<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Utils\Uuid;

/**
 * RpcController — PHP equivalents of all remaining PostgreSQL RPCs.
 *
 * Implements:
 *   get_email_by_phone, get_doctor_activity_stats, get_doctor_credit_transactions,
 *   get_doctor_earnings_dashboard, get_doctor_student_profile,
 *   create_course_audited, update_course_audited, permanently_delete_course,
 *   set_doctor_credit_price, set_enrollment_assigned_price,
 *   upsert_teacher_provider_permission, get_teacher_provider_permissions,
 *   get_orphan_deletion_records, mark_deletion_repaired, mark_lesson_video_missing,
 *   get_lesson_video_state, get_enum_values_bulk, search_audit_logs,
 *   admin_reset_violations, recover_stale_upload_sessions
 */
final class RpcController
{
    /**
     * check_registration_conflicts — anon-callable pre-registration check.
     * Port of 00132: returns a single row (email_taken, phone_taken) without
     * exposing any user data. Email is checked against users (canonical auth
     * source), phone against profiles.phone_e164 (normalised E.164 column).
     *
     * Response shape matches the frontend contract: an ARRAY with one row,
     * e.g. [{ "email_taken": false, "phone_taken": false }].
     */
    public function checkRegistrationConflicts(Request $request): array
    {
        $body = $request->json();
        $email = strtolower(trim((string) ($body['email'] ?? $body['p_email'] ?? '')));
        $phoneE164 = trim((string) ($body['phone_e164'] ?? $body['p_phone_e164'] ?? ''));

        $db = Database::instance();
        $emailTaken = false;
        if ($email !== '') {
            $emailTaken = (int) $db->value(
                'SELECT COUNT(*) FROM users WHERE LOWER(email) = ? AND deleted_at IS NULL',
                [$email],
                0
            ) > 0;
        }
        $phoneTaken = false;
        if ($phoneE164 !== '') {
            $phoneTaken = (int) $db->value(
                'SELECT COUNT(*) FROM profiles WHERE phone_e164 = ?',
                [$phoneE164],
                0
            ) > 0;
        }

        return [[
            'email_taken' => $emailTaken,
            'phone_taken' => $phoneTaken,
        ]];
    }

    /**
     * get_email_by_phone — Look up auth email by phone number.
     */
    public function getEmailByPhone(Request $request): array
    {
        $phone = trim((string) ($request->json()['phone'] ?? $request->query('phone', '')));
        if ($phone === '') {
            throw new ApiException(422, 'phone is required');
        }

        $row = Database::instance()->row(
            'SELECT email FROM users WHERE phone = ? LIMIT 1',
            [$phone]
        );

        return ['email' => $row['email'] ?? null];
    }

    /**
     * get_doctor_activity_stats — Doctor activity summary.
     */
    public function doctorActivityStats(Request $request): array
    {
        $doctorId = Uuid::normalize((string) ($request->params['doctorId'] ?? $request->json()['doctor_id'] ?? ''));
        if ($doctorId === '') {
            throw new ApiException(422, 'doctor_id is required');
        }

        $db = Database::instance();
        $courseCount = (int) $db->value(
            'SELECT COUNT(*) FROM courses WHERE doctor_id = ? AND is_deleted = 0',
            [$doctorId], 0
        );
        $studentCount = (int) $db->value(
            'SELECT COUNT(DISTINCT e.student_id) FROM enrollments e
             JOIN courses c ON c.id = e.course_id WHERE c.doctor_id = ?',
            [$doctorId], 0
        );
        $totalEarnings = (int) $db->value(
            'SELECT COALESCE(SUM(consumed), 0) FROM credits WHERE doctor_id = ?',
            [$doctorId], 0
        );

        return [
            'total_courses' => $courseCount,
            'total_students' => $studentCount,
            'total_earnings' => $totalEarnings,
        ];
    }

    /**
     * get_doctor_credit_transactions — Paginated credit transactions for a doctor.
     */
    public function doctorCreditTransactions(Request $request): array
    {
        $doctorId = Uuid::normalize((string) ($request->params['doctorId'] ?? $request->json()['doctor_id'] ?? ''));
        if ($doctorId === '') {
            throw new ApiException(422, 'doctor_id is required');
        }

        $limit = min(max((int) ($request->query('limit', '50')), 1), 200);
        $offset = max((int) ($request->query('offset', '0')), 0);

        $db = Database::instance();
        $transactions = $db->select(
            'SELECT id, doctor_id, student_id, course_id, amount, transaction_type,
                    description, created_at
             FROM credit_transactions
             WHERE doctor_id = ?
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?',
            [$doctorId, $limit, $offset]
        );

        return ['transactions' => $transactions ?? []];
    }

    /**
     * get_doctor_earnings_dashboard — Full earnings dashboard for a doctor.
     */
    public function doctorEarningsDashboard(Request $request): array
    {
        $doctorId = Uuid::normalize((string) ($request->params['doctorId'] ?? $request->json()['doctor_id'] ?? ''));
        if ($doctorId === '') {
            throw new ApiException(422, 'doctor_id is required');
        }

        $db = Database::instance();
        $credits = $db->row('SELECT * FROM credits WHERE doctor_id = ?', [$doctorId]);

        $recentTransactions = $db->select(
            'SELECT id, student_id, course_id, amount, transaction_type, description, created_at
             FROM credit_transactions WHERE doctor_id = ?
             ORDER BY created_at DESC LIMIT 20',
            [$doctorId]
        );

        $earningsEvents = $db->select(
            'SELECT id, event_type, amount, created_at
             FROM doctor_earnings_events WHERE doctor_id = ?
             ORDER BY created_at DESC LIMIT 20',
            [$doctorId]
        );

        return [
            'credits' => $credits ?? ['allocated' => 0, 'consumed' => 0, 'remaining' => 0],
            'recent_transactions' => $recentTransactions ?? [],
            'earnings_events' => $earningsEvents ?? [],
        ];
    }

    /**
     * get_doctor_student_profile — Doctor fetches a specific student profile.
     */
    public function doctorStudentProfile(Request $request): array
    {
        $studentId = Uuid::normalize((string) ($request->json()['student_id'] ?? $request->query('student_id', '')));
        $doctorId = $request->user['id'];

        if ($studentId === '') {
            throw new ApiException(422, 'student_id is required');
        }

        $db = Database::instance();

        // Verify doctor has at least one shared enrollment
        $sharedEnrollment = $db->value(
            'SELECT 1 FROM enrollments e
             JOIN courses c ON c.id = e.course_id
             WHERE e.student_id = ? AND c.doctor_id = ?
             LIMIT 1',
            [$studentId, $doctorId]
        );
        if ($sharedEnrollment === null) {
            throw new ApiException(403, 'No shared enrollment with this student');
        }

        $profile = $db->row('SELECT * FROM profiles WHERE id = ?', [$studentId]);
        if ($profile === null) {
            throw new ApiException(404, 'Student not found');
        }

        $credits = $db->row('SELECT * FROM credits WHERE doctor_id = ?', [$studentId]);
        $devices = $db->select(
            'SELECT id, device_name, platform, status, last_active_at FROM devices WHERE user_id = ?',
            [$studentId]
        );
        $enrollments = $db->select(
            'SELECT e.id, e.course_id, e.enrolled_at, e.status, c.title AS course_title
             FROM enrollments e JOIN courses c ON c.id = e.course_id
             WHERE e.student_id = ? ORDER BY e.enrolled_at DESC',
            [$studentId]
        );

        return [
            'profile' => $profile,
            'credits' => $credits ?? ['allocated' => 0, 'consumed' => 0, 'remaining' => 0],
            'devices' => $devices ?? [],
            'enrollments' => $enrollments ?? [],
        ];
    }

    /**
     * create_course_audited — Create course + write audit log atomically.
     */
    public function createCourseAudited(Request $request): array
    {
        $data = $request->json();
        $userId = $request->user['id'];

        $title = trim((string) ($data['title'] ?? ''));
        $description = trim((string) ($data['description'] ?? ''));
        $categoryId = $data['category_id'] ?? null;
        $difficulty = (string) ($data['difficulty'] ?? 'beginner');
        $creditPrice = (int) ($data['credit_price'] ?? 1);

        if ($title === '') {
            throw new ApiException(422, 'title is required');
        }

        $courseId = Uuid::v4();
        $db = Database::instance();

        $db->beginTransaction();
        try {
            $db->query(
                'INSERT INTO courses (id, title, description, category_id, difficulty, credit_price,
                     doctor_id, status, is_deleted, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                [$courseId, $title, $description, $categoryId, $difficulty, $creditPrice, $userId, 'draft']
            );

            AuditService::write($userId, 'course_created', [
                'course_id' => $courseId,
                'title' => $title,
            ]);

            $db->commit();
        } catch (\Throwable $e) {
            $db->rollBack();
            throw $e;
        }

        return ['course_id' => $courseId];
    }

    /**
     * update_course_audited — Update course fields + write audit log.
     */
    public function updateCourseAudited(Request $request): array
    {
        $courseId = Uuid::normalize((string) ($request->params['courseId'] ?? $request->json()['course_id'] ?? ''));
        $data = $request->json();
        $userId = $request->user['id'];

        if ($courseId === '') {
            throw new ApiException(422, 'course_id is required');
        }

        $db = Database::instance();
        $course = $db->row('SELECT * FROM courses WHERE id = ?', [$courseId]);
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }

        $allowed = ['title', 'description', 'category_id', 'difficulty', 'credit_price', 'status', 'thumbnail_url'];
        $sets = [];
        $params = [];
        $changes = [];

        foreach ($allowed as $col) {
            if (array_key_exists($col, $data)) {
                $sets[] = '`' . $col . '` = ?';
                $params[] = $data[$col];
                $changes[$col] = $data[$col];
            }
        }

        if ($sets === []) {
            throw new ApiException(422, 'No updatable fields provided');
        }

        $sets[] = 'updated_at = UTC_TIMESTAMP(6)';
        $params[] = $courseId;

        $db->beginTransaction();
        try {
            $db->query(
                'UPDATE courses SET ' . implode(', ', $sets) . ' WHERE id = ?',
                $params
            );

            AuditService::write($userId, 'course_updated', [
                'course_id' => $courseId,
                'changes' => $changes,
            ]);

            $db->commit();
        } catch (\Throwable $e) {
            $db->rollBack();
            throw $e;
        }

        return ['success' => true];
    }

    /**
     * permanently_delete_course — Hard-delete course and all children.
     */
    public function permanentlyDeleteCourse(Request $request): array
    {
        $courseId = Uuid::normalize((string) ($request->params['courseId'] ?? $request->json()['course_id'] ?? ''));
        $userId = $request->user['id'];

        if ($courseId === '') {
            throw new ApiException(422, 'course_id is required');
        }

        $db = Database::instance();
        $course = $db->row('SELECT * FROM courses WHERE id = ?', [$courseId]);
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }

        $db->beginTransaction();
        try {
            // Delete child records in correct order (respecting FK constraints)
            $lessonIds = $db->select(
                'SELECT id FROM lessons WHERE course_id = ?',
                [$courseId]
            );
            $lessonIdList = array_column($lessonIds ?? [], 'id');

            if (!empty($lessonIdList)) {
                $placeholders = implode(',', array_fill(0, count($lessonIdList), '?'));
                $db->query("DELETE FROM lesson_materials WHERE lesson_id IN ($placeholders)", $lessonIdList);
                $db->query("DELETE FROM lesson_progress WHERE lesson_id IN ($placeholders)", $lessonIdList);
                $db->query("DELETE FROM lessons WHERE course_id = ?", [$courseId]);
            }

            $db->query("DELETE FROM sections WHERE course_id = ?", [$courseId]);
            $db->query("DELETE FROM enrollments WHERE course_id = ?", [$courseId]);
            $db->query("DELETE FROM video_uploads WHERE course_id = ?", [$courseId]);
            $db->query("DELETE FROM courses WHERE id = ?", [$courseId]);

            AuditService::write($userId, 'course_deleted', [
                'course_id' => $courseId,
                'title' => $course['title'] ?? 'unknown',
                'permanent' => true,
            ]);

            $db->commit();
        } catch (\Throwable $e) {
            $db->rollBack();
            throw $e;
        }

        return ['success' => true];
    }

    /**
     * set_doctor_credit_price — Set custom credit price for a doctor.
     */
    public function setDoctorCreditPrice(Request $request): array
    {
        $doctorId = Uuid::normalize((string) ($request->json()['doctor_id'] ?? ''));
        $price = (int) ($request->json()['price'] ?? 1);
        $userId = $request->user['id'];

        if ($doctorId === '') {
            throw new ApiException(422, 'doctor_id is required');
        }
        if ($price < 0) {
            throw new ApiException(422, 'price must be non-negative');
        }

        $db = Database::instance();

        $db->beginTransaction();
        try {
            $db->query(
                'UPDATE profiles SET credit_selling_price = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [$price, $doctorId]
            );

            $db->insert(
                'INSERT INTO doctor_pricing_history (id, doctor_id, old_price, new_price, changed_by, created_at)
                 VALUES (?, ?, (SELECT credit_selling_price FROM profiles WHERE id = ?), ?, ?, UTC_TIMESTAMP(6))',
                [Uuid::v4(), $doctorId, $doctorId, $price, $userId]
            );

            AuditService::write($userId, 'permission_changed', [
                'doctor_id' => $doctorId,
                'action' => 'set_doctor_credit_price',
                'new_price' => $price,
            ]);

            $db->commit();
        } catch (\Throwable $e) {
            $db->rollBack();
            throw $e;
        }

        return ['success' => true];
    }

    /**
     * set_enrollment_assigned_price — Override enrollment credit price.
     */
    public function setEnrollmentAssignedPrice(Request $request): array
    {
        $enrollmentId = Uuid::normalize((string) ($request->json()['enrollment_id'] ?? ''));
        $price = (int) ($request->json()['price'] ?? 1);

        if ($enrollmentId === '') {
            throw new ApiException(422, 'enrollment_id is required');
        }

        Database::instance()->query(
            'UPDATE enrollments SET assigned_price = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [$price, $enrollmentId]
        );

        return ['success' => true];
    }

    /**
     * upsert_teacher_provider_permission — Grant/revoke video provider access for teacher.
     */
    public function upsertTeacherProviderPermission(Request $request): array
    {
        $teacherId = Uuid::normalize((string) ($request->json()['teacher_id'] ?? ''));
        $provider = trim((string) ($request->json()['provider'] ?? ''));
        $enabled = (bool) ($request->json()['enabled'] ?? true);

        if ($teacherId === '' || $provider === '') {
            throw new ApiException(422, 'teacher_id and provider are required');
        }

        $db = Database::instance();
        $existing = $db->row(
            'SELECT id FROM video_provider_config WHERE teacher_id = ? AND provider = ?',
            [$teacherId, $provider]
        );

        if ($existing) {
            $db->query(
                'UPDATE video_provider_config SET enabled = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [$enabled ? 1 : 0, $existing['id']]
            );
        } else {
            $db->insert(
                'INSERT INTO video_provider_config (id, teacher_id, provider, enabled, created_at, updated_at)
                 VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                [Uuid::v4(), $teacherId, $provider, $enabled ? 1 : 0]
            );
        }

        return ['success' => true];
    }

    /**
     * get_teacher_provider_permissions — Returns video provider access for a teacher.
     */
    public function getTeacherProviderPermissions(Request $request): array
    {
        $teacherId = Uuid::normalize((string) ($request->json()['teacher_id'] ?? $request->query('teacher_id', '')));

        if ($teacherId === '') {
            throw new ApiException(422, 'teacher_id is required');
        }

        $permissions = Database::instance()->select(
            'SELECT provider, enabled FROM video_provider_config WHERE teacher_id = ?',
            [$teacherId]
        );

        return ['permissions' => $permissions ?? []];
    }

    /**
     * get_orphan_deletion_records — Find orphaned video/storage deletion records.
     */
    public function getOrphanDeletionRecords(Request $request): array
    {
        $db = Database::instance();

        // Find deletion_records for non-existent video_uploads
        $orphanRecords = $db->select(
            'SELECT dr.* FROM deletion_records dr
             LEFT JOIN video_uploads vu ON vu.id = dr.video_upload_id
             WHERE vu.id IS NULL AND dr.status = ?
             ORDER BY dr.created_at DESC LIMIT 100',
            ['pending']
        );

        return ['orphan_records' => $orphanRecords ?? []];
    }

    /**
     * mark_deletion_repaired — Mark orphan deletion record as resolved.
     */
    public function markDeletionRepaired(Request $request): array
    {
        $recordId = Uuid::normalize((string) ($request->json()['record_id'] ?? ''));

        if ($recordId === '') {
            throw new ApiException(422, 'record_id is required');
        }

        Database::instance()->query(
            'UPDATE deletion_records SET status = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            ['repaired', $recordId]
        );

        return ['success' => true];
    }

    /**
     * mark_lesson_video_missing — Flag lesson video as missing in health check.
     */
    public function markLessonVideoMissing(Request $request): array
    {
        $lessonId = Uuid::normalize((string) ($request->json()['lesson_id'] ?? ''));

        if ($lessonId === '') {
            throw new ApiException(422, 'lesson_id is required');
        }

        $db = Database::instance();

        // Insert into video_health_alerts
        $alertId = Uuid::v4();
        $db->insert(
            'INSERT INTO video_health_alerts (id, lesson_id, alert_type, message, created_at)
             VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [$alertId, $lessonId, 'video_missing', 'Video asset not found on VdoCipher']
        );

        // Update lesson to flag missing video
        $db->query(
            'UPDATE lessons SET video_status = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            ['missing', $lessonId]
        );

        return ['success' => true];
    }

    /**
     * get_lesson_video_state — Returns video upload/processing state for a lesson.
     */
    public function getLessonVideoState(Request $request): array
    {
        $lessonId = Uuid::normalize((string) ($request->json()['lesson_id'] ?? $request->query('lesson_id', '')));

        if ($lessonId === '') {
            throw new ApiException(422, 'lesson_id is required');
        }

        $db = Database::instance();
        $lesson = $db->row('SELECT id, video_id, video_status FROM lessons WHERE id = ?', [$lessonId]);

        if ($lesson === null) {
            throw new ApiException(404, 'Lesson not found');
        }

        $videoUpload = null;
        if (!empty($lesson['video_id'])) {
            $videoUpload = $db->row(
                'SELECT id, vdo_cipher_video_id, status, processing_status, upload_status,
                        file_size_bytes, duration_seconds, created_at
                 FROM video_uploads WHERE vdo_cipher_video_id = ? OR id = ?',
                [$lesson['video_id'], $lesson['video_id']]
            );
        }

        $videoAssets = $db->select(
            'SELECT id, video_id, video_url, thumbnail_url, file_size_bytes, duration_seconds
             FROM video_assets WHERE lesson_id = ?',
            [$lessonId]
        );

        return [
            'lesson_id' => $lessonId,
            'video_id' => $lesson['video_id'] ?? null,
            'video_status' => $lesson['video_status'] ?? null,
            'upload' => $videoUpload,
            'assets' => $videoAssets ?? [],
        ];
    }

    /**
     * get_enum_values_bulk — Returns all values for multiple enum types at once.
     */
    public function getEnumValuesBulk(Request $request): array
    {
        $enumNames = $request->json()['enum_names'] ?? [];

        if (!is_array($enumNames) || empty($enumNames)) {
            throw new ApiException(422, 'enum_names array is required');
        }

        $db = Database::instance();
        $result = [];

        // MySQL enums are stored as CHECK constraints or VARCHAR columns.
        // We return the CHECK constraint values from the schema.
        $knownEnums = [
            'user_role' => ['student', 'doctor', 'admin', 'super_admin'],
            'user_status' => ['active', 'suspended', 'blocked', 'trashed', 'deleted'],
            'difficulty_level' => ['beginner', 'intermediate', 'advanced'],
            'course_status' => ['draft', 'published', 'archived', 'deleted'],
            'security_event_type' => [
                'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected',
                'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected',
                'debug_detected', 'frida_detected', 'xposed_detected',
                'app_integrity_compromised', 'developer_options_enabled', 'adb_enabled',
                'debugger_attached', 'magisk_detected', 'overlay_detected',
                'signature_invalid', 'tamper_detected', 'play_integrity_failed',
                'play_integrity_passed',
            ],
            'security_policy_action' => ['log_only', 'warn_only', 'block_video', 'block_login'],
            'security_violation_type' => ['screenshot_detected', 'screen_recording_detected'],
            'audit_action' => [
                'login', 'logout', 'register', 'password_changed', 'role_changed',
                'status_changed', 'course_created', 'course_updated', 'course_deleted',
                'course_archived', 'enrollment_created', 'enrollment_removed',
                'credit_allocated', 'credit_refunded', 'credit_revoked',
                'device_registered', 'device_blocked', 'device_unblocked',
                'security_event', 'violation_logged', 'earnings_reset',
                'permission_changed', 'admin_action', 'system_health_check',
            ],
        ];

        foreach ($enumNames as $name) {
            if (isset($knownEnums[$name])) {
                $result[$name] = $knownEnums[$name];
            } else {
                $result[$name] = [];
            }
        }

        return ['enums' => $result];
    }

    /**
     * search_audit_logs — Filtered paginated audit log search.
     */
    public function searchAuditLogs(Request $request): array
    {
        $search = trim((string) ($request->query('search', '')));
        $limit = min(max((int) $request->query('limit', '50'), 1), 200);
        $offset = max((int) $request->query('offset', '0'), 0);
        $action = trim((string) ($request->query('action', '')));
        $userId = Uuid::normalize((string) ($request->query('user_id', '')));

        $db = Database::instance();
        $conditions = [];
        $params = [];

        if ($search !== '') {
            $conditions[] = '(al.action LIKE ? OR al.details LIKE ? OR p.full_name LIKE ?)';
            $like = '%' . $search . '%';
            array_push($params, $like, $like, $like);
        }
        if ($action !== '') {
            $conditions[] = 'al.action = ?';
            $params[] = $action;
        }
        if ($userId !== '') {
            $conditions[] = '(al.user_id = ? OR al.actor_id = ?)';
            $params[] = $userId;
            $params[] = $userId;
        }

        $where = $conditions !== [] ? 'WHERE ' . implode(' AND ', $conditions) : '';

        $rows = $db->select(
            "SELECT al.id, al.action, al.user_id, al.actor_id, al.details, al.created_at,
                    p.full_name AS actor_name
             FROM audit_logs al
             LEFT JOIN profiles p ON p.id = al.actor_id
             {$where}
             ORDER BY al.created_at DESC
             LIMIT ? OFFSET ?",
            array_merge($params, [$limit, $offset])
        );

        return ['logs' => $rows ?? []];
    }

    /**
     * admin_reset_violations — Admin resets content protection violation strike count.
     */
    public function adminResetViolations(Request $request): array
    {
        $targetUserId = Uuid::normalize((string) ($request->json()['user_id'] ?? ''));
        $actorId = $request->user['id'];

        if ($targetUserId === '') {
            throw new ApiException(422, 'user_id is required');
        }

        $db = Database::instance();

        $db->beginTransaction();
        try {
            // Reset violation count in content_protection_violations
            $db->query(
                'UPDATE content_protection_violations
                 SET strike_count = 0, is_suspended = 0, updated_at = UTC_TIMESTAMP(6)
                 WHERE user_id = ?',
                [$targetUserId]
            );

            // Reset in profiles if column exists
            $db->query(
                'UPDATE profiles
                 SET violation_count = 0, strike_count = 0, is_suspended = 0,
                     updated_at = UTC_TIMESTAMP(6)
                 WHERE id = ?',
                [$targetUserId]
            );

            AuditService::write($actorId, 'admin_action', [
                'action' => 'admin_reset_violations',
                'target_user_id' => $targetUserId,
            ]);

            $db->commit();
        } catch (\Throwable $e) {
            $db->rollBack();
            throw $e;
        }

        return ['success' => true];
    }

    /**
     * recover_stale_upload_sessions — Reset stale in-progress upload sessions.
     */
    public function recoverStaleUploadSessions(Request $request): array
    {
        $db = Database::instance();

        // Reset sessions that have been in progress for more than 24 hours
        $result = $db->query(
            "UPDATE upload_sessions
             SET status = 'expired', updated_at = UTC_TIMESTAMP(6)
             WHERE status = 'in_progress'
               AND created_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 24 HOUR)"
        );

        $recovered = $result->rowCount();

        AuditService::write(
            $request->user['id'] ?? 'system',
            'system_health_check',
            ['action' => 'recover_stale_upload_sessions', 'recovered' => $recovered]
        );

        return ['recovered' => $recovered];
    }

    // ================================================================
    // REMAINING MISSING RPC EQUIVALENTS
    // ================================================================

    /**
     * GET /rpc/chunk-upload-state — returns upload session progress.
     * Mirrors get_chunk_upload_state(p_session_id uuid)
     */
    public function getChunkUploadState(Request $request): array
    {
        $sessionId = Uuid::normalize((string) ($request->query('session_id', $request->params['sessionId'] ?? '')));
        if ($sessionId === '') {
            throw new ApiException(422, 'session_id is required');
        }
        $db = Database::instance();
        $session = $db->row(
            'SELECT id, status, total_chunks, chunks_completed, chunk_size_bytes,
                    bytes_uploaded, file_name, file_size, mime_type,
                    created_at, updated_at
               FROM upload_sessions WHERE id = ?',
            [$sessionId]
        );
        if ($session === null) {
            throw new ApiException(404, 'Upload session not found');
        }
        return ['session' => $session];
    }

    /**
     * POST /rpc/remove-course-enrollment — admin removes enrollment and refunds credits.
     * Mirrors remove_course_enrollment(p_student_id uuid, p_course_id uuid)
     */
    public function removeCourseEnrollment(Request $request): array
    {
        $body = $request->json();
        $studentId = Uuid::normalize((string) ($body['student_id'] ?? ''));
        $courseId = Uuid::normalize((string) ($body['course_id'] ?? ''));

        if ($studentId === '' || $courseId === '') {
            throw new ApiException(422, 'student_id and course_id are required');
        }

        $db = Database::instance();
        $enrollment = $db->row(
            'SELECT id, credit_cost FROM enrollments WHERE student_id = ? AND course_id = ?',
            [$studentId, $courseId]
        );
        if ($enrollment === null) {
            throw new ApiException(404, 'Enrollment not found');
        }

        // Get course doctor for credit refund
        $course = $db->row('SELECT doctor_id FROM courses WHERE id = ?', [$courseId]);
        $creditCost = $enrollment['credit_cost'] ?? 1;

        $db->transaction(function (Database $db) use ($enrollment, $courseId, $studentId, $creditCost, $course, $request) {
            $db->query('DELETE FROM enrollments WHERE id = ?', [$enrollment['id']]);

            if ($course && $creditCost > 0) {
                $db->query(
                    'UPDATE credits SET remaining = remaining + ?, updated_at = UTC_TIMESTAMP(6)
                      WHERE doctor_id = ?',
                    [$creditCost, $course['doctor_id']]
                );
                $db->insert(
                    'INSERT INTO credit_transactions (id, doctor_id, transaction_type, amount, course_id, student_id, performed_by, notes, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                    [Uuid::v4(), $course['doctor_id'], 'refund', $creditCost, $courseId, $studentId, $request->user['id'], 'Admin removed enrollment']
                );
            }
        });

        AuditService::write($request->user['id'], 'enrollment_removed', [
            'student_id' => $studentId,
            'course_id' => $courseId,
            'credit_refunded' => $creditCost,
        ]);

        return ['success' => true];
    }

    /**
     * POST /rpc/remove-student-and-record-earnings — doctor removes student and records earnings.
     * Mirrors remove_student_and_record_earnings(p_student_id uuid, p_course_id uuid)
     */
    public function removeStudentAndRecordEarnings(Request $request): array
    {
        $body = $request->json();
        $studentId = Uuid::normalize((string) ($body['student_id'] ?? ''));
        $courseId = Uuid::normalize((string) ($body['course_id'] ?? ''));

        if ($studentId === '' || $courseId === '') {
            throw new ApiException(422, 'student_id and course_id are required');
        }

        $db = Database::instance();
        $enrollment = $db->row(
            'SELECT id FROM enrollments WHERE student_id = ? AND course_id = ?',
            [$studentId, $courseId]
        );
        if ($enrollment === null) {
            throw new ApiException(404, 'Enrollment not found');
        }

        $db->transaction(function (Database $db) use ($enrollment, $studentId, $courseId, $request) {
            $db->query('DELETE FROM enrollments WHERE id = ?', [$enrollment['id']]);

            // Record earnings event
            $db->insert(
                'INSERT INTO doctor_earnings_events (id, doctor_id, event_type, student_id, course_id, amount, created_at)
                 VALUES (?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(6))',
                [Uuid::v4(), $request->user['id'], 'student_removed', $studentId, $courseId]
            );
        });

        AuditService::write($request->user['id'], 'student_removed_from_course', [
            'student_id' => $studentId,
            'course_id' => $courseId,
        ]);

        return ['success' => true];
    }

    /**
     * POST /rpc/reset-user-password-by-admin — admin sets user password.
     * Mirrors reset_user_password_by_admin(p_user_id uuid, p_new_password text)
     */
    public function resetUserPasswordByAdmin(Request $request): array
    {
        $body = $request->json();
        $targetUserId = Uuid::normalize((string) ($body['user_id'] ?? ''));
        $newPassword = (string) ($body['new_password'] ?? '');

        if ($targetUserId === '' || $newPassword === '') {
            throw new ApiException(422, 'user_id and new_password are required');
        }
        if (strlen($newPassword) < 8) {
            throw new ApiException(422, 'Password must be at least 8 characters');
        }

        $db = Database::instance();
        $target = $db->row('SELECT id, full_name, role FROM profiles WHERE id = ?', [$targetUserId]);
        if ($target === null) {
            throw new ApiException(404, 'User not found');
        }
        if ($target['role'] === 'super_admin' && $request->user['role'] !== 'super_admin') {
            throw new ApiException(403, 'Only super_admin can reset a super_admin password');
        }

        $hashedPassword = \MedAcademy\Auth\Password::hash($newPassword);
        $db->query(
            'UPDATE users SET encrypted_password = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [$hashedPassword, $targetUserId]
        );

        // Force password change on next login
        $db->query(
            'UPDATE profiles SET force_password_change = 1, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [$targetUserId]
        );

        // Revoke all refresh tokens
        $db->query(
            'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(6), revoked_reason = ?
              WHERE user_id = ? AND revoked_at IS NULL',
            ['admin_password_reset', $targetUserId]
        );

        AuditService::write($request->user['id'], 'password_reset_by_admin', [
            'target_user_id' => $targetUserId,
            'target_name' => $target['full_name'],
        ]);

        return ['success' => true];
    }
}
