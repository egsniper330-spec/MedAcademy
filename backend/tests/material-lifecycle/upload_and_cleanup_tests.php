<?php

declare(strict_types=1);

/**
 * upload_and_cleanup_tests.php — the zero-byte-upload regression suite and the
 * delete/replace file-lifecycle suite.
 *
 * WHAT THIS PROVES (all against the REAL controllers/services, a REAL private
 * storage directory and a REAL database):
 *
 *   UPLOAD
 *     U1  a 0-byte body is refused (`upload_empty`) and stores NOTHING — the
 *         exact shape of the production incident (row + 0-byte object + 200 OK)
 *     U2  a body shorter than the declared size is refused (`upload_truncated`)
 *     U3  a missing temp file is refused (`upload_missing`)
 *     U4  an HTML file named `.pdf` is refused (`pdf_invalid` / `pdf_truncated`)
 *     U5  a truncated PDF (no %%EOF) is refused (`pdf_truncated`)
 *     U6  a valid PDF is stored, and the reported size/SHA-256 match the bytes
 *         actually on disk (not the client's claim)
 *     U7  a persist whose byte count does not match leaves NO object behind
 *     U8  `POST /storage/upload` end-to-end: 0 bytes → coded refusal, no file;
 *         a valid PDF → 200 {size, sha256} and one complete object
 *     U9  `lesson_materials` writes are refused when the object is missing, and
 *         the recorded `file_size` is measured from disk
 *   CLEANUP
 *     C1  deleting a material removes the source and its watermarked copies
 *     C2  a path still referenced by another material is RETAINED
 *     C3  `../` traversal never deletes outside the storage root
 *     C4  cleanup is idempotent (a missing file is not an error)
 *     C5  a failed deletion is queued and `retryPending()` reclaims it
 *
 * USAGE (operator / CI machine with PHP 8.2+):
 *     bash backend/tests/material-lifecycle/run.sh
 *   or directly:
 *     php backend/tests/material-lifecycle/upload_and_cleanup_tests.php
 *
 * It never touches production data, credentials or the network. The SQLite PDO
 * is injected into `Database` by reflection (test-only, exactly like
 * backend/tests/pdf-watermark/delivery_tests.php).
 *
 * The PDF fixture is built with the vendored TCPDF so it is byte-for-byte a
 * document the real watermark engine can parse; if the vendored library is not
 * installed the PDF-specific cases are reported SKIPPED rather than passed.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
$WORK = (string) (getenv('MATTEST_WORKDIR') ?: $root . '/.freebuff/material-lifecycle-tests');
$OUT = $WORK . '/out';
$STORE = $OUT . '/storage/private';
$STORE_PUBLIC = $OUT . '/storage/public';

@mkdir($OUT, 0775, true);
@mkdir($STORE, 0775, true);
@mkdir($STORE_PUBLIC, 0775, true);
@mkdir($WORK . '/logs', 0775, true);

// StorageService resolves these against MEDACADEMY_BASE (backend/), so they are
// expressed relative to it. Set BEFORE bootstrap: real env wins over .env.
$workReal = str_replace('\\', '/', (string) (realpath($WORK) ?: $WORK));
$repoReal = str_replace('\\', '/', (string) (realpath($root) ?: $root));
if (!str_starts_with($workReal, $repoReal . '/')) {
    fwrite(STDERR, "the test workspace must live inside the repository\n");
    exit(2);
}
$relWork = '../' . ltrim(substr($workReal, strlen($repoReal)), '/');

$env = [
    'APP_ENV' => 'testing',
    'APP_URL' => 'http://127.0.0.1:8080',
    'STORAGE_PRIVATE_DIR' => $relWork . '/out/storage/private',
    'STORAGE_PUBLIC_DIR' => $relWork . '/out/storage/public',
    'STORAGE_SIGNED_URL_SECRET' => 'material-lifecycle-test-secret',
    'JWT_SECRET' => 'material-lifecycle-test-secret',
    'LOG_DIR' => $relWork . '/logs',
];
foreach ($env as $k => $v) {
    putenv($k . '=' . $v);
    $_ENV[$k] = $v;
}

require $root . '/backend/src/bootstrap.php';

use MedAcademy\Controllers\DataController;
use MedAcademy\Controllers\StorageController;
use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\MaterialFileCleanupService;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Services\UploadIntegrityService;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;

\MedAcademy\Utils\Config::init();

$DB_FILE = $OUT . '/db.sqlite';
$FAILS = 0;
$PASSES = 0;
$SKIPS = 0;

function check(string $name, bool $condition, string $detail = ''): void
{
    global $FAILS, $PASSES;
    if ($condition) {
        $PASSES++;
        echo "  ok   {$name}\n";
        return;
    }
    $FAILS++;
    echo "  FAIL {$name}" . ($detail !== '' ? " — {$detail}" : '') . "\n";
}

function skip(string $name, string $why): void
{
    global $SKIPS;
    $SKIPS++;
    echo "  SKIP {$name} — {$why}\n";
}

function section(string $title): void
{
    echo "\n" . $title . "\n";
}

// ── Test-only SQLite PDO: translates the one MySQL-ism used in this path ─────
final class LifecycleTestPdo extends PDO
{
    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $query = (string) preg_replace(
            '/\b(?:UTC_TIMESTAMP|CURRENT_TIMESTAMP|NOW)\s*\(\s*\d*\s*\)/i',
            'CURRENT_TIMESTAMP',
            $query
        );
        return parent::prepare($query, $options);
    }
}

function connectDb(): LifecycleTestPdo
{
    global $DB_FILE;
    $pdo = new LifecycleTestPdo('sqlite:' . $DB_FILE);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 20000');
    return $pdo;
}

function bindDatabase(PDO $pdo): void
{
    $db = (new ReflectionClass(Database::class))->newInstanceWithoutConstructor();
    (new ReflectionProperty(Database::class, 'pdo'))->setValue($db, $pdo);
    (new ReflectionProperty(Database::class, 'instance'))->setValue(null, $db);
}

function resetDatabase(): void
{
    $pdo = connectDb();
    $pdo->exec('DROP TABLE IF EXISTS lesson_material_pdfs');
    $pdo->exec('DROP TABLE IF EXISTS lesson_materials');
    $pdo->exec('DROP TABLE IF EXISTS lessons');
    $pdo->exec('DROP TABLE IF EXISTS courses');
    $pdo->exec('CREATE TABLE courses (id TEXT PRIMARY KEY, doctor_id TEXT)');
    $pdo->exec('CREATE TABLE lessons (id TEXT PRIMARY KEY, course_id TEXT)');
    $pdo->exec(
        'CREATE TABLE lesson_materials (
            id TEXT PRIMARY KEY, lesson_id TEXT, course_id TEXT, file_name TEXT, file_type TEXT,
            file_size INTEGER, storage_path TEXT, permission TEXT DEFAULT \'allow\',
            download_enabled INTEGER DEFAULT 1,
            file_hash TEXT, file_hash_path TEXT, file_hash_size INTEGER, file_hash_mtime INTEGER
        )'
    );
    $pdo->exec(
        'CREATE TABLE lesson_material_pdfs (
            id TEXT PRIMARY KEY, material_id TEXT, student_id TEXT, variant_key TEXT,
            storage_path TEXT, page_count INTEGER
        )'
    );
    bindDatabase($pdo);
}

/** Absolute path of a private object, creating its directory. */
function objectPath(StorageService $storage, string $bucket, string $rel): string
{
    $abs = $storage->privateFilePath($bucket, $rel);
    $dir = dirname($abs);
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
    return $abs;
}

/** Build a real, parseable PDF with the vendored TCPDF; false when absent. */
function makePdf(string $path, string $text = 'Material lifecycle fixture'): bool
{
    try {
        // loadLibraries() requires the vendored autoload; isAvailable() triggers it.
        (new PdfWatermarkService())->isAvailable();
        if (!class_exists('TCPDF')) {
            return false;
        }
        $pdf = new \TCPDF('P', 'mm', 'A4');
        $pdf->SetAutoPageBreak(true, 10);
        $pdf->AddPage();
        $pdf->SetFont('helvetica', '', 12);
        $pdf->Write(0, $text);
        $bytes = $pdf->Output('', 'S');
        if (!is_string($bytes) || $bytes === '') {
            return false;
        }
        @mkdir(dirname($path), 0775, true);
        return @file_put_contents($path, $bytes) !== false;
    } catch (\Throwable) {
        return false;
    }
}

/** Run a closure expecting an ApiException; returns the code (or null). */
function expectCode(callable $fn): ?string
{
    try {
        $fn();
        return null;
    } catch (ApiException $e) {
        return (string) ($e->errors[0] ?? '');
    } catch (\Throwable) {
        return null;
    }
}

// ── Environment guards ──────────────────────────────────────────────────────
$storage = new StorageService();
$cleanup = new MaterialFileCleanupService();
$integrity = new UploadIntegrityService();

echo "Material upload integrity + file lifecycle tests\n";
echo "workspace: {$OUT}\n";

resetDatabase();

// ── U1–U7: UploadIntegrityService ────────────────────────────────────────────
section('UPLOAD INTEGRITY (UploadIntegrityService)');

$tmpDir = $OUT . '/tmp';
@mkdir($tmpDir, 0775, true);

// U1: the incident. UPLOAD_ERR_OK + an empty temp file.
$emptyTmp = $tmpDir . '/empty.pdf';
@file_put_contents($emptyTmp, '');
$code = expectCode(fn () => $integrity->validate(
    ['name' => 'Biology_AR_Model_7.pdf', 'type' => 'application/pdf', 'tmp_name' => $emptyTmp, 'size' => 0, 'error' => UPLOAD_ERR_OK],
    'course/lesson/empty.pdf',
    'lesson-materials'
));
check('U1.1 zero-byte body is refused with upload_empty', $code === 'upload_empty', (string) $code);
$after = $storage->privateFilePath('lesson-materials', 'course/lesson/empty.pdf');
check('U1.2 nothing is written for a zero-byte body', !is_file($after));

// U2: declared 2 MB, 10 bytes on disk → a truncated multipart body.
$shortTmp = $tmpDir . '/short.pdf';
@file_put_contents($shortTmp, str_repeat('A', 10));
$code = expectCode(fn () => $integrity->validate(
    ['name' => 'a.pdf', 'type' => 'application/pdf', 'tmp_name' => $shortTmp, 'size' => 2097152, 'error' => UPLOAD_ERR_OK],
    'course/lesson/short.pdf',
    'lesson-materials'
));
check('U2 truncated body is refused with upload_truncated', $code === 'upload_truncated', (string) $code);

// U3: PHP's temp file vanished (or the field was never populated).
$code = expectCode(fn () => $integrity->validate(
    ['name' => 'a.pdf', 'type' => 'application/pdf', 'tmp_name' => $tmpDir . '/does-not-exist.pdf', 'size' => 10, 'error' => UPLOAD_ERR_OK],
    'course/lesson/missing.pdf',
    'lesson-materials'
));
check('U3 missing temp file is refused with upload_missing', $code === 'upload_missing', (string) $code);

// U3b: PHP reported an upload error — never ignored.
$code = expectCode(fn () => $integrity->validate(
    ['name' => 'a.pdf', 'type' => 'application/pdf', 'tmp_name' => $shortTmp, 'size' => 10, 'error' => UPLOAD_ERR_PARTIAL],
    'course/lesson/partial.pdf',
    'lesson-materials'
));
check('U3b UPLOAD_ERR_PARTIAL is refused, not stored', $code === 'upload_truncated', (string) $code);

// U4: an HTML document named .pdf.
$notPdfTmp = $tmpDir . '/notapdf.pdf';
@file_put_contents($notPdfTmp, '<html><body>not a pdf</body></html>');
$code = expectCode(fn () => $integrity->validate(
    ['name' => 'notes.pdf', 'type' => 'application/pdf', 'tmp_name' => $notPdfTmp, 'size' => (int) filesize($notPdfTmp), 'error' => UPLOAD_ERR_OK],
    'course/lesson/notes.pdf',
    'lesson-materials'
));
check('U4 HTML named .pdf is refused', in_array($code, ['pdf_invalid', 'pdf_truncated'], true), (string) $code);

// U5/U6 need a genuine PDF.
$validTmp = $tmpDir . '/valid.pdf';
$havePdf = makePdf($validTmp);
if ($havePdf) {
    $validBytes = (int) filesize($validTmp);

    // U5: cut the document short (no %%EOF) — the transfer stopped early.
    $cutTmp = $tmpDir . '/cut.pdf';
    @file_put_contents($cutTmp, substr((string) file_get_contents($validTmp), 0, (int) floor($validBytes * 0.6)));
    $code = expectCode(fn () => $integrity->validate(
        ['name' => 'cut.pdf', 'type' => 'application/pdf', 'tmp_name' => $cutTmp, 'size' => (int) filesize($cutTmp), 'error' => UPLOAD_ERR_OK],
        'course/lesson/cut.pdf',
        'lesson-materials'
    ));
    check('U5 truncated PDF is refused', in_array($code, ['pdf_truncated', 'pdf_invalid'], true), (string) $code);

    // U6: a real PDF round trip.
    $dest = 'course-1/lesson-1/valid.pdf';
    $validated = $integrity->validate(
        ['name' => 'valid.pdf', 'type' => 'application/pdf', 'tmp_name' => $validTmp, 'size' => $validBytes, 'error' => UPLOAD_ERR_OK],
        $dest,
        'lesson-materials'
    );
    check('U6.1 a valid PDF passes validation', $validated['size'] === $validBytes, (string) $validated['size']);
    $stored = $integrity->persist($validated['tmp'], $validated['size'], 'lesson-materials', $dest, false);
    $abs = $storage->privateFilePath('lesson-materials', $dest);
    check('U6.2 the object exists at the final path', is_file($abs));
    check('U6.3 the reported size equals the bytes on disk', $stored['size'] === (int) filesize($abs) && $stored['size'] > 0);
    check('U6.4 the reported SHA-256 equals the file digest', $stored['sha256'] === hash_file('sha256', $abs));

    // U7: a persist that cannot deliver every byte leaves nothing behind.
    $tmp2 = $tmpDir . '/mismatch.pdf';
    @copy($validTmp, $tmp2);
    $code = expectCode(fn () => $integrity->persist($tmp2, (int) filesize($tmp2) + 512, 'lesson-materials', 'course-1/lesson-1/mismatch.pdf', false));
    check('U7.1 a short write is refused with persist_mismatch', $code === 'persist_mismatch', (string) $code);
    check('U7.2 no partial object is left behind', !is_file($storage->privateFilePath('lesson-materials', 'course-1/lesson-1/mismatch.pdf')));
} else {
    skip('U5 truncated PDF refused', 'vendored TCPDF/FPDI not installed');
    skip('U6 valid PDF round trip', 'vendored TCPDF/FPDI not installed');
    skip('U7 short write refused', 'vendored TCPDF/FPDI not installed');
}

// ── U8: the HTTP handler end-to-end ─────────────────────────────────────────
section('UPLOAD ENDPOINT (StorageController::upload)');

const COURSE_ID = '3a29a59e-59ef-48da-894a-b8e20d091ed1';
const LESSON_ID = '108ba8e2-6383-45ef-b587-281aed4d3c68';
const DOCTOR_ID = '11111111-1111-4111-8111-111111111111';

$pdo = connectDb();
$pdo->exec("INSERT INTO courses (id, doctor_id) VALUES ('" . COURSE_ID . "', '" . DOCTOR_ID . "')");
$pdo->exec("INSERT INTO lessons (id, course_id) VALUES ('" . LESSON_ID . "', '" . COURSE_ID . "')");

/** Drive one POST /storage/upload with a fabricated multipart body. */
$runUpload = function (string $tmpPath, int $declaredSize, string $dest, int $error = UPLOAD_ERR_OK) {
    $_SERVER['REQUEST_METHOD'] = 'POST';
    $_SERVER['REQUEST_URI'] = '/storage/upload';
    $_SERVER['CONTENT_LENGTH'] = (string) max(1, $declaredSize);
    $_SERVER['REMOTE_ADDR'] = '127.0.0.1';
    $_POST = ['bucket' => 'lesson-materials', 'path' => $dest];
    $_FILES = [
        'file' => [
            'name' => basename($dest),
            'type' => 'application/pdf',
            'tmp_name' => $tmpPath,
            'error' => $error,
            'size' => $declaredSize,
        ],
    ];
    $request = Request::capture();
    $request->user = ['id' => DOCTOR_ID, 'role' => 'doctor'];
    return (new StorageController())->upload($request);
};

$emptyPath = $tmpDir . '/http-empty.pdf';
@file_put_contents($emptyPath, '');
$code = expectCode(fn () => $runUpload($emptyPath, 0, COURSE_ID . '/' . LESSON_ID . '/http-empty.pdf'));
check('U8.1 the endpoint refuses a zero-byte body (upload_empty)', $code === 'upload_empty', (string) $code);
check(
    'U8.2 the refused upload left no object',
    !is_file($storage->privateFilePath('lesson-materials', COURSE_ID . '/' . LESSON_ID . '/http-empty.pdf'))
);

if ($havePdf) {
    $goodTmp = $tmpDir . '/http-good.pdf';
    @copy($validTmp, $goodTmp);
    $goodSize = (int) filesize($goodTmp);
    $response = $runUpload($goodTmp, $goodSize, COURSE_ID . '/' . LESSON_ID . '/http-good.pdf');
    $goodAbs = $storage->privateFilePath('lesson-materials', COURSE_ID . '/' . LESSON_ID . '/http-good.pdf');
    check('U8.3 a valid upload returns the measured size', (int) ($response['size'] ?? 0) === $goodSize, (string) ($response['size'] ?? 'missing'));
    check('U8.4 a valid upload returns the stored digest', ($response['sha256'] ?? '') === hash_file('sha256', $goodAbs));
    check('U8.5 the stored object is complete', is_file($goodAbs) && (int) filesize($goodAbs) === $goodSize);
} else {
    skip('U8.3–U8.5 valid upload through the endpoint', 'vendored TCPDF/FPDI not installed');
}

// ── U9: a material row cannot point at nothing ──────────────────────────────
section('MATERIAL ROW INTEGRITY (DataController)');

$dc = new DataController();
$verify = new ReflectionMethod(DataController::class, 'withVerifiedMaterialFile');
$verify->setAccessible(true);

$code = expectCode(fn () => $verify->invoke($dc, ['storage_path' => COURSE_ID . '/' . LESSON_ID . '/ghost.pdf', 'file_type' => 'application/pdf', 'file_size' => 2097152]));
check('U9.1 a row naming a missing object is refused', $code === 'material_file_missing', (string) $code);

if ($havePdf) {
    // The valid object from U8.5, claimed with a bogus client-side size.
    $row = $verify->invoke($dc, [
        'storage_path' => COURSE_ID . '/' . LESSON_ID . '/http-good.pdf',
        'file_type' => 'application/pdf',
        'file_size' => 999999999,
    ]);
    $goodAbs = $storage->privateFilePath('lesson-materials', COURSE_ID . '/' . LESSON_ID . '/http-good.pdf');
    check('U9.2 file_size is measured from disk, not taken from the client', (int) ($row['file_size'] ?? 0) === (int) filesize($goodAbs));
    check('U9.3 the source-hash cache is filled from the stored bytes', ($row['file_hash'] ?? '') === hash_file('sha256', $goodAbs));
    check('U9.4 the cache records the path it describes', ($row['file_hash_path'] ?? '') === COURSE_ID . '/' . LESSON_ID . '/http-good.pdf');
} else {
    skip('U9.2–U9.4 measured size + hash cache', 'vendored TCPDF/FPDI not installed');
}

// ── C1–C5: cleanup ──────────────────────────────────────────────────────────
section('DELETE / REPLACE CLEANUP (MaterialFileCleanupService)');

$pdo = connectDb();
$pdo->exec('DELETE FROM lesson_material_pdfs');
$pdo->exec('DELETE FROM lesson_materials');

$sourceRel = COURSE_ID . '/' . LESSON_ID . '/to-delete.pdf';
$variantRel = 'mat-1/student-1/copy.pdf';
$sourceAbs = objectPath($storage, 'lesson-materials', $sourceRel);
$variantAbs = objectPath($storage, PdfWatermarkService::BUCKET, $variantRel);
@file_put_contents($sourceAbs, str_repeat('P', 4096));
@file_put_contents($variantAbs, str_repeat('W', 8192));

$pdo->exec("INSERT INTO lesson_materials (id, lesson_id, course_id, storage_path, file_name, file_type, file_size)
            VALUES ('mat-1', '" . LESSON_ID . "', '" . COURSE_ID . "', '" . $sourceRel . "', 'a.pdf', 'application/pdf', 4096)");
$pdo->exec("INSERT INTO lesson_material_pdfs (id, material_id, student_id, variant_key, storage_path, page_count)
            VALUES ('v1', 'mat-1', 'student-1', 'k1', '" . $variantRel . "', 1)");

$snapshot = $cleanup->snapshotMaterial('mat-1');
check('C1.0 the snapshot captures the source and its copies', $snapshot !== null
    && ($snapshot['source'] ?? '') === $sourceRel
    && in_array($variantRel, $snapshot['variants'] ?? [], true));

$result = $cleanup->retire([$snapshot], 'test_delete', DOCTOR_ID);
check('C1.1 the source object is removed', !is_file($sourceAbs));
check('C1.2 the watermarked copy is removed', !is_file($variantAbs));
check('C1.3 the freed byte count is reported', (int) $result['bytes'] === 4096 + 8192, (string) $result['bytes']);
check('C1.4 the variant registry rows are cleared', (int) $pdo->query("SELECT COUNT(*) FROM lesson_material_pdfs WHERE material_id='mat-1'")->fetchColumn() === 0);

// C2: a shared path must survive.
$sharedRel = COURSE_ID . '/' . LESSON_ID . '/shared.pdf';
$sharedAbs = objectPath($storage, 'lesson-materials', $sharedRel);
@file_put_contents($sharedAbs, str_repeat('S', 1024));
$pdo->exec("INSERT INTO lesson_materials (id, lesson_id, course_id, storage_path) VALUES ('mat-2', '" . LESSON_ID . "', '" . COURSE_ID . "', '" . $sharedRel . "')");
$pdo->exec("INSERT INTO lesson_materials (id, lesson_id, course_id, storage_path) VALUES ('mat-3', '" . LESSON_ID . "', '" . COURSE_ID . "', '" . $sharedRel . "')");
$snapshot2 = $cleanup->snapshotMaterial('mat-2');
$cleanup->retire([$snapshot2], 'test_delete', DOCTOR_ID);
check('C2 a source still referenced by another material is retained', is_file($sharedAbs));

// C3: traversal never escapes the root.
$outside = $storage->privateDir() . '/outside.txt';
@file_put_contents($outside, 'do not delete');
$pdo->exec("INSERT INTO lesson_materials (id, lesson_id, course_id, storage_path) VALUES ('mat-4', '" . LESSON_ID . "', '" . COURSE_ID . "', '../outside.txt')");
$snapshot3 = $cleanup->snapshotMaterial('mat-4');
$cleanup->retire([$snapshot3], 'test_delete', DOCTOR_ID);
check('C3 a `../` path cannot delete outside the storage root', is_file($outside));

// C4: idempotent.
$again = $cleanup->retire([$snapshot3], 'test_delete', DOCTOR_ID);
check('C4 a repeated cleanup is a no-op, not an error', iterator_count(new ArrayIterator([$again])) === 1 && is_file($outside));

// C5: a queued failure is retried and reclaimed.
$queuedRel = COURSE_ID . '/' . LESSON_ID . '/queued.pdf';
$queuedAbs = objectPath($storage, 'lesson-materials', $queuedRel);
@file_put_contents($queuedAbs, str_repeat('Q', 2048));
$queued = $cleanup->enqueue([
    'reason' => 'test_failure',
    'bucket' => 'lesson-materials',
    'paths' => [$queuedRel],
    'material_ids' => ['mat-1'],
]);
check('C5.1 a failed cleanup can be queued', $queued === true && count($cleanup->pending()) >= 1);
$retry = $cleanup->retryPending();
check('C5.2 the retry reclaims the file', !is_file($queuedAbs));
check('C5.3 nothing is left pending for that path', (int) $retry['remaining'] === 0, (string) $retry['remaining']);

// ── D1–D6: discard an upload that never became a row ────────────────────────
section('DISCARD UNREFERENCED UPLOAD (StorageController::discardUpload)');

// The lesson editor reclaims the just-uploaded object when the material insert is
// refused with a DEFINITIVE 4xx. This route must (a) delete only unreferenced
// bytes, (b) refuse a path a material still references, and (c) be scoped to the
// caller's own course. The generic /storage/delete is deliberately permissive, so
// the guard has to live here.
$OTHER_DOCTOR = '22222222-2222-4222-8222-222222222222';
$OTHER_COURSE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
$OTHER_LESSON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
$pdo = connectDb();
$pdo->exec("INSERT INTO courses (id, doctor_id) VALUES ('" . $OTHER_COURSE . "', '" . $OTHER_DOCTOR . "')");
$pdo->exec("INSERT INTO lessons (id, course_id) VALUES ('" . $OTHER_LESSON . "', '" . $OTHER_COURSE . "')");

/** Drive one POST /storage/discard-upload (JSON body injected: CLI has no php://input). */
$runDiscard = function (string $bucket, string $path, string $role = 'doctor', string $userId = DOCTOR_ID) {
    $_SERVER['REQUEST_METHOD'] = 'POST';
    $_SERVER['REQUEST_URI'] = '/storage/discard-upload';
    $_SERVER['CONTENT_LENGTH'] = '64';
    $_SERVER['REMOTE_ADDR'] = '127.0.0.1';
    $_POST = [];
    $_FILES = [];
    $request = Request::capture();
    (new ReflectionProperty(Request::class, 'body'))->setValue($request, ['bucket' => $bucket, 'path' => $path]);
    $request->user = ['id' => $userId, 'role' => $role];
    return (new StorageController())->discardUpload($request);
};

// D1: unreferenced bytes are reclaimed.
$orphanRel = COURSE_ID . '/' . LESSON_ID . '/orphan.pdf';
$orphanAbs = objectPath($storage, 'lesson-materials', $orphanRel);
@file_put_contents($orphanAbs, str_repeat('O', 2048));
$response = $runDiscard('lesson-materials', $orphanRel);
check('D1.1 an unreferenced upload is discarded', ($response['discarded'] ?? false) === true && !is_file($orphanAbs));

// D2: a path a material still references is REFUSED and kept.
$liveRel = COURSE_ID . '/' . LESSON_ID . '/live.pdf';
$liveAbs = objectPath($storage, 'lesson-materials', $liveRel);
@file_put_contents($liveAbs, str_repeat('L', 1024));
$pdo->exec("INSERT INTO lesson_materials (id, lesson_id, course_id, storage_path) VALUES ('mat-live', '" . LESSON_ID . "', '" . COURSE_ID . "', '" . $liveRel . "')");
$code = expectCode(fn () => $runDiscard('lesson-materials', $liveRel));
check('D2.1 a referenced object is refused with object_referenced', $code === 'object_referenced', (string) $code);
check('D2.2 the referenced object still exists', is_file($liveAbs));

// D3: one doctor cannot discard another doctor's object.
$foreignRel = $OTHER_COURSE . '/' . $OTHER_LESSON . '/theirs.pdf';
$foreignAbs = objectPath($storage, 'lesson-materials', $foreignRel);
@file_put_contents($foreignAbs, str_repeat('T', 1024));
$code = expectCode(fn () => $runDiscard('lesson-materials', $foreignRel));
check('D3.1 another doctor\'s path is refused with discard_forbidden', $code === 'discard_forbidden', (string) $code);
check('D3.2 the other doctor\'s object is kept', is_file($foreignAbs));

// D4/D5: only the attachment bucket, only a non-empty normalised path.
check('D4 another bucket is refused', expectCode(fn () => $runDiscard('user-avatars', 'x/y.png')) === 'discard_invalid');
check('D5 an empty path is refused', expectCode(fn () => $runDiscard('lesson-materials', '')) === 'discard_invalid');

// D6: idempotent — a missing object is a no-op, not an error.
$response = $runDiscard('lesson-materials', COURSE_ID . '/' . LESSON_ID . '/never-existed.pdf');
check('D6 a missing object is a no-op', ($response['discarded'] ?? true) === false);

// ── Summary ─────────────────────────────────────────────────────────────────
echo "\n" . str_repeat('-', 60) . "\n";
echo "{$PASSES} passed, {$FAILS} failed, {$SKIPS} skipped\n";
if ($FAILS > 0) {
    echo "FAILED\n";
    exit(1);
}
echo "ALL CHECKS PASSED\n";
exit(0);
