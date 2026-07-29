
-- Replace remove_student_and_record_earnings to resolve the deduction price
-- internally from the DB priority chain, so the client never needs to pass or
-- pre-load a price value. Eliminates the race-condition where pricingSettings
-- hasn't loaded yet and the client sends p_deduct_amount = 0.
CREATE OR REPLACE FUNCTION remove_student_and_record_earnings(
  p_enrollment_id  uuid,
  p_doctor_id      uuid,
  p_student_name   text,
  p_course_name    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enrollment    enrollments;
  v_deduct_amount numeric;
  v_event_id      uuid;
BEGIN
  -- 1. Lock and validate enrollment
  SELECT * INTO v_enrollment
  FROM enrollments
  WHERE id = p_enrollment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND',
      'message', 'Enrollment not found');
  END IF;

  -- 2. Verify doctor owns the course
  IF NOT EXISTS (
    SELECT 1 FROM courses
    WHERE id = v_enrollment.course_id AND doctor_id = p_doctor_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'FORBIDDEN',
      'message', 'You do not own this course');
  END IF;

  -- 3. Resolve deduction amount using 3-level priority chain (all from DB):
  --    a. enrollment.assigned_price (per-student override)
  --    b. courses.doctor_revenue_price (per-course override)
  --    c. profiles.doctor_global_price (doctor's global price)
  SELECT COALESCE(
    v_enrollment.assigned_price,
    (SELECT doctor_revenue_price FROM courses WHERE id = v_enrollment.course_id),
    (SELECT doctor_global_price  FROM profiles WHERE id = p_doctor_id),
    0
  ) INTO v_deduct_amount;

  -- 4. Delete enrollment
  DELETE FROM enrollments WHERE id = p_enrollment_id;

  -- 5. Record negative earnings event only when there is a real price to deduct
  IF v_deduct_amount > 0 THEN
    INSERT INTO doctor_earnings_events(
      doctor_id, course_id, student_id,
      event_type, pricing_mode,
      price_snapshot, earnings_amount,
      transaction_type,
      student_name_snapshot, course_name_snapshot,
      notes
    ) VALUES (
      p_doctor_id,
      v_enrollment.course_id,
      v_enrollment.student_id,
      'credit_use',
      'doctor_independent',
      v_deduct_amount,
      -v_deduct_amount,
      'removal',
      p_student_name,
      p_course_name,
      'Student removed from course'
    )
    RETURNING id INTO v_event_id;
  END IF;

  -- 6. Audit log (non-fatal)
  BEGIN
    INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, details)
    VALUES (
      p_doctor_id, 'student_removed_with_earnings', 'enrollment', p_enrollment_id,
      jsonb_build_object(
        'student_id',    v_enrollment.student_id,
        'course_id',     v_enrollment.course_id,
        'deduct_amount', v_deduct_amount,
        'event_id',      v_event_id
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success',       true,
    'enrollment_id', p_enrollment_id,
    'event_id',      v_event_id,
    'deducted',      v_deduct_amount
  );
END;
$$;
