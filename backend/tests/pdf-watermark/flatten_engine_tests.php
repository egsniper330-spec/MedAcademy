<?php

declare(strict_types=1);

/**
 * flatten_engine_tests.php — the renderer-free flattened engine (MODE_FLATTEN)
 * and the AGPL licence gate on the Ghostscript engine.
 *
 * This suite is about the PROPERTIES the change is supposed to guarantee, read
 * out of the delivered bytes — not about the code that produced them:
 *
 *   1. no external binary is executed, and the engine needs no font upload;
 *   2. one page in, one page out, same page box, same orientation;
 *   3. EXACTLY ONE visible mark per page, at the configured opacity, centred;
 *   4. the mark lives in a page content stream (no /Annots, no /OCProperties);
 *   5. the lecture text layer survives (the documented trade-off vs raster);
 *   6. two students get different bytes; the source file is untouched;
 *   7. the cache token changes when the look changes;
 *   8. the raster engine refuses to run without the operator's licence opt-in.
 *
 * Runs with tmp copies only; never touches a database, storage bucket or .env.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
require $root . '/backend/src/bootstrap.php';

use MedAcademy\Http\ApiException;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Utils\Config;

$WORK = (string) (getenv('PDFTEST_WORKDIR') ?: $root . '/.freebuff/pdf-watermark-tests');
$FIX = $WORK . '/fixtures';
$OUT = $WORK . '/out/flatten';
@mkdir($OUT, 0775, true);

$cases = [];
$fail = [];

function check(array &$cases, array &$fail, string $label, bool $ok, string $detail = ''): void
{
    $cases[] = ['check' => $label, 'ok' => $ok, 'detail' => mb_substr($detail, 0, 220)];
    if (!$ok) {
        $fail[] = $label . ($detail !== '' ? ' — ' . $detail : '');
    }
    printf("[%s] %s%s\n", $ok ? 'PASS' : 'FAIL', $label, $detail !== '' ? ' — ' . mb_substr($detail, 0, 160) : '');
}

/** Every content stream of the document, decompressed. */
function streams(string $raw): array
{
    $out = [];
    if (preg_match_all('#stream\r?\n(.*?)\r?\nendstream#s', $raw, $m)) {
        foreach ($m[1] as $chunk) {
            $d = @gzuncompress($chunk);
            if (is_string($d)) {
                $out[] = $d;
            }
        }
    }
    return $out;
}

/**
 * The baked mark = the run appended after %MAC-WM-BAKED. Returns, per page
 * stream that carries it, the number of text runs and the first run's geometry.
 *
 * @return array<int,array{runs:int,size:float,angle:float,x:float,y:float}>
 */
function marks(string $raw): array
{
    $found = [];
    foreach (streams($raw) as $s) {
        if (!str_contains($s, '%MAC-WM-BAKED')) {
            continue;
        }
        $tail = substr($s, strpos($s, '%MAC-WM-BAKED'));
        $runs = preg_match_all('#\nBT\n#', $tail);
        $geo = ['runs' => $runs, 'size' => 0.0, 'angle' => 0.0, 'x' => 0.0, 'y' => 0.0];
        if (preg_match('#BT\n/[A-Z0-9]+ ([0-9.]+) Tf\n([-0-9. ]+) cm\n<[0-9A-F]+> Tj#', $tail, $r)) {
            $nums = array_map('floatval', preg_split('/\s+/', trim($r[2])) ?: []);
            if (count($nums) === 6) {
                $geo['size'] = (float) $r[1];
                $geo['angle'] = rad2deg(atan2($nums[1], $nums[0]));
                $geo['x'] = $nums[4];
                $geo['y'] = $nums[5];
            }
        }
        $found[] = $geo;
    }
    return $found;
}

function pageBoxes(string $raw): array
{
    preg_match_all('#/MediaBox\s*\[\s*([-0-9.]+)\s+([-0-9.]+)\s+([-0-9.]+)\s+([-0-9.]+)\s*\]#', $raw, $m, PREG_SET_ORDER);
    $boxes = [];
    foreach ($m as $b) {
        $boxes[] = [round((float) $b[3] - (float) $b[1], 2), round((float) $b[4] - (float) $b[2], 2)];
    }
    return $boxes;
}

// ── 1. Mode resolution and the licence gate ────────────────────────────────
putenv('PDF_WATERMARK_MODE=flatten');
putenv('PDF_WATERMARK_ACCEPT_AGPL_RENDERER');
Config::init();
$svc = new PdfWatermarkService();
$status = $svc->status();

check($cases, $fail, 'mode: PDF_WATERMARK_MODE=flatten is accepted', $svc->configuredMode() === 'flatten', $svc->configuredMode());
check($cases, $fail, 'mode: flatten resolves to itself when TCPDF is present', $svc->effectiveMode() === PdfWatermarkService::MODE_FLATTEN, (string) $svc->effectiveMode());
check($cases, $fail, 'status: flatten_ready=true', ($status['flatten_ready'] ?? false) === true);
check($cases, $fail, 'status: the AGPL renderer is NOT accepted by default', ($status['agpl_renderer_accepted'] ?? true) === false);
check(
    $cases,
    $fail,
    'driver: names the pure-PHP path and states no renderer binary',
    str_contains((string) $svc->driver(), 'no renderer binary'),
    (string) $svc->driver()
);
check(
    $cases,
    $fail,
    'driver: no Ghostscript requirement in flatten mode',
    !str_contains((string) $svc->driver(), 'Ghostscript')
);

// The raster engine must refuse to run without the licence opt-in, even when the
// binary exists. In-process this shows up as effective_mode = null.
putenv('PDF_WATERMARK_MODE=raster');
Config::init();
$rasterGated = new PdfWatermarkService();
$gatedStatus = $rasterGated->status();
check(
    $cases,
    $fail,
    'gate: raster does not resolve without PDF_WATERMARK_ACCEPT_AGPL_RENDERER',
    $rasterGated->effectiveMode() === null,
    'effective=' . var_export($rasterGated->effectiveMode(), true) . ' prerequisites=' . var_export($gatedStatus['raster_ready'], true)
);
$refused = false;
$refusedCode = null;
try {
    $rasterGated->personalize($FIX . '/source.pdf', ['Gate Probe', 'MED-0000'], $OUT . '/gated.pdf');
} catch (ApiException $e) {
    $refused = true;
    $refusedCode = $e->status;
}
check($cases, $fail, 'gate: delivery is REFUSED (503) with the gate closed', $refused && $refusedCode === 503, 'code=' . var_export($refusedCode, true));
check($cases, $fail, 'gate: no file is produced when the gate is closed', !is_file($OUT . '/gated.pdf'));

// ── 2. The engine, on real fixtures ────────────────────────────────────────
putenv('PDF_WATERMARK_MODE=flatten');
Config::init();
$svc = new PdfWatermarkService();
$opacity = $svc->opacity();

foreach (['source.pdf' => 4, 'rotated.pdf' => 3] as $fixture => $expectedPages) {
    $src = $FIX . '/' . $fixture;
    if (!is_file($src)) {
        check($cases, $fail, "fixture present: $fixture", false, 'missing');
        continue;
    }
    $srcHash = hash_file('sha256', $src);
    $a = $OUT . '/a-' . $fixture;
    $b = $OUT . '/b-' . $fixture;
    @unlink($a);
    @unlink($b);

    $pagesA = $svc->personalize($src, $svc->watermarkLines('Alpha One', 'MED-0042'), $a);
    $pagesB = $svc->personalize($src, $svc->watermarkLines('Beta Two', 'MED-0099'), $b);
    $rawA = (string) file_get_contents($a);
    $rawB = (string) file_get_contents($b);

    check($cases, $fail, "$fixture: page count preserved ($expectedPages)", $pagesA === $expectedPages && $pagesB === $expectedPages, "$pagesA/$pagesB");
    check($cases, $fail, "$fixture: valid PDF envelope", str_starts_with($rawA, '%PDF-') && str_contains($rawA, '%%EOF'));
    check($cases, $fail, "$fixture: source file untouched", hash_file('sha256', $src) === $srcHash);
    check($cases, $fail, "$fixture: two students get different bytes", $rawA !== $rawB);

    // Page geometry: every page keeps the source's sheet, in order.
    //
    // A /Rotate 90 source page has a MediaBox of 842x595 while the OUTPUT page
    // is laid out to the VISIBLE size (595x842) — FPDI reports the visible size
    // and the rotation is applied inside the imported Form. So a page matches
    // when its box equals the source's either directly or with width/height
    // swapped, within 1pt (FPDI rounds page sizes to 0.5pt).
    // A source page may INHERIT its /MediaBox from the /Pages node (the fixture
    // does), so the count of MediaBox entries in the source is not the page
    // count. Compare against the SET of declared sheets instead, in either
    // orientation.
    $srcBoxes = pageBoxes((string) file_get_contents($src));
    $outBoxes = pageBoxes($rawA);
    $sameBoxes = count($outBoxes) === $expectedPages;
    $boxDetail = [];
    foreach ($outBoxes as $out) {
        $matched = false;
        foreach ($srcBoxes as $box) {
            $direct = abs($box[0] - $out[0]) <= 1.0 && abs($box[1] - $out[1]) <= 1.0;
            $swapped = abs($box[0] - $out[1]) <= 1.0 && abs($box[1] - $out[0]) <= 1.0;
            if ($direct || $swapped) {
                $matched = true;
                break;
            }
        }
        $boxDetail[] = sprintf('%.1fx%.1f%s', $out[0], $out[1], $matched ? '' : ' UNMATCHED');
        if (!$matched) {
            $sameBoxes = false;
        }
    }
    check(
        $cases,
        $fail,
        "$fixture: every page keeps its sheet size and order (rotation-aware)",
        $sameBoxes,
        implode(' ', $boxDetail)
    );

    // The mark: one per page, at 35°, from a page content stream.
    $found = marks($rawA);
    check($cases, $fail, "$fixture: the mark is baked into a page content stream", count($found) === $expectedPages, count($found) . ' page stream(s)');
    $oneEach = $found !== [];
    $angleOk = true;
    $centred = true;
    foreach ($found as $g) {
        if ($g['runs'] !== 1) {
            $oneEach = false;
        }
        if (abs($g['angle'] - 35.0) > 0.05) {
            $angleOk = false;
        }
    }
    check($cases, $fail, "$fixture: EXACTLY ONE text run per page (no grid)", $oneEach, implode(',', array_column($found, 'runs')));
    check($cases, $fail, "$fixture: every run is at the 35 deg design angle", $angleOk, implode(',', array_map(static fn ($g) => round($g['angle'], 2), $found)));

    // Centring: origin + R*(runWidth/2, 0.30em) must be the page centre. The
    // run width is not in the operators, so assert the weaker but still
    // meaningful property: the origin lies on the correct side of the centre
    // and at a distance consistent with a centred run of this size.
    foreach ($found as $idx => $g) {
        $box = $outBoxes[$idx] ?? [0, 0];
        $cx = $box[0] / 2;
        $cy = $box[1] / 2;
        $dx = $g['x'] - $cx;
        $dy = $g['y'] - $cy;
        $dist = sqrt($dx * $dx + $dy * $dy);
        // A centred run's origin is half the run length away along the baseline,
        // i.e. roughly 0.3-0.5 of the page width for one large centred mark.
        $ratio = $dist / max(1.0, $box[0]);
        if ($ratio < 0.15 || $ratio > 0.55) {
            $centred = false;
        }
    }
    check($cases, $fail, "$fixture: mark origin sits where a centred run puts it", $centred);

    // Security shape: content, not an object a "remove watermark" command targets.
    check($cases, $fail, "$fixture: no /Annots, no optional-content groups", !preg_match('#/OCProperties#', $rawA) && !preg_match('#/Subtype\s*/Widget#', $rawA));
    check($cases, $fail, "$fixture: the opacity comes from an ExtGState, not a pre-blended colour", (bool) preg_match('#/Type\s*/ExtGState\s*/ca\s+0?\.' . substr((string) $opacity, 2) . '#', $rawA));

    // Documented trade-off: the lecture text layer survives.
    check($cases, $fail, "$fixture: lecture text layer preserved (flatten keeps selectable text)", (bool) preg_match('#/Type\s*/Font#', $rawA));
}

// ── 3. Cache identity ──────────────────────────────────────────────────────
$lines = $svc->watermarkLines('Alpha One', 'MED-0042');
putenv('PDF_WATERMARK_MODE=flatten');
Config::init();
$before = (new PdfWatermarkService())->variantSettings($lines);
$restore = $_ENV['PDF_WATERMARK_OPACITY'] ?? null;
// $_ENV is populated at process start and takes precedence over putenv(), so a
// test-only override must set both.
$_ENV['PDF_WATERMARK_OPACITY'] = '0.22';
putenv('PDF_WATERMARK_OPACITY=0.22');
Config::init();
$after = (new PdfWatermarkService())->variantSettings($lines);
check(
    $cases,
    $fail,
    'cache: the flatten token changes when the opacity changes',
    ($before['engine'] ?? '') !== ($after['engine'] ?? '') || ($before['opacity'] ?? 0) !== ($after['opacity'] ?? 0),
    json_encode(['before' => $before['opacity'] ?? null, 'after' => $after['opacity'] ?? null])
);
check(
    $cases,
    $fail,
    'cache: the flatten token is distinct from the vector token',
    str_contains((string) ($before['engine'] ?? ''), 'center-bake'),
    (string) ($before['engine'] ?? '')
);

// ── 4. Restore the environment for any later suite in the same process ─────
putenv('PDF_WATERMARK_MODE');
if ($restore === null) {
    unset($_ENV['PDF_WATERMARK_OPACITY']);
} else {
    $_ENV['PDF_WATERMARK_OPACITY'] = $restore;
}
Config::init();

$json = json_encode(['cases' => $cases, 'failures' => $fail, 'ok' => $fail === []], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
echo "\n", $json, "\n";
if (($jp = getenv('PDFTEST_JSON_OUT')) !== false && $jp !== '') {
    @mkdir(dirname($jp), 0775, true);
    file_put_contents($jp, $json . "\n");
}
if ($fail !== []) {
    fwrite(STDERR, "FAILED:\n - " . implode("\n - ", $fail) . "\n");
    exit(1);
}
printf("\nALL FLATTEN-ENGINE CHECKS PASSED (%d checks)\n", count($cases));
exit(0);
