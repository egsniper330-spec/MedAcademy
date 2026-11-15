-- ============================================================================
-- Migration 039 — Admin RBAC: permission templates + per-admin grants
-- ============================================================================
-- PURPOSE
--   Turns the existing role-only gate (admin / super_admin) into real,
--   granular, server-enforced RBAC for the Admin role.
--
--   • permission_templates — reusable named permission sets (system + custom).
--   • admin_permissions    — per-admin overlay: granted = 1 (explicit grant)
--                            or 0 (explicit revoke on top of the template).
--   • profiles.permission_template_id — the template an admin is assigned.
--
-- SEMANTICS (implemented in src/Services/PermissionService.php, the single
-- source of truth for the key catalog — no key list is duplicated here):
--   effective(admin) = template.permissions
--                      OVERLAID BY admin_permissions rows (granted 1|0)
--   role = 'super_admin'  → ALWAYS every permission (unrestricted, unchanged).
--   role = 'admin' with no template and no rows → DENY-ALL (secure default).
--
-- BACKWARD COMPATIBILITY
--   Existing admins already had unrestricted platform access, so every
--   existing role='admin' row is stamped with the seeded `full_admin` template
--   in the same transaction-safe statement below. Nobody silently loses access,
--   and nobody is silently promoted to Super Admin.
--
-- IDEMPOTENCE: every statement is guarded (IF NOT EXISTS / information_schema /
-- INSERT IGNORE), so the file is safe to re-run. Nothing is dropped.
-- REVERSIBILITY: see 039_admin_rbac_down.sql.
-- ============================================================================

-- ── 1. Templates -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `permission_templates` (
  `id` CHAR(36) NOT NULL,
  `slug` VARCHAR(100) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` TEXT,
  `permissions` JSON NOT NULL,
  `is_system` TINYINT(1) NOT NULL DEFAULT 0,
  `created_by` CHAR(36) DEFAULT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_permission_templates_slug` (`slug`),
  CONSTRAINT `fk_permission_templates_created_by`
    FOREIGN KEY (`created_by`) REFERENCES `profiles` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. Per-admin overlay -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `admin_permissions` (
  `id` CHAR(36) NOT NULL,
  `admin_id` CHAR(36) NOT NULL,
  `permission_key` VARCHAR(191) NOT NULL,
  `granted` TINYINT(1) NOT NULL DEFAULT 1,
  `granted_by` CHAR(36) DEFAULT NULL,
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_permissions_admin_key` (`admin_id`, `permission_key`),
  KEY `idx_admin_permissions_admin_id` (`admin_id`),
  CONSTRAINT `fk_admin_permissions_admin_id`
    FOREIGN KEY (`admin_id`) REFERENCES `profiles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_admin_permissions_granted_by`
    FOREIGN KEY (`granted_by`) REFERENCES `profiles` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. Template assignment on profiles (nullable, non-destructive) -----------
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'profiles'
    AND COLUMN_NAME = 'permission_template_id'
);
SET @sql := IF(@has_col = 0,
  'ALTER TABLE `profiles` ADD COLUMN `permission_template_id` CHAR(36) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'profiles'
    AND CONSTRAINT_NAME = 'fk_profiles_permission_template_id'
);
SET @sql := IF(@has_fk = 0,
  'ALTER TABLE `profiles` ADD CONSTRAINT `fk_profiles_permission_template_id`
     FOREIGN KEY (`permission_template_id`) REFERENCES `permission_templates` (`id`) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 4. Seed the system templates (deterministic UUIDs) ------------------------
-- The JSON arrays below are the documented baseline for the seeded presets.
-- The authoritative key catalog (labels, groups, validation) lives in
-- PermissionService::catalog(); any key not in the catalog is ignored on read,
-- so a drifting preset can never grant an unknown capability.
INSERT IGNORE INTO `permission_templates` (`id`, `slug`, `name`, `description`, `permissions`, `is_system`) VALUES
('11111111-1111-4111-8111-111111111111', 'full_admin', 'Full Admin',
 'Every permission. Ordinary admins still cannot modify Super Admin accounts or grant more than they hold.',
 JSON_ARRAY('manage_admins','manage_permissions','manage_roles','manage_faculties','manage_universities','delete_any_course','edit_any_course','hidden_enrollment','manage_courses','manage_lessons','publish_courses','upload_videos','view_courses','block_doctor','manage_doctors','promote_doctor','remove_doctor','unblock_doctor','view_doctors','bulk_generate_codes','delete_codes','generate_codes','manage_activation_batches','manage_enrollment_codes','manage_activation_codes','view_activation_history','edit_course_prices','manage_doctor_credits','manage_financial_reports','view_credit_history','manage_about_us','manage_contact','manage_privacy','manage_terms','approve_university_requests','manage_platform','manage_system_health','manage_whatsapp','send_notifications','site_settings','storage_management','view_audit_logs','view_reports','view_revenue','view_statistics','view_student_counts','manage_security','reset_passwords','unlock_accounts','add_students','block_students','delete_students','edit_students','manage_students','unblock_students','view_students'),
 1),
('22222222-2222-4222-8222-222222222222', 'content_manager', 'Content Manager',
 'Academic structure, courses and lessons. No user, financial or platform administration.',
 JSON_ARRAY('manage_faculties','manage_universities','manage_courses','manage_lessons','publish_courses','upload_videos','view_courses','edit_any_course','view_reports','view_statistics'),
 1),
('33333333-3333-4333-8333-333333333333', 'course_manager', 'Course Manager',
 'Courses, lessons and doctors. No student or financial administration.',
 JSON_ARRAY('manage_courses','manage_lessons','publish_courses','upload_videos','view_courses','edit_any_course','delete_any_course','manage_doctors','view_doctors','manage_faculties','manage_universities','view_student_counts'),
 1),
('44444444-4444-4444-8444-444444444444', 'student_support', 'Student Support',
 'Student accounts, enrollment codes and password resets. Read-only elsewhere.',
 JSON_ARRAY('manage_students','view_students','add_students','edit_students','block_students','unblock_students','reset_passwords','unlock_accounts','manage_enrollment_codes','generate_codes','view_activation_history','view_courses','view_doctors','view_statistics'),
 1),
('55555555-5555-4555-8555-555555555555', 'financial_viewer', 'Financial Viewer',
 'Read-only financial and reporting access. Cannot modify money or accounts.',
 JSON_ARRAY('view_revenue','view_reports','view_statistics','view_credit_history','manage_financial_reports','view_student_counts'),
 1),
('66666666-6666-4666-8666-666666666666', 'custom', 'Custom',
 'Starts empty. Assign individual permissions explicitly.',
 JSON_ARRAY(),
 1);

-- ── 5. Preserve existing admin access ---------------------------------------
-- Every admin that existed before RBAC keeps working exactly as before by
-- receiving the full_admin template. Only rows that have never been assigned a
-- template are touched, so re-running can never overwrite later configuration.
UPDATE `profiles`
   SET `permission_template_id` = '11111111-1111-4111-8111-111111111111'
 WHERE `role` = 'admin'
   AND `permission_template_id` IS NULL;

-- ── 6. Verification ----------------------------------------------------------
SELECT 'permission_templates' AS object_name, COUNT(*) AS rows_present FROM `permission_templates`
UNION ALL
SELECT 'admins_without_template', COUNT(*) FROM `profiles` WHERE `role` = 'admin' AND `permission_template_id` IS NULL;
