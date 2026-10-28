<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;

/**
 * The ONE implementation of "produce (or reuse) this student's personalized copy
 * of this material".
 *
 * Both delivery paths use it:
 *   • MaterialDeliveryController::pdfUrl  — staff mint synchronously, students
 *     get a queued job; this class supplies the cache lookup either way.
 *   • MaterialPdfQueueService + the cron worker — generate one copy in the
 *     background, bounded per run.
 *
 * Moving it out of the controller (where it used to live as a set of private
 * methods) is deliberate: two copies of a watermarking routine would eventually
 * disagree about the cache identity, and a disagreement means serving a copy
 * that does not belong to the current source PDF.
 *
 * INVARIANTS
 *   • The file is rendered to a `.part` file, then renamed into place — a
 *     reader can only ever see a complete, verified document.
 *   • The registry row is written AFTER the bytes land; if the row write fails
 *     the file is removed so a retry starts clean.
 *   • A copy is only reused when student, source hash AND engine settings all
 *     still match (`variant_key`), so a replaced source is never served stale.
 *   • The unwatermarked source is never returned from here.
 */
final class MaterialPdfVariantService
{
    /** How long a generation may wait for its per-variant lock. */
    private const LOCK_WAIT_SECONDS = 25;

    /** Cached probe: does `lesson_materials.file_hash*` (migration 035) exist? */
    private ?bool $hashCacheAvailable = null;
    private bool $hashMtimeAvailable = false;

    public function __construct(
        private readonly StorageService $storage = new StorageService(),
        private readonly PdfWatermarkService $watermark = new PdfWatermarkService(),
    ) {
    }

    public function watermark(): PdfWatermarkService
    {
        return $this->watermark;
    }

    public function storage(): StorageService
    {
        return $this->storage;
    }

    // ── Identity ──────────────────────────────────────────────────────────────

    /** Absolute path of the private source PDF (may not exist). */
    public function sourcePath(array $material): string
    {
        return $this->storage->privateFilePath('lesson-materials', (string) ($material['storage_path'] ?? ''));
    }

    /**
     * The cache identity of one student's copy of one material:
     *   source_hash  — the exact bytes being personalized;
     *   variant_key  — sha256(source_hash + identity + engine/settings).
     *
     * Throws 404 when the source is gone and 403 when the student has no profile.
     * Identity comes from TRUSTED server-side records only.
     *
     * @return array{lines:array<int,string>,source_hash:string,identity_hash:string,variant_key:string}
     */
    public function identity(array $material, string $studentId): array
    {
        $sourceAbs = $this->sourcePath($material);
        if (!is_file($sourceAbs)) {
            throw new ApiException(404, 'The source PDF is missing.');
        }

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

        return [
            'lines' => $lines,
            'source_hash' => $sourceHash,
            'identity_hash' => $identityHash,
            'variant_key' => $this->watermark->variantKey(
                $sourceHash,
                $identityHash,
                $this->watermark->variantSettings($lines)
            ),
        ];
    }

    // ── Lookup / generation ───────────────────────────────────────────────────

    /**
     * Ensure the personalized copy exists and is current, generating it when
     * needed. Reuse requires the SAME student, SAME source hash and SAME
     * settings — a replaced source or changed settings produces a new
     * variant_key, so a stale copy is never returned.
     *
     * @return array{storage_path:string,source_hash:string,variant_key:string,page_count:int}
     */
    public function ensure(array $material, string $studentId): array
    {
        $identity = $this->identity($material, $studentId);
        $lines = $identity['lines'];
        $sourceHash = $identity['source_hash'];
        $variantKey = $identity['variant_key'];
        $sourceAbs = $this->sourcePath($material);

        // Fast path: a cached copy for EXACTLY this variant.
        $existing = $this->existing($material, $studentId, $variantKey);
        if ($existing !== null) {
            return $existing;
        }

        $rel = $this->relativePath($material, $studentId, $variantKey);
        $finalAbs = $this->storage->privateFilePath(PdfWatermarkService::BUCKET, $rel);

        // One render per (material, student, variant). A second worker or
        // request waits briefly and then reuses the finished file.
        return $this->withVariantLock($material, $studentId, $variantKey, function () use (
            $material,
            $studentId,
            $sourceAbs,
            $lines,
            $sourceHash,
            $variantKey,
            $rel,
            $finalAbs
        ): array {
            // Double-checked: another worker may have finished while we waited.
            $now = $this->existing($material, $studentId);
            if ($now !== null && (string) ($now['variant_key'] ?? '') === $variantKey) {
                return $now;
            }

            // ── HAND THE DATABASE SLOT BACK FOR THE RENDER ─────────────────
            // Everything above is database work (identity, the cached-copy
            // check, the double check inside the variant lock); everything below
            // until registerVariant() is file work — and rendering is the
            // slowest phase in the whole application (it can run for seconds on
            // a large document, and the cron worker may hold it for its entire
            // --max-seconds budget). On a host whose `max_user_connections` is
            // 50, holding the slot through a render is what starves concurrent
            // requests. registerVariant() reconnects lazily, so nothing else
            // here changes.
            Database::instance()->release();

            $partAbs = $finalAbs . '.' . bin2hex(random_bytes(6)) . '.part';
            try {
                $pages = $this->watermark->personalize($sourceAbs, $lines, $partAbs);
            } catch (\Throwable $e) {
                @unlink($partAbs);
                throw $e;
            }

            // The engine wrote a file: verify it before it can ever be served.
            $verified = $this->verifyOutput($partAbs);
            if (!$verified['ok']) {
                @unlink($partAbs);
                throw new ApiException(500, 'The personalized PDF failed validation.', $verified['code']);
            }

            $dir = dirname($finalAbs);
            if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
                @unlink($partAbs);
                throw new ApiException(500, 'Could not create the storage directory.', 'storage_unwritable');
            }
            // Atomic publication: a concurrent reader can only ever see a
            // complete file (rename is atomic on the same filesystem).
            if (!@rename($partAbs, $finalAbs)) {
                $why = error_get_last()['message'] ?? 'unknown error';
                error_log('[material-pdf] could not publish the personalized PDF: ' . $why);
                @unlink($partAbs);
                throw new ApiException(500, 'Could not finalise the personalized PDF.', 'publish_failed');
            }

            $size = (int) @filesize($finalAbs);
            try {
                $this->registerVariant($material, $studentId, $sourceHash, $variantKey, $rel, $size, $pages);
            } catch (\Throwable $e) {
                @unlink($finalAbs);
                error_log('[material-pdf] could not register the personalized PDF: ' . $e->getMessage());
                throw new ApiException(500, 'The personalized PDF could not be registered.', 'schema');
            }

            // Stale variants for the SAME student/material are unreachable now.
            $this->purgeStale($material, $studentId, $variantKey);

            return [
                'storage_path' => $rel,
                'source_hash' => $sourceHash,
                'variant_key' => $variantKey,
                'page_count' => $pages,
            ];
        });
    }

    /**
     * A rendered `.part` file is published only if it is a real, non-empty PDF
     * (header + EOF marker + parseable page count). A truncated file can never
     * reach the registry.
     *
     * @return array{ok:bool,code:string}
     */
    private function verifyOutput(string $absPath): array
    {
        if (!is_file($absPath)) {
            return ['ok' => false, 'code' => 'output_missing'];
        }
        if ((int) @filesize($absPath) < 1024) {
            return ['ok' => false, 'code' => 'output_missing'];
        }
        $size = (int) @filesize($absPath);
        $head = (string) @file_get_contents($absPath, false, null, 0, 5);
        if ($head !== '%PDF-') {
            return ['ok' => false, 'code' => 'render_failed'];
        }
        // A render that stopped early leaves a PREFIX of a document. Its trailer
        // is the cheap, parser-independent proof that the file is complete —
        // checked here so a truncated render can never be published.
        $tail = (string) @file_get_contents($absPath, false, null, max(0, $size - 4096));
        if (!str_contains($tail, '%%EOF')) {
            return ['ok' => false, 'code' => 'render_failed'];
        }
        return ['ok' => true, 'code' => ''];
    }

    /** Upsert the registry row for one personalized variant. */
    public function registerVariant(
        array $material,
        string $studentId,
        string $sourceHash,
        string $variantKey,
        string $rel,
        int $size,
        int $pages
    ): void {
        $db = Database::instance();
        $now = gmdate('Y-m-d H:i:s');
        $update = static fn (): int => $db->query(
            'UPDATE lesson_material_pdfs
                SET storage_path = ?, file_size = ?, page_count = ?, updated_at = ?
              WHERE material_id = ? AND student_id = ? AND variant_key = ?',
            [$rel, $size, $pages, $now, (string) $material['id'], $studentId, $variantKey]
        )->rowCount();

        // Update-then-insert instead of ON DUPLICATE KEY UPDATE: the same two
        // statements work on MySQL and on the SQLite the test harness injects,
        // and the registry's UNIQUE key still makes duplicates impossible. The
        // retry covers the (tiny) window where another worker inserted the row
        // between our UPDATE and our INSERT.
        if ($update() > 0) {
            return;
        }
        try {
            $db->query(
                'INSERT INTO lesson_material_pdfs
                    (id, material_id, student_id, source_hash, variant_key, storage_path, file_size, page_count, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [Uuid::v4(), (string) $material['id'], $studentId, $sourceHash, $variantKey, $rel, $size, $pages, $now, $now]
            );
        } catch (\PDOException) {
            // Another worker registered the same variant first; make sure the
            // path/size it produced is the one that stays.
            $update();
        }
    }

    /**
     * The current, valid personalized copy for this student — or null.
     *
     * A row whose source hash no longer matches the LIVE source is stale and is
     * treated as absent (regenerated rather than served). `$expectedVariantKey`
     * additionally rejects a copy produced by different engine settings.
     */
    public function existing(array $material, string $studentId, ?string $expectedVariantKey = null): ?array
    {
        $row = Database::instance()->row(
            'SELECT id, storage_path, source_hash, variant_key, page_count
               FROM lesson_material_pdfs
              WHERE material_id = ? AND student_id = ?
              ORDER BY updated_at DESC LIMIT 1',
            [(string) $material['id'], $studentId]
        );
        if ($row === null) {
            return null;
        }
        if ($expectedVariantKey !== null && (string) ($row['variant_key'] ?? '') !== $expectedVariantKey) {
            return null;
        }
        if (!$this->storage->privateFileExists(PdfWatermarkService::BUCKET, (string) $row['storage_path'])) {
            return null;
        }
        $sourceAbs = $this->sourcePath($material);
        if (!is_file($sourceAbs) || $this->sourceHashFor($material, $sourceAbs) !== (string) $row['source_hash']) {
            return null;
        }
        return $row;
    }

    /**
     * Fixed 24h retention from generation; do not reset the clock on download.
     */
    public function touchServed(array $copy): void
    {
        // No-op: expiration is fixed from generation time.
    }

    // ── Source hash ───────────────────────────────────────────────────────────

    /**
     * sha256 of the source PDF, cached on the material row.
     *
     * Hashing a 20 MB PDF on every open is waste, so the digest is persisted
     * once (`lesson_materials.file_hash`) with the path, byte size and mtime it
     * belongs to. Any change to any of them makes the cached digest unusable, so
     * a replaced (even same-length) source invalidates every copy of it.
     */
    public function sourceHashFor(array $material, string $sourceAbs): string
    {
        $this->probeHashColumns();

        $size = (int) @filesize($sourceAbs);
        $mtime = (int) @filemtime($sourceAbs);
        $storedPath = (string) ($material['file_hash_path'] ?? '');
        $storedHash = (string) ($material['file_hash'] ?? '');
        $storedSize = $material['file_hash_size'] ?? null;
        $storedMtime = $material['file_hash_mtime'] ?? null;

        if (
            $this->hashCacheAvailable === true
            && $storedHash !== ''
            && $storedPath === (string) ($material['storage_path'] ?? '')
            && $storedSize !== null
            && (int) $storedSize === $size
            && (!$this->hashMtimeAvailable || ($storedMtime !== null && (int) $storedMtime === $mtime))
        ) {
            return $storedHash;
        }

        $hash = $this->watermark->sourceHash($sourceAbs);

        if ($this->hashCacheAvailable === true) {
            try {
                if ($this->hashMtimeAvailable) {
                    Database::instance()->query(
                        'UPDATE lesson_materials SET file_hash = ?, file_hash_path = ?, file_hash_size = ?, file_hash_mtime = ? WHERE id = ?',
                        [$hash, (string) ($material['storage_path'] ?? ''), $size, $mtime, (string) $material['id']]
                    );
                } else {
                    Database::instance()->query(
                        'UPDATE lesson_materials SET file_hash = ?, file_hash_path = ?, file_hash_size = ? WHERE id = ?',
                        [$hash, (string) ($material['storage_path'] ?? ''), $size, (string) $material['id']]
                    );
                }
            } catch (\Throwable) {
                // A cache write must never break generation.
                $this->hashCacheAvailable = false;
            }
        }
        return $hash;
    }

    /** Detect migration 035's cache columns once per process. */
    private function probeHashColumns(): void
    {
        if ($this->hashCacheAvailable !== null) {
            return;
        }
        try {
            Database::instance()->query('SELECT file_hash, file_hash_path, file_hash_size FROM lesson_materials LIMIT 1');
            $this->hashCacheAvailable = true;
        } catch (\Throwable) {
            $this->hashCacheAvailable = false;
            return;
        }
        try {
            Database::instance()->query('SELECT file_hash_mtime FROM lesson_materials LIMIT 1');
            $this->hashMtimeAvailable = true;
        } catch (\Throwable) {
            $this->hashMtimeAvailable = false;
        }
    }

    // ── Concurrency ───────────────────────────────────────────────────────────

    /**
     * Serialize generation per variant with an advisory file lock.
     *
     * `flock` is used rather than a database row lock because the shared host
     * runs PHP-FPM with no long-lived connection and the lock is released even
     * if the process dies (the OS closes the descriptor).
     *
     * @template T
     * @param callable():T $fn
     * @return T
     */
    public function withVariantLock(array $material, string $studentId, string $variantKey, callable $fn): mixed
    {
        $dir = $this->storage->privateDir() . '/.watermark-locks';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return $fn();
        }
        $handle = @fopen($dir . '/' . $this->lockName($material, $studentId, $variantKey), 'c');
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
            throw new ApiException(503, 'This document is being prepared. Please try again in a moment.', 'watermark_busy');
        }
        try {
            return $fn();
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /** Advisory lock file name for one variant (no identity leaks into it). */
    public function lockName(array $material, string $studentId, string $variantKey): string
    {
        return hash('sha256', implode('|', [(string) $material['id'], $studentId, $variantKey])) . '.lock';
    }

    // ── Paths / cleanup ───────────────────────────────────────────────────────

    /**
     * Delete personalized copies of OTHER variants for the same student and
     * material (a replaced source, or an engine/settings change).
     *
     * Deliberately conservative: the row must exist, its path must live under
     * this material's own folder, and the file is only removed after the row is
     * gone. A missing row never causes a blind filesystem delete.
     */
    public function purgeStale(array $material, string $studentId, string $keepVariantKey): void
    {
        $rows = Database::instance()->select(
            'SELECT id, storage_path, variant_key FROM lesson_material_pdfs
              WHERE material_id = ? AND student_id = ? AND variant_key <> ?',
            [(string) $material['id'], $studentId, $keepVariantKey]
        );
        if ($rows === []) {
            return;
        }
        $prefix = $this->prefix($material, $studentId);
        foreach ($rows as $row) {
            $path = (string) ($row['storage_path'] ?? '');
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
    public function relativePath(array $material, string $studentId, string $variantKey): string
    {
        return $this->prefix($material, $studentId) . $variantKey . '.pdf';
    }

    /** `{course}/{material}/{student}/` — the folder a copy must live in. */
    public function prefix(array $material, string $studentId): string
    {
        $courseId = preg_replace('/[^A-Za-z0-9-]/', '', (string) ($material['course_id'] ?? '')) ?? '';
        $materialId = preg_replace('/[^A-Za-z0-9-]/', '', (string) $material['id']) ?? '';
        $safeStudent = preg_replace('/[^A-Za-z0-9-]/', '', $studentId) ?? '';
        return implode('/', array_filter([$courseId, $materialId, $safeStudent])) . '/';
    }
}
