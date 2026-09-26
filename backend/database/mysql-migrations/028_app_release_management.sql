-- ============================================================================
-- Migration 028 — App release management (production version lifecycle)
-- ============================================================================
-- PURPOSE
--   Separates "the version currently running in production" from "a release
--   the Super Admin is preparing". Drafts/ready rows NEVER affect production;
--   only an explicit publish (or rollback) does. Auto-increment is impossible:
--   nothing writes production state except publish()/rollback().
--
-- WHAT THIS CHANGES
--   1. New table app_releases — the release history per platform:
--        platform            android | ios
--        version             semantic version, canonical WITHOUT the v prefix
--                            (display adds it) — e.g. 1.1.0
--        android_version_code / ios_build_number
--                            developer-facing build numbers, SEPARATE from the
--                            semantic version (Expo: version vs versionCode /
--                            buildNumber). Never reset to zero by this system.
--        download_url        required before publish
--        status              draft | ready | published | archived
--        published_at/by     activation record (re-activation on rollback)
--   2. One-active-per-platform invariant: UNIQUE index over
--      (platform, status) WHERE status = 'published' — implemented as a
--      normal unique index on a generated marker column because MariaDB has
--      no partial indexes (same trick MySQL 8 uses for "unique nullable"):
--        active_marker = platform WHEN status='published' ELSE NULL
--      NULLs don't collide in unique indexes → drafts never conflict.
--   3. Initial production reset (per operator decision): one published
--      release per platform at v1.0.0 (build numbers 1) IF no production row
--      exists yet. Existing app_update_config rows are left untouched — the
--      migration never silently rewrites the live gate; publishing any future
--      release promotes its values through AppReleaseService.
--   4. Audit actions appended to chk_audit_logs_action (superset — re-adding
--      cannot invalidate existing rows): release_created, release_updated,
--      release_published, release_rollback, release_archived.
--
-- PRODUCTION DATA
--   Nothing is deleted. Existing releases (none — new table) are unaffected;
--   app_update_config is read, never written, by this migration.
--
-- APPLY ON api.medacademy.site:
--   mysql -u <user> -p <db> < 028_app_release_management.sql
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK A — normal case: table + invariant + initial production reset
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS `app_releases` (
  `id`                  CHAR(36) DEFAULT (UUID()) COMMENT 'pg_default: gen_random_uuid()',
  `platform`            VARCHAR(16) NOT NULL COMMENT 'android | ios',
  `version`             VARCHAR(32) NOT NULL COMMENT 'semantic version WITHOUT v prefix (display adds it)',
  `android_version_code` INT UNSIGNED NULL COMMENT 'developer-facing versionCode (separate concept from version)',
  `ios_build_number`    INT UNSIGNED NULL COMMENT 'developer-facing buildNumber (separate concept from version)',
  `download_url`        TEXT NULL COMMENT 'required before publish',
  `release_notes`       TEXT NULL,
  `status`              VARCHAR(16) NOT NULL DEFAULT 'draft' COMMENT 'draft | ready | published | archived',
  `published_at`        DATETIME(6) NULL,
  `published_by`        CHAR(36) NULL,
  `created_by`          CHAR(36) NULL,
  `created_at`          DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `active_marker`       VARCHAR(16) GENERATED ALWAYS AS
                        (CASE WHEN `status` = 'published' THEN `platform` ELSE NULL END) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_app_releases_one_active` (`active_marker`),
  KEY `idx_app_releases_platform_status` (`platform`, `status`),
  CONSTRAINT `chk_app_releases_platform`
    CHECK (`platform` IN ('android', 'ios')),
  CONSTRAINT `chk_app_releases_status`
    CHECK (`status` IN ('draft', 'ready', 'published', 'archived'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── Initial production reset: first official production release = v1.0.0 ──
-- Only inserted when the platform has NO release rows yet (fresh install or
-- first apply). The Super Admin's future publishes move production forward.
INSERT INTO `app_releases`
    (platform, version, android_version_code, ios_build_number, download_url,
     release_notes, status, published_at)
SELECT 'android', '1.0.0', 1, NULL,
       'https://medacademy.site/app/download', 'First official production release.',
       'published', UTC_TIMESTAMP(6)
WHERE NOT EXISTS (SELECT 1 FROM `app_releases` WHERE platform = 'android');

INSERT INTO `app_releases`
    (platform, version, android_version_code, ios_build_number, download_url,
     release_notes, status, published_at)
SELECT 'ios', '1.0.0', NULL, 1,
       'https://medacademy.site/app/download', 'First official production release.',
       'published', UTC_TIMESTAMP(6)
WHERE NOT EXISTS (SELECT 1 FROM `app_releases` WHERE platform = 'ios');


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK C — extend the audit action CHECK (union superset — same as 025/027)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE `audit_logs` DROP CONSTRAINT `chk_audit_logs_action`;

ALTER TABLE `audit_logs` ADD CONSTRAINT `chk_audit_logs_action` CHECK (`action` IN ('login', 'logout', 'register', 'password_reset', 'course_created', 'course_updated', 'course_deleted', 'lesson_created', 'lesson_updated', 'lesson_deleted', 'video_uploaded', 'pdf_uploaded', 'pdf_deleted', 'credit_allocated', 'credit_consumed', 'credit_deducted', 'code_created', 'code_redeemed', 'code_deactivated', 'device_reset', 'device_force_logout', 'role_changed', 'permission_changed', 'user_suspended', 'user_activated', 'enrollment_created', 'security_event', 'initial_super_admin_created', 'password_changed', 'phone_login', 'user_searched', 'user_created', 'admin_created', 'super_admin_created', 'device_blocked', 'device_unblocked', 'device_registered', 'limit_changed', 'unlimited_enabled', 'unlimited_disabled', 'device_logout_all', 'device_revoked', 'user_deleted', 'student_created_by_doctor', 'student_bulk_imported', 'course_assigned_by_doctor', 'credit_consumed_by_doctor', 'temp_password_generated', 'password_changed_first_login', 'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected', 'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected', 'debug_detected', 'frida_detected', 'xposed_detected', 'app_integrity_compromised', 'security_policy_changed', 'user_trashed', 'user_restored', 'bulk_trash', 'bulk_restore', 'user_hard_deleted', 'bulk_permanent_delete', 'device_removed', 'undo_delete', 'trash_emptied', 'system_health_check', 'provider_changed', 'device_limit_changed', 'unlimited_devices_enabled', 'unlimited_devices_disabled', 'bulk_suspend', 'bulk_unsuspend', 'bulk_reset_devices', 'bulk_reset_password', 'account_restored', 'deletion_verification_failed', 'impersonation_started', 'impersonation_ended', 'code_deleted', 'video_play', 'video_play_failed', 'credit_refunded', 'credit_expired', 'subscription_created', 'subscription_removed', 'subscription_restored', 'profile_updated', 'avatar_updated', 'settings_changed', 'enrollment_created_by_admin', 'enrollment_removed_by_admin', 'enrollment_hidden_flag_set', 'enrollment_visibility_changed', 'account_permanently_deleted', 'platform_earnings_reset', 'doctor_approved', 'doctor_rejected', 'video_replaced', 'video_deleted', 'course_published', 'course_unpublished', 'category_created', 'category_updated', 'category_deleted', 'university_created', 'university_updated', 'university_deleted', 'notification_sent', 'admin_updated', 'admin_deleted', 'earnings_reset', 'activation_code_created', 'activation_code_used', 'course_archived', 'course_restored', 'course_price_changed', 'instructor_changed', 'thumbnail_changed', 'credits_added', 'credits_removed', 'enrollment_removed', 'password_reset_by_admin', 'email_changed', 'name_changed', 'avatar_changed', 'device_reset_by_admin', 'platform_settings_changed', 'code_activated', 'code_disabled', 'code_expired', 'custom_pricing_enabled', 'custom_pricing_disabled', 'earnings_settings_changed', 'revenue_settings_changed', 'update_earnings_settings', 'credit_price_changed', 'course_hidden', 'failed_login', 'session_revoked', 'bulk_device_reset', 'profile_name_changed', 'profile_avatar_changed', 'profile_email_changed', 'profile_phone_changed', 'doctor_created', 'role_changed_to_doctor', 'role_changed_to_admin', 'role_changed_to_super_admin', 'role_changed_to_student', 'password_changed_by_admin', 'user_blocked', 'user_unblocked', 'admin_action', 'codes_batch_cloned', 'codes_batch_created', 'codes_bulk_deleted', 'codes_deactivated', 'codes_reactivated', 'orphan_video_cleanup', 'student_removed_from_course', 'redeem_code_created', 'redeem_code_redeemed', 'redeem_code_revoked', 'app_update_config_changed', 'video_provider_global_updated', 'video_provider_doctor_override_updated', 'feature_flag_override_updated', 'redeem_code_deleted', 'redeem_code_archived', 'video_remote_sync', 'video_remote_missing', 'video_delete_requested', 'video_remote_delete_succeeded', 'video_remote_delete_failed', 'video_local_reconciled', 'video_duplicate_detected', 'release_created', 'release_updated', 'release_published', 'release_rollback', 'release_archived'));
