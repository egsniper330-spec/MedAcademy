
-- ============================================================
-- Fix: every INSERT into audit_logs.action must supply
--      audit_action enum, never plain text.
--
-- Affected RPCs (confirmed by reading prosrc):
--   1. set_user_status      — CASE returns text, no ::audit_action cast
--   2. bulk_trash_users     — 'bulk_trash' literal, no cast
--   3. bulk_restore_users   — 'bulk_restore' literal, no cast
--   4. hard_delete_user     — 'account_permanently_deleted' literal, no cast
-- ============================================================

-- ── 1. set_user_status ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_user_status(
  p_user_id uuid,
  p_status  text
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
  v_action      audit_action;   -- typed variable — never text
  v_desc        text;
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

  -- Assign typed enum variable — no CASE-to-text anywhere near the INSERT
  IF p_status = 'suspended' THEN
    v_action := 'user_suspended'::audit_action;
    v_desc   := format('%s suspended %s (%s)',
                  v_actor.full_name, v_target.full_name, v_target.email);
  ELSE
    v_action := 'user_activated'::audit_action;
    v_desc   := format('%s activated %s (%s)',
                  v_actor.full_name, v_target.full_name, v_target.email);
  END IF;

  UPDATE profiles
  SET status     = p_status::user_status,
      updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_user_id, target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    auth.uid(), v_actor.full_name, v_actor.email, v_actor.role::text,
    v_action,                     -- audit_action variable, not text
    'profile', p_user_id,
    p_user_id, v_target.full_name, v_desc,
    jsonb_build_object('status', v_old_status),
    jsonb_build_object('status', p_status),
    p_user_id, 'success'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_user_status(uuid, text) TO authenticated;


-- ── 2. bulk_trash_users ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bulk_trash_users(
  p_user_ids uuid[],
  p_actor_id uuid,
  p_reason   text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id      UUID;
  v_success INT := 0;
  v_failed  INT := 0;
  v_res     JSON;
BEGIN
  FOREACH v_id IN ARRAY p_user_ids LOOP
    v_res := public.trash_user(v_id, p_actor_id, p_reason);
    IF (v_res->>'success')::BOOLEAN THEN v_success := v_success + 1;
    ELSE v_failed := v_failed + 1; END IF;
  END LOOP;

  INSERT INTO public.audit_logs(actor_id, action, resource_type, resource_id, log_status, details)
  VALUES (
    p_actor_id,
    'bulk_trash'::audit_action,   -- explicit enum cast
    'profile', NULL, 'success',
    jsonb_build_object('total', array_length(p_user_ids,1), 'success', v_success, 'failed', v_failed, 'reason', p_reason)
  );

  RETURN json_build_object('success', true, 'trashed', v_success, 'failed', v_failed);
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_trash_users(uuid[], uuid, text) TO authenticated, service_role;


-- ── 3. bulk_restore_users ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bulk_restore_users(
  p_user_ids uuid[],
  p_actor_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id      UUID;
  v_success INT := 0;
  v_failed  INT := 0;
  v_res     JSON;
BEGIN
  FOREACH v_id IN ARRAY p_user_ids LOOP
    v_res := public.restore_user(v_id, p_actor_id);
    IF (v_res->>'success')::BOOLEAN THEN v_success := v_success + 1;
    ELSE v_failed := v_failed + 1; END IF;
  END LOOP;

  INSERT INTO public.audit_logs(actor_id, action, resource_type, resource_id, log_status, details)
  VALUES (
    p_actor_id,
    'bulk_restore'::audit_action,   -- explicit enum cast
    'profile', NULL, 'success',
    jsonb_build_object('total', array_length(p_user_ids,1), 'success', v_success, 'failed', v_failed)
  );

  RETURN json_build_object('success', true, 'restored', v_success, 'failed', v_failed);
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_restore_users(uuid[], uuid) TO authenticated, service_role;


-- ── 4. hard_delete_user ───────────────────────────────────────────────────────
-- Only the final audit INSERT needs patching — replace the plain-text literal
-- with an explicit ::audit_action cast. All other logic is preserved exactly.
CREATE OR REPLACE FUNCTION public.hard_delete_user(
  p_target_user_id uuid,
  p_actor_id       uuid,
  p_reason         text DEFAULT ''
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile        RECORD;
  v_actor          RECORD;
  v_admin_count    INT;
  v_sa_count       INT;
  v_course_count   INT;
  v_deleted_label  TEXT;
  v_actor_label    TEXT;
BEGIN
  -- ── 1. Load target profile ──────────────────────────────────────────────────
  SELECT id, full_name, role, email, phone_e164, status
  INTO   v_profile FROM public.profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success',false,'code','NOT_FOUND','message','User not found');
  END IF;

  SELECT id, role, full_name INTO v_actor FROM public.profiles WHERE id = p_actor_id;

  v_deleted_label := CASE v_profile.role
    WHEN 'student'     THEN 'Deleted Student'
    WHEN 'doctor'      THEN 'Deleted Doctor'
    WHEN 'admin'       THEN 'Deleted Admin'
    WHEN 'super_admin' THEN 'Deleted Super Admin'
    ELSE                    'Deleted User'
  END;
  v_actor_label := COALESCE(v_actor.full_name, 'Unknown Actor');

  -- ── 2. Business-rule guards ─────────────────────────────────────────────────
  IF v_profile.role = 'doctor' AND (v_actor.role IS DISTINCT FROM 'super_admin') THEN
    SELECT COUNT(*) INTO v_course_count FROM public.courses
    WHERE  doctor_id = p_target_user_id
      AND  status != 'archived'::public.course_status;
    IF v_course_count > 0 THEN
      RETURN json_build_object(
        'success', false, 'code', 'DOCTOR_HAS_COURSES',
        'message', format('Doctor has %s active course(s). Archive them first.', v_course_count)
      );
    END IF;
  END IF;

  IF v_profile.role = 'admin' THEN
    SELECT COUNT(*) INTO v_admin_count FROM public.profiles
    WHERE  role = 'admin' AND status = 'active' AND id <> p_target_user_id;
    IF v_admin_count = 0 THEN
      RETURN json_build_object('success',false,'code','LAST_ADMIN',
        'message','Cannot delete the last active admin.');
    END IF;
  END IF;

  IF v_profile.role = 'super_admin' THEN
    SELECT COUNT(*) INTO v_sa_count FROM public.profiles
    WHERE  role = 'super_admin' AND status = 'active' AND id <> p_target_user_id;
    IF v_sa_count = 0 THEN
      RETURN json_build_object('success',false,'code','LAST_SUPER_ADMIN',
        'message','Cannot delete the last active super admin.');
    END IF;
  END IF;

  -- ── 3. Nullify NO ACTION FKs before DELETE FROM profiles ────────────────────
  UPDATE public.audit_logs
  SET    user_id = NULL,
         details = COALESCE(details, '{}')
                   || jsonb_build_object(
                        'deleted_actor_label', v_deleted_label,
                        'deletion_reason',     p_reason)
  WHERE  user_id = p_target_user_id;

  UPDATE public.credit_transactions SET performed_by = NULL WHERE performed_by = p_target_user_id;
  UPDATE public.credit_transactions SET student_id   = NULL WHERE student_id   = p_target_user_id;
  UPDATE public.activation_codes    SET created_by   = NULL WHERE created_by   = p_target_user_id;
  UPDATE public.code_batches        SET created_by   = NULL WHERE created_by   = p_target_user_id;
  UPDATE public.courses             SET archived_by  = NULL WHERE archived_by  = p_target_user_id;
  UPDATE public.courses             SET restored_by  = NULL WHERE restored_by  = p_target_user_id;
  UPDATE public.fraud_flags         SET resolved_by  = NULL WHERE resolved_by  = p_target_user_id;
  UPDATE public.provider_audit_log  SET actor_id     = NULL WHERE actor_id     = p_target_user_id;
  UPDATE public.subscription_timeline SET actor_id   = NULL WHERE actor_id     = p_target_user_id;

  BEGIN UPDATE public.assistant_permissions      SET updated_by = NULL WHERE updated_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.system_config              SET updated_by = NULL WHERE updated_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.video_health_scans         SET triggered_by = NULL WHERE triggered_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.content_protection_policies SET updated_by = NULL WHERE updated_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.video_health_alerts        SET resolved_by = NULL WHERE resolved_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.assistant_permissions      SET granted_by  = NULL WHERE granted_by  = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.security_policies          SET created_by  = NULL WHERE created_by  = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.security_vpn_whitelist     SET added_by    = NULL WHERE added_by    = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.content_protection_policies SET created_by = NULL WHERE created_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- ── 4. Delete profile row ───────────────────────────────────────────────────
  DELETE FROM public.profiles WHERE id = p_target_user_id;

  -- ── 5. Final audit entry — explicit ::audit_action cast ─────────────────────
  INSERT INTO public.audit_logs(
    actor_id, actor_name, action, resource_type, resource_id,
    target_name, description, log_status, details
  )
  VALUES (
    p_actor_id,
    v_actor_label,
    'account_permanently_deleted'::audit_action,  -- explicit cast, not text
    'profile', p_target_user_id,
    v_profile.full_name,
    format('%s permanently deleted account for %s (%s)',
      v_actor_label, v_profile.full_name, v_profile.email),
    'success',
    jsonb_build_object(
      'deleted_name',        v_profile.full_name,
      'deleted_role',        v_profile.role,
      'deleted_actor_label', v_deleted_label,
      'actor_name',          v_actor_label,
      'actor_role',          v_actor.role,
      'reason',              p_reason
    )
  );

  RETURN json_build_object(
    'success',       true,
    'deleted_name',  v_profile.full_name,
    'deleted_role',  v_profile.role,
    'deleted_label', v_deleted_label
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.hard_delete_user(uuid, uuid, text) TO service_role;
