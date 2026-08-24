<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
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
     */
    public function securityStats(Request $request): array
    {
        $db = Database::instance();

        $totalEvents = (int) $db->value('SELECT COUNT(*) FROM security_events', [], 0);
        $recentEvents = (int) $db->value(
            "SELECT COUNT(*) FROM security_events WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 24 HOUR)",
            [], 0
        );

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
            'total_events' => $totalEvents,
            'recent_events_24h' => $recentEvents,
            'by_type' => $byType ?? [],
            'by_platform' => $byPlatform ?? [],
            'policies' => $policies ?? [],
        ];
    }

    /**
     * GET /analytics/user-activity/{id} — user recent activity summary.
     */
    public function userActivity(Request $request): array
    {
        $userId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $db = Database::instance();

        $recentAudit = $db->select(
            "SELECT id, action, details, created_at FROM audit_logs
             WHERE user_id = ? OR actor_id = ?
             ORDER BY created_at DESC LIMIT 20",
            [$userId, $userId]
        );

        $recentSecurity = $db->select(
            "SELECT id, event_type, platform, created_at FROM security_events
             WHERE user_id = ?
             ORDER BY created_at DESC LIMIT 20",
            [$userId]
        );

        $devices = $db->select(
            "SELECT id, device_name, platform, status, last_active_at FROM devices
             WHERE user_id = ? ORDER BY last_active_at DESC LIMIT 10",
            [$userId]
        );

        return [
            'recent_audit' => $recentAudit ?? [],
            'recent_security' => $recentSecurity ?? [],
            'devices' => $devices ?? [],
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

        $users = Database::instance()->select(
            "SELECT id, full_name, email, phone, role, status, pre_trash_status,
                    trashed_at, trash_expires_at, trash_reason
             FROM profiles WHERE status = 'trashed'
             ORDER BY trashed_at DESC LIMIT ? OFFSET ?",
            [$limit, $offset]
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
            'total_courses' => (int) $db->value("SELECT COUNT(*) FROM courses WHERE is_deleted = 1", [], 0),
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
     */
    public function courseDeleteStats(Request $request): array
    {
        $courseId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $db = Database::instance();

        $lessons = (int) $db->value('SELECT COUNT(*) FROM lessons WHERE course_id = ?', [$courseId], 0);
        $enrollments = (int) $db->value('SELECT COUNT(*) FROM enrollments WHERE course_id = ?', [$courseId], 0);
        $videos = (int) $db->value('SELECT COUNT(*) FROM video_uploads WHERE course_id = ?', [$courseId], 0);
        $materials = (int) $db->value(
            "SELECT COUNT(*) FROM lesson_materials WHERE lesson_id IN (SELECT id FROM lessons WHERE course_id = ?)",
            [$courseId], 0
        );

        return [
            'course_id' => $courseId,
            'lessons' => $lessons,
            'enrollments' => $enrollments,
            'videos' => $videos,
            'materials' => $materials,
        ];
    }

    /**
     * GET /analytics/risky-devices — devices flagged by security events.
     */
    public function riskyDevices(Request $request): array
    {
        $devices = Database::instance()->select(
            "SELECT d.id, d.user_id, d.device_name, d.platform, d.status, d.last_active_at,
                    p.full_name AS user_name
             FROM devices d
             JOIN profiles p ON p.id = d.user_id
             WHERE d.id IN (
                 SELECT DISTINCT se.device_id FROM security_events se
                 WHERE se.event_type IN ('root_detected', 'jailbreak_detected', 'frida_detected', 'xposed_detected', 'magisk_detected')
                   AND se.device_id IS NOT NULL
             )
             ORDER BY d.last_active_at DESC LIMIT 50"
        );
        return ['devices' => $devices ?? []];
    }

    /**
     * GET /analytics/video-asset-usage — VdoCipher storage usage summary.
     */
    public function videoAssetUsage(Request $request): array
    {
        $db = Database::instance();
        $totalAssets = (int) $db->value('SELECT COUNT(*) FROM video_assets', [], 0);
        $totalSize = (int) $db->value('SELECT COALESCE(SUM(file_size_bytes), 0) FROM video_assets', [], 0);
        $totalDuration = (int) $db->value('SELECT COALESCE(SUM(duration_seconds), 0) FROM video_assets', [], 0);

        return [
            'total_assets' => $totalAssets,
            'total_size_bytes' => $totalSize,
            'total_duration_seconds' => $totalDuration,
        ];
    }

    /**
     * POST /analytics/db-audit — run database integrity checks.
     */
    public function dbAudit(Request $request): array
    {
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
