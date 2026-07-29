
-- ============================================================
-- Advanced Credit & Activation Code Management v2
-- ============================================================

-- ─── 1. credit_transactions: reference_id, expiry_date ────────
ALTER TABLE credit_transactions
  ADD COLUMN IF NOT EXISTS reference_id    uuid,
  ADD COLUMN IF NOT EXISTS expires_at      timestamptz;

-- ─── 2. fraud_flags table ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS fraud_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id     uuid REFERENCES profiles(id) ON DELETE CASCADE,
  flag_type     text NOT NULL,
  severity      text NOT NULL DEFAULT 'medium',
  details       jsonb NOT NULL DEFAULT '{}',
  resolved      boolean NOT NULL DEFAULT false,
  resolved_by   uuid REFERENCES profiles(id),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fraud_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fraud_flags_admin" ON fraud_flags;
CREATE POLICY "fraud_flags_admin" ON fraud_flags
  FOR ALL TO authenticated USING (is_admin_or_super_admin());

-- ─── 3. system_config: low_credit_threshold ───────────────────
INSERT INTO system_config (key, value)
VALUES ('low_credit_threshold', '{"amount": 10}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ─── 4. Indexes for fraud_flags ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fraud_flags_doctor   ON fraud_flags(doctor_id);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_resolved ON fraud_flags(resolved) WHERE NOT resolved;
CREATE INDEX IF NOT EXISTS idx_fraud_flags_created  ON fraud_flags(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_expires    ON credit_transactions(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_tx_reference  ON credit_transactions(reference_id) WHERE reference_id IS NOT NULL;

-- ─── 5. revoke_credits SECURITY DEFINER function ─────────────
CREATE OR REPLACE FUNCTION revoke_credits(
  p_doctor_id  uuid,
  p_amount     integer,
  p_reason     text DEFAULT '',
  p_actor_id   uuid DEFAULT NULL,
  p_reference_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id    uuid := COALESCE(p_actor_id, auth.uid());
  v_bal_before  integer;
  v_bal_after   integer;
BEGIN
  -- Lock and read current balance
  SELECT COALESCE(remaining, 0) INTO v_bal_before
  FROM credits WHERE doctor_id = p_doctor_id FOR UPDATE;

  IF v_bal_before IS NULL THEN
    RAISE EXCEPTION 'Doctor credits record not found';
  END IF;
  IF p_amount > v_bal_before THEN
    RAISE EXCEPTION 'Revoke amount (%) exceeds current balance (%)', p_amount, v_bal_before;
  END IF;

  v_bal_after := v_bal_before - p_amount;

  -- Deduct balance
  UPDATE credits SET
    remaining  = v_bal_after,
    allocated  = GREATEST(allocated - p_amount, 0),
    updated_at = now()
  WHERE doctor_id = p_doctor_id;

  -- Immutable reverse transaction (type = deduction)
  INSERT INTO credit_transactions
    (doctor_id, transaction_type, amount, performed_by, reason, notes, balance_before, balance_after, reference_id)
  VALUES
    (p_doctor_id, 'deduction', p_amount, v_actor_id, p_reason, p_reason, v_bal_before, v_bal_after, p_reference_id);

  -- Audit log
  INSERT INTO audit_logs (user_id, actor_id, action, details, resource_type, resource_id)
  VALUES (v_actor_id, v_actor_id, 'credit_allocated',
    jsonb_build_object('type','revoke','doctor_id',p_doctor_id,'amount',p_amount,
                       'reason',p_reason,'balance_before',v_bal_before,'balance_after',v_bal_after),
    'credits', p_doctor_id);

  -- Push in-app notification to doctor
  INSERT INTO notifications (user_id, title, body, notification_type)
  VALUES (p_doctor_id,
    'Credits Removed',
    format('%s credits have been removed from your account. Reason: %s. Balance: %s', p_amount, p_reason, v_bal_after),
    'system'
  );

  RETURN jsonb_build_object('success',true,'balance_before',v_bal_before,'balance_after',v_bal_after);
END;
$$;

-- ─── 6. check_low_credit_and_notify function ─────────────────
CREATE OR REPLACE FUNCTION check_low_credit_and_notify(p_doctor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance   integer;
  v_threshold integer;
BEGIN
  SELECT COALESCE(remaining, 0) INTO v_balance FROM credits WHERE doctor_id = p_doctor_id;
  SELECT COALESCE((value->>'amount')::integer, 10) INTO v_threshold
  FROM system_config WHERE key = 'low_credit_threshold';

  IF v_balance <= v_threshold THEN
    -- Avoid spam: only insert if no unread low-credit notification in last 24h
    IF NOT EXISTS (
      SELECT 1 FROM notifications
      WHERE user_id = p_doctor_id
        AND notification_type = 'system'
        AND title = 'Low Credit Balance'
        AND created_at > now() - interval '24 hours'
    ) THEN
      INSERT INTO notifications (user_id, title, body, notification_type)
      VALUES (p_doctor_id,
        'Low Credit Balance',
        format('Your credit balance is low (%s remaining). Please contact your administrator.', v_balance),
        'system'
      );
    END IF;
  END IF;
END;
$$;

-- ─── 7. Updated allocate_credits: now triggers low-credit check ─
CREATE OR REPLACE FUNCTION allocate_credits(
  p_doctor_id uuid,
  p_amount    integer,
  p_notes     text DEFAULT '',
  p_actor_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id   uuid := COALESCE(p_actor_id, auth.uid());
  v_bal_before integer;
  v_bal_after  integer;
  v_tx_type    credit_transaction_type;
BEGIN
  SELECT CASE
    WHEN role = 'super_admin' THEN 'grant_super_admin'::credit_transaction_type
    ELSE 'grant_admin'::credit_transaction_type
  END INTO v_tx_type FROM profiles WHERE id = v_actor_id;
  v_tx_type := COALESCE(v_tx_type, 'grant_admin'::credit_transaction_type);

  SELECT COALESCE(remaining, 0) INTO v_bal_before FROM credits WHERE doctor_id = p_doctor_id;
  v_bal_before := COALESCE(v_bal_before, 0);
  v_bal_after  := v_bal_before + p_amount;

  INSERT INTO credits (doctor_id, allocated, remaining)
  VALUES (p_doctor_id, p_amount, p_amount)
  ON CONFLICT (doctor_id) DO UPDATE SET
    allocated  = credits.allocated  + p_amount,
    remaining  = credits.remaining  + p_amount,
    updated_at = now();

  INSERT INTO credit_transactions
    (doctor_id, transaction_type, amount, performed_by, notes, balance_before, balance_after)
  VALUES
    (p_doctor_id, v_tx_type, p_amount, v_actor_id, p_notes, v_bal_before, v_bal_after);

  INSERT INTO audit_logs (user_id, actor_id, action, details, resource_type, resource_id)
  VALUES (v_actor_id, v_actor_id, 'credit_allocated',
    jsonb_build_object('doctor_id',p_doctor_id,'amount',p_amount,
                       'balance_before',v_bal_before,'balance_after',v_bal_after,'notes',p_notes),
    'credits', p_doctor_id);

  -- Notify doctor of credit addition
  INSERT INTO notifications (user_id, title, body, notification_type)
  VALUES (p_doctor_id,
    'Credits Added',
    format('%s credits have been added to your account. New balance: %s', p_amount, v_bal_after),
    'system'
  );

  RETURN jsonb_build_object('success',true,'balance_before',v_bal_before,'balance_after',v_bal_after);
END;
$$;

-- ─── 8. revenue_analytics view ────────────────────────────────
CREATE OR REPLACE VIEW revenue_analytics AS
WITH pricing AS (
  SELECT
    COALESCE((value->>'amount')::numeric, 10) AS credit_price,
    COALESCE((value->>'currency')::text, 'EGP') AS currency
  FROM system_config WHERE key = 'credit_price'
  LIMIT 1
),
code_pricing AS (
  SELECT COALESCE((value->>'amount')::numeric, 25) AS code_price
  FROM system_config WHERE key = 'activation_code_price'
  LIMIT 1
)
SELECT
  ct.performed_by        AS admin_id,
  p.full_name            AS admin_name,
  ct.doctor_id,
  d.full_name            AS doctor_name,
  DATE(ct.created_at)    AS day,
  DATE_TRUNC('month', ct.created_at) AS month,
  DATE_TRUNC('year',  ct.created_at) AS year,
  ct.transaction_type,
  ct.amount,
  ct.amount * pr.credit_price AS revenue,
  pr.currency
FROM credit_transactions ct
CROSS JOIN pricing pr
LEFT JOIN profiles p ON p.id = ct.performed_by
LEFT JOIN profiles d ON d.id = ct.doctor_id
WHERE ct.transaction_type IN ('grant_admin','grant_super_admin','allocation');

GRANT SELECT ON revenue_analytics TO authenticated;

-- ─── 9. fraud_detection view ──────────────────────────────────
CREATE OR REPLACE VIEW fraud_suspicious_activity AS
-- Large single allocation (> 500 credits)
SELECT 'large_allocation' AS flag_type, 'high' AS severity,
  doctor_id, performed_by, amount, created_at
FROM credit_transactions
WHERE transaction_type IN ('grant_admin','grant_super_admin','allocation')
  AND amount > 500
UNION ALL
-- Repeated reversals (> 3 deductions in 1 hour)
SELECT 'repeated_reversals' AS flag_type, 'medium' AS severity,
  doctor_id, performed_by, SUM(amount)::int AS amount, MAX(created_at) AS created_at
FROM credit_transactions
WHERE transaction_type = 'deduction'
  AND created_at > now() - interval '1 hour'
GROUP BY doctor_id, performed_by
HAVING COUNT(*) > 3
UNION ALL
-- Bulk code generation > 50 codes in 1 hour by same user
SELECT 'bulk_code_generation' AS flag_type, 'medium' AS severity,
  NULL AS doctor_id, created_by AS performed_by,
  COUNT(*)::int AS amount, MAX(created_at) AS created_at
FROM activation_codes
WHERE created_at > now() - interval '1 hour'
GROUP BY created_by
HAVING COUNT(*) > 50;

GRANT SELECT ON fraud_suspicious_activity TO authenticated;
