<?php

declare(strict_types=1);

/**
 * storage-cleanup.php — retry failed material-file deletions and find orphaned
 * files in the private material buckets.
 *
 *   php backend/scripts/storage-cleanup.php                 # report only (safe)
 *   php backend/scripts/storage-cleanup.php --list           # same
 *   php backend/scripts/storage-cleanup.php --retry          # drain the queue
 *   php backend/scripts/storage-cleanup.php --orphans        # list orphans only
 *   php backend/scripts/storage-cleanup.php --delete-orphans --yes [--grace=3600]
 *
 * WHY THIS EXISTS
 * ---------------
 * Deleting or replacing a lesson material commits the database change first and
 * removes the files afterwards — the correct order, but it means a filesystem
 * failure cannot roll back the row. Those failures are appended to
 * `storage/private/.cleanup/queue.jsonl` by MaterialFileCleanupService instead of
 * being lost (there is no queue worker on shared cPanel hosting).
 *
 * A file is only ever removed when NO `lesson_materials` / `lesson_material_pdfs`
 * row references it, it resolves INSIDE the private storage root, it is not a
 * symlink, and it is older than the grace period (so an upload that is still
 * being registered is never mistaken for garbage).
 *
 * OPERATOR-ONLY: refuses a web SAPI, prints no document content and no secret,
 * and never touches the public storage root.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Services\MaterialFileCleanupService;

$args = $argv ?? [];
$flag = static function (string $name) use ($args): bool {
    return in_array($name, $args, true);
};
$option = static function (string $name, int $default) use ($args): int {
    foreach ($args as $a) {
        if (str_starts_with((string) $a, $name . '=')) {
            return (int) substr((string) $a, strlen($name) + 1);
        }
    }
    return $default;
};

$cleanup = new MaterialFileCleanupService();

$retry = $flag('--retry');
$listOrphans = $flag('--orphans');
$deleteOrphans = $flag('--delete-orphans');
$confirmed = $flag('--yes');
$grace = max(0, $option('--grace', 3600));

$out = [
    'queue' => $cleanup->queueHealth(),
    'actions' => [],
];

if ($retry) {
    $out['actions'][] = ['retry' => $cleanup->retryPending()];
    $out['queue'] = $cleanup->queueHealth();
}

if ($listOrphans || $deleteOrphans) {
    $orphans = $cleanup->scanOrphans($grace);
    $out['orphans'] = [
        'count' => count($orphans),
        'bytes' => array_sum(array_map(static fn (array $o): int => (int) $o['bytes'], $orphans)),
        'grace_seconds' => $grace,
        'files' => $orphans,
    ];

    if ($deleteOrphans) {
        if (!$confirmed) {
            $out['actions'][] = [
                'delete_orphans' => 'refused — pass --yes to confirm (this unlinks files)',
            ];
        } else {
            $deleted = 0;
            $bytes = 0;
            $failedByBucket = [];
            foreach ($orphans as $orphan) {
                $bucket = (string) $orphan['bucket'];
                $outcome = $cleanup->deleteObject($bucket, (string) $orphan['path']);
                if ($outcome['status'] === 'deleted') {
                    $deleted++;
                    $bytes += (int) $outcome['bytes'];
                } elseif ($outcome['status'] === 'failed') {
                    $failedByBucket[$bucket][] = (string) $orphan['path'];
                }
            }
            // Nothing else can reclaim these; record them per bucket so the next
            // run (or a human) sees them instead of silently leaking storage.
            foreach ($failedByBucket as $bucket => $paths) {
                $cleanup->enqueue([
                    'reason' => 'orphan_delete',
                    'bucket' => $bucket,
                    'paths' => $paths,
                    'material_ids' => [],
                ]);
            }
            $out['actions'][] = [
                'delete_orphans' => [
                    'deleted' => $deleted,
                    'bytes' => $bytes,
                    'failed' => array_sum(array_map('count', $failedByBucket)),
                ],
            ];
            unset($failedByBucket);
        }
    }
}

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), PHP_EOL;
exit(0);
