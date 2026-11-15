<?php

declare(strict_types=1);

/**
 * Removes expired personalized PDF copies from the private variant store.
 *
 * What is deleted: only the delivered copy file for a forensic issuance whose
 * `expires_at` has passed. The issuance row is kept (marked expired/purged) so the
 * forensic mapping, download history and audit trail survive, and the original
 * upload plus the master page images are never touched.
 *
 * Safe to run from cron on every tick: it is idempotent, bounded and refuses to
 * delete anything outside the variant bucket.
 *
 * Usage: php scripts/forensic-cleanup.php [--limit=500] [--dry-run]
 */

require __DIR__ . '/../src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Services\MaterialForensicPdfService;
use MedAcademy\Storage\StorageService;

$limit = 500;
$dryRun = false;
foreach (array_slice($argv, 1) as $arg) {
    if ($arg === '--dry-run') {
        $dryRun = true;
    } elseif (preg_match('/^--limit=(\d+)$/', $arg, $m) === 1) {
        $limit = max(1, min(5000, (int) $m[1]));
    }
}

$db = Database::instance();
$storage = new StorageService();

$rows = $db->select(
    'SELECT id, storage_path, student_id, material_id, expires_at
       FROM pdf_forensic_issuances
      WHERE purged_at IS NULL
        AND expires_at <= ?
      ORDER BY expires_at ASC
      LIMIT ' . $limit,
    [gmdate('Y-m-d H:i:s')]
);

$deleted = 0;
$missing = 0;
$failed = 0;

foreach ($rows as $row) {
    $rel = (string) ($row['storage_path'] ?? '');
    $removed = false;

    // Only ever touch a normalised relative path inside the variant bucket.
    if ($rel !== '' && strpos($rel, '..') === false && $rel[0] !== '/' && strpos($rel, '\\') === false) {
        try {
            if ($dryRun) {
                $removed = $storage->exists(MaterialForensicPdfService::BUCKET, $rel);
                echo "[dry-run] would purge {$rel}\n";
                continue;
            }
            $storage->delete(MaterialForensicPdfService::BUCKET, $rel);
            $removed = true;
        } catch (\Throwable $e) {
            $failed++;
            fwrite(STDERR, "purge failed for {$row['id']}: " . get_class($e) . "\n");
            continue;
        }
    }

    if (!$removed) {
        $missing++;
    }

    // Keep the row: the mapping is the evidence that this copy existed.
    $db->query(
        'UPDATE pdf_forensic_issuances
            SET status = ?, purged_at = ?, updated_at = ?
          WHERE id = ?',
        ['expired', gmdate('Y-m-d H:i:s'), gmdate('Y-m-d H:i:s'), (string) $row['id']]
    );
    $deleted++;
}

echo 'forensic-cleanup: purged=' . $deleted . ' already_missing=' . $missing . ' failed=' . $failed . "\n";
exit($failed > 0 ? 1 : 0);
