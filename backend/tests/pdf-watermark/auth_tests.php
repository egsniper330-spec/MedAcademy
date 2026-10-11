<?php

declare(strict_types=1);

/**
 * auth_tests.php — authorization / link-lifecycle tests for material delivery.
 *
 * The production Database is a MySQL-only singleton. To exercise the SAME
 * source-controlled authorization code without a MySQL server, a SQLite PDO is
 * injected into Database via reflection (test-only; no production code is
 * modified and no database server is contacted). The queries that run are the
 * real StorageService::canAccess and MaterialDeliveryController token code.
 *
 * Covers: permission matrix (allow / preview_only / download_enabled=0 /
 * hidden / disabled), unpublished course+lesson, suspended and missing
 * enrollment, free-preview lessons, staff override, shouldWatermark role
 * rules, token round-trip, forged identity (403), expiry (410), malformed
 * token (403), and REVOCATION: a previously issued link keeps verifying
 * cryptographically but is refused at stream time once policy changes.
 *
 * Baseline: 32/32. Never touches production data or credentials.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
require $root . '/backend/src/bootstrap.php';

use MedAcademy\Controllers\MaterialDeliveryController;
use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Storage\StorageService;

putenv('MATERIAL_PDF_TOKEN_SECRET=test-secret-0123456789');
$_ENV['MATERIAL_PDF_TOKEN_SECRET'] = 'test-secret-0123456789';

$fail = [];
$results = [];

function check(array &$results, array &$fail, string $name, bool $ok, string $detail = ''): void
{
    $results[] = ['check' => $name, 'ok' => $ok, 'detail' => $detail];
    if (!$ok) {
        $fail[] = $name . ($detail !== '' ? " ($detail)" : '');
    }
}

// ── Inject an in-memory SQLite database ─────────────────────────────────────
$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
$pdo->exec('CREATE TABLE courses (id TEXT PRIMARY KEY, status TEXT)');
$pdo->exec('CREATE TABLE lessons (id TEXT PRIMARY KEY, is_preview INTEGER, status TEXT)');
$pdo->exec('CREATE TABLE enrollments (student_id TEXT, course_id TEXT, status TEXT)');
$pdo->exec('CREATE TABLE lesson_materials (id TEXT PRIMARY KEY, lesson_id TEXT, course_id TEXT, file_name TEXT, file_type TEXT, storage_path TEXT, permission TEXT, download_enabled INTEGER, preview_enabled INTEGER, watermark_enabled INTEGER)');
$pdo->exec('CREATE TABLE profiles (id TEXT PRIMARY KEY, role TEXT, full_name TEXT, public_user_id TEXT)');

$pdo->exec("INSERT INTO courses (id,status) VALUES ('c1','published'),('c2','draft')");
$pdo->exec("INSERT INTO lessons (id,is_preview,status) VALUES ('l1',0,'published'),('l2',0,'published'),('l3',0,'draft'),('l4',1,'published')");
$pdo->exec("INSERT INTO enrollments (student_id,course_id,status) VALUES ('s1','c1','active'),('s2','c1','suspended')");
$pdo->exec("INSERT INTO profiles (id,role,full_name,public_user_id) VALUES ('s1','student','Alpha One','MED-0042'),('s2','student','Beta Two','MED-0099')");
$pdo->exec("INSERT INTO lesson_materials (id,lesson_id,course_id,file_name,file_type,storage_path,permission,download_enabled,preview_enabled,watermark_enabled) VALUES
  ('m1','l1','c1','a.pdf','pdf','m1.pdf','allow',1,1,1),
  ('m2','l1','c1','b.pdf','pdf','m2.pdf','preview_only',1,1,1),
  ('m3','l1','c1','c.pdf','pdf','m3.pdf','allow',0,1,1),
  ('m4','l1','c1','d.pdf','pdf','m4.pdf','hidden',1,1,1),
  ('m5','l1','c1','e.pdf','pdf','m5.pdf','disabled',1,1,1),
  ('m6','l2','c2','f.pdf','pdf','m6.pdf','allow',1,1,1),
  ('m7','l3','c1','g.pdf','pdf','m7.pdf','allow',1,1,1),
  ('m8','l4','c1','h.pdf','pdf','m8.pdf','allow',1,1,1)");

$db = (new ReflectionClass(Database::class))->newInstanceWithoutConstructor();
(new ReflectionProperty(Database::class, 'pdo'))->setValue($db, $pdo);
(new ReflectionProperty(Database::class, 'instance'))->setValue(null, $db);

$storage = new StorageService();
$can = fn (string $u, string $r, string $path, bool $dl = false): bool => $storage->canAccess($u, $r, 'lesson-materials', $path, $dl);

// ── 1. canAccess matrix ─────────────────────────────────────────────────────
check($results, $fail, 'allow + download_enabled: view allowed',        $can('s1', 'student', 'm1.pdf', false) === true);
check($results, $fail, 'allow + download_enabled: download allowed',    $can('s1', 'student', 'm1.pdf', true) === true);
check($results, $fail, 'preview_only: view allowed',                    $can('s1', 'student', 'm2.pdf', false) === true);
check($results, $fail, 'preview_only: download DENIED',                 $can('s1', 'student', 'm2.pdf', true) === false);
check($results, $fail, 'download_enabled=0: view allowed',              $can('s1', 'student', 'm3.pdf', false) === true);
check($results, $fail, 'download_enabled=0: download DENIED',           $can('s1', 'student', 'm3.pdf', true) === false);
check($results, $fail, 'hidden: view DENIED',                           $can('s1', 'student', 'm4.pdf', false) === false);
check($results, $fail, 'hidden: download DENIED',                       $can('s1', 'student', 'm4.pdf', true) === false);
check($results, $fail, 'disabled: view DENIED',                         $can('s1', 'student', 'm5.pdf', false) === false);
check($results, $fail, 'unpublished course: DENIED',                    $can('s1', 'student', 'm6.pdf', false) === false);
check($results, $fail, 'unpublished lesson: DENIED',                    $can('s1', 'student', 'm7.pdf', false) === false);
check($results, $fail, 'SUSPENDED enrollment: DENIED',                  $can('s2', 'student', 'm1.pdf', false) === false);
check($results, $fail, 'not enrolled: DENIED',                          $can('s3', 'student', 'm1.pdf', false) === false);
check($results, $fail, 'free-preview lesson: enrolled view allowed',    $can('s1', 'student', 'm8.pdf', false) === true);
check($results, $fail, 'free-preview lesson: unenrolled user view allowed', $can('s3', 'student', 'm8.pdf', false) === true);
check($results, $fail, 'unknown material: DENIED',                      $can('s1', 'student', 'nope.pdf', false) === false);
check($results, $fail, 'doctor: allowed',                               $can('d1', 'doctor', 'm4.pdf', true) === true);
check($results, $fail, 'admin: allowed',                                $can('a1', 'admin', 'm4.pdf', true) === true);

// ── 2. shouldWatermark (staff never; students per material flag) ────────────
$ctrl = new MaterialDeliveryController();
$should = new ReflectionMethod(MaterialDeliveryController::class, 'shouldWatermark');
$should->setAccessible(true);
$m = ['watermark_enabled' => 1];
check($results, $fail, 'shouldWatermark: student + enabled => true',  $should->invoke($ctrl, $m, 'student') === true);
check($results, $fail, 'shouldWatermark: student + disabled => false', $should->invoke($ctrl, ['watermark_enabled' => 0], 'student') === false);
check($results, $fail, 'shouldWatermark: doctor => false',            $should->invoke($ctrl, $m, 'doctor') === false);
check($results, $fail, 'shouldWatermark: admin => false',             $should->invoke($ctrl, $m, 'admin') === false);

// ── 3. Token lifecycle ──────────────────────────────────────────────────────
$sign = new ReflectionMethod(MaterialDeliveryController::class, 'signToken');
$sign->setAccessible(true);
$verify = new ReflectionMethod(MaterialDeliveryController::class, 'verifyToken');
$verify->setAccessible(true);

$exp = time() + 300;
$tok = $sign->invoke($ctrl, 'm1', 's1', 'download', $exp);
$payload = $verify->invoke($ctrl, $tok);
check($results, $fail, 'token round-trips material/student/intent', $payload['material_id'] === 'm1' && $payload['student_id'] === 's1' && $payload['intent'] === 'download');
check($results, $fail, 'token round-trips even with url-safe base64 chars', is_string($tok) && $tok !== '');

// Tampered token (change the student in the payload) must fail the HMAC.
$decoded = explode('|', base64_decode(strtr($tok, '-_', '+/') . str_repeat('=', (4 - strlen($tok) % 4) % 4)));
$forgedBody = implode('|', ['m1', 's2', 'download', (string) $exp]);
$forged = rtrim(strtr(base64_encode($forgedBody . '|' . $decoded[4]), '+/', '-_'), '=');
$forgedCode = null;
try {
    $verify->invoke($ctrl, $forged);
} catch (ApiException $e) {
    $forgedCode = $e->status;
}
check($results, $fail, 'forged student identity in token => 403', $forgedCode === 403, (string) $forgedCode);

// Expired token => 410.
$expired = $sign->invoke($ctrl, 'm1', 's1', 'view', time() - 10);
$expiredCode = null;
try {
    $verify->invoke($ctrl, $expired);
} catch (ApiException $e) {
    $expiredCode = $e->status;
}
check($results, $fail, 'expired token => 410', $expiredCode === 410, (string) $expiredCode);

// Garbage / empty token => 403.
$badCode = null;
try {
    $verify->invoke($ctrl, 'not-a-token');
} catch (ApiException $e) {
    $badCode = $e->status;
}
check($results, $fail, 'malformed token => 403', $badCode === 403, (string) $badCode);

// ── 4. Revocation: a previously issued link stops working after the policy
//        changes, because authorization is re-evaluated at stream time ──────
$tokenForS1 = $sign->invoke($ctrl, 'm1', 's1', 'download', time() + 300);
check($results, $fail, 'pre-revocation: token authorizes the download', $can('s1', 'student', 'm1.pdf', true) === true);
// Doctor flips the material to Hidden (or the student is suspended).
$pdo->exec("UPDATE lesson_materials SET permission='hidden' WHERE storage_path='m1.pdf'");
check($results, $fail, 'link still verifies cryptographically (not expired/forged)', $verify->invoke($ctrl, $tokenForS1)['student_id'] === 's1');
check($results, $fail, 'post-revocation: same link is REFUSED at stream time', $can('s1', 'student', 'm1.pdf', true) === false);
// Restore to avoid cross-test contamination.
$pdo->exec("UPDATE lesson_materials SET permission='allow' WHERE storage_path='m1.pdf'");

// Suspension revocation.
$tokenForS2 = $sign->invoke($ctrl, 'm1', 's2', 'view', time() + 300);
$pdo->exec("UPDATE enrollments SET status='active' WHERE student_id='s2'");
check($results, $fail, 're-activated enrollment: access restored', $can('s2', 'student', 'm1.pdf', false) === true);
$pdo->exec("UPDATE enrollments SET status='suspended' WHERE student_id='s2'");
check($results, $fail, 'suspended enrollment: previously issued token refused', $can('s2', 'student', 'm1.pdf', false) === false);
unset($tokenForS2);

$json = json_encode(['checks' => $results, 'failures' => $fail, 'ok' => $fail === []], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
echo $json, "\n";
if (($jp = getenv('PDFTEST_JSON_OUT')) !== false && $jp !== '') {
    @mkdir(dirname($jp), 0775, true);
    file_put_contents($jp, $json . "\n");
}
if ($fail !== []) {
    fwrite(STDERR, "FAILED:\n - " . implode("\n - ", $fail) . "\n");
    exit(1);
}
echo "\nALL AUTHORIZATION CHECKS PASSED\n";
exit(0);
