
-- v56: Hard-delete cascade support
-- 1. Ensure profiles can be hard-deleted (no orphan FK blocks)
-- 2. Fraud flags may reference doctor_id → cascade or set null
-- 3. Clean up stale 'deleted' status profiles (they should have been hard-deleted)

-- ── 1. fraud_flags: doctor_id → SET NULL on profile delete ──────
ALTER TABLE fraud_flags
  DROP CONSTRAINT IF EXISTS fraud_flags_doctor_id_fkey;

ALTER TABLE fraud_flags
  ADD CONSTRAINT fraud_flags_doctor_id_fkey
  FOREIGN KEY (doctor_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- ── 2. activation_codes: used_by → SET NULL on delete ───────────
ALTER TABLE activation_codes
  DROP CONSTRAINT IF EXISTS activation_codes_used_by_fkey;

ALTER TABLE activation_codes
  ADD CONSTRAINT activation_codes_used_by_fkey
  FOREIGN KEY (used_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- ── 3. notifications: user_id → CASCADE on delete ───────────────
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_user_id_fkey;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ── 4. devices: user_id → CASCADE on delete ─────────────────────
ALTER TABLE devices
  DROP CONSTRAINT IF EXISTS devices_user_id_fkey;

ALTER TABLE devices
  ADD CONSTRAINT devices_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ── 5. enrollments: student_id → CASCADE on delete ──────────────
ALTER TABLE enrollments
  DROP CONSTRAINT IF EXISTS enrollments_student_id_fkey;

ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ── 6. credit_transactions: doctor_id → CASCADE ─────────────────
ALTER TABLE credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_doctor_id_fkey;

ALTER TABLE credit_transactions
  ADD CONSTRAINT credit_transactions_doctor_id_fkey
  FOREIGN KEY (doctor_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ── 7. credits: doctor_id → CASCADE ─────────────────────────────
ALTER TABLE credits
  DROP CONSTRAINT IF EXISTS credits_doctor_id_fkey;

ALTER TABLE credits
  ADD CONSTRAINT credits_doctor_id_fkey
  FOREIGN KEY (doctor_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ── 8. idempotency_keys: user_id → CASCADE ──────────────────────
ALTER TABLE idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_user_id_fkey;

ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ── 9. audit_logs: keep records for compliance, allow null actor ─
ALTER TABLE audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_actor_id_fkey;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- ── 10. Hard-delete helper view for admins ───────────────────────
-- Shows all profiles including deleted ones so admins can confirm
CREATE OR REPLACE VIEW admin_all_profiles AS
  SELECT * FROM profiles;

GRANT SELECT ON admin_all_profiles TO authenticated;
