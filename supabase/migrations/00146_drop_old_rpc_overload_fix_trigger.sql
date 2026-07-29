
-- 1. Drop the old 5-parameter overload that accepts p_deduct_amount.
--    This was the one being called when client sends 4 params (Postgres matched wrong sig).
DROP FUNCTION IF EXISTS remove_student_and_record_earnings(uuid, uuid, numeric, text, text);

-- 2. Fix the account_deletion trigger function:
--    Previously filtered WHERE transaction_type = 'purchase' — this ignores prior
--    removal events, so if a student was removed then re-added, the net could be wrong.
--    Correct: sum ALL earnings_amount (already signed) to get true net per doctor+course.
CREATE OR REPLACE FUNCTION trg_deduct_earnings_on_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  -- Only fire when status transitions TO 'trashed' for the first time
  IF NEW.status <> 'trashed' OR OLD.status = 'trashed' THEN
    RETURN NEW;
  END IF;

  -- For each doctor+course with a net positive balance from this student,
  -- insert one negative account_deletion event.
  -- Sum ALL earnings_amount (signed) — not just purchases — to get true net.
  FOR r IN
    SELECT
      dee.doctor_id,
      dee.course_id,
      dee.course_name_snapshot,
      SUM(dee.earnings_amount) AS net_amount
    FROM doctor_earnings_events dee
    WHERE dee.student_id = NEW.id
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
      -r.net_amount,
      'account_deletion',
      COALESCE(NEW.full_name, 'Deleted Account'),
      r.course_name_snapshot,
      'Student account deleted'
    );
  END LOOP;

  RETURN NEW;
END;
$$;

-- 3. Verify only one overload remains
SELECT p.proname, pg_get_function_arguments(p.oid) AS args
FROM pg_proc p
WHERE p.proname = 'remove_student_and_record_earnings';
