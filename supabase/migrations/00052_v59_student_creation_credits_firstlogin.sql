
-- ── v59: Doctor-created students, force password change, atomic credit grant ──

-- 1. Add force_password_change + created_by_doctor to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS force_password_change boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by_doctor_id  uuid REFERENCES profiles(id) ON DELETE SET NULL;

-- 2. Add bulk_import_jobs table for tracking async bulk imports
CREATE TABLE IF NOT EXISTS bulk_import_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  total         integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  failed_count  integer NOT NULL DEFAULT 0,
  credits_used  integer NOT NULL DEFAULT 0,
  rows          jsonb    NOT NULL DEFAULT '[]'::jsonb,
  errors        jsonb    NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

ALTER TABLE bulk_import_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bulk_import_jobs_doctor_own" ON bulk_import_jobs
  FOR ALL TO authenticated
  USING  (doctor_id = auth.uid())
  WITH CHECK (doctor_id = auth.uid());

-- 3. Extend audit_log action enum to include new events
-- (Postgres enums require ALTER TYPE; we add only new values)
DO $$
BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'student_created_by_doctor';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'student_bulk_imported';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'course_assigned_by_doctor';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'credit_consumed_by_doctor';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'temp_password_generated';
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'password_changed_first_login';
EXCEPTION WHEN others THEN NULL;
END$$;

-- 4. Upgrade grant_course_access to use enrollment_method column if present,
--    and ensure the audit log uses the new action types.
CREATE OR REPLACE FUNCTION grant_course_access(
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
  v_doctor_id uuid := auth.uid();
  v_credits   credits;
BEGIN
  -- Idempotency: if already enrolled, return success silently
  IF p_idempotency_key IS NOT NULL AND
     EXISTS(SELECT 1 FROM enrollments WHERE student_id = p_student_id AND course_id = p_course_id) THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true);
  END IF;

  -- Verify caller owns the course
  IF NOT EXISTS(SELECT 1 FROM courses WHERE id = p_course_id AND doctor_id = v_doctor_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized for this course');
  END IF;

  -- Check credits
  SELECT * INTO v_credits FROM credits WHERE doctor_id = v_doctor_id;
  IF v_credits IS NULL OR v_credits.remaining < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient credits');
  END IF;

  -- Guard duplicate enrollment
  IF EXISTS(SELECT 1 FROM enrollments WHERE student_id = p_student_id AND course_id = p_course_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Student already enrolled');
  END IF;

  -- 1. Enroll
  INSERT INTO enrollments (student_id, course_id, enrolled_by, enrollment_method)
  VALUES (p_student_id, p_course_id, v_doctor_id, 'credits')
  ON CONFLICT DO NOTHING;

  -- 2. Deduct credit
  UPDATE credits
  SET consumed   = consumed   + 1,
      remaining  = remaining  - 1,
      updated_at = now()
  WHERE doctor_id = v_doctor_id;

  -- 3. Ledger entry
  INSERT INTO credit_transactions (doctor_id, transaction_type, amount, course_id, student_id, performed_by)
  VALUES (v_doctor_id, 'consumption', 1, p_course_id, p_student_id, v_doctor_id);

  -- 4. Audit
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
  VALUES (v_doctor_id, 'credit_consumed_by_doctor', 'enrollment',
          p_student_id,
          jsonb_build_object('student_id', p_student_id, 'course_id', p_course_id));

  RETURN jsonb_build_object('success', true);
END;
$$;

-- 5. RPC: get_my_credits_balance — lightweight live balance fetch (any authenticated user)
CREATE OR REPLACE FUNCTION get_my_credits_balance()
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
    RETURN jsonb_build_object('allocated', 0, 'consumed', 0, 'remaining', 0);
  END IF;
  RETURN jsonb_build_object(
    'allocated',  v_row.allocated,
    'consumed',   v_row.consumed,
    'remaining',  v_row.remaining,
    'updated_at', v_row.updated_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_my_credits_balance() TO authenticated;

-- 6. enrollments table: add enrolled_by + enrollment_method if not present
ALTER TABLE enrollments
  ADD COLUMN IF NOT EXISTS enrolled_by        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS enrollment_method  text NOT NULL DEFAULT 'activation_code'
    CHECK (enrollment_method IN ('activation_code','credits','admin','doctor_created'));
