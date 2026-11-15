-- ============================================================================
-- Migration 039 (down) — revert Admin RBAC
-- ============================================================================
-- Safe, dependency-ordered rollback. It removes ONLY the objects this
-- migration created; profiles, roles and accounts are untouched.
--
-- NOTE: rolling back restores the pre-RBAC behaviour where every `admin`
-- has unrestricted platform access (there is no finer-grained model to fall
-- back to). Run this only if the RBAC code is also being reverted.
-- ============================================================================

SET @has_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'profiles'
    AND CONSTRAINT_NAME = 'fk_profiles_permission_template_id'
);
SET @sql := IF(@has_fk > 0,
  'ALTER TABLE `profiles` DROP FOREIGN KEY `fk_profiles_permission_template_id`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'profiles'
    AND COLUMN_NAME = 'permission_template_id'
);
SET @sql := IF(@has_col > 0,
  'ALTER TABLE `profiles` DROP COLUMN `permission_template_id`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

DROP TABLE IF EXISTS `admin_permissions`;
DROP TABLE IF EXISTS `permission_templates`;

SELECT 'admin_rbac_reverted' AS status;
