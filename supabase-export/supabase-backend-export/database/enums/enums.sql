-- =============================================================================
-- MedAcademy — PostgreSQL Custom Enums
-- Schema: public
-- Generated: 2026-07-13
-- Total: 18 enum types
-- =============================================================================

CREATE TYPE public.activation_code_status AS ENUM (
  'active', 'used', 'expired', 'deactivated', 'disabled', 'deleted', 'reserved'
);

CREATE TYPE public.audit_action AS ENUM (
  'login','logout','register','password_reset',
  'course_created','course_updated','course_deleted',
  'lesson_created','lesson_updated','lesson_deleted',
  'video_uploaded','pdf_uploaded','pdf_deleted',
  'credit_allocated','credit_consumed','credit_deducted',
  'code_created','code_redeemed','code_deactivated',
  'device_reset','device_force_logout',
  'role_changed','permission_changed',
  'user_suspended','user_activated',
  'enrollment_created','security_event',
  'initial_super_admin_created','password_changed','phone_login',
  'user_searched','user_created','admin_created','super_admin_created',
  'device_blocked','device_unblocked','device_registered',
  'limit_changed','unlimited_enabled','unlimited_disabled',
  'device_logout_all','device_revoked','user_deleted',
  'student_created_by_doctor','student_bulk_imported',
  'course_assigned_by_doctor','credit_consumed_by_doctor',
  'temp_password_generated','password_changed_first_login',
  'root_detected','jailbreak_detected','vpn_detected','proxy_detected',
  'ssl_pinning_failure','screenshot_detected','screen_recording_detected',
  'debug_detected','frida_detected','xposed_detected','app_integrity_compromised',
  'security_policy_changed',
  'user_trashed','user_restored','bulk_trash','bulk_restore',
  'user_hard_deleted','bulk_permanent_delete',
  'device_removed','undo_delete','trash_emptied',
  'system_health_check','provider_changed',
  'device_limit_changed','unlimited_devices_enabled','unlimited_devices_disabled',
  'bulk_suspend','bulk_unsuspend','bulk_reset_devices',
  'bulk_reset_password','account_restored',
  'deletion_verification_failed',
  'impersonation_started','impersonation_ended',
  'code_deleted','video_play','video_play_failed',
  'credit_refunded','credit_expired',
  'subscription_created','subscription_removed','subscription_restored',
  'profile_updated','avatar_updated','settings_changed',
  'enrollment_created_by_admin','enrollment_removed_by_admin',
  'enrollment_hidden_flag_set','enrollment_visibility_changed',
  'account_permanently_deleted','platform_earnings_reset',
  'doctor_approved','doctor_rejected',
  'video_replaced','video_deleted','course_published','course_unpublished',
  'category_created','category_updated','category_deleted',
  'university_created','university_updated','university_deleted',
  'notification_sent','admin_updated','admin_deleted',
  'earnings_reset','activation_code_created','activation_code_used',
  'course_archived','course_restored','course_price_changed',
  'instructor_changed','thumbnail_changed',
  'credits_added','credits_removed','enrollment_removed',
  'password_reset_by_admin','email_changed','name_changed','avatar_changed',
  'device_reset_by_admin','platform_settings_changed',
  'code_activated','code_disabled','code_expired',
  'custom_pricing_enabled','custom_pricing_disabled',
  'earnings_settings_changed','revenue_settings_changed',
  'update_earnings_settings','credit_price_changed',
  'course_hidden','failed_login','session_revoked',
  'bulk_device_reset','profile_name_changed','profile_avatar_changed',
  'profile_email_changed','profile_phone_changed',
  'doctor_created','role_changed_to_doctor','role_changed_to_admin',
  'role_changed_to_super_admin','role_changed_to_student',
  'password_changed_by_admin','user_blocked','user_unblocked'
);

CREATE TYPE public.content_protection_action AS ENUM (
  'warn_only', 'strike_system', 'auto_logout', 'auto_suspend'
);

CREATE TYPE public.course_status AS ENUM (
  'draft', 'published', 'hidden', 'archived'
);

CREATE TYPE public.credit_transaction_type AS ENUM (
  'allocation', 'consumption', 'deduction', 'restoration',
  'expiry', 'adjustment', 'grant_super_admin', 'grant_admin', 'transfer'
);

CREATE TYPE public.device_status AS ENUM (
  'active', 'blocked', 'logged_out'
);

CREATE TYPE public.difficulty_level AS ENUM (
  'beginner', 'intermediate', 'advanced', 'all_levels'
);

CREATE TYPE public.download_permission AS ENUM (
  'allow', 'preview_only', 'hidden', 'disabled'
);

CREATE TYPE public.enrollment_visibility AS ENUM (
  'all', 'admin_only', 'super_admin_only'
);

CREATE TYPE public.lesson_status AS ENUM (
  'draft', 'published', 'hidden', 'scheduled', 'archived'
);

CREATE TYPE public.notification_type AS ENUM (
  'info', 'course', 'system', 'security',
  'admin_broadcast', 'announcement', 'maintenance', 'broadcast'
);

CREATE TYPE public.security_detection_type AS ENUM (
  'root_jailbreak', 'vpn', 'proxy', 'ssl_pinning', 'debug',
  'screenshot', 'screen_recording', 'app_integrity', 'developer_options',
  'frida', 'xposed', 'magisk', 'overlay', 'tamper', 'play_integrity'
);

CREATE TYPE public.security_event_type AS ENUM (
  'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected',
  'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected',
  'debug_detected', 'frida_detected', 'xposed_detected',
  'app_integrity_compromised', 'developer_options_enabled', 'adb_enabled',
  'debugger_attached', 'magisk_detected', 'overlay_detected',
  'signature_invalid', 'tamper_detected',
  'play_integrity_failed', 'play_integrity_passed'
);

CREATE TYPE public.security_policy_action AS ENUM (
  'log_only', 'warn_only', 'block_video', 'block_login'
);

CREATE TYPE public.strike_action AS ENUM (
  'warning', 'logout', 'suspend', 'ban'
);

CREATE TYPE public.user_role AS ENUM (
  'student', 'doctor', 'assistant', 'admin', 'super_admin'
);

CREATE TYPE public.user_status AS ENUM (
  'active', 'suspended', 'pending', 'deleted', 'trashed', 'blocked'
);

CREATE TYPE public.video_type AS ENUM (
  'vdocipher', 'coming_soon', 'youtube'
);

CREATE TYPE public.violation_type AS ENUM (
  'screenshot_detected', 'screen_recording_detected'
);
