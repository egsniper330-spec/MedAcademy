<?php

declare(strict_types=1);

/**
 * make_fixture.php — deterministic fixture generation for the PDF watermark tests.
 *
 * Builds, with the REAL FPDF + GD stack (no sample files are committed):
 *
 *   fixtures/source.pdf          4 pages, mixed sizes/orientations, dense body
 *                                text, 6pt small print, vector diagram, embedded
 *                                raster chart, and the marker string
 *                                LECTURE-TEXT-MARKER-ALPHA (the watermarked
 *                                output must NOT expose it as extractable text);
 *   fixtures/embedded-chart.png  the synthetic chart drawn into page 2/3;
 *   fixtures/notapdf.pdf         literal garbage;
 *   fixtures/empty.pdf           zero bytes;
 *   fixtures/truncated.pdf       the first 400 bytes of source.pdf;
 *   fixtures/encrypted.pdf       source.pdf re-encoded by Ghostscript with
 *                                user+owner passwords (synthetic test data).
 *
 * The source PDF carries a FPDF creation timestamp, so its bytes differ
 * between runs; page structure and text content are deterministic. Tests
 * never compare fixture bytes across runs.
 *
 * Run (normally done by run.ps1 / run.sh):
 *   php -d auto_prepend_file=prepend.php make_fixture.php [out.pdf]
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
$work = (string) getenv('PDFTEST_WORKDIR');
$work = ($work !== '' ? $work : $root . '/.freebuff/pdf-watermark-tests');
$FIX = $work . '/fixtures';
@mkdir($FIX, 0775, true);

$out = $argv[1] ?? $FIX . '/source.pdf';

// ── A synthetic chart drawn with GD and embedded as a raster image ──────────
$imgPath = $FIX . '/embedded-chart.png';
$im = imagecreatetruecolor(600, 260);
$bg = imagecolorallocate($im, 245, 248, 252);
imagefilledrectangle($im, 0, 0, 600, 260, $bg);
$bar = [
    imagecolorallocate($im, 37, 99, 235),
    imagecolorallocate($im, 16, 185, 129),
    imagecolorallocate($im, 245, 158, 11),
    imagecolorallocate($im, 239, 68, 68),
];
foreach ([0.4, 0.65, 0.85, 0.55] as $i => $v) {
    $x = 60 + $i * 130;
    $h = (int) (200 * $v);
    imagefilledrectangle($im, $x, 240 - $h, $x + 90, 240, $bar[$i]);
}
$axis = imagecolorallocate($im, 30, 41, 59);
imageline($im, 40, 240, 580, 240, $axis);
imagestring($im, 4, 250, 5, 'Enrollment by term (raster image)', imagecolorallocate($im, 15, 23, 42));
imagepng($im, $imgPath);
imagedestroy($im);

// ── The rich source PDF ─────────────────────────────────────────────────────
$pdf = new \FPDF('P', 'pt', 'A4');
$pdf->SetAutoPageBreak(true, 40);

// Page 1: A4 portrait, title + dense body + 6pt small print + diagram.
$pdf->AddPage();
$pdf->SetFont('Helvetica', 'B', 22);
$pdf->Cell(0, 28, 'MEDACADEMY - CARDIOLOGY LECTURE, SECTION A', 0, 1);
$pdf->SetFont('Helvetica', '', 11);
$body = 'This page exists to prove that the flattened output still shows every '
    . 'glyph of the original lecture. The paragraph is genuine selectable text in '
    . 'the source PDF, so extracting it from the watermarked copy would mean the '
    . 'flattening step failed. Marker: LECTURE-TEXT-MARKER-ALPHA. The raster '
    . 'pipeline must render this text to pixels, place the student watermark '
    . 'underneath those pixels, and flatten the two layers into one image.';
$pdf->MultiCell(0, 16, $body);
$pdf->Ln(6);
$pdf->SetFont('Helvetica', '', 6);
$pdf->MultiCell(0, 8, 'Small print (6pt): blood pressure targets, dosing intervals, contraindications, '
    . 'and follow-up windows for the cohort are listed in this fine-print block. It is deliberately small '
    . 'so legibility can be checked at high zoom in the rendered output.');
$pdf->Ln(10);
$pdf->SetFont('Helvetica', 'B', 12);
$pdf->Cell(0, 20, 'Vector diagram: pressure-volume loop (drawn, not an image)', 0, 1);
$pdf->SetDrawColor(37, 99, 235);
$pdf->SetLineWidth(1.5);
$pdf->Rect(60, 560, 300, 200);
$pdf->Line(60, 660, 360, 660);
$pdf->Line(210, 560, 210, 760);
$pdf->SetDrawColor(239, 68, 68);
$pdf->SetLineWidth(2.5);
$pdf->Rect(90, 600, 120, 90);
$pdf->Rect(140, 580, 130, 120);

// Page 2: A4 landscape, wide table + embedded raster image.
$pdf->AddPage('L');
$pdf->SetFont('Helvetica', 'B', 20);
$pdf->Cell(0, 28, 'LANDSCAPE PAGE - DATA DASHBOARD', 0, 1);
$pdf->SetFont('Helvetica', '', 10);
for ($r = 0; $r < 14; $r++) {
    $pdf->Cell(70, 16, 'Row ' . ($r + 1), 1);
    $pdf->Cell(180, 16, 'Metric value ' . (100 + $r * 7), 1);
    $pdf->Cell(180, 16, 'Cohort note ' . chr(65 + $r), 1, 1);
}
$pdf->Ln(10);
$pdf->Image($imgPath, 60, 330, 380, 0, 'PNG');

// Page 3: US-Letter portrait (different size), image + text.
$pdf->AddPage('P', [612, 792]);
$pdf->SetFont('Helvetica', 'B', 20);
$pdf->Cell(0, 28, 'US-LETTER PAGE - DIFFERENT PAGE SIZE', 0, 1);
$pdf->SetFont('Helvetica', '', 11);
$pdf->MultiCell(0, 16, 'This page uses US-Letter (612x792pt) rather than A4, so a pipeline that '
    . 'hard-codes A4 would visibly distort it. Marker repeated: LECTURE-TEXT-MARKER-ALPHA.');
$pdf->Image($imgPath, 70, 260, 470, 0, 'PNG');

// Page 4: A4 portrait, dense fine text.
$pdf->AddPage();
$pdf->SetFont('Helvetica', 'B', 18);
$pdf->Cell(0, 26, 'APPENDIX - DENSE REFERENCE TABLE', 0, 1);
$pdf->SetFont('Helvetica', '', 9);
for ($i = 1; $i <= 40; $i++) {
    $pdf->Cell(60, 14, 'A' . $i, 1);
    $pdf->Cell(200, 14, 'Reference entry number ' . $i . ' - see marker LECTURE-TEXT-MARKER-ALPHA', 1);
    $pdf->Cell(150, 14, 'Status: active', 1, 1);
}

$pdf->Output($out, 'F');
$srcBytes = (string) file_get_contents($out);

// ── Error-handling fixtures ─────────────────────────────────────────────────
file_put_contents($FIX . '/notapdf.pdf', "THIS IS NOT A PDF AT ALL.\njust garbage bytes for the reject_non_pdf test.\n");
file_put_contents($FIX . '/empty.pdf', '');
file_put_contents($FIX . '/truncated.pdf', substr($srcBytes, 0, 400));

// Encrypted fixture: re-encode with Ghostscript pdfwrite + passwords.
$gs = (string) (getenv('GHOSTSCRIPT_BIN') ?: 'gs');
$enc = $FIX . '/encrypted.pdf';
@unlink($enc);
$argvGs = [$gs, '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite',
    '-sOwnerPassword=fixture-owner-pw', '-sUserPassword=fixture-user-pw',
    '-sOutputFile=' . $enc, $out];
$d = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
$p = @proc_open($argvGs, $d, $pipes);
$gsRc = 127;
$gsErr = 'proc_open failed';
if (is_resource($p)) {
    fclose($pipes[0]);
    stream_get_contents($pipes[1]);
    $gsErr = (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $gsRc = proc_close($p);
}
if ($gsRc !== 0 || !is_file($enc)) {
    fwrite(STDERR, "FAIL: could not build encrypted.pdf with Ghostscript (rc=$gsRc): $gsErr\n");
    exit(1);
}
$encBytes = (string) file_get_contents($enc);
if (!str_contains($encBytes, '/Encrypt')) {
    fwrite(STDERR, "FAIL: encrypted.pdf does not contain /Encrypt — Ghostscript did not encrypt it.\n");
    exit(1);
}

echo json_encode([
    'source' => $out,
    'source_bytes' => strlen($srcBytes),
    'source_pages' => preg_match_all('#/Type\s*/Page[^s]#', $srcBytes),
    'fixtures' => [
        'source.pdf' => strlen($srcBytes),
        'encrypted.pdf' => strlen($encBytes),
        'truncated.pdf' => filesize($FIX . '/truncated.pdf'),
        'notapdf.pdf' => filesize($FIX . '/notapdf.pdf'),
        'empty.pdf' => filesize($FIX . '/empty.pdf'),
        'embedded-chart.png' => filesize($imgPath),
    ],
], JSON_UNESCAPED_SLASHES), "\n";
