#!/usr/bin/env node
/**
 * dataReusePerformance.test.cjs — the enrollment list is fetched ONCE, not once
 * per screen.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * `getMySubscriptions()` returns the fattest read in the app (enrollments with
 * the full embedded course row, doctor and category). Six surfaces need the same
 * list, and a normal student journey is dashboard → My Courses → Course → Lesson
 * → Profile → Explore. Every one of those fetches used to hit the API again, each
 * with its own loading state, so navigating around re-downloaded the same list
 * four to six times within a few seconds.
 *
 * `src/lib/myCoursesCache.ts` reuses the result for a SHORT window (60 s), shares
 * one in-flight request, keys everything by `studentId`, and is invalidated by
 * every write we perform.
 *
 * ── WHAT THIS SUITE DOES ───────────────────────────────────────────────────
 * It EXECUTES the real module against a stubbed transport and counts requests —
 * these are real measured call counts for the same navigation sequence, not an
 * estimate. It then pins the safety properties that make the reuse legal:
 * account isolation, invalidation, expiry, and failure not being cached.
 *
 * Run: node tests/dataReusePerformance.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.join(__dirname, '..', 'node_modules/typescript'));

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures.push(label + (detail ? ` (${detail})` : '')); console.log('  ✗ ' + label); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

/* ── Load the real cache module with a stubbed API + controllable clock ──── */

const SOURCE = read('src/lib/myCoursesCache.ts');
const compiled = ts.transpile(SOURCE, {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
});

let clock = 1_700_000_000_000;
let calls = [];
let rowsFor = (studentId) => [{ id: 'e1', student_id: studentId, course: { id: 'c1', title: 'Bio' } }];
let failNext = null;

/**
 * Manual gate: while held, every stubbed read starts (and is counted) but does
 * not resolve. That is how the "invalidation / account switch lands while the
 * request is still in flight" races are reproduced deterministically — no
 * sleeps anywhere in this suite.
 */
let hold = null;
function holdRequests() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  hold = promise;
  return () => { hold = null; release(); };
}

const cacheModule = { exports: {} };
const sandbox = {
  exports: cacheModule.exports,
  module: cacheModule,
  require: (id) => {
    if (id === '@/lib/api') {
      return {
        getMySubscriptions: async (studentId) => {
          calls.push(studentId);
          // Snapshot the payload at REQUEST time: a test that rewrites `rowsFor`
          // while the request is held then proves which version was cached.
          const payload = rowsFor(studentId);
          await Promise.resolve();
          if (hold) await hold;
          if (failNext) {
            const err = failNext;
            failNext = null;
            throw err;
          }
          return payload;
        },
      };
    }
    return require(id);
  },
  console: { log() {}, warn() {} },
  Date: { now: () => clock },
  Promise,
  Map,
  Error,
};
vm.runInNewContext(compiled, sandbox, { filename: 'myCoursesCache.ts' });
const {
  getMySubscriptionsCached,
  invalidateMySubscriptionsCache,
  __myCoursesCacheState,
  MY_COURSES_CACHE_TTL_MS,
} = cacheModule.exports;

function reset() {
  if (hold) { const r = hold; hold = null; r.finally?.(() => {}); }
  invalidateMySubscriptionsCache();
  calls = [];
  clock = 1_700_000_000_000;
  failNext = null;
  hold = null;
}

(async () => {
  /* ══ 1. The real win: one request per navigation burst ══════════════════ */

  section('1. A navigation burst downloads the list once');

  reset();
  const STUDENT = 'student-a';
  // The exact order a student moves through the app.
  await getMySubscriptionsCached(STUDENT); // dashboard
  await getMySubscriptionsCached(STUDENT); // My Courses
  await getMySubscriptionsCached(STUDENT); // course details
  await getMySubscriptionsCached(STUDENT); // lesson player
  await getMySubscriptionsCached(STUDENT); // profile
  await getMySubscriptionsCached(STUDENT); // explore
  ok('six screens in one burst → exactly ONE API call', calls.length === 1, `saw ${calls.length}`);
  console.log(`      measured: 6 screen reads → ${calls.length} request(s)`);

  section('1b. Concurrent mounts share one request (single-flight)');

  reset();
  const [a, b, c] = await Promise.all([
    getMySubscriptionsCached(STUDENT),
    getMySubscriptionsCached(STUDENT),
    getMySubscriptionsCached(STUDENT),
  ]);
  ok('three simultaneous readers → ONE API call', calls.length === 1, `saw ${calls.length}`);
  ok('every caller gets the same rows', a === b && b === c && a.length === 1);

  section('1c. The window is 60 s, then the server is asked again');

  reset();
  await getMySubscriptionsCached(STUDENT);
  clock += 59_000;
  await getMySubscriptionsCached(STUDENT);
  ok('at 59 s the cached list is still reused', calls.length === 1, `saw ${calls.length}`);
  clock += 1_000; // now exactly 60 s after the fetch
  await getMySubscriptionsCached(STUDENT);
  ok('at 60 s the entry is expired and the server is asked again', calls.length === 2, `saw ${calls.length}`);
  clock += 61_000;
  await getMySubscriptionsCached(STUDENT);
  ok('expired data never becomes valid again', calls.length === 3, `saw ${calls.length}`);
  ok('the TTL is 60 s from ONE named constant', MY_COURSES_CACHE_TTL_MS === 60_000);

  /* ══ 2. Safety: account isolation, invalidation, failures ═══════════════ */

  section('2. Cached data can never cross accounts');

  reset();
  rowsFor = (id) => [{ id: 'e-' + id, student_id: id }];
  const first = await getMySubscriptionsCached('student-a');
  const second = await getMySubscriptionsCached('student-b');
  ok('a different student triggers its own request', calls.length === 2, `saw ${calls.length}`);
  ok('student B never receives student A rows', second[0].student_id === 'student-b');
  ok('student A rows are unchanged', first[0].student_id === 'student-a');
  ok('the cache records which student it belongs to', __myCoursesCacheState().studentId === 'student-b');
  const againA = await getMySubscriptionsCached('student-a');
  ok('switching back is a cache miss, never a stale hit', calls.length === 3 && againA[0].student_id === 'student-a');

  section('2b. Invalidation (enrollment / purchase / sign-out)');

  reset();
  await getMySubscriptionsCached(STUDENT);
  invalidateMySubscriptionsCache();
  ok('invalidate drops the entry', __myCoursesCacheState().hasEntry === false);
  await getMySubscriptionsCached(STUDENT);
  ok('the next read asks the server again (fresh post-enrollment list)', calls.length === 2, `saw ${calls.length}`);

  section('2c. A failed read is never cached as an empty list');

  reset();
  failNext = new Error('network down');
  let threw = false;
  try { await getMySubscriptionsCached(STUDENT); } catch { threw = true; }
  ok('the failure reaches the caller (no invented empty list)', threw);
  ok('nothing was cached on failure', __myCoursesCacheState().hasEntry === false);
  const recovered = await getMySubscriptionsCached(STUDENT);
  ok('the next read retries and succeeds', calls.length === 2 && recovered.length === 1, `saw ${calls.length}`);

  section('2d. A failed REFRESH cannot resurrect or extend an expired entry');

  reset();
  await getMySubscriptionsCached(STUDENT);           // cached at t0
  clock += 61_000;                                    // expired
  failNext = new Error('refresh failed');
  let refreshThrew = false;
  try { await getMySubscriptionsCached(STUDENT); } catch { refreshThrew = true; }
  ok('the expired refresh failure surfaces', refreshThrew);
  const afterFailure = await getMySubscriptionsCached(STUDENT);
  ok('the block does not silently serve the old rows as fresh', calls.length === 3, `saw ${calls.length}`);
  ok('a later successful read is cached again', afterFailure.length === 1);

  section('2e. Invalidation during an in-flight request cannot restore stale data');

  reset();
  rowsFor = (id) => [{ id: 'old', student_id: id }];
  const releaseEnroll = holdRequests();
  const pendingRead = getMySubscriptionsCached(STUDENT);
  await Promise.resolve();                            // request started, held
  rowsFor = (id) => [{ id: 'new', student_id: id }];  // enrollment landed
  invalidateMySubscriptionsCache();                   // enrollment invalidates
  releaseEnroll();
  const staleRows = await pendingRead;
  ok('the in-flight caller still receives its own result', staleRows[0].id === 'old');
  ok('but the pre-invalidation response is NOT cached', __myCoursesCacheState().hasEntry === false);
  const freshRows = await getMySubscriptionsCached(STUDENT);
  ok('the next screen reads post-enrollment data', freshRows[0].id === 'new', freshRows[0].id);
  ok('and it is a real second request, not a join to the stale one', calls.length === 2, `saw ${calls.length}`);

  section('2f. Sign-out / account switch during an in-flight request');

  reset();
  rowsFor = (id) => [{ id: 'row-' + id, student_id: id }];
  const releaseSwitch = holdRequests();
  const pendingA = getMySubscriptionsCached('student-a');
  await Promise.resolve();
  invalidateMySubscriptionsCache();                   // sign-out clears it
  hold = null;                                        // let both requests resolve
  const rowsB = await getMySubscriptionsCached('student-b');
  releaseSwitch();
  const staleA = await pendingA;
  ok('the previous account\u2019s rows are returned only to that caller', staleA[0].student_id === 'student-a');
  ok('the new account gets only its own rows', rowsB[0].student_id === 'student-b');
  const afterA = await getMySubscriptionsCached('student-a');
  ok('a later read for the old account re-fetches (no resurrected entry)', calls.length === 3, `saw ${calls.length}`);
  ok('and it is that account\u2019s data', afterA[0].student_id === 'student-a');

  /* ══ 3. Wiring: every surface uses it, every write invalidates ══════════ */

  section('3. Wiring');

  const SCREENS = [
    'src/app/(app)/(student)/dashboard.tsx',
    'src/app/(app)/(student)/explore.tsx',
    'src/app/(app)/(student)/my-courses.tsx',
    'src/app/(app)/(student)/profile.tsx',
    'src/app/(app)/course/[id].tsx',
    'src/app/(app)/lesson/[id].tsx',
  ];
  for (const rel of SCREENS) {
    const src = read(rel);
    ok(`${path.basename(path.dirname(rel))}/${path.basename(rel)} reads through the cache`,
      /getMySubscriptionsCached\(/.test(src) && !/getMySubscriptions\(/.test(src));
  }

  const enrollment = read('src/lib/courseEnrollment.ts');
  ok('free enrollment invalidates the list (success path)',
    /invalidateMySubscriptionsCache\(\)/.test(enrollment) &&
    enrollment.indexOf('invalidateMySubscriptionsCache()') < enrollment.indexOf('alreadyEnrolled: data?.already_enrolled'));

  const credits = read('src/lib/creditService.ts');
  ok('credit activation invalidates the list', /invalidateMySubscriptionsCache/.test(credits));

  const ctx = read('src/ctx.tsx');
  ok('sign-out clears it (next account cannot inherit rows)',
    /SIGNED_OUT[\s\S]{0,400}invalidateMySubscriptionsCache\(\)/.test(ctx));
  ok('account switch clears it',
    /account switch detected[\s\S]{0,300}invalidateMySubscriptionsCache\(\)/.test(ctx));

  /* ══ 4. Instrumentation is real, cheap and privacy-safe ═════════════════ */

  section('4. Startup instrumentation (dev builds only)');

  const perf = read('src/lib/perfTimeline.ts');
  ok('the timeline is a no-op outside dev builds',
    /function enabled\(\): boolean \{\s*return typeof __DEV__ !== 'undefined' && __DEV__ === true;/.test(perf) &&
    /if \(!enabled\(\)\) return;/.test(perf));
  ok('it records only stage names and offsets (no ids, tokens or payloads)',
    !/userId|token|email|response|payload/i.test(perf.replace(/\/\*[\s\S]*?\*\//g, '')));

  const stages = [
    ['src/app/_layout.tsx', "markPerf('js-start')"],
    ['src/ctx.tsx', "markPerf('session-restored')"],
    ['src/lib/SecurityContext.tsx', "markPerf('security-verdict')"],
    ['src/app/(app)/_layout.tsx', "markPerf('profile-resolved')"],
  ];
  for (const [rel, needle] of stages) {
    ok(`${needle} is wired in ${rel}`, read(rel).includes(needle));
  }
  ok('the landing screens mark the last stage and print the timeline',
    /markPerf\('screen-data'\)/.test(read('src/app/(app)/(student)/dashboard.tsx')) &&
    /logPerfTimeline\(\)/.test(read('src/app/(app)/(student)/dashboard.tsx')) &&
    /markPerf\('screen-data'\)/.test(read('src/app/(app)/(doctor)/dr-overview.tsx')));

  /* ══ 5. Security was not weakened for any of this ═══════════════════════ */

  section('5. Security and authorization unchanged');

  const client = read('src/client/php.ts');
  ok('the network lock still refuses/defer-routes every protected request',
    /if \(isSecurityLocked\(\) && !isLockExempt\(path\)\)/.test(client));
  ok('the deferral bound is unchanged (20 s → refusal, never authorization)',
    /const NETWORK_LOCK_DEFER_MAX_MS = 20_000;/.test(client));
  // The allowlist is the verification/recovery plane only. Asserting the exact
  // SET (not a count) is what stops a future "just add this endpoint" shortcut
  // from quietly exempting protected traffic from containment.
  ok('the lock allowlist is exactly the verification/recovery plane', (() => {
    const block = client.match(/const LOCK_EXEMPT_PREFIXES = \[([\s\S]*?)\];/);
    if (!block) return false;
    const entries = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    return JSON.stringify(entries) === JSON.stringify([
      '/auth/logout',
      '/security/config',
      '/security/events',
      '/security/policies',
      '/security/violations',
      '/support/contact',
    ]);
  })());
  ok('no cached data is used to decide access (server decides on each delivery)',
    !/myCoursesCache|getMySubscriptionsCached/.test(read('backend/src/Controllers/MaterialDeliveryController.php')) &&
    /getMySubscriptionsCached/.test(read('src/lib/myCoursesCache.ts')));

  section('Summary');
  console.log(`\n${passed} passed; ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error('suite crashed:', e);
  process.exit(1);
});
