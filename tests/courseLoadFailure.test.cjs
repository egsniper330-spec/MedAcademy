#!/usr/bin/env node
'use strict';
/**
 * courseLoadFailure.test.cjs — the false "Course not found" and the resume
 * loading path.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * On iPhone, returning from the background could show a long spinner and then
 * "Course not found" for a course the student was enrolled in. The course
 * screen loaded inside `try { … } catch {}` and rendered `course === null` as
 * not-found, so EVERY failure was reported as a missing course:
 *
 *   • a 30 s request timeout on a weak connection,
 *   • a request deferred by the security lock while the device was being
 *     re-verified after a resume (refused when the deferral bound expired,
 *     code SECURITY_LOCK),
 *   • a request aborted by containment when the app went to the background,
 *   • a token-refresh race / 5xx / 502 from the PHP backend.
 *
 * The classification is now a pure module (src/lib/courseLoadError.ts), so the
 * mapping is MEASURED here rather than asserted from a string in the JSX. The
 * screen-level checks then pin the wiring: a spinner that always ends, a
 * generation guard against stale results, a retry that is bounded, and no
 * second security verification on resume.
 *
 * Run: node tests/courseLoadFailure.test.cjs   (also part of `npm test`)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  }
}
function section(title) {
  console.log('\n── ' + title + ' ──');
}

/* ───────────────── compile the pure classifier ─────────────────────────── */

const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), 'course-load-'));
try {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src/lib/courseLoadError.ts'),
      '--outDir', BUILD,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
} catch (e) {
  console.error('tsc failed:\n' + (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''));
  process.exit(1);
}
const model = require(path.join(BUILD, 'courseLoadError.js'));
const {
  classifyCourseLoadError,
  shouldAutoRetry,
  nextRetryDelayMs,
  sanitizeLoadError,
  COURSE_LOAD_AUTO_RETRIES,
  COURSE_LOAD_RETRY_BASE_MS,
} = model;

/* ─────────────────────── 1. the classification matrix ─────────────────── */

section('1. only a positive server verdict is "not found"');
const notFoundCases = [
  ['HTTP 404', { status: 404, message: 'Not Found' }],
  ['adapter no-row code', { code: 'PGRST116', message: 'no rows' }],
  ['explicit not_found code', { code: 'not_found', message: 'missing' }],
  ['explicit not-found message', { message: 'Course not found' }],
];
for (const [label, err] of notFoundCases) {
  ok(label + ' → notFound', classifyCourseLoadError(err).kind === 'notFound');
}

const transientCases = [
  ['request timeout (client 30 s bound)', { message: 'The request timed out', status: 0 }],
  ['aborted by containment', { code: 'SECURITY_LOCK', status: 0, message: 'Blocked by the active security lock.' }],
  ['deferral bound expired', { code: 'SECURITY_LOCK', message: 'Blocked by the active security lock.' }],
  ['offline / DNS failure', { message: 'Network request failed' }],
  ['upstream 502', { status: 502, message: 'Bad gateway' }],
  ['unexpected plain Error', new Error('boom')],
  ['undefined throw', undefined],
];
for (const [label, err] of transientCases) {
  const r = classifyCourseLoadError(err);
  ok(label + ' → transient (never notFound)', r.kind === 'transient', JSON.stringify(r));
}

section('2. authoritative refusals are not auto-retried');
for (const [label, err] of [
  ['401 after a failed refresh', { status: 401, code: 'authentication_failed' }],
  ['403 policy refusal', { status: 403, code: 'forbidden' }],
  ['suspended account', { status: 403, code: 'account_suspended' }],
]) {
  const r = classifyCourseLoadError(err);
  ok(label + ' → transient but NOT retryable',
    r.kind === 'transient' && r.retryable === false, JSON.stringify(r));
}

/* ───────────────────────── 3. retry policy ─────────────────────────────── */

section('3. bounded retry — no retry storm');
ok('a transient failure with nothing on screen retries',
  shouldAutoRetry({ kind: 'transient', retryable: true }, { hasContent: false, attempt: 0 }) === true);
ok('content on screen is refreshed by stale-while-revalidate, not by a retry',
  shouldAutoRetry({ kind: 'transient', retryable: true }, { hasContent: true, attempt: 0 }) === false);
ok('a not-found verdict is never retried',
  shouldAutoRetry({ kind: 'notFound' }, { hasContent: false, attempt: 0 }) === false);
ok('an authoritative refusal is never retried automatically',
  shouldAutoRetry({ kind: 'transient', retryable: false }, { hasContent: false, attempt: 0 }) === false);
ok('the budget is finite (' + COURSE_LOAD_AUTO_RETRIES + ' attempts)',
  COURSE_LOAD_AUTO_RETRIES > 0 && COURSE_LOAD_AUTO_RETRIES <= 3 &&
  shouldAutoRetry({ kind: 'transient', retryable: true },
    { hasContent: false, attempt: COURSE_LOAD_AUTO_RETRIES }) === false);
ok('backoff doubles from the documented base',
  nextRetryDelayMs(0) === COURSE_LOAD_RETRY_BASE_MS &&
  nextRetryDelayMs(1) === COURSE_LOAD_RETRY_BASE_MS * 2 &&
  nextRetryDelayMs(2) === COURSE_LOAD_RETRY_BASE_MS * 4);
ok('a negative/invalid attempt cannot produce a negative delay',
  nextRetryDelayMs(-3) === COURSE_LOAD_RETRY_BASE_MS && Number.isFinite(nextRetryDelayMs(NaN)));

section('4. diagnostics carry no payload');
const sanitized = sanitizeLoadError({ status: 502, code: 'upstream_error', message: 'x'.repeat(400) });
ok('status and code are preserved', sanitized.status === 502 && sanitized.code === 'upstream_error');
ok('the message is truncated', sanitized.message.length === 160);
ok('no body/token fields are copied',
  !('body' in sanitized) && !('token' in sanitized) && Object.keys(sanitized).length === 3);

/* ───────────────────────── 5. screen wiring ───────────────────────────── */

section('5. course screen wiring');
const screen = stripComments(read('src/app/(app)/course/[id].tsx'));

ok('the classifier is the one from the pure module',
  /from '@\/lib\/courseLoadError'/.test(screen) && /classifyCourseLoadError\(err\)/.test(screen));
ok('"Course not found" is rendered only for a notFound verdict',
  /const isNotFound = loadError\?\.kind === 'notFound'/.test(screen) &&
  /isNotFound \? t\('course\.notFound'\) : t\('course\.loadFailedTitle'\)/.test(screen));
ok('the failure state offers a retry',
  /retryLoad/.test(screen) && /t\('common\.tryAgain'\)/.test(screen));
ok('the spinner is cleared in a finally block (it can always end)',
  /\} finally \{[\s\S]{0,200}setLoading\(false\)/.test(screen));
ok('only the newest load may commit state (generation guard)',
  /loadGenRef/.test(screen) && /gen !== loadGenRef\.current/.test(screen));
ok('a missing row (null data, no error) is the real not-found path',
  /if \(!courseData\) \{[\s\S]{0,220}kind: 'notFound'/.test(screen));
ok('the enrollment read can no longer abort the course page',
  /catch \(enrollErr\)/.test(screen));
ok('progress is a secondary read that cannot blank the page',
  /getLessonProgress\(profile\.id, id\)\.catch\(\(\) => \[\]\)/.test(screen));
ok('a background refresh keeps the content mounted',
  /if \(loading && !course\) return \(/.test(screen));
ok('the screen is wired through the stale-while-revalidate focus loader',
  /useStaleWhileRevalidateFocus\(loadData, \{ setLoading, hasContent: hasCourseContent \}\)/.test(screen));

/* ─────────── 6. resume performs ONE verification, not two ─────────────── */

section('6. resume does the security work once');
const layout = stripComments(read('src/app/(app)/_layout.tsx'));
const ctx = stripComments(read('src/lib/SecurityContext.tsx'));
ok('SecurityContext still owns the authoritative resume verification',
  /requestResumeVerification\('resume'\)/.test(ctx));
ok('the app shell no longer issues a second evaluation on resume',
  !/void check\(\)\.then\(/.test(layout));
ok('the app shell still refreshes feature flags on resume',
  /ensureFeatureFlagsFresh\(\)/.test(layout));
ok('warnings are still presented from the single published verdict',
  /presentWarningScreen\(\{ threats, riskScore, blocksLogin, hasWarnings \}\)/.test(layout));

/* ───────────────────────────── summary ────────────────────────────────── */

console.log('\n' + '─'.repeat(60));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('course-load failure suite FAILED.');
  process.exit(1);
}
console.log('course-load failure suite OK.');
