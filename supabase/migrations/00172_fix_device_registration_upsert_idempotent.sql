
-- ─────────────────────────────────────────────────────────────────────────────
-- Fix: Duplicate device registration on sign-in
--
-- Root causes:
--   1. devices_installation_id_unique is a GLOBAL unique index on installation_id
--      with no user_id scope. Two different users who reinstall on the same
--      device would share installation_id, and the second INSERT always fails.
--      The correct uniqueness scope is (user_id, installation_id), which is
--      already enforced by idx_devices_user_installation_unique.
--
--   2. register_device_for_user uses SELECT-then-INSERT which has a race
--      condition: two concurrent logins for the same user both pass the SELECT
--      (row not found) and both attempt INSERT, hitting the unique constraint.
--
-- Fix:
--   1. Drop the incorrect global unique constraint.
--   2. Rewrite register_device_for_user to use INSERT … ON CONFLICT DO UPDATE
--      (UPSERT) on both conflict targets so the operation is atomic and
--      idempotent regardless of concurrency or reinstall scenarios.
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: Drop the incorrectly-scoped global unique index
DROP INDEX IF EXISTS devices_installation_id_unique;

-- Step 2: Replace register_device_for_user with UPSERT-based implementation
CREATE OR REPLACE FUNCTION public.register_device_for_user(
  p_user_id         uuid,
  p_fingerprint     text,
  p_device_name     text    DEFAULT 'Unknown Device',
  p_platform        text    DEFAULT 'unknown',
  p_ip_address      text    DEFAULT NULL,
  p_device_model    text    DEFAULT NULL,
  p_os              text    DEFAULT NULL,
  p_os_version      text    DEFAULT NULL,
  p_app_version     text    DEFAULT NULL,
  p_manufacturer    text    DEFAULT NULL,
  p_installation_id text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_devices  INT;
  v_role         TEXT;
  v_device_count INT;
  v_device_id    UUID;
  v_blocked_id   UUID;
  v_was_revoked  BOOLEAN := false;
  v_is_new       BOOLEAN := false;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'p_user_id is required');
  END IF;

  SELECT max_devices, role
  INTO   v_max_devices, v_role
  FROM   profiles
  WHERE  id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'User profile not found');
  END IF;

  -- ── SECURITY: reject blocked devices ────────────────────────────────────────
  IF p_installation_id IS NOT NULL THEN
    SELECT id INTO v_blocked_id
    FROM   devices
    WHERE  user_id         = p_user_id
      AND  installation_id = p_installation_id
      AND  status          = 'blocked'
    LIMIT 1;
  END IF;

  IF v_blocked_id IS NULL THEN
    SELECT id INTO v_blocked_id
    FROM   devices
    WHERE  user_id            = p_user_id
      AND  device_fingerprint = p_fingerprint
      AND  status             = 'blocked'
    LIMIT 1;
  END IF;

  IF v_blocked_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'error',          'This device has been blocked by the administrator. Please contact support.',
      'device_blocked', true,
      'device_id',      v_blocked_id
    );
  END IF;

  -- ── Check for existing non-blocked row ──────────────────────────────────────
  -- Priority: installation_id (stable across reinstalls) > fingerprint
  IF p_installation_id IS NOT NULL THEN
    SELECT id, (trust_level = 'revoked' OR status = 'logged_out')
    INTO   v_device_id, v_was_revoked
    FROM   devices
    WHERE  user_id         = p_user_id
      AND  installation_id = p_installation_id
      AND  status         != 'blocked'
    LIMIT 1;
  END IF;

  IF v_device_id IS NULL THEN
    SELECT id, (trust_level = 'revoked' OR status = 'logged_out')
    INTO   v_device_id, v_was_revoked
    FROM   devices
    WHERE  user_id            = p_user_id
      AND  device_fingerprint = p_fingerprint
      AND  status            != 'blocked'
    LIMIT 1;
  END IF;

  -- ── Known device: re-activate via UPSERT on (user_id, installation_id) ──────
  IF v_device_id IS NOT NULL THEN
    UPDATE devices SET
      status             = 'active',
      trust_level        = 'trusted',
      last_active_at     = now(),
      device_fingerprint = p_fingerprint,
      app_version        = COALESCE(p_app_version,  app_version),
      os_version         = COALESCE(p_os_version,   os_version),
      ip_address         = COALESCE(p_ip_address,   ip_address),
      device_name        = COALESCE(NULLIF(p_device_name, 'Unknown Device'), device_name),
      installation_id    = COALESCE(p_installation_id, installation_id),
      revoked_at         = NULL,
      revoked_reason     = NULL
    WHERE id = v_device_id;

    RETURN jsonb_build_object(
      'device_id',   v_device_id,
      'status',      'updated',
      'is_new',      false,
      'was_revoked', v_was_revoked
    );
  END IF;

  -- ── New device: enforce limit (unlimited for super_admin or max_devices NULL) ─
  IF v_role != 'super_admin' AND v_max_devices IS NOT NULL THEN
    SELECT COUNT(*) INTO v_device_count
    FROM   devices
    WHERE  user_id     = p_user_id
      AND  status     NOT IN ('blocked', 'logged_out')
      AND  trust_level != 'revoked';

    IF v_device_count >= v_max_devices THEN
      RETURN jsonb_build_object(
        'error',         'This account is already active on another authorized device.',
        'limit_reached', true,
        'current_count', v_device_count,
        'max_devices',   v_max_devices
      );
    END IF;
  END IF;

  v_is_new := true;

  -- ── UPSERT on (user_id, installation_id) — eliminates race condition ─────────
  -- If two concurrent logins both pass the SELECT above, the second INSERT will
  -- hit ON CONFLICT and run the UPDATE instead of throwing a duplicate-key error.
  IF p_installation_id IS NOT NULL THEN
    INSERT INTO devices (
      user_id, device_fingerprint, installation_id, device_name, platform, ip_address,
      device_model, os, os_version, app_version, manufacturer,
      status, trust_level, first_login_at, registered_at, last_active_at
    ) VALUES (
      p_user_id, p_fingerprint, p_installation_id, p_device_name, p_platform, p_ip_address,
      p_device_model, p_os, p_os_version, p_app_version, p_manufacturer,
      'active', 'trusted', now(), now(), now()
    )
    ON CONFLICT (user_id, installation_id) WHERE installation_id IS NOT NULL
    DO UPDATE SET
      status             = 'active',
      trust_level        = 'trusted',
      last_active_at     = now(),
      device_fingerprint = EXCLUDED.device_fingerprint,
      app_version        = COALESCE(EXCLUDED.app_version,  devices.app_version),
      os_version         = COALESCE(EXCLUDED.os_version,   devices.os_version),
      ip_address         = COALESCE(EXCLUDED.ip_address,   devices.ip_address),
      device_name        = COALESCE(NULLIF(EXCLUDED.device_name, 'Unknown Device'), devices.device_name),
      revoked_at         = NULL,
      revoked_reason     = NULL
    RETURNING id INTO v_device_id;
  ELSE
    -- No installation_id: UPSERT on (user_id, device_fingerprint)
    INSERT INTO devices (
      user_id, device_fingerprint, installation_id, device_name, platform, ip_address,
      device_model, os, os_version, app_version, manufacturer,
      status, trust_level, first_login_at, registered_at, last_active_at
    ) VALUES (
      p_user_id, p_fingerprint, NULL, p_device_name, p_platform, p_ip_address,
      p_device_model, p_os, p_os_version, p_app_version, p_manufacturer,
      'active', 'trusted', now(), now(), now()
    )
    ON CONFLICT (user_id, device_fingerprint)
    DO UPDATE SET
      status         = 'active',
      trust_level    = 'trusted',
      last_active_at = now(),
      app_version    = COALESCE(EXCLUDED.app_version,  devices.app_version),
      os_version     = COALESCE(EXCLUDED.os_version,   devices.os_version),
      ip_address     = COALESCE(EXCLUDED.ip_address,   devices.ip_address),
      device_name    = COALESCE(NULLIF(EXCLUDED.device_name, 'Unknown Device'), devices.device_name),
      revoked_at     = NULL,
      revoked_reason = NULL
    RETURNING id INTO v_device_id;
  END IF;

  RETURN jsonb_build_object(
    'device_id', v_device_id,
    'status',    'registered',
    'is_new',    v_is_new,
    'unlimited', (v_role = 'super_admin' OR v_max_devices IS NULL)
  );
END;
$$;
