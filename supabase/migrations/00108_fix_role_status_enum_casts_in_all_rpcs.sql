
-- ============================================================
-- ROOT CAUSE:
--   set_user_role  declared p_new_role as TEXT, then did:
--     UPDATE profiles SET role = p_new_role      ← no cast; TEXT ≠ user_role enum → ERROR
--   set_user_status did:
--     UPDATE profiles SET status = p_status::text ← cast TO text, not FROM text → ERROR
--   demote_doctor, demote_to_student, promote_to_doctor, promote_to_admin all did:
--     UPDATE profiles SET role = 'student'/'doctor'/'admin' (untyped string literal) → ERROR
--
-- FIX: every UPDATE that touches profiles.role uses ::user_role cast,
--      every UPDATE that touches profiles.status uses ::user_status cast.
-- ============================================================

-- 1. set_user_role — THE primary RPC used by all 6 transitions
CREATE OR REPLACE FUNCTION public.set_user_role(
  p_user_id  uuid,
  p_new_role text          -- kept as text so callers don't need to know the enum
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
  IF p_new_role NOT IN ('student','doctor','admin','super_admin') THEN
    RAISE EXCEPTION 'Invalid role: %', p_new_role;
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  SELECT * INTO v_actor  FROM profiles WHERE id = auth.uid();

  -- FIX: explicit cast text → user_role enum
  UPDATE profiles
  SET role       = p_new_role::user_role,
      updated_at = now()
  WHERE id = p_user_id;

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
    format('%s changed %s role from %s to %s',
           v_actor.full_name, v_target.full_name,
           v_target.role::text, p_new_role),
    jsonb_build_object('role', v_target.role::text),
    jsonb_build_object('role', p_new_role),
    p_user_id, 'success'
  );
END;
$$;

-- 2. set_user_status — status column is user_status enum, not text
CREATE OR REPLACE FUNCTION public.set_user_status(
  p_user_id uuid,
  p_status  text          -- kept as text for caller convenience
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
  v_old_status  text;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('admin','super_admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF p_status NOT IN ('active','suspended','pending','deleted','trashed') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  SELECT * INTO v_target FROM profiles WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  v_old_status := v_target.status::text;
  SELECT * INTO v_actor FROM profiles WHERE id = auth.uid();

  -- FIX: cast text → user_status enum (previously wrongly cast status to ::text)
  UPDATE profiles
  SET status     = p_status::user_status,
      updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    auth.uid(), v_actor.full_name, v_actor.email, v_actor.role::text,
    CASE p_status WHEN 'suspended' THEN 'user_suspended' ELSE 'user_activated' END,
    'profile', p_user_id,
    v_target.full_name,
    format('%s %s %s (%s)',
           v_actor.full_name,
           CASE p_status WHEN 'suspended' THEN 'suspended' ELSE 'activated' END,
           v_target.full_name,
           v_target.email),
    jsonb_build_object('status', v_old_status),
    jsonb_build_object('status', p_status),
    p_user_id, 'success'
  );
END;
$$;

-- 3. demote_doctor — string literal 'student' is untyped text; cast to user_role
CREATE OR REPLACE FUNCTION public.demote_doctor(
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

  -- FIX: 'student'::user_role
  UPDATE profiles
  SET role       = 'student'::user_role,
      updated_at = now()
  WHERE id = p_doctor_id;

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
    jsonb_build_object('role', v_target.role::text),
    jsonb_build_object('role', 'student'),
    p_doctor_id, 'success'
  );
END;
$$;

-- 4. demote_to_student — same fix
CREATE OR REPLACE FUNCTION public.demote_to_student(
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

  -- FIX: 'student'::user_role
  UPDATE profiles
  SET role       = 'student'::user_role,
      updated_at = now()
  WHERE id = p_user_id;

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

-- 5. promote_to_doctor — 'doctor'::user_role
CREATE OR REPLACE FUNCTION public.promote_to_doctor(
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

  -- FIX: 'doctor'::user_role
  UPDATE profiles
  SET role       = 'doctor'::user_role,
      updated_at = now()
  WHERE id = p_user_id;

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

-- 6. promote_to_admin — 'admin'::user_role
CREATE OR REPLACE FUNCTION public.promote_to_admin(
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

  -- FIX: 'admin'::user_role
  UPDATE profiles
  SET role       = 'admin'::user_role,
      updated_at = now()
  WHERE id = p_user_id;

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
