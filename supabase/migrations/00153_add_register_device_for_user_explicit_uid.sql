
-- Migration: add register_device_for_user
-- Root cause: register_device() uses auth.uid() which returns NULL inside
-- SECURITY DEFINER functions when called via a user-scoped JWT client.
-- Fix: accept explicit p_user_id from the Edge Function (which already
-- verified the JWT via requireAuth) and use serviceClient to call this.
-- The service-role client is trusted — no auth.uid() needed.

CREATE OR REPLACE FUNCTION public.register_device_for_user(
  p_user_id         UUID,
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
BEGIN
  -- p_user_id is provided by the Edge Function after requireAuth() verification.
  -- No need for auth.uid() — the caller (service role via EF) is trusted.
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'p_user_id is required');
  END IF;

  SELECT max_devices, role
  INTO   v_max_devices, v_role
  FROM   profiles WHERE id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'User profile not found');
  END IF;

  -- ── Try existing device: installation_id first, then fingerprint ─────────────
  -- Include ALL statuses except 'blocked' so revoked/logged-out rows get re-activated.
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

  -- ── Known device: re-activate ─────────────────────────────────────────────
  IF v_device_id IS NOT NULL THEN
    UPDATE devices SET
      status          = 'active',
      trust_level     = 'trusted',
      last_active_at  = now(),
      app_version     = COALESCE(p_app_version,     app_version),
      os_version      = COALESCE(p_os_version,      os_version),
      ip_address      = COALESCE(p_ip_address,      ip_address),
      device_name     = COALESCE(NULLIF(p_device_name, 'Unknown Device'), device_name),
      installation_id = COALESCE(p_installation_id, installation_id),
      revoked_at      = NULL,
      revoked_reason  = NULL
    WHERE id = v_device_id;

    RETURN jsonb_build_object(
      'device_id',   v_device_id,
      'status',      'updated',
      'is_new',      false,
      'was_revoked', v_was_revoked
    );
  END IF;

  -- ── New device: enforce limit ─────────────────────────────────────────────
  -- Unlimited: super_admin OR max_devices IS NULL
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

-- Grant execute to service role (used by Edge Functions)
GRANT EXECUTE ON FUNCTION public.register_device_for_user(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO service_role;
