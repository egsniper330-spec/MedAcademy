
-- Update get_doctor_students RPC to include assigned_price and doctor_revenue_price
-- so the doctor Students screen can resolve the deduction amount on removal.
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
      'assigned_price',    e.assigned_price,
      'course', jsonb_build_object(
        'id',                  c.id,
        'title',               c.title,
        'doctor_id',           c.doctor_id,
        'doctor_revenue_price', c.doctor_revenue_price
      ),
      'student', jsonb_build_object(
        'id',              p.id,
        'full_name',       p.full_name,
        'email',           p.email,
        'profile_email',   p.profile_email,
        'phone',           p.phone,
        'phone_e164',      p.phone_e164,
        'phone_national',  p.phone_national,
        'watermark_id',    p.watermark_id,
        'status',          p.status,
        'created_at',      p.created_at,
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
