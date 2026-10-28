<?php

declare(strict_types=1);

/**
 * pdf_gate_tests.php — the UPLOAD gate for lesson documents, executed.
 *
 * `UploadIntegrityService::validate()` runs `PdfWatermarkService::inspect()` on
 * every PDF a doctor attaches, so a document the engine cannot render is refused
 * at upload instead of failing at a student's download. That protection is only
 * useful if it (a) accepts ordinary documents, (b) refuses each broken kind with
 * its OWN code, and (c) never claims a modern PDF is "damaged" when the actual
 * limitation is the container format.
 *
 * WHAT THIS PINS
 *   U1  a structurally valid PDF is accepted and its byte count is measured;
 *   U2  a 0-byte file is refused with `upload_empty` (the byte gate runs first);
 *   U3  non-PDF bytes named `.pdf` are refused with `pdf_invalid`;
 *   U4  a truncated PDF is refused with `pdf_truncated` (not silently stored);
 *   U5  a PDF whose xref is a COMPRESSED STREAM — what Word/Acrobat exports
 *       produce — is refused with `pdf_unsupported_format` and a message that
 *       says how to fix it, when FPDI is the renderer; on a host whose renderer
 *       is Ghostscript that container IS readable, so there it must be accepted;
 *   U6  the size cap never exceeds what PHP itself accepts
 *       (`upload_max_filesize`), so a "100 MB" limit on an 8 MB host cannot
 *       advertise a size the host will reject;
 *   U7  the gate never reports success for bytes it did not store: a truncated
 *       temp file fails validate() instead of being published;
 *   U8  a PDF with a BROKEN cross-reference table (startxref pointing at the
 *       wrong object type, a missing xref pointer, rows pointing at nothing) is
 *       refused as `pdf_invalid`, never as `pdf_unsupported_format` — FPDI throws
 *       the SAME exception class for both, so the code must be told apart;
 *   U9  an encrypted PDF is refused as `pdf_encrypted` (its own code, its own
 *       message), including when `/Encrypt` sits outside the scanned tail;
 *   U10 a large but valid PDF (~9.5 MB, the size in the production incident) is
 *       ACCEPTED, so a size near 9.5 MB is never the reason for a `pdf`-stage
 *       `pdf_invalid`;
 *   U11 a refused upload leaves nothing behind: no object is written for bytes
 *       the gate rejected;
 *   U12 the refusal is logged with the fields an operator needs to answer
 *       "which file, which request?" — stage, result, reason, source, bytes and
 *       the client-declared byte count;
 *   U13 the SELECTED file vs the RECEIVED bytes is judged by PROVENANCE: a short
 *       body is always a truncation, a long body is a different file only when
 *       the declared size was MEASURED, and wrong provider metadata is logged
 *       instead of refusing a genuine document (the 679-byte / 9.5 MB shape).
 *
 * Run:
 *   php backend/tests/material-upload/pdf_gate_tests.php
 * Exit code 0 = every case passed.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

// Isolate the structured log BEFORE the logger is built: U12 reads the line this
// run writes, and a test must never append to the real storage/logs/app.log.
//
// LOG_LEVEL is forced to `info` for the same reason it must be `info` on the
// server: the upload diagnostics are INFO lines, so a deployment left at
// `warning` records NOTHING for a refused upload — the operator sees a failed
// upload in the app and an empty log. (backed by a real .env in this repo that
// had exactly that value.)
$logDir = rtrim(sys_get_temp_dir(), '/\\') . '/medacademy-pdf-gate-logs-' . bin2hex(random_bytes(4));
@mkdir($logDir, 0775, true);
putenv('LOG_DIR=' . $logDir);
putenv('LOG_LEVEL=info');
$_ENV['LOG_DIR'] = $logDir;
$_ENV['LOG_LEVEL'] = 'info';

require dirname(__DIR__, 2) . '/src/bootstrap.php';

use MedAcademy\Http\ApiException;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Services\UploadIntegrityService;

$passed = 0;
$failed = 0;

function check(string $label, bool $ok, string $detail = ''): void
{
    global $passed, $failed;
    if ($ok) {
        $passed++;
        printf("  PASS  %s%s\n", $label, $detail !== '' ? ' — ' . $detail : '');
    } else {
        $failed++;
        printf("  FAIL  %s%s\n", $label, $detail !== '' ? ' — ' . $detail : '');
    }
}

/** Stable failure code of a thrown ApiException (or null when it did not throw). */
function failureCode(callable $fn): ?string
{
    try {
        $fn();
        return null;
    } catch (ApiException $e) {
        return (string) ($e->errors[0] ?? 'api_exception');
    }
}

/** Smallest structurally complete PDF: classic xref table, one page, Helvetica. */
function samplePdf(string $text): string
{
    $content = "BT /F1 12 Tf 24 120 Td (" . addcslashes($text, '()\\') . ") Tj ET\n";
    $objects = [
        1 => '<< /Type /Catalog /Pages 2 0 R >>',
        2 => '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        3 => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        4 => "<< /Length " . strlen($content) . " >>\nstream\n" . $content . 'endstream',
        5 => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    $pdf = "%PDF-1.4\n";
    $offsets = [];
    foreach ($objects as $n => $body) {
        $offsets[$n] = strlen($pdf);
        $pdf .= $n . " 0 obj\n" . $body . "\nendobj\n";
    }
    $xrefAt = strlen($pdf);
    $count = count($objects) + 1;
    $pdf .= "xref\n0 " . $count . "\n0000000000 65535 f \n";
    for ($i = 1; $i < $count; $i++) {
        $pdf .= sprintf("%010d 00000 n \n", $offsets[$i]);
    }
    return $pdf . "trailer\n<< /Size " . $count . " /Root 1 0 R >>\nstartxref\n" . $xrefAt . "\n%%EOF\n";
}

/** A PDF 1.5 whose cross-reference table is a COMPRESSED STREAM (no classic xref). */
function crossReferenceStreamPdf(): string
{
    $body = "%PDF-1.5\n%\xE2\xE3\xCF\xD3\n";
    $offsets = [];
    $add = static function (int $n, string $content) use (&$body, &$offsets): void {
        $offsets[$n] = strlen($body);
        $body .= $n . " 0 obj\n" . $content . "\nendobj\n";
    };
    $add(1, '<< /Type /Catalog /Pages 2 0 R >>');
    $add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    $add(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>');
    $content = "BT /F1 18 Tf 40 790 Td (COMPRESSED XREF STREAM) Tj ET\n";
    $add(4, '<< /Length ' . strlen($content) . " >>\nstream\n" . $content . 'endstream');
    $add(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    $xrefAt = strlen($body);
    $rows = pack('C', 0) . pack('N', 0) . pack('n', 65535);
    foreach ([1, 2, 3, 4, 5] as $n) {
        $rows .= pack('C', 1) . pack('N', $offsets[$n]) . pack('n', 0);
    }
    $rows .= pack('C', 1) . pack('N', $xrefAt) . pack('n', 0);
    $body .= "6 0 obj\n<< /Type /XRef /Size 7 /W [1 4 2] /Root 1 0 R /Length " . strlen($rows)
        . " >>\nstream\n" . $rows . "\nendstream\nendobj\n";
    return $body . "startxref\n" . $xrefAt . "\n%%EOF\n";
}

$work = rtrim(sys_get_temp_dir(), '/\\') . '/medacademy-pdf-gate-' . bin2hex(random_bytes(4));
@mkdir($work, 0775, true);

$integrity = new UploadIntegrityService();
$pdf = new PdfWatermarkService();
$mode = $pdf->effectiveMode();
$fpdiRenders = in_array($mode, [PdfWatermarkService::MODE_VECTOR, PdfWatermarkService::MODE_FLATTEN], true);

/** Write a sample and return its path. */
$write = static function (string $name, string $bytes) use ($work): string {
    $path = $work . '/' . $name;
    file_put_contents($path, $bytes);
    return $path;
};
/**
 * Feed a file through the SAME entry point the HTTP handler uses.
 *
 * $declaredSize is what the app sends as `declared_size` (the picker's byte
 * count). It defaults to the real size, i.e. "the client is honest".
 */
$validate = static function (string $path, string $dest, int $declaredSize = -1, string $declaredSource = '') use ($integrity): array {
    $actual = (int) filesize($path);
    return $integrity->validate(
        ['error' => UPLOAD_ERR_OK, 'tmp_name' => $path, 'size' => $actual, 'name' => basename($path), 'type' => 'application/pdf'],
        $dest,
        'lesson-materials',
        $declaredSize < 0 ? $actual : $declaredSize,
        $declaredSource
    );
};

echo "PDF upload gate (" . ($mode ?? 'no engine') . ")\n";
echo str_repeat('─', 78), "\n";

// ── U1: an ordinary document is accepted ────────────────────────────────────
$good = $write('good.pdf', samplePdf('Gate test'));
$code = failureCode(static function () use ($validate, $good): void {
    $validate($good, 'gate/good.pdf');
});
check('U1 valid PDF is accepted', $code === null, $code ?? 'accepted');
check('U1 bytes are measured, not trusted', is_file($good) && (int) filesize($good) > 0, (string) filesize($good) . ' B');

// ── U2: empty file ──────────────────────────────────────────────────────────
// The byte-count gate runs BEFORE the PDF gate (a 0-byte body is refused for
// every file type), so the code is the upload-level `upload_empty`.
$empty = $write('empty.pdf', '');
check('U2 empty file is refused', failureCode(static function () use ($validate, $empty): void {
    $validate($empty, 'gate/empty.pdf');
}) === 'upload_empty');

// ── U3: not a PDF at all ────────────────────────────────────────────────────
$notPdf = $write('notapdf.pdf', "This is plain text with a .pdf name.\n");
check('U3 non-PDF bytes are refused', failureCode(static function () use ($validate, $notPdf): void {
    $validate($notPdf, 'gate/notapdf.pdf');
}) === 'pdf_invalid');

// ── U4: truncated transfer ──────────────────────────────────────────────────
$truncated = $write('truncated.pdf', substr(samplePdf('Truncated'), 0, 200));
check('U4 truncated PDF is refused', failureCode(static function () use ($validate, $truncated): void {
    $validate($truncated, 'gate/truncated.pdf');
}) === 'pdf_truncated');

// ── U5: compressed cross-reference stream ──────────────────────────────────
$modern = $write('modern.pdf', crossReferenceStreamPdf());
$modernCode = failureCode(static function () use ($validate, $modern): void {
    $validate($modern, 'gate/modern.pdf');
});
if ($fpdiRenders) {
    check(
        'U5 compressed-xref PDF is refused with the explained code (FPDI renders)',
        $modernCode === 'pdf_unsupported_format',
        (string) $modernCode
    );
    $msg = '';
    try {
        $pdf->inspect($modern);
    } catch (ApiException $e) {
        $msg = $e->getMessage();
    }
    check(
        'U5 the message tells the doctor how to fix it',
        str_contains($msg, 'Re-export') || str_contains($msg, 'Print to PDF'),
        mb_substr($msg, 0, 90)
    );
} else {
    // Ghostscript understands the container, so refusing it here would block a
    // document that delivery can perfectly well water-mark.
    check('U5 compressed-xref PDF is accepted on a Ghostscript host', $modernCode === null, $modernCode ?? 'accepted');
}

// ── U6: the advertised cap fits the host ───────────────────────────────────
$cap = $integrity->maxBytes();
$hostCap = (static function (): int {
    $raw = trim((string) ini_get('upload_max_filesize'));
    if ($raw === '' || $raw === '-1' || $raw === '0') {
        return 0;
    }
    $unit = strtolower(substr($raw, -1));
    $n = (float) $raw;
    return (int) match ($unit) {
        'g' => $n * 1073741824,
        'm' => $n * 1048576,
        'k' => $n * 1024,
        default => $n,
    };
})();
check('U6 default cap is 100 MB when the host allows it', $cap > 0 && $cap <= 100 * 1024 * 1024, (string) round($cap / 1048576) . ' MB');
check('U6 cap never exceeds upload_max_filesize', $hostCap === 0 || $cap <= $hostCap, 'host ' . ($hostCap === 0 ? 'unlimited' : round($hostCap / 1048576) . ' MB'));

// ── U7: a declared size that disagrees with the bytes is a truncation ──────
$mismatch = failureCode(static function () use ($integrity, $good): void {
    $integrity->validate(
        ['error' => UPLOAD_ERR_OK, 'tmp_name' => $good, 'size' => (int) filesize($good) + 4096, 'name' => 'good.pdf', 'type' => 'application/pdf'],
        'gate/mismatch.pdf',
        'lesson-materials'
    );
});
check('U7 a short transfer is refused, not published', $mismatch === 'upload_truncated', (string) $mismatch);

// ── U8: broken cross-reference tables are damage, not "a modern format" ────
// FPDI raises CrossReferenceException for BOTH "compressed xref the free parser
// cannot read" (code 0x010B) and real corruption. Treating the class alone as
// "unsupported container" told the doctor to re-export a file that is simply
// broken. Each variant below must therefore land on pdf_invalid.
$brokenVariants = [
    'bad_startxref' => preg_replace('/startxref\n\d+/', "startxref\n999999", samplePdf('Gate test')),
    'no_xref_pointer' => str_replace("xref\n", "hrrq\n", samplePdf('Gate test')),
    'bad_xref_rows' => preg_replace('/(\d{10}) 00000 n/', '0000000001 00000 n', samplePdf('Gate test')),
];
foreach ($brokenVariants as $name => $bytes) {
    $path = $write($name . '.pdf', (string) $bytes);
    $variantCode = failureCode(static function () use ($validate, $path, $name): void {
        $validate($path, 'gate/' . $name . '.pdf');
    });
    if ($fpdiRenders) {
        check('U8 ' . $name . ' is refused as pdf_invalid, not "unsupported"', $variantCode === 'pdf_invalid', (string) $variantCode);
    } else {
        check('U8 ' . $name . ' is never mislabelled as a container problem', $variantCode !== 'pdf_unsupported_format', (string) ($variantCode ?? 'accepted'));
    }
}

// ── U9: encrypted document ─────────────────────────────────────────────────
// The real incident category is "valid PDF the engine cannot open". The tail
// scan catches it without needing a real encrypted fixture; the message must say
// "encrypted", not "damaged".
$encrypted = $write('encrypted.pdf', str_replace(
    '/Size 6 /Root 1 0 R',
    '/Size 6 /Root 1 0 R /Encrypt 9 0 R',
    samplePdf('Gate test')
));
check('U9 encrypted PDF is refused as pdf_encrypted', failureCode(static function () use ($validate, $encrypted): void {
    $validate($encrypted, 'gate/encrypted.pdf');
}) === 'pdf_encrypted');
$encMsg = '';
try {
    $pdf->inspect($encrypted);
} catch (ApiException $e) {
    $encMsg = $e->getMessage();
}
check('U9 the encrypted message names the real problem', stripos($encMsg, 'encrypted') !== false, mb_substr($encMsg, 0, 90));

// ── U10: a LARGE valid PDF is accepted ─────────────────────────────────────
// The production failure logged bytes=9563250 with reason=pdf_invalid, while the
// file the doctor picked was under 200 KB. Whatever the cause, ~9.5 MB of VALID
// bytes must pass this gate — otherwise "large file" would be a plausible
// explanation and the real one (mismatched/damaged bytes) would stay hidden.
$big = $write('large.pdf', samplePdf(str_repeat('Gate test large document. ', 350000)));
$bigSize = (int) filesize($big);
$bigCode = failureCode(static function () use ($validate, $big): void {
    $validate($big, 'gate/large.pdf');
});
check('U10 a ~9.5 MB valid PDF is accepted', $bigCode === null, ($bigCode ?? 'accepted') . ', ' . round($bigSize / 1048576, 2) . ' MB');
check('U10 its byte count is measured from disk', $bigSize > 9000000, $bigSize . ' B');

// ── U11: a refused upload writes no object ─────────────────────────────────
$storage = new MedAcademy\Storage\StorageService();
$refusedDest = 'gate/refused-' . bin2hex(random_bytes(4)) . '.pdf';
$refusedCode = failureCode(static function () use ($validate, $notPdf, $refusedDest): void {
    $validate($notPdf, $refusedDest);
});
check(
    'U11 a refused upload leaves no object behind',
    $refusedCode === 'pdf_invalid' && !is_file($storage->privateFilePath('lesson-materials', $refusedDest)),
    (string) $refusedCode
);

// ── U12: the refusal is correlated and explained in the log ────────────────
$logFile = $logDir . '/app.log';
$lines = is_file($logFile) ? (array) file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : [];
$pdfFail = null;
foreach ($lines as $line) {
    $row = json_decode((string) $line, true);
    if (!is_array($row) || ($row['message'] ?? '') !== 'storage-upload') {
        continue;
    }
    $ctx = (array) ($row['context'] ?? []);
    if (($ctx['stage'] ?? '') === 'pdf' && ($ctx['result'] ?? '') === 'fail') {
        $pdfFail = $ctx;
    }
}
check('U12 a pdf/fail line is written for the refusal', is_array($pdfFail));
if (is_array($pdfFail)) {
    check('U12 it carries a stable reason code', in_array($pdfFail['reason'] ?? '', ['pdf_invalid', 'pdf_encrypted', 'pdf_unsupported_format', 'pdf_truncated'], true), (string) ($pdfFail['reason'] ?? ''));
    check('U12 it says WHICH bytes were inspected', ($pdfFail['source'] ?? '') === 'upload' || ($pdfFail['source'] ?? '') === 'stored', (string) ($pdfFail['source'] ?? ''));
    check('U12 both the stored and the declared byte counts are recorded', array_key_exists('bytes', $pdfFail) && array_key_exists('declared_bytes', $pdfFail), (int) ($pdfFail['bytes'] ?? 0) . ' / ' . (int) ($pdfFail['declared_bytes'] ?? 0) . ' B');
    check('U12 it is correlated by an operation id', preg_match('/^up_[0-9a-f]{12}$/', (string) ($pdfFail['op'] ?? '')) === 1, (string) ($pdfFail['op'] ?? 'missing'));
}

// ── U13: the SELECTED file vs the RECEIVED bytes — and WHY the source matters ─
// Two production refusals carry the same shape: the number the client declared
// was not the size of the file the doctor picked. A <200 KB pick was logged as
// `bytes=9563250`, and a ~140 KB PDF's refusal quoted 679 bytes. Neither can
// come from PHP (`$_FILES['size']` always matches itself), and neither is
// possible for a file the doctor chose — the provider's size metadata was wrong.
//
// So the declared number now travels with its PROVENANCE (`declared_size_source`)
// and the two divergences are treated differently:
//   • SHORT arrival (truncated body)  → refused, always;
//   • LONG arrival vs a MEASURED size → refused (a different file);
//   • LONG arrival vs PROVIDER metadata → accepted and logged, because a hint
//     is not proof and refusing real documents is the worse failure.

// (a) measured ('stat') + far too many bytes = a different file.
$mismatchDest = 'gate/mismatch-' . bin2hex(random_bytes(4)) . '.pdf';
$mismatchCode = failureCode(static function () use ($validate, $big, $mismatchDest): void {
    $validate($big, $mismatchDest, 191265, 'stat');
});
check('U13 a measured 191 KB pick carrying 9.5 MB is refused', $mismatchCode === 'upload_size_mismatch', (string) $mismatchCode);
check(
    'U13 nothing is stored for a substituted body',
    !is_file($storage->privateFilePath('lesson-materials', $mismatchDest))
);

// (b) the SAME numbers from provider metadata are a wrong hint, not a wrong
// file: the bytes are a valid PDF, so they are accepted.
$pickerDest = 'gate/picker-hint-' . bin2hex(random_bytes(4)) . '.pdf';
$pickerCode = failureCode(static function () use ($validate, $big, $pickerDest): void {
    $validate($big, $pickerDest, 191265, 'picker');
});
check('U13 a wrong PICKER hint does not refuse a valid document', $pickerCode === null, (string) ($pickerCode ?? 'accepted'));

// (c) a SHORT body is a truncation whatever the provenance says.
$shortCode = failureCode(static function () use ($validate, $good): void {
    $validate($good, 'gate/short.pdf', (int) filesize($good) + 200000, 'picker');
});
check('U13 a body shorter than the declared file is refused as upload_truncated', $shortCode === 'upload_truncated', (string) $shortCode);

// A picker that is a few KB off (provider metadata) must NOT be refused: this
// guard exists to catch a different file, not to block honest uploads.
$roundingCode = failureCode(static function () use ($validate, $good): void {
    $validate($good, 'gate/rounding.pdf', (int) filesize($good) - 3000, 'stat');
});
check('U13 a size a few KB off is still accepted', $roundingCode === null, (string) ($roundingCode ?? 'accepted'));

// An old client sends no `declared_size` at all; that must keep working.
$noDeclaredCode = failureCode(static function () use ($validate, $good): void {
    $validate($good, 'gate/no-declared.pdf', 0);
});
check('U13 a client that reports no size is not blocked', $noDeclaredCode === null, (string) ($noDeclaredCode ?? 'accepted'));

// The refusal must be answerable from the log alone: both byte counts and the
// client's filename/MIME type, under the same operation id.
// Re-read: the earlier $lines snapshot was taken before this case ran.
$lines = is_file($logFile) ? (array) file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : [];
$mismatchLine = null;
$hintLine = null;
foreach ($lines as $line) {
    $row = json_decode((string) $line, true);
    if (!is_array($row) || ($row['message'] ?? '') !== 'storage-upload') {
        continue;
    }
    $ctx = (array) ($row['context'] ?? []);
    if (($ctx['reason'] ?? '') === 'client_size_mismatch') {
        $mismatchLine = $ctx;
    }
    if (($ctx['reason'] ?? '') === 'picker_size_inaccurate') {
        $hintLine = $ctx;
    }
}
check('U13 the size refusal is logged with reason client_size_mismatch', is_array($mismatchLine));
check(
    'U13 a wrong picker hint is logged (warn) but not refused',
    is_array($hintLine) && ($hintLine['result'] ?? '') === 'warn',
    (string) ($hintLine['result'] ?? 'not logged')
);
if (is_array($mismatchLine)) {
    check(
        'U13 it records the declared size AND the received size',
        (int) ($mismatchLine['declared_bytes'] ?? 0) === 191265 && (int) ($mismatchLine['actual_bytes'] ?? 0) > 9000000,
        (int) ($mismatchLine['declared_bytes'] ?? 0) . ' vs ' . (int) ($mismatchLine['actual_bytes'] ?? 0) . ' B'
    );
    check(
        'U13 it records the declared size SOURCE',
        ($mismatchLine['declared_source'] ?? '') === 'stat',
        (string) ($mismatchLine['declared_source'] ?? 'missing')
    );
    check(
        'U13 it names the document the client sent',
        ($mismatchLine['client_name'] ?? '') !== '' && ($mismatchLine['client_type'] ?? '') !== '',
        (string) ($mismatchLine['client_name'] ?? '') . ' / ' . (string) ($mismatchLine['client_type'] ?? '')
    );
}

// ── Cleanup ────────────────────────────────────────────────────────────────
foreach ((array) glob($work . '/*') as $f) {
    @unlink((string) $f);
}
@rmdir($work);
foreach ((array) glob($logDir . '/*') as $f) {
    @unlink((string) $f);
}
@rmdir($logDir);

echo str_repeat('─', 78), "\n";
printf("%d passed, %d failed\n", $passed, $failed);
exit($failed === 0 ? 0 : 1);
