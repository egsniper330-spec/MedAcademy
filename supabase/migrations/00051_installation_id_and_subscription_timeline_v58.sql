-- ── v58: Installation ID + Subscription Timeline ─────────────────────────────

-- 1. Add installation_id to devices table (primary security identifier)
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS installation_id TEXT,
  ADD COLUMN IF NOT EXISTS first_login_at  TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_devices_installation_id
  ON devices(user_id, installation_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_user_installation_unique
  ON devices(user_id, installation_id)
  WHERE installation_id IS NOT NULL;

-- 2. pre_login_device_check — callable by anon role (no JWT needed)
CREATE OR REPLACE FUNCTION pre_login_device_check(
  p_email           TEXT,
  p_installation_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id         UUID;
  v_max_devices     INT;
  v_allow_unlimited BOOL;
  v_role            TEXT;
  v_device_count    INT;
  v_existing_device UUID;
BEGIN
  SELECT p.id, p.max_devices, p.allow_unlimited, p.role
  INTO   v_user_id, v_max_devices, v_allow_unlimited, v_role
  FROM   profiles p
  WHERE  lower(p.email) = lower(p_email)
  LIMIT  1;

  -- Unknown user — let auth layer handle it
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('allowed', true);
  END IF;

  -- Unlimited / super_admin bypass
  IF v_allow_unlimited = true OR v_role = 'super_admin' OR v_max_devices IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'unlimited', true);
  END IF;

  -- Known installation_id → always allow (update metadata on register)
  SELECT id INTO v_existing_device
  FROM   devices
  WHERE  user_id        = v_user_id
    AND  installation_id = p_installation_id
    AND  status         != 'blocked'
  LIMIT  1;

  IF v_existing_device IS NOT NULL THEN
    RETURN jsonb_build_object('allowed', true, 'known_device', true);
  END IF;

  -- Count active devices
  SELECT COUNT(*) INTO v_device_count
  FROM   devices
  WHERE  user_id = v_user_id AND status != 'blocked';

  IF v_device_count >= v_max_devices THEN
    RETURN jsonb_build_object(
      'allowed',       false,
      'limit_reached', true,
      'reason',        'This account is already active on another authorized device.',
      'current_count', v_device_count,
      'max_devices',   v_max_devices
    );
  END IF;

  RETURN jsonb_build_object('allowed', true);
END;
$$;

GRANT EXECUTE ON FUNCTION pre_login_device_check(TEXT, TEXT) TO anon, authenticated;

-- 3. Updated register_device — uses installation_id as primary dedup key
CREATE OR REPLACE FUNCTION register_device(
  p_fingerprint     TEXT,
  p_device_name     TEXT    DEFAULT 'Unknown Device',
  p_platform        TEXT    DEFAULT 'unknown',
  p_ip_address      TEXT    DEFAULT NULL,
  p_device_model    TEXT    DEFAULT NULL,
  p_os              TEXT    DEFAULT NULL,
  p_os_version      TEXT    DEFAULT NULL,
  p_app_version     TEXT    DEFAULT NULL,
  p_manufacturer    TEXT    DEFAULT NULL,
  p_installation_id TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id         UUID  := auth.uid();
  v_max_devices     INT;
  v_allow_unlimited BOOL;
  v_role            TEXT;
  v_device_count    INT;
  v_device_id       UUID;
  v_is_new          BOOL  := false;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Not authenticated');
  END IF;

  SELECT max_devices, allow_unlimited, role
  INTO   v_max_devices, v_allow_unlimited, v_role
  FROM   profiles WHERE id = v_user_id;

  -- Try to find existing device by installation_id first, then fingerprint
  IF p_installation_id IS NOT NULL THEN
    SELECT id INTO v_device_id FROM devices
    WHERE  user_id = v_user_id AND installation_id = p_installation_id AND status != 'blocked'
    LIMIT  1;
  END IF;

  IF v_device_id IS NULL THEN
    SELECT id INTO v_device_id FROM devices
    WHERE  user_id = v_user_id AND device_fingerprint = p_fingerprint AND status != 'blocked'
    LIMIT  1;
  END IF;

  -- Known device → update metadata only, no limit check
  IF v_device_id IS NOT NULL THEN
    UPDATE devices SET
      last_active_at  = now(),
      app_version     = COALESCE(p_app_version, app_version),
      os_version      = COALESCE(p_os_version, os_version),
      ip_address      = COALESCE(p_ip_address, ip_address),
      installation_id = COALESCE(p_installation_id, installation_id)
    WHERE id = v_device_id;
    RETURN jsonb_build_object('device_id', v_device_id, 'status', 'updated', 'is_new', false);
  END IF;

  -- Unlimited bypass for new device
  IF v_allow_unlimited = true OR v_role = 'super_admin' OR v_max_devices IS NULL THEN
    INSERT INTO devices
      (user_id, device_fingerprint, installation_id, device_name, platform, ip_address,
       device_model, os, os_version, app_version, manufacturer,
       status, first_login_at, registered_at, last_active_at)
    VALUES
      (v_user_id, p_fingerprint, p_installation_id, p_device_name, p_platform, p_ip_address,
       p_device_model, p_os, p_os_version, p_app_version, p_manufacturer,
       'active', now(), now(), now())
    RETURNING id INTO v_device_id;
    RETURN jsonb_build_object('device_id', v_device_id, 'status', 'registered', 'is_new', true, 'unlimited', true);
  END IF;

  -- Enforce limit for new device
  SELECT COUNT(*) INTO v_device_count FROM devices WHERE user_id = v_user_id AND status != 'blocked';
  IF v_device_count >= COALESCE(v_max_devices, 1) THEN
    RETURN jsonb_build_object(
      'error',         'This account is already active on another authorized device.',
      'limit_reached', true,
      'current_count', v_device_count,
      'max_devices',   v_max_devices
    );
  END IF;

  INSERT INTO devices
    (user_id, device_fingerprint, installation_id, device_name, platform, ip_address,
     device_model, os, os_version, app_version, manufacturer,
     status, first_login_at, registered_at, last_active_at)
  VALUES
    (v_user_id, p_fingerprint, p_installation_id, p_device_name, p_platform, p_ip_address,
     p_device_model, p_os, p_os_version, p_app_version, p_manufacturer,
     'active', now(), now(), now())
  RETURNING id INTO v_device_id;
  RETURN jsonb_build_object('device_id', v_device_id, 'status', 'registered', 'is_new', true);
END;
$$;

-- 4. Subscription timeline
CREATE TABLE IF NOT EXISTS subscription_timeline (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES profiles(id)   ON DELETE CASCADE,
  course_id     UUID NOT NULL REFERENCES courses(id)    ON DELETE CASCADE,
  event_type    TEXT NOT NULL,
  event_data    JSONB DEFAULT '{}',
  actor_id      UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_timeline_enrollment ON subscription_timeline(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_sub_timeline_user       ON subscription_timeline(user_id);

ALTER TABLE subscription_timeline ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sub_timeline_read" ON subscription_timeline
  FOR SELECT USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM courses c
      WHERE  c.id = subscription_timeline.course_id AND c.doctor_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin')
    )
  );

-- 5. admin_reset_device: delete devices + bump security_version
CREATE OR REPLACE FUNCTION admin_reset_device(
  p_target_user_id UUID,
  p_reason         TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted_count INT;
  v_actor_id      UUID := auth.uid();
BEGIN
  DELETE FROM devices WHERE user_id = p_target_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  UPDATE profiles
  SET    security_version = COALESCE(security_version, 0) + 1
  WHERE  id = p_target_user_id;

  INSERT INTO audit_logs (actor_id, target_user_id, action, details, created_at)
  VALUES (
    v_actor_id, p_target_user_id, 'admin_reset_device',
    jsonb_build_object('reason', p_reason, 'deleted_devices', v_deleted_count),
    now()
  );

  RETURN jsonb_build_object(
    'success',         true,
    'deleted_devices', v_deleted_count,
    'message',         'All devices deleted and security version bumped.'
  );
END;
$$;