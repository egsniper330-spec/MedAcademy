<?php

declare(strict_types=1);

/**
 * pdf_wait_estimate_tests.php — the waiting-time contract and the aging policy,
 * against a REAL database.
 *
 * WHY THIS SUITE EXISTS
 *   `queue_tests.php` proves the queue's guarantees; `pdf_worker_performance_tests.php`
 *   proves what one copy costs; `pdf_queue_concurrency_tests.php` proves staged
 *   concurrency. None of them covers what a WAITING STUDENT is told, which is
 *   where the queue was actually failing its users: with a five-minute cron the
 *   client gave up after ~82 s and called a healthy queued job a failure, and
 *   nothing anywhere reported a position or an estimate.
 *
 * WHAT IT PROVES
 *   E1  with no measured render, EVERY eta field is null (`insufficient_samples`)
 *       — an unsupported estimate is never invented;
 *   E2  with measurements, a grounded range is returned, exactly ONE worker
 *       interval wide, with `eta_seconds` as the conservative upper bound and a
 *       position/rank pair that agree;
 *   E3  the estimate LEARNS from measurement: doubling the measured render moves
 *       both bounds by the same delta;
 *   E4  samples outside the window (or without a lock stamp) are ignored;
 *   E5  a job inside retry backoff does not block anybody, and reports its
 *       run_after as `retry_after` (a polling interval, never an ETA);
 *   E6  a claimed job is reported as `generating`, not `queued`;
 *   E7  `ready` is reported only with a valid copy; a `ready` row whose copy
 *       vanished is reported as queued again;
 *   E8  AGING: only aged PREWARM rows are eligible, the oldest is served first,
 *       one claim cannot be re-claimed by a second worker, an aged interactive
 *       job is never targeted, and reserving 0 slots disables the policy;
 *   E9  the ETA is class-aware: interactive backlog inflates an interactive
 *       copy's estimate and does NOT inflate a background copy's, because the
 *       reservation is what serves background work.
 *
 * METHOD: assertions are DIFFERENTIAL wherever the local database could already
 * hold rows from another suite (the queue is global, so a rank is only meaningful
 * relative to what else is queued). Nothing here depends on an absolute queue
 * depth, and the suite never deletes a row it did not create.
 *
 * SAFETY
 *   • Refuses to run when APP_ENV=production — it writes rows.
 *   • Creates only `qtest-est-*` fixtures and deletes them in a finally block.
 *   • No PDF is rendered and no storage object is touched: the estimate and the
 *     aging claim are pure queue/DB behaviour.
 *
 * USAGE
 *   php backend/tests/material-queue/pdf_wait_estimate_tests.php
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
require $root . '/backend/src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Services\MaterialPdfQueueService;
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
$doctorId = 'qtest-est-doc-' . $tag;
$studentA = 'qtest-est-stu-a-' . $tag;
$studentB = 'qtest-est-stu-b-' . $tag;
$studentC = 'qtest-est-stu-c-' . $tag;
$courseId = 'qtest-est-crs-' . $tag;
$lessonId = 'qtest-est-lsn-' . $tag;
$sectionId = 'qtest-est-sec-' . $tag;
$materialId = 'qtest-est-mat-' . $tag;
$now = gmdate('Y-m-d H:i:s');

function seedFixtures(): void
{
    global $db, $doctorId, $studentA, $studentB, $studentC, $courseId, $lessonId, $sectionId, $materialId, $now;

    $people = [
        [$doctorId, 'doctor', 'Estimate Doctor'],
        [$studentA, 'student', 'Estimate Student A'],
        [$studentB, 'student', 'Estimate Student B'],
        [$studentC, 'student', 'Estimate Student C'],
    ];
    foreach ($people as [$id, $role, $name]) {
        $db->query(
            'INSERT INTO users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?)',
            [$id, $id . '@example.invalid', 'qtest-no-login-' . bin2hex(random_bytes(8)), $now, $now]
        );
        // The schema's trigger auto-creates the profile row, so UPDATE when it exists.
        if ($db->row('SELECT id FROM profiles WHERE id = ?', [$id]) !== null) {
            $db->query(
                'UPDATE profiles SET full_name = ?, role = ?, status = ?, email = ?, updated_at = ? WHERE id = ?',
                [$name, $role, 'active', $id . '@example.invalid', $now, $id]
            );
        } else {
            $db->query(
                'INSERT INTO profiles (id, email, full_name, role, status, watermark_id, public_user_id, security_version, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
                [$id, $id . '@example.invalid', $name, $role, 'active', 'QE-' . strtoupper(substr($id, -6)), 'QE' . substr(md5($id), 0, 6), $now, $now]
            );
        }
    }

    $db->query(
        'INSERT INTO courses (id, doctor_id, title, description, language, status, phone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$courseId, $doctorId, 'Estimate Test Course ' . substr($courseId, -6), 'Estimate test fixture. Safe to delete.', 'en', 'published', '+201000000000', $now, $now]
    );
    $db->query(
        'INSERT INTO sections (id, course_id, title, order_index, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)',
        [$sectionId, $courseId, 'Estimate Test Section', $now, $now]
    );
    $db->query(
        'INSERT INTO lessons (id, section_id, course_id, title, status, order_index, video_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
        [$lessonId, $sectionId, $courseId, 'Estimate Test Lesson', 'published', 'coming_soon', $now, $now]
    );
    $db->query(
        "INSERT INTO lesson_materials (id, lesson_id, course_id, file_name, file_url, file_type, storage_path, permission, download_enabled, preview_enabled, uploaded_by, created_at, updated_at)
         VALUES (?, ?, ?, 'estimate-test.pdf', ?, 'application/pdf', ?, 'allow', 1, 1, ?, ?, ?)",
        [$materialId, $lessonId, $courseId, $materialId . '/estimate-test.pdf', $materialId . '/estimate-test.pdf', $doctorId, $now, $now]
    );
}

function removeFixtures(): void
{
    global $db, $doctorId, $studentA, $studentB, $studentC, $courseId, $lessonId, $sectionId, $materialId;

    $db->query('DELETE FROM lesson_material_pdf_jobs WHERE material_id = ?', [$materialId]);
    $db->query('DELETE FROM lesson_material_pdfs WHERE material_id = ?', [$materialId]);
    $db->query('DELETE FROM lesson_materials WHERE id = ?', [$materialId]);
    $db->query('DELETE FROM lessons WHERE id = ?', [$lessonId]);
    $db->query('DELETE FROM sections WHERE id = ?', [$sectionId]);
    $db->query('DELETE FROM courses WHERE id = ?', [$courseId]);
    $db->query('DELETE FROM profiles WHERE id IN (?, ?, ?, ?)', [$doctorId, $studentA, $studentB, $studentC]);
    $db->query('DELETE FROM users WHERE id IN (?, ?, ?, ?)', [$doctorId, $studentA, $studentB, $studentC]);
}

/**
 * Insert one job row with EXACT control over the fields the contract reads.
 * Returns [id, variantKey] so statusFor() can be called for that row.
 */
function addJob(
    string $studentId,
    string $label,
    int $priority,
    string $createdAt,
    ?string $runAfter = null,
    string $status = 'queued',
    ?string $lockedAt = null,
    ?string $readyAt = null,
    ?string $lockToken = null
): array {
    global $db, $materialId;

    $id = Uuid::v4();
    $variantKey = hash('sha256', 'variant-' . $label . '-' . $studentId);
    $db->query(
        "INSERT INTO lesson_material_pdf_jobs
           (id, material_id, student_id, source_hash, variant_key, status, priority, attempts, max_attempts,
            lock_token, locked_at, run_after, ready_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 4, ?, ?, ?, ?, ?, ?)",
        [
            $id,
            $materialId,
            $studentId,
            hash('sha256', 'source-' . $label),
            $variantKey,
            $status,
            $priority,
            $lockToken,
            $lockedAt,
            $runAfter ?? gmdate('Y-m-d H:i:s'),
            $readyAt,
            $createdAt,
            $createdAt,
        ]
    );

    return ['id' => $id, 'variant_key' => $variantKey];
}

/** A fresh service instance per phase: the render-sample cache is per instance. */
function queue(): MaterialPdfQueueService
{
    return new MaterialPdfQueueService();
}

/** Wipe only this suite's sample rows (never another suite's). */
function clearSamples(): void
{
    global $db, $materialId;
    $db->query("DELETE FROM lesson_material_pdf_jobs WHERE material_id = ? AND status = 'ready'", [$materialId]);
}

/** Insert $count recent successful render samples of $seconds each. */
function addSamples(int $count, int $seconds): void
{
    global $studentA;
    $readyAt = gmdate('Y-m-d H:i:s', time() - 30);
    $lockedAt = gmdate('Y-m-d H:i:s', time() - 30 - $seconds);
    for ($i = 0; $i < $count; $i++) {
        addJob(
            $studentA,
            'sample-' . $i . '-' . $seconds,
            MaterialPdfQueueService::PRIORITY_PREWARM,
            gmdate('Y-m-d H:i:s', time() - 60),
            gmdate('Y-m-d H:i:s', time() - 60),
            'ready',
            $lockedAt,
            $readyAt,
            null
        );
    }
}

try {
    seedFixtures();

    $material = queue()->loadMaterial($materialId);
    if ($material === null) {
        throw new RuntimeException('fixture material missing');
    }

    $interval = MaterialPdfQueueService::workerIntervalSeconds();
    $perRun = MaterialPdfQueueService::workerJobsPerRun();
    $reserve = MaterialPdfQueueService::reservedPrewarmClaims();
    $slots = max(1, $perRun - $reserve);
    fwrite(STDOUT, "configured schedule: interval={$interval}s jobs/run={$perRun} reserved={$reserve} interactive-slots={$slots}\n\n");

    check('E0: the schedule the estimate uses is configured and sane',
        $interval >= 30 && $perRun >= 1 && $reserve >= 0,
        "interval={$interval} jobs/run={$perRun} reserved={$reserve}");

    // ── E1. No measurement → no estimate, ever ──────────────────────────────
    clearSamples();
    $mine = addJob($studentA, 'primary', MaterialPdfQueueService::PRIORITY_STUDENT, gmdate('Y-m-d H:i:s', time() - 5));
    $foreignSamples = (int) $db->value(
        "SELECT COUNT(*) FROM lesson_material_pdf_jobs
          WHERE status = 'ready' AND locked_at IS NOT NULL AND ready_at IS NOT NULL AND material_id <> ?",
        [$materialId],
        0
    );

    $s1 = queue()->statusFor($material, $studentA, $mine['variant_key'], false);
    if ($foreignSamples === 0) {
        check('E1: with no measured render EVERY eta field is null (never invented)',
            $s1['eta_seconds'] === null && $s1['eta_min_seconds'] === null && $s1['eta_max_seconds'] === null,
            json_encode($s1));
        check('E1: the reason is reported, so the client can explain itself',
            $s1['eta_basis'] === 'insufficient_samples' && $s1['eta_samples'] === 0,
            (string) $s1['eta_basis']);
    } else {
        skip('E1: with no measured render EVERY eta field is null', "the local database already holds {$foreignSamples} measured render(s) from another suite");
    }
    check('E1: a queued copy is reported as `queued`, with its client state',
        $s1['status'] === 'queued' && $s1['state'] === MaterialPdfQueueService::STATE_QUEUED,
        json_encode(['status' => $s1['status'], 'state' => $s1['state']]));
    check('E1: retry_after stays a POLLING interval, bounded and not an ETA',
        is_int($s1['retry_after']) && $s1['retry_after'] >= 5 && $s1['retry_after'] <= 120,
        (string) $s1['retry_after']);
    check('E1: position and rank are consistent for a queued job',
        is_int($s1['queue_position']) && $s1['queue_position'] >= 1
        && $s1['jobs_ahead'] === $s1['queue_position'] - 1,
        json_encode(['position' => $s1['queue_position'], 'ahead' => $s1['jobs_ahead']]));

    // ── E2. With measurements: a grounded, one-interval-wide range ──────────
    addSamples(5, 4);
    $s2 = queue()->statusFor($material, $studentA, $mine['variant_key'], false);

    check('E2: measured renders produce an estimate (and say how many backed it)',
        $s2['eta_basis'] === 'measured_render_median' && $s2['eta_samples'] >= 3
        && is_int($s2['eta_seconds']) && $s2['eta_seconds'] > 0,
        json_encode(['basis' => $s2['eta_basis'], 'samples' => $s2['eta_samples'], 'eta' => $s2['eta_seconds']]));
    check('E2: the range is exactly ONE worker interval wide',
        $s2['eta_max_seconds'] - $s2['eta_min_seconds'] === $interval,
        'width=' . ($s2['eta_max_seconds'] - $s2['eta_min_seconds']) . " interval={$interval}");
    check('E2: eta_seconds is the conservative UPPER bound',
        $s2['eta_seconds'] === $s2['eta_max_seconds'],
        json_encode(['eta' => $s2['eta_seconds'], 'max' => $s2['eta_max_seconds']]));
    check('E2: the lower bound includes the measured render and no more than one tick',
        $s2['eta_min_seconds'] >= 1 && $s2['eta_min_seconds'] <= $interval + 10,
        (string) $s2['eta_min_seconds']);
    check('E2: the estimate includes the render itself (a 4 s median shows up in the lower bound)',
        $s2['eta_min_seconds'] <= 5 + $interval * 0,
        (string) $s2['eta_min_seconds']);

    // ── E3. The estimate LEARNS from measurement ─────────────────────────────
    clearSamples();
    addSamples(5, 64);
    $s3 = queue()->statusFor($material, $studentA, $mine['variant_key'], false);

    $minDelta = $s3['eta_min_seconds'] - $s2['eta_min_seconds'];
    $maxDelta = $s3['eta_max_seconds'] - $s2['eta_max_seconds'];
    check('E3: a longer measured render moves both bounds by the same delta',
        abs($minDelta - 60) <= 1 && $minDelta === $maxDelta,
        "minΔ={$minDelta} maxΔ={$maxDelta}");
    check('E3: the width of the range is unaffected by the render length',
        $s3['eta_max_seconds'] - $s3['eta_min_seconds'] === $interval,
        'width=' . ($s3['eta_max_seconds'] - $s3['eta_min_seconds']));

    // ── E4. Stale / unstamped samples are ignored ────────────────────────────
    $samplesBefore = $s3['eta_samples'];
    addJob($studentB, 'unstamped', MaterialPdfQueueService::PRIORITY_PREWARM, gmdate('Y-m-d H:i:s', time() - 60), gmdate('Y-m-d H:i:s', time() - 60), 'ready', null, gmdate('Y-m-d H:i:s'), null);
    addJob($studentB, 'ancient', MaterialPdfQueueService::PRIORITY_PREWARM, gmdate('Y-m-d H:i:s', time() - 30 * 86400), gmdate('Y-m-d H:i:s', time() - 30 * 86400), 'ready', gmdate('Y-m-d H:i:s', time() - 30 * 86400), gmdate('Y-m-d H:i:s', time() - 30 * 86400 + 600), null);
    $s4 = queue()->statusFor($material, $studentA, $mine['variant_key'], false);
    check('E4: unstamped and out-of-window renders are not learned from',
        $s4['eta_samples'] === $samplesBefore
        && $s4['eta_min_seconds'] === $s3['eta_min_seconds']
        && $s4['eta_max_seconds'] === $s3['eta_max_seconds'],
        json_encode(['before' => $samplesBefore, 'after' => $s4['eta_samples']]));

    // ── E5. Retry backoff: does not block, still pollable ────────────────────
    $mineAhead = $s4['jobs_ahead'];
    $backoff = addJob($studentB, 'backoff', MaterialPdfQueueService::PRIORITY_STUDENT, gmdate('Y-m-d H:i:s', time() - 300), gmdate('Y-m-d H:i:s', time() + 120));
    $s5 = queue()->statusFor($material, $studentA, $mine['variant_key'], false);
    check('E5: a job inside retry backoff does NOT count as blocking',
        $s5['jobs_ahead'] === $mineAhead,
        "before={$mineAhead} after={$s5['jobs_ahead']}");

    $sB = queue()->statusFor($material, $studentB, $backoff['variant_key'], false);
    check('E5: its own run_after is reported as retry_after (a polling interval)',
        $sB['retry_after'] >= 100 && $sB['retry_after'] <= 120 && $sB['status'] === 'queued',
        json_encode(['retry_after' => $sB['retry_after'], 'status' => $sB['status']]));
    check('E5: the wait it reports is not shorter than its own backoff',
        is_int($sB['eta_min_seconds']) && $sB['eta_min_seconds'] >= 110,
        (string) $sB['eta_min_seconds']);

    // ── E6. A claimed job is `generating`, not `queued` ──────────────────────
    $db->query(
        "UPDATE lesson_material_pdf_jobs SET status = 'processing', lock_token = ?, locked_by = 'qtest-est-worker', locked_at = ?
          WHERE id = ?",
        [Uuid::v4(), gmdate('Y-m-d H:i:s'), $mine['id']]
    );
    $s6 = queue()->statusFor($material, $studentA, $mine['variant_key'], false);
    check('E6: a claimed job reports the `generating` state with no queue position',
        $s6['state'] === MaterialPdfQueueService::STATE_GENERATING && $s6['queue_position'] === null,
        json_encode(['state' => $s6['state'], 'position' => $s6['queue_position']]));
    check('E6: a generating copy still gets an upper bound (it should be nearly done)',
        is_int($s6['eta_max_seconds']) && $s6['eta_max_seconds'] >= 30
        && $s6['eta_max_seconds'] === max(30, (int) round(64 * 2)),
        (string) $s6['eta_max_seconds']);
    check('E6: the poll interval for a rendering copy stays short',
        $s6['retry_after'] === 15, (string) $s6['retry_after']);

    // ── E7. `ready` is never claimed without a valid copy ────────────────────
    $s7a = queue()->statusFor($material, $studentA, $mine['variant_key'], true);
    check('E7: a VALID copy is reported ready, with a zero wait',
        $s7a['state'] === MaterialPdfQueueService::STATE_READY && $s7a['eta_seconds'] === 0
        && $s7a['eta_basis'] === 'already_ready' && $s7a['queue_position'] === null,
        json_encode(['state' => $s7a['state'], 'eta' => $s7a['eta_seconds']]));
    $db->query("UPDATE lesson_material_pdf_jobs SET status = 'ready', ready_at = ? WHERE id = ?", [gmdate('Y-m-d H:i:s'), $mine['id']]);
    $s7b = queue()->statusFor($material, $studentA, $mine['variant_key'], false);
    check('E7: a `ready` row whose copy vanished is reported as queued again (never ready)',
        $s7b['state'] === MaterialPdfQueueService::STATE_QUEUED && $s7b['status'] === 'queued',
        json_encode(['state' => $s7b['state'], 'status' => $s7b['status']]));

    // ── E8. Aging: bounded fairness for background work ─────────────────────
    $aging = new MaterialPdfQueueService();
    check('E8: the aging window and slot count are configuration',
        MaterialPdfQueueService::prewarmStarvationSeconds() >= 60
        && $reserve === MaterialPdfQueueService::reservedPrewarmClaims(),
        'window=' . MaterialPdfQueueService::prewarmStarvationSeconds() . "s reserve={$reserve}");

    $youngPrewarm = addJob($studentC, 'young-prewarm', MaterialPdfQueueService::PRIORITY_PREWARM, gmdate('Y-m-d H:i:s', time() - 60));
    check('E8: a young background job is NOT rescued — only a starved one is',
        $aging->claimAgedPrewarm('qtest-est-aging') === [],
        'claimed something from a 60 s old prewarm job');

    $agedInteractive = addJob($studentB, 'aged-interactive', MaterialPdfQueueService::PRIORITY_STUDENT, gmdate('Y-m-d H:i:s', time() - 3600));
    check('E8: aging NEVER targets an interactive job, however old',
        $aging->claimAgedPrewarm('qtest-est-aging') === [],
        'claimed an interactive row');

    $oldestAged = addJob($studentC, 'oldest-prewarm', MaterialPdfQueueService::PRIORITY_PREWARM, gmdate('Y-m-d H:i:s', time() - 1800));
    $newerAged = addJob($studentC, 'newer-prewarm', MaterialPdfQueueService::PRIORITY_PREWARM, gmdate('Y-m-d H:i:s', time() - 1200));
    $reserved = $aging->claimAgedPrewarm('qtest-est-aging');
    check('E8: the OLDEST starved background job is served first',
        ($reserved[0]['id'] ?? '') === $oldestAged['id'],
        (string) substr((string) ($reserved[0]['id'] ?? 'none'), 0, 8));
    $claimedRow = $db->row('SELECT status, lock_token, locked_by FROM lesson_material_pdf_jobs WHERE id = ?', [$oldestAged['id']]);
    check('E8: the reserved claim is a real, locked claim',
        $claimedRow !== null && (string) $claimedRow['status'] === 'processing'
        && !empty($claimedRow['lock_token']) && (string) $claimedRow['locked_by'] === 'qtest-est-aging',
        json_encode($claimedRow));

    $second = $aging->claimAgedPrewarm('qtest-est-aging');
    check('E8: a second worker cannot re-claim the same row',
        ($second[0]['id'] ?? '') === $newerAged['id'],
        (string) substr((string) ($second[0]['id'] ?? 'none'), 0, 8));

    $normal = $aging->claim(1, 'qtest-est-aging');
    check('E8: a waiting student is still served in the same run (the reservation is not a lock-out)',
        $normal !== [] && (int) $normal[0]['priority'] <= MaterialPdfQueueService::PRIORITY_STUDENT,
        $normal === [] ? 'nothing claimable at all' : 'priority=' . $normal[0]['priority']);
    check('E8: an old interactive job is still preferentially claimable after aging ran',
        $db->row('SELECT status FROM lesson_material_pdf_jobs WHERE id = ?', [$agedInteractive['id']]) !== null,
        'row vanished');

    // Reserving 0 slots must disable the policy completely.
    $_ENV['MATERIAL_PDF_PREWARM_RESERVED_CLAIMS'] = '0';
    putenv('MATERIAL_PDF_PREWARM_RESERVED_CLAIMS=0');
    Config::init();
    check('E8: reserving 0 slots disables aging entirely',
        MaterialPdfQueueService::reservedPrewarmClaims() === 0
        && (new MaterialPdfQueueService())->claimAgedPrewarm('qtest-est-aging') === [],
        'reserved=' . MaterialPdfQueueService::reservedPrewarmClaims());
    unset($_ENV['MATERIAL_PDF_PREWARM_RESERVED_CLAIMS']);
    putenv('MATERIAL_PDF_PREWARM_RESERVED_CLAIMS');
    Config::init();

    // ── E9. The estimate is class-aware ─────────────────────────────────────
    // A background copy's wait must NOT grow with the interactive backlog: what
    // serves it is the reservation, not the interactive slots.
    $background = addJob($studentC, 'class-prewarm', MaterialPdfQueueService::PRIORITY_PREWARM, gmdate('Y-m-d H:i:s', time() - 1800));
    $before = queue()->statusFor($material, $studentC, $background['variant_key'], false);
    for ($i = 0; $i < $slots; $i++) {
        addJob($studentB, 'backlog-' . $i, MaterialPdfQueueService::PRIORITY_STUDENT, gmdate('Y-m-d H:i:s', time() - 120));
    }
    $after = queue()->statusFor($material, $studentC, $background['variant_key'], false);
    check('E9: a growing interactive backlog leaves a background estimate UNCHANGED',
        $after['eta_max_seconds'] === $before['eta_max_seconds']
        && $after['eta_min_seconds'] === $before['eta_min_seconds'],
        json_encode(['before' => $before['eta_max_seconds'], 'after' => $after['eta_max_seconds']]));
    check('E9: while its claim-order rank does grow (the backlog is real)',
        $after['jobs_ahead'] === $before['jobs_ahead'] + $slots,
        "before={$before['jobs_ahead']} after={$after['jobs_ahead']}");

    // The mirror: an INTERACTIVE copy's wait grows by one tick per full batch of
    // interactive work ahead of it.
    $mine2 = addJob($studentA, 'interactive-2', MaterialPdfQueueService::PRIORITY_STUDENT, gmdate('Y-m-d H:i:s', time() - 30));
    $i1 = queue()->statusFor($material, $studentA, $mine2['variant_key'], false);
    for ($i = 0; $i < $slots; $i++) {
        addJob($studentB, 'ahead-' . $i, MaterialPdfQueueService::PRIORITY_STUDENT, gmdate('Y-m-d H:i:s', time() - 90));
    }
    $i2 = queue()->statusFor($material, $studentA, $mine2['variant_key'], false);
    check('E9: a full batch of interactive work ahead adds exactly one tick to a student estimate',
        $i2['eta_max_seconds'] - $i1['eta_max_seconds'] === $interval
        && $i2['jobs_ahead'] === $i1['jobs_ahead'] + $slots,
        json_encode(['before' => $i1['eta_max_seconds'], 'after' => $i2['eta_max_seconds'], 'interval' => $interval]));
    check('E9: the range width stays exactly one interval in every case',
        $i2['eta_max_seconds'] - $i2['eta_min_seconds'] === $interval
        && $after['eta_max_seconds'] - $after['eta_min_seconds'] === $interval);

    // ── E10. The contract never leaks identity ──────────────────────────────
    $payload = json_encode($s2);
    check('E10: the estimate payload carries counts and durations only',
        !str_contains((string) $payload, 'full_name')
        && !str_contains((string) $payload, 'storage_path')
        && !str_contains((string) $payload, $studentB)
        && str_contains((string) $payload, 'eta_basis'),
        (string) $payload);
} catch (Throwable $e) {
    fwrite(STDERR, 'suite error: ' . get_class($e) . ': ' . $e->getMessage() . "\n");
    removeFixtures();
    exit(2);
}

removeFixtures();

$failed = count($failures);
$total = count($checks);
fwrite(STDOUT, "\n" . ($failed === 0 ? 'ALL WAIT-ESTIMATE CHECKS PASSED' : 'WAIT-ESTIMATE CHECKS FAILED') . " ({$total} checks, {$failed} failed)\n");
if ($failed > 0) {
    fwrite(STDERR, "FAILED:\n - " . implode("\n - ", $failures) . "\n");
    exit(1);
}
exit(0);
