<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;

/**
 * Durable, bounded queue for personalized lesson-PDF copies (migration 038).
 *
 * WHY A DATABASE QUEUE
 *   Production is shared cPanel: no Redis, no Supervisor, no resident daemon.
 *   A table plus a short-lived CLI worker started by cron is the only mechanism
 *   that survives a PHP-FPM recycle. Every operation here is a plain SQL
 *   statement, so a worker killed mid-run leaves no in-memory state behind: the
 *   job it held is reclaimed by `recoverStale()` after the lock timeout.
 *
 * GUARANTEES
 *   • Duplicate prevention — the table's UNIQUE key (material, student, variant)
 *     plus `INSERT … ON DUPLICATE KEY UPDATE`; N concurrent requests for the same
 *     copy produce ONE job.
 *   • Atomic claiming — candidates are read, then claimed by a conditional
 *     UPDATE that only succeeds while `status = 'queued'`. Two workers racing on
 *     the same row: exactly one wins. The winner gets an unguessable
 *     `lock_token`, and can only complete the jobs it holds that token for.
 *   • Bounded — a worker claims at most `limit` jobs and stops at `max-seconds`,
 *     so a cron run never outlives the host's process limit.
 *   • Bounded retries — `attempts`/`max_attempts` with exponential backoff;
 *     a permanent failure ends as `failed` with a machine-readable stage.
 *   • Nothing here generates bytes. Generation stays in
 *     MaterialPdfVariantService, the single implementation used by delivery.
 */
final class MaterialPdfQueueService
{
    public const STATUS_QUEUED = 'queued';
    public const STATUS_PROCESSING = 'processing';
    public const STATUS_READY = 'ready';
    public const STATUS_FAILED = 'failed';
    public const STATUS_SKIPPED = 'skipped';

    /** A student is waiting on this copy right now. */
    public const PRIORITY_STUDENT = 0;
    /** Upload-time pre-generation for enrolled students. */
    public const PRIORITY_PREWARM = 10;

    /** Attempts before a job is parked as `failed` (a student retry re-queues). */
    public const DEFAULT_MAX_ATTEMPTS = 4;

    /**
     * Retention for generated copies. Strict on-demand only: 24 hours from
     * generation. This is a REGENERABLE cache, not the original document — an
     * expired copy is deleted and the next student request regenerates it.
     */
    public const RETENTION_DAYS = 1;

    /** Rows per multi-row INSERT (keeps every statement small). */
    private const INSERT_CHUNK = 100;

    // ── Client-facing states (a superset of the internal status vocabulary) ──
    // `status` is what the queue row holds; `state` is what a waiting student is
    // shown. They differ for exactly one case: a `processing` row is
    // `generating`, which the UI words differently from `queued`.
    public const STATE_READY = 'ready';
    public const STATE_QUEUED = 'queued';
    public const STATE_GENERATING = 'generating';
    public const STATE_FAILED = 'failed';
    /** The queue table/row could not be read: never reported as `ready`. */
    public const STATE_UNAVAILABLE = 'unavailable';

    // ── Waiting-time estimate (see estimateFor()) ────────────────────────────
    /** A measured render duration is only trusted from this many samples. */
    public const ETA_MIN_SAMPLES = 3;
    /** Only renders that finished inside this window are used as samples. */
    public const ETA_SAMPLE_WINDOW_SECONDS = 604800; // 7 days
    /** Upper bound on sample rows read per status call (index-ordered). */
    public const ETA_SAMPLE_LIMIT = 50;

    /** Recent render durations (seconds), memoised for one request/worker run. */
    private ?array $renderSamples = null;

    public function __construct(
        private readonly MaterialPdfVariantService $variants = new MaterialPdfVariantService(),
    ) {
    }

    /**
     * How often cron starts the worker. This is the single most important input
     * to the wait estimate, and it is CONFIGURATION, not an assumption:
     *
     *   MATERIAL_PDF_WORKER_INTERVAL_SECONDS=300  ← verified live cadence (5 min)
     *
     * WHEN THE CRON CADENCE CHANGES, CHANGE THIS WITH IT. Every-minute cron is
     * `60`; if this value is left at 300 the estimate simply over-states the
     * wait (conservative) instead of promising something the queue cannot keep.
     */
    public static function workerIntervalSeconds(): int
    {
        return max(30, min(3600, Config::int('MATERIAL_PDF_WORKER_INTERVAL_SECONDS', 300)));
    }

    /**
     * Jobs a single worker run completes — keep in step with `--limit` in the
     * Cron command (default 5, the shipped flag). Used only for estimates.
     */
    public static function workerJobsPerRun(): int
    {
        return max(1, min(100, Config::int('MATERIAL_PDF_WORKER_JOBS_PER_RUN', 5)));
    }

    /**
     * Slots per worker run reserved for PREWARM (background) work once it has
     * starved. 1 = a bounded aging policy: at most one of five slots per run can
     * be taken from interactive capacity, and only for a job that has already
     * waited `prewarmStarvationSeconds()`. 0 disables aging entirely (strict
     * interactive-first, which is what deferred pre-generation indefinitely).
     */
    public static function reservedPrewarmClaims(): int
    {
        return max(0, min(2, Config::int('MATERIAL_PDF_PREWARM_RESERVED_CLAIMS', 1)));
    }

    /** How long a prewarm job must wait before it earns a reserved slot. */
    public static function prewarmStarvationSeconds(): int
    {
        return max(60, min(86400, Config::int('MATERIAL_PDF_PREWARM_STARVATION_SECONDS', 900)));
    }

    public function variants(): MaterialPdfVariantService
    {
        return $this->variants;
    }

    // ── Material / eligibility ────────────────────────────────────────────────

    /** The material row the queue needs, or null when it no longer exists. */
    public function loadMaterial(string $materialId): ?array
    {
        return Database::instance()->row(
            'SELECT id, lesson_id, course_id, file_name, file_type, storage_path,
                    permission, download_enabled, preview_enabled,
                    file_hash, file_hash_path, file_hash_size
               FROM lesson_materials WHERE id = ? LIMIT 1',
            [$materialId]
        );
    }

    /** True when this material is a PDF at all — other types cannot be personalized. */
    public function isPdf(array $material): bool
    {
        $path = strtolower((string) ($material['storage_path'] ?? ''));
        $type = strtolower((string) ($material['file_type'] ?? ''));
        return str_ends_with($path, '.pdf') || str_contains($type, 'pdf');
    }

    /**
     * The CURRENT access rule for one student, evaluated the same way delivery
     * evaluates it (this is re-checked by the worker before every render, so a
     * copy is never produced for a suspended, unenrolled or unauthorized user):
     *
     *   • material must exist and not be hidden/disabled;
     *   • the student's enrollment must be active (not suspended);
     *   • lesson AND course must be published — OR the lesson is a free preview,
     *     which any authenticated user may read (its identity is still theirs);
     *   • profile must exist and not be suspended/disabled/deleted.
     */
    public function isStudentEligible(string $materialId, string $studentId): bool
    {
        $row = Database::instance()->row(
            "SELECT lm.permission,
                    l.is_preview, l.status AS lesson_status,
                    c.status AS course_status,
                    p.role, p.status AS profile_status,
                    (SELECT COUNT(*) FROM enrollments e
                      WHERE e.student_id = p.id
                        AND e.course_id = lm.course_id
                        AND (e.status IS NULL OR e.status <> 'suspended')) AS active_enrollments
               FROM lesson_materials lm
               LEFT JOIN lessons l ON l.id = lm.lesson_id
               LEFT JOIN courses c ON c.id = lm.course_id
               JOIN profiles p ON p.id = ?
              WHERE lm.id = ?
              LIMIT 1",
            [$studentId, $materialId]
        );
        if ($row === null) {
            return false;
        }
        if (in_array((string) ($row['permission'] ?? 'allow'), ['hidden', 'disabled'], true)) {
            return false;
        }
        $profileStatus = strtolower((string) ($row['profile_status'] ?? 'active'));
        if (in_array($profileStatus, ['suspended', 'disabled', 'deleted'], true)) {
            return false;
        }
        if ((string) ($row['role'] ?? '') !== 'student') {
            return false;
        }
        if ((int) ($row['active_enrollments'] ?? 0) > 0) {
            if (($row['course_status'] ?? null) === 'published' && ($row['lesson_status'] ?? null) === 'published') {
                return true;
            }
            // Enrolled but the content is not published yet: no copy.
            return false;
        }
        // Not enrolled: only a free-preview lesson in a published course is open.
        return !empty($row['is_preview'])
            && ($row['course_status'] ?? null) === 'published'
            && ($row['lesson_status'] ?? null) === 'published';
    }

    /**
     * Every student who should have a copy of this material right now.
     *
     * ONE query (not one per student), because this runs inside an upload
     * request: the upload must not wait for N round trips. The cap is
     * configurable and only guards against an absurd roster; request-time
     * enqueueing still covers anybody the cap skipped.
     *
     * @return array<int,array{student_id:string,full_name:string,public_user_id:string}>
     */
    public function eligibleStudents(string $materialId): array
    {
        $max = max(1, Config::int('MATERIAL_PDF_PREWARM_MAX_STUDENTS', 5000));
        return Database::instance()->select(
            "SELECT p.id AS student_id, p.full_name, p.public_user_id
               FROM enrollments e
               JOIN profiles p ON p.id = e.student_id
               JOIN lesson_materials lm ON lm.id = ?
               JOIN lessons l ON l.id = lm.lesson_id
               JOIN courses c ON c.id = lm.course_id
              WHERE e.course_id = lm.course_id
                AND p.role = 'student'
                AND (e.status IS NULL OR e.status <> 'suspended')
                AND (p.status IS NULL OR p.status NOT IN ('suspended','disabled','deleted'))
                AND lm.permission NOT IN ('hidden','disabled')
                AND l.status = 'published'
                AND c.status = 'published'
              ORDER BY p.id
              LIMIT {$max}",
            [$materialId]
        );
    }

    // ── Enqueue ───────────────────────────────────────────────────────────────

    /**
     * Pre-generate disabled: strict on-demand generation only.
     * @return array{enqueued:int,students:int,skipped:string}
     */
    public function enqueueMaterial(string $materialId, int $priority = self::PRIORITY_PREWARM): array
    {
        return ['enqueued' => 0, 'students' => 0, 'skipped' => 'prewarm_disabled'];
    }

    /**
     * Enqueue (or re-target) ONE student's copy.
     *
     * Used by:
     *   • the delivery endpoint, after its own authorization check passed —
     *     `$authorized` skips the duplicate DB eligibility query (the caller has
     *     just run the authoritative `StorageService::canAccess`);
     *   • the worker, when a job's source changed and the live variant needs a
     *     fresh row;
     *   • a student "Retry" after a permanent failure.
     *
     * @return string|null the variant key, or null when it could not be queued
     */
    public function enqueueStudent(
        array|string $materialOrId,
        string $studentId,
        int $priority = self::PRIORITY_STUDENT,
        bool $authorized = false
    ): ?string {
        $material = is_array($materialOrId) ? $materialOrId : $this->loadMaterial($materialOrId);
        if ($material === null || !$this->isPdf($material)) {
            return null;
        }
        if (!$authorized && !$this->isStudentEligible((string) $material['id'], $studentId)) {
            return null;
        }

        try {
            $identity = $this->variants->identity($material, $studentId);
        } catch (\Throwable $e) {
            error_log('[material-pdf-queue] cannot derive identity: ' . $e->getMessage());
            return null;
        }

        $this->insertJobs((string) $material['id'], [[
            'student_id' => $studentId,
            'source_hash' => $identity['source_hash'],
            'variant_key' => $identity['variant_key'],
        ]], $priority);

        return (string) $identity['variant_key'];
    }

    /**
     * Insert jobs without ever creating a duplicate.
     *
     * The unique key is (material, student, variant). A row that already exists:
     *   • queued / processing → priority is raised if the new request is more
     *     urgent (a student is waiting) and the row is left alone otherwise, so a
     *     running render is never disturbed;
     *   • ready / failed / skipped → reset to `queued` (attempts cleared), because
     *     the copy this row describes is missing again (retention sweep, manual
     *     delete, a student retry, or a skipped job whose source came back).
     *
     * @param array<int,array{student_id:string,source_hash:string,variant_key:string}> $rows
     */
    private function insertJobs(string $materialId, array $rows, int $priority): int
    {
        if ($rows === []) {
            return 0;
        }
        $db = Database::instance();
        $now = gmdate('Y-m-d H:i:s');
        $key = static fn (array $row): string => $row['student_id'] . '|' . $row['variant_key'];

        // Which of these (student, variant) pairs already exist? One read per
        // chunk, so a roster of hundreds of students still costs a handful of
        // statements instead of one per student.
        $found = [];
        foreach (array_chunk($rows, self::INSERT_CHUNK) as $chunk) {
            $where = [];
            $bind = [$materialId];
            foreach ($chunk as $row) {
                $where[] = '(student_id = ? AND variant_key = ?)';
                $bind[] = (string) $row['student_id'];
                $bind[] = (string) $row['variant_key'];
            }
            foreach ($db->select(
                'SELECT student_id, variant_key FROM lesson_material_pdf_jobs
                  WHERE material_id = ? AND (' . implode(' OR ', $where) . ')',
                $bind
            ) as $hit) {
                $found[(string) $hit['student_id'] . '|' . (string) $hit['variant_key']] = true;
            }
        }

        $fresh = [];
        foreach ($rows as $row) {
            if (!isset($found[$key($row)]) && !isset($fresh[$key($row)])) {
                $fresh[$key($row)] = $row;
            }
        }

        // New copies: a plain multi-row INSERT. The UNIQUE key is the real
        // duplicate guard; a request that loses the race raises a duplicate-key
        // error and simply falls through to the UPDATE below.
        $inserted = [];
        foreach (array_chunk(array_values($fresh), self::INSERT_CHUNK) as $chunk) {
            $values = [];
            $bind = [];
            foreach ($chunk as $row) {
                $values[] = '(?, ?, ?, ?, ?, ?, ?, ?)';
                array_push(
                    $bind,
                    Uuid::v4(),
                    $materialId,
                    (string) $row['student_id'],
                    (string) $row['source_hash'],
                    (string) $row['variant_key'],
                    self::STATUS_QUEUED,
                    $priority,
                    $now
                );
            }
            try {
                $db->query(
                    'INSERT INTO lesson_material_pdf_jobs
                         (id, material_id, student_id, source_hash, variant_key, status, priority, run_after)
                     VALUES ' . implode(', ', $values),
                    $bind
                );
                foreach ($chunk as $row) {
                    $inserted[$key($row)] = true;
                }
            } catch (\PDOException) {
                // Duplicate key: another request wrote these rows first. The
                // UPDATE below still applies the priority/reset rules.
                foreach ($chunk as $row) {
                    $found[$key($row)] = true;
                }
            }
        }

        // Rows that were already there: raise priority (a student is waiting)
        // and restart only TERMINAL ones. A queued/processing copy is left
        // exactly as it is — resetting it would orphan a running claim.
        //
        // `status` is assigned LAST on purpose: MySQL and SQLite both evaluate
        // SET left to right, so every CASE above still sees the OLD status.
        $revisit = [];
        foreach ($rows as $row) {
            if (isset($found[$key($row)]) && !isset($inserted[$key($row)]) && !isset($revisit[$key($row)])) {
                $revisit[$key($row)] = $row;
            }
        }
        foreach (array_chunk(array_values($revisit), self::INSERT_CHUNK) as $chunk) {
            $where = [];
            $bind = [$priority, $priority, $now, $now, $materialId];
            foreach ($chunk as $row) {
                $where[] = '(student_id = ? AND variant_key = ?)';
                $bind[] = (string) $row['student_id'];
                $bind[] = (string) $row['variant_key'];
            }
            // "Keep the row as it is" = in flight, OR parked after exhausting its
            // attempts. Case 2 is essential: without it every page load would
            // silently reset a permanently failing job, the client would never
            // see `failed`, and cron would re-render a broken source forever.
            // A student who presses Retry goes through `retry()`, which resets it
            // on purpose.
            $keep = "status IN ('queued', 'processing') OR (status = 'failed' AND attempts >= max_attempts)";
            $db->query(
                "UPDATE lesson_material_pdf_jobs
                    SET priority   = CASE WHEN priority > ? THEN ? ELSE priority END,
                        attempts   = CASE WHEN {$keep} THEN attempts ELSE 0 END,
                        run_after  = CASE WHEN {$keep} THEN run_after ELSE ? END,
                        last_error = CASE WHEN {$keep} THEN last_error ELSE NULL END,
                        status     = CASE WHEN {$keep} THEN status ELSE 'queued' END,
                        updated_at = ?
                  WHERE material_id = ? AND (" . implode(' OR ', $where) . ')'
                    , $bind
            );
        }

        return count($rows);
    }

    /**
     * Raise an existing queued job to "a student is waiting", or create one.
     * Returns the variant key when the copy is (now) queued or in progress.
     */
    public function prioritize(array $material, string $studentId, bool $authorized = true): ?string
    {
        $variantKey = $this->enqueueStudent($material, $studentId, self::PRIORITY_STUDENT, $authorized);
        if ($variantKey === null) {
            return null;
        }
        try {
            Database::instance()->query(
                "UPDATE lesson_material_pdf_jobs
                    SET priority = ?, updated_at = ?
                  WHERE material_id = ? AND student_id = ? AND variant_key = ?
                    AND status = 'queued'",
                [self::PRIORITY_STUDENT, gmdate('Y-m-d H:i:s'), (string) $material['id'], $studentId, $variantKey]
            );
        } catch (\Throwable) {
            // Priority is an optimization; never fail the request over it.
        }
        return $variantKey;
    }

    // ── Status for the client ─────────────────────────────────────────────────

    /**
     * What the client should be told about this student's copy.
     *
     * `ready` is reported ONLY when a valid registered copy exists; the caller
     * passes `$hasValidCopy` from MaterialPdfVariantService (which re-checks the
     * source hash and the file). A row saying "ready" is never trusted alone.
     *
     * ── THE WAIT CONTRACT ──────────────────────────────────────────────────
     * A student told to wait must be told HOW LONG, without the server
     * inventing a number. `state` names the situation (`queued`, `generating`,
     * `ready`, `failed`, `unavailable`) and three measured inputs back it:
     *
     *   • `queue_position` / `jobs_ahead` — the row's REAL rank in the worker's
     *     own claim order (`priority ASC, run_after ASC, created_at ASC`),
     *     counted over jobs that are due NOW (a job still inside retry backoff
     *     blocks nobody). A prewarm job's rank is by AGE instead, because the
     *     aging reservation (claimAgedPrewarm) serves the oldest one first.
     *   • `eta_min_seconds` / `eta_max_seconds` / `eta_seconds` — the configured
     *     worker interval and job budget, this job's own `run_after`, and the
     *     MEDIAN of recent successful render durations (`ready_at - locked_at`).
     *   • `eta_basis` — why the numbers are what they are. With fewer than
     *     ETA_MIN_SAMPLES measurements EVERY eta field is NULL
     *     (`insufficient_samples`): an unsupported estimate is never returned,
     *     and the client shows a transparent fallback instead.
     *
     * The range exists because the next cron tick may be imminent or a full
     * interval away; `eta_seconds` is the conservative upper bound.
     * `retry_after` stays a POLLING INTERVAL and is never an ETA.
     *
     * Only counts are exposed — never another student's identity or document.
     * Reads are bounded (at most four small indexed queries) and run only while
     * a copy is actually pending.
     *
     * @return array{status:string,state:string,attempts:int,max_attempts:int,reason:?string,retry_after:int,queue_position:?int,jobs_ahead:?int,processing_now:int,eta_seconds:?int,eta_min_seconds:?int,eta_max_seconds:?int,eta_basis:string,eta_samples:int}
     */
    public function statusFor(array $material, string $studentId, ?string $variantKey, bool $hasValidCopy): array
    {
        if ($hasValidCopy) {
            // array_merge, NOT `+`: the shared payload already carries null eta
            // fields, and `+` never overwrites an existing key.
            return array_merge(
                $this->statusPayload(self::STATUS_READY, 0, self::DEFAULT_MAX_ATTEMPTS, null, 0, self::STATE_READY),
                ['eta_seconds' => 0, 'eta_min_seconds' => 0, 'eta_max_seconds' => 0, 'eta_basis' => 'already_ready']
            );
        }

        $row = null;
        try {
            $columns = 'id, status, attempts, max_attempts, last_error, run_after, priority, created_at';
            $row = $variantKey !== null
                ? Database::instance()->row(
                    "SELECT {$columns}
                       FROM lesson_material_pdf_jobs
                      WHERE material_id = ? AND student_id = ? AND variant_key = ? LIMIT 1",
                    [(string) $material['id'], $studentId, $variantKey]
                )
                : Database::instance()->row(
                    "SELECT {$columns}
                       FROM lesson_material_pdf_jobs
                      WHERE material_id = ? AND student_id = ?
                      ORDER BY updated_at DESC LIMIT 1",
                    [(string) $material['id'], $studentId]
                );
        } catch (\Throwable $e) {
            // The queue table is not migrated yet (038 not applied). Report the
            // honest state instead of inventing "ready".
            error_log('[material-pdf-queue] status read failed: ' . $e->getMessage());
            return array_merge(
                $this->statusPayload(self::STATUS_QUEUED, 0, self::DEFAULT_MAX_ATTEMPTS, 'queue_unavailable', 60, self::STATE_UNAVAILABLE),
                ['eta_basis' => 'queue_unavailable']
            );
        }

        if ($row === null) {
            return array_merge(
                $this->statusPayload(self::STATUS_QUEUED, 0, self::DEFAULT_MAX_ATTEMPTS, null, 10, self::STATE_QUEUED),
                ['eta_basis' => 'no_job_row']
            );
        }

        $status = (string) $row['status'];
        $retryAfter = 10;
        if ($status === self::STATUS_QUEUED) {
            $runAt = strtotime((string) $row['run_after'] . ' UTC') ?: time();
            $retryAfter = max(5, min(120, $runAt - time()));
        } elseif ($status === self::STATUS_PROCESSING) {
            $retryAfter = 15;
        } elseif ($status === self::STATUS_FAILED) {
            $retryAfter = 0;
        } elseif ($status === self::STATUS_READY) {
            // A "ready" job whose copy is missing (swept/removed): it will be
            // re-queued by the delivery path on the next request.
            $status = self::STATUS_QUEUED;
        } elseif ($status === self::STATUS_SKIPPED) {
            $status = self::STATUS_FAILED;
        }

        $state = match ($status) {
            self::STATUS_PROCESSING => self::STATE_GENERATING,
            self::STATUS_FAILED => self::STATE_FAILED,
            default => self::STATE_QUEUED,
        };

        $payload = $this->statusPayload(
            $status,
            (int) $row['attempts'],
            (int) $row['max_attempts'],
            $row['last_error'] !== null && $row['last_error'] !== '' ? (string) $row['last_error'] : null,
            $retryAfter,
            $state
        );

        // The estimate is computed only for a copy that is genuinely waiting: a
        // failed job has no future, and the queue table may not exist at all.
        if ($state === self::STATE_QUEUED || $state === self::STATE_GENERATING) {
            try {
                $payload = array_merge($payload, $this->estimateFor($row, $state));
            } catch (\Throwable $e) {
                // An estimate is a convenience. A failing estimate must never
                // turn a healthy pending state into an error response.
                error_log('[material-pdf-queue] estimate failed: ' . $e->getMessage());
                $payload['eta_basis'] = 'estimate_failed';
            }
        }

        return $payload;
    }

    /**
     * The shared shape of every status answer, so no branch can omit a wait
     * field: callers get explicit nulls rather than undefined keys.
     */
    private function statusPayload(
        string $status,
        int $attempts,
        int $maxAttempts,
        ?string $reason,
        int $retryAfter,
        string $state
    ): array {
        return [
            'status' => $status,
            'state' => $state,
            'attempts' => $attempts,
            'max_attempts' => $maxAttempts,
            'reason' => $reason,
            'retry_after' => $retryAfter,
            'queue_position' => null,
            'jobs_ahead' => null,
            'processing_now' => 0,
            'eta_seconds' => null,
            'eta_min_seconds' => null,
            'eta_max_seconds' => null,
            'eta_basis' => 'unknown',
            'eta_samples' => 0,
        ];
    }

    /**
     * How long this student's copy is likely to take, from measurement.
     *
     * MODEL (deliberately conservative, and only as good as its inputs):
     *   runs      = ceil(rank / slots)   — slots is per worker run
     *   eta_min   = notBefore + (runs - 1) * interval + render
     *   eta_max   = notBefore + runs * interval + render
     *   eta       = eta_max              — the promise the UI shows
     *
     * `slots` differs by class because the two classes compete differently:
     *   • interactive (priority 0): `jobsPerRun - reservedPrewarmClaims`, because
     *     at most the reservation can be taken by aged background work;
     *   • prewarm (priority 10): `reservedPrewarmClaims`, because that reservation
     *     is the ONLY guaranteed progress background work gets while students keep
     *     arriving — its rank therefore counts prewarm jobs, not all jobs.
     *
     * With no measurement yet, or when the reservation is disabled (so prewarm
     * has no guaranteed slot), every eta field is null. Honest, not invented.
     */
    private function estimateFor(array $row, string $state): array
    {
        $now = time();
        $processing = $this->processingCount();
        $samples = $this->recentRenderSamples();
        $render = count($samples) >= self::ETA_MIN_SAMPLES ? $this->median($samples) : null;
        $basis = $render === null ? 'insufficient_samples' : 'measured_render_median';

        if ($state === self::STATE_GENERATING) {
            $upper = $render === null ? null : max(30, (int) round($render * 2));
            return [
                'queue_position' => null,
                'jobs_ahead' => null,
                'processing_now' => $processing,
                'eta_seconds' => $upper,
                'eta_min_seconds' => $upper === null ? null : 1,
                'eta_max_seconds' => $upper,
                'eta_basis' => $basis,
                'eta_samples' => count($samples),
            ];
        }

        $priority = (int) ($row['priority'] ?? self::PRIORITY_PREWARM);
        $ahead = $this->jobsAhead($row, $priority);
        $position = $ahead['all'] + 1;

        $interval = self::workerIntervalSeconds();
        $perRun = self::workerJobsPerRun();
        $reserve = self::reservedPrewarmClaims();
        $runAfterTs = strtotime((string) $row['run_after'] . ' UTC') ?: $now;
        $notBefore = max(0, $runAfterTs - $now);

        $interactive = $priority <= self::PRIORITY_STUDENT;
        $slots = $interactive ? max(1, $perRun - $reserve) : $reserve;

        if ($render === null || $slots < 1) {
            return [
                'queue_position' => $position,
                'jobs_ahead' => $ahead['all'],
                'processing_now' => $processing,
                'eta_seconds' => null,
                'eta_min_seconds' => null,
                'eta_max_seconds' => null,
                'eta_basis' => $render === null ? $basis : 'no_guaranteed_slot',
                'eta_samples' => count($samples),
            ];
        }

        $rank = max(1, $ahead['class'] + 1);
        $runs = max(1, (int) ceil($rank / $slots));
        $renderSeconds = max(1, (int) round($render));
        $min = $notBefore + ($runs - 1) * $interval + $renderSeconds;
        $max = $notBefore + $runs * $interval + $renderSeconds;

        return [
            'queue_position' => $position,
            'jobs_ahead' => $ahead['all'],
            'processing_now' => $processing,
            'eta_seconds' => $max,
            'eta_min_seconds' => $min,
            'eta_max_seconds' => $max,
            'eta_basis' => $basis,
            'eta_samples' => count($samples),
        ];
    }

    /**
     * How many DUE jobs rank ahead of this one.
     *
     * `all` is the honest claim-order rank (what the worker's ORDER BY does), and
     * is what the student is shown. `class` is the rank that decides the ETA: for
     * an interactive job the two are identical (nothing outranks priority 0),
     * while for a prewarm job it counts prewarm jobs only, because the aging
     * reservation serves the OLDEST prewarm job first.
     *
     * A job in retry backoff (`run_after` in the future) is filtered out: it is
     * not eligible for the next claim and therefore blocks nobody.
     *
     * @return array{all:int,class:int}
     */
    private function jobsAhead(array $row, int $priority): array
    {
        $db = Database::instance();
        $now = gmdate('Y-m-d H:i:s');
        $id = (string) $row['id'];
        $runAfter = (string) $row['run_after'];
        $createdAt = (string) $row['created_at'];

        $all = (int) $db->value(
            "SELECT COUNT(*) FROM lesson_material_pdf_jobs
              WHERE status = 'queued' AND run_after <= ? AND id <> ?
                AND (priority < ?
                     OR (priority = ? AND (run_after < ? OR (run_after = ? AND created_at < ?))))",
            [$now, $id, $priority, $priority, $runAfter, $runAfter, $createdAt],
            0
        );

        if ($priority <= self::PRIORITY_STUDENT) {
            return ['all' => $all, 'class' => $all];
        }

        $class = (int) $db->value(
            "SELECT COUNT(*) FROM lesson_material_pdf_jobs
              WHERE status = 'queued' AND run_after <= ? AND id <> ?
                AND priority >= ?
                AND (created_at < ? OR (created_at = ? AND id < ?))",
            [$now, $id, self::PRIORITY_PREWARM, $createdAt, $createdAt, $id],
            0
        );

        return ['all' => $all, 'class' => $class];
    }

    /** Jobs a worker is rendering right now (how many are in flight). */
    private function processingCount(): int
    {
        return (int) Database::instance()->value(
            "SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE status = 'processing'",
            [],
            0
        );
    }

    /**
     * Durations of recent SUCCESSFUL renders, in seconds.
     *
     * `ready_at - locked_at` is a pure render measurement: `locked_at` is set when
     * a worker claims the job and (by design) kept on the finished row, so the
     * pair records exactly what a copy cost without the queue wait mixed in.
     *
     * Bounded and index-ordered: only `ready` rows scheduled in the last week,
     * read in `run_after` order (the second key of the claim index) so the
     * database never has to sort a large table. Implausible values are dropped.
     *
     * @return array<int,float>
     */
    private function recentRenderSamples(): array
    {
        if (is_array($this->renderSamples)) {
            return $this->renderSamples;
        }
        try {
            $rows = Database::instance()->select(
                'SELECT ready_at, locked_at FROM lesson_material_pdf_jobs
                  WHERE status = ? AND ready_at IS NOT NULL AND locked_at IS NOT NULL
                    AND run_after >= ?
                  ORDER BY run_after DESC
                  LIMIT ' . self::ETA_SAMPLE_LIMIT,
                [self::STATUS_READY, gmdate('Y-m-d H:i:s', time() - self::ETA_SAMPLE_WINDOW_SECONDS)]
            );
        } catch (\Throwable $e) {
            error_log('[material-pdf-queue] render samples unavailable: ' . $e->getMessage());
            return $this->renderSamples = [];
        }

        $samples = [];
        foreach ($rows as $row) {
            $ready = strtotime((string) $row['ready_at'] . ' UTC');
            $locked = strtotime((string) $row['locked_at'] . ' UTC');
            if ($ready === false || $locked === false) {
                continue;
            }
            $seconds = (float) $ready - (float) $locked;
            // 0 (sub-second or clock rounding) and anything over an hour are not
            // a render measurement; they are noise this estimate must not learn
            // from.
            if ($seconds > 0 && $seconds <= 3600) {
                $samples[] = $seconds;
            }
        }

        return $this->renderSamples = $samples;
    }

    /** @param array<int,float> $values */
    private function median(array $values): float
    {
        sort($values);
        $count = count($values);
        $middle = intdiv($count, 2);
        return $count % 2 === 1
            ? (float) $values[$middle]
            : ((float) $values[$middle - 1] + (float) $values[$middle]) / 2;
    }

    // ── Worker: claim / complete / retry ──────────────────────────────────────

    /**
     * Claim up to `$limit` due jobs for this worker.
     *
     * Two statements, no `SKIP LOCKED` (MariaDB on cPanel may not support it):
     *   1. read candidate ids in priority order;
     *   2. claim each with `WHERE status = 'queued'` — only the worker whose
     *      UPDATE actually changed the row owns it.
     * The claim is then read back by `lock_token`, so a worker can never pick up
     * a row another worker won.
     *
     * @return array<int,array<string,mixed>>
     */
    public function claim(int $limit, string $workerId): array
    {
        $limit = max(1, min(100, $limit));
        $now = gmdate('Y-m-d H:i:s');
        $candidates = Database::instance()->select(
            "SELECT id FROM lesson_material_pdf_jobs
              WHERE status = 'queued' AND run_after <= ?
              ORDER BY priority ASC, run_after ASC, created_at ASC
              LIMIT {$limit}",
            [$now]
        );

        return $this->claimIds($candidates, $workerId);
    }

    /**
     * Claim the OLDEST prewarm job that has already waited `$minWaitSeconds`.
     *
     * ── THE AGING POLICY (why this exists) ─────────────────────────────────
     * Strict `priority ASC` ordering means an unstarted background pre-generation
     * job is deferred for as long as ANY student request keeps arriving — measured, not
     * theoretical (see scripts/loadtest/PDF_WORKER_PERFORMANCE_AUDIT.md §7 C5).
     * The fix is bounded, not a priority inversion:
     *
     *   • only PREWARM rows (priority >= 10) are eligible — an unstarted student
     *     request (0) always outranks them, so interactive work is never starved;
     *   • only rows already older than the starvation window, so newly uploaded
     *     material cannot jump an active queue;
     *   • the OLDEST such row first, so the policy can never leave one background
     *     job permanently behind newer ones;
     *   • at most `reservedPrewarmClaims()` slots PER WORKER RUN are taken this
     *     way (the worker asks for this claim before its normal claims), so a run
     *     with `--limit=5` still spends 4 of its 5 slots on waiting students.
     *
     * Ordering is by `created_at`, which is the age the policy is about — the
     * opposite of `claim()`, where the interactive priority dominates.
     *
     * @return array<int,array<string,mixed>>
     */
    public function claimAgedPrewarm(string $workerId, ?int $minWaitSeconds = null): array
    {
        if (self::reservedPrewarmClaims() < 1) {
            return [];
        }
        $wait = max(60, $minWaitSeconds ?? self::prewarmStarvationSeconds());
        $now = gmdate('Y-m-d H:i:s');
        $cutoff = gmdate('Y-m-d H:i:s', time() - $wait);

        $candidates = Database::instance()->select(
            "SELECT id FROM lesson_material_pdf_jobs
              WHERE status = 'queued' AND run_after <= ?
                AND priority >= ? AND created_at <= ?
              ORDER BY created_at ASC, id ASC
              LIMIT 1",
            [$now, self::PRIORITY_PREWARM, $cutoff]
        );

        return $this->claimIds($candidates, $workerId);
    }

    /**
     * Atomically claim the given candidate rows and read the claim back.
     *
     * One conditional UPDATE per row, `WHERE status = 'queued'` — the only worker
     * whose UPDATE actually changed the row owns it. The claim is then re-read by
     * `lock_token`, so a worker can never pick up a row another worker won.
     *
     * @param array<int,array<string,mixed>> $candidates id-bearing rows
     * @return array<int,array<string,mixed>>
     */
    private function claimIds(array $candidates, string $workerId): array
    {
        if ($candidates === []) {
            return [];
        }
        $now = gmdate('Y-m-d H:i:s');
        $token = Uuid::v4();
        $claimed = [];
        $ids = array_map(static fn (array $r): string => (string) $r['id'], $candidates);
        foreach ($ids as $id) {
            $stmt = Database::instance()->query(
                "UPDATE lesson_material_pdf_jobs
                    SET status = 'processing', lock_token = ?, locked_by = ?,
                        locked_at = ?, updated_at = ?
                  WHERE id = ? AND status = 'queued' AND run_after <= ?",
                [$token, $workerId, $now, $now, $id, $now]
            );
            if ($stmt->rowCount() === 1) {
                $claimed[] = $id;
            }
        }
        if ($claimed === []) {
            return [];
        }

        $placeholders = implode(', ', array_fill(0, count($claimed), '?'));
        return Database::instance()->select(
            "SELECT * FROM lesson_material_pdf_jobs
              WHERE lock_token = ? AND id IN ({$placeholders})",
            array_merge([$token], $claimed)
        );
    }

    /**
     * Mark a claimed job as produced. Only the holding worker can do this.
     *
     * `locked_at` is deliberately KEPT on the finished row. It is the only
     * persisted record of when the render started, and `ready_at - locked_at` is
     * exactly the render measurement the waiting-time estimate learns from
     * (recentRenderSamples()). It cannot be mistaken for a live claim: every
     * claim, completion and recovery path additionally requires
     * `status = 'processing'`, which a ready row is not. The claim identity
     * (`lock_token`, `locked_by`) is still cleared, so a finished job can never be
     * completed or failed twice.
     */
    public function markReady(string $jobId, string $lockToken): bool
    {
        $now = gmdate('Y-m-d H:i:s');
        $stmt = Database::instance()->query(
            "UPDATE lesson_material_pdf_jobs
                SET status = 'ready', ready_at = ?,
                    lock_token = NULL, locked_by = NULL,
                    last_error = NULL, updated_at = ?
              WHERE id = ? AND lock_token = ? AND status = 'processing'",
            [$now, $now, $jobId, $lockToken]
        );
        return $stmt->rowCount() === 1;
    }

    /**
     * Put a claimed job back WITHOUT counting a failure (the worker ran out of
     * time budget, or the host asked it to stop). Used by the cron worker when
     * its wall-clock budget is spent, so work is never lost to a timeout.
     */
    public function release(string $jobId, string $lockToken, string $reason = 'deferred'): bool
    {
        $stmt = Database::instance()->query(
            "UPDATE lesson_material_pdf_jobs
                SET status = 'queued', last_error = ?, lock_token = NULL,
                    locked_at = NULL, locked_by = NULL, updated_at = ?
              WHERE id = ? AND lock_token = ? AND status = 'processing'",
            [mb_substr($reason, 0, 191), gmdate('Y-m-d H:i:s'), $jobId, $lockToken]
        );
        return $stmt->rowCount() === 1;
    }

    /** Terminal for this attempt; retries are scheduled with backoff. */
    public function markSkipped(string $jobId, string $lockToken, string $reason): void
    {
        Database::instance()->query(
            "UPDATE lesson_material_pdf_jobs
                SET status = 'skipped', last_error = ?, lock_token = NULL,
                    locked_at = NULL, locked_by = NULL, updated_at = ?
              WHERE id = ? AND lock_token = ? AND status = 'processing'",
            [mb_substr($reason, 0, 191), gmdate('Y-m-d H:i:s'), $jobId, $lockToken]
        );
    }

    /**
     * Record a failure. `attempts` is incremented; below `max_attempts` the job
     * returns to the queue after an exponential backoff, at or above it the job
     * is parked as `failed` with the stage the caller named.
     *
     * @return string the resulting status (queued|failed)
     */
    public function markFailed(string $jobId, string $lockToken, string $reason): string
    {
        $reason = mb_substr($reason !== '' ? $reason : 'render_failed', 0, 191);
        $row = Database::instance()->row(
            'SELECT attempts, max_attempts FROM lesson_material_pdf_jobs
              WHERE id = ? AND lock_token = ? AND status = ? LIMIT 1',
            [$jobId, $lockToken, self::STATUS_PROCESSING]
        );
        if ($row === null) {
            return self::STATUS_FAILED;
        }
        $attempts = (int) $row['attempts'] + 1;
        $max = max(1, (int) $row['max_attempts']);

        $now = gmdate('Y-m-d H:i:s');
        if ($attempts >= $max) {
            Database::instance()->query(
                "UPDATE lesson_material_pdf_jobs
                    SET status = 'failed', attempts = ?, last_error = ?,
                        lock_token = NULL, locked_at = NULL, locked_by = NULL,
                        updated_at = ?
                  WHERE id = ? AND lock_token = ?",
                [$attempts, $reason, $now, $jobId, $lockToken]
            );
            return self::STATUS_FAILED;
        }

        // 30s, 60s, 120s, … capped at 30 min. A cron run is not blocked on it.
        $delay = min(1800, 30 * (2 ** ($attempts - 1)));
        Database::instance()->query(
            "UPDATE lesson_material_pdf_jobs
                SET status = 'queued', attempts = ?, last_error = ?,
                    run_after = ?,
                    lock_token = NULL, locked_at = NULL, locked_by = NULL,
                    updated_at = ?
              WHERE id = ? AND lock_token = ?",
            [$attempts, $reason, gmdate('Y-m-d H:i:s', time() + $delay), $now, $jobId, $lockToken]
        );
        return self::STATUS_QUEUED;
    }

    /**
     * Reclaim jobs whose worker died (deploy, timeout, host kill) — the lock is
     * older than `$staleSeconds`. Below `max_attempts` they are re-queued; a job
     * that has exhausted its attempts is parked as `failed` so it stops looping.
     *
     * @return array{requeued:int,failed:int}
     */
    public function recoverStale(int $staleSeconds = 900): array
    {
        $stale = max(60, $staleSeconds);
        $cutoff = gmdate('Y-m-d H:i:s', time() - $stale);
        $now = gmdate('Y-m-d H:i:s');
        $failed = Database::instance()->query(
            "UPDATE lesson_material_pdf_jobs
                SET status = 'failed', attempts = attempts + 1,
                    last_error = COALESCE(last_error, 'stale_lock'),
                    lock_token = NULL, locked_at = NULL, locked_by = NULL,
                    updated_at = ?
              WHERE status = 'processing'
                AND (locked_at IS NULL OR locked_at < ?)
                AND attempts + 1 >= max_attempts",
            [$now, $cutoff]
        )->rowCount();

        $requeued = Database::instance()->query(
            "UPDATE lesson_material_pdf_jobs
                SET status = 'queued', attempts = attempts + 1,
                    last_error = COALESCE(last_error, 'stale_lock'),
                    run_after = ?,
                    lock_token = NULL, locked_at = NULL, locked_by = NULL,
                    updated_at = ?
              WHERE status = 'processing'
                AND (locked_at IS NULL OR locked_at < ?)
                AND attempts + 1 < max_attempts",
            [$now, $now, $cutoff]
        )->rowCount();

        return ['requeued' => $requeued, 'failed' => $failed];
    }

    /**
     * A student pressed "Retry" after a permanent failure. Re-queues ONLY their
     * own failed job — it cannot touch another student's copy, and it does not
     * reset a render that is already running.
     */
    public function retry(array $material, string $studentId): bool
    {
        $now = gmdate('Y-m-d H:i:s');
        $stmt = Database::instance()->query(
            "UPDATE lesson_material_pdf_jobs
                SET status = 'queued', attempts = 0, last_error = NULL,
                    priority = ?, run_after = ?,
                    lock_token = NULL, locked_at = NULL, locked_by = NULL,
                    updated_at = ?
              WHERE material_id = ? AND student_id = ?
                AND status IN ('failed', 'skipped')",
            [self::PRIORITY_STUDENT, $now, $now, (string) $material['id'], $studentId]
        );
        return $stmt->rowCount() > 0;
    }

    /** Drop jobs whose material no longer exists or is no longer a PDF. */
    public function dropOrphanedJobs(): int
    {
        return Database::instance()->query(
            'DELETE FROM lesson_material_pdf_jobs
              WHERE NOT EXISTS (SELECT 1 FROM lesson_materials lm WHERE lm.id = lesson_material_pdf_jobs.material_id)'
        )->rowCount();
    }

    // ── Retention (90 days) ───────────────────────────────────────────────────

    /**
     * Delete personalized copies older than `$days` from generation — never
     * originals, never a copy with an active job (queued/processing), and never
     * a file outside the `{course}/{material}/{student}/` folder its own
     * registry row names.
     *
     * Fixed 24h retention from generation (created_at); downloads do not reset
     * the clock.
     *
     * @return array{scanned:int,deleted:int,bytes:int,skipped_active:int,errors:int,files:array<int,string>}
     */
    public function sweepRetention(int $days = self::RETENTION_DAYS, int $limit = 200, bool $apply = false): array
    {
        $days = max(1, $days);
        $limit = max(1, min(2000, $limit));
        $cutoff = gmdate('Y-m-d H:i:s', time() - ($days * 86400));
        $stats = ['scanned' => 0, 'deleted' => 0, 'bytes' => 0, 'skipped_active' => 0, 'errors' => 0, 'files' => []];

        $rows = Database::instance()->select(
            "SELECT p.id, p.material_id, p.student_id, p.storage_path, p.file_size,
                    lm.course_id
               FROM lesson_material_pdfs p
               JOIN lesson_materials lm ON lm.id = p.material_id
              WHERE p.created_at < ?
              ORDER BY p.created_at ASC
              LIMIT {$limit}",
            [$cutoff]
        );

        foreach ($rows as $row) {
            $stats['scanned']++;
            $materialId = (string) $row['material_id'];
            $studentId = (string) $row['student_id'];

            $active = (int) Database::instance()->value(
                "SELECT COUNT(*) FROM lesson_material_pdf_jobs
                  WHERE material_id = ? AND student_id = ? AND status IN ('queued','processing')",
                [$materialId, $studentId],
                0
            );
            if ($active > 0) {
                $stats['skipped_active']++;
                continue;
            }

            $rel = (string) $row['storage_path'];
            // Ownership guard: only files under this material+student folder.
            $prefix = $this->variants->prefix(
                ['id' => $materialId, 'course_id' => (string) ($row['course_id'] ?? '')],
                $studentId
            );
            if ($rel === '' || str_contains($rel, '..') || !str_starts_with($rel, $prefix)) {
                $stats['errors']++;
                continue;
            }

            $stats['files'][] = $rel;
            $stats['bytes'] += (int) ($row['file_size'] ?? 0);
            $stats['deleted']++;
            if (!$apply) {
                continue;
            }
            try {
                Database::instance()->query('DELETE FROM lesson_material_pdfs WHERE id = ?', [(string) $row['id']]);
                $abs = $this->variants->storage()->privateFilePath(PdfWatermarkService::BUCKET, $rel);
                if (is_file($abs) && !@unlink($abs)) {
                    $stats['errors']++;
                }
            } catch (\Throwable $e) {
                $stats['errors']++;
                error_log('[material-pdf-retention] ' . $e->getMessage());
            }
        }

        return $stats;
    }

    /** Queue + storage health for the admin/host report. */
    public function health(): array
    {
        $db = Database::instance();
        $queued = (int) $db->value("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE status = 'queued'", [], 0);
        $processing = (int) $db->value("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE status = 'processing'", [], 0);
        $failed = (int) $db->value("SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE status = 'failed'", [], 0);
        $oldest = $db->value("SELECT MIN(created_at) FROM lesson_material_pdf_jobs WHERE status = 'queued'");
        $copies = (int) $db->value('SELECT COUNT(*) FROM lesson_material_pdfs', [], 0);
        $bytes = (int) $db->value('SELECT COALESCE(SUM(file_size), 0) FROM lesson_material_pdfs', [], 0);

        // Aging evidence for the host report: how much background work is waiting
        // and how much of it has already crossed the starvation window (i.e. is
        // about to take a reserved slot from interactive capacity).
        $prewarm = (int) $db->value(
            'SELECT COUNT(*) FROM lesson_material_pdf_jobs WHERE status = ? AND priority >= ?',
            [self::STATUS_QUEUED, self::PRIORITY_PREWARM],
            0
        );
        $starving = (int) $db->value(
            'SELECT COUNT(*) FROM lesson_material_pdf_jobs
              WHERE status = ? AND priority >= ? AND created_at <= ?',
            [self::STATUS_QUEUED, self::PRIORITY_PREWARM, gmdate('Y-m-d H:i:s', time() - self::prewarmStarvationSeconds())],
            0
        );

        return [
            'queued' => $queued,
            'processing' => $processing,
            'failed' => $failed,
            'oldest_queued_at' => is_string($oldest) ? $oldest : null,
            'copies' => $copies,
            'copy_bytes' => $bytes,
            'retention_days' => self::RETENTION_DAYS,
            'prewarm_queued' => $prewarm,
            'prewarm_starving' => $starving,
            'worker_interval_seconds' => self::workerIntervalSeconds(),
            'worker_jobs_per_run' => self::workerJobsPerRun(),
            'prewarm_reserved_claims' => self::reservedPrewarmClaims(),
            'prewarm_starvation_seconds' => self::prewarmStarvationSeconds(),
            'eta_samples' => count($this->recentRenderSamples()),
        ];
    }
}
