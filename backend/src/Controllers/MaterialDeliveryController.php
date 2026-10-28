<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Http\Response;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\IntegrityService;
use MedAcademy\Services\MaterialPdfQueueService;
use MedAcademy\Services\MaterialPdfVariantService;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Services\RateLimitService;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;

/**
 * MaterialDeliveryController — the ONLY path that serves a lesson PDF.
 *
 * ── POLICY: WATERMARKING IS MANDATORY FOR EVERY DELIVERY ──────────────────
 * Every delivery — student, doctor, admin — is a PERSONALIZED copy carrying the
 * caller's name and public account id. That keeps one observable behaviour for
 * everyone: a doctor who previews their own course receives exactly the bytes a
 * student would.
 *
 * There is no per-material switch and no client option: `shouldWatermark()` is
 * unconditional. The legacy `lesson_materials.watermark_enabled` column is
 * deliberately ignored (see loadMaterial()).
 *
 * ── HYBRID GENERATION (queue + inline) ─────────────────────────────────────
 * Rendering a personalized copy used to happen inside the requesting HTTP
 * request for EVERY caller. On shared cPanel hosting a first-open of a large
 * PDF therefore pinned a PHP-FPM worker for the whole render, and N students
 * opening the same document at once could exhaust the pool.
 *
 * Now:
 *   • an upload enqueues durable jobs for every eligible enrolled student
 *     (MaterialPdfQueueService::enqueueMaterial), so copies are usually ready
 *     before anybody asks;
 *   • a STUDENT never renders inline — a missing copy is queued (their own job,
 *     highest priority, no duplicate) and the response says `preparing`, which
 *     the app polls;
 *   • STAFF keep the synchronous render for their own single preview copy: it is
 *     one document, it is what makes the lesson editor usable, and it is bounded.
 *
 * The unwatermarked original is NEVER served from this endpoint, and a copy is
 * only reused while its source hash and engine settings still match.
 *
 * ── WHY A TOKEN INSTEAD OF A SIGNED STORAGE URL ────────────────────────────
 * The token identifies MATERIAL + STUDENT + INTENT (never a path), is
 * short-lived, and is validated AT CONSUMPTION TIME against the CURRENT
 * permission, download flag, enrollment and publication status. Setting a
 * material to Preview Only or hidden kills every previously issued link.
 *
 * `/storage/signed-url` and `/storage/signed` REFUSE lesson-material PDFs, and
 * the `lesson-material-pdfs` bucket is absent from StorageController's private
 * buckets, so this endpoint is the only way those bytes leave the server.
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────
 * If the renderer is unavailable, the source is unreadable, or the cached copy
 * vanished, the request FAILS. The original is never substituted.
 */
final class MaterialDeliveryController
{
    /** Short-lived by design — the app mints a fresh URL each time it opens. */
    private const DEFAULT_TTL_SECONDS = 300;

    public function __construct(
        private readonly StorageService $storage = new StorageService(),
        private readonly PdfWatermarkService $watermark = new PdfWatermarkService(),
        private readonly MaterialPdfVariantService $variants = new MaterialPdfVariantService(),
        private readonly MaterialPdfQueueService $queue = new MaterialPdfQueueService(),
    ) {
    }

    /**
     * POST /materials/pdf-url
     * Body: { material_id, intent: 'view' | 'download', retry?: bool }
     *
     * Authorises the caller, then returns EITHER a short-lived URL for a ready
     * personalized copy OR a structured pending state:
     *
     *   { status: 'ready',     url, expires_at, ... }
     *   { status: 'preparing', retry_after, ... }   queued / being rendered
     *   { status: 'failed',    reason, retry_allowed, ... }
     *
     * A student never gets the unwatermarked source, and never triggers an
     * unbounded render in this request.
     */
    public function pdfUrl(Request $request): array
    {
        $body = $request->json();
        $materialId = trim((string) ($body['material_id'] ?? ''));
        $intent = strtolower((string) ($body['intent'] ?? 'view'));
        if ($intent !== 'download') {
            $intent = 'view';
        }
        if ($materialId === '') {
            throw new ApiException(400, 'material_id is required');
        }

        // Minting may enqueue work, so it is throttled per ACCOUNT (an
        // account-scoped bucket is immune to shared carrier-NAT IPs).
        RateLimitService::perAccount($request, 'material_pdf_mint', $this->mintPerMinute(), 60);

        $userId = (string) $request->user['id'];
        $role = (string) $request->user['role'];

        $material = $this->loadMaterial($materialId);
        $forDownload = $intent === 'download';

        // Server-side authorization — the SAME routine the storage layer uses.
        if (!$this->storage->canAccess($userId, $role, 'lesson-materials', (string) $material['storage_path'], $forDownload)) {
            throw new ApiException(403, 'Access denied');
        }

        // ── Server-side integrity policy for ISSUANCE ──────────────────────
        // Default tier is log_only; once an operator sets
        // security_config.extras.play_integrity.actions.material_pdf to
        // "enforce", only a Google-verified APK can mint a copy. The client
        // cannot influence the decision: the header merely names a
        // server-issued challenge and the verdict row is written ONLY from
        // Google's decoded payload.
        IntegrityService::assertActionAllowed(
            $userId,
            'material_pdf',
            $request->header(IntegrityService::HEADER),
            $request->clientIp()
        );

        $this->shouldWatermark($role); // policy is unconditional; kept explicit

        // Cache identity of THIS student's copy of THIS material. Throws 404 when
        // the source vanished and 403 when there is no profile to personalize to.
        $identity = $this->variants->identity($material, $userId);

        // Fast path: a valid, current copy already exists.
        $copy = $this->variants->existing($material, $userId, $identity['variant_key']);
        if ($copy !== null) {
            // Retention clock: a copy being opened today is never swept.
            $this->variants->touchServed($copy);
            return $this->readyResponse(
                $materialId,
                $userId,
                $intent,
                (int) ($copy['page_count'] ?? 0),
                (string) $copy['variant_key']
            );
        }

        // ── STAFF: render this one preview copy inline ──────────────────────
        // Bounded by construction: it is the caller's own single document. The
        // queue still pre-generated student copies in the background.
        if ($this->isStaff($role)) {
            try {
                $copy = $this->variants->ensure($material, $userId);
            } catch (ApiException $e) {
                $this->auditFailure($material, $userId, $this->failureStage($e), $e);
                throw $e;
            } catch (\Throwable $e) {
                $this->auditFailure($material, $userId, 'unexpected', null);
                error_log('[material-delivery] unexpected mint failure (' . get_class($e) . '): ' . $e->getMessage());
                throw $e;
            }
            $this->variants->touchServed($copy);
            return $this->readyResponse(
                $materialId,
                $userId,
                $intent,
                (int) ($copy['page_count'] ?? 0),
                (string) $copy['variant_key']
            );
        }

        // ── STUDENT: queue it, report honestly, never render here ───────────
        // `retry` is the explicit user action after a permanent failure; it only
        // ever re-queues THIS student's own failed job.
        if (!empty($body['retry'])) {
            $this->queue->retry($material, $userId);
        }

        $variantKey = $this->queue->prioritize($material, $userId, true);
        if ($variantKey === null) {
            throw new ApiException(503, 'This document cannot be prepared right now.', 'queue_unavailable');
        }

        $status = $this->queue->statusFor($material, $userId, $variantKey, false);

        // A queued copy may have been completed between the cache check and the
        // enqueue (another worker finishing): re-check before saying "wait".
        $copy = $this->variants->existing($material, $userId, $variantKey);
        if ($copy !== null) {
            $this->variants->touchServed($copy);
            return $this->readyResponse(
                $materialId,
                $userId,
                $intent,
                (int) ($copy['page_count'] ?? 0),
                (string) $copy['variant_key']
            );
        }

        return $this->pendingResponse($materialId, $intent, $status);
    }

    /**
     * GET /materials/pdf-status?material_id=…
     *
     * Read-only companion to pdf-url: it answers "is my copy ready?" WITHOUT
     * minting a token or touching the render path, so the client can poll it
     * cheaply with bounded backoff. It performs the same authorization check and
     * never reports `ready` for a copy that is not valid right now.
     *
     * Since the waiting UX was added it also carries the server-grounded wait
     * contract: `state` (queued | generating | ready | failed | unavailable),
     * `queue_position` / `jobs_ahead`, `processing_now` and an `eta_*` range that
     * is NULL unless it is measured (see MaterialPdfQueueService::statusFor).
     * `retry_after` remains a POLLING INTERVAL, never an ETA.
     */
    public function pdfStatus(Request $request): array
    {
        $materialId = trim((string) $request->query('material_id', ''));
        if ($materialId === '') {
            throw new ApiException(400, 'material_id is required');
        }

        RateLimitService::perAccount($request, 'material_pdf_status', $this->statusPerMinute(), 60);

        $userId = (string) $request->user['id'];
        $role = (string) $request->user['role'];
        $material = $this->loadMaterial($materialId);

        if (!$this->storage->canAccess($userId, $role, 'lesson-materials', (string) $material['storage_path'], false)) {
            throw new ApiException(403, 'Access denied');
        }

        try {
            $identity = $this->variants->identity($material, $userId);
        } catch (ApiException $e) {
            // No identity (no profile to personalize to, source gone): this is a
            // verdict, not a queue state — and it must never look like `ready`.
            return [
                'material_id' => $materialId,
                'status' => MaterialPdfQueueService::STATUS_FAILED,
                'state' => MaterialPdfQueueService::STATE_FAILED,
                'reason' => $this->failureStage($e),
                'attempts' => 0,
                'max_attempts' => MaterialPdfQueueService::DEFAULT_MAX_ATTEMPTS,
                'retry_after' => 0,
                'retry_allowed' => false,
                'watermarked' => true,
            ] + $this->waitFields([]);
        }

        $copy = $this->variants->existing($material, $userId, $identity['variant_key']);
        $status = $this->queue->statusFor($material, $userId, $identity['variant_key'], $copy !== null);

        return [
            'material_id' => $materialId,
            // `status` keeps the three-value client contract (ready | preparing |
            // failed) that already-shipped clients rely on; `state` adds the
            // distinction between queued and actively generating.
            'status' => $this->clientStatus($status),
            'state' => $status['state'],
            'reason' => $status['reason'],
            'attempts' => $status['attempts'],
            'max_attempts' => $status['max_attempts'],
            'retry_after' => $status['retry_after'],
            'retry_allowed' => $status['status'] === MaterialPdfQueueService::STATUS_FAILED,
            'watermarked' => true,
        ] + $this->waitFields($status);
    }

    /**
     * GET /materials/pdf?token=…
     *
     * Validates the token, then RE-READS the current database state and re-runs
     * the authorization check before streaming a single byte. A link minted
     * before a permission change is refused after it.
     */
    public function streamPdf(Request $request): never
    {
        $token = (string) $request->query('token', '');
        $payload = $this->verifyToken($token); // throws 403/410

        $materialId = (string) $payload['material_id'];
        $studentId = (string) $payload['student_id'];
        $intent = (string) $payload['intent'];
        $forDownload = $intent === 'download';

        $material = $this->loadMaterial($materialId);
        $role = (string) Database::instance()->value(
            'SELECT role FROM profiles WHERE id = ?',
            [$studentId],
            'student'
        );

        // ── LIVE re-authorization: the whole point of validating here ──
        if (!$this->storage->canAccess($studentId, $role, 'lesson-materials', (string) $material['storage_path'], $forDownload)) {
            Response::error('Access denied', 403, 'forbidden');
        }

        $this->shouldWatermark($role);
        $copy = $this->variants->existing($material, $studentId);
        if ($copy === null) {
            // The copy went missing between mint and stream (or the source was
            // replaced). Never serve the original — fail closed; the client
            // re-mints, which queues a fresh job.
            Response::error('The personalized copy is not available.', 503, 'watermark_unavailable');
        }

        $abs = $this->storage->privateFilePath(PdfWatermarkService::BUCKET, (string) $copy['storage_path']);
        if (!is_file($abs)) {
            Response::error('The personalized copy is not available.', 503, 'watermark_unavailable');
        }

        $pageCount = (int) ($copy['page_count'] ?? 0);
        $variantKey = (string) ($copy['variant_key'] ?? '');
        $fileName = (string) ($material['file_name'] ?? 'material.pdf');

        // Delivery audit: ids and outcomes only — never the name, the token or
        // any document content.
        $this->auditDelivery($material, $studentId, $role, $intent, $pageCount, $variantKey, $request);

        // The database work for this response is finished (material, live
        // authorization, copy lookup and the delivery audit row). What follows is
        // a file transfer whose duration depends on the document size and the
        // client's link, so the connection slot is released before it starts
        // rather than being held for the whole download.
        Database::instance()->release();

        // ATTACHMENT for an explicit download; INLINE for viewing. Either way the
        // bytes are the personalized copy, and a document is never rendered
        // inline as active content (nosniff).
        Response::file(
            $abs,
            'application/pdf',
            [
                'X-Content-Type-Options' => 'nosniff',
                // Per-student bytes: never cacheable by a shared browser/CDN.
                'Cache-Control' => 'private, no-store, max-age=0',
                'Pragma' => 'no-cache',
                'Content-Disposition' => ($forDownload ? 'attachment' : 'inline')
                    . '; filename="' . $this->safeFileName($fileName) . '"',
            ]
        );
    }

    /** Super-admin health surface for the watermarking + queue capability. */
    public function watermarkStatus(Request $request): array
    {
        $status = $this->watermark->status();
        try {
            $status['queue'] = $this->queue->health();
        } catch (\Throwable $e) {
            // Migration 038 not applied yet: report it instead of a 500.
            $status['queue'] = ['error' => 'queue_table_missing', 'detail' => $e->getMessage()];
        }
        return $status;
    }

    // ──────────────────────────────────────────────────────────────────────────

    /**
     * TRUE for every delivery, whatever the role.
     *
     * This is the whole policy. It intentionally does NOT look at the material,
     * at `watermark_enabled`, at a feature flag or at any request field: a doctor
     * cannot disable it, a stale database value cannot disable it, and a client
     * cannot ask for it to be skipped.
     */
    private function shouldWatermark(string $role): bool
    {
        unset($role); // kept in the signature: the policy must not depend on it
        return true;
    }

    private function isStaff(string $role): bool
    {
        return in_array($role, ['doctor', 'admin', 'super_admin'], true);
    }

    /**
     * Resolve the material row. The material id is the only client selector; the
     * path and course are read from the row, never from the request.
     */
    private function loadMaterial(string $materialId): array
    {
        $base = 'SELECT id, lesson_id, course_id, file_name, file_type, storage_path,
                       permission, download_enabled, preview_enabled';
        $db = Database::instance();

        // `watermark_enabled` is NOT read: personalization is mandatory and the
        // legacy toggle must not influence delivery.
        //
        // The source-hash cache is used when present; the fallbacks keep a
        // partially applied migration 035 working (without the mtime column,
        // then without the cache columns at all).
        $attempts = [
            $base . ', file_hash, file_hash_path, file_hash_size, file_hash_mtime FROM lesson_materials WHERE id = ? LIMIT 1',
            $base . ', file_hash, file_hash_path, file_hash_size FROM lesson_materials WHERE id = ? LIMIT 1',
            $base . ' FROM lesson_materials WHERE id = ? LIMIT 1',
        ];

        $failedAll = true;
        foreach ($attempts as $sql) {
            try {
                $row = $db->row($sql, [$materialId]);
                $failedAll = false;
                if ($row === null) {
                    throw new ApiException(404, 'Material not found');
                }
                return $row;
            } catch (ApiException $e) {
                throw $e;
            } catch (\Throwable) {
                continue; // column not migrated yet — try the next shape
            }
        }

        if ($failedAll) {
            // Every attempt failed: report the schema problem instead of a 404.
            throw new ApiException(500, 'The lesson material could not be read.');
        }
        throw new ApiException(404, 'Material not found');
    }

    /** Mint a fresh token and describe a ready copy. */
    private function readyResponse(string $materialId, string $studentId, string $intent, int $pageCount, string $variantKey): array
    {
        unset($pageCount, $variantKey); // diagnostics only; never exposed
        $expires = time() + max(60, Config::int('MATERIAL_PDF_URL_TTL_SECONDS', self::DEFAULT_TTL_SECONDS));
        $token = $this->signToken($materialId, $studentId, $intent, $expires);
        $url = rtrim(Config::string('APP_URL'), '/') . '/materials/pdf?token=' . urlencode($token);

        return [
            'status' => 'ready',
            'state' => MaterialPdfQueueService::STATE_READY,
            'url' => $url,
            'expires_at' => gmdate('c', $expires),
            'intent' => $intent,
            'watermarked' => true,
            'material_id' => $materialId,
            'retry_after' => 0,
            'retry_allowed' => false,
            'reason' => null,
            'message' => 'Personalized watermarked copy.',
        ] + $this->waitFields([
            'eta_seconds' => 0,
            'eta_min_seconds' => 0,
            'eta_max_seconds' => 0,
            'eta_basis' => 'already_ready',
        ]);
    }

    /**
     * The wait-contract fields, in ONE place so pdf-url and pdf-status can never
     * disagree. A missing value is a null, never an absent key: the client only
     * has the state it was actually told about.
     *
     * Counts and durations only — nothing here identifies another student, another
     * document, or a storage path.
     */
    private function waitFields(array $status): array
    {
        return [
            'queue_position' => $status['queue_position'] ?? null,
            'jobs_ahead' => $status['jobs_ahead'] ?? null,
            'processing_now' => (int) ($status['processing_now'] ?? 0),
            'eta_seconds' => $status['eta_seconds'] ?? null,
            'eta_min_seconds' => $status['eta_min_seconds'] ?? null,
            'eta_max_seconds' => $status['eta_max_seconds'] ?? null,
            'eta_basis' => (string) ($status['eta_basis'] ?? 'unknown'),
            'eta_samples' => (int) ($status['eta_samples'] ?? 0),
        ];
    }

    /**
     * Map the queue's internal status onto the three-value client contract.
     * `queued` and `processing` are both "preparing" to an older client; the
     * finer distinction travels in `state`.
     */
    private function clientStatus(array $status): string
    {
        return $status['status'] === MaterialPdfQueueService::STATUS_FAILED ? 'failed' : 'preparing';
    }

    /**
     * Describe a copy that is not ready. Status is `preparing` while a job is
     * queued/processing and `failed` once attempts are exhausted; nothing here
     * ever names a path, an identity or a document.
     */
    private function pendingResponse(string $materialId, string $intent, array $status): array
    {
        $failed = $status['status'] === MaterialPdfQueueService::STATUS_FAILED;
        return [
            'status' => $failed ? 'failed' : 'preparing',
            'url' => null,
            'expires_at' => null,
            'intent' => $intent,
            'watermarked' => true,
            'material_id' => $materialId,
            'retry_after' => max(0, (int) ($status['retry_after'] ?? 10)),
            // A retry re-queues a permanently failed job; it is never offered for
            // a copy that is merely still queued or being generated.
            'retry_allowed' => $failed,
            'reason' => $status['reason'] ?? null,
            'state' => $status['state'] ?? ($failed
                ? MaterialPdfQueueService::STATE_FAILED
                : MaterialPdfQueueService::STATE_QUEUED),
            // The client shows localized copy from `state`; this is a fallback.
            'message' => $failed
                ? 'The personalized copy could not be prepared.'
                : 'Your personalized copy is being prepared.',
        ] + $this->waitFields($status);
    }

    /** Content-Disposition safe file name (no path, no control characters). */
    private function safeFileName(string $name): string
    {
        $name = basename(str_replace('\\', '/', $name));
        $name = (string) preg_replace('/[^A-Za-z0-9._ -]/', '_', $name);
        if ($name === '' || strtolower($name) === '.pdf') {
            $name = 'material.pdf';
        }
        return $name;
    }

    // ── Audit (ids and outcomes only; never names, tokens or bytes) ───────────

    private function auditDelivery(
        array $material,
        string $studentId,
        string $role,
        string $intent,
        int $pageCount,
        ?string $variantKey,
        Request $request
    ): void {
        try {
            AuditService::write($studentId, 'material_pdf_delivered', [
                'material_id' => (string) $material['id'],
                'course_id' => (string) ($material['course_id'] ?? ''),
                'lesson_id' => (string) ($material['lesson_id'] ?? ''),
                'role' => $role,
                'intent' => $intent,
                'watermarked' => 'yes',
                'page_count' => $pageCount,
                'variant' => $variantKey !== null ? substr($variantKey, 0, 12) : null,
                'description' => 'Personalized student PDF delivered',
            ], $request->clientIp());
        } catch (\Throwable $e) {
            // An audit failure must never block a legitimate read.
            error_log('[material-delivery] audit write failed: ' . $e->getMessage());
        }
    }

    /**
     * The machine-readable stage of a failed mint, taken from the exception's own
     * code (see PdfWatermarkService). Falls back to a coarse stage so an
     * untagged failure is still recorded rather than lost.
     */
    private function failureStage(ApiException $e): string
    {
        $code = $e->errors[0] ?? null;
        return is_string($code) && $code !== '' ? $code : 'mint';
    }

    private function auditFailure(array $material, string $userId, string $stage, ?ApiException $e): void
    {
        try {
            AuditService::write($userId, 'material_pdf_failed', [
                'material_id' => (string) $material['id'],
                'course_id' => (string) ($material['course_id'] ?? ''),
                'stage' => $stage,
                'status' => $e?->status,
                'reason' => $e !== null ? $e->getMessage() : 'unexpected_error',
                // The PREVIOUS exception is the real cause when the engine threw
                // (class + message only; no path, no stack, no document bytes).
                'cause' => $e?->getPrevious() !== null
                    ? get_class($e->getPrevious()) . ': ' . mb_substr($e->getPrevious()->getMessage(), 0, 300)
                    : null,
                'description' => 'Personalized PDF could not be produced; delivery was refused',
            ]);
        } catch (\Throwable) {
            // Never mask the original failure.
        }
    }

    // ── Token ─────────────────────────────────────────────────────────────────

    /** Mint rate ceiling per account per minute (0 disables the limiter). */
    private function mintPerMinute(): int
    {
        return max(0, Config::int('MATERIAL_PDF_MINT_PER_MINUTE', 60));
    }

    /** Status polls are cheaper than mints; they may be a little more frequent. */
    private function statusPerMinute(): int
    {
        return max(0, Config::int('MATERIAL_PDF_STATUS_PER_MINUTE', 120));
    }

    private function secret(): string
    {
        return Config::string(
            'MATERIAL_PDF_TOKEN_SECRET',
            Config::string('STORAGE_SIGNED_URL_SECRET', Config::string('JWT_SECRET'))
        );
    }

    /**
     * HMAC over material + student + intent + expiry. The bucket path and the
     * file name are NOT in the token, so the URL cannot be pointed at another
     * object even if someone tampers with the query string.
     */
    private function signToken(string $materialId, string $studentId, string $intent, int $expires): string
    {
        $body = implode('|', [$materialId, $studentId, $intent, (string) $expires]);
        $sig = hash_hmac('sha256', $body, $this->secret());
        return rtrim(strtr(base64_encode($body . '|' . $sig), '+/', '-_'), '=');
    }

    /**
     * Verify the token. Rejects a bad signature (403) and an expired token (410).
     * The body is re-split from the decoded payload, so a forged body cannot
     * survive without the signature.
     *
     * @return array{material_id:string,student_id:string,intent:string,expires:int}
     */
    private function verifyToken(string $token): array
    {
        if ($token === '') {
            throw new ApiException(403, 'Missing token');
        }
        $padded = strtr($token, '-_', '+/');
        $padded .= str_repeat('=', (4 - strlen($padded) % 4) % 4);
        $decoded = base64_decode($padded, true);
        if ($decoded === false) {
            throw new ApiException(403, 'Invalid token');
        }
        $parts = explode('|', $decoded);
        if (count($parts) !== 5) {
            throw new ApiException(403, 'Invalid token');
        }
        [$materialId, $studentId, $intent, $expiresRaw, $sig] = $parts;
        $expected = hash_hmac('sha256', implode('|', [$materialId, $studentId, $intent, $expiresRaw]), $this->secret());
        if (!hash_equals($expected, $sig)) {
            throw new ApiException(403, 'Invalid token');
        }
        $expires = (int) $expiresRaw;
        if ($expires < time()) {
            throw new ApiException(410, 'This link has expired. Reopen the material.');
        }
        return [
            'material_id' => $materialId,
            'student_id' => $studentId,
            'intent' => $intent === 'download' ? 'download' : 'view',
            'expires' => $expires,
        ];
    }
}
