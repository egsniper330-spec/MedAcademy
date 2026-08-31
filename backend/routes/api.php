<?php

declare(strict_types=1);

use MedAcademy\Controllers\AdminController;
use MedAcademy\Controllers\AnalyticsController;
use MedAcademy\Controllers\AuthController;
use MedAcademy\Controllers\CourseController;
use MedAcademy\Controllers\CreditController;
use MedAcademy\Controllers\DeviceController;
use MedAcademy\Controllers\HealthController;
use MedAcademy\Controllers\IntegrityController;
use MedAcademy\Controllers\NotificationController;
use MedAcademy\Controllers\SecurityController;
use MedAcademy\Controllers\StudentController;
use MedAcademy\Controllers\RpcController;
use MedAcademy\Controllers\DataController;
use MedAcademy\Controllers\StorageController;
use MedAcademy\Controllers\UserController;
use MedAcademy\Controllers\VideoController;

/*
 * MedAcademy REST API route table — 95+ routes.
 */

$auth = ['auth' => true];

// ---- Health / system -------------------------------------------------------
$router->get('/', [HealthController::class, 'root']);
$router->get('/api/health', [HealthController::class, 'health']);
$router->get('/health', [HealthController::class, 'health']);
$router->get('/system-health', [HealthController::class, 'systemHealth']);
$router->get('/provider-health', [HealthController::class, 'providerHealth']);

// ---- Auth (public) ---------------------------------------------------------
$router->post('/auth/register', [AuthController::class, 'register']);
$router->post('/auth/login', [AuthController::class, 'login']);
$router->post('/auth/refresh', [AuthController::class, 'refresh']);
$router->post('/auth/logout', [AuthController::class, 'logout'], $auth);
$router->post('/auth/forgot-password', [AuthController::class, 'forgotPassword']);
$router->post('/auth/reset-password', [AuthController::class, 'resetPassword']);
$router->post('/auth/change-password', [AuthController::class, 'changePassword'], $auth);
$router->post('/auth/admin/change-password', [AuthController::class, 'adminChangePassword'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/auth/lookup', [AuthController::class, 'lookup']);
$router->post('/auth/pre-login-check', [AuthController::class, 'preLoginCheck']);

// ---- Pre-registration conflict check (anon, port of 00132) ----------------
$router->post('/rpc/check-registration-conflicts', [RpcController::class, 'checkRegistrationConflicts']);

// ---- Current user / devices ------------------------------------------------
$router->get('/auth/me', [AuthController::class, 'me'], $auth);
$router->get('/auth/devices', [AuthController::class, 'devices'], $auth);
$router->post('/auth/devices/revoke', [AuthController::class, 'revokeDevice'], $auth);

// ---- Device binding ---------------------------------------------------------
$router->post('/device-binding', [DeviceController::class, 'handle'], $auth);

// ---- Student operations -----------------------------------------------------
$router->post('/student-operations', [StudentController::class, 'handle'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);

// ---- Trash / restore --------------------------------------------------------
$router->post('/users/{id}/trash', [AuthController::class, 'trashUser'], $auth + ['role' => ['admin', 'super_admin']]);

// ---- Impersonate ------------------------------------------------------------
$router->post('/auth/impersonate', [AuthController::class, 'impersonate'], $auth + ['role' => ['super_admin']]);

// ---- Users (profiles) -------------------------------------------------------
$router->get('/users/me', [UserController::class, 'me'], $auth);
$router->patch('/users/me', [UserController::class, 'updateMe'], $auth);
$router->get('/users/{id}', [UserController::class, 'show'], $auth);
$router->get('/doctors/students', [UserController::class, 'doctorStudents'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);

// ---- Courses / lessons (LMS) ------------------------------------------------
$router->get('/courses', [CourseController::class, 'index'], $auth);
$router->get('/courses/{id}', [CourseController::class, 'show'], $auth);
$router->get('/courses/{id}/sections', [CourseController::class, 'sections'], $auth);
$router->get('/courses/{id}/lessons', [CourseController::class, 'lessons'], $auth);
$router->get('/courses/{id}/progress', [CourseController::class, 'progress'], $auth);
$router->post('/courses', [CourseController::class, 'create'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->patch('/courses/{id}', [CourseController::class, 'update'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/courses/{id}/enroll', [CourseController::class, 'enroll'], $auth);
$router->post('/courses/{id}/archive', [CourseController::class, 'archive'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/courses/{id}/publish', [CourseController::class, 'publish'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/courses/{id}/unpublish', [CourseController::class, 'unpublish'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/courses/{id}/restore', [CourseController::class, 'restore'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/courses/{id}/delete', [CourseController::class, 'deleteCourse'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/courses/{id}/duplicate', [CourseController::class, 'duplicate'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/courses/grant-access', [CourseController::class, 'grantAccess'], $auth + ['role' => ['admin', 'super_admin']]);

$router->get('/categories', [CourseController::class, 'categories'], $auth);
$router->get('/universities', [CourseController::class, 'universities'], $auth);
$router->get('/universities/{id}/faculties', [CourseController::class, 'faculties'], $auth);
$router->get('/faculties/{id}/levels', [CourseController::class, 'academicLevels'], $auth);

// ---- Credits / activation codes ---------------------------------------------
$router->get('/credits/me', [CreditController::class, 'me'], $auth);
$router->get('/credits/transactions', [CreditController::class, 'transactions'], $auth);
$router->post('/credits/allocate', [CreditController::class, 'allocate'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/credits/refund', [CreditController::class, 'refund'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/credits/revoke', [CreditController::class, 'revoke'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/credits/bulk-allocate', [CreditController::class, 'bulkAllocate'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/credits/doctor/{id}', [CreditController::class, 'doctorEarnings'], $auth + ['role' => ['admin', 'super_admin']]);

$router->post('/activation-codes/redeem', [CreditController::class, 'redeem'], $auth);
$router->post('/activation-codes', [CreditController::class, 'createCodes'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/activation-codes/assign', [CreditController::class, 'assignCode'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/activation-codes/batch-create', [CreditController::class, 'batchCreateCodes'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/activation-codes/deactivate', [CreditController::class, 'deactivateCode'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/activation-codes/reactivate', [CreditController::class, 'reactivateCode'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/activation-codes/bulk-delete', [CreditController::class, 'bulkDeleteCodes'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/activation-codes/clone-batch', [CreditController::class, 'cloneBatch'], $auth + ['role' => ['admin', 'super_admin']]);

// ---- Notifications ----------------------------------------------------------
$router->get('/notifications', [NotificationController::class, 'index'], $auth);
$router->post('/notifications/read', [NotificationController::class, 'markRead'], $auth);

// ---- Security ---------------------------------------------------------------
$router->get('/security/config', [SecurityController::class, 'config'], $auth);
$router->get('/security/version', [SecurityController::class, 'version'], $auth);
$router->post('/security/events', [SecurityController::class, 'reportEvent'], $auth);
$router->post('/security/violations', [SecurityController::class, 'reportViolation'], $auth);
$router->post('/security/bump-version/{id}', [SecurityController::class, 'bumpVersion'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/security/devices/{id}/block', [SecurityController::class, 'blockDevice'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/security/devices/{id}/unblock', [SecurityController::class, 'unblockDevice'], $auth + ['role' => ['admin', 'super_admin']]);

// ---- Video (VdoCipher) -----------------------------------------------------
$router->post('/video/otp', [VideoController::class, 'otp'], $auth);
$router->post('/video/upload-init', [VideoController::class, 'uploadInit'], $auth);
$router->post('/video/upload-status', [VideoController::class, 'uploadStatus'], $auth);
$router->post('/video/delete', [VideoController::class, 'delete'], $auth);
$router->post('/video/cancel-upload', [VideoController::class, 'cancelUpload'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/video/assets', [VideoController::class, 'assets'], $auth);
$router->post('/video/assets/delete', [VideoController::class, 'deleteAsset'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/video/webhook', [VideoController::class, 'webhook']);
$router->post('/video/chunk', [VideoController::class, 'uploadChunk'], $auth);
$router->post('/video/assemble', [VideoController::class, 'assembleUpload'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/video/health-scan', [VideoController::class, 'healthScan'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/video/upload-patch', [VideoController::class, 'uploadPatch']);
$router->post('/video/orphan-cleanup', [VideoController::class, 'orphanCleanup'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/lessons/{id}/delete', [CourseController::class, 'deleteLesson'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);

// ---- Integrity (Play Integrity / App Integrity) -----------------------------
$router->post('/integrity/play', [IntegrityController::class, 'playIntegrity'], $auth);
$router->post('/integrity/app', [IntegrityController::class, 'appIntegrity'], $auth);

// ---- Storage ---------------------------------------------------------------
$router->get('/storage/buckets', [StorageController::class, 'buckets'], $auth);
$router->get('/storage/signed-url', [StorageController::class, 'signedUrl'], $auth);
$router->post('/storage/signed-url', [StorageController::class, 'signedUrl'], $auth); // EF get-signed-url POSTs a JSON body
$router->get('/storage/signed', [StorageController::class, 'signedFile']);
$router->get('/storage/public/{bucket}/{path*}', [StorageController::class, 'publicFile']);
$router->post('/storage/upload', [StorageController::class, 'upload'], $auth);
$router->post('/storage/delete', [StorageController::class, 'delete'], $auth);

// ---- Admin ----------------------------------------------------------------
$router->get('/admin/users', [AdminController::class, 'users'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/admin/users/{id}', [AdminController::class, 'userDetail'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/admin/users/{id}/role', [AdminController::class, 'setRole'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/admin/users/{id}/status', [AdminController::class, 'setStatus'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/admin/users/{id}/block', [AdminController::class, 'blockUser'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/admin/users/{id}/restore', [AdminController::class, 'restoreUser'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/admin/users/{id}/devices/reset', [AdminController::class, 'resetDevices'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/admin/audit-logs', [AdminController::class, 'auditLogs'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/admin/audit-logs', [AdminController::class, 'writeAuditLog'], $auth);
$router->get('/admin/stats', [AdminController::class, 'stats'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/admin/security-config', [AdminController::class, 'securityConfig'], $auth + ['role' => ['admin', 'super_admin']]);
$router->patch('/admin/security-config', [AdminController::class, 'updateSecurityConfig'], $auth + ['role' => ['super_admin']]);
$router->post('/admin/bulk-user-ops', [AdminController::class, 'bulkUserOps'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/admin/trash-cleanup', [AdminController::class, 'runTrashCleanup'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/admin/enrollment', [AdminController::class, 'adminEnrollment'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/admin/update-email', [AdminController::class, 'adminUpdateEmail'], $auth + ['role' => ['super_admin']]);
$router->post('/admin/delete-user', [AdminController::class, 'deleteUser'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/admin/delete-user/preflight', [AdminController::class, 'deleteUserPreflight'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/admin/user-lookup', [AdminController::class, 'userLookup'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/admin/user-management', [AdminController::class, 'userManagement'], $auth + ['role' => ['admin', 'super_admin']]);

// ---- Analytics / RPCs -------------------------------------------------------
$router->get('/analytics/security-stats', [AnalyticsController::class, 'securityStats'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/analytics/user-activity/{id}', [AnalyticsController::class, 'userActivity'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/analytics/user-profile/{id}', [AnalyticsController::class, 'userProfile'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/analytics/trash-list', [AnalyticsController::class, 'trashList'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/analytics/trash-stats', [AnalyticsController::class, 'trashStats'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/analytics/deletion-stats', [AnalyticsController::class, 'deletionStats'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/analytics/archive-analytics', [AnalyticsController::class, 'archiveAnalytics'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/analytics/archived-courses', [AnalyticsController::class, 'archivedCourses'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/analytics/course-delete-stats/{id}', [AnalyticsController::class, 'courseDeleteStats'], $auth); // owner-aware: admins + the owning doctor
$router->get('/analytics/risky-devices', [AnalyticsController::class, 'riskyDevices'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/analytics/video-asset-usage', [AnalyticsController::class, 'videoAssetUsage'], $auth); // ownership enforced in controller (doctors may query their own assets)
$router->post('/analytics/db-audit', [AnalyticsController::class, 'dbAudit'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/analytics/recalculate-earnings/{doctorId}', [AnalyticsController::class, 'recalculateEarnings'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/analytics/reset-doctor-earnings/{doctorId}', [AnalyticsController::class, 'resetDoctorEarnings'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/analytics/reset-platform-earnings', [AnalyticsController::class, 'resetPlatformEarnings'], $auth + ['role' => ['super_admin']]);

// ---- Generic Data API (legacy query contract over PHP/MySQL) ----------------
$router->get('/api/{table}', [DataController::class, 'select'], $auth);
$router->post('/api/{table}', [DataController::class, 'insert'], $auth);
$router->patch('/api/{table}', [DataController::class, 'update'], $auth);
$router->delete('/api/{table}', [DataController::class, 'delete'], $auth);

// ---- Named backend actions ---------------------------------------------------
// User RPCs
// Pre-login phone → email resolution. Original Supabase function was SECURITY
// DEFINER and GRANTed to anon so the sign-in screen can resolve a phone number
// to an email BEFORE authentication (see 00039/00062/00061/00074). It returns
// only an email address, never profile data — safe to expose anonymously.
$router->post('/rpc/get-email-by-phone', [RpcController::class, 'getEmailByPhone']);

// Doctor RPCs
$router->get('/rpc/doctor-activity-stats/{doctorId}', [RpcController::class, 'doctorActivityStats'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->get('/rpc/doctor-credit-transactions/{doctorId}', [RpcController::class, 'doctorCreditTransactions'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->get('/rpc/doctor-earnings-dashboard/{doctorId}', [RpcController::class, 'doctorEarningsDashboard'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/rpc/doctor-student-profile', [RpcController::class, 'doctorStudentProfile'], $auth + ['role' => ['doctor']]);

// Course RPCs
$router->post('/rpc/create-course-audited', [RpcController::class, 'createCourseAudited'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/rpc/update-course-audited', [RpcController::class, 'updateCourseAudited'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/rpc/permanently-delete-course', [RpcController::class, 'permanentlyDeleteCourse'], $auth + ['role' => ['admin', 'super_admin']]);

// Doctor pricing RPCs
$router->post('/rpc/set-doctor-credit-price', [RpcController::class, 'setDoctorCreditPrice'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/rpc/set-enrollment-assigned-price', [RpcController::class, 'setEnrollmentAssignedPrice'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);

// Video provider permissions RPCs
$router->post('/rpc/upsert-teacher-provider-permission', [RpcController::class, 'upsertTeacherProviderPermission'], $auth + ['role' => ['admin', 'super_admin']]);
$router->get('/rpc/teacher-provider-permissions', [RpcController::class, 'getTeacherProviderPermissions'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);

// Deletion/health RPCs
$router->get('/rpc/orphan-deletion-records', [RpcController::class, 'getOrphanDeletionRecords'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/rpc/mark-deletion-repaired', [RpcController::class, 'markDeletionRepaired'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/rpc/mark-lesson-video-missing', [RpcController::class, 'markLessonVideoMissing'], $auth + ['role' => ['admin', 'super_admin']]);

// Lesson video state RPC
$router->get('/rpc/lesson-video-state', [RpcController::class, 'getLessonVideoState'], $auth);

// Enum values RPC (public)
$router->post('/rpc/enum-values-bulk', [RpcController::class, 'getEnumValuesBulk'], $auth);

// Audit log search RPC
$router->get('/rpc/search-audit-logs', [RpcController::class, 'searchAuditLogs'], $auth + ['role' => ['admin', 'super_admin']]);

// Admin violation/device RPCs
$router->post('/rpc/admin-reset-violations', [RpcController::class, 'adminResetViolations'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/rpc/recover-stale-upload-sessions', [RpcController::class, 'recoverStaleUploadSessions'], $auth + ['role' => ['admin', 'super_admin']]);

// Remaining missing RPC equivalents
$router->get('/rpc/chunk-upload-state', [RpcController::class, 'getChunkUploadState'], $auth);
$router->post('/rpc/remove-course-enrollment', [RpcController::class, 'removeCourseEnrollment'], $auth + ['role' => ['admin', 'super_admin']]);
$router->post('/rpc/remove-student-and-record-earnings', [RpcController::class, 'removeStudentAndRecordEarnings'], $auth + ['role' => ['doctor', 'admin', 'super_admin']]);
$router->post('/rpc/reset-user-password-by-admin', [RpcController::class, 'resetUserPasswordByAdmin'], $auth + ['role' => ['admin', 'super_admin']]);
