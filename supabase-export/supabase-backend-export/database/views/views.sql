-- =============================================================================
-- MedAcademy — Database Views
-- Generated: 2026-07-13
-- Total: 30+ views
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- activation_codes_summary
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.activation_codes_summary AS
SELECT
  b.id AS batch_id,
  b.name AS batch_name,
  b.credit_amount,
  b.code_count,
  COUNT(ac.id) AS total_codes,
  COUNT(ac.id) FILTER (WHERE ac.status = 'active') AS active_count,
  COUNT(ac.id) FILTER (WHERE ac.status = 'used') AS used_count,
  COUNT(ac.id) FILTER (WHERE ac.status = 'expired') AS expired_count,
  COUNT(ac.id) FILTER (WHERE ac.status = 'disabled') AS disabled_count
FROM public.code_batches b
LEFT JOIN public.activation_codes ac ON ac.batch_id = b.id
GROUP BY b.id, b.name, b.credit_amount, b.code_count;

-- ─────────────────────────────────────────────────────────────────────────────
-- credit_ledger_view
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.credit_ledger_view AS
SELECT
  ct.id,
  ct.user_id,
  p.full_name AS user_name,
  ct.amount,
  ct.transaction_type,
  ct.note,
  ct.course_id,
  c.title AS course_title,
  ct.performed_by,
  pb.full_name AS performed_by_name,
  ct.created_at
FROM public.credit_transactions ct
LEFT JOIN public.profiles p ON p.id = ct.user_id
LEFT JOIN public.courses c ON c.id = ct.course_id
LEFT JOIN public.profiles pb ON pb.id = ct.performed_by
ORDER BY ct.created_at DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- doctor_credit_summary
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.doctor_credit_summary AS
SELECT
  p.id AS doctor_id,
  p.full_name,
  p.email,
  COALESCE(cr.balance, 0) AS balance,
  COALESCE(cr.total_allocated, 0) AS total_allocated,
  COALESCE(cr.total_consumed, 0) AS total_consumed,
  COUNT(DISTINCT e.id) AS total_enrollments,
  COUNT(DISTINCT co.id) AS total_courses
FROM public.profiles p
LEFT JOIN public.credits cr ON cr.user_id = p.id
LEFT JOIN public.enrollments e ON e.user_id = p.id
LEFT JOIN public.courses co ON co.doctor_id = p.id
WHERE p.role IN ('doctor','assistant')
GROUP BY p.id, p.full_name, p.email, cr.balance, cr.total_allocated, cr.total_consumed;

-- ─────────────────────────────────────────────────────────────────────────────
-- fraud_detection_flags
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.fraud_detection_flags AS
SELECT
  ff.id,
  ff.user_id,
  p.full_name AS user_name,
  ff.flag_type,
  ff.details,
  ff.resolved,
  ff.created_at
FROM public.fraud_flags ff
LEFT JOIN public.profiles p ON p.id = ff.user_id
ORDER BY ff.created_at DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- revenue_analytics
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.revenue_analytics AS
SELECT
  date_trunc('day', ct.created_at) AS day,
  ct.transaction_type,
  SUM(ct.amount) AS total_amount,
  COUNT(*) AS transaction_count
FROM public.credit_transactions ct
GROUP BY date_trunc('day', ct.created_at), ct.transaction_type
ORDER BY day DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- credits_summary
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.credits_summary AS
SELECT
  p.id AS user_id,
  p.full_name,
  p.role,
  p.status,
  COALESCE(cr.balance, 0) AS balance,
  COALESCE(cr.total_allocated, 0) AS total_allocated,
  COALESCE(cr.total_consumed, 0) AS total_consumed
FROM public.profiles p
LEFT JOIN public.credits cr ON cr.user_id = p.id;

-- ─────────────────────────────────────────────────────────────────────────────
-- activation_ledger_view
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.activation_ledger_view AS
SELECT
  ac.id,
  ac.code,
  ac.batch_id,
  b.name AS batch_name,
  ac.credit_amount,
  ac.status,
  ac.used_by,
  p.full_name AS used_by_name,
  ac.used_at,
  ac.expires_at,
  ac.created_at
FROM public.activation_codes ac
LEFT JOIN public.code_batches b ON b.id = ac.batch_id
LEFT JOIN public.profiles p ON p.id = ac.used_by
ORDER BY ac.created_at DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- device_stats
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.device_stats AS
SELECT
  user_id,
  COUNT(*) AS total_devices,
  COUNT(*) FILTER (WHERE status = 'active') AS active_devices,
  COUNT(*) FILTER (WHERE status = 'blocked') AS blocked_devices,
  MAX(last_seen_at) AS last_seen
FROM public.devices
GROUP BY user_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- credit_daily_stats (view over transaction data — also a table)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.credit_daily_stats_view AS
SELECT
  date_trunc('day', created_at)::date AS stat_date,
  SUM(amount) FILTER (WHERE transaction_type IN ('allocation','grant_super_admin','grant_admin')) AS total_allocated,
  ABS(SUM(amount) FILTER (WHERE transaction_type = 'consumption')) AS total_consumed,
  COUNT(DISTINCT user_id) AS active_users
FROM public.credit_transactions
GROUP BY date_trunc('day', created_at)::date
ORDER BY stat_date DESC;
