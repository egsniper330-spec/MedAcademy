
-- Add thumbnail, verification, and replace-tracking columns to video_uploads
ALTER TABLE video_uploads
  ADD COLUMN IF NOT EXISTS thumbnail_url          text,
  ADD COLUMN IF NOT EXISTS thumbnail_storage_path text,
  ADD COLUMN IF NOT EXISTS verification_status    text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verifying','passed','failed','skipped')),
  ADD COLUMN IF NOT EXISTS verification_error     text,
  ADD COLUMN IF NOT EXISTS verified_at            timestamptz,
  -- for replace-video flow: track the old file to delete after successful replacement
  ADD COLUMN IF NOT EXISTS old_storage_path       text,
  ADD COLUMN IF NOT EXISTS is_replacement         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS replaced_upload_id     uuid REFERENCES video_uploads(id) ON DELETE SET NULL,
  -- file analysis metadata
  ADD COLUMN IF NOT EXISTS file_analysis          jsonb,
  -- recovery state for interrupted uploads
  ADD COLUMN IF NOT EXISTS recovery_state         text NOT NULL DEFAULT 'none'
    CHECK (recovery_state IN ('none','interrupted','recovering','recovered'));

-- Extend audit log events to cover new lifecycle
ALTER TABLE upload_audit_logs
  DROP CONSTRAINT IF EXISTS upload_audit_logs_event_check;

ALTER TABLE upload_audit_logs
  ADD CONSTRAINT upload_audit_logs_event_check CHECK (
    event IN (
      'upload_started','upload_completed','upload_failed',
      'upload_paused','upload_resumed','upload_canceled',
      'video_deleted','video_replaced','video_reprocessed',
      'processing_started','encoding_started','ready',
      'verification_started','verification_passed','verification_failed',
      'thumbnail_generated','thumbnail_replaced',
      'recovery_detected','recovery_started','recovery_completed'
    )
  );

-- Add thumbnail_url to lessons for fast display everywhere
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_thumbnail_url text;

CREATE INDEX IF NOT EXISTS idx_video_uploads_verification ON video_uploads(verification_status);
CREATE INDEX IF NOT EXISTS idx_video_uploads_recovery     ON video_uploads(recovery_state);
