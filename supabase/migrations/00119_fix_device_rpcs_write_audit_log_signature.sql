
-- Fix all device RPCs that call the dropped 8-arg write_audit_log(uuid,uuid,audit_action,...)
-- The canonical overload A is: (p_actor_id uuid, p_action audit_action, p_details jsonb,
--   p_resource_type text, p_resource_id uuid, p_ip_address text, p_success boolean, p_reason text)

-- ── 1. logout_device ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logout_device(
  p_device_id UUID,
  p_actor_id  UUID DEFAULT NULL
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_actor   UUID := COALESCE(p_actor_id, auth.uid());
  v_user_id UUID;
BEGIN
  SELECT user_id INTO v_user_id FROM devices WHERE id = p_device_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Device not found'; END IF;
  IF v_user_id != auth.uid() AND NOT is_admin_or_super_admin() THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  UPDATE devices SET status = 'logged_out' WHERE id = p_device_id;

  -- Use canonical overload A: (actor_id, action, details, resource_type, resource_id, ip, success, reason)
  PERFORM write_audit_log(
    v_actor,
    'device_removed'::audit_action,
    jsonb_build_object('device_id', p_device_id, 'action', 'logout'),
    'device',
    p_device_id,
    NULL::text,
    true,
    NULL::text
  );
END;
$$;

-- ── 2. force_logout_device ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.force_logout_device(
  p_device_id UUID,
  p_reason    TEXT DEFAULT 'Admin force logout'
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_owner_id UUID;
BEGIN
  IF NOT is_admin_or_super_admin() THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  SELECT user_id INTO v_owner_id FROM devices WHERE id = p_device_id;
  IF v_owner_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Device not found');
  END IF;

  UPDATE devices
  SET status         = 'logged_out',
      trust_level    = 'revoked',
      revoked_at     = now(),
      revoked_reason = p_reason
  WHERE id = p_device_id;

  UPDATE profiles
  SET security_version = COALESCE(security_version, 0) + 1
  WHERE id = v_owner_id;

  -- Use canonical overload A: (actor_id, action, details, resource_type, resource_id, ip, success, reason)
  PERFORM write_audit_log(
    v_admin_id,
    'device_force_logout'::audit_action,
    jsonb_build_object('device_id', p_device_id, 'owner_id', v_owner_id, 'reason', p_reason),
    'device',
    p_device_id,
    NULL::text,
    true,
    p_reason
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ── 3. logout_all_devices ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logout_all_devices(
  p_target_user_id    UUID,
  p_exclude_fingerprint TEXT DEFAULT NULL,
  p_reason            TEXT DEFAULT 'Admin logout all'
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_admin_id   UUID := auth.uid();
  v_admin_role TEXT;
BEGIN
  SELECT role INTO v_admin_role FROM profiles WHERE id = v_admin_id;
  IF v_admin_role NOT IN ('admin','super_admin') THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  UPDATE devices
  SET status         = 'logged_out',
      trust_level    = 'revoked',
      revoked_at     = now(),
      revoked_reason = p_reason
  WHERE user_id = p_target_user_id
    AND status  != 'logged_out'
    AND (p_exclude_fingerprint IS NULL OR device_fingerprint != p_exclude_fingerprint);

  UPDATE profiles
  SET security_version = COALESCE(security_version, 0) + 1
  WHERE id = p_target_user_id;

  -- Use canonical overload A: (actor_id, action, details, resource_type, resource_id, ip, success, reason)
  PERFORM write_audit_log(
    v_admin_id,
    'device_logout_all'::audit_action,
    jsonb_build_object('target_user', p_target_user_id, 'reason', p_reason,
                       'excluded_fp', p_exclude_fingerprint),
    'device',
    p_target_user_id,
    NULL::text,
    true,
    p_reason
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ── 4. create_activation_code — also used overload A incorrectly ──────────────
-- Live function also has the bad 8-arg call; replace it with overload A.
CREATE OR REPLACE FUNCTION public.create_activation_code(
  p_course_id       UUID,
  p_expires_at      TIMESTAMPTZ DEFAULT NULL,
  p_idempotency_key TEXT        DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_role     TEXT;
  v_code     TEXT;
  v_record   activation_codes%ROWTYPE;
  v_result   jsonb;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = v_admin_id;
  IF v_role NOT IN ('admin','super_admin') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_result
    FROM idempotency_keys
    WHERE key = p_idempotency_key AND user_id = v_admin_id;
    IF v_result IS NOT NULL THEN RETURN v_result; END IF;
  END IF;

  LOOP
    v_code := upper(encode(extensions.gen_random_bytes(8), 'hex'));
    EXIT WHEN NOT EXISTS(SELECT 1 FROM activation_codes WHERE code = v_code);
  END LOOP;

  INSERT INTO activation_codes (code, course_id, expires_at, created_by)
  VALUES (v_code, p_course_id, p_expires_at, v_admin_id)
  RETURNING * INTO v_record;

  -- Use canonical overload A: (actor_id, action, details, resource_type, resource_id, ip, success, reason)
  PERFORM write_audit_log(
    v_admin_id,
    'code_created'::audit_action,
    jsonb_build_object('code_id', v_record.id, 'course_id', p_course_id),
    'activation_code',
    v_record.id,
    NULL::text,
    true,
    NULL::text
  );

  v_result := jsonb_build_object('success', true, 'code', v_code, 'id', v_record.id);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, user_id, operation, result)
    VALUES (p_idempotency_key, v_admin_id, 'create_activation_code', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- Restore grants
GRANT EXECUTE ON FUNCTION public.logout_device(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.force_logout_device(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.logout_all_devices(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_activation_code(uuid, timestamptz, text) TO authenticated;
