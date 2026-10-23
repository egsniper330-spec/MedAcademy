<?php

declare(strict_types=1);

/**
 * make_gallery.php — build a self-contained HTML gallery of the rendered pages
 * so the watermark (behind the content) can be inspected visually.
 *
 * The gallery is written to $PDFTEST_WORKDIR/out/gallery.html as a single
 * self-contained file (all images base64-embedded). It is NEVER opened in a
 * browser automatically and NEVER uploaded anywhere — inspect it manually:
 *
 *   start "" "<work-dir>\out\gallery.html"        (Windows)
 *   open "<work-dir>/out/gallery.html"            (macOS)
 *   xdg-open "<work-dir>/out/gallery.html"        (Linux)
 *
 * Requires the renders produced by run_real_test.php (src-p1..4.png,
 * out-p1..4.png), which in turn need a working Ghostscript. Without a renderer
 * there is nothing to look at, so the suite reports SKIPPED and exits 0 instead
 * of failing — the vector pipeline itself needs no renderer at all.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
$WORK = (string) (getenv('PDFTEST_WORKDIR') ?: $root . '/.freebuff/pdf-watermark-tests');
$OUT = $WORK . '/out';
$gs = (string) (getenv('GHOSTSCRIPT_BIN') ?: 'gs');
$dpi = max(96, min(400, (int) (getenv('PDF_WATERMARK_DPI') ?: 200)));

$fail = [];

// No renderer / no renders => nothing to build. This is a SKIP, not a failure.
$probe = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
$ph = @proc_open([$gs, '--version'], $probe, $pp);
$gsOk = false;
if (is_resource($ph)) {
    fclose($pp[0]);
    stream_get_contents($pp[1]);
    stream_get_contents($pp[2]);
    fclose($pp[1]);
    fclose($pp[2]);
    $gsOk = proc_close($ph) === 0;
}
if (!$gsOk) {
    $skip = [
        'ok' => true,
        'skipped' => 'no Ghostscript renderer available — the visual gallery needs page renders; the vector pipeline needs none',
    ];
    $json = json_encode($skip, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
    // The runner reads this file; without it a clean SKIP is reported as
    // "suite crashed". Every suite must persist its verdict.
    if (($jp = getenv('PDFTEST_JSON_OUT')) !== false && $jp !== '') {
        @mkdir(dirname($jp), 0775, true);
        file_put_contents($jp, $json);
    }
    echo $json;
    exit(0);
}

function run(array $a): int
{
    $d = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $p = proc_open($a, $d, $pi);
    if (!is_resource($p)) {
        return 127;
    }
    fclose($pi[0]);
    stream_get_contents($pi[1]);
    stream_get_contents($pi[2]);
    fclose($pi[1]);
    fclose($pi[2]);
    return proc_close($p);
}

function render(string $gs, string $pdf, string $png, int $page, int $dpi): int
{
    return run([$gs, '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=png16m', '-r' . $dpi,
        '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
        '-dFirstPage=' . $page, '-dLastPage=' . $page, '-dUseCropBox', '-sOutputFile=' . $png, $pdf, '-c', 'quit']);
}

function cropScaled(string $src, string $dst, int $x, int $y, int $w, int $h, float $scale = 1.0): void
{
    $im = imagecreatefrompng($src);
    $out = imagecreatetruecolor((int) ($w * $scale), (int) ($h * $scale));
    imagecopyresampled($out, $im, 0, 0, $x, $y, (int) ($w * $scale), (int) ($h * $scale), $w, $h);
    imagepng($out, $dst, 6);
    imagedestroy($im);
    imagedestroy($out);
}

function thumb(string $src, string $dst, int $targetW): void
{
    $im = imagecreatefrompng($src);
    $w = imagesx($im);
    $h = imagesy($im);
    $scale = $targetW / $w;
    $out = imagecreatetruecolor($targetW, (int) ($h * $scale));
    imagecopyresampled($out, $im, 0, 0, 0, 0, $targetW, (int) ($h * $scale), $w, $h);
    imagepng($out, $dst, 6);
    imagedestroy($im);
    imagedestroy($out);
}

$required = ['src-p1.png', 'out-p1.png', 'student-b.pdf'];
foreach ($required as $f) {
    if (!is_file($OUT . '/' . $f)) {
        $fail[] = "missing $f — run run_real_test.php first";
    }
}
if ($fail === []) {
    // Student B page-1 render (proves the second identity's watermark too).
    if (render($gs, $OUT . '/student-b.pdf', $OUT . '/outB-p1.png', 1, $dpi) !== 0) {
        $fail[] = 'Ghostscript could not render student-b.pdf';
    }
}
if ($fail === []) {
    thumb($OUT . '/src-p1.png',  $OUT . '/g-src.png',  620);
    thumb($OUT . '/out-p1.png',  $OUT . '/g-outA.png', 620);
    thumb($OUT . '/outB-p1.png', $OUT . '/g-outB.png', 620);

    // Zoom crop over the body-text block (legibility at higher zoom) and a
    // wide crop over empty margin (proves the watermark shows through).
    cropScaled($OUT . '/src-p1.png',  $OUT . '/z-src-text.png', 140, 60, 470, 150, 3.0);
    cropScaled($OUT . '/out-p1.png',  $OUT . '/z-outA-text.png', 140, 60, 470, 150, 3.0);
    cropScaled($OUT . '/out-p1.png',  $OUT . '/z-margin.png', 20, 1600, 640, 300, 2.0);

    $b64 = fn (string $f): string => base64_encode((string) file_get_contents($f));
    $img = fn (string $f, string $cap): string => '<figure><img src="data:image/png;base64,' . $b64($OUT . '/' . $f) . '"><figcaption>' . htmlspecialchars($cap) . '</figcaption></figure>';

    $html = '<!doctype html><meta charset="utf-8"><title>MedAcademy PDF watermark — visual verification</title>'
        . '<style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px}'
        . 'h1{font-size:20px}h2{font-size:15px;color:#93c5fd;margin-top:28px}'
        . '.row{display:flex;gap:18px;flex-wrap:wrap}figure{margin:0;background:#1e293b;padding:10px;border-radius:8px}'
        . 'img{display:block;max-width:620px;height:auto}figcaption{font-size:12px;color:#94a3b8;margin-top:6px}'
        . '.zoom img{max-width:100%}</style>'
        . '<h1>MedAcademy — personalized PDF watermark, real PHP engine (Ghostscript + GD + FPDF)</h1>'
        . '<p style="font-size:12px;color:#94a3b8">Generated locally by backend/tests/pdf-watermark/make_gallery.php. '
        . 'This file is self-contained: no network requests. Inspect it manually — it is never opened or uploaded automatically.</p>'
        . '<h2>Whole page 1 — source vs Student A vs Student B (same layout, different identity)</h2>'
        . '<div class="row">' . $img('g-src.png', 'SOURCE (selectable text)') . $img('g-outA.png', 'Student A &bull; MED-0042') . $img('g-outB.png', 'Student B &bull; MED-0099') . '</div>'
        . '<h2>Zoomed 3&times; — output text stays crisp; watermark is behind the glyphs, not over them</h2>'
        . '<div class="row zoom">' . $img('z-src-text.png', 'SOURCE 3&times;') . $img('z-outA-text.png', 'Student A output 3&times;') . '</div>'
        . '<h2>Zoomed 2&times; — empty margin: the grey diagonal watermark shows on the paper</h2>'
        . '<div class="row zoom">' . $img('z-margin.png', 'Student A output margin 2&times;') . '</div>';

    file_put_contents($OUT . '/gallery.html', $html);
    if (!is_file($OUT . '/gallery.html')) {
        $fail[] = 'could not write gallery.html';
    }
}

$report = [
    'gallery' => $OUT . '/gallery.html',
    'bytes' => is_file($OUT . '/gallery.html') ? filesize($OUT . '/gallery.html') : 0,
    'failures' => $fail,
    'ok' => $fail === [],
];
$json = json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
echo $json, "\n";
if (($jp = getenv('PDFTEST_JSON_OUT')) !== false && $jp !== '') {
    @mkdir(dirname($jp), 0775, true);
    file_put_contents($jp, $json . "\n");
}
if ($fail !== []) {
    fwrite(STDERR, "GALLERY FAILED:\n - " . implode("\n - ", $fail) . "\n");
    exit(1);
}
echo 'gallery written: ' . $report['gallery'] . ' (' . $report['bytes'] . " bytes)\n";
echo "Inspect manually (never auto-opened):\n  start \"\" \"{$report['gallery']}\"\n";
exit(0);
