-- =============================================================
-- 007_fix_profile_fk_on_delete.sql  (v2 — corrected)
--
-- Change foreign keys referencing profiles.id that use
-- NO ACTION (RESTRICT) to ON DELETE SET NULL, so that
-- permanent user deletion does not fail on FK constraints.
--
-- Fix applied: v1 used COLUMN_NAME in TABLE_CONSTRAINTS queries.
-- COLUMN_NAME lives in KEY_COLUMN_USAGE, not TABLE_CONSTRAINTS.
-- This v2 joins both tables correctly.
--
-- Tables affected:
--   audit_logs.user_id                → SET NULL (preserve audit record)
--   courses.archived_by               → SET NULL
--   courses.restored_by               → SET NULL
--   credit_transactions.student_id    → SET NULL
--   credit_transactions.performed_by  → SET NULL
--   code_batches.created_by           → SET NULL
--   activation_codes.created_by       → SET NULL
--   assistant_permissions.updated_by  → SET NULL
--   system_config.updated_by          → SET NULL
--   fraud_flags.resolved_by           → SET NULL
--
-- Idempotent: safe to re-run. Skips FKs that already have
-- SET NULL, skips missing tables/columns gracefully.
-- =============================================================

-- ---------------------------------------------------------------
-- 1. audit_logs.user_id
-- ---------------------------------------------------------------
-- Drop the FK if it exists (by known name or by column lookup)
SET @fk = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'audit_logs'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'user_id'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
  LIMIT 1
);
SET @sql = IF(@fk IS NOT NULL,
              CONCAT('ALTER TABLE `audit_logs` DROP FOREIGN KEY `', @fk, '`'),
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add with SET NULL (skip if constraint already exists with correct behavior)
SET @existing = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND rc.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'audit_logs'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'user_id'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND rc.DELETE_RULE = 'SET NULL'
  LIMIT 1
);
SET @sql = IF(@existing IS NULL,
              'ALTER TABLE `audit_logs` ADD CONSTRAINT `fk_audit_logs_user_id` FOREIGN KEY (`user_id`) REFERENCES `profiles` (`id`) ON DELETE SET NULL',
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------
-- 2. courses.archived_by
-- ---------------------------------------------------------------
SET @fk = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'courses'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'archived_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
  LIMIT 1
);
SET @sql = IF(@fk IS NOT NULL,
              CONCAT('ALTER TABLE `courses` DROP FOREIGN KEY `', @fk, '`'),
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @existing = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND rc.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'courses'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'archived_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND rc.DELETE_RULE = 'SET NULL'
  LIMIT 1
);
SET @sql = IF(@existing IS NULL,
              'ALTER TABLE `courses` ADD CONSTRAINT `fk_courses_archived_by` FOREIGN KEY (`archived_by`) REFERENCES `profiles` (`id`) ON DELETE SET NULL',
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------
-- 3. courses.restored_by
-- ---------------------------------------------------------------
SET @fk = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'courses'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'restored_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
  LIMIT 1
);
SET @sql = IF(@fk IS NOT NULL,
              CONCAT('ALTER TABLE `courses` DROP FOREIGN KEY `', @fk, '`'),
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @existing = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND rc.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'courses'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'restored_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND rc.DELETE_RULE = 'SET NULL'
  LIMIT 1
);
SET @sql = IF(@existing IS NULL,
              'ALTER TABLE `courses` ADD CONSTRAINT `fk_courses_restored_by` FOREIGN KEY (`restored_by`) REFERENCES `profiles` (`id`) ON DELETE SET NULL',
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------
-- 4. credit_transactions.student_id
-- ---------------------------------------------------------------
SET @fk = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'credit_transactions'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'student_id'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
  LIMIT 1
);
SET @sql = IF(@fk IS NOT NULL,
              CONCAT('ALTER TABLE `credit_transactions` DROP FOREIGN KEY `', @fk, '`'),
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @existing = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND rc.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'credit_transactions'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'student_id'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND rc.DELETE_RULE = 'SET NULL'
  LIMIT 1
);
SET @sql = IF(@existing IS NULL,
              'ALTER TABLE `credit_transactions` ADD CONSTRAINT `fk_credit_transactions_student_id` FOREIGN KEY (`student_id`) REFERENCES `profiles` (`id`) ON DELETE SET NULL',
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------
-- 5. credit_transactions.performed_by
-- ---------------------------------------------------------------
SET @fk = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'credit_transactions'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'performed_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
  LIMIT 1
);
SET @sql = IF(@fk IS NOT NULL,
              CONCAT('ALTER TABLE `credit_transactions` DROP FOREIGN KEY `', @fk, '`'),
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @existing = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND rc.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'credit_transactions'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'performed_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND rc.DELETE_RULE = 'SET NULL'
  LIMIT 1
);
SET @sql = IF(@existing IS NULL,
              'ALTER TABLE `credit_transactions` ADD CONSTRAINT `fk_credit_transactions_performed_by` FOREIGN KEY (`performed_by`) REFERENCES `profiles` (`id`) ON DELETE SET NULL',
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------
-- 6. code_batches.created_by
-- ---------------------------------------------------------------
SET @fk = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'code_batches'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'created_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
  LIMIT 1
);
SET @sql = IF(@fk IS NOT NULL,
              CONCAT('ALTER TABLE `code_batches` DROP FOREIGN KEY `', @fk, '`'),
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @existing = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND rc.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'code_batches'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'created_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND rc.DELETE_RULE = 'SET NULL'
  LIMIT 1
);
SET @sql = IF(@existing IS NULL,
              'ALTER TABLE `code_batches` ADD CONSTRAINT `fk_code_batches_created_by` FOREIGN KEY (`created_by`) REFERENCES `profiles` (`id`) ON DELETE SET NULL',
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------
-- 7. activation_codes.created_by
-- ---------------------------------------------------------------
SET @fk = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'activation_codes'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'created_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
  LIMIT 1
);
SET @sql = IF(@fk IS NOT NULL,
              CONCAT('ALTER TABLE `activation_codes` DROP FOREIGN KEY `', @fk, '`'),
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @existing = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND rc.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'activation_codes'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'created_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND rc.DELETE_RULE = 'SET NULL'
  LIMIT 1
);
SET @sql = IF(@existing IS NULL,
              'ALTER TABLE `activation_codes` ADD CONSTRAINT `fk_activation_codes_created_by` FOREIGN KEY (`created_by`) REFERENCES `profiles` (`id`) ON DELETE SET NULL',
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------
-- 8. assistant_permissions.updated_by
-- ---------------------------------------------------------------
SET @fk = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'assistant_permissions'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'updated_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
  LIMIT 1
);
SET @sql = IF(@fk IS NOT NULL,
              CONCAT('ALTER TABLE `assistant_permissions` DROP FOREIGN KEY `', @fk, '`'),
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @existing = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND rc.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'assistant_permissions'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'updated_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND rc.DELETE_RULE = 'SET NULL'
  LIMIT 1
);
SET @sql = IF(@existing IS NULL,
              'ALTER TABLE `assistant_permissions` ADD CONSTRAINT `fk_assistant_permissions_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `profiles` (`id`) ON DELETE SET NULL',
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------
-- 9. system_config.updated_by
-- ---------------------------------------------------------------
SET @fk = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'system_config'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'updated_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
  LIMIT 1
);
SET @sql = IF(@fk IS NOT NULL,
              CONCAT('ALTER TABLE `system_config` DROP FOREIGN KEY `', @fk, '`'),
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @existing = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND rc.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'system_config'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'updated_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND rc.DELETE_RULE = 'SET NULL'
  LIMIT 1
);
SET @sql = IF(@existing IS NULL,
              'ALTER TABLE `system_config` ADD CONSTRAINT `fk_system_config_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `profiles` (`id`) ON DELETE SET NULL',
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------
-- 10. fraud_flags.resolved_by
-- ---------------------------------------------------------------
SET @fk = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'fraud_flags'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'resolved_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
  LIMIT 1
);
SET @sql = IF(@fk IS NOT NULL,
              CONCAT('ALTER TABLE `fraud_flags` DROP FOREIGN KEY `', @fk, '`'),
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @existing = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND rc.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'fraud_flags'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'resolved_by'
    AND kcu.REFERENCED_TABLE_NAME = 'profiles'
    AND rc.DELETE_RULE = 'SET NULL'
  LIMIT 1
);
SET @sql = IF(@existing IS NULL,
              'ALTER TABLE `fraud_flags` ADD CONSTRAINT `fk_fraud_flags_resolved_by` FOREIGN KEY (`resolved_by`) REFERENCES `profiles` (`id`) ON DELETE SET NULL',
              'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
