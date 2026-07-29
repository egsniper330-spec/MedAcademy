
-- ── 1. Add credit_selling_price to profiles ──────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS credit_selling_price numeric NOT NULL DEFAULT 0;

-- ── 2. Initialize existing doctors with the current default credit price ─────
DO $$
DECLARE
  v_default_price numeric;
BEGIN
  SELECT COALESCE((value->>'amount')::numeric, 10)
  INTO v_default_price
  FROM system_config
  WHERE key = 'credit_price'
  LIMIT 1;

  v_default_price := COALESCE(v_default_price, 10);

  UPDATE profiles
  SET credit_selling_price = v_default_price
  WHERE role = 'doctor' AND credit_selling_price = 0;
END;
$$;

-- ── 3. Drop and recreate doctor_credit_summary view with new column ──────────
DROP VIEW IF EXISTS doctor_credit_summary;

CREATE VIEW doctor_credit_summary AS
SELECT
  p.id,
  p.full_name,
  p.email,
  p.credit_selling_price,
  COALESCE(cr.allocated,  0) AS total_received,
  COALESCE(cr.consumed,   0) AS total_used,
  COALESCE(cr.remaining,  0) AS current_balance,
  COALESCE((
    SELECT COALESCE(SUM(ct.amount), 0)
    FROM credit_transactions ct
    WHERE ct.doctor_id = p.id
      AND ct.transaction_type IN ('deduction','expiry')
  ), 0) AS total_removed,
  COALESCE((
    SELECT COALESCE(SUM(ct.amount), 0)
    FROM credit_transactions ct
    WHERE ct.doctor_id = p.id
      AND ct.transaction_type = 'restoration'
  ), 0) AS total_refunded
FROM profiles p
LEFT JOIN credits cr ON cr.doctor_id = p.id
WHERE p.role = 'doctor';

-- ── 4. RPC: set_doctor_credit_price ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_doctor_credit_price(
  p_doctor_id  uuid,
  p_new_price  numeric,
  p_actor_id   uuid  DEFAULT NULL,
  p_actor_name text  DEFAULT NULL,
  p_actor_role text  DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_price   numeric;
  v_doctor_name text;
BEGIN
  SELECT credit_selling_price, full_name
  INTO v_old_price, v_doctor_name
  FROM profiles WHERE id = p_doctor_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'Doctor not found'; END IF;
  IF v_old_price = p_new_price THEN RETURN; END IF;

  UPDATE profiles
  SET credit_selling_price = p_new_price,
      updated_at = now()
  WHERE id = p_doctor_id;

  INSERT INTO audit_logs (
    user_id, actor_id, actor_name, actor_email, actor_role,
    action, target_name, resource_type, resource_id,
    description, log_status, old_values, new_values
  )
  VALUES (
    p_doctor_id,
    p_actor_id,
    p_actor_name,
    NULL,
    p_actor_role,
    'credit_price_changed',
    v_doctor_name,
    'doctor',
    p_doctor_id,
    format(
      'Credit selling price changed from %s EGP to %s EGP',
      v_old_price, p_new_price
    ),
    'success',
    jsonb_build_object('credit_selling_price', v_old_price),
    jsonb_build_object('credit_selling_price', p_new_price)
  );
END;
$$;

REVOKE ALL ON FUNCTION set_doctor_credit_price FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_doctor_credit_price TO authenticated;

-- ── 5. RPC: get_doctor_activity_stats ────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_doctor_activity_stats(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile           profiles%ROWTYPE;
  v_credits           credits%ROWTYPE;
  v_videos_uploaded   bigint := 0;
  v_courses_sold      bigint := 0;
  v_students_enrolled bigint := 0;
  v_last_login        timestamptz;
  v_last_active       timestamptz;
BEGIN
  SELECT * INTO v_profile FROM profiles WHERE id = p_doctor_id AND role = 'doctor';
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_credits FROM credits WHERE doctor_id = p_doctor_id;

  SELECT COUNT(*) INTO v_videos_uploaded
  FROM lessons l
  JOIN courses c ON c.id = l.course_id
  WHERE c.doctor_id = p_doctor_id AND l.video_url IS NOT NULL;

  SELECT COUNT(DISTINCT course_id) INTO v_courses_sold
  FROM credit_transactions
  WHERE doctor_id = p_doctor_id AND transaction_type = 'consumption';

  SELECT COUNT(*) INTO v_students_enrolled
  FROM credit_transactions
  WHERE doctor_id = p_doctor_id AND transaction_type = 'consumption';

  SELECT created_at INTO v_last_login
  FROM audit_logs
  WHERE (user_id = p_doctor_id OR actor_id = p_doctor_id) AND action::text = 'login'
  ORDER BY created_at DESC LIMIT 1;

  SELECT created_at INTO v_last_active
  FROM audit_logs
  WHERE user_id = p_doctor_id OR actor_id = p_doctor_id
  ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'credit_selling_price',  v_profile.credit_selling_price,
    'total_allocated',       COALESCE(v_credits.allocated,  0),
    'total_used',            COALESCE(v_credits.consumed,   0),
    'remaining_credits',     COALESCE(v_credits.remaining,  0),
    'total_earnings',        COALESCE(v_credits.consumed, 0) * v_profile.credit_selling_price,
    'courses_sold',          v_courses_sold,
    'students_enrolled',     v_students_enrolled,
    'videos_uploaded',       v_videos_uploaded,
    'last_login',            v_last_login,
    'last_active',           v_last_active
  );
END;
$$;

REVOKE ALL ON FUNCTION get_doctor_activity_stats FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_doctor_activity_stats TO authenticated;
