<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Http\Response;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;

/**
 * MaterialDeliveryController — the ONLY path that serves a lesson PDF with the
 * teacher's watermark and download settings applied.
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
 * A personalized copy is never reachable any other way: the
 * `lesson-material-pdfs` bucket is absent from StorageController::PRIVATE_BUCKETS
 * and from canAccess(), so the storage endpoints refuse it outright.
 */
final class MaterialDeliveryController
{
    /** Short-lived by design — the app mints a fresh URL each time it opens. */
    private const DEFAULT_TTL_SECONDS = 300;

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
     * short-lived URL. Returns the ORIGINAL's URL only when watermarking is off
     * (or the caller is staff); when watermarking is ON this either returns a
     * personalized URL or FAILS — it never hands back the unwatermarked source.
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

        $userId = (string) $request->user['id'];
        $role = (string) $request->user['role'];

        $material = $this->loadMaterial($materialId);
        $forDownload = $intent === 'download';

        // Server-side authorization — the SAME routine the storage layer uses, so
        // there is exactly one place that decides material access.
        if (!$this->storage->canAccess($userId, $role, 'lesson-materials', (string) $material['storage_path'], $forDownload)) {
            throw new ApiException(403, 'Access denied');
        }

        $watermarked = $this->shouldWatermark($material, $role);
        if ($watermarked) {
            // Generate now (or reuse the cached variant). Throws 503 when no PDF
            // library is bundled — deliberately NOT falling back to the original.
            $this->ensurePersonalizedCopy($material, $userId);
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
                : 'Original document (watermarking disabled for this material).',
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

        $watermarked = $this->shouldWatermark($material, $role);
        $abs = null;
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
        } else {
            $abs = $this->storage->privateFilePath('lesson-materials', $this->storage->bucketPath('lesson-materials', (string) $material['storage_path']));
        }

        if (!is_file($abs)) {
            Response::error('File not found', 404, 'not_found');
        }

        // ATTACHMENT for an explicit download; INLINE for viewing. Either way the
        // bytes are the personalized copy when watermarking is on, and a document
        // is never rendered inline as active content (nosniff).
        $disposition = $forDownload ? 'attachment' : 'inline';
        $bytes = (string) file_get_contents($abs);

        Response::raw($bytes, 200, 'application/pdf', [
            'X-Content-Type-Options' => 'nosniff',
            'Cache-Control' => 'private, no-store',
            'Content-Disposition' => $disposition . '; filename="' . $this->safeFileName($fileName) . '"',
        ]);
    }

    /** Super-admin health surface for the watermarking capability. */
    public function watermarkStatus(Request $request): array
    {
        return $this->watermark->status();
    }

    // ──────────────────────────────────────────────────────────────────────────

    /**
     * True when THIS request must be served as a personalized copy: the material
     * has watermarking enabled AND the caller is a student. Staff preview the
     * original — they are not the audience the forensic mark identifies.
     */
    private function shouldWatermark(array $material, string $role): bool
    {
        if (!in_array($role, ['student'], true)) {
            return false;
        }
        return (int) ($material['watermark_enabled'] ?? 0) === 1;
    }

    /**
     * Resolve the material row. The material id is the only client selector; the
     * path and course are read from the row, never from the request.
     */
    private function loadMaterial(string $materialId): array
    {
        $row = Database::instance()->row(
            'SELECT id, lesson_id, course_id, file_name, file_type, storage_path,
                    permission, download_enabled, preview_enabled, watermark_enabled
               FROM lesson_materials WHERE id = ? LIMIT 1',
            [$materialId]
        );
        if ($row === null) {
            throw new ApiException(404, 'Material not found');
        }
        // A database that has not yet received migration 032 has no
        // `watermark_enabled` column; treat that as OFF so nothing changes.
        if (!array_key_exists('watermark_enabled', $row)) {
            $row['watermark_enabled'] = 0;
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
        $existing = $this->findPersonalizedCopy($material, $studentId);
        if ($existing !== null) {
            return $existing;
        }

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

        $sourceHash = $this->watermark->sourceHash($sourceAbs);
        $identityHash = hash('sha256', implode('|', $lines));
        // The engine + render settings are part of the cache identity, so a DPI
        // change or an engine switch regenerates instead of serving old bytes.
        $variantKey = $this->watermark->variantKey($sourceHash, $identityHash, $this->watermark->variantSettings($lines));

        $rel = $this->personalizedRelPath($material, $studentId, $variantKey);
        $finalAbs = $this->storage->privateFilePath(PdfWatermarkService::BUCKET, $rel);
        $partAbs = $finalAbs . '.' . bin2hex(random_bytes(6)) . '.part';

        // Render to a temp sibling, then publish atomically, so a concurrent
        // reader can never stream a half-written PDF. A failed generation must
        // not leave an orphaned .part behind.
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
        if (!@rename($partAbs, $finalAbs)) {
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

        return [
            'storage_path' => $rel,
            'source_hash' => $sourceHash,
            'variant_key' => $variantKey,
            'page_count' => $pages,
        ];
    }

    /**
     * The current, valid personalized copy for this student — or null. A row
     * whose source hash no longer matches the LIVE source is stale and is
     * treated as absent (so it is regenerated rather than served).
     */
    private function findPersonalizedCopy(array $material, string $studentId): ?array
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
        if (!$this->storage->privateFileExists(PdfWatermarkService::BUCKET, (string) $row['storage_path'])) {
            return null;
        }
        // Invalidate when the teacher replaced the source PDF.
        $sourceAbs = $this->storage->privateFilePath('lesson-materials', (string) $material['storage_path']);
        if (!is_file($sourceAbs) || $this->watermark->sourceHash($sourceAbs) !== (string) $row['source_hash']) {
            return null;
        }
        return $row;
    }

    /**
     * Non-guessable, per-student path. Never derived from the file name, so a
     * student cannot enumerate or guess another student's copy.
     */
    private function personalizedRelPath(array $material, string $studentId, string $variantKey): string
    {
        $courseId = preg_replace('/[^A-Za-z0-9-]/', '', (string) $material['course_id']) ?? '';
        $materialId = preg_replace('/[^A-Za-z0-9-]/', '', (string) $material['id']) ?? '';
        $safeStudent = preg_replace('/[^A-Za-z0-9-]/', '', $studentId) ?? '';
        return implode('/', array_filter([$courseId, $materialId, $safeStudent, $variantKey . '.pdf']));
    }

    /** Content-Disposition safe file name (no path, no control characters). */
    private function safeFileName(string $name): string
    {
        $name = basename(str_replace('\\', '/', $name));
        $name = (string) preg_replace('/[^A-Za-z0-9._ -]/', '_', $name);
        return $name !== '' ? $name : 'material.pdf';
    }

    // ── Token ─────────────────────────────────────────────────────────────────

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
