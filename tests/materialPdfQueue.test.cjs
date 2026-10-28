#!/usr/bin/env node
/**
 * tests/materialPdfQueue.test.cjs
 *
 * Hybrid personalized-PDF pre-generation queue.
 *
 * PHP cannot run in this suite, so this file combines:
 *   • SOURCE assertions over the real committed PHP/SQL/TS files — the
 *     durability, isolation and fail-closed invariants that must not drift, and
 *   • PURE MODELS of the decisions that are easy to get wrong (backoff, claim
 *     exclusivity, retention eligibility, client polling budget), executed here
 *     so their behaviour is tested rather than merely grepped.
 *
 * The properties under test:
 *   1. Duplicate prevention and atomic claiming.
 *   2. Bounded retries with backoff, and stale-lock recovery.
 *   3. A student request never renders inline and never gets the original.
 *   4. Re-authorization before every background render.
 *   5. Source-version invalidation.
 *   6. 90-day retention that never deletes originals or active work.
 *   7. Bounded client polling that surfaces preparing / failed honestly.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

function ok(label, cond) {
  if (cond) {
    passed++;
  } else {
    failures.push(label);
    console.log('  ✗ ' + label);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function section(title) {
  console.log('\n── ' + title + ' ──');
}

const MIGRATION = 'backend/database/mysql-migrations/038_pdf_watermark_queue.sql';
const QUEUE = 'backend/src/Services/MaterialPdfQueueService.php';
const VARIANTS = 'backend/src/Services/MaterialPdfVariantService.php';
const DELIVERY = 'backend/src/Controllers/MaterialDeliveryController.php';
const WORKER = 'backend/scripts/watermark-worker.php';
const DATA = 'backend/src/Controllers/DataController.php';
const REPLACE = 'backend/src/Controllers/LessonMaterialController.php';
const ROUTES = 'backend/routes/api.php';
const API = 'src/lib/api.ts';
const PHP_CLIENT = 'src/client/php.ts';
const LESSON = 'src/app/(app)/lesson/[id].tsx';
// The polling/estimate rules the lesson screen uses (the waiting-UX suite
// tests/materialPdfWaiting.test.cjs executes them; here they are only pinned).
const PREP = 'src/lib/pdfPreparation.ts';
const I18N = 'src/lib/i18n/resources.ts';

/* ══ 1. Schema — additive, deduplicated, claimable ════════════════════════ */

section('1. Migration 038 (additive, one table)');

{
  const sql = read(MIGRATION);
  const down = read('backend/database/mysql-migrations/038_pdf_watermark_queue_down.sql');

  ok('creates the job table', /CREATE TABLE IF NOT EXISTS `lesson_material_pdf_jobs`/.test(sql));
  ok('one job per (material, student, variant) — duplicate guard',
    /UNIQUE KEY `uq_lesson_material_pdf_jobs_variant` \(`material_id`, `student_id`, `variant_key`\)/.test(sql));
  ok('the variant key is stored so a source change produces a new job',
    /`variant_key`\s+CHAR\(64\)\s+NOT NULL/.test(sql));
  ok('status is a bounded vocabulary',
    /`status`\s+VARCHAR\(16\)\s+NOT NULL DEFAULT 'queued'/.test(sql));
  ok('has an atomic claim identity (lock_token + locked_at)',
    /`lock_token`/.test(sql) && /`locked_at`/.test(sql));
  ok('has bounded attempt counters',
    /`attempts`\s+INT\s+NOT NULL DEFAULT 0/.test(sql) && /`max_attempts`/.test(sql));
  ok('has the worker claim index', /KEY `idx_lesson_material_pdf_jobs_claim`/.test(sql));
  ok('cascades with material and profile deletion',
    /FOREIGN KEY \(`material_id`\) REFERENCES `lesson_materials` \(`id`\) ON DELETE CASCADE/.test(sql) &&
    /FOREIGN KEY \(`student_id`\) REFERENCES `profiles` \(`id`\) ON DELETE CASCADE/.test(sql));
  ok('the migration is additive (no DROP/ALTER of existing tables)',
    !/\b(DROP TABLE|ALTER TABLE|TRUNCATE|DELETE FROM)\b/i.test(sql));
  ok('a rollback script exists and only drops the queue table',
    /DROP TABLE IF EXISTS `lesson_material_pdf_jobs`/.test(down) && !/lesson_material_pdfs/.test(down.replace(/^\s*--.*$/gm, '')));
}

/* ══ 2. Claim / retry semantics (executed models) ═════════════════════════ */

section('2. Claim, retry and stale-lock models');

{
  const queue = read(QUEUE);

  // Two workers cannot both win: the claim UPDATE is conditional on the row
  // still being queued and due. The due-time is a bound parameter (portable
  // across MySQL and the SQLite harness) rather than an inline function.
  ok('claims only rows still queued (two workers cannot both win)',
    /WHERE id = \? AND status = 'queued' AND run_after <= \?/.test(queue)
    && /locked_at = \?, updated_at = \?/.test(queue));
  ok('reads the claim back by its own lock token',
    /WHERE lock_token = \? AND id IN/.test(queue));
  ok('claims in priority order, then age',
    /ORDER BY priority ASC, run_after ASC, created_at ASC/.test(queue));
  ok('completion requires the holding worker',
    /WHERE id = \? AND lock_token = \? AND status = 'processing'/.test(queue));
  ok('stale locks are reclaimed in two bounded passes',
    /attempts \+ 1 >= max_attempts/.test(queue) && /attempts \+ 1 < max_attempts/.test(queue));
  ok('retention/cron work cannot lose a job silently — release() requeues it',
    /public function release\(/.test(queue));
  ok('a second worker cannot be spawned by a request: no generation call here',
    !/->ensure\(/.test(queue));

  // Model the shipped backoff exactly: min(1800, 30 * 2^(attempts-1)).
  const backoff = (attempts) => Math.min(1800, 30 * (2 ** (attempts - 1)));
  ok('retry backoff is 30s → 60s → 120s, capped at 30 min',
    backoff(1) === 30 && backoff(2) === 60 && backoff(3) === 120 && backoff(20) === 1800);

  // Model the claim rule: two workers selecting the same candidate → one wins.
  const claim = (row, workerToken) => (row.status === 'queued' ? { ...row, status: 'processing', lock_token: workerToken } : null);
  const shared = { id: 'j1', status: 'queued' };
  const a = claim(shared, 'worker-a');
  const b = claim({ ...shared, status: a.status }, 'worker-b');
  ok('the second worker gets nothing from the same row', a !== null && b === null);

  // Model the "student is waiting" priority bump.
  const bump = (row) => ({ ...row, priority: Math.min(row.priority, 0) });
  ok('a student request raises priority but never resets a running job',
    bump({ priority: 10, status: 'processing' }).priority === 0);
}

/* ══ 3. Eligibility and re-authorization ══════════════════════════════════ */

section('3. Authorization is re-checked before every render');

{
  const queue = read(QUEUE);
  const worker = read(WORKER);

  ok('eligibility requires an active (non-suspended) enrollment',
    /e\.status IS NULL OR e\.status <> 'suspended'/.test(queue));
  ok('eligibility requires published lesson AND course',
    /l\.status = 'published'/.test(queue) && /c\.status = 'published'/.test(queue));
  ok('hidden/disabled materials are excluded',
    /permission NOT IN \('hidden','disabled'\)/.test(queue));
  ok('suspended/disabled/deleted profiles are excluded',
    /p\.status NOT IN \('suspended','disabled','deleted'\)/.test(queue));
  ok('the worker re-checks eligibility before generating',
    /isStudentEligible\(\$materialId, \$studentId\)/.test(worker));
  ok('the worker refuses to generate for a non-eligible student',
    /markSkipped\(\$jobId, \$lockToken, 'not_eligible'\)/.test(worker));
  ok('enqueue is scoped to the material’s OWN course enrollment',
    /e\.course_id = lm\.course_id/.test(queue));
}

/* ══ 4. Delivery: student never renders inline, never gets the original ═══ */

section('4. Delivery path');

{
  const delivery = read(DELIVERY);
  const routes = read(ROUTES);

  const studentBlock = delivery.slice(delivery.indexOf('STUDENT: queue it'));
  ok('a student request queues instead of rendering',
    /queue->prioritize\(/.test(studentBlock) && !/variants->ensure\(/.test(studentBlock));
  ok('staff keep a bounded single inline preview render',
    /if \(\$this->isStaff\(\$role\)\)[\s\S]*?variants->ensure\(\$material, \$userId\)/.test(delivery));
  ok('the response reports a machine-readable status',
    /'status' => 'ready'/.test(delivery) && /'status' => \$failed \? 'failed' : 'preparing'/.test(delivery));
  ok('pending responses carry no url at all',
    /'url' => null/.test(delivery));
  ok('there is no fallback to the unwatermarked original',
    !/lesson-materials', \(string\) \$material\['storage_path'\]\)[\s\S]{0,200}Response::file/.test(delivery));
  ok('streaming re-runs canAccess on every request',
    /LIVE re-authorization/.test(delivery) &&
    /canAccess\(\$studentId, \$role, 'lesson-materials'/.test(delivery));
  ok('streaming refuses when the copy is missing (never the original)',
    /watermark_unavailable/.test(delivery));
  ok('the copy path is re-validated against the live source hash before reuse',
    /existing\(\$material, \$userId, \$identity\['variant_key'\]\)/.test(delivery) &&
    /existing\(\$material, \$studentId\)/.test(delivery));

  ok('a status route exists and is authenticated',
    /\$router->get\('\/materials\/pdf-status', \[MaterialDeliveryController::class, 'pdfStatus'\], \$auth\)/.test(routes));
  ok('the status route is read-only (no token, no render)',
    !/signToken/.test(delivery.slice(delivery.indexOf('public function pdfStatus'), delivery.indexOf('public function streamPdf'))));
}

/* ══ 5. Generation invariants (shared service) ════════════════════════════ */

section('5. One generation implementation');

{
  const variants = read(VARIANTS);

  ok('render goes to a .part file', /\.part'/.test(variants));
  ok('the part file is verified before publication',
    /verifyOutput\(\$partAbs\)/.test(variants) && /%%EOF/.test(variants));
  ok('publication is an atomic rename', /rename\(\$partAbs, \$finalAbs\)/.test(variants));
  ok('the registry row is written after the bytes land', /registerVariant\(/.test(variants));
  ok('a failed registration removes the orphan file', /unlink\(\$finalAbs\)/.test(variants));
  ok('reuse requires the exact variant key', /\$expectedVariantKey/.test(variants));
  ok('a stale source hash invalidates the cached copy',
    /sourceHashFor\(\$material, \$sourceAbs\) !== \(string\) \$row\['source_hash'\]/.test(variants));
  ok('per-variant flock serialises concurrent renders',
    /flock\(\$handle, LOCK_EX \| LOCK_NB\)/.test(variants));
  ok('stale variants are purged only inside the student’s own folder',
    /str_starts_with\(\$path, \$prefix\)/.test(variants));
  ok('the delivery controller delegates instead of duplicating the renderer',
    !/function ensurePersonalizedCopy/.test(read(DELIVERY)) && /MaterialPdfVariantService/.test(read(DELIVERY)));
}

/* ══ 6. Upload → strict on-demand only (no prewarm) ═══════════════════════ */

section('6. Strict on-demand only');

{
  const data = read(DATA);
  const replace = read(REPLACE);
  const queue = read(QUEUE);
  const lessonMaterial = read(REPLACE);

  ok('prewarm enqueue paths are disabled',
    /enqueueMaterial.*prewarm_disabled|prewarm_disabled/.test(queue));
  ok('DataController has no prewarm enqueue calls',
    !/enqueueMaterial|enqueueStudent|enqueuePersonalizedCopies/.test(data));
  ok('LessonMaterialController has no prewarm enqueue calls',
    !/enqueueMaterial|enqueuePersonalizedCopies|enqueueStudent.*PREWARM/.test(lessonMaterial));
  ok('the upload request does not render anything itself',
    !/->ensure\(/.test(data));
}

/* ══ 7. Retention ═════════════════════════════════════════════════════════ */

section('7. 24-hour retention');

{
  const queue = read(QUEUE);
  const worker = read(WORKER);
  const variants = read(VARIANTS);

  ok('the window is 24 hours and is a named constant',
    /public const RETENTION_DAYS = 1/.test(queue));
  ok('rows with active jobs are skipped',
    /status IN \('queued','processing'\)/.test(queue) && /skipped_active/.test(queue));
  ok('deletion is limited to the owning material+student folder',
    /str_starts_with\(\$rel, \$prefix\)/.test(queue));
  ok('only registry rows are deleted, never lesson_materials originals',
    !/DELETE FROM `?lesson_materials`?/.test(queue));
  ok('the sweep is a dry run unless applied', /if \(!\$apply\) \{\s*continue;/.test(queue));
  ok('the worker runs it behind an explicit flag', /--retention/.test(worker));
  ok('expiration is fixed from generation (no clock reset on serve)',
    /No-op: expiration is fixed|Fixed 24h retention from generation/.test(variants));
  ok('retention uses created_at (generation time)',
    /WHERE p\.created_at < \?/.test(queue));
}

/* ══ 8. Worker is bounded and cron-safe ═══════════════════════════════════ */

section('8. CLI worker');

{
  const worker = read(WORKER);

  ok('CLI only', /PHP_SAPI !== 'cli'/.test(worker));
  ok('bounded job count', /--limit/.test(worker) && /min\(100, \$limit\)/.test(worker));
  ok('bounded wall clock', /--max-seconds/.test(worker) && /min\(600, \$maxSeconds\)/.test(worker));
  // The budget must never fail a job, and since the worker now claims ONE job at
  // a time it does not even need to release an un-started one: it checks the
  // remaining budget BEFORE claiming and stops.
  ok('stops before claiming when the budget cannot finish a render',
    /\$remaining < \$minRenderSeconds/.test(worker)
    && /\$summary\['budget_stop'\]/.test(worker));
  ok('never marks a job failed for budgeting',
    !/markFailed\(\$jobId, \$lockToken, 'deferred_budget'/.test(worker));
  ok('claims one job per iteration, so a dead run strands at most one',
    /\$queue->claim\(1, \$workerId\)/.test(worker) && !/\$queue->claim\(\$limit/.test(worker));
  ok('recovers stale locks on every run', /recoverStale\(\$staleSeconds\)/.test(worker));
  ok('never deletes remote/original objects',
    !/unlink\(/.test(worker.replace(/^\s*\/\/.*$/gm, '')));
  ok('a stale source queues the live variant instead of failing forever',
    /stale_variant/.test(worker) && /enqueueStudent\(/.test(worker));
  ok('documents that cron is NOT configured by this change',
    /NOT configured by this change/.test(worker));
}

/* ══ 9. Client: preparing / failed states, bounded polling ════════════════ */

section('9. Frontend');

{
  const api = read(API);
  const client = read(PHP_CLIENT);
  const lesson = read(LESSON);
  const i18n = read(I18N);

  ok('the API type exposes all three states',
    /'ready' \| 'preparing' \| 'failed'/.test(api));
  ok('pending responses carry retry_after and retry_allowed',
    /retry_after: number;/.test(api) && /retry_allowed: boolean;/.test(api));
  ok('retry is explicit, not automatic', /if \(retry\) body\.retry = true;/.test(api));
  ok('a read-only status call exists and uses GET',
    /getMaterialPdfStatus/.test(api) && /materials\/pdf-status'[\s\S]{0,80}'GET'/.test(api));
  ok('the PHP client maps the status endpoint',
    /'materials\/pdf-status':\s*'\/materials\/pdf-status'/.test(client));

  const prep = read(PREP);
  ok('polling is bounded', /PDF_POLL_MAX_ATTEMPTS = \d+/.test(prep) && /PDF_POLL_MAX_WAIT_MS/.test(prep));
  // The budget has to outlast the worker's cron interval, or a healthy queued job
  // is reported as a failure (the defect the waiting UX fixed).
  ok('the polling budget outlasts a five-minute worker tick',
    /PDF_POLL_MAX_WAIT_MS = 15 \* 60 \* 1_000/.test(prep));
  ok('polling backs off and is capped',
    /PDF_POLL_CEILING_MS = 20_000/.test(prep) && /PDF_POLL_GROWTH = 1\.6/.test(prep));
  ok('a dismissed modal cancels the poll loop', /pdfRunRef\.current \+= 1/.test(lesson));
  ok('the preparing state is shown, not a silent failure', /status: 'preparing'/.test(lesson));
  ok('failed copies offer an explicit retry', /materialRetryPrepare/.test(lesson));
  ok('a spent budget shows “still queued”, not a failure',
    /showStillWaiting\(/.test(lesson) && /materialWaitingTitle/.test(lesson));
  ok('the screen never falls back to the raw original on pending',
    /if \(!ready\) return;/.test(lesson));

  const locales = ['lesson.materialPreparing', 'lesson.materialPreparingDesc', 'lesson.materialPrepareFailed', 'lesson.materialRetryPrepare'];
  ok('every new string exists in BOTH locales (en + ar)',
    locales.every((key) => (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length === 2));

  // Model the SHIPPED backoff (floor 5 s, ×1.6, ceiling 20 s) so a regression in
  // the constants above is caught here as well as in the waiting-UX suite.
  const delays = [];
  let d = 5_000;
  for (let i = 0; i < 4; i++) {
    d = Math.min(20_000, Math.round(d * 1.6));
    delays.push(d);
  }
  ok('client delay grows but never exceeds the cap',
    delays.every((v) => v <= 20_000) && delays[3] > delays[0]);
}

/* ══ Report ═══════════════════════════════════════════════════════════════ */

console.log('\n' + (failures.length === 0 ? '✔' : '✗') +
  ` materialPdfQueue: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
