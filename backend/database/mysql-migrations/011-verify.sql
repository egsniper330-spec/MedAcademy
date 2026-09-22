-- ===========================================================================
-- 011-verify.sql — RUN MANUALLY AFTER IMPORTING 011_drop_legacy_activation_codes.sql
-- ===========================================================================
-- This file contains read-only verification queries.
-- Run each query individually in phpMyAdmin's SQL tab AFTER importing 011.
-- DO NOT import this file via phpMyAdmin — run queries one at a time.
-- ===========================================================================

-- 1. Verify legacy Activation Code tables are gone
SELECT COUNT(*) AS legacy_tables_remaining
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('activation_codes', 'code_batches');
-- EXPECTED: 0 (both tables should be gone)

-- 2. Verify legacy views are gone
SELECT COUNT(*) AS legacy_views_remaining
FROM information_schema.VIEWS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('activation_ledger_view', 'activation_codes_summary');
-- EXPECTED: 0 (both views should be gone)

-- 3. Verify no stray verification procedure
SELECT COUNT(*) AS stray_procedures_remaining
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = DATABASE()
  AND ROUTINE_NAME = 'mig011_verify';
-- EXPECTED: 0 (no stray procedure)

-- 4. Verify application tables still exist (including users and enrollments)
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('users', 'profiles', 'courses', 'enrollments', 'credits', 'credit_transactions', 'audit_logs')
ORDER BY TABLE_NAME;
-- EXPECTED: 7 rows (all application tables present)

-- 5. Verify historical audit data is intact
SELECT COUNT(*) AS legacy_code_audit_rows
FROM audit_logs
WHERE action IN (
  'code_created', 'code_redeemed', 'code_deactivated', 'code_deleted',
  'code_activated', 'code_disabled', 'code_expired',
  'activation_code_created', 'activation_code_used'
);
-- EXPECTED: same count as before migration (historical data preserved)

-- 6. Verify historical enrollments are intact
SELECT COUNT(*) AS enrollments_count
FROM enrollments;
-- EXPECTED: same count as before migration (historical enrollments preserved)

-- 7. Verify users table is intact
SELECT COUNT(*) AS users_count
FROM users;
-- EXPECTED: same count as before migration (users data preserved)
