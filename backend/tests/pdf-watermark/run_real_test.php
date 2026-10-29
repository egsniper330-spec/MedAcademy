<?php

declare(strict_types=1);

/**
 * run_real_test.php — REAL end-to-end test of the actual PHP watermark engine.
 *
 * Drives MedAcademy\Services\PdfWatermarkService itself (the source-controlled
 * implementation) with its real dependencies, then inspects the ACTUAL output
 * bytes, page geometry, page content streams and (when a renderer is available)
 * pixels. Two students are personalized from the same source. Never touches a
 * database.
 *
 * Student delivery must resolve to the RASTER engine, gated on Ghostscript,
 * the configured compositor/font, and the operator's licence acknowledgement.
 * Legacy vector and flatten modes are explicitly expected to fail closed:
 *
 *   raster  : page count preserved; both identities produce different pixels;
 *             there are no font/form/vector/annotation objects or text layer;
 *             every page passes a page-by-page centered single-mark pixel proof.
 *   rotated : /Rotate 90 and /Rotate 180 pages are rasterized at visible size,
 *             and each page passes its own centered-single-mark pixel proof.
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

/**
 * Content-bake scan. Streams may be FlateDecode (backend TCPDF) or plain
 * (older test vendor), so decode BEFORE searching for the marker — a raw
 * byte scan silently misses compressed bakes and under-reports to zero.
 *
 * Returns baked/rotated/wrapped/badmatrix:
 *  · baked    — Form XObjects whose stream carries PdfWatermarkBaker::MARKER
 *  · rotated  — of those, forms whose /Matrix is non-identity (FPDI stores
 *               the source page's /Rotate here; the bake must pre-multiply
 *               the inverse so marks land upright in page coordinates)
 *  · wrapped  — rotated forms with `q <matrix-inverse> cm` right after the marker
 */
function bakedFormScan(string $raw): array
{
    $out = ['baked' => 0, 'rotated' => 0, 'wrapped' => 0, 'badmatrix' => 0];
    // Walk every `stream` keyword. A raw `N 0 obj` slice is UNSAFE here: the
    // compressed payload can contain the byte sequence "123 0 obj", which
    // desynchronises regex slicing and silently loses whole objects. The
    // dictionary immediately before the keyword is ASCII and authoritative:
    // /Subtype /Form + /Length give us both identity and exact payload size.
    $off = 0;
    while (($sp = strpos($raw, 'stream', $off)) !== false) {
        $off = $sp + 6;
        $head = substr($raw, max(0, $sp - 800), 800);
        if (!preg_match('#/Subtype\s*/Form#', $head, $sm, PREG_OFFSET_CAPTURE)) {
            continue;
        }
        if (!preg_match('#/Length\s+(\d+)#', $head, $lm, PREG_OFFSET_CAPTURE)) {
            continue;
        }
        // Both keys must belong to THIS dict: /Subtype before /Length, and
        // /Length within 600 bytes of the keyword. Offsets are HEAD-relative
        // (head always ends exactly at $sp), so compare within the head.
        $headLen = strlen($head);
        if ($sm[0][1] > $lm[0][1] || $headLen - $lm[0][1] > 600) {
            continue;
        }
        $len = (int) $lm[1][0];
        $ps = $sp + 6;
        if (substr($raw, $ps, 2) === "\r\n") {
            $ps += 2;
        } elseif (substr($raw, $ps, 1) === "\n") {
            $ps += 1;
        } else {
            continue;
        }
        $payload = substr($raw, $ps, $len);
        if (strlen($payload) !== $len) {
            continue;
        }
        $decoded = str_contains($head, '/FlateDecode') ? @gzuncompress($payload) : $payload;
        if (!is_string($decoded) || !str_contains($decoded, '%MAC-WM-BAKED')) {
            continue;
        }
        $out['baked']++;
        if (!preg_match('#/Matrix\s*\[([^\]]*)\]#', $head, $mm)) {
            continue; // identity by absence
        }
        if (!preg_match_all('#-?\d+(?:\.\d+)?#', $mm[1], $nm) || count($nm[0]) !== 6) {
            $out['badmatrix']++;
            continue;
        }
        $a = array_map('floatval', $nm[0]);
        if (abs($a[0] - 1) < 1e-4 && abs($a[1]) < 1e-4 && abs($a[2]) < 1e-4
            && abs($a[3] - 1) < 1e-4 && abs($a[4]) < 1e-4 && abs($a[5]) < 1e-4) {
            continue; // identity matrix
        }
        $out['rotated']++;
        $det = $a[0] * $a[3] - $a[1] * $a[2];
        if (abs($det) < 1e-9) {
            $out['badmatrix']++;
            continue;
        }
        [$ma, $mb, $mc, $md, $me, $mf] = $a;
        $inv = [$md / $det, -$mb / $det, -$mc / $det, $ma / $det,
            ($mc * $mf - $md * $me) / $det, ($mb * $me - $ma * $mf) / $det];
        if (!preg_match('#%MAC-WM-BAKED\s*\nq ((?:-?\d+(?:\.\d+)?\s+){5}-?\d+(?:\.\d+)?)\s+cm#', $decoded, $wm)) {
            continue;
        }
        preg_match_all('#-?\d+(?:\.\d+)?#', $wm[1], $wn);
        $got = array_map('floatval', $wn[0]);
        $okW = count($got) === 6;
        foreach ($got as $k => $v) {
            if (abs($v - $inv[$k]) > 0.01) {
                $okW = false;
            }
        }
        if ($okW) {
            $out['wrapped']++;
        }
    }
    return $out;
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
        [$rc, $stdout, $stderr] = runArgv([$bin, '-v']);
        if ($rc !== 127 && (str_contains($stdout . $stderr, 'pdftotext version') || str_contains($stdout . $stderr, 'pdftotext '))) {
            return $bin;
        }
    }
    return null;
}

function pdfPageCount(string $file): int
{
    return (int) preg_match_all('#/Type\s*/Page[^s]#', (string) file_get_contents($file));
}

/**
 * sha256 of every embedded image XObject payload, in file order.
 * A flattened copy has exactly one per page — this is how "every page is a
 * full-page image" is measured without a renderer.
 *
 * @return array<int,string>
 */
function imageStreams(string $file): array
{
    $raw = is_file($file) ? (string) file_get_contents($file) : '';
    if ($raw === '') {
        return [];
    }
    $out = [];
    $off = 0;
    while (($sp = strpos($raw, 'stream', $off)) !== false) {
        $off = $sp + 6;
        $head = substr($raw, max(0, $sp - 4000), min(4000, $sp));
        $sub = strrpos($head, '/Subtype /Image');
        if ($sub === false) {
            continue;
        }
        // An `endstream` between the image dict and this keyword means the
        // keyword opens a LATER object (a page content stream), not the image.
        $end = strrpos($head, 'endstream');
        if ($end !== false && $end > $sub) {
            continue;
        }
        if (!preg_match_all('#/Length\s+(\d+)\b#', substr($head, $sub), $lm) || $lm[1] === []) {
            continue;
        }
        $len = (int) end($lm[1]);
        $ps = $sp + 6;
        if (substr($raw, $ps, 2) === "\r\n") {
            $ps += 2;
        } elseif (substr($raw, $ps, 1) === "\n") {
            $ps += 1;
        } else {
            continue;
        }
        $payload = substr($raw, $ps, $len);
        if (strlen($payload) !== $len) {
            continue;
        }
        $out[] = hash('sha256', $payload);
    }
    return $out;
}

/**
 * Geometry of the DIFFERENCE between two personalized renders of the SAME
 * source page: source pixels cancel, leaving only their different identity
 * marks. The centroid, bounding box and row runs reveal a centered single line
 * versus repeated/tiled copies without confusing dense source text with ink.
 *
 * Also used against a clean source render for paper-visibility checks; the
 * per-page single-mark assertion always uses two student renders.
 *
 * @return array{w:int,h:int,n:int,cover:float,cx:float,cy:float,bbox_cx:float,bbox_cy:float,band_frac:float,bbox_ratio:float,runs:int}|null
 */
function bandStats(string $srcPng, string $outPng): ?array
{
    $a = @imagecreatefrompng($srcPng);
    $b = @imagecreatefrompng($outPng);
    if ($a === false || $b === false) {
        return null;
    }
    $w = min(imagesx($a), imagesx($b));
    $h = min(imagesy($a), imagesy($b));
    $n = 0;
    $sx = 0.0;
    $sy = 0.0;
    $minx = $w;
    $maxx = -1;
    $miny = $h;
    $maxy = -1;
    $runs = 0;
    $prev = false;
    for ($y = 0; $y < $h; $y++) {
        $hit = false;
        for ($x = 0; $x < $w; $x++) {
            $pa = imagecolorat($a, $x, $y);
            $pb = imagecolorat($b, $x, $y);
            $la = (int) ((((($pa >> 16) & 255)) * 0.299) + (((($pa >> 8) & 255)) * 0.587) + ((($pa & 255)) * 0.114));
            $lb = (int) ((((($pb >> 16) & 255)) * 0.299) + (((($pb >> 8) & 255)) * 0.587) + ((($pb & 255)) * 0.114));
            if (abs($lb - $la) > 15) {
                $n++;
                $sx += $x;
                $sy += $y;
                $hit = true;
                if ($x < $minx) {
                    $minx = $x;
                }
                if ($x > $maxx) {
                    $maxx = $x;
                }
                if ($y < $miny) {
                    $miny = $y;
                }
                if ($y > $maxy) {
                    $maxy = $y;
                }
            }
        }
        if ($hit && !$prev) {
            $runs++;
        }
        $prev = $hit;
    }
    imagedestroy($a);
    imagedestroy($b);
    if ($n === 0 || $maxx < 0) {
        return null;
    }
    $bw = $maxx - $minx + 1;
    $bh = $maxy - $miny + 1;
    return [
        'w' => $w,
        'h' => $h,
        'n' => $n,
        'cover' => round($n / ($w * $h), 4),
        // Ink centroid can shift with letter shape or a different student's
        // glyphs even when the entire text run is geometrically centered. Use
        // the extent midpoint for placement assertions; retain mass centroid
        // as a diagnostic only.
        'cx' => round($sx / $n / $w, 3),
        'cy' => round($sy / $n / $h, 3),
        'bbox_cx' => round((($minx + $maxx + 1) / 2) / $w, 3),
        'bbox_cy' => round((($miny + $maxy + 1) / 2) / $h, 3),
        'band_frac' => round($bw / $w, 3),
        'bbox_ratio' => round($bh / $bw, 3),
        'runs' => $runs,
    ];
}

/**
 * Decode the literal strings of a page content stream.
 * TCPDF writes Unicode text as UTF-16BE in `(…)` literals of a `TJ` array.
 */
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
 * Count the baked watermark blocks in the document. The baked block lives inside
 * the imported page's OWN content stream (FlateDecode), so it is invisible to a
 * raw grep — the stream must be inflated first.
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
 * Per-page insight into a PDF, read through FPDI's own parser (the same library
 * the engine uses): decoded content text, visible size, and whether text was
 * drawn BEFORE and AFTER the imported page Form XObject. Both must be true:
 * the back layer is what stays legible in the margins, the front layer is what
 * lands on the lecture and cannot be covered without covering the lecture.
 *
 * @return array<int,array{text:string,w:float,h:float,rotation:int,wm_before_page:?bool,wm_after_page:?bool}>|null
 */
function pageInsight(string $file): ?array
{
    if (!class_exists(\setasign\Fpdi\PdfParser\StreamReader::class)) {
        return null;
    }
    try {
        $stream = \setasign\Fpdi\PdfParser\StreamReader::createByFile($file);
        $parser = new \setasign\Fpdi\PdfParser\PdfParser($stream);
        $reader = new \setasign\Fpdi\PdfReader\PdfReader($parser);
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
                'rotation' => (int) $page->getRotation(),
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
if ($mode !== PdfWatermarkService::MODE_RASTER) {
    fwrite(STDERR, "FAIL: real pipeline requires raster delivery; resolved mode=" . var_export($mode, true) . "\n");
    exit(1);
}

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
$identityA = (string) ($linesA[0] ?? '');
$identityB = (string) ($linesB[0] ?? '');

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

// ── 2. Checks that hold for EVERY engine ────────────────────────────────────
check($checks, $fail, 'engine available', $service->isAvailable(), (string) $service->driver());
check($checks, $fail, 'student delivery resolves to raster-only mode', $mode === PdfWatermarkService::MODE_RASTER, (string) $mode);
check($checks, $fail, 'source has a text layer (/Type /Font present)', (bool) preg_match('#/Type\s*/Font#', (string) file_get_contents($src)));
check($checks, $fail, 'source page count == 4', $srcPages === 4, "pages=$srcPages");
check($checks, $fail, 'engine reported page count == source', $pagesA === $srcPages, "reported=$pagesA src=$srcPages");
check($checks, $fail, 'output A page count == source', pdfPageCount($outA) === $srcPages, 'pages=' . pdfPageCount($outA));
check($checks, $fail, 'output A opens with %PDF- header', str_starts_with($bytesA, '%PDF-'));
check($checks, $fail, 'output A ends with %%EOF', str_contains(substr($bytesA, -2048), '%%EOF'));
check($checks, $fail, 'two students receive DIFFERENT bytes', md5($bytesA) !== md5($bytesB));
check($checks, $fail, 'outputs are non-empty', strlen($bytesA) > 1024 && strlen($bytesB) > 1024, strlen($bytesA) . '/' . strlen($bytesB) . ' bytes');
check($checks, $fail, 'no storage path, file name or original bytes are echoed into the output', !str_contains($bytesA, $src));

// ── 3. Engine-specific structure ────────────────────────────────────────────
$pageReport = null;
if ($mode === PdfWatermarkService::MODE_VECTOR) {
    $pageReport = pageInsight($outA);
    check($checks, $fail, 'output parses back as a valid PDF (FPDI)', $pageReport !== null && count($pageReport) === $srcPages, $pageReport === null ? 'unparseable' : ('pages=' . count($pageReport)));

    // Identity on EVERY page, at least twice (grid + edge line).
    $perPage = [];
    foreach ($pageReport ?? [] as $i => $p) {
        $perPage[] = ['page' => $i + 1, 'has_identity' => str_contains($p['text'], $identityA), 'hits' => substr_count($p['text'], $identityA)];
    }
    $allPages = $perPage !== [] && !in_array(false, array_column($perPage, 'has_identity'), true);
    $minHits = $perPage === [] ? 0 : min(array_column($perPage, 'hits'));
    check($checks, $fail, 'EVERY page carries the student identity', $allPages, json_encode($perPage));
    check($checks, $fail, 'the identity repeats many times on each page (layers + rails)', $minHits >= 6, 'min hits/page=' . $minHits);
    check($checks, $fail, 'a BACK layer is drawn before the imported page',
        $pageReport !== null && !in_array(false, array_column($pageReport, 'wm_before_page'), true),
        json_encode(array_column($pageReport ?? [], 'wm_before_page')));
    check($checks, $fail, 'a FRONT layer is drawn after the imported page (covers content)',
        $pageReport !== null && !in_array(false, array_column($pageReport, 'wm_after_page'), true),
        json_encode(array_column($pageReport ?? [], 'wm_after_page')));
    // The structural fix: marks are also appended INSIDE each imported page
    // stream, so "keep only the page XObject" no longer returns a clean page.
    $baked = bakedMarkerCount($outA);
    check($checks, $fail, 'every page carries baked marks inside its own content stream', $baked === $srcPages, "baked=$baked pages=$srcPages");
    check($checks, $fail, 'the brand line is gone from the repeated text (id has the space)',
        !str_contains($identityA, 'MedAcademy') && str_contains($identityA, 'MED-0042'), $identityA);
    check($checks, $fail, 'the short label is the NAME, not the brand', ($linesA[1] ?? '') === 'Test Student Alpha', (string) ($linesA[1] ?? ''));
    check($checks, $fail, 'the trace code is a deterministic 8-hex-digit fingerprint',
        (bool) preg_match('/^[0-9a-f]{8}$/', $service->traceCode($identityA))
        && $service->traceCode($identityA) === $service->traceCode('  ' . $identityA . '  ')
        && $service->traceCode($identityA) !== $service->traceCode($identityB));
    check($checks, $fail, 'the original page survives as a vector Form XObject', (bool) preg_match('#/Subtype\s*/Form#', $bytesA));
    check($checks, $fail, 'the lecture text layer survives (font objects present)', (bool) preg_match('#/Type\s*/Font#', $bytesA));
    check($checks, $fail, 'each page keeps its original point size', $pageReport !== null && abs(($pageReport[0]['w'] ?? 0) - 595.28) < 2.0 && abs(($pageReport[1]['w'] ?? 0) - 841.89) < 2.0, json_encode(array_map(static fn ($p) => [$p['w'], $p['h']], $pageReport ?? [])));
} elseif ($mode === PdfWatermarkService::MODE_RASTER) {
    check($checks, $fail, 'flattened output has NO /Type /Font objects', !preg_match('#/Type\s*/Font#', $bytesA));
    check($checks, $fail, 'flattened output has image XObjects', (bool) preg_match('#/Subtype\s*/Image#', $bytesA));
    $imgA = imageStreams($outA);
    check($checks, $fail, 'flattened output is ONE full-page image per page', count($imgA) === $srcPages,
        'images=' . count($imgA) . " pages={$srcPages}");
    check($checks, $fail, 'flattened output carries no annotations (no removable mark object)',
        !preg_match('#/Subtype\s*/Annot#', $bytesA));
    check($checks, $fail, 'flattened output embeds no Form XObject (no original page object to keep)',
        !preg_match('#/Subtype\s*/Form#', $bytesA));
} elseif ($mode === PdfWatermarkService::MODE_FLATTEN) {
    // Renderer-free flattened engine: ONE centred mark per page, baked into the
    // page content stream (no annotation, no optional-content group), with the
    // lecture text layer intact — that last part is the documented trade-off
    // against the image-per-page engine above.
    $baked = bakedMarkerCount($outA);
    check($checks, $fail, 'flattened output carries ONE baked mark per page', $baked === $srcPages, "baked=$baked pages=$srcPages");
    check($checks, $fail, 'flattened output keeps the lecture text layer (documented trade-off)', (bool) preg_match('#/Type\s*/Font#', $bytesA));
    check($checks, $fail, 'flattened output carries no annotation and no optional-content group',
        !preg_match('#/Subtype\s*/Annot#', $bytesA) && !preg_match('#/OCProperties#', $bytesA));
    check($checks, $fail, 'flattened output has no separate watermark image object',
        !preg_match('#/Subtype\s*/Image#', $bytesA) || (bool) preg_match('#/Subtype\s*/Image#', (string) file_get_contents($src)));
} else {
    check($checks, $fail, 'an engine mode is known', false, 'mode=' . var_export($mode, true));
}

// ── 3b. Renderer (shared by the pixel proofs below) ────────────────────────
// Ghostscript is optional: the vector engine's structural checks and the
// flattened engine's image/XObject checks need no renderer. Every check that
// DOES need pixels reports SKIPPED when this returns false, never "passed".
$gsBin = (string) \MedAcademy\Utils\Config::string('GHOSTSCRIPT_BIN', 'gs');
[$gsProbeRc] = runArgv([$gsBin, '--version']);
check($checks, $fail, 'Ghostscript renderer is available for mandatory pixel proofs', $gsProbeRc === 0, $gsBin);
$render = static function (string $pdf, string $png, int $page) use ($gsBin, $service): bool {
    @unlink($png);
    $argv = [$gsBin, '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=png16m', '-r' . $service->dpi(),
             '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
             '-dFirstPage=' . $page, '-dLastPage=' . $page, '-dUseCropBox', '-sOutputFile=' . $png, $pdf, '-c', 'quit'];
    [$rc] = runArgv($argv);
    return $rc === 0 && is_file($png);
};
$hasRenderer = $render($src, $OUT . '/src-p1.png', 1);

// ── 4. Text extraction (pdftotext, when installed) ──────────────────────────
$pdftotext = findPdftotext();
$textReport = ['pdftotext' => $pdftotext];
if ($pdftotext === null) {
    check($checks, $fail, 'pdftotext extracts the marker from the SOURCE', false, 'pdftotext is required for the text-layer proof');
    $textReport['skipped'] = false;
} else {
    [$rcS] = runArgv([$pdftotext, '-layout', $src, $OUT . '/source.txt']);
    [$rcO] = runArgv([$pdftotext, '-layout', $outA, $OUT . '/student-a.txt']);
    $srcText = is_file($OUT . '/source.txt') ? (string) file_get_contents($OUT . '/source.txt') : '';
    $outText = is_file($OUT . '/student-a.txt') ? (string) file_get_contents($OUT . '/student-a.txt') : '';
    $textReport += [
        'source_rc' => $rcS, 'output_rc' => $rcO,
        'source_has_marker' => str_contains($srcText, MARKER),
        'output_has_marker' => str_contains($outText, MARKER),
        'output_has_identity' => str_contains($outText, $identityA),
    ];
    check($checks, $fail, 'pdftotext extracts the marker from the SOURCE',
        $rcS === 0 && str_contains($srcText, MARKER), 'exit=' . $rcS);
    if ($mode === PdfWatermarkService::MODE_RASTER) {
        // Rasterization removes selectable source text. OCR may still recognize
        // text in the page images; this only tests the ordinary PDF text layer.
        check($checks, $fail, 'raster output exposes NO extractable source text layer',
            $rcO === 0 && !str_contains($outText, MARKER) && !str_contains($outText, 'MED-0042') && !str_contains($outText, 'MEDACADEMY'),
            'bytes=' . strlen($outText));
    } else {
        // The vector engine deliberately keeps the lecture text layer (a
        // documented trade-off), so extraction still yields the lecture — but a
        // 45° background mark is emitted BEFORE the page and therefore
        // interleaves with it in extraction order, which makes an exact
        // substring match meaningless. The identity is verified per page from
        // the CONTENT STREAM above, which is the reliable proof.
        check($checks, $fail, 'vector output still exposes a text layer (lecture text not rasterised)', $rcO === 0 && strlen($outText) > 200, 'bytes=' . strlen($outText));
    }
}

// ── 5. Rotated pages + mixed sizes ──────────────────────────────────────────
$rotSrc = $FIX . '/rotated.pdf';
if (is_file($rotSrc)) {
    $rotOut = $OUT . '/rotated-out.pdf';
    @unlink($rotOut);
    try {
        $rotPages = $service->personalize($rotSrc, $linesA, $rotOut);
        check($checks, $fail, 'rotated fixture: page count preserved', $rotPages === pdfPageCount($rotSrc), "reported=$rotPages");
        $insight = pageInsight($rotOut);
        if ($insight === null) {
            check($checks, $fail, 'rotated fixture: output is readable and page count is preserved', false, 'output not parseable by FPDI');
        } else {
            $dims = [];
            foreach ($insight as $i => $p) {
                $dims[] = ['page' => $i + 1, 'w' => $p['w'], 'h' => $p['h'], 'identity' => str_contains($p['text'], $identityA)];
            }
            if ($mode === PdfWatermarkService::MODE_RASTER) {
                // Flattened engine: there is no text layer to read, so identity
                // is proved from PIXELS — the mark is the only difference from a
                // clean render of the same source page — and the structure from
                // one image XObject per page. Ghostscript applies the source
                // /Rotate itself, which is why the mark lands upright and
                // centred on rotated pages too.
                $rotRaw = (string) file_get_contents($rotOut);
                $rotImages = imageStreams($rotOut);
                check($checks, $fail, 'rotated fixture: every page is ONE flattened full-page image',
                    count($rotImages) === count($insight) && !preg_match('#/Type\s*/Font#', $rotRaw),
                    'images=' . count($rotImages) . ' pages=' . count($insight));
                if (!$hasRenderer) {
                    check($checks, $fail, 'rotated fixture: EVERY page carries ONE centred watermark', false, 'Ghostscript failed to render source or output');
                } else {
                    $bad = [];
                    $rotOutB = $OUT . '/rotated-out-student-b.pdf';
                    // Do not reuse a previous test run's PDF: stale rendering
                    // settings or code can make a valid current Student A copy
                    // appear off-center in a difference-image comparison.
                    @unlink($rotOutB);
                    try {
                        $service->personalize($rotSrc, $linesB, $rotOutB);
                    } catch (\Throwable $e) {
                        check($checks, $fail, 'rotated fixture: student B copy generated for this run', false, get_class($e) . ': ' . $e->getMessage());
                        $bad[] = ['page' => 1, 'error' => 'student B generation failed'];
                    }
                    foreach ($insight as $i => $p) {
                        $sp = $OUT . '/rot-student-a-' . ($i + 1) . '.png';
                        $op = $OUT . '/rot-student-b-' . ($i + 1) . '.png';
                        if (!$render($rotOut, $sp, $i + 1)) {
                            $bad[] = ['page' => $i + 1, 'error' => 'student A render failed'];
                            continue;
                        }
                        $rotOutB = $OUT . '/rotated-out-student-b.pdf';
                        if ($i === 0 && !is_file($rotOutB)) {
                            try {
                                $service->personalize($rotSrc, $linesB, $rotOutB);
                            } catch (\Throwable) {
                                $bad[] = ['page' => $i + 1, 'error' => 'student B generation failed'];
                                continue;
                            }
                        }
                        if (!$render($rotOutB, $op, $i + 1)) {
                            $bad[] = ['page' => $i + 1, 'error' => 'render failed'];
                            continue;
                        }
                        $band = bandStats($sp, $op);
                        $okBand = $band !== null
                            && $band['n'] >= 2000
                            && abs($band['bbox_cx'] - 0.5) <= 0.025
                            && abs($band['bbox_cy'] - 0.5) <= 0.025
                            && $band['band_frac'] >= 0.45
                            && $band['bbox_ratio'] <= 0.25
                            && $band['runs'] <= 4;
                        if (!$okBand) {
                            $bad[] = ['page' => $i + 1] + ($band ?? ['error' => 'no mark ink']);
                        }
                    }
                    check($checks, $fail, 'rotated fixture: EVERY page (incl. /Rotate 90 and 180) carries ONE centred watermark',
                        $bad === [], json_encode($bad));
                }
            } else {
                $ok = true;
                foreach ($insight as $i => $p) {
                    if (!str_contains($p['text'], $identityA)) {
                        $ok = false;
                    }
                }
                check($checks, $fail, 'rotated fixture: EVERY page (incl. /Rotate 90 and 180) carries the identity', $ok, json_encode($dims));
                // FPDI carries the source /Rotate in the Form's /Matrix. The baker
                // must still content-bake those pages (pre-multiplying the matrix
                // inverse) instead of skipping 90° pages or appending upside-down
                // marks on 180° ones — regression lock for the matrix-aware bake.
                // Scan is FlateDecode-aware (see bakedFormScan): a raw-byte scan
                // reports zero bakes on compressed TCPDF output.
                if ($mode === PdfWatermarkService::MODE_FLATTEN) {
                    // flatten_engine_tests.php asserts the same property from the
                    // delivered bytes (one mark per page, three pages, /Rotate 90 included),
                    // but it reads the appended blocks directly instead of counting
                    // /Subtype /Form objects, which is what bakedFormScan does.
                    skip(
                        $checks,
                        'rotated fixture: every rotated form carries the inverse-wrapped baked block',
                        'vector-only matrix assertion — the flatten engine ships its own per-page proof'
                    );
                } else {
                    $scan = bakedFormScan((string) file_get_contents($rotOut));
                    check($checks, $fail, 'rotated fixture: EVERY page is content-baked (incl. /Rotate 90)', $scan['baked'] === count($insight), 'baked=' . $scan['baked'] . ' pages=' . count($insight));
                    check($checks, $fail, 'rotated fixture: every rotated form carries the inverse-wrapped baked block', $scan['badmatrix'] === 0 && $scan['rotated'] >= 1 && $scan['wrapped'] === $scan['rotated'], json_encode($scan));
                }
            }
            // /Rotate 90 must be re-laid-out as a landscape page, not squeezed
            // into a portrait one: the visible width stays the larger value.
            $second = $insight[1] ?? null;
            check($checks, $fail, 'rotated fixture: a /Rotate 90 page keeps its VISIBLE orientation',
                $second !== null && $second['w'] > $second['h'],
                $second === null ? 'missing' : ($second['w'] . 'x' . $second['h']));
        }
    } catch (\Throwable $e) {
        check($checks, $fail, 'rotated fixture: personalize succeeded', false, get_class($e) . ': ' . $e->getMessage());
    }
} else {
    skip($checks, 'rotated fixture: identity on every page', 'fixture rotated.pdf not generated');
}

// ── 6. Source unchanged ─────────────────────────────────────────────────────
check($checks, $fail, 'source PDF is unchanged', hash_file('sha256', $src) === $srcHashBefore, 'sha256 stable');

// ── 7. Temporary scratch dirs must be gone ──────────────────────────────────
$leftover = glob($OUT . '/wm-*') ?: [];
check($checks, $fail, 'no temporary scratch dirs left behind', $leftover === [], implode(',', array_map('basename', $leftover)));

// ── 8. Mandatory page-by-page pixel proof ──────────────────────────────────
$srcPng = $OUT . '/src-p1.png';
$outPng = $OUT . '/out-p1.png';
$pixelReport = null;
$allPageBands = [];
$badPageBands = [];
$hasRenderer = $hasRenderer && $render($outA, $outPng, 1);

if (!$hasRenderer) {
    check($checks, $fail, 'source/output pages render successfully for pixel proofs', false, 'Ghostscript failed to render source or output');
} else {
    for ($pageNo = 1; $pageNo <= $srcPages; $pageNo++) {
        $sourcePagePng = $OUT . '/source-p' . $pageNo . '.png';
        $outputPagePng = $OUT . '/output-p' . $pageNo . '.png';
        $studentBPagePng = $OUT . '/student-b-p' . $pageNo . '.png';
        if (!$render($src, $sourcePagePng, $pageNo)
            || !$render($outA, $outputPagePng, $pageNo)
            || !$render($outB, $studentBPagePng, $pageNo)) {
            $badPageBands[] = ['page' => $pageNo, 'error' => 'source/output page render failed'];
            continue;
        }
        if ($pageNo === 1) {
            $srcPng = $sourcePagePng;
            $outPng = $outputPagePng;
        }
        $geometryA = @getimagesize($outputPagePng);
        $geometryB = @getimagesize($studentBPagePng);
        $sameGeometry = is_array($geometryA) && is_array($geometryB)
            && $geometryA[0] === $geometryB[0] && $geometryA[1] === $geometryB[1];
        $pageBand = bandStats($outputPagePng, $studentBPagePng);
        $pageBandOk = $sameGeometry && $pageBand !== null
            && $pageBand['n'] >= 2000
            && abs($pageBand['bbox_cx'] - 0.5) <= 0.025
            && abs($pageBand['bbox_cy'] - 0.5) <= 0.025
            && $pageBand['band_frac'] >= 0.45
            && $pageBand['bbox_ratio'] <= 0.25
            && $pageBand['runs'] <= 4;
        $allPageBands[] = [
            'page' => $pageNo,
            'size_px' => $sameGeometry ? [$geometryA[0], $geometryA[1]] : null,
            'stats' => $pageBand,
            'ok' => $pageBandOk,
        ];
        if (!$pageBandOk) {
            $badPageBands[] = ['page' => $pageNo, 'same_geometry' => $sameGeometry]
                + ($pageBand ?? ['error' => 'no watermark ink']);
        }
    }
    check($checks, $fail, 'pixels: every page has exactly ONE centered mark and no repeated copies (student A vs B; source pixels cancel)',
        $badPageBands === [] && count($allPageBands) === $srcPages, json_encode($badPageBands));
    $a = imagecreatefrompng($srcPng);
    $b = imagecreatefrompng($outPng);
    $w = min(imagesx($a), imagesx($b));
    $h = min(imagesy($a), imagesy($b));
    // Counterfactual: compositing the mark ON TOP at opacity o would force even a
    // pure-black content pixel up to ~grey*o. Black pixels staying black is
    // decisive proof the mark sits BEHIND the lecture content.
    $opacity = $mode === PdfWatermarkService::MODE_RASTER ? $service->opacity() : $service->vectorOpacity();
    $counterfactual = (int) round((255 - $opacity * (255 - 90)) * $opacity);
    $blackN = 0;
    $blackOutSum = 0.0;
    $blackLt10 = 0;
    $whiteN = 0;
    $wmN = 0;
    for ($y = 0; $y < $h; $y++) {
        for ($x = 0; $x < $w; $x++) {
            $pa = imagecolorat($a, $x, $y);
            $pb = imagecolorat($b, $x, $y);
            $la = (int) (((($pa >> 16) & 255) * 0.299) + ((($pa >> 8) & 255) * 0.587) + (($pa & 255) * 0.114));
            $lb = (int) (((($pb >> 16) & 255) * 0.299) + ((($pb >> 8) & 255) * 0.587) + (($pb & 255) * 0.114));
            if ($la < 5) {
                $blackN++;
                $blackOutSum += $lb;
                if ($lb < 12) {
                    $blackLt10++;
                }
            } elseif ($la > 245) {
                $whiteN++;
                if ($lb >= 110 && $lb <= 249) {
                    $wmN++;
                }
            }
        }
    }
    imagedestroy($a);
    imagedestroy($b);
    $blackMean = $blackN ? round($blackOutSum / $blackN, 2) : 0;
    $pixelReport = [
        'dimensions' => [$w, $h],
        'watermark_on_top_counterfactual_grey' => $counterfactual,
        'black_content_pixels' => $blackN,
        'black_out_mean_lum' => $blackMean,
        'black_out_lt12_pct' => $blackN ? round(100 * $blackLt10 / $blackN, 2) : 0,
        'white_paper_pixels' => $whiteN,
        'watermark_stroke_pixels_over_paper' => $wmN,
        'watermark_coverage_of_paper_pct' => $whiteN ? round(100 * $wmN / $whiteN, 2) : 0,
    ];
    // The mark is now layered ON PURPOSE: a FRONT layer crosses the lecture so
    // that covering it also covers the lecture. The readability requirement is
    // therefore "content ink stays dark", not "content ink is untouched".
    $inkChanged = 0;
    $inkLt140 = 0;
    $inkN = 0;
    $inkSum = 0.0;
    for ($y = 0; $y < $h; $y++) {
        for ($x = 0; $x < $w; $x++) {
            $pa = imagecolorat($a, $x, $y);
            $pb = imagecolorat($b, $x, $y);
            $la = (int) (((($pa >> 16) & 255) * 0.299) + ((($pa >> 8) & 255) * 0.587) + (($pa & 255) * 0.114));
            $lb = (int) (((($pb >> 16) & 255) * 0.299) + ((($pb >> 8) & 255) * 0.587) + (($pb & 255) * 0.114));
            if ($la < 60) {
                $inkN++;
                $inkSum += $lb;
                if ($lb < 140) {
                    $inkLt140++;
                }
                if (abs($lb - $la) > 8) {
                    $inkChanged++;
                }
            }
        }
    }
    $inkMean = $inkN ? round($inkSum / $inkN, 2) : 0;
    $inkChangedPct = $inkN ? round(100 * $inkChanged / $inkN, 2) : 0;
    $inkLt140Pct = $inkN ? round(100 * $inkLt140 / $inkN, 2) : 0;
    $pixelReport['content_ink'] = [
        'pixels' => $inkN,
        'mean_lum' => $inkMean,
        'lt140_pct' => $inkLt140Pct,
        'changed_pct' => $inkChangedPct,
    ];
    check($checks, $fail, 'pixels: lecture text stays dark and readable under the marks',
        $inkN > 500 && $inkMean <= 60.0 && $inkLt140Pct >= 99.0,
        "inkMean=$inkMean lt140=" . $inkLt140Pct . '%');
    if ($mode === PdfWatermarkService::MODE_RASTER) {
        // The raster layout must be ONE large centred mark, not a tiled grid.
        // Use the two personalized renders here too, so source page ink (notably
        // the repeated marker in the dense appendix) cannot skew the centroid.
        $band = bandStats($outPng, $OUT . '/student-b-p1.png');
        check($checks, $fail,        'pixels: page 1 has ONE centered watermark band (student A vs B; no grid)',
            $band !== null
            && $band['n'] >= 2000
            && abs($band['bbox_cx'] - 0.5) <= 0.025
            && abs($band['bbox_cy'] - 0.5) <= 0.025
            && $band['band_frac'] >= 0.45
            && $band['bbox_ratio'] <= 0.25
            && $band['runs'] <= 4,
            json_encode($band));
        $pixelReport['raster_band_page1'] = $band;
        $pixelReport['every_page_bands'] = $allPageBands;
        check(
            $checks,
            $fail,
            'pixels: watermark is baked into each raster page image',
            count($imgA) === $srcPages
                && !preg_match('#/Subtype\\s*/Form|/Type\\s*/Font|/Subtype\\s*/Annot#', $bytesA)
                && strpos((string) file_get_contents($outA), MARKER) === false,
            'images=' . count($imgA) . ' pages=' . $srcPages
        );
        skip(
            $checks,
            'pixels: watermark ink is entangled with lecture ink (front layer really covers content)',
            'not applicable to the raster engine: watermark and page imagery are already composited into one image XObject'
        );
    } else {
        check($checks, $fail, 'pixels: watermark ink is entangled with lecture ink (front layer really covers content)',
            $inkChangedPct >= 0.2, "changed=$inkChangedPct% of content ink px");
    }
    check($checks, $fail, 'pixels: watermark strokes are visible on the paper', $wmN > 300, "wm_px=$wmN of {$whiteN} paper px");
}

// ── 9. Small/large raster performance and output-size measurements ─────────
// These deterministic fixtures are generated by the harness outside this file.
// Keep measurements in the required suite result so the report and its claims
// are tied to this exact renderer run, rather than to stale workspace artifacts.
$benchmarks = [];
foreach (['small' => 'benchmark-small.pdf', 'large' => 'benchmark-large.pdf'] as $label => $fixtureName) {
    $benchSource = $OUT . '/' . $fixtureName;
    if (!is_file($benchSource)) {
        skip($checks, "benchmark $label fixture render", "fixture $fixtureName is not present");
        continue;
    }
    $benchTarget = $OUT . '/benchmark-' . $label . '-watermarked.pdf';
    @unlink($benchTarget);
    // PHP's peak counter otherwise includes the earlier student render and
    // makes the per-fixture value misleading. Keep this run-scoped when the
    // runtime provides the reset API (PHP 8.2+).
    if (function_exists('memory_reset_peak_usage')) {
        memory_reset_peak_usage();
    }
    $benchStart = microtime(true);
    try {
        $benchPages = $service->personalize($benchSource, $linesA, $benchTarget);
        $benchMs = (int) round((microtime(true) - $benchStart) * 1000);
        $benchBytes = is_file($benchTarget) ? (int) filesize($benchTarget) : 0;
        $benchmarks[$label] = [
            'pages' => $benchPages,
            'source_bytes' => (int) filesize($benchSource),
            'output_bytes' => $benchBytes,
            'ms' => $benchMs,
            'peak_memory_bytes' => memory_get_peak_usage(true),
        ];
        check(
            $checks,
            $fail,
            "benchmark $label: rendered all pages to a non-empty personalized PDF",
            $benchPages === pdfPageCount($benchSource) && $benchBytes > 0,
            json_encode($benchmarks[$label])
        );
    } catch (\Throwable $e) {
        $benchmarks[$label] = ['error' => get_class($e) . ': ' . $e->getMessage()];
        check($checks, $fail, "benchmark $label: render completed", false, $benchmarks[$label]['error']);
    }
}

$report = [
    'engine' => $mode,
    'driver' => $status['driver'],
    'settings' => $status['settings'],
    'source' => ['pages' => $srcPages, 'bytes' => $srcSize, 'sha256_prefix' => substr($srcHashBefore, 0, 16)],
    'student_a' => ['identity' => implode(' | ', array_filter($linesA)), 'pages' => $pagesA, 'bytes' => strlen($bytesA), 'ms' => $msA, 'peak_mem_bytes' => $peakA],
    'student_b' => ['identity' => implode(' | ', array_filter($linesB)), 'pages' => $pagesB, 'bytes' => strlen($bytesB), 'ms' => $msB],
    'bytes_identical_between_students' => md5($bytesA) === md5($bytesB),
    'text_extraction' => $textReport,
    'vector_page_report' => $pageReport,
    'pixel_analysis' => $pixelReport,
    'benchmarks' => $benchmarks,
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
