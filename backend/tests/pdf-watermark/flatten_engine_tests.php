<?php

declare(strict_types=1);

/**
 * Legacy-engine policy regression. Vector and renderer-free flatten modes are
 * no longer valid student-delivery paths: both preserve selectable source
 * content, so delivery must fail closed. Raster delivery is independently
 * covered by run_real_test.php and the controller delivery suite.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
require $root . '/backend/src/bootstrap.php';

use MedAcademy\Http\ApiException;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Utils\Config;

$work = (string) (getenv('PDFTEST_WORKDIR') ?: $root . '/.freebuff/pdf-watermark-tests');
$source = $work . '/fixtures/source.pdf';
$outDir = $work . '/out/legacy-policy';
@mkdir($outDir, 0775, true);
$checks = [];
$failures = [];

function verify(array &$checks, array &$failures, string $label, bool $ok, string $detail = ''): void
{
    $checks[] = ['check' => $label, 'ok' => $ok, 'detail' => $detail];
    if (!$ok) {
        $failures[] = $label . ($detail !== '' ? ' — ' . $detail : '');
    }
    printf("[%s] %s%s\n", $ok ? 'PASS' : 'FAIL', $label, $detail !== '' ? ' — ' . $detail : '');
}

function setTestEnv(string $key, ?string $value): void
{
    if ($value === null) {
        putenv($key);
        unset($_ENV[$key]);
        return;
    }
    putenv($key . '=' . $value);
    $_ENV[$key] = $value;
}

verify($checks, $failures, 'raster fixture is available for fail-closed checks', is_file($source));

foreach (['vector', 'flatten'] as $mode) {
    setTestEnv('PDF_WATERMARK_MODE', $mode);
    setTestEnv('PDF_WATERMARK_ACCEPT_AGPL_RENDERER', null);
    Config::init();
    $service = new PdfWatermarkService();
    $status = $service->status();
    verify($checks, $failures, "$mode is reported as configured for compatibility", $service->configuredMode() === $mode);
    verify($checks, $failures, "$mode has no effective student-delivery engine", $service->effectiveMode() === null, json_encode(['effective_mode' => $status['effective_mode'] ?? null]));
    verify($checks, $failures, "$mode is unavailable for student delivery", !$service->isAvailable());

    $target = $outDir . '/' . $mode . '.pdf';
    @unlink($target);
    $refused = false;
    $code = null;
    try {
        $service->personalize($source, $service->watermarkLines('Policy Probe', 'MED-0000'), $target);
    } catch (ApiException $e) {
        $refused = true;
        $code = $e->status;
    }
    verify($checks, $failures, "$mode delivery fails closed with HTTP 503", $refused && $code === 503, 'status=' . var_export($code, true));
    verify($checks, $failures, "$mode failure publishes no PDF", !is_file($target));
}

setTestEnv('PDF_WATERMARK_MODE', null);
setTestEnv('PDF_WATERMARK_ACCEPT_AGPL_RENDERER', null);
Config::init();
$default = new PdfWatermarkService();
verify($checks, $failures, 'an unset mode defaults to raster-only delivery', $default->configuredMode() === PdfWatermarkService::MODE_RASTER);

$json = json_encode(['cases' => $checks, 'failures' => $failures, 'ok' => $failures === []], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
echo "\n", $json, "\n";
if (($path = getenv('PDFTEST_JSON_OUT')) !== false && $path !== '') {
    @mkdir(dirname($path), 0775, true);
    file_put_contents($path, $json . "\n");
}
if ($failures !== []) {
    fwrite(STDERR, "FAILED:\n - " . implode("\n - ", $failures) . "\n");
    exit(1);
}
printf("\nALL LEGACY-ENGINE POLICY CHECKS PASSED (%d checks)\n", count($checks));
