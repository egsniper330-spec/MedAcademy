<?php

declare(strict_types=1);

/**
 * delivery_tests.php — END-TO-END tests for the personalized-PDF delivery path.
 *
 * The other suites prove the renderer, the error contract and the authorization
 * matrix in isolation. This one drives the REAL controllers
 * (`MaterialDeliveryController`, `StorageController`) and the REAL cleanup
 * script against a real database and a real private storage directory.
 *
 * WHY CHILD PROCESSES
 * -------------------
 * The streaming endpoints answer with `Response::file()` / `Response::error()`,
 * which write the response and `exit`. There is no way to observe that from
 * inside one PHP process, and stubbing it would test a copy of the code instead
 * of the code. Each scenario therefore runs in a child `php` process: stdout IS
 * the response body, so a PDF body is recognised by its `%PDF-` header and a
 * refusal by its JSON envelope. The parent seeds, orchestrates and asserts.
 *
 * WHY SQLITE
 * ----------
 * The production database is MySQL and no MySQL server is available here. A
 * SQLite PDO is injected into `Database` by reflection (test-only; production
 * code and schema are untouched) and a thin PDO subclass translates the two
 * MySQL-only constructs the controllers use (`ON DUPLICATE KEY UPDATE`,
 * `UTC_TIMESTAMP(6)`). Every other statement — the authorization joins, the
 * source-hash cache, the variant registry, the rate limiter, the audit write —
 * runs exactly as written in the shipped code.
 *
 * WHAT IS COVERED (see the numbered sections below)
 *   1. every student PDF delivery is personalized (legacy flag ignored)
 *   2. identity comes from the server profile, never the request payload
 *   3. two students get different, individually-watermarked copies
 *   4. every page carries the identity; the copy differs from the original
 *   5. preview AND download intents both hit the personalized endpoint
 *   6. staff are personalized too; nobody can obtain the raw original
 *   7. revocation, expiry, forgery and hidden-material refusals
 *   8. a missing/failed copy fails closed (never the original)
 *   9. /storage/signed-url and /storage/signed refuse lesson PDFs
 *  10. non-PDF attachments keep their signed-URL flow
 *  11. cache isolation, source replacement (same-size edit included)
 *  12. concurrent first-time requests render once, leave no partial files
 *  13. per-account rate limiting on the mint endpoint
 *  14. cleanup: orphan files, missing rows, stale variants, grace period
 *  15. unsupported modern PDFs (xref streams) are refused with a clear code
 *
 * Never touches production data, credentials or the network.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
$WORK = (string) (getenv('PDFTEST_WORKDIR') ?: $root . '/.freebuff/pdf-watermark-tests');
$FIX = $WORK . '/fixtures';
$OUT = $WORK . '/out/delivery';

// ── Environment (must be set BEFORE bootstrap caches Config) ────────────────
// StorageService resolves STORAGE_PRIVATE_DIR against MEDACADEMY_BASE (backend/),
// so the test storage root must be expressed RELATIVE to it. realpath() is used
// on both sides because the shell may hand us "D:/v3/..." while PHP reports
// "D:\\v3\\..." — comparing the raw strings silently yields the wrong path.
$workReal = str_replace('\\', '/', (string) (realpath($WORK) ?: $WORK));
$repoReal = str_replace('\\', '/', (string) (realpath($root) ?: $root));
if (!str_starts_with($workReal, $repoReal . '/')) {
    fwrite(STDERR, "delivery_tests: the test workspace must live inside the repository "
        . "(work={$workReal}, repo={$repoReal})\n");
    exit(2);
}
// backend/ sits directly under the repository root, so "../<repo-relative>" is
// exactly the path MEDACADEMY_BASE needs.
$relPrivate = '../' . ltrim(substr($workReal, strlen($repoReal)), '/') . '/out/delivery/storage/private';

$baseEnv = [
    'MATERIAL_PDF_TOKEN_SECRET' => 'delivery-test-secret-0123456789',
    'STORAGE_SIGNED_URL_SECRET' => 'delivery-test-storage-secret',
    'STORAGE_PRIVATE_DIR' => $relPrivate,
    'STORAGE_PUBLIC_DIR' => $relPrivate . '-public',
    'APP_URL' => 'http://127.0.0.1:8080',
    'APP_ENV' => 'testing',
    'MATERIAL_PDF_MINT_PER_MINUTE' => '60',
    'MATERIAL_PDF_URL_TTL_SECONDS' => '300',
    'PDF_WATERMARK_CLEANUP_GRACE_SECONDS' => '0',
];
foreach ($baseEnv as $k => $v) {
    putenv($k . '=' . $v);
    $_ENV[$k] = $v;
}

// Per-scenario overrides travel on the COMMAND LINE (--set=K=V / --unset=K)
// rather than through proc_open's env array: the array form is not reliably
// applied on every platform, which would silently run whole scenarios with the
// wrong configuration.
foreach ($argv ?? [] as $arg) {
    if (str_starts_with((string) $arg, '--set=') && str_contains((string) $arg, '=')) {
        [$k, $v] = explode('=', substr((string) $arg, 6), 2);
        putenv($k . '=' . $v);
        $_ENV[$k] = $v;
    } elseif (str_starts_with((string) $arg, '--unset=')) {
        $k = substr((string) $arg, 8);
        putenv($k);
        unset($_ENV[$k]);
    }
}

require $root . '/backend/src/bootstrap.php';

use MedAcademy\Controllers\MaterialDeliveryController;
use MedAcademy\Controllers\StorageController;
use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\MaterialPdfQueueService;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;

\MedAcademy\Utils\Config::init();

$DB_FILE = $OUT . '/db.sqlite';
$STORE = $OUT . '/storage/private';
$MODE_LABEL = (string) (getenv('PDF_WATERMARK_MODE') ?: 'raster (product default)');
$PERSONAL = $STORE . '/' . PdfWatermarkService::BUCKET;

// ── Test-only PDO: SQLite with the two MySQL-isms translated ────────────────
final class DeliveryTestPdo extends PDO
{
    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        // MySQL time functions (with or without precision) -> CURRENT_TIMESTAMP.
        $query = (string) preg_replace(
            '/\b(?:UTC_TIMESTAMP|CURRENT_TIMESTAMP|NOW)\s*\(\s*\d*\s*\)/i',
            'CURRENT_TIMESTAMP',
            $query
        );
        if (stripos($query, 'ON DUPLICATE KEY UPDATE') !== false) {
            if (str_contains($query, 'lesson_material_pdfs')) {
                $target = 'material_id, student_id, variant_key';
            } elseif (str_contains($query, 'rate_limits')) {
                $target = 'identifier, operation, window_start';
            } else {
                $target = null;
            }
            if ($target !== null) {
                $query = (string) preg_replace(
                    '/ON\s+DUPLICATE\s+KEY\s+UPDATE/s',
                    'ON CONFLICT(' . $target . ') DO UPDATE SET',
                    $query
                );
                // `VALUES(col)` (MySQL) == `excluded.col` (SQLite)
                $query = (string) preg_replace('/VALUES\(\s*([A-Za-z_]+)\s*\)/', 'excluded.$1', $query);
            }
        }
        try {
            return parent::prepare($query, $options);
        } catch (\PDOException $e) {
            // Surface the translated statement: a syntax error here means the
            // shim (not the shipped SQL) is wrong, and the SQL makes that obvious.
            throw new \PDOException($e->getMessage() . ' | SQL: ' . preg_replace('/\s+/', ' ', $query), 0, $e);
        }
    }
}

function connectDb(): DeliveryTestPdo
{
    global $DB_FILE;
    $pdo = new DeliveryTestPdo('sqlite:' . $DB_FILE);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 20000');
    $pdo->exec('PRAGMA foreign_keys = OFF');
    return $pdo;
}

function bindDatabase(PDO $pdo): void
{
    $db = (new ReflectionClass(Database::class))->newInstanceWithoutConstructor();
    (new ReflectionProperty(Database::class, 'pdo'))->setValue($db, $pdo);
    (new ReflectionProperty(Database::class, 'instance'))->setValue(null, $db);
}

// ── Helpers shared by parent and children ──────────────────────────────────

/** Build a Request with an injected body (Request::capture() only reads php://input). */
function makeRequest(string $method, string $uri, array $query, array $body): Request
{
    $_SERVER['REQUEST_METHOD'] = $method;
    $_SERVER['REQUEST_URI'] = $uri;
    $_SERVER['CONTENT_TYPE'] = 'application/json';
    $_SERVER['REMOTE_ADDR'] = '127.0.0.1';
    $_GET = $query;
    $request = Request::capture();
    (new ReflectionProperty(Request::class, 'body'))->setValue($request, $body);
    return $request;
}

/** Decode TCPDF's UTF-16BE text literals out of a page content stream. */
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
 * Per-page text of every page's OWN content stream (the imported lecture page is
 * a Form XObject, so this reads the watermark layer exactly where it is drawn).
 *
 * @return array<int,string>
 */
function pdfPages(string $file): array
{
    // Inspect a COPY, never the live file: FPDI keeps the source stream open for
    // the lifetime of the reader object, and on Windows an open handle keeps the
    // name reserved even after the delivery code deletes/renames over it (making
    // the regeneration under test fail for reasons the product does not have).
    $tmp = tempnam(sys_get_temp_dir(), 'wmprobe');
    if ($tmp === false || !@copy($file, $tmp)) {
        return [];
    }
    $pages = [];
    try {
        $stream = \setasign\Fpdi\PdfParser\StreamReader::createByFile($tmp);
        $parser = new \setasign\Fpdi\PdfParser\PdfParser($stream);
        $reader = new \setasign\Fpdi\PdfReader\PdfReader($parser);
        for ($n = 1; $n <= $reader->getPageCount(); $n++) {
            $pages[] = decodePdfText($reader->getPage($n)->getContentStream());
        }
    } catch (\Throwable $e) {
        $pages = [];
    } finally {
        unset($reader, $parser, $stream);
        gc_collect_cycles();
        @unlink($tmp);
    }
    return $pages;
}

function pdfPageCount(string $file): int
{
    return (int) preg_match_all('#/Type\s*/Page[^s]#', (string) file_get_contents($file));
}

// ── Flattened-engine (raster) proof helpers ────────────────────────────────
//
// The raster engine writes NO text layer, so the per-page substring checks that
// prove "this page carries student X" cannot run against it. Identity is proved
// instead from the pixels that ARE in the file: every page is ONE embedded
// full-page image, and the pipeline is deterministic (same source + same
// identity + same settings => byte-identical image payloads). Regenerating a
// REFERENCE copy in-process from a known identity and comparing the image
// streams therefore binds a delivered copy to exactly one identity — verified
// empirically in .freebuff/pdf-watermark-tests/probe_identity.php, and asserted
// here by the negative checks (A must not match B's reference).

/**
 * sha256 of every embedded image XObject payload, in file order.
 * One entry per page in a flattened copy.
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
        // The dictionary of THIS stream is the text between the last
        // /Subtype /Image and the keyword. An `endstream` in between means the
        // keyword belongs to a later object (a page content stream), not an
        // image — skip it instead of reading a bogus /Length.
        $head = substr($raw, max(0, $sp - 4000), min(4000, $sp));
        $sub = strrpos($head, '/Subtype /Image');
        if ($sub === false) {
            continue;
        }
        $end = strrpos($head, 'endstream');
        if ($end !== false && $end > $sub) {
            continue;
        }
        $dict = substr($head, $sub);
        if (!preg_match_all('#/Length\s+(\d+)\b#', $dict, $lm) || $lm[1] === []) {
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
 * Generate (once per source+identity) a reference copy with the SAME engine and
 * settings, so its image streams can be compared with a delivered copy.
 *
 * @param array{0:string,1:string} $lines
 */
function rasterRef(PdfWatermarkService $wm, string $src, array $lines, string $tag): string
{
    global $OUT;
    static $cache = [];
    $key = $tag . '|' . hash('sha256', $src . '|' . implode('|', $lines));
    if (isset($cache[$key])) {
        return $cache[$key];
    }
    $safe = preg_replace('/[^a-z0-9]+/', '-', strtolower($tag)) ?: 'ref';
    $ref = $OUT . '/raster-ref-' . $safe . '-' . substr(hash('sha256', $key), 0, 10) . '.pdf';
    @unlink($ref);
    $wm->personalize($src, $lines, $ref);
    $cache[$key] = $ref;
    return $ref;
}

/**
 * Does this delivered copy carry EXACTLY the pixels of that identity?
 *
 * @return array{match:bool,pages:int,ref_pages:int}
 */
function rasterIdentityMatches(string $delivered, string $ref): array
{
    $a = imageStreams($delivered);
    $b = imageStreams($ref);
    return [
        'match' => $a !== [] && $a === $b,
        'pages' => count($a),
        'ref_pages' => count($b),
    ];
}

function rrmdir(string $dir): void
{
    if (!is_dir($dir)) {
        return;
    }
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($it as $f) {
        $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
    }
    @rmdir($dir);
}

/** Files under a directory (recursive), path => size. */
function filesUnder(string $dir): array
{
    if (!is_dir($dir)) {
        return [];
    }
    $out = [];
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY
    );
    $prefix = strlen($dir) + 1;
    foreach ($it as $f) {
        // A file may be renamed/unlinked while we walk (the delivery code does
        // exactly that under concurrency), so a stat failure just means "gone".
        $size = @filesize($f->getPathname());
        if ($size === false) {
            continue;
        }
        $out[str_replace('\\', '/', substr($f->getPathname(), $prefix))] = (int) $size;
    }
    ksort($out);
    return $out;
}

// ═══════════════════════════════════════════════════════════════════════════
// CHILD MODE — one scenario, one process
// ═══════════════════════════════════════════════════════════════════════════
if (isset($argv[1])) {
    bindDatabase(connectDb());
    $mode = (string) $argv[1];
    // The streaming endpoints finish with exit(); the status they set survives
    // to shutdown, which is how the parent observes the HTTP status. (Head-
    // alone `header()` output does not exist on the CLI SAPI.)
    register_shutdown_function(static function (): void {
        fwrite(STDERR, "\nSTATUS=" . (int) http_response_code() . "\n");
    });

    try {
        switch ($mode) {
            case 'mint':
                [$mid, $uid, $role] = [$argv[2], $argv[3], $argv[4]];
                $intent = (string) ($argv[5] ?? 'view');
                $spoof = (bool) ($argv[6] ?? false);
                $body = ['material_id' => $mid, 'intent' => $intent];
                if ($spoof) {
                    // A hostile client trying to choose its own watermark text.
                    $body += [
                        'full_name' => 'Mallory Attacker',
                        'name' => 'Mallory Attacker',
                        'public_user_id' => 'MED-9999',
                        'student_id' => 's2',
                        'user_id' => 's2',
                    ];
                }
                $req = makeRequest('POST', '/materials/pdf-url', [], $body);
                $req->user = ['id' => $uid, 'role' => $role];
                echo json_encode((new MaterialDeliveryController())->pdfUrl($req));
                break;

            case 'worker':
                // One pass of the cron worker, in-process. The student path never
                // renders inline (it queues), so this is how the suite produces
                // the copy a student would wait for in production. It claims,
                // re-derives the variant from the LIVE source and publishes
                // through the SAME service the CLI worker uses.
                //
                // `isStudentEligible()` is deliberately NOT called here: it reads
                // profiles.status, which this SQLite harness does not model. Live
                // eligibility is covered by backend/tests/material-queue and by
                // the controller's own authorization checks above.
                $queue = new MaterialPdfQueueService();
                $variants = $queue->variants();
                $jobs = $queue->claim(20, 'test-worker-' . getmypid());
                $out = ['claimed' => count($jobs), 'ready' => 0, 'skipped' => 0, 'failed' => 0];
                foreach ($jobs as $job) {
                    $mid = (string) $job['material_id'];
                    $sid = (string) $job['student_id'];
                    $material = $queue->loadMaterial($mid);
                    if ($material === null || !$queue->isPdf($material)) {
                        $queue->markSkipped((string) $job['id'], (string) $job['lock_token'], 'material_missing');
                        $out['skipped']++;
                        continue;
                    }
                    try {
                        $identity = $variants->identity($material, $sid);
                        if ($identity['variant_key'] !== (string) $job['variant_key']) {
                            $queue->markSkipped((string) $job['id'], (string) $job['lock_token'], 'stale_variant');
                            $queue->enqueueStudent($material, $sid, MaterialPdfQueueService::PRIORITY_PREWARM, true);
                            $out['skipped']++;
                            continue;
                        }
                        $variants->ensure($material, $sid);
                        $queue->markReady((string) $job['id'], (string) $job['lock_token']);
                        $out['ready']++;
                    } catch (\Throwable) {
                        $queue->markFailed((string) $job['id'], (string) $job['lock_token'], 'render_failed');
                        $out['failed']++;
                    }
                }
                echo json_encode($out);
                break;

            case 'stream':
                $token = (string) ($argv[2] ?? '');
                $req = makeRequest('GET', '/materials/pdf', ['token' => $token], []);
                // Never returns: Response::file()/error() end the process.
                (new MaterialDeliveryController())->streamPdf($req);
                break;

            case 'sign':
                [$mid, $sid, $intent] = [$argv[2], $argv[3], (string) ($argv[4] ?? 'view')];
                $offset = (int) ($argv[5] ?? 300);
                $ctrl = new MaterialDeliveryController();
                $sign = new ReflectionMethod(MaterialDeliveryController::class, 'signToken');
                $sign->setAccessible(true);
                echo $sign->invoke($ctrl, $mid, $sid, $intent, time() + $offset);
                break;

            case 'forge':
                // Sign for $argv[3] then swap the student id, keeping the MAC.
                $ctrl = new MaterialDeliveryController();
                $sign = new ReflectionMethod(MaterialDeliveryController::class, 'signToken');
                $sign->setAccessible(true);
                $tok = $sign->invoke($ctrl, $argv[2], $argv[3], 'view', time() + 300);
                $body = base64_decode(strtr($tok, '-_', '+/') . str_repeat('=', (4 - strlen($tok) % 4) % 4), true);
                $parts = explode('|', (string) $body);
                $parts[1] = $argv[4]; // victim student id
                echo rtrim(strtr(base64_encode(implode('|', $parts)), '+/', '-_'), '=');
                break;

            case 'storage-sign':
                [$bucket, $path, $uid, $role] = [$argv[2], $argv[3], $argv[4], $argv[5]];
                $download = (bool) ($argv[6] ?? false);
                $req = makeRequest('POST', '/storage/signed-url', [], [
                    'bucket' => $bucket, 'path' => $path, 'download' => $download,
                ]);
                $req->user = ['id' => $uid, 'role' => $role];
                try {
                    echo json_encode((new StorageController())->signedUrl($req));
                } catch (ApiException $e) {
                    echo json_encode(['error' => [
                        'status' => $e->status,
                        'code' => $e->errors[0] ?? null,
                        'message' => $e->getMessage(),
                    ]]);
                }
                break;

            case 'storage-redeem':
                [$bucket, $path] = [$argv[2], $argv[3]];
                $url = (new StorageService())->signedUrl($bucket, $path, 600);
                parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
                $req = makeRequest('GET', '/storage/signed', $q, []);
                (new StorageController())->signedFile($req); // streams or exits
                break;

            case 'cleanup':
                // Run the REAL cron script from this process (its exit() is the
                // child's exit, which the parent treats as the script's status).
                // The flag is read BEFORE $argv is replaced.
                $apply = ($argv[2] ?? '') === '--apply';
                $GLOBALS['argv'] = array_merge(['watermark-cleanup.php'], $apply ? ['--apply'] : []);
                $GLOBALS['argc'] = count($GLOBALS['argv']);
                require $root . '/backend/scripts/watermark-cleanup.php';
                break;

            case 'status':
                echo json_encode((new MaterialDeliveryController())->watermarkStatus(
                    makeRequest('GET', '/admin/material-watermark-status', [], [])
                ));
                break;

            default:
                fwrite(STDERR, "unknown mode: {$mode}\n");
                exit(64);
        }
    } catch (ApiException $e) {
        http_response_code($e->status); // mirror what the error handler would send
        echo json_encode(['error' => [
            'status' => $e->status,
            'code' => $e->errors[0] ?? null,
            'message' => $e->getMessage(),
        ]]);
    } catch (Throwable $e) {
        http_response_code(500);
        echo json_encode(['error' => [
            'status' => 500,
            'code' => 'uncaught',
            'message' => get_class($e) . ': ' . $e->getMessage(),
        ]]);
    }
    exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// PARENT MODE — seed, orchestrate, assert
// ═══════════════════════════════════════════════════════════════════════════

@mkdir($OUT, 0775, true);
foreach ([$DB_FILE, $DB_FILE . '-wal', $DB_FILE . '-shm'] as $f) {
    @unlink($f);
}
rrmdir($OUT . '/storage');
@mkdir($STORE . '/lesson-materials', 0775, true);

$pdo = connectDb();
bindDatabase($pdo);

$checks = [];
$fail = [];

function check(string $name, bool $ok, mixed $detail = ''): void
{
    global $checks, $fail;
    $detail = is_scalar($detail) ? (string) $detail : (string) json_encode($detail);
    // Details sometimes quote RAW response bodies (a streamed PDF or a child's
    // stderr). Those bytes are not UTF-8, and one bad byte would make the final
    // json_encode() return false and lose the whole result file.
    $detail = mb_scrub($detail, 'UTF-8');
    $checks[] = ['check' => $name, 'ok' => $ok, 'detail' => $detail];
    if (!$ok) {
        $fail[] = $name . ($detail !== '' ? " ({$detail})" : '');
    }
}

function skipCheck(string $name, string $why): void
{
    global $checks;
    $checks[] = ['check' => $name, 'ok' => true, 'detail' => 'SKIPPED — ' . $why];
}

/** Spawn a child scenario; returns [exitCode, stdout, stderr]. */
function runChild(array $args, array $envOverrides = []): array
{
    [$proc, $pipes] = spawnChild($args, $envOverrides);
    return finishChild($proc, $pipes);
}

function spawnChild(array $args, array $envOverrides = []): array
{
    global $root;
    $cmd = array_merge(
        [PHP_BINARY, '-d', 'auto_prepend_file=' . __DIR__ . '/prepend.php', __FILE__],
        $args
    );
    foreach ($envOverrides as $k => $v) {
        $cmd[] = $v === null ? '--unset=' . $k : '--set=' . $k . '=' . $v;
    }
    $desc = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $proc = proc_open($cmd, $desc, $pipes, $root);
    if (!is_resource($proc)) {
        throw new RuntimeException('could not start child: ' . implode(' ', $args));
    }
    fclose($pipes[0]);
    return [$proc, $pipes];
}

function finishChild($proc, array $pipes): array
{
    $out = (string) stream_get_contents($pipes[1]);
    $err = (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    return [proc_close($proc), $out, $err];
}

/** Decode a child's JSON answer, or report the raw body. */
/**
 * Mint, and if the answer is "preparing" (the async student contract) run one
 * worker pass and ask again. Returns the final child result, so every existing
 * assertion still inspects a `ready` answer.
 *
 * This is exactly the production sequence: request → queued → cron renders →
 * the client's next poll/delivery request succeeds.
 */
function mintReady(array $args, array $envOverrides = []): array
{
    $child = runChild($args, $envOverrides);
    $answer = jsonOf($child[1]);
    $status = (string) ($answer['status'] ?? '');
    if ($answer === [] || !in_array($status, ['preparing', 'queued', 'processing'], true)) {
        return $child;
    }
    runChild(['worker'], $envOverrides);
    return runChild($args, $envOverrides);
}

function jsonOf(string $out): array
{
    $data = json_decode($out, true);
    return is_array($data) ? $data : ['_raw' => substr($out, 0, 400)];
}

function errStatus(array $answer): int
{
    return (int) ($answer['error']['status'] ?? 0);
}

/** HTTP status a child answered with (set by Response::json/file before exit). */
function childStatus(array $child): int
{
    return preg_match('/STATUS=(\d+)/', $child[2], $m) ? (int) $m[1] : 0;
}

function registry(string $materialId, string $studentId): array
{
    global $pdo;
    $stmt = $pdo->prepare(
        'SELECT * FROM lesson_material_pdfs WHERE material_id = ? AND student_id = ? ORDER BY updated_at DESC'
    );
    $stmt->execute([$materialId, $studentId]);
    return $stmt->fetchAll();
}

function auditRows(string $action): array
{
    global $pdo;
    $stmt = $pdo->prepare('SELECT * FROM audit_logs WHERE action = ?');
    $stmt->execute([$action]);
    return $stmt->fetchAll();
}

// ── Schema (the columns the shipped code reads and writes) ──────────────────
$pdo->exec('CREATE TABLE courses (id TEXT PRIMARY KEY, status TEXT)');
$pdo->exec('CREATE TABLE lessons (id TEXT PRIMARY KEY, is_preview INTEGER, status TEXT)');
$pdo->exec('CREATE TABLE enrollments (student_id TEXT, course_id TEXT, status TEXT)');
$pdo->exec('CREATE TABLE profiles (
    id TEXT PRIMARY KEY, role TEXT, full_name TEXT, public_user_id TEXT, email TEXT)');
$pdo->exec('CREATE TABLE lesson_materials (
    id TEXT PRIMARY KEY, lesson_id TEXT, course_id TEXT, file_name TEXT, file_type TEXT,
    storage_path TEXT, permission TEXT, download_enabled INTEGER, preview_enabled INTEGER,
    watermark_enabled INTEGER, file_hash TEXT, file_hash_path TEXT, file_hash_size INTEGER,
    file_hash_mtime INTEGER)');
$pdo->exec('CREATE TABLE lesson_material_pdfs (
    id TEXT PRIMARY KEY, material_id TEXT NOT NULL, student_id TEXT NOT NULL,
    source_hash TEXT NOT NULL, variant_key TEXT NOT NULL, storage_path TEXT NOT NULL,
    file_size INTEGER DEFAULT 0, page_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (material_id, student_id, variant_key))');
$pdo->exec('CREATE TABLE lesson_material_pdf_jobs (
    id TEXT PRIMARY KEY, material_id TEXT NOT NULL, student_id TEXT NOT NULL,
    source_hash TEXT NOT NULL, variant_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT \'queued\', priority INTEGER NOT NULL DEFAULT 10,
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 4,
    lock_token TEXT, locked_at TEXT, locked_by TEXT, run_after TEXT NOT NULL,
    last_error TEXT, ready_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (material_id, student_id, variant_key))');
$pdo->exec('CREATE TABLE rate_limits (
    id TEXT PRIMARY KEY, identifier TEXT NOT NULL, operation TEXT NOT NULL,
    window_start TEXT NOT NULL, request_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (identifier, operation, window_start))');
$pdo->exec('CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY, user_id TEXT, actor_id TEXT, action TEXT, details TEXT,
    ip_address TEXT, created_at TEXT, target_name TEXT, description TEXT,
    log_status TEXT, actor_name TEXT, actor_email TEXT, actor_role TEXT)');

// ── Seed ───────────────────────────────────────────────────────────────────
$pdo->exec("INSERT INTO courses (id,status) VALUES ('c1','published'),('c2','draft')");
$pdo->exec("INSERT INTO lessons (id,is_preview,status) VALUES
  ('l1',0,'published'),('l2',1,'published'),('l3',0,'draft')");
$pdo->exec("INSERT INTO enrollments (student_id,course_id,status) VALUES
  ('s1','c1','active'),('s2','c1','active'),('s3','c1','suspended')");
$pdo->exec("INSERT INTO profiles (id,role,full_name,public_user_id,email) VALUES
  ('s1','student','Alpha One','MED-0042','a1@example.test'),
  ('s2','student','Beta Two','MED-0099','b2@example.test'),
  ('s3','student','Gamma Three','MED-0077','g3@example.test'),
  ('s4','student','Delta Four','MED-0055','d4@example.test'),
  ('d1','doctor','Dr Instructor','MED-0001','doc@example.test'),
  ('a1','admin','Admin Person','MED-0002','admin@example.test')");
$pdo->exec("INSERT INTO lesson_materials
  (id,lesson_id,course_id,file_name,file_type,storage_path,permission,download_enabled,preview_enabled,watermark_enabled)
  VALUES
  ('m1','l1','c1','lecture.pdf','application/pdf','lecture.pdf','allow',1,1,0),
  ('m2','l1','c1','notes.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document','notes.docx','allow',1,1,0),
  ('m3','l1','c1','secret.pdf','application/pdf','secret.pdf','hidden',1,1,1),
  ('m4','l1','c1','preview.pdf','application/pdf','preview.pdf','preview_only',1,1,1),
  ('m5','l1','c1','concurrent.pdf','application/pdf','concurrent.pdf','allow',1,1,1),
  ('m6','l1','c1','replace.pdf','application/pdf','replace.pdf','allow',1,1,1),
  ('m7','l1','c1','broken.pdf','application/pdf','broken.pdf','allow',1,1,1),
  ('m8','l1','c1','modern.pdf','application/pdf','modern.pdf','allow',1,1,1),
  ('m9','l2','c1','free.pdf','application/pdf','free.pdf','allow',1,1,0)");

$materials = $STORE . '/lesson-materials';
$pdf = (string) file_get_contents($FIX . '/source.pdf');
foreach (['lecture.pdf', 'secret.pdf', 'preview.pdf', 'concurrent.pdf', 'replace.pdf', 'free.pdf'] as $name) {
    file_put_contents($materials . '/' . $name, $pdf);
}
file_put_contents($materials . '/notes.docx', "PK\x03\x04 not really a docx, but definitely not a PDF\n");
file_put_contents($materials . '/broken.pdf', "This is a text file with a .pdf name.\n");

$modernSource = $FIX . '/source-xrefstream.pdf';
$haveModern = is_file($modernSource);
if ($haveModern) {
    copy($modernSource, $materials . '/modern.pdf');
}

$srcHash = hash_file('sha256', $materials . '/lecture.pdf');
$srcPages = pdfPageCount($materials . '/lecture.pdf');

$storage = new StorageService();
$personalDir = $storage->privateFilePath(PdfWatermarkService::BUCKET, '');

// ── Engine sanity ──────────────────────────────────────────────────────────
$wm = new PdfWatermarkService();
$isRaster = $wm->effectiveMode() === PdfWatermarkService::MODE_RASTER;
$isFlatten = false;
check('engine: raster-only delivery engine is available', $isRaster && $wm->isAvailable(), (string) $wm->driver());
$r = runChild(['status'], ['PDF_WATERMARK_MODE' => null]);
$stDefault = jsonOf($r[1]);
check('engine: an absent mode resolves to raster-only delivery', ($stDefault['configured_mode'] ?? '') === 'raster', (string) ($stDefault['configured_mode'] ?? ''));
check('engine: auto resolves to raster, never vector or flatten', ($stDefault['effective_mode'] ?? null) === 'raster', (string) ($stDefault['effective_mode'] ?? ''));
$vectorStatus = jsonOf(runChild(['status'], ['PDF_WATERMARK_MODE' => 'vector'])[1]);
$flattenStatus = jsonOf(runChild(['status'], ['PDF_WATERMARK_MODE' => 'flatten'])[1]);
check('engine: legacy vector mode fails closed', array_key_exists('effective_mode', $vectorStatus) && $vectorStatus['effective_mode'] === null, json_encode($vectorStatus));
check('engine: legacy flatten mode fails closed', array_key_exists('effective_mode', $flattenStatus) && $flattenStatus['effective_mode'] === null, json_encode($flattenStatus));

// ═══ 1. Student requests generate missing PDFs directly and reuse cache ═══
$r = runChild(['mint', 'm1', 's1', 'student', 'view']);
$a1 = jsonOf($r[1]);
check('direct: first student request immediately returns a personalized URL',
    $r[0] === 0 && isset($a1['url']) && ($a1['status'] ?? '') === 'ready',
    substr($r[1], 0, 240) . substr($r[2], 0, 240));
check('direct: the first request generated and registered its copy',
    count(registry('m1', 's1')) === 1);
$firstPath = (string) (registry('m1', 's1')[0]['storage_path'] ?? '');
$firstMtime = (string) (registry('m1', 's1')[0]['created_at'] ?? '');

// Reopening the material reuses the completed copy; no queue entry or rerender.
$r = runChild(['mint', 'm1', 's1', 'student', 'view']);
$cached = jsonOf($r[1]);
check('cache: an unexpired copy returns ready on the next request',
    $r[0] === 0 && isset($cached['url']) && ($cached['status'] ?? '') === 'ready');
check('cache: reuse does not create another row or change generation time',
    count(registry('m1', 's1')) === 1
    && (string) (registry('m1', 's1')[0]['created_at'] ?? '') === $firstMtime);
check('queue: direct student requests do not enqueue cron-dependent work',
    (int) $pdo->query("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id='m1' AND student_id='s1'")->fetchColumn() === 0);

// ═══ 1b. The generated copy is personalized and token-gated ══════════════
check('mint: response says the copy is watermarked', ($a1['watermarked'] ?? false) === true);
check(
    'mint: legacy watermark_enabled=0 on the material does NOT disable it',
    (int) $pdo->query("SELECT watermark_enabled FROM lesson_materials WHERE id='m1'")->fetchColumn() === 0
    && ($a1['watermarked'] ?? false) === true
);
$token1 = (string) ($a1['token'] ?? '');
if ($token1 === '' && isset($a1['url'])) {
    parse_str((string) parse_url((string) $a1['url'], PHP_URL_QUERY), $q);
    $token1 = (string) ($q['token'] ?? '');
}
check('mint: returns a token-gated delivery URL (not a storage path)', str_contains((string) ($a1['url'] ?? ''), '/materials/pdf?token='));

$r = runChild(['mint', 'm1', 's2', 'student', 'download']);
$a2 = jsonOf($r[1]);
check('isolation: a second student generates their own copy immediately',
    isset($a2['url']) && ($a2['status'] ?? '') === 'ready');
check('mint: student DOWNLOAD succeeds and is watermarked', ($a2['watermarked'] ?? false) === true && ($a2['intent'] ?? '') === 'download');
check('registry: each student has their OWN copy (no sharing)',
    count(registry('m1', 's1')) === 1 && count(registry('m1', 's2')) === 1);
$token2 = '';
if (isset($a2['url'])) {
    parse_str((string) parse_url((string) $a2['url'], PHP_URL_QUERY), $q);
    $token2 = (string) ($q['token'] ?? '');
}
check('mint: two students receive different tokens', $token1 !== '' && $token2 !== '' && $token1 !== $token2);
check('mint: two students receive different URLs', ($a2['url'] ?? '') !== ($a1['url'] ?? ''));

// ═══ 2/3/4. Identity, isolation, every page ════════════════════════════════
$rows1 = registry('m1', 's1');
$rows2 = registry('m1', 's2');
check('registry: exactly one copy per student/material', count($rows1) === 1 && count($rows2) === 1, count($rows1) . '/' . count($rows2));
check('registry: the copies are stored under DIFFERENT paths', ($rows1[0]['storage_path'] ?? '') !== ($rows2[0]['storage_path'] ?? ''));
$file1 = $personalDir . '/' . ($rows1[0]['storage_path'] ?? 'none');
$file2 = $personalDir . '/' . ($rows2[0]['storage_path'] ?? 'none');
check('registry: both files exist on disk', is_file($file1) && is_file($file2));
check('cache: the two copies are not byte-identical', is_file($file1) && is_file($file2) && md5_file($file1) !== md5_file($file2));
check('cache: each copy is bound to its own student folder', ($rows1[0]['storage_path'] ?? '') !== ($rows2[0]['storage_path'] ?? '')
    && str_contains((string) ($rows1[0]['storage_path'] ?? ''), '/s1/')
    && str_contains((string) ($rows2[0]['storage_path'] ?? ''), '/s2/'));

$idA = 'Alpha One • MED-0042';
$idB = 'Beta Two • MED-0099';
$pagesA = is_file($file1) ? pdfPages($file1) : [];
$pagesB = is_file($file2) ? pdfPages($file2) : [];
check('identity: the SAME page count as the source', count($pagesA) === $srcPages && count($pagesB) === $srcPages, count($pagesA) . '/' . count($pagesB) . " src={$srcPages}");
if ($isRaster) {
    // ── Flattened engine: identity is proved from the embedded page images ──
    $lecture = $materials . '/lecture.pdf';
    $refA = rasterRef($wm, $lecture, $wm->watermarkLines('Alpha One', 'MED-0042'), 'student-a');
    $refB = rasterRef($wm, $lecture, $wm->watermarkLines('Beta Two', 'MED-0099'), 'student-b');
    $rawA = is_file($file1) ? (string) file_get_contents($file1) : '';
    $rawB = is_file($file2) ? (string) file_get_contents($file2) : '';
    check('identity: student A copy has NO text layer (flattened)', $rawA !== '' && !preg_match('#/Type\s*/Font#', $rawA));
    check('identity: student B copy has NO text layer (flattened)', $rawB !== '' && !preg_match('#/Type\s*/Font#', $rawB));
    check('identity: student A copy carries ONE full-page image per page',
        count(imageStreams($file1)) === $srcPages, count(imageStreams($file1)) . " images / {$srcPages} pages");
    check('identity: student B copy carries ONE full-page image per page',
        count(imageStreams($file2)) === $srcPages, count(imageStreams($file2)) . " images / {$srcPages} pages");
    $matchA = rasterIdentityMatches($file1, $refA);
    $matchB = rasterIdentityMatches($file2, $refB);
    $crossAB = rasterIdentityMatches($file1, $refB);
    $crossBA = rasterIdentityMatches($file2, $refA);
    check('identity: EVERY page of student A is rendered with the AUTHENTICATED identity',
        $matchA['match'], json_encode($matchA));
    check('identity: EVERY page of student B is rendered with the AUTHENTICATED identity',
        $matchB['match'], json_encode($matchB));
    check('identity: student A copy does NOT contain student B identity', !$crossAB['match'], json_encode($crossAB));
    check('identity: student B copy does NOT contain student A identity', !$crossBA['match'], json_encode($crossBA));
    skipCheck(
        'identity: repeated more than once per page (grid + edge line)',
        'vector-only layering — the flattened engine draws exactly ONE centred mark per page (asserted by the ' .
        'centred-band pixel proof in run_real_test.php)'
    );
} else {
    $everyPageA = $pagesA !== [] && !in_array(false, array_map(static fn ($t) => str_contains($t, $idA), $pagesA), true);
    $everyPageB = $pagesB !== [] && !in_array(false, array_map(static fn ($t) => str_contains($t, $idB), $pagesB), true);
    check('identity: EVERY page of student A carries name + MED id', $everyPageA, json_encode(array_map(static fn ($t) => str_contains($t, $idA), $pagesA)));
    check('identity: EVERY page of student B carries name + MED id', $everyPageB, json_encode(array_map(static fn ($t) => str_contains($t, $idB), $pagesB)));
    check('identity: student A copy does NOT contain student B identity', !str_contains(implode('', $pagesA), 'MED-0099'));
    check('identity: student B copy does NOT contain student A identity', !str_contains(implode('', $pagesB), 'MED-0042'));
    if ($isFlatten) {
        skipCheck(
            'identity: repeated more than once per page (grid + edge line)',
            'MODE_FLATTEN draws exactly ONE centred mark per page by design ' .
            '(pinned by flatten_engine_tests.php: exactly one run per page stream)'
        );
    } else {
        check('identity: legacy text layer is absent (raster-only contract)', false, 'vector/flatten delivery must not be used');
    }
}
check('content: the personalized copy is NOT the original bytes', is_file($file1) && hash_file('sha256', $file1) !== $srcHash);
check('content: the source PDF was not modified in place', hash_file('sha256', $materials . '/lecture.pdf') === $srcHash);

// ═══ 4b. Server-side identity, never the request payload ═══════════════════
// Drop the cached copy so the next mint must GENERATE from the profile: this is
// the only way a forged payload could ever influence the rendering.
$staleCopy = $pdo->query("SELECT storage_path FROM lesson_material_pdfs WHERE material_id='m1' AND student_id='s1'")->fetchColumn();
if (is_string($staleCopy) && $staleCopy !== '') {
    @unlink($personalDir . '/' . $staleCopy);
    clearstatcache(true);
}
$pdo->exec("DELETE FROM lesson_material_pdfs WHERE material_id='m1' AND student_id='s1'");
$r = mintReady(['mint', 'm1', 's1', 'student', 'view', 'spoof']);
$spoofAnswer = jsonOf($r[1]);
check('spoof: a client-supplied name/id is ignored (mint still succeeds)', isset($spoofAnswer['url']), substr($r[1], 0, 240) . ' | stderr: ' . substr(preg_replace('/\s+/', ' ', $r[2]), 0, 2000));
$rowsSpoof = registry('m1', 's1');
$spoofPath = ($rowsSpoof[0]['storage_path'] ?? '') !== ''
    ? $personalDir . '/' . $rowsSpoof[0]['storage_path']
    : '';
if ($isRaster) {
    $refAuth = rasterRef($wm, $materials . '/lecture.pdf', $wm->watermarkLines('Alpha One', 'MED-0042'), 'student-a');
    $refForged = rasterRef($wm, $materials . '/lecture.pdf', $wm->watermarkLines('Mallory Attacker', 'MED-9999'), 'forged');
    $spoofAuth = rasterIdentityMatches($spoofPath, $refAuth);
    $spoofForged = rasterIdentityMatches($spoofPath, $refForged);
    check('spoof: watermark still shows the AUTHENTICATED name and id', $spoofAuth['match'], json_encode($spoofAuth));
    check('spoof: the forged identity never reaches the document', !$spoofForged['match'], json_encode($spoofForged));
} else {
    $spoofText = is_file($spoofPath) ? implode('', pdfPages($spoofPath)) : '';
    check('spoof: watermark still shows the AUTHENTICATED name and id', str_contains($spoofText, $idA));
    check('spoof: the forged identity never reaches the document', !str_contains($spoofText, 'Mallory') && !str_contains($spoofText, 'MED-9999'));
}
check('spoof: the copy was not written under the forged student id', !str_contains((string) ($rowsSpoof[0]['storage_path'] ?? ''), '/s2/'));

// ═══ 5/6. Streaming, preview vs download, staff (also personalized) ═══════
$r = runChild(['stream', $token1]);
check('stream: the student delivery returns PDF bytes', str_starts_with($r[1], '%PDF-'), substr($r[1], 0, 80) . ' / ' . substr($r[2], 0, 120));
check('stream: the delivered bytes are the personalized copy', is_file($file1) && md5($r[1]) === md5_file($file1));
$r = mintReady(['mint', 'm1', 's1', 'student', 'download']);
$d = jsonOf($r[1]);
$dlToken = '';
if (isset($d['url'])) {
    parse_str((string) parse_url((string) $d['url'], PHP_URL_QUERY), $q);
    $dlToken = (string) ($q['token'] ?? '');
}
$r = runChild(['stream', $dlToken]);
check('download: the downloaded bytes are the SAME personalized copy (watermark retained)', str_starts_with($r[1], '%PDF-') && is_file($file1) && md5($r[1]) === md5_file($file1));

$r = mintReady(['mint', 'm1', 'd1', 'doctor', 'view']);
$doc = jsonOf($r[1]);
check('staff: a doctor request IS watermarked (no unwatermarked original is served)', ($doc['watermarked'] ?? false) === true);
$docToken = '';
if (isset($doc['url'])) {
    parse_str((string) parse_url((string) $doc['url'], PHP_URL_QUERY), $q);
    $docToken = (string) ($q['token'] ?? '');
}
$r = runChild(['stream', $docToken]);
check('staff: the doctor receives a PERSONALIZED copy, not the original',
    str_starts_with($r[1], '%PDF-') && hash('sha256', $r[1]) !== $srcHash);
$docProbe = tempnam(sys_get_temp_dir(), 'wmstaff');
file_put_contents((string) $docProbe, $r[1]);
if ($isRaster) {
    $refDoc = rasterRef($wm, $materials . '/lecture.pdf', $wm->watermarkLines('Dr Instructor', 'MED-0001'), 'doctor');
    $docMatch = rasterIdentityMatches((string) $docProbe, $refDoc);
    $docAsStudent = rasterIdentityMatches(
        (string) $docProbe,
        rasterRef($wm, $materials . '/lecture.pdf', $wm->watermarkLines('Alpha One', 'MED-0042'), 'student-a')
    );
    check('staff: the doctor copy carries the DOCTOR identity', $docMatch['match'], json_encode($docMatch));
    check('staff: the doctor copy is NOT the student copy', !$docAsStudent['match'], json_encode($docAsStudent));
} else {
    $docText = implode('', pdfPages((string) $docProbe));
    check('staff: the doctor copy carries the DOCTOR identity',
        str_contains($docText, 'Dr Instructor') && str_contains($docText, 'MED-0001'), substr($docText, 0, 120));
}
@unlink((string) $docProbe);
check('staff: a student never receives the original', md5_file($file1) !== $srcHash);

$r = mintReady(['mint', 'm1', 'a1', 'admin', 'download']);
check('staff: an admin download is watermarked too', (jsonOf($r[1])['watermarked'] ?? false) === true);

// ═══ 7. Refusals: suspended, unenrolled, hidden, preview-only download ═════
$r = mintReady(['mint', 'm1', 's3', 'student', 'view']);
check('deny: a SUSPENDED enrollment cannot mint a link', errStatus(jsonOf($r[1])) === 403);
$r = mintReady(['mint', 'm1', 's4', 'student', 'view']);
check('deny: a NON-ENROLLED student cannot mint a link', errStatus(jsonOf($r[1])) === 403);
$r = mintReady(['mint', 'm3', 's1', 'student', 'view']);
check('deny: a HIDDEN material cannot be minted', errStatus(jsonOf($r[1])) === 403);
$r = mintReady(['mint', 'm4', 's1', 'student', 'download']);
check('deny: preview_only refuses a DOWNLOAD intent', errStatus(jsonOf($r[1])) === 403);
$r = mintReady(['mint', 'm4', 's1', 'student', 'view']);
check('allow: preview_only still allows a VIEW intent', isset(jsonOf($r[1])['url']));
$r = mintReady(['mint', 'm9', 's4', 'student', 'view']);
check('allow: a free-preview lesson is open to an unenrolled user', isset(jsonOf($r[1])['url']));

// Token lifecycle
$r = runChild(['stream', 'not-a-token']);
check('token: a malformed token is refused (403)', childStatus($r) === 403, 'status=' . childStatus($r));
$r = runChild(['sign', 'm1', 's1', 'view', '-30']);
$r = runChild(['stream', trim($r[1])]);
check('token: an EXPIRED token is refused (410)', childStatus($r) === 410, 'status=' . childStatus($r));
$r = runChild(['forge', 'm1', 's1', 's2']);
$r = runChild(['stream', trim($r[1])]);
check('token: a token with a swapped student id is refused (403)', childStatus($r) === 403, 'status=' . childStatus($r));
check('token: a refused token leaks no PDF bytes', !str_starts_with($r[1], '%PDF-'));

// Revocation at delivery time
$r = runChild(['sign', 'm1', 's1', 'view', '300']);
$liveToken = trim($r[1]);
$pdo->exec("UPDATE enrollments SET status='suspended' WHERE student_id='s1' AND course_id='c1'");
$r = runChild(['stream', $liveToken]);
check('revocation: suspension kills an already-issued link at stream time', childStatus($r) === 403 && !str_starts_with($r[1], '%PDF-'), 'status=' . childStatus($r));
$pdo->exec("UPDATE enrollments SET status='active' WHERE student_id='s1' AND course_id='c1'");
$r = runChild(['stream', $liveToken]);
check('revocation: access restored => the same link works again', str_starts_with($r[1], '%PDF-'));

$pdo->exec("UPDATE lesson_materials SET permission='hidden' WHERE id='m1'");
$r = runChild(['stream', $liveToken]);
check('revocation: setting the material to HIDDEN kills an already-issued link', childStatus($r) === 403, 'status=' . childStatus($r));
$pdo->exec("UPDATE lesson_materials SET permission='allow' WHERE id='m1'");

// ═══ 8. Fail closed: a vanished copy never falls back to the original ══════
$rows = registry('m1', 's2');
if ($rows !== []) {
    @unlink($personalDir . '/' . $rows[0]['storage_path']);
}
$r = runChild(['stream', $token2]);
check('fail-closed: a missing personalized copy returns 503, not the original', childStatus($r) === 503 && !str_starts_with($r[1], '%PDF-'), 'status=' . childStatus($r) . ' ' . substr($r[1], 0, 120));
check('fail-closed: the original was NOT delivered in that case', hash('sha256', $r[1]) !== $srcHash);
$r = mintReady(['mint', 'm1', 's2', 'student', 'view']);
check('fail-closed: the next mint regenerates the missing copy', isset(jsonOf($r[1])['url']), substr($r[1], 0, 240));

function filesForMaterial(string $materialId): array
{
    global $personalDir;
    return array_filter(
        array_keys(filesUnder($personalDir)),
        static fn (string $p): bool => str_contains($p, '/' . $materialId . '/')
    );
}

foreach ([['broken.pdf', 'a non-PDF source'], ['modern.pdf', 'a modern xref-stream source']] as [$name, $label]) {
    $mid = $name === 'broken.pdf' ? 'm7' : 'm8';
    if ($name === 'modern.pdf' && !$haveModern) {
        skipCheck('direct: ' . $label . ' is delivered by the raster engine', 'fixture source-xrefstream.pdf not generated');
        continue;
    }
    $before = filesForMaterial($mid);
    $r = runChild(['mint', $mid, 's1', 'student', 'view']);
    $answer = jsonOf($r[1]);

    if ($name === 'broken.pdf') {
        check('fail-closed: a non-PDF source is rejected during the direct request',
            errStatus($answer) === 422 && ($answer['error']['code'] ?? '') === 'source_not_pdf',
            substr($r[1], 0, 240));
        check('fail-closed: a rejected source never returns a URL or original bytes',
            !isset($answer['url']) && !str_starts_with($r[1], '%PDF-'));
        check('fail-closed: a rejected source does not enqueue background work',
            (int) $pdo->query("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id='m7' AND student_id='s1'")->fetchColumn() === 0);
        check('fail-closed: no personalized output is written for the invalid source',
            filesForMaterial($mid) === $before, json_encode(filesForMaterial($mid)));
        continue;
    }

    check('direct: ' . $label . ' returns a personalized URL without a worker',
        isset($answer['url']) && ($answer['status'] ?? '') === 'ready', substr($r[1], 0, 240));
    check('direct: ' . $label . ' does not enqueue background work',
        (int) $pdo->query("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id='m8' AND student_id='s1'")->fetchColumn() === 0);
    $rows = registry($mid, 's1');
    $after = filesForMaterial($mid);
    check('direct: a personalized copy was written for ' . $label,
        count($rows) === 1 && count($after) > count($before), 'rows=' . count($rows) . ', files=' . count($after));
    $output = $rows !== [] ? $personalDir . '/' . $rows[0]['storage_path'] : '';
    check('direct: the rasterized xref-stream copy has one image per page and no text layer',
        $output !== '' && is_file($output) && count(imageStreams($output)) === (count(pdfPages($output)) ?: -1)
        && !preg_match('#/Type\s*/Font#', (string) @file_get_contents($output)));
}

// ═══ 9/10. Storage routes cannot expose originals ═════════════════════════
$r = runChild(['storage-sign', 'lesson-materials', 'lecture.pdf', 's1', 'student', '0']);
$sa = jsonOf($r[1]);
check('storage: a student cannot sign a lesson PDF (403 material_delivery_required)',
    errStatus($sa) === 403 && ($sa['error']['code'] ?? '') === 'material_delivery_required', json_encode($sa));
$r = runChild(['storage-sign', 'lesson-materials', 'lecture.pdf', 's1', 'student', '1']);
check('storage: the DOWNLOAD flag does not bypass the refusal', errStatus(jsonOf($r[1])) === 403);
$r = runChild(['storage-sign', 'lesson-materials', 'lecture.pdf', 'd1', 'doctor', '1']);
check('storage: even staff cannot get a raw path to a lesson PDF', errStatus(jsonOf($r[1])) === 403);
$r = runChild(['storage-sign', PdfWatermarkService::BUCKET, 'anything.pdf', 's1', 'student', '0']);
check('storage: the personalized bucket is not a routable bucket at all', errStatus(jsonOf($r[1])) === 400, json_encode(jsonOf($r[1])));

$r = runChild(['storage-redeem', 'lesson-materials', 'lecture.pdf']);
check('storage: redeeming a VALID signature for a lesson PDF is refused (403)', childStatus($r) === 403 && !str_starts_with($r[1], '%PDF-'), 'status=' . childStatus($r) . ' ' . substr($r[1], 0, 120));

// The legacy `lesson_pdfs` bucket (superseded by lesson materials). Its objects
// can never be personalized — there is no material row to key a copy on — so a
// student is refused, while staff keep their links (the refusal is at SIGNING,
// not at streaming, so a doctor's existing bookmark does not break).
@mkdir($STORE . '/lesson-pdfs', 0775, true);
file_put_contents($STORE . '/lesson-pdfs/legacy-notes.pdf', "%PDF-1.4 legacy lecture note fixture\n");

$r = runChild(['storage-sign', 'lesson-pdfs', 'legacy-notes.pdf', 's1', 'student', '0']);
$lg = jsonOf($r[1]);
check('storage: a student cannot sign a legacy lesson_pdfs note (403 material_delivery_required)',
    errStatus($lg) === 403 && ($lg['error']['code'] ?? '') === 'material_delivery_required', json_encode($lg));
$r = runChild(['storage-sign', 'lesson-pdfs', 'legacy-notes.pdf', 's1', 'student', '1']);
check('storage: the DOWNLOAD flag does not bypass the legacy refusal', errStatus(jsonOf($r[1])) === 403);
$r = runChild(['storage-sign', 'lesson-pdfs', 'legacy-notes.pdf', 'd1', 'doctor', '1']);
check('storage: staff can still sign a legacy lesson_pdfs note', isset(jsonOf($r[1])['signed_url']), json_encode(jsonOf($r[1])));
$r = runChild(['storage-redeem', 'lesson-pdfs', 'legacy-notes.pdf']);
check('storage: a staff link for a legacy note still streams (only signing is refused)',
    str_contains($r[1], 'legacy lecture note fixture'), 'status=' . childStatus($r) . ' ' . substr($r[1], 0, 120));

$r = runChild(['storage-sign', 'lesson-materials', 'notes.docx', 's1', 'student', '1']);
$docx = jsonOf($r[1]);
check('non-PDF: a DOCX attachment still gets a signed URL', isset($docx['signed_url']), json_encode($docx));
$r = runChild(['storage-redeem', 'lesson-materials', 'notes.docx']);
check('non-PDF: the DOCX bytes are still delivered through the signed route', str_contains($r[1], 'not really a docx'));

// ═══ 11. Replacement + settings changes invalidate the cache ══════════════
$r = mintReady(['mint', 'm6', 's1', 'student', 'view']);
check('replace: first copy generated', isset(jsonOf($r[1])['url']));
$before = registry('m6', 's1');
$beforePath = $personalDir . '/' . ($before[0]['storage_path'] ?? 'none');
$beforeHash = is_file($beforePath) ? hash_file('sha256', $beforePath) : '';
$cached = $pdo->query("SELECT file_hash, file_hash_path, file_hash_size, file_hash_mtime FROM lesson_materials WHERE id='m6'")->fetch();
check('hash cache: the source digest is cached on the material row', is_array($cached) && ($cached['file_hash'] ?? '') === hash_file('sha256', $materials . '/replace.pdf'));
check('hash cache: the cached digest records path + size + mtime', is_array($cached)
    && (string) ($cached['file_hash_path'] ?? '') === 'replace.pdf'
    && (int) ($cached['file_hash_size'] ?? 0) === (int) filesize($materials . '/replace.pdf')
    && (int) ($cached['file_hash_mtime'] ?? 0) === (int) filemtime($materials . '/replace.pdf'));

// Same SIZE, different bytes, newer mtime: only an mtime-aware cache notices.
// (The fixture's content streams are Flate-compressed, so the edit is applied
// to the uncompressed /Producer string — a byte-for-byte valid replacement.)
$original = (string) file_get_contents($materials . '/replace.pdf');
$edited = str_replace('FPDF 1.9', 'FPDF 2.0', $original);
check('replace: the fixture offers a same-length edit target', $edited !== $original);
rename($materials . '/replace.pdf', $materials . '/replace-old.pdf');
file_put_contents($materials . '/replace.pdf', $edited);
touch($materials . '/replace.pdf', time() + 2);
clearstatcache(true, $materials . '/replace.pdf');
check('replace: the fixture edit keeps the byte size identical', filesize($materials . '/replace.pdf') === strlen($original));

$r = mintReady(['mint', 'm6', 's1', 'student', 'view']);
check('replace: mint succeeds after the source was replaced', isset(jsonOf($r[1])['url']));
$after = registry('m6', 's1');
check('replace: exactly ONE copy remains for that student', count($after) === 1, count($after));
check('replace: the variant key changed (new source identity)', ($after[0]['variant_key'] ?? '') !== ($before[0]['variant_key'] ?? ''));
$afterPath = $personalDir . '/' . ($after[0]['storage_path'] ?? 'none');
check('replace: a NEW file was produced', is_file($afterPath) && hash_file('sha256', $afterPath) !== $beforeHash);
check('replace: the stale copy was reclaimed', !is_file($beforePath));
if ($isRaster) {
    $refReplaced = rasterRef($wm, $materials . '/replace.pdf', $wm->watermarkLines('Alpha One', 'MED-0042'), 'replace-a');
    $replaced = rasterIdentityMatches($afterPath, $refReplaced);
    check('replace: the new copy is personalized for the same student', $replaced['match'], json_encode($replaced));
} else {
    $afterText = is_file($afterPath) ? implode('', pdfPages($afterPath)) : '';
    check('replace: the new copy is personalized for the same student', str_contains($afterText, $idA));
}
@unlink($materials . '/replace-old.pdf');

// Changing raster resolution invalidates the cached variant.
$beforeSettings = registry('m6', 's1');
$settingsOverride = ['PDF_WATERMARK_DPI' => '150'];
$r = mintReady(['mint', 'm6', 's1', 'student', 'view'], $settingsOverride);
check('settings: a changed watermark setting still delivers', isset(jsonOf($r[1])['url']));
$afterSettings = registry('m6', 's1');
check('settings: a changed setting produces a NEW variant key', ($afterSettings[0]['variant_key'] ?? '') !== ($beforeSettings[0]['variant_key'] ?? ''));
check('settings: still exactly one copy for the student', count($afterSettings) === 1);
check('settings: the old variant file was reclaimed', !is_file($personalDir . '/' . ($beforeSettings[0]['storage_path'] ?? 'none')));

// ═══ 12. Concurrency ══════════════════════════════════════════════════════
// Same-student first opens race under the per-variant lock; they may each
// return a ready URL, but only one render/registry/file may be published.
$procs = [];
for ($i = 0; $i < 3; $i++) {
    $procs[] = spawnChild(['mint', 'm5', 's1', 'student', 'view']);
}
$answers = [];
foreach ($procs as [$proc, $pipes]) {
    $answers[] = finishChild($proc, $pipes);
}
$readyCount = 0;
foreach ($answers as [$code, $out]) {
    $a = jsonOf($out);
    if ($code === 0 && isset($a['url']) && ($a['status'] ?? '') === 'ready') {
        $readyCount++;
    }
}
check('concurrency: each request receives a ready personalized URL',
    $readyCount === 3, "ready={$readyCount}");
check('concurrency: direct requests create no queue jobs',
    (int) $pdo->query("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id='m5' AND student_id='s1'")->fetchColumn() === 0);
$concRows = registry('m5', 's1');
check('concurrency: exactly ONE registry row for the variant', count($concRows) === 1, count($concRows));
$concFiles = filesUnder($personalDir);
$variantFiles = array_filter(array_keys($concFiles), static fn ($p) => str_contains($p, '/m5/'));
check('concurrency: exactly ONE personalized file exists', count($variantFiles) === 1, json_encode(array_values($variantFiles)));
$partials = array_filter(array_keys(filesUnder($personalDir)), static fn ($p) => str_ends_with($p, '.part'));
check('concurrency: no partially written .part file is left behind', $partials === [], json_encode(array_values($partials)));
$scratch = glob($personalDir . '/wm-*') ?: [];
check('concurrency: no temporary render directory is left behind', $scratch === [], json_encode(array_map('basename', $scratch)));

// ═══ 13. Rate limiting on the mint endpoint ═══════════════════════════════
$pdo->exec("DELETE FROM rate_limits");
$statuses = [];
for ($i = 0; $i < 3; $i++) {
    $r = mintReady(['mint', 'm1', 's4x', 'student', 'view'], ['MATERIAL_PDF_MINT_PER_MINUTE' => '2']);
    $statuses[] = errStatus(jsonOf($r[1])) ?: 200;
}
check('rate limit: the third mint in the window is refused with 429',
    $statuses === [403, 403, 429] || in_array(429, $statuses, true), json_encode($statuses));
$r = mintReady(['mint', 'm1', 's1', 'student', 'view'], ['MATERIAL_PDF_MINT_PER_MINUTE' => '0']);
check('rate limit: 0 disables the limiter (operator escape hatch)', isset(jsonOf($r[1])['url']));
$pdo->exec("DELETE FROM rate_limits");

// ═══ 14. Cleanup script ═══════════════════════════════════════════════════
@mkdir($personalDir . '/c1/m1/orphan', 0775, true);
$orphan = $personalDir . '/c1/m1/orphan/orphan.pdf';
file_put_contents($orphan, '%PDF-1.4 orphan');
touch($orphan, time() - 90000);
$missingRowPath = 'c1/m1/s9/ghost.pdf';
$pdo->prepare('INSERT INTO lesson_material_pdfs (id,material_id,student_id,source_hash,variant_key,storage_path,file_size,page_count)
    VALUES (?,?,?,?,?,?,?,?)')->execute(['row-missing', 'm1', 's9', 'x', 'y', $missingRowPath, 10, 1]);
$staleRow = $pdo->query("SELECT storage_path FROM lesson_material_pdfs WHERE material_id='m6' AND student_id='s1'")->fetchColumn();
$stalePath = (string) $staleRow;
$pdo->prepare("UPDATE lesson_material_pdfs SET source_hash='stale-hash' WHERE material_id='m6' AND student_id='s1'")->execute();
$currentRow = $pdo->query("SELECT storage_path FROM lesson_material_pdfs WHERE material_id='m5' AND student_id='s1'")->fetchColumn();
$currentPath = (string) $currentRow;
touch($personalDir . '/' . $currentPath, time() - 90000);
$partDir = $personalDir . '/c1/m1/junk';
@mkdir($partDir, 0775, true);
file_put_contents($partDir . '/keep.part', 'x');
touch($partDir . '/keep.part', time() - 90000);
// Age the stale variant too: the grace window is measured from mtime.
if ($stalePath !== '' && is_file($personalDir . '/' . $stalePath)) {
    touch($personalDir . '/' . $stalePath, time() - 90000);
}

$r = runChild(['cleanup'], ['PDF_WATERMARK_CLEANUP_GRACE_SECONDS' => '604800']);
check('cleanup: the grace window protects recently written files', is_file($orphan) && !str_contains($r[1], 'orphan.pdf'), substr($r[1], 0, 200));
$r = runChild(['cleanup'], ['PDF_WATERMARK_CLEANUP_GRACE_SECONDS' => '1']);
check('cleanup: the dry run reports work without deleting anything', is_file($orphan) && str_contains($r[1], 'DRY RUN'), substr($r[1], 0, 200));
$r = runChild(['cleanup', '--apply'], ['PDF_WATERMARK_CLEANUP_GRACE_SECONDS' => '1']);
// The child process deletes the file, but THIS process already stat()ed it
// (the grace-window and dry-run checks above), so PHP's stat cache would still
// answer "exists" and the assertion would fail on a clean delete.
clearstatcache(true, $orphan);
check('cleanup: --apply removes the orphaned file', !is_file($orphan), substr($r[1], -300));
check('cleanup: --apply removes a registry row whose file is gone',
    (int) $pdo->query("SELECT COUNT(*) FROM lesson_material_pdfs WHERE id='row-missing'")->fetchColumn() === 0);
check('cleanup: --apply removes a stale variant (replaced source)',
    (int) $pdo->query("SELECT COUNT(*) FROM lesson_material_pdfs WHERE material_id='m6' AND student_id='s1'")->fetchColumn() === 0,
    substr(preg_replace('/\s+/', ' ', $r[1]), 0, 500));
check('cleanup: a CURRENT copy is left untouched', is_file($personalDir . '/' . $currentPath));
check('cleanup: its registry row survives', (int) $pdo->query("SELECT COUNT(*) FROM lesson_material_pdfs WHERE storage_path='{$currentPath}'")->fetchColumn() === 1);
check('cleanup: a .part file is never touched', is_file($partDir . '/keep.part'));

// ═══ 15. Status surface ═══════════════════════════════════════════════════
$r = runChild(['status']);
$st = jsonOf($r[1]);
check('status: reports the engine, mode and settings', isset($st['effective_mode']) && isset($st['settings']['max_pages']), substr($r[1], 0, 200));
$flat = json_encode($st);
check('status: exposes no absolute filesystem paths', !str_contains($flat, (string) dirname($root)) && !str_contains($flat, 'storage/private'));

// ═══ Audit trail (ids + outcomes only) ════════════════════════════════════
$audit = auditRows('material_pdf_delivered');
check('audit: deliveries are recorded', $audit !== [], count($audit) . ' rows');
$auditText = json_encode($audit);
check('audit: the delivery DETAILS carry ids and outcomes, not the student name',
    !str_contains((string) ($audit[0]['details'] ?? ''), 'Alpha One')
    && !str_contains((string) ($audit[0]['details'] ?? ''), 'MED-0042'), substr((string) ($audit[0]['details'] ?? ''), 0, 160));
check('audit: no delivery token is written into the audit row', !str_contains($auditText, $token1));
$details = json_decode((string) ($audit[0]['details'] ?? ''), true);
check('audit: the row names the material, the intent and the outcome',
    is_array($details)
    && isset($details['material_id'], $details['watermarked'])
    && in_array($details['watermarked'], ['yes', 'no'], true),
    (string) ($audit[0]['details'] ?? ''));

// ── Result ────────────────────────────────────────────────────────────────
$json = json_encode([
    'checks' => $checks,
    'failures' => $fail,
    'ok' => $fail === [],
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
if ($json === false) {
    fwrite(STDERR, "FAIL: could not encode the result JSON: " . json_last_error_msg() . "\n");
    exit(1);
}
echo $json, "\n";
if (($jp = getenv('PDFTEST_JSON_OUT')) !== false && $jp !== '') {
    @mkdir(dirname($jp), 0775, true);
    file_put_contents($jp, $json . "\n");
}
if ($fail !== []) {
    fwrite(STDERR, "FAILED:\n - " . implode("\n - ", $fail) . "\n");
    exit(1);
}
$passed = count($checks) - count($fail);
echo "\nALL DELIVERY CHECKS PASSED ({$passed} checks)\n";
exit(0);
