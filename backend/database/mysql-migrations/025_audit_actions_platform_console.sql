-- ============================================================================
-- Migration 025 — Audit actions for the Super Admin Platform Control Center
-- ============================================================================
-- ROOT CAUSE OF THE REPORTED "Internal server error" (Video Providers screen):
--
--   `audit_logs`.`action` carries the CHECK constraint `chk_audit_logs_action`,
--   which enumerates every legal action value. Application code writes actions
--   that are MISSING from that enumeration, so AuditService::write() raises:
--
--       ERROR 3819 (HY000): Check constraint 'chk_audit_logs_action' is violated
--
--   AuditService has no try/catch and the API maps the uncaught PDOException to
--   HTTP 500 "Internal server error".
--
--   Missing actions (found by scanning EVERY `AuditService::write(` call site in
--   src/ against the union of all published constraint versions):
--
--     1. video_provider_global_updated            VideoProviderController::setGlobal
--     2. video_provider_doctor_override_updated   VideoProviderController::setTeacher
--                                                 (+ RpcController legacy path)
--     3. feature_flag_override_updated            PlatformController override write
--     4. redeem_code_deleted                      RedeemCodeController (pre-existing)
--     5. redeem_code_archived                     RedeemCodeController (pre-existing)
--
--   Console symptom this explains exactly: GET reads keep working (index() writes
--   no audit row) while every WRITE fails — so the Video Providers page loads,
--   but toggling a global provider or saving a doctor override returns 500 and
--   the optimistic UI reverts, which reads as "expanding the doctor does nothing".
--
-- WHAT THIS CHANGES
--   * Dropped and re-added constraint `chk_audit_logs_action` with the COMPLETE
--     action list: the union of every previously published version
--     (schema.sql 160 + migrations 005/006/012/021) plus the five actions above.
--     174 actions total.
--   * Nothing else: no table, column, index, row or trigger is modified.
--
-- PRODUCTION DATA
--   No data is deleted, truncated or rewritten. Every existing audit row is by
--   definition already legal (an illegal value could never have been inserted),
--   so re-adding a SUPERSET constraint cannot invalidate existing data.
--
-- IDEMPOTENCE / PARTIAL EXECUTION
--   `DROP CONSTRAINT` fails if the constraint is already absent. Use BLOCK B
--   (ADD-only) in that case — the same convention documented by migration 006.
--
-- APPLY ON api.medacademy.site:
--   mysql -u <user> -p <db> < 025_audit_actions_platform_console.sql
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK A — normal case: constraint exists, replace it
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE `audit_logs` DROP CONSTRAINT `chk_audit_logs_action`;

ALTER TABLE `audit_logs` ADD CONSTRAINT `chk_audit_logs_action` CHECK (`action` IN ('login', 'logout', 'register', 'password_reset', 'course_created', 'course_updated', 'course_deleted', 'lesson_created', 'lesson_updated', 'lesson_deleted', 'video_uploaded', 'pdf_uploaded', 'pdf_deleted', 'credit_allocated', 'credit_consumed', 'credit_deducted', 'code_created', 'code_redeemed', 'code_deactivated', 'device_reset', 'device_force_logout', 'role_changed', 'permission_changed', 'user_suspended', 'user_activated', 'enrollment_created', 'security_event', 'initial_super_admin_created', 'password_changed', 'phone_login', 'user_searched', 'user_created', 'admin_created', 'super_admin_created', 'device_blocked', 'device_unblocked', 'device_registered', 'limit_changed', 'unlimited_enabled', 'unlimited_disabled', 'device_logout_all', 'device_revoked', 'user_deleted', 'student_created_by_doctor', 'student_bulk_imported', 'course_assigned_by_doctor', 'credit_consumed_by_doctor', 'temp_password_generated', 'password_changed_first_login', 'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected', 'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected', 'debug_detected', 'frida_detected', 'xposed_detected', 'app_integrity_compromised', 'security_policy_changed', 'user_trashed', 'user_restored', 'bulk_trash', 'bulk_restore', 'user_hard_deleted', 'bulk_permanent_delete', 'device_removed', 'undo_delete', 'trash_emptied', 'system_health_check', 'provider_changed', 'device_limit_changed', 'unlimited_devices_enabled', 'unlimited_devices_disabled', 'bulk_suspend', 'bulk_unsuspend', 'bulk_reset_devices', 'bulk_reset_password', 'account_restored', 'deletion_verification_failed', 'impersonation_started', 'impersonation_ended', 'code_deleted', 'video_play', 'video_play_failed', 'credit_refunded', 'credit_expired', 'subscription_created', 'subscription_removed', 'subscription_restored', 'profile_updated', 'avatar_updated', 'settings_changed', 'enrollment_created_by_admin', 'enrollment_removed_by_admin', 'enrollment_hidden_flag_set', 'enrollment_visibility_changed', 'account_permanently_deleted', 'platform_earnings_reset', 'doctor_approved', 'doctor_rejected', 'video_replaced', 'video_deleted', 'course_published', 'course_unpublished', 'category_created', 'category_updated', 'category_deleted', 'university_created', 'university_updated', 'university_deleted', 'notification_sent', 'admin_updated', 'admin_deleted', 'earnings_reset', 'activation_code_created', 'activation_code_used', 'course_archived', 'course_restored', 'course_price_changed', 'instructor_changed', 'thumbnail_changed', 'credits_added', 'credits_removed', 'enrollment_removed', 'password_reset_by_admin', 'email_changed', 'name_changed', 'avatar_changed', 'device_reset_by_admin', 'platform_settings_changed', 'code_activated', 'code_disabled', 'code_expired', 'custom_pricing_enabled', 'custom_pricing_disabled', 'earnings_settings_changed', 'revenue_settings_changed', 'update_earnings_settings', 'credit_price_changed', 'course_hidden', 'failed_login', 'session_revoked', 'bulk_device_reset', 'profile_name_changed', 'profile_avatar_changed', 'profile_email_changed', 'profile_phone_changed', 'doctor_created', 'role_changed_to_doctor', 'role_changed_to_admin', 'role_changed_to_super_admin', 'role_changed_to_student', 'password_changed_by_admin', 'user_blocked', 'user_unblocked', 'admin_action', 'codes_batch_cloned', 'codes_batch_created', 'codes_bulk_deleted', 'codes_deactivated', 'codes_reactivated', 'orphan_video_cleanup', 'student_removed_from_course', 'redeem_code_created', 'redeem_code_redeemed', 'redeem_code_revoked', 'app_update_config_changed', 'video_provider_global_updated', 'video_provider_doctor_override_updated', 'feature_flag_override_updated', 'redeem_code_deleted', 'redeem_code_archived'));


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK B — fallback: run ONLY if BLOCK A's DROP failed (constraint already absent)
-- ════════════════════════════════════════════════════════════════════════════
-- ALTER TABLE `audit_logs` ADD CONSTRAINT `chk_audit_logs_action` CHECK (`action` IN ('login', 'logout', 'register', 'password_reset', 'course_created', 'course_updated', 'course_deleted', 'lesson_created', 'lesson_updated', 'lesson_deleted', 'video_uploaded', 'pdf_uploaded', 'pdf_deleted', 'credit_allocated', 'credit_consumed', 'credit_deducted', 'code_created', 'code_redeemed', 'code_deactivated', 'device_reset', 'device_force_logout', 'role_changed', 'permission_changed', 'user_suspended', 'user_activated', 'enrollment_created', 'security_event', 'initial_super_admin_created', 'password_changed', 'phone_login', 'user_searched', 'user_created', 'admin_created', 'super_admin_created', 'device_blocked', 'device_unblocked', 'device_registered', 'limit_changed', 'unlimited_enabled', 'unlimited_disabled', 'device_logout_all', 'device_revoked', 'user_deleted', 'student_created_by_doctor', 'student_bulk_imported', 'course_assigned_by_doctor', 'credit_consumed_by_doctor', 'temp_password_generated', 'password_changed_first_login', 'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected', 'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected', 'debug_detected', 'frida_detected', 'xposed_detected', 'app_integrity_compromised', 'security_policy_changed', 'user_trashed', 'user_restored', 'bulk_trash', 'bulk_restore', 'user_hard_deleted', 'bulk_permanent_delete', 'device_removed', 'undo_delete', 'trash_emptied', 'system_health_check', 'provider_changed', 'device_limit_changed', 'unlimited_devices_enabled', 'unlimited_devices_disabled', 'bulk_suspend', 'bulk_unsuspend', 'bulk_reset_devices', 'bulk_reset_password', 'account_restored', 'deletion_verification_failed', 'impersonation_started', 'impersonation_ended', 'code_deleted', 'video_play', 'video_play_failed', 'credit_refunded', 'credit_expired', 'subscription_created', 'subscription_removed', 'subscription_restored', 'profile_updated', 'avatar_updated', 'settings_changed', 'enrollment_created_by_admin', 'enrollment_removed_by_admin', 'enrollment_hidden_flag_set', 'enrollment_visibility_changed', 'account_permanently_deleted', 'platform_earnings_reset', 'doctor_approved', 'doctor_rejected', 'video_replaced', 'video_deleted', 'course_published', 'course_unpublished', 'category_created', 'category_updated', 'category_deleted', 'university_created', 'university_updated', 'university_deleted', 'notification_sent', 'admin_updated', 'admin_deleted', 'earnings_reset', 'activation_code_created', 'activation_code_used', 'course_archived', 'course_restored', 'course_price_changed', 'instructor_changed', 'thumbnail_changed', 'credits_added', 'credits_removed', 'enrollment_removed', 'password_reset_by_admin', 'email_changed', 'name_changed', 'avatar_changed', 'device_reset_by_admin', 'platform_settings_changed', 'code_activated', 'code_disabled', 'code_expired', 'custom_pricing_enabled', 'custom_pricing_disabled', 'earnings_settings_changed', 'revenue_settings_changed', 'update_earnings_settings', 'credit_price_changed', 'course_hidden', 'failed_login', 'session_revoked', 'bulk_device_reset', 'profile_name_changed', 'profile_avatar_changed', 'profile_email_changed', 'profile_phone_changed', 'doctor_created', 'role_changed_to_doctor', 'role_changed_to_admin', 'role_changed_to_super_admin', 'role_changed_to_student', 'password_changed_by_admin', 'user_blocked', 'user_unblocked', 'admin_action', 'codes_batch_cloned', 'codes_batch_created', 'codes_bulk_deleted', 'codes_deactivated', 'codes_reactivated', 'orphan_video_cleanup', 'student_removed_from_course', 'redeem_code_created', 'redeem_code_redeemed', 'redeem_code_revoked', 'app_update_config_changed', 'video_provider_global_updated', 'video_provider_doctor_override_updated', 'feature_flag_override_updated', 'redeem_code_deleted', 'redeem_code_archived'));
