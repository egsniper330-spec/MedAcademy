-- =============================================================================
-- Migration 013: Redeem Code archive flag
-- =============================================================================
-- Adds credit_redeem_codes.archived_at. Product rule change:
--   * "Revoke" on an UNUSED code now PERMANENTLY DELETES the row (audit log
--     keeps the evidence; the code can never be redeemed).
--   * A REDEEMED code can no longer be deleted (that would destroy the
--     redeemed_by/redeemed_at accounting record) — the Super Admin may instead
--     ARCHIVE it: the row is kept (financial history intact) but hidden from
--     the active list via archived_at. Archived codes are already
--     status='redeemed' so they can never be redeemed again regardless.
--
-- Idempotent: column added only when missing; index likewise.
-- =============================================================================

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'credit_redeem_codes'
     AND COLUMN_NAME = 'archived_at'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `credit_redeem_codes` ADD COLUMN `archived_at` DATETIME(6) NULL AFTER `revoked_at`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Index for the list query's NOT NULL filter.
SET @idx_exists = (
  SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'credit_redeem_codes'
     AND INDEX_NAME = 'idx_credit_redeem_codes_archived_at'
);
SET @ddl = IF(@idx_exists = 0,
  'ALTER TABLE `credit_redeem_codes` ADD INDEX `idx_credit_redeem_codes_archived_at` (`archived_at`)',
  'SELECT 2');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Rollback (only safe if no rows are archived):
--   ALTER TABLE credit_redeem_codes DROP INDEX idx_credit_redeem_codes_archived_at;
--   ALTER TABLE credit_redeem_codes DROP COLUMN archived_at;
