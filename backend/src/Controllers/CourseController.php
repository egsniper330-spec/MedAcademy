<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\FeatureFlagService;
use MedAcademy\Utils\Uuid;

/**
 * Courses, sections, lessons, enrollments, academic structure.
 *
 * Access rules mirror the courses/sections/lessons RLS policies:
 *   - students see published courses (plus enrolled drafts)
 *   - the owning doctor and admins see their own (any status)
 *
 * Enhanced with:
 *   - publish_course
 *   - unpublish_course
 *   - archive_course (improved)
 *   - restore_course
 *   - delete_course (full cascade)
 *   - duplicate_course
 *   - get_course_progress
 *   - grant_course_access (admin direct enrollment)
 */
final class CourseController
{
    public function __construct(
        private readonly FeatureFlagService $flags = new FeatureFlagService()
    ) {
    }

    public function index(Request $request): array
    {
        $userId = $request->user['id'];
        $role = $request->user['role'];
        $isPrivileged = in_array($role, ['doctor', 'admin', 'super_admin'], true);

        $sql = "SELECT c.id, c.title, c.short_description, c.image_url, c.cover_url, c.thumbnail_url,
                       c.status, c.category_id, c.total_lessons, c.total_sections, c.language,
                       c.difficulty, c.price_egp, c.credits_required, c.free_preview,
                       c.university_id, c.faculty_id, c.academic_level_id, c.created_at,
                       c.updated_at, c.archived_at, c.estimated_duration_hours,
                       p.full_name AS doctor_name
                  FROM courses c
                  LEFT JOIN profiles p ON p.id = c.doctor_id";
        $params = [];
        $where = [];
        if ($isPrivileged) {
            if ($role === 'doctor') {
                $where[] = 'c.doctor_id = ?';
                $params[] = $userId;
            }
        } else {
            //  SUSPENSION ENFORCEMENT: a SUSPENDED enrollment must not keep a
            //  draft/hidden course visible to the student. Only a NON-suspended
            //  enrollment grants that visibility (published courses stay
            //  browsable by everyone, as before).
            $where[] = "(c.status = 'published'
                         OR EXISTS (SELECT 1 FROM enrollments e
                                     WHERE e.student_id = ? AND e.course_id = c.id
                                       AND (e.status IS NULL OR e.status <> 'suspended')))";
            $params[] = $userId;
        }

        //  STATUS FILTER: `?status=draft|published|hidden|archived`
        //  This parameter used to be IGNORED, so a client asking for drafts
        //  received every course the doctor owns (the "Drafts shows published
        //  courses" bug). Only a whitelist is ever interpolated, and the value
        //  is still bound as a parameter.
        $status = $request->query('status');
        if (is_string($status) && $status !== '' && $status !== 'all') {
            $allowed = ['draft', 'published', 'hidden', 'archived'];
            if (!in_array($status, $allowed, true)) {
                throw new ApiException(422, 'status must be one of: ' . implode(', ', $allowed));
            }
            $where[] = 'c.status = ?';
            $params[] = $status;
        }

        //  ARCHIVED FILTER: the client sends `archived_at=is.null` when it wants
        //  live rows only (the default for the Doctor course list). When the
        //  parameter is absent (e.g. the admin course manager requesting
        //  archived rows too) no filter is applied, preserving that behavior.
        if ((string) $request->query('archived_at', '') === 'is.null') {
            $where[] = 'c.archived_at IS NULL';
        }

        if ($where !== []) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $sql .= ' ORDER BY c.created_at DESC LIMIT 200';
        return ['courses' => Database::instance()->select($sql, $params)];
    }

    public function show(Request $request): array
    {
        $id = Uuid::normalize((string) $request->params['id']);
        $userId = $request->user['id'];
        $role = $request->user['role'];

        $course = Database::instance()->row(
            'SELECT c.*, p.full_name AS doctor_name,
                    (SELECT COUNT(*) FROM sections s WHERE s.course_id = c.id) AS section_count
               FROM courses c
               LEFT JOIN profiles p ON p.id = c.doctor_id
              WHERE c.id = ?',
            [$id]
        );
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }

        $canView = $course['status'] === 'published'
            || $course['doctor_id'] === $userId
            || in_array($role, ['admin', 'super_admin'], true)
            || $this->isEnrolled($userId, $id);
        if (!$canView) {
            throw new ApiException(403, 'This course is not available');
        }

        return ['course' => $course];
    }

    public function sections(Request $request): array
    {
        $courseId = Uuid::normalize((string) $request->params['id']);
        $this->assertCourseVisible($request, $courseId);
        return [
            'sections' => Database::instance()->select(
                'SELECT id, title, order_index FROM sections WHERE course_id = ? ORDER BY order_index, created_at',
                [$courseId]
            ),
        ];
    }

    public function lessons(Request $request): array
    {
        $courseId = Uuid::normalize((string) $request->params['id']);
        $this->assertCourseVisible($request, $courseId);
        $role = $request->user['role'];
        $isPrivileged = in_array($role, ['doctor', 'admin', 'super_admin'], true);

        $sql = "SELECT l.id, l.section_id, l.title, l.description, l.duration_seconds, l.status,
                       l.order_index, l.scheduled_at, l.is_preview,
                       l.video_id, lm.file_url AS material_url, lm.file_name AS material_name
                  FROM lessons l
                  LEFT JOIN lesson_materials lm ON lm.lesson_id = l.id
                 WHERE l.course_id = ?";
        $params = [$courseId];
        if (!$isPrivileged) {
            $sql .= " AND l.status = 'published'";
        }
        $sql .= ' ORDER BY l.order_index, l.created_at';
        return ['lessons' => Database::instance()->select($sql, $params)];
    }

    public function create(Request $request): array
    {
        // Feature flag: course_creation — server-side enforcement (403
        // feature_disabled). Existing courses are untouched.
        $this->flags->assertEnabled('course_creation', $request);

        $data = $request->json();
        $title = trim((string) ($data['title'] ?? ''));
        if ($title === '') {
            throw new ApiException(422, 'title is required');
        }
        $id = Uuid::v4();
        // The course owner is the authenticated doctor (never client-supplied).
        // Snapshot the doctor's current profile name into instructor_name so
        // legacy consumers that read the snapshot keep working; the student UI
        // prefers the live profiles.full_name via the doctor relation.
        $doctorName = Database::instance()->value(
            'SELECT full_name FROM profiles WHERE id = ? LIMIT 1',
            [$request->user['id']],
            null
        );
        Database::instance()->insert(
            'INSERT INTO courses (id, doctor_id, title, description, short_description, full_description,
                                  status, language, difficulty, credits_required, instructor_name,
                                  created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
            [
                $id,
                $request->user['id'],
                $title,
                (string) ($data['description'] ?? ''),
                $data['short_description'] ?? null,
                $data['full_description'] ?? null,
                (string) ($data['status'] ?? 'draft'),
                (string) ($data['language'] ?? 'arabic'),
                (string) ($data['difficulty'] ?? 'all_levels'),
                (int) ($data['credits_required'] ?? 1),
                $doctorName,
            ]
        );
        AuditService::write($request->user['id'], 'course_created', ['course_id' => $id, 'title' => $title]);
        return ['course' => Database::instance()->row('SELECT * FROM courses WHERE id = ?', [$id])];
    }

    public function update(Request $request): array
    {
        // Kill switch: stop edits platform-wide without touching stored data.
        $this->flags->assertEnabled('course_editing', $request);

        $id = Uuid::normalize((string) $request->params['id']);
        $this->assertCourseOwner($request, $id);
        $data = $request->json();
        $allowed = [
            'title', 'description', 'short_description', 'full_description', 'image_url', 'cover_url',
            'thumbnail_url', 'status', 'language', 'difficulty', 'category_id', 'credits_required',
            'free_preview', 'sequential_learning', 'certificate_enabled', 'price_egp',
            'university_id', 'faculty_id', 'academic_level_id', 'instructor_name',
        ];
        $sets = [];
        $params = [];
        foreach ($allowed as $col) {
            if (array_key_exists($col, $data)) {
                $sets[] = '`' . $col . '` = ?';
                $params[] = is_bool($data[$col]) ? ($data[$col] ? 1 : 0) : $data[$col];
            }
        }
        if ($sets === []) {
            throw new ApiException(422, 'No updatable fields provided');
        }
        $sets[] = 'updated_at = UTC_TIMESTAMP(6)';
        $params[] = $id;
        Database::instance()->query('UPDATE courses SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
        AuditService::write($request->user['id'], 'course_updated', ['course_id' => $id]);
        return ['course' => Database::instance()->row('SELECT * FROM courses WHERE id = ?', [$id])];
    }

    public function enroll(Request $request): array
    {
        // Feature flag: course_enrollment — server-side enforcement.
        $this->flags->assertEnabled('course_enrollment', $request);

        $courseId = Uuid::normalize((string) $request->params['id']);
        $studentId = $request->user['id'];

        $course = Database::instance()->row(
            'SELECT id, status, price_egp FROM courses WHERE id = ?',
            [$courseId]
        );
        if ($course === null || $course['status'] !== 'published') {
            throw new ApiException(404, 'Course not found');
        }

        // SERVER-SIDE ENFORCEMENT: enrollment is a PAID operation (credits).
        // The creditless self-enroll path would let any student token create
        // free enrollments on ANY published course by calling this endpoint
        // directly — bypassing grant_course_access' atomic deduction entirely.
        // Free courses (price 0) may still self-enroll.
        $price = (int) ($course['price_egp'] ?? 0);
        if ($price > 0) {
            throw new ApiException(402, 'This course requires enrollment through the app (credit activation)');
        }

        $already = (bool) Database::instance()->value(
            'SELECT COUNT(*) FROM enrollments WHERE student_id = ? AND course_id = ?',
            [$studentId, $courseId], 0
        );
        if ($already) {
            throw new ApiException(409, 'Already enrolled in this course');
        }
        Database::instance()->insert(
            'INSERT INTO enrollments (id, student_id, course_id, status, enrolled_at)
             VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [Uuid::v4(), $studentId, $courseId, 'active']
        );
        AuditService::write($studentId, 'enrollment_created', ['course_id' => $courseId, 'method' => 'direct_free']);
        return ['success' => true];
    }

    public function archive(Request $request): array
    {
        $id = Uuid::normalize((string) $request->params['id']);
        $this->assertCourseOwner($request, $id);
        Database::instance()->query(
            "UPDATE courses SET status = 'archived', archived_at = UTC_TIMESTAMP(6), archived_by = ?
              WHERE id = ?",
            [$request->user['id'], $id]
        );
        AuditService::write($request->user['id'], 'course_archived', ['course_id' => $id]);
        return ['success' => true];
    }

    // ================================================================
    // COURSE LIFECYCLE
    // ================================================================

    /**
     * POST /courses/{id}/publish — publish or republish the latest saved course tree.
     *
     * The latest successful `published` lifecycle log is the existing publish
     * marker. Pending changes are derived from updated_at across the course,
     * sections, lessons, and lesson materials; no snapshot table is needed.
     */
    public function publish(Request $request): array
    {
        // Feature flag: doctor_course_publishing — refused BEFORE any write, so
        // existing published courses and drafts keep their exact state and
        // re-enabling the flag restores publishing.
        $this->flags->assertEnabled('doctor_course_publishing', $request);

        $id = Uuid::normalize((string) $request->params['id']);
        $this->assertCourseOwner($request, $id);

        $db = Database::instance();
        $course = $db->row(
            'SELECT status, title, doctor_id, use_default_contact, whatsapp, telegram, facebook, phone, updated_at FROM courses WHERE id = ?',
            [$id]
        );
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }

        $lastPublishedAt = $db->value(
            "SELECT created_at FROM course_lifecycle_logs
              WHERE course_id = ? AND action IN ('published', 'republished', 'updated_and_published')
              ORDER BY created_at DESC LIMIT 1",
            [$id],
            null
        );
        $latestTreeChange = $db->value(
            "SELECT MAX(changed_at) FROM (
                SELECT updated_at AS changed_at FROM courses WHERE id = ?
                UNION ALL
                SELECT updated_at FROM sections WHERE course_id = ?
                UNION ALL
                SELECT updated_at FROM lessons WHERE course_id = ?
                UNION ALL
                SELECT lm.updated_at FROM lesson_materials lm
                JOIN lessons l ON l.id = lm.lesson_id
                WHERE l.course_id = ?
            ) changes",
            [$id, $id, $id, $id],
            null
        );
        $hasPendingChanges = $lastPublishedAt === null || $latestTreeChange === null
            || strtotime((string) $latestTreeChange) > strtotime((string) $lastPublishedAt);
        $wasPublished = $course['status'] === 'published';
        $action = $wasPublished && !$hasPendingChanges ? 'already_published' : ($wasPublished ? 'updated' : 'published');
        if ($action === 'already_published') {
            return ['success' => true, 'status' => 'published', 'action' => $action];
        }

        // ── Resolve the course's effective contact information ────────────
        // When the course uses the doctor's default contact (use_default_contact
        // = true), copy the doctor's CURRENT default contact into the course
        // row. This satisfies chk_courses_c0 legitimately (a published course
        // must carry at least one contact method) instead of failing the UPDATE.
        // When the course has its own explicit contact info, it is preserved.
        $whatsapp = $course['whatsapp'];
        $telegram = $course['telegram'];
        $facebook = $course['facebook'];
        $phone    = $course['phone'];

        if ((int) $course['use_default_contact'] === 1) {
            $doctor = $db->row(
                'SELECT contact_whatsapp, contact_telegram, contact_phone, phone, phone_e164 FROM profiles WHERE id = ?',
                [$course['doctor_id']]
            );
            if ($doctor !== null) {
                $whatsapp = $doctor['contact_whatsapp'] ?? null;
                $telegram = $doctor['contact_telegram'] ?? null;
                // Older/current profiles may store their default phone in the
                // account phone column rather than contact_phone. Treat that
                // authenticated profile phone as the default contact without
                // weakening chk_courses_c0 or accepting client-supplied data.
                $phone = $doctor['contact_phone']
                    ?? $doctor['phone_e164']
                    ?? $doctor['phone']
                    ?? null;
            }
        }

        $hasContact = !empty(trim((string) $whatsapp))
            || !empty(trim((string) $telegram))
            || !empty(trim((string) $facebook))
            || !empty(trim((string) $phone));

        if (!$hasContact) {
            throw new ApiException(422, 'A contact method is required to publish. Add your default contact in Profile or set course-specific contact information.');
        }

        if ((int) $course['use_default_contact'] === 1) {
            $db->query(
                'UPDATE courses SET status = ?, whatsapp = ?, telegram = ?, phone = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [
                    'published',
                    $whatsapp !== null && trim((string) $whatsapp) !== '' ? $whatsapp : null,
                    $telegram !== null && trim((string) $telegram) !== '' ? $telegram : null,
                    $phone    !== null && trim((string) $phone)    !== '' ? $phone    : null,
                    $id,
                ]
            );
        } else {
            $db->query(
                "UPDATE courses SET status = 'published', updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
                [$id]
            );
        }

        $lifecycleAction = $wasPublished ? 'updated_and_published' : 'published';
        $this->logLifecycle($id, $course['title'], $lifecycleAction, $request->user['id']);
        AuditService::write($request->user['id'], 'course_published', [
            'course_id' => $id,
            'action' => $action,
        ]);
        return ['success' => true, 'status' => 'published', 'action' => $action];
    }

    /**
     * POST /courses/{id}/unpublish — unpublish course (published → hidden).
     */
    public function unpublish(Request $request): array
    {
        $id = Uuid::normalize((string) $request->params['id']);
        $this->assertCourseOwner($request, $id);

        $course = Database::instance()->row('SELECT status, title FROM courses WHERE id = ?', [$id]);
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }

        Database::instance()->query(
            "UPDATE courses SET status = 'hidden', updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
            [$id]
        );

        $this->logLifecycle($id, $course['title'], 'unpublished', $request->user['id']);
        AuditService::write($request->user['id'], 'course_unpublished', ['course_id' => $id]);
        return ['success' => true];
    }

    /**
     * POST /courses/{id}/restore — restore archived/deleted course.
     */
    public function restore(Request $request): array
    {
        $id = Uuid::normalize((string) $request->params['id']);
        $this->assertCourseOwner($request, $id);

        $course = Database::instance()->row('SELECT status, title FROM courses WHERE id = ?', [$id]);
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }

        $newStatus = $course['status'] === 'archived' ? 'draft' : 'draft';
        Database::instance()->query(
            "UPDATE courses SET status = ?, archived_at = NULL, archived_by = NULL,
                    restored_at = UTC_TIMESTAMP(6), restored_by = ?, updated_at = UTC_TIMESTAMP(6)
              WHERE id = ?",
            [$newStatus, $request->user['id'], $id]
        );

        $this->logLifecycle($id, $course['title'], 'restored', $request->user['id']);
        AuditService::write($request->user['id'], 'course_restored', ['course_id' => $id]);
        return ['success' => true];
    }

    /**
     * POST /courses/{id}/delete — permanently delete course with full cascade.
     */
    public function deleteCourse(Request $request): array
    {
        $id = Uuid::normalize((string) $request->params['id']);
        $this->assertCourseOwner($request, $id);

        $course = Database::instance()->row('SELECT title FROM courses WHERE id = ?', [$id]);
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }        $db = Database::instance();
        $lessonsDeleted = $db->value('SELECT COUNT(*) FROM lessons WHERE course_id = ?', [$id], 0);
        $studentsRemoved = $db->value('SELECT COUNT(*) FROM enrollments WHERE course_id = ?', [$id], 0);
        $videosDeleted = $db->value('SELECT COUNT(*) FROM video_uploads WHERE course_id = ?', [$id], 0);
        $storageFreed = (int) $db->value('SELECT COALESCE(SUM(file_size), 0) FROM video_uploads WHERE course_id = ?', [$id], 0);

        // Log the lifecycle event INSIDE the transaction and BEFORE the course
        // row is deleted: course_lifecycle_logs.course_id references courses.id
        // (ON DELETE SET NULL), so an insert after the DELETE would violate the
        // FK and fail the whole request even though the deletion succeeded.
        $db->transaction(function (Database $db) use ($id, $course, $request) {
            $this->logLifecycle($id, $course['title'] ?? '', 'permanently_deleted', $request->user['id']);
            $db->query('DELETE FROM lesson_materials WHERE lesson_id IN (SELECT id FROM lessons WHERE course_id = ?)', [$id]);
            $db->query('DELETE FROM video_uploads WHERE course_id = ?', [$id]);
            $db->query('DELETE FROM lessons WHERE course_id = ?', [$id]);
            $db->query('DELETE FROM sections WHERE course_id = ?', [$id]);
            $db->query('DELETE FROM enrollments WHERE course_id = ?', [$id]);
            $db->query('DELETE FROM courses WHERE id = ?', [$id]);
        });

        AuditService::write($request->user['id'], 'course_deleted', [
            'course_id' => $id,
            'lessons_deleted' => $lessonsDeleted,
            'students_removed' => $studentsRemoved,
            'videos_deleted' => $videosDeleted,
            'storage_bytes_freed' => $storageFreed,
        ]);


        return ['success' => true, 'title' => $course['title'], 'lessons_deleted' => $lessonsDeleted, 'students_removed' => $studentsRemoved, 'videos_deleted' => $videosDeleted, 'storage_bytes_freed' => $storageFreed];
    }

    /**
     * POST /courses/{id}/duplicate — deep-copy course with sections/lessons.
     */
    public function duplicate(Request $request): array
    {
        // Feature flag: course_creation — duplicating creates a NEW course row,
        // so it is a course-creation operation and must honour the same flag as
        // POST /courses. Gate-first, before any read or write.
        $this->flags->assertEnabled('course_creation', $request);

        $id = Uuid::normalize((string) $request->params['id']);
        $this->assertCourseOwner($request, $id);

        $db = Database::instance();
        $course = $db->row('SELECT * FROM courses WHERE id = ?', [$id]);
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }

        $newCourseId = Uuid::v4();
        $actorId = $request->user['id'];

        $db->transaction(function (Database $db) use ($course, $newCourseId, $actorId, $id) {
            // Create new course
            $db->insert(
                'INSERT INTO courses (id, doctor_id, title, description, short_description, full_description,
                                      status, language, difficulty, credits_required, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                [
                    $newCourseId, $actorId, $course['title'] . ' (Copy)',
                    $course['description'], $course['short_description'], $course['full_description'],
                    'draft', $course['language'], $course['difficulty'],
                ]
            );

            // Copy sections and lessons
            $sections = $db->select('SELECT * FROM sections WHERE course_id = ? ORDER BY order_index', [$id]);
            foreach ($sections as $section) {
                $newSectionId = Uuid::v4();
                $db->insert(
                    'INSERT INTO sections (id, course_id, title, order_index, created_at, updated_at)
                     VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                    [$newSectionId, $newCourseId, $section['title'], $section['order_index']]
                );

                $lessons = $db->select(
                    'SELECT * FROM lessons WHERE section_id = ? AND course_id = ? ORDER BY order_index',
                    [$section['id'], $id]
                );
                foreach ($lessons as $lesson) {
                    $newLessonId = Uuid::v4();
                    $db->insert(
                        'INSERT INTO lessons (id, section_id, course_id, title, description, duration_seconds,
                                              video_id, status, order_index, video_type, is_preview, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                        [
                            $newLessonId, $newSectionId, $newCourseId, $lesson['title'], $lesson['description'],
                            $lesson['duration_seconds'], null, 'draft', $lesson['order_index'],
                            $lesson['video_type'] ?? 'coming_soon', $lesson['is_preview'] ?? 0,
                        ]
                    );
                }
            }
        });

        AuditService::write($actorId, 'course_created', ['course_id' => $newCourseId, 'duplicated_from' => $id]);
        return ['success' => true, 'new_course_id' => $newCourseId];
    }

    /**
     * GET /courses/{id}/progress — student progress for a course.
     */
    public function progress(Request $request): array
    {
        $courseId = Uuid::normalize((string) $request->params['id']);
        $studentId = $request->user['id'];

        $db = Database::instance();
        $totalLessons = (int) $db->value(
            "SELECT COUNT(*) FROM lessons l
              JOIN sections s ON s.id = l.section_id
             WHERE s.course_id = ? AND l.status = 'published'",
            [$courseId], 0
        );

        $completedLessons = (int) $db->value(
            "SELECT COUNT(*) FROM lesson_progress lp
              JOIN lessons l ON l.id = lp.lesson_id
             WHERE l.course_id = ? AND lp.student_id = ? AND lp.completed = 1",
            [$courseId, $studentId], 0
        );

        $progress = $totalLessons > 0 ? round(($completedLessons / $totalLessons) * 100) : 0;

        return [
            'progress' => $progress,
            'total_lessons' => $totalLessons,
            'completed_lessons' => $completedLessons,
        ];
    }

    /**
     * POST /courses/grant-access — admin grants direct enrollment without credit deduction.
     */
    public function grantAccess(Request $request): array
    {
        $body = $request->json();
        $studentId = (string) ($body['student_id'] ?? '');
        $courseId = (string) ($body['course_id'] ?? '');

        if ($studentId === '' || $courseId === '') {
            throw new ApiException(422, 'student_id and course_id are required');
        }

        $db = Database::instance();

        // Check if already enrolled
        $exists = $db->value(
            'SELECT COUNT(*) FROM enrollments WHERE student_id = ? AND course_id = ?',
            [$studentId, $courseId], 0
        );
        if ($exists > 0) {
            return ['success' => true, 'message' => 'Already enrolled'];
        }

        $db->insert(
            'INSERT INTO enrollments (id, student_id, course_id, enrolled_by, enrollment_method, status, enrolled_at)
             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [Uuid::v4(), $studentId, $courseId, $request->user['id'], 'admin_grant', 'active']
        );

        AuditService::write($request->user['id'], 'enrollment_created_by_admin', [
            'student_id' => $studentId,
            'course_id' => $courseId,
        ]);

        return ['success' => true];
    }

    public function categories(Request $request): array
    {
        return ['categories' => Database::instance()->select('SELECT id, name FROM categories ORDER BY name')];
    }

    public function universities(Request $request): array
    {
        return ['universities' => Database::instance()->select(
            'SELECT id, name FROM universities WHERE is_active = 1 ORDER BY name'
        )];
    }

    public function faculties(Request $request): array
    {
        $universityId = Uuid::normalize((string) $request->params['id']);
        return ['faculties' => Database::instance()->select(
            'SELECT id, name FROM faculties WHERE university_id = ? AND is_active = 1 ORDER BY name',
            [$universityId]
        )];
    }

    public function academicLevels(Request $request): array
    {
        $facultyId = Uuid::normalize((string) $request->params['id']);
        return ['levels' => Database::instance()->select(
            'SELECT id, name, display_order FROM academic_levels WHERE faculty_id = ? AND is_active = 1 ORDER BY display_order',
            [$facultyId]
        )];
    }

    // ---- helpers ----------------------------------------------------------
    /**
     * Enrollment that grants course access. A SUSPENDED enrollment is not
     * access, so the row's status is part of the question — previously this
     * counted rows regardless of status, so a suspension never took effect on
     * the course detail / sections / lessons paths.
     */
    private function isEnrolled(string $studentId, string $courseId): bool
    {
        return (bool) Database::instance()->value(
            "SELECT COUNT(*) FROM enrollments
              WHERE student_id = ? AND course_id = ?
                AND (status IS NULL OR status <> 'suspended')",
            [$studentId, $courseId], 0
        );
    }

    private function assertCourseVisible(Request $request, string $courseId): void
    {
        $role = $request->user['role'];
        if (in_array($role, ['admin', 'super_admin'], true)) {
            return;
        }
        $course = Database::instance()->row(
            'SELECT doctor_id, status FROM courses WHERE id = ?',
            [$courseId]
        );
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }
        $canView = $course['status'] === 'published'
            || $course['doctor_id'] === $request->user['id']
            || $this->isEnrolled($request->user['id'], $courseId);
        if (!$canView) {
            throw new ApiException(403, 'This course is not available');
        }
    }

    private function assertCourseOwner(Request $request, string $courseId): void
    {
        $role = $request->user['role'];
        if (in_array($role, ['admin', 'super_admin'], true)) {
            return;
        }
        $owner = Database::instance()->value('SELECT doctor_id FROM courses WHERE id = ?', [$courseId]);
        if ($owner !== $request->user['id']) {
            throw new ApiException(403, 'Not authorized for this course');
        }
    }

    /**
     * POST /lessons/{id}/delete — delete lesson and associated VdoCipher video.
     * Mirrors supabase/functions/delete-lesson/index.ts
     */
    public function deleteLesson(Request $request): array
    {
        $lessonId = Uuid::normalize((string) $request->params['id']);
        $userId = $request->user['id'];
        $role = $request->user['role'];

        $db = Database::instance();
        $lesson = $db->row(
            "SELECT l.id, l.title, l.video_id, l.video_upload_id,
                    c.doctor_id
               FROM lessons l
               JOIN sections sec ON sec.id = l.section_id
               JOIN courses c ON c.id = sec.course_id
              WHERE l.id = ?",
            [$lessonId]
        );
        if ($lesson === null) {
            throw new ApiException(404, 'Lesson not found');
        }
        if ($role === 'doctor' && $lesson['doctor_id'] !== $userId) {
            throw new ApiException(403, 'You do not own this lesson');
        }

        // 1. Delete VdoCipher video if present
        $vdoDeleted = false;
        $vdoError = null;
        if ($lesson['video_id']) {
            try {
                $apiSecret = \MedAcademy\Utils\Config::string('VDOCIPHER_API_SECRET', '');
                if ($apiSecret !== '') {
                    $ch = curl_init('https://dev.vdocipher.com/api/videos/' . rawurlencode($lesson['video_id']));
                    curl_setopt_array($ch, [
                        CURLOPT_DELETE => true,
                        CURLOPT_HTTPHEADER => ['Authorization: Apisecret ' . $apiSecret, 'Accept: application/json'],
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_TIMEOUT => 15,
                    ]);
                    $vdoStatus = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                    curl_close($ch);
                    $vdoDeleted = ($vdoStatus === 200 || $vdoStatus === 404);
                }
            } catch (\Throwable $e) {
                $vdoError = $e->getMessage();
            }
        } else {
            $vdoDeleted = true;
        }

        // 2. Collect storage paths for cleanup
        $storagePaths = [];
        $pdfs = $db->select('SELECT file_url FROM lesson_pdfs WHERE lesson_id = ?', [$lessonId]);
        foreach ($pdfs as $p) {
            $path = $this->extractStoragePath($p['file_url'] ?? '');
            if ($path) $storagePaths[] = $path;
        }
        $materials = $db->select('SELECT storage_path, file_url FROM lesson_materials WHERE lesson_id = ?', [$lessonId]);
        foreach ($materials as $m) {
            $path = $m['storage_path'] ?: $this->extractStoragePath($m['file_url'] ?? '');
            if ($path) $storagePaths[] = $path;
        }

        // 3. Cascade DB delete
        $db->transaction(function (Database $db) use ($lessonId) {
            //  RESUME POINTER: enrollments.last_lesson_id references lessons
            //  with NO ON DELETE action (MySQL default = RESTRICT). Leaving it
            //  alone made every lesson delete fail with a raw FK error as soon
            //  as one student had reached that lesson. Clearing the pointer
            //  keeps the enrollment intact and only forgets "where they were".
            $db->query('UPDATE enrollments SET last_lesson_id = NULL WHERE last_lesson_id = ?', [$lessonId]);
            $db->query('DELETE FROM lesson_pdfs WHERE lesson_id = ?', [$lessonId]);
            $db->query('DELETE FROM lesson_materials WHERE lesson_id = ?', [$lessonId]);
            $db->query('DELETE FROM video_uploads WHERE lesson_id = ?', [$lessonId]);
            $db->query('DELETE FROM lessons WHERE id = ?', [$lessonId]);
        });

        // 4. Audit log
        AuditService::write($userId, 'lesson_deleted', [
            'lesson_id' => $lessonId,
            'lesson_title' => $lesson['title'],
            'video_id' => $lesson['video_id'],
            'vdo_deleted' => $vdoDeleted,
        ]);

        return [
            'success' => true,
            'lesson_id' => $lessonId,
            'vdo_deleted' => $vdoDeleted,
            'vdo_error' => $vdoError,
        ];
    }

    /**
     * POST /courses/{id}/sections/{section_id}/delete
     *
     * Delete ONE section of ONE course, with everything the doctor confirmed.
     *
     * WHY A DEDICATED ENDPOINT (the "Failed to delete section" bug)
     * ─────────────────────────────────────────────────────────────
     * The app used to delete sections through the generic table API
     * (`DELETE /api/sections?id=eq.…`), which is a single `DELETE` statement.
     * Any dependent row therefore aborted the whole statement:
     *
     *   • lessons.section_id          (CASCADE in schema.sql, but a live DB
     *                                  migrated from the Postgres era may still
     *                                  carry the RESTRICT default),
     *   • enrollments.last_lesson_id  (REFERENCES lessons with NO ON DELETE
     *                                  action — RESTRICT — in the CURRENT
     *                                  schema, so every section holding a
     *                                  student's resume lesson failed even with
     *                                  correct CASCADEs),
     *   • lesson_pdfs / lesson_materials / lesson_progress / video_uploads,
     *     which hang off those lessons.
     *
     * MySQL reported error 1451, the client's friendlyError() masks
     * "Integrity constraint violation" (SQL internals are never shown), and the
     * doctor saw only "Failed to delete section."
     *
     * This handler removes the exact dependency chain in ONE transaction, in
     * dependency order, so the section delete cannot be blocked by a
     * restrictive foreign key. Nothing outside the section is touched:
     * enrollments, students, other sections and other courses stay intact;
     * videos in the library (video_assets) are NOT deleted; remote VdoCipher
     * media is left to the existing per-lesson delete flow.
     *
     * Authorization is server-side and re-checked here: the caller must be a
     * doctor who OWNS the course (admins/super admins excepted), and the
     * section must actually belong to that course — a doctor can never delete
     * another course's section by guessing its id.
     */
    public function deleteSection(Request $request): array
    {
        $courseId = Uuid::normalize((string) ($request->params['id'] ?? ''));
        $sectionId = Uuid::normalize((string) ($request->params['section_id'] ?? ''));
        $userId = $request->user['id'];

        $db = Database::instance();

        $course = $db->row('SELECT id, title, doctor_id FROM courses WHERE id = ?', [$courseId]);
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }
        // Ownership (403 for a doctor who does not own the course).
        $this->assertCourseOwner($request, $courseId);

        $section = $db->row('SELECT id, title, course_id FROM sections WHERE id = ?', [$sectionId]);
        if ($section === null) {
            throw new ApiException(404, 'Section not found');
        }
        // CROSS-COURSE GUARD: the section must belong to the course in the URL.
        // Answered as 404 (not 403) so the endpoint never confirms that a
        // section id exists elsewhere.
        if ((string) $section['course_id'] !== $courseId) {
            throw new ApiException(404, 'Section not found in this course');
        }

        $lessonIds = array_map(
            static fn(array $r): string => (string) $r['id'],
            $db->select('SELECT id FROM lessons WHERE section_id = ?', [$sectionId])
        );

        try {
            $result = $db->transaction(function (Database $db) use ($sectionId, $courseId, $lessonIds): array {
                if ($lessonIds !== []) {
                    $in = implode(',', array_fill(0, count($lessonIds), '?'));

                    // 1. Resume pointers first: RESTRICT FK, and the enrollment
                    //    itself must survive (a student keeps their seat).
                    $db->query("UPDATE enrollments SET last_lesson_id = NULL WHERE last_lesson_id IN ({$in})", $lessonIds);

                    // 2. Lesson children, explicitly — never rely on a CASCADE
                    //    that a migrated live schema may not have.
                    $db->query("DELETE FROM lesson_pdfs WHERE lesson_id IN ({$in})", $lessonIds);
                    $db->query("DELETE FROM lesson_materials WHERE lesson_id IN ({$in})", $lessonIds);
                    $db->query("DELETE FROM lesson_progress WHERE lesson_id IN ({$in})", $lessonIds);
                    $db->query("DELETE FROM video_uploads WHERE lesson_id IN ({$in})", $lessonIds);

                    // 3. The lessons themselves (video_assets rows stay — the
                    //    asset library is shared and must not be destroyed by
                    //    deleting a section).
                    $db->query("DELETE FROM lessons WHERE id IN ({$in})", $lessonIds);
                }

                // 4. The section, still constrained to the authorized course.
                $db->query('DELETE FROM sections WHERE id = ? AND course_id = ?', [$sectionId, $courseId]);

                // 5. Recount from the source of truth. The schema has triggers
                //    for these counters; recomputing keeps them correct even on
                //    a deployment where a trigger is missing.
                $db->query(
                    'UPDATE courses
                        SET total_sections = (SELECT COUNT(*) FROM sections WHERE course_id = ?),
                            total_lessons  = (SELECT COUNT(*) FROM lessons  WHERE course_id = ?),
                            updated_at     = CURRENT_TIMESTAMP
                      WHERE id = ?',
                    [$courseId, $courseId, $courseId]
                );

                $remainingSections = (int) $db->value(
                    'SELECT COUNT(*) FROM sections WHERE course_id = ?',
                    [$courseId],
                    0
                );

                return ['remaining_sections' => $remainingSections];
            });
        } catch (\PDOException $e) {
            // Still referenced by something we do not own (an older schema
            // object, a future feature). Report a conflict — never a 500 with
            // SQL internals, and never a silent success.
            if ((int) ($e->errorInfo[1] ?? 0) === 1451) {
                error_log(sprintf(
                    '[CourseController][section-delete][FK] course=%s section=%s driver=%s',
                    $courseId,
                    $sectionId,
                    $e->errorInfo[2] ?? 'unknown'
                ));
                throw new ApiException(
                    409,
                    'This section is still referenced by other records and cannot be deleted yet. No changes were made.',
                    'dependency_conflict',
                    $e
                );
            }
            throw $e;
        }

        AuditService::write($userId, 'course_updated', [
            'course_id' => $courseId,
            'section_deleted' => true,
            'section_id' => $sectionId,
            'section_title' => $section['title'],
            'lessons_removed' => count($lessonIds),
        ]);

        return [
            'success' => true,
            'course_id' => $courseId,
            'section_id' => $sectionId,
            'section_title' => $section['title'],
            'removed_lessons' => count($lessonIds),
            'remaining_sections' => $result['remaining_sections'],
        ];
    }

    private function extractStoragePath(string $url): ?string
    {
        if ($url === '') return null;
        if (preg_match('#/object/(?:public|sign)/[^/]+/(.+?)(?:\?.*)?$#', $url, $m)) {
            return $m[1];
        }
        return null;
    }

    private function logLifecycle(string $courseId, string $title, string $action, string $actorId): void
    {
        Database::instance()->insert(
            'INSERT INTO course_lifecycle_logs (id, course_id, course_title, action, actor_id, created_at)
             VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [Uuid::v4(), $courseId, $title, $action, $actorId]
        );
    }
}
