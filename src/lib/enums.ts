/**
 * ════════════════════════════════════════════════════════════════════════════
 * SHARED ENUM CONSTANTS — Frontend (React Native / Expo)
 * ════════════════════════════════════════════════════════════════════════════
 * Single source of truth for all PostgreSQL enum values used in the app.
 * NEVER write raw enum strings in component/API code — import from here.
 *
 * Shared enum values mirrored by the PHP backend.
 * DB:     public schema pg_enum values
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── user_status ───────────────────────────────────────────────────────────────
export const UserStatus = {
  ACTIVE:    'active',
  BLOCKED:   'blocked',
  SUSPENDED: 'suspended',
  PENDING:   'pending',
  DELETED:   'deleted',
  TRASHED:   'trashed',
} as const;
export type UserStatus = typeof UserStatus[keyof typeof UserStatus];

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  active:    'Active',
  blocked:   'Blocked',
  suspended: 'Suspended',
  pending:   'Pending',
  deleted:   'Deleted',
  trashed:   'Trashed',
};

export const USER_STATUS_COLORS: Record<UserStatus, string> = {
  active:    '#16A34A',
  blocked:   '#DC2626',
  suspended: '#DC2626',
  pending:   '#D97706',
  deleted:   '#6B7280',
  trashed:   '#9333EA',
};

// ── user_role ─────────────────────────────────────────────────────────────────
export const UserRole = {
  STUDENT:     'student',
  DOCTOR:      'doctor',
  ASSISTANT:   'assistant',
  ADMIN:       'admin',
  SUPER_ADMIN: 'super_admin',
} as const;
export type UserRole = typeof UserRole[keyof typeof UserRole];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  student:     'Student',
  doctor:      'Doctor',
  assistant:   'Assistant',
  admin:       'Admin',
  super_admin: 'Super Admin',
};

export const USER_ROLE_COLORS: Record<UserRole, string> = {
  student:     '#2563EB',
  doctor:      '#16A34A',
  assistant:   '#2DA8FF',
  admin:       '#7C3AED',
  super_admin: '#DC2626',
};

// ── course_status ─────────────────────────────────────────────────────────────
export const CourseStatus = {
  DRAFT:     'draft',
  PUBLISHED: 'published',
  HIDDEN:    'hidden',
  ARCHIVED:  'archived',
} as const;
export type CourseStatus = typeof CourseStatus[keyof typeof CourseStatus];

export const COURSE_STATUS_LABELS: Record<CourseStatus, string> = {
  draft:     'Draft',
  published: 'Published',
  hidden:    'Hidden',
  archived:  'Archived',
};

export const COURSE_STATUS_COLORS: Record<CourseStatus, string> = {
  draft:     '#D97706',
  published: '#16A34A',
  hidden:    '#6B7280',
  archived:  '#9CA3AF',
};

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

export const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
  beginner:     'Beginner',
  intermediate: 'Intermediate',
  advanced:     'Advanced',
  all_levels:   'All Levels',
};

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
  ROOT_DETECTED:             'root_detected',
  JAILBREAK_DETECTED:        'jailbreak_detected',
  VPN_DETECTED:              'vpn_detected',
  PROXY_DETECTED:            'proxy_detected',
  SSL_PINNING_FAILURE:       'ssl_pinning_failure',
  SCREENSHOT_DETECTED:       'screenshot_detected',
  SCREEN_RECORDING_DETECTED: 'screen_recording_detected',
  DEBUG_DETECTED:            'debug_detected',
  FRIDA_DETECTED:            'frida_detected',
  XPOSED_DETECTED:           'xposed_detected',
  APP_INTEGRITY_COMPROMISED: 'app_integrity_compromised',
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

// ── audit_action (complete as of v76) ────────────────────────────────────────
export const AuditAction = {
  LOGIN:                        'login',
  LOGOUT:                       'logout',
  REGISTER:                     'register',
  PASSWORD_RESET:               'password_reset',
  PASSWORD_CHANGED:             'password_changed',
  PASSWORD_CHANGED_FIRST_LOGIN: 'password_changed_first_login',
  PHONE_LOGIN:                  'phone_login',
  USER_CREATED:                 'user_created',
  ADMIN_CREATED:                'admin_created',
  SUPER_ADMIN_CREATED:          'super_admin_created',
  INITIAL_SUPER_ADMIN_CREATED:  'initial_super_admin_created',
  USER_SEARCHED:                'user_searched',
  USER_SUSPENDED:               'user_suspended',
  USER_ACTIVATED:               'user_activated',
  USER_BLOCKED:                 'user_blocked',
  USER_UNBLOCKED:               'user_unblocked',
  USER_DELETED:                 'user_deleted',
  USER_HARD_DELETED:            'user_hard_deleted',
  USER_TRASHED:                 'user_trashed',
  USER_RESTORED:                'user_restored',
  ACCOUNT_RESTORED:             'account_restored',
  UNDO_DELETE:                  'undo_delete',
  PROFILE_UPDATED:              'profile_updated',
  AVATAR_UPDATED:               'avatar_updated',
  SETTINGS_CHANGED:             'settings_changed',
  ROLE_CHANGED:                 'role_changed',
  PERMISSION_CHANGED:           'permission_changed',
  BULK_TRASH:                   'bulk_trash',
  BULK_RESTORE:                 'bulk_restore',
  BULK_SUSPEND:                 'bulk_suspend',
  BULK_UNSUSPEND:               'bulk_unsuspend',
  BULK_BLOCK:                   'bulk_block',
  BULK_UNBLOCK:                 'bulk_unblock',
  BULK_RESET_DEVICES:           'bulk_reset_devices',
  BULK_RESET_PASSWORD:          'bulk_reset_password',
  BULK_PERMANENT_DELETE:        'bulk_permanent_delete',
  TRASH_EMPTIED:                'trash_emptied',
  DELETION_VERIFICATION_FAILED: 'deletion_verification_failed',
  IMPERSONATION_STARTED:        'impersonation_started',
  IMPERSONATION_ENDED:          'impersonation_ended',
  COURSE_CREATED:               'course_created',
  COURSE_UPDATED:               'course_updated',
  COURSE_DELETED:               'course_deleted',
  COURSE_ASSIGNED_BY_DOCTOR:    'course_assigned_by_doctor',
  LESSON_CREATED:               'lesson_created',
  LESSON_UPDATED:               'lesson_updated',
  LESSON_DELETED:               'lesson_deleted',
  ENROLLMENT_CREATED:           'enrollment_created',
  VIDEO_UPLOADED:               'video_uploaded',
  VIDEO_PLAY:                   'video_play',
  VIDEO_PLAY_FAILED:            'video_play_failed',
  PDF_UPLOADED:                 'pdf_uploaded',
  PDF_DELETED:                  'pdf_deleted',
  CREDIT_ALLOCATED:             'credit_allocated',
  CREDIT_CONSUMED:              'credit_consumed',
  CREDIT_CONSUMED_BY_DOCTOR:    'credit_consumed_by_doctor',
  CREDIT_DEDUCTED:              'credit_deducted',
  CREDIT_REFUNDED:              'credit_refunded',
  CREDIT_EXPIRED:               'credit_expired',
  SUBSCRIPTION_CREATED:         'subscription_created',
  SUBSCRIPTION_REMOVED:         'subscription_removed',
  SUBSCRIPTION_RESTORED:        'subscription_restored',
  CODE_CREATED:                 'code_created',
  CODE_REDEEMED:                'code_redeemed',
  CODE_DEACTIVATED:             'code_deactivated',
  CODE_DELETED:                 'code_deleted',
  DEVICE_RESET:                 'device_reset',
  DEVICE_FORCE_LOGOUT:          'device_force_logout',
  DEVICE_LOGOUT_ALL:            'device_logout_all',
  DEVICE_REVOKED:               'device_revoked',
  DEVICE_REMOVED:               'device_removed',
  DEVICE_BLOCKED:               'device_blocked',
  DEVICE_UNBLOCKED:             'device_unblocked',
  DEVICE_REGISTERED:            'device_registered',
  DEVICE_LIMIT_CHANGED:         'device_limit_changed',
  UNLIMITED_DEVICES_ENABLED:    'unlimited_devices_enabled',
  UNLIMITED_DEVICES_DISABLED:   'unlimited_devices_disabled',
  LIMIT_CHANGED:                'limit_changed',
  UNLIMITED_ENABLED:            'unlimited_enabled',
  UNLIMITED_DISABLED:           'unlimited_disabled',
  STUDENT_CREATED_BY_DOCTOR:    'student_created_by_doctor',
  STUDENT_BULK_IMPORTED:        'student_bulk_imported',
  TEMP_PASSWORD_GENERATED:      'temp_password_generated',
  SECURITY_EVENT:               'security_event',
  SECURITY_POLICY_CHANGED:      'security_policy_changed',
  ROOT_DETECTED:                'root_detected',
  JAILBREAK_DETECTED:           'jailbreak_detected',
  VPN_DETECTED:                 'vpn_detected',
  PROXY_DETECTED:               'proxy_detected',
  SSL_PINNING_FAILURE:          'ssl_pinning_failure',
  SCREENSHOT_DETECTED:          'screenshot_detected',
  SCREEN_RECORDING_DETECTED:    'screen_recording_detected',
  DEBUG_DETECTED:               'debug_detected',
  FRIDA_DETECTED:               'frida_detected',
  XPOSED_DETECTED:              'xposed_detected',
  APP_INTEGRITY_COMPROMISED:    'app_integrity_compromised',
  SYSTEM_HEALTH_CHECK:          'system_health_check',
  PROVIDER_CHANGED:             'provider_changed',
  // v268 additions
  DOCTOR_APPROVED:              'doctor_approved',
  DOCTOR_REJECTED:              'doctor_rejected',
  VIDEO_REPLACED:               'video_replaced',
  VIDEO_DELETED:                'video_deleted',
  COURSE_PUBLISHED:             'course_published',
  COURSE_UNPUBLISHED:           'course_unpublished',
  CATEGORY_CREATED:             'category_created',
  CATEGORY_UPDATED:             'category_updated',
  CATEGORY_DELETED:             'category_deleted',
  UNIVERSITY_CREATED:           'university_created',
  UNIVERSITY_UPDATED:           'university_updated',
  UNIVERSITY_DELETED:           'university_deleted',
  NOTIFICATION_SENT:            'notification_sent',
  ADMIN_UPDATED:                'admin_updated',
  ADMIN_DELETED:                'admin_deleted',
  EARNINGS_RESET:               'earnings_reset',
  ACTIVATION_CODE_CREATED:      'activation_code_created',
  ACTIVATION_CODE_USED:         'activation_code_used',
} as const;
export type AuditAction = typeof AuditAction[keyof typeof AuditAction];

// ── Enum integrity helper (runtime validation) ────────────────────────────────
/**
 * Returns all values for a given const-enum object.
 * Use in admin health checks to verify DB ↔ frontend alignment.
 */
export function enumValues<T extends Record<string, string>>(e: T): string[] {
  return Object.values(e);
}

/** All enum names that map to PostgreSQL types — used by EnumHealthCheck screen */
export const DB_ENUM_NAMES = [
  'activation_code_status',
  'audit_action',
  'content_protection_action',
  'course_status',
  'credit_transaction_type',
  'device_status',
  'difficulty_level',
  'download_permission',
  'lesson_status',
  'notification_type',
  'security_detection_type',
  'security_event_type',
  'security_policy_action',
  'strike_action',
  'user_role',
  'user_status',
  'video_type',
  'violation_type',
] as const;
export type DbEnumName = typeof DB_ENUM_NAMES[number];

/** Frontend enum registry keyed by DB enum name — used for health check diffing */
export const FRONTEND_ENUM_REGISTRY: Record<DbEnumName, Record<string, string>> = {
  activation_code_status:      ActivationCodeStatus,
  audit_action:                AuditAction,
  content_protection_action:   ContentProtectionAction,
  course_status:               CourseStatus,
  credit_transaction_type:     CreditTransactionType,
  device_status:               DeviceStatus,
  difficulty_level:            DifficultyLevel,
  download_permission:         DownloadPermission,
  lesson_status:               LessonStatus,
  notification_type:           NotificationType,
  security_detection_type:     SecurityEventType,  // subset overlap
  security_event_type:         SecurityEventType,
  security_policy_action:      SecurityPolicyAction,
  strike_action:               StrikeAction,
  user_role:                   UserRole,
  user_status:                 UserStatus,
  video_type:                  VideoType,
  violation_type:              {} as Record<string, string>,  // mapped as text in frontend
};
