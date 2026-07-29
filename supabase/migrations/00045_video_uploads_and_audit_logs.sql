
-- ═══════════════════════════════════════════════════════════
-- VIDEO UPLOADS — tracks each upload job lifecycle
-- ═══════════════════════════════════════════════════════════
CREATE TABLE video_uploads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id           uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id           uuid REFERENCES lessons(id) ON DELETE SET NULL,
  course_id           uuid REFERENCES courses(id) ON DELETE SET NULL,
  -- File metadata
  file_name           text NOT NULL,
  file_size           bigint NOT NULL DEFAULT 0,         -- bytes
  mime_type           text NOT NULL DEFAULT 'video/mp4',
  -- Upload state machine
  status              text NOT NULL DEFAULT 'waiting'
                      CHECK (status IN ('waiting','uploading','paused','processing','encoding',
                                        'generating_streams','ready','failed','canceled')),
  -- Progress tracking
  bytes_uploaded      bigint NOT NULL DEFAULT 0,
  upload_speed_bps    bigint,                            -- bytes/sec
  eta_seconds         int,
  -- Storage result
  storage_path        text,
  public_url          text,
  -- Video metadata (populated after processing)
  video_duration_sec  int,
  video_resolution    text,                              -- e.g. "1920x1080"
  -- Error info
  error_message       text,
  retry_count         int NOT NULL DEFAULT 0,
  -- Timing
  upload_started_at   timestamptz,
  upload_completed_at timestamptz,
  processing_started_at timestamptz,
  ready_at            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_video_uploads_doctor   ON video_uploads(doctor_id);
CREATE INDEX idx_video_uploads_lesson   ON video_uploads(lesson_id);
CREATE INDEX idx_video_uploads_course   ON video_uploads(course_id);
CREATE INDEX idx_video_uploads_status   ON video_uploads(status);

-- ═══════════════════════════════════════════════════════════
-- UPLOAD AUDIT LOGS
-- ═══════════════════════════════════════════════════════════
CREATE TABLE upload_audit_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id    uuid NOT NULL REFERENCES video_uploads(id) ON DELETE CASCADE,
  actor_id     uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  event        text NOT NULL
               CHECK (event IN ('upload_started','upload_completed','upload_failed',
                                'upload_paused','upload_resumed','upload_canceled',
                                'video_deleted','video_replaced','video_reprocessed',
                                'processing_started','encoding_started','ready')),
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_upload_audit_upload ON upload_audit_logs(upload_id);
CREATE INDEX idx_upload_audit_actor  ON upload_audit_logs(actor_id);

-- ═══════════════════════════════════════════════════════════
-- AUTO-UPDATE updated_at
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_video_uploads_updated
  BEFORE UPDATE ON video_uploads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════════════════════
ALTER TABLE video_uploads    ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_audit_logs ENABLE ROW LEVEL SECURITY;

-- video_uploads: doctor owns their uploads
CREATE POLICY "doctor_select_own_uploads"  ON video_uploads FOR SELECT USING (doctor_id = auth.uid());
CREATE POLICY "doctor_insert_own_uploads"  ON video_uploads FOR INSERT WITH CHECK (doctor_id = auth.uid());
CREATE POLICY "doctor_update_own_uploads"  ON video_uploads FOR UPDATE USING (doctor_id = auth.uid());
CREATE POLICY "doctor_delete_own_uploads"  ON video_uploads FOR DELETE USING (doctor_id = auth.uid());

-- admins / superadmins: full access via helper
CREATE OR REPLACE FUNCTION is_admin_or_superadmin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin')
  )
$$;

CREATE POLICY "admin_all_uploads"     ON video_uploads    FOR ALL USING (is_admin_or_superadmin());
CREATE POLICY "admin_all_audit_logs"  ON upload_audit_logs FOR ALL USING (is_admin_or_superadmin());

-- audit logs: doctor sees their own
CREATE POLICY "doctor_select_own_audit"
  ON upload_audit_logs FOR SELECT
  USING (actor_id = auth.uid());

CREATE POLICY "doctor_insert_own_audit"
  ON upload_audit_logs FOR INSERT
  WITH CHECK (actor_id = auth.uid());

-- ═══════════════════════════════════════════════════════════
-- add video_status column to lessons for fast publish checks
-- ═══════════════════════════════════════════════════════════
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_upload_id uuid REFERENCES video_uploads(id) ON DELETE SET NULL;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_status text NOT NULL DEFAULT 'none'
  CHECK (video_status IN ('none','waiting','uploading','paused','processing','encoding',
                           'generating_streams','ready','failed','canceled'));
