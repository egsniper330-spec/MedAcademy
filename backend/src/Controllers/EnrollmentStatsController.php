<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Utils\Uuid;

/**
 * EnrollmentStatsController — student enrollment statistics for Admin and
 * Super Admin dashboards.
 *
 * TWO DISTINCT METRICS, NEVER COMBINED
 * ------------------------------------
 *   • unique_students  — distinct student ACCOUNTS. A student enrolled in five
 *                        courses counts ONCE platform-wide, and once per doctor
 *                        that owns any of their courses.
 *   • enrollments      — valid student↔course enrolments. The same student
 *                        counts once per course, so five courses = five.
 *
 * Both are returned together by every endpoint so the UI can switch modes
 * without refetching and without a figure silently changing meaning.
 *
 * COUNTING RULES (single source of truth for every query below)
 * ------------------------------------------------------------
 * An enrolment counts when ALL of these hold:
 *   1. e.status IS NULL OR e.status = 'active'
 *      ('suspended' is the only other value the app writes — see
 *      StudentBulkController::suspend/resume — so a suspended enrolment is
 *      excluded, matching the column's default and the rest of the app.)
 *   2. the student's profile role is 'student' — doctors, assistants, admins
 *      and super admins are never counted as students.
 *   3. the student's profile is not in the trash (trashed_at IS NULL).
 *   4. the course is not permanently deleted (permanently_deleted = 0) and, by
 *      default, not archived (archived_at IS NULL). `include_archived=1` opts
 *      archived courses back in so an admin can audit historical numbers; the
 *      response echoes the choice in `policy.include_archived`.
 *
 * DUPLICATE ROWS CANNOT INFLATE A COUNT: every aggregate reads from a
 * (student_id, course_id) pair set materialised with GROUP BY before any join,
 * so a legacy duplicate enrolment row — or a second JOIN — cannot double a
 * figure. `enrollments` is therefore COUNT(*) over distinct pairs and
 * `unique_students` is COUNT(DISTINCT student_id) over the same set.
 *
 * AUTHORIZATION: admin and super_admin only (route-level `role` gate). Both
 * roles already read platform-wide analytics elsewhere (get_super_admin_stats,
 * /analytics/*), so this endpoint grants no new scope. It is strictly read-only:
 * no INSERT/UPDATE/DELETE and no audit row.
 */
final class EnrollmentStatsController
{
    /** Rows per page when the client does not ask for a size. */
    private const DEFAULT_PER_PAGE = 25;
    private const MAX_PER_PAGE = 100;

    /** Sorting is a whitelist — never interpolate a client string into SQL. */
    private const DOCTOR_SORTS = [
        'name'            => 'full_name',
        'unique_students' => 'unique_students',
        'enrollments'     => 'enrollments',
        'courses'         => 'courses_count',
    ];

    private const COURSE_SORTS = [
        'title'           => 'title',
        'doctor'          => 'doctor_name',
        'unique_students' => 'unique_students',
        'enrollments'     => 'enrollments',
    ];

    private const COURSE_STATUSES = ['draft', 'published', 'archived'];

    // ── Endpoints ───────────────────────────────────────────────────────────

    /**
     * GET /analytics/enrollment-stats
     *
     * Platform overview: the two headline metrics plus the counts an admin needs
     * to sanity-check them (courses/doctors with at least one enrolment).
     * `enrollments` here MUST equal the sum of the per-course `enrollments`
     * column — both are computed from the same pair set.
     */
    public function summary(Request $request): array
    {
        $includeArchived = $this->includeArchived($request);
        $db = Database::instance();

        $row = $db->row(
            'SELECT COUNT(*) AS enrollments, COUNT(DISTINCT pairs.student_id) AS unique_students,'
            . ' COUNT(DISTINCT pairs.course_id) AS courses_with_enrollments'
            . ' FROM (' . $this->eligiblePairsSql($includeArchived) . ') pairs'
        ) ?? [];

        $doctorIds = $db->row(
            'SELECT COUNT(DISTINCT c.doctor_id) AS doctors_with_enrollments'
            . ' FROM (' . $this->eligiblePairsSql($includeArchived) . ') pairs'
            . ' JOIN courses c ON c.id = pairs.course_id'
        ) ?? [];

        return [
            'totals' => [
                'enrollments'              => (int) ($row['enrollments'] ?? 0),
                'unique_students'          => (int) ($row['unique_students'] ?? 0),
                'courses_with_enrollments' => (int) ($row['courses_with_enrollments'] ?? 0),
                'doctors_with_enrollments' => (int) ($doctorIds['doctors_with_enrollments'] ?? 0),
                'courses_total'            => (int) $db->value(
                    'SELECT COUNT(*) FROM courses c WHERE ' . $this->courseScopeSql($includeArchived, 'c'),
                    [],
                    0
                ),
                'doctors_total'            => (int) $db->value(
                    "SELECT COUNT(*) FROM profiles p WHERE p.role = 'doctor'",
                    [],
                    0
                ),
            ],
            'policy'      => $this->policy($includeArchived),
            'server_time' => gmdate('Y-m-d\TH:i:s\Z'),
        ];
    }

    /**
     * GET /analytics/enrollment-stats/doctors
     * Query: search, sort, order, page, per_page, include_archived
     *
     * Doctors with no enrolments are included with zeros so the table can show
     * an accurate roster (their `courses_count` still comes from the courses
     * table, not from the enrolment join).
     */
    public function doctors(Request $request): array
    {
        $db = Database::instance();
        $q = $request->queryParams();
        $includeArchived = $this->includeArchived($request);
        [$page, $perPage, $offset] = $this->pagination($q);
        $sort = $this->sortColumn($q, self::DOCTOR_SORTS, 'unique_students');
        $direction = $this->direction($q);

        [$searchSql, $searchParams] = $this->search(
            $q,
            ['p.full_name', 'p.email']
        );

        $from = ' FROM profiles p'
            . ' LEFT JOIN (' . $this->coursesPerDoctorSql($includeArchived) . ') cd ON cd.doctor_id = p.id'
            . ' LEFT JOIN (' . $this->enrollmentsPerDoctorSql($includeArchived) . ') en ON en.doctor_id = p.id'
            . " WHERE p.role = 'doctor'" . $searchSql;

        $total = (int) $db->value('SELECT COUNT(*)' . $from, $searchParams, 0);

        $rows = $db->select(
            'SELECT p.id AS doctor_id, p.full_name, p.email, p.status,'
            . ' COALESCE(cd.courses_count, 0) AS courses_count,'
            . ' COALESCE(en.enrollments, 0) AS enrollments,'
            . ' COALESCE(en.unique_students, 0) AS unique_students'
            . $from
            . " ORDER BY {$sort} {$direction}, p.full_name ASC"
            . " LIMIT {$perPage} OFFSET {$offset}",
            $searchParams
        );

        return [
            'rows'    => array_map([$this, 'normaliseDoctorRow'], $rows),
            'page'    => $page,
            'per_page'=> $perPage,
            'total'   => $total,
            'total_pages' => $this->totalPages($total, $perPage),
            'sort'    => array_search($sort, self::DOCTOR_SORTS, true) ?: 'unique_students',
            'order'   => strtolower($direction),
            'policy'  => $this->policy($includeArchived),
        ];
    }

    /**
     * GET /analytics/enrollment-stats/courses
     * Query: search, doctor_id, course_status, sort, order, page, per_page,
     *        include_archived
     *
     * Every eligible course appears, including courses with zero enrolments, so
     * "0 students" is visible rather than missing.
     */
    public function courses(Request $request): array
    {
        $db = Database::instance();
        $q = $request->queryParams();
        $includeArchived = $this->includeArchived($request);
        [$page, $perPage, $offset] = $this->pagination($q);
        $sort = $this->sortColumn($q, self::COURSE_SORTS, 'enrollments');
        $direction = $this->direction($q);

        $where = ' WHERE ' . $this->courseScopeSql($includeArchived, 'c');
        $params = [];

        $doctorId = trim((string) ($q['doctor_id'] ?? ''));
        if ($doctorId !== '') {
            $where .= ' AND c.doctor_id = ?';
            $params[] = Uuid::normalize($doctorId);
        }

        $status = strtolower(trim((string) ($q['course_status'] ?? '')));
        if ($status !== '' && in_array($status, self::COURSE_STATUSES, true)) {
            $where .= ' AND c.status = ?';
            $params[] = $status;
        }

        [$searchSql, $searchParams] = $this->search($q, ['c.title', 'd.full_name']);
        $where .= $searchSql;
        $params = array_merge($params, $searchParams);

        $from = ' FROM courses c'
            . ' LEFT JOIN profiles d ON d.id = c.doctor_id'
            . ' LEFT JOIN (' . $this->enrollmentsPerCourseSql($includeArchived) . ') en ON en.course_id = c.id'
            . $where;

        $total = (int) $db->value('SELECT COUNT(*)' . $from, $params, 0);

        $rows = $db->select(
            'SELECT c.id AS course_id, c.title, c.status, c.archived_at, c.doctor_id,'
            . ' d.full_name AS doctor_name, d.email AS doctor_email,'
            . ' COALESCE(en.enrollments, 0) AS enrollments,'
            . ' COALESCE(en.unique_students, 0) AS unique_students,'
            . ' en.last_enrolled_at'
            . $from
            . " ORDER BY {$sort} {$direction}, c.title ASC"
            . " LIMIT {$perPage} OFFSET {$offset}",
            $params
        );

        return [
            'rows'    => array_map([$this, 'normaliseCourseRow'], $rows),
            'page'    => $page,
            'per_page'=> $perPage,
            'total'   => $total,
            'total_pages' => $this->totalPages($total, $perPage),
            'sort'    => array_search($sort, self::COURSE_SORTS, true) ?: 'enrollments',
            'order'   => strtolower($direction),
            'policy'  => $this->policy($includeArchived),
        ];
    }

    /**
     * GET /analytics/enrollment-stats/doctors/{id}
     *
     * One doctor's totals plus the per-course breakdown that produced them.
     * The breakdown is the same course query filtered by doctor, so
     * Σ breakdown enrolments == the doctor's `enrollments`.
     */
    public function doctorDetail(Request $request): array
    {
        $doctorId = Uuid::normalize((string) ($request->params['id'] ?? ''));
        $db = Database::instance();
        $q = $request->queryParams();
        $includeArchived = $this->includeArchived($request);
        [$page, $perPage, $offset] = $this->pagination($q, 50);

        $doctor = $db->row(
            'SELECT p.id AS doctor_id, p.full_name, p.email, p.status'
            . ' FROM profiles p WHERE p.id = ? AND p.role = ?',
            [$doctorId, 'doctor']
        );
        if ($doctor === null) {
            throw new ApiException(404, 'Doctor not found');
        }

        $totalsRow = $db->row(
            'SELECT COALESCE(en.enrollments, 0) AS enrollments,'
            . ' COALESCE(en.unique_students, 0) AS unique_students,'
            . ' COALESCE(cd.courses_count, 0) AS courses_count'
            . ' FROM profiles p'
            . ' LEFT JOIN (' . $this->coursesPerDoctorSql($includeArchived) . ') cd ON cd.doctor_id = p.id'
            . ' LEFT JOIN (' . $this->enrollmentsPerDoctorSql($includeArchived) . ') en ON en.doctor_id = p.id'
            . ' WHERE p.id = ?',
            [$doctorId]
        ) ?? [];

        $from = ' FROM courses c'
            . ' LEFT JOIN profiles d ON d.id = c.doctor_id'
            . ' LEFT JOIN (' . $this->enrollmentsPerCourseSql($includeArchived) . ') en ON en.course_id = c.id'
            . ' WHERE ' . $this->courseScopeSql($includeArchived, 'c') . ' AND c.doctor_id = ?';

        $total = (int) $db->value('SELECT COUNT(*)' . $from, [$doctorId], 0);

        $rows = $db->select(
            'SELECT c.id AS course_id, c.title, c.status, c.archived_at, c.doctor_id,'
            . ' d.full_name AS doctor_name, d.email AS doctor_email,'
            . ' COALESCE(en.enrollments, 0) AS enrollments,'
            . ' COALESCE(en.unique_students, 0) AS unique_students,'
            . ' en.last_enrolled_at'
            . $from
            . ' ORDER BY COALESCE(en.enrollments, 0) DESC, c.title ASC'
            . " LIMIT {$perPage} OFFSET {$offset}",
            [$doctorId]
        );

        return [
            'doctor' => $this->normaliseDoctorRow($doctor + $totalsRow),
            'courses' => [
                'rows'        => array_map([$this, 'normaliseCourseRow'], $rows),
                'page'        => $page,
                'per_page'    => $perPage,
                'total'       => $total,
                'total_pages' => $this->totalPages($total, $perPage),
            ],
            'policy' => $this->policy($includeArchived),
        ];
    }

    /**
     * GET /analytics/enrollment-stats/courses/{id}
     *
     * One course: the metrics plus the doctor it belongs to and the last time a
     * student was enrolled. Read-only, admin/super_admin only.
     */
    public function courseDetail(Request $request): array
    {
        $courseId = Uuid::normalize((string) ($request->params['id'] ?? ''));
        $db = Database::instance();
        $includeArchived = $this->includeArchived($request);

        $row = $db->row(
            'SELECT c.id AS course_id, c.title, c.status, c.archived_at, c.doctor_id,'
            . ' d.full_name AS doctor_name, d.email AS doctor_email,'
            . ' COALESCE(en.enrollments, 0) AS enrollments,'
            . ' COALESCE(en.unique_students, 0) AS unique_students,'
            . ' en.last_enrolled_at'
            . ' FROM courses c'
            . ' LEFT JOIN profiles d ON d.id = c.doctor_id'
            . ' LEFT JOIN (' . $this->enrollmentsPerCourseSql($includeArchived) . ') en ON en.course_id = c.id'
            . ' WHERE c.id = ? AND ' . $this->courseScopeSql($includeArchived, 'c'),
            [$courseId]
        );
        if ($row === null) {
            throw new ApiException(404, 'Course not found');
        }

        return [
            'course' => $this->normaliseCourseRow($row),
            'policy' => $this->policy($includeArchived),
        ];
    }

    // ── Aggregate SQL (the counting rules live here, once) ───────────────────

    /**
     * The eligible (student, course) pair set every aggregate is derived from.
     *
     * GROUP BY (not DISTINCT over extra columns) keeps one row per pair even if
     * an older deployment stored duplicates, so COUNT(*) cannot inflate.
     */
    private function eligiblePairsSql(bool $includeArchived): string
    {
        return 'SELECT e.student_id, e.course_id, MIN(e.enrolled_at) AS enrolled_at'
            . ' FROM enrollments e'
            . ' JOIN courses c ON c.id = e.course_id'
            . ' JOIN profiles s ON s.id = e.student_id'
            . ' WHERE ' . $this->enrollmentScopeSql('e')
            . ' AND ' . $this->courseScopeSql($includeArchived, 'c')
            . " AND s.role = 'student'"
            . ' AND s.trashed_at IS NULL'
            . ' GROUP BY e.student_id, e.course_id';
    }

    /** Per-course aggregates: both metrics from the same pair set. */
    private function enrollmentsPerCourseSql(bool $includeArchived): string
    {
        // The pair set is filtered by course scope through the join below, so a
        // course that is archived/deleted never contributes.
        return 'SELECT pairs.course_id,'
            . ' COUNT(*) AS enrollments,'
            . ' COUNT(DISTINCT pairs.student_id) AS unique_students,'
            . ' MAX(pairs.enrolled_at) AS last_enrolled_at'
            . ' FROM (' . $this->eligiblePairsSql($includeArchived) . ') pairs'
            . ' GROUP BY pairs.course_id';
    }

    /** Per-doctor aggregates: one row per student per doctor (not per course). */
    private function enrollmentsPerDoctorSql(bool $includeArchived): string
    {
        return 'SELECT c.doctor_id,'
            . ' COUNT(*) AS enrollments,'
            . ' COUNT(DISTINCT pairs.student_id) AS unique_students'
            . ' FROM (' . $this->eligiblePairsSql($includeArchived) . ') pairs'
            . ' JOIN courses c ON c.id = pairs.course_id'
            . ' GROUP BY c.doctor_id';
    }

    /** Every course assigned to a doctor (zeros included). */
    private function coursesPerDoctorSql(bool $includeArchived): string
    {
        return 'SELECT c.doctor_id, COUNT(*) AS courses_count'
            . ' FROM courses c'
            . ' WHERE ' . $this->courseScopeSql($includeArchived, 'c')
            . ' GROUP BY c.doctor_id';
    }

    private function enrollmentScopeSql(string $alias): string
    {
        return "({$alias}.status IS NULL OR {$alias}.status = 'active')";
    }

    private function courseScopeSql(bool $includeArchived, string $alias): string
    {
        $sql = "{$alias}.permanently_deleted = 0";
        if (!$includeArchived) {
            $sql .= " AND {$alias}.archived_at IS NULL";
        }
        return $sql;
    }

    // ── Request helpers ─────────────────────────────────────────────────────

    private function includeArchived(Request $request): bool
    {
        $raw = strtolower(trim((string) ($request->queryParams()['include_archived'] ?? '')));
        return in_array($raw, ['1', 'true', 'yes'], true);
    }

    /** @return array{0:int,1:int,2:int} [page, perPage, offset] */
    private function pagination(array $q, ?int $defaultPerPage = null): array
    {
        $page = (int) ($q['page'] ?? 1);
        if ($page < 1) {
            $page = 1;
        }
        $perPage = (int) ($q['per_page'] ?? ($defaultPerPage ?? self::DEFAULT_PER_PAGE));
        if ($perPage < 1) {
            $perPage = $defaultPerPage ?? self::DEFAULT_PER_PAGE;
        }
        if ($perPage > self::MAX_PER_PAGE) {
            $perPage = self::MAX_PER_PAGE;
        }
        return [$page, $perPage, ($page - 1) * $perPage];
    }

    private function totalPages(int $total, int $perPage): int
    {
        return $perPage > 0 ? (int) ceil($total / $perPage) : 0;
    }

    /** Whitelisted sort column; unknown input falls back to the default. */
    private function sortColumn(array $q, array $allowed, string $default): string
    {
        $requested = strtolower(trim((string) ($q['sort'] ?? '')));
        return $allowed[$requested] ?? $allowed[$default];
    }

    private function direction(array $q): string
    {
        return strtolower(trim((string) ($q['order'] ?? ''))) === 'asc' ? 'ASC' : 'DESC';
    }

    /**
     * Optional `search` over the given columns.
     * @return array{0:string,1:array<int,string>} [sqlFragment, params]
     */
    private function search(array $q, array $columns): array
    {
        $term = trim((string) ($q['search'] ?? ''));
        if ($term === '') {
            return ['', []];
        }
        $like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $term) . '%';
        $parts = [];
        $params = [];
        foreach ($columns as $column) {
            $parts[] = "{$column} LIKE ?";
            $params[] = $like;
        }
        return [' AND (' . implode(' OR ', $parts) . ')', $params];
    }

    // ── Response shaping (ints stay ints, never "" or null) ─────────────────

    private function normaliseDoctorRow(array $row): array
    {
        return [
            'doctor_id'       => (string) ($row['doctor_id'] ?? $row['id'] ?? ''),
            'full_name'       => (string) ($row['full_name'] ?? ''),
            'email'           => (string) ($row['email'] ?? ''),
            'status'          => $row['status'] ?? null,
            'courses_count'   => (int) ($row['courses_count'] ?? 0),
            'enrollments'     => (int) ($row['enrollments'] ?? 0),
            'unique_students' => (int) ($row['unique_students'] ?? 0),
        ];
    }

    private function normaliseCourseRow(array $row): array
    {
        return [
            'course_id'        => (string) ($row['course_id'] ?? $row['id'] ?? ''),
            'title'            => (string) ($row['title'] ?? ''),
            'status'           => (string) ($row['status'] ?? 'draft'),
            'archived_at'      => $row['archived_at'] ?? null,
            'doctor_id'        => $row['doctor_id'] !== null ? (string) $row['doctor_id'] : null,
            'doctor_name'      => $row['doctor_name'] !== null ? (string) $row['doctor_name'] : null,
            'doctor_email'     => $row['doctor_email'] !== null ? (string) $row['doctor_email'] : null,
            'enrollments'      => (int) ($row['enrollments'] ?? 0),
            'unique_students'  => (int) ($row['unique_students'] ?? 0),
            'last_enrolled_at' => $row['last_enrolled_at'] ?? null,
        ];
    }

    /** Documented counting policy, echoed so the UI never has to guess. */
    private function policy(bool $includeArchived): array
    {
        return [
            'counting_modes'        => ['unique_students', 'enrollments'],
            'eligible_statuses'     => ['active'],
            'includes_null_status'  => true,
            'student_role_only'     => true,
            'excludes_trashed'      => true,
            'include_archived'      => $includeArchived,
            'counts_are_distinct'   => true,
        ];
    }
}
