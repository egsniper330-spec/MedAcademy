-- v214 — Fix hard_delete_user(): add 4 missing FK nullifications that block DELETE FROM profiles
--
-- ROOT CAUSE:
--   DELETE FROM profiles fails with a FK violation for users who have rows in:
--   1. fraud_flags.resolved_by        (NO ACTION) — user resolved a fraud flag
--   2. assistant_permissions.updated_by (NO ACTION) — user updated assistant permissions
--   3. system_config.updated_by        (NO ACTION) — user updated system config
--   4. video_health_scans.triggered_by  (NO ACTION) — user triggered a health scan
--
--   PostgreSQL error: "update or delete on table "profiles" violates foreign key
--   constraint ... on table "video_health_scans""
--
--   This error message contains SQL keywords (update/delete/table/constraint) so
--   friendlyError() in the frontend silently returns "Something went wrong."
--   obscuring the real failure.
--
-- FIX: Add SET NULL updates for all 4 missing FK columns before the DELETE,
--      wrapped in BEGIN/EXCEPTION blocks to tolerate tables that may not exist
--      in older environments.

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

  -- ── Nullify all NO ACTION FK references before DELETE ──────────────────
  -- Previously handled (audit_logs, credit_transactions, activation_codes,
  -- code_batches, courses.archived_by/restored_by, fraud_flags.user_id,
  -- provider_audit_log, subscription_timeline):
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
  UPDATE public.code_batches         SET created_by   = NULL WHERE created_by   = p_target_user_id;
  UPDATE public.courses SET archived_by = NULL WHERE archived_by = p_target_user_id;
  UPDATE public.courses SET restored_by = NULL WHERE restored_by = p_target_user_id;
  UPDATE public.fraud_flags SET user_id = NULL WHERE user_id = p_target_user_id;
  UPDATE public.provider_audit_log    SET actor_id = NULL WHERE actor_id = p_target_user_id;
  UPDATE public.subscription_timeline SET actor_id = NULL WHERE actor_id = p_target_user_id;

  -- ── NEW in v214: 4 missing NO ACTION FKs that caused FK violation ───────
  -- Fix 1: fraud_flags.resolved_by — user may have resolved fraud flags
  UPDATE public.fraud_flags SET resolved_by = NULL WHERE resolved_by = p_target_user_id;

  -- Fix 2: assistant_permissions.updated_by — user may have updated AI assistant perms
  BEGIN
    UPDATE public.assistant_permissions SET updated_by = NULL WHERE updated_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- Fix 3: system_config.updated_by — user may have changed system configuration
  BEGIN
    UPDATE public.system_config SET updated_by = NULL WHERE updated_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- Fix 4: video_health_scans.triggered_by — user may have triggered a video health scan
  BEGIN
    UPDATE public.video_health_scans SET triggered_by = NULL WHERE triggered_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- ── Pre-existing optional-table handlers (kept for safety) ───────────────
  BEGIN UPDATE public.security_policies       SET created_by = NULL WHERE created_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.security_vpn_whitelist   SET added_by   = NULL WHERE added_by   = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.assistant_permissions    SET granted_by = NULL WHERE granted_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.content_protection_policies SET created_by = NULL WHERE created_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.video_health_alerts SET resolved_by = NULL WHERE resolved_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- ── Delete profile (CASCADE handles devices, enrollments, push_tokens, etc.)
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

-- Verify: confirm all 4 previously-missing tables have NULL-able FK columns
SELECT
  tc.table_name,
  kcu.column_name,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_name = 'profiles'
  AND rc.delete_rule = 'NO ACTION'
  AND tc.table_name IN ('fraud_flags','assistant_permissions','system_config','video_health_scans')
ORDER BY tc.table_name;