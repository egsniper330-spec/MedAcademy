
-- Fix the purchase trigger to write all snapshot fields (phone, email, watermark)
-- Previously it only wrote student_name_snapshot and course_name_snapshot.
CREATE OR REPLACE FUNCTION trg_record_earnings_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doctor_global_price  numeric := 0;
  v_course_revenue_price numeric;
  v_assigned_price       numeric;
  v_resolved_price       numeric := 0;
  v_student_name         text    := NULL;
  v_student_email        text    := NULL;
  v_student_phone        text    := NULL;
  v_student_watermark    text    := NULL;
  v_course_name          text    := NULL;
BEGIN
  IF NEW.transaction_type <> 'consumption' THEN RETURN NEW; END IF;
  IF NEW.doctor_id IS NULL THEN RETURN NEW; END IF;

  -- 1. Doctor global price
  SELECT COALESCE(doctor_global_price, 0)
    INTO v_doctor_global_price
    FROM profiles WHERE id = NEW.doctor_id;

  -- 2. Per-course revenue override + course name
  IF NEW.course_id IS NOT NULL THEN
    SELECT doctor_revenue_price, title
      INTO v_course_revenue_price, v_course_name
      FROM courses WHERE id = NEW.course_id;
  END IF;

  -- 3. Per-student assigned_price from enrollment row just inserted
  IF NEW.course_id IS NOT NULL AND NEW.student_id IS NOT NULL THEN
    SELECT assigned_price INTO v_assigned_price
      FROM enrollments
     WHERE course_id = NEW.course_id AND student_id = NEW.student_id
     ORDER BY enrolled_at DESC LIMIT 1;
  END IF;

  -- 4. Resolve: per-student → per-course → global  (platform price NEVER used)
  v_resolved_price := COALESCE(v_assigned_price, v_course_revenue_price, v_doctor_global_price, 0);

  -- 5. Student snapshot fields (name, email, phone, watermark)
  IF NEW.student_id IS NOT NULL THEN
    SELECT
      full_name,
      COALESCE(profile_email, email),
      COALESCE(phone_national, phone_e164, phone),
      watermark_id
    INTO v_student_name, v_student_email, v_student_phone, v_student_watermark
    FROM profiles
    WHERE id = NEW.student_id;
  END IF;

  INSERT INTO doctor_earnings_events(
    doctor_id, course_id, student_id,
    event_type, pricing_mode, price_snapshot, earnings_amount,
    transaction_type,
    student_name_snapshot,     course_name_snapshot,
    student_email_snapshot,    student_phone_snapshot,
    student_watermark_snapshot
  ) VALUES (
    NEW.doctor_id, NEW.course_id, NEW.student_id,
    'credit_use', 'doctor_independent', v_resolved_price, v_resolved_price,
    'purchase',
    v_student_name,    v_course_name,
    v_student_email,   v_student_phone,
    v_student_watermark
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;
