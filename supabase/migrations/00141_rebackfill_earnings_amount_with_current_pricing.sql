
-- ══════════════════════════════════════════════════════════════════════════════
-- Re-backfill earnings_amount for ALL purchase rows where earnings_amount = 0
-- and pricing_mode = 'doctor_independent'.
--
-- This fixes rows that were backfilled when doctor_global_price was still 0.
-- Uses the SAME priority chain as the live trigger:
--   1. enrollments.assigned_price      (per-student override)
--   2. courses.doctor_revenue_price    (per-course override)
--   3. profiles.doctor_global_price    (doctor's global default)
--
-- Removal rows (transaction_type = 'removal') are intentionally excluded —
-- their negative amounts are derived from the matching purchase amounts and
-- are handled separately (their absolute amount mirrors the purchase).
-- ══════════════════════════════════════════════════════════════════════════════

UPDATE doctor_earnings_events dee
SET
  earnings_amount = COALESCE(
    -- 1. per-student assigned_price
    (SELECT e.assigned_price
       FROM enrollments e
      WHERE e.course_id  = dee.course_id
        AND e.student_id = dee.student_id
      LIMIT 1),
    -- 2. per-course doctor_revenue_price
    (SELECT c.doctor_revenue_price
       FROM courses c
      WHERE c.id = dee.course_id),
    -- 3. doctor's global default
    (SELECT p.doctor_global_price
       FROM profiles p
      WHERE p.id = dee.doctor_id),
    0
  ),
  price_snapshot = COALESCE(
    (SELECT e.assigned_price
       FROM enrollments e
      WHERE e.course_id  = dee.course_id
        AND e.student_id = dee.student_id
      LIMIT 1),
    (SELECT c.doctor_revenue_price
       FROM courses c
      WHERE c.id = dee.course_id),
    (SELECT p.doctor_global_price
       FROM profiles p
      WHERE p.id = dee.doctor_id),
    0
  )
WHERE dee.transaction_type = 'purchase'
  AND dee.earnings_amount  = 0
  AND dee.pricing_mode     = 'doctor_independent';

-- Also fix removal rows: their deductAmount should mirror the purchase amount for
-- the same student+course (negative sign).
UPDATE doctor_earnings_events rem
SET
  earnings_amount = -ABS(COALESCE(
    (SELECT e.assigned_price
       FROM enrollments e
      WHERE e.course_id  = rem.course_id
        AND e.student_id = rem.student_id
      LIMIT 1),
    (SELECT c.doctor_revenue_price
       FROM courses c
      WHERE c.id = rem.course_id),
    (SELECT p.doctor_global_price
       FROM profiles p
      WHERE p.id = rem.doctor_id),
    0
  )),
  price_snapshot = COALESCE(
    (SELECT e.assigned_price
       FROM enrollments e
      WHERE e.course_id  = rem.course_id
        AND e.student_id = rem.student_id
      LIMIT 1),
    (SELECT c.doctor_revenue_price
       FROM courses c
      WHERE c.id = rem.course_id),
    (SELECT p.doctor_global_price
       FROM profiles p
      WHERE p.id = rem.doctor_id),
    0
  )
WHERE rem.transaction_type = 'removal'
  AND rem.earnings_amount  = 0
  AND rem.pricing_mode     = 'doctor_independent';
