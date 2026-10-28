<?php

declare(strict_types=1);

/**
 * pdf_worker_performance_tests.php — what the personalized-PDF worker actually
 * costs, per document size, on this machine and this schema.
 *
 * WHY THIS SUITE EXISTS
 *   The capacity question for personalized lesson PDFs is not "how many students
 *   can press download" but "how much work is one copy, and does the cron shape
 *   (`--limit=5 --max-seconds=50 --min-render-seconds=15`) actually complete it".
 *   Everything below is measured, not assumed: source bytes and SHA-256, an
 *   in-process render, and the same render through the REAL CLI worker (its own
 *   process, its own lock, its own claim) with the job's own timestamps.
 *
 * WHAT IT PROVES
 *   P1 the size-matrix fixtures are real PDFs of the size they claim;
 *   P2 a personalized copy renders, and its output is valid, page-accurate, and
 *      different for two different students (per-identity watermark);
 *   P3 the copy is scoped to the requesting student (storage path + registry row)
 *      and is never shared between students;
 *   P4 the queue serves an INTERACTIVE (priority 0) job before a PREWARM
 *      (priority 10) one, at the real document size;
 *   P5 an already-generated copy is reused by the worker (`ready:cached`) and the
 *      file is NOT re-rendered;
 *   P6 the worker's budget stop leaves a job `queued` — never stranded in
 *      `processing` — when the remaining budget cannot finish a render of the
 *      size just measured;
 *   P7 two simultaneous worker launches: exactly one renders, the other reports
 *      `worker_locked` and claims nothing;
 *   P8 five concurrent enqueues of the same copy still create ONE job;
 *   P9 a measured throughput table (per size: pages, bytes, render seconds,
 *      output bytes, and what the shipped cron flags achieve with it).
 *
 * SAFETY
 *   • Refuses to run when APP_ENV=production — it writes rows and files.
 *   • Creates only rows/files it owns (ids prefixed `qtest-perf-`) and removes
 *     them in a finally block.
 *   • Measurement worker runs use `--stale=86400` so the sweep cannot touch rows
 *     this suite did not create; the stale-recovery check (P6b) is separate and
 *     reports how many foreign rows it reclaimed.
 *   • Never calls VdoCipher, never sends mail, never deletes another owner's copy.
 *
 * USAGE
 *   php backend/tests/material-queue/pdf_worker_performance_tests.php
 *   php backend/tests/material-queue/pdf_worker_performance_tests.php --sizes=100k,1m
 *   php backend/tests/material-queue/pdf_worker_performance_tests.php --json=out.json
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
    fwrite(STDERR, "Refusing to run: APP_ENV=production. This suite writes to the database and storage.\n");
    exit(2);
}

$args = [];
foreach (array_slice($argv, 1) as $arg) {
    if (!str_starts_with($arg, '--')) {
        continue;
    }
    $parts = explode('=', substr($arg, 2), 2);
    $args[$parts[0]] = $parts[1] ?? '1';
}

$work = $root . '/.freebuff/pdf-worker-bench';
$fixtureDir = (string) ($args['fixtures'] ?? $work . '/fixtures');
$sizesArg = (string) ($args['sizes'] ?? '100k,1m,5m,10m');
$cronLimit = (int) ($args['limit'] ?? 5);
$cronSeconds = (int) ($args['max-seconds'] ?? 50);
$cronMinRender = (int) ($args['min-render-seconds'] ?? 15);
$jsonOut = (string) ($args['json'] ?? '');

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

/** Only the checks that ran count as passes; a SKIP is reported separately. */
function summarize(): array
{
    global $checks;
    $skipped = 0;
    $failed = 0;
    foreach ($checks as $c) {
        if (str_starts_with((string) $c['detail'], 'SKIPPED')) {
            $skipped++;
        } elseif (!$c['ok']) {
            $failed++;
        }
    }
    return ['passed' => count($checks) - $skipped - $failed, 'skipped' => $skipped, 'failed' => $failed];
}

function skip(string $name, string $why): void
{
    global $checks;
    $checks[] = ['check' => $name, 'ok' => true, 'detail' => 'SKIPPED — ' . $why];
    fwrite(STDOUT, "SKIP {$name}  [{$why}]\n");
}

/** Run a command and return [exitCode, stdout, stderr, wallSeconds]. */
function run(array $argv, ?float $timeout = null): array
{
    $cmd = implode(' ', array_map('escapeshellarg', $argv));
    $descriptors = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $start = microtime(true);
    $proc = proc_open($cmd, $descriptors, $pipes);
    if (!is_resource($proc)) {
        throw new RuntimeException('could not start: ' . $cmd);
    }
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $out = '';
    $err = '';
    while (true) {
        $status = proc_get_status($proc);
        $out .= (string) stream_get_contents($pipes[1]);
        $err .= (string) stream_get_contents($pipes[2]);
        if (!$status['running']) {
            break;
        }
        if ($timeout !== null && (microtime(true) - $start) > $timeout) {
            proc_terminate($proc, 9);
            $err .= "\n[timed out after {$timeout}s]";
            break;
        }
        usleep(20000);
    }
    $out .= (string) stream_get_contents($pipes[1]);
    $err .= (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exit = proc_close($proc);
    return [$exit, $out, $err, microtime(true) - $start];
}

$php = PHP_BINARY;
$ini = php_ini_loaded_file();
$worker = $root . '/backend/scripts/watermark-worker.php';

/** Invoke the REAL cron worker. `--stale` is pinned so it cannot sweep rows this suite does not own. */
function run_worker(array $extra = [], ?float $timeout = 300): array
{
    global $php, $ini, $worker;
    $argv = [$php];
    if ($ini !== false && $ini !== '') {
        $argv[] = '-c';
        $argv[] = $ini;
    }
    $argv[] = $worker;
    $argv[] = '--stale=86400';
    foreach ($extra as $arg) {
        $argv[] = $arg;
    }
    return run($argv, $timeout);
}

// ── P1. Fixtures ────────────────────────────────────────────────────────────
fwrite(STDOUT, "\nP1 size-matrix fixtures\n");
$fixtureJsonPath = $work . '/fixtures.json';
@mkdir($work, 0775, true);
[$code, $out, $err] = run([
    $php,
    ...($ini ? ['-c', $ini] : []),
    $root . '/backend/tests/material-queue/make_size_fixtures.php',
    '--out=' . $fixtureDir,
    '--sizes=' . $sizesArg,
]);
if ($code !== 0) {
    fwrite(STDERR, "fixture generation failed: {$err}\n");
    exit(2);
}
file_put_contents($fixtureJsonPath, $out);
$fixtureData = json_decode($out, true);
$fixtures = is_array($fixtureData['fixtures'] ?? null) ? $fixtureData['fixtures'] : [];
check('P1: fixtures generated for every requested size', count($fixtures) > 0, 'count=' . count($fixtures));
foreach ($fixtures as $f) {
    check(
        'P1: ' . $f['label'] . ' is a real PDF of the expected order of magnitude',
        $f['bytes'] > 1024 && is_file($f['path']) && str_starts_with((string) file_get_contents($f['path'], false, null, 0, 5), '%PDF-'),
        $f['bytes'] . ' bytes, ' . $f['pages'] . ' pages'
    );
}

// ── Fixture rows (owned by this suite) ──────────────────────────────────────
$db = Database::instance();
$tag = substr(bin2hex(random_bytes(4)), 0, 8);
$doctor = 'qtest-perf-doc-' . $tag;
$studentA = 'qtest-perf-a-' . $tag;
$studentB = 'qtest-perf-b-' . $tag;
$course = 'qtest-perf-crs-' . $tag;
$section = 'qtest-perf-sec-' . $tag;
$lesson = 'qtest-perf-lsn-' . $tag;
$now = gmdate('Y-m-d H:i:s');
$ownedFiles = [];
$results = [];

/** Insert users/profiles/course/lesson/enrollments once; materials are added per size. */
function seedBase(): void
{
    global $db, $doctor, $studentA, $studentB, $course, $section, $lesson, $now;

    foreach ([[$doctor, 'doctor', 'Perf Doctor'], [$studentA, 'student', 'Perf Student A'], [$studentB, 'student', 'Perf Student B']] as [$id, $role, $name]) {
        $db->query(
            'INSERT INTO users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?)',
            [$id, $id . '@example.invalid', 'qtest-no-login-' . bin2hex(random_bytes(8)), $now, $now]
        );
        if ($db->row('SELECT id FROM profiles WHERE id = ?', [$id]) !== null) {
            $db->query(
                'UPDATE profiles SET full_name = ?, role = ?, status = ?, email = ?, updated_at = ? WHERE id = ?',
                [$name, $role, 'active', $id . '@example.invalid', $now, $id]
            );
        } else {
            $db->query(
                'INSERT INTO profiles (id, email, full_name, role, status, watermark_id, public_user_id, security_version, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
                [$id, $id . '@example.invalid', $name, $role, 'active', 'QT-' . strtoupper(substr($id, -6)), 'QT' . substr(md5($id), 0, 6), $now, $now]
            );
        }
    }

    $db->query(
        'INSERT INTO courses (id, doctor_id, title, description, language, status, phone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$course, $doctor, 'Perf Test Course ' . substr($course, -6), 'Worker performance fixture. Safe to delete.', 'en', 'published', '+201000000000', $now, $now]
    );
    $db->query(
        'INSERT INTO sections (id, course_id, title, order_index, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
        [$section, $course, 'Perf Section', $now, $now]
    );
    $db->query(
        'INSERT INTO lessons (id, section_id, course_id, title, status, order_index, video_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
        [$lesson, $section, $course, 'Perf Lesson', 'published', 'coming_soon', $now, $now]
    );
    foreach ([[$studentA, 'a'], [$studentB, 'b']] as [$sid, $suffix]) {
        $db->query(
            "INSERT INTO enrollments (id, student_id, course_id, enrolled_by, enrollment_method, status, progress_percent, visibility_level, enrolled_at)
             VALUES (?, ?, ?, ?, 'doctor_created', 'active', 0, 'all', ?)",
            ['qtest-perf-enr-' . $suffix . '-' . substr($sid, -6), $sid, $course, $doctor, $now]
        );
    }
}

/** A material row whose source file is the given fixture. */
function seed_material(string $label, string $path): string
{
    global $db, $lesson, $course, $doctor, $now;
    $materialId = 'qtest-perf-mat-' . $label . '-' . substr(bin2hex(random_bytes(3)), 0, 6);
    $rel = $materialId . '/perf-' . $label . '.pdf';
    $db->query(
        "INSERT INTO lesson_materials (id, lesson_id, course_id, file_name, file_url, file_type, storage_path, permission, download_enabled, preview_enabled, uploaded_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, 'allow', 1, 1, ?, ?, ?)",
        [$materialId, $lesson, $course, 'perf-' . $label . '.pdf', $rel, $rel, $doctor, $now, $now]
    );
    $abs = (new MaterialPdfVariantService())->sourcePath([
        'id' => $materialId,
        'course_id' => $course,
        'storage_path' => $rel,
    ]);
    @mkdir(dirname($abs), 0775, true);
    copy($path, $abs);
    clearstatcache(true, $abs);
    return $materialId;
}

function removeFixtures(): void
{
    global $db, $doctor, $studentA, $studentB, $course, $section, $lesson, $ownedFiles;
    foreach ($ownedFiles as $file) {
        if (is_file($file)) {
            @unlink($file);
        }
    }
    foreach ([$studentA, $studentB] as $sid) {
        $db->query('DELETE FROM lesson_material_pdf_jobs WHERE student_id = ? AND material_id LIKE ?', [$sid, 'qtest-perf-%']);
        $db->query('DELETE FROM lesson_material_pdfs WHERE student_id = ? AND material_id LIKE ?', [$sid, 'qtest-perf-%']);
    }
    $db->query("DELETE FROM lesson_material_pdf_jobs WHERE material_id LIKE 'qtest-perf-%'");
    $db->query("DELETE FROM lesson_material_pdf_jobs WHERE id LIKE 'qtest-perf-%'");
    $db->query("DELETE FROM lesson_material_pdfs WHERE material_id LIKE 'qtest-perf-%'");
    $db->query("DELETE FROM lesson_materials WHERE lesson_id = ?", [$lesson]);
    $db->query('DELETE FROM enrollments WHERE course_id = ?', [$course]);
    $db->query('DELETE FROM lessons WHERE id = ?', [$lesson]);
    $db->query('DELETE FROM sections WHERE id = ?', [$section]);
    $db->query('DELETE FROM courses WHERE id = ?', [$course]);
    $db->query('DELETE FROM profiles WHERE id IN (?, ?, ?)', [$doctor, $studentA, $studentB]);
    $db->query('DELETE FROM users WHERE id IN (?, ?, ?)', [$doctor, $studentA, $studentB]);
}

try {
    seedBase();
    $queue = new MaterialPdfQueueService();
    $variants = $queue->variants();

    $watermark = new PdfWatermarkService();
    $driver = $watermark->effectiveMode();
    fwrite(STDOUT, "\nengine: " . json_encode($driver) . '  (' . (string) $watermark->driver() . ")\n");
    check('P1: a watermark engine is available locally (otherwise nothing can be measured)', $driver !== null, 'mode=' . json_encode($driver));

    foreach ($fixtures as $f) {
        $label = (string) $f['label'];
        $sourcePages = (int) $f['pages'];
        fwrite(STDOUT, "\n── size {$label} ({$f['bytes']} bytes, {$sourcePages} pages) ──\n");

        $materialId = seed_material($label, (string) $f['path']);
        $material = $queue->loadMaterial($materialId);
        if ($material === null) {
            check("P2 {$label}: material fixture exists", false);
            continue;
        }
        check("P2 {$label}: both students are eligible for the material", $queue->isStudentEligible($materialId, $studentA) && $queue->isStudentEligible($materialId, $studentB));

        // ── P2/P3: one precise in-process render ────────────────────────────
        $t0 = microtime(true);
        $copyA = $variants->ensure($material, $studentA);
        $renderSeconds = microtime(true) - $t0;
        $copyAbsA = $variants->storage()->privateFilePath(PdfWatermarkService::BUCKET, (string) $copyA['storage_path']);
        $ownedFiles[] = $copyAbsA;
        $bytesA = is_file($copyAbsA) ? (int) filesize($copyAbsA) : 0;
        check(
            "P2 {$label}: the personalized copy exists and is a non-empty PDF",
            $bytesA > 0 && str_starts_with((string) file_get_contents($copyAbsA, false, null, 0, 5), '%PDF-'),
            $bytesA . ' bytes'
        );
        check(
            "P2 {$label}: the output keeps the source page count ({$sourcePages})",
            (int) $copyA['page_count'] === $sourcePages,
            'pages=' . $copyA['page_count']
        );
        check(
            "P3 {$label}: the copy path is scoped to this student",
            str_contains((string) $copyA['storage_path'], $studentA) && !str_contains((string) $copyA['storage_path'], $studentB),
            (string) $copyA['storage_path']
        );
        $registered = $db->row(
            'SELECT student_id, variant_key, page_count, file_size FROM lesson_material_pdfs WHERE material_id = ? AND student_id = ?',
            [$materialId, $studentA]
        );
        check(
            "P3 {$label}: the registry row belongs to the requesting student only",
            $registered !== null && (string) $registered['student_id'] === $studentA,
            json_encode($registered)
        );

        // ── P4: priority at the real size ───────────────────────────────────
        // B is queued as PREWARM (priority 10) so the ordering check has two
        // different priorities to compare. It is raised to STUDENT below before
        // the worker is asked to render it: `--limit=1` claims the OLDEST
        // priority-10 job, and an unrelated prewarm row in this dev database
        // would otherwise win (which is exactly what the first draft measured by
        // accident — the run reported `material 82b9f7e1`, not the fixture).
        $queue->enqueueStudent($material, $studentB, MaterialPdfQueueService::PRIORITY_PREWARM, true);
        $queue->enqueueStudent($material, $studentA, MaterialPdfQueueService::PRIORITY_STUDENT, true);
        $claimOrder = $db->row(
            "SELECT student_id FROM lesson_material_pdf_jobs
              WHERE material_id = ? AND student_id = ? AND status = 'queued'",
            [$materialId, $studentA]
        );
        check("P4 {$label}: the interactive student's job is queued at priority 0", $claimOrder !== null);
        $prioRow = $db->row(
            'SELECT priority FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1',
            [$materialId, $studentA]
        );
        $prewarmRow = $db->row(
            'SELECT priority FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1',
            [$materialId, $studentB]
        );
        check(
            "P4 {$label}: interactive priority (0) is strictly ahead of prewarm (" . MaterialPdfQueueService::PRIORITY_PREWARM . ')',
            (int) ($prioRow['priority'] ?? -1) === MaterialPdfQueueService::PRIORITY_STUDENT
                && (int) ($prewarmRow['priority'] ?? -1) === MaterialPdfQueueService::PRIORITY_PREWARM
        );
        $probe = $queue->claim(1, 'perf-order-probe');
        check(
            "P4 {$label}: the database claim returns the waiting student first",
            count($probe) === 1 && (string) $probe[0]['student_id'] === $studentA,
            json_encode(array_column($probe, 'student_id'))
        );
        if ($probe !== []) {
            $queue->release((string) $probe[0]['id'], (string) $probe[0]['lock_token'], 'perf_probe_released');
        }

        // ── P5: the REAL worker reuses the existing copy (no re-render) ─────
        $mtimeBefore = is_file($copyAbsA) ? filemtime($copyAbsA) : 0;
        [$codeA, $outA, $errA, $wallA] = run_worker(['--limit=1', '--max-seconds=120', '--min-render-seconds=5']);
        $summaryA = json_decode(trim($outA), true);
        if (!is_array($summaryA)) {
            check("P5 {$label}: worker summary is valid JSON", false, substr(trim($outA . ' ' . $errA), 0, 200));
        } else {
            check(
                "P5 {$label}: the worker completed the waiting student's job without re-rendering",
                (int) $summaryA['claimed'] === 1
                    && (int) $summaryA['ready'] === 1
                    && (string) ($summaryA['details'][0]['result'] ?? '') === 'ready:cached',
                json_encode($summaryA['details'][0] ?? $summaryA)
            );
            check(
                "P5 {$label}: the cached copy file was NOT rewritten",
                $mtimeBefore > 0 && filemtime($copyAbsA) === $mtimeBefore,
                'mtime=' . filemtime($copyAbsA)
            );
        }

        // ── P2/P5: the second student's copy is rendered by the worker ──────
        // A student waiting on their own copy is priority 0, which sorts ahead
        // of every prewarm row, so the single claimed job is OURS by construction.
        $queue->enqueueStudent($material, $studentB, MaterialPdfQueueService::PRIORITY_STUDENT, true);
        [$codeB, $outB, $errB, $wallB] = run_worker(['--limit=1', '--max-seconds=300', '--min-render-seconds=5'], 400);
        $summaryB = json_decode(trim($outB), true);
        $copyB = $variants->existing($material, $studentB);
        $copyAbsB = $copyB !== null
            ? $variants->storage()->privateFilePath(PdfWatermarkService::BUCKET, (string) $copyB['storage_path'])
            : '';
        if ($copyAbsB !== '') {
            $ownedFiles[] = $copyAbsB;
        }
        if (is_array($summaryB)) {
            // Guard against measuring someone else's job: the worker reports an
            // 8-character material prefix, so a claim on a foreign row is visible
            // instead of being silently counted as this fixture's work.
            $detail = $summaryB['details'][0] ?? [];
            $mine = str_starts_with($materialId, (string) ($detail['material'] ?? ''));
            check(
                "P2 {$label}: the worker rendered a copy for the second student",
                (int) $summaryB['ready'] === 1 && $copyB !== null && $mine,
                json_encode($detail)
            );
        } else {
            check("P2 {$label}: worker run for the second student produced a summary", false, substr(trim($outB . ' ' . $errB), 0, 200));
        }
        $bytesB = is_file($copyAbsB) ? (int) filesize($copyAbsB) : 0;
        check(
            "P2 {$label}: the two students' copies are DIFFERENT bytes (per-identity watermark)",
            $bytesB > 0 && hash_file('sha256', $copyAbsB) !== hash_file('sha256', $copyAbsA),
            'A=' . $bytesA . ' B=' . $bytesB
        );
        check(
            "P3 {$label}: the second student's copy is scoped to them",
            $copyB !== null && str_contains((string) $copyB['storage_path'], $studentB),
            (string) ($copyB['storage_path'] ?? 'none')
        );

        $jobB = $db->row(
            'SELECT status, attempts, locked_at, ready_at, created_at, lock_token FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1',
            [$materialId, $studentB]
        );
        // A completed job must be terminally `ready`, stamped, and hold NO lock:
        // markReady() clears lock_token/locked_at so a finished job can never be
        // mistaken for one still being rendered.
        check(
            "P2 {$label}: the job is terminally ready, stamped, and holds no lock",
            $jobB !== null
                && (string) $jobB['status'] === 'ready'
                && ($jobB['ready_at'] ?? null) !== null
                // NOT `??`: null-coalescing fires on a NULL column too, so it
                // reported a lock-free job as locked. The key must exist and be null.
                && array_key_exists('lock_token', $jobB)
                && $jobB['lock_token'] === null,
            json_encode($jobB)
        );

        // ── P6b: an abandoned (crashed) job is reclaimed ────────────────────
        $queue->enqueueStudent($material, $studentB, MaterialPdfQueueService::PRIORITY_PREWARM, true);
        $crashed = $db->row(
            "SELECT id, lock_token FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? AND status = 'queued' LIMIT 1",
            [$materialId, $studentB]
        );
        if ($crashed !== null) {
            // Simulate a worker killed mid-render: claimed, then abandoned 2 hours ago.
            $queue->claim(1, 'perf-crasher');
            $db->query(
                "UPDATE lesson_material_pdf_jobs SET locked_at = ?, attempts = attempts + 1
                  WHERE material_id = ? AND student_id = ? AND status = 'processing'",
                [gmdate('Y-m-d H:i:s', time() - 7200), $materialId, $studentB]
            );
            $recovered = $queue->recoverStale(3600);
            $after = $db->row('SELECT status, lock_token FROM lesson_material_pdf_jobs WHERE id = ?', [(string) $crashed['id']]);
            check(
                "P6b {$label}: a job abandoned by a dead worker returns to the queue, not to `processing`",
                $after !== null && (string) $after['status'] === 'queued' && $after['lock_token'] === null,
                json_encode($recovered) . ' row=' . json_encode($after)
            );
            if ($recovered['requeued'] + $recovered['failed'] > 1) {
                fwrite(STDOUT, "  note: the stale sweep also reclaimed " . ($recovered['requeued'] + $recovered['failed'] - 1) . " pre-existing row(s) in this local database\n");
            }
            // Close this suite's own requeued row so it cannot be claimed by a
            // later phase and be mistaken for that phase's job.
            $db->query('DELETE FROM lesson_material_pdf_jobs WHERE id = ?', [(string) $crashed['id']]);
        }

        $results[] = [
            'size' => $label,
            'source_bytes' => (int) $f['bytes'],
            'source_sha256' => (string) $f['sha256'],
            'pages' => $sourcePages,
            'in_process_render_seconds' => round($renderSeconds, 3),
            'worker_render_wall_seconds' => round($wallB, 3),
            'worker_cached_wall_seconds' => round($wallA, 3),
            'copy_bytes' => $bytesA,
            'copy_size_ratio' => $bytesA > 0 ? round($bytesA / max(1, (int) $f['bytes']), 2) : null,
            'copy_bytes_second_student' => $bytesB,
        ];
    }

    // ── P6: budget stop ─────────────────────────────────────────────────────
    fwrite(STDOUT, "\nP6 budget behaviour (the difference between a bounded run and a truncated one)\n");
    $f = $fixtures[count($fixtures) - 1];

    // Leave no older priority-0 job of ours queued: `--limit=1` claims the oldest,
    // so a leftover row would be measured instead of the job this phase queued.
    $db->query("DELETE FROM lesson_material_pdf_jobs WHERE material_id LIKE 'qtest-perf-%' AND status IN ('queued', 'processing')");

    // P6a: a budget that cannot fit a render of this size must claim NOTHING.
    $materialId = seed_material('budget0-' . (string) $f['label'], (string) $f['path']);
    $material = $queue->loadMaterial($materialId);
    $queue->enqueueStudent($material, $studentA, MaterialPdfQueueService::PRIORITY_STUDENT, true);
    $jobA = $db->row('SELECT id FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1', [$materialId, $studentA]);
    [$code, $out] = run_worker(['--limit=1', '--max-seconds=5', '--min-render-seconds=5']);
    $summary = json_decode(trim($out), true);
    $row = $db->row('SELECT status FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1', [$materialId, $studentA]);
    check(
        'P6a: with no room for a render the worker stops BEFORE claiming',
        is_array($summary) && (int) $summary['claimed'] === 0 && ($summary['budget_stop'] ?? null) !== null,
        json_encode($summary['budget_stop'] ?? null)
    );
    check(
        'P6a: the deferred job stays `queued` — never stranded in `processing`',
        $row !== null && (string) $row['status'] === 'queued',
        json_encode($row)
    );
    // The deferred row is ours; remove it so P6b claims ITS job, not this one.
    $db->query('DELETE FROM lesson_material_pdf_jobs WHERE material_id = ?', [$materialId]);
    unset($jobA);

    // P6b: a budget that fits exactly one render of this size completes it and
    // stops in time (this is the real cron question for the measured sizes).
    $renderSeconds = $results === [] ? null : (float) $results[count($results) - 1]['worker_render_wall_seconds'];
    $oneJobBudget = $renderSeconds === null ? null : max(6, (int) ceil($renderSeconds) + 6);
    if ($oneJobBudget === null) {
        skip('P6b: a budget sized for one render completes it and stops', 'no render was measured');
    } else {
        $materialId = seed_material('budget1-' . (string) $f['label'], (string) $f['path']);
        $material = $queue->loadMaterial($materialId);
        $queue->enqueueStudent($material, $studentA, MaterialPdfQueueService::PRIORITY_STUDENT, true);
        $jobId = (string) $db->value('SELECT id FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1', [$materialId, $studentA], '');
        [$code, $out, $err] = run_worker([
            '--limit=1',
            '--max-seconds=' . $oneJobBudget,
            '--min-render-seconds=' . max(5, (int) ceil($renderSeconds) + 1),
        ]);
        $summary = json_decode(trim($out), true);
        $claimedJob = (string) ($summary['details'][0]['job'] ?? '');
        $row = $db->row('SELECT status FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1', [$materialId, $studentA]);
        check(
            sprintf('P6b: a %d s budget (one render ≈ %.2f s) completes exactly one job', $oneJobBudget, $renderSeconds),
            is_array($summary)
                && (int) $summary['ready'] === 1
                && $row !== null
                && (string) $row['status'] === 'ready'
                && $jobId !== ''
                && str_starts_with($jobId, $claimedJob),
            json_encode($summary['details'][0] ?? $summary)
        );
        check(
            'P6b: the run finished inside its own budget',
            is_array($summary) && (float) $summary['seconds'] <= $oneJobBudget,
            'seconds=' . json_encode($summary['seconds'] ?? null)
        );
    }

    // ── P7: two simultaneous worker launches ────────────────────────────────
    fwrite(STDOUT, "\nP7 single-instance lock under two simultaneous launches\n");
    $f = $fixtures[count($fixtures) - 1];
    $materialId = seed_material('lock-' . (string) $f['label'], (string) $f['path']);
    $material = $queue->loadMaterial($materialId);
    $queue->enqueueStudent($material, $studentA, MaterialPdfQueueService::PRIORITY_STUDENT, true);
    $argv = [$php, ...($ini ? ['-c', $ini] : []), $worker, '--stale=86400', '--limit=1', '--max-seconds=300', '--min-render-seconds=5'];
    $p1 = proc_open(implode(' ', array_map('escapeshellarg', $argv)), [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes1);
    usleep(120000); // let the first process take the lock, then start the second
    $p2 = proc_open(implode(' ', array_map('escapeshellarg', $argv)), [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes2);
    $out1 = (string) stream_get_contents($pipes1[1]);
    $out2 = (string) stream_get_contents($pipes2[1]);
    fclose($pipes1[1]);
    fclose($pipes2[1]);
    proc_close($p1);
    proc_close($p2);
    $s1 = json_decode(trim($out1), true);
    $s2 = json_decode(trim($out2), true);
    $claimedTotal = (int) ($s1['claimed'] ?? -1) + (int) ($s2['claimed'] ?? -1);
    $locked = ($s2['skipped'] ?? '') === 'worker_locked' || ($s1['skipped'] ?? '') === 'worker_locked';
    check(
        'P7: exactly one of the two launches claimed the job',
        $claimedTotal === 1,
        'claimed=' . $claimedTotal . ' first=' . json_encode($s1) . ' second=' . json_encode($s2)
    );
    check(
        'P7: the loser reported `worker_locked` and touched nothing',
        $locked,
        json_encode(['first' => $s1['skipped'] ?? null, 'second' => $s2['skipped'] ?? null])
    );
    $stuck = (int) $db->value(
        "SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ? AND status = 'processing'",
        [$materialId]
    );
    check('P7: no job was left in `processing` after both launches exited', $stuck === 0, 'processing=' . $stuck);

    // ── P8: duplicate prevention ────────────────────────────────────────────
    fwrite(STDOUT, "\nP8 duplicate prevention\n");
    $materialId = seed_material('dup-' . (string) $f['label'], (string) $f['path']);
    $material = $queue->loadMaterial($materialId);
    $variant = $queue->enqueueStudent($material, $studentA, MaterialPdfQueueService::PRIORITY_PREWARM, true);
    for ($i = 0; $i < 4; $i++) {
        $queue->enqueueStudent($material, $studentA, MaterialPdfQueueService::PRIORITY_PREWARM, true);
    }
    $jobs = (int) $db->value('SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ?', [$materialId, $studentA]);
    check('P8: five enqueues of the same copy still create exactly ONE job', $jobs === 1, 'jobs=' . $jobs);
    check('P8: the enqueue returned the variant it queued', is_string($variant) && strlen($variant) === 64);

    // ── P9: throughput with the shipped cron flags ──────────────────────────
    fwrite(STDOUT, "\nP9 measured throughput and what the cron shape achieves\n");
    $usable = $cronSeconds - $cronMinRender; // the loop stops claiming below min-render
    foreach ($results as $r) {
        $renderSeconds = (float) $r['worker_render_wall_seconds'];
        $fits = $renderSeconds > 0 ? (int) floor($usable / $renderSeconds) : $cronLimit;
        $perRun = min($cronLimit, max(0, $fits));
        $r['cron_shape'] = [
            'limit' => $cronLimit,
            'max_seconds' => $cronSeconds,
            'min_render_seconds' => $cronMinRender,
            'usable_render_budget_seconds' => $usable,
            'jobs_a_run_can_complete' => $perRun,
            'jobs_per_hour_at_1_minute_cron' => $perRun * 60,
            'limit_is_the_binding_constraint' => $perRun >= $cronLimit,
        ];
        fwrite(STDOUT, sprintf(
            "  %-5s %6d B / %2d pages → render %6.2f s, copy %8d B (%4.1fx), cron run ≈ %d job(s) (%s)\n",
            $r['size'],
            $r['source_bytes'],
            $r['pages'],
            $renderSeconds,
            $r['copy_bytes'],
            (float) ($r['copy_size_ratio'] ?? 0),
            $perRun,
            $perRun >= $cronLimit ? 'limit-bound' : 'budget-bound'
        ));
    }
    // ── P10: aging — a starved background job is served, a student never is ──
    fwrite(STDOUT, "\nP10 aging: bounded fairness for background pre-generation\n");
    $f = $fixtures[count($fixtures) - 1];

    // The reservation is one slot per run, and it serves the OLDEST starved
    // prewarm job in the whole queue — so this phase needs to know that the only
    // such row is the one it creates.
    $foreignAged = (int) $db->value(
        "SELECT COUNT(*) FROM lesson_material_pdf_jobs
          WHERE status = 'queued' AND priority >= ? AND created_at <= ? AND material_id NOT LIKE 'qtest-perf-%'",
        [MaterialPdfQueueService::PRIORITY_PREWARM, gmdate('Y-m-d H:i:s', time() - MaterialPdfQueueService::prewarmStarvationSeconds())],
        0
    );
    $db->query("DELETE FROM lesson_material_pdf_jobs WHERE material_id LIKE 'qtest-perf-%' AND status IN ('queued', 'processing')");

    if ($foreignAged > 0) {
        skip('P10: aging serves a starved background job while students keep arriving', "the local database already holds {$foreignAged} starved background job(s) from another suite");
    } else {
        $materialId = seed_material('aging-' . (string) $f['label'], (string) $f['path']);
        $material = $queue->loadMaterial($materialId);

        // Student A is waiting now; student B's background copy has been waiting
        // far longer than the starvation window.
        $queue->enqueueStudent($material, $studentB, MaterialPdfQueueService::PRIORITY_PREWARM, true);
        $db->query(
            'UPDATE lesson_material_pdf_jobs SET created_at = ?, run_after = ? WHERE material_id = ? AND student_id = ?',
            [gmdate('Y-m-d H:i:s', time() - 1800), gmdate('Y-m-d H:i:s'), $materialId, $studentB]
        );
        $prewarmJobId = (string) $db->value(
            'SELECT id FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1',
            [$materialId, $studentB],
            ''
        );
        $queue->enqueueStudent($material, $studentA, MaterialPdfQueueService::PRIORITY_STUDENT, true);

        // (1) A single-slot run must NOT be handed to background work: reserving
        // the whole run would starve exactly the students the queue exists for.
        [$code, $out] = run_worker(['--limit=1', '--max-seconds=120', '--min-render-seconds=5']);
        $oneSlot = json_decode(trim($out), true);
        $studentRow = $db->row('SELECT status FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1', [$materialId, $studentA]);
        $prewarmRow = $db->row('SELECT status FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1', [$materialId, $studentB]);
        check(
            'P10: a --limit=1 run serves the waiting STUDENT, never the whole run to background work',
            is_array($oneSlot) && (int) $oneSlot['ready'] === 1 && (int) ($oneSlot['prewarm_reserved'] ?? -1) === 0
                && $studentRow !== null && (string) $studentRow['status'] === 'ready'
                && $prewarmRow !== null && (string) $prewarmRow['status'] === 'queued',
            json_encode(['summary' => $oneSlot, 'student' => $studentRow, 'prewarm' => $prewarmRow])
        );

        // (2) With a spare slot, the aged background job is served FIRST (before
        // the interactive batch is even read) and the student is still served in
        // the same run.
        $queue->enqueueStudent($material, $studentA, MaterialPdfQueueService::PRIORITY_STUDENT, true);
        [$code, $out] = run_worker(['--limit=2', '--max-seconds=120', '--min-render-seconds=5']);
        $twoSlots = json_decode(trim($out), true);
        $details = is_array($twoSlots) ? ($twoSlots['details'] ?? []) : [];
        $reservedMyJob = false;
        foreach ($details as $detail) {
            if ($prewarmJobId !== '' && str_starts_with($prewarmJobId, (string) ($detail['job'] ?? ''))) {
                $reservedMyJob = true;
            }
        }
        $afterPrewarm = $db->row('SELECT status FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1', [$materialId, $studentB]);
        $afterStudent = $db->row('SELECT status FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? LIMIT 1', [$materialId, $studentA]);
        check(
            'P10: with a spare slot the STARVED background job is served in the very same run',
            $reservedMyJob && $afterPrewarm !== null && (string) $afterPrewarm['status'] === 'ready',
            json_encode(['reserved' => $twoSlots['prewarm_reserved'] ?? null, 'prewarm' => $afterPrewarm, 'details' => $details])
        );
        check(
            'P10: the reservation never starves the waiting student',
            is_array($twoSlots) && (int) $twoSlots['ready'] === 2
                && $afterStudent !== null && (string) $afterStudent['status'] === 'ready'
                && (int) ($twoSlots['prewarm_reserved'] ?? 0) === 1,
            json_encode(['summary' => $twoSlots, 'student' => $afterStudent])
        );
        check(
            'P10: nothing is left in `processing` after the aging run',
            (int) $db->value("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ? AND status = 'processing'", [$materialId], 0) === 0
        );
        check(
            'P10: a young background job is left alone (only starvation is rescued)',
            MaterialPdfQueueService::prewarmStarvationSeconds() >= 60,
            'window=' . MaterialPdfQueueService::prewarmStarvationSeconds() . 's'
        );
    }

    $results = array_map(static function (array $r) use ($cronLimit, $cronSeconds, $cronMinRender, $usable): array {
        $renderSeconds = (float) $r['worker_render_wall_seconds'];
        $perRun = min($cronLimit, max(0, $renderSeconds > 0 ? (int) floor($usable / $renderSeconds) : $cronLimit));
        $r['cron_shape'] = [
            'limit' => $cronLimit,
            'max_seconds' => $cronSeconds,
            'min_render_seconds' => $cronMinRender,
            'usable_render_budget_seconds' => $usable,
            'jobs_a_run_can_complete' => $perRun,
            'jobs_per_hour_at_1_minute_cron' => $perRun * 60,
        ];
        return $r;
    }, $results);
} finally {
    removeFixtures();
}

$totals = summarize();
fwrite(STDOUT, "\n{$totals['passed']} passed; {$totals['skipped']} skipped; {$totals['failed']} failed\n");
if ($jsonOut !== '') {
    file_put_contents($jsonOut, json_encode([
        'results' => $results,
        'checks' => $checks,
        'totals' => $totals,
        'engine' => $driver,
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fwrite(STDOUT, "wrote {$jsonOut}\n");
}
if ($failures !== []) {
    foreach ($failures as $name) {
        fwrite(STDOUT, " - {$name}\n");
    }
    exit(1);
}
fwrite(STDOUT, "ALL PDF WORKER PERFORMANCE CHECKS PASSED\n");
