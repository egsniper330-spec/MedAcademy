<?php

declare(strict_types=1);

/**
 * watermark-worker.php — generate personalized lesson-PDF copies in bounded
 * background batches. Designed for cPanel cron on shared hosting: no daemon, no
 * Redis, no Supervisor. Every run is a short-lived CLI process.
 *
 *   php backend/scripts/watermark-worker.php
 *       One batch: default 5 jobs, stop after 50 s.
 *
 *   php backend/scripts/watermark-worker.php --limit=10 --max-seconds=90
 *
 *   php backend/scripts/watermark-worker.php --retention --apply
 *       Also sweep personalized copies older than 90 days (dry run without
 *       --apply). Nightly is enough.
 *
 * CRON (cPanel → Cron Jobs) — NOT configured by this change:
 *   * * * * * /usr/local/bin/php /home/<user>/<app>/backend/scripts/watermark-worker.php --limit=5 --max-seconds=50 >/dev/null 2>&1
 *   30 3 * * * /usr/local/bin/php /home/<user>/<app>/backend/scripts/watermark-worker.php --retention --apply --limit=0 >/dev/null 2>&1
 *
 * FLAGS
 *   --limit=N          jobs per run (default 5, max 100; 0 = only housekeeping)
 *   --max-seconds=N    wall-clock budget (default 50; clamp 5–600)
 *   --min-render-seconds=N  do not START a render with less budget than this
 *                      left (default 15) — a render killed by the PHP execution
 *                      limit is a fatal, not an exception (see SAFETY)
 *   --lock-file=PATH   override the single-instance lock path (tests only)
 *   --stale=N          reclaim worker locks older than N seconds (default 900)
 *   --prewarm-reserved=N  overriding slots per run reserved for aged prewarm
 *                      jobs (default from MATERIAL_PDF_PREWARM_RESERVED_CLAIMS,
 *                      then 1; 0 disables aging)
 *   --retention        also run the 90-day retention sweep
 *   --retention-days=N retention window (default 90 — do not shorten silently)
 *   --apply            with --retention, actually delete (default: dry run)
 *   --status           print queue health and exit (no rendering, no writes);
 *                      exits 1 when the queue table is missing, which is the
 *                      quickest way to confirm migration 038 is applied
 *   --pretty           human-readable output instead of one JSON line
 *
 * SAFETY
 *   • SINGLE INSTANCE: one worker per host, enforced with `flock(LOCK_EX|LOCK_NB)`
 *     on storage/private/.watermark-worker.lock (WorkerLock). A second launch
 *     exits 0 immediately with `"skipped":"worker_locked"` and touches nothing —
 *     the OS releases the lock on exit, crash, kill or fatal.
 *   • Bounded: at most `limit` renders and never past `max-seconds`; a render is
 *     only STARTED when at least `--min-render-seconds` of budget remain. Jobs
 *     are claimed ONE AT A TIME, so a run that dies never strands un-started
 *     work in `processing`.
 *   • AGING (bounded fairness): waiting students outrank background
 *     pre-generation, but a pre-generation job that has waited longer than
 *     MATERIAL_PDF_PREWARM_STARVATION_SECONDS (default 900, 15 min) gets ONE
 *     reserved slot at the START of a run — MATERIAL_PDF_PREWARM_RESERVED_CLAIMS
 *     (default 1, max 2), and never the whole run (`--limit=1` reserves nothing).
 *     With `--limit=5` that is at most one of five renders taken from
 *     interactive capacity, and only for an already-starved job, so a continuous
 *     stream of student requests can no longer defer pre-generation indefinitely,
 *     and that background work can no longer starve the students either.
 *   • FATAL-SAFE: `max_execution_time` produces an uncatchable fatal (no
 *     exception, no finally). A shutdown handler releases the job this process
 *     was holding, so it is retried on the next cron tick instead of waiting for
 *     the 900 s stale window.
 *   • Re-authorises every job: material still present/visible, lesson and course
 *     still published, enrollment not suspended, profile not suspended. A copy is
 *     never produced for a student who lost access.
 *   • Re-derives the variant key from the LIVE source; a job whose source was
 *     replaced is skipped and a fresh job is queued for the new source.
 *   • A render goes to a `.part` file and is published atomically, only after it
 *     validates — no reader can ever see a partial document.
 *   • Never touches originals. Retention deletes only registry-owned copies
 *     inside the `lesson-material-pdfs` bucket.
 *   • Exit code 0 unless the run could not start (DB/schema problem).
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Http\ApiException;
use MedAcademy\Services\MaterialPdfQueueService;
use MedAcademy\Services\PdfWatermarkService;
use MedAcademy\Services\WorkerLock;

/** @return array<string,string> */
function cli_args(array $argv): array
{
    $out = [];
    foreach (array_slice($argv, 1) as $arg) {
        if (!str_starts_with($arg, '--')) {
            continue;
        }
        $parts = explode('=', substr($arg, 2), 2);
        $out[$parts[0]] = $parts[1] ?? '1';
    }
    return $out;
}

$args = cli_args($argv);
$limit = isset($args['limit']) ? (int) $args['limit'] : 5;
$limit = max(0, min(100, $limit));
$maxSeconds = isset($args['max-seconds']) ? (int) $args['max-seconds'] : 50;
$maxSeconds = max(5, min(600, $maxSeconds));
$staleSeconds = isset($args['stale']) ? (int) $args['stale'] : 900;
$minRenderSeconds = isset($args['min-render-seconds']) ? (int) $args['min-render-seconds'] : 15;
$minRenderSeconds = max(5, min(120, $minRenderSeconds));
$lockFile = isset($args['lock-file']) ? (string) $args['lock-file'] : '';
$retentionDays = isset($args['retention-days']) ? (int) $args['retention-days'] : MaterialPdfQueueService::RETENTION_DAYS;
$applyRetention = isset($args['apply']);
$wantRetention = isset($args['retention']);
$pretty = isset($args['pretty']);
$wantStatus = isset($args['status']);

$started = microtime(true);
$workerId = 'cron-' . (gethostname() ?: 'host') . '-' . getmypid();
$summary = [
    'worker' => $workerId,
    'claimed' => 0,
    'ready' => 0,
    'skipped' => 0,
    'failed' => 0,
    'requeued' => 0,
    'stale_requeued' => 0,
    'stale_failed' => 0,
    'orphans_dropped' => 0,
    'prewarm_reserved' => 0,
    'retention' => null,
    'details' => [],
    'seconds' => 0.0,
];

// Release the job this process is holding when PHP dies from a FATAL (e.g. the
// execution-time limit inside a long render). A fatal skips every catch/finally,
// so without this the job stays `processing` until recoverStale() (900 s).
$GLOBALS['wm_held_job'] = null;
register_shutdown_function(static function (): void {
    global $queue, $lock;
    $held = $GLOBALS['wm_held_job'] ?? null;
    if (is_array($held) && isset($queue)) {
        try {
            $queue->release((string) $held['id'], (string) $held['token'], 'worker_aborted');
        } catch (\Throwable) {
            // The stale sweep is the backstop; never mask the original failure.
        }
    }
    if (isset($lock)) {
        $lock->release();
    }
});

$queue = new MaterialPdfQueueService();
$variants = $queue->variants();

// ── 0. --status: read-only health probe (safe while cron is running) ────────
if ($wantStatus) {
    try {
        $health = $queue->health();
        $due = (int) \MedAcademy\Database\Database::instance()->value(
            "SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE status = 'queued' AND run_after <= ?",
            [gmdate('Y-m-d H:i:s')],
            0
        );
        $oldestFailed = \MedAcademy\Database\Database::instance()->value(
            "SELECT MAX(last_error) FROM lesson_material_pdf_jobs WHERE status = 'failed'"
        );
        $out = [
            'schema_ok' => true,
            'due_now' => $due,
            'oldest_failed_reason' => is_string($oldestFailed) ? $oldestFailed : null,
        ] + $health;
        if ($pretty) {
            echo "MedAcademy personalized-PDF queue\n";
            foreach ($out as $k => $v) {
                echo str_pad((string) $k, 22) . ': ' . (is_scalar($v) || $v === null ? var_export($v, true) : json_encode($v)) . "\n";
            }
        } else {
            echo json_encode($out, JSON_UNESCAPED_SLASHES) . "\n";
        }
        exit(0);
    } catch (\Throwable $e) {
        fwrite(STDERR, 'queue schema NOT ready (apply migration 038): ' . $e->getMessage() . "\n");
        exit(1);
    }
}

// ── 0a. SINGLE INSTANCE ────────────────────────────────────────────────────
// Before ANY database work: two overlapping cron runs must not both render. The
// guard is an OS lock (released on exit/crash/fatal), never a PID file, so a
// killed run cannot leave the queue permanently "locked". `--status` above is
// read-only and deliberately does not take the lock.
$lock = new WorkerLock($lockFile !== '' ? $lockFile : WorkerLock::defaultPath());
try {
    if (!$lock->acquire()) {
        $holder = $lock->holder();
        echo json_encode([
            'skipped' => 'worker_locked',
            'reason' => 'another worker process holds the single-instance lock; this run claimed and modified nothing',
            'claimed' => 0,
            'lock' => $lock->path(),
            'holder' => $holder,
            'seconds' => 0.0,
        ], JSON_UNESCAPED_SLASHES) . "\n";
        exit(0);
    }
} catch (\Throwable $e) {
    // Could not CREATE the lock: refuse to run. Continuing unlocked would make
    // the guard decorative and allow exactly the overlap it exists to prevent.
    fwrite(STDERR, 'worker cannot start: single-instance lock unavailable: ' . $e->getMessage() . "\n");
    exit(1);
}

try {
    // ── 1. Reclaim jobs whose worker died (deploy / timeout / kill) ──────────
    $recovered = $queue->recoverStale($staleSeconds);
    $summary['stale_requeued'] = $recovered['requeued'];
    $summary['stale_failed'] = $recovered['failed'];
    $summary['orphans_dropped'] = $queue->dropOrphanedJobs();
} catch (\Throwable $e) {
    fwrite(STDERR, 'worker cannot start (is migration 038 applied?): ' . $e->getMessage() . "\n");
    exit(1);
}

// ── 1b. Work loop ──────────────────────────────
// ONE JOB AT A TIME. Claiming `limit` up front marked every row `processing`
// before a single byte was rendered, so a run that hit the execution-time fatal
// (or was killed) left up to `limit - 1` untouched jobs stranded until the stale
// sweep. Claiming per iteration means a dead worker strands at most the ONE job
// it was actually rendering — and the shutdown handler above releases even that.
$summary['budget_stop'] = null;
$prewarmReserved = isset($args['prewarm-reserved'])
    ? max(0, min(2, (int) $args['prewarm-reserved']))
    : MaterialPdfQueueService::reservedPrewarmClaims();
// A reservation may never consume the WHOLE run: with `--limit=1` that would hand
// every tick to background work and starve the students the queue exists for.
// The shipped `--limit=5` reserves one slot; `--limit=1` reserves none.
$prewarmReserved = min($prewarmReserved, max(0, $limit - 1));
for ($done = 0; $limit > 0 && $done < $limit; $done++) {
    // Stop BEFORE claiming when what is left cannot finish a render: starting one
    // only to be killed by max_execution_time is the failure this avoids.
    $remaining = $maxSeconds - (microtime(true) - $started);
    if ($remaining < $minRenderSeconds) {
        $summary['budget_stop'] = round($remaining, 1);
        break;
    }

    // ── AGING: the one reserved slot goes FIRST ────────────────────────────
    // On-demand only: claim by normal priority without prewarm-specific scheduling.
    $batch = $queue->claim(1, $workerId);
    if ($batch === []) {
        break; // nothing due: a genuinely empty queue, not a lock contention
    }
    $job = $batch[0];
    $summary['claimed']++;

    $jobId = (string) $job['id'];
    $lockToken = (string) $job['lock_token'];
    $materialId = (string) $job['material_id'];
    $studentId = (string) $job['student_id'];
    $context = ['job' => substr($jobId, 0, 8), 'material' => substr($materialId, 0, 8)];

    // Remembered for the shutdown handler: a fatal during this render releases
    // it immediately instead of waiting for the 900 s stale window.
    $GLOBALS['wm_held_job'] = ['id' => $jobId, 'token' => $lockToken];

    try {
        $material = $queue->loadMaterial($materialId);
        if ($material === null) {
            $queue->markSkipped($jobId, $lockToken, 'material_missing');
            $summary['skipped']++;
            $context['result'] = 'skipped:material_missing';
            $summary['details'][] = $context;
            continue;
        }
        if (!$queue->isPdf($material)) {
            $queue->markSkipped($jobId, $lockToken, 'source_not_pdf');
            $summary['skipped']++;
            $context['result'] = 'skipped:source_not_pdf';
            $summary['details'][] = $context;
            continue;
        }
        // ── LIVE authorization: the student must STILL be entitled ───────
        if (!$queue->isStudentEligible($materialId, $studentId)) {
            $queue->markSkipped($jobId, $lockToken, 'not_eligible');
            $summary['skipped']++;
            $context['result'] = 'skipped:not_eligible';
            $summary['details'][] = $context;
            continue;
        }

        $identity = $variants->identity($material, $studentId);

        // Source replaced (or engine settings changed): this job is for a
        // document nobody can be served. Drop it and queue the live variant.
        if ($identity['variant_key'] !== (string) $job['variant_key']) {
            $queue->markSkipped($jobId, $lockToken, 'stale_variant');
            $queue->enqueueStudent(
                $material,
                $studentId,
                (int) ($job['priority'] ?? MaterialPdfQueueService::PRIORITY_PREWARM),
                true
            );
            $summary['skipped']++;
            $context['result'] = 'skipped:stale_variant';
            $summary['details'][] = $context;
            continue;
        }

        // Someone else (a staff preview, another worker) already produced it.
        if ($variants->existing($material, $studentId, $identity['variant_key']) !== null) {
            $queue->markReady($jobId, $lockToken);
            $summary['ready']++;
            $context['result'] = 'ready:cached';
            $summary['details'][] = $context;
            continue;
        }

        $copy = $variants->ensure($material, $studentId);
        if (!$queue->markReady($jobId, $lockToken)) {
            // Lock lost (reclaimed as stale). The file is valid and
            // registered, so nothing is lost — the job will be re-checked.
            $summary['requeued']++;
            $context['result'] = 'ready:lock_lost';
        } else {
            $summary['ready']++;
            $context['result'] = 'ready:rendered';
            $context['pages'] = (int) ($copy['page_count'] ?? 0);
        }
        $summary['details'][] = $context;
    } catch (ApiException $e) {
        $code = is_string($e->errors[0] ?? null) && $e->errors[0] !== '' ? (string) $e->errors[0] : 'watermark_failed';
        $next = $queue->markFailed($jobId, $lockToken, $code);
        $summary[$next === MaterialPdfQueueService::STATUS_FAILED ? 'failed' : 'requeued']++;
        $context['result'] = ($next === MaterialPdfQueueService::STATUS_FAILED ? 'failed:' : 'retry:') . $code;
        $summary['details'][] = $context;
    } catch (\Throwable $e) {
        $next = $queue->markFailed($jobId, $lockToken, 'unexpected');
        $summary[$next === MaterialPdfQueueService::STATUS_FAILED ? 'failed' : 'requeued']++;
        $context['result'] = 'unexpected:' . get_class($e);
        $summary['details'][] = $context;
        error_log('[watermark-worker] ' . get_class($e) . ': ' . $e->getMessage());
    }
}
$GLOBALS['wm_held_job'] = null;

// ── 2. Optional retention sweep (90 days by default) ────────────────────────
if ($wantRetention) {
    try {
        $sweep = $queue->sweepRetention($retentionDays, 200, $applyRetention);
        $summary['retention'] = [
            'days' => $retentionDays,
            'applied' => $applyRetention,
            'scanned' => $sweep['scanned'],
            'deleted' => $applyRetention ? $sweep['deleted'] : 0,
            'would_delete' => $applyRetention ? 0 : $sweep['deleted'],
            'skipped_active_jobs' => $sweep['skipped_active'],
            'bytes' => $sweep['bytes'],
            'errors' => $sweep['errors'],
        ];
    } catch (\Throwable $e) {
        $summary['retention'] = ['error' => $e->getMessage()];
        error_log('[watermark-worker] retention sweep failed: ' . $e->getMessage());
    }
}

$summary['seconds'] = round(microtime(true) - $started, 2);

if ($pretty) {
    echo "MedAcademy personalized-PDF worker\n";
    echo 'worker        : ' . $summary['worker'] . "\n";
    echo 'claimed       : ' . $summary['claimed'] . "\n";
    echo 'ready         : ' . $summary['ready'] . "\n";
    echo 'skipped       : ' . $summary['skipped'] . "\n";
    echo 'failed        : ' . $summary['failed'] . "\n";
    echo 'requeued      : ' . $summary['requeued'] . "\n";
    echo 'stale locks   : ' . $summary['stale_requeued'] . ' requeued / ' . $summary['stale_failed'] . " failed\n";
    echo 'orphan jobs   : ' . $summary['orphans_dropped'] . "\n";
    echo 'aged prewarm  : ' . $summary['prewarm_reserved'] . " of " . $prewarmReserved . " reserved slot(s)\n";
    if ($summary['budget_stop'] !== null) {
        echo 'budget stop  : stopped claiming with ' . $summary['budget_stop'] . " s left (below --min-render-seconds)\n";
    }
    if ($summary['retention'] !== null) {
        echo 'retention     : ' . json_encode($summary['retention']) . "\n";
    }
    foreach ($summary['details'] as $detail) {
        echo '  - job ' . $detail['job'] . ' material ' . $detail['material'] . ' → ' . $detail['result'] . "\n";
    }
    echo 'seconds       : ' . $summary['seconds'] . "\n";
} else {
    echo json_encode($summary, JSON_UNESCAPED_SLASHES) . "\n";
}

exit(0);
