/**
 * ════════════════════════════════════════════════════════════════════════════
 * SHARED ENUM CONSTANTS — Backend (Deno Edge Functions)
 * ════════════════════════════════════════════════════════════════════════════
 * Single source of truth for all PostgreSQL enum values used in Edge Functions.
 * NEVER write raw enum strings in EF code — always import from this file.
 *
 * Mirror: src/lib/enums.ts (frontend copy — must stay in sync)
 * DB:     public schema pg_enum values
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── user_status ───────────────────────────────────────────────────────────────
export const UserStatus = {
  ACTIVE:    'active',
  SUSPENDED: 'suspended',
  PENDING:   'pending',
  DELETED:   'deleted',
  TRASHED:   'trashed',
} as const;
export type UserStatus = typeof UserStatus[keyof typeof UserStatus];

// ── user_role ─────────────────────────────────────────────────────────────────
export const UserRole = {
  STUDENT:     'student',
  DOCTOR:      'doctor',
  ASSISTANT:   'assistant',
  ADMIN:       'admin',
  SUPER_ADMIN: 'super_admin',
} as const;
export type UserRole = typeof UserRole[keyof typeof UserRole];

// ── course_status ─────────────────────────────────────────────────────────────
export const CourseStatus = {
  DRAFT:     'draft',
  PUBLISHED: 'published',
  HIDDEN:    'hidden',
  ARCHIVED:  'archived',
} as const;
export type CourseStatus = typeof CourseStatus[keyof typeof CourseStatus];

// ── lesson_status ─────────────────────────────────────────────────────────────
export const LessonStatus = {
  DRAFT:     'draft',
  PUBLISHED: 'published',
  HIDDEN:    'hidden',
  SCHEDULED: 'scheduled',
  ARCHIVED:  'archived',
} as const;
export type LessonStatus = typeof LessonStatus[keyof typeof LessonStatus];

// ── device_status ─────────────────────────────────────────────────────────────
export const DeviceStatus = {
  ACTIVE:     'active',
  BLOCKED:    'blocked',
  LOGGED_OUT: 'logged_out',
} as const;
export type DeviceStatus = typeof DeviceStatus[keyof typeof DeviceStatus];

// ── video_type ────────────────────────────────────────────────────────────────
export const VideoType = {
  VDOCIPHER:   'vdocipher',
  EXTERNAL:    'external',
  YOUTUBE:     'youtube',
  COMING_SOON: 'coming_soon',
} as const;
export type VideoType = typeof VideoType[keyof typeof VideoType];

// ── notification_type ─────────────────────────────────────────────────────────
export const NotificationType = {
  INFO:            'info',
  COURSE:          'course',
  SYSTEM:          'system',
  SECURITY:        'security',
  ADMIN_BROADCAST: 'admin_broadcast',
  ANNOUNCEMENT:    'announcement',
  MAINTENANCE:     'maintenance',
  BROADCAST:       'broadcast',
} as const;
export type NotificationType = typeof NotificationType[keyof typeof NotificationType];

// ── credit_transaction_type ───────────────────────────────────────────────────
export const CreditTransactionType = {
  ALLOCATION:        'allocation',
  CONSUMPTION:       'consumption',
  DEDUCTION:         'deduction',
  RESTORATION:       'restoration',
  EXPIRY:            'expiry',
  ADJUSTMENT:        'adjustment',
  GRANT_SUPER_ADMIN: 'grant_super_admin',
  GRANT_ADMIN:       'grant_admin',
  TRANSFER:          'transfer',
} as const;
export type CreditTransactionType = typeof CreditTransactionType[keyof typeof CreditTransactionType];

// ── activation_code_status ────────────────────────────────────────────────────
export const ActivationCodeStatus = {
  ACTIVE:      'active',
  USED:        'used',
  EXPIRED:     'expired',
  DEACTIVATED: 'deactivated',
  DISABLED:    'disabled',
  DELETED:     'deleted',
  RESERVED:    'reserved',
} as const;
export type ActivationCodeStatus = typeof ActivationCodeStatus[keyof typeof ActivationCodeStatus];

// ── difficulty_level ──────────────────────────────────────────────────────────
export const DifficultyLevel = {
  BEGINNER:     'beginner',
  INTERMEDIATE: 'intermediate',
  ADVANCED:     'advanced',
  ALL_LEVELS:   'all_levels',
} as const;
export type DifficultyLevel = typeof DifficultyLevel[keyof typeof DifficultyLevel];

// ── download_permission ───────────────────────────────────────────────────────
export const DownloadPermission = {
  ALLOW:        'allow',
  PREVIEW_ONLY: 'preview_only',
  HIDDEN:       'hidden',
  DISABLED:     'disabled',
} as const;
export type DownloadPermission = typeof DownloadPermission[keyof typeof DownloadPermission];

// ── security_event_type ───────────────────────────────────────────────────────
export const SecurityEventType = {
  ROOT_DETECTED:              'root_detected',
  JAILBREAK_DETECTED:         'jailbreak_detected',
  VPN_DETECTED:               'vpn_detected',
  PROXY_DETECTED:             'proxy_detected',
  SSL_PINNING_FAILURE:        'ssl_pinning_failure',
  SCREENSHOT_DETECTED:        'screenshot_detected',
  SCREEN_RECORDING_DETECTED:  'screen_recording_detected',
  DEBUG_DETECTED:             'debug_detected',
  FRIDA_DETECTED:             'frida_detected',
  XPOSED_DETECTED:            'xposed_detected',
  APP_INTEGRITY_COMPROMISED:  'app_integrity_compromised',
} as const;
export type SecurityEventType = typeof SecurityEventType[keyof typeof SecurityEventType];

// ── content_protection_action ─────────────────────────────────────────────────
export const ContentProtectionAction = {
  WARN_ONLY:     'warn_only',
  STRIKE_SYSTEM: 'strike_system',
  AUTO_LOGOUT:   'auto_logout',
  AUTO_SUSPEND:  'auto_suspend',
} as const;
export type ContentProtectionAction = typeof ContentProtectionAction[keyof typeof ContentProtectionAction];

// ── security_policy_action ────────────────────────────────────────────────────
export const SecurityPolicyAction = {
  LOG_ONLY:    'log_only',
  WARN_ONLY:   'warn_only',
  BLOCK_VIDEO: 'block_video',
  BLOCK_LOGIN: 'block_login',
} as const;
export type SecurityPolicyAction = typeof SecurityPolicyAction[keyof typeof SecurityPolicyAction];

// ── strike_action ─────────────────────────────────────────────────────────────
export const StrikeAction = {
  WARNING: 'warning',
  LOGOUT:  'logout',
  SUSPEND: 'suspend',
  BAN:     'ban',
} as const;
export type StrikeAction = typeof StrikeAction[keyof typeof StrikeAction];

// ── violation_type ────────────────────────────────────────────────────────────
export const ViolationType = {
  SCREENSHOT_DETECTED:       'screenshot_detected',
  SCREEN_RECORDING_DETECTED: 'screen_recording_detected',
} as const;
export type ViolationType = typeof ViolationType[keyof typeof ViolationType];

// ── audit_action (complete — 94 values as of v76) ────────────────────────────
export const AuditAction = {
  // Auth
  LOGIN:                       'login',
  LOGOUT:                      'logout',
  REGISTER:                    'register',
  PASSWORD_RESET:              'password_reset',
  PASSWORD_CHANGED:            'password_changed',
  PASSWORD_CHANGED_FIRST_LOGIN:'password_changed_first_login',
  PHONE_LOGIN:                 'phone_login',

  // User lifecycle
  USER_CREATED:                'user_created',
  ADMIN_CREATED:               'admin_created',
  SUPER_ADMIN_CREATED:         'super_admin_created',
  INITIAL_SUPER_ADMIN_CREATED: 'initial_super_admin_created',
  USER_SEARCHED:               'user_searched',
  USER_SUSPENDED:              'user_suspended',
  USER_ACTIVATED:              'user_activated',
  USER_DELETED:                'user_deleted',
  USER_HARD_DELETED:           'user_hard_deleted',
  USER_TRASHED:                'user_trashed',
  USER_RESTORED:               'user_restored',
  ACCOUNT_RESTORED:            'account_restored',
  UNDO_DELETE:                 'undo_delete',
  PROFILE_UPDATED:             'profile_updated',
  AVATAR_UPDATED:              'avatar_updated',
  SETTINGS_CHANGED:            'settings_changed',

  // Role
  ROLE_CHANGED:                'role_changed',
  PERMISSION_CHANGED:          'permission_changed',

  // Bulk operations
  BULK_TRASH:                  'bulk_trash',
  BULK_RESTORE:                'bulk_restore',
  BULK_SUSPEND:                'bulk_suspend',
  BULK_UNSUSPEND:              'bulk_unsuspend',
  BULK_RESET_DEVICES:          'bulk_reset_devices',
  BULK_RESET_PASSWORD:         'bulk_reset_password',
  BULK_PERMANENT_DELETE:       'bulk_permanent_delete',
  TRASH_EMPTIED:               'trash_emptied',
  DELETION_VERIFICATION_FAILED:'deletion_verification_failed',

  // Impersonation
  IMPERSONATION_STARTED:       'impersonation_started',
  IMPERSONATION_ENDED:         'impersonation_ended',

  // Courses & Lessons
  COURSE_CREATED:              'course_created',
  COURSE_UPDATED:              'course_updated',
  COURSE_DELETED:              'course_deleted',
  COURSE_ASSIGNED_BY_DOCTOR:   'course_assigned_by_doctor',
  LESSON_CREATED:              'lesson_created',
  LESSON_UPDATED:              'lesson_updated',
  LESSON_DELETED:              'lesson_deleted',
  ENROLLMENT_CREATED:          'enrollment_created',

  // Videos & PDFs
  VIDEO_UPLOADED:              'video_uploaded',
  VIDEO_PLAY:                  'video_play',
  VIDEO_PLAY_FAILED:           'video_play_failed',
  PDF_UPLOADED:                'pdf_uploaded',
  PDF_DELETED:                 'pdf_deleted',

  // Credits
  CREDIT_ALLOCATED:            'credit_allocated',
  CREDIT_CONSUMED:             'credit_consumed',
  CREDIT_CONSUMED_BY_DOCTOR:   'credit_consumed_by_doctor',
  CREDIT_DEDUCTED:             'credit_deducted',
  CREDIT_REFUNDED:             'credit_refunded',
  CREDIT_EXPIRED:              'credit_expired',

  // Subscriptions
  SUBSCRIPTION_CREATED:        'subscription_created',
  SUBSCRIPTION_REMOVED:        'subscription_removed',
  SUBSCRIPTION_RESTORED:       'subscription_restored',

  // Activation codes
  CODE_CREATED:                'code_created',
  CODE_REDEEMED:               'code_redeemed',
  CODE_DEACTIVATED:            'code_deactivated',
  CODE_DELETED:                'code_deleted',

  // Devices
  DEVICE_RESET:                'device_reset',
  DEVICE_FORCE_LOGOUT:         'device_force_logout',
  DEVICE_LOGOUT_ALL:           'device_logout_all',
  DEVICE_REVOKED:              'device_revoked',
  DEVICE_REMOVED:              'device_removed',
  DEVICE_BLOCKED:              'device_blocked',
  DEVICE_UNBLOCKED:            'device_unblocked',
  DEVICE_REGISTERED:           'device_registered',
  DEVICE_LIMIT_CHANGED:        'device_limit_changed',
  UNLIMITED_DEVICES_ENABLED:   'unlimited_devices_enabled',
  UNLIMITED_DEVICES_DISABLED:  'unlimited_devices_disabled',
  LIMIT_CHANGED:               'limit_changed',          // legacy alias
  UNLIMITED_ENABLED:           'unlimited_enabled',      // legacy alias
  UNLIMITED_DISABLED:          'unlimited_disabled',     // legacy alias

  // Students
  STUDENT_CREATED_BY_DOCTOR:   'student_created_by_doctor',
  STUDENT_BULK_IMPORTED:       'student_bulk_imported',
  TEMP_PASSWORD_GENERATED:     'temp_password_generated',

  // Security events
  SECURITY_EVENT:              'security_event',
  SECURITY_POLICY_CHANGED:     'security_policy_changed',
  ROOT_DETECTED:               'root_detected',
  JAILBREAK_DETECTED:          'jailbreak_detected',
  VPN_DETECTED:                'vpn_detected',
  PROXY_DETECTED:              'proxy_detected',
  SSL_PINNING_FAILURE:         'ssl_pinning_failure',
  SCREENSHOT_DETECTED:         'screenshot_detected',
  SCREEN_RECORDING_DETECTED:   'screen_recording_detected',
  DEBUG_DETECTED:              'debug_detected',
  FRIDA_DETECTED:              'frida_detected',
  XPOSED_DETECTED:             'xposed_detected',
  APP_INTEGRITY_COMPROMISED:   'app_integrity_compromised',

  // System
  SYSTEM_HEALTH_CHECK:         'system_health_check',
  PROVIDER_CHANGED:            'provider_changed',
} as const;
export type AuditAction = typeof AuditAction[keyof typeof AuditAction];
