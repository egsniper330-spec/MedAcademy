-- ===========================================================================
-- Migration 012 — CREATE the Credit Redeem Code system
-- MedAcademy — Phase 2 (Credit Redeem Code)
--
-- WHAT THIS CREATES
--   credit_redeem_codes — super admin mints a code carrying a credit amount;
--   a doctor redeems it and the amount is added to the doctor's EXISTING
--   credits balance through the standard credit architecture. The code is a
--   Credit top-up system ONLY: it never activates a course, never enrolls a
--   student and is never associated with a course or a student.
--
-- WHAT THIS ALSO DOES
--   Extends the audit_logs action CHECK with the three new audit actions:
--     redeem_code_created / redeem_code_redeemed / redeem_code_revoked
--   (Historical audit rows are untouched — this only widens the allowed set.)
--
-- WHAT THIS PRESERVES
--   * Additive only: no existing table, column or row is modified or deleted.
--   * credits / credit_transactions / enrollments / profiles / users: untouched.
--
-- IDEMPOTENCE / PARTIAL EXECUTION
--   The CREATE TABLE is IF NOT EXISTS. The CHECK extension uses
--   DROP CONSTRAINT IF EXISTS (MariaDB 10.3.1+) followed by ADD CONSTRAINT,
--   so the whole file is safe to rerun after any partial import.
--
-- REDUNDANT OBJECTS NOTE
--   No stored procedures, triggers, functions or events are created.
--   All status/expiry/assignment rules are enforced in the backend
--   (RedeemCodeController) inside a single transaction; the unique index on
--   `code` is the authoritative collision guard.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. credit_redeem_codes table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `credit_redeem_codes` (
  `id`                 CHAR(36) NOT NULL,
  `code`               VARCHAR(20) NOT NULL,
  `credit_amount`      INT UNSIGNED NOT NULL,
  `assigned_doctor_id` CHAR(36) NULL DEFAULT NULL,
  `status`             VARCHAR(16) DEFAULT 'unused' NOT NULL,
  `redeemed_by`        CHAR(36) NULL DEFAULT NULL,
  `redeemed_at`        DATETIME(6) NULL DEFAULT NULL,
  `created_by`         CHAR(36) NULL DEFAULT NULL,
  `created_at`         DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) NOT NULL,
  `expires_at`         DATETIME(6) NULL DEFAULT NULL,
  `revoked_at`         DATETIME(6) NULL DEFAULT NULL,
  `revoked_by`         CHAR(36) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_credit_redeem_codes_code` (`code`),
  KEY `idx_crc_status` (`status`),
  KEY `idx_crc_assigned_doctor` (`assigned_doctor_id`),
  KEY `idx_crc_redeemed_by` (`redeemed_by`),
  CONSTRAINT `fk_crc_assigned_doctor` FOREIGN KEY (`assigned_doctor_id`) REFERENCES `profiles` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_crc_redeemed_by`     FOREIGN KEY (`redeemed_by`)     REFERENCES `profiles` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_crc_created_by`      FOREIGN KEY (`created_by`)      REFERENCES `profiles` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_crc_revoked_by`      FOREIGN KEY (`revoked_by`)      REFERENCES `profiles` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_crc_amount_positive` CHECK (`credit_amount` > 0),
  CONSTRAINT `chk_crc_status` CHECK (`status` IN ('unused','redeemed','expired','revoked'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Credit Redeem Code — super admin mints, doctors redeem for credit top-up (credit top-up ONLY, never course activation)';

-- ---------------------------------------------------------------------------
-- 2. Extend the audit_logs action CHECK with the Redeem Code audit actions
--    (the previous action list is preserved verbatim — history stays valid)
-- ---------------------------------------------------------------------------
ALTER TABLE `audit_logs` DROP CONSTRAINT IF EXISTS `chk_audit_logs_action`;
ALTER TABLE `audit_logs` ADD CONSTRAINT `chk_audit_logs_action` CHECK (`action` IN ('login', 'logout', 'register', 'password_reset', 'course_created', 'course_updated', 'course_deleted', 'lesson_created', 'lesson_updated', 'lesson_deleted', 'video_uploaded', 'pdf_uploaded', 'pdf_deleted', 'credit_allocated', 'credit_consumed', 'credit_deducted', 'code_created', 'code_redeemed', 'code_deactivated', 'device_reset', 'device_force_logout', 'role_changed', 'permission_changed', 'user_suspended', 'user_activated', 'enrollment_created', 'security_event', 'initial_super_admin_created', 'password_changed', 'phone_login', 'user_searched', 'user_created', 'admin_created', 'super_admin_created', 'device_blocked', 'device_unblocked', 'device_registered', 'limit_changed', 'unlimited_enabled', 'unlimited_disabled', 'device_logout_all', 'device_revoked', 'user_deleted', 'student_created_by_doctor', 'student_bulk_imported', 'course_assigned_by_doctor', 'credit_consumed_by_doctor', 'temp_password_generated', 'password_changed_first_login', 'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected', 'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected', 'debug_detected', 'frida_detected', 'xposed_detected', 'app_integrity_compromised', 'security_policy_changed', 'user_trashed', 'user_restored', 'bulk_trash', 'bulk_restore', 'user_hard_deleted', 'bulk_permanent_delete', 'device_removed', 'undo_delete', 'trash_emptied', 'system_health_check', 'provider_changed', 'device_limit_changed', 'unlimited_devices_enabled', 'unlimited_devices_disabled', 'bulk_suspend', 'bulk_unsuspend', 'bulk_reset_devices', 'bulk_reset_password', 'account_restored', 'deletion_verification_failed', 'impersonation_started', 'impersonation_ended', 'code_deleted', 'video_play', 'video_play_failed', 'credit_refunded', 'credit_expired', 'subscription_created', 'subscription_removed', 'subscription_restored', 'profile_updated', 'avatar_updated', 'settings_changed', 'enrollment_created_by_admin', 'enrollment_removed_by_admin', 'enrollment_hidden_flag_set', 'enrollment_visibility_changed', 'account_permanently_deleted', 'platform_earnings_reset', 'doctor_approved', 'doctor_rejected', 'video_replaced', 'video_deleted', 'course_published', 'course_unpublished', 'category_created', 'category_updated', 'category_deleted', 'university_created', 'university_updated', 'university_deleted', 'notification_sent', 'admin_updated', 'admin_deleted', 'earnings_reset', 'activation_code_created', 'activation_code_used', 'course_archived', 'course_restored', 'course_price_changed', 'instructor_changed', 'thumbnail_changed', 'credits_added', 'credits_removed', 'enrollment_removed', 'password_reset_by_admin', 'email_changed', 'name_changed', 'avatar_changed', 'device_reset_by_admin', 'platform_settings_changed', 'code_activated', 'code_disabled', 'code_expired', 'custom_pricing_enabled', 'custom_pricing_disabled', 'earnings_settings_changed', 'revenue_settings_changed', 'update_earnings_settings', 'credit_price_changed', 'course_hidden', 'failed_login', 'session_revoked', 'bulk_device_reset', 'profile_name_changed', 'profile_avatar_changed', 'profile_email_changed', 'profile_phone_changed', 'doctor_created', 'role_changed_to_doctor', 'role_changed_to_admin', 'role_changed_to_super_admin', 'role_changed_to_student', 'password_changed_by_admin', 'user_blocked', 'user_unblocked', 'redeem_code_created', 'redeem_code_redeemed', 'redeem_code_revoked'));

-- Migration 012 complete.
