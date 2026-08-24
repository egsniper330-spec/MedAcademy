-- ============================================================================
-- Migration 001: Add support_settings table
-- Source: Supabase migration 0041 (support_settings.sql)
-- Date: 2026-08-20
-- Safe: IF NOT EXISTS, idempotent
-- ============================================================================

CREATE TABLE IF NOT EXISTS `support_settings` (
  `key`         VARCHAR(50) NOT NULL,
  `value`       VARCHAR(255) NOT NULL DEFAULT '',
  `label`       VARCHAR(100) NULL,
  `enabled`     TINYINT(1) NOT NULL DEFAULT 0,
  `updated_by`  CHAR(36) NULL,
  `updated_at`  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed default support channels (idempotent)
INSERT IGNORE INTO `support_settings` (`key`, `value`, `label`, `enabled`) VALUES
  ('phone',    '', 'Phone Support',    0),
  ('telegram', '', 'Telegram Support', 0),
  ('whatsapp', '', 'WhatsApp Support', 0);
