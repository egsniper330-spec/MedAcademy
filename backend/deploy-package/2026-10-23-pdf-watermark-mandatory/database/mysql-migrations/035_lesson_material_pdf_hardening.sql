-- ============================================================================
-- 035_lesson_material_pdf_hardening.sql
--
-- Personalized PDF watermarking became MANDATORY for students (delivery decides
-- from the caller's ROLE only). This migration adds the two pieces of plumbing
-- that change needs in the database. It changes NO policy by itself and deletes
-- nothing.
--
-- WHAT THIS ADDS
--   1. `lesson_materials.file_hash` / `file_hash_path` / `file_hash_size` /
--      `file_hash_mtime`
--      A cached sha256 of the CURRENT source PDF, together with the storage path,
--      byte size and modification time it belongs to. Delivery used to read and
--      hash the entire source file on EVERY open, only to compare it with the
--      copy registry. With this cache the hash is computed once per (path, size,
--      mtime); a replaced or re-uploaded file changes one of those and the digest
--      is recomputed, so a stale personalized copy can never be served. The mtime
--      matters because an in-place replacement with a same-length file (a
--      corrected export) would otherwise keep the old digest.
--      All four are NULLable: existing rows simply hash on first use.
--
--   2. Two `audit_logs` actions
--        material_pdf_delivered — one PDF delivery (ids + outcome only; no
--                                 student name, no token, no document bytes)
--        material_pdf_failed    — a personalized copy could not be produced
--                                 (the request was refused, never downgraded to
--                                 the unwatermarked original)
--      chk_audit_logs_action is dropped and re-added as a SUPERSET, exactly the
--      way 031 did it. No existing row can become invalid: every stored value
--      was legal under the previous constraint.
--
-- NOT CHANGED ON PURPOSE
--   * `lesson_materials.watermark_enabled` is NOT dropped. Its comment is
--     updated to say it is legacy and IGNORED by delivery; dropping a column is
--     a destructive change with no functional benefit, and an older app build
--     still reads it.
--   * No data is rewritten, moved or deleted.
--
-- HOW TO APPLY
--   phpMyAdmin -> select the MedAcademy database -> Import -> choose this file.
--   Run it ONCE, before uploading the matching backend code (the new code works
--   without it — it just hashes the source on every request — so the order is
--   not critical, only the speed differs).
--
--   Re-running reports these harmless "already applied" errors, which can be
--   ignored:
--     #1060 Duplicate column name 'file_hash' (and the other three)
--     #3820/#3821 the CHECK constraint already exists / was already dropped
-- ============================================================================

-- ── 1. Cached source hash (run each line once; skip #1060) ─────────────────
ALTER TABLE `lesson_materials`
  ADD COLUMN `file_hash` CHAR(64) NULL
  COMMENT 'sha256 of the current source file; cached so a delivery does not re-hash the whole PDF';

ALTER TABLE `lesson_materials`
  ADD COLUMN `file_hash_path` TEXT NULL
  COMMENT 'storage_path the cached file_hash belongs to; a different path invalidates the cache';

ALTER TABLE `lesson_materials`
  ADD COLUMN `file_hash_size` BIGINT NULL
  COMMENT 'byte size the cached file_hash belongs to; a different size invalidates the cache';

ALTER TABLE `lesson_materials`
  ADD COLUMN `file_hash_mtime` BIGINT NULL
  COMMENT 'unix mtime the cached file_hash belongs to; a same-size in-place replacement is still detected';

-- ── 2. Mark the legacy toggle as ignored (comment only, no data change) ────
ALTER TABLE `lesson_materials`
  MODIFY COLUMN `watermark_enabled` TINYINT(1) NOT NULL DEFAULT 0
  COMMENT 'LEGACY (migration 032): ignored by delivery — student copies are ALWAYS personalized';

-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK A — normal case: the constraint exists, replace it
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE `audit_logs` DROP CONSTRAINT `chk_audit_logs_action`;

ALTER TABLE `audit_logs` ADD CONSTRAINT `chk_audit_logs_action` CHECK (`action` IN ('login', 'logout', 'register', 'password_reset', 'course_created', 'course_updated', 'course_deleted', 'lesson_created', 'lesson_updated', 'lesson_deleted', 'video_uploaded', 'pdf_uploaded', 'pdf_deleted', 'credit_allocated', 'credit_consumed', 'credit_deducted', 'code_created', 'code_redeemed', 'code_deactivated', 'device_reset', 'device_force_logout', 'role_changed', 'permission_changed', 'user_suspended', 'user_activated', 'enrollment_created', 'security_event', 'initial_super_admin_created', 'password_changed', 'phone_login', 'user_searched', 'user_created', 'admin_created', 'super_admin_created', 'device_blocked', 'device_unblocked', 'device_registered', 'limit_changed', 'unlimited_enabled', 'unlimited_disabled', 'device_logout_all', 'device_revoked', 'user_deleted', 'student_created_by_doctor', 'student_bulk_imported', 'course_assigned_by_doctor', 'credit_consumed_by_doctor', 'temp_password_generated', 'password_changed_first_login', 'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected', 'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected', 'debug_detected', 'frida_detected', 'xposed_detected', 'app_integrity_compromised', 'security_policy_changed', 'user_trashed', 'user_restored', 'bulk_trash', 'bulk_restore', 'user_hard_deleted', 'bulk_permanent_delete', 'device_removed', 'undo_delete', 'trash_emptied', 'system_health_check', 'provider_changed', 'device_limit_changed', 'unlimited_devices_enabled', 'unlimited_devices_disabled', 'bulk_suspend', 'bulk_unsuspend', 'bulk_reset_devices', 'bulk_reset_password', 'account_restored', 'deletion_verification_failed', 'impersonation_started', 'impersonation_ended', 'code_deleted', 'video_play', 'video_play_failed', 'credit_refunded', 'credit_expired', 'subscription_created', 'subscription_removed', 'subscription_restored', 'profile_updated', 'avatar_updated', 'settings_changed', 'enrollment_created_by_admin', 'enrollment_removed_by_admin', 'enrollment_hidden_flag_set', 'enrollment_visibility_changed', 'account_permanently_deleted', 'platform_earnings_reset', 'doctor_approved', 'doctor_rejected', 'video_replaced', 'video_deleted', 'course_published', 'course_unpublished', 'category_created', 'category_updated', 'category_deleted', 'university_created', 'university_updated', 'university_deleted', 'notification_sent', 'admin_updated', 'admin_deleted', 'earnings_reset', 'activation_code_created', 'activation_code_used', 'course_archived', 'course_restored', 'course_price_changed', 'instructor_changed', 'thumbnail_changed', 'credits_added', 'credits_removed', 'enrollment_removed', 'password_reset_by_admin', 'email_changed', 'name_changed', 'avatar_changed', 'device_reset_by_admin', 'platform_settings_changed', 'code_activated', 'code_disabled', 'code_expired', 'custom_pricing_enabled', 'custom_pricing_disabled', 'earnings_settings_changed', 'revenue_settings_changed', 'update_earnings_settings', 'credit_price_changed', 'course_hidden', 'failed_login', 'session_revoked', 'bulk_device_reset', 'profile_name_changed', 'profile_avatar_changed', 'profile_email_changed', 'profile_phone_changed', 'doctor_created', 'role_changed_to_doctor', 'role_changed_to_admin', 'role_changed_to_super_admin', 'role_changed_to_student', 'password_changed_by_admin', 'user_blocked', 'user_unblocked', 'admin_action', 'codes_batch_cloned', 'codes_batch_created', 'codes_bulk_deleted', 'codes_deactivated', 'codes_reactivated', 'orphan_video_cleanup', 'student_removed_from_course', 'redeem_code_created', 'redeem_code_redeemed', 'redeem_code_revoked', 'app_update_config_changed', 'video_provider_global_updated', 'video_provider_doctor_override_updated', 'feature_flag_override_updated', 'redeem_code_deleted', 'redeem_code_archived', 'video_remote_sync', 'video_remote_missing', 'video_delete_requested', 'video_remote_delete_succeeded', 'video_remote_delete_failed', 'video_local_reconciled', 'video_duplicate_detected', 'release_created', 'release_updated', 'release_published', 'release_rollback', 'release_archived', 'impersonation_failed', 'data_exported', 'students_bulk_action', 'security_policy_update', 'security_vpn_whitelist_add', 'security_vpn_whitelist_remove', 'patch_uploaded', 'vdocipher_delete_failed', 'vdoapi_curl_error', 'material_pdf_delivered', 'material_pdf_failed'));

-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK B — ONLY if BLOCK A's DROP failed because the constraint was already
-- absent (a previous partial import). Run this block alone in that case.
-- ════════════════════════════════════════════════════════════════════════════
-- ALTER TABLE `audit_logs` ADD CONSTRAINT `chk_audit_logs_action` CHECK (`action` IN ('login', 'logout', 'register', 'password_reset', 'course_created', 'course_updated', 'course_deleted', 'lesson_created', 'lesson_updated', 'lesson_deleted', 'video_uploaded', 'pdf_uploaded', 'pdf_deleted', 'credit_allocated', 'credit_consumed', 'credit_deducted', 'code_created', 'code_redeemed', 'code_deactivated', 'device_reset', 'device_force_logout', 'role_changed', 'permission_changed', 'user_suspended', 'user_activated', 'enrollment_created', 'security_event', 'initial_super_admin_created', 'password_changed', 'phone_login', 'user_searched', 'user_created', 'admin_created', 'super_admin_created', 'device_blocked', 'device_unblocked', 'device_registered', 'limit_changed', 'unlimited_enabled', 'unlimited_disabled', 'device_logout_all', 'device_revoked', 'user_deleted', 'student_created_by_doctor', 'student_bulk_imported', 'course_assigned_by_doctor', 'credit_consumed_by_doctor', 'temp_password_generated', 'password_changed_first_login', 'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected', 'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected', 'debug_detected', 'frida_detected', 'xposed_detected', 'app_integrity_compromised', 'security_policy_changed', 'user_trashed', 'user_restored', 'bulk_trash', 'bulk_restore', 'user_hard_deleted', 'bulk_permanent_delete', 'device_removed', 'undo_delete', 'trash_emptied', 'system_health_check', 'provider_changed', 'device_limit_changed', 'unlimited_devices_enabled', 'unlimited_devices_disabled', 'bulk_suspend', 'bulk_unsuspend', 'bulk_reset_devices', 'bulk_reset_password', 'account_restored', 'deletion_verification_failed', 'impersonation_started', 'impersonation_ended', 'code_deleted', 'video_play', 'video_play_failed', 'credit_refunded', 'credit_expired', 'subscription_created', 'subscription_removed', 'subscription_restored', 'profile_updated', 'avatar_updated', 'settings_changed', 'enrollment_created_by_admin', 'enrollment_removed_by_admin', 'enrollment_hidden_flag_set', 'enrollment_visibility_changed', 'account_permanently_deleted', 'platform_earnings_reset', 'doctor_approved', 'doctor_rejected', 'video_replaced', 'video_deleted', 'course_published', 'course_unpublished', 'category_created', 'category_updated', 'category_deleted', 'university_created', 'university_updated', 'university_deleted', 'notification_sent', 'admin_updated', 'admin_deleted', 'earnings_reset', 'activation_code_created', 'activation_code_used', 'course_archived', 'course_restored', 'course_price_changed', 'instructor_changed', 'thumbnail_changed', 'credits_added', 'credits_removed', 'enrollment_removed', 'password_reset_by_admin', 'email_changed', 'name_changed', 'avatar_changed', 'device_reset_by_admin', 'platform_settings_changed', 'code_activated', 'code_disabled', 'code_expired', 'custom_pricing_enabled', 'custom_pricing_disabled', 'earnings_settings_changed', 'revenue_settings_changed', 'update_earnings_settings', 'credit_price_changed', 'course_hidden', 'failed_login', 'session_revoked', 'bulk_device_reset', 'profile_name_changed', 'profile_avatar_changed', 'profile_email_changed', 'profile_phone_changed', 'doctor_created', 'role_changed_to_doctor', 'role_changed_to_admin', 'role_changed_to_super_admin', 'role_changed_to_student', 'password_changed_by_admin', 'user_blocked', 'user_unblocked', 'admin_action', 'codes_batch_cloned', 'codes_batch_created', 'codes_bulk_deleted', 'codes_deactivated', 'codes_reactivated', 'orphan_video_cleanup', 'student_removed_from_course', 'redeem_code_created', 'redeem_code_redeemed', 'redeem_code_revoked', 'app_update_config_changed', 'video_provider_global_updated', 'video_provider_doctor_override_updated', 'feature_flag_override_updated', 'redeem_code_deleted', 'redeem_code_archived', 'video_remote_sync', 'video_remote_missing', 'video_delete_requested', 'video_remote_delete_succeeded', 'video_remote_delete_failed', 'video_local_reconciled', 'video_duplicate_detected', 'release_created', 'release_updated', 'release_published', 'release_rollback', 'release_archived', 'impersonation_failed', 'data_exported', 'students_bulk_action', 'security_policy_update', 'security_vpn_whitelist_add', 'security_vpn_whitelist_remove', 'patch_uploaded', 'vdocipher_delete_failed', 'vdoapi_curl_error', 'material_pdf_delivered', 'material_pdf_failed'));
