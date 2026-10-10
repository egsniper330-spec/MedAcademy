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

    /** Public read-only check for callers deciding policy on unknown remote state. */
    public function providerConfigured(): bool
    {
        return $this->isConfigured();
    }

    /**
     * DYNAMIC (MOVING) STREAM WATERMARK — `annotate` on the ONLINE OTP.
     *
     * VdoCipher burns this text INTO THE STREAM server-side, so it is present in
     * fullscreen, survives any React Native view re-parenting, and cannot be
     * removed by clearing a DOM/overlay element — which a client-side overlay
     * alone cannot guarantee.
     *
     * SCOPE: streaming OTPs only. `offlineAuthorize()` keeps the client overlay
     * as its single watermark — the offline token is persisted by the app, so
     * changing it here without an app-side contract would reintroduce the
     * reported duplicate watermark on downloaded videos.
     *
     * ANTI-DUPLICATION CONTRACT: it was removed in 2026-09 because it
     * double-fired alongside the app overlay (burned-in "NAME\nID: MED-####"
     * PLUS the overlay pill) — the reported duplicate watermark. The OTP
     * response now carries `annotateApplied`, and the app renders its overlay
     * ONLY when that flag is false, so exactly one watermark is ever shown.
     * The overlay stays as the fallback for accounts that cannot be annotated
     * (missing name/public id) and for providers with no server-side
     * annotation at all (YouTube).
     *
     * The provider's STATIC text watermark option is not available for mobile
     * SDK playback, so it is deliberately not used — this is the rotating/moving
     * annotation instead.
     */

    /**
     * Build the `annotate` value for the OTP request — a MOVING text watermark.
     *
     * `type: rtext` is VdoCipher's rotating text: `interval` is the ms between
     * moves and `skip` the ms offset before the first move, so the mark is never
     * static on screen.
     *
     * Content is the display name plus the canonical public user id (MED-####),
     * falling back to the legacy watermark_id for pre-migration rows. Nothing
     * else — never a password, token, email or device id.
     *
     * Built with json_encode(), NEVER string concatenation, so an apostrophe or
     * quote in a display name cannot break or inject into the JSON payload.
     * Returns "" when there is nothing safe to render, so callers skip the field
     * entirely. The API secret is never part of this value.
     */
    public function buildAnnotate(string $fullName, string $watermarkId): string
    {
        $idLine = trim($watermarkId) !== '' ? 'ID: ' . trim($watermarkId) : '';
        $name = trim($fullName);
        $lines = array_filter([
            $name,
            $idLine,
        ], static fn (string $v): bool => $v !== '');
        if ($lines === []) {
            return '';
        }
        $text = implode("\n", $lines);
        $annotations = [[
            'type'     => 'rtext',
            'text'     => $text,
            'color'    => '0xFFFFFF',
            'alpha'    => '0.45',
            'size'     => '18',
            'interval' => '25000',
            'skip'     => '2000',
        ]];
        return json_encode($annotations, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: '';
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
            'SELECT role, full_name, watermark_id, public_user_id FROM profiles WHERE id = ?',
            [$userId]
        );
        if ($profile === null) {
            throw new ApiException(401, 'Account not found');
        }
        $role = $profile['role'];
        $isPrivileged = in_array($role, ['doctor', 'admin', 'super_admin'], true);

        // SERVER-SIDE CONTENT GATE: students MUST identify the lesson. Without
        // it there is no way to verify enrollment/published state, so issuing an
        // OTP would let any student token play ANY provider video (draft,
        // unpublished, or another doctor's content) by calling /video/otp with
        // only video_id. The app always sends lesson_id; a request without one
        // from a non-privileged role is treated as unauthorized.
        if (!$isPrivileged && ($lessonId === null || $lessonId === '')) {
            throw new ApiException(403, 'This lesson is not available');
        }

        $lesson = null;
        if ($lessonId !== null && $lessonId !== '') {
            $lesson = $db->row(
                'SELECT course_id, video_id, status, video_status FROM lessons WHERE id = ? AND video_id = ?',
                [$lessonId, $videoId]
            );
            if ($lesson === null) {
                throw new ApiException($isPrivileged ? 404 : 403, $isPrivileged ? 'Lesson not found' : 'This lesson is not available');
            }
            // PLAYBACK SAFETY (sync contract): a lesson whose video was proven
            // deleted from VdoCipher (library sync / markLessonVideoMissing)
            // must never reach the OTP endpoint — return a clear, stable
            // "unavailable" instead of an upstream 404 wrapped in a 502.
            if (($lesson['video_status'] ?? '') === 'missing') {
                throw new ApiException(410, 'This video is no longer available');
            }
            if (!$isPrivileged && $lesson['status'] !== 'published') {
                throw new ApiException(403, 'This lesson is not available');
            }
            if (!$isPrivileged) {
                //  SUSPENSION ENFORCEMENT: a SUSPENDED enrollment is not
                //  access. Previously this counted rows without consulting
                //  `status`, so a doctor's course suspension was written to the
                //  DB but never read — the student kept receiving playback OTPs.
                //  Read the status so the refusal is HONEST (suspended vs never
                //  enrolled). The row is never deleted; resuming restores
                //  access with progress intact.
                $enrollmentStatus = $db->value(
                    'SELECT status FROM enrollments WHERE student_id = ? AND course_id = ? LIMIT 1',
                    [$userId, $lesson['course_id']],
                    null
                );
                if ($enrollmentStatus === null) {
                    throw new ApiException(403, 'Not enrolled in this course');
                }
                if ((string) $enrollmentStatus === 'suspended') {
                    throw new ApiException(403, 'Your access to this course has been suspended by the instructor.');
                }
                // COURSE VISIBILITY GATE: enrollment alone is not access. If the
                // parent course is not currently published, a student must not
                // receive NEW playback/download authorization even with an
                // active enrollment (unpublish hides the course; the enrollment
                // row is preserved for when it returns). Staff bypass: doctors/
                // admins keep managing their (unpublished) content.
                $courseStatus = $db->value(
                    'SELECT status FROM courses WHERE id = ?',
                    [$lesson['course_id']],
                    ''
                );
                if ($courseStatus !== 'published') {
                    throw new ApiException(403, 'This course is not available');
                }
            }
        }

        $payload = [];
        $appDomain = Config::string('APP_URL');
        if ($appDomain !== '') {
            $payload['whitelisthref'] = $appDomain;
        }

        // ── DYNAMIC (MOVING) STREAM WATERMARK — server-side annotate ──────
        // Student playback only, matching the policy this code had before the
        // 2026-09 removal: staff previewing their own or draft content are not
        // watermarked. `annotateApplied` tells the app whether the burned-in
        // watermark is present so it can suppress its own overlay — that flag is
        // what keeps this from regressing into the reported duplicate watermark.
        $annotated = false;
        if (!$isPrivileged && $profile !== null) {
            $name = trim((string) $profile['full_name']);
            $wmId = trim((string) ($profile['public_user_id'] ?? ''));
            if ($wmId === '') {
                $wmId = trim((string) ($profile['watermark_id'] ?? ''));
            }
            if ($name !== '' && $wmId !== '') {
                $annotate = $this->buildAnnotate($name, $wmId);
                if ($annotate !== '') {
                    $payload['annotate'] = $annotate;
                    $annotated = true;
                }
            }
        }

        $res = $this->request('POST', '/videos/' . rawurlencode($videoId) . '/otp', $payload);
        $status = (int) $res['status'];
        $body = $res['body'];

        // ── WATERMARK CAPABILITY FALLBACK (availability guard) ─────────────
        // `annotate` is attached only when a safe identity exists, but whether
        // the ACCOUNT is allowed to burn a watermark in is a dashboard/plan
        // capability this code cannot observe. If the annotation is what the
        // upstream refused, the student must still be able to play: retry ONCE
        // WITHOUT it and let the client overlay take over (annotateApplied=false
        // → the app renders its own watermark, so playback is never
        // unwatermarked either way). Exactly one retry is issued, and only when
        // the first attempt actually carried the annotation, so this can never
        // loop; if the retry also fails the ORIGINAL upstream error is raised.
        if ($status >= 400 && $annotated && isset($payload['annotate'])) {
            unset($payload['annotate']);
            $retry = $this->request('POST', '/videos/' . rawurlencode($videoId) . '/otp', $payload);
            if ((int) $retry['status'] < 400) {
                $res    = $retry;
                $status = (int) $retry['status'];
                $body   = $retry['body'];
                $annotated = false;
            }
        }

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

        return [
            'otp'             => $data['otp'] ?? null,
            'playbackInfo'    => $data['playbackInfo'] ?? null,
            // TRUE when the moving stream watermark was attached to THIS OTP;
            // the app suppresses its own overlay in that case so exactly one
            // watermark is ever shown. Never a secret.
            'annotateApplied' => $annotated,
        ];
    }

    /**
     * OFFLINE DOWNLOAD AUTHORIZATION (official VdoCipher offline flow).
     *
     * Identical server-side policy to otp() (entitlement/published/enrollment,
     * watermark), plus the OFFLINE-specific policy: the download-OTP embeds a
     * finite offline license (rental duration) so a downloaded copy always
     * expires — permanent offline copies are never issued. The rental duration
     * is operator policy (security_config.extras.offline_rental_hours, default
     * 2160h = 90 days) — never hardcoded in the client. The API secret never leaves the
     * server; the client receives only otp + playbackInfo, exactly as for
     * streaming.
     *
     * IMPORTANT (account capability): the VdoCipher ACCOUNT must have offline
     * downloads enabled for getDownloadOptions() to return options on the
     * device. That is a dashboard/plan capability — if it is disabled, this
     * endpoint still works and the CLIENT surfaces VdoCipher's specific error
     * honestly (the capability cannot be enabled from code).
     */
    public function offlineAuthorize(
        string $userId,
        string $videoId,
        ?string $lessonId,
        ?string $ipAddress = null
    ): array {
        if (!$this->isConfigured()) {
            throw new ApiException(500, 'Video service not configured');
        }

        $db = Database::instance();
        $profile = $db->row(
            'SELECT role, full_name, watermark_id, public_user_id FROM profiles WHERE id = ?',
            [$userId]
        );
        if ($profile === null) {
            throw new ApiException(401, 'Account not found');
        }
        $role = $profile['role'];
        $isPrivileged = in_array($role, ['doctor', 'admin', 'super_admin'], true);

        // SAME content gate as otp(): students MUST identify the lesson; the
        // lesson must match the video, be published, and the student enrolled.
        // A download OTP is a playback OTP — no weaker entitlement rules.
        if (!$isPrivileged && ($lessonId === null || $lessonId === '')) {
            throw new ApiException(403, 'This lesson is not available');
        }

        $lesson = null;
        if ($lessonId !== null && $lessonId !== '') {
            $lesson = $db->row(
                'SELECT course_id, video_id, status, video_status FROM lessons WHERE id = ? AND video_id = ?',
                [$lessonId, $videoId]
            );
            if ($lesson === null) {
                throw new ApiException($isPrivileged ? 404 : 403, $isPrivileged ? 'Lesson not found' : 'This lesson is not available');
            }
            // PLAYBACK SAFETY (sync contract): same remotely-deleted gate as
            // otp() — a download OTP is a playback OTP, no weaker rules.
            if (($lesson['video_status'] ?? '') === 'missing') {
                throw new ApiException(410, 'This video is no longer available');
            }
            if (!$isPrivileged && $lesson['status'] !== 'published') {
                throw new ApiException(403, 'This lesson is not available');
            }
            if (!$isPrivileged) {
                //  SUSPENSION ENFORCEMENT (offline twin): no NEW download
                //  authorization for a suspended enrollment — same rule as
                //  otp(), no weaker path. Already-downloaded DRM media is never
                //  touched here (this gate only refuses new licences).
                $enrollmentStatus = $db->value(
                    'SELECT status FROM enrollments WHERE student_id = ? AND course_id = ? LIMIT 1',
                    [$userId, $lesson['course_id']],
                    null
                );
                if ($enrollmentStatus === null) {
                    throw new ApiException(403, 'Not enrolled in this course');
                }
                if ((string) $enrollmentStatus === 'suspended') {
                    throw new ApiException(403, 'Your access to this course has been suspended by the instructor.');
                }
                // COURSE VISIBILITY GATE (offline twin): identical rule to
                // otp() — an enrollment row alone is not access while the
                // parent course is unpublished. No NEW download authorization.
                $courseStatus = $db->value(
                    'SELECT status FROM courses WHERE id = ?',
                    [$lesson['course_id']],
                    ''
                );
                if ($courseStatus !== 'published') {
                    throw new ApiException(403, 'This course is not available');
                }
            }
        }

        // ── Offline rental policy (finite licenses, operator-configurable) ──
        // security_config.extras.offline_rental_hours = int hours
        // (default 90 * 24 = 2160 hours = 90 days). The live DB row OVERRIDES
        // this default when present — an operator-set value always wins.
        // The VdoCipher offline license is bound to the OTP, so the expiry
        // travels with the downloaded media and is enforced by the DRM layer
        // at playback — not by client clocks.
        $rentalHours = 90 * 24; // 90 days / 3 months — still FINITE, never unlimited
        try {
            $row = $db->row(
                'SELECT extras FROM security_config WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1'
            );
            $extras = $row !== null ? json_decode((string) $row['extras'], true) : null;
            if (is_array($extras) && isset($extras['offline_rental_hours'])) {
                $h = (int) $extras['offline_rental_hours'];
                if ($h > 0 && $h <= 24 * 365) {
                    $rentalHours = $h;
                }
            }
        } catch (\Throwable) {
            // policy row unavailable → keep the safe default
        }

        $payload = [];
        $appDomain = Config::string('APP_URL');
        if ($appDomain !== '') {
            $payload['whitelisthref'] = $appDomain;
        }

        // WATERMARK: the client-side overlay remains the single watermark for
        // OFFLINE playback (see the class-level SCOPE note). The moving
        // `annotate` watermark is restored for ONLINE streaming OTPs only.
        // Adding it here would double-fire against the overlay the offline
        // player renders, because the offline token is persisted by the app and
        // has no app-side `annotateApplied` contract yet.

        // OFFLINE LICENSE (official VdoCipher offline-OTP contract): the OTP
        // must carry licenseRules = {"canPersist":true,"rentalDuration":<sec>}
        // as a SERIALIZED JSON STRING for the license server to grant a
        // persistent (offline) Widevine license. Without canPersist the
        // license server rejects the persistent-license request at download
        // time ("License creation failed", HTTP 403). The rental window is
        // enforced by the DRM license itself — expires fully offline.
        $payload['licenseRules'] = json_encode([
            'canPersist'     => true,
            'rentalDuration' => $rentalHours * 3600,
        ]);

        $res = $this->request('POST', '/videos/' . rawurlencode($videoId) . '/otp', $payload);
        $status = (int) $res['status'];
        $body = $res['body'];

        if ($status >= 400) {
            $errDetail = '';
            $decoded = json_decode($body, true);
            if (is_array($decoded)) {
                $errDetail = $decoded['message'] ?? $decoded['error'] ?? json_encode($decoded);
            }
            throw new ApiException(502, 'Failed to generate offline download token (upstream ' . $status . ')' . ($errDetail ? ': ' . $errDetail : ''));
        }
        $data = json_decode($body, true);
        if (!is_array($data)) {
            throw new ApiException(502, 'Invalid response from video service');
        }

        \MedAcademy\Services\AuditService::write($userId, 'security_event', [
            'event' => 'video_download_authorized',
            'video_id' => $videoId,
            'lesson_id' => $lessonId,
            'rental_hours' => $rentalHours,
        ], $ipAddress);

        return [
            'otp'         => $data['otp'] ?? null,
            'playbackInfo'=> $data['playbackInfo'] ?? null,
            'rentalHours' => $rentalHours,
            'expiresAt'   => gmdate('c', time() + $rentalHours * 3600),
            // OPTIONAL official parameter (VdoCipher RN offline docs: "We can
            // also pass the customPlayerId along with the otp and playbackInfo
            // which should be applied to the downloaded video"). Null unless
            // the operator configures it — the account default player is used
            // otherwise, exactly as before. Never a secret.
            'customPlayerId' => Config::string('VDO_CUSTOM_PLAYER_ID'),
        ];
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
     * Check if a VdoCipher video still exists at the provider.
     * Uses GET /videos/{videoId}.
     *
     * ERROR-SAFE (Video Library sync contract): only an HTTP 404 proves the
     * asset is gone. A network failure, timeout, auth failure or 5xx returns
     * status 'error' — callers MUST treat that as UNKNOWN, never as deleted.
     * (The previous boolean form collapsed all of these into "false", which
     * let a transient outage orphan live VdoCipher assets.)
     *
     * @return array{status: 'exists'|'missing'|'error', http_status: int}
     */
    public function verifyRemote(string $videoId): array
    {
        if ($videoId === '') {
            return ['status' => 'error', 'http_status' => 0];
        }
        if (!$this->isConfigured()) {
            return ['status' => 'error', 'http_status' => 0];
        }
        $res = $this->request('GET', '/videos/' . rawurlencode($videoId));
        $http = (int) $res['status'];
        if ($http === 200) {
            return ['status' => 'exists', 'http_status' => $http];
        }
        if ($http === 404) {
            return ['status' => 'missing', 'http_status' => $http];
        }
        // 401/403/429/5xx/timeout(curl reports 0)/malformed → UNKNOWN.
        return ['status' => 'error', 'http_status' => $http];
    }

    /**
     * LEGACY boolean wrapper (deleteAsset orphan check). Kept for callers
     * that only need a yes/no and handle errors separately — new sync code
     * must use verifyRemote(). True only when provably present; false for
     * missing AND unknown (callers decide policy per case).
     */
    public function providerExists(string $videoId): bool
    {
        return $this->verifyRemote($videoId)['status'] === 'exists';
    }

    /**
     * List the ENTIRE remote VdoCipher library using the official paginated
     * listing API (GET /videos?page=N&limit=M).
     * https://www.vdocipher.com/docs/server/videomanagement/listing/
     *
     * Follows every page until exhaustion (or the safety cap) so a large
     * library is never truncated at the first page — the exact failure that
     * produced stale Video Library entries. Memory stays bounded: only the
     * video IDs (+ minimal metadata) are retained.
     *
     * @param int $pageLimit  page size (VdoCipher max 100)
     * @param int $maxPages   safety cap (100 pages × 100 = 10k videos)
     * @return array{status:'ok'|'error', http_status:int, videos:array<string,array>, total:int|null, pages:int, error:?string}
     *         videos maps videoId => ['title'=>?string,'duration'=>?int,'status'=>?string]
     */
    public function listAllVideos(int $pageLimit = 100, int $maxPages = 100): array
    {
        $videos = [];
        $total = null;
        $pagesFetched = 0;
        if (!$this->isConfigured()) {
            return ['status' => 'error', 'http_status' => 0, 'videos' => [], 'total' => null, 'pages' => 0, 'error' => 'not_configured'];
        }
        $pageLimit = max(1, min(100, $pageLimit));
        for ($page = 1; $page <= $maxPages; $page++) {
            $res = $this->request('GET', '/videos?page=' . $page . '&limit=' . $pageLimit);
            $http = (int) $res['status'];
            if ($http === 429) {
                // Rate limited mid-listing: report partial success as an error
                // so the caller can retry later — never treat as complete.
                return ['status' => 'error', 'http_status' => $http, 'videos' => $videos, 'total' => $total, 'pages' => $pagesFetched, 'error' => 'rate_limited'];
            }
            if ($http >= 400) {
                return ['status' => 'error', 'http_status' => $http, 'videos' => $videos, 'total' => $total, 'pages' => $pagesFetched, 'error' => 'upstream_' . $http];
            }
            $body = json_decode($res['body'], true);
            if (!is_array($body)) {
                return ['status' => 'error', 'http_status' => $http, 'videos' => $videos, 'total' => $total, 'pages' => $pagesFetched, 'error' => 'malformed_response'];
            }
            // VdoCipher listing shape (verified live 2026-09): { "rows": [...], "count": N }.
            // Older API versions returned { "videos": [...], "count": ... } or a
            // bare array — all three are accepted so an API-side schema change
            // can never make a healthy library look empty (the empty-remote
            // bug class: sync then marks every local asset missing).
            $rows = [];
            if (isset($body['rows']) && is_array($body['rows'])) {
                $rows = $body['rows'];
            } elseif (isset($body['videos']) && is_array($body['videos'])) {
                $rows = $body['videos'];
            } elseif ($body !== [] && array_keys($body) === range(0, count($body) - 1)) {
                $rows = $body; // legacy bare-array response
            }
            if (isset($body['count']) && is_numeric($body['count'])) {
                $total = (int) $body['count'];
            }
            $pagesFetched++;
            $rowIds = [];
            foreach ($rows as $row) {
                if (!is_array($row)) continue;
                $id = (string) ($row['videoId'] ?? $row['id'] ?? '');
                if ($id === '') continue;
                $rowIds[] = $id;
                $videos[$id] = [
                    'title' => isset($row['title']) ? (string) $row['title'] : null,
                    'duration' => isset($row['length']) && is_numeric($row['length']) ? (int) $row['length'] : null,
                    'status' => isset($row['status']) ? (string) $row['status'] : null,
                ];
            }
            // Stop when a short/empty page means we have everything.
            if (count($rowIds) < $pageLimit) {
                break;
            }
        }
        return ['status' => 'ok', 'http_status' => 200, 'videos' => $videos, 'total' => $total, 'pages' => $pagesFetched, 'error' => null];
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
        // Official VdoCipher API: DELETE /videos?videos={video_id}
        // The query parameter name is 'videos' (plural), not 'id'.
        $res = $this->request('DELETE', '/videos?videos=' . rawurlencode($videoId));
        $vdoStatus = (int) $res['status'];
        // VdoCipher deletion is idempotent: a missing provider resource is
        // already in the desired state and must not block local cleanup.
        $providerDeleted = ($vdoStatus >= 200 && $vdoStatus < 300) || $vdoStatus === 404;

        // Log VdoCipher deletion result (redact API secret, never log credentials)
        if (!$providerDeleted) {
            \MedAcademy\Services\AuditService::write(
                'system',
                'vdocipher_delete_failed',
                [
                    'video_id' => $videoId,
                    'http_status' => $vdoStatus,
                    'response_body' => mb_substr($res['body'] ?? '', 0, 500),
                ]
            );
        }

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
            'success' => $providerDeleted,
            'vdo_deleted' => $providerDeleted,
            'vdo_status' => $vdoStatus,
            'vdo_error' => $providerDeleted ? null : ('VdoCipher delete failed (upstream ' . $vdoStatus . ')'),
            'lesson_cleared' => $cleared,
        ];
    }

    private function request(string $method, string $path, array $body = []): array
    {
        $ch = curl_init($this->apiBase . $path);
        $headers = [
            'Authorization: Apisecret ' . $this->apiSecret,
            'Accept: application/json',
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
        $curlError = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($curlError !== '') {
            \MedAcademy\Services\AuditService::write(
                'system',
                'vdoapi_curl_error',
                ['method' => $method, 'path' => $path, 'error' => $curlError, 'status' => $status]
            );
        }
        return ['status' => $status, 'body' => is_string($raw) ? $raw : ''];
    }
}
