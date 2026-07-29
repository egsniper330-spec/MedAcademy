
CREATE OR REPLACE FUNCTION public.set_user_role(
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
  v_old_role    text;
  v_new_role    text;
  v_action      audit_action;
  v_verb        text;
  v_description text;

  -- Role hierarchy: higher number = higher rank
  v_old_rank    int;
  v_new_rank    int;
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

  v_old_role := v_target.role::text;
  v_new_role := p_new_role;

  -- Rank mapping for promote vs demote wording
  v_old_rank := CASE v_old_role
    WHEN 'student'     THEN 1
    WHEN 'doctor'      THEN 2
    WHEN 'admin'       THEN 3
    WHEN 'super_admin' THEN 4
    ELSE 0
  END;
  v_new_rank := CASE v_new_role
    WHEN 'student'     THEN 1
    WHEN 'doctor'      THEN 2
    WHEN 'admin'       THEN 3
    WHEN 'super_admin' THEN 4
    ELSE 0
  END;

  -- Determine promote/demote verb and specific action
  IF v_new_rank > v_old_rank THEN
    v_verb := 'promoted';
  ELSE
    v_verb := 'demoted';
  END IF;

  -- Specific action enum for filtering by category
  v_action := CASE v_new_role
    WHEN 'doctor'      THEN 'role_changed_to_doctor'::audit_action
    WHEN 'admin'       THEN 'role_changed_to_admin'::audit_action
    WHEN 'super_admin' THEN 'role_changed_to_super_admin'::audit_action
    ELSE                    'role_changed_to_student'::audit_action
  END;

  -- Human-readable description: "Ahmed Hassan promoted Mohamed Ali from User to Doctor"
  v_description := format(
    '%s %s %s from %s to %s',
    COALESCE(v_actor.full_name, 'Unknown'),
    v_verb,
    COALESCE(v_target.full_name, 'Unknown'),
    initcap(replace(v_old_role, '_', ' ')),
    initcap(replace(v_new_role, '_', ' '))
  );

  -- Apply the role change
  UPDATE profiles
  SET role       = p_new_role::user_role,
      updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_user_id, target_name,
    description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    auth.uid(), v_actor.full_name, v_actor.email, v_actor.role::text,
    v_action, 'profile', p_user_id,
    p_user_id, v_target.full_name,
    v_description,
    jsonb_build_object('role', v_old_role),
    jsonb_build_object('role', v_new_role),
    p_user_id, 'success'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_user_role(uuid, text) TO authenticated;
