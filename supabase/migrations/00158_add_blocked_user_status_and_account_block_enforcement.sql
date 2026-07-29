
-- ══════════════════════════════════════════════════════════════════════════════
-- Migration: Replace "suspended" with "blocked" for admin-initiated account
-- blocking. Suspended remains for system/violation use. Blocked is the
-- explicit super-admin action that triggers immediate session invalidation.
-- ══════════════════════════════════════════════════════════════════════════════

-- 1. Add 'blocked' to the user_status enum (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.user_status'::regtype
      AND enumlabel = 'blocked'
  ) THEN
    ALTER TYPE public.user_status ADD VALUE 'blocked';
  END IF;
END$$;

-- 2. Add audit action values for block/unblock (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.audit_action'::regtype
      AND enumlabel = 'user_blocked'
  ) THEN
    ALTER TYPE public.audit_action ADD VALUE 'user_blocked';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.audit_action'::regtype
      AND enumlabel = 'user_unblocked'
  ) THEN
    ALTER TYPE public.audit_action ADD VALUE 'user_unblocked';
  END IF;
END$$;

-- 3. Update set_user_status RPC to accept 'blocked' and use correct audit action
CREATE OR REPLACE FUNCTION public.set_user_status(
  p_user_id uuid,
  p_status  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor_id    uuid := auth.uid();
  v_actor_name  text;
  v_target_name text;
  v_action      audit_action;
BEGIN
  SELECT full_name INTO v_actor_name  FROM profiles WHERE id = v_actor_id;
  SELECT full_name INTO v_target_name FROM profiles WHERE id = p_user_id;

  UPDATE profiles
  SET    status     = p_status::user_status,
         updated_at = now()
  WHERE  id = p_user_id;

  v_action := CASE p_status
    WHEN 'suspended'  THEN 'user_suspended'::audit_action
    WHEN 'blocked'    THEN 'user_blocked'::audit_action
    WHEN 'unblocked'  THEN 'user_unblocked'::audit_action
    ELSE                   'user_activated'::audit_action
  END;

  INSERT INTO audit_logs (
    actor_id, actor_name, action, resource_type, resource_id,
    target_user_id, target_name, description, details, log_status
  ) VALUES (
    v_actor_id,
    COALESCE(v_actor_name, 'System'),
    v_action,
    'profile',
    p_user_id,
    p_user_id,
    COALESCE(v_target_name, p_user_id::text),
    COALESCE(v_actor_name, 'System') || ' set status to ' || p_status || ' for ' || COALESCE(v_target_name, p_user_id::text),
    jsonb_build_object('new_status', p_status),
    'success'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_user_status(uuid, text) TO authenticated;

-- 4. Update pre_login_device_check to block accounts with status='blocked'
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
  SELECT p.id, p.max_devices, p.role, p.status::text
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

  -- Trashed / deleted accounts
  IF v_status IN ('trashed', 'deleted') THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'deleted', true,
      'reason',  'No account found for this email or phone number.'
    );
  END IF;

  -- ── ACCOUNT BLOCKED (admin-initiated) ────────────────────────────────────
  IF v_status = 'blocked' THEN
    RETURN jsonb_build_object(
      'allowed',          false,
      'account_blocked',  true,
      'reason',           'Your account has been blocked. Please contact the administrator.'
    );
  END IF;

  -- ── SECURITY: Blocked DEVICE check ───────────────────────────────────────
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

  -- Known installation_id that is NOT blocked → always allow
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
