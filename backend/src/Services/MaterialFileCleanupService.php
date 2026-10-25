<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Storage\StorageService;
use Throwable;

/**
 * MaterialFileCleanupService — the ONE place that deletes lesson-material bytes.
 *
 * ── WHY A SERVICE, NOT A LINE OF `unlink()` IN EACH CONTROLLER ──────────────
 * Deleting a material has four separate things to get right, and every path
 * that touched this (the app's delete, the app's replace, lesson delete,
 * section delete and course delete) got at least one of them wrong:
 *
 *   1. ORDER — database first, files last. The row is the authority; bytes are
 *      only removed once nothing points at them any more, and a failed
 *      filesystem operation must not make a committed delete look broken.
 *   2. THE GENERATED COPIES — `lesson_material_pdfs` rows hold watermarked
 *      per-student copies. They CASCADE away with the material row, so if you
 *      delete the row first you have already lost the only record of the files
 *      and they stay on disk forever. Hence snapshotMaterial() BEFORE the
 *      transaction.
 *   3. SHARED PATHS — two rows can name the same object. A path still referenced
 *      by any other material is never unlinked.
 *   4. CONTAINMENT — every unlink goes through StorageService::absolutePath(),
 *      which refuses `..`, refuses a resolved directory outside the storage
 *      root, and refuses a SYMLINKED object (an easy way to make the app delete
 *      `/etc/passwd`).
 *
 * ── FAILURE IS RECORDED, NOT SWALLOWED ──────────────────────────────────────
 * Database transactions cannot roll back a filesystem change, and this backend
 * runs on shared cPanel hosting where a queue worker does not exist. So a
 * failed delete is appended to `storage/private/.cleanup/queue.jsonl` and
 * `backend/scripts/storage-cleanup.php` retries it later (and can sweep for
 * orphans that were never queued, e.g. from before this service existed). No new
 * table, no daemon, no schema migration.
 *
 * Nothing here can throw out of a request path: a cleanup failure is reported
 * in the return value and logged, never turned into a 500 for a delete that
 * already committed.
 */
final class MaterialFileCleanupService
{
    /** Bucket that holds the doctor's original upload. */
    public const BUCKET = 'lesson-materials';

    /** Length of one queued-cleanup line (bounded so the file cannot grow unbounded per entry). */
    private const QUEUE_MAX_BYTES = 8 * 1024 * 1024;

    public function __construct(private readonly StorageService $storage = new StorageService())
    {
    }

    /** Bucket that holds the generated, watermarked per-student copies. */
    public static function variantBucket(): string
    {
        return PdfWatermarkService::BUCKET;
    }

    // ── Snapshots (taken BEFORE the rows are deleted) ────────────────────────

    /**
     * Everything that owns files for one material, or null when the row is gone.
     *
     * @return array{material_id:string,source:string,variants:array<int,string>,lesson_id:?string,course_id:?string}|null
     */
    public function snapshotMaterial(string $materialId): ?array
    {
        try {
            $row = Database::instance()->row(
                'SELECT id, lesson_id, course_id, storage_path FROM lesson_materials WHERE id = ? LIMIT 1',
                [$materialId]
            );
        } catch (Throwable) {
            return null;
        }
        return $row === null ? null : $this->snapshotFromRow($row);
    }

    /** @return array<int,array{material_id:string,source:string,variants:array<int,string>,lesson_id:?string,course_id:?string}> */
    public function snapshotLesson(string $lessonId): array
    {
        return $this->snapshotWhere('lesson_id = ?', [$lessonId]);
    }

    /** @return array<int,array{material_id:string,source:string,variants:array<int,string>,lesson_id:?string,course_id:?string}> */
    public function snapshotCourse(string $courseId): array
    {
        return $this->snapshotWhere('course_id = ?', [$courseId]);
    }

    /**
     * @param array<int,string> $materialIds
     * @return array<int,array{material_id:string,source:string,variants:array<int,string>,lesson_id:?string,course_id:?string}>
     */
    public function snapshotMaterials(array $materialIds): array
    {
        $materialIds = array_values(array_filter($materialIds, static fn ($v): bool => is_string($v) && $v !== ''));
        if ($materialIds === []) {
            return [];
        }
        $in = implode(',', array_fill(0, count($materialIds), '?'));
        return $this->snapshotWhere("id IN ({$in})", $materialIds);
    }

    /**
     * @param array<int,mixed> $params
     * @return array<int,array{material_id:string,source:string,variants:array<int,string>,lesson_id:?string,course_id:?string}>
     */
    private function snapshotWhere(string $where, array $params): array
    {
        try {
            $rows = Database::instance()->select(
                "SELECT id, lesson_id, course_id, storage_path FROM lesson_materials WHERE {$where}",
                $params
            );
        } catch (Throwable) {
            return [];
        }
        return array_map(fn (array $r): array => $this->snapshotFromRow($r), $rows);
    }

    /**
     * @param array<string,mixed> $row
     * @return array{material_id:string,source:string,variants:array<int,string>,lesson_id:?string,course_id:?string}
     */
    private function snapshotFromRow(array $row): array
    {
        $materialId = (string) ($row['id'] ?? '');
        $variants = [];
        try {
            foreach (Database::instance()->select(
                'SELECT storage_path FROM lesson_material_pdfs WHERE material_id = ?',
                [$materialId]
            ) as $variant) {
                $p = (string) ($variant['storage_path'] ?? '');
                if ($p !== '') {
                    $variants[] = $p;
                }
            }
        } catch (Throwable) {
            // Migration 032 not applied: there are no generated copies to retire.
        }

        return [
            'material_id' => $materialId,
            'source' => (string) ($row['storage_path'] ?? ''),
            'variants' => $variants,
            'lesson_id' => isset($row['lesson_id']) ? (string) $row['lesson_id'] : null,
            'course_id' => isset($row['course_id']) ? (string) $row['course_id'] : null,
        ];
    }

    // ── Retirement (called AFTER the database change committed) ─────────────

    /**
     * Reclaim every file owned by the given snapshots.
     *
     * @param array<int,array{material_id:string,source:string,variants:array<int,string>}> $snapshots
     * @return array{deleted:int,bytes:int,skipped:int,failed:array<int,array{bucket:string,path:string}>,queued:bool}
     */
    public function retire(array $snapshots, string $reason, ?string $actorId = null): array
    {
        $summary = ['deleted' => 0, 'bytes' => 0, 'skipped' => 0, 'failed' => [], 'queued' => false];

        foreach ($snapshots as $snapshot) {
            // 1. The watermarked copies are owned solely by this material.
            foreach (($snapshot['variants'] ?? []) as $variantPath) {
                $outcome = $this->deleteObject(self::variantBucket(), (string) $variantPath);
                $this->tally($summary, $outcome, (string) $variantPath, self::variantBucket());
            }
            // Their registry rows may still exist when the material row survived
            // (a replacement keeps the row but invalidates its old copies).
            try {
                Database::instance()->query(
                    'DELETE FROM lesson_material_pdfs WHERE material_id = ?',
                    [(string) ($snapshot['material_id'] ?? '')]
                );
            } catch (Throwable) {
                // table/columns absent — nothing to clear
            }

            // 2. The source object, unless another material still names it.
            $source = (string) ($snapshot['source'] ?? '');
            if ($source !== '') {
                if ($this->isReferencedElsewhere($source, (string) ($snapshot['material_id'] ?? ''))) {
                    $summary['skipped']++;
                } else {
                    $outcome = $this->deleteObject(self::BUCKET, $source);
                    $this->tally($summary, $outcome, $source, self::BUCKET);
                }
            }
        }

        if ($summary['failed'] !== []) {
            // Queue per BUCKET: a variant path is meaningless in the source bucket
            // (and vice versa), so a retry must know which root to resolve it in.
            $byBucket = [];
            foreach ($summary['failed'] as $failure) {
                $byBucket[$failure['bucket']][] = $failure['path'];
            }
            foreach ($byBucket as $bucket => $paths) {
                $queued = $this->enqueue([
                    'reason' => $reason,
                    'actor_id' => $actorId,
                    'bucket' => $bucket,
                    'paths' => $paths,
                    'material_ids' => array_values(array_map(
                        static fn (array $s): string => (string) ($s['material_id'] ?? ''),
                        $snapshots
                    )),
                ]);
                $summary['queued'] = $summary['queued'] || $queued;
            }
        }

        $this->log('retire', $reason, [
            'deleted' => $summary['deleted'],
            'bytes' => $summary['bytes'],
            'skipped' => $summary['skipped'],
            'failed' => count($summary['failed']),
            'queued' => $summary['queued'],
        ]);

        return $summary;
    }

    /**
     * Would deleting this object remove something still in use?
     *
     * Conservative on purpose: a database error means "probably in use", so the
     * file is kept and the cleanup is queued rather than losing a live document.
     */
    public function isReferencedElsewhere(string $storagePath, string $excludingMaterialId = ''): bool
    {
        if ($storagePath === '') {
            return false;
        }
        try {
            $n = (int) Database::instance()->value(
                'SELECT COUNT(*) FROM lesson_materials WHERE storage_path = ? AND id <> ?',
                [$storagePath, $excludingMaterialId],
                0
            );
            return $n > 0;
        } catch (Throwable) {
            return true;
        }
    }

    /**
     * Delete one object after containment checks. Returns
     * ['status' => deleted|skipped|failed, 'bytes' => int, 'reason' => string].
     *
     * Idempotent: a file that is already gone is a normal outcome, never an
     * error (a retried cleanup must not "fail" forever).
     *
     * @return array{status:string,bytes:int,reason:string}
     */
    public function deleteObject(string $bucket, string $relativePath): array
    {
        if ($relativePath === '') {
            return ['status' => 'skipped', 'bytes' => 0, 'reason' => 'empty_path'];
        }

        $abs = $this->storage->absolutePath($bucket, $relativePath);
        if ($abs === null) {
            // Refused (traversal, symlink, or a missing parent directory) or the
            // object is already gone. Nothing was deleted; never guess.
            return ['status' => 'skipped', 'bytes' => 0, 'reason' => 'outside_root_or_missing'];
        }
        if (!is_file($abs)) {
            return ['status' => 'skipped', 'bytes' => 0, 'reason' => 'missing'];
        }

        $bytes = (int) @filesize($abs);
        if (!@unlink($abs)) {
            return ['status' => 'failed', 'bytes' => 0, 'reason' => 'unlink_failed'];
        }
        return ['status' => 'deleted', 'bytes' => $bytes, 'reason' => 'ok'];
    }

    /** @param array{deleted:int,bytes:int,skipped:int,failed:array<int,array{bucket:string,path:string}>} $summary */
    private function tally(array &$summary, array $outcome, string $path, string $bucket): void
    {
        if ($outcome['status'] === 'deleted') {
            $summary['deleted']++;
            $summary['bytes'] += (int) $outcome['bytes'];
            return;
        }
        if ($outcome['status'] === 'failed') {
            $summary['failed'][] = ['bucket' => $bucket, 'path' => $path];
            return;
        }
        $summary['skipped']++;
    }

    // ── Retry queue (no cron required, no schema change) ─────────────────────

    /** `<private>/.cleanup/queue.jsonl` — outside every bucket, never served. */
    public function queuePath(): string
    {
        return rtrim($this->storage->privateDir(), '/\\') . '/.cleanup/queue.jsonl';
    }

    /**
     * Append one failed cleanup. Returns FALSE when even that failed (the caller
     * logs it; nothing else can be done on shared hosting).
     *
     * @param array<string,mixed> $entry
     */
    public function enqueue(array $entry): bool
    {
        $path = $this->queuePath();
        $dir = dirname($path);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return false;
        }
        if (is_file($path) && (int) @filesize($path) > self::QUEUE_MAX_BYTES) {
            return false;
        }
        $entry['id'] = bin2hex(random_bytes(8));
        $entry['at'] = gmdate('c');
        $entry['attempts'] = (int) ($entry['attempts'] ?? 0);
        $line = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($line === false) {
            return false;
        }
        return @file_put_contents($path, $line . "\n", FILE_APPEND | LOCK_EX) !== false;
    }

    /**
     * Queued cleanups, oldest first.
     *
     * @return array<int,array<string,mixed>>
     */
    public function pending(): array
    {
        $path = $this->queuePath();
        if (!is_file($path)) {
            return [];
        }
        $raw = (string) @file_get_contents($path);
        $out = [];
        foreach (explode("\n", $raw) as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            $decoded = json_decode($line, true);
            if (is_array($decoded)) {
                $out[] = $decoded;
            }
        }
        return $out;
    }

    /**
     * Retry every queued cleanup. Entries that still fail are re-queued with an
     * incremented attempt count; entries whose files are gone are dropped.
     *
     * @return array{attempted:int,deleted:int,bytes:int,remaining:int}
     */
    public function retryPending(int $maxAttempts = 20): array
    {
        $entries = $this->pending();
        $result = ['attempted' => 0, 'deleted' => 0, 'bytes' => 0, 'remaining' => 0];
        if ($entries === []) {
            return $result;
        }

        $keep = [];
        foreach ($entries as $entry) {
            $result['attempted']++;
            $bucket = (string) ($entry['bucket'] ?? self::BUCKET);
            $stillFailing = [];
            foreach ((array) ($entry['paths'] ?? []) as $p) {
                $outcome = $this->deleteObject($bucket, (string) $p);
                if ($outcome['status'] === 'deleted') {
                    $result['deleted']++;
                    $result['bytes'] += (int) $outcome['bytes'];
                } elseif ($outcome['status'] === 'failed') {
                    $stillFailing[] = (string) $p;
                }
                // 'skipped' (already gone / refused) is treated as resolved: there
                // is nothing left to reclaim and retrying forever helps nobody.
            }

            if ($stillFailing !== []) {
                $attempts = (int) ($entry['attempts'] ?? 0) + 1;
                if ($attempts < $maxAttempts) {
                    $entry['paths'] = $stillFailing;
                    $entry['attempts'] = $attempts;
                    $entry['last_attempt'] = gmdate('c');
                    $keep[] = $entry;
                } else {
                    $this->log('retry', 'give_up', ['id' => $entry['id'] ?? '', 'attempts' => $attempts]);
                }
            }
        }

        $this->writeQueue($keep);
        $result['remaining'] = count($keep);
        return $result;
    }

    /** @param array<int,array<string,mixed>> $entries */
    private function writeQueue(array $entries): void
    {
        $path = $this->queuePath();
        if ($entries === []) {
            @unlink($path);
            return;
        }
        $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
        $body = '';
        foreach ($entries as $entry) {
            $line = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($line !== false) {
                $body .= $line . "\n";
            }
        }
        if (@file_put_contents($tmp, $body, LOCK_EX) !== false && @rename($tmp, $path)) {
            return;
        }
        @unlink($tmp);
    }

    // ── Diagnostics ──────────────────────────────────────────────────────────

    /** Health of the cleanup mechanism, for the diagnostic script. */
    public function queueHealth(): array
    {
        $entries = $this->pending();
        $path = $this->queuePath();
        return [
            'queue_file' => 'private/.cleanup/queue.jsonl',
            'writable_dir' => is_dir(dirname($path))
                ? is_writable(dirname($path))
                : is_writable($this->storage->privateDir()),
            'pending' => count($entries),
            'oldest' => $entries === [] ? null : (string) ($entries[0]['at'] ?? ''),
            'reasons' => array_values(array_unique(array_map(
                static fn (array $e): string => (string) ($e['reason'] ?? 'unknown'),
                $entries
            ))),
        ];
    }

    /**
     * Files in the material buckets that NO database row references.
     *
     * Only a RECONCILIATION aid for the CLI tool: it never deletes anything
     * itself. `$graceSeconds` skips recently written files so an upload that is
     * still being registered is never reported (or removed) as an orphan.
     *
     * @return array<int,array{bucket:string,path:string,bytes:int,modified:int}>
     */
    public function scanOrphans(int $graceSeconds = 3600): array
    {
        $buckets = [
            self::BUCKET => ['table' => 'lesson_materials', 'column' => 'storage_path'],
            self::variantBucket() => ['table' => 'lesson_material_pdfs', 'column' => 'storage_path'],
        ];

        $orphans = [];
        foreach ($buckets as $bucket => $meta) {
            $root = $this->storage->privateDir() . '/' . $bucket;
            if (!is_dir($root)) {
                continue;
            }
            try {
                $known = [];
                foreach (Database::instance()->select("SELECT {$meta['column']} AS p FROM {$meta['table']}") as $row) {
                    $p = (string) ($row['p'] ?? '');
                    if ($p !== '') {
                        $known[$p] = true;
                    }
                }
            } catch (Throwable) {
                continue; // cannot prove anything without the registry
            }

            $it = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS | \FilesystemIterator::CURRENT_AS_FILEINFO),
                \RecursiveIteratorIterator::LEAVES_ONLY
            );
            foreach ($it as $info) {
                if (!$info->isFile()) {
                    continue;
                }
                $rel = ltrim(str_replace('\\', '/', substr($info->getPathname(), strlen($root))), '/');
                if (isset($known[$rel])) {
                    continue;
                }
                if (time() - (int) $info->getMTime() < $graceSeconds) {
                    continue;
                }
                $orphans[] = [
                    'bucket' => $bucket,
                    'path' => $rel,
                    'bytes' => (int) $info->getSize(),
                    'modified' => (int) $info->getMTime(),
                ];
            }
        }
        return $orphans;
    }

    private function log(string $stage, string $reason, array $context = []): void
    {
        try {
            \MedAcademy\Utils\Logger::instance()->info('material-cleanup', [
                'stage' => $stage,
                'reason' => $reason,
            ] + $context);
        } catch (Throwable) {
            // diagnostics must never break a cleanup
        }
    }
}
