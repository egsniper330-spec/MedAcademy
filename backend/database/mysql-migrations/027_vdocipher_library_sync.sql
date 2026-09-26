-- ============================================================================
-- Migration 027 — VdoCipher ↔ Video Library synchronization
-- ============================================================================
-- PURPOSE
--   VdoCipher is the remote source of truth for asset EXISTENCE. Dashboard
--   deletions never notify this app, so the library can serve stale entries.
--   This migration adds the persistent state the backend reconciliation
--   (POST /video/sync-library) writes and the audit actions it emits.
--
-- WHAT THIS CHANGES
--   1. video_assets.remote_synced_at   DATETIME(6) NULL
--        When the asset's existence was last confirmed against VdoCipher.
--   2. video_assets.remote_status      VARCHAR(32) NULL
--        Last verified remote existence: 'exists' | 'missing' | 'unknown'.
--        NULL = never verified (legacy rows / fresh uploads).
--        The local lifecycle status ('remotely_deleted') is carried by the
--        existing `status` column — no second competing state machine.
--   3. INDEX idx_video_assets_remote_sync (provider_video_id, remote_synced_at)
--        Duplication detection groups by provider_video_id (the canonical
--        identity); the composite keeps the reconcile queries covered.
--   4. audit actions appended to chk_audit_logs_action (superset — re-adding
--        cannot invalidate existing rows):
--          video_remote_sync, video_remote_missing, video_delete_requested,
--          video_remote_delete_succeeded, video_remote_delete_failed,
--          video_local_reconciled, video_duplicate_detected
--
-- WHY NO UNIQUE CONSTRAINT ON provider_video_id ALONE
--   The existing constraint `video_assets_doctor_provider_uniq` already makes
--   (doctor_id, provider_video_id) unique. A GLOBAL unique index on
--   provider_video_id is NOT added because a legacy row may legitimately share
--   a provider ID with an in-flight re-upload under a different doctor until
--   reconciled; forcing it now could block rows with existing duplicates on
--   production. Uniqueness across doctors is enforced by the sync service
--   (consolidation) and by the guarded INSERT paths — see syncLibrary().
--
-- IDEMPOTENCE / PARTIAL EXECUTION
--   * ADD COLUMN: if a previous run added a column already, the ADD fails
--     harmlessly at that statement; use BLOCK B for MariaDB < 10.0.2 or
--     already-applied columns (same convention as migration 006).
--   * The audit-actions statement is DROP+ADD (same pattern as migration 025).
--     If the constraint is already absent, use BLOCK D (ADD-only).
--
-- PRODUCTION DATA
--   Nothing is deleted, truncated or rewritten. New columns are nullable with
--   no defaults that would masquerade as verified state.
--
-- APPLY ON api.medacademy.site:
--   mysql -u <user> -p <db> < 027_vdocipher_library_sync.sql
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK A — normal case: add sync state columns + index
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE `video_assets`
  ADD COLUMN `remote_synced_at` DATETIME(6) NULL
    COMMENT 'Last time remote existence was confirmed against VdoCipher',
  ADD COLUMN `remote_status` VARCHAR(32) NULL
    COMMENT 'Last verified remote existence: exists | missing | unknown (NULL = never verified)';

CREATE INDEX `idx_video_assets_remote_sync`
  ON `video_assets` (`provider_video_id`, `remote_synced_at`);


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK B — fallback: run ONLY if BLOCK A failed because a column already exists
-- ════════════════════════════════════════════════════════════════════════════
-- ALTER TABLE `video_assets` ADD COLUMN `remote_synced_at` DATETIME(6) NULL;
-- ALTER TABLE `video_assets` ADD COLUMN `remote_status` VARCHAR(32) NULL;
-- CREATE INDEX `idx_video_assets_remote_sync` ON `video_assets` (`provider_video_id`, `remote_synced_at`);


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK C — normal case: extend the audit action CHECK (union superset)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE `audit_logs` DROP CONSTRAINT `chk_audit_logs_action`;

ALTER TABLE `audit_logs` ADD CONSTRAINT `chk_audit_logs_action` CHECK (`action` IN ('login', 'logout', 'register', 'password_reset', 'course_created', 'course_updated', 'course_deleted', 'lesson_created', 'lesson_updated', 'lesson_deleted', 'video_uploaded', 'pdf_uploaded', 'pdf_deleted', 'credit_allocated', 'credit_consumed', 'credit_deducted', 'code_created', 'code_redeemed', 'code_deactivated', 'device_reset', 'device_force_logout', 'role_changed', 'permission_changed', 'user_suspended', 'user_activated', 'enrollment_created', 'security_event', 'initial_super_admin_created', 'password_changed', 'phone_login', 'user_searched', 'user_created', 'admin_created', 'super_admin_created', 'device_blocked', 'device_unblocked', 'device_registered', 'limit_changed', 'unlimited_enabled', 'unlimited_disabled', 'device_logout_all', 'device_revoked', 'user_deleted', 'student_created_by_doctor', 'student_bulk_imported', 'course_assigned_by_doctor', 'credit_consumed_by_doctor', 'temp_password_generated', 'password_changed_first_login', 'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected', 'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected', 'debug_detected', 'frida_detected', 'xposed_detected', 'app_integrity_compromised', 'security_policy_changed', 'user_trashed', 'user_restored', 'bulk_trash', 'bulk_restore', 'user_hard_deleted', 'bulk_permanent_delete', 'device_removed', 'undo_delete', 'trash_emptied', 'system_health_check', 'provider_changed', 'device_limit_changed', 'unlimited_devices_enabled', 'unlimited_devices_disabled', 'bulk_suspend', 'bulk_unsuspend', 'bulk_reset_devices', 'bulk_reset_password', 'account_restored', 'deletion_verification_failed', 'impersonation_started', 'impersonation_ended', 'code_deleted', 'video_play', 'video_play_failed', 'credit_refunded', 'credit_expired', 'subscription_created', 'subscription_removed', 'subscription_restored', 'profile_updated', 'avatar_updated', 'settings_changed', 'enrollment_created_by_admin', 'enrollment_removed_by_admin', 'enrollment_hidden_flag_set', 'enrollment_visibility_changed', 'account_permanently_deleted', 'platform_earnings_reset', 'doctor_approved', 'doctor_rejected', 'video_replaced', 'video_deleted', 'course_published', 'course_unpublished', 'category_created', 'category_updated', 'category_deleted', 'university_created', 'university_updated', 'university_deleted', 'notification_sent', 'admin_updated', 'admin_deleted', 'earnings_reset', 'activation_code_created', 'activation_code_used', 'course_archived', 'course_restored', 'course_price_changed', 'instructor_changed', 'thumbnail_changed', 'credits_added', 'credits_removed', 'enrollment_removed', 'password_reset_by_admin', 'email_changed', 'name_changed', 'avatar_changed', 'device_reset_by_admin', 'platform_settings_changed', 'code_activated', 'code_disabled', 'code_expired', 'custom_pricing_enabled', 'custom_pricing_disabled', 'earnings_settings_changed', 'revenue_settings_changed', 'update_earnings_settings', 'credit_price_changed', 'course_hidden', 'failed_login', 'session_revoked', 'bulk_device_reset', 'profile_name_changed', 'profile_avatar_changed', 'profile_email_changed', 'profile_phone_changed', 'doctor_created', 'role_changed_to_doctor', 'role_changed_to_admin', 'role_changed_to_super_admin', 'role_changed_to_student', 'password_changed_by_admin', 'user_blocked', 'user_unblocked', 'admin_action', 'codes_batch_cloned', 'codes_batch_created', 'codes_bulk_deleted', 'codes_deactivated', 'codes_reactivated', 'orphan_video_cleanup', 'student_removed_from_course', 'redeem_code_created', 'redeem_code_redeemed', 'redeem_code_revoked', 'app_update_config_changed', 'video_provider_global_updated', 'video_provider_doctor_override_updated', 'feature_flag_override_updated', 'redeem_code_deleted', 'redeem_code_archived', 'video_remote_sync', 'video_remote_missing', 'video_delete_requested', 'video_remote_delete_succeeded', 'video_remote_delete_failed', 'video_local_reconciled', 'video_duplicate_detected'));


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK D — fallback: run ONLY if BLOCK C's DROP failed (constraint already absent)
-- ════════════════════════════════════════════════════════════════════════════
-- ALTER TABLE `audit_logs` ADD CONSTRAINT `chk_audit_logs_action` CHECK (`action` IN (…same list as BLOCK C…));
