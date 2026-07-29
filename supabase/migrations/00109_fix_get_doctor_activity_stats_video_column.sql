
CREATE OR REPLACE FUNCTION get_doctor_activity_stats(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile           profiles%ROWTYPE;
  v_allocated         numeric := 0;
  v_consumed          numeric := 0;
  v_remaining         numeric := 0;
  v_videos_uploaded   bigint  := 0;
  v_courses_sold      bigint  := 0;
  v_students_enrolled bigint  := 0;
  v_last_login        timestamptz;
  v_last_active       timestamptz;
BEGIN
  SELECT * INTO v_profile FROM profiles WHERE id = p_doctor_id AND role = 'doctor';
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Credits: sum directly from credit_transactions to avoid missing credits-row edge-case
  SELECT
    COALESCE(SUM(CASE WHEN transaction_type IN ('allocation','grant_admin','grant_super_admin') THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN transaction_type = 'consumption' THEN amount ELSE 0 END), 0)
  INTO v_allocated, v_consumed
  FROM credit_transactions
  WHERE doctor_id = p_doctor_id;

  v_remaining := GREATEST(v_allocated - v_consumed, 0);

  -- Videos: use video_id (not video_url — that column does not exist)
  SELECT COUNT(*)
  INTO v_videos_uploaded
  FROM lessons l
  JOIN courses c ON c.id = l.course_id
  WHERE c.doctor_id = p_doctor_id
    AND c.permanently_deleted = false
    AND l.video_id IS NOT NULL;

  -- Courses sold (distinct courses with at least 1 consumption)
  SELECT COUNT(DISTINCT course_id)
  INTO v_courses_sold
  FROM credit_transactions
  WHERE doctor_id = p_doctor_id AND transaction_type = 'consumption';

  -- Students enrolled (distinct students)
  SELECT COUNT(DISTINCT student_id)
  INTO v_students_enrolled
  FROM credit_transactions
  WHERE doctor_id = p_doctor_id AND transaction_type = 'consumption'
    AND student_id IS NOT NULL;

  -- Last login
  SELECT created_at INTO v_last_login
  FROM audit_logs
  WHERE (user_id = p_doctor_id OR actor_id = p_doctor_id)
    AND action::text = 'login'
  ORDER BY created_at DESC LIMIT 1;

  -- Last active (any event)
  SELECT created_at INTO v_last_active
  FROM audit_logs
  WHERE user_id = p_doctor_id OR actor_id = p_doctor_id
  ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'credit_selling_price',  COALESCE(v_profile.credit_selling_price, 0),
    'total_allocated',       v_allocated,
    'total_used',            v_consumed,
    'remaining_credits',     v_remaining,
    'total_earnings',        v_consumed * COALESCE(v_profile.credit_selling_price, 0),
    'courses_sold',          v_courses_sold,
    'students_enrolled',     v_students_enrolled,
    'videos_uploaded',       v_videos_uploaded,
    'last_login',            v_last_login,
    'last_active',           v_last_active
  );
END;
$$;
