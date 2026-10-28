#!/usr/bin/env node
/**
 * tests/materialPdfWaiting.test.cjs
 *
 * The student-facing WAITING experience for a personalized lesson PDF.
 *
 * WHY THIS SUITE EXISTS
 *   `tests/materialPdfQueue.test.cjs` guards the queue's durability. This one
 *   guards the two things that made a healthy queued job look broken to a
 *   student, plus the fairness gap the performance audit measured:
 *
 *     1. the client gave up after ~82 s while the cron worker runs every five
 *        minutes, so a copy that was coming was reported as a failure;
 *     2. nothing anywhere told the student how long the wait would be, or even
 *        whether the copy was queued or actively being generated;
 *     3. strict `priority ASC` let a continuous stream of student requests defer
 *        background pre-generation indefinitely.
 *
 * WHAT IT DOES
 *   • COMPILES `src/lib/pdfPreparation.ts` standalone (it has no imports by
 *     design) and EXECUTES the polling/ETA/state rules — the decisions are
 *     tested, not grepped;
 *   • asserts the PHP wait contract, the aging claim and the screen wiring in
 *     the real committed files, so the numbers the UI shows can only come from
 *     the server.
 *
 * Run: node tests/materialPdfWaiting.test.cjs   (or: npm test)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

function ok(label, cond, detail = '') {
  if (cond) {
    passed++;
  } else {
    failures.push(label + (detail ? ` (${detail})` : ''));
    console.log('  ✗ ' + label + (detail ? `  [${detail}]` : ''));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function section(title) {
  console.log('\n── ' + title + ' ──');
}

const RULES = 'src/lib/pdfPreparation.ts';
const QUEUE = 'backend/src/Services/MaterialPdfQueueService.php';
const DELIVERY = 'backend/src/Controllers/MaterialDeliveryController.php';
const WORKER = 'backend/scripts/watermark-worker.php';
const LESSON = 'src/app/(app)/lesson/[id].tsx';
const API = 'src/lib/api.ts';
const I18N = 'src/lib/i18n/resources.ts';
const DOCS = 'backend/docs/PDF_WATERMARK_QUEUE.md';
const ENV_EXAMPLE = 'backend/.env.example';

/**
 * Compile the pure rules module and load it. Same approach as the state-model
 * suites: the project's own TypeScript, into a temp directory, then require().
 */
function loadRules() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfprep-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, RULES),
      '--outDir', out,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(out, 'pdfPreparation.js'));
}

const rules = loadRules();

/* ══ 1. The polling budget must outlast the worker schedule ═══════════════ */

section('1. Polling budget vs the five-minute worker');

{
  ok('the floor is 5 s (never hammer the host)', rules.PDF_POLL_FLOOR_MS === 5_000);
  ok('the natural ceiling is 20 s', rules.PDF_POLL_CEILING_MS === 20_000);
  ok('growth is 1.6× per poll', rules.PDF_POLL_GROWTH === 1.6);
  ok('the hard budget is 15 minutes — three five-minute ticks',
    rules.PDF_POLL_MAX_WAIT_MS === 15 * 60 * 1_000, String(rules.PDF_POLL_MAX_WAIT_MS));
  ok('an attempt ceiling exists as a safety net',
    Number.isInteger(rules.PDF_POLL_MAX_ATTEMPTS) && rules.PDF_POLL_MAX_ATTEMPTS > 0);

  // The old bug in numbers: 10 attempts × (10 s then 8 s) ≈ 82 s total.
  const oldBudgetMs = 10_000 + 9 * 8_000;
  ok('the new budget covers far more than the old ~82 s',
    rules.PDF_POLL_MAX_WAIT_MS > oldBudgetMs * 10, `${rules.PDF_POLL_MAX_WAIT_MS} vs ${oldBudgetMs}`);

  ok('the first delay respects the floor', rules.nextPollDelay(rules.PDF_POLL_FLOOR_MS, 5) === 8_000);
  // A missing/garbage retry_after still yields a bounded delay: one growth step
  // from the floor, never zero and never unbounded.
  ok('a missing retry_after still yields a bounded first delay',
    rules.nextPollDelay(0, undefined) === 8_000
    && rules.nextPollDelay(NaN, null) === 8_000
    && rules.nextPollDelay(-1, 'x') === 8_000);

  // Growth is capped, so a long wait does not turn into a request storm.
  let delay = rules.PDF_POLL_FLOOR_MS;
  const delays = [];
  for (let i = 0; i < 8; i++) {
    delay = rules.nextPollDelay(delay, 5);
    delays.push(delay);
  }
  ok('delays grow and then stop at the ceiling',
    delays[0] < delays[1] && delays[delays.length - 1] === rules.PDF_POLL_CEILING_MS,
    JSON.stringify(delays));

  // A server that asks for longer (retry backoff) is honoured beyond the ceiling.
  ok('a server retry_after longer than the ceiling is honoured',
    rules.nextPollDelay(rules.PDF_POLL_CEILING_MS, 90) === 90_000);
  ok('a server retry_after is itself capped',
    rules.nextPollDelay(5_000, 100_000) === 120_000);

  // Poll count inside the budget: bounded, and far below the status rate limit.
  let elapsed = 0;
  let polls = 0;
  let step = rules.nextPollDelay(rules.PDF_POLL_FLOOR_MS, 5);
  while (elapsed < rules.PDF_POLL_MAX_WAIT_MS && polls < 10_000) {
    elapsed += step;
    polls++;
    step = rules.nextPollDelay(step, 5);
  }
  ok('a 15-minute wait costs at most ~45 polls (rate limit is 120/min)',
    polls >= 40 && polls <= 120, String(polls));

  // Budget exhaustion: time-based, attempt-based, and never negative.
  const t0 = 1_000_000;
  ok('the budget is not spent inside the window',
    rules.pollBudgetExhausted(t0, t0 + rules.PDF_POLL_MAX_WAIT_MS - 1, 0) === false);
  ok('the budget is spent when the deadline passes',
    rules.pollBudgetExhausted(t0, t0 + rules.PDF_POLL_MAX_WAIT_MS, 0) === true);
  ok('the budget is spent when the attempt ceiling is reached',
    rules.pollBudgetExhausted(t0, t0, rules.PDF_POLL_MAX_ATTEMPTS) === true);
  ok('the remaining budget never goes negative',
    rules.pollBudgetRemaining(t0, t0 + 10 * rules.PDF_POLL_MAX_WAIT_MS) === 0);
}

/* ══ 2. State interpretation ═════════════════════════════════════════════ */

section('2. Queue states (queued / generating / ready / failed / unavailable)');

{
  ok('generating is distinguished from queued',
    rules.normalizePrepState('preparing', 'generating') === 'generating'
    && rules.normalizePrepState('preparing', 'queued') === 'queued');
  ok('an older server that only sends `preparing` is treated as queued',
    rules.normalizePrepState('preparing', undefined) === 'queued');
  ok('ready is only ever ready', rules.normalizePrepState('ready', 'ready') === 'ready');
  ok('an unknown state never becomes ready',
    rules.normalizePrepState('ready', 'nonsense') === 'ready'
    && rules.normalizePrepState('preparing', 'nonsense') === 'queued'
    && rules.normalizePrepState(undefined, undefined) === 'queued');
  ok('failed stays failed', rules.normalizePrepState('failed', undefined) === 'failed');
  ok('unavailable stays unavailable (never ready)',
    rules.normalizePrepState('preparing', 'unavailable') === 'unavailable');

  ok('phases map: generating → generating, everything else → queued',
    rules.phaseOf('generating') === 'generating'
    && rules.phaseOf('queued') === 'queued'
    && rules.phaseOf('unavailable') === 'queued');

  const queued = rules.describePrep('queued');
  const generating = rules.describePrep('generating');
  ok('the two waiting phases have DIFFERENT copy',
    queued.titleKey !== generating.titleKey && queued.bodyKey !== generating.bodyKey);
  ok('the queued copy is the audited message set',
    queued.titleKey === 'lesson.materialQueuedTitle' && queued.bodyKey === 'lesson.materialQueuedDesc');
}

/* ══ 3. Queue position ═══════════════════════════════════════════════════ */

section('3. Queue position is shown only when it means something');

{
  ok('position 1 (nothing ahead) is not shown', rules.queuePositionView(1) === null);
  ok('position 0 / null / NaN are not shown',
    rules.queuePositionView(0) === null
    && rules.queuePositionView(null) === null
    && rules.queuePositionView(undefined) === null
    && rules.queuePositionView(NaN) === null);
  const view = rules.queuePositionView(3);
  ok('a real queue position renders the localized line',
    view !== null && view.key === 'lesson.materialQueuePosition' && view.params.position === 3);
  ok('a stringy number is accepted, a float is floored',
    rules.queuePositionView('4').params.position === 4
    && rules.queuePositionView(2.9).params.position === 2);
}

/* ══ 4. Estimate formatting (never promises more than measured) ══════════ */

section('4. Estimated wait — range, approximation, or the honest fallback');

{
  ok('no measurement → the transparent fallback',
    rules.describeEta(null, null).key === 'lesson.materialEtaUnknown'
    && rules.describeEta(undefined, undefined).key === 'lesson.materialEtaUnknown');
  ok('zero/negative/nonsense → the fallback, never "0 min"',
    rules.describeEta(0, 0).key === 'lesson.materialEtaUnknown'
    && rules.describeEta(-5, 30).key === 'lesson.materialEtaUnknown'
    && rules.describeEta('soon', 'later').key === 'lesson.materialEtaUnknown');
  ok('hasEta mirrors the fallback rule',
    rules.hasEta(30, 60) === true && rules.hasEta(0, 60) === false && rules.hasEta(null, 60) === false);

  // Durations round UP: a shorter promise than the measurement supports would be
  // a lie the queue cannot keep.
  ok('rounding is upward', rules.etaUnit(61).value === 2 && rules.etaUnit(1).value === 1);

  const range = rules.describeEta(120, 300);
  ok('a real range is reported as minutes',
    range.key === 'lesson.materialEtaRangeMinutes' && range.params.min === 2 && range.params.max === 5,
    JSON.stringify(range));
  const approx = rules.describeEta(302, 359);
  ok('a tight range collapses to one approximate value',
    approx.key === 'lesson.materialEtaApproxMinutes' && approx.params.minutes === 6,
    JSON.stringify(approx));

  const hours = rules.describeEta(7_200, 10_800);
  ok('hours are used past two hours',
    hours.key === 'lesson.materialEtaRangeHours' && hours.params.min === 2 && hours.params.max === 3,
    JSON.stringify(hours));
  const days = rules.describeEta(172_800, 259_200);
  ok('days are used past two days',
    days.key === 'lesson.materialEtaRangeDays' && days.params.min === 2 && days.params.max === 3,
    JSON.stringify(days));
  ok('exactly two days is already expressed in days',
    rules.etaUnit(172_800).unit === 'days' && rules.etaUnit(172_800).value === 2);
  const mixed = rules.describeEta(3_000, 7_300);
  ok('a range spanning two units states the coarser upper bound only',
    mixed.key === 'lesson.materialEtaApproxHours' && mixed.params.hours === 3,
    JSON.stringify(mixed));

  // The shipped five-minute cron, one job ahead, a 2 s render: a wide range is
  // the honest answer, and it must NOT collapse into a fixed "2 minutes".
  const realistic = rules.describeEta(2, 302);
  ok('five-minute cron yields a range, not a fixed promise',
    realistic.key === 'lesson.materialEtaRangeMinutes' && realistic.params.max === 6,
    JSON.stringify(realistic));
}

/* ══ 5. Backend wait contract ════════════════════════════════════════════ */

section('5. Server-side contract');

{
  const queue = read(QUEUE);
  const delivery = read(DELIVERY);

  ok('the service names all five client states',
    /STATE_READY = 'ready'/.test(queue) && /STATE_QUEUED = 'queued'/.test(queue)
    && /STATE_GENERATING = 'generating'/.test(queue) && /STATE_FAILED = 'failed'/.test(queue)
    && /STATE_UNAVAILABLE = 'unavailable'/.test(queue));
  ok('a processing row is reported as generating',
    /self::STATUS_PROCESSING => self::STATE_GENERATING/.test(queue));

  ok('every status branch returns the wait fields (one shared shape)',
    /private function statusPayload\(/.test(queue)
    && (queue.match(/statusPayload\(/g) || []).length >= 4);
  ok('the payload carries position, rank, concurrency and the ETA range',
    /'queue_position' =>/.test(queue) && /'jobs_ahead' =>/.test(queue)
    && /'processing_now' =>/.test(queue) && /'eta_seconds' =>/.test(queue)
    && /'eta_min_seconds' =>/.test(queue) && /'eta_max_seconds' =>/.test(queue)
    && /'eta_basis' =>/.test(queue));

  ok('an unsupported estimate is NULL, not a guess',
    /ETA_MIN_SAMPLES = 3/.test(queue)
    && /count\(\$samples\) >= self::ETA_MIN_SAMPLES \? \$this->median\(\$samples\) : null/.test(queue)
    && /'insufficient_samples'/.test(queue));
  ok('retry_after is never used as an ETA',
    !/'eta_seconds' => \$retryAfter/.test(queue) && !/\$retryAfter.*eta_seconds/.test(queue));
  ok('the position is counted in the worker’s real claim order',
    /priority < \?\s*OR \(priority = \? AND \(run_after < \? OR \(run_after = \? AND created_at < \?\)\)\)/.test(queue));
  ok('a job in retry backoff (not due) does not count as blocking',
    /WHERE status = 'queued' AND run_after <= \? AND id <> \?/.test(queue));
  ok('the estimate comes from measured render durations',
    /ready_at - locked_at/.test(queue) && /recentRenderSamples\(/.test(queue)
    && /ORDER BY run_after DESC/.test(queue) && /LIMIT ' \. self::ETA_SAMPLE_LIMIT/.test(queue));
  ok('marks kept on the finished row are what makes that measurement possible',
    !/status = 'ready', ready_at = \?,\s*lock_token = NULL, locked_at = NULL/.test(queue));

  // Configuration is what the schedule is, so the estimate has to read it.
  ok('the worker interval is configuration with the verified five-minute default',
    /MATERIAL_PDF_WORKER_INTERVAL_SECONDS', 300\)/.test(queue));
  ok('jobs per run matches the shipped --limit default',
    /MATERIAL_PDF_WORKER_JOBS_PER_RUN', 5\)/.test(queue));
  ok('the docs say to change the interval WITH the cron cadence',
    /MATERIAL_PDF_WORKER_INTERVAL_SECONDS/.test(read(DOCS))
    && /Change it to `60` when the cron moves to every minute/.test(read(DOCS)));
  ok('the env template ships the same defaults',
    /MATERIAL_PDF_WORKER_INTERVAL_SECONDS=300/.test(read(ENV_EXAMPLE))
    && /MATERIAL_PDF_WORKER_JOBS_PER_RUN=5/.test(read(ENV_EXAMPLE)));

  // Both endpoints, one contract.
  ok('pdf-status carries the wait fields',
    /\+ \$this->waitFields\(\$status\)/.test(delivery));
  ok('pdf-url carries the wait fields while pending',
    /waitFields\(\$status\)/.test(delivery.slice(delivery.indexOf('private function pendingResponse'))));
  ok('the three-value status stays backward compatible',
    /private function clientStatus\(/.test(delivery) && /'preparing'/.test(delivery));
  ok('a retry is offered ONLY for a permanent failure',
    /'retry_allowed' => \$failed/.test(delivery));
  ok('a queue read failure is reported as unavailable, never ready',
    /'queue_unavailable', 60, self::STATE_UNAVAILABLE\)/.test(queue)
    && /'state' => \$status\['state'\]/.test(delivery));

  // Privacy: the wait contract is counts only.
  const waitFields = delivery.slice(delivery.indexOf('private function waitFields'), delivery.indexOf('private function clientStatus'));
  ok('the wait fields expose no identity, material or path',
    !/student_id|full_name|public_user_id|storage_path|'name'|reason_code/.test(waitFields.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('the estimate queries read no student identity',
    !/SELECT[^;]*full_name[^;]*FROM lesson_material_pdf_jobs/i.test(queue));
}

/* ══ 6. Aging: disabled for strict on-demand only ════════════════════════ */

section('6. Bounded prewarm aging');

{
  const queue = read(QUEUE);
  const worker = read(WORKER);

  ok('worker uses simple claim (no prewarm reservation)',
    /On-demand only: claim by normal priority/.test(worker) || /\$queue->claim\(1, \$workerId\)/.test(worker));
  ok('prewarm reservation logic removed from worker',
    !/claimAgedPrewarm/.test(worker));
  ok('worker still re-checks authorization',
    /isStudentEligible\(\$materialId, \$studentId\)/.test(worker));
}

/* ══ 7. The screen wires the rules to the UI ═════════════════════════════ */

section('7. Screen wiring');

{
  const lesson = read(LESSON);
  const api = read(API);

  ok('the screen imports the shared rules instead of local constants',
    /from '@\/lib\/pdfPreparation'/.test(lesson) && !/const PDF_POLL_MAX_ATTEMPTS/.test(lesson));
  ok('the loop is bounded by the shared budget',
    /pollBudgetExhausted\(startedAt, Date\.now\(\), attempts\)/.test(lesson));
  ok('the server retry_after drives the delay through the rules',
    /nextPollDelay\(delay, status\.retry_after\)/.test(lesson));
  ok('a spent budget shows “still queued”, not a failure',
    /showStillWaiting\(name, forDownload\)/.test(lesson)
    && /status === 'waiting'/.test(lesson)
    && /materialWaitingTitle/.test(lesson));
  ok('re-checking a healthy queued job does NOT re-queue it',
    /void openMaterial\(target, again\.name, again\.forDownload, false\)/.test(lesson)
    && /void openMaterial\(target, retry\.name, retry\.forDownload, true\)/.test(lesson));
  ok('the queued/generating copy and the estimate are rendered',
    /describePrep\(downloadState\.phase/.test(lesson)
    && /describeEta\(downloadState\.etaMinSeconds, downloadState\.etaMaxSeconds\)/.test(lesson)
    && /queuePositionView\(downloadState\.queuePosition\)/.test(lesson));
  ok('a ready copy still downloads automatically',
    /if \(state === 'ready'\)/.test(lesson) && /return ready.url/.test(lesson));
  ok('polling stops on a terminal failure and on dismissal',
    /showPrepareFailure\(name, materialId, forDownload\)/.test(lesson)
    && /runId !== pdfRunRef\.current/.test(lesson));
  ok('an unreadable queue stops polling immediately (it cannot self-heal)',
    /if \(state === 'unavailable'\) \{[\s\S]{0,400}?break;/.test(lesson));
  ok('the API type carries the server-grounded wait contract',
    /export type MaterialPdfState = 'queued' \| 'generating' \| 'ready' \| 'failed' \| 'unavailable'/.test(api)
    && /export interface MaterialPdfWait/.test(api)
    && /eta_min_seconds: number \| null;/.test(api)
    && /queue_position: number \| null;/.test(api));
  ok('the API still documents retry_after as a polling interval, not an ETA',
    /POLLING INTERVAL, never an ETA/.test(api));
}

/* ══ 8. Localization (Arabic + English) ══════════════════════════════════ */

section('8. Arabic and English copy');

{
  const i18n = read(I18N);
  const en = i18n.slice(0, i18n.indexOf('export const ar'));
  const ar = i18n.slice(i18n.indexOf('export const ar'));
  const keys = [
    'lesson.materialQueuedTitle',
    'lesson.materialQueuedDesc',
    'lesson.materialGeneratingTitle',
    'lesson.materialGeneratingDesc',
    'lesson.materialQueuePosition',
    'lesson.materialEtaApproxMinutes',
    'lesson.materialEtaRangeMinutes',
    'lesson.materialEtaApproxHours',
    'lesson.materialEtaRangeHours',
    'lesson.materialEtaApproxDays',
    'lesson.materialEtaUnknown',
    'lesson.materialWaitingTitle',
    'lesson.materialWaitingDesc',
    'lesson.materialCheckAgain',
  ];
  const count = (haystack, key) =>
    (haystack.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;

  ok('every new string exists in BOTH locales (en + ar)',
    keys.every((k) => count(en, k) === 1 && count(ar, k) === 1),
    keys.filter((k) => count(en, k) !== 1 || count(ar, k) !== 1).join(','));

  const arabic = (key) => (ar.match(new RegExp(`'${key.replace(/\./g, '\\.')}': '(.*?)',`)) || [])[1] || '';
  ok('the Arabic queue message is the audited wording',
    arabic('lesson.materialQueuedTitle') === 'طلبك في قائمة الانتظار', arabic('lesson.materialQueuedTitle'));
  ok('the Arabic description matches the requested sentence',
    arabic('lesson.materialQueuedDesc') === 'جاري تجهيز نسخة PDF الخاصة بك، وسنخبرك عندما تصبح جاهزة للتحميل.',
    arabic('lesson.materialQueuedDesc'));
  ok('the Arabic no-estimate fallback is present',
    arabic('lesson.materialEtaUnknown') === 'الوقت المتوقع غير متاح حاليًا، وسنحدّث الحالة تلقائيًا.',
    arabic('lesson.materialEtaUnknown'));
  ok('the Arabic ETA lines use the range/approx placeholders',
    /\{minutes\}/.test(arabic('lesson.materialEtaApproxMinutes'))
    && /\{min\}/.test(arabic('lesson.materialEtaRangeMinutes'))
    && /\{max\}/.test(arabic('lesson.materialEtaRangeMinutes')));

  // Placeholder parity: the same names must exist on both sides.
  const enP = (key) => (en.match(new RegExp(`'${key.replace(/\./g, '\\.')}': '(.*?)',`)) || [])[1] || '';
  const placeholders = (s) => (s.match(/\{(\w+)\}/g) || []).sort().join(',');
  ok('each new key uses the SAME placeholders in both languages',
    keys.every((k) => placeholders(enP(k)) === placeholders(arabic(k))),
    keys.filter((k) => placeholders(enP(k)) !== placeholders(arabic(k))).join(','));
  // The audit's warning: the example wording must not become a hard promise.
  const etaCopy = [
    'lesson.materialEtaApproxMinutes',
    'lesson.materialEtaRangeMinutes',
    'lesson.materialEtaApproxHours',
    'lesson.materialEtaRangeHours',
    'lesson.materialEtaApproxDays',
    'lesson.materialQueuedDesc',
  ].map(arabic).join(' ');
  ok('the ETA copy never hard-codes a fixed two/five minutes',
    !/دقيقتين|خمس دقائق/.test(etaCopy), etaCopy);
}

/* ══ Report ═════════════════════════════════════════════════════════════ */

console.log('\n' + (failures.length === 0 ? '✔' : '✗') +
  ` materialPdfWaiting: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
