<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Utils\Uuid;

/**
 * StudentBulkController — POST /students/bulk-action
 *
 * Backend-authoritative bulk execution of the SAME per-enrollment actions the
 * Students screen offers individually (suspend / resume subscription, remove
 * with earnings event). The client can never widen authorization:
 *
 *   • Doctor  → only enrollments whose course they OWN (courses.doctor_id),
 *               and only rows NOT hidden from doctors
 *               (visibility_level = 'all' or NULL — mirrors the generic
 *               Data API's ownerScope() enrollment visibility policy).
 *   • Admin / Super Admin → platform-wide, exactly like their individual
 *               actions through the Data API / RPC.
 *
 * Every requested id is resolved against a server-side scoped query; ids that
 * are missing or outside the caller's scope are reported per-row as failures —
 * never silently ignored, never executed. Rows are independent: each row's DML
 * is atomic and per-row results are always accurate (a failure on one student
 * never rolls back another, and a partial batch reports exact counts).
 * A summary audit event records the whole operation.
 */
final class StudentBulkController
{
    /** Actions mirror the individual per-card actions (no new capability). */
    private const ACTIONS = ['suspend', 'resume', 'remove'];

    /** Hard ceiling so one request can never DoS the worker. */
    private const MAX_IDS = 200;

    public function handle(Request $request): array
    {
        $actorId = (string) $request->user['id'];
        $actorRole = (string) $request->user['role'];

        // Route middleware already enforces the role set; re-checked here so
        // the controller is safe standalone (defense in depth, mirrors
        // StudentController::handle).
        if (!in_array($actorRole, ['doctor', 'admin', 'super_admin'], true)) {
            throw new ApiException(403, 'Requires doctor, admin, or super_admin role');
        }

        $body = $request->json();
        $action = (string) ($body['action'] ?? '');
        if (!in_array($action, self::ACTIONS, true)) {
            throw new ApiException(422, 'action must be one of: ' . implode(', ', self::ACTIONS));
        }

        $rawIds = $body['enrollment_ids'] ?? null;
        if (!is_array($rawIds) || $rawIds === []) {
            throw new ApiException(422, 'enrollment_ids must be a non-empty array');
        }
        if (count($rawIds) > self::MAX_IDS) {
            throw new ApiException(422, 'Too many enrollment_ids (max ' . self::MAX_IDS . ' per request)');
        }

        // Validate + dedupe every id BEFORE touching the database: garbage
        // identifiers are a client error (422), not a per-row failure.
        $ids = [];
        foreach ($rawIds as $raw) {
            $ids[] = Uuid::normalize((string) $raw);
        }
        $ids = array_values(array_unique(array_filter($ids, static fn ($id) => $id !== '')));
        if ($ids === []) {
            throw new ApiException(422, 'enrollment_ids did not contain any valid identifiers');
        }

        // ── ONE server-side scoped fetch resolves authorization for ALL ids ──
        $db = Database::instance();
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $rows = $db->select(
            "SELECT e.id, e.status, e.visibility_level, e.student_id, c.doctor_id, c.id AS course_id
               FROM enrollments e
               JOIN courses c ON c.id = e.course_id
              WHERE e.id IN ({$placeholders})",
            $ids
        );
        $byId = [];
        foreach ($rows as $row) {
            $byId[(string) $row['id']] = $row;
        }

        $results = [];
        $succeeded = 0;
        $skipped = 0;
        $failed = 0;

        foreach ($ids as $id) {
            $row = $byId[$id] ?? null;

            // Unknown id — reported, never executed.
            if ($row === null) {
                $failed++;
                $results[] = ['id' => $id, 'status' => 'failed', 'reason' => 'not_found'];
                continue;
            }

            // SCOPE ENFORCEMENT (server-side truth, client claims are ignored).
            if ($actorRole === 'doctor') {
                $visibleToDoctor = $row['visibility_level'] === null || $row['visibility_level'] === 'all';
                if ((string) $row['doctor_id'] !== $actorId || !$visibleToDoctor) {
                    $failed++;
                    $results[] = ['id' => $id, 'status' => 'failed', 'reason' => 'not_authorized'];
                    continue;
                }
            }

            $currentStatus = (string) ($row['status'] ?? '');

            try {
                if ($action === 'suspend' || $action === 'resume') {
                    $target = $action === 'suspend' ? 'suspended' : 'active';
                    if ($currentStatus === $target) {
                        $skipped++;
                        $results[] = ['id' => $id, 'status' => 'skipped', 'reason' => "already_{$target}"];
                        continue;
                    }
                    // Single-row UPDATE — atomic on its own; enrollments has no
                    // updated_at column (verified against schema) so none is set.
                    $db->query('UPDATE enrollments SET status = ? WHERE id = ?', [$target, $id]);
                    $succeeded++;
                    $results[] = ['id' => $id, 'status' => 'succeeded'];
                    continue;
                }

                // action === 'remove' — mirrors RpcController::removeStudentAndRecordEarnings:
                // delete the enrollment, record the doctor earnings event, all in
                // one per-row transaction so the row is never half-removed.
                $db->transaction(function (Database $tx) use ($row, $actorId) {
                    $tx->query('DELETE FROM enrollments WHERE id = ?', [(string) $row['id']]);
                    $tx->insert(
                        'INSERT INTO doctor_earnings_events (id, doctor_id, event_type, student_id, course_id, amount, created_at)
                         VALUES (?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(6))',
                        [Uuid::v4(), $actorId, 'student_removed', (string) $row['student_id'], (string) $row['course_id']]
                    );
                });
                $succeeded++;
                $results[] = ['id' => $id, 'status' => 'succeeded'];
            } catch (\Throwable $e) {
                $failed++;
                $results[] = ['id' => $id, 'status' => 'failed', 'reason' => 'operation_failed'];
            }
        }

        // AUDIT — one summary event with exact per-row outcomes (the
        // individual suspend/resume path through the Data API writes no audit
        // today; bulk holds itself to the stricter standard).
        AuditService::write($actorId, 'students_bulk_action', [
            'action' => $action,
            'requested' => count($ids),
            'succeeded' => $succeeded,
            'skipped' => $skipped,
            'failed' => $failed,
            'results' => $results,
        ], $request->clientIp());

        return [
            'success' => true,
            'action' => $action,
            'requested' => count($ids),
            'succeeded' => $succeeded,
            'skipped' => $skipped,
            'failed' => $failed,
            'results' => $results,
        ];
    }
}
