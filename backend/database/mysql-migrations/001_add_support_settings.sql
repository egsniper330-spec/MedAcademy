-- ============================================================================
-- Migration 001: support_settings table (idempotent on MySQL AND MariaDB)
-- Date: 2026-10-07 (v3 — production-safe ALTER guard)
--
-- WHY v3 EXISTS:
--   v2 used `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`, which is
--   MariaDB-only syntax. On MySQL it is a syntax error, so the migration
--   could never apply on the production cPanel database — and the seed
--   INSERT below it kept failing with
--     #1054 - Unknown column 'display_order' in 'INSERT INTO'
--   because production's support_settings table predates the column.
--
--   v3 guards the ALTER through INFORMATION_SCHEMA + PREPARE, which is
--   valid on both MySQL 5.7/8.0 and MariaDB, and is safe to re-run any
--   number of times (phpMyAdmin-safe: run as separate statements).
-- ============================================================================

CREATE TABLE IF NOT EXISTS `support_settings` (
  `key`           VARCHAR(50)  NOT NULL,
  `value`         VARCHAR(255) NOT NULL DEFAULT '',
  `label`         VARCHAR(100) NULL,
  `enabled`       TINYINT(1)   NOT NULL DEFAULT 0,
  `display_order` INT          NOT NULL DEFAULT 0,
  `updated_by`    CHAR(36)     NULL,
  `updated_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Add display_order if this table predates the column.
-- MySQL-safe idempotent ALTER (works in phpMyAdmin; run statements in order).
-- ---------------------------------------------------------------------------
SET @col_exists := (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'support_settings'
     AND COLUMN_NAME  = 'display_order'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `support_settings` ADD COLUMN `display_order` INT NOT NULL DEFAULT 0 AFTER `enabled`',
  'SELECT ''display_order already exists — nothing to do'' AS note');
PREPARE _ddl_stmt FROM @ddl;
EXECUTE _ddl_stmt;
DEALLOCATE PREPARE _ddl_stmt;

-- Seed default support channels (idempotent)
INSERT IGNORE INTO `support_settings` (`key`, `value`, `label`, `enabled`, `display_order`) VALUES
  ('whatsapp',  '', 'WhatsApp Support',   0, 1),
  ('facebook',  '', 'Facebook Support',   0, 2),
  ('instagram', '', 'Instagram Support',  0, 3),
  ('telegram',  '', 'Telegram Support',   0, 4),
  ('phone',     '', 'Phone Support',      0, 5),
  ('email',     '', 'Email Support',      0, 6),
  ('x',         '', 'X / Twitter Support', 0, 7),
  ('website',   '', 'Website Support',    0, 8);
