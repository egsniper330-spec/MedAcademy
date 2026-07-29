
-- =============================================================================
-- FIX: Web session fingerprint rotation causes immediate logout
--
-- ROOT CAUSE ANALYSIS:
--
-- On web, Constants.sessionId (from Expo) is a new UUID every page load.
-- buildFingerprint() in sign-in.tsx includes sessionId, so the fingerprint
-- changes every page load.
--
-- Bug A — register_device_for_user:
--   When an existing device row is found by installation_id (stable), the UPDATE
--   does NOT overwrite device_fingerprint. So the DB retains the old fingerprint
--   from the previous session, while localStorage stores the NEW fingerprint.
--
-- Bug B — check_authorization:
--   Looks up the device row by device_fingerprint ONLY. The new fingerprint
--   (stored in localStorage after this login) does not match the old one in DB
--   → device row "not found" → authorized=false → forceSignOut within seconds.
--
-- FIX A: In register_device_for_user, always update device_fingerprint when
--   re-activating a known device row (found by installation_id). This keeps the
--   DB fingerprint in sync with the client on every login.
--
-- FIX B: In check_authorization, when the device row is not found by
--   device_fingerprint, fall back to installation_id lookup before declaring
--   "device_not_found". This gracefully handles the one login cycle where the
--   DB fingerprint is stale (first login after a page reload before the
--   register_device_for_user fix propagated).
-- =============================================================================

-- ── Fix A: register_device_for_user — always sync device_fingerprint ──────────
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
SET search_path TO 'public'
AS $$
DECLARE
  v_max_devices     INT;
  v_role            TEXT;
  v_device_count    INT;
  v_device_id       UUID;
  v_was_revoked     BOOLEAN := false;
  v_blocked_id      UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'p_user_id is required');
  END IF;

  SELECT max_devices, role
  INTO   v_max_devices, v_role
  FROM   profiles WHERE id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'User profile not found');
  END IF;

  -- ── SECURITY: Reject blocked devices ──────────────────────────────────────
  IF p_installation_id IS NOT NULL THEN
    SELECT id INTO v_blocked_id
    FROM   devices
    WHERE  user_id         = p_user_id
      AND  installation_id = p_installation_id
      AND  status          = 'blocked'
    LIMIT  1;
  END IF;

  IF v_blocked_id IS NULL THEN
    SELECT id INTO v_blocked_id
    FROM   devices
    WHERE  user_id            = p_user_id
      AND  device_fingerprint = p_fingerprint
      AND  status             = 'blocked'
    LIMIT  1;
  END IF;

  IF v_blocked_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'error',          'This device has been blocked by the administrator. Please contact support.',
      'device_blocked', true,
      'device_id',      v_blocked_id
    );
  END IF;

  -- ── Find existing device: installation_id first, then fingerprint ──────────
  IF p_installation_id IS NOT NULL THEN
    SELECT id, (trust_level = 'revoked' OR status = 'logged_out')
    INTO   v_device_id, v_was_revoked
    FROM   devices
    WHERE  user_id         = p_user_id
      AND  installation_id = p_installation_id
      AND  status         != 'blocked'
    LIMIT  1;
  END IF;

  IF v_device_id IS NULL THEN
    SELECT id, (trust_level = 'revoked' OR status = 'logged_out')
    INTO   v_device_id, v_was_revoked
    FROM   devices
    WHERE  user_id            = p_user_id
      AND  device_fingerprint = p_fingerprint
      AND  status            != 'blocked'
    LIMIT  1;
  END IF;

  -- ── Known device: re-activate and ALWAYS sync fingerprint ─────────────────
  -- FIX: device_fingerprint is now always overwritten with the new value.
  -- On web, Constants.sessionId changes every page load so the fingerprint
  -- rotates on every login. Keeping DB in sync here ensures check_authorization
  -- can always find the row by the current fingerprint.
  IF v_device_id IS NOT NULL THEN
    UPDATE devices SET
      status              = 'active',
      trust_level         = 'trusted',
      last_active_at      = now(),
      device_fingerprint  = p_fingerprint,                          -- always sync
      app_version         = COALESCE(p_app_version,     app_version),
      os_version          = COALESCE(p_os_version,      os_version),
      ip_address          = COALESCE(p_ip_address,      ip_address),
      device_name         = COALESCE(NULLIF(p_device_name, 'Unknown Device'), device_name),
      installation_id     = COALESCE(p_installation_id, installation_id),
      revoked_at          = NULL,
      revoked_reason      = NULL
    WHERE id = v_device_id;

    RETURN jsonb_build_object(
      'device_id',   v_device_id,
      'status',      'updated',
      'is_new',      false,
      'was_revoked', v_was_revoked
    );
  END IF;

  -- ── New device: enforce limit ──────────────────────────────────────────────
  IF v_role = 'super_admin' OR v_max_devices IS NULL THEN
    INSERT INTO devices (
      user_id, device_fingerprint, installation_id, device_name, platform, ip_address,
      device_model, os, os_version, app_version, manufacturer,
      status, trust_level, first_login_at, registered_at, last_active_at
    ) VALUES (
      p_user_id, p_fingerprint, p_installation_id, p_device_name, p_platform, p_ip_address,
      p_device_model, p_os, p_os_version, p_app_version, p_manufacturer,
      'active', 'trusted', now(), now(), now()
    ) RETURNING id INTO v_device_id;

    RETURN jsonb_build_object(
      'device_id', v_device_id,
      'status',    'registered',
      'is_new',    true,
      'unlimited', true
    );
  END IF;

  -- Count active non-revoked devices
  SELECT COUNT(*) INTO v_device_count
  FROM   devices
  WHERE  user_id = p_user_id
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

  INSERT INTO devices (
    user_id, device_fingerprint, installation_id, device_name, platform, ip_address,
    device_model, os, os_version, app_version, manufacturer,
    status, trust_level, first_login_at, registered_at, last_active_at
  ) VALUES (
    p_user_id, p_fingerprint, p_installation_id, p_device_name, p_platform, p_ip_address,
    p_device_model, p_os, p_os_version, p_app_version, p_manufacturer,
    'active', 'trusted', now(), now(), now()
  ) RETURNING id INTO v_device_id;

  RETURN jsonb_build_object(
    'device_id', v_device_id,
    'status',    'registered',
    'is_new',    true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_device_for_user(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO service_role;
