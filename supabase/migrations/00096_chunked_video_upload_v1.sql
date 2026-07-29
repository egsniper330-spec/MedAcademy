-- ═══════════════════════════════════════════════════════════════════════════
-- Chunked Video Upload System
-- Adds chunk tracking to video_uploads + creates video-chunks storage bucket
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Chunk tracking columns on video_uploads ───────────────────────────────
ALTER TABLE public.video_uploads
  ADD COLUMN IF NOT EXISTS total_chunks        INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chunks_completed    INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chunk_size_bytes    INT NOT NULL DEFAULT 8388608,  -- 8 MB default
  ADD COLUMN IF NOT EXISTS assembly_triggered  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assembly_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assembly_error      TEXT;

-- Allow 'resuming' in video_uploads.status (was not in original check constraint)
ALTER TABLE public.video_uploads
  DROP CONSTRAINT IF EXISTS video_uploads_status_check;

ALTER TABLE public.video_uploads
  ADD CONSTRAINT video_uploads_status_check CHECK (
    status IN (
      'waiting','uploading','paused','resuming','processing','encoding',
      'generating_streams','verifying','ready','failed','timeout','canceled','recovering'
    )
  );

-- ── 2. video-chunks Storage bucket ──────────────────────────────────────────
-- Private bucket — chunks are temporary; public URL not needed
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'video-chunks',
  'video-chunks',
  false,
  104857600,  -- 10 MB per chunk file
  ARRAY['application/octet-stream', 'video/mp4', 'video/webm', 'video/quicktime',
        'video/x-msvideo', 'video/mpeg', 'video/x-m4v', 'video/3gpp', 'application/zip']
)
ON CONFLICT (id) DO NOTHING;

-- ── 3. RLS for video-chunks bucket ──────────────────────────────────────────
-- Doctors can upload chunks only to paths prefixed with their own upload IDs.
-- Service role (used in Edge Functions) has unrestricted access.

DROP POLICY IF EXISTS "chunks_service_all"        ON storage.objects;
DROP POLICY IF EXISTS "chunks_doctor_insert"       ON storage.objects;
DROP POLICY IF EXISTS "chunks_doctor_select"       ON storage.objects;
DROP POLICY IF EXISTS "chunks_doctor_delete"       ON storage.objects;

-- Service role: unrestricted (used by assembly EF to read chunks)
CREATE POLICY "chunks_service_all"
  ON storage.objects FOR ALL
  TO service_role
  USING (bucket_id = 'video-chunks')
  WITH CHECK (bucket_id = 'video-chunks');

-- Authenticated doctors: can write chunks for uploads they own
CREATE POLICY "chunks_doctor_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'video-chunks'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.video_uploads WHERE doctor_id = auth.uid()
    )
  );

-- Authenticated doctors: can read their own chunks
CREATE POLICY "chunks_doctor_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'video-chunks'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.video_uploads WHERE doctor_id = auth.uid()
    )
  );

-- Authenticated doctors: can delete their own chunks
CREATE POLICY "chunks_doctor_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'video-chunks'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.video_uploads WHERE doctor_id = auth.uid()
    )
  );

-- ── 4. RPC: get_chunk_upload_state ───────────────────────────────────────────
-- Returns how many chunks have been stored for a given upload.
-- Used by frontend on resume to skip already-uploaded chunks.
CREATE OR REPLACE FUNCTION public.get_chunk_upload_state(p_upload_id UUID)
RETURNS TABLE (
  total_chunks        INT,
  chunks_completed    INT,
  chunk_size_bytes    INT,
  assembly_triggered  BOOLEAN,
  status              TEXT
)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT
    vu.total_chunks,
    vu.chunks_completed,
    vu.chunk_size_bytes,
    vu.assembly_triggered,
    vu.status::text
  FROM public.video_uploads vu
  WHERE vu.id = p_upload_id
    AND (
      vu.doctor_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role IN ('admin','super_admin')
      )
    );
$$;

GRANT EXECUTE ON FUNCTION public.get_chunk_upload_state(UUID) TO authenticated;

-- ── 5. RPC: increment_chunks_completed ───────────────────────────────────────
-- Atomically increments chunks_completed and returns the new count.
-- Called by video-upload-chunk EF after storing each chunk.
CREATE OR REPLACE FUNCTION public.increment_chunks_completed(
  p_upload_id UUID,
  p_total_chunks INT DEFAULT NULL
)
RETURNS TABLE (chunks_completed INT, total_chunks INT, assembly_triggered BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.video_uploads
  SET
    chunks_completed = chunks_completed + 1,
    total_chunks = CASE
      WHEN p_total_chunks IS NOT NULL THEN p_total_chunks
      ELSE total_chunks
    END,
    updated_at = now()
  WHERE id = p_upload_id;

  RETURN QUERY
  SELECT vu.chunks_completed, vu.total_chunks, vu.assembly_triggered
  FROM public.video_uploads vu
  WHERE vu.id = p_upload_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_chunks_completed(UUID, INT) TO service_role;

-- ── 6. Extend audit log events for chunked upload ────────────────────────────
ALTER TABLE public.upload_audit_logs
  DROP CONSTRAINT IF EXISTS upload_audit_logs_event_check;

ALTER TABLE public.upload_audit_logs
  ADD CONSTRAINT upload_audit_logs_event_check CHECK (
    event IN (
      'upload_started','upload_completed','upload_failed',
      'upload_paused','upload_resumed','upload_canceled',
      'video_deleted','video_replaced','video_reprocessed',
      'processing_started','encoding_started','ready',
      'verification_started','verification_passed','verification_failed',
      'thumbnail_generated','thumbnail_replaced',
      'recovery_detected','recovery_started','recovery_completed',
      'chunk_upload_started','chunk_received','assembly_triggered',
      'assembly_started','assembly_completed','assembly_failed',
      'retry_upload','retry_processing','lock_recovery_recovering',
      'lock_recovery_failed','vdocipher_init_started','vdocipher_init_completed',
      'vdocipher_s3_upload_started','vdocipher_s3_upload_completed',
      'vdocipher_encoding_complete','vdocipher_encoding_failed',
      'vdocipher_polling_started','upload_resumed'
    )
  );