-- v100: upload_sessions table + deferred VdoCipher cleanup support
-- Rationale: provider assets must NOT be deleted immediately on upload failure.
-- The upload_sessions table tracks the asset lifecycle independently of
-- video_uploads, enabling retry/resume/replace flows without losing the asset.

-- ── 1. upload_sessions table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.upload_sessions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id          UUID        REFERENCES public.video_uploads(id) ON DELETE CASCADE,
  lesson_id          UUID        REFERENCES public.lessons(id)       ON DELETE SET NULL,
  course_id          UUID        REFERENCES public.courses(id)       ON DELETE SET NULL,
  provider_video_id  TEXT,                                           -- VdoCipher video ID
  status             TEXT        NOT NULL DEFAULT 'uploading'
                                 CHECK (status IN (
                                   'uploading','processing','encoding',
                                   'ready','failed','cancelled','expired'
                                 )),
  upload_offset      BIGINT      DEFAULT 0,                          -- bytes uploaded (resumable)
  file_name          TEXT,
  file_size          BIGINT,
  mime_type          TEXT,
  storage_path       TEXT,                                           -- Supabase Storage path
  error_message      TEXT,
  retry_count        INT         NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Deferred cleanup: asset is safe until this timestamp.
  -- Failed uploads: expires in 24 h. Cancelled: eligible immediately.
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);

-- Index for cleanup job queries
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status_expires
  ON public.upload_sessions (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_lesson_id
  ON public.upload_sessions (lesson_id);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_provider_video_id
  ON public.upload_sessions (provider_video_id)
  WHERE provider_video_id IS NOT NULL;

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_upload_sessions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_upload_sessions_updated_at ON public.upload_sessions;
CREATE TRIGGER trg_upload_sessions_updated_at
  BEFORE UPDATE ON public.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_upload_sessions_updated_at();

-- ── 2. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.upload_sessions ENABLE ROW LEVEL SECURITY;

-- Doctors / admins can see their own sessions via upload_id join
CREATE POLICY "upload_sessions_service_role_all"
  ON public.upload_sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "upload_sessions_owner_select"
  ON public.upload_sessions
  FOR SELECT
  TO authenticated
  USING (
    lesson_id IN (
      SELECT l.id FROM public.lessons l
      JOIN public.sections s ON s.id = l.section_id
      JOIN public.courses  c ON c.id = s.course_id
      WHERE c.doctor_id = auth.uid()
    )
  );

-- ── 3. Helper: upsert upload session ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_upload_session(
  p_upload_id        UUID,
  p_lesson_id        UUID,
  p_course_id        UUID,
  p_provider_video_id TEXT,
  p_status           TEXT,
  p_file_name        TEXT  DEFAULT NULL,
  p_file_size        BIGINT DEFAULT NULL,
  p_mime_type        TEXT  DEFAULT NULL,
  p_storage_path     TEXT  DEFAULT NULL,
  p_error_message    TEXT  DEFAULT NULL,
  p_retry_count      INT   DEFAULT 0,
  p_expires_hours    INT   DEFAULT 24
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.upload_sessions (
    upload_id, lesson_id, course_id, provider_video_id,
    status, file_name, file_size, mime_type, storage_path,
    error_message, retry_count,
    expires_at
  ) VALUES (
    p_upload_id, p_lesson_id, p_course_id, p_provider_video_id,
    p_status, p_file_name, p_file_size, p_mime_type, p_storage_path,
    p_error_message, p_retry_count,
    now() + (p_expires_hours || ' hours')::INTERVAL
  )
  ON CONFLICT (upload_id) DO UPDATE SET
    provider_video_id = COALESCE(EXCLUDED.provider_video_id, upload_sessions.provider_video_id),
    status            = EXCLUDED.status,
    storage_path      = COALESCE(EXCLUDED.storage_path,      upload_sessions.storage_path),
    error_message     = EXCLUDED.error_message,
    retry_count       = EXCLUDED.retry_count,
    expires_at        = CASE
      -- Cancelled: expire immediately (eligible for cleanup)
      WHEN EXCLUDED.status = 'cancelled' THEN now()
      -- Failed: 24 h grace period for retry
      WHEN EXCLUDED.status = 'failed'    THEN now() + (p_expires_hours || ' hours')::INTERVAL
      -- Anything else: extend expiry
      ELSE now() + (p_expires_hours || ' hours')::INTERVAL
    END,
    updated_at        = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Unique constraint so ON CONFLICT works
ALTER TABLE public.upload_sessions
  DROP CONSTRAINT IF EXISTS upload_sessions_upload_id_key;
ALTER TABLE public.upload_sessions
  ADD CONSTRAINT upload_sessions_upload_id_key UNIQUE (upload_id);

GRANT EXECUTE ON FUNCTION public.upsert_upload_session(UUID,UUID,UUID,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,INT,INT)
  TO authenticated, service_role;

-- ── 4. Query: sessions eligible for provider cleanup ─────────────────────────
-- Used by orphan-cleanup EF to find assets safe to delete.
CREATE OR REPLACE FUNCTION public.get_cleanable_upload_sessions()
RETURNS TABLE (
  session_id        UUID,
  upload_id         UUID,
  lesson_id         UUID,
  provider_video_id TEXT,
  status            TEXT,
  expires_at        TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, upload_id, lesson_id, provider_video_id, status, expires_at
  FROM   public.upload_sessions
  WHERE  status IN ('failed', 'cancelled', 'expired')
    AND  expires_at <= now()
    AND  provider_video_id IS NOT NULL
  ORDER  BY expires_at ASC
  LIMIT  100;
$$;

GRANT EXECUTE ON FUNCTION public.get_cleanable_upload_sessions() TO service_role;