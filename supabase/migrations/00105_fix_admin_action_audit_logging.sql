
-- ============================================================
-- Helper: write a rich audit log entry (SECURITY DEFINER)
-- ============================================================
CREATE OR REPLACE FUNCTION write_audit_log(
  p_action        text,
  p_resource_type text    DEFAULT NULL,
  p_resource_id   uuid    DEFAULT NULL,
  p_target_name   text    DEFAULT NULL,
  p_description   text    DEFAULT NULL,
  p_old_values    jsonb   DEFAULT NULL,
  p_new_values    jsonb   DEFAULT NULL,
  p_user_id       uuid    DEFAULT NULL   -- subject of the action
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_actor FROM profiles WHERE id = auth.uid();

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    auth.uid(),
    v_actor.full_name,
    v_actor.email,
    v_actor.role::text,
    p_action,
    p_resource_type,
    p_resource_id,
    p_target_name,
    p_description,
    p_old_values,
    p_new_values,
    p_user_id,
    'success'
  );
END;
$$;


-- ============================================================
-- promote_to_admin  (replaces direct table update)
-- ============================================================
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
    format('%s promoted %s from %s to admin',
           v_actor.full_name, v_target.full_name, v_target.role::text),
    jsonb_build_object('role', v_target.role::text),
    jsonb_build_object('role', 'admin'),
    p_user_id, 'success'
  );
END;
$$;


-- ============================================================
-- demote_to_student  (replaces direct table update)
-- ============================================================
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
    format('%s demoted %s from %s to student',
           v_actor.full_name, v_target.full_name, v_target.role::text),
    jsonb_build_object('role', v_target.role::text),
    jsonb_build_object('role', 'student'),
    p_user_id, 'success'
  );
END;
$$;


-- ============================================================
-- suspend_user / activate_user  (replaces direct table update)
-- ============================================================
CREATE OR REPLACE FUNCTION set_user_status(
  p_user_id  uuid,
  p_status   text   -- 'active' | 'suspended'
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

  SELECT * INTO v_target FROM profiles WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  v_old_status := v_target.status;
  SELECT * INTO v_actor FROM profiles WHERE id = auth.uid();

  UPDATE profiles SET status = p_status::text, updated_at = now() WHERE id = p_user_id;

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


-- ============================================================
-- Update promote_to_doctor to include description + target_name
-- ============================================================
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

  UPDATE profiles SET role = 'doctor', updated_at = now() WHERE id = p_user_id;

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
    format('%s promoted %s from %s to doctor',
           v_actor.full_name, v_target.full_name, v_target.role::text),
    jsonb_build_object('role', v_target.role::text),
    jsonb_build_object('role', 'doctor'),
    p_user_id, 'success'
  );
END;
$$;


-- ============================================================
-- Update demote_doctor to include description + target_name
-- ============================================================
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Doctor not found'; END IF;
  SELECT * INTO v_actor  FROM profiles WHERE id = auth.uid();

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
    format('%s demoted %s from doctor to student',
           v_actor.full_name, v_target.full_name),
    jsonb_build_object('role', 'doctor'),
    jsonb_build_object('role', 'student'),
    p_doctor_id, 'success'
  );
END;
$$;


-- ============================================================
-- Patch existing blank audit_log rows: backfill actor_name
-- from the profiles join where actor_name is NULL but actor_id exists
-- ============================================================
UPDATE audit_logs al
SET
  actor_name  = p.full_name,
  actor_email = p.email,
  actor_role  = p.role::text
FROM profiles p
WHERE al.actor_id = p.id
  AND al.actor_name IS NULL;

-- Backfill target_name for profile resource rows
UPDATE audit_logs al
SET target_name = p.full_name
FROM profiles p
WHERE al.resource_id = p.id
  AND al.resource_type = 'profile'
  AND al.target_name IS NULL;

-- Backfill descriptions for common action types that still have NULL
UPDATE audit_logs
SET description = CASE
  WHEN action::text = 'user_trashed'              THEN 'Account moved to trash'
  WHEN action::text = 'account_permanently_deleted' THEN 'Account permanently deleted'
  WHEN action::text = 'code_deleted'              THEN 'Activation code deleted'
  WHEN action::text = 'code_created'              THEN 'Activation code created'
  WHEN action::text = 'limit_changed'             THEN 'User limit settings changed'
  WHEN action::text = 'credit_allocated'          THEN 'Credits allocated to account'
  WHEN action::text = 'role_changed'              THEN COALESCE(
    description,
    format('Role changed: %s → %s',
      old_values->>'role', new_values->>'role')
  )
  ELSE description
END
WHERE description IS NULL;
