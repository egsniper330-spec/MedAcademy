CREATE OR REPLACE FUNCTION public.admin_enroll_student(
  p_student_id      uuid,
  p_course_id       uuid,
  p_actor_id        uuid,
  p_visibility_level text DEFAULT 'all'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_enrollment_id uuid;
  v_vis           public.enrollment_visibility;
BEGIN
  BEGIN
    v_vis := p_visibility_level::public.enrollment_visibility;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY: % is not a valid visibility level', p_visibility_level;
  END;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_student_id AND status = 'active') THEN
    RAISE EXCEPTION 'STUDENT_NOT_FOUND: Student % does not exist or is suspended', p_student_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM courses WHERE id = p_course_id) THEN
    RAISE EXCEPTION 'COURSE_NOT_FOUND: Course % does not exist', p_course_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM enrollments
    WHERE student_id = p_student_id AND course_id = p_course_id AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true);
  END IF;

  -- Use 'admin' — the valid CHECK constraint value for admin-initiated enrollments.
  -- ('admin_direct' was previously used but is not in enrollments_enrollment_method_check)
  INSERT INTO enrollments (
    student_id, course_id, enrolled_by,
    enrollment_method, status, visibility_level
  )
  VALUES (
    p_student_id, p_course_id, p_actor_id,
    'admin', 'active', v_vis
  )
  RETURNING id INTO v_enrollment_id;

  BEGIN
    INSERT INTO audit_logs (user_id, action, details)
    VALUES (
      p_actor_id,
      'enrollment_created_by_admin',
      jsonb_build_object(
        'actor_id',         p_actor_id,
        'target_user_id',   p_student_id,
        'course_id',        p_course_id,
        'enrollment_id',    v_enrollment_id,
        'action',           'enroll',
        'method',           'admin',
        'visibility_level', p_visibility_level
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success',          true,
    'idempotent',       false,
    'enrollment_id',    v_enrollment_id,
    'visibility_level', p_visibility_level
  );
END;
$$;