
-- ── Expand pricing_mode constraint to include 'doctor_independent' ────────────
ALTER TABLE doctor_earnings_events
  DROP CONSTRAINT IF EXISTS doctor_earnings_events_pricing_mode_check;

ALTER TABLE doctor_earnings_events
  ADD CONSTRAINT doctor_earnings_events_pricing_mode_check
  CHECK (pricing_mode = ANY (ARRAY[
    'platform'::text,
    'credit'::text,
    'course'::text,
    'doctor_independent'::text
  ]));

-- ══════════════════════════════════════════════════════════════════════════════
-- Rewrite earnings trigger: use doctor's OWN pricing — NEVER platform credit price
--
-- Priority chain per enrollment:
--   1. enrollments.assigned_price       (per-student override)
--   2. courses.doctor_revenue_price     (per-course override)
--   3. profiles.doctor_global_price     (doctor's global default)
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION trg_record_earnings_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doctor_global_price  numeric := 0;
  v_course_revenue_price numeric;
  v_assigned_price       numeric;
  v_resolved_price       numeric := 0;
  v_student_name         text    := NULL;
  v_course_name          text    := NULL;
BEGIN
  IF NEW.transaction_type <> 'consumption' THEN RETURN NEW; END IF;
  IF NEW.doctor_id IS NULL THEN RETURN NEW; END IF;

  -- 1. Doctor global price
  SELECT COALESCE(doctor_global_price, 0)
    INTO v_doctor_global_price
    FROM profiles WHERE id = NEW.doctor_id;

  -- 2. Per-course revenue override
  IF NEW.course_id IS NOT NULL THEN
    SELECT doctor_revenue_price, title
      INTO v_course_revenue_price, v_course_name
      FROM courses WHERE id = NEW.course_id;
  END IF;

  -- 3. Per-student assigned_price from enrollment row just inserted
  IF NEW.course_id IS NOT NULL AND NEW.student_id IS NOT NULL THEN
    SELECT assigned_price INTO v_assigned_price
      FROM enrollments
     WHERE course_id = NEW.course_id AND student_id = NEW.student_id
     ORDER BY enrolled_at DESC LIMIT 1;
  END IF;

  -- 4. Resolve: per-student → per-course → global  (platform price NEVER used)
  v_resolved_price := COALESCE(v_assigned_price, v_course_revenue_price, v_doctor_global_price, 0);

  -- 5. Student name snapshot
  IF NEW.student_id IS NOT NULL THEN
    SELECT full_name INTO v_student_name FROM profiles WHERE id = NEW.student_id;
  END IF;

  INSERT INTO doctor_earnings_events(
    doctor_id, course_id, student_id,
    event_type, pricing_mode, price_snapshot, earnings_amount,
    transaction_type, student_name_snapshot, course_name_snapshot
  ) VALUES (
    NEW.doctor_id, NEW.course_id, NEW.student_id,
    'credit_use', 'doctor_independent', v_resolved_price, v_resolved_price,
    'purchase', v_student_name, v_course_name
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_earnings_on_consumption ON credit_transactions;
CREATE TRIGGER trg_earnings_on_consumption
  AFTER INSERT ON credit_transactions
  FOR EACH ROW EXECUTE FUNCTION trg_record_earnings_event();

-- ══════════════════════════════════════════════════════════════════════════════
-- Backfill existing rows that used platform/credit/course (old system)
-- Re-resolve each row using the doctor's current independent pricing.
-- Rows already at doctor_independent are untouched.
-- ══════════════════════════════════════════════════════════════════════════════
UPDATE doctor_earnings_events dee
SET
  earnings_amount = COALESCE(
    (SELECT e.assigned_price      FROM enrollments e WHERE e.course_id = dee.course_id AND e.student_id = dee.student_id LIMIT 1),
    (SELECT c.doctor_revenue_price FROM courses c    WHERE c.id = dee.course_id),
    (SELECT p.doctor_global_price  FROM profiles p   WHERE p.id = dee.doctor_id),
    0
  ),
  price_snapshot = COALESCE(
    (SELECT e.assigned_price      FROM enrollments e WHERE e.course_id = dee.course_id AND e.student_id = dee.student_id LIMIT 1),
    (SELECT c.doctor_revenue_price FROM courses c    WHERE c.id = dee.course_id),
    (SELECT p.doctor_global_price  FROM profiles p   WHERE p.id = dee.doctor_id),
    0
  ),
  pricing_mode          = 'doctor_independent',
  student_name_snapshot = COALESCE(dee.student_name_snapshot, (SELECT p.full_name FROM profiles p WHERE p.id = dee.student_id)),
  course_name_snapshot  = COALESCE(dee.course_name_snapshot,  (SELECT c.title    FROM courses c  WHERE c.id = dee.course_id))
WHERE dee.pricing_mode IN ('platform', 'credit', 'course');
