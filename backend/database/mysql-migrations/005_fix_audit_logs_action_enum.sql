-- ============================================================================
-- Migration 005: Fix audit_logs CHECK constraint (action enum)
-- ============================================================================
-- PROBLEM: saving a Doctor profile (name / email / phone / avatar) triggers
--   POST /admin/audit-logs  →  500
-- with the actions the frontend sends ('profile_name_changed',
-- 'profile_avatar_changed', 'profile_email_changed', 'profile_phone_changed').
-- The MySQL CHECK constraint chk_audit_logs_action allowed only ~103 of the
-- 157 values in the canonical PG enum `audit_action`, so the INSERT was
-- rejected (4025 CONSTRAINT ... failed) and audit logging 500'd.
--
-- THIS FILE IS 100% STATIC SQL. It contains ONLY direct ALTER TABLE
-- statements. There is NO information_schema, NO PREPARE, NO EXECUTE, no
-- dynamic SQL, no stored procedures, no metadata queries of any kind.
--
-- Target constraint: chk_audit_logs_action = CHECK (action IN (<all 157
-- canonical PG enum values, incl. profile_name_changed, profile_avatar_changed,
-- profile_email_changed, profile_phone_changed, doctor_created,
-- role_changed_to_doctor/admin/super_admin/student, device_blocked, ...)).
--
-- HOW TO USE:
--   * If the constraint exists (any values — proven by the live 500):
--       → import this file as-is. It drops and re-adds the constraint with the
--         full value list. Safe for any state where the constraint exists.
--   * If verification shows the constraint is ALREADY MISSING (a previous
--     partial import dropped it): run ONLY the ADD statement from BLOCK B.
--   * If verification shows the full 157-value list is already present:
--       → nothing to do.
--
-- No rows are modified. Only the CHECK constraint is replaced.
--
-- Compatibility: `ALTER TABLE ... DROP CONSTRAINT` is MariaDB syntax for CHECK
-- constraints (cPanel) and also works on MySQL 8.0.19+. On MySQL 8.0.16–8.0.18
-- use `DROP CHECK` instead of `DROP CONSTRAINT`.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK A — DROP the old constraint, then re-add it with the full values.
-- Run this whole block when the constraint still exists (any values).
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE `audit_logs` DROP CONSTRAINT `chk_audit_logs_action`;

ALTER TABLE `audit_logs` ADD CONSTRAINT `chk_audit_logs_action` CHECK (`action` IN ('login', 'logout', 'register', 'password_reset', 'course_created', 'course_updated', 'course_deleted', 'lesson_created', 'lesson_updated', 'lesson_deleted', 'video_uploaded', 'pdf_uploaded', 'pdf_deleted', 'credit_allocated', 'credit_consumed', 'credit_deducted', 'code_created', 'code_redeemed', 'code_deactivated', 'device_reset', 'device_force_logout', 'role_changed', 'permission_changed', 'user_suspended', 'user_activated', 'enrollment_created', 'security_event', 'initial_super_admin_created', 'password_changed', 'phone_login', 'user_searched', 'user_created', 'admin_created', 'super_admin_created', 'device_blocked', 'device_unblocked', 'device_registered', 'limit_changed', 'unlimited_enabled', 'unlimited_disabled', 'device_logout_all', 'device_revoked', 'user_deleted', 'student_created_by_doctor', 'student_bulk_imported', 'course_assigned_by_doctor', 'credit_consumed_by_doctor', 'temp_password_generated', 'password_changed_first_login', 'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected', 'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected', 'debug_detected', 'frida_detected', 'xposed_detected', 'app_integrity_compromised', 'security_policy_changed', 'user_trashed', 'user_restored', 'bulk_trash', 'bulk_restore', 'user_hard_deleted', 'bulk_permanent_delete', 'device_removed', 'undo_delete', 'trash_emptied', 'system_health_check', 'provider_changed', 'device_limit_changed', 'unlimited_devices_enabled', 'unlimited_devices_disabled', 'bulk_suspend', 'bulk_unsuspend', 'bulk_reset_devices', 'bulk_reset_password', 'account_restored', 'deletion_verification_failed', 'impersonation_started', 'impersonation_ended', 'code_deleted', 'video_play', 'video_play_failed', 'credit_refunded', 'credit_expired', 'subscription_created', 'subscription_removed', 'subscription_restored', 'profile_updated', 'avatar_updated', 'settings_changed', 'enrollment_created_by_admin', 'enrollment_removed_by_admin', 'enrollment_hidden_flag_set', 'enrollment_visibility_changed', 'account_permanently_deleted', 'platform_earnings_reset', 'doctor_approved', 'doctor_rejected', 'video_replaced', 'video_deleted', 'course_published', 'course_unpublished', 'category_created', 'category_updated', 'category_deleted', 'university_created', 'university_updated', 'university_deleted', 'notification_sent', 'admin_updated', 'admin_deleted', 'earnings_reset', 'activation_code_created', 'activation_code_used', 'course_archived', 'course_restored', 'course_price_changed', 'instructor_changed', 'thumbnail_changed', 'credits_added', 'credits_removed', 'enrollment_removed', 'password_reset_by_admin', 'email_changed', 'name_changed', 'avatar_changed', 'device_reset_by_admin', 'platform_settings_changed', 'code_activated', 'code_disabled', 'code_expired', 'custom_pricing_enabled', 'custom_pricing_disabled', 'earnings_settings_changed', 'revenue_settings_changed', 'update_earnings_settings', 'credit_price_changed', 'course_hidden', 'failed_login', 'session_revoked', 'bulk_device_reset', 'profile_name_changed', 'profile_avatar_changed', 'profile_email_changed', 'profile_phone_changed', 'doctor_created', 'role_changed_to_doctor', 'role_changed_to_admin', 'role_changed_to_super_admin', 'role_changed_to_student', 'password_changed_by_admin', 'user_blocked', 'user_unblocked'));


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK B — ADD-only fallback.
-- ONLY for the state where a previous partial import already dropped the
-- constraint. Run ONLY this line in that case (do NOT run Block A).
-- ════════════════════════════════════════════════════════════════════════════
-- ALTER TABLE `audit_logs` ADD CONSTRAINT `chk_audit_logs_action` CHECK (`action` IN ('login', 'logout', 'register', 'password_reset', 'course_created', 'course_updated', 'course_deleted', 'lesson_created', 'lesson_updated', 'lesson_deleted', 'video_uploaded', 'pdf_uploaded', 'pdf_deleted', 'credit_allocated', 'credit_consumed', 'credit_deducted', 'code_created', 'code_redeemed', 'code_deactivated', 'device_reset', 'device_force_logout', 'role_changed', 'permission_changed', 'user_suspended', 'user_activated', 'enrollment_created', 'security_event', 'initial_super_admin_created', 'password_changed', 'phone_login', 'user_searched', 'user_created', 'admin_created', 'super_admin_created', 'device_blocked', 'device_unblocked', 'device_registered', 'limit_changed', 'unlimited_enabled', 'unlimited_disabled', 'device_logout_all', 'device_revoked', 'user_deleted', 'student_created_by_doctor', 'student_bulk_imported', 'course_assigned_by_doctor', 'credit_consumed_by_doctor', 'temp_password_generated', 'password_changed_first_login', 'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected', 'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected', 'debug_detected', 'frida_detected', 'xposed_detected', 'app_integrity_compromised', 'security_policy_changed', 'user_trashed', 'user_restored', 'bulk_trash', 'bulk_restore', 'user_hard_deleted', 'bulk_permanent_delete', 'device_removed', 'undo_delete', 'trash_emptied', 'system_health_check', 'provider_changed', 'device_limit_changed', 'unlimited_devices_enabled', 'unlimited_devices_disabled', 'bulk_suspend', 'bulk_unsuspend', 'bulk_reset_devices', 'bulk_reset_password', 'account_restored', 'deletion_verification_failed', 'impersonation_started', 'impersonation_ended', 'code_deleted', 'video_play', 'video_play_failed', 'credit_refunded', 'credit_expired', 'subscription_created', 'subscription_removed', 'subscription_restored', 'profile_updated', 'avatar_updated', 'settings_changed', 'enrollment_created_by_admin', 'enrollment_removed_by_admin', 'enrollment_hidden_flag_set', 'enrollment_visibility_changed', 'account_permanently_deleted', 'platform_earnings_reset', 'doctor_approved', 'doctor_rejected', 'video_replaced', 'video_deleted', 'course_published', 'course_unpublished', 'category_created', 'category_updated', 'category_deleted', 'university_created', 'university_updated', 'university_deleted', 'notification_sent', 'admin_updated', 'admin_deleted', 'earnings_reset', 'activation_code_created', 'activation_code_used', 'course_archived', 'course_restored', 'course_price_changed', 'instructor_changed', 'thumbnail_changed', 'credits_added', 'credits_removed', 'enrollment_removed', 'password_reset_by_admin', 'email_changed', 'name_changed', 'avatar_changed', 'device_reset_by_admin', 'platform_settings_changed', 'code_activated', 'code_disabled', 'code_expired', 'custom_pricing_enabled', 'custom_pricing_disabled', 'earnings_settings_changed', 'revenue_settings_changed', 'update_earnings_settings', 'credit_price_changed', 'course_hidden', 'failed_login', 'session_revoked', 'bulk_device_reset', 'profile_name_changed', 'profile_avatar_changed', 'profile_email_changed', 'profile_phone_changed', 'doctor_created', 'role_changed_to_doctor', 'role_changed_to_admin', 'role_changed_to_super_admin', 'role_changed_to_student', 'password_changed_by_admin', 'user_blocked', 'user_unblocked'));
