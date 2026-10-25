<?php

declare(strict_types=1);

/**
 * enroll_tests.php — free-course self-enrollment, against the REAL controller.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * A student tapping Subscribe on a FREE course used to be shown the doctor's
 * contact card and was never enrolled. The client now calls
 * `POST /courses/{id}/enroll`; this suite proves the server side of that
 * contract, including the rules a tampered client must not be able to break:
 *
 *   • the enrollment OWNER is the token subject (a body field cannot redirect it);
 *   • only STUDENTS self-enroll (staff use the audited grant path);
 *   • the PRICE is read from the published row — a client claiming "free" for a
 *     paid course still gets 402 and no enrollment;
 *   • only a PUBLISHED course can be enrolled;
 *   • repeating the call is idempotent (one row, `already_enrolled`), including
 *     the genuine lost race of two concurrent requests (UNIQUE violation);
 *   • a SUSPENDED enrollment is refused and never reactivated;
 *   • the enrollment row is immediately what the video-access gate reads.
 *
 * Run: bash backend/tests/course-enrollment/run.sh
 * Exit codes: 0 = all checks passed, 1 = a check failed, 2 = prerequisite missing.
 */

$root = dirname(__DIR__, 3);
$work = getenv('ENROLLTEST_WORKDIR');
if (!is_string($work) || $work === '') {
    $work = $root . '/.freebuff/enrollment-tests';
}
$out = $work . '/out';
@mkdir($out, 0775, true);

$env = [
    'APP_ENV' => 'testing',
    'APP_URL' => 'http://127.0.0.1:8080',
    'JWT_SECRET' => 'enrollment-test-secret',
    'STORAGE_PRIVATE_DIR' => '../' . ltrim(substr(str_replace('\\', '/', $work), strlen(str_replace('\\', '/', $root))), '/') . '/out/storage/private',
    'LOG_DIR' => '../' . ltrim(substr(str_replace('\\', '/', $work), strlen(str_replace('\\', '/', $root))), '/') . '/logs',
];
@mkdir($work . '/logs', 0775, true);
foreach ($env as $k => $v) {
    putenv($k . '=' . $v);
    $_ENV[$k] = $v;
}

require $root . '/backend/src/bootstrap.php';

use MedAcademy\Controllers\CourseController;
use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\FeatureFlagService;

\MedAcademy\Utils\Config::init();

$DB_FILE = $out . '/enroll.sqlite';
$PASSES = 0;
$FAILS = 0;
$SKIPS = 0;

function check(string $name, bool $condition, string $detail = ''): void
{
    global $PASSES, $FAILS;
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

/**
 * SQLite shim for the ONE MySQL-ism on this path (`UTC_TIMESTAMP(6)`), plus a
 * hook that reproduces the REAL interleaving of two concurrent enrollments:
 * the competitor's row is inserted AFTER our pre-check returned "not enrolled"
 * and BEFORE our INSERT runs, so our INSERT hits the UNIQUE index exactly as it
 * would in production.
 */
final class EnrollTestPdo extends PDO
{
    public bool $simulateRace = false;
    public bool $raceFired = false;
    public string $raceStudentId = '';
    public string $raceCourseId = '';
    public const RACE_WINNER_ID = 'race-winner';

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $query = (string) preg_replace(
            '/\b(?:UTC_TIMESTAMP|CURRENT_TIMESTAMP|NOW)\s*\(\s*\d*\s*\)/i',
            'CURRENT_TIMESTAMP',
            $query
        );

        if ($this->simulateRace && !$this->raceFired && stripos(ltrim($query), 'INSERT INTO enrollments') === 0) {
            $this->raceFired = true;
            // The request that WON the race, committing first — same student,
            // same course, so this request's INSERT must hit the UNIQUE index.
            $stmt = parent::prepare(
                'INSERT INTO enrollments (id, student_id, course_id, enrollment_method, status, enrolled_at)
                 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
            );
            $stmt->execute([self::RACE_WINNER_ID, $this->raceStudentId, $this->raceCourseId, 'direct', 'active']);
        }

        return parent::prepare($query, $options);
    }
}

function connectDb(): EnrollTestPdo
{
    global $DB_FILE;
    $pdo = new EnrollTestPdo('sqlite:' . $DB_FILE);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA busy_timeout = 20000');
    return $pdo;
}

function bindDatabase(PDO $pdo): void
{
    $db = (new ReflectionClass(Database::class))->newInstanceWithoutConstructor();
    (new ReflectionProperty(Database::class, 'pdo'))->setValue($db, $pdo);
    (new ReflectionProperty(Database::class, 'instance'))->setValue(null, $db);
}

function resetDatabase(): EnrollTestPdo
{
    if (file_exists($GLOBALS['DB_FILE'])) {
        @unlink($GLOBALS['DB_FILE']);
    }
    $pdo = connectDb();
    $pdo->exec('CREATE TABLE courses (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT NOT NULL DEFAULT \'published\',
        price_egp INTEGER NOT NULL DEFAULT 0,
        doctor_id TEXT
    )');
    // The production UNIQUE index — the entire concurrency guarantee hangs on it.
    $pdo->exec('CREATE TABLE enrollments (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        enrollment_method TEXT NOT NULL DEFAULT \'direct\',
        status TEXT NOT NULL DEFAULT \'active\',
        credit_cost INTEGER DEFAULT 0,
        enrolled_at TEXT
    )');
    $pdo->exec('CREATE UNIQUE INDEX uq_enrollment ON enrollments (student_id, course_id)');
    $pdo->exec('CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY, user_id TEXT, actor_id TEXT, action TEXT, details TEXT,
        ip_address TEXT, created_at TEXT, target_name TEXT, description TEXT,
        log_status TEXT, actor_name TEXT, actor_email TEXT, actor_role TEXT
    )');
    $pdo->exec('CREATE TABLE users (id TEXT PRIMARY KEY, full_name TEXT, email TEXT, role TEXT)');
    // Full production column set: the service also runs `INSERT IGNORE` for any
    // registry key it has not seen, which is MySQL-only, so the flag test seeds
    // EVERY registry row and never needs that fallback path.
    $pdo->exec('CREATE TABLE feature_flags (
        `id` TEXT PRIMARY KEY, `key` TEXT NOT NULL UNIQUE, `label` TEXT, `description` TEXT,
        `enabled` INTEGER NOT NULL DEFAULT 1, `updated_at` TEXT
    )');
    bindDatabase($pdo);
    return $pdo;
}

/**
 * A Request exactly as AuthMiddleware hands it to a controller.
 *
 * Note what is NOT here: a student id and a price. The enroll action never reads
 * the request body (asserted in tests/freeCourseEnrollment.test.cjs), so there
 * is no field a client could tamper with to redirect the owner or claim free
 * access — this harness deliberately has nothing to tamper with.
 */
function makeRequest(string $routeId, array $user): Request
{
    $request = Request::capture();
    $request->params = ['id' => $routeId];
    $request->user = $user;
    return $request;
}

function student(string $id = 'student-1'): array
{
    return ['id' => $id, 'role' => 'student', 'email' => $id . '@example.test', 'full_name' => 'Student One'];
}

function enrollCount(PDO $pdo, string $studentId, string $courseId): int
{
    $stmt = $pdo->prepare('SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ? AND course_id = ?');
    $stmt->execute([$studentId, $courseId]);
    return (int) ($stmt->fetch()['c'] ?? 0);
}

function insertCourse(PDO $pdo, string $id, int $price, string $status = 'published'): void
{
    $stmt = $pdo->prepare('INSERT INTO courses (id, title, status, price_egp, doctor_id) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$id, 'Course ' . $id, $status, $price, 'doctor-1']);
}

$COURSE_FREE = '11111111-1111-4111-8111-111111111111';
$COURSE_PAID = '22222222-2222-4222-8222-222222222222';
$COURSE_DRAFT = '33333333-3333-4333-8333-333333333333';
$COURSE_RACE = '44444444-4444-4444-8444-444444444444';
$STUDENT = '55555555-5555-4555-8555-555555555555';
$STUDENT_RACE = '66666666-6666-4666-8666-666666666666';

$pdo = resetDatabase();
insertCourse($pdo, $COURSE_FREE, 0);
insertCourse($pdo, $COURSE_PAID, 750);
insertCourse($pdo, $COURSE_DRAFT, 0, 'draft');
insertCourse($pdo, $COURSE_RACE, 0);

$controller = new CourseController(new FeatureFlagService());

/* ── 1. Free course: immediate, owned, active enrollment ─────────────────── */

section('1. A free published course enrolls immediately');

$result = $controller->enroll(makeRequest($COURSE_FREE, student($STUDENT)));
check('success is returned', ($result['success'] ?? false) === true);
check('not reported as already enrolled', ($result['already_enrolled'] ?? null) === false);
check('the enrollment is ACTIVE', ($result['status'] ?? '') === 'active');
check('exactly one enrollment row exists', enrollCount($pdo, $STUDENT, $COURSE_FREE) === 1);

$row = $pdo->prepare('SELECT id, status, enrollment_method FROM enrollments WHERE student_id = ? AND course_id = ?');
$row->execute([$STUDENT, $COURSE_FREE]);
$enrollment = $row->fetch();
check('the row is owned by the TOKEN subject', is_array($enrollment));
check('the row records the direct (free) method', ($enrollment['enrollment_method'] ?? '') === 'direct');
check('the enrollment id is returned to the client', ($result['enrollment_id'] ?? '') === ($enrollment['id'] ?? null));

$audit = $pdo->prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE action = ? AND user_id = ?');
$audit->execute(['enrollment_created', $STUDENT]);
check('an audit event records the creation', (int) ($audit->fetch()['c'] ?? 0) === 1);

/* ── 2. The access gate reads the new row ────────────────────────────────── */

section('2. Course access sees the enrollment at once');

// Exactly what VdoCipherService::otp() reads before issuing playback OTPs.
$gate = $pdo->prepare('SELECT status FROM enrollments WHERE student_id = ? AND course_id = ? LIMIT 1');
$gate->execute([$STUDENT, $COURSE_FREE]);
check('the access gate resolves an active enrollment', ($gate->fetch()['status'] ?? null) === 'active');
$gateCourse = $pdo->prepare('SELECT status FROM courses WHERE id = ?');
$gateCourse->execute([$COURSE_FREE]);
check('the parent course is published (second half of the gate)', ($gateCourse->fetch()['status'] ?? null) === 'published');

/* ── 3. Repeat taps are idempotent ───────────────────────────────────────── */

section('3. Repeat / retried requests do not duplicate');

$again = $controller->enroll(makeRequest($COURSE_FREE, student($STUDENT)));
check('a repeat call succeeds', ($again['success'] ?? false) === true);
check('it is reported as already enrolled', ($again['already_enrolled'] ?? null) === true);
check('still exactly one row', enrollCount($pdo, $STUDENT, $COURSE_FREE) === 1);

$audit->execute(['enrollment_created', $STUDENT]);
check('no second audit event is written', (int) ($audit->fetch()['c'] ?? 0) === 1);

/* ── 4. Concurrent requests (real UNIQUE violation) ──────────────────────── */

section('4. Two concurrent requests produce one enrollment');

$pdo->simulateRace = true;
$pdo->raceFired = false;
$pdo->raceStudentId = $STUDENT_RACE;
$pdo->raceCourseId = $COURSE_RACE;
$race = null;
$raceError = null;
try {
    $race = $controller->enroll(makeRequest($COURSE_RACE, student($STUDENT_RACE)));
} catch (\Throwable $e) {
    $raceError = $e;
}
$pdo->simulateRace = false;
check('the lost race did not raise an exception', $raceError === null, $raceError ? $raceError->getMessage() : '');
check('the loser is told it is already enrolled', ($race['already_enrolled'] ?? null) === true);
check('the unique index kept a single row', enrollCount($pdo, $STUDENT_RACE, $COURSE_RACE) === 1);
check('the surviving row is the winner\'s', ($race['enrollment_id'] ?? '') === EnrollTestPdo::RACE_WINNER_ID);

/* ── 5. Paid courses cannot be self-enrolled ─────────────────────────────── */

section('5. Paid courses are refused (no free access, no price bypass)');

$paidStatus = null;
$paidMessage = '';
$paidError = null;
try {
    $controller->enroll(makeRequest($COURSE_PAID, student($STUDENT)));
} catch (ApiException $e) {
    $paidError = $e;
    $paidStatus = $e->status;
    $paidMessage = $e->getMessage();
}
check('a paid course is refused with 402', $paidStatus === 402, (string) $paidStatus);
check('the refusal explains the credit path', stripos($paidMessage, 'credit') !== false, $paidMessage);
check('no enrollment was created', enrollCount($pdo, $STUDENT, $COURSE_PAID) === 0);
check('the error is an ApiException (mapped to JSON, never a 500)', $paidError instanceof ApiException);

/* ── 6. Only published courses ───────────────────────────────────────────── */

section('6. Unpublished courses cannot be enrolled');

$draftStatus = null;
try {
    $controller->enroll(makeRequest($COURSE_DRAFT, student($STUDENT)));
} catch (ApiException $e) {
    $draftStatus = $e->status;
}
check('a draft course is a 404', $draftStatus === 404, (string) $draftStatus);
check('no enrollment was created', enrollCount($pdo, $STUDENT, $COURSE_DRAFT) === 0);

$missingStatus = null;
try {
    $controller->enroll(makeRequest('99999999-9999-4999-8999-999999999999', student($STUDENT)));
} catch (ApiException $e) {
    $missingStatus = $e->status;
}
check('an unknown course is a 404', $missingStatus === 404, (string) $missingStatus);

/* ── 7. Role: students only ─────────────────────────────────────────────── */

section('7. Staff cannot create a student-owned enrollment for themselves');

foreach (['doctor', 'admin', 'super_admin'] as $role) {
    $status = null;
    try {
        $controller->enroll(makeRequest($COURSE_FREE, ['id' => 'staff-' . $role, 'role' => $role]));
    } catch (ApiException $e) {
        $status = $e->status;
    }
    check("role {$role} is refused with 403", $status === 403, (string) $status);
    check("no enrollment for role {$role}", enrollCount($pdo, 'staff-' . $role, $COURSE_FREE) === 0);
}

/* ── 8. A suspended enrollment is never reactivated ─────────────────────── */

section('8. Suspension stays authoritative');

$suspend = $pdo->prepare('UPDATE enrollments SET status = \'suspended\' WHERE student_id = ? AND course_id = ?');
$suspend->execute([$STUDENT, $COURSE_FREE]);
$suspendedStatus = null;
$suspendedMessage = '';
try {
    $controller->enroll(makeRequest($COURSE_FREE, student($STUDENT)));
} catch (ApiException $e) {
    $suspendedStatus = $e->status;
    $suspendedMessage = $e->getMessage();
}
check('a suspended enrollment is refused with 403', $suspendedStatus === 403, (string) $suspendedStatus);
check('the refusal names suspension', stripos($suspendedMessage, 'suspend') !== false, $suspendedMessage);
$state = $pdo->prepare('SELECT status FROM enrollments WHERE student_id = ? AND course_id = ?');
$state->execute([$STUDENT, $COURSE_FREE]);
check('the row is still suspended (never silently reactivated)', ($state->fetch()['status'] ?? null) === 'suspended');
check('no extra row was added', enrollCount($pdo, $STUDENT, $COURSE_FREE) === 1);

/* ── 9. Feature flag enforcement ────────────────────────────────────────── */

section('9. The course_enrollment feature flag is enforced server-side');

$seed = $pdo->prepare('INSERT INTO feature_flags (`id`, `key`, `label`, `description`, `enabled`, `updated_at`)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)');
foreach (FeatureFlagService::REGISTRY as $key => $meta) {
    $seed->execute([
        'ff-' . $key,
        $key,
        (string) ($meta['label'] ?? $key),
        (string) ($meta['description'] ?? ''),
        $key === 'course_enrollment' ? 0 : (!empty($meta['default']) ? 1 : 0),
    ]);
}
// The service caches flag state for a few seconds; clear it so the new row is read.
(new ReflectionProperty(FeatureFlagService::class, 'cache'))->setValue(null, null);
(new ReflectionProperty(FeatureFlagService::class, 'cacheAt'))->setValue(null, 0);
$flagStatus = null;
$flagCode = null;
try {
    $controller->enroll(makeRequest($COURSE_RACE, student('77777777-7777-4777-8777-777777777777')));
} catch (\MedAcademy\Http\FeatureDisabledException $e) {
    $flagStatus = $e->status;
    $flagCode = $e->errors[0] ?? null;
} catch (ApiException $e) {
    $flagStatus = $e->status;
}
check('enrollment is refused while the feature is disabled', $flagStatus === 403, var_export($flagStatus, true));
check('the refusal is the feature_disabled error the app maps to "unavailable"',
    $flagCode === 'feature_disabled', var_export($flagCode, true));
check('no enrollment was created while disabled',
    enrollCount($pdo, '77777777-7777-4777-8777-777777777777', $COURSE_RACE) === 0);

// And prove the flag is the ONLY thing that was holding it back: enabling it
// again lets the very same request through (after dropping the short cache).
$pdo->exec("UPDATE feature_flags SET `enabled` = 1 WHERE `key` = 'course_enrollment'");
(new ReflectionProperty(FeatureFlagService::class, 'cache'))->setValue(null, null);
(new ReflectionProperty(FeatureFlagService::class, 'cacheAt'))->setValue(null, 0);
$reenabled = $controller->enroll(makeRequest($COURSE_RACE, student('88888888-8888-4888-8888-888888888888')));
check('enabling the flag restores enrollment', ($reenabled['success'] ?? false) === true);

/* ── Summary ────────────────────────────────────────────────────────────── */

echo "\n" . str_repeat('─', 62) . "\n";
echo "{$PASSES} passed, {$FAILS} failed";
if ($SKIPS > 0) {
    echo ", {$SKIPS} skipped";
}
echo "\n";
exit($FAILS === 0 ? 0 : 1);
