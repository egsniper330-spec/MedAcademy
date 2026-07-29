
-- ============================================================
-- v63b: process_student_activation — atomic DB side of
--       student-operations Edge Function (Modes B/C/D/E)
--
-- Called by the Edge Function AFTER auth user + profile are
-- created (or for an existing student in D/E).
-- Runs entirely in one PG transaction:
--   enroll_credits → lock credits → deduct → enroll → ledger → audit
--   enroll_code    → validate code → redeem → enroll → audit
-- ============================================================

CREATE OR REPLACE FUNCTION public.process_student_activation(
  p_mode        text,       -- 'enroll_credits' | 'enroll_code'
  p_doctor_id   uuid,       -- verified by EF from JWT
  p_student_id  uuid,       -- newly created or existing student
  p_course_id   uuid,
  p_code        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credits     credits;
  v_bal_before  int;
  v_bal_after   int;
  v_tx_id       uuid;
  v_code_row    activation_codes;
BEGIN

  -- ── MODE: enroll via doctor credits ─────────────────────────────────────────
  IF p_mode = 'enroll_credits' THEN

    -- Idempotency guard
    IF EXISTS (
      SELECT 1 FROM enrollments
      WHERE student_id = p_student_id AND course_id = p_course_id
    ) THEN
      RETURN jsonb_build_object('success', true, 'idempotent', true, 'mode', p_mode);
    END IF;

    -- Verify doctor owns the course
    IF NOT EXISTS (
      SELECT 1 FROM courses WHERE id = p_course_id AND doctor_id = p_doctor_id
    ) THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED: Doctor does not own course %', p_course_id;
    END IF;

    -- Lock the credits row — prevents race conditions
    SELECT * INTO v_credits
    FROM credits
    WHERE doctor_id = p_doctor_id
    FOR UPDATE;

    IF v_credits IS NULL THEN
      RAISE EXCEPTION 'NO_CREDITS_RECORD: No credits record found for doctor %', p_doctor_id;
    END IF;

    IF v_credits.remaining < 1 THEN
      RAISE EXCEPTION 'INSUFFICIENT_CREDITS: Balance is %, need 1', v_credits.remaining;
    END IF;

    v_bal_before := v_credits.remaining;
    v_bal_after  := v_credits.remaining - 1;

    -- Insert enrollment
    INSERT INTO enrollments (student_id, course_id, enrolled_by, enrollment_method, status)
    VALUES (p_student_id, p_course_id, p_doctor_id, 'credits', 'active');

    -- Deduct credit
    UPDATE credits
    SET consumed   = consumed + 1,
        remaining  = remaining - 1,
        updated_at = now()
    WHERE doctor_id = p_doctor_id;

    -- Credit ledger with balance snapshots
    INSERT INTO credit_transactions (
      doctor_id, transaction_type, amount,
      course_id, student_id, performed_by,
      notes, balance_before, balance_after
    )
    VALUES (
      p_doctor_id, 'consumption', 1,
      p_course_id, p_student_id, p_doctor_id,
      'Student enrolled via doctor credits',
      v_bal_before, v_bal_after
    )
    RETURNING id INTO v_tx_id;

    -- Audit log
    INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
    VALUES (
      p_doctor_id, 'credit_consumed_by_doctor', 'enrollment', p_student_id,
      jsonb_build_object(
        'student_id',     p_student_id,
        'course_id',      p_course_id,
        'balance_before', v_bal_before,
        'balance_after',  v_bal_after,
        'transaction_id', v_tx_id,
        'mode',           p_mode
      )
    );

    RETURN jsonb_build_object(
      'success',        true,
      'mode',           p_mode,
      'balance_before', v_bal_before,
      'balance_after',  v_bal_after,
      'transaction_id', v_tx_id
    );

  -- ── MODE: enroll via activation code ────────────────────────────────────────
  ELSIF p_mode = 'enroll_code' THEN

    IF p_code IS NULL OR trim(p_code) = '' THEN
      RAISE EXCEPTION 'MISSING_CODE: Activation code is required';
    END IF;

    -- Idempotency guard
    IF EXISTS (
      SELECT 1 FROM enrollments
      WHERE student_id = p_student_id AND course_id = p_course_id
    ) THEN
      RETURN jsonb_build_object('success', true, 'idempotent', true, 'mode', p_mode);
    END IF;

    -- Lock and validate the code
    SELECT * INTO v_code_row
    FROM activation_codes
    WHERE code = upper(trim(p_code))
      AND course_id = p_course_id
    FOR UPDATE;

    IF v_code_row IS NULL THEN
      RAISE EXCEPTION 'INVALID_CODE: Code % not found for this course', p_code;
    END IF;

    IF v_code_row.status != 'active' THEN
      RAISE EXCEPTION 'CODE_USED: Code % has already been used or is inactive (status: %)', p_code, v_code_row.status;
    END IF;

    IF v_code_row.expires_at IS NOT NULL AND v_code_row.expires_at < now() THEN
      RAISE EXCEPTION 'CODE_EXPIRED: Code % expired at %', p_code, v_code_row.expires_at;
    END IF;

    -- Mark code as used
    UPDATE activation_codes
    SET status   = 'used',
        used_by  = p_student_id,
        used_at  = now()
    WHERE id = v_code_row.id;

    -- Insert enrollment
    INSERT INTO enrollments (student_id, course_id, enrolled_by, enrollment_method, status)
    VALUES (p_student_id, p_course_id, p_doctor_id, 'activation_code', 'active');

    -- Audit log
    INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
    VALUES (
      p_doctor_id, 'student_enrolled_via_code', 'enrollment', p_student_id,
      jsonb_build_object(
        'student_id', p_student_id,
        'course_id',  p_course_id,
        'code',       p_code,
        'mode',       p_mode
      )
    );

    RETURN jsonb_build_object(
      'success', true,
      'mode',    p_mode
    );

  ELSE
    RAISE EXCEPTION 'UNKNOWN_MODE: % is not a valid activation mode', p_mode;
  END IF;

END;
$$;

-- Grant execute to authenticated role so the EF's user-scoped client can call it
-- (EF uses service client, but this is belt-and-suspenders)
GRANT EXECUTE ON FUNCTION public.process_student_activation(text, uuid, uuid, uuid, text)
  TO authenticated, service_role;
