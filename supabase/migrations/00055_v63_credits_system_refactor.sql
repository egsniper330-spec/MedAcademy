
-- ============================================================
-- v63: Credits System Refactor
-- Root causes fixed:
--   1. enrollments.status column missing → add with default 'active'
--   2. enrollments.activation_method missing → add (mirrors enrollment_method)
--   3. grant_course_access returned JSON error instead of raising
--   4. ledger missing balance_before / balance_after
--   5. no atomic single-RPC enroll path
-- ============================================================

-- 1. Add status + activation_method to enrollments
ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','expired','pending')),
  ADD COLUMN IF NOT EXISTS activation_method text
    GENERATED ALWAYS AS (enrollment_method) STORED;

-- Back-fill: all existing enrollments are active
UPDATE public.enrollments SET status = 'active' WHERE status IS NULL;

-- 2. Add index for doctor lookups via course join
CREATE INDEX IF NOT EXISTS idx_enrollments_course_id ON public.enrollments (course_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_student_id ON public.enrollments (student_id);

-- 3. Replace grant_course_access: now RAISEs on every failure path
--    so the JS `if (error) throw error` pattern works correctly.
CREATE OR REPLACE FUNCTION public.grant_course_access(
  p_student_id      uuid,
  p_course_id       uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doctor_id    uuid := auth.uid();
  v_credits      credits;
  v_bal_before   int;
  v_bal_after    int;
  v_tx_id        uuid;
BEGIN
  -- Idempotency: already enrolled → success (no double-deduct)
  IF EXISTS (
    SELECT 1 FROM enrollments
    WHERE student_id = p_student_id AND course_id = p_course_id
  ) THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true);
  END IF;

  -- Verify caller owns the course
  IF NOT EXISTS (
    SELECT 1 FROM courses WHERE id = p_course_id AND doctor_id = v_doctor_id
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: You do not own course %', p_course_id;
  END IF;

  -- Lock credits row for this doctor
  SELECT * INTO v_credits
  FROM credits
  WHERE doctor_id = v_doctor_id
  FOR UPDATE;

  IF v_credits IS NULL THEN
    RAISE EXCEPTION 'NO_CREDITS_RECORD: No credits record found for this doctor';
  END IF;

  IF v_credits.remaining < 1 THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: Balance is %, need 1', v_credits.remaining;
  END IF;

  v_bal_before := v_credits.remaining;
  v_bal_after  := v_credits.remaining - 1;

  -- 1. Create enrollment
  INSERT INTO enrollments (student_id, course_id, enrolled_by, enrollment_method, status)
  VALUES (p_student_id, p_course_id, v_doctor_id, 'credits', 'active');

  -- 2. Deduct credit (atomic with above)
  UPDATE credits
  SET consumed   = consumed + 1,
      remaining  = remaining - 1,
      updated_at = now()
  WHERE doctor_id = v_doctor_id;

  -- 3. Full ledger entry with balance snapshots
  INSERT INTO credit_transactions (
    doctor_id, transaction_type, amount,
    course_id, student_id, performed_by,
    notes, balance_before, balance_after
  )
  VALUES (
    v_doctor_id, 'consumption', 1,
    p_course_id, p_student_id, v_doctor_id,
    'Student enrolled via doctor credits',
    v_bal_before, v_bal_after
  )
  RETURNING id INTO v_tx_id;

  -- 4. Audit log
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
  VALUES (
    v_doctor_id, 'credit_consumed_by_doctor', 'enrollment', p_student_id,
    jsonb_build_object(
      'student_id',    p_student_id,
      'course_id',     p_course_id,
      'balance_before', v_bal_before,
      'balance_after',  v_bal_after,
      'transaction_id', v_tx_id
    )
  );

  RETURN jsonb_build_object(
    'success',        true,
    'balance_before', v_bal_before,
    'balance_after',  v_bal_after,
    'transaction_id', v_tx_id
  );
END;
$$;

-- 4. get_my_credits_balance: ensure it returns total_allocated field too
--    (dashboard reads credits?.remaining; credits page needs all three)
CREATE OR REPLACE FUNCTION public.get_my_credits_balance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row credits;
BEGIN
  SELECT * INTO v_row FROM credits WHERE doctor_id = auth.uid();
  IF v_row IS NULL THEN
    RETURN jsonb_build_object(
      'allocated', 0, 'consumed', 0, 'remaining', 0,
      'total_allocated', 0, 'used', 0
    );
  END IF;
  RETURN jsonb_build_object(
    'allocated',       v_row.allocated,
    'consumed',        v_row.consumed,
    'remaining',       v_row.remaining,
    'total_allocated', v_row.allocated,
    'used',            v_row.consumed,
    'updated_at',      v_row.updated_at
  );
END;
$$;

-- 5. get_doctor_credit_transactions — rich ledger for the calling doctor
CREATE OR REPLACE FUNCTION public.get_doctor_credit_transactions(p_limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.created_at DESC)
  INTO v_rows
  FROM (
    SELECT
      ct.id, ct.transaction_type, ct.amount,
      ct.notes, ct.balance_before, ct.balance_after,
      ct.created_at,
      c.title  AS course_title,
      p.full_name AS student_name
    FROM credit_transactions ct
    LEFT JOIN courses  c ON c.id  = ct.course_id
    LEFT JOIN profiles p ON p.id  = ct.student_id
    WHERE ct.doctor_id = auth.uid()
    ORDER BY ct.created_at DESC
    LIMIT p_limit
  ) t;
  RETURN COALESCE(v_rows, '[]'::jsonb);
END;
$$;

-- 6. RLS: ensure doctors can read their own credit_transactions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'credit_transactions'
      AND policyname = 'doctor_read_own_transactions'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY doctor_read_own_transactions ON public.credit_transactions
      FOR SELECT TO authenticated
      USING (doctor_id = auth.uid())
    $policy$;
  END IF;
END $$;

-- 7. RLS: ensure doctors can read their own credits row
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'credits'
      AND policyname = 'doctor_read_own_credits'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY doctor_read_own_credits ON public.credits
      FOR SELECT TO authenticated
      USING (doctor_id = auth.uid())
    $policy$;
  END IF;
END $$;
