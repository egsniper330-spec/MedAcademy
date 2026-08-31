<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Auth\Password;
use MedAcademy\Auth\SessionManager;
use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuthService;
use MedAcademy\Services\AuditService;
use MedAcademy\Utils\Uuid;

/**
 * Admin / super-admin operations. Every mutation is audited.
 * Role restrictions mirror the RLS policies (admin_or_super_admin).
 *
 * Enhanced with:
 *   - bulk-user-ops (trash, restore, suspend, unsuspend, reset_password, reset_devices, permanent_delete)
 *   - admin-enrollment (enroll, remove, set_hidden, search, courses, enrollments)
 *   - admin-update-email (super_admin only)
 */
final class AdminController
{
    public function users(Request $request): array
    {
        $search = trim((string) $request->query('search', ''));
        $role = (string) $request->query('role', '');
        $status = (string) $request->query('status', '');
        $limit = min((int) $request->query('limit', 100), 500);
        $offset = max((int) $request->query('offset', 0), 0);

        $sql = "SELECT id, email, full_name, phone, phone_e164, role, status, watermark_id,
                       created_at, updated_at
                  FROM profiles";
        $where = [];
        $params = [];
        if ($search !== '') {
            $where[] = '(full_name LIKE ? OR email LIKE ? OR phone_e164 LIKE ? OR phone LIKE ?)';
            $like = '%' . $search . '%';
            array_push($params, $like, $like, $like, $like);
        }
        if ($role !== '') {
            $where[] = 'role = ?';
            $params[] = $role;
        }
        if ($status !== '') {
            $where[] = 'status = ?';
            $params[] = $status;
        }
        if ($where) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $sql .= ' ORDER BY created_at DESC LIMIT ' . $limit . ' OFFSET ' . $offset;
        return ['users' => Database::instance()->select($sql, $params)];
    }

    public function userDetail(Request $request): array
    {
        $id = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $user = Database::instance()->row('SELECT * FROM profiles WHERE id = ?', [$id]);
        if ($user === null) {
            throw new ApiException(404, 'User not found');
        }
        $user['devices'] = Database::instance()->select(
            'SELECT id, device_name, platform, status, trust_level, last_active_at, registered_at, installation_id
               FROM devices WHERE user_id = ? ORDER BY last_active_at DESC',
            [$id]
        );
        $user['credits'] = Database::instance()->row('SELECT * FROM credits WHERE doctor_id = ?', [$id]);
        return ['user' => $user];
    }

    public function setRole(Request $request): array
    {
        $userId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $newRole = (string) ($request->json()['role'] ?? '');
        if (!in_array($newRole, ['student', 'doctor', 'assistant', 'admin', 'super_admin'], true)) {
            throw new ApiException(422, 'Invalid role');
        }
        $actor = $request->user['id'];
        $actorRole = $request->user['role'];
        if ($newRole === 'super_admin' && $actorRole !== 'super_admin') {
            throw new ApiException(403, 'Only super admins can assign super_admin');
        }

        $old = Database::instance()->value('SELECT role FROM profiles WHERE id = ?', [$userId]);
        if ($old === null) {
            throw new ApiException(404, 'User not found');
        }

        Database::instance()->transaction(function (Database $db) use ($userId, $newRole, $old) {
            $db->query(
                'UPDATE profiles SET role = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [$newRole, $userId]
            );
            if ($newRole === 'doctor' && $old !== 'doctor') {
                $db->query(
                    'INSERT INTO credits (id, doctor_id, allocated, consumed, remaining) VALUES (?, ?, 0, 0, 0)
                     ON DUPLICATE KEY UPDATE doctor_id = doctor_id',
                    [Uuid::v4(), $userId]
                );
            }
        });
        (new SessionManager())->revokeAllForUser($userId, 'role_changed');
        AuditService::write($actor, 'role_changed', ['user_id' => $userId, 'from' => $old, 'to' => $newRole]);
        return ['success' => true];
    }

    public function setStatus(Request $request): array
    {
        $userId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $status = (string) ($request->json()['status'] ?? '');
        if (!in_array($status, ['active', 'suspended', 'pending', 'deleted', 'trashed', 'blocked'], true)) {
            throw new ApiException(422, 'Invalid status');
        }
        if ($userId === $request->user['id'] && in_array($status, ['suspended', 'deleted', 'trashed'], true)) {
            throw new ApiException(400, 'Cannot suspend or delete your own account');
        }
        $actor = $request->user['id'];

        $db = Database::instance();
        $old = $db->value('SELECT status FROM profiles WHERE id = ?', [$userId]);
        if ($old === null) {
            throw new ApiException(404, 'User not found');
        }

        if (in_array($status, ['deleted', 'trashed'], true)) {
            $db->query(
                'UPDATE profiles SET status = ?, pre_trash_status = ?, trashed_at = UTC_TIMESTAMP(6),
                        trash_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 DAY)
                  WHERE id = ?',
                [$status, $old, $userId]
            );
        } else {
            $db->query('UPDATE profiles SET status = ?, is_suspended = ?, suspension_at = NULL WHERE id = ?', [
                $status,
                $status === 'suspended' ? 1 : 0,
                $userId,
            ]);
        }
        (new SessionManager())->revokeAllForUser($userId, 'status_changed:' . $status);
        AuditService::write($actor, 'user_suspended', ['user_id' => $userId, 'status' => $status]);
        return ['success' => true];
    }

    public function blockUser(Request $request): array
    {
        $userId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $reason = (string) ($request->json()['reason'] ?? 'Blocked by administrator');
        Database::instance()->query(
            "UPDATE profiles SET status = 'blocked', suspension_reason = ? WHERE id = ?",
            [$reason, $userId]
        );
        (new SessionManager())->revokeAllForUser($userId, 'account_blocked');
        AuditService::write($request->user['id'], 'user_suspended', ['user_id' => $userId, 'reason' => $reason]);
        return ['success' => true];
    }

    public function restoreUser(Request $request): array
    {
        $userId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $db = Database::instance();

        // Check if user is trashed
        $profile = $db->row(
            "SELECT id, status, email FROM profiles WHERE id = ? AND status IN ('trashed','deleted','blocked')",
            [$userId]
        );
        if ($profile === null) {
            throw new ApiException(404, 'Trashed user not found');
        }

        // Determine restore status: try pre_trash_status, fall back to 'active'
        $restoreStatus = 'active';
        try {
            $pts = $db->value('SELECT pre_trash_status FROM profiles WHERE id = ?', [$userId]);
            if ($pts && $pts !== 'trashed' && $pts !== 'deleted' && $pts !== 'blocked') {
                $restoreStatus = $pts;
            }
        } catch (\Throwable $e) {
            // Column doesn't exist — use 'active'
        }

        // Check email conflict: another active account might have taken this email
        $emailConflict = $db->value(
            "SELECT id FROM profiles WHERE email = ? AND id != ? AND status NOT IN ('trashed','deleted','blocked')",
            [$profile['email'], $userId]
        );
        if ($emailConflict !== null) {
            throw new ApiException(409, 'Cannot restore: email is already used by another active account');
        }

        $db->query(
            'UPDATE profiles SET status = ?, trashed_at = NULL,
                    trash_expires_at = NULL, is_suspended = 0, suspension_reason = NULL,
                    updated_at = UTC_TIMESTAMP(6)
              WHERE id = ?',
            [$restoreStatus, $userId]
        );

        // Restore the original email in the users table (undo tombstone)
        $db->query('UPDATE users SET email = ? WHERE id = ?', [$profile['email'], $userId]);

        AuditService::write($request->user['id'], 'user_activated', ['user_id' => $userId, 'action' => 'restore']);
        return ['success' => true];
    }

    public function resetDevices(Request $request): array
    {
        $userId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        Database::instance()->query(
            "UPDATE devices SET status = 'logged_out', trust_level = 'revoked',
                    revoked_at = UTC_TIMESTAMP(6), revoked_reason = 'admin_device_reset'
              WHERE user_id = ?",
            [$userId]
        );
        (new SessionManager())->revokeAllForUser($userId, 'admin_device_reset');
        AuditService::write($request->user['id'], 'device_reset', ['user_id' => $userId]);
        return ['success' => true];
    }

    public function auditLogs(Request $request): array
    {
        $userId = (string) $request->query('user_id', '');
        $action = (string) $request->query('action', '');
        $search = (string) $request->query('search', '');
        $limit = min((int) $request->query('limit', 100), 500);
        $offset = max((int) $request->query('offset', 0), 0);

        $sql = 'SELECT id, user_id, actor_id, action, details, old_values, new_values, description,
                       target_name, ip_address, log_status, created_at FROM audit_logs';
        $where = [];
        $params = [];
        if ($userId !== '') {
            $where[] = 'user_id = ?';
            $params[] = $userId;
        }
        if ($action !== '') {
            $where[] = 'action = ?';
            $params[] = $action;
        }
        if ($search !== '') {
            $where[] = '(description LIKE ? OR target_name LIKE ? OR actor_name LIKE ?)';
            $like = '%' . $search . '%';
            array_push($params, $like, $like, $like);
        }
        if ($where) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $sql .= ' ORDER BY created_at DESC LIMIT ' . $limit . ' OFFSET ' . $offset;
        $rows = Database::instance()->select($sql, $params);
        foreach ($rows as &$r) {
            $r['details'] = json_decode((string) $r['details'], true);
            $r['old_values'] = json_decode((string) ($r['old_values'] ?? '{}'), true);
            $r['new_values'] = json_decode((string) ($r['new_values'] ?? '{}'), true);
        }
        return ['logs' => $rows];
    }

    public function stats(Request $request): array
    {
        $db = Database::instance();
        return [
            'users' => (int) $db->value("SELECT COUNT(*) FROM profiles WHERE status NOT IN ('trashed','deleted')"),
            'doctors' => (int) $db->value("SELECT COUNT(*) FROM profiles WHERE role IN ('doctor','admin','super_admin')"),
            'courses' => (int) $db->value("SELECT COUNT(*) FROM courses WHERE status = 'published'"),
            'enrollments' => (int) $db->value('SELECT COUNT(*) FROM enrollments'),
            'active_devices' => (int) $db->value("SELECT COUNT(*) FROM devices WHERE status = 'active'"),
            'trashed_users' => (int) $db->value("SELECT COUNT(*) FROM profiles WHERE status = 'trashed'"),
        ];
    }

    public function securityConfig(Request $request): array
    {
        return ['config' => Database::instance()->row(
            'SELECT * FROM security_config WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1'
        )];
    }

    public function updateSecurityConfig(Request $request): array
    {
        $data = $request->json();
        $allowed = [
            'play_integrity_enabled', 'expected_cert_sha256', 'expected_cert_sha256s',
            'minimum_app_version', 'minimum_supported_version', 'latest_version',
            'force_update', 'update_title', 'update_message',
            'android_store_url', 'ios_store_url', 'extras', 'security_version',
        ];
        $sets = [];
        $params = [];
        foreach ($allowed as $col) {
            if (array_key_exists($col, $data)) {
                $sets[] = '`' . $col . '` = ?';
                $params[] = is_bool($data[$col]) ? ($data[$col] ? 1 : 0)
                    : (is_array($data[$col]) ? json_encode($data[$col], JSON_UNESCAPED_SLASHES) : $data[$col]);
            }
        }
        if ($sets === []) {
            throw new ApiException(422, 'No fields to update');
        }
        $sets[] = 'updated_at = UTC_TIMESTAMP(6)';
        $sets[] = 'updated_by = ?';
        $params[] = $request->user['id'];
        Database::instance()->query(
            'UPDATE security_config SET ' . implode(', ', $sets) . ' WHERE is_active = 1',
            $params
        );
        AuditService::write($request->user['id'], 'security_event', ['action' => 'update_security_config']);
        return ['success' => true];
    }

    // ================================================================
    // BULK USER OPERATIONS
    // ================================================================

    /**
     * POST /admin/bulk-user-ops — bulk operations on user accounts.
     * Port of bulk-user-ops Edge Function.
     */
    public function bulkUserOps(Request $request): array
    {
        $body = $request->json();
        $operation = (string) ($body['operation'] ?? '');
        $userIds = $body['user_ids'] ?? [];
        $reason = (string) ($body['reason'] ?? '');
        $actorId = $request->user['id'];
        $actorRole = $request->user['role'];
        $actorProfile = Database::instance()->row('SELECT full_name FROM profiles WHERE id = ?', [$actorId]);
        $actorName = $actorProfile['full_name'] ?? 'Unknown';

        if (!is_array($userIds) || count($userIds) === 0) {
            throw new ApiException(422, 'user_ids array required');
        }
        if (count($userIds) > 200) {
            throw new ApiException(422, 'Max 200 users per bulk operation');
        }

        // Remove self from list
        $userIds = array_values(array_filter($userIds, fn ($id) => $id !== $actorId));

        $success = 0;
        $failed = 0;
        $errors = [];

        match ($operation) {
            'trash' => $this->bulkTrash($userIds, $actorId, $reason, $success, $failed, $errors),
            'restore' => $this->bulkRestore($userIds, $actorId, $success, $failed, $errors),
            'suspend' => $this->bulkStatus($userIds, 'suspended', $actorId, $actorName, $reason, $success),
            'unsuspend' => $this->bulkStatus($userIds, 'active', $actorId, $actorName, $reason, $success),
            'reset_devices' => $this->bulkResetDevices($userIds, $actorId, $actorName, $success),
            'reset_password' => $this->bulkResetPassword($userIds, $actorId, $actorName, $success, $failed, $errors),
            'permanent_delete' => $this->bulkPermanentDelete($userIds, $actorId, $reason, $success, $failed, $errors),
            default => throw new ApiException(422, "Unknown operation: {$operation}"),
        };

        return [
            'success' => true,
            'operation' => $operation,
            'processed' => count($userIds),
            'succeeded' => $success,
            'failed' => $failed,
            'errors' => $errors,
        ];
    }

    private function bulkTrash(array $userIds, string $actorId, string $reason, int &$success, int &$failed, array &$errors): void
    {
        $db = Database::instance();
        foreach ($userIds as $userId) {
            try {
                $old = $db->value('SELECT status FROM profiles WHERE id = ?', [$userId]);
                if ($old === null || $old === 'trashed') {
                    $failed++;
                    $errors[] = ['user_id' => $userId, 'message' => 'User not found or already trashed'];
                    continue;
                }
                $db->query(
                    "UPDATE profiles SET status = 'trashed', pre_trash_status = ?, trashed_at = UTC_TIMESTAMP(6),
                            trash_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 DAY)
                      WHERE id = ?",
                    [$old, $userId]
                );
                $success++;
            } catch (\Throwable $e) {
                $failed++;
                $errors[] = ['user_id' => $userId, 'message' => $e->getMessage()];
            }
        }
    }

    private function bulkRestore(array $userIds, string $actorId, int &$success, int &$failed, array &$errors): void
    {
        $db = Database::instance();
        foreach ($userIds as $userId) {
            try {
                $old = $db->value("SELECT pre_trash_status FROM profiles WHERE id = ? AND status = 'trashed'", [$userId]);
                if ($old === null) {
                    $failed++;
                    $errors[] = ['user_id' => $userId, 'message' => 'User not found or not trashed'];
                    continue;
                }
                $db->query(
                    "UPDATE profiles SET status = ?, pre_trash_status = NULL, trashed_at = NULL,
                            trash_expires_at = NULL WHERE id = ?",
                    [$old, $userId]
                );
                $success++;
            } catch (\Throwable $e) {
                $failed++;
                $errors[] = ['user_id' => $userId, 'message' => $e->getMessage()];
            }
        }
    }

    private function bulkStatus(array $userIds, string $newStatus, string $actorId, string $actorName, string $reason, int &$success): void
    {
        $db = Database::instance();
        $db->query(
            "UPDATE profiles SET status = ?, is_suspended = ? WHERE id IN (" . implode(',', array_fill(0, count($userIds), '?')) . ")",
            array_merge([$newStatus, $newStatus === 'suspended' ? 1 : 0], $userIds)
        );
        $success = count($userIds);

        AuditService::write($actorId, $newStatus === 'suspended' ? 'bulk_suspend' : 'bulk_unsuspend', [
            'affected_count' => count($userIds),
            'reason' => $reason,
        ]);
    }

    private function bulkResetDevices(array $userIds, string $actorId, string $actorName, int &$success): void
    {
        $db = Database::instance();
        $db->query(
            "UPDATE devices SET status = 'logged_out', trust_level = 'revoked',
                    revoked_at = UTC_TIMESTAMP(6), revoked_reason = 'bulk_device_reset'
              WHERE user_id IN (" . implode(',', array_fill(0, count($userIds), '?')) . ")",
            $userIds
        );
        $success = count($userIds);

        AuditService::write($actorId, 'bulk_reset_devices', [
            'affected_count' => count($userIds),
        ]);
    }

    private function bulkResetPassword(array $userIds, string $actorId, string $actorName, int &$success, int &$failed, array &$errors): void
    {
        // Generate temporary passwords and update
        $db = Database::instance();
        foreach ($userIds as $userId) {
            try {
                $tempPassword = substr(str_replace(['/', '+', '='], '', base64_encode(random_bytes(12))), 0, 12) . '!';
                $db->query(
                    'UPDATE users SET encrypted_password = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                    [Password::hash($tempPassword), $userId]
                );
                $success++;
            } catch (\Throwable $e) {
                $failed++;
                $errors[] = ['user_id' => $userId, 'message' => $e->getMessage()];
            }
        }

        AuditService::write($actorId, 'bulk_reset_password', [
            'affected_count' => $success,
            'failed' => $failed,
        ]);
    }

    private function bulkPermanentDelete(array $userIds, string $actorId, string $reason, int &$success, int &$failed, array &$errors): void
    {
        if ($actorId !== null) {
            $actorRole = Database::instance()->value('SELECT role FROM profiles WHERE id = ?', [$actorId]);
            if ($actorRole !== 'super_admin') {
                throw new ApiException(403, 'Only super_admin can permanently delete accounts');
            }
        }

        $db = Database::instance();
        foreach ($userIds as $userId) {
            try {
                $this->hardDeleteUser($db, $userId);
                $success++;
            } catch (\Throwable $e) {
                $failed++;
                $errors[] = ['user_id' => $userId, 'message' => $e->getMessage()];
            }
        }

        AuditService::write($actorId, 'bulk_permanent_delete', [
            'deleted' => $success,
            'failed' => $failed,
            'reason' => $reason,
        ]);
    }

    // ================================================================
    // ADMIN ENROLLMENT
    // ================================================================

    /**
     * POST /admin/enrollment — admin enrollment management.
     * Port of admin-enrollment Edge Function.
     */
    public function adminEnrollment(Request $request): array
    {
        $body = $request->json();
        $action = (string) ($body['action'] ?? '');
        $actorId = $request->user['id'];

        return match ($action) {
            'enroll' => $this->adminEnrollStudent($body, $actorId),
            'remove' => $this->adminRemoveEnrollment($body, $actorId),
            'search' => $this->adminSearchUsers($body),
            'courses' => $this->adminListCourses(),
            'enrollments' => $this->adminListEnrollments($body),
            default => throw new ApiException(422, "Unknown action: {$action}"),
        };
    }

    private function adminEnrollStudent(array $body, string $actorId): array
    {
        $studentId = (string) ($body['student_id'] ?? '');
        $courseId = (string) ($body['course_id'] ?? '');
        $visibility = (string) ($body['visibility_level'] ?? 'all');

        if ($studentId === '' || $courseId === '') {
            throw new ApiException(422, 'student_id and course_id are required');
        }

        $db = Database::instance();

        // Check student exists
        $student = $db->row('SELECT id, role, status FROM profiles WHERE id = ?', [$studentId]);
        if ($student === null || $student['status'] === 'suspended') {
            throw new ApiException(404, 'Student not found or is suspended');
        }

        // Check course exists
        $course = $db->row('SELECT id, title FROM courses WHERE id = ?', [$courseId]);
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }

        // Check already enrolled
        $exists = $db->value(
            'SELECT COUNT(*) FROM enrollments WHERE student_id = ? AND course_id = ?',
            [$studentId, $courseId], 0
        );
        if ($exists > 0) {
            return ['success' => true, 'already_enrolled' => true, 'message' => 'This user is already enrolled in this course.'];
        }

        $enrollmentId = Uuid::v4();
        $db->insert(
            "INSERT INTO enrollments (id, student_id, course_id, enrolled_by, enrollment_method, visibility_level, status, enrolled_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))",
            [$enrollmentId, $studentId, $courseId, $actorId, 'admin_enrolled', $visibility]
        );

        AuditService::write($actorId, 'enrollment_created_by_admin', [
            'student_id' => $studentId,
            'course_id' => $courseId,
        ]);

        return ['success' => true, 'enrollment_id' => $enrollmentId, 'message' => 'User enrolled successfully.'];
    }

    private function adminRemoveEnrollment(array $body, string $actorId): array
    {
        $enrollmentId = (string) ($body['enrollment_id'] ?? '');
        if ($enrollmentId === '') {
            throw new ApiException(422, 'enrollment_id is required');
        }

        $db = Database::instance();
        $enrollment = $db->row('SELECT id FROM enrollments WHERE id = ?', [$enrollmentId]);
        if ($enrollment === null) {
            throw new ApiException(404, 'Enrollment not found');
        }

        $db->query('DELETE FROM enrollments WHERE id = ?', [$enrollmentId]);
        AuditService::write($actorId, 'enrollment_removed_by_admin', ['enrollment_id' => $enrollmentId]);

        return ['success' => true, 'message' => 'Enrollment removed successfully.'];
    }

    private function adminSearchUsers(array $body): array
    {
        $query = trim((string) ($body['query'] ?? ''));
        if ($query === '') {
            return ['users' => []];
        }

        $db = Database::instance();
        $like = '%' . $query . '%';

        // UUID exact match
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $query)) {
            $users = $db->select(
                'SELECT id, full_name, email, phone, phone_e164, role, status, watermark_id, avatar_url FROM profiles WHERE id = ? LIMIT 1',
                [$query]
            );
            return ['users' => $users ?? []];
        }

        $users = $db->select(
            "SELECT id, full_name, email, phone, phone_e164, role, status, watermark_id, avatar_url
               FROM profiles
              WHERE full_name LIKE ? OR email LIKE ? OR phone LIKE ? OR phone_e164 LIKE ? OR watermark_id LIKE ?
              ORDER BY full_name ASC LIMIT 20",
            [$like, $like, $like, $like, $like]
        );

        return ['users' => $users ?? []];
    }

    private function adminListCourses(): array
    {
        $courses = Database::instance()->select(
            "SELECT c.id, c.title, c.status, p.full_name AS doctor_name
               FROM courses c
               LEFT JOIN profiles p ON p.id = c.doctor_id
              ORDER BY c.title ASC LIMIT 500"
        );
        return ['courses' => $courses ?? []];
    }

    private function adminListEnrollments(array $body): array
    {
        $courseId = (string) ($body['course_id'] ?? '');
        if ($courseId === '') {
            throw new ApiException(422, 'course_id is required');
        }

        $enrollments = Database::instance()->select(
            "SELECT e.id, e.student_id, e.course_id, e.enrolled_at, e.visibility_level, e.enrollment_method,
                    p.full_name, p.email, p.watermark_id
               FROM enrollments e
               LEFT JOIN profiles p ON p.id = e.student_id
              WHERE e.course_id = ?
              ORDER BY e.enrolled_at DESC LIMIT 200",
            [$courseId]
        );

        return ['enrollments' => $enrollments ?? []];
    }

    // ================================================================
    // ADMIN UPDATE EMAIL
    // ================================================================

    /**
     * POST /admin/update-email — super_admin changes user's email.
     * Port of admin-update-email Edge Function.
     */
    public function adminUpdateEmail(Request $request): array
    {
        if ($request->user['role'] !== 'super_admin') {
            throw new ApiException(403, 'Only Super Admin can change user emails');
        }

        $body = $request->json();
        $targetUserId = (string) ($body['target_user_id'] ?? '');
        $newEmail = strtolower(trim((string) ($body['new_email'] ?? '')));

        if ($targetUserId === '' || $newEmail === '') {
            throw new ApiException(422, 'target_user_id and new_email are required');
        }

        if (!filter_var($newEmail, FILTER_VALIDATE_EMAIL)) {
            throw new ApiException(422, 'Invalid email address format');
        }

        if (str_ends_with($newEmail, '@medacademy.internal')) {
            throw new ApiException(422, 'Cannot set an internal placeholder email');
        }

        $db = Database::instance();

        // Check uniqueness
        $existing = $db->value(
            'SELECT COUNT(*) FROM profiles WHERE (email = ? OR profile_email = ?) AND id <> ?',
            [$newEmail, $newEmail, $targetUserId], 0
        );
        if ($existing > 0) {
            throw new ApiException(409, 'This email address is already in use by another account');
        }

        // Update users table
        $db->query(
            'UPDATE users SET email = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [$newEmail, $targetUserId]
        );

        // Update profiles table
        $db->query(
            'UPDATE profiles SET email = ?, profile_email = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [$newEmail, $newEmail, $targetUserId]
        );

        AuditService::write($request->user['id'], 'email_changed', [
            'target_user_id' => $targetUserId,
            'new_email' => $newEmail,
        ]);

        return ['success' => true, 'email' => $newEmail];
    }

    // ================================================================
    // MISSING EDGE FUNCTION EQUIVALENTS
    // ================================================================

    /**
     * POST /admin/delete-user — permanent user deletion pipeline.
     * Mirrors supabase/functions/delete-user/index.ts
     */
    public function deleteUser(Request $request): array
    {
        $body = $request->json();
        $targetUserId = Uuid::normalize((string) ($body['target_user_id'] ?? ''));
        $reason = (string) ($body['reason'] ?? 'Permanent delete by admin');

        if ($targetUserId === '') {
            throw new ApiException(422, 'target_user_id is required');
        }
        if ($targetUserId === $request->user['id']) {
            throw new ApiException(400, 'Cannot delete your own account');
        }

        $db = Database::instance();
        $target = $db->row('SELECT id, full_name, role, email, phone FROM profiles WHERE id = ?', [$targetUserId]);
        if ($target === null) {
            throw new ApiException(404, 'User not found');
        }
        if ($target['role'] === 'super_admin' && $request->user['role'] !== 'super_admin') {
            throw new ApiException(403, 'Only super_admin can delete a super_admin');
        }

        // 1. Collect VdoCipher video IDs (before DB delete)
        $vdoVideoIds = [];
        if ($target['role'] === 'doctor') {
            $videos = $db->select('SELECT provider_video_id FROM video_uploads WHERE doctor_id = ?', [$targetUserId]);
            foreach ($videos as $v) {
                if ($v['provider_video_id']) $vdoVideoIds[] = $v['provider_video_id'];
            }
        }

        // 2. DB cascade delete via shared helper (transaction-safe)
        $db->transaction(function (Database $db) use ($targetUserId) {
            $this->hardDeleteUser($db, $targetUserId);
        });

        // 3. VdoCipher cleanup (best-effort)
        $videosRemoved = 0;
        $apiSecret = \MedAcademy\Utils\Config::string('VDOCIPHER_API_SECRET', '');
        if ($apiSecret !== '' && count($vdoVideoIds) > 0) {
            foreach ($vdoVideoIds as $vid) {
                try {
                    $ch = curl_init('https://dev.vdocipher.com/api/videos/' . rawurlencode($vid));
                    curl_setopt_array($ch, [
                        CURLOPT_DELETE => true,
                        CURLOPT_HTTPHEADER => ['Authorization: Apisecret ' . $apiSecret],
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_TIMEOUT => 10,
                    ]);
                    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                    curl_close($ch);
                    if ($status === 200 || $status === 404) $videosRemoved++;
                } catch (\Throwable) {}
            }
        }

        AuditService::write($request->user['id'], 'user_hard_deleted', [
            'target_user_id' => $targetUserId,
            'target_name' => $target['full_name'],
            'target_role' => $target['role'],
            'reason' => $reason,
            'videos_removed' => $videosRemoved,
        ]);

        return [
            'success' => true,
            'deleted_user_id' => $targetUserId,
            'deleted_name' => $target['full_name'],
            'videos_removed' => $videosRemoved,
        ];
    }

    /**
     * POST /admin/audit-logs — write an audit log entry (write_audit_log RPC port).
     * Any authenticated user may write audit entries; reading is admin-only (GET route).
     */
    public function writeAuditLog(Request $request): array
    {
        $body = $request->json();
        $actorId = (string) ($body['p_actor_id'] ?? $body['actor_id'] ?? $request->user['id'] ?? '');
        $action = (string) ($body['p_action'] ?? $body['action'] ?? '');
        if ($action === '') {
            throw new ApiException(422, 'p_action is required');
        }
        $details = $body['p_details'] ?? $body['details'] ?? [];
        if (!is_array($details)) {
            $details = [];
        }
        $details['resource_type'] = $body['p_resource_type'] ?? $body['resource_type'] ?? null;
        $details['resource_id'] = $body['p_resource_id'] ?? $body['resource_id'] ?? null;

        AuditService::write($actorId !== '' ? $actorId : null, $action, $details, $request->clientIp());
        return ['success' => true];
    }

    /**
     * GET /admin/delete-user/preflight — account summary WITHOUT deleting.
     * Mirrors the GET path of the delete-user Edge Function (preflight modal).
     * NEVER deletes anything — returns only counts for the confirmation UI.
     */
    public function deleteUserPreflight(Request $request): array
    {
        $targetUserId = Uuid::normalize((string) ($request->query('target_user_id', '') ?: ($request->json()['target_user_id'] ?? '')));
        if ($targetUserId === '') {
            throw new ApiException(422, 'target_user_id is required');
        }

        $db = Database::instance();
        $target = $db->row('SELECT id, full_name, email, phone, role FROM profiles WHERE id = ?', [$targetUserId]);
        if ($target === null) {
            return ['found' => false, 'id' => $targetUserId];
        }

        return [
            'found' => true,
            'id' => $target['id'],
            'role' => $target['role'],
            'full_name' => $target['full_name'],
            'email' => $target['email'],
            'phone' => $target['phone'],
            'active_courses' => (int) $db->value('SELECT COUNT(*) FROM courses WHERE doctor_id = ?', [$targetUserId], 0),
            'credits_remaining' => (int) ($db->row('SELECT remaining FROM credits WHERE doctor_id = ?', [$targetUserId])['remaining'] ?? 0),
            'devices' => (int) $db->value('SELECT COUNT(*) FROM devices WHERE user_id = ?', [$targetUserId], 0),
            'active_enrollments' => (int) $db->value("SELECT COUNT(*) FROM enrollments WHERE student_id = ? AND status = 'active'", [$targetUserId], 0),
        ];
    }

    /**
     * POST /admin/user-lookup — search user by email, phone, user_id, or name.
     * Mirrors supabase/functions/user-lookup/index.ts
     */
    public function userLookup(Request $request): array
    {
        $body = $request->json();
        $identifier = trim((string) ($body['identifier'] ?? ''));

        if ($identifier === '') {
            throw new ApiException(422, 'identifier is required');
        }

        $db = Database::instance();
        $results = $db->select(
            'SELECT id, full_name, email, phone, role, status, avatar_url
               FROM profiles
              WHERE email LIKE ?
                 OR phone LIKE ?
                 OR full_name LIKE ?
                 OR id = ?
              LIMIT 20',
            ['%' . $identifier . '%', '%' . $identifier . '%', '%' . $identifier . '%', $identifier]
        );

        return ['users' => $results];
    }

    /**
     * POST /admin/user-management — create user with any role.
     * Mirrors supabase/functions/user-management/index.ts
     */
    public function userManagement(Request $request): array
    {
        $body = $request->json();
        $email = trim((string) ($body['email'] ?? ''));
        $fullName = trim((string) ($body['full_name'] ?? ''));
        $role = (string) ($body['role'] ?? 'student');
        $phone = $body['phone'] ?? null;
        $password = (string) ($body['password'] ?? '');

        if ($email === '' || $fullName === '') {
            throw new ApiException(422, 'email and full_name are required');
        }

        $actorRole = $request->user['role'];
        $allowedRoles = ['student', 'doctor', 'assistant', 'admin'];
        if ($actorRole !== 'super_admin') {
            $allowedRoles = ['student', 'doctor', 'assistant', 'admin'];
        }
        if (!in_array($role, $allowedRoles, true)) {
            throw new ApiException(403, 'Cannot create users with role: ' . $role);
        }

        $db = Database::instance();
        // Only reject if an ACTIVE (non-trashed) account uses this email.
        // Trashed accounts have their users.email tombstoned, so the unique
        // constraint on users.email is already satisfied.  profiles.email retains
        // the original address for restore-reference, but we must not block
        // re-creation of a new account with the same email.
        $existing = $db->value(
            "SELECT COUNT(*) FROM profiles WHERE email = ? AND status NOT IN ('trashed','deleted')",
            [$email], 0
        );
        if ($existing > 0) {
            throw new ApiException(409, 'An account with this email already exists');
        }

        // Create user
        $userId = Uuid::v4();
        $hashedPassword = $password !== '' ? \MedAcademy\Auth\Password::hash($password) : null;

        // Phone uniqueness pre-check (mirrors /auth/register) so a duplicate
        // phone surfaces as a clean 409, not a raw constraint 500.
        $phoneE164 = null;
        if ($phone !== null && trim((string) $phone) !== '') {
            $phoneE164 = (new AuthService())->normalizePhone((string) $phone);
            $phoneExists = $db->value('SELECT COUNT(*) FROM users WHERE phone = ?', [$phoneE164], 0);
            if ($phoneExists > 0) {
                throw new ApiException(409, 'An account with this phone number already exists', 'phone_taken');
            }
        }

        $db->transaction(function (Database $db) use ($userId, $email, $fullName, $phone, $phoneE164, $role, $hashedPassword, $request) {
            // 1. Create the auth user. `phone` is intentionally NOT inserted
            //    here: inserting users.phone fires trg_sync_auth_phone_on_new_user
            //    → UPDATE profiles → fires trg_sync_auth_phone_on_profile_update
            //    → UPDATE users → MySQL Error 1442 → 500. The UPDATE profiles
            //    below syncs it back legally (its trigger writes users.phone).
            //    trg_on_auth_user_created fires and creates the profiles row;
            //    role is carried in raw_user_meta_data so that trigger (and its
            //    doctor-credits trigger) see the correct role.
            $db->insert(
                'INSERT INTO users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
                 VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                [
                    $userId,
                    $email,
                    $hashedPassword,
                    json_encode(['full_name' => $fullName, 'role' => $role, 'phone' => $phone], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                ]
            );

            // 2. Fill in the profiles row the trigger created — no second
            //    INSERT (that would collide with the trigger's row on the
            //    primary key). The phone_e164 write syncs users.phone back
            //    via trg_sync_auth_phone_on_profile_update.
            $watermarkId = (new AuthService())->nextWatermarkId();
            $db->query(
                'UPDATE profiles
                    SET email = ?, full_name = ?, phone = ?, phone_e164 = ?,
                        role = ?, status = ?, watermark_id = ?,
                        updated_at = UTC_TIMESTAMP(6)
                  WHERE id = ?',
                [$email, $fullName, $phone, $phoneE164, $role, 'active', $watermarkId, $userId]
            );

            // 3. Credits row (idempotent — the doctor-credits trigger may
            //    already have created one when role = 'doctor').
            $db->query(
                'INSERT INTO credits (doctor_id, allocated, consumed, remaining, updated_at)
                 VALUES (?, 0, 0, 0, UTC_TIMESTAMP(6))
                 ON DUPLICATE KEY UPDATE updated_at = updated_at',
                [$userId]
            );
        });

        AuditService::write($request->user['id'], 'user_created', [
            'new_user_id' => $userId,
            'email' => $email,
            'role' => $role,
        ]);

        return ['success' => true, 'user_id' => $userId];
    }

    /**
     * POST /admin/trash-cleanup — manual "empty trash now" equivalent of the
     * cron-trash-cleanup.php script (trash-cleanup Edge Function port).
     * Permanently deletes trashed users whose retention period has expired.
     */
    public function runTrashCleanup(Request $request): array
    {
        $db = Database::instance();
        $deleted = 0;
        $failed = 0;

        $trashedUsers = $db->select(
            "SELECT id, trashed_at, trash_expires_at FROM profiles
              WHERE status = 'trashed' AND trash_expires_at IS NOT NULL
                AND trash_expires_at <= UTC_TIMESTAMP(6)"
        );

        foreach ($trashedUsers as $user) {
            try {
                $userId = $user['id'];
                $this->hardDeleteUser($db, $userId);
                $deleted++;
            } catch (\Throwable $e) {
                $failed++;
            }
        }

        // Recover stale upload sessions (mirrors the cron script)
        $db->query(
            "UPDATE upload_sessions SET status = 'expired', error_message = 'Expired by trash cleanup'
              WHERE status = 'uploading' AND updated_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 24 HOUR)"
        );

        AuditService::write($request->user['id'], 'trash_emptied', ['deleted' => $deleted, 'failed' => $failed]);
        return ['deleted' => $deleted, 'failed' => $failed];
    }

    // ================================================================
    // SHARED PERMANENT DELETION HELPER
    // ================================================================

    /**
     * Permanently delete a user and all dependent records.
     * Must be called inside a transaction (or the caller handles tx).
     * Handles all FK constraints via explicit deletes + audit anonymization.
     */
    private function hardDeleteUser(Database $db, string $userId): void
    {
        // Determine which tables exist so we skip missing ones safely.
        // Once a query fails inside a MySQL transaction the entire
        // transaction aborts, so we MUST check before issuing any DML.
        $existingTables = [];
        $rows = $db->select(
            "SELECT table_name FROM information_schema.tables
              WHERE table_schema = DATABASE()"
        );
        foreach ($rows as $r) {
            $existingTables[$r['table_name']] = true;
        }
        $has = fn(string $t) => isset($existingTables[$t]);

        // Anonymize audit logs (preserve record, remove user reference)
        if ($has('audit_logs')) {
            $db->query(
                'UPDATE audit_logs SET user_id = NULL, actor_id = NULL,
                        details = JSON_SET(COALESCE(details, JSON_OBJECT()), "$.anonymized", true)
                  WHERE user_id = ? OR actor_id = ?',
                [$userId, $userId]
            );
        }

        // Explicitly delete dependent child records (only if table exists)
        $deletes = [
            ['devices',           'user_id'],
            ['push_tokens',       'user_id'],
            ['refresh_tokens',    'user_id'],
            ['notifications',     'user_id'],
            ['login_history',     'user_id'],
            ['security_events',   'user_id'],
            ['content_protection_violations', 'user_id'],
            ['analytics_events',  'user_id'],
            ['crash_logs',        'user_id'],
            ['lesson_progress',   'student_id'],
            ['enrollments',       'student_id'],
            ['credits',           'doctor_id'],
            ['idempotency_keys',  'user_id'],
        ];
        foreach ($deletes as [$table, $col]) {
            if ($has($table)) {
                $db->query("DELETE FROM `{$table}` WHERE `{$col}` = ?", [$userId]);
            }
        }

        // Multi-column deletes (table + compound WHERE)
        if ($has('fraud_flags')) {
            $db->query('DELETE FROM fraud_flags WHERE doctor_id = ? OR resolved_by = ?', [$userId, $userId]);
        }
        if ($has('credit_transactions')) {
            $db->query('DELETE FROM credit_transactions WHERE doctor_id = ? OR student_id = ?', [$userId, $userId]);
        }
        if ($has('activation_codes')) {
            $db->query('DELETE FROM activation_codes WHERE used_by = ? OR created_by = ?', [$userId, $userId]);
        }
        if ($has('code_batches')) {
            $db->query('DELETE FROM code_batches WHERE created_by = ?', [$userId]);
        }
        if ($has('assistant_permissions')) {
            $db->query('DELETE FROM assistant_permissions WHERE assistant_id = ?', [$userId]);
        }

        // Remaining FKs (courses.archived_by, courses.restored_by, etc.)
        // are handled by ON DELETE SET NULL from migration 007.
        $db->query('DELETE FROM profiles WHERE id = ?', [$userId]);
        $db->query('DELETE FROM users WHERE id = ?', [$userId]);
    }
}
