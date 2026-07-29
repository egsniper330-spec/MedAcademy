
-- ============================================================
-- SECURITY FIX: Blocked devices must never be allowed to login
-- ============================================================
--
-- Bug 1 — pre_login_device_check:
--   The "known installation_id → always allow" branch checked
--   `status != 'blocked'` correctly for the known-device lookup,
--   BUT: if the device IS blocked, the query returns no row
--   (v_existing_device IS NULL), and the function falls through
--   to the device-count check. Since the blocked device doesn't
--   count toward the active limit (also filtered with status != 'blocked'),
--   device_count < max_devices → returns allowed=true.
--   A blocked device can log in freely because the block causes
--   it to be treated as "no known device, under limit → allow".
--
-- Fix: explicitly check if a BLOCKED device matches the installation_id
--   or fingerprint BEFORE the known-device allow path. If blocked → deny.
--
-- Bug 2 — register_device_for_user:
--   The existing-device lookup (both installation_id and fingerprint
--   branches) uses `status != 'blocked'` to find the row to UPDATE.
--   If the device IS blocked, both lookups return nothing (v_device_id IS NULL),
--   and the function falls through to the new-device INSERT path,
--   inserting a brand-new row with status='active'. The blocked row
--   still exists but a new active row is created — effectively bypassing
--   the block entirely with a fresh device identity.
--
-- Fix: before the existing-device lookup, check if ANY row for this
--   user matches the installation_id or fingerprint with status='blocked'.
--   If found → return {error:'device_blocked', blocked:true}.

-- ── Fix 1: pre_login_device_check ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pre_login_device_check(
  p_email           text,
  p_installation_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id         UUID;
  v_max_devices     INT;
  v_role            TEXT;
  v_status          TEXT;
  v_device_count    INT;
  v_existing_device UUID;
  v_blocked_device  UUID;
BEGIN
  SELECT p.id, p.max_devices, p.role, p.status
  INTO   v_user_id, v_max_devices, v_role, v_status
  FROM   profiles p
  WHERE  lower(p.email) = lower(p_email)
  LIMIT  1;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'deleted', true,
      'reason',  'No account found for this email or phone number.'
    );
  END IF;

  IF v_status IN ('trashed', 'deleted') THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'deleted', true,
      'reason',  'No account found for this email or phone number.'
    );
  END IF;

  -- ── SECURITY: Blocked device check FIRST ────────────────────────────────────
  -- Before ANY allow path, check if the device presenting this installation_id
  -- is currently blocked. A blocked device must never be allowed through —
  -- even if it is a "known" device or the account is under the device limit.
  IF p_installation_id IS NOT NULL THEN
    SELECT id INTO v_blocked_device
    FROM   devices
    WHERE  user_id         = v_user_id
      AND  installation_id = p_installation_id
      AND  status          = 'blocked'
    LIMIT  1;

    IF v_blocked_device IS NOT NULL THEN
      RETURN jsonb_build_object(
        'allowed',        false,
        'device_blocked', true,
        'reason',         'This device has been blocked by the administrator. Please contact support.'
      );
    END IF;
  END IF;

  -- Unlimited: super_admin OR max_devices IS NULL
  IF v_role = 'super_admin' OR v_max_devices IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'unlimited', true);
  END IF;

  -- Known installation_id that is NOT blocked → always allow (same device re-login)
  SELECT id INTO v_existing_device
  FROM   devices
  WHERE  user_id         = v_user_id
    AND  installation_id = p_installation_id
    AND  status         != 'blocked'
  LIMIT  1;

  IF v_existing_device IS NOT NULL THEN
    RETURN jsonb_build_object('allowed', true, 'known_device', true);
  END IF;

  -- Count active (non-blocked) devices
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

GRANT EXECUTE ON FUNCTION public.pre_login_device_check(TEXT, TEXT) TO anon, authenticated;


-- ── Fix 2: register_device_for_user ───────────────────────────────────────────
-- Add an explicit blocked-device check BEFORE the existing-device lookup.
-- If ANY row for (user_id, installation_id) or (user_id, fingerprint) has
-- status='blocked', return an error immediately — never insert a new row.
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

  -- ── SECURITY: Reject if device is blocked ─────────────────────────────────
  -- Check by installation_id first (most stable identifier), then fingerprint.
  -- A blocked device must NEVER be re-activated or get a new active row.
  -- This prevents the bypass where the blocked row is skipped by `status != 'blocked'`
  -- and a fresh active row is inserted instead.
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

  -- ── Try existing device: installation_id first, then fingerprint ────────────
  -- Only consider non-blocked rows (revoked/logged-out can be re-activated).
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

  -- ── Known device: re-activate ──────────────────────────────────────────────
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
