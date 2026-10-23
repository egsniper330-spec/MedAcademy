<?php

declare(strict_types=1);

/**
 * watermark-cleanup.php — reclaim personalized PDF copies that nothing can
 * reach any more, and repair the registry when a file vanishes.
 *
 * Run from cron (see backend/docs/PDF_WATERMARK_DEPLOYMENT.md):
 *
 *   php backend/scripts/watermark-cleanup.php            # dry run, prints a plan
 *   php backend/scripts/watermark-cleanup.php --apply    # actually deletes
 *
 * WHAT IT CLEANS
 *   1. REGISTRY ROWS WITH A MISSING FILE — the copy was deleted out of band
 *      (manual cleanup, restore, failed storage move). The row is removed so the
 *      next request regenerates instead of failing closed forever.
 *   2. ORPHANED FILES — a `.pdf` inside the `lesson-material-pdfs` bucket with
 *      NO registry row pointing at it, and older than the grace period. These
 *      come from a crash between publication and the row write.
 *   3. STALE VARIANTS — copies whose `source_hash` no longer matches the source
 *      PDF (the doctor replaced it). Generation already purges these for the
 *      student who opens the document; this sweeps the ones nobody opened.
 *
 * SAFETY
 *   • Dry run unless --apply is given.
 *   • Only ever touches files UNDER the `lesson-material-pdfs` bucket root.
 *   • Only `.pdf` files outside the grace window; `.part` files and directories
 *     are never touched (an upload may be in flight).
 *   • A file is deleted only after its row (if any) has been removed, and the
 *     path must still resolve inside the bucket (path-traversal guard).
 *   • Prints counts and freed bytes; exits non-zero only on a real error.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Storage\StorageService;

$apply = in_array('--apply', $argv, true);
$graceSeconds = (int) (getenv('PDF_WATERMARK_CLEANUP_GRACE_SECONDS') ?: 86400);
$now = time();

$storage = new StorageService();
$bucketRoot = rtrim($storage->privateFilePath(PdfWatermarkService::BUCKET, ''), '/\\');
$stats = ['rows_missing_file' => 0, 'orphan_files' => 0, 'stale_variants' => 0, 'bytes_freed' => 0, 'errors' => 0];

echo "MedAcademy personalized-PDF cleanup\n";
echo 'mode: ' . ($apply ? 'APPLY' : 'DRY RUN (pass --apply to delete)') . "\n";
echo 'bucket: ' . PdfWatermarkService::BUCKET . "\n\n";

/**
 * Resolve a stored object path to an absolute file that is provably inside the
 * bucket. Returns null for anything else (traversal, absolute paths, symlink
 * escapes) so a corrupt registry row can never delete an unrelated file.
 */
$resolve = static function (string $relPath) use ($storage, $bucketRoot): ?string {
    if ($relPath === '' || str_contains($relPath, '..')) {
        return null;
    }
    $abs = $storage->privateFilePath(PdfWatermarkService::BUCKET, $relPath);
    $realRoot = realpath($bucketRoot);
    $realDir = realpath(dirname($abs));
    if ($realRoot === false || $realDir === false || !str_starts_with($realDir, $realRoot)) {
        return null;
    }
    return $abs;
};

// ── 1. Registry rows whose file is gone ────────────────────────────────────
$rows = Database::instance()->select(
    'SELECT id, material_id, student_id, storage_path FROM lesson_material_pdfs'
);
foreach ($rows as $row) {
    $abs = $resolve((string) $row['storage_path']);
    if ($abs !== null && is_file($abs)) {
        continue;
    }
    $stats['rows_missing_file']++;
    if ($apply) {
        try {
            Database::instance()->query('DELETE FROM lesson_material_pdfs WHERE id = ?', [(string) $row['id']]);
        } catch (\Throwable $e) {
            $stats['errors']++;
            fwrite(STDERR, "row {$row['id']}: " . $e->getMessage() . "\n");
        }
    }
}

// ── 2 & 3. Walk the bucket for orphans and stale variants ──────────────────
/** @var array<string,array{id:string,source_hash:string}> $byPath */
$byPath = [];
foreach (Database::instance()->select('SELECT id, storage_path, source_hash FROM lesson_material_pdfs') as $row) {
    $byPath[(string) $row['storage_path']] = $row;
}

/** Current source hash per material, for the staleness check. */
$materialHash = static function (string $materialId): ?string {
    try {
        $row = Database::instance()->row(
            'SELECT storage_path, file_hash, file_hash_path, file_hash_size FROM lesson_materials WHERE id = ? LIMIT 1',
            [$materialId]
        );
    } catch (\Throwable) {
        return null; // migration 035 not applied — skip staleness detection
    }
    if ($row === null) {
        return null;
    }
    if (
        !empty($row['file_hash'])
        && (string) $row['file_hash_path'] === (string) $row['storage_path']
    ) {
        return (string) $row['file_hash'];
    }
    return null;
};

if (is_dir($bucketRoot)) {
    $it = new \RecursiveIteratorIterator(
        new \RecursiveDirectoryIterator($bucketRoot, \FilesystemIterator::SKIP_DOTS),
        \RecursiveIteratorIterator::LEAVES_ONLY
    );
    $prefixLen = strlen($bucketRoot) + 1;
    foreach ($it as $file) {
        /** @var \SplFileInfo $file */
        if (!$file->isFile() || strtolower($file->getExtension()) !== 'pdf') {
            continue; // .part files, locks and directories are never touched
        }
        $abs = $file->getPathname();
        $rel = str_replace('\\', '/', substr($abs, $prefixLen));
        $age = $now - (int) $file->getMTime();
        if ($age < $graceSeconds) {
            continue;
        }

        $row = $byPath[$rel] ?? null;
        $reason = null;
        if ($row === null) {
            $reason = 'orphan file (no registry row)';
            $stats['orphan_files']++;
        } else {
            // Stale variant: the row exists but its source_hash is out of date.
            $meta = Database::instance()->row(
                'SELECT material_id, source_hash FROM lesson_material_pdfs WHERE storage_path = ? LIMIT 1',
                [$rel]
            );
            if ($meta !== null) {
                $current = $materialHash((string) $meta['material_id']);
                if ($current !== null && $current !== (string) $meta['source_hash']) {
                    $reason = 'stale variant (source PDF replaced)';
                    $stats['stale_variants']++;
                }
            }
        }

        if ($reason === null) {
            continue;
        }
        $stats['bytes_freed'] += (int) $file->getSize();
        echo '  - ' . $rel . '  (' . $reason . ", " . $age . "s old)\n";

        if (!$apply) {
            continue;
        }
        try {
            Database::instance()->query('DELETE FROM lesson_material_pdfs WHERE storage_path = ?', [$rel]);
            if (!@unlink($abs)) {
                $stats['errors']++;
                fwrite(STDERR, "could not delete {$abs}\n");
            }
        } catch (\Throwable $e) {
            $stats['errors']++;
            fwrite(STDERR, "{$rel}: " . $e->getMessage() . "\n");
        }
    }
}

// ── Report ──────────────────────────────────────────────────────────────────
echo "\n";
echo 'rows with a missing file : ' . $stats['rows_missing_file'] . "\n";
echo 'stale variants           : ' . $stats['stale_variants'] . "\n";
echo 'orphan files             : ' . $stats['orphan_files'] . "\n";
echo 'bytes reclaimed          : ' . $stats['bytes_freed'] . ' (' . round($stats['bytes_freed'] / 1048576, 2) . " MB)\n";
echo 'errors                   : ' . $stats['errors'] . "\n";
echo $apply ? "\nApplied.\n" : "\nDry run only — nothing was deleted.\n";

exit($stats['errors'] > 0 ? 1 : 0);
