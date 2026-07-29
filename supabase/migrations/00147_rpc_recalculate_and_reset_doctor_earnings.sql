
-- ─────────────────────────────────────────────────────────────────────────────
-- recalculate_doctor_earnings
-- Reads every ACTIVE enrollment for this doctor's courses (excluding trashed
-- profiles and suspended/inactive enrollments), resolves the 3-level price
-- chain, and inserts a corrective 'adjustment' event that brings each
-- student/course pair back to the correct net balance.
-- Does NOT delete any history — purely additive corrections.
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
  -- Verify caller is the doctor or an admin
  IF p_doctor_id <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid()
      AND role IN ('admin','super_admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'FORBIDDEN');
  END IF;

  -- For each active enrollment on this doctor's courses where the student
  -- profile is NOT trashed and the enrollment status is 'active':
  FOR r IN
    SELECT
      e.id            AS enrollment_id,
      e.student_id,
      e.course_id,
      e.assigned_price,
      c.doctor_revenue_price,
      p.full_name     AS student_name,
      c.title         AS course_title,
      p.status        AS profile_status
    FROM enrollments e
    JOIN courses  c ON c.id = e.course_id AND c.doctor_id = p_doctor_id
    JOIN profiles p ON p.id = e.student_id
    WHERE e.status = 'active'
      AND p.status IS DISTINCT FROM 'trashed'
  LOOP
    -- Resolve target price: assigned → course → global
    SELECT COALESCE(
      r.assigned_price,
      r.doctor_revenue_price,
      (SELECT doctor_global_price FROM profiles WHERE id = p_doctor_id),
      0
    ) INTO v_target_price;

    -- Current net for this student+course
    SELECT COALESCE(SUM(dee.earnings_amount), 0) INTO v_current_net
    FROM doctor_earnings_events dee
    WHERE dee.doctor_id  = p_doctor_id
      AND dee.course_id  = r.course_id
      AND dee.student_id = r.student_id;

    v_delta := v_target_price - v_current_net;

    -- Only write a correction when the net deviates from target
    IF v_delta <> 0 THEN
      INSERT INTO doctor_earnings_events(
        doctor_id, course_id, student_id,
        event_type, pricing_mode, price_snapshot, earnings_amount,
        transaction_type, student_name_snapshot, course_name_snapshot, notes
      ) VALUES (
        p_doctor_id, r.course_id, r.student_id,
        'credit_use', 'doctor_independent',
        v_target_price, v_delta,
        'adjustment',
        r.student_name, r.course_title,
        'Recalculate Earnings correction'
      );
      v_corrections := v_corrections + 1;
    END IF;
  END LOOP;

  -- Also zero out any net-positive balance for TRASHED students
  -- (deleted accounts should never contribute positive revenue)
  FOR r IN
    SELECT
      dee.course_id,
      dee.student_id,
      p.full_name      AS student_name,
      c.title          AS course_title,
      SUM(dee.earnings_amount) AS net_amount
    FROM doctor_earnings_events dee
    JOIN profiles p ON p.id = dee.student_id AND p.status = 'trashed'
    JOIN courses  c ON c.id = dee.course_id
    WHERE dee.doctor_id = p_doctor_id
    GROUP BY dee.course_id, dee.student_id, p.full_name, c.title
    HAVING SUM(dee.earnings_amount) > 0
  LOOP
    INSERT INTO doctor_earnings_events(
      doctor_id, course_id, student_id,
      event_type, pricing_mode, price_snapshot, earnings_amount,
      transaction_type, student_name_snapshot, course_name_snapshot, notes
    ) VALUES (
      p_doctor_id, r.course_id, r.student_id,
      'credit_use', 'doctor_independent',
      r.net_amount, -r.net_amount,
      'account_deletion',
      r.student_name, r.course_title,
      'Recalculate: removed revenue for deleted account'
    );
    v_corrections := v_corrections + 1;
  END LOOP;

  -- Audit
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
-- reset_doctor_earnings
-- Deletes ALL existing earnings events for this doctor, then rebuilds from
-- scratch using ONLY currently active enrollments (non-trashed, active status).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reset_doctor_earnings(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r              RECORD;
  v_price        numeric;
  v_rebuilt      int := 0;
  v_deleted      int;
BEGIN
  -- Verify caller is the doctor or an admin
  IF p_doctor_id <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid()
      AND role IN ('admin','super_admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'FORBIDDEN');
  END IF;

  -- 1. Delete all existing events for this doctor
  DELETE FROM doctor_earnings_events WHERE doctor_id = p_doctor_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- 2. Rebuild from active enrollments only
  FOR r IN
    SELECT
      e.id            AS enrollment_id,
      e.student_id,
      e.course_id,
      e.assigned_price,
      c.doctor_revenue_price,
      p.full_name     AS student_name,
      c.title         AS course_title
    FROM enrollments e
    JOIN courses  c ON c.id = e.course_id AND c.doctor_id = p_doctor_id
    JOIN profiles p ON p.id = e.student_id
    WHERE e.status = 'active'
      AND p.status IS DISTINCT FROM 'trashed'
  LOOP
    SELECT COALESCE(
      r.assigned_price,
      r.doctor_revenue_price,
      (SELECT doctor_global_price FROM profiles WHERE id = p_doctor_id),
      0
    ) INTO v_price;

    IF v_price > 0 THEN
      INSERT INTO doctor_earnings_events(
        doctor_id, course_id, student_id,
        event_type, pricing_mode, price_snapshot, earnings_amount,
        transaction_type, student_name_snapshot, course_name_snapshot, notes
      ) VALUES (
        p_doctor_id, r.course_id, r.student_id,
        'credit_use', 'doctor_independent',
        v_price, v_price,
        'purchase',
        r.student_name, r.course_title,
        'Reset Earnings rebuild'
      );
      v_rebuilt := v_rebuilt + 1;
    END IF;
  END LOOP;

  -- Audit
  BEGIN
    INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, details)
    VALUES (auth.uid(), 'reset_earnings', 'doctor', p_doctor_id,
            jsonb_build_object('deleted', v_deleted, 'rebuilt', v_rebuilt));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'deleted', v_deleted, 'rebuilt', v_rebuilt);
END;
$$;
