-- ===========================================================================
-- MedAcademy — MySQL Database Views
-- Migrated from Supabase PostgreSQL views
-- Names match frontend .from('view_name') references (NO v_ prefix)
-- ===========================================================================

-- ===========================================================================
-- 1. activation_codes_summary
-- ===========================================================================
DROP VIEW IF EXISTS `activation_codes_summary`;
CREATE VIEW `activation_codes_summary` AS
SELECT
  b.id AS batch_id,
  b.label AS batch_name,
  COALESCE(SUM(ac.credit_amount), 0) AS credit_amount,
  b.total_count AS code_count,
  COUNT(ac.id) AS total_codes,
  SUM(CASE WHEN ac.status = 'active' THEN 1 ELSE 0 END) AS active_count,
  SUM(CASE WHEN ac.status = 'used' THEN 1 ELSE 0 END) AS used_count,
  SUM(CASE WHEN ac.status = 'expired' THEN 1 ELSE 0 END) AS expired_count,
  SUM(CASE WHEN ac.status = 'deactivated' THEN 1 ELSE 0 END) AS disabled_count
FROM code_batches b
LEFT JOIN activation_codes ac ON ac.batch_id = b.id
GROUP BY b.id, b.label, b.total_count;

-- ===========================================================================
-- 2. credit_ledger_view
-- ===========================================================================
DROP VIEW IF EXISTS `credit_ledger_view`;
CREATE VIEW `credit_ledger_view` AS
SELECT
  ct.id,
  ct.doctor_id AS user_id,
  p.full_name AS user_name,
  ct.amount,
  ct.transaction_type,
  ct.notes AS note,
  ct.course_id,
  c.title AS course_title,
  ct.performed_by,
  pb.full_name AS performed_by_name,
  ct.created_at
FROM credit_transactions ct
LEFT JOIN profiles p ON p.id = ct.doctor_id
LEFT JOIN courses c ON c.id = ct.course_id
LEFT JOIN profiles pb ON pb.id = ct.performed_by
ORDER BY ct.created_at DESC;

-- ===========================================================================
-- 3. doctor_credit_summary
-- ===========================================================================
DROP VIEW IF EXISTS `doctor_credit_summary`;
CREATE VIEW `doctor_credit_summary` AS
SELECT
  p.id AS doctor_id,
  p.full_name,
  p.email,
  COALESCE(cr.remaining, 0) AS balance,
  COALESCE(cr.allocated, 0) AS total_allocated,
  COALESCE(cr.consumed, 0) AS total_consumed,
  COUNT(DISTINCT e.id) AS total_enrollments,
  COUNT(DISTINCT co.id) AS total_courses
FROM profiles p
LEFT JOIN credits cr ON cr.doctor_id = p.id
LEFT JOIN enrollments e ON e.student_id = p.id
LEFT JOIN courses co ON co.doctor_id = p.id
WHERE p.role IN ('doctor', 'assistant')
GROUP BY p.id, p.full_name, p.email, cr.remaining, cr.allocated, cr.consumed;

-- ===========================================================================
-- 4. fraud_detection_flags
-- ===========================================================================
DROP VIEW IF EXISTS `fraud_detection_flags`;
CREATE VIEW `fraud_detection_flags` AS
SELECT
  ff.id,
  ff.doctor_id AS user_id,
  p.full_name AS user_name,
  ff.flag_type,
  ff.details,
  ff.resolved,
  ff.created_at
FROM fraud_flags ff
LEFT JOIN profiles p ON p.id = ff.doctor_id
ORDER BY ff.created_at DESC;

-- ===========================================================================
-- 5. revenue_analytics
-- ===========================================================================
DROP VIEW IF EXISTS `revenue_analytics`;
CREATE VIEW `revenue_analytics` AS
SELECT
  DATE(ct.created_at) AS day,
  ct.transaction_type,
  SUM(ct.amount) AS total_amount,
  COUNT(*) AS transaction_count
FROM credit_transactions ct
GROUP BY DATE(ct.created_at), ct.transaction_type
ORDER BY day DESC;

-- ===========================================================================
-- 6. credits_summary
-- ===========================================================================
DROP VIEW IF EXISTS `credits_summary`;
CREATE VIEW `credits_summary` AS
SELECT
  p.id AS user_id,
  p.full_name,
  p.role,
  p.status,
  COALESCE(cr.remaining, 0) AS balance,
  COALESCE(cr.allocated, 0) AS total_allocated,
  COALESCE(cr.consumed, 0) AS total_consumed
FROM profiles p
LEFT JOIN credits cr ON cr.doctor_id = p.id;

-- ===========================================================================
-- 7. activation_ledger_view
-- ===========================================================================
DROP VIEW IF EXISTS `activation_ledger_view`;
CREATE VIEW `activation_ledger_view` AS
SELECT
  ac.id,
  ac.code,
  ac.batch_id,
  b.label AS batch_name,
  ac.credit_amount,
  ac.status,
  ac.used_by,
  p.full_name AS used_by_name,
  ac.used_at,
  ac.expires_at,
  ac.created_at
FROM activation_codes ac
LEFT JOIN code_batches b ON b.id = ac.batch_id
LEFT JOIN profiles p ON p.id = ac.used_by
ORDER BY ac.created_at DESC;

-- ===========================================================================
-- 8. device_stats
-- ===========================================================================
DROP VIEW IF EXISTS `device_stats`;
CREATE VIEW `device_stats` AS
SELECT
  user_id,
  COUNT(*) AS total_devices,
  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_devices,
  SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked_devices,
  MAX(last_active_at) AS last_seen
FROM devices
GROUP BY user_id;

-- ===========================================================================
-- 9. credit_daily_stats
-- ===========================================================================
DROP VIEW IF EXISTS `credit_daily_stats`;
CREATE VIEW `credit_daily_stats` AS
SELECT
  DATE(created_at) AS stat_date,
  SUM(CASE WHEN transaction_type IN ('allocation', 'grant_super_admin', 'grant_admin') THEN amount ELSE 0 END) AS total_allocated,
  ABS(SUM(CASE WHEN transaction_type = 'consumption' THEN amount ELSE 0 END)) AS total_consumed,
  COUNT(DISTINCT doctor_id) AS active_users
FROM credit_transactions
GROUP BY DATE(created_at)
ORDER BY stat_date DESC;
