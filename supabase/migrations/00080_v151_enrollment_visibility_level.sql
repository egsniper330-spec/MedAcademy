
-- ============================================================
-- v151 — Enrollment Visibility Level
-- Replaces hidden_from_instructor (boolean) with
-- visibility_level enum: all | admin_only | super_admin_only
-- ============================================================

-- ── 1. Create enum type ───────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.enrollment_visibility AS ENUM ('all', 'admin_only', 'super_admin_only');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. Drop the v150 RLS policy that references hidden_from_instructor
--      before dropping the column (avoids dependency error)
DROP POLICY IF EXISTS "enrollments_select_own" ON public.enrollments;
DROP POLICY IF EXISTS "lesson_progress_select_own" ON public.lesson_progress;

-- ── 3. Add visibility_level column, migrate data, drop old column ─────────────

ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS visibility_level public.enrollment_visibility NOT NULL DEFAULT 'all';

-- Migrate: hidden_from_instructor = true → admin_only, false → all
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'enrollments'
      AND column_name  = 'hidden_from_instructor'
  ) THEN
    UPDATE public.enrollments
    SET visibility_level = 'admin_only'
    WHERE hidden_from_instructor = true;

    ALTER TABLE public.enrollments DROP COLUMN hidden_from_instructor;
  END IF;
END $$;

-- Index for RLS/query performance
DROP INDEX IF EXISTS idx_enrollments_hidden;
CREATE INDEX IF NOT EXISTS idx_enrollments_visibility
  ON public.enrollments (visibility_level)
  WHERE visibility_level <> 'all';

-- ── 4. Drop old boolean helper, create role-aware helper ─────────────────────

DROP FUNCTION IF EXISTS public.is_enrollment_visible_to_doctor(uuid, uuid);

-- Returns true if the calling role may see this enrollment.
-- super_admin → always true
-- admin       → visibility_level IN ('all', 'admin_only')
-- doctor      → visibility_level = 'all'
CREATE OR REPLACE FUNCTION public.is_enrollment_visible_for_role(
  p_student_id uuid,
  p_course_id  uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_level  public.enrollment_visibility;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = auth.uid();

  IF v_role = 'super_admin' THEN RETURN true; END IF;

  SELECT visibility_level INTO v_level
  FROM enrollments
  WHERE student_id = p_student_id AND course_id = p_course_id
  LIMIT 1;

  IF NOT FOUND THEN RETURN false; END IF;

  IF v_role = 'admin' THEN
    RETURN v_level IN ('all', 'admin_only');
  END IF;

  RETURN v_level = 'all';
END;
$$;

-- ── 5. Recreate enrollments RLS ───────────────────────────────────────────────

CREATE POLICY "enrollments_select_own" ON public.enrollments
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR is_super_admin()
    OR (
      (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
      AND visibility_level IN ('all', 'admin_only')
    )
    OR (
      is_doctor_or_above()
      AND NOT is_super_admin()
      AND NOT ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin')
      AND visibility_level = 'all'
    )
  );

-- ── 6. Recreate lesson_progress RLS ─────────────────────────────────────────

CREATE POLICY "lesson_progress_select_own" ON public.lesson_progress
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR is_super_admin()
    OR (
      is_admin_or_super_admin()
      AND EXISTS (
        SELECT 1 FROM enrollments e
        WHERE e.student_id = lesson_progress.student_id
          AND e.course_id  = lesson_progress.course_id
          AND e.visibility_level IN ('all', 'admin_only')
      )
    )
    OR (
      is_doctor_or_above()
      AND NOT is_admin_or_super_admin()
      AND EXISTS (
        SELECT 1 FROM enrollments e
        WHERE e.student_id = lesson_progress.student_id
          AND e.course_id  = lesson_progress.course_id
          AND e.visibility_level = 'all'
      )
    )
  );

-- ── 7. Update admin_enroll_student: replace hidden param with visibility_level ─

DROP FUNCTION IF EXISTS public.admin_enroll_student(uuid, uuid, uuid, boolean);

CREATE OR REPLACE FUNCTION public.admin_enroll_student(
  p_student_id      uuid,
  p_course_id       uuid,
  p_actor_id        uuid,
  p_visibility_level text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  INSERT INTO enrollments (
    student_id, course_id, enrolled_by,
    enrollment_method, status, visibility_level
  )
  VALUES (
    p_student_id, p_course_id, p_actor_id,
    'admin_direct', 'active', v_vis
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
        'method',           'admin_direct',
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

GRANT EXECUTE ON FUNCTION public.admin_enroll_student(uuid, uuid, uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_enroll_student(uuid, uuid, uuid, text) FROM PUBLIC, authenticated, anon;

-- ── 8. Replace set_enrollment_hidden_flag with set_enrollment_visibility ──────

DROP FUNCTION IF EXISTS public.set_enrollment_hidden_flag(uuid, boolean, uuid);

CREATE OR REPLACE FUNCTION public.set_enrollment_visibility(
  p_enrollment_id   uuid,
  p_visibility_level text,
  p_actor_id        uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enrollment enrollments;
  v_vis        public.enrollment_visibility;
BEGIN
  BEGIN
    v_vis := p_visibility_level::public.enrollment_visibility;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'INVALID_VISIBILITY: % is not a valid visibility level', p_visibility_level;
  END;

  SELECT * INTO v_enrollment
  FROM enrollments WHERE id = p_enrollment_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: Enrollment % does not exist', p_enrollment_id;
  END IF;

  UPDATE enrollments
  SET visibility_level = v_vis
  WHERE id = p_enrollment_id;

  BEGIN
    INSERT INTO audit_logs (user_id, action, details)
    VALUES (
      p_actor_id,
      'enrollment_visibility_changed',
      jsonb_build_object(
        'actor_id',         p_actor_id,
        'enrollment_id',    p_enrollment_id,
        'student_id',       v_enrollment.student_id,
        'course_id',        v_enrollment.course_id,
        'visibility_level', p_visibility_level
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success',          true,
    'enrollment_id',    p_enrollment_id,
    'visibility_level', p_visibility_level
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_enrollment_visibility(uuid, text, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.set_enrollment_visibility(uuid, text, uuid) FROM PUBLIC, authenticated, anon;

-- ── 9. Update get_doctor_students: only visibility_level = 'all' ─────────────

CREATE OR REPLACE FUNCTION get_doctor_students(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
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
  WHERE e.visibility_level = 'all';

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION get_doctor_students(uuid) TO authenticated;

-- ── 10. New audit_action enum value ───────────────────────────────────────────

ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'enrollment_visibility_changed';
