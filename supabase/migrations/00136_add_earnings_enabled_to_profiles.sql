
-- Add earnings system toggle to doctor profiles
-- DEFAULT false: earnings system is OFF until the doctor explicitly enables it
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS earnings_enabled boolean NOT NULL DEFAULT false;

-- Create index for quick lookup (admin views filtering doctors with earnings on)
CREATE INDEX IF NOT EXISTS idx_profiles_earnings_enabled
  ON profiles(earnings_enabled)
  WHERE role = 'doctor';

-- Create doctor_earnings_transactions table if it doesn't exist
-- This stores per-student-enrollment revenue events
CREATE TABLE IF NOT EXISTS doctor_earnings_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id       uuid REFERENCES courses(id) ON DELETE SET NULL,
  student_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  amount_egp      numeric(12,2) NOT NULL DEFAULT 0,
  transaction_type text NOT NULL DEFAULT 'enrollment', -- enrollment | refund | adjustment
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_det_doctor_id   ON doctor_earnings_transactions(doctor_id);
CREATE INDEX IF NOT EXISTS idx_det_course_id   ON doctor_earnings_transactions(course_id);
CREATE INDEX IF NOT EXISTS idx_det_created_at  ON doctor_earnings_transactions(created_at DESC);

-- Payout requests
CREATE TABLE IF NOT EXISTS doctor_payout_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount_egp      numeric(12,2) NOT NULL,
  status          text NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid
  method          text,   -- bank_transfer | instapay | vodafone_cash | etc.
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dpr_doctor_id ON doctor_payout_requests(doctor_id);

-- RLS: doctors can see their own data only
ALTER TABLE doctor_earnings_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_payout_requests       ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- earnings transactions: doctor reads own rows; admins/superadmins read all
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='doctor_earnings_transactions' AND policyname='det_doctor_own') THEN
    CREATE POLICY det_doctor_own ON doctor_earnings_transactions
      FOR SELECT USING (doctor_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='doctor_earnings_transactions' AND policyname='det_admin_all') THEN
    CREATE POLICY det_admin_all ON doctor_earnings_transactions
      FOR ALL USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin'))
      );
  END IF;

  -- payout requests: doctor reads/inserts own; admins manage all
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='doctor_payout_requests' AND policyname='dpr_doctor_own') THEN
    CREATE POLICY dpr_doctor_own ON doctor_payout_requests
      FOR SELECT USING (doctor_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='doctor_payout_requests' AND policyname='dpr_doctor_insert') THEN
    CREATE POLICY dpr_doctor_insert ON doctor_payout_requests
      FOR INSERT WITH CHECK (doctor_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='doctor_payout_requests' AND policyname='dpr_admin_all') THEN
    CREATE POLICY dpr_admin_all ON doctor_payout_requests
      FOR ALL USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin'))
      );
  END IF;
END $$;
