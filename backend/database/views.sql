-- ===========================================================================
-- MedAcademy — MySQL Database Views
-- ===========================================================================
-- Restored to the ORIGINAL Supabase/PostgreSQL contracts. The frontend was
-- built against the PG field names (see src/lib/api.ts), so the previous
-- MySQL "redesign" of these views broke the API contract AND failed to import
-- (the #1054 "Unknown column 'ac.credit_amount'" error — the PG views never
-- had a credit_amount column at all).
--
-- Sources (final/last definition of each view):
--   * supabase/migrations/00017_enterprise_admin_panel_v2.sql
--   * supabase/migrations/00036_enterprise_ledger_tables_views.sql
--   * supabase/migrations/00037_advanced_credit_management_v2.sql
--   * supabase/migrations/00102_doctor_credit_selling_price.sql
--
-- Only syntax was adapted to MySQL:
--   * COUNT(*) FILTER (WHERE ...)  ->  SUM(CASE WHEN ... THEN 1 ELSE 0 END)
--   * DATE_TRUNC('month', ts)      ->  DATE_FORMAT(ts, '%Y-%m-01')
--   * value->>'amount'             ->  JSON_UNQUOTE(JSON_EXTRACT(value,'$.amount'))
--   * now()                        ->  CURRENT_TIMESTAMP
--
-- Import via: cPanel Terminal -> mysql -u USER -p DB < views.sql
-- (or phpMyAdmin SQL tab). Safe to re-run: every view is DROP + CREATE.
-- ===========================================================================

-- ===========================================================================
-- 1. activation_codes_summary  (PG 00017 — SINGLE row across all codes)
--    Frontend: admin dashboard -> .select('*').single() reads
--    active_codes / used_codes / disabled_codes / expired_codes / total_codes
-- ===========================================================================
DROP VIEW IF EXISTS `activation_codes_summary`;
CREATE VIEW `activation_codes_summary` AS
SELECT
  SUM(CASE WHEN status = 'active'  AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) THEN 1 ELSE 0 END) AS active_codes,
  SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) AS used_codes,
  SUM(CASE WHEN status = 'deactivated' THEN 1 ELSE 0 END) AS disabled_codes,
  SUM(CASE WHEN status = 'active' AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS expired_codes,
  COUNT(*) AS total_codes
FROM activation_codes;

-- ===========================================================================
-- 2. credit_ledger_view  (PG 00036 — one row per credit transaction)
--    Frontend: getCreditLedger() filters doctor_id / performed_by / created_at
-- ===========================================================================
DROP VIEW IF EXISTS `credit_ledger_view`;
CREATE VIEW `credit_ledger_view` AS
SELECT
  ct.id,
  ct.created_at,
  ct.transaction_type,
  ct.amount,
  ct.balance_before,
  ct.balance_after,
  ct.reason,
  ct.notes,
  ct.batch_id,
  ct.audit_log_id,
  ct.doctor_id,
  d.full_name    AS doctor_name,
  d.email        AS doctor_email,
  ct.performed_by,
  p.full_name    AS performed_by_name,
  p.role         AS performed_by_role,
  ct.student_id,
  s.full_name    AS student_name,
  ct.course_id,
  c.title        AS course_title
FROM credit_transactions ct
LEFT JOIN profiles d ON d.id = ct.doctor_id
LEFT JOIN profiles p ON p.id = ct.performed_by
LEFT JOIN profiles s ON s.id = ct.student_id
LEFT JOIN courses  c ON c.id = ct.course_id;

-- ===========================================================================
-- 3. doctor_credit_summary  (PG 00102 — LATEST; one row per doctor)
--    Frontend: getDoctorCreditSummary() .eq('id', ...); getTopDoctorsByCredits()
--    .order('current_balance'). Reads credit_selling_price, total_received,
--    total_used, current_balance, total_removed, total_refunded.
-- ===========================================================================
DROP VIEW IF EXISTS `doctor_credit_summary`;
CREATE VIEW `doctor_credit_summary` AS
SELECT
  p.id,
  p.full_name,
  p.email,
  p.credit_selling_price,
  COALESCE(cr.allocated, 0) AS total_received,
  COALESCE(cr.consumed,  0) AS total_used,
  COALESCE(cr.remaining, 0) AS current_balance,
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

-- ===========================================================================
-- 4. fraud_detection_flags  (no PG source — kept from the MySQL port; all
--    columns verified against the fraud_flags table)
-- ===========================================================================
DROP VIEW IF EXISTS `fraud_detection_flags`;
CREATE VIEW `fraud_detection_flags` AS
SELECT
  ff.id,
  ff.doctor_id AS user_id,
  p.full_name  AS user_name,
  ff.flag_type,
  ff.details,
  ff.resolved,
  ff.created_at
FROM fraud_flags ff
LEFT JOIN profiles p ON p.id = ff.doctor_id
ORDER BY ff.created_at DESC;

-- ===========================================================================
-- 5. revenue_analytics  (PG 00037 — one row per credit transaction)
--    Frontend: getRevenueAnalytics() filters admin_id / doctor_id / day; the
--    revenue-analytics screen reads doctor_id, doctor_name, amount,
--    performed_by, course_id. `performed_by` and `course_id` are added output
--    columns (real columns on credit_transactions) because the frontend reads
--    them; they were absent from the PG view.
-- ===========================================================================
DROP VIEW IF EXISTS `revenue_analytics`;
CREATE VIEW `revenue_analytics` AS
SELECT
  ct.performed_by AS admin_id,
  p.full_name     AS admin_name,
  ct.doctor_id,
  d.full_name     AS doctor_name,
  DATE(ct.created_at)              AS day,
  DATE_FORMAT(ct.created_at, '%Y-%m-01') AS month,
  DATE_FORMAT(ct.created_at, '%Y-01-01') AS year,
  ct.transaction_type,
  ct.amount,
  ct.performed_by,
  ct.course_id,
  ROUND(
    ct.amount * COALESCE(
      CAST(JSON_UNQUOTE(JSON_EXTRACT(
        (SELECT value FROM system_config WHERE `key` = 'credit_price' LIMIT 1),
        '$.amount')) AS DECIMAL(20,6)),
      10
    ),
    2
  ) AS revenue,
  COALESCE(
    JSON_UNQUOTE(JSON_EXTRACT(
      (SELECT value FROM system_config WHERE `key` = 'credit_price' LIMIT 1),
      '$.currency')),
    'EGP'
  ) AS currency
FROM credit_transactions ct
LEFT JOIN profiles p ON p.id = ct.performed_by
LEFT JOIN profiles d ON d.id = ct.doctor_id;

-- ===========================================================================
-- 6. credits_summary  (PG 00017 — SINGLE row across all credits)
--    Frontend: admin dashboard -> .select('*').single() reads total_credits /
--    used_credits / remaining_credits
-- ===========================================================================
DROP VIEW IF EXISTS `credits_summary`;
CREATE VIEW `credits_summary` AS
SELECT
  COALESCE(SUM(allocated),          0) AS total_credits,
  COALESCE(SUM(consumed),           0) AS used_credits,
  COALESCE(SUM(allocated - consumed), 0) AS remaining_credits
FROM credits;

-- ===========================================================================
-- 7. activation_ledger_view  (PG 00036 — one row per activation code)
--    Frontend: getActivationLedger() filters status / course_id / created_by /
--    batch_id, orders created_at. NOTE: no credit_amount column (the PG view
--    never had one — this also removes the second ac.credit_amount #1054).
-- ===========================================================================
DROP VIEW IF EXISTS `activation_ledger_view`;
CREATE VIEW `activation_ledger_view` AS
SELECT
  ac.id,
  ac.code,
  ac.status,
  ac.created_at,
  ac.expires_at,
  ac.used_at,
  ac.notes,
  ac.identifier,
  ac.device_info,
  ac.batch_id,
  ac.batch_label,
  ac.disabled_at,
  ac.course_id,
  c.title        AS course_title,
  ac.created_by,
  cr.full_name   AS created_by_name,
  cr.role        AS created_by_role,
  ac.used_by,
  u.full_name    AS used_by_name,
  u.email        AS used_by_email,
  ac.disabled_by,
  db.full_name   AS disabled_by_name
FROM activation_codes ac
LEFT JOIN courses  c  ON c.id  = ac.course_id
LEFT JOIN profiles cr ON cr.id = ac.created_by
LEFT JOIN profiles u  ON u.id  = ac.used_by
LEFT JOIN profiles db ON db.id = ac.disabled_by;

-- ===========================================================================
-- 8. device_stats  (PG 00017 — SINGLE row across all devices)
--    Frontend: admin dashboard -> .select('*').single() reads total_devices /
--    users_with_devices
-- ===========================================================================
DROP VIEW IF EXISTS `device_stats`;
CREATE VIEW `device_stats` AS
SELECT
  COUNT(*)                AS total_devices,
  COUNT(DISTINCT user_id) AS users_with_devices
FROM devices;

-- ===========================================================================
-- 9. credit_daily_stats  (PG 00036 — one row per day + transaction_type)
--    Frontend: getCreditDailyStats() .gte('day') / .order('day'); the
--    super-admin chart reads row.day and row.total_amount
-- ===========================================================================
DROP VIEW IF EXISTS `credit_daily_stats`;
CREATE VIEW `credit_daily_stats` AS
SELECT
  DATE(created_at) AS day,
  transaction_type,
  COUNT(*) AS tx_count,
  SUM(amount) AS total_amount
FROM credit_transactions
GROUP BY DATE(created_at), transaction_type;
