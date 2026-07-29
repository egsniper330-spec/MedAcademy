
-- Generic set_user_role RPC for demote/promote to any role
CREATE OR REPLACE FUNCTION set_user_role(
  p_user_id  uuid,
  p_new_role text
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

  UPDATE profiles SET role = p_new_role, updated_at = now() WHERE id = p_user_id;

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
