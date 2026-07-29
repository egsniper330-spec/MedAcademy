
-- 1. Fix get_doctor_activity_stats — robust version that never returns zeros
--    unless data is genuinely absent
CREATE OR REPLACE FUNCTION get_doctor_activity_stats(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile           profiles%ROWTYPE;
  v_allocated         numeric := 0;
  v_consumed          numeric := 0;
  v_remaining         numeric := 0;
  v_videos_uploaded   bigint  := 0;
  v_courses_sold      bigint  := 0;
  v_students_enrolled bigint  := 0;
  v_last_login        timestamptz;
  v_last_active       timestamptz;
BEGIN
  SELECT * INTO v_profile FROM profiles WHERE id = p_doctor_id AND role = 'doctor';
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Credits: sum directly from credit_transactions to avoid missing credits-row edge-case
  SELECT
    COALESCE(SUM(CASE WHEN transaction_type IN ('allocation','grant_admin','grant_super_admin') THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN transaction_type = 'consumption' THEN amount ELSE 0 END), 0)
  INTO v_allocated, v_consumed
  FROM credit_transactions
  WHERE doctor_id = p_doctor_id;

  v_remaining := GREATEST(v_allocated - v_consumed, 0);

  -- Videos
  SELECT COUNT(*)
  INTO v_videos_uploaded
  FROM lessons l
  JOIN courses c ON c.id = l.course_id
  WHERE c.doctor_id = p_doctor_id
    AND c.permanently_deleted = false
    AND l.video_url IS NOT NULL;

  -- Courses sold (distinct courses with at least 1 consumption)
  SELECT COUNT(DISTINCT course_id)
  INTO v_courses_sold
  FROM credit_transactions
  WHERE doctor_id = p_doctor_id AND transaction_type = 'consumption';

  -- Students enrolled (distinct students)
  SELECT COUNT(DISTINCT student_id)
  INTO v_students_enrolled
  FROM credit_transactions
  WHERE doctor_id = p_doctor_id AND transaction_type = 'consumption'
    AND student_id IS NOT NULL;

  -- Last login
  SELECT created_at INTO v_last_login
  FROM audit_logs
  WHERE (user_id = p_doctor_id OR actor_id = p_doctor_id)
    AND action::text = 'login'
  ORDER BY created_at DESC LIMIT 1;

  -- Last active (any event)
  SELECT created_at INTO v_last_active
  FROM audit_logs
  WHERE user_id = p_doctor_id OR actor_id = p_doctor_id
  ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'credit_selling_price',  COALESCE(v_profile.credit_selling_price, 0),
    'total_allocated',       v_allocated,
    'total_used',            v_consumed,
    'remaining_credits',     v_remaining,
    'total_earnings',        v_consumed * COALESCE(v_profile.credit_selling_price, 0),
    'courses_sold',          v_courses_sold,
    'students_enrolled',     v_students_enrolled,
    'videos_uploaded',       v_videos_uploaded,
    'last_login',            v_last_login,
    'last_active',           v_last_active
  );
END;
$$;


-- 2. Trigger: auto-record doctor_earnings_events on credit consumption
--    This is the critical missing piece — captures price at purchase time
CREATE OR REPLACE FUNCTION trg_record_earnings_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doctor       profiles%ROWTYPE;
  v_pricing_mode text;
  v_price        numeric := 0;
  v_earnings     numeric := 0;
  v_sys_price    numeric := 0;
BEGIN
  -- Only fire on consumption events
  IF NEW.transaction_type <> 'consumption' THEN
    RETURN NEW;
  END IF;
  IF NEW.doctor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_doctor FROM profiles WHERE id = NEW.doctor_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Determine pricing mode
  IF v_doctor.custom_pricing_enabled THEN
    IF v_doctor.earnings_mode = 'course' AND NEW.course_id IS NOT NULL THEN
      -- Course-based: use course's price_egp
      SELECT COALESCE(price_egp, 0) INTO v_price
      FROM courses WHERE id = NEW.course_id;
      v_pricing_mode := 'course';
    ELSE
      -- Credit-based: use doctor's own credit_selling_price
      v_price        := COALESCE(v_doctor.credit_selling_price, 0);
      v_pricing_mode := 'credit';
    END IF;
  ELSE
    -- Platform pricing: read from system_config
    SELECT COALESCE((value->>'amount')::numeric, 0) INTO v_sys_price
    FROM system_config WHERE key = 'credit_price' LIMIT 1;
    v_price        := v_sys_price;
    v_pricing_mode := 'platform';
  END IF;

  -- Earnings per consumption event = credits_consumed × price
  v_earnings := NEW.amount * v_price;

  INSERT INTO doctor_earnings_events(
    doctor_id, course_id, student_id,
    event_type, pricing_mode, price_snapshot, earnings_amount
  ) VALUES (
    NEW.doctor_id, NEW.course_id, NEW.student_id,
    'credit_use', v_pricing_mode, v_price, v_earnings
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_earnings_on_consumption ON credit_transactions;
CREATE TRIGGER trg_earnings_on_consumption
  AFTER INSERT ON credit_transactions
  FOR EACH ROW EXECUTE FUNCTION trg_record_earnings_event();


-- 3. Backfill existing consumption transactions into doctor_earnings_events
--    (skips rows already present)
INSERT INTO doctor_earnings_events(
  doctor_id, course_id, student_id,
  event_type, pricing_mode, price_snapshot, earnings_amount, created_at
)
SELECT
  ct.doctor_id,
  ct.course_id,
  ct.student_id,
  'credit_use',
  CASE
    WHEN p.custom_pricing_enabled AND p.earnings_mode = 'course' THEN 'course'
    WHEN p.custom_pricing_enabled THEN 'credit'
    ELSE 'platform'
  END,
  CASE
    WHEN p.custom_pricing_enabled AND p.earnings_mode = 'course'
      THEN COALESCE((SELECT price_egp FROM courses WHERE id = ct.course_id), 0)
    WHEN p.custom_pricing_enabled
      THEN COALESCE(p.credit_selling_price, 0)
    ELSE COALESCE((
      SELECT (value->>'amount')::numeric FROM system_config WHERE key = 'credit_price' LIMIT 1
    ), 0)
  END,
  ct.amount * CASE
    WHEN p.custom_pricing_enabled AND p.earnings_mode = 'course'
      THEN COALESCE((SELECT price_egp FROM courses WHERE id = ct.course_id), 0)
    WHEN p.custom_pricing_enabled
      THEN COALESCE(p.credit_selling_price, 0)
    ELSE COALESCE((
      SELECT (value->>'amount')::numeric FROM system_config WHERE key = 'credit_price' LIMIT 1
    ), 0)
  END,
  ct.created_at
FROM credit_transactions ct
JOIN profiles p ON p.id = ct.doctor_id
WHERE ct.transaction_type = 'consumption'
  AND ct.doctor_id IS NOT NULL
ON CONFLICT DO NOTHING;


-- 4. Fix get_doctor_earnings_dashboard to also fall back to credit_transactions
--    when doctor_earnings_events is empty (new doctors before first enrollment)
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

  -- Per-course breakdown
  SELECT jsonb_agg(row_to_json(t) ORDER BY (row_to_json(t)->>'course_revenue')::numeric DESC)
  INTO v_per_course
  FROM (
    SELECT
      c.id                                                        AS course_id,
      c.title                                                     AS course_title,
      COALESCE(c.price_egp, 0)                                   AS current_price,
      COUNT(dee.id)                                               AS enrollment_count,
      COALESCE(SUM(dee.earnings_amount), 0)                      AS course_revenue,
      COALESCE(AVG(dee.price_snapshot), COALESCE(c.price_egp,0)) AS avg_price_at_sale
    FROM courses c
    LEFT JOIN doctor_earnings_events dee
      ON dee.course_id = c.id
     AND dee.doctor_id = p_doctor_id
     AND dee.event_type IN ('enrollment','credit_use')
    WHERE c.doctor_id = p_doctor_id
      AND c.permanently_deleted = false
    GROUP BY c.id, c.title, c.price_egp
  ) t;

  -- Count paid courses
  SELECT COUNT(*) INTO v_paid_courses
  FROM courses
  WHERE doctor_id = p_doctor_id AND price_egp > 0 AND permanently_deleted = false;

  -- Avg course price
  SELECT COALESCE(AVG(price_egp), 0) INTO v_avg_course_price
  FROM courses
  WHERE doctor_id = p_doctor_id AND price_egp > 0 AND permanently_deleted = false;

  RETURN jsonb_build_object(
    'custom_pricing_enabled', COALESCE(v_custom_enabled, false),
    'earnings_mode',          COALESCE(v_earnings_mode, 'credit'),
    'credit_selling_price',   COALESCE(v_credit_price, 0),
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
