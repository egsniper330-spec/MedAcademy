
-- ─────────────────────────────────────────────────────────────────────────────
-- set_enrollment_assigned_price
--
-- Allows a doctor to set/clear the per-student price override on an enrollment
-- that belongs to one of their own courses.  Uses SECURITY DEFINER to bypass
-- the enrollments_update RLS policy (which currently only covers the student
-- themselves and admins).
--
-- After updating assigned_price it immediately runs recalculate_doctor_earnings
-- so the doctor_earnings_events table reflects the new price without the doctor
-- needing to press "Recalculate" manually.
--
-- Returns:
--   { success: true,  corrections: <int>, old_price: <numeric|null>, new_price: <numeric|null> }
--   { success: false, code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'ENROLLMENT_NOT_FOUND' }
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_enrollment_assigned_price(
  p_enrollment_id uuid,
  p_price         numeric   -- NULL clears the override (falls back to course/global)
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id   uuid := auth.uid();
  v_caller_role text := (auth.jwt() ->> 'role');
  v_doctor_id   uuid;
  v_old_price   numeric;
  v_corrections int;
BEGIN
  -- ── Auth ──────────────────────────────────────────────────────────────────
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'UNAUTHENTICATED');
  END IF;

  -- ── Fetch enrollment + owning doctor ─────────────────────────────────────
  SELECT c.doctor_id, e.assigned_price
  INTO   v_doctor_id, v_old_price
  FROM   enrollments e
  JOIN   courses     c ON c.id = e.course_id
  WHERE  e.id = p_enrollment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ENROLLMENT_NOT_FOUND');
  END IF;

  -- ── Authorisation: must be the owning doctor or admin ────────────────────
  IF v_caller_id <> v_doctor_id
     AND v_caller_role NOT IN ('admin', 'super_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'FORBIDDEN');
  END IF;

  -- ── Write new price ───────────────────────────────────────────────────────
  UPDATE enrollments
  SET    assigned_price = p_price
  WHERE  id = p_enrollment_id;

  -- ── Auto-recalculate so earnings_events reflect the new price ────────────
  -- Call via the existing recalculate function (doctor_id = owning doctor)
  SELECT (recalculate_doctor_earnings(v_doctor_id) ->> 'corrections')::int
  INTO   v_corrections;

  RETURN jsonb_build_object(
    'success',     true,
    'corrections', COALESCE(v_corrections, 0),
    'old_price',   v_old_price,
    'new_price',   p_price
  );
END;
$$;

GRANT EXECUTE ON FUNCTION set_enrollment_assigned_price(uuid, numeric) TO authenticated;
