-- v101: Upload session hardening — heartbeat, lock recovery, video_missing status
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Heartbeat column on upload_sessions ───────────────────────────────────
-- Updated every 15 s by the uploading client. Orphan-cleanup skips rows
-- whose last_heartbeat is within the last 60 s (still active).
ALTER TABLE public.upload_sessions
  ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ;

-- Index for the heartbeat liveness check in orphan-cleanup
CREATE INDEX IF NOT EXISTS idx_upload_sessions_last_heartbeat
  ON public.upload_sessions (last_heartbeat)
  WHERE last_heartbeat IS NOT NULL;

-- ── 2. video_missing status for lessons ──────────────────────────────────────
-- Allows the consistency-audit to mark a lesson whose VdoCipher asset no
-- longer exists so the UI can surface "Video Missing — Re-upload" instead of
-- silently showing a broken player.
DO $$
BEGIN
  -- Drop and re-add the check constraint to include 'video_missing'
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'lessons'
      AND constraint_name = 'lessons_video_status_check'
  ) THEN
    ALTER TABLE public.lessons DROP CONSTRAINT lessons_video_status_check;
  END IF;

  ALTER TABLE public.lessons
    ADD CONSTRAINT lessons_video_status_check
    CHECK (video_status IN (
      'none','waiting','uploading','paused','processing','encoding',
      'generating_streams','ready','failed','canceled','timeout',
      'video_missing'
    ));
END $$;

-- ── 3. RPC: recover_stale_upload_sessions ────────────────────────────────────
-- Called on app launch (by upload lock recovery logic).
-- Returns all sessions that were left in an active state (uploading/processing/
-- encoding) AND whose last_heartbeat is stale (> 60 s ago or NULL).
-- The caller decides whether to mark them 'recovering' or 'failed'.
CREATE OR REPLACE FUNCTION public.recover_stale_upload_sessions(
  p_stale_threshold_seconds INT DEFAULT 60
)
RETURNS TABLE (
  session_id        UUID,
  upload_id         UUID,
  lesson_id         UUID,
  provider_video_id TEXT,
  status            TEXT,
  last_heartbeat    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id             AS session_id,
    s.upload_id,
    s.lesson_id,
    s.provider_video_id,
    s.status,
    s.last_heartbeat,
    s.created_at
  FROM public.upload_sessions s
  WHERE s.status IN ('uploading', 'processing', 'encoding')
    AND (
      s.last_heartbeat IS NULL
      OR s.last_heartbeat < now() - (p_stale_threshold_seconds || ' seconds')::INTERVAL
    )
  ORDER BY s.created_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.recover_stale_upload_sessions(INT) TO authenticated, service_role;

-- ── 4. RPC: verify_lesson_video ───────────────────────────────────────────────
-- Called when a lesson opens (consistency audit).
-- Returns whether the lesson has a video, whether VdoCipher was checked, and
-- the current video_status. The frontend calls vdocipher-upload-status EF for
-- the actual liveness check; this RPC just reads lesson state.
CREATE OR REPLACE FUNCTION public.get_lesson_video_state(p_lesson_id UUID)
RETURNS JSONB
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'lesson_id',         l.id,
    'video_id',          l.video_id,
    'video_status',      l.video_status,
    'video_upload_id',   l.video_upload_id,
    'has_video',         l.video_id IS NOT NULL,
    'is_missing',        l.video_status = 'video_missing',
    'thumbnail_url',     l.video_thumbnail_url,
    'duration_seconds',  l.video_duration_seconds
  )
  FROM public.lessons l
  WHERE l.id = p_lesson_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_lesson_video_state(UUID) TO authenticated, service_role;

-- ── 5. RPC: mark_lesson_video_missing ────────────────────────────────────────
-- Called by the consistency-audit when VdoCipher confirms the asset is gone.
CREATE OR REPLACE FUNCTION public.mark_lesson_video_missing(p_lesson_id UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.lessons
  SET video_status = 'video_missing',
      updated_at   = now()
  WHERE id = p_lesson_id
    AND video_id IS NOT NULL;   -- only mark if there was supposed to be a video
$$;

GRANT EXECUTE ON FUNCTION public.mark_lesson_video_missing(UUID) TO authenticated, service_role;

-- ── 6. Update get_cleanable_upload_sessions to respect heartbeat ─────────────
-- Sessions with a recent heartbeat (< 60 s) are considered live and must NOT
-- be cleaned up even if their expires_at has nominally passed.
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
    -- Heartbeat guard: skip sessions still beating (active client)
    AND  (last_heartbeat IS NULL OR last_heartbeat < now() - INTERVAL '60 seconds')
  ORDER  BY expires_at ASC
  LIMIT  100;
$$;

GRANT EXECUTE ON FUNCTION public.get_cleanable_upload_sessions() TO service_role;