-- ===========================================================================
-- Migration 021 — App Update Enforcement (remote version gate)
-- MedAcademy — App Updates (Super Admin managed)
--
-- WHAT THIS CREATES
--   app_update_config — one row per client platform ('android', 'ios').
--   The Super Admin "App Updates" screen edits it; GET /app/version serves the
--   active row for the requesting platform; AuthMiddleware enforces the
--   minimum-version floor on every authenticated route via HTTP 426.
--
-- DESIGN NOTES
--   * versionCode is the AUTHORITATIVE comparison value (integer). Version
--     names are informational (display on the update screen only).
--   * update_mode enum: FORCED | OPTIONAL. Current policy: FORCED.
--   * update_url is platform-agnostic: APK URL today, Play/App Store URL later.
--   * iOS-ready: insert an ios row; Android logic is untouched.
--   * is_enabled=false → /app/version returns enabled:false and the backend
--     floor is NOT enforced (kill switch without redeploying).
--
-- WHAT THIS PRESERVES
--   * Additive only: no existing table, column or row is modified or deleted.
--   * security_config (legacy semver-name based force-update config) is
--     UNTOUCHED and remains functional; the client prefers the new endpoint
--     when it responds.
--
-- IDEMPOTENCE / PARTIAL EXECUTION
--   CREATE TABLE IF NOT EXISTS + INSERT ... ON DUPLICATE KEY UPDATE make the
--   whole file safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS `app_update_config` (
  `platform`             VARCHAR(16)  NOT NULL COMMENT 'android | ios',
  `latest_version_name`  VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'informational (e.g. 1.0.850)',
  `latest_version_code`  INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'informational latest versionCode',
  `minimum_version_code` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'AUTHORITATIVE floor; below → blocked',
  `update_mode`          VARCHAR(16)  NOT NULL DEFAULT 'FORCED' COMMENT 'FORCED | OPTIONAL',
  `update_url`           TEXT         NOT NULL COMMENT 'APK URL, Play Store, App Store, any https destination',
  `release_notes`        TEXT         NULL,
  `is_enabled`           TINYINT(1)   NOT NULL DEFAULT 1,
  `updated_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by`           CHAR(36)     NULL,
  PRIMARY KEY (`platform`),
  CONSTRAINT `chk_app_update_config_platform`
    CHECK (`platform` IN ('android', 'ios')),
  CONSTRAINT `chk_app_update_config_mode`
    CHECK (`update_mode` IN ('FORCED', 'OPTIONAL')),
  CONSTRAINT `fk_app_update_config_updated_by`
    FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the android row (disabled by default so deployment never locks users
-- until the Super Admin reviews and enables it — flip is_enabled afterwards).
INSERT INTO `app_update_config` (`platform`, `latest_version_name`, `latest_version_code`, `minimum_version_code`, `update_mode`, `update_url`, `release_notes`, `is_enabled`)
VALUES ('android', '', 0, 0, 'FORCED', '', 'Initial configuration.', 0)
ON DUPLICATE KEY UPDATE `platform` = `platform`;

-- Seed the ios row for future-proofing (harmless until iOS ships).
INSERT INTO `app_update_config` (`platform`, `latest_version_name`, `latest_version_code`, `minimum_version_code`, `update_mode`, `update_url`, `release_notes`, `is_enabled`)
VALUES ('ios', '', 0, 0, 'FORCED', '', 'Initial configuration.', 0)
ON DUPLICATE KEY UPDATE `platform` = `platform`;

-- Extend the audit_logs action CHECK with the update-config audit action
-- (historical rows untouched; DROP IF EXISTS + ADD = safe to re-run).
ALTER TABLE `audit_logs` DROP CONSTRAINT IF EXISTS `chk_audit_logs_action`;
ALTER TABLE `audit_logs` ADD CONSTRAINT `chk_audit_logs_action` CHECK (`action` IN ('login', 'logout', 'register', 'password_reset', 'course_created', 'course_updated', 'course_deleted', 'lesson_created', 'lesson_updated', 'lesson_deleted', 'video_uploaded', 'pdf_uploaded', 'pdf_deleted', 'credit_allocated', 'credit_consumed', 'credit_deducted', 'code_created', 'code_redeemed', 'code_deactivated', 'device_reset', 'device_force_logout', 'role_changed', 'permission_changed', 'user_suspended', 'user_activated', 'enrollment_created', 'security_event', 'initial_super_admin_created', 'password_changed', 'phone_login', 'user_searched', 'user_created', 'admin_created', 'super_admin_created', 'device_blocked', 'device_unblocked', 'device_registered', 'limit_changed', 'unlimited_enabled', 'unlimited_disabled', 'device_logout_all', 'device_revoked', 'user_deleted', 'student_created_by_doctor', 'student_bulk_imported', 'course_assigned_by_doctor', 'credit_consumed_by_doctor', 'temp_password_generated', 'password_changed_first_login', 'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected', 'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected', 'debug_detected', 'frida_detected', 'xposed_detected', 'app_integrity_compromised', 'security_policy_changed', 'user_trashed', 'user_restored', 'bulk_trash', 'bulk_restore', 'user_hard_deleted', 'bulk_permanent_delete', 'device_removed', 'undo_delete', 'trash_emptied', 'system_health_check', 'provider_changed', 'device_limit_changed', 'unlimited_devices_enabled', 'unlimited_devices_disabled', 'bulk_suspend', 'bulk_unsuspend', 'bulk_reset_devices', 'bulk_reset_password', 'account_restored', 'deletion_verification_failed', 'impersonation_started', 'impersonation_ended', 'code_deleted', 'video_play', 'video_play_failed', 'credit_refunded', 'credit_expired', 'subscription_created', 'subscription_removed', 'subscription_restored', 'profile_updated', 'avatar_updated', 'settings_changed', 'enrollment_created_by_admin', 'enrollment_removed_by_admin', 'enrollment_hidden_flag_set', 'enrollment_visibility_changed', 'account_permanently_deleted', 'platform_earnings_reset', 'doctor_approved', 'doctor_rejected', 'video_replaced', 'video_deleted', 'course_published', 'course_unpublished', 'category_created', 'category_updated', 'category_deleted', 'university_created', 'university_updated', 'university_deleted', 'notification_sent', 'admin_updated', 'admin_deleted', 'earnings_reset', 'activation_code_created', 'activation_code_used', 'course_archived', 'course_restored', 'course_price_changed', 'instructor_changed', 'thumbnail_changed', 'credits_added', 'credits_removed', 'enrollment_removed', 'password_reset_by_admin', 'email_changed', 'name_changed', 'avatar_changed', 'device_reset_by_admin', 'platform_settings_changed', 'code_activated', 'code_disabled', 'code_expired', 'custom_pricing_enabled', 'custom_pricing_disabled', 'earnings_settings_changed', 'revenue_settings_changed', 'update_earnings_settings', 'credit_price_changed', 'course_hidden', 'failed_login', 'session_revoked', 'bulk_device_reset', 'profile_name_changed', 'profile_avatar_changed', 'profile_phone_changed', 'doctor_created', 'role_changed_to_doctor', 'role_changed_to_admin', 'role_changed_to_super_admin', 'role_changed_to_student', 'password_changed_by_admin', 'user_blocked', 'user_unblocked', 'redeem_code_created', 'redeem_code_redeemed', 'redeem_code_revoked', 'app_update_config_changed'));

-- Migration 021 complete.
