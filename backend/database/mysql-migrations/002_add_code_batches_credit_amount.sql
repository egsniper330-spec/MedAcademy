-- ============================================================================
-- Migration 002: Add credit_amount to code_batches
-- Source: PG code_batches has credit_amount; MySQL was missing it
-- Date: 2026-08-20
-- Safe: IF NOT EXISTS, no data loss
-- ============================================================================

-- Add credit_amount column if missing (idempotent)
SET @exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'code_batches'
    AND COLUMN_NAME = 'credit_amount'
);

SET @sql = IF(@exists = 0,
  'ALTER TABLE `code_batches` ADD COLUMN `credit_amount` INT DEFAULT 0 NOT NULL COMMENT \'pg_default: 0\' AFTER `label`',
  'SELECT "credit_amount column already exists" AS status'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
