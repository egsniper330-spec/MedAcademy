<?php

declare(strict_types=1);

namespace MedAcademy\Video;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Config;

/**
 * VdoCipher server-side integration. The API secret lives only in the PHP
 * environment — it is never exposed to the mobile app.
 *
 * Port of supabase/functions/vdocipher-otp (dynamic rtext watermark for
 * students only; privileged roles get no server-side annotation), plus
 * upload-init / upload-status / delete from the matching Edge Functions.
 */
final class VdoCipherService
{
    private string $apiBase;
    private string $apiSecret;

    public function __construct()
    {
        $this->apiBase = rtrim(Config::string('VDOCIPHER_API_BASE', 'https://dev.vdocipher.com/api'), '/');
        $this->apiSecret = Config::string('VDOCIPHER_API_SECRET');
    }

    private function isConfigured(): bool
    {
        return $this->apiSecret !== '' && $this->apiSecret !== 'CHANGE_ME';
    }

    /**
     * Build the annotate watermark (JSON-stringified string — required by the
     * VdoCipher API; numeric fields as strings; color 0xRRGGBB).
     */
    public function buildAnnotate(string $fullName, string $watermarkId): string
    {
        $idLine = trim($watermarkId) !== '' ? 'ID: ' . trim($watermarkId) : '';
        $lines = array_filter([trim($fullName), $idLine]);
        $text = implode("\n", $lines);
        $annotations = [[
            'type' => 'rtext',
            'text' => $text,
            'color' => '0xFFFFFF',
            'alpha' => '0.45',
            'size' => '18',
            'interval' => '25000',
            'skip' => '2000',
        ]];
        return json_encode($annotations, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /**
     * Generate a playback OTP for a lesson video.
     *
     * Access rules (ported from vdocipher-otp):
     *   - lesson must exist with matching video_id
     *   - students: lesson.status = 'published' AND enrolled in the course
     *   - doctor/admin/super_admin: may preview drafts, no enrollment needed
     */
    public function otp(string $userId, string $videoId, ?string $lessonId, ?string $ipAddress = null): array
    {
        if (!$this->isConfigured()) {
            throw new ApiException(500, 'Video service not configured');
        }

        $db = Database::instance();
        $profile = $db->row(
            'SELECT role, full_name, watermark_id FROM profiles WHERE id = ?',
            [$userId]
        );
        if ($profile === null) {
            throw new ApiException(401, 'Account not found');
        }
        $role = $profile['role'];
        $isPrivileged = in_array($role, ['doctor', 'admin', 'super_admin'], true);

        $lesson = null;
        if ($lessonId !== null && $lessonId !== '') {
            $lesson = $db->row(
                'SELECT course_id, video_id, status FROM lessons WHERE id = ? AND video_id = ?',
                [$lessonId, $videoId]
            );
            if ($lesson === null) {
                throw new ApiException($isPrivileged ? 404 : 403, $isPrivileged ? 'Lesson not found' : 'This lesson is not available');
            }
            if (!$isPrivileged && $lesson['status'] !== 'published') {
                throw new ApiException(403, 'This lesson is not available');
            }
            if (!$isPrivileged) {
                $enrolled = $db->value(
                    'SELECT COUNT(*) FROM enrollments WHERE student_id = ? AND course_id = ?',
                    [$userId, $lesson['course_id']],
                    0
                );
                if (!$enrolled) {
                    throw new ApiException(403, 'Not enrolled in this course');
                }
            }
        }

        $payload = [];
        $appDomain = Config::string('APP_URL');
        if ($appDomain !== '') {
            $payload['whitelisthref'] = $appDomain;
        }

        // Dynamic watermark for students only
        if (!$isPrivileged && $profile) {
            $name = trim((string) $profile['full_name']);
            $wmId = trim((string) $profile['watermark_id']);
            if ($name !== '' && $wmId !== '') {
                $payload['annotate'] = $this->buildAnnotate($name, $wmId);
            }
        }

        $res = $this->request('POST', '/videos/' . rawurlencode($videoId) . '/otp', $payload);
        $status = (int) $res['status'];
        $body = $res['body'];

        if ($status >= 400) {
            $errDetail = '';
            $decoded = json_decode($body, true);
            if (is_array($decoded)) {
                $errDetail = $decoded['message'] ?? $decoded['error'] ?? json_encode($decoded);
            }
            throw new ApiException(502, 'Failed to generate playback token (upstream ' . $status . ')' . ($errDetail ? ': ' . $errDetail : ''));
        }
        $data = json_decode($body, true);
        if (!is_array($data)) {
            throw new ApiException(502, 'Invalid response from video service');
        }

        \MedAcademy\Services\AuditService::write($userId, 'security_event', [
            'event' => 'video_play',
            'video_id' => $videoId,
            'lesson_id' => $lessonId,
        ], $ipAddress);

        return ['otp' => $data['otp'] ?? null, 'playbackInfo' => $data['playbackInfo'] ?? null];
    }

    public function uploadInit(string $userId, array $data): array
    {
        if (!$this->isConfigured()) {
            throw new ApiException(500, 'Video service not configured');
        }
        // ── Match the original Edge Function exactly ──────────────────────────
        // VdoCipher API: PUT /videos?title=<encoded>
        // Returns { videoId, clientPayload } where clientPayload may be a
        // plain object OR a JSON-encoded string depending on API version.
        // The title goes in the query parameter, NOT in a JSON body.
        $title = mb_substr((string) ($data['title'] ?? 'Untitled'), 0, 200);
        $encodedTitle = rawurlencode($title);

        $ch = curl_init($this->apiBase . '/videos?title=' . $encodedTitle);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_CUSTOMREQUEST => 'PUT',
            CURLOPT_HTTPHEADER => [
                'Authorization: Apisecret ' . $this->apiSecret,
                'Accept: application/json',
            ],
        ]);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $curlErr = curl_error($ch);
        curl_close($ch);

        if ($raw === false || $curlErr !== '') {
            throw new ApiException(502, 'VdoCipher API connection failed: ' . $curlErr);
        }

        if ($status >= 400) {
            $errDetail = '';
            $decoded = json_decode(is_string($raw) ? $raw : '', true);
            if (is_array($decoded)) {
                $errDetail = $decoded['message'] ?? $decoded['error'] ?? json_encode($decoded);
            }
            throw new ApiException(502, 'Failed to initialise upload' . ($errDetail ? ': ' . $errDetail : ''));
        }

        $result = json_decode(is_string($raw) ? $raw : '', true);
        if (!is_array($result)) {
            throw new ApiException(502, 'Invalid response from video service');
        }

        $videoId = $result['videoId'] ?? $result['id'] ?? null;
        if (!$videoId) {
            throw new ApiException(502, 'VdoCipher returned unexpected response — videoId missing');
        }

        // ── Normalise clientPayload to match original EF output ─────────────
        // VdoCipher may return clientPayload as a plain object OR a JSON string.
        $rawClientPayload = $result['clientPayload'] ?? [];
        if (is_string($rawClientPayload)) {
            $rawClientPayload = json_decode($rawClientPayload, true) ?? [];
        }
        if (!is_array($rawClientPayload)) {
            $rawClientPayload = [];
        }

        // Extract uploadLink (becomes upload_url); rest becomes client_payload
        $uploadUrl = $rawClientPayload['uploadLink'] ?? null;
        unset($rawClientPayload['uploadLink']);
        // Always include these per VdoCipher browser upload spec
        $rawClientPayload['success_action_status'] = '201';
        $rawClientPayload['success_action_redirect'] = '';

        \MedAcademy\Services\AuditService::write($userId, 'video_uploaded', ['video_id' => $videoId]);

        // Return shape matches the original Edge Function:
        // { video_id, upload_url, client_payload }
        return [
            'video_id'       => $videoId,
            'upload_url'     => $uploadUrl,
            'client_payload' => $rawClientPayload,
        ];
    }

    /**
     * Poll a VdoCipher video's encoding status by its VdoCipher VIDEO id.
     * Mirrors the original vdocipher-upload-status Edge Function
     * (GET /videos/{videoId}, status mapped to the app's lifecycle).
     */
    public function uploadStatus(string $videoId): array
    {
        if (!$this->isConfigured()) {
            throw new ApiException(500, 'Video service not configured');
        }
        $res = $this->request('GET', '/videos/' . rawurlencode($videoId));
        $status = (int) $res['status'];
        $body = json_decode($res['body'], true);
        $body = is_array($body) ? $body : [];

        if ($status === 404) {
            // Video never reached the provider
            return [
                'video_id' => $videoId,
                'status' => 'failed',
                'vdo_status' => 'not_found',
                'title' => null,
                'duration' => null,
                'poster' => null,
                'error' => 'Video not found in VdoCipher — the upload may not have reached the provider.',
            ];
        }
        if ($status >= 400) {
            $errDetail = $body['message'] ?? $body['error'] ?? json_encode($body);
            throw new ApiException(502, 'Failed to fetch video status (upstream ' . $status . ')' . ($errDetail ? ': ' . $errDetail : ''));
        }

        $rawStatus = (string) ($body['status'] ?? '');
        $mapped = $this->mapVdoStatus($rawStatus);
        return [
            'video_id' => $videoId,
            'status' => $mapped,
            'vdo_status' => $rawStatus,
            'title' => $body['title'] ?? null,
            'duration' => isset($body['length']) && is_numeric($body['length']) ? (int) $body['length'] : null,
            'poster' => $body['poster'] ?? null,
        ];
    }

    /** Map a raw VdoCipher status to the app lifecycle (mirrors the original EF). */
    private function mapVdoStatus(string $raw): string
    {
        $s = strtolower($raw);
        if (in_array($s, ['queued', 'queue', 'pre-processing', 'preprocessing', 'pre_processing'], true)) {
            return 'processing';
        }
        if (in_array($s, ['processing', 'encoding', 'transcoding'], true)) {
            return 'encoding';
        }
        if ($s === 'ready') {
            return 'ready';
        }
        if (in_array($s, ['failed', 'error', 'deleted'], true)) {
            return 'failed';
        }
        return $raw === '' ? 'processing' : $raw;
    }

    /**
     * Create a VdoCipher video entry (PUT /videos?title=...).
     * Mirrors the original video-assemble-upload EF: title is the file name
     * without extension, separators collapsed to spaces, max 200 chars.
     *
     * @return array{ videoId: string, clientPayload: array } VdoCipher create response
     */
    public function createVideo(string $title): array
    {
        if (!$this->isConfigured()) {
            throw new ApiException(500, 'Video service not configured');
        }
        $encodedTitle = rawurlencode($title);
        $ch = curl_init($this->apiBase . '/videos?title=' . $encodedTitle);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_CUSTOMREQUEST => 'PUT',
            CURLOPT_HTTPHEADER => [
                'Authorization: Apisecret ' . $this->apiSecret,
                'Accept: application/json',
            ],
        ]);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($status >= 400) {
            $detail = '';
            $decoded = json_decode(is_string($raw) ? $raw : '', true);
            if (is_array($decoded)) {
                $detail = $decoded['message'] ?? $decoded['error'] ?? json_encode($decoded);
            }
            throw new ApiException(502, 'Video creation failed (upstream ' . $status . ')' . ($detail !== '' ? ': ' . $detail : ''));
        }
        $data = json_decode(is_string($raw) ? $raw : '', true);
        if (!is_array($data) || empty($data['videoId'])) {
            throw new ApiException(502, 'Invalid response from video service during creation');
        }
        return ['videoId' => (string) $data['videoId'], 'clientPayload' => $data['clientPayload'] ?? []];
    }

    /**
     * POST a fully-assembled video file to the VdoCipher S3 presigned endpoint.
     * Mirrors the original EF's multipart/form-data upload: every clientPayload
     * field verbatim (minus uploadLink), then success_action_status='201', then
     * success_action_redirect='', then the file — expecting HTTP 201.
     *
     * @return int S3 HTTP status (201 = success)
     */
    public function uploadToS3(array $clientPayload, string $filePath, string $fileName, string $mimeType): int
    {
        if (empty($clientPayload['uploadLink']) || !is_string($clientPayload['uploadLink'])) {
            throw new ApiException(502, 'Missing uploadLink in VdoCipher client payload');
        }
        $uploadUrl = $clientPayload['uploadLink'];

        $formFields = [];
        foreach ($clientPayload as $k => $v) {
            if ($k === 'uploadLink' || $v === null || $v === '') {
                continue;
            }
            $formFields[$k] = (string) $v;
        }
        // S3 policy requires these two explicitly (empty redirect is allowed)
        $fields = $formFields;
        $fields['success_action_status'] = '201';
        $fields['success_action_redirect'] = '';
        $fields['file'] = new \CURLFile($filePath, $mimeType !== '' ? $mimeType : 'video/mp4', $fileName);

        $ch = curl_init($uploadUrl);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_TIMEOUT => 3600, // 1 hour max for huge files (matches the original EF)
            CURLOPT_POSTFIELDS => $fields,
        ]);
        curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return $status;
    }

    /**
     * Delete a VdoCipher video and (optionally) clear the lesson reference.
     * Mirrors the original vdocipher-delete-video Edge Function.
     */
    public function deleteVideo(string $videoId, ?string $lessonId = null, bool $clearLesson = false): array
    {
        if (!$this->isConfigured()) {
            throw new ApiException(500, 'Video service not configured');
        }
        $res = $this->request('DELETE', '/videos/' . rawurlencode($videoId));
        $vdoStatus = (int) $res['status'];

        $cleared = false;
        if ($clearLesson && $lessonId !== null && $lessonId !== '') {
            $db = Database::instance();
            $db->query(
                'UPDATE lessons SET video_id = NULL, video_type = ?, video_status = ?, video_playback_id = NULL, video_upload_id = NULL
                  WHERE id = ? AND (video_id = ? OR video_id IS NULL)',
                ['none', 'none', $lessonId, $videoId]
            );
            $cleared = true;
        }

        return [
            'success' => $vdoStatus < 400,
            'vdo_deleted' => $vdoStatus < 400,
            'vdo_error' => $vdoStatus >= 400 ? ('VdoCipher delete failed (upstream ' . $vdoStatus . ')') : null,
            'lesson_cleared' => $cleared,
        ];
    }

    private function request(string $method, string $path, array $body = []): array
    {
        $ch = curl_init($this->apiBase . $path);
        $headers = [
            'Authorization: Apisecret ' . $this->apiSecret,
            'Content-Type: application/json',
        ];
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
        ]);
        if ($body !== []) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        }
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return ['status' => $status, 'body' => is_string($raw) ? $raw : ''];
    }
}
