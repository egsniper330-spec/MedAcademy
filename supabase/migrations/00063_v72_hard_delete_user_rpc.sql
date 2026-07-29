
-- ── v72: Hard delete RPC ───────────────────────────────────────────────────────
-- Replaces the soft-delete delete_user() with permanent account removal.
-- All DB work is atomic inside this SECURITY DEFINER function.
-- Auth user deletion is handled by the Edge Function after this returns.
-- ──────────────────────────────────────────────────────────────────────────────

-- 1. Preflight: return counts needed for the confirmation modal
CREATE OR REPLACE FUNCTION public.get_delete_preflight(p_target_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role         text;
  v_name         text;
  v_email        text;
  v_phone        text;
  v_courses      bigint;
  v_credits_rem  int;
  v_devices      bigint;
  v_enrollments  bigint;
BEGIN
  SELECT role, full_name, email, phone
    INTO v_role, v_name, v_email, v_phone
  FROM profiles WHERE id = p_target_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Active courses (doctor)
  SELECT COUNT(*) INTO v_courses FROM courses
  WHERE doctor_id = p_target_user_id AND status NOT IN ('archived','deleted');

  -- Credit balance (doctor)
  SELECT COALESCE(remaining, 0) INTO v_credits_rem FROM credits
  WHERE doctor_id = p_target_user_id LIMIT 1;

  -- Registered devices
  SELECT COUNT(*) INTO v_devices FROM devices WHERE user_id = p_target_user_id;

  -- Active enrollments (student)
  SELECT COUNT(*) INTO v_enrollments FROM enrollments
  WHERE student_id = p_target_user_id AND status = 'active';

  RETURN jsonb_build_object(
    'found',        true,
    'id',           p_target_user_id,
    'role',         v_role,
    'full_name',    v_name,
    'email',        v_email,
    'phone',        v_phone,
    'active_courses', v_courses,
    'credits_remaining', COALESCE(v_credits_rem, 0),
    'devices',      v_devices,
    'active_enrollments', v_enrollments
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_delete_preflight(uuid) TO authenticated;


-- 2. Main hard-delete RPC — all DB work in ONE transaction
CREATE OR REPLACE FUNCTION public.hard_delete_user(
  p_target_user_id  uuid,
  p_actor_id        uuid,
  p_reason          text DEFAULT 'Permanent delete by admin'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_role   text;
  v_target_email  text;
  v_target_name   text;
  v_active_admins bigint;
  v_active_supas  bigint;
  v_active_courses bigint;
BEGIN
  -- ── 0. Guards ───────────────────────────────────────────────────────────────
  IF p_target_user_id IS NULL OR p_actor_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'MISSING_PARAMS', 'message', 'Missing required parameters');
  END IF;

  IF p_target_user_id = p_actor_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'SELF_DELETE', 'message', 'Cannot delete your own account');
  END IF;

  SELECT role, email, full_name
    INTO v_target_role, v_target_email, v_target_name
  FROM profiles WHERE id = p_target_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'USER_NOT_FOUND', 'message', 'User not found');
  END IF;

  -- Last admin guard
  IF v_target_role = 'admin' THEN
    SELECT COUNT(*) INTO v_active_admins FROM profiles
    WHERE role = 'admin' AND status = 'active' AND id != p_target_user_id;
    IF v_active_admins = 0 THEN
      RETURN jsonb_build_object('success', false, 'code', 'LAST_ADMIN',
        'message', 'Cannot delete the last active admin. Promote another user first.');
    END IF;
  END IF;

  -- Last super_admin guard
  IF v_target_role = 'super_admin' THEN
    SELECT COUNT(*) INTO v_active_supas FROM profiles
    WHERE role = 'super_admin' AND status = 'active' AND id != p_target_user_id;
    IF v_active_supas = 0 THEN
      RETURN jsonb_build_object('success', false, 'code', 'LAST_SUPER_ADMIN',
        'message', 'Cannot delete the only Super Admin. Promote another user first.');
    END IF;
  END IF;

  -- Doctor with active courses guard
  IF v_target_role = 'doctor' THEN
    SELECT COUNT(*) INTO v_active_courses FROM courses
    WHERE doctor_id = p_target_user_id AND status NOT IN ('archived','deleted');
    IF v_active_courses > 0 THEN
      RETURN jsonb_build_object('success', false, 'code', 'DOCTOR_HAS_COURSES',
        'message', format('Doctor has %s active course(s). Archive or transfer them first.', v_active_courses),
        'active_courses', v_active_courses);
    END IF;
  END IF;

  -- ── 1. Anonymize reference columns (NO ACTION FKs — keep history, remove PII link) ──
  UPDATE audit_logs            SET user_id    = NULL WHERE user_id    = p_target_user_id;
  UPDATE audit_logs            SET actor_id   = NULL WHERE actor_id   = p_target_user_id;
  UPDATE credit_transactions   SET performed_by = NULL WHERE performed_by = p_target_user_id;
  UPDATE credit_transactions   SET student_id  = NULL WHERE student_id  = p_target_user_id;
  UPDATE activation_codes      SET created_by  = NULL WHERE created_by  = p_target_user_id;
  UPDATE code_batches          SET created_by  = NULL WHERE created_by  = p_target_user_id;
  UPDATE courses               SET archived_by = NULL WHERE archived_by = p_target_user_id;
  UPDATE courses               SET restored_by = NULL WHERE restored_by = p_target_user_id;
  UPDATE fraud_flags           SET resolved_by = NULL WHERE resolved_by = p_target_user_id;
  UPDATE provider_audit_log    SET actor_id    = NULL WHERE actor_id    = p_target_user_id;
  UPDATE subscription_timeline SET actor_id    = NULL WHERE actor_id    = p_target_user_id;
  UPDATE system_config         SET updated_by  = NULL WHERE updated_by  = p_target_user_id;
  UPDATE content_protection_policies SET updated_by = NULL WHERE updated_by = p_target_user_id;
  UPDATE video_health_alerts   SET resolved_by = NULL WHERE resolved_by = p_target_user_id;
  UPDATE video_health_scans    SET triggered_by = NULL WHERE triggered_by = p_target_user_id;
  UPDATE assistant_permissions  SET updated_by  = NULL WHERE updated_by  = p_target_user_id;
  UPDATE security_policies     SET updated_by  = NULL WHERE updated_by  = p_target_user_id;
  UPDATE security_vpn_whitelist SET added_by   = NULL WHERE added_by    = p_target_user_id;

  -- ── 2. Write deletion audit BEFORE deleting profile ─────────────────────────
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
  VALUES (
    p_actor_id,
    'user_hard_deleted',
    'user',
    p_target_user_id,
    jsonb_build_object(
      'target_role',  v_target_role,
      'target_email', v_target_email,
      'target_name',  v_target_name,
      'reason',       p_reason
    )
  );

  -- ── 3. Delete profile — cascades handle everything else ─────────────────────
  -- CASCADE tables (automatic): devices, enrollments, lesson_progress,
  -- notifications, login_history, credits, credit_transactions(doctor_id),
  -- courses(doctor_id), bulk_import_jobs, idempotency_keys,
  -- subscription_timeline(user_id), content_protection_violations,
  -- assistant_permissions(assistant_id), security_events(user_id→SET NULL),
  -- course_templates, course_lifecycle_logs(doctor_id→SET NULL)
  DELETE FROM profiles WHERE id = p_target_user_id;

  RETURN jsonb_build_object(
    'success',       true,
    'deleted_user_id', p_target_user_id,
    'target_role',   v_target_role,
    'target_email',  v_target_email
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.hard_delete_user(uuid, uuid, text) TO authenticated;
