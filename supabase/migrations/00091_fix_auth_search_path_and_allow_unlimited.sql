
-- ============================================================
-- FIX 1: handle_new_user()
-- ============================================================
-- ROOT CAUSE: supabase_auth_admin role has search_path = 'auth' ONLY.
-- handle_new_user() has no SET search_path, so it inherits 'auth'.
-- gen_random_bytes() lives in 'extensions' schema → ERROR 42883.
-- FIX: pin search_path to 'public', 'extensions'.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_wm      text;
  v_conflict bool;
BEGIN
  LOOP
    v_wm       := 'WM-' || upper(left(encode(gen_random_bytes(6), 'hex'), 8));
    v_conflict := EXISTS (SELECT 1 FROM profiles WHERE watermark_id = v_wm);
    EXIT WHEN NOT v_conflict;
  END LOOP;

  INSERT INTO profiles (id, email, full_name, role, watermark_id)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'student'),
    v_wm
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ============================================================
-- FIX 2: pre_login_device_check()
-- ============================================================
-- ROOT CAUSE: queries profiles.allow_unlimited which does NOT exist
-- in profiles (it exists only in devices). → ERROR 42703.
-- FIX: remove allow_unlimited from SELECT; unlimited = max_devices IS NULL.
-- ============================================================
CREATE OR REPLACE FUNCTION public.pre_login_device_check(
  p_email          text,
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

  -- Unlimited: super_admin OR max_devices IS NULL
  IF v_role = 'super_admin' OR v_max_devices IS NULL THEN
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

-- ============================================================
-- FIX 3: register_device() 10-param overload
-- ============================================================
-- ROOT CAUSE: queries profiles.allow_unlimited which does NOT exist → ERROR 42703.
-- FIX: remove allow_unlimited from SELECT; unlimited = max_devices IS NULL.
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
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Not authenticated');
  END IF;

  SELECT max_devices, role
  INTO   v_max_devices, v_role
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
      app_version     = COALESCE(p_app_version,  app_version),
      os_version      = COALESCE(p_os_version,   os_version),
      ip_address      = COALESCE(p_ip_address,   ip_address),
      installation_id = COALESCE(p_installation_id, installation_id)
    WHERE id = v_device_id;
    RETURN jsonb_build_object('device_id', v_device_id, 'status', 'updated', 'is_new', false);
  END IF;

  -- Unlimited bypass: super_admin OR max_devices IS NULL
  IF v_role = 'super_admin' OR v_max_devices IS NULL THEN
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

-- ============================================================
-- FIX 4: handle_doctor_credits() — add missing search_path
-- ============================================================
-- LATENT RISK: fires under postgres context (OK today), but unsafe
-- if trigger chain context ever changes. Pin it now.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_doctor_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.role = 'doctor' AND (OLD IS NULL OR OLD.role != 'doctor') THEN
    INSERT INTO credits (doctor_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- FIX 5: is_admin_or_super_admin() — add missing search_path
-- ============================================================
-- LATENT RISK: used in RLS policies; missing search_path is a
-- security concern and can break in certain call contexts.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_admin_or_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT role IN ('admin', 'super_admin') FROM profiles WHERE id = auth.uid();
$$;

-- ============================================================
-- CLEANUP: remove the diagnostic function created during audit
-- ============================================================
DROP FUNCTION IF EXISTS public._diag_test_trigger();

-- ============================================================
-- VERIFY: confirm handle_new_user now resolves gen_random_bytes
-- ============================================================
DO $$
DECLARE
  v_wm text;
BEGIN
  SET LOCAL search_path TO 'public', 'extensions';
  v_wm := 'WM-' || upper(left(encode(gen_random_bytes(6), 'hex'), 8));
  RAISE NOTICE 'gen_random_bytes OK under fixed search_path: %', v_wm;
END;
$$;
