<?php

declare(strict_types=1);

/**
 * error_tests.php — fail-closed / error-handling tests for the REAL engine.
 *
 * Every failing case must (a) throw, (b) NOT create the output file, and
 * (c) leave NO temporary scratch directory or .part file behind:
 *
 *   in-process:  non-PDF bytes, empty file, truncated PDF, encrypted PDF;
 *   child proc:  page-count limit (PDF_WATERMARK_MAX_PAGES) — both engines;
 *                raster only: missing Ghostscript binary, missing font,
 *                oversized page (PDF_WATERMARK_MAX_PIXELS_PER_PAGE);
 *                vector only: oversized source (PDF_WATERMARK_MAX_SOURCE_BYTES).
 *
 * The child processes give each config case a clean Config cache. Baseline: 8/8.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
require $root . '/backend/src/bootstrap.php';

use MedAcademy\Http\ApiException;
use MedAcademy\Services\PdfWatermarkService;

$WORK = (string) (getenv('PDFTEST_WORKDIR') ?: $root . '/.freebuff/pdf-watermark-tests');
$FIX = $WORK . '/fixtures';
$OUT = $WORK . '/out/errors';
@mkdir($OUT, 0775, true);

// ── Child-process mode: run ONE configuration case and print a JSON verdict ─
if (isset($argv[1])) {
    $case = (string) $argv[1];
    $src = $FIX . '/source.pdf';
    $outPath = $OUT . '/child-' . $case . '.pdf';
    @unlink($outPath);
    $svc = new PdfWatermarkService();
    $available = $svc->isAvailable();
    $code = null;
    $msg = '';
    $threw = false;
    try {
        $svc->personalize($src, $svc->watermarkLines('Err Case', 'MED-0000'), $outPath);
    } catch (ApiException $e) {
        $threw = true;
        $code = $e->status;
        $msg = $e->getMessage();
    } catch (\Throwable $e) {
        $threw = true;
        $code = -1;
        $msg = get_class($e) . ': ' . $e->getMessage();
    }
    echo json_encode([
        'case' => $case, 'available' => $available, 'threw' => $threw, 'code' => $code,
        'message' => mb_substr($msg, 0, 120),
        'output_exists' => is_file($outPath) && filesize($outPath) > 0,
        'leftover_wm_dirs' => count(glob($OUT . '/wm-*') ?: []),
        'part_files' => count(glob($OUT . '/*.part') ?: []),
    ]), "\n";
    exit(0);
}

$cases = [];
$fail = [];

function verdict(array &$cases, array &$fail, string $label, array $r, array $expectCodes): void
{
    $ok = true;
    $why = [];
    if (!$r['threw']) {
        $ok = false;
        $why[] = 'did NOT throw';
    } elseif (!in_array($r['code'], $expectCodes, true)) {
        $ok = false;
        $why[] = "code {$r['code']} not in [" . implode(',', $expectCodes) . ']';
    }
    if (!empty($r['output_exists'])) {
        $ok = false;
        $why[] = 'OUTPUT FILE WAS CREATED';
    }
    if (($r['leftover_wm_dirs'] ?? 0) !== 0) {
        $ok = false;
        $why[] = 'temp dir left behind';
    }
    if (($r['part_files'] ?? 0) !== 0) {
        $ok = false;
        $why[] = '.part left behind';
    }
    $r['ok'] = $ok;
    $r['why'] = implode('; ', $why);
    $cases[] = $r;
    if (!$ok) {
        $fail[] = "$label: {$r['why']}";
    }
}

// ── In-process cases: bad source files (normal config) ──────────────────────
$service = new PdfWatermarkService();
foreach ([
    ['reject_non_pdf',         $FIX . '/notapdf.pdf',   [422]],
    ['reject_empty_file',      $FIX . '/empty.pdf',     [422]],
    ['reject_truncated_pdf',   $FIX . '/truncated.pdf', [422, 500]],
    ['reject_encrypted_pdf',   $FIX . '/encrypted.pdf', [422]],
] as [$label, $src, $codes]) {
    if (!is_file($src)) {
        fwrite(STDERR, "FAIL: fixture missing ($src). Run make_fixture.php first.\n");
        exit(1);
    }
    $out = $OUT . "/$label.pdf";
    @unlink($out);
    $r = ['case' => $label, 'threw' => false, 'code' => null, 'message' => ''];
    try {
        $pages = $service->personalize($src, $service->watermarkLines('Err Case', 'MED-0000'), $out);
        $r['message'] = "returned pages=$pages";
    } catch (ApiException $e) {
        $r['threw'] = true;
        $r['code'] = $e->status;
        $r['message'] = $e->getMessage();
    } catch (\Throwable $e) {
        $r['threw'] = true;
        $r['code'] = -1;
        $r['message'] = get_class($e) . ': ' . $e->getMessage();
    }
    $r['output_exists'] = is_file($out) && filesize($out) > 0;
    $r['leftover_wm_dirs'] = count(glob($OUT . '/wm-*') ?: []);
    $r['part_files'] = count(glob($OUT . '/*.part') ?: []);
    verdict($cases, $fail, $label, $r, $codes);
}

// ── Config-only cases: child process with overridden environment ────────────
$PHP = PHP_BINARY;
$prepend = __DIR__ . '/prepend.php';
$baseEnv = getenv();
// The limit cases depend on WHICH engine is resolved: a missing Ghostscript or a
// missing TTF is fatal for the raster engine and irrelevant to the vector one,
// while an oversized SOURCE is a vector-engine limit. Assert only what the
// resolved engine actually enforces, so the suite cannot pass on a stale
// assumption.
$probeMode = (new PdfWatermarkService())->effectiveMode();
$envCases = [
    ['too_many_pages', ['PDF_WATERMARK_MAX_PAGES' => '2'], [422]],
];
if ($probeMode === PdfWatermarkService::MODE_RASTER) {
    $envCases[] = ['missing_pdfium', ['PDFIUM_RENDER_BIN' => $WORK . '/does/not/exist/pdfium_render'], [503]];
    $envCases[] = ['missing_font', ['PDF_WATERMARK_FONT' => $WORK . '/does/not/exist/font.ttf'], [503]];
    $envCases[] = ['page_too_large', ['PDF_WATERMARK_MAX_PIXELS_PER_PAGE' => '1000'], [422]];
} else {
    $envCases[] = ['source_too_large', ['PDF_WATERMARK_MAX_SOURCE_BYTES' => '500'], [422]];
}
foreach ($envCases as [$label, $overrides, $codes]) {
    $env = array_merge($baseEnv, $overrides);
    $d = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $p = proc_open([$PHP, '-d', 'auto_prepend_file=' . $prepend, __FILE__, $label], $d, $pipes, __DIR__, $env);
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($p);
    $r = json_decode(trim((string) $stdout), true);
    if (!is_array($r)) {
        $r = ['case' => $label, 'threw' => false, 'code' => null, 'message' => 'child produced no JSON: ' . trim((string) $stderr), 'output_exists' => false, 'leftover_wm_dirs' => 0, 'part_files' => 0];
    }
    verdict($cases, $fail, $label, $r, $codes);
}

$json = json_encode(['cases' => $cases, 'failures' => $fail, 'ok' => $fail === []], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
echo $json, "\n";
if (($jp = getenv('PDFTEST_JSON_OUT')) !== false && $jp !== '') {
    @mkdir(dirname($jp), 0775, true);
    file_put_contents($jp, $json . "\n");
}
if ($fail !== []) {
    fwrite(STDERR, "FAILED:\n - " . implode("\n - ", $fail) . "\n");
    exit(1);
}
echo "\nALL ERROR-HANDLING CHECKS PASSED\n";
exit(0);
