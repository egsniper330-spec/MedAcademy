<?php

declare(strict_types=1);

/**
 * byte_range_tests.php — the download path's streaming + range contract, executed.
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * Downloading a lesson attachment used to run
 * `Response::raw(file_get_contents($file))`:
 *
 *   • the WHOLE file was read into the PHP heap before the first byte was sent,
 *     so time-to-first-byte was the full read time, and
 *   • no Content-Length was sent, so the app could not show a determinate
 *     progress bar and could not tell a truncated transfer from a slow one, and
 *   • there was no `Accept-Ranges`, so an interrupted 25 MB download had to
 *     start again from zero.
 *
 * `Response::file()` streams the object with `Content-Length` and honours a
 * single byte range. The headers it sets cannot be observed from the CLI, so the
 * RANGE PARSER is pure and is tested here directly, and the wiring (which routes
 * use the streaming responder, and what they no longer do) is asserted from the
 * source.
 *
 * RUN
 *   ./.phpcli/php/php.exe backend/tests/http/byte_range_tests.php
 */

// The application does not use Composer's classmap for its own namespace (it
// loads them from src/ via the front controller), so a test includes exactly the
// three files Response.php depends on.
$src = dirname(__DIR__, 2) . '/src';
require $src . '/Http/ApiException.php';
require $src . '/Utils/Json.php';
require $src . '/Http/Response.php';

use MedAcademy\Http\Response;

$pass = 0;
$fail = 0;

function check(string $name, bool $ok, string $detail = ''): void
{
    global $pass, $fail;
    if ($ok) {
        $pass++;
        echo "  ok    {$name}" . ($detail !== '' ? "  ({$detail})" : '') . "\n";
        return;
    }
    $fail++;
    echo "  FAIL  {$name}" . ($detail !== '' ? "  ({$detail})" : '') . "\n";
}

echo "── 1. Single byte ranges ──\n";
$size = 1000;

check('1a "bytes=0-99" is the first hundred bytes', Response::parseRange('bytes=0-99', $size) === [0, 99]);
check('1b "bytes=900-" runs to the end', Response::parseRange('bytes=900-', $size) === [900, 999]);
check('1c "bytes=-100" is the LAST hundred bytes', Response::parseRange('bytes=-100', $size) === [900, 999]);
check('1d a suffix larger than the file is clamped', Response::parseRange('bytes=-5000', $size) === [0, 999]);
check('1e an end beyond the file is clamped', Response::parseRange('bytes=990-9999', $size) === [990, 999]);
check('1f "bytes=500-999" is the second half', Response::parseRange('bytes=500-999', $size) === [500, 999]);
check('1g whitespace and case do not matter', Response::parseRange('BYTES = 10 - 20', $size) === [10, 20]);

echo "── 2. Things that must NOT be a partial response ──\n";
check('2a no header → whole file (null)', Response::parseRange('', $size) === null);
check('2b a broken header → whole file, not a 500', Response::parseRange('bytes=abc', $size) === null);
check('2c a bare "bytes=" → whole file', Response::parseRange('bytes=', $size) === null);
check('2d reversed range → whole file', Response::parseRange('bytes=80-20', $size) === null);
check('2e multi-range → whole file (no multipart body is built)', Response::parseRange('bytes=0-9,20-29', $size) === null);
check('2f a unit other than bytes → whole file', Response::parseRange('items=0-9', $size) === null);
check('2g zero-length object → whole file', Response::parseRange('bytes=0-0', 0) === null);

echo "── 3. Unsatisfiable ranges must be a 416, never a silent whole file ──\n";
check('3a start at/after the end is unsatisfiable', Response::parseRange('bytes=1000-', $size) === false);
check('3b start past the end is unsatisfiable', Response::parseRange('bytes=5000-6000', $size) === false);
check('3c a zero-length suffix is unsatisfiable', Response::parseRange('bytes=-0', $size) === false);

echo "── 4. Wiring: the routes stream, they do not buffer ──\n";
$storage = (string) file_get_contents(dirname(__DIR__, 2) . '/src/Controllers/StorageController.php');
$response = (string) file_get_contents(dirname(__DIR__, 2) . '/src/Http/Response.php');

$publicFile = substr($storage, (int) strpos($storage, 'public function publicFile'));
$publicFile = substr($publicFile, 0, (int) strpos($publicFile, 'public function signedFile'));
$signedFile = substr($storage, (int) strpos($storage, 'public function signedFile'));
$signedFile = substr($signedFile, 0, (int) strpos($signedFile, 'public function upload'));

check('4a /storage/public streams the object', str_contains($publicFile, 'Response::file($file'));
check('4b /storage/signed streams the object', str_contains($signedFile, 'Response::file($file'));
// The comments that explain the old behaviour mention the function by name, so
// the assertion targets the CALL, not any occurrence of the word.
check('4c neither route buffers the body in PHP memory anymore', !str_contains($publicFile, 'file_get_contents($file)')
    && !str_contains($signedFile, 'file_get_contents($file)'));
check('4d the personalized-PDF delivery still streams (unchanged)', str_contains(
    (string) file_get_contents(dirname(__DIR__, 2) . '/src/Controllers/MaterialDeliveryController.php'),
    'Response::file('
));
check('4e Accept-Ranges is advertised on every streamed file', str_contains($response, "header('Accept-Ranges: bytes')"));
check('4f a partial response carries Content-Range and its own length', str_contains($response, 'Content-Range: bytes ')
    && str_contains($response, "header('Content-Length: ' . (\$end - \$start + 1))"));
check('4g the connection slot is released BEFORE the transfer', (bool) preg_match(
    '/Database::instance\(\)->release\(\);\s*(\/\/[^\n]*\n\s*)*Response::file/',
    $signedFile
));
check('4h the private-storage guard still runs before any byte is sent', strpos($signedFile, 'isLessonMaterialPdf') < strpos($signedFile, 'Response::file'));

echo "\n{$pass} passed, {$fail} failed.\n";
exit($fail === 0 ? 0 : 1);
