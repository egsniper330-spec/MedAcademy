-- v215 — Fix hard_delete_user(): nullify content_protection_policies.updated_by
--
-- ROOT CAUSE (remaining after v214):
--   content_protection_policies has TWO FK columns referencing profiles:
--     - created_by  → SET NULL (safe — CASCADE handles it automatically)
--     - updated_by  → NO ACTION (blocks DELETE FROM profiles)
--
--   v214 only added `SET created_by = NULL` inside the EXCEPTION block.
--   The actual blocking column is `updated_by` which was never nullified.
--
--   Any user who ever saved a security/content-protection policy change
--   will have their id in updated_by → FK violation on DELETE → error:
--     "update or delete on table "profiles" violates foreign key constraint
--      "content_protection_policies_updated_by_fkey" on table
--      "content_protection_policies""
--
--   This message contains "update", "delete", "table", "constraint" — all
--   SQL_KEYWORDS — so friendlyError() returned "Something went wrong."
--   (that masking bug is also fixed in the same release, v214/v215).

DROP FUNCTION IF EXISTS public.hard_delete_user(UUID, UUID, TEXT);

CREATE FUNCTION public.hard_delete_user(
  p_target_user_id UUID,
  p_actor_id       UUID,
  p_reason         TEXT DEFAULT 'Admin-initiated permanent delete'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
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

  -- Doctor with active courses guard
  -- Fixed in v212: was NOT IN ('archived','deleted') — 'deleted' is not a valid course_status enum value.
  IF v_profile.role = 'doctor' AND (v_actor.role IS DISTINCT FROM 'super_admin') THEN
    SELECT COUNT(*) INTO v_course_count FROM public.courses
    WHERE  doctor_id = p_target_user_id
      AND  status != 'archived'::public.course_status;
    IF v_course_count > 0 THEN
      RETURN json_build_object(
        'success', false,
        'code',    'DOCTOR_HAS_COURSES',
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

  -- ── Nullify ALL NO ACTION FK references before DELETE FROM profiles ────
  -- Every FK listed here was verified against information_schema.referential_constraints
  -- with delete_rule = 'NO ACTION'. SET NULL and CASCADE FKs are safe without
  -- explicit nullification.
  --
  -- Required (unconditional — tables always exist):
  UPDATE public.audit_logs
  SET    user_id = NULL,
         details = COALESCE(details,'{}')
                   || jsonb_build_object('deleted_actor_label', v_deleted_label, 'deletion_reason', p_reason)
  WHERE  user_id = p_target_user_id;

  UPDATE public.audit_logs
  SET    actor_id = NULL,
         details  = COALESCE(details,'{}')
                    || jsonb_build_object('deleted_actor_label', v_actor_label)
  WHERE  actor_id = p_target_user_id;

  UPDATE public.credit_transactions SET performed_by = NULL WHERE performed_by = p_target_user_id;
  UPDATE public.credit_transactions SET student_id   = NULL WHERE student_id   = p_target_user_id;
  UPDATE public.activation_codes    SET created_by   = NULL WHERE created_by   = p_target_user_id;
  UPDATE public.code_batches        SET created_by   = NULL WHERE created_by   = p_target_user_id;
  UPDATE public.courses             SET archived_by  = NULL WHERE archived_by  = p_target_user_id;
  UPDATE public.courses             SET restored_by  = NULL WHERE restored_by  = p_target_user_id;
  UPDATE public.fraud_flags         SET user_id      = NULL WHERE user_id      = p_target_user_id;
  UPDATE public.fraud_flags         SET resolved_by  = NULL WHERE resolved_by  = p_target_user_id;
  UPDATE public.provider_audit_log  SET actor_id     = NULL WHERE actor_id     = p_target_user_id;
  UPDATE public.subscription_timeline SET actor_id   = NULL WHERE actor_id     = p_target_user_id;

  -- Optional-table handlers (EXCEPTION block tolerates missing table/column in older envs):

  -- assistant_permissions.updated_by (v214)
  BEGIN
    UPDATE public.assistant_permissions SET updated_by = NULL WHERE updated_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- system_config.updated_by (v214)
  BEGIN
    UPDATE public.system_config SET updated_by = NULL WHERE updated_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- video_health_scans.triggered_by (v214)
  BEGIN
    UPDATE public.video_health_scans SET triggered_by = NULL WHERE triggered_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- content_protection_policies.updated_by (v215 — was incorrectly set to created_by in v214)
  BEGIN
    UPDATE public.content_protection_policies SET updated_by = NULL WHERE updated_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- video_health_alerts.resolved_by
  BEGIN
    UPDATE public.video_health_alerts SET resolved_by = NULL WHERE resolved_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- security_policies.created_by
  BEGIN
    UPDATE public.security_policies SET created_by = NULL WHERE created_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- security_vpn_whitelist.added_by
  BEGIN
    UPDATE public.security_vpn_whitelist SET added_by = NULL WHERE added_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- assistant_permissions.granted_by
  BEGIN
    UPDATE public.assistant_permissions SET granted_by = NULL WHERE granted_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- content_protection_policies.created_by (belt-and-suspenders; FK is SET NULL but explicit is safer)
  BEGIN
    UPDATE public.content_protection_policies SET created_by = NULL WHERE created_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- ── Delete profile (CASCADE handles devices, enrollments, push_tokens, etc.) ──
  DELETE FROM public.profiles WHERE id = p_target_user_id;

  -- Final audit entry
  INSERT INTO public.audit_logs(actor_id, action, resource_type, resource_id, success, details)
  VALUES (p_actor_id, 'account_permanently_deleted', 'profile', p_target_user_id, true,
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

GRANT EXECUTE ON FUNCTION public.hard_delete_user(UUID, UUID, TEXT) TO authenticated;