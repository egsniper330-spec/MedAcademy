
-- get_doctor_students: SECURITY DEFINER RPC, returns all enrollments for courses
-- owned by the given doctor, with full student profiles. Bypasses RLS entirely.
-- Replaces the broken client-side query that used .eq('courses.doctor_id') + .order('created_at').

CREATE OR REPLACE FUNCTION get_doctor_students(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
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
        'id',        p.id,
        'full_name', p.full_name,
        'email',     p.email,
        'phone',     p.phone,
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
  LEFT JOIN universities   u  ON u.id  = p.university_id
  LEFT JOIN faculties      f  ON f.id  = p.faculty_id
  LEFT JOIN academic_levels al ON al.id = p.academic_level_id;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION get_doctor_students(uuid) TO authenticated;
