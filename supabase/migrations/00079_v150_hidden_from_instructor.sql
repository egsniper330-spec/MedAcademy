
-- ============================================================
-- v150 — Hidden from Instructor (Super Admin–only feature)
-- ============================================================
-- 1. Add hidden_from_instructor column to enrollments
-- 2. Add is_super_admin() SECURITY DEFINER helper
-- 3. Update enrollments RLS: doctors filtered by hidden flag
-- 4. Add is_enrollment_visible_to_doctor() helper for lesson_progress
-- 5. Update lesson_progress RLS: doctors filtered for hidden students
-- 6. Update admin_enroll_student to accept hidden flag
-- 7. Add set_enrollment_hidden_flag SECURITY DEFINER RPC
-- 8. Update get_doctor_students RPC to exclude hidden enrollments
-- 9. New audit_action enum values
-- ============================================================

-- ── 1. Column ─────────────────────────────────────────────────────────────────

ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS hidden_from_instructor boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_enrollments_hidden
  ON public.enrollments (hidden_from_instructor)
  WHERE hidden_from_instructor = true;

-- ── 2. is_super_admin() helper ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role = 'super_admin' FROM profiles WHERE id = auth.uid();
$$;

-- ── 3. Replace enrollments_select_own RLS policy ──────────────────────────────
-- Doctors (role = 'doctor') must NOT see hidden enrollments.
-- Admins and Super Admins see everything.
-- Students see only their own row.

DROP POLICY IF EXISTS "enrollments_select_own" ON public.enrollments;

CREATE POLICY "enrollments_select_own" ON public.enrollments
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR is_admin_or_super_admin()
    OR (
      is_doctor_or_above()
      AND NOT hidden_from_instructor
    )
  );

-- ── 4. Helper: is_enrollment_visible_to_doctor ────────────────────────────────
-- Used by lesson_progress RLS to check enrollment visibility without a
-- self-referencing loop. SECURITY DEFINER bypasses RLS on enrollments.

CREATE OR REPLACE FUNCTION public.is_enrollment_visible_to_doctor(
  p_student_id uuid,
  p_course_id  uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM enrollments
    WHERE student_id = p_student_id
      AND course_id  = p_course_id
      AND hidden_from_instructor = false
  );
$$;

-- ── 5. Replace lesson_progress_select_own RLS policy ─────────────────────────
-- Doctors must not see lesson progress for hidden-enrolled students.

DROP POLICY IF EXISTS "lesson_progress_select_own" ON public.lesson_progress;

CREATE POLICY "lesson_progress_select_own" ON public.lesson_progress
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR is_admin_or_super_admin()
    OR (
      is_doctor_or_above()
      AND is_enrollment_visible_to_doctor(student_id, course_id)
    )
  );

-- ── 6. Update admin_enroll_student to accept hidden flag ──────────────────────

CREATE OR REPLACE FUNCTION public.admin_enroll_student(
  p_student_id             uuid,
  p_course_id              uuid,
  p_actor_id               uuid,
  p_hidden_from_instructor boolean DEFAULT false
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
    SELECT 1 FROM profiles WHERE id = p_student_id AND status = 'active'
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

  -- Insert enrollment with hidden flag
  INSERT INTO enrollments (
    student_id, course_id, enrolled_by,
    enrollment_method, status, hidden_from_instructor
  )
  VALUES (
    p_student_id, p_course_id, p_actor_id,
    'admin_direct', 'active', p_hidden_from_instructor
  )
  RETURNING id INTO v_enrollment_id;

  -- Audit (non-fatal)
  BEGIN
    INSERT INTO audit_logs (user_id, action, details)
    VALUES (
      p_actor_id,
      'enrollment_created_by_admin',
      jsonb_build_object(
        'actor_id',                p_actor_id,
        'target_user_id',          p_student_id,
        'course_id',               p_course_id,
        'enrollment_id',           v_enrollment_id,
        'action',                  'enroll',
        'method',                  'admin_direct',
        'hidden_from_instructor',  p_hidden_from_instructor
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success',                 true,
    'idempotent',              false,
    'enrollment_id',           v_enrollment_id,
    'hidden_from_instructor',  p_hidden_from_instructor
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_enroll_student(uuid, uuid, uuid, boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_enroll_student(uuid, uuid, uuid, boolean) FROM PUBLIC, authenticated, anon;

-- Drop old 3-arg overload if it exists
DROP FUNCTION IF EXISTS public.admin_enroll_student(uuid, uuid, uuid);

-- ── 7. set_enrollment_hidden_flag — super_admin only ─────────────────────────
-- Called exclusively via the admin-enrollment Edge Function (service role).
-- The EF enforces that only super_admin actors may call this action.

CREATE OR REPLACE FUNCTION public.set_enrollment_hidden_flag(
  p_enrollment_id uuid,
  p_hidden        boolean,
  p_actor_id      uuid
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
  FROM enrollments WHERE id = p_enrollment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: Enrollment % does not exist', p_enrollment_id;
  END IF;

  UPDATE enrollments
  SET hidden_from_instructor = p_hidden
  WHERE id = p_enrollment_id;

  -- Audit (non-fatal)
  BEGIN
    INSERT INTO audit_logs (user_id, action, details)
    VALUES (
      p_actor_id,
      'enrollment_hidden_flag_set',
      jsonb_build_object(
        'actor_id',               p_actor_id,
        'enrollment_id',          p_enrollment_id,
        'student_id',             v_enrollment.student_id,
        'course_id',              v_enrollment.course_id,
        'hidden_from_instructor', p_hidden,
        'action',                 CASE WHEN p_hidden THEN 'hide' ELSE 'unhide' END
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success',                true,
    'enrollment_id',          p_enrollment_id,
    'hidden_from_instructor', p_hidden
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_enrollment_hidden_flag(uuid, boolean, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.set_enrollment_hidden_flag(uuid, boolean, uuid) FROM PUBLIC, authenticated, anon;

-- ── 8. Update get_doctor_students: exclude hidden enrollments ─────────────────

CREATE OR REPLACE FUNCTION get_doctor_students(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Security check: caller must be the doctor or an admin/super_admin
  IF p_doctor_id <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id',                e.id,
      'status',            e.status,
      'enrolled_at',       e.enrolled_at,
      'enrollment_method', COALESCE(e.enrollment_method, ''),
      'activation_method', COALESCE(e.activation_method, ''),
      'course', jsonb_build_object(
        'id',        c.id,
        'title',     c.title,
        'doctor_id', c.doctor_id
      ),
      'student', jsonb_build_object(
        'id',           p.id,
        'full_name',    p.full_name,
        'email',        p.email,
        'phone',        p.phone,
        'watermark_id', p.watermark_id,
        'university',     CASE WHEN u.id  IS NOT NULL THEN jsonb_build_object('id', u.id,  'name', u.name)  ELSE NULL END,
        'faculty',        CASE WHEN f.id  IS NOT NULL THEN jsonb_build_object('id', f.id,  'name', f.name)  ELSE NULL END,
        'academic_level', CASE WHEN al.id IS NOT NULL THEN jsonb_build_object('id', al.id, 'name', al.name) ELSE NULL END
      )
    )
    ORDER BY e.enrolled_at DESC
  )
  INTO v_result
  FROM enrollments e
  JOIN courses  c  ON c.id  = e.course_id  AND c.doctor_id = p_doctor_id
  JOIN profiles p  ON p.id  = e.student_id
  LEFT JOIN universities    u  ON u.id  = p.university_id
  LEFT JOIN faculties       f  ON f.id  = p.faculty_id
  LEFT JOIN academic_levels al ON al.id = p.academic_level_id
  WHERE e.hidden_from_instructor = false;   -- ← v150: exclude hidden enrollments

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION get_doctor_students(uuid) TO authenticated;

-- ── 9. New audit_action enum value ────────────────────────────────────────────

ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'enrollment_hidden_flag_set';
