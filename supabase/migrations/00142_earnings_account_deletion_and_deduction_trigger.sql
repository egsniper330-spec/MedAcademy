
-- ── 1. Expand transaction_type to include 'account_deletion' ─────────────────
ALTER TABLE doctor_earnings_events
  DROP CONSTRAINT IF EXISTS doctor_earnings_events_transaction_type_check;

ALTER TABLE doctor_earnings_events
  ADD CONSTRAINT doctor_earnings_events_transaction_type_check
  CHECK (transaction_type = ANY (ARRAY[
    'purchase'::text,
    'removal'::text,
    'suspension_refund'::text,
    'adjustment'::text,
    'account_deletion'::text
  ]));

-- ── 2. Trigger: when a student profile is trashed, deduct all their earnings ──
-- Fires AFTER UPDATE on profiles when status changes TO 'trashed'.
-- For every doctor who has POSITIVE purchase earnings from this student,
-- inserts a matching negative 'account_deletion' event.
CREATE OR REPLACE FUNCTION trg_deduct_earnings_on_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  -- Only fire when status changes to 'trashed'
  IF NEW.status <> 'trashed' OR OLD.status = 'trashed' THEN
    RETURN NEW;
  END IF;

  -- For each doctor that has net positive earnings from this student,
  -- insert a negative account_deletion event per doctor+course combination.
  FOR r IN
    SELECT
      dee.doctor_id,
      dee.course_id,
      dee.course_name_snapshot,
      SUM(dee.earnings_amount) AS net_amount
    FROM doctor_earnings_events dee
    WHERE dee.student_id = NEW.id
      AND dee.transaction_type = 'purchase'
    GROUP BY dee.doctor_id, dee.course_id, dee.course_name_snapshot
    HAVING SUM(dee.earnings_amount) > 0
  LOOP
    INSERT INTO doctor_earnings_events(
      doctor_id, course_id, student_id,
      event_type, pricing_mode, price_snapshot, earnings_amount,
      transaction_type,
      student_name_snapshot, course_name_snapshot,
      notes
    ) VALUES (
      r.doctor_id,
      r.course_id,
      NEW.id,
      'credit_use',
      'doctor_independent',
      r.net_amount,
      -r.net_amount,          -- negative deduction
      'account_deletion',
      COALESCE(NEW.full_name, 'Deleted Account'),
      r.course_name_snapshot,
      'Student account deleted'
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_earnings_on_account_deletion ON profiles;
CREATE TRIGGER trg_earnings_on_account_deletion
  AFTER UPDATE OF status ON profiles
  FOR EACH ROW EXECUTE FUNCTION trg_deduct_earnings_on_account_deletion();
