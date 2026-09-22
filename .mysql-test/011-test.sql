-- This file exists so I can demonstrate the corrected 011 import behavior.
-- It is NOT part of the project; delete before committing.

SET FOREIGN_KEY_CHECKS = 0;
DROP VIEW IF EXISTS `activation_ledger_view`;
DROP VIEW IF EXISTS `activation_codes_summary`;
DROP TABLE IF EXISTS `activation_codes`;
DROP TABLE IF EXISTS `code_batches`;
SET FOREIGN_KEY_CHECKS = 1;
DROP PROCEDURE IF EXISTS `mig011_verify`;

-- phpMyAdmin parses SELECTs too. If a SELECT references `users` inside a
-- non-existent DB context, it errors — so verification SELECTs that check
-- app-tables-by-existence should use INFORMATION_SCHEMA, not bare table refs.

-- GOOD: this is safe even when phpMyAdmin parses it with no default db.
SELECT COUNT(*) AS sample_app_tables_preserved
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('users', 'profiles', 'credits');

-- BAD (this is what produced the #1109):
-- SELECT COUNT(*) AS users_count FROM `users`;
