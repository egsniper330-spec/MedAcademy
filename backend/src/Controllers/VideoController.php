<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Http\Response;
use MedAcademy\Services\AuditService;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;
use MedAcademy\Video\VdoCipherService;

/**
 * VideoController — PHP equivalent of VdoCipher Edge Functions.
 *
 * Handles:
 *   - OTP generation (vdocipher-otp)
 *   - Upload initialization (vdocipher-upload-init)
 *   - Upload status polling (vdocipher-upload-status)
 *   - Video deletion (vdocipher-delete-video)
 *   - Webhook reception (vdocipher-otp webhook)
 *   - Chunk upload (video-upload-chunk)
 *   - Upload assembly (video-assemble-upload)
 *   - Video health scan (video-health-scan)
 */
final class VideoController
{
    public function __construct(private readonly VdoCipherService $video = new VdoCipherService())
    {
    }

    public function otp(Request $request): array
    {
        $videoId = (string) ($request->json()['video_id'] ?? '');
        $lessonId = isset($request->json()['lesson_id']) ? (string) $request->json()['lesson_id'] : null;
        if ($videoId === '') {
            throw new ApiException(400, 'video_id is required');
        }
        return $this->video->otp($request->user['id'], $videoId, $lessonId, $request->clientIp());
    }

    public function uploadInit(Request $request): array
    {
        return $this->video->uploadInit($request->user['id'], $request->json());
    }

    public function uploadStatus(Request $request): array
    {
        // Mirrors the original vdocipher-upload-status EF: poll by VdoCipher video id
        $videoId = (string) ($request->json()['video_id'] ?? '');
        if ($videoId === '') {
            throw new ApiException(400, 'video_id is required');
        }
        return $this->video->uploadStatus($videoId);
    }

    public function delete(Request $request): array
    {
        $videoId = (string) ($request->json()['video_id'] ?? '');
        if ($videoId === '') {
            throw new ApiException(400, 'video_id is required');
        }
        $lessonId = (string) ($request->json()['lesson_id'] ?? '');
        $clearLesson = (bool) ($request->json()['clear_lesson'] ?? false);
        return $this->video->deleteVideo($videoId, $lessonId, $clearLesson);
    }

    public function assets(Request $request): array
    {
        $userId = $request->user['id'];
        $isAdmin = in_array($request->user['role'], ['admin', 'super_admin'], true);
        $sql = 'SELECT id, doctor_id, provider_video_id, title, duration_seconds, file_size_bytes,
                       thumbnail_url, status, created_at, updated_at
                  FROM video_assets';
        $params = [];
        if (!$isAdmin) {
            $sql .= ' WHERE doctor_id = ?';
            $params[] = $userId;
        }
        $sql .= ' ORDER BY created_at DESC';
        return ['assets' => Database::instance()->select($sql, $params)];
    }

    /**
     * POST /video/webhook — VdoCipher webhook handler.
     * No auth middleware — signature is verified internally.
     */
    public function webhook(Request $request): void
    {
        $webhookSecret = Config::string('VDOCIPHER_WEBHOOK_SECRET', '');
        if ($webhookSecret === '') {
            Response::json(['error' => 'Webhook not configured'], 501);
            return;
        }

        $signature = $_SERVER['HTTP_X_VDOCIPHER_SIGNATURE'] ?? '';
        $rawBody = file_get_contents('php://input');

        if ($signature === '' || !$this->verifyHmac($rawBody, $signature, $webhookSecret)) {
            Response::json(['error' => 'Invalid signature'], 401);
            return;
        }

        $event = json_decode($rawBody, true);
        if (!is_array($event)) {
            Response::json(['error' => 'Invalid JSON body'], 400);
            return;
        }

        $eventType = $event['event'] ?? 'unknown';

        match ($eventType) {
            'VIDEO_ENCODED', 'VIDEO_READY' => $this->handleVideoReady($event),
            'UPLOAD_COMPLETE' => $this->handleUploadComplete($event),
            default => null,
        };

        Response::json(['received' => true, 'event' => $eventType]);
    }

    /**
     * POST /video/chunk — upload a single video chunk.
     *
     * Headers:
     *   x-upload-id — upload session UUID
     *   x-chunk-index — chunk number (0-based)
     *   x-total-chunks — total chunk count
     *   x-chunk-size — chunk size in bytes
     *   x-file-name — original file name
     *   x-mime-type — MIME type
     *
     * Body: raw binary chunk data
     */
    public function uploadChunk(Request $request): void
    {
        $uploadId = $_SERVER['HTTP_X_UPLOAD_ID'] ?? '';
        $chunkIndex = (int) ($_SERVER['HTTP_X_CHUNK_INDEX'] ?? -1);
        $totalChunks = (int) ($_SERVER['HTTP_X_TOTAL_CHUNKS'] ?? 0);
        $chunkSize = (int) ($_SERVER['HTTP_X_CHUNK_SIZE'] ?? 0);
        $fileName = $_SERVER['HTTP_X_FILE_NAME'] ?? 'unknown';
        $mimeType = $_SERVER['HTTP_X_MIME_TYPE'] ?? 'video/mp4';

        if ($uploadId === '') {
            Response::json(['error' => 'x-upload-id header is required'], 400);
            return;
        }

        $db = Database::instance();
        $session = $db->row(
            "SELECT us.*, vu.id AS video_upload_id, vu.doctor_id, vu.lesson_id, vu.course_id
             FROM upload_sessions us
             JOIN video_uploads vu ON vu.id = us.upload_id
             WHERE us.id = ? AND us.status = 'uploading'",
            [$uploadId]
        );

        if ($session === null) {
            Response::json(['error' => 'Upload session not found or not active'], 404);
            return;
        }

        // Verify ownership
        if ($session['doctor_id'] !== $request->user['id']) {
            Response::json(['error' => 'Not authorized'], 403);
            return;
        }

        $chunkData = file_get_contents('php://input');
        if ($chunkData === false || strlen($chunkData) === 0) {
            Response::json(['error' => 'No chunk data received'], 400);
            return;
        }

        // Store chunk to temp directory
        $chunkDir = sys_get_temp_dir() . '/medacademy_chunks/' . $uploadId;
        if (!is_dir($chunkDir)) {
            mkdir($chunkDir, 0755, true);
        }
        $chunkPath = $chunkDir . "/chunk_{$chunkIndex}";
        file_put_contents($chunkPath, $chunkData);

        // Update progress
        $chunksCompleted = (int) $db->value(
            'SELECT COUNT(*) FROM upload_sessions WHERE id = ?', [$uploadId], 0
        );

        $db->query(
            'UPDATE upload_sessions SET
                upload_offset = upload_offset + ?,
                updated_at = UTC_TIMESTAMP(6),
                last_heartbeat = UTC_TIMESTAMP(6)
              WHERE id = ?',
            [strlen($chunkData), $uploadId]
        );

        $db->query(
            'UPDATE video_uploads SET
                chunks_completed = chunks_completed + 1,
                bytes_uploaded = bytes_uploaded + ?,
                updated_at = UTC_TIMESTAMP(6)
              WHERE id = ?',
            [strlen($chunkData), $session['video_upload_id']]
        );

        // Log chunk received
        $db->insert(
            'INSERT INTO upload_audit_logs (id, upload_id, actor_id, event, details, created_at)
             VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [
                Uuid::v4(), $session['video_upload_id'], $request->user['id'],
                'chunk_received',
                json_encode(['chunk_index' => $chunkIndex, 'size' => strlen($chunkData)], JSON_UNESCAPED_SLASHES),
            ]
        );

        Response::json([
            'success' => true,
            'chunk_index' => $chunkIndex,
            'bytes_received' => strlen($chunkData),
        ]);
    }

    /**
     * POST /video/assemble — assemble uploaded chunks and transfer to VdoCipher.
     */
    public function assembleUpload(Request $request): array
    {
        $body = $request->json();
        $uploadId = (string) ($body['upload_id'] ?? '');

        if ($uploadId === '') {
            throw new ApiException(400, 'upload_id is required');
        }

        $db = Database::instance();
        $session = $db->row(
            "SELECT us.*, vu.id AS video_upload_id, vu.doctor_id, vu.lesson_id, vu.course_id,
                    vu.file_name, vu.file_size, vu.mime_type, vu.status AS upload_status,
                    vu.provider_video_id AS vu_provider_video_id
             FROM upload_sessions us
             JOIN video_uploads vu ON vu.id = us.upload_id
             WHERE us.id = ?",
            [$uploadId]
        );

        if ($session === null) {
            throw new ApiException(404, 'Upload session not found');
        }

        if ($session['doctor_id'] !== $request->user['id']) {
            throw new ApiException(403, 'Not authorized');
        }

        // ── Idempotent return: already processing/ready with a provider video id ──
        $existingVdoId = $session['vu_provider_video_id'] ?? $session['provider_video_id'] ?? null;
        $currentStatus = (string) ($session['upload_status'] ?? '');
        if ($existingVdoId !== null && $existingVdoId !== ''
            && in_array($currentStatus, ['processing', 'encoding', 'ready', 'generating_streams'], true)) {
            return [
                'status' => $currentStatus === 'ready' ? 'ready' : 'processing',
                'video_id' => $existingVdoId,
                'skipped_upload' => true,
            ];
        }

        $videoUploadId = $session['video_upload_id'];
        $lessonId = $session['lesson_id'] ?? null;

        $db->insert(
            'INSERT INTO upload_audit_logs (id, upload_id, actor_id, event, details, created_at)
             VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [
                Uuid::v4(), $videoUploadId, $request->user['id'],
                'assembly_started',
                json_encode(['total_chunks' => (int) ($body['total_chunks'] ?? 0)], JSON_UNESCAPED_SLASHES),
            ]
        );

        // Mark assembly started
        $db->query(
            "UPDATE video_uploads SET
                status = 'uploading',
                assembly_started_at = UTC_TIMESTAMP(6),
                assembly_triggered = 1,
                updated_at = UTC_TIMESTAMP(6)
              WHERE id = ?",
            [$videoUploadId]
        );

        // ── Step 1: reassemble chunks from the local temp dir ─────────────────
        $chunkDir = sys_get_temp_dir() . '/medacademy_chunks/' . $uploadId;
        $totalChunks = max(1, (int) ($body['total_chunks'] ?? 0));
        if ($totalChunks <= 0) {
            // Fall back to counting on-disk chunks
            $totalChunks = 0;
            if (is_dir($chunkDir)) {
                foreach (glob($chunkDir . '/chunk_*') ?: [] as $p) {
                    $totalChunks++;
                }
            }
            $totalChunks = max(1, $totalChunks);
        }

        $fullPath = tempnam(sys_get_temp_dir(), 'vdoasm_');
        $fh = fopen($fullPath, 'wb');
        $chunksStreamed = 0;
        for ($i = 0; $i < $totalChunks; $i++) {
            $chunkPath = $chunkDir . "/chunk_{$i}";
            if (!is_file($chunkPath)) {
                fclose($fh);
                @unlink($fullPath);
                $errMsg = 'Missing chunk ' . $i . ' of ' . $totalChunks;
                $db->query(
                    "UPDATE video_uploads SET status = 'failed', assembly_error = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
                    [$errMsg, $videoUploadId]
                );
                $db->query("UPDATE lessons SET video_status = 'failed' WHERE id = ?", [$lessonId]);
                throw new ApiException(502, $errMsg);
            }
            $chunkData = file_get_contents($chunkPath);
            if ($chunkData === false) {
                fclose($fh);
                @unlink($fullPath);
                throw new ApiException(502, 'Failed to read chunk ' . $i);
            }
            fwrite($fh, $chunkData);
            $chunksStreamed++;
        }
        fclose($fh);

        // ── Step 2: create the VdoCipher video entry (title from file name) ───
        $fileName = (string) ($body['file_name'] ?? $session['file_name'] ?? 'Untitled');
        $mimeType = (string) ($body['mime_type'] ?? $session['mime_type'] ?? 'video/mp4');
        $title = preg_replace('/\.[^.]+$/', '', $fileName);
        $title = trim((string) preg_replace('/[_-]+/', ' ', $title));
        $title = mb_substr($title, 0, 200);
        if ($title === '') {
            $title = 'Untitled';
        }

        try {
            $created = $this->video->createVideo($title);
        } catch (ApiException $e) {
            @unlink($fullPath);
            $db->query(
                "UPDATE video_uploads SET status = 'failed', assembly_error = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
                [$e->getMessage(), $videoUploadId]
            );
            $db->query("UPDATE lessons SET video_status = 'failed' WHERE id = ?", [$lessonId]);
            throw $e;
        }
        $vdoVideoId = $created['videoId'];
        $clientPayload = is_array($created['clientPayload']) ? $created['clientPayload'] : [];

        // Persist the provider id immediately for deduplication
        $db->query(
            "UPDATE video_uploads SET provider_video_id = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
            [$vdoVideoId, $videoUploadId]
        );
        $db->query(
            "UPDATE lessons SET video_id = ?, video_status = 'uploading' WHERE id = ?",
            [$vdoVideoId, $lessonId]
        );

        // ── Step 3: POST the assembled file to VdoCipher's S3 endpoint ────────
        $s3Status = $this->video->uploadToS3($clientPayload, $fullPath, basename($fileName), $mimeType);
        @unlink($fullPath);

        if ($s3Status !== 201) {
            $errMsg = 'S3 upload rejected — HTTP ' . $s3Status;
            $db->query(
                "UPDATE video_uploads SET status = 'failed', assembly_error = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
                [$errMsg, $videoUploadId]
            );
            $db->query("UPDATE lessons SET video_status = 'failed' WHERE id = ?", [$lessonId]);
            $db->insert(
                'INSERT INTO upload_audit_logs (id, upload_id, actor_id, event, details, created_at)
                 VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [
                    Uuid::v4(), $videoUploadId, $request->user['id'],
                    'assembly_failed',
                    json_encode(['error' => $errMsg, 's3Status' => $s3Status], JSON_UNESCAPED_SLASHES),
                ]
            );
            throw new ApiException(502, $errMsg);
        }

        // ── Step 4: mark processing + clean up chunks (best-effort) ──────────
        $db->query(
            "UPDATE video_uploads SET
                status = 'processing',
                upload_completed_at = UTC_TIMESTAMP(6),
                processing_started_at = UTC_TIMESTAMP(6),
                updated_at = UTC_TIMESTAMP(6)
              WHERE id = ?",
            [$videoUploadId]
        );
        $db->query(
            "UPDATE lessons SET video_id = ?, video_status = 'processing' WHERE id = ?",
            [$vdoVideoId, $lessonId]
        );
        $db->query(
            "UPDATE upload_sessions SET status = 'assembling', provider_video_id = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
            [$vdoVideoId, $uploadId]
        );
        $db->insert(
            'INSERT INTO upload_audit_logs (id, upload_id, actor_id, event, details, created_at)
             VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [
                Uuid::v4(), $videoUploadId, $request->user['id'],
                'assembly_completed',
                json_encode(['video_id' => $vdoVideoId, 'total_chunks' => $totalChunks, 'chunks_streamed' => $chunksStreamed], JSON_UNESCAPED_SLASHES),
            ]
        );

        if (is_dir($chunkDir)) {
            foreach (glob($chunkDir . '/chunk_*') ?: [] as $p) {
                @unlink($p);
            }
            @rmdir($chunkDir);
        }

        AuditService::write($request->user['id'], 'video_uploaded', [
            'upload_id' => $uploadId,
            'video_upload_id' => $videoUploadId,
            'video_id' => $vdoVideoId,
        ]);

        return ['status' => 'processing', 'video_id' => $vdoVideoId, 'chunks_assembled' => $chunksStreamed];
    }

    /**
     * POST /video/health-scan — on-demand video health scan.
     */
    public function healthScan(Request $request): array
    {
        $body = $request->json();
        $uploadId = isset($body['upload_id']) ? (string) $body['upload_id'] : null;
        $actorId = $request->user['id'];

        $db = Database::instance();
        $apiSecret = Config::string('VDOCIPHER_API_SECRET', '');

        // Fetch uploads to scan
        if ($uploadId !== null) {
            $uploads = $db->select(
                "SELECT id, provider_video_id, thumbnail_url, status FROM video_uploads WHERE id = ?",
                [$uploadId]
            );
        } else {
            $uploads = $db->select(
                "SELECT id, provider_video_id, thumbnail_url, status
                 FROM video_uploads WHERE status IN ('ready', 'failed') LIMIT 100"
            );
        }

        $scanId = Uuid::v4();
        $db->insert(
            'INSERT INTO video_health_scans (id, scan_type, triggered_by, started_at, overall_status, created_at)
             VALUES (?, ?, ?, UTC_TIMESTAMP(6), ?, UTC_TIMESTAMP(6))',
            [$scanId, 'manual', $actorId, 'running']
        );

        $passed = 0;
        $failed = 0;

        foreach ($uploads as $upload) {
            $errors = [];

            if (!empty($upload['provider_video_id']) && $apiSecret !== '') {
                $ch = curl_init("https://dev.vdocipher.com/api/videos/{$upload['provider_video_id']}");
                curl_setopt_array($ch, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_HTTPHEADER => ["Authorization: Apisecret {$apiSecret}"],
                    CURLOPT_TIMEOUT => 10,
                ]);
                $response = curl_exec($ch);
                $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);

                if ($httpCode !== 200) {
                    $errors[] = "Metadata fetch failed (HTTP {$httpCode})";
                }
            }

            if (empty($upload['thumbnail_url'])) {
                $errors[] = 'Thumbnail missing';
            }

            $status = empty($errors) ? 'passed' : 'failed';
            $healthScore = max(0, 100 - count($errors) * 20);

            $db->query(
                'UPDATE video_uploads SET health_score = ?, verification_status = ?, verification_error = ?,
                    last_health_check_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
                 WHERE id = ?',
                [$healthScore, $status, !empty($errors) ? implode(' ', $errors) : null, $upload['id']]
            );

            if (empty($errors)) {
                $passed++;
            } else {
                $failed++;

                // Create alert if not already present
                $existingAlerts = $db->value(
                    'SELECT COUNT(*) FROM video_health_alerts WHERE upload_id = ? AND resolved = 0',
                    [$upload['id']], 0
                );
                if ($existingAlerts === 0) {
                    $db->insert(
                        'INSERT INTO video_health_alerts (id, upload_id, alert_type, severity, title, message, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                        [
                            Uuid::v4(), $upload['id'], 'health_scan_failed',
                            count($errors) >= 2 ? 'critical' : 'warning',
                            'Health Scan Failed', implode(' ', $errors),
                        ]
                    );
                }
            }
        }

        $total = count($uploads);
        $healthPct = $total > 0 ? round(($passed / $total) * 100, 2) : 100;

        // Update scan record
        $db->query(
            "UPDATE video_health_scans SET
                overall_status = ?, health_score = ?, completed_at = UTC_TIMESTAMP(6),
                duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, UTC_TIMESTAMP(6)) / 1000
              WHERE id = ?",
            [$failed > 0 ? 'partial_pass' : 'passed', $healthPct, $scanId]
        );

        return [
            'scan_id' => $scanId,
            'scanned' => $total,
            'passed' => $passed,
            'failed' => $failed,
            'health_pct' => $healthPct,
        ];
    }

    private function handleVideoReady(array $event): void
    {
        $videoId = $event['video_id'] ?? null;
        if ($videoId === null) {
            return;
        }

        $db = Database::instance();
        $db->query(
            "UPDATE video_uploads SET status = 'ready', updated_at = UTC_TIMESTAMP(6)
              WHERE provider_video_id = ?",
            [$videoId]
        );
        $db->query(
            "UPDATE video_assets SET status = 'ready', updated_at = UTC_TIMESTAMP(6)
              WHERE provider_video_id = ?",
            [$videoId]
        );
        $db->query(
            "UPDATE lessons SET video_status = 'ready', updated_at = UTC_TIMESTAMP(6)
              WHERE video_id = ?",
            [$videoId]
        );
    }

    private function handleUploadComplete(array $event): void
    {
        $videoId = $event['video_id'] ?? null;
        if ($videoId !== null) {
            $this->handleVideoReady($event);
        }
    }

    private function verifyHmac(string $data, string $expectedSignature, string $secret): bool
    {
        $expectedHash = hash_hmac('sha256', $data, $secret);
        return hash_equals($expectedHash, $expectedSignature);
    }

    // ================================================================
    // MISSING EDGE FUNCTION EQUIVALENTS
    // ================================================================

    /**
     * POST /video/upload-patch — receive OTA patch ZIP, store, return signed URL.
     * Mirrors supabase/functions/upload-patch/index.ts
     */
    public function uploadPatch(Request $request): never
    {
        $file = $request->file('file');
        if ($file === null || ($file['error'] ?? 1) !== UPLOAD_ERR_OK) {
            Response::error('file is required', 422);
        }

        $fileName = $file['name'] ?? 'patch.zip';
        $dest = date('Y/m/d') . '/' . Uuid::v4() . '.zip';

        $storage = new \MedAcademy\Storage\StorageService();
        $storage->putFile('patch-uploads', $dest, (string) $file['tmp_name'], false);

        $signedUrl = $storage->signedUrl('patch-uploads', $dest, 86400);

        AuditService::write(
            $request->user['id'] ?? 'system',
            'patch_uploaded',
            ['path' => $dest, 'file_name' => $fileName]
        );

        Response::json(['url' => $signedUrl, 'path' => $dest]);
    }

    /**
     * POST /video/orphan-cleanup — delete VdoCipher videos not linked to any lesson.
     * Mirrors supabase/functions/vdocipher-orphan-cleanup/index.ts
     */
    public function orphanCleanup(Request $request): array
    {
        $db = Database::instance();
        $orphanVideos = $db->select(
            "SELECT va.id, va.provider_video_id
               FROM video_assets va
              WHERE va.provider_video_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.video_id = va.provider_video_id)"
        );

        $deleted = 0;
        $failed = 0;
        $apiSecret = Config::string('VDOCIPHER_API_SECRET', '');

        foreach ($orphanVideos as $video) {
            if ($apiSecret === '') {
                $failed++;
                continue;
            }
            try {
                $ch = curl_init('https://dev.vdocipher.com/api/videos/' . rawurlencode($video['provider_video_id']));
                curl_setopt_array($ch, [
                    CURLOPT_DELETE => true,
                    CURLOPT_HTTPHEADER => ['Authorization: Apisecret ' . $apiSecret, 'Accept: application/json'],
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 15,
                ]);
                $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);
                if ($status === 200 || $status === 404) {
                    $db->query('DELETE FROM video_assets WHERE id = ?', [$video['id']]);
                    $deleted++;
                } else {
                    $failed++;
                }
            } catch (\Throwable) {
                $failed++;
            }
        }

        AuditService::write($request->user['id'], 'orphan_video_cleanup', [
            'total_orphans' => count($orphanVideos),
            'deleted' => $deleted,
            'failed' => $failed,
        ]);

        return ['deleted' => $deleted, 'failed' => $failed, 'total' => count($orphanVideos)];
    }
}
