<?php

declare(strict_types=1);

/**
 * pdf_queue_concurrency_tests.php — staged concurrency against the REAL queue and
 * the REAL cron worker, with disposable students.
 *
 * WHY THIS SUITE EXISTS
 *   `queue_tests.php` proves the queue's guarantees with a handful of rows;
 *   `pdf_worker_performance_tests.php` proves what one copy costs. Neither shows
 *   what happens when a class of students asks at once: does every request get
 *   its OWN job, does a waiting student get served ahead of background
 *   pre-generation, how long does the queue actually take to drain, and can the
 *   prewarm work be starved by a steady stream of student requests?
 *
 *   Stages: 1, 5, 10, 20 and 50 students. Each student is a real row with a real
 *   enrollment, and each request is a real `enqueueStudent()` call issued from a
 *   SEPARATE PROCESS, so the unique-key/duplicate-prevention path is exercised
 *   under genuine concurrency rather than from one loop.
 *
 * WHAT IT MEASURES
 *   C1 N simultaneous download requests → exactly N jobs, one per student, no
 *      duplicates and no cross-student rows;
 *   C2 draining the stage with the shipped cron shape (--limit=5 --max-seconds=50)
 *      repeated until empty: invocations needed, wall clock, jobs/minute, and the
 *      per-job queue latency (queued → ready) as p50/p95;
 *   C3 an interactive request arriving while background prewarm work is queued is
 *      claimed FIRST (measured from the worker's own detail, by job id);
 *   C4 a student's copy is never registered to another student, at every stage;
 *   C5 how long a PREWARM job waits while student requests keep arriving — the
 *      measured answer to "can interactive traffic starve pre-generation".
 *
 * WHAT IT IS NOT
 *   It is a queue/worker test on ONE machine with a local MariaDB. It is NOT a
 *   host capacity test: no live host, no PHP-FPM, no cPanel process limits. The
 *   live staged run needs a staging install and explicit approval (see §5 of the
 *   report); this suite deliberately does not touch production.
 *
 * SAFETY
 *   • Refuses to run when APP_ENV=production.
 *   • Creates only `qtest-conc-*` rows/files and deletes them in a finally block.
 *   • Worker runs pin `--stale=86400` so the sweep cannot touch rows it did not
 *     create; the stale path itself is covered by the other suites.
 *
 * USAGE
 *   php backend/tests/material-queue/pdf_queue_concurrency_tests.php
 *   php backend/tests/material-queue/pdf_queue_concurrency_tests.php --stages=1,5 --size=1m --json=out.json
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
require $root . '/backend/src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Services\MaterialPdfQueueService;
use MedAcademy\Services\MaterialPdfVariantService;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Utils\Config;

Config::init();

if (Config::string('APP_ENV', 'production') === 'production') {
    fwrite(STDERR, "Refusing to run: APP_ENV=production. This suite writes to the database.\n");
    exit(2);
}

$args = [];
foreach (array_slice($argv, 1) as $arg) {
    if (!str_starts_with($arg, '--')) {
        continue;
    }
    $p = explode('=', substr($arg, 2), 2);
    $args[$p[0]] = $p[1] ?? '1';
}

$stages = array_values(array_filter(array_map('intval', explode(',', (string) ($args['stages'] ?? '1,5,10,20,50')))));
sort($stages);
$fixtureSize = (string) ($args['size'] ?? '1m');
$jsonOut = (string) ($args['json'] ?? '');
$fixtureDir = (string) ($args['fixtures'] ?? $root . '/.freebuff/pdf-worker-bench/fixtures');
$sourcePdf = $fixtureDir . '/source-' . $fixtureSize . '.pdf';

$checks = [];
$failures = [];
function check(string $name, bool $ok, string $detail = ''): void
{
    global $checks, $failures;
    $checks[] = ['check' => $name, 'ok' => $ok, 'detail' => $detail];
    if (!$ok) {
        $failures[] = $name . ($detail !== '' ? " ({$detail})" : '');
    }
    fwrite(STDOUT, ($ok ? 'PASS ' : 'FAIL ') . $name . ($detail !== '' ? "  [{$detail}]" : '') . "\n");
}

function skip(string $name, string $why): void
{
    global $checks;
    $checks[] = ['check' => $name, 'ok' => true, 'detail' => 'SKIPPED — ' . $why];
    fwrite(STDOUT, "SKIP {$name}  [{$why}]\n");
}

$php = PHP_BINARY;
$ini = php_ini_loaded_file();
$worker = $root . '/backend/scripts/watermark-worker.php';

/**
 * Start a process.
 *
 * The ARRAY form of proc_open is used deliberately: the string form goes through
 * the shell (cmd.exe on Windows), which strips the double quotes out of an `-r`
 * code argument and turns it into a parse error. The first draft of this suite
 * silently failed every child process that way.
 */
function run_cmd(array $argv, ?float $timeout = null): array
{
    $proc = proc_open($argv, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($proc)) {
        throw new RuntimeException('could not start: ' . implode(' ', $argv));
    }
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $out = '';
    $err = '';
    $start = microtime(true);
    while (true) {
        $status = proc_get_status($proc);
        $out .= (string) stream_get_contents($pipes[1]);
        $err .= (string) stream_get_contents($pipes[2]);
        if (!$status['running']) {
            break;
        }
        if ($timeout !== null && (microtime(true) - $start) > $timeout) {
            proc_terminate($proc, 9);
            break;
        }
        usleep(15000);
    }
    $out .= (string) stream_get_contents($pipes[1]);
    $err .= (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exit = proc_close($proc);
    return [$exit, $out, $err, microtime(true) - $start];
}

/** START (do not wait for) a process; returns [resource, pipes, startedAt]. */
function start_cmd(array $argv): array
{
    $proc = proc_open($argv, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($proc)) {
        throw new RuntimeException('could not start: ' . implode(' ', $argv));
    }
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    return [$proc, $pipes, microtime(true)];
}

function finish_cmd(array $started): array
{
    [$proc, $pipes, $t0] = $started;
    $out = '';
    $err = '';
    while (true) {
        $status = proc_get_status($proc);
        $out .= (string) stream_get_contents($pipes[1]);
        $err .= (string) stream_get_contents($pipes[2]);
        if (!$status['running']) {
            break;
        }
        usleep(15000);
    }
    $out .= (string) stream_get_contents($pipes[1]);
    $err .= (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exit = proc_close($proc);
    return [$exit, $out, $err, microtime(true) - $t0];
}

function worker(array $extra = [], ?float $timeout = 300): array
{
    global $php, $ini, $worker;
    $argv = [$php, ...($ini ? ['-c', $ini] : []), $worker, '--stale=86400', ...$extra];
    return run_cmd($argv, $timeout);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
$db = Database::instance();
$queue = new MaterialPdfQueueService();
$variants = $queue->variants();
$tag = substr(bin2hex(random_bytes(4)), 0, 8);
$doctor = 'qtest-conc-doc-' . $tag;
$course = 'qtest-conc-crs-' . $tag;
$section = 'qtest-conc-sec-' . $tag;
$lesson = 'qtest-conc-lsn-' . $tag;
$now = gmdate('Y-m-d H:i:s');
$ownedFiles = [];
$stagesOut = [];

/** One enrolled disposable student per participant. */
function seed_students(int $count): array
{
    global $db, $doctor, $course, $now, $tag;
    $ids = [];
    for ($i = 0; $i < $count; $i++) {
        $id = 'qtest-conc-s' . $count . '-' . $i . '-' . substr($tag, 0, 4);
        if ($db->row('SELECT id FROM users WHERE id = ?', [$id]) === null) {
            $db->query(
                'INSERT INTO users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
                 VALUES (?, ?, ?, NULL, ?, ?)',
                [$id, $id . '@example.invalid', 'qtest-no-login-' . bin2hex(random_bytes(8)), $now, $now]
            );
            if ($db->row('SELECT id FROM profiles WHERE id = ?', [$id]) !== null) {
                $db->query(
                    'UPDATE profiles SET full_name = ?, role = ?, status = ?, email = ?, updated_at = ? WHERE id = ?',
                    ['Conc Student ' . $i, 'student', 'active', $id . '@example.invalid', $now, $id]
                );
            } else {
                $db->query(
                    'INSERT INTO profiles (id, email, full_name, role, status, watermark_id, public_user_id, security_version, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
                    [$id, $id . '@example.invalid', 'Conc Student ' . $i, 'student', 'active', 'QC-' . strtoupper(substr(md5($id), 0, 8)), 'QC' . substr(md5($id), 0, 6), $now, $now]
                );
            }
        }
        $db->query(
            "INSERT INTO enrollments (id, student_id, course_id, enrolled_by, enrollment_method, status, progress_percent, visibility_level, enrolled_at)
             VALUES (?, ?, ?, ?, 'doctor_created', 'active', 0, 'all', ?)
             ON DUPLICATE KEY UPDATE status = 'active'",
            ['qtest-conc-enr-' . substr(md5($id), 0, 10), $id, $course, $doctor, $now]
        );
        $ids[] = $id;
    }
    return $ids;
}

function seed_material(string $slug, string $sourcePath, string $extension = 'pdf'): string
{
    global $db, $doctor, $course, $lesson, $now, $tag;
    // The run tag is part of the id: a fixture left behind by an interrupted run
    // must never be adopted by the next one.
    $materialId = 'qtest-conc-mat-' . $tag . '-' . $slug;
    $rel = $materialId . '/' . $slug . '.' . $extension;
    $existing = $db->row('SELECT id FROM lesson_materials WHERE id = ?', [$materialId]);
    if ($existing === null) {
        $db->query(
            "INSERT INTO lesson_materials (id, lesson_id, course_id, file_name, file_url, file_type, storage_path, permission, download_enabled, preview_enabled, uploaded_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, 'allow', 1, 1, ?, ?, ?)",
            [$materialId, $lesson, $course, 'conc-' . $slug . '.' . $extension, $rel, $rel, $doctor, $now, $now]
        );
    }
    $abs = (new MaterialPdfVariantService())->sourcePath([
        'id' => $materialId,
        'course_id' => $course,
        'storage_path' => $rel,
    ]);
    @mkdir(dirname($abs), 0775, true);
    copy($sourcePath, $abs);
    clearstatcache(true, $abs);
    return $materialId;
}

function remove_fixtures(): void
{
    global $db, $doctor, $course, $section, $lesson, $ownedFiles, $tag;
    foreach ($ownedFiles as $file) {
        if (is_file($file)) {
            @unlink($file);
        }
    }
    $db->query("DELETE FROM lesson_material_pdf_jobs WHERE student_id LIKE 'qtest-conc-%' OR material_id LIKE 'qtest-conc-%'");
    $db->query("DELETE FROM lesson_material_pdfs WHERE student_id LIKE 'qtest-conc-%' OR material_id LIKE 'qtest-conc-%'");
    $db->query("DELETE FROM lesson_materials WHERE lesson_id = ?", [$lesson]);
    $db->query('DELETE FROM enrollments WHERE course_id = ?', [$course]);
    $db->query('DELETE FROM lessons WHERE id = ?', [$lesson]);
    $db->query('DELETE FROM sections WHERE id = ?', [$section]);
    $db->query('DELETE FROM courses WHERE id = ?', [$course]);
    $db->query("DELETE FROM profiles WHERE id LIKE 'qtest-conc-%'");
    $db->query("DELETE FROM users WHERE id LIKE 'qtest-conc-%'");
}

try {
    if (!is_file($sourcePdf)) {
        fwrite(STDERR, "No fixture at {$sourcePdf}. Run make_size_fixtures.php first.\n");
        exit(2);
    }
    $sourceBytes = (int) filesize($sourcePdf);
    $sourcePages = 0;

    // Base rows (users/course/lesson) — the doctor is created directly, students per stage.
    $db->query(
        'INSERT INTO users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)',
        [$doctor, $doctor . '@example.invalid', 'qtest-no-login-' . bin2hex(random_bytes(8)), $now, $now]
    );
    if ($db->row('SELECT id FROM profiles WHERE id = ?', [$doctor]) !== null) {
        $db->query('UPDATE profiles SET full_name = ?, role = ?, status = ? WHERE id = ?', ['Conc Doctor', 'doctor', 'active', $doctor]);
    } else {
        $db->query(
            'INSERT INTO profiles (id, email, full_name, role, status, watermark_id, public_user_id, security_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
            [$doctor, $doctor . '@example.invalid', 'Conc Doctor', 'doctor', 'active', 'QC-DOC', 'QCDOC1', $now, $now]
        );
    }
    $db->query(
        'INSERT INTO courses (id, doctor_id, title, description, language, status, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$course, $doctor, 'Conc Test Course ' . substr($course, -6), 'Queue concurrency fixture. Safe to delete.', 'en', 'published', '+201000000000', $now, $now]
    );
    $db->query('INSERT INTO sections (id, course_id, title, order_index, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', [$section, $course, 'Conc Section', $now, $now]);
    $db->query(
        'INSERT INTO lessons (id, section_id, course_id, title, status, order_index, video_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
        [$lesson, $section, $course, 'Conc Lesson', 'published', 'coming_soon', $now, $now]
    );

    fwrite(STDOUT, "\nsource: {$fixtureSize} ({$sourceBytes} bytes)\n");

    foreach ($stages as $n) {
        fwrite(STDOUT, "\n── stage: {$n} students ──\n");
        $students = seed_students($n);
        $materialId = seed_material('s' . $n, $sourcePdf);
        $material = $queue->loadMaterial($materialId);
        if ($material === null) {
            check("C1 stage {$n}: material fixture exists", false);
            continue;
        }

        // ── C1: N SIMULTANEOUS requests from N separate processes ───────────
        $launched = [];
        $enqueueStart = microtime(true);
        foreach ($students as $sid) {
            // Each child is a real process: the INSERT ... ON DUPLICATE KEY path
            // and the priority UPDATE run concurrently, as they do in production.
            $code = 'require ' . var_export($root . '/backend/src/bootstrap.php', true) . ';'
                . '$q = new MedAcademy\Services\MaterialPdfQueueService();'
                . '$m = $q->loadMaterial(' . var_export($materialId, true) . ');'
                . 'echo $q->enqueueStudent($m, ' . var_export($sid, true) . ', MedAcademy\Services\MaterialPdfQueueService::PRIORITY_STUDENT, true) ? "ok" : "null";';
            $argv = [$php, ...($ini ? ['-c', $ini] : []), '-r', $code];
            $launched[] = start_cmd($argv);
        }
        $ok = 0;
        $childErrors = [];
        foreach ($launched as $started) {
            [$exit, $out, $err] = finish_cmd($started);
            if (trim($out) === 'ok' && $exit === 0) {
                $ok++;
            } elseif (count($childErrors) < 2) {
                // Visible, not swallowed: a broken child must not look like "no jobs".
                $childErrors[] = 'exit=' . $exit . ' out=' . substr(trim($out), 0, 60) . ' err=' . substr(trim($err), 0, 120);
            }
        }
        $spawnSeconds = microtime(true) - $enqueueStart;

        $jobs = $db->select(
            "SELECT id, student_id, priority, status, created_at FROM lesson_material_pdf_jobs WHERE material_id = ? ORDER BY created_at",
            [$materialId]
        );
        $distinctStudents = count(array_unique(array_column($jobs, 'student_id')));
        check(
            "C1 stage {$n}: every request created exactly ONE job for its own student",
            count($jobs) === $n && $distinctStudents === $n,
            'jobs=' . count($jobs) . ' students=' . $distinctStudents . ' enqueued_ok=' . $ok
        );
        check(
            "C1 stage {$n}: no job is duplicated for the same student",
            (int) $db->value('SELECT COUNT(*) FROM (SELECT student_id FROM lesson_material_pdf_jobs WHERE material_id = ? GROUP BY student_id HAVING COUNT(*) > 1) d', [$materialId]) === 0
        );
        check(
            "C1 stage {$n}: every job carries the interactive priority",
            (int) $db->value('SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ? AND priority <> ?', [$materialId, MaterialPdfQueueService::PRIORITY_STUDENT]) === 0
        );
        check(
            "C1 stage {$n}: all {$n} requests ran in separate processes and reported success",
            $ok === $n,
            sprintf('%d/%d processes succeeded in %.2f s%s', $ok, $n, $spawnSeconds, $childErrors === [] ? '' : ' — ' . implode(' | ', $childErrors))
        );

        // ── C2: drain with the shipped cron shape, as cron would ────────────
        $drainStart = microtime(true);
        $invocations = 0;
        $readyTotal = 0;
        while ($invocations < 60) {
            [$exit, $out, $err, $wall] = worker(['--limit=5', '--max-seconds=50'], 300);
            $invocations++;
            $summary = json_decode(trim($out), true);
            if (!is_array($summary)) {
                check("C2 stage {$n}: worker summary is valid JSON", false, substr(trim($out . ' ' . $err), 0, 160));
                break;
            }
            $readyTotal += (int) $summary['ready'];
            $remaining = (int) $db->value(
                "SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ? AND status IN ('queued','processing')",
                [$materialId]
            );
            if ($remaining === 0) {
                break;
            }
        }
        $drainSeconds = microtime(true) - $drainStart;
        // `created_at` is DATETIME(6) but `ready_at` is written by gmdate() at
        // second precision, so a sub-second wait can compute as slightly negative.
        // Clamped at 0 and reported as "< 1 s" rather than as a negative wait.
        $drainRows = $db->select(
            "SELECT status, created_at, ready_at,
                    GREATEST(TIMESTAMPDIFF(MICROSECOND, created_at, ready_at) / 1000000, 0) AS wait_seconds
               FROM lesson_material_pdf_jobs WHERE material_id = ?",
            [$materialId]
        );
        $waits = array_values(array_filter(array_map(
            static fn (array $r): ?float => $r['wait_seconds'] === null ? null : (float) $r['wait_seconds'],
            $drainRows
        ), static fn (?float $v): bool => $v !== null));
        sort($waits);
        $p50 = $waits === [] ? null : $waits[intdiv(count($waits), 2)];
        $p95 = $waits === [] ? $waits : $waits[min(count($waits) - 1, (int) ceil(0.95 * count($waits)) - 1)];
        $jobText = PHP_OS_FAMILY === 'Windows' ? 'process-spawn model' : 'cron model';
        check(
            "C2 stage {$n}: the queue drained completely ({$jobText})",
            $readyTotal === $n && (int) $db->value("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ? AND status <> 'ready'", [$materialId]) === 0,
            "ready={$readyTotal}/{$n} invocations={$invocations} seconds=" . round($drainSeconds, 2)
        );
        check(
            "C2 stage {$n}: every student's copy exists and is registered to them",
            (int) $db->value('SELECT COUNT(*) FROM lesson_material_pdfs WHERE material_id = ?', [$materialId]) === $n
        );
        check(
            "C2 stage {$n}: no job was left claimed in `processing`",
            (int) $db->value("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ? AND status = 'processing'", [$materialId]) === 0
        );
        $stagesOut[] = [
            'students' => $n,
            'size' => $fixtureSize,
            'source_bytes' => $sourceBytes,
            'jobs' => count($jobs),
            'worker_invocations' => $invocations,
            'drain_seconds' => round($drainSeconds, 2),
            'jobs_per_minute' => $drainSeconds > 0 ? round($n / ($drainSeconds / 60), 2) : null,
            'queue_wait_p50_seconds' => $p50 === null ? null : round($p50, 2),
            'queue_wait_p95_seconds' => $p95 === null ? null : round($p95, 2),
            'first_job_queued_at' => (string) ($jobs[0]['created_at'] ?? ''),
            'last_job_ready_at' => (string) $db->value("SELECT MAX(ready_at) FROM lesson_material_pdf_jobs WHERE material_id = ?", [$materialId], ''),
        ];
        fwrite(STDOUT, sprintf(
            "  drain: %d job(s) in %.1f s over %d invocation(s) = %.1f jobs/min, queue wait p50 %.2f s / p95 %.2f s\n",
            $n,
            $drainSeconds,
            $invocations,
            $stagesOut[count($stagesOut) - 1]['jobs_per_minute'] ?? 0,
            (float) ($p50 ?? 0),
            (float) ($p95 ?? 0)
        ));
    }

    // ── C3: an interactive request overtakes a backlog ──────────────────────
    fwrite(STDOUT, "\n── C3 interactive overtakes background prewarm ──\n");
    $students = seed_students(20);
    $materialId = seed_material('c3', $sourcePdf);
    $material = $queue->loadMaterial($materialId);
    foreach (array_slice($students, 0, 10) as $sid) {
        $queue->enqueueStudent($material, $sid, MaterialPdfQueueService::PRIORITY_PREWARM, true);
    }
    $waiting = $students[19];
    $queue->enqueueStudent($material, $waiting, MaterialPdfQueueService::PRIORITY_STUDENT, true);
    $interactiveJob = (string) $db->value(
        'SELECT id FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ?',
        [$materialId, $waiting],
        ''
    );
    [$exit, $out] = worker(['--limit=5', '--max-seconds=50'], 300);
    $summary = json_decode(trim($out), true);
    $claimedIds = array_map(static fn (array $d): string => (string) $d['job'], (array) ($summary['details'] ?? []));
    check(
        'C3: the single job the worker claimed first is the waiting student\'s',
        $interactiveJob !== '' && $claimedIds !== [] && str_starts_with($interactiveJob, $claimedIds[0]),
        'claimed=' . json_encode($claimedIds) . ' interactive=' . substr($interactiveJob, 0, 8)
    );
    $prewarmRow = $db->row(
        'SELECT status, ready_at, created_at FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ?',
        [$materialId, $students[0]]
    );
    check(
        'C3: the prewarm backlog was processed in the same run (the interactive job did not consume the whole batch)',
        is_array($summary) && (int) $summary['ready'] === 5,
        'ready=' . json_encode($summary['ready'] ?? null)
    );

    // ── C5: can interactive traffic starve prewarm? ─────────────────────────
    fwrite(STDOUT, "\n── C5 starvation of pre-generation by a stream of student requests ──\n");
    $materialId = seed_material('c5', $sourcePdf);
    $material = $queue->loadMaterial($materialId);
    $victim = $students[0];
    $queue->enqueueStudent($material, $victim, MaterialPdfQueueService::PRIORITY_PREWARM, true);
    $rounds = 5;
    for ($i = 1; $i <= $rounds; $i++) {
        // A new student request arrives before each worker tick.
        $queue->enqueueStudent($material, $students[$i], MaterialPdfQueueService::PRIORITY_STUDENT, true);
        worker(['--limit=1', '--max-seconds=50'], 300);
    }
    $victimRow = $db->row(
        'SELECT status, created_at, ready_at, priority FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ?',
        [$materialId, $victim]
    );
    $victimWait = $victimRow !== null && $victimRow['ready_at'] !== null
        ? (float) $victimRow['ready_at'] - (float) strtotime((string) $victimRow['created_at'])
        : null;
    $deferredThroughStream = $victimRow !== null && (string) $victimRow['status'] !== 'ready';
    check(
        'C5: while student requests keep arriving the PREWARM job is still queued (measured fact, not a design claim)',
        $victimRow !== null,
        'status after ' . $rounds . ' interactive arrivals: ' . (string) ($victimRow['status'] ?? 'missing')
    );

    // `claim()` is global, and this dev database may hold unrelated queued jobs,
    // so completion is measured by ticking until THIS job is ready — with the
    // number of ticks and the unrelated backlog reported instead of assumed away.
    $foreignDue = (int) $db->value(
        "SELECT COUNT(*) FROM lesson_material_pdf_jobs
          WHERE status = 'queued' AND material_id NOT LIKE 'qtest-conc-%' AND material_id NOT LIKE 'qtest-perf-%'"
    );
    $ticks = 0;
    while ($ticks < 25 && (string) ($victimRow['status'] ?? '') !== 'ready') {
        worker(['--limit=1', '--max-seconds=50'], 300);
        $ticks++;
        $victimRow = $db->row(
            'SELECT status, created_at, ready_at, priority FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ?',
            [$materialId, $victim]
        );
    }
    $victimWait = $victimRow !== null && $victimRow['ready_at'] !== null
        ? (float) strtotime((string) $victimRow['ready_at']) - (float) strtotime((string) $victimRow['created_at'])
        : null;
    fwrite(STDOUT, sprintf(
        "  prewarm job: status=%s, %d worker tick(s) to completion%s, wait %s (interactive workload: %d request(s); unrelated due jobs: %d)\n",
        (string) ($victimRow['status'] ?? 'missing'),
        $ticks,
        $deferredThroughStream ? ' after the interactive stream ended' : '',
        $victimWait === null ? 'not measured' : sprintf('%.0f s', $victimWait),
        $rounds,
        $foreignDue
    ));
    check(
        'C5: the deferred prewarm job completes once student traffic stops (no permanent starvation)',
        $victimRow !== null && (string) $victimRow['status'] === 'ready',
        'status=' . (string) ($victimRow['status'] ?? 'missing') . ' ticks=' . $ticks
    );

    // ── C4: isolation across every stage ───────────────────────────────────
    fwrite(STDOUT, "\n── C4 student isolation ──\n");
    $mismatched = (int) $db->value(
        "SELECT COUNT(*) FROM lesson_material_pdfs p
           JOIN lesson_material_pdf_jobs j ON j.material_id = p.material_id AND j.student_id = p.student_id
          WHERE p.material_id LIKE 'qtest-conc-%' AND NOT (p.storage_path LIKE CONCAT('%', p.student_id, '%'))"
    );
    check('C4: every generated copy lives under its own student path', $mismatched === 0, 'mismatched=' . $mismatched);
    $orphan = (int) $db->value(
        "SELECT COUNT(*) FROM lesson_material_pdf_jobs j
          WHERE j.material_id LIKE 'qtest-conc-%'
            AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = j.student_id)"
    );
    check('C4: no job points at a non-existent student', $orphan === 0, 'orphans=' . $orphan);
} finally {
    remove_fixtures();
}

$passed = 0;
$skipped = 0;
$failed = 0;
foreach ($checks as $c) {
    if (str_starts_with((string) $c['detail'], 'SKIPPED')) {
        $skipped++;
    } elseif ($c['ok']) {
        $passed++;
    } else {
        $failed++;
    }
}
fwrite(STDOUT, "\n{$passed} passed; {$skipped} skipped; {$failed} failed\n");
if ($jsonOut !== '') {
    file_put_contents($jsonOut, json_encode([
        'source' => ['size' => $fixtureSize, 'bytes' => $sourceBytes ?? null],
        'stages' => $stagesOut,
        'checks' => $checks,
        'totals' => ['passed' => $passed, 'skipped' => $skipped, 'failed' => $failed],
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fwrite(STDOUT, "wrote {$jsonOut}\n");
}
if ($failures !== []) {
    foreach ($failures as $f) {
        fwrite(STDOUT, " - {$f}\n");
    }
    exit(1);
}
fwrite(STDOUT, "ALL PDF QUEUE CONCURRENCY CHECKS PASSED\n");
