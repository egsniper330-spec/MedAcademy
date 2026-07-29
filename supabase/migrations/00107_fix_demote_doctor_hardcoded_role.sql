
-- Fix demote_doctor: old_values was hardcoded as 'doctor' regardless of real role,
-- and description assumed 'doctor' even when called on admin/student.
-- Also remove the need for p_demoted_by (unused) – keep signature compatible.
CREATE OR REPLACE FUNCTION demote_doctor(
  p_doctor_id  uuid,
  p_demoted_by uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_target      profiles%ROWTYPE;
  v_actor       profiles%ROWTYPE;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('admin','super_admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_doctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  SELECT * INTO v_actor  FROM profiles WHERE id = auth.uid();

  -- No check on current role — allow any → student transition
  UPDATE profiles SET role = 'student', updated_at = now() WHERE id = p_doctor_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    auth.uid(), v_actor.full_name, v_actor.email, v_actor.role::text,
    'role_changed', 'profile', p_doctor_id,
    v_target.full_name,
    format('%s changed %s role from %s to student',
           v_actor.full_name, v_target.full_name, v_target.role::text),
    jsonb_build_object('role', v_target.role::text),   -- real old role from DB
    jsonb_build_object('role', 'student'),
    p_doctor_id, 'success'
  );
END;
$$;

-- Fix promote_to_doctor: remove old "must be student" guard
-- (already done in previous migration, this is a safety re-apply)
CREATE OR REPLACE FUNCTION promote_to_doctor(
  p_user_id     uuid,
  p_promoted_by uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_target      profiles%ROWTYPE;
  v_actor       profiles%ROWTYPE;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('admin','super_admin') THEN
    RAISE EXCEPTION 'Only admin or super_admin can promote to doctor';
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  SELECT * INTO v_actor  FROM profiles WHERE id = auth.uid();

  -- No check on current role — allow any → doctor transition
  UPDATE profiles SET role = 'doctor', updated_at = now() WHERE id = p_user_id;

  -- Ensure credits row exists for new doctor
  INSERT INTO credits (doctor_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    auth.uid(), v_actor.full_name, v_actor.email, v_actor.role::text,
    'role_changed', 'profile', p_user_id,
    v_target.full_name,
    format('%s changed %s role from %s to doctor',
           v_actor.full_name, v_target.full_name, v_target.role::text),
    jsonb_build_object('role', v_target.role::text),
    jsonb_build_object('role', 'doctor'),
    p_user_id, 'success'
  );
END;
$$;

-- Fix promote_to_admin: no old-role guard, real description
CREATE OR REPLACE FUNCTION promote_to_admin(
  p_user_id     uuid,
  p_promoted_by uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_target      profiles%ROWTYPE;
  v_actor       profiles%ROWTYPE;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('admin','super_admin') THEN
    RAISE EXCEPTION 'Only admin or super_admin can promote to admin';
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  SELECT * INTO v_actor  FROM profiles WHERE id = auth.uid();

  -- No check on current role — student / doctor / admin all allowed → admin
  UPDATE profiles SET role = 'admin', updated_at = now() WHERE id = p_user_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    auth.uid(), v_actor.full_name, v_actor.email, v_actor.role::text,
    'role_changed', 'profile', p_user_id,
    v_target.full_name,
    format('%s changed %s role from %s to admin',
           v_actor.full_name, v_target.full_name, v_target.role::text),
    jsonb_build_object('role', v_target.role::text),
    jsonb_build_object('role', 'admin'),
    p_user_id, 'success'
  );
END;
$$;

-- Fix demote_to_student: no old-role guard, real description
CREATE OR REPLACE FUNCTION demote_to_student(
  p_user_id    uuid,
  p_demoted_by uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_target      profiles%ROWTYPE;
  v_actor       profiles%ROWTYPE;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('admin','super_admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  SELECT * INTO v_actor  FROM profiles WHERE id = auth.uid();

  -- No check on current role
  UPDATE profiles SET role = 'student', updated_at = now() WHERE id = p_user_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    auth.uid(), v_actor.full_name, v_actor.email, v_actor.role::text,
    'role_changed', 'profile', p_user_id,
    v_target.full_name,
    format('%s changed %s role from %s to student',
           v_actor.full_name, v_target.full_name, v_target.role::text),
    jsonb_build_object('role', v_target.role::text),
    jsonb_build_object('role', 'student'),
    p_user_id, 'success'
  );
END;
$$;
