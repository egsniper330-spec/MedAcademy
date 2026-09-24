<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Http\Response;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\FeatureFlagService;
use MedAcademy\Services\VideoProviderPolicyService;
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
    public function __construct(
        private readonly FeatureFlagService $flags = new FeatureFlagService()
    ) {
    }

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

        // Normalize to E.164 first (any format works), then fall back to the
        // raw value — mirrors the original normalize_phone_e164() + the v69 raw
        // phone fallback in the Supabase function. Excludes trashed/deleted
        // accounts like the v74 version.
        $e164 = $this->normalizePhoneE164($phone);
        $lookups = array_values(array_unique(array_filter([$e164, $phone])));
        $ph = implode(',', array_fill(0, count($lookups), '?'));

        $row = Database::instance()->row(
            "SELECT u.email
               FROM users u
               JOIN profiles p ON p.id = u.id
              WHERE (u.phone IN ({$ph}) OR p.phone_e164 IN ({$ph}) OR p.phone IN ({$ph}))
                AND p.status NOT IN ('trashed', 'deleted')
              LIMIT 1",
            array_merge($lookups, $lookups, $lookups)
        );

        // Original RPC RETURNS TEXT — a bare email string (or null), not an
        // object. The frontend reads the RPC result directly as the email
        // (`data ?? null`). Response::json exits; the return is unreachable
        // but keeps the array return type.
        Response::json($row['email'] ?? null);
        return [];
    }

    /**
     * E.164 phone normalization — mirrors the Supabase normalize_phone_e164().
     * Accepts: +201020182886, 00201020182886, 01020182886, 201020182886,
     * and bare 10-digit (or shorter) local formats → +20 (Egypt).
     */
    private function normalizePhoneE164(string $phone): ?string
    {
        $raw = preg_replace('/[\s\-()]/', '', $phone);
        if ($raw === '') {
            return null;
        }
        if (preg_match('/^\+[1-9]\d{6,14}$/', $raw)) {
            return $raw;
        }
        if (preg_match('/^00([1-9]\d{6,14})$/', $raw, $m)) {
            return '+' . $m[1];
        }
        if (preg_match('/^0([1-9]\d{9})$/', $raw, $m)) {
            return '+20' . $m[1];
        }
        if (preg_match('/^([1-9]\d{9})$/', $raw, $m)) {
            return '+20' . $m[1];
        }
        return null;
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
            'SELECT COUNT(*) FROM courses WHERE doctor_id = ? AND permanently_deleted = 0',
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
     *
     * • Doctors may only read their OWN history; admins/super admins may read
     *   any doctor's (mirrors VideoController's ownership model).
     * • LIMIT/OFFSET are clamped ints interpolated into SQL — PDO emulated
     *   prepares bind them as strings and MariaDB rejects "LIMIT '5'".
     * • Selects the real schema columns (notes — NOT description, which does
     *   not exist) plus balance_before/balance_after and course/student names
     *   for the UI.
     */
    public function doctorCreditTransactions(Request $request): array
    {
        $doctorId = Uuid::normalize((string) ($request->params['doctorId'] ?? $request->json()['doctor_id'] ?? ''));
        if ($doctorId === '') {
            throw new ApiException(422, 'doctor_id is required');
        }

        $role = $request->user['role'] ?? '';
        if (!in_array($role, ['admin', 'super_admin'], true) && $doctorId !== $request->user['id']) {
            throw new ApiException(403, 'You may only view your own credit history');
        }

        $limit  = min(max((int) ($request->query('limit', '50')), 1), 200);
        $offset = max((int) ($request->query('offset', '0')), 0);

        $db = Database::instance();
        $transactions = $db->select(
            "SELECT ct.id, ct.doctor_id, ct.student_id, ct.course_id, ct.amount,
                    ct.transaction_type, ct.notes, ct.balance_before, ct.balance_after,
                    ct.created_at, c.title AS course_title, p.full_name AS student_name
             FROM credit_transactions ct
             LEFT JOIN courses c  ON c.id = ct.course_id
             LEFT JOIN profiles p ON p.id = ct.student_id
             WHERE ct.doctor_id = ?
             ORDER BY ct.created_at DESC
             LIMIT {$limit} OFFSET {$offset}",
            [$doctorId]
        );

        return ['transactions' => $transactions ?? []];
    }

    /**
     * get_doctor_earnings_dashboard — Full earnings dashboard for a doctor.
     */
    public function doctorEarningsDashboard(Request $request): array
    {
        // Feature flag: doctor_earnings — the doctor-facing earnings surface.
        // READ-ONLY gate: nothing is recalculated, hidden or deleted; the
        // dashboard simply refuses to render while the capability is off.
        $this->flags->assertEnabled('doctor_earnings', $request);

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

        // The frontend sends p_payload: { title, description, ... }.
        // After the PHP client strips the p_ prefix, we receive
        // { payload: { title, ... } }.  Unwrap to match the original PG
        // contract create_course_audited(p_payload jsonb).
        $payload = $data['payload'] ?? $data;

        $title = trim((string) ($payload['title'] ?? ''));
        $description = trim((string) ($payload['description'] ?? ''));
        $categoryId = $payload['category_id'] ?? null;
        $difficulty = (string) ($payload['difficulty'] ?? 'beginner');
        $priceEgp = $payload['price_egp'] ?? $payload['credit_price'] ?? 1;
        // Owner is ALWAYS the authenticated user — never trust a client-supplied
        // doctor_id (the requirement: derive the owner from the session).
        $doctorId = $userId;
        $status = (string) ($payload['status'] ?? 'draft');

        if ($title === '') {
            throw new ApiException(422, 'title is required');
        }

        $db = Database::instance();

        // Snapshot the doctor's current profile name so legacy consumers that
        // read courses.instructor_name keep working; the student UI prefers the
        // live profiles.full_name via the doctor relation.
        $doctorName = $db->value(
            'SELECT full_name FROM profiles WHERE id = ? LIMIT 1',
            [$userId],
            null
        );

        $courseId = Uuid::v4();

        $db->beginTransaction();
        try {
            $db->query(
                'INSERT INTO courses (id, title, description, category_id, difficulty, price_egp,
                     doctor_id, status, instructor_name, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                [$courseId, $title, $description, $categoryId, $difficulty, $priceEgp, $doctorId, $status, $doctorName]
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

        // Return { id, title } to match the original PG contract
        // RETURN jsonb_build_object('id', v_id, 'title', v_course.title)
        return ['id' => $courseId, 'title' => $title];
    }

    /**
     * update_course_audited — Update course fields + write audit log.
     */
    public function updateCourseAudited(Request $request): array
    {
        $courseId = Uuid::normalize((string) ($request->params['courseId'] ?? $request->json()['course_id'] ?? ''));
        $data = $request->json();
        $userId = $request->user['id'];

        // Unwrap p_updates (after p_ strip: 'updates') to match the original PG contract
        // update_course_audited(p_course_id uuid, p_updates jsonb)
        $updates = $data['updates'] ?? $data;

        if ($courseId === '') {
            throw new ApiException(422, 'course_id is required');
        }

        $db = Database::instance();
        $course = $db->row('SELECT * FROM courses WHERE id = ?', [$courseId]);
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }

        // OWNERSHIP ENFORCEMENT (server-side): a doctor may only update courses
        // they own. Without this check any doctor token could mutate another
        // doctor's course (title, price, status...) by calling the RPC directly.
        // Admins/super_admins retain full access.
        $callerRole = (string) ($request->user['role'] ?? '');
        if (!in_array($callerRole, ['admin', 'super_admin'], true)
            && (string) $course['doctor_id'] !== $userId) {
            throw new ApiException(403, 'Not authorized for this course');
        }
        $allowed = [
            'title', 'description', 'short_description', 'full_description',
            'category_id', 'difficulty', 'price_egp', 'status',
            'thumbnail_url', 'cover_url', 'image_url', 'language',
            'instructor_name', 'university_id', 'faculty_id', 'academic_level_id',
            'use_default_contact', 'whatsapp', 'telegram', 'phone', 'facebook',
            'tags', 'sequential_learning', 'free_preview',
            'certificate_enabled', 'subscription_required',
        ];
        $sets = [];
        $params = [];
        $changes = [];

        foreach ($allowed as $col) {
            if (array_key_exists($col, $updates)) {
                $value = $updates[$col];
                // JSON columns: encode arrays/objects (MySQL rejects raw arrays)
                if (in_array($col, ['tags'], true) && is_array($value)) {
                    $value = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                }
                $sets[] = '`' . $col . '` = ?';
                $params[] = $value;
                $changes[$col] = $updates[$col];
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

        // Capture the previous price BEFORE the UPDATE so the history row
        // records old_value/new_value correctly.
        $oldPrice = (int) $db->value('SELECT credit_selling_price FROM profiles WHERE id = ?', [$doctorId], 0);

        $db->beginTransaction();
        try {
            $db->query(
                'UPDATE profiles SET credit_selling_price = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [$price, $doctorId]
            );

            $db->insert(
                'INSERT INTO doctor_pricing_history (id, doctor_id, changed_by, field_name, old_value, new_value, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [Uuid::v4(), $doctorId, $userId, 'credit_selling_price', (string) $oldPrice, (string) $price]
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

        // SERVER-SIDE PRICING GUARDS: price is server-validated (never trusted
        // from the client) and the caller must own the enrollment's course.
        // Without the ownership check any doctor token could rewrite the
        // assigned price on ANY enrollment in the platform.
        if ($price < 0 || $price > 1_000_000) {
            throw new ApiException(422, 'price must be between 0 and 1,000,000');
        }

        $db = Database::instance();
        $callerRole = (string) ($request->user['role'] ?? '');
        $enrollment = $db->row(
            'SELECT e.id, c.doctor_id
               FROM enrollments e
               JOIN courses c ON c.id = e.course_id
              WHERE e.id = ?',
            [$enrollmentId]
        );
        if ($enrollment === null) {
            throw new ApiException(404, 'Enrollment not found');
        }
        if (!in_array($callerRole, ['admin', 'super_admin'], true)
            && (string) $enrollment['doctor_id'] !== $request->user['id']) {
            throw new ApiException(403, 'Not authorized for this enrollment');
        }

        Database::instance()->query(
            'UPDATE enrollments SET assigned_price = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [$price, $enrollmentId]
        );

        AuditService::write($request->user['id'], 'enrollment_visibility_changed', [
            'enrollment_id' => $enrollmentId,
                'assigned_price' => $price,
        ]);

        return ['success' => true];
    }

    /**
     * upsert_teacher_provider_permission — THREE-STATE per-doctor provider
     * override. This is the ROOT-CAUSE FIX for the Video Providers page's
     * "Internal server error": the previous implementation queried the
     * video_provider_config health/config registry (provider_key UNIQUE,
     * NO teacher_id / enabled columns), so every call died with an SQL
     * "Unknown column" → HTTP 500. The correct table is
     * teacher_provider_permissions (teacher_id, provider_key, is_enabled).
     *
     * Body: teacher_id, provider, enabled(bool) — plus optional
     * mode('inherit'|'enabled'|'disabled') for the SA console. enabled=false
     * means EXPLICITLY DISABLED (global ON stays blocked for this doctor);
     * mode='inherit' removes the row so the global default applies again.
     * Registry-validated provider keys; audited.
     */
    public function upsertTeacherProviderPermission(Request $request): array
    {
        $teacherId = Uuid::normalize((string) ($request->json()['teacher_id'] ?? ''));
        $provider = trim((string) ($request->json()['provider'] ?? ''));
        $mode = trim((string) ($request->json()['mode'] ?? ''));
        $enabled = (bool) ($request->json()['enabled'] ?? true);

        if ($teacherId === '' || $provider === '') {
            throw new ApiException(422, 'teacher_id and provider are required');
        }

        // Legacy boolean callers (enabled true/false) map to enabled/disabled;
        // the SA console sends mode='inherit' to clear an explicit override.
        if ($mode === '') {
            $mode = $enabled ? 'enabled' : 'disabled';
        }

        VideoProviderPolicyService::setOverride($teacherId, $provider, $mode);

        AuditService::write(
            (string) ($request->user['id'] ?? ''),
            'video_provider_doctor_override_updated',
            [
                'teacher_id' => $teacherId,
                'provider'   => $provider,
                'mode'       => $mode,
            ],
            $request->clientIp()
        );

        return ['success' => true];
    }

    /**
     * get_teacher_provider_permissions — Effective provider state for a
     * teacher (root-cause fix as above): resolved from
     * teacher_provider_permissions overrides + video_providers globals via
     * VideoProviderPolicyService, with the three states (inherit/enabled/
     * disabled) AND the effective decision. Response shape stays compatible
     * with the previous contract (permissions[]) while adding the fields the
     * Video Providers console renders. No caller-identifiable data beyond the
     * policy itself.
     */
    public function getTeacherProviderPermissions(Request $request): array
    {
        $role = (string) ($request->user['role'] ?? '');
        $teacherId = Uuid::normalize((string) ($request->json()['teacher_id'] ?? $request->query('teacher_id', '')));

        // ROOT-CAUSE FIX (doctor-side gating never worked): the doctor-side
        // client calls this WITHOUT teacher_id to resolve its own effective
        // policy — the previous code 422'd on the empty value. Default to the
        // CALLING user; non-admin callers are always forced to self so a
        // doctor can never read another account's policy rows.
        if ($teacherId === '') {
            $teacherId = (string) ($request->user['id'] ?? '');
        } elseif (!in_array($role, ['admin', 'super_admin'], true)) {
            $teacherId = (string) ($request->user['id'] ?? '');
        }

        if ($teacherId === '') {
            throw new ApiException(401, 'Authentication required');
        }

        $effective = VideoProviderPolicyService::effectiveForTeacher($teacherId);

        $permissions = array_map(
            static fn(array $p): array => [
                'provider_key'   => $p['provider_key'],
                'display_name'   => $p['display_name'],
                'global_enabled' => $p['global_enabled'],
                'override'       => $p['override'],
                'teacher_enabled' => $p['teacher_enabled'],
                'final_enabled'  => $p['effective'],
            ],
            $effective
        );

        return ['permissions' => $permissions];
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
        $lesson = $db->row(
            'SELECT id, course_id, video_id, video_status, video_upload_id, video_asset_id,
                    video_thumbnail_url, video_duration_seconds
               FROM lessons WHERE id = ?',
            [$lessonId]
        );

        if ($lesson === null) {
            throw new ApiException(404, 'Lesson not found');
        }

        // Response shape matches the frontend getLessonVideoState() contract.
        return [
            'lesson_id' => $lessonId,
            'video_id' => $lesson['video_id'] ?? null,
            'video_status' => $lesson['video_status'] ?? null,
            'video_upload_id' => $lesson['video_upload_id'] ?? null,
            'has_video' => !empty($lesson['video_id']),
            'is_missing' => ($lesson['video_status'] ?? '') === 'missing',
            'thumbnail_url' => $lesson['video_thumbnail_url'] ?? null,
            'duration_seconds' => $lesson['video_duration_seconds'] ?? null,
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
        // Gate only the CLEARING of strikes; reporting a violation is never
        // blocked by a flag, so content protection keeps working when this is off.
        $this->flags->assertEnabled('violation_management', $request);

        $targetUserId = Uuid::normalize((string) ($request->json()['user_id'] ?? ''));
        $actorId = $request->user['id'];

        if ($targetUserId === '') {
            throw new ApiException(422, 'user_id is required');
        }

        $db = Database::instance();

        $db->beginTransaction();
        try {
            // Reset violation strike counts in content_protection_violations.
            // This table only has strike_count (no is_suspended or updated_at columns).
            $db->query(
                'UPDATE content_protection_violations
                 SET strike_count = 0
                 WHERE user_id = ?',
                [$targetUserId]
            );

            // Reset violation counters and suspension flag in profiles.
            // profiles.is_suspended tracks whether the account is suspended;
            // violation_count / strike_count track cumulative violations.
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
     *
     * Returns the affected session rows (upload_id, lesson_id, status, …) so the
     * client can reconcile its local queue. The frontend expects an ARRAY of
     * session rows — never return a bare object here.
     */
    public function recoverStaleUploadSessions(Request $request): array
    {
        $db = Database::instance();

        // The Doctor client's launch recovery scan calls this RPC for its own
        // uploads (the "task not in queue" branch writes to the returned rows'
        // upload/lesson records). Ownership flows upload_sessions.upload_id →
        // video_uploads.doctor_id (upload_sessions has no owner column), so:
        //   - non-staff callers (doctor) are strictly scoped to their OWN
        //     sessions — their scan can never touch another doctor's uploads;
        //   - admin/super_admin keep the original global maintenance sweep.
        $role = (string) ($request->user['role'] ?? '');
        $isStaff = in_array($role, ['admin', 'super_admin'], true);
        $ownerId = (string) ($request->user['id'] ?? '');

        // Client contract: p_stale_threshold_seconds = max heartbeat age for a
        // session to still count as live. Honor it instead of the port's
        // hardcoded 24h (a crashed upload should be recoverable, not lost for
        // a day). Defaults to the original 24h when the param is absent —
        // e.g. admin tooling that predates the param.
        $body = $request->json();
        $threshold = filter_var(
            $body['stale_threshold_seconds'] ?? 86400,
            FILTER_VALIDATE_INT,
            ['options' => ['default' => 86400, 'min_range' => 30]]
        );
        if ($threshold === false) {
            $threshold = 86400;
        }

        $ownerJoin = $isStaff
            ? ''
            : ' INNER JOIN video_uploads vu ON vu.id = us.upload_id AND vu.doctor_id = ?';
        $ownerParams = $isStaff ? [] : [$ownerId];

        // Select the stale sessions FIRST (in_progress past the heartbeat
        // threshold), then expire them — the client reconciles from the rows.
        $stale = $db->select(
            "SELECT us.id AS session_id, us.upload_id, us.lesson_id, us.course_id,
                    us.provider_video_id, us.status, us.last_heartbeat, us.created_at
             FROM upload_sessions us{$ownerJoin}
             WHERE us.status = 'in_progress'
               AND us.created_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL {$threshold} SECOND)"
            . ($isStaff
                ? ''
                : ' AND (us.last_heartbeat IS NULL OR us.last_heartbeat < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 60 SECOND))'),
            $ownerParams
        );

        if (!empty($stale)) {
            // Expire exactly the rows returned (scoped join re-applied) so a
            // doctor's scan can never flip another doctor's session status.
            $db->query(
                "UPDATE upload_sessions us{$ownerJoin}
                 SET us.status = 'expired', us.updated_at = UTC_TIMESTAMP(6)
                 WHERE us.status = 'in_progress'
                   AND us.created_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL {$threshold} SECOND)"
                . ($isStaff
                    ? ''
                    : ' AND (us.last_heartbeat IS NULL OR us.last_heartbeat < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 60 SECOND))'),
                $ownerParams
            );
        }

        AuditService::write(
            $request->user['id'] ?? 'system',
            'system_health_check',
            ['action' => 'recover_stale_upload_sessions', 'recovered' => count($stale), 'scoped_to' => $isStaff ? 'all' : $ownerId]
        );

        return $stale;
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
        // `upload_id` is the video_uploads.id. Param is named upload_id (not
        // session_id) because cPanel's WAF blocks the literal `session_id`
        // query parameter with an HTML 403 before the request reaches PHP.
        $sessionId = Uuid::normalize((string) ($request->query('upload_id', $request->query('session_id', $request->params['sessionId'] ?? ''))));
        if ($sessionId === '') {
            throw new ApiException(422, 'session_id is required');
        }
        $db = Database::instance();
        // The chunk upload flow is tracked on video_uploads (the original
        // Edge Function contract); upload_sessions is a legacy/cleanup-only
        // table that is never written by the upload pipeline.
        $upload = $db->row(
            'SELECT id, status, total_chunks, chunks_completed, chunk_size_bytes,
                    bytes_uploaded, file_name, file_size, mime_type,
                    assembly_triggered, doctor_id, created_at, updated_at
               FROM video_uploads WHERE id = ?',
            [$sessionId]
        );
        if ($upload === null) {
            throw new ApiException(404, 'Upload session not found');
        }
        $role = $request->user['role'] ?? '';
        if (!in_array($role, ['admin', 'super_admin'], true) && $upload['doctor_id'] !== $request->user['id']) {
            throw new ApiException(404, 'Upload session not found');
        }
        return ['session' => $upload];
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
        $creditCost = (int) ($enrollment['credit_cost'] ?? 0);

        // OWNERSHIP ENFORCEMENT (server-side): non-staff callers may only
        // remove enrollments on courses they own.
        $callerRole = (string) ($request->user['role'] ?? '');
        if (!in_array($callerRole, ['admin', 'super_admin'], true)
            && (!$course || (string) $course['doctor_id'] !== $request->user['id'])) {
            throw new ApiException(403, 'Not authorized for this enrollment');
        }

        $db->transaction(function (Database $db) use ($enrollment, $courseId, $studentId, $creditCost, $course, $request) {
            $db->query('DELETE FROM enrollments WHERE id = ?', [$enrollment['id']]);

            if ($course && $creditCost > 0) {
                // Refund the consuming doctor and write a 'restoration' ledger
                // row — 'refund' violates chk_credit_transactions_transaction_type
                // (allocation/consumption/deduction/restoration), which made this
                // whole transaction roll back and the endpoint return a 500.
                $db->query(
                    'UPDATE credits SET remaining = remaining + ?, updated_at = UTC_TIMESTAMP(6)
                      WHERE doctor_id = ?',
                    [$creditCost, $course['doctor_id']]
                );
                $db->insert(
                    'INSERT INTO credit_transactions (id, doctor_id, transaction_type, amount, course_id, student_id, performed_by, notes, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                    [Uuid::v4(), $course['doctor_id'], 'restoration', $creditCost, $courseId, $studentId, $request->user['id'], 'Enrollment removed — credit restored']
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

        // OWNERSHIP ENFORCEMENT (server-side): the caller must own the course
        // (or be staff). Without this, any doctor token could remove ANY
        // student's enrollment platform-wide and forge earnings events.
        $courseDoctor = $db->value(
            'SELECT doctor_id FROM courses WHERE id = ?',
            [$courseId],
            ''
        );
        $callerRole = (string) ($request->user['role'] ?? '');
        if (!in_array($callerRole, ['admin', 'super_admin'], true)
            && (string) $courseDoctor !== $request->user['id']) {
            throw new ApiException(403, 'Not authorized for this enrollment');
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
