
-- ── 1. Doctor pricing on profiles ────────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS doctor_global_price   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS doctor_pricing_mode   text    NOT NULL DEFAULT 'global'
    CHECK (doctor_pricing_mode IN ('global','per_student'));

-- ── 2. Per-student price override on enrollments ─────────────────────────────
ALTER TABLE enrollments
  ADD COLUMN IF NOT EXISTS assigned_price numeric DEFAULT NULL;

-- ── 3. Extend doctor_earnings_events with transaction_type ───────────────────
ALTER TABLE doctor_earnings_events
  ADD COLUMN IF NOT EXISTS transaction_type text NOT NULL DEFAULT 'purchase'
    CHECK (transaction_type IN ('purchase','removal','suspension_refund','adjustment'));

-- Back-fill existing rows (all were credit_use = purchase)
UPDATE doctor_earnings_events SET transaction_type = 'purchase' WHERE transaction_type IS NULL OR transaction_type = 'purchase';

-- ── 4. RLS: doctors can INSERT their own earnings events ─────────────────────
DROP POLICY IF EXISTS doctor_insert_own_dee ON doctor_earnings_events;
CREATE POLICY doctor_insert_own_dee ON doctor_earnings_events
  FOR INSERT
  WITH CHECK (doctor_id = auth.uid());

-- ── 5. RLS: doctors can UPDATE (suspend/restore) their own enrollments ────────
-- Already covered by enrollments_update policy (is_doctor_or_above).
-- Nothing new needed.
