
-- ─── 1. Enhance credit_transactions ───────────────────────────
ALTER TABLE credit_transactions
  ADD COLUMN IF NOT EXISTS balance_before  integer,
  ADD COLUMN IF NOT EXISTS balance_after   integer,
  ADD COLUMN IF NOT EXISTS reason          text,
  ADD COLUMN IF NOT EXISTS audit_log_id    uuid REFERENCES audit_logs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS batch_id        uuid;

-- ─── 2. Enhance activation_codes ──────────────────────────────
ALTER TABLE activation_codes
  ADD COLUMN IF NOT EXISTS batch_id     uuid,
  ADD COLUMN IF NOT EXISTS batch_label  text,
  ADD COLUMN IF NOT EXISTS notes        text,
  ADD COLUMN IF NOT EXISTS identifier   text,
  ADD COLUMN IF NOT EXISTS device_info  text,
  ADD COLUMN IF NOT EXISTS disabled_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS disabled_at  timestamptz;

-- ─── 3. code_batches table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS code_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label          text,
  course_id      uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_by     uuid NOT NULL REFERENCES profiles(id),
  total_count    integer NOT NULL DEFAULT 0,
  used_count     integer NOT NULL DEFAULT 0,
  expired_count  integer NOT NULL DEFAULT 0,
  disabled_count integer NOT NULL DEFAULT 0,
  expires_at     timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE code_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "code_batches_admin_all" ON code_batches;
CREATE POLICY "code_batches_admin_all" ON code_batches
  FOR ALL TO authenticated USING (is_admin_or_super_admin());

-- ─── 4. Performance indexes ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_credit_tx_created      ON credit_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_type         ON credit_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_credit_tx_performed_by ON credit_transactions(performed_by);
CREATE INDEX IF NOT EXISTS idx_credit_tx_student      ON credit_transactions(student_id) WHERE student_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_tx_course       ON credit_transactions(course_id)  WHERE course_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_tx_batch        ON credit_transactions(batch_id)   WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_tx_audit        ON credit_transactions(audit_log_id) WHERE audit_log_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_codes_status           ON activation_codes(status);
CREATE INDEX IF NOT EXISTS idx_codes_created_at       ON activation_codes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_codes_used_at          ON activation_codes(used_at DESC) WHERE used_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_codes_batch_id         ON activation_codes(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_codes_used_by          ON activation_codes(used_by) WHERE used_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_codes_expires_at       ON activation_codes(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_code_batches_course    ON code_batches(course_id);
CREATE INDEX IF NOT EXISTS idx_code_batches_creator   ON code_batches(created_by);
CREATE INDEX IF NOT EXISTS idx_code_batches_created   ON code_batches(created_at DESC);

-- ─── 5. credit_ledger_view ─────────────────────────────────────
CREATE OR REPLACE VIEW credit_ledger_view AS
SELECT
  ct.id,
  ct.created_at,
  ct.transaction_type,
  ct.amount,
  ct.balance_before,
  ct.balance_after,
  ct.reason,
  ct.notes,
  ct.batch_id,
  ct.audit_log_id,
  ct.doctor_id,
  d.full_name    AS doctor_name,
  d.email        AS doctor_email,
  ct.performed_by,
  p.full_name    AS performed_by_name,
  p.role         AS performed_by_role,
  ct.student_id,
  s.full_name    AS student_name,
  ct.course_id,
  c.title        AS course_title
FROM credit_transactions ct
LEFT JOIN profiles d ON d.id = ct.doctor_id
LEFT JOIN profiles p ON p.id = ct.performed_by
LEFT JOIN profiles s ON s.id = ct.student_id
LEFT JOIN courses  c ON c.id = ct.course_id;

-- ─── 6. activation_ledger_view ─────────────────────────────────
CREATE OR REPLACE VIEW activation_ledger_view AS
SELECT
  ac.id,
  ac.code,
  ac.status,
  ac.created_at,
  ac.expires_at,
  ac.used_at,
  ac.notes,
  ac.identifier,
  ac.device_info,
  ac.batch_id,
  ac.batch_label,
  ac.disabled_at,
  ac.course_id,
  c.title        AS course_title,
  ac.created_by,
  cr.full_name   AS created_by_name,
  cr.role        AS created_by_role,
  ac.used_by,
  u.full_name    AS used_by_name,
  u.email        AS used_by_email,
  ac.disabled_by,
  db.full_name   AS disabled_by_name
FROM activation_codes ac
LEFT JOIN courses  c  ON c.id  = ac.course_id
LEFT JOIN profiles cr ON cr.id = ac.created_by
LEFT JOIN profiles u  ON u.id  = ac.used_by
LEFT JOIN profiles db ON db.id = ac.disabled_by;

-- ─── 7. doctor_credit_summary view ────────────────────────────
CREATE OR REPLACE VIEW doctor_credit_summary AS
SELECT
  p.id,
  p.full_name,
  p.email,
  COALESCE(cr.allocated,  0) AS total_received,
  COALESCE(cr.consumed,   0) AS total_used,
  COALESCE(cr.remaining,  0) AS current_balance,
  COALESCE((
    SELECT COALESCE(SUM(amount), 0)
    FROM credit_transactions
    WHERE doctor_id = p.id AND transaction_type IN ('deduction','expiry')
  ), 0) AS total_removed,
  COALESCE((
    SELECT COALESCE(SUM(amount), 0)
    FROM credit_transactions
    WHERE doctor_id = p.id AND transaction_type = 'restoration'
  ), 0) AS total_refunded
FROM profiles p
LEFT JOIN credits cr ON cr.doctor_id = p.id
WHERE p.role = 'doctor';

-- ─── 8. credit_daily_stats view ───────────────────────────────
CREATE OR REPLACE VIEW credit_daily_stats AS
SELECT
  DATE(created_at) AS day,
  transaction_type,
  COUNT(*) AS tx_count,
  SUM(amount) AS total_amount
FROM credit_transactions
GROUP BY DATE(created_at), transaction_type;

-- ─── 9. Grant SELECT on views ─────────────────────────────────
GRANT SELECT ON credit_ledger_view     TO authenticated;
GRANT SELECT ON activation_ledger_view TO authenticated;
GRANT SELECT ON doctor_credit_summary  TO authenticated;
GRANT SELECT ON credit_daily_stats     TO authenticated;

-- ─── 10. Enhanced allocate_credits with balance tracking ──────
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
  END INTO v_tx_type
  FROM profiles WHERE id = v_actor_id;
  v_tx_type := COALESCE(v_tx_type, 'grant_admin'::credit_transaction_type);

  SELECT COALESCE(remaining, 0) INTO v_bal_before
  FROM credits WHERE doctor_id = p_doctor_id;
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
    jsonb_build_object('doctor_id', p_doctor_id, 'amount', p_amount,
                       'balance_before', v_bal_before, 'balance_after', v_bal_after,
                       'notes', p_notes),
    'credits', p_doctor_id);

  RETURN jsonb_build_object('success', true, 'balance_before', v_bal_before, 'balance_after', v_bal_after);
END;
$$;

-- ─── 11. Immutability: block direct deletes on ledger ─────────
REVOKE DELETE ON credit_transactions FROM authenticated;
REVOKE UPDATE ON credit_transactions FROM authenticated;
REVOKE DELETE ON activation_codes    FROM authenticated;
