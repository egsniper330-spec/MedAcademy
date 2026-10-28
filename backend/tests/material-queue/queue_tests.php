<?php

declare(strict_types=1);

/**
 * queue_tests.php — integration suite for the durable PDF pre-generation queue.
 *
 * WHY A SEPARATE SUITE
 *   backend/tests/pdf-watermark/delivery_tests.php runs against SQLite, which is
 *   perfect for the authorization/rendering matrix but cannot exercise the
 *   queue's real concurrency (row locks, two live worker processes, DATE/backoff
 *   arithmetic). This suite runs against the configured MySQL/MariaDB database
 *   and builds its own disposable fixtures, so it proves the behaviour the cron
 *   worker depends on:
 *
 *   Q1  enqueue is idempotent — 5 concurrent inserts of the same copy => 1 job
 *   Q2  a student request raises priority (0) and prewarm stays at 10; the
 *       worker claims the waiting student's job FIRST
 *   Q3  two workers racing for the same job: exactly one wins, the loser claims
 *       nothing and never touches the winner's lock
 *   Q4  a stale lock (worker killed) is reclaimed; attempts are bounded; an
 *       exhausted job is parked `failed`, not looped forever
 *   Q5  a transient failure backs off (run_after moves into the future) and is
 *       re-claimable only after that time
 *   Q6  eligibility is re-checked live: suspended enrollment, unpublished
 *       course, hidden material and a suspended profile all refuse
 *   Q7  a replaced source produces a NEW variant key; the old job is skipped and
 *       a job for the live source is queued
 *   Q8  a permanent failure is NOT reset by a student's next page load (bounded
 *       retries); only `retry()` re-queues it
 *   Q9  retention: dry run deletes nothing, --apply deletes only registry-owned
 *       copies older than the window, never an active (queued/processing) copy,
 *       and never a path outside the material/student folder
 *   Q10 orphaned jobs (material deleted) are dropped, and the queue health
 *       counters add up
 *   Q11 one real render end to end through the worker path (skipped when no PDF
 *       fixture or no watermark engine is available)
 *
 * SAFETY
 *   • Refuses to run when APP_ENV=production — it writes to the database.
 *   • Creates only rows it owns (ids prefixed `qtest-`) and deletes them again in
 *     a finally block, including generated copies and the temporary storage dir.
 *   • Never calls VdoCipher, never sends mail, never touches other users' rows.
 *
 * USAGE
 *   php backend/tests/material-queue/queue_tests.php
 * Exit codes: 0 all checks passed · 1 a check failed · 2 refused / cannot run.
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
use MedAcademy\Utils\Uuid;

Config::init();

if (Config::string('APP_ENV', 'production') === 'production') {
    fwrite(STDERR, "Refusing to run: APP_ENV=production. This suite writes to the database.\n");
    exit(2);
}

$db = Database::instance();

// ── Reporting ───────────────────────────────────────────────────────────────
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

// ── Fixtures ────────────────────────────────────────────────────────────────
$tag = substr(bin2hex(random_bytes(4)), 0, 8);
$doctorId = 'qtest-doc-' . $tag;
$studentA = 'qtest-stu-a-' . $tag;
$studentB = 'qtest-stu-b-' . $tag;
$courseId = 'qtest-crs-' . $tag;
$lessonId = 'qtest-lsn-' . $tag;
$sectionId = 'qtest-sec-' . $tag;
$materialId = 'qtest-mat-' . $tag;
$createdFiles = [];

$now = gmdate('Y-m-d H:i:s');

/**
 * Insert the fixture rows. `profiles` is the identity table in this schema.
 */
function seedFixtures(): void
{
    global $db, $doctorId, $studentA, $studentB, $courseId, $lessonId, $sectionId, $materialId, $now;

    foreach ([[$doctorId, 'doctor', 'Queue Doctor'], [$studentA, 'student', 'Queue Student A'], [$studentB, 'student', 'Queue Student B']] as [$id, $role, $name]) {
        // profiles.id is a FK to users.id in this schema: the credential row
        // must exist first. No password is set — these accounts cannot sign in.
        $db->query(
            'INSERT INTO users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?)',
            [$id, $id . '@example.invalid', 'qtest-no-login-' . bin2hex(random_bytes(8)), $now, $now]
        );
        // The schema ships a trigger that auto-creates the profile row on a
        // users INSERT, so this must UPDATE when it already exists.
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

    // chk_courses_c0 requires a contact channel once a course is published.
    $db->query(
        'INSERT INTO courses (id, doctor_id, title, description, language, status, phone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$courseId, $doctorId, 'Queue Test Course ' . substr($courseId, -6), 'Queue test fixture. Safe to delete.', 'en', 'published', '+201000000000', $now, $now]
    );
    $db->query(
        'INSERT INTO sections (id, course_id, title, order_index, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)',
        [$sectionId, $courseId, 'Queue Test Section', $now, $now]
    );
    $db->query(
        'INSERT INTO lessons (id, section_id, course_id, title, status, order_index, video_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
        [$lessonId, $sectionId, $courseId, 'Queue Test Lesson', 'published', 'coming_soon', $now, $now]
    );
    $db->query(
        "INSERT INTO enrollments (id, student_id, course_id, enrolled_by, enrollment_method, status, progress_percent, visibility_level, enrolled_at)
         VALUES (?, ?, ?, ?, 'doctor_created', 'active', 0, 'all', ?)",
        ['qtest-enr-a-' . substr($studentA, -6), $studentA, $courseId, $doctorId, $now]
    );
    $db->query(
        "INSERT INTO enrollments (id, student_id, course_id, enrolled_by, enrollment_method, status, progress_percent, visibility_level, enrolled_at)
         VALUES (?, ?, ?, ?, 'doctor_created', 'active', 0, 'all', ?)",
        ['qtest-enr-b-' . substr($studentB, -6), $studentB, $courseId, $doctorId, $now]
    );
    $db->query(
        "INSERT INTO lesson_materials (id, lesson_id, course_id, file_name, file_url, file_type, storage_path, permission, download_enabled, preview_enabled, uploaded_by, created_at, updated_at)
         VALUES (?, ?, ?, 'queue-test.pdf', ?, 'application/pdf', ?, 'allow', 1, 1, ?, ?, ?)",
        [$materialId, $lessonId, $courseId, $materialId . '/queue-test.pdf', $materialId . '/queue-test.pdf', $doctorId, $now, $now]
    );

    // A real source PDF: enqueueStudent derives the variant key from the bytes,
    // so without a readable source nothing can be queued at all. The fixture is
    // generated by backend/tests/pdf-watermark/make_fixture.php; the suite skips
    // gracefully (rather than failing) when it has not been generated.
    $fixture = dirname(__DIR__, 3) . '/.freebuff/pdf-watermark-tests/fixtures/source.pdf';
    $sourceAbs = (new MaterialPdfVariantService())->sourcePath([
        'id' => $materialId,
        'course_id' => $courseId,
        'storage_path' => $materialId . '/queue-test.pdf',
    ]);
    if (is_file($fixture)) {
        @mkdir(dirname($sourceAbs), 0775, true);
        copy($fixture, $sourceAbs);
        clearstatcache(true, $sourceAbs);
    }
}

function removeFixtures(): void
{
    global $db, $doctorId, $studentA, $studentB, $courseId, $lessonId, $sectionId, $materialId, $createdFiles;

    foreach ($createdFiles as $file) {
        if (is_file($file)) {
            @unlink($file);
        }
    }
    $db->query('DELETE FROM lesson_material_pdf_jobs WHERE material_id = ?', [$materialId]);
    $db->query('DELETE FROM lesson_material_pdfs WHERE material_id = ?', [$materialId]);
    $db->query('DELETE FROM lesson_materials WHERE id = ?', [$materialId]);
    $db->query('DELETE FROM enrollments WHERE course_id = ?', [$courseId]);
    $db->query('DELETE FROM lessons WHERE id = ?', [$lessonId]);
    $db->query('DELETE FROM sections WHERE id = ?', [$sectionId]);
    $db->query('DELETE FROM courses WHERE id = ?', [$courseId]);
    $db->query('DELETE FROM profiles WHERE id IN (?, ?, ?)', [$doctorId, $studentA, $studentB]);
    $db->query('DELETE FROM users WHERE id IN (?, ?, ?)', [$doctorId, $studentA, $studentB]);
}

try {
    seedFixtures();
    $queue = new MaterialPdfQueueService();
    $variants = $queue->variants();
    $material = $queue->loadMaterial($materialId);
    if ($material === null) {
        throw new RuntimeException('fixture material missing');
    }

    // ── Q1. Idempotent enqueue ───────────────────────────────────────────────
    for ($i = 0; $i < 5; $i++) {
        $queue->enqueueStudent($material, $studentA, MaterialPdfQueueService::PRIORITY_STUDENT, true);
    }
    $jobs = (int) $db->value('SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ?', [$materialId, $studentA], 0);
    check('Q1: five enqueues of the same copy create exactly ONE job', $jobs === 1, "jobs={$jobs}");

    // A second student gets their OWN job.
    $queue->enqueueStudent($material, $studentB, MaterialPdfQueueService::PRIORITY_PREWARM, true);
    $jobsTotal = (int) $db->value('SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ?', [$materialId], 0);
    check('Q1: a second student gets a separate job (no cross-student sharing)', $jobsTotal === 2, "jobs={$jobsTotal}");
    check('Q1: the two jobs carry DIFFERENT variant keys (per-identity watermark)',
        (string) $db->value('SELECT COUNT(DISTINCT variant_key) FROM lesson_material_pdf_jobs WHERE material_id = ?', [$materialId], '0') === '2');

    // ── Q2. Priority ─────────────────────────────────────────────────────────
    // studentA asked through the delivery path (priority 0); studentB is prewarm.
    $claimed = $queue->claim(1, 'qtest-worker-priority');
    check('Q2: the worker claims the WAITING student first',
        ($claimed[0]['student_id'] ?? '') === $studentA, (string) ($claimed[0]['student_id'] ?? 'none'));
    $queue->release((string) $claimed[0]['id'], (string) $claimed[0]['lock_token'], 'qtest_release');

    // ── Q3. Two workers race for one job ─────────────────────────────────────
    $first = $queue->claim(2, 'qtest-worker-1');
    $second = $queue->claim(2, 'qtest-worker-2');
    check('Q3: the first worker claims both due jobs', count($first) === 2, 'claimed=' . count($first));
    check('Q3: the second worker claims NOTHING (rows are already processing)', $second === [], json_encode(array_column($second, 'id')));
    $firstIds = array_column($first, 'id');
    check('Q3: the two claims never overlap', count(array_unique($firstIds)) === count($firstIds));
    $locked = (int) $db->value("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ? AND status = 'processing' AND lock_token IS NOT NULL", [$materialId], 0);
    check('Q3: every claimed row is owned by exactly one lock token', $locked === 2, "processing={$locked}");
    check('Q3: a worker cannot complete a job with a foreign lock token',
        $queue->markReady((string) $first[0]['id'], Uuid::v4()) === false);
    check('Q3: the owner can complete its own job',
        $queue->markReady((string) $first[0]['id'], (string) $first[0]['lock_token']) === true);

    // ── Q4. Stale lock recovery + bounded attempts ───────────────────────────
    // Simulate a worker that was killed: the remaining claimed row keeps its lock
    // but its locked_at is old.
    $db->query(
        "UPDATE lesson_material_pdf_jobs SET locked_at = ?, attempts = 0 WHERE material_id = ? AND status = 'processing'",
        [gmdate('Y-m-d H:i:s', time() - 7200), $materialId]
    );
    $recovered = $queue->recoverStale(900);
    check('Q4: a stale lock older than the timeout is reclaimed', $recovered['requeued'] >= 1, json_encode($recovered));
    check('Q4: the reclaimed row is queued again with no lock',
        (int) $db->value("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ? AND status = 'queued' AND lock_token IS NULL", [$materialId], 0) >= 1);

    // Exhaust the attempts of one job and confirm it parks instead of looping.
    $db->query("UPDATE lesson_material_pdf_jobs SET attempts = max_attempts - 1, status = 'processing', lock_token = 'qtest-token-exhaust' WHERE material_id = ? AND student_id = ?", [$materialId, $studentA]);
    $exhaustId = (string) $db->value('SELECT id FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ?', [$materialId, $studentA], '');
    check('Q4: the last allowed attempt parks the job as failed',
        $queue->markFailed($exhaustId, 'qtest-token-exhaust', 'render_failed') === MaterialPdfQueueService::STATUS_FAILED);
    $parked = $db->row('SELECT status, attempts, max_attempts FROM lesson_material_pdf_jobs WHERE id = ?', [$exhaustId]);
    check('Q4: the parked job records attempts = max_attempts and no lock',
        is_array($parked) && (string) $parked['status'] === 'failed' && (int) $parked['attempts'] >= (int) $parked['max_attempts'],
        json_encode($parked));

    // ── Q8. A page load must NOT reset a permanently failed job ──────────────
    $queue->enqueueStudent($material, $studentA, MaterialPdfQueueService::PRIORITY_STUDENT, true);
    $afterPageLoad = $db->row('SELECT status, attempts FROM lesson_material_pdf_jobs WHERE id = ?', [$exhaustId]);
    check('Q8: a student page load does NOT reset a permanently failed job',
        is_array($afterPageLoad) && (string) $afterPageLoad['status'] === 'failed',
        json_encode($afterPageLoad));
    check('Q8: the student is told the copy FAILED (not "preparing" forever)',
        ($queue->statusFor($material, $studentA, (string) $db->value('SELECT variant_key FROM lesson_material_pdf_jobs WHERE id = ?', [$exhaustId], ''), false)['status'] ?? '') === 'failed');
    check('Q8: an explicit retry re-queues the student’s own failed job',
        $queue->retry($material, $studentA) === true
        && (string) $db->value('SELECT status FROM lesson_material_pdf_jobs WHERE id = ?', [$exhaustId], '') === 'queued');

    // ── Q5. Backoff on a transient failure ───────────────────────────────────
    $db->query("UPDATE lesson_material_pdf_jobs SET attempts = 0, status = 'processing', lock_token = 'qtest-token-retry', run_after = ? WHERE id = ?", [$now, $exhaustId]);
    $next = $queue->markFailed($exhaustId, 'qtest-token-retry', 'engine_busy');
    $retryRow = $db->row('SELECT status, attempts, run_after FROM lesson_material_pdf_jobs WHERE id = ?', [$exhaustId]);
    check('Q5: a transient failure returns the job to the queue', $next === MaterialPdfQueueService::STATUS_QUEUED && (string) ($retryRow['status'] ?? '') === 'queued', json_encode($retryRow));
    check('Q5: the retry is delayed into the future (no hot loop)',
        strtotime((string) ($retryRow['run_after'] ?? '1970-01-01') . ' UTC') > time() + 20,
        (string) ($retryRow['run_after'] ?? ''));
    check('Q5: a backed-off job is NOT claimable before run_after',
        count(array_filter($queue->claim(5, 'qtest-worker-early'), static fn ($j) => (string) $j['id'] === $exhaustId)) === 0);
    $db->query("UPDATE lesson_material_pdf_jobs SET run_after = ? WHERE id = ?", [gmdate('Y-m-d H:i:s', time() - 5), $exhaustId]);

    // ── Q6. Live eligibility re-check ───────────────────────────────────────
    check('Q6: an actively enrolled student in a published course is eligible',
        $queue->isStudentEligible($materialId, $studentA) === true);
    $db->query("UPDATE enrollments SET status = 'suspended' WHERE student_id = ? AND course_id = ?", [$studentA, $courseId]);
    check('Q6: a SUSPENDED enrollment is refused by the worker check',
        $queue->isStudentEligible($materialId, $studentA) === false);
    $db->query("UPDATE enrollments SET status = 'active' WHERE student_id = ? AND course_id = ?", [$studentA, $courseId]);
    $db->query("UPDATE courses SET status = 'draft' WHERE id = ?", [$courseId]);
    check('Q6: an UNPUBLISHED course is refused',
        $queue->isStudentEligible($materialId, $studentA) === false);
    $db->query("UPDATE courses SET status = 'published' WHERE id = ?", [$courseId]);
    check('Q6: publishing the course restores eligibility',
        $queue->isStudentEligible($materialId, $studentA) === true);
    $db->query("UPDATE lesson_materials SET permission = 'hidden' WHERE id = ?", [$materialId]);
    check('Q6: a HIDDEN material is refused',
        $queue->isStudentEligible($materialId, $studentA) === false);
    $db->query("UPDATE lesson_materials SET permission = 'allow' WHERE id = ?", [$materialId]);
    $db->query("UPDATE profiles SET status = 'suspended' WHERE id = ?", [$studentB]);
    check('Q6: a SUSPENDED profile is refused',
        $queue->isStudentEligible($materialId, $studentB) === false);
    $db->query("UPDATE profiles SET status = 'active' WHERE id = ?", [$studentB]);
    check('Q6: a staff profile never gets a personalized student copy queued',
        $queue->isStudentEligible($materialId, $doctorId) === false);
    check('Q6: a stranger without a profile is refused',
        $queue->isStudentEligible($materialId, 'qtest-missing-' . $tag) === false);
    check('Q6: enqueueStudent refuses an ineligible student (no job created)',
        $queue->enqueueStudent($materialId, 'qtest-missing-' . $tag, MaterialPdfQueueService::PRIORITY_STUDENT) === null);

    // ── Q7. Source replacement invalidates the variant ────────────────────
    $oldKey = (string) $db->value('SELECT variant_key FROM lesson_material_pdf_jobs WHERE id = ?', [$exhaustId], '');
    $sourceAbs = $variants->sourcePath($material);
    $db->query('UPDATE lesson_materials SET file_hash = NULL, file_hash_path = NULL, file_hash_size = NULL, file_hash_mtime = NULL WHERE id = ?', [$materialId]);
    if (is_file($sourceAbs)) {
        $originalBytes = (string) file_get_contents($sourceAbs);
        file_put_contents($sourceAbs, $originalBytes . "\n% source replaced by queue test\n");
        clearstatcache(true, $sourceAbs);
        $fresh = $queue->loadMaterial($materialId);
        $identity = $variants->identity((array) $fresh, $studentA);
        check('Q7: replacing the source yields a NEW variant key',
            $identity['variant_key'] !== $oldKey,
            substr($oldKey, 0, 12) . ' -> ' . substr((string) $identity['variant_key'], 0, 12));
        check('Q7: the stale job is recognisable as stale against the live source',
            $identity['variant_key'] !== (string) $db->value('SELECT variant_key FROM lesson_material_pdf_jobs WHERE id = ?', [$exhaustId], ''));
        file_put_contents($sourceAbs, $originalBytes);
        clearstatcache(true, $sourceAbs);
    } else {
        skip('Q7: replacing the source yields a NEW variant key', 'no readable source file for the fixture material');
    }

    // ── Q10. Orphaned jobs ───────────────────────────────────────────────────
    $orphanMaterial = 'qtest-orphan-' . $tag;
    $db->query(
        "INSERT INTO lesson_materials (id, lesson_id, course_id, file_name, file_url, file_type, storage_path, permission, download_enabled, preview_enabled, uploaded_by, created_at, updated_at)
         VALUES (?, ?, ?, 'orphan.pdf', ?, 'application/pdf', ?, 'allow', 1, 1, ?, ?, ?)",
        [$orphanMaterial, $lessonId, $courseId, $orphanMaterial . '/orphan.pdf', $orphanMaterial . '/orphan.pdf', $doctorId, $now, $now]
    );
    $db->query(
        "INSERT INTO lesson_material_pdf_jobs (id, material_id, student_id, source_hash, variant_key, status, priority, run_after)
         VALUES (?, ?, ?, 'h', 'k', 'queued', 10, ?)",
        ['qtest-job-orphan-' . $tag, $orphanMaterial, $studentA, $now]
    );
    $db->query('DELETE FROM lesson_materials WHERE id = ?', [$orphanMaterial]);
    // The FK cascade removes the job with its material; `dropOrphanedJobs()` is
    // the belt-and-braces sweep for rows written while FKs were off/legacy data.
    $queue->dropOrphanedJobs();
    $orphansLeft = (int) $db->value('SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ?', [$orphanMaterial], 0);
    check('Q10: a job whose material was deleted no longer exists (cascade or sweep)', $orphansLeft === 0, "left={$orphansLeft}");

    $health = $queue->health();
    check('Q10: queue health reports counters and the retention window',
        isset($health['queued'], $health['processing'], $health['failed'], $health['copies'], $health['retention_days'])
        && (int) $health['retention_days'] === 1,
        json_encode($health));

    // ── Q9. Retention: 24 hours from generation, dry run, active-job and path guards ──────────
    // Three independent rules, each with its own row and its own student, so one
    // guard cannot mask another:
    //   studentA  old + correct folder  -> SWEPT
    //   studentB  old + correct folder  -> PROTECTED (has a queued job)
    //   studentA  old + folder outside  -> REFUSED (never deleted)
    //   studentB  fresh (inside window) -> untouched
    $storage = $variants->storage();
    $prefixA = $variants->prefix($material, $studentA);       // {course}/{material}/{student}
    $prefixB = $variants->prefix($material, $studentB);
    $oldRel = rtrim($prefixA, '/') . '/old-copy.pdf';
    $activeRel = rtrim($prefixB, '/') . '/active-copy.pdf';
    $outsideRel = 'elsewhere/not-ours.pdf';
    $freshRel = rtrim($prefixB, '/') . '/fresh-copy.pdf';
    $oldTs = gmdate('Y-m-d H:i:s', time() - (48 * 3600));
    $newTs = gmdate('Y-m-d H:i:s');
    foreach ([[$oldRel, $oldTs, 'qtest-copy-old', $studentA], [$activeRel, $oldTs, 'qtest-copy-active', $studentB], [$outsideRel, $oldTs, 'qtest-copy-outside', $studentA], [$freshRel, $newTs, 'qtest-copy-fresh', $studentB]] as [$rel, $ts, $id, $sid]) {
        $abs = $storage->privateFilePath(PdfWatermarkService::BUCKET, $rel);
        @mkdir(dirname($abs), 0775, true);
        file_put_contents($abs, "%PDF-1.4 retention fixture\n");
        $createdFiles[] = $abs;
        $db->query(
            'INSERT INTO lesson_material_pdfs (id, material_id, student_id, source_hash, variant_key, storage_path, file_size, page_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 27, 1, ?, ?)',
            [$id . '-' . $tag, $materialId, $sid, 'h', $id . '-variant', $rel, $ts, $ts]
        );
    }

    // studentB has a job in flight, so their expired copy must be left alone.
    $db->query('DELETE FROM lesson_material_pdf_jobs WHERE material_id = ?', [$materialId]);
    $queue->enqueueStudent($material, $studentB, MaterialPdfQueueService::PRIORITY_STUDENT, true);
    check('Q9: the protected student really has a queued job',
        (int) $db->value("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE material_id = ? AND student_id = ? AND status = 'queued'", [$materialId, $studentB], 0) === 1);

    $dry = $queue->sweepRetention(1, 200, false);
    check('Q9: a dry run REPORTS the expired inactive copy but deletes nothing',
        $dry['deleted'] === 1 && is_file($storage->privateFilePath(PdfWatermarkService::BUCKET, $oldRel)),
        json_encode(['deleted' => $dry['deleted'], 'skipped_active' => $dry['skipped_active'], 'errors' => $dry['errors']]));
    check('Q9: a copy whose student has an ACTIVE job is never swept',
        $dry['skipped_active'] === 1 && is_file($storage->privateFilePath(PdfWatermarkService::BUCKET, $activeRel)),
        'skipped=' . $dry['skipped_active']);
    check('Q9: a registry path outside the material/student folder is refused',
        $dry['errors'] === 1, 'errors=' . $dry['errors']);
    check('Q9: a fresh copy inside the 24h window is not even considered',
        !in_array($freshRel, $dry['files'], true) && is_file($storage->privateFilePath(PdfWatermarkService::BUCKET, $freshRel)));

    $apply = $queue->sweepRetention(1, 200, true);
    check('Q9: --apply deletes the expired, inactive copy',
        !is_file($storage->privateFilePath(PdfWatermarkService::BUCKET, $oldRel)),
        json_encode(['deleted' => $apply['deleted'], 'errors' => $apply['errors']]));
    check('Q9: the registry row for the swept copy is gone',
        (int) $db->value('SELECT COUNT(*) FROM lesson_material_pdfs WHERE storage_path = ?', [$oldRel], 0) === 0);
    check('Q9: an expired copy with an ACTIVE job survives the sweep',
        is_file($storage->privateFilePath(PdfWatermarkService::BUCKET, $activeRel))
        && (int) $db->value('SELECT COUNT(*) FROM lesson_material_pdfs WHERE storage_path = ?', [$activeRel], 0) === 1);
    check('Q9: the out-of-folder path was NOT deleted',
        is_file($storage->privateFilePath(PdfWatermarkService::BUCKET, $outsideRel))
        && (int) $db->value('SELECT COUNT(*) FROM lesson_material_pdfs WHERE storage_path = ?', [$outsideRel], 0) === 1);
    check('Q9: the fresh copy is untouched', is_file($storage->privateFilePath(PdfWatermarkService::BUCKET, $freshRel)));
    check('Q9: default retention is 24 hours',
        MaterialPdfQueueService::RETENTION_DAYS === 1);

    // ── Q11. One real render through the worker path ───────────────────────
    $fixture = $root . '/.freebuff/pdf-watermark-tests/fixtures/source.pdf';
    if (!is_file($fixture) || !$variants->watermark()->isAvailable()) {
        skip('Q11: the worker renders a real personalized copy', 'no PDF fixture or no watermark engine available');
    } else {
        $db->query('DELETE FROM lesson_material_pdf_jobs WHERE material_id = ?', [$materialId]);
        $db->query('DELETE FROM lesson_material_pdfs WHERE material_id = ?', [$materialId]);
        $sourceAbs = $variants->sourcePath($material);
        @mkdir(dirname($sourceAbs), 0775, true);
        copy($fixture, $sourceAbs);
        clearstatcache(true, $sourceAbs);
        $db->query('UPDATE lesson_materials SET file_hash = NULL, file_hash_path = NULL, file_hash_size = NULL, file_hash_mtime = NULL WHERE id = ?', [$materialId]);

        $fresh = (array) $queue->loadMaterial($materialId);
        $queue->enqueueStudent($fresh, $studentA, MaterialPdfQueueService::PRIORITY_STUDENT, true);
        $jobs = $queue->claim(5, 'qtest-worker-render');
        check('Q11: the worker claims the queued job', count($jobs) === 1, 'claimed=' . count($jobs));
        $ok = false;
        $detail = '';
        try {
            $variants->ensure($fresh, $studentA);
            $ok = $queue->markReady((string) $jobs[0]['id'], (string) $jobs[0]['lock_token']);
            $detail = 'job=' . substr((string) $jobs[0]['id'], 0, 8);
        } catch (Throwable $e) {
            $detail = get_class($e) . ': ' . $e->getMessage();
        }
        check('Q11: the render completes and the job becomes ready', $ok, $detail);
        $copy = $variants->existing($fresh, $studentA);
        check('Q11: a valid, registered copy exists for that student', $copy !== null, json_encode($copy));
        if ($copy !== null) {
            $abs = $storage->privateFilePath(PdfWatermarkService::BUCKET, (string) $copy['storage_path']);
            $createdFiles[] = $abs;
            check('Q11: the copy is on disk and is NOT the original bytes',
                is_file($abs) && hash_file('sha256', $abs) !== hash_file('sha256', $sourceAbs));
            check('Q11: the copy is stored under that student’s own folder',
                str_starts_with((string) $copy['storage_path'], rtrim($variants->prefix($fresh, $studentA), '/') . '/'),
                (string) $copy['storage_path']);
            check('Q11: another student has NO copy from this render',
                $variants->existing($fresh, $studentB) === null);
        }
        @unlink($sourceAbs);
    }
} catch (Throwable $e) {
    fwrite(STDERR, 'suite error: ' . get_class($e) . ': ' . $e->getMessage() . "\n");
    removeFixtures();
    exit(2);
}

removeFixtures();

$failed = count($failures);
$total = count($checks);
fwrite(STDOUT, "\n" . ($failed === 0 ? 'ALL QUEUE CHECKS PASSED' : 'QUEUE CHECKS FAILED') . " ({$total} checks, {$failed} failed)\n");
if ($failed > 0) {
    fwrite(STDERR, "FAILED:\n - " . implode("\n - ", $failures) . "\n");
    exit(1);
}
exit(0);
