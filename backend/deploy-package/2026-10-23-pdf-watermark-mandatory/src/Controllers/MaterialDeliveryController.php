<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Http\Response;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Services\RateLimitService;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;

/**
 * MaterialDeliveryController — the ONLY path that serves a lesson PDF.
 *
 * ── POLICY: WATERMARKING IS MANDATORY FOR EVERY DELIVERY ──────────────────
 * Every delivery — student, doctor, admin — is a PERSONALIZED copy carrying the
 * caller's name and public account id. That keeps one observable behaviour for
 * everyone: a doctor who previews their own course (or opens a lesson PDF from
 * the lesson screen) receives exactly the bytes a student would, which is what
 * made "no watermark in the downloaded file" possible before.
 *
 * There is no per-material switch and no client option: `shouldWatermark()` is
 * unconditional. The legacy `lesson_materials.watermark_enabled` column is
 * deliberately ignored (see loadMaterial()), so a stale `0` — or a write
 * through the generic data API — cannot turn personalization off.
 *
 * ── WHY A TOKEN INSTEAD OF A SIGNED STORAGE URL ────────────────────────────
 * The app's PDF viewer needs a URL it can open without setting an Authorization
 * header, so a token is embedded in the URL. Unlike a plain `/storage/signed`
 * link, this token:
 *   • identifies the MATERIAL + STUDENT + INTENT, not a filesystem path, so the
 *     URL reveals nothing about storage and cannot be retargeted at another file;
 *   • is SHORT-LIVED (default 300 s);
 *   • is validated AT CONSUMPTION TIME against the CURRENT database state — the
 *     permission, download flag, enrollment and publication status are re-read
 *     on every stream. Setting a material to Preview Only (or hidden) therefore
 *     kills every previously issued link immediately, which a plain signed
 *     storage URL cannot do because it encodes only a path and an expiry.
 *
 * `/storage/signed-url` and `/storage/signed` REFUSE lesson-material PDFs, so
 * this endpoint is the only way those bytes can leave the server. A
 * personalized copy is additionally unreachable: the `lesson-material-pdfs`
 * bucket is absent from StorageController::PRIVATE_BUCKETS and from canAccess().
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────
 * If the renderer is unavailable, the source is unreadable, or the cached copy
 * vanished, the request FAILS (503/422). The unwatermarked original is never
 * served to a student as a fallback.
 */
final class MaterialDeliveryController
{
    /** Short-lived by design — the app mints a fresh URL each time it opens. */
    private const DEFAULT_TTL_SECONDS = 300;

    /** How long a single generation may wait for its per-variant lock. */
    private const LOCK_WAIT_SECONDS = 25;

    /**
     * `lesson_materials.file_hash*` only exists after migration 035. Until it is
     * applied the controller still works — it just hashes the source on every
     * request, exactly as before. Resolved once per request.
     */
    private ?bool $hashCacheAvailable = null;

    /** Migration 035 also added file_hash_mtime (same-size replacement guard). */
    private bool $hashMtimeAvailable = false;

    public function __construct(
        private readonly StorageService $storage = new StorageService(),
        private readonly PdfWatermarkService $watermark = new PdfWatermarkService(),
    ) {
    }

    /**
     * POST /materials/pdf-url
     * Body: { material_id, intent: 'view' | 'download' }
     *
     * Authorises the caller, ensures the correct variant exists, and returns a
     * short-lived URL. For a student this either returns a personalized URL or
     * FAILS — it never hands back the unwatermarked source.
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

        // Minting may trigger a full render, so it is throttled per ACCOUNT (an
        // account-scoped bucket is immune to shared carrier-NAT IPs). A normal
        // reader opens a handful of documents a minute; the ceiling only stops
        // a loop from queueing hundreds of renders.
        RateLimitService::perAccount($request, 'material_pdf_mint', $this->mintPerMinute(), 60);

        $userId = (string) $request->user['id'];
        $role = (string) $request->user['role'];

        $material = $this->loadMaterial($materialId);
        $forDownload = $intent === 'download';

        // Server-side authorization — the SAME routine the storage layer uses, so
        // there is exactly one place that decides material access.
        if (!$this->storage->canAccess($userId, $role, 'lesson-materials', (string) $material['storage_path'], $forDownload)) {
            throw new ApiException(403, 'Access denied');
        }

        $watermarked = $this->shouldWatermark($role);
        if ($watermarked) {
            // Generate now (or reuse the cached variant). Throws 503 when no PDF
            // library is bundled — deliberately NOT falling back to the original.
            try {
                $this->ensurePersonalizedCopy($material, $userId);
            } catch (ApiException $e) {
                $this->auditFailure($material, $userId, 'mint', $e);
                throw $e;
            } catch (\Throwable $e) {
                $this->auditFailure($material, $userId, 'mint', null);
                throw $e;
            }
        }

        $expires = time() + max(60, Config::int('MATERIAL_PDF_URL_TTL_SECONDS', self::DEFAULT_TTL_SECONDS));
        $token = $this->signToken($materialId, $userId, $intent, $expires);
        $url = rtrim(Config::string('APP_URL'), '/') . '/materials/pdf?token=' . urlencode($token);

        return [
            'url' => $url,
            'expires_at' => gmdate('c', $expires),
            'intent' => $intent,
            'watermarked' => $watermarked,
            'material_id' => $materialId,
            // Diagnostics only — never contains the path, the identity or a secret.
            'message' => $watermarked
                ? 'Personalized watermarked copy.'
                : 'Original document.',
        ];
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

        $watermarked = $this->shouldWatermark($role);
        $abs = null;
        $pageCount = 0;
        $variantKey = null;
        $fileName = (string) ($material['file_name'] ?? 'material.pdf');

        if ($watermarked) {
            $copy = $this->findPersonalizedCopy($material, $studentId);
            if ($copy === null) {
                // The cached file went missing between mint and stream. Never
                // serve the original — fail closed.
                Response::error('The personalized copy is not available.', 503, 'watermark_unavailable');
            }
            $abs = $this->storage->privateFilePath(PdfWatermarkService::BUCKET, (string) $copy['storage_path']);
            if (!is_file($abs)) {
                Response::error('The personalized copy is not available.', 503, 'watermark_unavailable');
            }
            $pageCount = (int) ($copy['page_count'] ?? 0);
            $variantKey = (string) ($copy['variant_key'] ?? '');
        } else {
            $abs = $this->storage->privateFilePath('lesson-materials', (string) $material['storage_path']);
        }

        if (!is_file($abs)) {
            Response::error('File not found', 404, 'not_found');
        }

        // Delivery audit: ids and outcomes only — never the name, the token or
        // any document content.
        $this->auditDelivery($material, $studentId, $role, $intent, $watermarked, $pageCount, $variantKey, $request);

        // ATTACHMENT for an explicit download; INLINE for viewing. Either way the
        // bytes are the personalized copy for a student, and a document is never
        // rendered inline as active content (nosniff).
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

    /** Super-admin health surface for the watermarking capability. */
    public function watermarkStatus(Request $request): array
    {
        return $this->watermark->status();
    }

    // ──────────────────────────────────────────────────────────────────────────

    /**
     * TRUE for every delivery, whatever the role.
     *
     * This is the whole policy. It intentionally does NOT look at the material,
     * at `watermark_enabled`, at a feature flag or at any request field: a doctor
     * cannot disable it, a stale database value cannot disable it, and a client
     * cannot ask for it to be skipped. Owner decision: the unwatermarked
     * original is never served from this endpoint to ANYONE, so what a doctor
     * downloads while reviewing their course is what a student downloads.
     */
    private function shouldWatermark(string $role): bool
    {
        unset($role); // kept in the signature: the policy must not depend on it
        return true;
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
        // legacy toggle must not influence delivery. The column is left in place
        // (dropping it is a destructive migration with no benefit).
        //
        // The source-hash cache is used when present. Two fallbacks keep a
        // partially applied migration 035 working instead of silently disabling
        // the cache: without the mtime column (size+path only), then without the
        // cache columns at all.
        $attempts = [
            $base . ', file_hash, file_hash_path, file_hash_size, file_hash_mtime FROM lesson_materials WHERE id = ? LIMIT 1' => true,
            $base . ', file_hash, file_hash_path, file_hash_size FROM lesson_materials WHERE id = ? LIMIT 1' => false,
            $base . ' FROM lesson_materials WHERE id = ? LIMIT 1' => null,
        ];
        $row = null;
        foreach ($attempts as $sql => $hasMtime) {
            try {
                $row = $db->row($sql, [$materialId]);
                $this->hashCacheAvailable = $hasMtime !== null;
                $this->hashMtimeAvailable = $hasMtime === true;
                break;
            } catch (\Throwable $e) {
                continue; // column not migrated yet
            }
        }

        if ($row === null && $this->hashCacheAvailable === null) {
            // Every attempt failed: report the schema problem instead of a 404.
            throw new ApiException(500, 'The lesson material could not be read.');
        }

        if ($row === null) {
            throw new ApiException(404, 'Material not found');
        }
        return $row;
    }

    /**
     * Ensure the personalized copy exists and is current, generating it when
     * needed. Reuse requires the SAME student, SAME source hash and SAME settings
     * — a replaced source or changed settings produces a new variant_key, so a
     * stale copy is never served.
     */
    private function ensurePersonalizedCopy(array $material, string $studentId): array
    {
        $sourceAbs = $this->storage->privateFilePath('lesson-materials', (string) $material['storage_path']);
        if (!is_file($sourceAbs)) {
            throw new ApiException(404, 'The source PDF is missing.');
        }

        // Identity from TRUSTED server-side records only.
        $profile = Database::instance()->row(
            'SELECT full_name, public_user_id FROM profiles WHERE id = ? LIMIT 1',
            [$studentId]
        );
        if ($profile === null) {
            throw new ApiException(403, 'Access denied');
        }
        $lines = $this->watermark->watermarkLines(
            (string) ($profile['full_name'] ?? ''),
            (string) ($profile['public_user_id'] ?? '')
        );

        $sourceHash = $this->sourceHashFor($material, $sourceAbs);
        $identityHash = hash('sha256', implode('|', $lines));
        // The engine + render settings are part of the cache identity, so an
        // engine switch or a tuned setting (vector opacity, DPI…) regenerates
        // instead of serving bytes produced by the previous configuration.
        $variantKey = $this->watermark->variantKey($sourceHash, $identityHash, $this->watermark->variantSettings($lines));

        // Fast path: a cached copy for EXACTLY this variant. Compared against
        // the live variant key (not merely the source hash) so a settings change
        // is honoured the next time the material is opened.
        $existing = $this->findPersonalizedCopy($material, $studentId, $variantKey);
        if ($existing !== null) {
            return $existing;
        }

        $rel = $this->personalizedRelPath($material, $studentId, $variantKey);
        $finalAbs = $this->storage->privateFilePath(PdfWatermarkService::BUCKET, $rel);

        // ── Concurrency: one render per (material, student, variant) ──
        // A second request for the same variant waits instead of rendering the
        // same document twice and racing on the same output path.
        return $this->withVariantLock($material, $studentId, $variantKey, function () use ($material, $studentId, $sourceAbs, $lines, $sourceHash, $variantKey, $rel, $finalAbs): array {
            // Double-checked: another worker may have finished while we waited.
            $now = $this->findPersonalizedCopy($material, $studentId);
            if ($now !== null && (string) ($now['variant_key'] ?? '') === $variantKey) {
                return $now;
            }

            $partAbs = $finalAbs . '.' . bin2hex(random_bytes(6)) . '.part';
            try {
                $pages = $this->watermark->personalize($sourceAbs, $lines, $partAbs);
            } catch (\Throwable $e) {
                @unlink($partAbs);
                throw $e;
            }

            $dir = dirname($finalAbs);
            if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
                @unlink($partAbs);
                throw new ApiException(500, 'Could not create the storage directory.');
            }
            // Atomic publication: a concurrent reader can only ever see a
            // complete file (rename is atomic on the same filesystem).
            if (!@rename($partAbs, $finalAbs)) {
                $why = error_get_last()['message'] ?? 'unknown error';
                // Stays server-side: the client only gets the actionable message.
                error_log('[material-delivery] could not publish the personalized PDF: ' . $why);
                @unlink($partAbs);
                throw new ApiException(500, 'Could not finalise the personalized PDF.');
            }

            $size = (int) @filesize($finalAbs);
            Database::instance()->query(
                'INSERT INTO lesson_material_pdfs
                    (id, material_id, student_id, source_hash, variant_key, storage_path, file_size, page_count)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE storage_path = VALUES(storage_path),
                                         file_size   = VALUES(file_size),
                                         page_count  = VALUES(page_count),
                                         updated_at  = CURRENT_TIMESTAMP(6)',
                [Uuid::v4(), (string) $material['id'], $studentId, $sourceHash, $variantKey, $rel, $size, $pages]
            );

            // Stale variants for the SAME student/material (previous source
            // version or engine settings) are unreachable now, so their bytes
            // are reclaimed. Files are only removed through a row that owns them
            // and whose path is validated below.
            $this->purgeStaleVariants($material, $studentId, $variantKey);

            return [
                'storage_path' => $rel,
                'source_hash' => $sourceHash,
                'variant_key' => $variantKey,
                'page_count' => $pages,
            ];
        });
    }

    /**
     * The current, valid personalized copy for this student — or null. A row
     * whose source hash no longer matches the LIVE source is stale and is
     * treated as absent (so it is regenerated rather than served).
     *
     * The source hash is CACHED on the material row, so this does not re-read
     * and re-hash the whole PDF on every open; the cache is keyed by
     * (path, size) so a replaced or re-uploaded file is detected and re-hashed.
     */
    private function findPersonalizedCopy(array $material, string $studentId, ?string $expectedVariantKey = null): ?array
    {
        $row = Database::instance()->row(
            'SELECT storage_path, source_hash, variant_key, page_count
               FROM lesson_material_pdfs
              WHERE material_id = ? AND student_id = ?
              ORDER BY updated_at DESC LIMIT 1',
            [(string) $material['id'], $studentId]
        );
        if ($row === null) {
            return null;
        }
        if ($expectedVariantKey !== null && (string) ($row['variant_key'] ?? '') !== $expectedVariantKey) {
            return null; // produced by different settings / an older source
        }
        if (!$this->storage->privateFileExists(PdfWatermarkService::BUCKET, (string) $row['storage_path'])) {
            return null;
        }
        // Invalidate when the teacher replaced the source PDF.
        $sourceAbs = $this->storage->privateFilePath('lesson-materials', (string) $material['storage_path']);
        if (!is_file($sourceAbs) || $this->sourceHashFor($material, $sourceAbs) !== (string) $row['source_hash']) {
            return null;
        }
        return $row;
    }

    /**
     * sha256 of the source PDF, cached on the material row.
     *
     * Hashing a 20 MB PDF on every single open is pure waste, so the digest is
     * persisted once (`lesson_materials.file_hash`) together with the path, the
     * byte size and the modification time it belongs to. Any change to any of
     * them — a replaced file, a re-upload that reuses a path, a restore from
     * backup — makes the cached digest unusable and it is recomputed.
     *
     * WHY MTIME AND NOT ONLY SIZE: an upload that replaces a document in place
     * with a same-length file (a corrected version of the same export is a very
     * ordinary case) would otherwise keep the old digest, and the cached
     * personalized copy of the OLD content would keep being served. The fresh
     * mtime makes that detectable without re-hashing on every request.
     */
    private function sourceHashFor(array $material, string $sourceAbs): string
    {
        $size = (int) @filesize($sourceAbs);
        $mtime = (int) @filemtime($sourceAbs);
        $storedPath = (string) ($material['file_hash_path'] ?? '');
        $storedHash = (string) ($material['file_hash'] ?? '');
        $storedSize = $material['file_hash_size'] ?? null;
        $storedMtime = $material['file_hash_mtime'] ?? null;

        if (
            $this->hashCacheAvailable !== false
            && $storedHash !== ''
            && $storedPath === (string) $material['storage_path']
            && $storedSize !== null
            && (int) $storedSize === $size
            && (!$this->hashMtimeAvailable || ($storedMtime !== null && (int) $storedMtime === $mtime))
        ) {
            return $storedHash;
        }

        $hash = $this->watermark->sourceHash($sourceAbs);

        if ($this->hashCacheAvailable !== false) {
            try {
                if ($this->hashMtimeAvailable) {
                    Database::instance()->query(
                        'UPDATE lesson_materials SET file_hash = ?, file_hash_path = ?, file_hash_size = ?, file_hash_mtime = ? WHERE id = ?',
                        [$hash, (string) $material['storage_path'], $size, $mtime, (string) $material['id']]
                    );
                } else {
                    Database::instance()->query(
                        'UPDATE lesson_materials SET file_hash = ?, file_hash_path = ?, file_hash_size = ? WHERE id = ?',
                        [$hash, (string) $material['storage_path'], $size, (string) $material['id']]
                    );
                }
            } catch (\Throwable) {
                // A cache write must never break delivery.
                $this->hashCacheAvailable = false;
            }
        }
        return $hash;
    }

    /**
     * Serialize generation per variant with an advisory file lock.
     *
     * `flock` is used rather than a database row lock because the shared host
     * runs PHP-FPM workers with no long-lived connection and the lock must be
     * released even if the worker dies (the OS closes the descriptor).
     *
     * @template T
     * @param callable():T $fn
     * @return T
     */
    private function withVariantLock(array $material, string $studentId, string $variantKey, callable $fn): mixed
    {
        $dir = $this->storage->privateDir() . '/.watermark-locks';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            // No lock directory: still better to render than to fail the read.
            return $fn();
        }
        $handle = @fopen($dir . '/' . hash('sha256', implode('|', [(string) $material['id'], $studentId, $variantKey])) . '.lock', 'c');
        if ($handle === false) {
            return $fn();
        }
        $deadline = microtime(true) + max(1, Config::int('PDF_WATERMARK_LOCK_WAIT_SECONDS', self::LOCK_WAIT_SECONDS));
        $locked = false;
        while (true) {
            if (flock($handle, LOCK_EX | LOCK_NB)) {
                $locked = true;
                break;
            }
            if (microtime(true) >= $deadline) {
                break;
            }
            usleep(120000);
        }
        if (!$locked) {
            fclose($handle);
            // The wait is bounded so a request cannot hang the worker; the
            // client retries and almost always hits the finished copy.
            throw new ApiException(503, 'This document is being prepared. Please try again in a moment.', 'watermark_busy');
        }
        try {
            return $fn();
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /**
     * Delete personalized copies of OTHER variants for the same student and
     * material (a replaced source, or an engine/settings change).
     *
     * Deliberately conservative: the row must exist, its path must live under
     * this material's own folder, and the file is only removed after the row is
     * gone. A missing row never causes a blind filesystem delete.
     */
    private function purgeStaleVariants(array $material, string $studentId, string $keepVariantKey): void
    {
        $rows = Database::instance()->select(
            'SELECT id, storage_path, variant_key FROM lesson_material_pdfs
              WHERE material_id = ? AND student_id = ? AND variant_key <> ?',
            [(string) $material['id'], $studentId, $keepVariantKey]
        );
        if ($rows === []) {
            return;
        }
        $prefix = $this->personalizedPrefix($material, $studentId);
        foreach ($rows as $row) {
            $path = (string) ($row['storage_path'] ?? '');
            // Ownership check: only files inside THIS material+student folder.
            if ($path === '' || !str_starts_with($path, $prefix) || str_contains($path, '..')) {
                continue;
            }
            Database::instance()->query('DELETE FROM lesson_material_pdfs WHERE id = ?', [(string) $row['id']]);
            $abs = $this->storage->privateFilePath(PdfWatermarkService::BUCKET, $path);
            if (is_file($abs)) {
                @unlink($abs);
            }
        }
    }

    /**
     * Non-guessable, per-student path. Never derived from the file name, so a
     * student cannot enumerate or guess another student's copy.
     */
    private function personalizedRelPath(array $material, string $studentId, string $variantKey): string
    {
        return $this->personalizedPrefix($material, $studentId) . $variantKey . '.pdf';
    }

    /** `{course}/{material}/{student}/` — the folder a copy must live in. */
    private function personalizedPrefix(array $material, string $studentId): string
    {
        $courseId = preg_replace('/[^A-Za-z0-9-]/', '', (string) $material['course_id']) ?? '';
        $materialId = preg_replace('/[^A-Za-z0-9-]/', '', (string) $material['id']) ?? '';
        $safeStudent = preg_replace('/[^A-Za-z0-9-]/', '', $studentId) ?? '';
        return implode('/', array_filter([$courseId, $materialId, $safeStudent])) . '/';
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
        bool $watermarked,
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
                'watermarked' => $watermarked ? 'yes' : 'no',
                'page_count' => $pageCount,
                'variant' => $variantKey !== null ? substr($variantKey, 0, 12) : null,
                'description' => $watermarked
                    ? 'Personalized student PDF delivered'
                    : 'Original PDF delivered to staff',
            ], $request->clientIp());
        } catch (\Throwable $e) {
            // An audit failure must never block a legitimate read.
            error_log('[material-delivery] audit write failed: ' . $e->getMessage());
        }
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
