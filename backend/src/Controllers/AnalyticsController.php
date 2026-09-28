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
 * AnalyticsController — PHP equivalents of admin/analytics RPCs.
 *
 * Implements:
 *   get_security_stats, get_user_activity, get_user_profile_summary,
 *   get_trash_list, get_trash_stats, get_deletion_stats, get_archive_analytics,
 *   get_archived_courses, get_course_delete_stats, get_risky_devices,
 *   get_video_asset_usage, run_db_audit, recalculate_doctor_earnings,
 *   reset_doctor_earnings, reset_platform_earnings
 */
final class AnalyticsController
{
    /**
     * GET /analytics/security-stats — aggregated security event statistics.
     *
     * FRONTEND CONTRACT (get_security_stats RPC → SecurityStats):
     *   { total_events, root_jailbreak, vpn, proxy, ssl_pinning, screenshot,
     *     screen_recording, debug, app_integrity, recent_events_24h,
     *     by_type, by_platform, policies }
     *
     * Optional window params: p_start_date / p_end_date (ISO-8601). When absent
     * the aggregation covers the full table (legacy behavior). The per-category
     * counters are additive over the same window; by_type/by_platform/policies
     * remain global snapshots for compatibility with existing consumers.
     */
    public function securityStats(Request $request): array
    {
        $db = Database::instance();
        $q = $request->queryParams();

        $startDate = trim((string) ($q['start_date'] ?? ''));
        $endDate   = trim((string) ($q['end_date'] ?? ''));
        $windowSql  = '';
        $windowBind = [];
        if ($startDate !== '' && $endDate !== '') {
            $windowSql = ' WHERE created_at BETWEEN ? AND ?';
            $windowBind = [$startDate, $endDate];
        }

        $totalEvents = (int) $db->value(
            "SELECT COUNT(*) FROM security_events{$windowSql}", $windowBind, 0
        );
        $recentEvents = (int) $db->value(
            "SELECT COUNT(*) FROM security_events WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 24 HOUR)",
            [], 0
        );

        // Per-category counters over the requested window (additive keys — the
        // dashboard's SecurityStats interface). COUNT(CASE…) keeps this a single
        // round-trip; unknown event types simply fall through to 0.
        $categories = [
            'root_jailbreak'  => ["'root_detected','jailbreak_detected'"],
            'vpn'             => ["'vpn_detected'"],
            'proxy'           => ["'proxy_detected'"],
            'ssl_pinning'     => ["'ssl_pinning_failure'"],
            'screenshot'      => ["'screenshot_detected'"],
            'screen_recording'=> ["'screen_recording_detected'"],
            'debug'           => ["'debug_detected','debugger_attached','developer_options_enabled','adb_enabled'"],
            'app_integrity'   => ["'app_integrity_compromised','signature_invalid','tamper_detected','frida_detected','xposed_detected','magisk_detected'"],
        ];
        $categorySql = [];
        foreach ($categories as $key => $types) {
            $categorySql[] = "SUM(CASE WHEN event_type IN ({$types[0]}) THEN 1 ELSE 0 END) AS `{$key}`";
        }
        $catRow = $db->row(
            'SELECT ' . implode(', ', $categorySql) . " FROM security_events{$windowSql}",
            $windowBind
        ) ?? [];
        $counters = [];
        foreach (array_keys($categories) as $key) {
            $counters[$key] = (int) ($catRow[$key] ?? 0);
        }

        $byType = $db->select(
            "SELECT event_type, COUNT(*) as count FROM security_events
             GROUP BY event_type ORDER BY count DESC LIMIT 20"
        );

        $byPlatform = $db->select(
            "SELECT platform, COUNT(*) as count FROM security_events
             WHERE platform IS NOT NULL GROUP BY platform ORDER BY count DESC"
        );

        $policies = $db->select('SELECT detection_type, action, enabled FROM security_policies ORDER BY detection_type');

        return [
            'total_events'      => $totalEvents,
            'recent_events_24h' => $recentEvents,
            ...$counters,
            'by_type'           => $byType ?? [],
            'by_platform'       => $byPlatform ?? [],
            'policies'          => $policies ?? [],
        ];
    }

    /**
     * GET /analytics/user-activity/{id} — a user's activity timeline.
     *
     * THE CONTRACT (proven against the RN UserAuditLogs screen): the response
     * is a paginated array of UNIFIED activity rows. The previous shape —
     * three separate raw arrays with only (id, action, details, created_at)
     * — made the screen crash (security rows have no `action` → undefined
     * passed to actionLabel/split) and silently ignored every filter param.
     * The screen still renders legacy wrapper payloads through
     * normalizeUserActivityResponse() (api.ts), so old deployments keep working.
     *
     * Query params (all optional): category, search, direction ('by'|'on'),
 * date_from, date_to, limit (≤100), offset.
     */
    public function userActivity(Request $request): array
    {
        $userId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $db = Database::instance();
        $q = $request->queryParams();

        $limit  = min(100, max(1, (int) ($q['limit'] ?? 50)));
        $offset = max(0, (int) ($q['offset'] ?? 0));
        $category = strtolower(trim((string) ($q['category'] ?? '')));
        $search   = trim((string) ($q['search'] ?? ''));
        $direction = strtolower(trim((string) ($q['direction'] ?? '')));
        $dateFrom = trim((string) ($q['date_from'] ?? ''));
        $dateTo   = trim((string) ($q['date_to'] ?? ''));

        // ---- Build the unified query over audit_logs (+ optional security_events)
        $selectAudit = "SELECT a.id, 'audit' AS entry_kind, a.action, a.action AS event_type,
                a.description, a.target_name, a.actor_id, p.full_name AS actor_name,
                p.role AS actor_role, a.log_status, a.resource_type, a.resource_id,
                a.ip_address, a.created_at, NULL AS risk_score, NULL AS platform
             FROM audit_logs a
             LEFT JOIN profiles p ON p.id = a.actor_id
             WHERE (a.user_id = ? OR a.actor_id = ?)";
        $selectSecurity = null;
        // First two bindings: the shared user scope (used by BOTH legs of the
        // UNION when present — PDO positional params cannot be reused).
        $params = [$userId, $userId];

        if ($category === 'security') {
            // Security category = the user's security_events only.
            $selectAudit = "SELECT s.id, 'security' AS entry_kind, COALESCE(s.event_type, 'security_event') AS action,
                    s.event_type, NULL AS description, NULL AS target_name, s.user_id AS actor_id,
                    NULL AS actor_name, NULL AS actor_role,
                    CASE COALESCE(s.policy_action, '') WHEN 'block' THEN 'failed' WHEN 'warn' THEN 'warning' ELSE 'success' END AS log_status,
                    'security_event' AS resource_type, s.device_id AS resource_id,
                    s.ip_address, s.created_at, s.risk_score, s.platform
                 FROM security_events s
                 WHERE (s.user_id = ?)";
            $params = [$userId];
        } elseif ($category === '') {
            // Unified timeline: audit + security events merged.
            $selectSecurity = "SELECT s.id, 'security' AS entry_kind, COALESCE(s.event_type, 'security_event') AS action,
                    s.event_type, NULL AS description, NULL AS target_name, s.user_id AS actor_id,
                    NULL AS actor_name, NULL AS actor_role,
                    CASE COALESCE(s.policy_action, '') WHEN 'block' THEN 'failed' WHEN 'warn' THEN 'warning' ELSE 'success' END AS log_status,
                    'security_event' AS resource_type, s.device_id AS resource_id,
                    s.ip_address, s.created_at, s.risk_score, s.platform
                 FROM security_events s
                 WHERE (s.user_id = ?)";
            // $params stays [user, user]: leg 1 consumes one, leg 2 the other.
        }

        // ---- Filter fragments. PDO positional params bind in SQL order, so
        // each leg needs its OWN copy of every binding. The SEARCH fragment is
        // per-leg: WHERE cannot reference SELECT aliases, and the security leg
        // has no action/description/target_name columns (its real column is
        // event_type). Date fragments are shared (created_at exists on both).
        $searchAuditFrag = '';
        $searchSecFrag   = '';
        $searchAuditParams = [];
        $searchSecParams   = [];
        if ($search !== '') {
            $like = '%' . $search . '%';
            $searchAuditFrag = " AND (action LIKE ? OR COALESCE(description, '') LIKE ? OR COALESCE(target_name, '') LIKE ?)";
            array_push($searchAuditParams, $like, $like, $like);
            $searchSecFrag = ' AND COALESCE(event_type, \'\') LIKE ?';
            $searchSecParams[] = $like;
        }
        // direction: 'by' → only rows the user ACTED (actor_id); 'on' → only
        // rows that target the user (user_id). Default: both.
        $directionFrag = '';
        $directionParams = [];
        if ($direction === 'by') {
            $directionFrag = ' AND actor_id = ?';
            $directionParams[] = $userId;
        } elseif ($direction === 'on') {
            $directionFrag = ' AND user_id = ?';
            $directionParams[] = $userId;
        }
        $dateFrag = '';
        $dateParams = [];
        if ($dateFrom !== '') {
            $dateFrag .= ' AND created_at >= ?';
            $dateParams[] = $dateFrom;
        }
        if ($dateTo !== '') {
            $dateFrag .= ' AND created_at <= ?';
            $dateParams[] = $dateTo;
        }
        $whereExtraAudit = $searchAuditFrag . $directionFrag . $dateFrag;
        $whereExtraSec   = $searchSecFrag . $directionFrag . $dateFrag;
        $extraAuditParams = array_merge($searchAuditParams, $directionParams, $dateParams);
        $extraSecParams   = array_merge($searchSecParams, $directionParams, $dateParams);

        $orderBy = ' ORDER BY created_at DESC';
        $limitSql = " LIMIT {$limit} OFFSET {$offset}";

        // ---- Category mapping for audit rows (audit-only paths). $categoryWhere
        // applies ONLY to the audit leg (security rows are never category-matched;
        // 'security' category swaps the whole leg above).
        $categoryWhere = '';
        $categoryParams = [];
        if ($category !== '' && $category !== 'security') {
            $map = [
                'auth'    => ['login', 'logout', 'register', 'password_reset', 'password_changed', 'phone_login', 'failed_login', 'password_changed_by_admin', 'password_changed_first_login', 'temp_password_generated', 'session_revoked', 'reset_token'],
                'profile' => ['profile_name_changed', 'profile_avatar_changed', 'profile_email_changed', 'profile_phone_changed', 'profile_updated', 'name_changed', 'avatar_changed', 'avatar_updated', 'email_changed'],
                'devices' => ['device_reset', 'device_force_logout', 'device_blocked', 'device_unblocked', 'device_registered', 'device_limit_changed', 'device_revoked', 'device_removed', 'device_reset_by_admin', 'device_logout_all', 'limit_changed', 'unlimited_enabled', 'unlimited_disabled', 'unlimited_devices_enabled', 'unlimited_devices_disabled', 'bulk_device_reset', 'bulk_reset_devices'],
                'courses' => ['course_created', 'course_updated', 'course_deleted', 'course_published', 'course_unpublished', 'course_archived', 'course_restored', 'course_price_changed', 'course_hidden', 'lesson_created', 'lesson_updated', 'lesson_deleted', 'video_uploaded', 'video_replaced', 'video_deleted', 'pdf_uploaded', 'pdf_deleted'],
                'purchases' => ['credit_allocated', 'credit_consumed', 'credit_deducted', 'credit_refunded', 'credit_expired', 'credits_added', 'credits_removed', 'code_created', 'code_redeemed', 'code_deactivated', 'code_deleted', 'code_activated', 'code_disabled', 'code_expired', 'redeem_code_created', 'redeem_code_redeemed', 'redeem_code_revoked', 'enrollment_created', 'enrollment_removed'], 'admin_actions' => [
                    'platform_settings_changed', 'security_policy_changed', 'settings_changed', 'revenue_settings_changed', 'earnings_settings_changed', 'update_earnings_settings', 'credit_price_changed', 'custom_pricing_enabled', 'custom_pricing_disabled', 'provider_changed', 'system_health_check', 'impersonation_started', 'impersonation_ended', 'bulk_trash', 'bulk_restore', 'bulk_permanent_delete', 'bulk_suspend', 'bulk_unsuspend', 'bulk_reset_password', 'admin_updated', 'admin_created', 'admin_deleted', 'notification_sent', 'platform_earnings_reset', 'earnings_reset', 'undo_delete', 'trash_emptied', 'deletion_verification_failed'],
                'roles'   => ['role_changed', 'role_changed_to_doctor', 'role_changed_to_admin', 'role_changed_to_super_admin', 'role_changed_to_student', 'permission_changed', 'doctor_approved', 'doctor_rejected', 'doctor_created', 'user_created', 'student_created_by_doctor', 'student_bulk_imported', 'admin_created', 'super_admin_created', 'initial_super_admin_created'],
                'blocking' => ['user_suspended', 'user_blocked', 'user_unblocked', 'user_trashed', 'user_restored', 'user_deleted', 'user_hard_deleted', 'account_restored', 'account_permanently_deleted', 'user_activated'],
                'system'  => ['security_event', 'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected', 'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected', 'debug_detected', 'frida_detected', 'xposed_detected', 'app_integrity_compromised'],
            ];
            $actions = $map[$category] ?? null;
            if ($actions !== null) {
                $placeholders = implode(',', array_fill(0, count($actions), '?'));
                $categoryWhere = " AND action IN ({$placeholders})";
                $categoryParams = $actions;
            } else {
                // Unknown category → match nothing rather than silently ignoring the filter.
                $categoryWhere = ' AND 1=0';
            }
        }

        if ($selectSecurity !== null) {
            // ---- UNION path: audit leg binds [user, user] + audit extras,
            // security leg binds [user] + its own extras (separate placeholders).
            $auditLeg   = $selectAudit . $categoryWhere . $whereExtraAudit;
            $secLeg     = $selectSecurity . $whereExtraSec;
            $auditParams   = array_merge([$userId, $userId], $categoryParams, $extraAuditParams);
            $secParams     = array_merge([$userId], $extraSecParams);
            $pageSql   = " LIMIT {$limit} OFFSET {$offset}";

            $rows = $db->select(
                "SELECT * FROM ((" . $auditLeg . $orderBy . $pageSql . ")"
                . " UNION ALL (" . $secLeg . $orderBy . $pageSql . ")) u"
                . " ORDER BY u.created_at DESC LIMIT {$limit} OFFSET {$offset}",
                array_merge($auditParams, $secParams)
            );

            // Count: same union without pagination.
            $countRows = $db->select(
                "SELECT (SELECT COUNT(*) FROM (" . $auditLeg . ") t1) AS c1,"
                . " (SELECT COUNT(*) FROM (" . $secLeg . ") t2) AS c2",
                array_merge($auditParams, $secParams)
            );
            $total = (int) ($countRows[0]['c1'] ?? 0) + (int) ($countRows[0]['c2'] ?? 0);
        } else {
            $whereSql = $selectAudit . $categoryWhere . $whereExtraAudit;
            $rows = $db->select($whereSql . $orderBy . $limitSql, array_merge($params, $categoryParams, $extraAuditParams));
            $countRows = $db->select("SELECT COUNT(*) AS c FROM (" . $whereSql . ") t", array_merge($params, $categoryParams, $extraAuditParams));
            $total = (int) ($countRows[0]['c'] ?? 0);
        }

        $entries = array_map(static function (array $r): array {
            return [
                'id'            => (string) $r['id'],
                'entry_kind'    => (string) $r['entry_kind'],
                'action'        => (string) ($r['action'] ?? 'unknown'),
                'event_type'    => $r['event_type'] ?? null,
                'description'   => $r['description'] ?? null,
                'target_name'   => $r['target_name'] ?? null,
                'actor_id'      => $r['actor_id'] ?? null,
                'actor_name'    => $r['actor_name'] ?? null,
                'actor_role'    => $r['actor_role'] ?? null,
                'log_status'    => (string) ($r['log_status'] ?? 'success'),
                'resource_type' => $r['resource_type'] ?? null,
                'resource_id'   => $r['resource_id'] ?? null,
                'ip_address'    => $r['ip_address'] ?? null,
                'risk_score'    => $r['risk_score'] !== null ? (int) $r['risk_score'] : null,
                'platform'      => $r['platform'] ?? null,
                'created_at'    => (string) $r['created_at'],
            ];
        }, $rows ?? []);

        return [
            'entries'     => $entries,
            'total_count' => $total,
            'limit'       => $limit,
            'offset'      => $offset,
        ];
    }

    /**
     * GET /analytics/user-profile/{id} — full profile summary.
     */
    public function userProfile(Request $request): array
    {
        $userId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $db = Database::instance();

        $profile = $db->row('SELECT * FROM profiles WHERE id = ?', [$userId]);
        if ($profile === null) {
            throw new ApiException(404, 'User not found');
        }

        $credits = $db->row('SELECT * FROM credits WHERE doctor_id = ?', [$userId]);
        $devices = $db->select(
            "SELECT id, device_name, platform, status, last_active_at FROM devices WHERE user_id = ?",
            [$userId]
        );
        $enrollments = $db->select(
            "SELECT e.id, e.course_id, e.enrolled_at, e.status, c.title AS course_title
             FROM enrollments e JOIN courses c ON c.id = e.course_id
             WHERE e.student_id = ? ORDER BY e.enrolled_at DESC LIMIT 50",
            [$userId]
        );

        return [
            'profile' => $profile,
            'credits' => $credits ?? ['allocated' => 0, 'consumed' => 0, 'remaining' => 0],
            'devices' => $devices ?? [],
            'enrollments' => $enrollments ?? [],
        ];
    }

    /**
     * GET /analytics/trash-list — list trashed users.
     */
    public function trashList(Request $request): array
    {
        $limit = min((int) $request->query('limit', 50), 200);
        $offset = max((int) $request->query('offset', 0), 0);
        $role = $request->query('role');

        $db = Database::instance();

        // Build query — only select columns guaranteed to exist on all environments
        $where = "status = 'trashed'";
        $params = [];
        if ($role && in_array($role, ['student', 'doctor', 'admin', 'super_admin'], true)) {
            $where .= ' AND role = ?';
            $params[] = $role;
        }

        // LIMIT/OFFSET are cast to int above, so inline them to avoid
        // PDO quoting them as strings (MariaDB requires numeric LIMIT/OFFSET).
        $users = $db->select(
            "SELECT id, full_name, email, phone, role, status,
                    trashed_at, trash_expires_at, trash_reason
             FROM profiles WHERE {$where}
             ORDER BY trashed_at DESC LIMIT {$limit} OFFSET {$offset}",
            $params
        );

        $total = (int) Database::instance()->value(
            "SELECT COUNT(*) FROM profiles WHERE status = 'trashed'", [], 0
        );

        return ['users' => $users ?? [], 'total' => $total];
    }

    /**
     * GET /analytics/trash-stats — trash statistics.
     */
    public function trashStats(Request $request): array
    {
        $db = Database::instance();
        $count = (int) $db->value("SELECT COUNT(*) FROM profiles WHERE status = 'trashed'", [], 0);
        $oldest = $db->value("SELECT MIN(trashed_at) FROM profiles WHERE status = 'trashed'", [], null);
        $config = $db->row('SELECT retention_days FROM trash_config LIMIT 1');

        return [
            'trashed_count' => $count,
            'oldest_trash' => $oldest,
            'retention_days' => (int) ($config['retention_days'] ?? 30),
        ];
    }

    /**
     * GET /analytics/deletion-stats — platform-wide deletion statistics.
     */
    public function deletionStats(Request $request): array
    {
        $db = Database::instance();
        return [
            'trashed_users' => (int) $db->value("SELECT COUNT(*) FROM profiles WHERE status = 'trashed'", [], 0),
            'deleted_users' => (int) $db->value("SELECT COUNT(*) FROM profiles WHERE status = 'deleted'", [], 0),
            'blocked_users' => (int) $db->value("SELECT COUNT(*) FROM profiles WHERE status = 'blocked'", [], 0),
            'total_courses' => (int) $db->value("SELECT COUNT(*) FROM courses WHERE permanently_deleted = 1", [], 0),
            'total_devices' => (int) $db->value("SELECT COUNT(*) FROM devices", [], 0),
        ];
    }

    /**
     * GET /analytics/archive-analytics — archived course stats.
     */
    public function archiveAnalytics(Request $request): array
    {
        $db = Database::instance();
        $archived = (int) $db->value("SELECT COUNT(*) FROM courses WHERE status = 'archived'", [], 0);
        $totalStudents = (int) $db->value(
            "SELECT COUNT(DISTINCT e.student_id) FROM enrollments e
             JOIN courses c ON c.id = e.course_id WHERE c.status = 'archived'", [], 0
        );

        return [
            'archived_courses' => $archived,
            'affected_students' => $totalStudents,
        ];
    }

    /**
     * GET /analytics/archived-courses — list archived courses.
     */
    public function archivedCourses(Request $request): array
    {
        $courses = Database::instance()->select(
            "SELECT c.id, c.title, c.archived_at, c.archived_by, p.full_name AS doctor_name
             FROM courses c LEFT JOIN profiles p ON p.id = c.doctor_id
             WHERE c.status = 'archived' ORDER BY c.archived_at DESC"
        );
        return ['courses' => $courses ?? []];
    }

    /**
     * GET /analytics/course-delete-stats/{id} — deletion dependency stats.
     * Mirrors the original PG function get_course_delete_stats so the Doctor
     * delete-confirmation dialog receives the same contract.
     *
     * Authorization: admins/super_admins may view any course; a doctor may
     * only view their own course's stats (the course is still a draft here,
     * so only the owner can reach the delete flow).
     */
    public function courseDeleteStats(Request $request): array
    {
        $courseId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $db = Database::instance();
        $role = $request->user['role'] ?? '';

        if (!in_array($role, ['admin', 'super_admin'], true)) {
            $owner = $db->value('SELECT doctor_id FROM courses WHERE id = ?', [$courseId]);
            if ($owner !== ($request->user['id'] ?? null)) {
                throw new ApiException(403, 'Not authorized for this course');
            }
        }

        $course = $db->row(
            'SELECT id, title, doctor_id, created_at, updated_at FROM courses WHERE id = ?',
            [$courseId]
        );
        if ($course === null) {
            throw new ApiException(404, 'Course not found');
        }

        $lessonIds = array_column($db->select('SELECT id FROM lessons WHERE course_id = ?', [$courseId]), 'id');

        $doctorName = $db->value('SELECT full_name FROM profiles WHERE id = ?', [$course['doctor_id']], '');

        $sectionCount = (int) $db->value('SELECT COUNT(*) FROM sections WHERE course_id = ?', [$courseId], 0);
        $lessonCount  = (int) $db->value('SELECT COUNT(*) FROM lessons WHERE course_id = ?', [$courseId], 0);
        $enrollCount  = (int) $db->value('SELECT COUNT(*) FROM enrollments WHERE course_id = ?', [$courseId], 0);
        $videoCount   = (int) $db->value('SELECT COUNT(*) FROM video_uploads WHERE course_id = ?', [$courseId], 0);

        $pdfCount = 0;
        $materialCount = 0;
        if ($lessonIds !== []) {
            $placeholders = implode(',', array_fill(0, count($lessonIds), '?'));
            $pdfCount = (int) $db->value(
                "SELECT COUNT(*) FROM lesson_pdfs WHERE lesson_id IN ({$placeholders})",
                $lessonIds, 0
            );
            $materialCount = (int) $db->value(
                "SELECT COUNT(*) FROM lesson_materials WHERE lesson_id IN ({$placeholders})",
                $lessonIds, 0
            );
        }

        return [
            'title'            => $course['title'],
            'doctor_name'      => (string) $doctorName,
            'created_at'       => $course['created_at'],
            'updated_at'       => $course['updated_at'] ?? $course['created_at'],
            'enrolled_count'   => $enrollCount,
            'section_count'    => $sectionCount,
            'lesson_count'     => $lessonCount,
            'video_count'      => $videoCount,
            'pdf_count'        => $pdfCount,
            'attachment_count' => $materialCount,
        ];
    }

    /**
     * GET /analytics/risky-devices — devices flagged by security events.
     *
     * FRONTEND CONTRACT (get_risky_devices RPC → RiskyDevice[]):
     *   { risky_devices: [{ device_id, user_id, user_name, user_email,
     *                       max_risk_score, event_types, last_seen, platform }] }
     *
     * The previous shape — { devices: [{ id, device_name, last_active_at, ... }] }
     * — both wrapped the list in an object AND used different field names than
     * the original Supabase RPC. The dashboard stored the wrapper as the array
     * and crashed with "riskyDevices.map is not a function" (2026-09). Field
     * names follow the original get_risky_devices SQL contract so every client
     * of this RPC sees one canonical shape.
     *
     * Optional params: p_min_score (default 20), p_limit (default 20, cap 50),
     * p_offset. Only events with a device_id are considered; risk classification
     * mirrors the security policy weights (see SecurityService).
     */
    public function riskyDevices(Request $request): array
    {
        $db = Database::instance();
        $q = $request->queryParams();

        $minScore = max(0, (int) ($q['min_score'] ?? 20));
        $limit    = min(50, max(1, (int) ($q['limit'] ?? 20)));
        $offset   = max(0, (int) ($q['offset'] ?? 0));

        // Risk weights per event_type — aligned with the security policy
        // severity tiers (critical/high). Unknown event types contribute 0.
        $weights = [
            'root_detected'                => 100,
            'jailbreak_detected'           => 100,
            'frida_detected'               => 90,
            'xposed_detected'              => 90,
            'magisk_detected'              => 90,
            'app_integrity_compromised'    => 80,
            'signature_invalid'            => 80,
            'tamper_detected'              => 80,
            'ssl_pinning_failure'          => 60,
            'debugger_attached'            => 40,
            'debug_detected'               => 40,
            'developer_options_enabled'    => 30,
            'adb_enabled'                  => 30,
            'overlay_detected'             => 30,
            'vpn_detected'                 => 25,
            'proxy_detected'               => 25,
            'screenshot_detected'          => 20,
            'screen_recording_detected'    => 30,
            'play_integrity_failed'        => 50,
            'app_attest_failed'            => 50,
            'detection_unavailable'        => 10,
        ];

        // Aggregate per device: max risk score + distinct event types.
        $rows = $db->select(
            "SELECT se.device_id, se.event_type, MAX(se.risk_score) AS native_score
               FROM security_events se
              WHERE se.device_id IS NOT NULL
              GROUP BY se.device_id, se.event_type"
        ) ?? [];

        if ($rows === []) {
            return ['risky_devices' => []];
        }

        // Fold events into per-device aggregates in PHP (portable across the
        // MySQL versions this backend targets; the row count is bounded by the
        // number of flagged devices × event types).
        $perDevice = [];
        foreach ($rows as $row) {
            $deviceId = (string) $row['device_id'];
            if (!isset($perDevice[$deviceId])) {
                $perDevice[$deviceId] = ['score' => 0, 'types' => []];
            }
            $etype = (string) $row['event_type'];
            $perDevice[$deviceId]['types'][$etype] = true;
            $weighted = (int) ($weights[$etype] ?? 0);
            $native = (int) ($row['native_score'] ?? 0);
            $score = max($weighted, $native);
            if ($score > $perDevice[$deviceId]['score']) {
                $perDevice[$deviceId]['score'] = $score;
            }
        }

        // Rank, filter by the min score, paginate — all before the profile join
        // so only the devices actually returned hit the database.
        usort($perDevice, static fn (array $a, array $b): int => $b['score'] <=> $a['score']);
        $ranked = array_filter($perDevice, static fn (array $d): bool => $d['score'] >= $minScore);
        $page = array_slice($ranked, $offset, $limit, true);
        if ($page === []) {
            return ['risky_devices' => []];
        }

        $deviceIds = array_keys($page);
        $placeholders = implode(',', array_fill(0, count($deviceIds), '?'));
        $devices = $db->select(
            "SELECT d.id AS device_id, d.user_id, p.full_name AS user_name,
                    p.email AS user_email, d.platform, d.last_active_at AS last_seen
               FROM devices d
               JOIN profiles p ON p.id = d.user_id
              WHERE d.id IN ({$placeholders})",
            $deviceIds
        ) ?? [];

        $out = [];
        foreach ($devices as $dev) {
            $deviceId = (string) $dev['device_id'];
            $agg = $page[$deviceId] ?? null;
            if ($agg === null) continue;
            $dev['max_risk_score'] = $agg['score'];
            $dev['event_types'] = array_keys($agg['types']);
            $out[] = $dev;
        }

        // Preserve the risk ranking after the SQL join.
        usort($out, static fn (array $a, array $b): int => $b['max_risk_score'] <=> $a['max_risk_score']);

        return ['risky_devices' => $out];
    }

    /**
     * GET /analytics/video-asset-usage — VdoCipher storage usage summary.
     */
    /**
     * GET /analytics/video-asset-usage — usage of a library video.
     *
     * Frontend contract (get_video_asset_usage RPC):
     *   ?asset_id=<video_assets.id> → [{ lesson_id, lesson_title, course_id, course_title }]
     *
     * Ownership is enforced server-side: a doctor may only query usage of their
     * OWN library videos; admins may query any. When no asset_id is supplied the
     * legacy admin totals contract is preserved (admins only).
     */
    public function videoAssetUsage(Request $request): array
    {
        $db = Database::instance();
        $assetId = Uuid::normalize((string) ($request->query('asset_id', $request->query('p_asset_id', ''))));
        $role = $request->user['role'] ?? '';
        $isAdmin = in_array($role, ['admin', 'super_admin'], true);

        if ($assetId === '') {
            // Legacy admin totals (no per-asset filter).
            if (!$isAdmin) {
                throw new ApiException(403, 'Not authorized');
            }
            $totalAssets = (int) $db->value('SELECT COUNT(*) FROM video_assets', [], 0);
            $totalSize = (int) $db->value('SELECT COALESCE(SUM(file_size_bytes), 0) FROM video_assets', [], 0);
            $totalDuration = (int) $db->value('SELECT COALESCE(SUM(duration_seconds), 0) FROM video_assets', [], 0);

            return [
                'total_assets' => $totalAssets,
                'total_size_bytes' => $totalSize,
                'total_duration_seconds' => $totalDuration,
            ];
        }

        $asset = $db->row('SELECT id, doctor_id FROM video_assets WHERE id = ?', [$assetId]);
        if ($asset === null) {
            throw new ApiException(404, 'Video asset not found');
        }
        if (!$isAdmin && $asset['doctor_id'] !== $request->user['id']) {
            throw new ApiException(403, 'Not authorized');
        }

        return $db->select(
            'SELECT l.id AS lesson_id, l.title AS lesson_title, c.id AS course_id, c.title AS course_title
               FROM lessons l
               JOIN courses c ON c.id = l.course_id
              WHERE l.video_asset_id = ?
              ORDER BY l.created_at ASC',
            [$assetId]
        ) ?? [];
    }

    /**
     * POST /analytics/db-audit — run database integrity checks.
     */
    public function dbAudit(Request $request): array
    {
        // Read-only diagnostics — gated so a runaway audit can be stopped
        // remotely; it writes nothing, so disabling loses no data.
        (new FeatureFlagService())->assertEnabled('db_audit', $request);

        $db = Database::instance();
        $results = [];

        // Check profiles without users
        $orphanProfiles = (int) $db->value(
            "SELECT COUNT(*) FROM profiles p WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.id)", [], 0
        );
        $results['orphan_profiles'] = $orphanProfiles;

        // Check enrollments without profiles
        $orphanEnrollments = (int) $db->value(
            "SELECT COUNT(*) FROM enrollments e WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = e.student_id)", [], 0
        );
        $results['orphan_enrollments'] = $orphanEnrollments;

        // Check credits without profiles
        $orphanCredits = (int) $db->value(
            "SELECT COUNT(*) FROM credits c WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = c.doctor_id)", [], 0
        );
        $results['orphan_credits'] = $orphanCredits;

        // Check courses without doctors
        $orphanCourses = (int) $db->value(
            "SELECT COUNT(*) FROM courses c WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = c.doctor_id)", [], 0
        );
        $results['orphan_courses'] = $orphanCourses;

        // Check negative credit balances
        $negativeBalances = (int) $db->value(
            "SELECT COUNT(*) FROM credits WHERE remaining < 0", [], 0
        );
        $results['negative_balances'] = $negativeBalances;

        // Table row counts
        $tables = ['profiles', 'users', 'courses', 'enrollments', 'credits', 'devices', 'lessons', 'audit_logs'];
        $rowCounts = [];
        foreach ($tables as $table) {
            $rowCounts[$table] = (int) $db->value("SELECT COUNT(*) FROM {$table}", [], 0);
        }
        $results['row_counts'] = $rowCounts;

        AuditService::write($request->user['id'], 'system_health_check', ['type' => 'db_audit', 'results' => $results]);

        return ['audit' => $results];
    }

    /**
     * POST /analytics/recalculate-earnings/{doctorId} — rebuild doctor earnings.
     */
    public function recalculateEarnings(Request $request): array
    {
        $doctorId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['doctorId']);
        $db = Database::instance();

        // Sum all enrollment-related credit consumption for this doctor's courses
        $totalEarnings = (int) $db->value(
            "SELECT COALESCE(SUM(ct.amount), 0) FROM credit_transactions ct
             JOIN courses c ON c.id = ct.course_id
             WHERE c.doctor_id = ? AND ct.transaction_type = 'consumption'",
            [$doctorId], 0
        );

        $enrollmentCount = (int) $db->value(
            "SELECT COUNT(*) FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE c.doctor_id = ?",
            [$doctorId], 0
        );

        return [
            'doctor_id' => $doctorId,
            'total_earnings' => $totalEarnings,
            'total_enrollments' => $enrollmentCount,
        ];
    }

    /**
     * POST /analytics/reset-doctor-earnings/{doctorId} — admin resets doctor earnings.
     */
    public function resetDoctorEarnings(Request $request): array
    {
        $doctorId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['doctorId']);
        $actorId = $request->user['id'];

        Database::instance()->query(
            'UPDATE credits SET consumed = 0, updated_at = UTC_TIMESTAMP(6) WHERE doctor_id = ?',
            [$doctorId]
        );

        AuditService::write($actorId, 'earnings_reset', [
            'doctor_id' => $doctorId,
            'action' => 'reset_doctor_earnings',
        ]);

        return ['success' => true];
    }

    /**
     * POST /analytics/reset-platform-earnings — super_admin resets platform earnings.
     */
    public function resetPlatformEarnings(Request $request): array
    {
        $actorId = $request->user['id'];
        $note = (string) ($request->json()['note'] ?? 'Platform earnings reset');

        $totalBefore = (int) Database::instance()->value(
            'SELECT COALESCE(SUM(consumed), 0) FROM credits', [], 0
        );

        Database::instance()->insert(
            'INSERT INTO platform_earnings_resets (id, reset_by_id, earnings_before, note, reset_at)
             VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [Uuid::v4(), $actorId, $totalBefore, $note]
        );

        AuditService::write($actorId, 'platform_earnings_reset', [
            'previous_total' => $totalBefore,
            'note' => $note,
        ]);

        return ['success' => true, 'previous_total' => $totalBefore];
    }
}
