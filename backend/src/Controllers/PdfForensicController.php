<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\PdfForensicClient;
use MedAcademy\Services\PdfForensicException;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Logger;
use MedAcademy\Utils\Uuid;

/**
 * PdfForensicController — the PDF Checker API.
 *
 * A staff member uploads a suspect PDF; the VPS service reads the forensic payload from
 * the page images; this controller maps that payload back to an issuance record and,
 * only when the caller is allowed to see it, to the student it was issued to.
 *
 * PERMISSIONS (enforced HERE, never in the UI):
 *   • doctor        — only documents of materials they can access, and only issuances
 *                     belonging to their own courses. A doctor never sees another
 *                     doctor's student.
 *   • admin         — same material-level check; cannot read outside that scope.
 *   • super_admin   — platform-wide.
 *
 * Every inspection is written to audit_logs and pdf_forensic_checks, whatever the outcome.
 * A clean result reports NO identity: the controller never guesses.
 */
final class PdfForensicController
{
    private const MAX_UPLOAD_BYTES = 26214400; // 25 MiB

    public function __construct(
        private readonly ?PdfForensicClient $client = null,
        private readonly StorageService $storage = new StorageService(),
    ) {
    }

    /** POST /pdf-forensic/check  (multipart: file, optional material_id) */
    public function check(Request $request): array
    {
        $userId = (string) $request->user['id'];
        $role = (string) $request->user['role'];
        if (!in_array($role, ['doctor', 'admin', 'super_admin'], true)) {
            throw new ApiException(403, 'Access denied');
        }
        $file = $request->file('file');
        if ($file === null || (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            throw new ApiException(400, 'A PDF file is required.');
        }
        if ((int) ($file['size'] ?? 0) <= 0 || (int) $file['size'] > self::MAX_UPLOAD_BYTES) {
            throw new ApiException(413, 'The file is too large to inspect.');
        }
        $tmp = (string) ($file['tmp_name'] ?? '');
        if ($tmp === '' || !is_uploaded_file($tmp)) {
            throw new ApiException(400, 'The upload could not be read.');
        }
        // The document is NEVER loaded into PHP memory: the magic header is read from the
        // first 5 bytes and the SHA-256 is computed by streaming the temp file. (An 18 MB
        // inspector upload used to cost ~18 MB of heap plus a cURL copy per request.)
        $timingStart = (float) ($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true));
        $magic = (string) @file_get_contents($tmp, false, null, 0, 5);
        if (!str_starts_with($magic, '%PDF-')) {
            throw new ApiException(422, 'The uploaded file is not a PDF.');
        }
        $fileSha256 = (string) hash_file('sha256', $tmp);
        // multipart/form-data does not populate the JSON body, so read the field from
        // $_POST, then the query string. Never from a hidden client-side identity.
        //
        // material_id is OPTIONAL. The detector decodes the OPAQUE payload from the page
        // images and `findIssuance()` maps that payload back through server-side records,
        // so the source material is only ever used for SCOPING — never to decode the mark.
        // Requiring it made the doctor hunt through every course's files before every check.
        // Omitting it keeps the same authorization: the lookup is still restricted to the
        // caller's own courses (doctor) or to materials they can access (admin).
        $materialId = trim((string) ($request->input('material_id') ?? ($_POST['material_id'] ?? $request->query('material_id', ''))));
        $material = null;
        if ($materialId !== '') {
            $material = $this->loadMaterial($materialId);
            // Same authorization routine the delivery path uses. A doctor or admin outside
            // the material's audience gets nothing — not even a verdict.
            if (!$this->storage->canAccess($userId, $role, 'lesson-materials', (string) $material['storage_path'], false)
                || !$this->withinScope($userId, $role, $material)) {
                $this->audit($userId, 'pdf_forensic_check_denied', ['material_id' => $materialId, 'reason' => 'forbidden'], $request);
                throw new ApiException(403, 'Access denied');
            }
        }

        $detectStart = microtime(true);
        $client = $this->client ?? new PdfForensicClient();
        try {
            // Streamed transport: cURL uploads the temp file from disk (see detectFile()).
            // The digest computed above is passed in, so the 18 MB upload is read for
            // its hash ONCE instead of twice.
            $result = $client->detectFile($tmp, $fileSha256);
        } catch (PdfForensicException $e) {
            $this->audit($userId, 'pdf_forensic_check_failed', ['material_id' => $materialId, 'reason' => $e->code()], $request);
            throw new ApiException(503, 'The document could not be inspected.', 'forensic_' . $e->code());
        }
        $detectDone = microtime(true);

        $verdict = (string) ($result['verdict'] ?? 'no_mark');
        $payload = isset($result['payload']) ? (int) $result['payload'] : null;
        $issuance = null;
        if ($payload !== null && in_array($verdict, ['confirmed', 'probable'], true)) {
            $issuance = $this->findIssuance($payload, $userId, $role, $materialId === '' ? null : $materialId);
        }

        Database::instance()->query(
            'INSERT INTO pdf_forensic_checks
                (id, actor_id, actor_role, material_id, scope_course_id, file_sha256, verdict, payload,
                 score, agreement, pages_analyzed, matched_issuance_id, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [
                Uuid::v4(), $userId, $role, $materialId === '' ? null : $materialId,
                (string) ($material['course_id'] ?? $issuance['course_id'] ?? '') ?: null,
                $fileSha256, $verdict, $payload,
                (float) ($result['score'] ?? 0), (float) ($result['agreement'] ?? 0),
                (int) ($result['pages_analyzed'] ?? 0),
                $issuance['id'] ?? null,
                $issuance === null && $payload !== null ? 'payload_unmatched' : null,
            ]
        );
        $this->audit($userId, 'pdf_forensic_check', [
            'material_id' => $materialId === '' ? null : $materialId,
            'resolution' => $materialId === '' ? 'auto' : 'material',
            'verdict' => $verdict,
            'matched' => $issuance !== null,
        ], $request);

        // Stage timings for the upload-latency investigation: how long the request spent
        // receiving the body before this code ran, how long the forensic service took, and
        // the total. No identity, no document bytes, no payload value is logged.
        //
        // The same numbers travel back in the response body as `timings`, so the client can
        // prove which half of the wait was the UPLOAD and which half was the VPS scan
        // instead of inferring it from a progress bar. Staff-only endpoint; no identity.
        $timings = [
            'bytes' => (int) ($file['size'] ?? 0),
            'receive_ms' => (int) round(($detectStart - $timingStart) * 1000),
            'detect_ms' => (int) round(($detectDone - $detectStart) * 1000),
            'forwarded_ms' => (int) round($client->lastRequestSeconds() * 1000),
            'total_ms' => (int) round((microtime(true) - $timingStart) * 1000),
        ];
        Logger::instance()->info('pdf-forensic-timing', $timings + [
            'verdict' => $verdict,
            'auto' => $materialId === '',
        ]);

        $body = [
            'verdict' => $verdict,
            'score' => (float) ($result['score'] ?? 0),
            'agreement' => (float) ($result['agreement'] ?? 0),
            'pages_analyzed' => (int) ($result['pages_analyzed'] ?? 0),
            'pages_total' => (int) ($result['pages_total'] ?? 0),
            'matched' => $issuance !== null,
            'timings' => $timings,
        ];
        if ($issuance !== null) {
            $body['issuance'] = [
                'watermark_record' => (string) $issuance['id'],
                'issued_at' => (string) $issuance['issued_at'],
                'expires_at' => (string) $issuance['expires_at'],
                'course_id' => (string) $issuance['course_id'],
                // The COURSE TITLE is joined server-side from courses.id. The client never
                // supplies it and never sees a raw UUID where a name is meaningful.
                'course_title' => $issuance['course_title'] ?? null,
                'material_id' => (string) $issuance['material_id'],
                'material_name' => $issuance['material_name'] ?? null,
                'student' => [
                    'id' => (string) $issuance['student_id'],
                    'name' => $issuance['full_name'] ?? null,
                    'public_user_id' => $issuance['public_user_id'] ?? null,
                    // Profile photo for the result card; null is normal and the client
                    // renders an initials fallback (never a broken <img>).
                    'avatar_url' => $issuance['avatar_url'] ?? null,
                    // Courses THIS student is enrolled in *inside the caller's scope*.
                    // The client used to count the doctor's own courses instead, which is
                    // a different number entirely (6 rather than the 4 the student is in).
                    'enrolled_courses' => $this->studentCourseCount(
                        (string) $issuance['student_id'], $userId, $role
                    ),
                ],
                'doctor' => $issuance['doctor_id'] === null ? null : [
                    'id' => (string) $issuance['doctor_id'],
                    'name' => $issuance['doctor_name'] ?? null,
                ],
            ];
        } elseif ($verdict === 'confirmed' || $verdict === 'probable') {
            $body['note'] = 'A mark was read but no issuance in your scope matches it.';
        } else {
            $body['note'] = 'No forensic mark was read from this document.';
        }
        return $body;
    }

    /** GET /pdf-forensic/issuances?material_id=… — audit view, scoped by role. */
    public function issuances(Request $request): array
    {
        $userId = (string) $request->user['id'];
        $role = (string) $request->user['role'];
        if (!in_array($role, ['doctor', 'admin', 'super_admin'], true)) {
            throw new ApiException(403, 'Access denied');
        }
        $materialId = trim((string) $request->query('material_id', ''));
        $sql = 'SELECT i.id, i.material_id, i.course_id, i.student_id, i.doctor_id, i.payload,
                       i.issued_at, i.expires_at, i.status, i.purged_at, i.download_count, i.last_download_at
                  FROM pdf_forensic_issuances i';
        $params = [];
        $where = [];
        if ($materialId !== '') {
            $material = $this->loadMaterial($materialId);
            if (!$this->storage->canAccess($userId, $role, 'lesson-materials', (string) $material['storage_path'], false)
                || !$this->withinScope($userId, $role, $material)) {
                throw new ApiException(403, 'Access denied');
            }
            $where[] = 'i.material_id = ?';
            $params[] = $materialId;
        }
        if ($role === 'doctor') {
            // A doctor only ever sees issuances from their own courses.
            $where[] = 'i.doctor_id = ?';
            $params[] = $userId;
        }
        if ($where !== []) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $sql .= ' ORDER BY i.issued_at DESC LIMIT 200';
        return ['issuances' => Database::instance()->select($sql, $params)];
    }

    /**
     * Map a payload to an issuance the caller may see. Returns null when the payload is
     * outside their scope, which is reported as "unmatched" rather than as somebody
     * else's student.
     */
    private function findIssuance(int $payload, string $userId, string $role, ?string $materialId): ?array
    {
        // Course name and material name are joined from the server-side rows the issuance
        // points at, so the client never has to render a raw UUID.
        $sql = 'SELECT i.*, p.full_name, p.public_user_id, p.avatar_url, d.full_name AS doctor_name,
                       c.title AS course_title, m.file_name AS material_name
                  FROM pdf_forensic_issuances i
                  LEFT JOIN profiles p ON p.id = i.student_id
                  LEFT JOIN profiles d ON d.id = i.doctor_id
                  LEFT JOIN courses c ON c.id = i.course_id
                  LEFT JOIN lesson_materials m ON m.id = i.material_id
                 WHERE i.payload = ?';
        $params = [$payload];
        if ($role === 'doctor') {
            $sql .= ' AND i.doctor_id = ?';
            $params[] = $userId;
        }
        $sql .= ' LIMIT 1';
        try {
            $row = Database::instance()->row($sql, $params);
        } catch (\Throwable $e) {
            // Log WHY: a silent null here is indistinguishable from "no match" in the UI,
            // which is how a broken join once read as "issuance not in your scope".
            Logger::instance()->warning('pdf-forensic-lookup-failed', [
                'error' => get_class($e),
                'detail' => substr($e->getMessage(), 0, 200),
            ]);
            return null;
        }
        if ($row === null) {
            return null;
        }
        // A doctor additionally needs access to the material the copy belongs to.
        // `materialId === null` means AUTO resolution: nothing was pre-selected, so the
        // found issuance must pass the same material-level + course-scope checks that a
        // pre-selected material would have been held to. No shortcut for auto mode.
        if ($role !== 'super_admin' && (string) $row['material_id'] !== (string) $materialId) {
            $other = $this->loadMaterial((string) $row['material_id']);
            if (!$this->storage->canAccess($userId, $role, 'lesson-materials', (string) $other['storage_path'], false)
                || !$this->withinScope($userId, $role, $other)) {
                return null;
            }
        }
        return $row;
    }

    /**
     * How many courses this student is enrolled in WITHIN the viewer's authorization.
     *
     * Deliberately not “courses the doctor has”: that is a property of the doctor, not of
     * the identified student. Rules, all applied in SQL — never from client-supplied ids:
     *   • active enrollments only (suspended/removed/left rows do not count);
     *   • COUNT(DISTINCT course_id) so duplicate enrollment rows cannot inflate it;
     *   • archived courses excluded (they are not accessible courses any more);
     *   • doctor → only courses whose courses.doctor_id is the authenticated doctor;
     *   • admin  → the courses their account can reach. This schema has no per-admin
     *              course scope table, so the admin count is the platform count — the
     *              same restriction the rest of the admin surface already operates under;
     *   • super_admin → platform-wide.
     */
    private function studentCourseCount(string $studentId, string $actorId, string $role): int
    {
        $sql = 'SELECT COUNT(DISTINCT e.course_id)
                  FROM enrollments e
                  JOIN courses c ON c.id = e.course_id
                 WHERE e.student_id = ?
                   AND e.status = ?
                   AND c.archived_at IS NULL';
        $params = [$studentId, 'active'];
        if ($role === 'doctor') {
            $sql .= ' AND c.doctor_id = ?';
            $params[] = $actorId;
        }
        try {
            return (int) Database::instance()->value($sql, $params, 0);
        } catch (\Throwable $e) {
            Logger::instance()->warning('pdf-forensic-course-count-failed', [
                'error' => get_class($e),
                'detail' => substr($e->getMessage(), 0, 160),
            ]);
            return 0;
        }
    }

    /**
     * Role scope beyond material-level access.
     *
     * `StorageService::canAccess` deliberately returns true for ALL staff roles, so it alone
     * would let any doctor inspect any material. A doctor is therefore additionally limited to
     * courses they own (courses.doctor_id). Super admins are platform-wide; admins are held to
     * the same material-level rule as today because no assigned-administrative-scope model
     * exists in this schema yet — that is deliberately NOT broadened here.
     */
    private function withinScope(string $userId, string $role, array $material): bool
    {
        if ($role !== 'doctor') {
            return true;
        }
        try {
            $owner = Database::instance()->value(
                'SELECT doctor_id FROM courses WHERE id = ? LIMIT 1',
                [(string) ($material['course_id'] ?? '')],
                ''
            );
        } catch (\Throwable $e) {
            Logger::instance()->warning('pdf-forensic-scope-failed', ['error' => get_class($e)]);
            return false;
        }
        return $owner !== '' && $owner !== null && (string) $owner === $userId;
    }

    private function loadMaterial(string $materialId): array
    {
        $row = Database::instance()->row(
            'SELECT id, course_id, storage_path, file_name FROM lesson_materials WHERE id = ? LIMIT 1',
            [$materialId]
        );
        if ($row === null) {
            throw new ApiException(404, 'Material not found');
        }
        return $row;
    }

    private function audit(string $userId, string $action, array $details, Request $request): void
    {
        try {
            AuditService::write($userId, $action, $details, $request->clientIp());
        } catch (\Throwable $e) {
            Logger::instance()->warning('pdf-forensic-audit-failed', ['error' => get_class($e)]);
        }
    }
}
