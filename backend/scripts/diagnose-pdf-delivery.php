<?php

declare(strict_types=1);

/**
 * diagnose-pdf-delivery.php — WHY a student PDF download says
 * "تعذّر تجهيز نسختك المخصّصة" (the personalized copy could not be prepared).
 *
 * The app only ever receives a generic message for a refused mint, so the
 * failing component has to be identified on the server. This script walks the
 * SAME stages the controller walks and stops at the first one that fails,
 * printing its name plus the exception class / API code — never a document
 * byte, a token, a name or a student id.
 *
 *   php backend/scripts/diagnose-pdf-delivery.php                 # environment only
 *   php backend/scripts/diagnose-pdf-delivery.php <material_id>   # full pipeline
 *
 * Exit code 0 = every exercised stage passed; 1 = the named stage failed.
 * OPERATOR-ONLY: refuses a web SAPI and lives outside the document root.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;

$report = [
    'stages' => [],
    'notes'  => [],
];

/**
 * Run one stage, record the outcome, and stop the whole run on failure.
 *
 * @param callable():mixed $fn
 */
$stage = function (string $name, callable $fn) use (&$report): mixed {
    try {
        $detail = $fn();
        $report['stages'][] = ['stage' => $name, 'ok' => true, 'detail' => $detail];
        return $detail;
    } catch (\Throwable $e) {
        $report['stages'][] = [
            'stage'   => $name,
            'ok'      => false,
            'class'   => get_class($e),
            'message' => $e->getMessage(),
            'http'    => $e instanceof ApiException ? $e->status : null,
            'code'    => $e instanceof ApiException ? ($e->errors[0] ?? null) : null,
        ];
        echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), PHP_EOL;
        fwrite(STDERR, PHP_EOL . 'STOPPED at stage: ' . $name . ' (' . get_class($e) . ')' . PHP_EOL);
        exit(1);
    }
};

$materialId = isset($argv[1]) ? trim((string) $argv[1]) : '';
$service    = new PdfWatermarkService();
$storage    = new StorageService();

// ── 1. Storage roots ────────────────────────────────────────────────────────
$stage('storage_roots', function () use ($storage): array {
    $private = $storage->privateDir();
    return [
        'exists'    => is_dir($private),
        'writable'  => is_dir($private) && is_writable($private),
        'relative'  => (string) preg_replace('#^' . preg_quote(MEDACADEMY_BASE, '#') . '#', '', $private),
    ];
});

// ── 2. Engine (this is the 503 'engine_unavailable' gate) ───────────────────
$status = $stage('engine', function () use ($service): array {
    return [
        'available'       => $service->isAvailable(),
        'driver'          => $service->driver(),
        'configured_mode' => Config::string('PDF_WATERMARK_MODE', 'auto'),
        'effective_mode'  => $service->effectiveMode(),
        'vector'          => $service->rendererStatus()['vector'],
        'flatten'         => $service->rendererStatus()['flatten'],
        'flatten_ready'   => $service->rendererStatus()['flatten']['ready'],
    ];
});
if (($status['available'] ?? false) !== true) {
    fwrite(STDERR, 'No engine is available — run watermark-diagnostics.php for the missing piece.' . PHP_EOL);
    echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), PHP_EOL;
    exit(1);
}

if ($materialId === '') {
    $report['notes'][] = 'Pass a material id to exercise database, source and render stages.';
    echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), PHP_EOL;
    exit(0);
}

// ── 3. Database: the material row (and whether the 035 cache columns exist) ─
$material = $stage('material_row', function () use ($materialId): array {
    $db  = Database::instance();
    $sql = 'SELECT id, lesson_id, course_id, file_name, file_type, storage_path,
                   permission, download_enabled, preview_enabled,
                   file_hash, file_hash_path, file_hash_size, file_hash_mtime
              FROM lesson_materials WHERE id = ? LIMIT 1';
    try {
        $row = $db->row($sql, [$materialId]);
    } catch (\Throwable $e) {
        // Migration 035 not applied — the controller falls back to hashing the
        // source on every request, so this is a NOTE, not a failure.
        $row = $db->row(
            'SELECT id, lesson_id, course_id, file_name, file_type, storage_path,
                    permission, download_enabled, preview_enabled
               FROM lesson_materials WHERE id = ? LIMIT 1',
            [$materialId]
        );
        if ($row === null) {
            throw new ApiException(404, 'Material not found', 'material_missing', $e);
        }
        return ['row' => $row, 'file_hash_columns' => 'absent (migration 035 not applied — slower, still works)'];
    }
    if ($row === null) {
        throw new ApiException(404, 'Material not found', 'material_missing');
    }
    return ['row' => $row, 'file_hash_columns' => 'present'];
});

$row = $material['row'];

// ── 4. Source file ──────────────────────────────────────────────────────────
// Reports the RESOLVED ABSOLUTE PATH, the byte count and whether the document
// parses. Operator-only output (this script refuses a web SAPI), so a path here
// cannot leak to a student.
$sourceAbs = $stage('source_file', function () use ($storage, $row): array {
    $rel = (string) ($row['storage_path'] ?? '');
    $abs = $storage->privateFilePath('lesson-materials', $rel);
    if (!is_file($abs)) {
        throw new ApiException(404, 'The source file is missing on disk.', 'source_missing');
    }
    $size = (int) @filesize($abs);
    if ($size <= 0) {
        // THIS is the zero-byte upload: the row exists, the object exists, and
        // it holds nothing. The upload handler now refuses to store such a body
        // (UploadIntegrityService) — an existing 0-byte object therefore
        // predates that fix, or was written by something outside the API.
        throw new ApiException(
            422,
            'The stored file is 0 bytes. The upload never persisted any bytes, so there is nothing to watermark. '
            . 'Re-upload the document after deploying the storage-upload integrity fix '
            . '(UploadIntegrityService + POST /storage/upload).',
            'source_unreadable'
        );
    }
    return [
        'absolute_path' => $abs,
        'storage_path' => $rel,
        'bytes' => $size,
        'readable' => is_readable($abs),
        'recorded_file_size' => isset($row['file_size']) ? (int) $row['file_size'] : null,
        'size_matches_record' => !isset($row['file_size']) || (int) $row['file_size'] === $size,
    ];
});

// ── 4b. The document itself (same validation the upload path applies) ────────
$stage('source_pdf_valid', function () use ($service, $sourceAbs): array {
    $inspected = $service->inspect((string) $sourceAbs['absolute_path']);
    return [
        'page_count' => $inspected['page_count'],
        'bytes' => $inspected['size'],
        'encrypted' => false,
    ];
});

// ── 4c. Cached source digest vs the bytes on disk ───────────────────────────
// A stale cache is not fatal (the next delivery re-digests), but a MISMATCH on
// path/size/mtime means the cache is describing a different object — which is
// exactly what a failed replacement used to leave behind.
$stage('hash_cache', function () use ($sourceAbs, $row): array {
    $abs = (string) $sourceAbs['absolute_path'];
    $actualSize = (int) @filesize($abs);
    $actualMtime = (int) @filemtime($abs);
    $recordedHash = (string) ($row['file_hash'] ?? '');
    $out = [
        'cache_present' => $recordedHash !== '',
        'recorded_size' => isset($row['file_hash_size']) ? (int) $row['file_hash_size'] : null,
        'actual_size' => $actualSize,
        'size_matches' => !isset($row['file_hash_size']) || (int) $row['file_hash_size'] === $actualSize,
        'path_matches' => !isset($row['file_hash_path']) || (string) $row['file_hash_path'] === (string) $sourceAbs['storage_path'],
        'mtime_matches' => !isset($row['file_hash_mtime']) || (int) $row['file_hash_mtime'] === $actualMtime,
    ];
    if ($recordedHash !== '') {
        $out['hash_matches'] = hash_equals($recordedHash, (string) @hash_file('sha256', $abs));
    }
    return $out;
});

// ── 4d. Generated personalized copies: present, or stale? ───────────────────
$stage('personalized_copies', function () use ($storage, $row): array {
    $materialId = (string) ($row['id'] ?? '');
    try {
        $copies = Database::instance()->select(
            'SELECT storage_path, variant_key, page_count FROM lesson_material_pdfs WHERE material_id = ?',
            [$materialId]
        );
    } catch (\Throwable $e) {
        throw new ApiException(500, 'The variant registry is unreadable (migration 032/035 not applied?).', 'schema', $e);
    }
    $missing = 0;
    $bytes = 0;
    foreach ($copies as $copy) {
        $abs = $storage->privateFilePath(PdfWatermarkService::BUCKET, (string) ($copy['storage_path'] ?? ''));
        if (!is_file($abs) || (int) @filesize($abs) === 0) {
            $missing++;
            continue;
        }
        $bytes += (int) @filesize($abs);
    }
    return [
        'count' => count($copies),
        'missing_files' => $missing,
        'total_bytes' => $bytes,
        'note' => $missing > 0
            ? 'A registry row without a file makes delivery fail closed for that student; the next mint regenerates it.'
            : 'All registered copies are present.',
    ];
});

// ── 5. Registry table (variant_key / page_count must exist) ─────────────────
$stage('registry_table', function (): string {
    Database::instance()->row('SELECT variant_key, page_count FROM lesson_material_pdfs LIMIT 1');
    return 'ok';
});

// ── 5b. Delete/replace cleanup machinery ────────────────────────────────────
// A backlog here means deleted materials still have bytes on disk; nothing about
// delivery is affected, but the storage cost is real and retryable.
$stage('cleanup_health', function (): array {
    $cleanup = new \MedAcademy\Services\MaterialFileCleanupService();
    $health = $cleanup->queueHealth();
    $orphans = $cleanup->scanOrphans(3600);
    $health['orphan_files'] = count($orphans);
    $health['orphan_bytes'] = array_sum(array_map(static fn (array $o): int => (int) $o['bytes'], $orphans));
    $health['note'] = 'Run storage-cleanup.php --retry to drain the queue, --orphans to list unreferenced files.';
    return $health;
});

// ── 6. The render itself (the expensive stage) ──────────────────────────────
$stage('render', function () use ($service, $sourceAbs): array {
    $tmp = tempnam(sys_get_temp_dir(), 'mwdiag-');
    if ($tmp === false) {
        throw new ApiException(500, 'Could not create a temp file.', 'storage_unwritable');
    }
    $out = $tmp . '.pdf';
    $started = microtime(true);
    $pages = $service->personalize(
        (string) $sourceAbs['absolute_path'],
        $service->watermarkLines('Diagnostic Reader', 'MED-DIAGNOSTIC'),
        $out
    );
    $bytes = (int) @filesize($out);
    @unlink($out);
    @unlink($tmp);
    return [
        'pages'     => $pages,
        'bytes'     => $bytes,
        'elapsed_ms' => (int) round((microtime(true) - $started) * 1000),
    ];
});

$report['notes'][] = 'Every exercised stage passed. A failure in the app from here is authorization, rate limiting or delivery metadata — check audit_logs for material_pdf_failed.stage.';
echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), PHP_EOL;
exit(0);
