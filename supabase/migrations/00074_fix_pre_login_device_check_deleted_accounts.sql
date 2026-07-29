-- v99: Fix BUG #1 — deleted accounts must never reach auth.signInWithPassword
-- Root cause: pre_login_device_check returns {allowed:true} when no profile row
-- exists, allowing the call to reach Supabase Auth where the auth.users row
-- still has ban_duration='87600h' set by trash-user. Supabase then returns
-- "User is banned." which the UI surfaces as "Account Banned".
--
-- Fix: return {allowed:false, deleted:true} when profile is not found so the
-- sign-in flow shows "No account found." before any auth call is made.

CREATE OR REPLACE FUNCTION public.pre_login_device_check(
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
  v_status          TEXT;
  v_device_count    INT;
  v_existing_device UUID;
BEGIN
  SELECT p.id, p.max_devices, p.allow_unlimited, p.role, p.status
  INTO   v_user_id, v_max_devices, v_allow_unlimited, v_role, v_status
  FROM   profiles p
  WHERE  lower(p.email) = lower(p_email)
  LIMIT  1;

  -- ── CRITICAL FIX ──────────────────────────────────────────────────────────
  -- If no profile row found, the account was either never registered or has
  -- been permanently deleted.  Do NOT pass through to Supabase Auth — the
  -- auth.users row may still exist with ban_duration set (from the trash step
  -- that precedes hard deletion).  Letting the call through causes Auth to
  -- return "User is banned." which surfaces as "Account Banned" in the UI
  -- even though the account no longer exists.
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'deleted', true,
      'reason',  'No account found for this email or phone number.'
    );
  END IF;
  -- ── END CRITICAL FIX ──────────────────────────────────────────────────────

  -- Trashed / permanently deleted profile — same guard for status-based checks
  IF v_status IN ('trashed', 'deleted') THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'deleted', true,
      'reason',  'No account found for this email or phone number.'
    );
  END IF;

  -- Unlimited / super_admin bypass
  IF v_allow_unlimited = true OR v_role = 'super_admin' OR v_max_devices IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'unlimited', true);
  END IF;

  -- Known installation_id → always allow
  SELECT id INTO v_existing_device
  FROM   devices
  WHERE  user_id         = v_user_id
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

GRANT EXECUTE ON FUNCTION public.pre_login_device_check(TEXT, TEXT) TO anon, authenticated;

-- Also fix get_email_by_phone to exclude trashed/deleted profiles so that
-- phone-based login for a deleted account also fails gracefully at the RPC
-- level (pre_login_device_check) rather than reaching Supabase Auth.
CREATE OR REPLACE FUNCTION public.get_email_by_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_e164  TEXT;
  v_email TEXT;
BEGIN
  v_e164 := normalize_phone_e164(p_phone);

  IF v_e164 IS NOT NULL THEN
    SELECT email INTO v_email
    FROM   public.profiles
    WHERE  phone_e164 = v_e164
      AND  status NOT IN ('trashed', 'deleted')
    LIMIT  1;

    IF v_email IS NOT NULL THEN RETURN v_email; END IF;

    SELECT email INTO v_email
    FROM   public.profiles
    WHERE  (phone_e164 = p_phone OR phone = p_phone)
      AND  status NOT IN ('trashed', 'deleted')
    LIMIT  1;

    IF v_email IS NOT NULL THEN RETURN v_email; END IF;
  END IF;

  -- Final fallback: raw phone, exclude deleted/trashed
  SELECT email INTO v_email
  FROM   public.profiles
  WHERE  (phone = p_phone OR phone_e164 = p_phone)
    AND  status NOT IN ('trashed', 'deleted')
  LIMIT  1;

  RETURN v_email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text) TO anon, authenticated;