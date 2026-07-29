
-- ============================================================
-- v67: Enrollment fixes
-- 1. Fix process_student_activation — idempotency checks ACTIVE only
-- 2. New get_course_delete_stats RPC — real counts for delete dialog
-- 3. New remove_course_enrollment RPC — doctor-owned enrollment delete
-- ============================================================

-- ── 1. Update process_student_activation ─────────────────────────────────────
-- Change idempotency guard to check status='active' only, so a student
-- who was previously removed can be re-enrolled without hitting the guard.
CREATE OR REPLACE FUNCTION public.process_student_activation(
  p_mode        text,
  p_doctor_id   uuid,
  p_student_id  uuid,
  p_course_id   uuid,
  p_code        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credits     credits;
  v_bal_before  int;
  v_bal_after   int;
  v_tx_id       uuid;
  v_code_row    activation_codes;
BEGIN

  IF p_mode = 'enroll_credits' THEN

    -- Check for ACTIVE enrollment only (allows re-enroll after removal)
    IF EXISTS (
      SELECT 1 FROM enrollments
      WHERE student_id = p_student_id
        AND course_id  = p_course_id
        AND status     = 'active'
    ) THEN
      RETURN jsonb_build_object('success', true, 'idempotent', true, 'mode', p_mode);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM courses WHERE id = p_course_id AND doctor_id = p_doctor_id
    ) THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED: Doctor does not own course %', p_course_id;
    END IF;

    SELECT * INTO v_credits
    FROM credits
    WHERE doctor_id = p_doctor_id
    FOR UPDATE;

    IF v_credits IS NULL THEN
      RAISE EXCEPTION 'NO_CREDITS_RECORD: No credits record found for doctor %', p_doctor_id;
    END IF;

    IF v_credits.remaining < 1 THEN
      RAISE EXCEPTION 'INSUFFICIENT_CREDITS: Balance is %, need 1', v_credits.remaining;
    END IF;

    v_bal_before := v_credits.remaining;
    v_bal_after  := v_credits.remaining - 1;

    INSERT INTO enrollments (student_id, course_id, enrolled_by, enrollment_method, status)
    VALUES (p_student_id, p_course_id, p_doctor_id, 'credits', 'active');

    UPDATE credits
    SET consumed   = consumed + 1,
        remaining  = remaining - 1,
        updated_at = now()
    WHERE doctor_id = p_doctor_id;

    INSERT INTO credit_transactions (
      doctor_id, transaction_type, amount,
      course_id, student_id, performed_by,
      notes, balance_before, balance_after
    )
    VALUES (
      p_doctor_id, 'consumption', 1,
      p_course_id, p_student_id, p_doctor_id,
      'Student enrolled via doctor credits',
      v_bal_before, v_bal_after
    )
    RETURNING id INTO v_tx_id;

    INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
    VALUES (
      p_doctor_id, 'credit_consumed_by_doctor', 'enrollment', p_student_id,
      jsonb_build_object(
        'student_id', p_student_id, 'course_id', p_course_id,
        'balance_before', v_bal_before, 'balance_after', v_bal_after,
        'transaction_id', v_tx_id, 'mode', p_mode
      )
    );

    RETURN jsonb_build_object(
      'success', true, 'mode', p_mode,
      'balance_before', v_bal_before, 'balance_after', v_bal_after,
      'transaction_id', v_tx_id
    );

  ELSIF p_mode = 'enroll_code' THEN

    IF p_code IS NULL OR trim(p_code) = '' THEN
      RAISE EXCEPTION 'MISSING_CODE: Activation code is required';
    END IF;

    -- Check for ACTIVE enrollment only
    IF EXISTS (
      SELECT 1 FROM enrollments
      WHERE student_id = p_student_id
        AND course_id  = p_course_id
        AND status     = 'active'
    ) THEN
      RETURN jsonb_build_object('success', true, 'idempotent', true, 'mode', p_mode);
    END IF;

    SELECT * INTO v_code_row
    FROM activation_codes
    WHERE code      = upper(trim(p_code))
      AND course_id = p_course_id
    FOR UPDATE;

    IF v_code_row IS NULL THEN
      RAISE EXCEPTION 'INVALID_CODE: Code % not found for this course', p_code;
    END IF;

    IF v_code_row.status != 'active' THEN
      RAISE EXCEPTION 'CODE_USED: Code % has already been used or is inactive (status: %)', p_code, v_code_row.status;
    END IF;

    IF v_code_row.expires_at IS NOT NULL AND v_code_row.expires_at < now() THEN
      RAISE EXCEPTION 'CODE_EXPIRED: Code % expired at %', p_code, v_code_row.expires_at;
    END IF;

    UPDATE activation_codes
    SET status   = 'used',
        used_by  = p_student_id,
        used_at  = now()
    WHERE id = v_code_row.id;

    INSERT INTO enrollments (student_id, course_id, enrolled_by, enrollment_method, status)
    VALUES (p_student_id, p_course_id, p_doctor_id, 'activation_code', 'active');

    INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
    VALUES (
      p_doctor_id, 'student_enrolled_via_code', 'enrollment', p_student_id,
      jsonb_build_object(
        'student_id', p_student_id, 'course_id', p_course_id,
        'code', p_code, 'mode', p_mode
      )
    );

    RETURN jsonb_build_object('success', true, 'mode', p_mode);

  ELSE
    RAISE EXCEPTION 'UNKNOWN_MODE: % is not a valid activation mode', p_mode;
  END IF;

END;
$$;

GRANT EXECUTE ON FUNCTION public.process_student_activation(text, uuid, uuid, uuid, text)
  TO authenticated, service_role;


-- ── 2. get_course_delete_stats ────────────────────────────────────────────────
-- Returns real counts for the delete-confirmation dialog.
-- Replaces the broken nested-PostgREST count approach in getCourseDeleteStats().
CREATE OR REPLACE FUNCTION public.get_course_delete_stats(p_course_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course         record;
  v_lesson_ids     uuid[];
  v_section_count  int := 0;
  v_lesson_count   int := 0;
  v_video_count    int := 0;
  v_pdf_count      int := 0;
  v_material_count int := 0;
  v_enroll_count   int := 0;
  v_code_count     int := 0;
  v_doctor_name    text;
BEGIN
  SELECT c.id, c.title, c.doctor_id, c.created_at, c.updated_at
  INTO v_course
  FROM courses c
  WHERE c.id = p_course_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COURSE_NOT_FOUND: %', p_course_id;
  END IF;

  -- Doctor name
  SELECT full_name INTO v_doctor_name FROM profiles WHERE id = v_course.doctor_id;

  -- Direct counts (fast, no nested aggregation)
  SELECT COUNT(*) INTO v_section_count  FROM sections         WHERE course_id = p_course_id;
  SELECT COUNT(*) INTO v_lesson_count   FROM lessons           WHERE course_id = p_course_id;
  SELECT COUNT(*) INTO v_enroll_count   FROM enrollments       WHERE course_id = p_course_id;
  SELECT COUNT(*) INTO v_code_count     FROM activation_codes  WHERE course_id = p_course_id;

  -- Lesson-level counts via course_id (video_uploads has course_id directly)
  SELECT COUNT(*) INTO v_video_count FROM video_uploads WHERE course_id = p_course_id;

  -- lesson_pdfs and lesson_materials don't have course_id — join through lessons
  SELECT ARRAY_AGG(id) INTO v_lesson_ids FROM lessons WHERE course_id = p_course_id;
  IF v_lesson_ids IS NOT NULL THEN
    SELECT COUNT(*) INTO v_pdf_count      FROM lesson_pdfs      WHERE lesson_id = ANY(v_lesson_ids);
    SELECT COUNT(*) INTO v_material_count FROM lesson_materials  WHERE lesson_id = ANY(v_lesson_ids);
  END IF;

  RETURN jsonb_build_object(
    'title',            v_course.title,
    'doctor_name',      COALESCE(v_doctor_name, ''),
    'created_at',       v_course.created_at,
    'updated_at',       COALESCE(v_course.updated_at, v_course.created_at),
    'enrolled_count',   v_enroll_count,
    'section_count',    v_section_count,
    'lesson_count',     v_lesson_count,
    'video_count',      v_video_count,
    'pdf_count',        v_pdf_count,
    'attachment_count', v_material_count,
    'code_count',       v_code_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_course_delete_stats(uuid) TO authenticated, service_role;


-- ── 3. remove_course_enrollment ───────────────────────────────────────────────
-- Verifies course ownership then hard-deletes the enrollment.
-- Bypasses the missing DELETE RLS policy (which would silently no-op client-side).
CREATE OR REPLACE FUNCTION public.remove_course_enrollment(
  p_enrollment_id uuid,
  p_doctor_id     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enrollment enrollments;
BEGIN
  SELECT * INTO v_enrollment FROM enrollments WHERE id = p_enrollment_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: Enrollment % does not exist', p_enrollment_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM courses
    WHERE id = v_enrollment.course_id AND doctor_id = p_doctor_id
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN: You do not own the course for this enrollment';
  END IF;

  DELETE FROM enrollments WHERE id = p_enrollment_id;

  -- Audit (non-fatal)
  BEGIN
    INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
    VALUES (
      p_doctor_id, 'student_removed_by_doctor', 'enrollment', p_enrollment_id,
      jsonb_build_object(
        'enrollment_id', p_enrollment_id,
        'student_id',    v_enrollment.student_id,
        'course_id',     v_enrollment.course_id
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'enrollment_id', p_enrollment_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_course_enrollment(uuid, uuid) TO authenticated, service_role;
