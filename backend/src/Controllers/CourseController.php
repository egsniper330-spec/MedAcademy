<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
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
    public function index(Request $request): array
    {
        $userId = $request->user['id'];
        $role = $request->user['role'];
        $isPrivileged = in_array($role, ['doctor', 'admin', 'super_admin'], true);

        $sql = "SELECT c.id, c.title, c.short_description, c.image_url, c.cover_url, c.thumbnail_url,
                       c.status, c.category_id, c.total_lessons, c.total_sections, c.language,
                       c.difficulty, c.price_egp, c.credits_required, c.free_preview,
                       c.university_id, c.faculty_id, c.academic_level_id, c.created_at,
                       p.full_name AS doctor_name
                  FROM courses c
                  LEFT JOIN profiles p ON p.id = c.doctor_id";
        $params = [];
        if ($isPrivileged) {
            if ($role === 'doctor') {
                $sql .= ' WHERE c.doctor_id = ?';
                $params[] = $userId;
            }
        } else {
            $sql .= " WHERE c.status = 'published'
                      OR EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = ? AND e.course_id = c.id)";
            $params[] = $userId;
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
        $data = $request->json();
        $title = trim((string) ($data['title'] ?? ''));
        if ($title === '') {
            throw new ApiException(422, 'title is required');
        }
        $id = Uuid::v4();
        Database::instance()->insert(
            'INSERT INTO courses (id, doctor_id, title, description, short_description, full_description,
                                  status, language, difficulty, credits_required, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
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
            ]
        );
        AuditService::write($request->user['id'], 'course_created', ['course_id' => $id, 'title' => $title]);
        return ['course' => Database::instance()->row('SELECT * FROM courses WHERE id = ?', [$id])];
    }

    public function update(Request $request): array
    {
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
        $courseId = Uuid::normalize((string) $request->params['id']);
        $studentId = $request->user['id'];

        $course = Database::instance()->row(
            'SELECT id, status, subscription_required FROM courses WHERE id = ?',
            [$courseId]
        );
        if ($course === null || $course['status'] !== 'published') {
            throw new ApiException(404, 'Course not found');
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
        AuditService::write($studentId, 'enrollment_created', ['course_id' => $courseId, 'method' => 'direct']);
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
     * POST /courses/{id}/publish — publish course (draft → published).
     */
    public function publish(Request $request): array
    {
        $id = Uuid::normalize((string) $request->params['id']);
        $this->assertCourseOwner($request, $id);

        $course = Database::instance()->row('SELECT status, title FROM courses WHERE id = ?', [$id]);
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }
        if ($course['status'] === 'published') {
            throw new ApiException(409, 'Course is already published');
        }

        Database::instance()->query(
            "UPDATE courses SET status = 'published', updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
            [$id]
        );

        $this->logLifecycle($id, $course['title'], 'published', $request->user['id']);
        AuditService::write($request->user['id'], 'course_published', ['course_id' => $id]);
        return ['success' => true];
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

        $db->transaction(function (Database $db) use ($id) {
            $db->query('DELETE FROM lesson_materials WHERE lesson_id IN (SELECT id FROM lessons WHERE course_id = ?)', [$id]);
            $db->query('DELETE FROM video_uploads WHERE course_id = ?', [$id]);
            $db->query('DELETE FROM lessons WHERE course_id = ?', [$id]);
            $db->query('DELETE FROM sections WHERE course_id = ?', [$id]);
            $db->query('DELETE FROM activation_codes WHERE course_id = ?', [$id]);
            $db->query('DELETE FROM enrollments WHERE course_id = ?', [$id]);
            $db->query('DELETE FROM courses WHERE id = ?', [$id]);
        });

        $this->logLifecycle($id, $course['title'] ?? '', 'permanently_deleted', $request->user['id']);
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
            'INSERT INTO enrollments (id, student_id, course_id, enrolled_by, enrollment_method, status, enrolled_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
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
    private function isEnrolled(string $studentId, string $courseId): bool
    {
        return (bool) Database::instance()->value(
            'SELECT COUNT(*) FROM enrollments WHERE student_id = ? AND course_id = ?',
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
