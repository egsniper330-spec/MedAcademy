-- ============================================================
-- CONTENT PROTECTION — v62
-- ============================================================

-- Enum: action types for content protection policies
DO $$ BEGIN
  CREATE TYPE content_protection_action AS ENUM ('warn_only', 'strike_system', 'auto_logout', 'auto_suspend');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE strike_action AS ENUM ('warning', 'logout', 'suspend', 'ban');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE violation_type AS ENUM ('screenshot_detected', 'screen_recording_detected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add content-protection columns to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS violation_count   integer   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS strike_count      integer   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_suspended      boolean   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspension_reason text,
  ADD COLUMN IF NOT EXISTS suspension_at     timestamptz,
  ADD COLUMN IF NOT EXISTS suspension_device jsonb;

-- ─── content_protection_policies ────────────────────────────
CREATE TABLE IF NOT EXISTS content_protection_policies (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  screenshot_policy   content_protection_action NOT NULL DEFAULT 'strike_system',
  recording_policy    content_protection_action NOT NULL DEFAULT 'strike_system',
  violation_limit     integer     NOT NULL DEFAULT 3,
  warning_message     text        NOT NULL DEFAULT 'Screenshots of protected educational content are prohibited. Repeated violations may result in temporary account suspension.',
  auto_logout         boolean     NOT NULL DEFAULT true,
  auto_suspend        boolean     NOT NULL DEFAULT true,
  suspension_hours    integer     NOT NULL DEFAULT 24,
  strike1_action      strike_action NOT NULL DEFAULT 'warning',
  strike2_action      strike_action NOT NULL DEFAULT 'logout',
  strike3_action      strike_action NOT NULL DEFAULT 'suspend',
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid        REFERENCES profiles(id)
);

-- Seed default policy row
INSERT INTO content_protection_policies (id)
VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ─── content_protection_violations ──────────────────────────
CREATE TABLE IF NOT EXISTS content_protection_violations (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  violation_type   violation_type NOT NULL,
  strike_count     integer     NOT NULL DEFAULT 0,
  action_taken     strike_action NOT NULL DEFAULT 'warning',
  device_id        text,
  device_name      text,
  platform         text,
  installation_id  text,
  session_id       text,
  ip_address       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_violations_user_id    ON content_protection_violations(user_id);
CREATE INDEX IF NOT EXISTS idx_violations_created_at ON content_protection_violations(created_at DESC);

-- ─── RLS ────────────────────────────────────────────────────

ALTER TABLE content_protection_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_protection_violations ENABLE ROW LEVEL SECURITY;

-- Policies: content_protection_policies
-- All authenticated users can read (needed to apply policy client-side)
CREATE POLICY "cp_policies_read" ON content_protection_policies
  FOR SELECT TO authenticated USING (true);

-- Only super admin can modify via service role (Edge Function)
CREATE POLICY "cp_policies_admin_all" ON content_protection_policies
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Policies: content_protection_violations
CREATE POLICY "violations_own_read" ON content_protection_violations
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "violations_insert_own" ON content_protection_violations
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "violations_admin_all" ON content_protection_violations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Admins/Super Admins read all violations
CREATE POLICY "violations_admin_read" ON content_protection_violations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'super_admin')
    )
  );

-- ─── RPC helpers ────────────────────────────────────────────

-- Get content protection stats for admin dashboard
CREATE OR REPLACE FUNCTION get_content_protection_stats()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT jsonb_build_object(
    'total_screenshot_violations',  (SELECT COUNT(*) FROM content_protection_violations WHERE violation_type = 'screenshot_detected'),
    'total_recording_violations',   (SELECT COUNT(*) FROM content_protection_violations WHERE violation_type = 'screen_recording_detected'),
    'total_suspended_accounts',     (SELECT COUNT(*) FROM profiles WHERE is_suspended = true),
    'total_violations_today',       (SELECT COUNT(*) FROM content_protection_violations WHERE created_at >= NOW() - INTERVAL '24 hours'),
    'top_violators',                (
      SELECT jsonb_agg(r) FROM (
        SELECT p.id, p.full_name, p.email, p.violation_count, p.strike_count, p.is_suspended
        FROM profiles p
        WHERE p.violation_count > 0
        ORDER BY p.violation_count DESC
        LIMIT 10
      ) r
    )
  );
$$;

-- Reset violations for a user (admin only)
CREATE OR REPLACE FUNCTION admin_reset_violations(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  UPDATE profiles
  SET violation_count = 0, strike_count = 0, updated_at = now()
  WHERE id = target_user_id;
END;
$$;

-- Restore a suspended account (admin only)
CREATE OR REPLACE FUNCTION admin_restore_account(
  target_user_id uuid,
  reset_violations boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  UPDATE profiles
  SET
    is_suspended     = false,
    suspension_reason = NULL,
    suspension_at     = NULL,
    suspension_device = NULL,
    status            = 'active',
    violation_count   = CASE WHEN reset_violations THEN 0 ELSE violation_count END,
    strike_count      = CASE WHEN reset_violations THEN 0 ELSE strike_count END,
    updated_at        = now()
  WHERE id = target_user_id;
END;
$$;
