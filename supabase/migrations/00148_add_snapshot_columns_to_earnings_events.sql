
-- Add immutable snapshot columns for deleted-account display
ALTER TABLE doctor_earnings_events
  ADD COLUMN IF NOT EXISTS student_email_snapshot     text,
  ADD COLUMN IF NOT EXISTS student_phone_snapshot     text,
  ADD COLUMN IF NOT EXISTS student_watermark_snapshot text;

-- ─────────────────────────────────────────────────────────────────────────────
-- remove_student_and_record_earnings — now captures email/phone/watermark
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION remove_student_and_record_earnings(
  p_enrollment_id uuid,
  p_doctor_id     uuid,
  p_student_name  text DEFAULT '',
  p_course_name   text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enrollment    RECORD;
  v_student       RECORD;
  v_deduct_amount numeric;
  v_event_id      uuid;
BEGIN
  -- Fetch enrollment + owning doctor
  SELECT e.*, c.doctor_id AS course_doctor_id, c.title AS course_title,
         c.doctor_revenue_price
  INTO v_enrollment
  FROM enrollments e
  JOIN courses c ON c.id = e.course_id
  WHERE e.id = p_enrollment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ENROLLMENT_NOT_FOUND');
  END IF;

  -- Only the owning doctor can remove
  IF v_enrollment.course_doctor_id <> p_doctor_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'FORBIDDEN');
  END IF;

  -- Fetch student snapshot data
  SELECT full_name,
         COALESCE(profile_email, email) AS email,
         COALESCE(phone_national, phone_e164, phone) AS phone,
         watermark_id
  INTO v_student
  FROM profiles
  WHERE id = v_enrollment.student_id;

  -- Resolve deduction amount: assigned_price → course price → doctor global
  SELECT COALESCE(
    v_enrollment.assigned_price,
    v_enrollment.doctor_revenue_price,
    (SELECT doctor_global_price FROM profiles WHERE id = p_doctor_id),
    0
  ) INTO v_deduct_amount;

  IF v_deduct_amount <= 0 THEN
    -- Still delete enrollment even if no revenue to deduct
    DELETE FROM enrollments WHERE id = p_enrollment_id;
    RETURN jsonb_build_object('success', true, 'deducted', 0, 'event_id', null, 'enrollment_id', p_enrollment_id);
  END IF;

  -- Delete enrollment
  DELETE FROM enrollments WHERE id = p_enrollment_id;

  -- Insert negative earnings event with full snapshots
  INSERT INTO doctor_earnings_events(
    doctor_id, course_id, student_id,
    event_type, pricing_mode, price_snapshot, earnings_amount,
    transaction_type,
    student_name_snapshot,    course_name_snapshot,
    student_email_snapshot,   student_phone_snapshot,
    student_watermark_snapshot,
    notes
  ) VALUES (
    p_doctor_id,
    v_enrollment.course_id,
    v_enrollment.student_id,
    'credit_use', 'doctor_independent',
    v_deduct_amount, -v_deduct_amount,
    'removal',
    COALESCE(v_student.full_name, p_student_name),
    COALESCE(v_enrollment.course_title, p_course_name),
    v_student.email,
    v_student.phone,
    v_student.watermark_id,
    'Student removed by doctor'
  )
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'deducted', v_deduct_amount,
    'event_id', v_event_id,
    'enrollment_id', p_enrollment_id
  );
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- recalculate_doctor_earnings — writes snapshot columns on new adjustment rows
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recalculate_doctor_earnings(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r              RECORD;
  v_current_net  numeric;
  v_target_price numeric;
  v_delta        numeric;
  v_corrections  int := 0;
BEGIN
  IF p_doctor_id <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'FORBIDDEN');
  END IF;

  -- Correct active enrollments
  FOR r IN
    SELECT e.id AS enrollment_id, e.student_id, e.course_id,
           e.assigned_price, c.doctor_revenue_price,
           p.full_name AS student_name, c.title AS course_title,
           COALESCE(p.profile_email, p.email)           AS student_email,
           COALESCE(p.phone_national, p.phone_e164, p.phone) AS student_phone,
           p.watermark_id AS student_watermark
    FROM enrollments e
    JOIN courses  c ON c.id = e.course_id AND c.doctor_id = p_doctor_id
    JOIN profiles p ON p.id = e.student_id
    WHERE e.status = 'active'
      AND p.status IS DISTINCT FROM 'trashed'
  LOOP
    SELECT COALESCE(r.assigned_price, r.doctor_revenue_price,
      (SELECT doctor_global_price FROM profiles WHERE id = p_doctor_id), 0)
    INTO v_target_price;

    SELECT COALESCE(SUM(dee.earnings_amount), 0) INTO v_current_net
    FROM doctor_earnings_events dee
    WHERE dee.doctor_id = p_doctor_id AND dee.course_id = r.course_id AND dee.student_id = r.student_id;

    v_delta := v_target_price - v_current_net;
    IF v_delta <> 0 THEN
      INSERT INTO doctor_earnings_events(
        doctor_id, course_id, student_id,
        event_type, pricing_mode, price_snapshot, earnings_amount,
        transaction_type,
        student_name_snapshot, course_name_snapshot,
        student_email_snapshot, student_phone_snapshot, student_watermark_snapshot,
        notes
      ) VALUES (
        p_doctor_id, r.course_id, r.student_id,
        'credit_use', 'doctor_independent', v_target_price, v_delta,
        'adjustment',
        r.student_name, r.course_title,
        r.student_email, r.student_phone, r.student_watermark,
        'Recalculate Earnings correction'
      );
      v_corrections := v_corrections + 1;
    END IF;
  END LOOP;

  -- Zero out trashed accounts with net-positive balance
  FOR r IN
    SELECT dee.course_id, dee.student_id,
           p.full_name AS student_name, c.title AS course_title,
           COALESCE(p.profile_email, p.email)           AS student_email,
           COALESCE(p.phone_national, p.phone_e164, p.phone) AS student_phone,
           p.watermark_id AS student_watermark,
           SUM(dee.earnings_amount) AS net_amount
    FROM doctor_earnings_events dee
    JOIN profiles p ON p.id = dee.student_id AND p.status = 'trashed'
    JOIN courses  c ON c.id = dee.course_id
    WHERE dee.doctor_id = p_doctor_id
    GROUP BY dee.course_id, dee.student_id, p.full_name, c.title,
             p.profile_email, p.email, p.phone_national, p.phone_e164, p.phone, p.watermark_id
    HAVING SUM(dee.earnings_amount) > 0
  LOOP
    INSERT INTO doctor_earnings_events(
      doctor_id, course_id, student_id,
      event_type, pricing_mode, price_snapshot, earnings_amount,
      transaction_type,
      student_name_snapshot, course_name_snapshot,
      student_email_snapshot, student_phone_snapshot, student_watermark_snapshot,
      notes
    ) VALUES (
      p_doctor_id, r.course_id, r.student_id,
      'credit_use', 'doctor_independent', r.net_amount, -r.net_amount,
      'account_deletion',
      r.student_name, r.course_title,
      r.student_email, r.student_phone, r.student_watermark,
      'Recalculate: removed revenue for deleted account'
    );
    v_corrections := v_corrections + 1;
  END LOOP;

  BEGIN
    INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, details)
    VALUES (auth.uid(), 'recalculate_earnings', 'doctor', p_doctor_id,
            jsonb_build_object('corrections', v_corrections));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'corrections', v_corrections);
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- reset_doctor_earnings — writes snapshot columns on rebuilt purchase rows
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reset_doctor_earnings(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r         RECORD;
  v_price   numeric;
  v_rebuilt int := 0;
  v_deleted int;
BEGIN
  IF p_doctor_id <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'FORBIDDEN');
  END IF;

  DELETE FROM doctor_earnings_events WHERE doctor_id = p_doctor_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  FOR r IN
    SELECT e.id AS enrollment_id, e.student_id, e.course_id,
           e.assigned_price, c.doctor_revenue_price,
           p.full_name AS student_name, c.title AS course_title,
           COALESCE(p.profile_email, p.email)           AS student_email,
           COALESCE(p.phone_national, p.phone_e164, p.phone) AS student_phone,
           p.watermark_id AS student_watermark
    FROM enrollments e
    JOIN courses  c ON c.id = e.course_id AND c.doctor_id = p_doctor_id
    JOIN profiles p ON p.id = e.student_id
    WHERE e.status = 'active'
      AND p.status IS DISTINCT FROM 'trashed'
  LOOP
    SELECT COALESCE(r.assigned_price, r.doctor_revenue_price,
      (SELECT doctor_global_price FROM profiles WHERE id = p_doctor_id), 0)
    INTO v_price;

    IF v_price > 0 THEN
      INSERT INTO doctor_earnings_events(
        doctor_id, course_id, student_id,
        event_type, pricing_mode, price_snapshot, earnings_amount,
        transaction_type,
        student_name_snapshot, course_name_snapshot,
        student_email_snapshot, student_phone_snapshot, student_watermark_snapshot,
        notes
      ) VALUES (
        p_doctor_id, r.course_id, r.student_id,
        'credit_use', 'doctor_independent', v_price, v_price,
        'purchase',
        r.student_name, r.course_title,
        r.student_email, r.student_phone, r.student_watermark,
        'Reset Earnings rebuild'
      );
      v_rebuilt := v_rebuilt + 1;
    END IF;
  END LOOP;

  BEGIN
    INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, details)
    VALUES (auth.uid(), 'reset_earnings', 'doctor', p_doctor_id,
            jsonb_build_object('deleted', v_deleted, 'rebuilt', v_rebuilt));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'deleted', v_deleted, 'rebuilt', v_rebuilt);
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- trg_deduct_earnings_on_account_deletion — also captures snapshots
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_deduct_earnings_on_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  IF NEW.status <> 'trashed' OR OLD.status = 'trashed' THEN
    RETURN NEW;
  END IF;

  FOR r IN
    SELECT dee.doctor_id, dee.course_id, dee.course_name_snapshot,
           SUM(dee.earnings_amount) AS net_amount
    FROM doctor_earnings_events dee
    WHERE dee.student_id = NEW.id
    GROUP BY dee.doctor_id, dee.course_id, dee.course_name_snapshot
    HAVING SUM(dee.earnings_amount) > 0
  LOOP
    INSERT INTO doctor_earnings_events(
      doctor_id, course_id, student_id,
      event_type, pricing_mode, price_snapshot, earnings_amount,
      transaction_type,
      student_name_snapshot,    course_name_snapshot,
      student_email_snapshot,   student_phone_snapshot,
      student_watermark_snapshot,
      notes
    ) VALUES (
      r.doctor_id, r.course_id, NEW.id,
      'credit_use', 'doctor_independent',
      r.net_amount, -r.net_amount,
      'account_deletion',
      COALESCE(NEW.full_name, 'Deleted Account'),
      r.course_name_snapshot,
      COALESCE(NEW.profile_email, NEW.email),
      COALESCE(NEW.phone_national, NEW.phone_e164, NEW.phone),
      NEW.watermark_id,
      'Student account deleted'
    );
  END LOOP;

  RETURN NEW;
END;
$$;
