<?php

declare(strict_types=1);

/**
 * make_size_fixtures.php — synthetic lesson PDFs for the worker-performance matrix.
 *
 * Builds four disposable source documents that look like real lecture material
 * (scanned/image pages plus a text line) at roughly 100 KB, 1 MB, 5 MB and 10 MB.
 * Nothing is committed and nothing leaves the machine: the files are written to a
 * scratch directory and the JSON on stdout records what was actually produced, so
 * a report can cite measured bytes instead of the target it hoped for.
 *
 * WHY IMAGES: file size in real lesson material comes from rasterised pages, and
 * that is also the expensive case for the renderer (one XObject per page to
 * decode and re-emit). Text-only padding would inflate the byte count without
 * costing the worker anything, which would make the measurement a lie.
 *
 * USAGE
 *   php backend/tests/material-queue/make_size_fixtures.php --out=<dir> [--sizes=100k,1m,5m,10m]
 *
 * Refuses to run against a production environment (it only writes local files,
 * but the suite it feeds writes rows, so the guard is shared).
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
require $root . '/backend/src/bootstrap.php';

use MedAcademy\Utils\Config;

Config::init();
if (Config::string('APP_ENV', 'production') === 'production') {
    fwrite(STDERR, "Refusing to run: APP_ENV=production.\n");
    exit(2);
}

if (!extension_loaded('gd')) {
    fwrite(STDERR, "GD is required to build the image pages.\n");
    exit(1);
}

$args = [];
foreach (array_slice($argv, 1) as $arg) {
    if (!str_starts_with($arg, '--')) {
        continue;
    }
    $parts = explode('=', substr($arg, 2), 2);
    $args[$parts[0]] = $parts[1] ?? '1';
}

$outDir = (string) ($args['out'] ?? $root . '/.freebuff/pdf-worker-bench/fixtures');
if (!is_dir($outDir) && !@mkdir($outDir, 0775, true) && !is_dir($outDir)) {
    fwrite(STDERR, "Cannot create {$outDir}\n");
    exit(1);
}

$sizes = [];
foreach (explode(',', (string) ($args['sizes'] ?? '100k,1m,5m,10m')) as $label) {
    $label = strtolower(trim($label));
    $bytes = match ($label) {
        '100k' => 102400,
        '1m' => 1048576,
        '5m' => 5 * 1048576,
        '10m' => 10 * 1048576,
        default => null,
    };
    if ($bytes !== null) {
        $sizes[$label] = $bytes;
    }
}
if ($sizes === []) {
    fwrite(STDERR, "No valid --sizes value (use e.g. 100k,1m,5m,10m).\n");
    exit(1);
}

// The app's real PDF stack (backend/vendor), exactly as PdfWatermarkService loads it.
foreach ([$root . '/backend/vendor/autoload.php', $root . '/backend/vendor/setasign/fpdf/fpdf.php'] as $lib) {
    if (is_file($lib)) {
        require_once $lib;
    }
}
if (!class_exists('FPDF')) {
    fwrite(STDERR, "FPDF is not installed (backend/vendor). Run composer install first.\n");
    exit(1);
}

/** A distinct, poorly-compressible raster page (a real scan is not a flat colour). */
function build_raster(string $path, int $seed, int $w = 900, int $h = 1200, int $quality = 55): int
{
    $im = imagecreatetruecolor($w, $h);
    $base = [($seed * 37) % 200 + 30, ($seed * 61) % 180 + 40, ($seed * 97) % 160 + 50];
    for ($y = 0; $y < $h; $y += 4) {
        $t = $y / $h;
        $c = imagecolorallocate(
            $im,
            (int) ($base[0] * (1 - $t) + 245 * $t),
            (int) ($base[1] * (1 - $t) + 248 * $t),
            (int) ($base[2] * (1 - $t) + 252 * $t)
        );
        imagefilledrectangle($im, 0, $y, $w, $y + 3, $c);
    }
    // Fine-grained text-like noise: JPEG keeps it, so the bytes are honest work.
    for ($i = 0; $i < 2600; $i++) {
        $x = mt_rand(10, $w - 10);
        $y = mt_rand(10, $h - 10);
        $len = mt_rand(20, 120);
        $c = imagecolorallocate($im, mt_rand(20, 120), mt_rand(20, 120), mt_rand(20, 120));
        imageline($im, $x, $y, min($w - 1, $x + $len), $y + mt_rand(-1, 1), $c);
    }
    imagejpeg($im, $path, $quality);
    imagedestroy($im);
    clearstatcache(true, $path);
    return (int) @filesize($path);
}

/**
 * Raster shaping per size class.
 *
 * A 100 KB lecture handout is a couple of lightly-scanned pages, not forty short
 * ones, so the smallest class uses smaller rasters rather than fewer big pages —
 * otherwise the per-page cost of the benchmark would not match the file size.
 *
 * @return array{w:int,h:int,quality:int,pages:int}
 */
function raster_plan(int $targetBytes, int $probeBytes): array
{
    if ($targetBytes <= 200 * 1024) {
        // One scanned page: a ~100 KB handout is one light raster page, and two
        // would report a 2.4x larger document than the class it claims to test.
        return ['w' => 700, 'h' => 950, 'quality' => 45, 'pages' => 1];
    }
    return ['w' => 900, 'h' => 1200, 'quality' => 55, 'pages' => max(2, (int) ceil($targetBytes / max(1, $probeBytes)))];
}

$scratch = $outDir . '/raster';
if (!is_dir($scratch)) {
    @mkdir($scratch, 0775, true);
}

$result = ['generated_at' => gmdate('c'), 'fixtures' => []];

foreach ($sizes as $label => $target) {
    $seedBase = strlen($label) * 31;
    $probe = build_raster($scratch . '/probe.jpg', 7);
    $plan = raster_plan($target, $probe);
    $pages = $plan['pages'];

    $path = $outDir . "/source-{$label}.pdf";
    $pdf = new FPDF('P', 'pt', 'A4');
    $pdf->SetTitle('MedAcademy workload fixture ' . $label);
    $pdf->SetAuthor('MedAcademy test fixture');
    $pdf->SetMargins(28, 28, 28);
    $pdf->SetAutoPageBreak(false);

    $images = [];
    for ($p = 0; $p < $pages; $p++) {
        $pdf->AddPage();
        $pdf->SetFont('Helvetica', '', 9);
        $pdf->SetTextColor(90, 90, 90);
        $pdf->SetXY(28, 18);
        $pdf->Cell(0, 12, 'MedAcademy synthetic lecture page ' . ($p + 1) . ' of ' . $pages . '  [' . $label . ']', 0, 0, 'L');
        $img = $scratch . "/page-{$label}-{$p}.jpg";
        if (!is_file($img)) {
            build_raster($img, $seedBase + $p, $plan['w'], $plan['h'], $plan['quality']);
        }
        // A page-sized raster: the shape a scanned/exported handout has, and the
        // case the renderer has to decode and re-emit page by page.
        $pdf->Image($img, 28, 34, 539, 0, 'JPEG');
        $pdf->SetFont('Helvetica', '', 8);
        $pdf->SetTextColor(120, 120, 120);
        $pdf->SetXY(28, 806);
        $pdf->Cell(0, 10, 'LECTURE-TEXT-MARKER-ALPHA', 0, 0, 'L');
    }
    $pdf->Output('F', $path);
    clearstatcache(true, $path);

    $bytes = (int) @filesize($path);
    $result['fixtures'][] = [
        'label' => $label,
        'target_bytes' => $target,
        'path' => $path,
        'bytes' => $bytes,
        'pages' => $pages,
        'images' => $pages,
        'raster' => $plan,
        'sha256' => (string) @hash_file('sha256', $path),
    ];
}

echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n";
