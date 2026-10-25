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
$sourceAbs = $stage('source_file', function () use ($storage, $row): string {
    $abs = $storage->privateFilePath('lesson-materials', (string) $row['storage_path']);
    if (!is_file($abs)) {
        throw new ApiException(404, 'The source PDF is missing.', 'source_missing');
    }
    $size = (int) @filesize($abs);
    if ($size <= 0) {
        throw new ApiException(422, 'The source PDF is empty.', 'source_unreadable');
    }
    $head = (string) @file_get_contents($abs, false, null, 0, 1024);
    if (!str_starts_with($head, '%PDF-')) {
        throw new ApiException(422, 'The source is not a PDF.', 'source_not_pdf');
    }
    return $abs;
});

// ── 5. Registry table (variant_key / page_count must exist) ─────────────────
$stage('registry_table', function (): string {
    Database::instance()->row('SELECT variant_key, page_count FROM lesson_material_pdfs LIMIT 1');
    return 'ok';
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
        $sourceAbs,
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
