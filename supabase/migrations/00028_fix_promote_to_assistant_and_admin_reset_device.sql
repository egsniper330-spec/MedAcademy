-- FIX 1: promote_to_assistant — add permission_key + updated_by to INSERT
CREATE OR REPLACE FUNCTION public.promote_to_assistant(
  p_student_id uuid,
  p_doctor_id  uuid,
  p_granted_by uuid
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_doctor_id AND role = 'doctor') THEN
    RAISE EXCEPTION 'Target doctor not found or does not have doctor role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_student_id AND role = 'student') THEN
    RAISE EXCEPTION 'Target user is not a student';
  END IF;

  UPDATE profiles SET role = 'assistant', doctor_id = p_doctor_id WHERE id = p_student_id;

  -- Provide permission_key='default' and updated_by=p_granted_by to satisfy NOT NULL constraints
  INSERT INTO assistant_permissions (assistant_id, permission_key, updated_by, granted_by)
  VALUES (p_student_id, 'default', p_granted_by, p_granted_by)
  ON CONFLICT (assistant_id) DO UPDATE
    SET granted_by  = p_granted_by,
        updated_by  = p_granted_by,
        updated_at  = NOW();

  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
  VALUES (p_granted_by, 'role_changed', 'profile', p_student_id,
    jsonb_build_object('old_role','student','new_role','assistant','doctor_id',p_doctor_id));
END;
$$;

-- FIX 2: admin_reset_device — write_audit_log overload ambiguity (use all 8 args = overload-1)
CREATE OR REPLACE FUNCTION public.admin_reset_device(
  p_target_user_id uuid,
  p_reason text DEFAULT ''
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
BEGIN
  IF NOT is_admin_or_super_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
  END IF;

  DELETE FROM devices WHERE user_id = p_target_user_id;

  -- Overload-1: (actor, action, details, resource_type, resource_id, ip, success, reason)
  PERFORM write_audit_log(
    v_admin_id,
    'device_reset'::audit_action,
    jsonb_build_object('target_user', p_target_user_id, 'reason', p_reason),
    'device'::text,
    p_target_user_id,
    NULL::text,
    true::boolean,
    NULL::text
  );

  RETURN jsonb_build_object('success', true);
END;
$$;