<?php

declare(strict_types=1);

/**
 * verify-watermark.php — REAL integration test for the personalized-PDF engine.
 *
 * Run on a host that has the engine (and ideally PHP CLI):
 *
 *   php backend/scripts/verify-watermark.php
 *
 * It GENERATES a 3-page source PDF (real selectable text, mixed orientation),
 * personalizes it for two different students, and inspects the ACTUAL OUTPUT
 * BYTES. Checks:
 *   • the output opens and has the same page count as the source;
 *   • the flattened output has NO text layer (no /Font objects, and — when the
 *     `pdftotext` utility is present — the original marker string is not
 *     extractable as text);
 *   • the source DOES contain the text layer (so the check is meaningful);
 *   • two students receive DIFFERENT bytes (personalization is per-student);
 *   • output is image-only (image XObjects present) when the raster engine ran;
 *   • file sizes and processing times are reported.
 *
 * Exit code 0 = all checks pass. It never touches the database.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Services\PdfWatermarkService;

const MARKER = 'LECTURE-TEXT-MARKER-ALPHA';

$fail = [];
$checks = [];

function check(array &$checks, array &$fail, string $name, bool $ok, string $detail = ''): void
{
    $checks[] = ['check' => $name, 'ok' => $ok, 'detail' => $detail];
    if (!$ok) {
        $fail[] = $name . ($detail !== '' ? ' (' . $detail . ')' : '');
    }
}

function countPages(string $bytes): int
{
    // Count page objects; /Type /Pages (the tree root) is excluded by [^s].
    return (int) preg_match_all('#/Type\s*/Page[^s]#', $bytes);
}

function runTextExtract(string $bin, string $pdf, string $txt): ?string
{
    $d = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $p = @proc_open([$bin, '-q', $pdf, $txt], $d, $pipes);
    if (!is_resource($p)) {
        return null;
    }
    fclose($pipes[0]);
    stream_get_contents($pipes[1]);
    stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($p);
    return is_file($txt) ? (string) @file_get_contents($txt) : null;
}

/** Locate a usable pdftotext without relying on a POSIX shell (`command -v`). */
function findPdftotext(): ?string
{
    $configured = trim((string) getenv('PDFTOTEXT'));
    $candidates = $configured !== '' ? [$configured] : [];
    $fromPath = trim((string) @shell_exec('command -v pdftotext 2>/dev/null'));
    if ($fromPath !== '') {
        $candidates[] = $fromPath;
    }
    $candidates[] = 'pdftotext';
    foreach ($candidates as $bin) {
        $d = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $p = @proc_open([$bin, '-v'], $d, $pipes);
        if (!is_resource($p)) {
            continue;
        }
        fclose($pipes[0]);
        stream_get_contents($pipes[1]);
        stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($p);
        return $bin;
    }
    return null;
}

$service = new PdfWatermarkService();
$status = $service->status();

echo "Engine: " . json_encode([
    'configured_mode' => $status['configured_mode'],
    'effective_mode' => $status['effective_mode'],
    'driver' => $status['driver'],
    'dpi' => $status['settings']['dpi'],
    'format' => $status['settings']['image_format'],
], JSON_UNESCAPED_SLASHES) . "\n\n";

if (!$service->isAvailable()) {
    fwrite(STDERR, "FAIL: no watermark engine is available on this host.\n");
    fwrite(STDERR, json_encode($service->rendererStatus()['raster'], JSON_PRETTY_PRINT) . "\n");
    exit(1);
}

// Scratch lives in backend/storage/tmp by default; the reproducible test
// workflow redirects it into its git-ignored workspace via PDF_WATERMARK_TEST_TMP
// so no generated file ever lands in a tracked directory.
$tmpBase = getenv('PDF_WATERMARK_TEST_TMP');
$tmpBase = ($tmpBase !== false && $tmpBase !== '')
    ? rtrim($tmpBase, '/\\')
    : MEDACADEMY_BASE . '/storage/tmp';
$work = $tmpBase . '/wm-verify-' . bin2hex(random_bytes(4));
@mkdir($work, 0775, true);
if (!is_dir($work)) {
    fwrite(STDERR, "FAIL: cannot create scratch directory {$work}\n");
    exit(1);
}
$src = $work . '/source.pdf';
$outA = $work . '/student-a.pdf';
$outB = $work . '/student-b.pdf';
$txtSrc = $work . '/source.txt';
$txtA = $work . '/student-a.txt';

// ── 1. Build the source fixture with REAL text ──────────────────────────────
if (!class_exists('FPDF')) {
    fwrite(STDERR, "FAIL: FPDF is not loaded, cannot build the test fixture.\n");
    exit(1);
}
$src2 = new \FPDF('P', 'pt', 'A4');
$src2->AddPage();
$src2->SetFont('Helvetica', 'B', 22);
$src2->Cell(0, 30, 'MEDACADEMY LECTURE - SECTION A', 0, 1);
$src2->SetFont('Helvetica', '', 12);
$src2->MultiCell(0, 16, "This paragraph is genuine selectable text. It exists to prove the flattened output has no text layer. Marker: " . MARKER);
$src2->AddPage('L');
$src2->SetFont('Helvetica', 'B', 20);
$src2->Cell(0, 30, 'LANDSCAPE PAGE - DIAGRAM AREA', 0, 1);
$src2->AddPage('P');
$src2->SetFont('Helvetica', 'B', 20);
$src2->Cell(0, 30, 'LAST PAGE', 0, 1);
$src2->Output($src, 'F');

$srcBytes = (string) file_get_contents($src);
$srcPages = countPages($srcBytes);

// ── 2. Personalize for two different students ───────────────────────────────
$t0 = microtime(true);
$pagesA = $service->personalize($src, $service->watermarkLines('Test Student', 'MED-0042'), $outA);
$msA = (int) round((microtime(true) - $t0) * 1000);

$t1 = microtime(true);
$pagesB = $service->personalize($src, $service->watermarkLines('Other Student', 'MED-0099'), $outB);
$msB = (int) round((microtime(true) - $t1) * 1000);

$bytesA = (string) file_get_contents($outA);
$bytesB = (string) file_get_contents($outB);

// ── 3. Assertions on the ACTUAL output bytes ────────────────────────────────
check($checks, $fail, 'source fixture has text (/Font present)', str_contains($srcBytes, '/Font'));
check($checks, $fail, 'source fixture page count >= 3', $srcPages >= 3, "pages=$srcPages");
check($checks, $fail, 'engine reported page count == source', $pagesA === $srcPages, "reported=$pagesA src=$srcPages");
check($checks, $fail, 'output A opens with same page count', countPages($bytesA) === $srcPages, 'pages=' . countPages($bytesA));
// FPDF always emits an empty `/Font <<` resource dictionary even for a page
// that only carries an image XObject, so the meaningful assertion is the
// absence of an actual font OBJECT (`/Type /Font`), not of the dictionary key.
check($checks, $fail, 'flattened output has NO font objects (/Type /Font)', !preg_match('#/Type\s*/Font#', $bytesA));
check($checks, $fail, 'flattened output contains image XObjects', str_contains($bytesA, '/Subtype /Image') || str_contains($bytesA, '/Image'));
check($checks, $fail, 'two students receive different bytes', md5($bytesA) !== md5($bytesB));
check($checks, $fail, 'output A is non-empty', strlen($bytesA) > 1024, strlen($bytesA) . ' bytes');
check($checks, $fail, 'output B is non-empty', strlen($bytesB) > 1024, strlen($bytesB) . ' bytes');

$pdftotext = findPdftotext();
if ($pdftotext !== null) {
    $srcText = runTextExtract($pdftotext, $src, $txtSrc);
    $outText = runTextExtract($pdftotext, $outA, $txtA);
    check($checks, $fail, 'pdftotext extracts the marker from the SOURCE', $srcText !== null && str_contains($srcText, MARKER));
    check($checks, $fail, 'pdftotext does NOT extract the marker from the OUTPUT', $outText !== null && !str_contains($outText, MARKER));
} else {
    $checks[] = ['check' => 'pdftotext text-extraction check', 'ok' => true, 'detail' => 'SKIPPED — pdftotext not installed'];
}

// ── 4. Report ───────────────────────────────────────────────────────────────
$report = [
    'engine' => $status['effective_mode'],
    'source' => ['pages' => $srcPages, 'bytes' => strlen($srcBytes)],
    'student_a' => ['pages' => $pagesA, 'bytes' => strlen($bytesA), 'ms' => $msA, 'bytes_per_page' => (int) (strlen($bytesA) / max(1, $pagesA))],
    'student_b' => ['pages' => $pagesB, 'bytes' => strlen($bytesB), 'ms' => $msB],
    'checks' => $checks,
    'ok' => $fail === [],
];

echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";

// Cleanup the scratch directory (files only).
foreach (glob($work . '/*') ?: [] as $f) {
    @unlink($f);
}
@rmdir($work);

if ($fail !== []) {
    fwrite(STDERR, "\nFAILED:\n - " . implode("\n - ", $fail) . "\n");
    exit(1);
}
echo "\nALL CHECKS PASSED\n";
exit(0);
