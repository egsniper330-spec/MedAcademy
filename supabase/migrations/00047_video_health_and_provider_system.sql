
-- ── Provider & health fields on video_uploads ────────────────────────────────
ALTER TABLE video_uploads
  ADD COLUMN IF NOT EXISTS provider             text NOT NULL DEFAULT 'medacademy',
  ADD COLUMN IF NOT EXISTS provider_video_id    text,
  ADD COLUMN IF NOT EXISTS provider_metadata    jsonb,
  ADD COLUMN IF NOT EXISTS archived_at          timestamptz,
  ADD COLUMN IF NOT EXISTS last_health_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS health_score         smallint,
  ADD COLUMN IF NOT EXISTS playback_status      text DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS thumbnail_missing    boolean DEFAULT false;

-- Backfill provider_video_id from existing storage_path or public_url (use id as fallback)
-- (video_uploads does not have a legacy video_id column — provider_video_id starts fresh)

-- ── Video Health Scans ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_health_scans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id         uuid REFERENCES video_uploads(id) ON DELETE CASCADE,
  scan_type         text NOT NULL DEFAULT 'manual',
  triggered_by      uuid REFERENCES profiles(id),
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  duration_ms       integer,
  overall_status    text NOT NULL DEFAULT 'running',
  health_score      smallint,
  checks            jsonb NOT NULL DEFAULT '{}',
  error_message     text,
  report_url        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vhs_upload_id  ON video_health_scans(upload_id);
CREATE INDEX IF NOT EXISTS idx_vhs_scan_type  ON video_health_scans(scan_type);
CREATE INDEX IF NOT EXISTS idx_vhs_overall    ON video_health_scans(overall_status);
CREATE INDEX IF NOT EXISTS idx_vhs_started_at ON video_health_scans(started_at DESC);

-- ── Video Health Alerts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_health_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id     uuid REFERENCES video_uploads(id) ON DELETE CASCADE,
  alert_type    text NOT NULL,
  severity      text NOT NULL DEFAULT 'warning',
  title         text NOT NULL,
  message       text NOT NULL,
  metadata      jsonb,
  resolved      boolean NOT NULL DEFAULT false,
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vha_upload_id  ON video_health_alerts(upload_id);
CREATE INDEX IF NOT EXISTS idx_vha_alert_type ON video_health_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_vha_resolved   ON video_health_alerts(resolved);
CREATE INDEX IF NOT EXISTS idx_vha_created_at ON video_health_alerts(created_at DESC);

-- ── Video Provider Config ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_provider_config (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key      text NOT NULL UNIQUE,
  display_name      text NOT NULL,
  is_active         boolean NOT NULL DEFAULT false,
  is_default        boolean NOT NULL DEFAULT false,
  health_status     text NOT NULL DEFAULT 'unknown',
  health_checked_at timestamptz,
  last_sync_at      timestamptz,
  config            jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO video_provider_config (provider_key, display_name, is_active, is_default, health_status, config)
VALUES ('medacademy', 'MedAcademy Video', true, true, 'online',
  '{"api_url":"https://dev.vdocipher.com/api","supports_streaming":true,"supports_drm":true,"max_file_size_gb":5}')
ON CONFLICT (provider_key) DO NOTHING;

-- ── Daily Health Reports ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_daily_health_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date     date NOT NULL UNIQUE,
  total_videos    integer NOT NULL DEFAULT 0,
  healthy_count   integer NOT NULL DEFAULT 0,
  broken_count    integer NOT NULL DEFAULT 0,
  warning_count   integer NOT NULL DEFAULT 0,
  health_pct      numeric(5,2),
  scan_duration_s integer,
  details         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE video_health_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_health_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_provider_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_daily_health_reports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='video_health_scans' AND policyname='super_admin_health_scans') THEN
    CREATE POLICY "super_admin_health_scans" ON video_health_scans
      FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='video_health_alerts' AND policyname='super_admin_health_alerts') THEN
    CREATE POLICY "super_admin_health_alerts" ON video_health_alerts
      FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('super_admin','admin')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='video_provider_config' AND policyname='super_admin_provider_config') THEN
    CREATE POLICY "super_admin_provider_config" ON video_provider_config
      FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='video_daily_health_reports' AND policyname='super_admin_daily_reports') THEN
    CREATE POLICY "super_admin_daily_reports" ON video_daily_health_reports
      FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'));
  END IF;
END $$;
