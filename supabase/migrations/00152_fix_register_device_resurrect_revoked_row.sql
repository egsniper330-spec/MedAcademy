
-- ============================================================
-- FIX: register_device resurrects revoked device rows
--
-- ROOT CAUSE: The lookup for a "known device" used:
--   WHERE status != 'blocked'
-- This also matches status='logged_out' / trust_level='revoked' rows
-- (set by admin_reset_device). When the same device re-logs in,
-- register_device finds the old revoked row, returns 'updated' (not
-- 're-registered'), leaving trust_level='revoked' in place.
-- The next checkRevocation call sees trust_level='revoked' →
-- authorized=false → forceSignOut: the user is kicked out within
-- seconds of a successful login.
--
-- FIX: When a known device row is found (by installation_id OR
-- fingerprint), also reset status='active' and trust_level='trusted'
-- so that a re-login after admin_reset properly re-activates the device.
-- This mirrors the intent of register_device: a successful
-- re-registration means the device is trusted again.
-- ============================================================
CREATE OR REPLACE FUNCTION public.register_device(
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
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id         UUID  := auth.uid();
  v_max_devices     INT;
  v_role            TEXT;
  v_device_count    INT;
  v_device_id       UUID;
  v_was_revoked     BOOLEAN := false;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Not authenticated');
  END IF;

  SELECT max_devices, role
  INTO   v_max_devices, v_role
  FROM   profiles WHERE id = v_user_id;

  -- ── Try to find existing device row ────────────────────────────────────────
  -- Search by installation_id first (stable across reinstalls), then fingerprint.
  -- IMPORTANT: include ALL statuses (including 'logged_out', 'revoked') so we
  -- can re-activate the row rather than creating a duplicate. Only 'blocked'
  -- rows are excluded — a blocked device must never be re-activated here.
  IF p_installation_id IS NOT NULL THEN
    SELECT id, (trust_level = 'revoked' OR status = 'logged_out')
    INTO   v_device_id, v_was_revoked
    FROM   devices
    WHERE  user_id         = v_user_id
      AND  installation_id = p_installation_id
      AND  status         != 'blocked'
    LIMIT  1;
  END IF;

  IF v_device_id IS NULL THEN
    SELECT id, (trust_level = 'revoked' OR status = 'logged_out')
    INTO   v_device_id, v_was_revoked
    FROM   devices
    WHERE  user_id            = v_user_id
      AND  device_fingerprint = p_fingerprint
      AND  status            != 'blocked'
    LIMIT  1;
  END IF;

  -- ── Known device → re-activate + update metadata ───────────────────────────
  -- Crucially: reset status='active' and trust_level='trusted' so that a
  -- device that was previously revoked by admin_reset is fully re-authorized
  -- on re-login. Without this, check_authorization sees trust_level='revoked'
  -- and immediately signs the user out again.
  IF v_device_id IS NOT NULL THEN
    UPDATE devices SET
      status          = 'active',
      trust_level     = 'trusted',
      last_active_at  = now(),
      app_version     = COALESCE(p_app_version,     app_version),
      os_version      = COALESCE(p_os_version,      os_version),
      ip_address      = COALESCE(p_ip_address,      ip_address),
      device_name     = COALESCE(p_device_name,     device_name),
      installation_id = COALESCE(p_installation_id, installation_id),
      -- clear revocation metadata on re-activation
      revoked_at      = NULL,
      revoked_reason  = NULL
    WHERE id = v_device_id;
    RETURN jsonb_build_object(
      'device_id',    v_device_id,
      'status',       'updated',
      'is_new',       false,
      'was_revoked',  v_was_revoked
    );
  END IF;

  -- ── New device: enforce limit ───────────────────────────────────────────────
  -- Unlimited bypass: super_admin OR max_devices IS NULL
  IF v_role = 'super_admin' OR v_max_devices IS NULL THEN
    INSERT INTO devices
      (user_id, device_fingerprint, installation_id, device_name, platform, ip_address,
       device_model, os, os_version, app_version, manufacturer,
       status, trust_level, first_login_at, registered_at, last_active_at)
    VALUES
      (v_user_id, p_fingerprint, p_installation_id, p_device_name, p_platform, p_ip_address,
       p_device_model, p_os, p_os_version, p_app_version, p_manufacturer,
       'active', 'trusted', now(), now(), now())
    RETURNING id INTO v_device_id;
    RETURN jsonb_build_object('device_id', v_device_id, 'status', 'registered', 'is_new', true, 'unlimited', true);
  END IF;

  -- Enforce device limit for new devices (active only — revoked/logged_out don't count)
  SELECT COUNT(*) INTO v_device_count
  FROM   devices
  WHERE  user_id = v_user_id
    AND  status NOT IN ('blocked', 'logged_out')
    AND  trust_level != 'revoked';

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
     status, trust_level, first_login_at, registered_at, last_active_at)
  VALUES
    (v_user_id, p_fingerprint, p_installation_id, p_device_name, p_platform, p_ip_address,
     p_device_model, p_os, p_os_version, p_app_version, p_manufacturer,
     'active', 'trusted', now(), now(), now())
  RETURNING id INTO v_device_id;
  RETURN jsonb_build_object('device_id', v_device_id, 'status', 'registered', 'is_new', true);
END;
$$;
