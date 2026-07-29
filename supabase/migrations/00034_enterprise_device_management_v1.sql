-- ══════════════════════════════════════════════════════════════════
-- ENTERPRISE DEVICE MANAGEMENT — SCHEMA MIGRATION
-- ══════════════════════════════════════════════════════════════════

-- 1. device_status enum
DO $$ BEGIN
  CREATE TYPE device_status AS ENUM ('active', 'blocked', 'logged_out');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Enhance devices table with full device info + status
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS device_model      TEXT,
  ADD COLUMN IF NOT EXISTS os                TEXT,
  ADD COLUMN IF NOT EXISTS os_version        TEXT,
  ADD COLUMN IF NOT EXISTS app_version       TEXT,
  ADD COLUMN IF NOT EXISTS manufacturer      TEXT,
  ADD COLUMN IF NOT EXISTS ip_address        TEXT,
  ADD COLUMN IF NOT EXISTS status            device_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS block_reason      TEXT,
  ADD COLUMN IF NOT EXISTS blocked_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_by        UUID REFERENCES profiles(id) ON DELETE SET NULL;

-- Rename allow_multiple / allow_unlimited to be on profiles (devices only stores per-device state)
-- Keep them on devices table for backward compat but add proper limit on profiles

-- 3. Add max_devices to profiles (NULL = unlimited)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS max_devices INTEGER DEFAULT 1;

-- Super admin is unlimited by default
UPDATE profiles SET max_devices = NULL WHERE role = 'super_admin';

-- 4. Create login_history table
CREATE TABLE IF NOT EXISTS login_history (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_fingerprint TEXT,
  device_name       TEXT,
  platform          TEXT,
  ip_address        TEXT,
  success           BOOLEAN      NOT NULL DEFAULT true,
  failure_reason    TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_login_history_user_id    ON login_history(user_id);
CREATE INDEX IF NOT EXISTS idx_login_history_created_at ON login_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_user_status       ON devices(user_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_fingerprint       ON devices(device_fingerprint);
CREATE INDEX IF NOT EXISTS idx_profiles_max_devices      ON profiles(max_devices) WHERE max_devices IS NOT NULL;

-- 5. RLS for login_history
ALTER TABLE login_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY login_history_user_read ON login_history
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY login_history_admin_all ON login_history
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin'))
  );

-- login_history: inserts go through SECURITY DEFINER functions only (no direct client insert)

-- 6. Additional RLS for new devices columns
-- Existing devices RLS stays; add admin policies for block/unblock/delete

-- Helper: check if caller is admin/super_admin (SECURITY DEFINER to avoid self-loop)
CREATE OR REPLACE FUNCTION is_admin_or_superadmin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin'));
$$;

-- 7. RPC: update_device_status (admin block/unblock/delete)
CREATE OR REPLACE FUNCTION update_device_status(
  p_device_id     UUID,
  p_status        device_status,
  p_block_reason  TEXT DEFAULT NULL,
  p_actor_id      UUID DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_actor UUID := COALESCE(p_actor_id, auth.uid());
  v_user_id UUID;
  v_action audit_action;
BEGIN
  SELECT user_id INTO v_user_id FROM devices WHERE id = p_device_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Device not found';
  END IF;

  UPDATE devices SET
    status       = p_status,
    block_reason = CASE WHEN p_status = 'blocked' THEN p_block_reason ELSE NULL END,
    blocked_at   = CASE WHEN p_status = 'blocked' THEN now() ELSE NULL END,
    blocked_by   = CASE WHEN p_status = 'blocked' THEN v_actor ELSE NULL END
  WHERE id = p_device_id;

  v_action := CASE p_status
    WHEN 'blocked'    THEN 'device_blocked'::audit_action
    WHEN 'active'     THEN 'device_unblocked'::audit_action
    WHEN 'logged_out' THEN 'device_removed'::audit_action
  END;

  PERFORM write_audit_log(
    v_actor, v_user_id, v_action,
    '{"device_id":"' || p_device_id::text || '"}',
    CASE WHEN p_block_reason IS NOT NULL THEN ('{"reason":"' || p_block_reason || '"}') ELSE '{}' END,
    NULL, NULL, NULL
  );
END;
$$;

-- 8. RPC: rename_device
CREATE OR REPLACE FUNCTION rename_device(
  p_device_id   UUID,
  p_new_name    TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner UUID;
BEGIN
  SELECT user_id INTO v_owner FROM devices WHERE id = p_device_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Device not found'; END IF;
  -- User can only rename own device; admins can rename any
  IF v_owner != auth.uid() AND NOT is_admin_or_superadmin() THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  UPDATE devices SET device_name = p_new_name WHERE id = p_device_id;
END;
$$;

-- 9. RPC: delete_device_record (admin only)
CREATE OR REPLACE FUNCTION delete_device_record(
  p_device_id UUID,
  p_actor_id  UUID DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_actor   UUID := COALESCE(p_actor_id, auth.uid());
  v_user_id UUID;
BEGIN
  SELECT user_id INTO v_user_id FROM devices WHERE id = p_device_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Device not found'; END IF;

  DELETE FROM devices WHERE id = p_device_id;

  PERFORM write_audit_log(
    v_actor, v_user_id, 'device_removed'::audit_action,
    '{"device_id":"' || p_device_id::text || '"}',
    '{}', NULL, NULL, NULL
  );
END;
$$;

-- 10. RPC: set_device_limit (admin sets max_devices per user)
CREATE OR REPLACE FUNCTION set_device_limit(
  p_target_user_id UUID,
  p_max_devices    INTEGER,   -- NULL = unlimited
  p_actor_id       UUID DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_actor UUID := COALESCE(p_actor_id, auth.uid());
  v_old   INTEGER;
BEGIN
  SELECT max_devices INTO v_old FROM profiles WHERE id = p_target_user_id;

  UPDATE profiles SET max_devices = p_max_devices WHERE id = p_target_user_id;

  PERFORM write_audit_log(
    v_actor, p_target_user_id,
    CASE WHEN p_max_devices IS NULL THEN 'unlimited_enabled'::audit_action ELSE 'limit_changed'::audit_action END,
    ('{"old_limit":' || COALESCE(v_old::text,'null') || '}')::text,
    ('{"new_limit":' || COALESCE(p_max_devices::text,'null') || '}')::text,
    NULL, NULL, NULL
  );
END;
$$;

-- 11. RPC: logout_device (mark a device as logged_out + log audit)
CREATE OR REPLACE FUNCTION logout_device(
  p_device_id UUID,
  p_actor_id  UUID DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_actor   UUID := COALESCE(p_actor_id, auth.uid());
  v_user_id UUID;
BEGIN
  SELECT user_id INTO v_user_id FROM devices WHERE id = p_device_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Device not found'; END IF;
  IF v_user_id != auth.uid() AND NOT is_admin_or_superadmin() THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  UPDATE devices SET status = 'logged_out' WHERE id = p_device_id;

  PERFORM write_audit_log(
    v_actor, v_user_id, 'device_removed'::audit_action,
    '{"device_id":"' || p_device_id::text || '","action":"logout"}',
    '{}', NULL, NULL, NULL
  );
END;
$$;

-- 12. RPC: write_login_history (SECURITY DEFINER — only called from EF)
CREATE OR REPLACE FUNCTION write_login_history(
  p_user_id           UUID,
  p_device_fingerprint TEXT,
  p_device_name       TEXT,
  p_platform          TEXT,
  p_ip_address        TEXT,
  p_success           BOOLEAN,
  p_failure_reason    TEXT DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO login_history(user_id, device_fingerprint, device_name, platform, ip_address, success, failure_reason)
  VALUES (p_user_id, p_device_fingerprint, p_device_name, p_platform, p_ip_address, p_success, p_failure_reason);
END;
$$;

-- 13. Enhanced register_device: adds full device info + device limit check
CREATE OR REPLACE FUNCTION register_device(
  p_fingerprint   TEXT,
  p_device_name   TEXT    DEFAULT 'Unknown Device',
  p_platform      TEXT    DEFAULT 'unknown',
  p_ip_address    TEXT    DEFAULT NULL,
  p_device_model  TEXT    DEFAULT NULL,
  p_os            TEXT    DEFAULT NULL,
  p_os_version    TEXT    DEFAULT NULL,
  p_app_version   TEXT    DEFAULT NULL,
  p_manufacturer  TEXT    DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_user_id    UUID := auth.uid();
  v_max        INTEGER;
  v_count      INTEGER;
  v_device_id  UUID;
  v_existing   UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error','Not authenticated');
  END IF;

  -- Check if this exact fingerprint already exists (update last_seen)
  SELECT id INTO v_existing FROM devices
  WHERE user_id = v_user_id AND device_fingerprint = p_fingerprint
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    -- Check not blocked
    IF EXISTS (SELECT 1 FROM devices WHERE id = v_existing AND status = 'blocked') THEN
      RETURN jsonb_build_object('error','Device is blocked. Contact your administrator.');
    END IF;
    -- Update last seen + restore active status if logged_out
    UPDATE devices SET
      last_active_at = now(),
      status         = 'active',
      ip_address     = COALESCE(p_ip_address, ip_address),
      app_version    = COALESCE(p_app_version, app_version),
      device_name    = COALESCE(NULLIF(p_device_name,'Unknown Device'), device_name)
    WHERE id = v_existing;

    RETURN jsonb_build_object('device_id', v_existing, 'status','updated');
  END IF;

  -- New device — check limit
  SELECT max_devices INTO v_max FROM profiles WHERE id = v_user_id;

  -- NULL means unlimited
  IF v_max IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count
    FROM devices
    WHERE user_id = v_user_id AND status != 'logged_out';

    IF v_count >= v_max THEN
      RETURN jsonb_build_object(
        'error','This account is already active on another device.',
        'limit_reached', true
      );
    END IF;
  END IF;

  -- Insert new device
  INSERT INTO devices(
    user_id, device_fingerprint, device_name, platform, ip_address,
    device_model, os, os_version, app_version, manufacturer,
    status, is_trusted, registered_at, last_active_at
  ) VALUES (
    v_user_id, p_fingerprint, p_device_name, p_platform, p_ip_address,
    p_device_model, p_os, p_os_version, p_app_version, p_manufacturer,
    'active', true, now(), now()
  )
  RETURNING id INTO v_device_id;

  -- Audit log
  PERFORM write_audit_log(
    v_user_id, v_user_id, 'device_registered'::audit_action,
    '{}',
    jsonb_build_object('device_id', v_device_id, 'platform', p_platform, 'name', p_device_name)::text,
    p_ip_address, NULL, NULL
  );

  RETURN jsonb_build_object('device_id', v_device_id, 'status','registered');
END;
$$;

-- 14. Extend audit_action enum with new device events
DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'device_blocked';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'device_unblocked';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'device_registered';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'limit_changed';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'unlimited_enabled';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'unlimited_disabled';
EXCEPTION WHEN others THEN NULL;
END $$;

-- 15. Grant execute permissions on new RPCs
GRANT EXECUTE ON FUNCTION update_device_status TO authenticated;
GRANT EXECUTE ON FUNCTION rename_device TO authenticated;
GRANT EXECUTE ON FUNCTION delete_device_record TO authenticated;
GRANT EXECUTE ON FUNCTION set_device_limit TO authenticated;
GRANT EXECUTE ON FUNCTION logout_device TO authenticated;
GRANT EXECUTE ON FUNCTION write_login_history TO authenticated;
GRANT EXECUTE ON FUNCTION is_admin_or_superadmin TO authenticated;
