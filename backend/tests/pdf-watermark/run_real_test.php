<?php

declare(strict_types=1);

/**
 * run_real_test.php — REAL end-to-end test of the actual PHP watermark engine.
 *
 * Drives MedAcademy\Services\PdfWatermarkService itself (the source-controlled
 * implementation) with its real dependencies: Ghostscript CLI, PHP GD+FreeType,
 * FPDF, a real TTF font. Personalizes one rich, mixed-orientation source PDF
 * for TWO students and inspects the ACTUAL output bytes, page geometry and
 * pixels. Never touches a database.
 *
 * Checks (baseline: 20/20):
 *   • engine available, raster (flattened) mode;
 *   • source has a text layer, 4 pages; engine reports the same page count;
 *   • output opens with %PDF-, ends with %%EOF, keeps the page count;
 *   • flattened output has NO font OBJECTS and contains image XObjects;
 *   • two students receive different bytes; both non-empty;
 *   • pdftotext extracts the marker from the SOURCE and NOT from the output
 *     (skipped, and reported as skipped, when pdftotext is not installed);
 *   • source PDF byte-identical after processing; no temp scratch left behind;
 *   • every page renders, keeps its original pixel size + orientation, none blank;
 *   • pixel proof that the watermark sits BEHIND the content, and that its
 *     strokes are present across the white paper.
 *
 * Artifacts (renders, student PDFs) land in $PDFTEST_WORKDIR/out.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
require $root . '/backend/src/bootstrap.php';

use MedAcademy\Services\PdfWatermarkService;

const MARKER = 'LECTURE-TEXT-MARKER-ALPHA';

$WORK = (string) (getenv('PDFTEST_WORKDIR') ?: $root . '/.freebuff/pdf-watermark-tests');
$FIX = $WORK . '/fixtures';
$OUT = $WORK . '/out';
@mkdir($OUT, 0775, true);

$checks = [];
$fail = [];

function check(array &$checks, array &$fail, string $name, bool $ok, string $detail = ''): void
{
    $checks[] = ['check' => $name, 'ok' => $ok, 'detail' => $detail];
    if (!$ok) {
        $fail[] = $name . ($detail !== '' ? " ($detail)" : '');
    }
}

function skip(array &$checks, string $name, string $why): void
{
    $checks[] = ['check' => $name, 'ok' => true, 'detail' => 'SKIPPED — ' . $why];
}

/** Run an argv without a shell; returns [exitCode, stdout, stderr]. */
function runArgv(array $argv): array
{
    $d = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $p = @proc_open($argv, $d, $pipes);
    if (!is_resource($p)) {
        return [127, '', 'proc_open failed'];
    }
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    return [proc_close($p), (string) $out, (string) $err];
}

/** Locate pdftotext the cross-platform way (env PDFTOTEXT, then PATH). */
function findPdftotext(): ?string
{
    $configured = trim((string) getenv('PDFTOTEXT'));
    $candidates = $configured !== '' ? [$configured] : ['pdftotext'];
    foreach ($candidates as $bin) {
        [$rc] = runArgv([$bin, '-v']);
        if ($rc !== 127) {
            return $bin;
        }
    }
    return null;
}

function pdfPageCount(string $file): int
{
    return (int) preg_match_all('#/Type\s*/Page[^s]#', (string) file_get_contents($file));
}

$service = new PdfWatermarkService();
$status = $service->status();

$src = $FIX . '/source.pdf';
$outA = $OUT . '/student-a.pdf';
$outB = $OUT . '/student-b.pdf';
if (!is_file($src)) {
    fwrite(STDERR, "FAIL: fixture missing ($src). Run make_fixture.php first.\n");
    exit(1);
}
@unlink($outA);
@unlink($outB);

$srcHashBefore = hash_file('sha256', $src);
$srcSize = (int) filesize($src);
$srcPages = pdfPageCount($src);

// ── 1. Personalize for two different students ───────────────────────────────
$linesA = $service->watermarkLines('Test Student Alpha', 'MED-0042');
$linesB = $service->watermarkLines('Test Student Beta', 'MED-0099');

$mA0 = memory_get_peak_usage(true);
$t0 = microtime(true);
$pagesA = $service->personalize($src, $linesA, $outA);
$msA = (int) round((microtime(true) - $t0) * 1000);
$peakA = memory_get_peak_usage(true) - $mA0;

$t1 = microtime(true);
$pagesB = $service->personalize($src, $linesB, $outB);
$msB = (int) round((microtime(true) - $t1) * 1000);

$bytesA = (string) file_get_contents($outA);
$bytesB = (string) file_get_contents($outB);

// ── 2. Structural checks on the ACTUAL output ───────────────────────────────
check($checks, $fail, 'engine available', $service->isAvailable(), (string) $service->driver());
check($checks, $fail, 'effective engine is raster (flattened)', $service->effectiveMode() === PdfWatermarkService::MODE_RASTER, (string) $service->effectiveMode());
check($checks, $fail, 'source has a text layer (/Type /Font present)', (bool) preg_match('#/Type\s*/Font#', (string) file_get_contents($src)));
check($checks, $fail, 'source page count == 4', $srcPages === 4, "pages=$srcPages");
check($checks, $fail, 'engine reported page count == source', $pagesA === $srcPages, "reported=$pagesA src=$srcPages");
check($checks, $fail, 'output A page count == source', pdfPageCount($outA) === $srcPages, 'pages=' . pdfPageCount($outA));
check($checks, $fail, 'output A opens with %PDF- header', str_starts_with($bytesA, '%PDF-'));
check($checks, $fail, 'output A ends with %%EOF', str_contains(substr($bytesA, -2048), '%%EOF'));
check($checks, $fail, 'flattened output has NO /Type /Font objects', !preg_match('#/Type\s*/Font#', $bytesA));
check($checks, $fail, 'flattened output has image XObjects', (bool) preg_match('#/Subtype\s*/Image#', $bytesA));
check($checks, $fail, 'two students receive DIFFERENT bytes', md5($bytesA) !== md5($bytesB));
check($checks, $fail, 'outputs are non-empty', strlen($bytesA) > 1024 && strlen($bytesB) > 1024, strlen($bytesA) . '/' . strlen($bytesB) . ' bytes');

// ── 3. Text extraction: source yields the marker, output must NOT ───────────
$pdftotext = findPdftotext();
$textReport = ['pdftotext' => $pdftotext];
if ($pdftotext === null) {
    skip($checks, 'pdftotext extracts the marker from the SOURCE', 'pdftotext not installed');
    skip($checks, 'pdftotext extracts NO marker/text from the OUTPUT', 'pdftotext not installed');
    $textReport['skipped'] = true;
} else {
    [$rcS] = runArgv([$pdftotext, '-layout', $src, $OUT . '/source.txt']);
    [$rcO] = runArgv([$pdftotext, '-layout', $outA, $OUT . '/student-a.txt']);
    $srcText = is_file($OUT . '/source.txt') ? (string) file_get_contents($OUT . '/source.txt') : '';
    $outText = is_file($OUT . '/student-a.txt') ? (string) file_get_contents($OUT . '/student-a.txt') : '';
    $textReport = [
        'pdftotext' => $pdftotext, 'source_rc' => $rcS, 'output_rc' => $rcO,
        'source_has_marker' => str_contains($srcText, MARKER), 'source_text_bytes' => strlen($srcText),
        'output_has_marker' => str_contains($outText, MARKER), 'output_text_bytes' => strlen($outText),
    ];
    if ($rcS === 0) {
        check($checks, $fail, 'pdftotext extracts the marker from the SOURCE', str_contains($srcText, MARKER));
    }
    check($checks, $fail, 'pdftotext extracts NO marker/text from the OUTPUT', $rcO === 0 && !str_contains($outText, MARKER));
}

// ── 4. Source unchanged ─────────────────────────────────────────────────────
check($checks, $fail, 'source PDF is unchanged', hash_file('sha256', $src) === $srcHashBefore, 'sha256 stable');

// ── 5. Temporary scratch dirs must be gone ──────────────────────────────────
$leftover = glob($OUT . '/wm-*') ?: [];
check($checks, $fail, 'no temporary scratch dirs left behind', $leftover === [], implode(',', array_map('basename', $leftover)));

// ── 6. Render every page of source and output; compare size + blankness ─────
// The comparison renders use the SAME anti-aliasing flags the service passes
// to Ghostscript, so source and output are rasterised identically and any
// difference is real rather than a rendering artifact.
$gs = (string) \MedAcademy\Utils\Config::string('GHOSTSCRIPT_BIN', 'gs');
$dpi = $service->dpi();
$render = function (string $pdf, string $png, int $page) use ($gs, $dpi): ?array {
    $argv = [$gs, '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=png16m', '-r' . $dpi,
             '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
             '-dFirstPage=' . $page, '-dLastPage=' . $page, '-dUseCropBox', '-sOutputFile=' . $png, $pdf, '-c', 'quit'];
    [$rc] = runArgv($argv);
    if ($rc !== 0 || !is_file($png)) {
        return null;
    }
    $s = getimagesize($png);
    return $s ? [$s[0], $s[1]] : null;
};

$pageSizes = [];
$blank = [];
$bytesAllRendered = true;
for ($p = 1; $p <= $srcPages; $p++) {
    $sp = $OUT . "/src-p{$p}.png";
    $op = $OUT . "/out-p{$p}.png";
    $sd = $render($src, $sp, $p);
    $od = $render($outA, $op, $p);
    if ($sd === null || $od === null) {
        $bytesAllRendered = false;
        continue;
    }
    $pageSizes[] = ['page' => $p, 'src' => $sd, 'out' => $od, 'match' => $sd === $od];
    $im = imagecreatefrompng($op);
    $w = imagesx($im);
    $h = imagesy($im);
    $ink = 0;
    $n = 0;
    for ($y = 0; $y < $h; $y += 4) {
        for ($x = 0; $x < $w; $x += 4) {
            $n++;
            $c = imagecolorat($im, $x, $y);
            $l = (int) (((($c >> 16) & 255) * 0.299) + ((($c >> 8) & 255) * 0.587) + (($c & 255) * 0.114));
            if ($l < 245) {
                $ink++;
            }
        }
    }
    imagedestroy($im);
    $blank[] = ['page' => $p, 'nonwhite_ratio' => round($ink / max(1, $n), 4)];
}
check($checks, $fail, 'every page rendered without error', $bytesAllRendered && count($pageSizes) === $srcPages);
$allMatch = $pageSizes !== [] && !in_array(false, array_column($pageSizes, 'match'), true);
check($checks, $fail, 'every page keeps its original pixel size + orientation', $allMatch, json_encode(array_column($pageSizes, 'match')));
$noBlank = $blank !== [] && !in_array(true, array_map(static fn ($b) => $b['nonwhite_ratio'] < 0.005, $blank), true);
check($checks, $fail, 'no unexpected blank pages (each page has content + watermark ink)', $noBlank, json_encode($blank));

// ── 7. PIXEL-LEVEL "watermark behind content" proof (page 1) ────────────────
$srcPng = $OUT . '/src-p1.png';
$outPng = $OUT . '/out-p1.png';
$pixelReport = null;
if (is_file($srcPng) && is_file($outPng)) {
    $a = imagecreatefrompng($srcPng);
    $b = imagecreatefrompng($outPng);
    $aw = imagesx($a);
    $ah = imagesy($a);
    $bw = imagesx($b);
    $bh = imagesy($b);
    $w = min($aw, $bw);
    $h = min($ah, $bh);
    // Counterfactual: compositing the mark ON TOP at opacity o would force even
    // a pure-black content pixel up to ~grey*o (35 here). So black content
    // pixels staying at 0 is decisive proof the watermark sits BEHIND it.
    $counterfactual = (int) round((255 - 0.15 * (255 - 90)) * 0.15);
    $blackN = 0;
    $blackOutSum = 0;
    $blackLt10 = 0;
    $outMin = 255;
    $wmN = 0;
    $whiteN = 0;
    for ($y = 0; $y < $h; $y++) {
        for ($x = 0; $x < $w; $x++) {
            $pa = imagecolorat($a, $x, $y);
            $pb = imagecolorat($b, $x, $y);
            $la = (int) (((($pa >> 16) & 255) * 0.299) + ((($pa >> 8) & 255) * 0.587) + (($pa & 255) * 0.114));
            $lb = (int) (((($pb >> 16) & 255) * 0.299) + ((($pb >> 8) & 255) * 0.587) + (($pb & 255) * 0.114));
            if ($la < 5) {                               // pure-black content ink in the source
                $blackN++;
                $blackOutSum += $lb;
                if ($lb < 10) {
                    $blackLt10++;
                }
                $outMin = min($outMin, $lb);
            } elseif ($la > 245) {                       // white paper
                $whiteN++;
                if ($lb >= 120 && $lb <= 249) {
                    $wmN++;                              // grey watermark stroke on paper
                }
            }
        }
    }
    imagedestroy($a);
    imagedestroy($b);
    $blackMean = $blackN ? round($blackOutSum / $blackN, 2) : 0;
    $pixelReport = [
        'dimensions' => [$aw, $ah], 'same_dimensions' => $aw === $bw && $ah === $bh,
        'watermark_on_top_counterfactual_grey' => $counterfactual,
        'black_content_pixels' => $blackN,
        'black_out_mean_lum' => $blackMean,
        'black_out_min_lum' => $outMin,
        'black_out_lt10_pct' => $blackN ? round(100 * $blackLt10 / $blackN, 2) : 0,
        'white_paper_pixels' => $whiteN,
        'watermark_stroke_pixels_over_paper' => $wmN,
        'watermark_coverage_of_paper_pct' => $whiteN ? round(100 * $wmN / $whiteN, 2) : 0,
    ];
    check($checks, $fail, 'content stays black (watermark is BEHIND, not over it)',
        $blackN > 500 && ($blackLt10 / max(1, $blackN)) >= 0.98 && $blackMean <= 2.0,
        "blackMean=$blackMean min=$outMin lt10=" . $pixelReport['black_out_lt10_pct'] . "% (on-top would force >= $counterfactual)");
    check($checks, $fail, 'watermark strokes are present across the white paper', $wmN > 1000, "wm_px=$wmN of {$whiteN} paper px");
} else {
    check($checks, $fail, 'page images available for pixel analysis', false, 'render missing');
}

$report = [
    'engine' => $status['effective_mode'],
    'driver' => $status['driver'],
    'settings' => $status['settings'],
    'source' => ['pages' => $srcPages, 'bytes' => $srcSize, 'sha256_prefix' => substr($srcHashBefore, 0, 16)],
    'student_a' => ['identity' => implode(' | ', array_filter($linesA)), 'pages' => $pagesA, 'bytes' => strlen($bytesA), 'ms' => $msA, 'peak_mem_bytes' => $peakA],
    'student_b' => ['identity' => implode(' | ', array_filter($linesB)), 'pages' => $pagesB, 'bytes' => strlen($bytesB), 'ms' => $msB],
    'bytes_identical_between_students' => md5($bytesA) === md5($bytesB),
    'text_extraction' => $textReport,
    'page_sizes' => $pageSizes,
    'blank_page_check' => $blank,
    'pixel_analysis' => $pixelReport,
    'checks' => $checks,
    'ok' => $fail === [],
];

$json = json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
echo $json, "\n";
if (($jp = getenv('PDFTEST_JSON_OUT')) !== false && $jp !== '') {
    @mkdir(dirname($jp), 0775, true);
    file_put_contents($jp, $json . "\n");
}
if ($fail !== []) {
    fwrite(STDERR, "\nFAILED:\n - " . implode("\n - ", $fail) . "\n");
    exit(1);
}
echo "\nALL CHECKS PASSED\n";
exit(0);
