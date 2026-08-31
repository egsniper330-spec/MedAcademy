-- ============================================================================
-- Migration 003: Add credit_amount to activation_codes
-- ============================================================================
-- Source: PG activation_codes has credit_amount (pg_default: 1). The workspace
-- schema.sql includes it, but the LIVE database predates it (the previous
-- views.sql #1054 "Unknown column 'ac.credit_amount'" error came from this).
--
-- WHY THIS IS REQUIRED: the application code writes this column on every code
-- generation — CreditController::createBatch() and cloneBatch() both run
-- `INSERT INTO activation_codes (... credit_amount ...)`. Without the column,
-- creating/cloning an activation-code batch on the live server fails with
-- MySQL error 1054. This migration does NOT change the views (they now follow
-- the original PG contract, which has no credit_amount in the views).
--
-- Safe: idempotent (checks information_schema), non-destructive, no data loss.
-- ============================================================================

SET @exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'activation_codes'
    AND COLUMN_NAME = 'credit_amount'
);

SET @sql = IF(@exists = 0,
  'ALTER TABLE `activation_codes` ADD COLUMN `credit_amount` INT DEFAULT 1 NOT NULL COMMENT ''pg_default: 1'' AFTER `uses_count`',
  'SELECT "credit_amount column already exists" AS status'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
