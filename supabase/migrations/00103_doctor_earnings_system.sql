
-- 1. Add earnings settings columns to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS custom_pricing_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS earnings_mode text NOT NULL DEFAULT 'credit'
    CHECK (earnings_mode IN ('credit', 'course'));

-- 2. Create doctor_earnings_events — immutable ledger (price never changes retroactively)
CREATE TABLE IF NOT EXISTS doctor_earnings_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id        uuid REFERENCES courses(id) ON DELETE SET NULL,
  student_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  event_type       text NOT NULL CHECK (event_type IN ('enrollment','credit_use','manual_adjustment')),
  pricing_mode     text NOT NULL CHECK (pricing_mode IN ('platform','credit','course')),
  price_snapshot   numeric(12,2) NOT NULL DEFAULT 0,
  earnings_amount  numeric(12,2) NOT NULL DEFAULT 0,
  notes            text,
  created_at       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dee_doctor    ON doctor_earnings_events(doctor_id);
CREATE INDEX IF NOT EXISTS idx_dee_course    ON doctor_earnings_events(course_id);
CREATE INDEX IF NOT EXISTS idx_dee_created   ON doctor_earnings_events(doctor_id, created_at DESC);

-- RLS
ALTER TABLE doctor_earnings_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_dee" ON doctor_earnings_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "doctor_read_own_dee" ON doctor_earnings_events
  FOR SELECT TO authenticated
  USING (
    doctor_id = auth.uid() OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin'))
  );

-- 3. Pricing change history table
CREATE TABLE IF NOT EXISTS doctor_pricing_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  changed_by  uuid NOT NULL REFERENCES profiles(id),
  field_name  text NOT NULL,   -- 'custom_pricing_enabled' | 'earnings_mode' | 'credit_selling_price' | 'course_price:{course_id}'
  old_value   text,
  new_value   text,
  created_at  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dph_doctor ON doctor_pricing_history(doctor_id, created_at DESC);

ALTER TABLE doctor_pricing_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_dph" ON doctor_pricing_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "admin_read_dph" ON doctor_pricing_history
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin')));

-- 4. RPC: set_doctor_earnings_settings
CREATE OR REPLACE FUNCTION set_doctor_earnings_settings(
  p_doctor_id           uuid,
  p_custom_enabled      boolean,
  p_earnings_mode       text DEFAULT 'credit'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_old_enabled boolean;
  v_old_mode    text;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('admin','super_admin') THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  IF p_earnings_mode NOT IN ('credit','course') THEN
    RAISE EXCEPTION 'Invalid earnings_mode: must be credit or course';
  END IF;

  SELECT custom_pricing_enabled, earnings_mode
  INTO v_old_enabled, v_old_mode
  FROM profiles WHERE id = p_doctor_id;

  UPDATE profiles
  SET custom_pricing_enabled = p_custom_enabled,
      earnings_mode = p_earnings_mode,
      updated_at = now()
  WHERE id = p_doctor_id;

  -- Record pricing history
  IF v_old_enabled IS DISTINCT FROM p_custom_enabled THEN
    INSERT INTO doctor_pricing_history(doctor_id, changed_by, field_name, old_value, new_value)
    VALUES (p_doctor_id, auth.uid(), 'custom_pricing_enabled',
            v_old_enabled::text, p_custom_enabled::text);
  END IF;
  IF v_old_mode IS DISTINCT FROM p_earnings_mode THEN
    INSERT INTO doctor_pricing_history(doctor_id, changed_by, field_name, old_value, new_value)
    VALUES (p_doctor_id, auth.uid(), 'earnings_mode', v_old_mode, p_earnings_mode);
  END IF;

  -- Audit log
  INSERT INTO audit_logs(actor_id, action, target_id, target_type, description)
  VALUES (auth.uid(), 'update_earnings_settings', p_doctor_id, 'profile',
          format('custom_pricing=%s earnings_mode=%s', p_custom_enabled, p_earnings_mode));

  RETURN jsonb_build_object('success', true);
END;
$$;

-- 5. RPC: set_doctor_course_price
CREATE OR REPLACE FUNCTION set_doctor_course_price(
  p_course_id  uuid,
  p_price      numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_doctor_id   uuid;
  v_old_price   numeric;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('admin','super_admin','doctor') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT doctor_id, price_egp INTO v_doctor_id, v_old_price FROM courses WHERE id = p_course_id;

  -- Doctors can only edit their own courses
  IF v_caller_role = 'doctor' AND v_doctor_id != auth.uid() THEN
    RAISE EXCEPTION 'Forbidden: not your course';
  END IF;

  IF p_price < 0 THEN RAISE EXCEPTION 'Price cannot be negative'; END IF;

  UPDATE courses SET price_egp = p_price, updated_at = now() WHERE id = p_course_id;

  INSERT INTO doctor_pricing_history(doctor_id, changed_by, field_name, old_value, new_value)
  VALUES (v_doctor_id, auth.uid(),
          'course_price:' || p_course_id::text,
          v_old_price::text, p_price::text);

  INSERT INTO audit_logs(actor_id, action, target_id, target_type, description)
  VALUES (auth.uid(), 'update_course_price', p_course_id, 'course',
          format('old=%s new=%s', v_old_price, p_price));

  RETURN jsonb_build_object('success', true, 'old_price', v_old_price, 'new_price', p_price);
END;
$$;

-- 6. RPC: get_doctor_earnings_dashboard
CREATE OR REPLACE FUNCTION get_doctor_earnings_dashboard(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role        text;
  v_custom_enabled     boolean;
  v_earnings_mode      text;
  v_credit_price       numeric;
  v_total_earnings     numeric := 0;
  v_monthly_earnings   numeric := 0;
  v_today_earnings     numeric := 0;
  v_total_enrollments  bigint  := 0;
  v_paid_courses       bigint  := 0;
  v_avg_course_price   numeric := 0;
  v_per_course         jsonb   := '[]'::jsonb;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('admin','super_admin','doctor') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF v_caller_role = 'doctor' AND p_doctor_id != auth.uid() THEN
    RAISE EXCEPTION 'Forbidden: not your profile';
  END IF;

  SELECT custom_pricing_enabled, earnings_mode, credit_selling_price
  INTO v_custom_enabled, v_earnings_mode, v_credit_price
  FROM profiles WHERE id = p_doctor_id;

  -- Aggregate from doctor_earnings_events (immutable ledger)
  SELECT
    COALESCE(SUM(earnings_amount), 0),
    COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', now()) THEN earnings_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN created_at >= date_trunc('day',   now()) THEN earnings_amount ELSE 0 END), 0),
    COUNT(*)
  INTO v_total_earnings, v_monthly_earnings, v_today_earnings, v_total_enrollments
  FROM doctor_earnings_events
  WHERE doctor_id = p_doctor_id AND event_type IN ('enrollment','credit_use');

  -- Per-course breakdown from earnings events
  SELECT jsonb_agg(row_to_json(t))
  INTO v_per_course
  FROM (
    SELECT
      c.id           AS course_id,
      c.title        AS course_title,
      c.price_egp    AS current_price,
      COUNT(dee.id)  AS enrollment_count,
      COALESCE(SUM(dee.earnings_amount), 0) AS course_revenue,
      COALESCE(AVG(dee.price_snapshot), c.price_egp) AS avg_price_at_sale
    FROM courses c
    LEFT JOIN doctor_earnings_events dee
      ON dee.course_id = c.id AND dee.doctor_id = p_doctor_id
         AND dee.event_type IN ('enrollment','credit_use')
    WHERE c.doctor_id = p_doctor_id
      AND c.permanently_deleted = false
    GROUP BY c.id, c.title, c.price_egp
    ORDER BY course_revenue DESC
  ) t;

  -- Count paid courses (price_egp > 0)
  SELECT COUNT(*) INTO v_paid_courses
  FROM courses
  WHERE doctor_id = p_doctor_id AND price_egp > 0 AND permanently_deleted = false;

  -- Avg course price
  SELECT COALESCE(AVG(price_egp), 0) INTO v_avg_course_price
  FROM courses
  WHERE doctor_id = p_doctor_id AND price_egp > 0 AND permanently_deleted = false;

  RETURN jsonb_build_object(
    'custom_pricing_enabled', v_custom_enabled,
    'earnings_mode',          v_earnings_mode,
    'credit_selling_price',   v_credit_price,
    'total_earnings',         v_total_earnings,
    'monthly_earnings',       v_monthly_earnings,
    'today_earnings',         v_today_earnings,
    'total_enrollments',      v_total_enrollments,
    'paid_courses_count',     v_paid_courses,
    'avg_course_price',       v_avg_course_price,
    'per_course',             COALESCE(v_per_course, '[]'::jsonb)
  );
END;
$$;

-- 7. RPC: get_doctor_pricing_history
CREATE OR REPLACE FUNCTION get_doctor_pricing_history(
  p_doctor_id uuid,
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  id          uuid,
  field_name  text,
  old_value   text,
  new_value   text,
  changed_by  uuid,
  changer_name text,
  created_at  timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_caller_role text;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('admin','super_admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  RETURN QUERY
    SELECT
      dph.id, dph.field_name, dph.old_value, dph.new_value,
      dph.changed_by, p.full_name, dph.created_at
    FROM doctor_pricing_history dph
    LEFT JOIN profiles p ON p.id = dph.changed_by
    WHERE dph.doctor_id = p_doctor_id
    ORDER BY dph.created_at DESC
    LIMIT p_limit;
END;
$$;
