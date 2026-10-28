<?php

declare(strict_types=1);

/**
 * diagnose-upload.php — "why does the doctor's PDF upload fail?" on THIS host.
 *
 * The app shows one sentence ("Upload failed."), the frontend cannot see WHICH
 * stage refused the file, and the server may be a different PHP build from the
 * developer's machine. This script walks the SAME code path the HTTP request
 * walks — validate → persist → verify (exactly what `/storage/upload` calls),
 * plus the storage/engine/schema facts that decide whether that path can work —
 * and prints one verdict per stage.
 *
 * WHAT IT CHANGES: nothing that matters.
 *   • No database writes, no user data, no session, no external API call.
 *   • It stores ONE tiny generated PDF under
 *     `storage/private/lesson-materials/diagnostics/`, verifies it and deletes
 *     it again (including the directory when it was created empty).
 *   • It reads no secret and prints none: limits, paths, booleans and codes only.
 *
 * USAGE (cPanel → Terminal, or a cron "Run now"):
 *   php /home/USER/medacademy-api/scripts/diagnose-upload.php
 *   php /home/USER/medacademy-api/scripts/diagnose-upload.php --file=/home/USER/the-failing.pdf
 *   php /home/USER/medacademy-api/scripts/diagnose-upload.php --json
 *
 *   --file=PATH  also run the PDF gate on a real document (e.g. the file the
 *                doctor tried to upload, copied to the server). This is the
 *                decisive test when the doctor's own PDF is available.
 *   --json       machine-readable output (one JSON object).
 *
 * EXIT CODES: 0 = every stage passed; 1 = at least one stage failed (the failing
 * stage is named); 2 = bad usage.
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This script is CLI-only.\n");
    exit(2);
}

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Services\UploadIntegrityService;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;

$options = getopt('', ['file::', 'json', 'help']);
if (isset($options['help'])) {
    fwrite(STDOUT, "Usage: php scripts/diagnose-upload.php [--file=/path/to/document.pdf] [--json]\n");
    exit(0);
}

$jsonOut = isset($options['json']);
$sampleFile = is_string($options['file'] ?? null) ? (string) $options['file'] : '';

$checks = [];
$failures = 0;

/**
 * Record one verdict. `$detail` must never contain a secret, a token, document
 * content or a user identity — this output is meant to be pasted into a ticket.
 */
function verdict(string $stage, bool $ok, string $detail = ''): void
{
    global $checks, $failures;
    $checks[] = ['stage' => $stage, 'ok' => $ok, 'detail' => $detail];
    if (!$ok) {
        $failures++;
    }
    if (!($GLOBALS['jsonOut'] ?? false)) {
        printf("[%s] %-28s %s\n", $ok ? ' OK ' : 'FAIL', $stage, $detail);
    }
}

function humanBytes(int $bytes): string
{
    if ($bytes >= 1048576) {
        return round($bytes / 1048576, 1) . ' MB';
    }
    if ($bytes >= 1024) {
        return round($bytes / 1024, 1) . ' KB';
    }
    return $bytes . ' B';
}

function iniBytes(string $value): int
{
    $value = trim($value);
    if ($value === '' || $value === '-1') {
        return -1;
    }
    $unit = strtolower(substr($value, -1));
    $num = (int) $value;
    return match ($unit) {
        'g' => $num * 1073741824,
        'm' => $num * 1048576,
        'k' => $num * 1024,
        default => $num,
    };
}

/**
 * A tiny, structurally complete PDF built here (classic xref table, Helvetica
 * base font) so the gate can be exercised without any fixture file or engine.
 * FPDI/TCPDF both accept this container, which is the point: a failure below is
 * therefore about THIS host, not about the sample.
 */
function buildSamplePdf(string $title): string
{
    $content = "BT /F1 12 Tf 24 120 Td (" . addcslashes($title, '()\\') . ") Tj ET\n";
    $objects = [
        1 => "<< /Type /Catalog /Pages 2 0 R >>",
        2 => "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3 => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        4 => "<< /Length " . strlen($content) . " >>\nstream\n" . $content . "endstream",
        5 => "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];

    $pdf = "%PDF-1.4\n";
    $offsets = [];
    foreach ($objects as $num => $body) {
        $offsets[$num] = strlen($pdf);
        $pdf .= $num . " 0 obj\n" . $body . "\nendobj\n";
    }
    $xrefAt = strlen($pdf);
    $count = count($objects) + 1;
    $pdf .= "xref\n0 " . $count . "\n0000000000 65535 f \n";
    for ($i = 1; $i < $count; $i++) {
        $pdf .= sprintf("%010d 00000 n \n", $offsets[$i]);
    }
    $pdf .= "trailer\n<< /Size " . $count . " /Root 1 0 R >>\nstartxref\n" . $xrefAt . "\n%%EOF\n";

    return $pdf;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. PHP runtime — the limits a shared host actually enforces
// ════════════════════════════════════════════════════════════════════════════
$uploadMax = iniBytes((string) ini_get('upload_max_filesize'));
$postMax = iniBytes((string) ini_get('post_max_size'));
$uploadTmp = (string) (ini_get('upload_tmp_dir') ?: sys_get_temp_dir());

fwrite(STDOUT, $jsonOut ? '' : "MedAcademy — PDF upload path diagnostic\n" . str_repeat('─', 78) . "\n");

verdict('php.version', PHP_VERSION_ID >= 80100, PHP_VERSION);
verdict(
    'php.upload_max_filesize',
    $uploadMax > 0,
    $uploadMax === -1 ? 'unlimited' : humanBytes($uploadMax)
);
verdict(
    'php.post_max_size',
    $postMax > 0,
    $postMax === -1 ? 'unlimited' : humanBytes($postMax)
);
// The app's EFFECTIVE attachment cap must fit inside what PHP will accept, or
// a picker-approved file is refused by the host instead of by a stated limit.
$integrity = new UploadIntegrityService();
$configuredCap = max(1, Config::int('LESSON_MATERIAL_MAX_BYTES', 100 * 1024 * 1024));
$effectiveCap = $integrity->maxBytes();
$smallest = PHP_INT_MAX;
foreach ([$uploadMax, $postMax] as $limit) {
    if ($limit > 0) {
        $smallest = min($smallest, $limit);
    }
}
verdict(
    'php.attachment_cap',
    $smallest === PHP_INT_MAX || $configuredCap <= $smallest || $effectiveCap <= $smallest,
    'effective ' . humanBytes($effectiveCap)
    . ' (configured ' . humanBytes($configuredCap)
    . ', host accepts ' . ($smallest === PHP_INT_MAX ? 'unlimited' : humanBytes($smallest)) . ')'
);
verdict('php.memory_limit', true, (string) ini_get('memory_limit'));
verdict('php.max_execution_time', true, (string) ini_get('max_execution_time') . 's');
verdict('php.upload_tmp_dir', is_dir($uploadTmp) && is_writable($uploadTmp), $uploadTmp . (is_dir($uploadTmp) ? (is_writable($uploadTmp) ? ' (writable)' : ' (NOT writable)') : ' (missing)'));

$requiredExt = ['pdo_mysql', 'fileinfo'];
$missingExt = array_values(array_filter($requiredExt, static fn (string $e): bool => !extension_loaded($e)));
verdict('php.extensions', $missingExt === [], $missingExt === [] ? implode(', ', $requiredExt) : 'missing: ' . implode(', ', $missingExt));

// ════════════════════════════════════════════════════════════════════════════
// 2. Storage roots — where the bytes go, and whether they may
// ════════════════════════════════════════════════════════════════════════════
$storage = new StorageService();
$privateDir = $storage->privateDir();
$publicDir = $storage->publicDir();
$materialDir = $storage->privateFilePath('lesson-materials', '');

verdict('storage.private_root', is_dir($privateDir), $privateDir . (is_dir($privateDir) ? '' : ' (missing)'));
verdict('storage.private_writable', is_dir($privateDir) && is_writable($privateDir), is_dir($privateDir) ? (is_writable($privateDir) ? 'writable' : 'NOT writable') : 'missing');
verdict('storage.material_bucket', is_dir($materialDir) || is_writable($privateDir), $materialDir);
verdict('storage.public_root', is_dir($publicDir), $publicDir);

$free = @disk_free_space($privateDir);
if (is_float($free) || is_int($free)) {
    // A full quota is the classic cPanel "upload silently fails" cause.
    verdict('storage.free_space', (int) $free > 5 * 1024 * 1024, humanBytes((int) $free) . ' free');
} else {
    verdict('storage.free_space', true, 'unavailable on this host');
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Watermark engine — what can actually render a copy
// ════════════════════════════════════════════════════════════════════════════
$pdf = new PdfWatermarkService();
$mode = $pdf->effectiveMode();
verdict(
    'engine.available',
    $mode !== null,
    ($mode ?? 'none') . ' — ' . (string) ($pdf->driver() ?? 'no engine found (backend/vendor missing?)')
);
verdict('engine.vendor_autoload', is_file(MEDACADEMY_BASE . '/vendor/autoload.php'), MEDACADEMY_BASE . '/vendor/autoload.php');
verdict('engine.max_source', true, humanBytes($pdf->maxSourceBytes()) . ' (PDF_WATERMARK_MAX_SOURCE_BYTES)');

// ════════════════════════════════════════════════════════════════════════════
// 4. Schema — read-only probes (never information_schema: cPanel grants vary)
// ════════════════════════════════════════════════════════════════════════════
$db = Database::instance();
try {
    $db->query('SELECT 1');
    verdict('db.connect', true, 'ok');
} catch (\Throwable $e) {
    verdict('db.connect', false, 'connection failed: ' . get_class($e));
}

$probes = [
    'db.lesson_materials' => 'SELECT `id`, `storage_path`, `file_size` FROM `lesson_materials` LIMIT 0',
    'db.hash_cache_035' => 'SELECT `file_hash`, `file_hash_path`, `file_hash_size`, `file_hash_mtime` FROM `lesson_materials` LIMIT 0',
    'db.already_applied_032' => 'SELECT `permission`, `watermark_enabled` FROM `lesson_materials` LIMIT 0',
    'db.queue_table_038' => 'SELECT `id`, `material_id`, `student_id`, `variant_key`, `status`, `priority`, `run_after`, `lock_token` FROM `lesson_material_pdf_jobs` LIMIT 0',
];
foreach ($probes as $stage => $sql) {
    if ($stage === 'db.hash_cache_035') {
        // Optional: the code degrades to hashing on demand. Report as info only.
        try {
            $db->query($sql);
            verdict($stage, true, 'present (fast path)');
        } catch (\Throwable $e) {
            verdict($stage, true, 'absent — source hash is recomputed per request (slower, still correct)');
        }
        continue;
    }
    try {
        $db->query($sql);
        verdict($stage, true, 'ok');
    } catch (\Throwable $e) {
        verdict($stage, false, 'missing or unreadable: ' . mb_substr($e->getMessage(), 0, 120));
    }
}

// Which columns the app actually sends when it creates a material.
$payloadColumns = [
    'id', 'lesson_id', 'course_id', 'uploaded_by', 'file_name', 'file_url', 'storage_path',
    'file_type', 'file_size', 'download_enabled', 'preview_enabled', 'order_index',
];
// A NOT NULL column with no default that the app does not send makes EVERY
// insert fail with an error the app cannot show ("Upload failed."). This is what
// schema drift looks like from the doctor's side, so name it here.
try {
    $rows = $db->select('SHOW COLUMNS FROM `lesson_materials`');
    $required = [];
    foreach ($rows as $col) {
        $field = (string) ($col['Field'] ?? '');
        $nullable = strtoupper((string) ($col['Null'] ?? 'YES')) !== 'NO';
        $extra = strtolower((string) ($col['Extra'] ?? ''));
        if ($nullable || str_contains($extra, 'auto_increment') || ($col['Default'] ?? null) !== null) {
            continue;
        }
        $required[] = $field;
    }
    $missing = array_values(array_diff($required, $payloadColumns));
    verdict(
        'db.required_columns',
        $missing === [],
        $missing === []
            ? count($required) . ' required column(s), all supplied by the app'
            : 'the app does not send: ' . implode(', ', $missing) . ' (every insert will be refused)'
    );
} catch (\Throwable $e) {
    verdict('db.required_columns', true, 'could not introspect (skipped): ' . mb_substr($e->getMessage(), 0, 80));
}

// ════════════════════════════════════════════════════════════════════════════
// 5. The real gate: validate → persist → verify (what /storage/upload does)
// ════════════════════════════════════════════════════════════════════════════
$tmpPath = rtrim(sys_get_temp_dir(), '/\\') . '/medacademy-diag-' . bin2hex(random_bytes(4)) . '.pdf';
$storedPath = '';
$dest = 'diagnostics/' . date('Ymd-His') . '-' . bin2hex(random_bytes(3)) . '.pdf';

try {
    if (@file_put_contents($tmpPath, buildSamplePdf('MedAcademy upload diagnostic')) === false) {
        throw new \RuntimeException('could not write the temporary sample to ' . dirname($tmpPath));
    }
    $size = (int) filesize($tmpPath);

    // Stage A — the PDF gate (this is where a document is refused).
    try {
        $validated = $integrity->validate(
            ['error' => UPLOAD_ERR_OK, 'tmp_name' => $tmpPath, 'size' => $size, 'name' => 'diagnostic.pdf', 'type' => 'application/pdf'],
            $dest,
            'lesson-materials'
        );
        verdict('upload.validate', true, humanBytes($validated['size']) . ' accepted');
    } catch (ApiException $e) {
        throw new \RuntimeException(
            'REJECTED by the document gate: [' . (string) ($e->errors[0] ?? '?') . '] ' . $e->getMessage()
        );
    }

    // Stage B — atomic write into private storage.
    try {
        $stored = $integrity->persist($validated['tmp'], $validated['size'], 'lesson-materials', $dest, false);
        $storedPath = $stored['path'];
        verdict('upload.persist', true, humanBytes($stored['size']) . ' written to lesson-materials/' . $stored['path']);
    } catch (ApiException $e) {
        throw new \RuntimeException(
            'WRITE failed: [' . (string) ($e->errors[0] ?? '?') . '] ' . $e->getMessage()
        );
    }

    // Stage C — the verification the material row repeats. If A and B pass but
    // this fails, the upload succeeds and the ROW is what rejects the file.
    try {
        $measured = $integrity->inspectStored('lesson-materials', $storedPath, true);
        $ok = $measured['size'] === $stored['size'] && $measured['sha256'] === $stored['sha256'];
        verdict(
            'upload.verify_stored',
            $ok,
            $ok ? humanBytes($measured['size']) . ' re-measured, sha256 matches' : 'measured/stored bytes disagree'
        );
    } catch (ApiException $e) {
        throw new \RuntimeException(
            'VERIFY failed (the row would be refused): [' . (string) ($e->errors[0] ?? '?') . '] ' . $e->getMessage()
        );
    }
} catch (\RuntimeException $e) {
    verdict('upload.round_trip', false, $e->getMessage());
} catch (\Throwable $e) {
    verdict('upload.round_trip', false, get_class($e) . ': ' . mb_substr($e->getMessage(), 0, 200));
} finally {
    @unlink($tmpPath);
    if ($storedPath !== '') {
        $removed = $storage->delete('lesson-materials', $storedPath, false);
        verdict('upload.cleanup', $removed, $removed ? 'sample removed from storage' : 'sample was already gone');
        $dir = dirname($storage->privateFilePath('lesson-materials', $storedPath));
        if (is_dir($dir) && count((array) @scandir($dir)) <= 2) {
            @rmdir($dir);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Optional: the doctor's own document
// ════════════════════════════════════════════════════════════════════════════
if ($sampleFile !== '') {
    if (!is_file($sampleFile)) {
        verdict('file.exists', false, $sampleFile . ' not found');
    } else {
        verdict('file.exists', true, humanBytes((int) filesize($sampleFile)));
        try {
            $info = $pdf->inspect($sampleFile);
            verdict('file.pdf_gate', true, 'accepted — ' . ($info['page_count'] === null ? 'pages unknown (engine parses at render time)' : $info['page_count'] . ' page(s)'));
        } catch (ApiException $e) {
            verdict(
                'file.pdf_gate',
                false,
                'REJECTED: [' . (string) ($e->errors[0] ?? '?') . '] ' . $e->getMessage()
            );
        } catch (\Throwable $e) {
            verdict('file.pdf_gate', false, get_class($e) . ': ' . mb_substr($e->getMessage(), 0, 200));
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════════════════
if ($jsonOut) {
    echo json_encode(
        [
            'ok' => $failures === 0,
            'failures' => $failures,
            'checks' => $checks,
            'server' => ['php' => PHP_VERSION, 'sapi' => PHP_SAPI, 'os' => PHP_OS_FAMILY],
        ],
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES
    ), "\n";
} else {
    echo str_repeat('─', 78), "\n";
    echo $failures === 0
        ? "RESULT: every stage passed — the upload path works on this host.\n"
        : "RESULT: {$failures} failing stage(s) above. Fix the FIRST failure;\n"
            . "        later stages depend on it. Nothing was changed by this script.\n";
    echo "Server log lines to quote in a ticket: grep 'storage-upload' storage/logs/app.log | tail -20\n";
}

exit($failures === 0 ? 0 : 1);
