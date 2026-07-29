
-- ============================================================
-- v149 — Admin & Super Admin enrollment permissions
-- ============================================================
-- 1. New audit_action enum values
-- 2. admin_enroll_student  — SECURITY DEFINER, service-role only
-- 3. admin_remove_enrollment — SECURITY DEFINER, service-role only
-- ============================================================

-- ── 1. Enum values ────────────────────────────────────────────────────────────

ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'enrollment_created_by_admin';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'enrollment_removed_by_admin';

-- ── 2. admin_enroll_student ───────────────────────────────────────────────────
-- Called exclusively by the admin-enrollment Edge Function (service role).
-- Does NOT deduct credits — admin enrollment is a direct management action.
-- Returns jsonb: { success, idempotent?, enrollment_id? }

CREATE OR REPLACE FUNCTION public.admin_enroll_student(
  p_student_id  uuid,
  p_course_id   uuid,
  p_actor_id    uuid    -- the admin/super_admin performing the action
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enrollment_id uuid;
BEGIN
  -- Validate student exists and is active
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_student_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'STUDENT_NOT_FOUND: Student % does not exist or is suspended', p_student_id;
  END IF;

  -- Validate course exists
  IF NOT EXISTS (
    SELECT 1 FROM courses WHERE id = p_course_id
  ) THEN
    RAISE EXCEPTION 'COURSE_NOT_FOUND: Course % does not exist', p_course_id;
  END IF;

  -- Idempotency: already has an active enrollment → return early
  IF EXISTS (
    SELECT 1 FROM enrollments
    WHERE student_id = p_student_id
      AND course_id  = p_course_id
      AND status     = 'active'
  ) THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true);
  END IF;

  -- Insert enrollment
  INSERT INTO enrollments (student_id, course_id, enrolled_by, enrollment_method, status)
  VALUES (p_student_id, p_course_id, p_actor_id, 'admin_direct', 'active')
  RETURNING id INTO v_enrollment_id;

  -- Audit (non-fatal)
  BEGIN
    INSERT INTO audit_logs (user_id, action, details)
    VALUES (
      p_actor_id,
      'enrollment_created_by_admin',
      jsonb_build_object(
        'actor_id',       p_actor_id,
        'target_user_id', p_student_id,
        'course_id',      p_course_id,
        'enrollment_id',  v_enrollment_id,
        'action',         'enroll',
        'method',         'admin_direct'
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success',       true,
    'idempotent',    false,
    'enrollment_id', v_enrollment_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_enroll_student(uuid, uuid, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_enroll_student(uuid, uuid, uuid) FROM PUBLIC, authenticated, anon;

-- ── 3. admin_remove_enrollment ────────────────────────────────────────────────
-- Called exclusively by the admin-enrollment Edge Function (service role).
-- Hard-deletes any enrollment regardless of course ownership.
-- Returns jsonb: { success, enrollment_id, student_id, course_id }

CREATE OR REPLACE FUNCTION public.admin_remove_enrollment(
  p_enrollment_id uuid,
  p_actor_id      uuid    -- the admin/super_admin performing the action
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enrollment enrollments;
BEGIN
  SELECT * INTO v_enrollment
  FROM enrollments
  WHERE id = p_enrollment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: Enrollment % does not exist', p_enrollment_id;
  END IF;

  DELETE FROM enrollments WHERE id = p_enrollment_id;

  -- Audit (non-fatal)
  BEGIN
    INSERT INTO audit_logs (user_id, action, details)
    VALUES (
      p_actor_id,
      'enrollment_removed_by_admin',
      jsonb_build_object(
        'actor_id',       p_actor_id,
        'target_user_id', v_enrollment.student_id,
        'course_id',      v_enrollment.course_id,
        'enrollment_id',  p_enrollment_id,
        'action',         'remove'
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success',        true,
    'enrollment_id',  p_enrollment_id,
    'student_id',     v_enrollment.student_id,
    'course_id',      v_enrollment.course_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_remove_enrollment(uuid, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_remove_enrollment(uuid, uuid) FROM PUBLIC, authenticated, anon;
