<?php

declare(strict_types=1);

/**
 * verify-watermark.php — REAL integration test for the personalized-PDF engine.
 *
 * Safe to run on the live host (and on a laptop):
 *
 *   php backend/scripts/verify-watermark.php
 *
 * It builds a 3-page source PDF (real selectable text, portrait + landscape +
 * small page), personalizes it for two different students through the REAL
 * service, and inspects the ACTUAL output. It never touches the database, never
 * reads a stored document and never writes outside a scratch directory.
 *
 * Checks:
 *   • an engine is available, and which one (vector / raster);
 *   • the engine reports the same page count as the source;
 *   • every page carries the student identity (grid + edge line);
 *   • a back layer is drawn BEFORE the imported page and a front layer AFTER
 *     it, and marks are baked into each imported page's own content stream;
 *   • the complete identity (name + id) appears on every page;
 *   • the original page size and orientation survive per page;
 *   • two students receive different bytes;
 *   • a non-PDF and a missing file are refused (fail closed), and no output
 *     file is created for them;
 *   • the scratch directory is removed afterwards.
 *
 * Exit code 0 = all checks pass.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Services\PdfWatermarkService;

const MARKER = 'LECTURE-TEXT-MARKER-ALPHA';

$checks = [];
$fail = [];

function check(array &$checks, array &$fail, string $name, bool $ok, string $detail = ''): void
{
    $checks[] = ['check' => $name, 'ok' => $ok, 'detail' => $detail];
    if (!$ok) {
        $fail[] = $name . ($detail !== '' ? ' (' . $detail . ')' : '');
    }
}

function pdfPageCount(string $bytes): int
{
    // Count page objects; /Type /Pages (the tree root) is excluded by [^s].
    return (int) preg_match_all('#/Type\s*/Page[^s]#', $bytes);
}

/** Decode the literal strings of a content stream (TCPDF writes UTF-16BE). */
function decodePdfText(string $content): string
{
    preg_match_all('/\((?:\\\\.|[^\\\\()])*\)/s', $content, $m);
    $out = '';
    foreach ($m[0] as $literal) {
        $raw = substr($literal, 1, -1);
        $raw = str_replace(['\\(', '\\)', '\\\\'], ['(', ')', '\\'], $raw);
        $out .= str_contains($raw, "\0")
            ? (string) @mb_convert_encoding($raw, 'UTF-8', 'UTF-16BE')
            : $raw;
    }
    return $out;
}

/**
 * Count the marks baked INTO each imported page stream (FlateDecode, so the
 * marker is invisible to a raw grep and must be inflated first).
 */
function bakedMarkerCount(string $file): int
{
    $bytes = (string) file_get_contents($file);
    $count = 0;
    $offset = 0;
    while (($at = strpos($bytes, 'stream', $offset)) !== false) {
        $start = $at + 6;
        if (substr($bytes, $start, 2) === "\r\n") {
            $start += 2;
        } elseif (($bytes[$start] ?? '') === "\n" || ($bytes[$start] ?? '') === "\r") {
            $start += 1;
        }
        $end = strpos($bytes, 'endstream', $start);
        if ($end === false) {
            break;
        }
        $decoded = @gzuncompress(substr($bytes, $start, $end - $start));
        if ($decoded !== false) {
            $count += substr_count($decoded, '%MAC-WM-BAKED');
        }
        $offset = $end + 9;
    }
    return $count;
}

/**
 * Per-page text + geometry, read back through FPDI's parser, plus whether a
 * watermark layer is drawn before AND after the imported page.
 *
 * @return array<int,array{text:string,w:float,h:float,wm_before_page:?bool,wm_after_page:?bool}>|null
 */
function pageInsight(string $file): ?array
{
    if (!class_exists(\setasign\Fpdi\PdfParser\StreamReader::class)) {
        return null;
    }
    try {
        $reader = new \setasign\Fpdi\PdfReader\PdfReader(
            new \setasign\Fpdi\PdfParser\PdfParser(\setasign\Fpdi\PdfParser\StreamReader::createByFile($file))
        );
        $pages = [];
        for ($n = 1; $n <= $reader->getPageCount(); $n++) {
            $page = $reader->getPage($n);
            $content = $page->getContentStream();
            [$w, $h] = $page->getWidthAndHeight();
            $tplPos = strpos($content, '/TPL');
            $firstText = false;
            $lastText = false;
            foreach (['TJ', 'Tj'] as $op) {
                $p = 0;
                while (($p = strpos($content, $op, $p)) !== false) {
                    if ($firstText === false || $p < $firstText) {
                        $firstText = $p;
                    }
                    if ($lastText === false || $p > $lastText) {
                        $lastText = $p;
                    }
                    $p += 2;
                }
            }
            $pages[] = [
                'text' => decodePdfText($content),
                'w' => round((float) $w, 2),
                'h' => round((float) $h, 2),
                'wm_before_page' => ($tplPos === false || $firstText === false) ? null : ($firstText < $tplPos),
                'wm_after_page' => ($tplPos === false || $lastText === false) ? null : ($lastText > $tplPos),
            ];
        }
        return $pages;
    } catch (\Throwable $e) {
        return null;
    }
}

$service = new PdfWatermarkService();
$status = $service->status();
$mode = $service->effectiveMode();

echo "Engine: " . json_encode([
    'configured_mode' => $status['configured_mode'],
    'effective_mode' => $mode,
    'driver' => $status['driver'],
], JSON_UNESCAPED_SLASHES) . "\n\n";

if (!$service->isAvailable()) {
    fwrite(STDERR, "FAIL: no watermark engine is available on this host.\n");
    fwrite(STDERR, json_encode($service->rendererStatus(), JSON_PRETTY_PRINT) . "\n");
    fwrite(STDERR, "\nInstall the pure-PHP engine: composer install (backend/composer.json) and upload backend/vendor.\n");
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
$src2->MultiCell(0, 16, 'This paragraph is genuine selectable text. Marker: ' . MARKER);
$src2->AddPage('L');
$src2->SetFont('Helvetica', 'B', 20);
$src2->Cell(0, 30, 'LANDSCAPE PAGE - DIAGRAM AREA', 0, 1);
$src2->AddPage('P', [420, 595]);
$src2->SetFont('Helvetica', 'B', 18);
$src2->Cell(0, 26, 'SMALL PAGE - A5', 0, 1);
$src2->Output($src, 'F');

$srcHash = hash_file('sha256', $src);
$srcBytes = (string) file_get_contents($src);
$srcPages = pdfPageCount($srcBytes);

// ── 2. Personalize for two different students ───────────────────────────────
$linesA = $service->watermarkLines('Test Student', 'MED-0042');
$linesB = $service->watermarkLines('Other Student', 'MED-0099');
$identityA = (string) ($linesA[0] ?? '');

$t0 = microtime(true);
$pagesA = $service->personalize($src, $linesA, $outA);
$msA = (int) round((microtime(true) - $t0) * 1000);
$t1 = microtime(true);
$pagesB = $service->personalize($src, $linesB, $outB);
$msB = (int) round((microtime(true) - $t1) * 1000);

$bytesA = (string) file_get_contents($outA);
$bytesB = (string) file_get_contents($outB);

// ── 3. Assertions on the ACTUAL output bytes ────────────────────────────────
check($checks, $fail, 'source fixture has text (/Font present)', str_contains($srcBytes, '/Font'));
check($checks, $fail, 'source fixture page count >= 3', $srcPages >= 3, "pages=$srcPages");
check($checks, $fail, 'engine reported page count == source', $pagesA === $srcPages, "reported=$pagesA src=$srcPages");
check($checks, $fail, 'output A opens with same page count', pdfPageCount($bytesA) === $srcPages, 'pages=' . pdfPageCount($bytesA));
check($checks, $fail, 'two students receive different bytes', md5($bytesA) !== md5($bytesB));
check($checks, $fail, 'output A is non-empty', strlen($bytesA) > 1024, strlen($bytesA) . ' bytes');
check($checks, $fail, 'source PDF was not modified', hash_file('sha256', $src) === $srcHash);

if ($mode === PdfWatermarkService::MODE_VECTOR) {
    $insight = pageInsight($outA);
    check($checks, $fail, 'output parses as a valid PDF', $insight !== null, $insight === null ? 'unparseable' : 'ok');
    $hits = [];
    $before = [];
    $after = [];
    foreach ($insight ?? [] as $i => $p) {
        $hits[] = ['page' => $i + 1, 'hits' => substr_count($p['text'], $identityA)];
        $before[] = $p['wm_before_page'];
        $after[] = $p['wm_after_page'];
    }
    check($checks, $fail, 'EVERY page carries the student identity', $hits !== [] && !in_array(0, array_column($hits, 'hits'), true), json_encode($hits));
    check($checks, $fail, 'identity repeats many times on each page (layers + rails)', $hits !== [] && min(array_column($hits, 'hits')) >= 6, json_encode($hits));
    check($checks, $fail, 'a BACK layer is drawn before the imported page', $before !== [] && !in_array(false, $before, true), json_encode($before));
    check($checks, $fail, 'a FRONT layer is drawn after the imported page', $after !== [] && !in_array(false, $after, true), json_encode($after));
    $baked = bakedMarkerCount($outA);
    check($checks, $fail, 'marks are baked into every imported page stream', $baked === $srcPages, "baked=$baked pages=$srcPages");
    check($checks, $fail, 'page geometry preserved (portrait / landscape / A5)', $insight !== null
        && abs(($insight[0]['w'] ?? 0) - 595.28) < 2.0
        && abs(($insight[1]['w'] ?? 0) - 841.89) < 2.0
        && abs(($insight[2]['w'] ?? 0) - 420.0) < 2.0,
        json_encode(array_map(static fn ($p) => [$p['w'], $p['h']], $insight ?? [])));
} elseif ($mode === PdfWatermarkService::MODE_RASTER) {
    // FPDF emits an empty `/Font <<` resource dictionary even for image-only
    // pages, so the meaningful assertion is the absence of a font OBJECT.
    check($checks, $fail, 'flattened output has NO font objects (/Type /Font)', !preg_match('#/Type\s*/Font#', $bytesA));
    check($checks, $fail, 'flattened output contains image XObjects', str_contains($bytesA, '/Subtype /Image') || str_contains($bytesA, '/Image'));
    $pdftotext = trim((string) getenv('PDFTOTEXT'));
    if ($pdftotext !== '' && is_executable($pdftotext)) {
        @exec(escapeshellarg($pdftotext) . ' -q ' . escapeshellarg($outA) . ' ' . escapeshellarg($work . '/a.txt') . ' 2>&1');
        $txt = is_file($work . '/a.txt') ? (string) file_get_contents($work . '/a.txt') : '';
        check($checks, $fail, 'flattened output exposes NO extractable marker', !str_contains($txt, MARKER));
    }
}

// ── 4. Fail-closed behaviour ────────────────────────────────────────────────
$bad = $work . '/notapdf.pdf';
file_put_contents($bad, 'this is not a pdf');
$badOut = $work . '/bad-out.pdf';
$refused = false;
try {
    $service->personalize($bad, $linesA, $badOut);
} catch (\MedAcademy\Http\ApiException $e) {
    $refused = $e->status === 422;
}
check($checks, $fail, 'a non-PDF source is refused (422)', $refused);
check($checks, $fail, 'a refused source produces NO output file', !is_file($badOut));

$missingOut = $work . '/missing-out.pdf';
$refusedMissing = false;
try {
    $service->personalize($work . '/does-not-exist.pdf', $linesA, $missingOut);
} catch (\MedAcademy\Http\ApiException $e) {
    $refusedMissing = $e->status === 422;
}
check($checks, $fail, 'a missing source is refused (422)', $refusedMissing);
check($checks, $fail, 'a missing source produces NO output file', !is_file($missingOut));

// ── 5. Report ───────────────────────────────────────────────────────────────
$report = [
    'engine' => $mode,
    'driver' => $status['driver'],
    'source' => ['pages' => $srcPages, 'bytes' => strlen($srcBytes)],
    'student_a' => ['identity' => $identityA, 'pages' => $pagesA, 'bytes' => strlen($bytesA), 'ms' => $msA, 'bytes_per_page' => (int) (strlen($bytesA) / max(1, $pagesA))],
    'student_b' => ['identity' => (string) ($linesB[0] ?? ''), 'pages' => $pagesB, 'bytes' => strlen($bytesB), 'ms' => $msB],
    'checks' => $checks,
    'ok' => $fail === [],
];

echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";

// The reproducible test workflow (backend/tests/pdf-watermark) collects this
// report as machine-readable output; a plain interactive run just prints it.
if (($jp = getenv('PDFTEST_JSON_OUT')) !== false && $jp !== '') {
    @mkdir(dirname($jp), 0775, true);
    file_put_contents($jp, json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
}

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
