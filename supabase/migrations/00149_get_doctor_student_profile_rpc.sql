
-- ─────────────────────────────────────────────────────────────────────────────
-- get_doctor_student_profile
--
-- Returns a student's profile + their enrollments on THIS doctor's courses.
-- Uses SECURITY DEFINER so doctors can read student profiles they have an
-- enrollment relationship with, without needing direct RLS access to the
-- profiles table for non-doctor/non-self rows.
--
-- Security check: the student must have at least one enrollment in a course
-- owned by the calling doctor, OR the doctor is an admin/super_admin.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_doctor_student_profile(
  p_doctor_id  uuid,
  p_student_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id   uuid := auth.uid();
  v_caller_role text := (auth.jwt() ->> 'role');
  v_profile     jsonb;
  v_enrollments jsonb;
BEGIN
  -- Auth check: caller must be the doctor or an admin
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  IF v_caller_id <> p_doctor_id
     AND v_caller_role NOT IN ('admin', 'super_admin') THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  -- Relationship check: student must have an enrollment on one of this doctor's courses
  IF NOT EXISTS (
    SELECT 1
    FROM enrollments e
    JOIN courses c ON c.id = e.course_id
    WHERE e.student_id = p_student_id
      AND c.doctor_id  = p_doctor_id
  ) AND v_caller_role NOT IN ('admin', 'super_admin') THEN
    RETURN jsonb_build_object('error', 'no_relationship');
  END IF;

  -- Fetch profile (bypasses RLS via SECURITY DEFINER)
  SELECT jsonb_build_object(
    'id',             p.id,
    'full_name',      p.full_name,
    'phone',          p.phone,
    'email',          COALESCE(p.profile_email, p.email),
    'avatar_url',     p.avatar_url,
    'watermark_id',   p.watermark_id,
    'created_at',     p.created_at,
    'account_status', p.status::text
  )
  INTO v_profile
  FROM profiles p
  WHERE p.id = p_student_id;

  IF v_profile IS NULL THEN
    -- Student row was hard-deleted (extremely rare)
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Fetch enrollments on THIS doctor's courses only
  SELECT jsonb_agg(
    jsonb_build_object(
      'enrollment_id',    e.id,
      'course_id',        e.course_id,
      'course_title',     c.title,
      'enrolled_at',      e.enrolled_at,
      'status',           COALESCE(e.status::text, 'active'),
      'assigned_price',   e.assigned_price,
      'progress_percent', COALESCE(e.progress_percent, 0)
    )
    ORDER BY e.enrolled_at DESC
  )
  INTO v_enrollments
  FROM enrollments e
  JOIN courses c ON c.id = e.course_id
  WHERE e.student_id = p_student_id
    AND c.doctor_id  = p_doctor_id;

  RETURN v_profile
    || jsonb_build_object(
         'found',       true,
         'enrollments', COALESCE(v_enrollments, '[]'::jsonb)
       );
END;
$$;

-- Grant execute to authenticated users (RLS enforced inside the function)
GRANT EXECUTE ON FUNCTION get_doctor_student_profile(uuid, uuid) TO authenticated;
