-- Extend audit_action enum with security-specific values
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'root_detected';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'jailbreak_detected';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'vpn_detected';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'proxy_detected';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'ssl_pinning_failure';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'screenshot_detected';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'screen_recording_detected';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'debug_detected';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'frida_detected';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'xposed_detected';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'app_integrity_compromised';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'security_policy_changed';

-- Security event type enum
CREATE TYPE security_event_type AS ENUM (
  'root_detected',
  'jailbreak_detected',
  'vpn_detected',
  'proxy_detected',
  'ssl_pinning_failure',
  'screenshot_detected',
  'screen_recording_detected',
  'debug_detected',
  'frida_detected',
  'xposed_detected',
  'app_integrity_compromised'
);

-- Security policy action enum
CREATE TYPE security_policy_action AS ENUM (
  'log_only',
  'warn_only',
  'block_video',
  'block_login'
);

-- Security detection type enum
CREATE TYPE security_detection_type AS ENUM (
  'root_jailbreak',
  'vpn',
  'proxy',
  'ssl_pinning',
  'debug',
  'screenshot',
  'screen_recording',
  'app_integrity'
);

-- security_events table
CREATE TABLE security_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  device_id        text,
  event_type       security_event_type NOT NULL,
  detection_method text,
  policy_action    security_policy_action,
  risk_score       integer DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  ip_address       text,
  platform         text,
  app_version      text,
  metadata         jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_security_events_user_id    ON security_events(user_id);
CREATE INDEX idx_security_events_event_type ON security_events(event_type);
CREATE INDEX idx_security_events_created_at ON security_events(created_at DESC);
CREATE INDEX idx_security_events_device_id  ON security_events(device_id);

ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_security_events" ON security_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin','super_admin') AND p.status = 'active')
  );

CREATE POLICY "user_read_own_security_events" ON security_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "service_insert_security_events" ON security_events
  FOR INSERT TO service_role WITH CHECK (true);

-- security_policies table
CREATE TABLE security_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detection_type security_detection_type NOT NULL UNIQUE,
  action         security_policy_action  NOT NULL DEFAULT 'warn_only',
  enabled        boolean NOT NULL DEFAULT true,
  updated_by     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE security_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_security_policies" ON security_policies
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "anon_read_security_policies" ON security_policies
  FOR SELECT TO anon USING (true);

CREATE POLICY "superadmin_write_security_policies" ON security_policies
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'super_admin' AND p.status = 'active')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'super_admin' AND p.status = 'active')
  );

-- Seed default security policies
INSERT INTO security_policies (detection_type, action, enabled) VALUES
  ('root_jailbreak',   'warn_only',   true),
  ('vpn',              'warn_only',   true),
  ('proxy',            'warn_only',   true),
  ('ssl_pinning',      'block_login', true),
  ('debug',            'warn_only',   true),
  ('screenshot',       'log_only',    true),
  ('screen_recording', 'log_only',    true),
  ('app_integrity',    'warn_only',   true);

-- VPN whitelist table
CREATE TABLE security_vpn_whitelist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  added_by    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE security_vpn_whitelist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_vpn_whitelist" ON security_vpn_whitelist
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "anon_read_vpn_whitelist" ON security_vpn_whitelist
  FOR SELECT TO anon USING (true);

CREATE POLICY "superadmin_write_vpn_whitelist" ON security_vpn_whitelist
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'super_admin' AND p.status = 'active')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'super_admin' AND p.status = 'active')
  );

-- RPC: get_security_stats
CREATE OR REPLACE FUNCTION get_security_stats(
  p_start_date timestamptz DEFAULT now() - interval '30 days',
  p_end_date   timestamptz DEFAULT now()
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_caller_role text;
  v_result      jsonb;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('super_admin','admin') THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  SELECT jsonb_build_object(
    'total_events',     COUNT(*),
    'root_jailbreak',   COUNT(*) FILTER (WHERE event_type IN ('root_detected','jailbreak_detected')),
    'vpn',              COUNT(*) FILTER (WHERE event_type = 'vpn_detected'),
    'proxy',            COUNT(*) FILTER (WHERE event_type = 'proxy_detected'),
    'ssl_pinning',      COUNT(*) FILTER (WHERE event_type = 'ssl_pinning_failure'),
    'screenshot',       COUNT(*) FILTER (WHERE event_type = 'screenshot_detected'),
    'screen_recording', COUNT(*) FILTER (WHERE event_type = 'screen_recording_detected'),
    'debug',            COUNT(*) FILTER (WHERE event_type IN ('debug_detected','frida_detected','xposed_detected')),
    'app_integrity',    COUNT(*) FILTER (WHERE event_type = 'app_integrity_compromised')
  ) INTO v_result
  FROM security_events
  WHERE created_at BETWEEN p_start_date AND p_end_date;
  RETURN v_result;
END;
$$;

-- RPC: get_risky_devices
CREATE OR REPLACE FUNCTION get_risky_devices(
  p_min_score integer DEFAULT 20,
  p_limit     integer DEFAULT 50,
  p_offset    integer DEFAULT 0
)
RETURNS TABLE (
  device_id      text,
  user_id        uuid,
  user_name      text,
  user_email     text,
  max_risk_score integer,
  event_types    text[],
  last_seen      timestamptz,
  platform       text
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_caller_role text;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('super_admin','admin') THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  RETURN QUERY
  SELECT
    se.device_id, se.user_id,
    p.full_name, p.email,
    MAX(se.risk_score)::integer,
    ARRAY_AGG(DISTINCT se.event_type::text),
    MAX(se.created_at),
    se.platform
  FROM security_events se
  LEFT JOIN profiles p ON p.id = se.user_id
  WHERE se.risk_score >= p_min_score AND se.device_id IS NOT NULL
  GROUP BY se.device_id, se.user_id, p.full_name, p.email, se.platform
  ORDER BY MAX(se.risk_score) DESC, MAX(se.created_at) DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;