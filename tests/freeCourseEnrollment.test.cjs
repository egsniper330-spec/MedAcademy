#!/usr/bin/env node
/**
 * freeCourseEnrollment.test.cjs — free courses must ENROLL, not open the
 * doctor's contact sheet.
 *
 * ── THE REPORTED BUG ────────────────────────────────────────────────────────
 * A doctor publishes a course with price 0. The student sees "Free" and taps
 * Subscribe. The app opened the doctor's contact card — exactly the paid flow.
 * Nothing was sent to the server, so the student was never enrolled, and My
 * Courses stayed empty no matter how many times the button was tapped.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────
 *  A. CLIENT BEHAVIOUR (the real module, executed):
 *     • isFreeCourse() is a DISPLAY hint and never authorizes anything;
 *     • the free flow POSTs /courses/{id}/enroll and only reports success when
 *       the server confirmed it;
 *     • a 402 (server says the course is paid) is reported as `paid_course` so
 *       the caller opens the unchanged contact/purchase sheet;
 *     • a suspended enrollment is NOT reported as success and is never
 *       reactivated client-side;
 *     • a network failure is `network`, never success;
 *     • concurrent taps share ONE request (single-flight) and a settled
 *       request can be retried.
 *  B. SCREEN WIRING: both student entry points (Explore list + course details)
 *     use the free path and keep the contact sheet for paid courses only.
 *  C. BACKEND RULES (source-checked against CourseController::enroll):
 *     server-side price authority, owner from the token, student-only,
 *     idempotent repeats, UNIQUE-key race handling, suspended stays suspended,
 *     audit written only on creation, paid courses untouched.
 *
 * Run: node tests/freeCourseEnrollment.test.cjs
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
const count = (haystack, needle) => haystack.split(needle).length - 1;

/* ══ Load the REAL client module with a stubbed transport ═════════════════ */

const MODULE_SOURCE = read('src/lib/courseEnrollment.ts');
const compiled = ts.transpile(MODULE_SOURCE, {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
});

let apiCalls = [];
let nextResponse = null;
let cacheInvalidations = 0;
/** Queue the reply the stubbed apiFetch should resolve with. */
function replyWith(response) { nextResponse = response; }

function loadModule() {
  const module = { exports: {} };
  const sandbox = {
    exports: module.exports,
    module,
    require: (id) => {
      // The enrollment module drops the short-TTL enrollment cache on success —
      // stubbed here so this suite measures ONLY the transport behaviour.
      if (id === '@/lib/myCoursesCache') {
        return { invalidateMySubscriptionsCache: () => { cacheInvalidations++; } };
      }
      if (id === '@/client/php') {
        return {
          apiFetch: async (p, opts) => {
            apiCalls.push({ path: p, method: opts?.method ?? 'GET', body: opts?.body });
            const r = nextResponse;
            return typeof r === 'function' ? r(p, opts) : r;
          },
        };
      }
      return require(id);
    },
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Map,
    Error,
    Number,
    encodeURIComponent,
  };
  vm.runInNewContext(compiled, sandbox, { filename: 'courseEnrollment.ts' });
  return module.exports;
}

const mod = loadModule();
const { isFreeCourse, enrollInFreeCourse, EnrollmentError, __resetEnrollmentInFlight } = mod;

section('A1. isFreeCourse() is a display hint with no authority');

ok('price 0 is free', isFreeCourse({ price_egp: 0 }) === true);
ok('"0" / "0.00" are free', isFreeCourse({ price_egp: '0' }) === true && isFreeCourse({ price_egp: '0.00' }) === true);
ok('null / undefined / "" are treated as free (same rule the cards render)', 
  isFreeCourse({ price_egp: null }) && isFreeCourse({ price_egp: undefined }) && isFreeCourse({ price_egp: '' }));
ok('a positive price is NOT free', isFreeCourse({ price_egp: 250 }) === false && isFreeCourse({ price_egp: '99.99' }) === false);
// A non-numeric price must never be read as "free"; a value <= 0 is free —
// exactly the rule the server applies (`price > 0` is the paid branch), so the
// hint and the authority agree.
ok('a non-numeric price is not silently free', isFreeCourse({ price_egp: 'abc' }) === false);
ok('a non-positive price matches the server\u2019s own paid/free rule', isFreeCourse({ price_egp: -5 }) === true);
ok('null course is not free', isFreeCourse(null) === false && isFreeCourse(undefined) === false);

section('A2. The free flow calls the server and only then reports success');

(async () => {
  __resetEnrollmentInFlight();
  apiCalls = [];
  replyWith({ data: { success: true, already_enrolled: false, enrollment_id: 'e-1', status: 'active' }, error: null });

  const res = await enrollInFreeCourse('course-1');
  ok('POSTs the enroll endpoint for the course', 
    apiCalls.length === 1 && apiCalls[0].path === '/courses/course-1/enroll' && apiCalls[0].method === 'POST',
    JSON.stringify(apiCalls));
  ok('no student/price field is sent (the server owns both)',
    JSON.stringify(apiCalls[0].body) === '{}', JSON.stringify(apiCalls[0].body));
  ok('reports the server-confirmed enrollment', res.alreadyEnrolled === false && res.enrollmentId === 'e-1' && res.status === 'active');
  ok('the cached enrollment list is invalidated on success', cacheInvalidations === 1, `saw ${cacheInvalidations}`);

  // ── already enrolled (repeat tap) ───────────────────────────────────────
  __resetEnrollmentInFlight();
  apiCalls = [];
  replyWith({ data: { success: true, already_enrolled: true, enrollment_id: 'e-1', status: 'active' }, error: null });
  const again = await enrollInFreeCourse('course-1');
  ok('a repeat tap is a success, not an error', again.alreadyEnrolled === true);

  // ── 402 → paid course: hand back to the contact flow ─────────────────────
  __resetEnrollmentInFlight();
  apiCalls = [];
  replyWith({ data: null, error: { status: 402, message: 'This course requires enrollment through the app (credit activation)' } });
  let err = null;
  try { await enrollInFreeCourse('paid-1'); } catch (e) { err = e; }
  ok('a paid course surfaces as paid_course (never as enrolled)',
    err instanceof EnrollmentError && err.code === 'paid_course' && err.status === 402);
  ok('the paid attempt created no local success state', err !== null);

  // ── suspended: refused, not reactivated ─────────────────────────────────
  __resetEnrollmentInFlight();
  replyWith({ data: null, error: { status: 403, message: 'Your enrollment in this course is suspended' } });
  err = null;
  try { await enrollInFreeCourse('c-susp'); } catch (e) { err = e; }
  ok('a suspended enrollment is reported as suspended (failure, not success)',
    err instanceof EnrollmentError && err.code === 'suspended');

  // ── feature disabled ───────────────────────────────────────────────────
  __resetEnrollmentInFlight();
  replyWith({ data: null, error: { status: 403, code: 'feature_disabled', message: 'Course Enrollment is temporarily unavailable.' } });
  err = null;
  try { await enrollInFreeCourse('c-flag'); } catch (e) { err = e; }
  ok('a disabled enrollment feature is reported as unavailable',
    err instanceof EnrollmentError && err.code === 'unavailable');

  // ── other 403 (not a student token, etc.) ──────────────────────────────
  __resetEnrollmentInFlight();
  replyWith({ data: null, error: { status: 403, message: 'Only students can enroll themselves in a course' } });
  err = null;
  try { await enrollInFreeCourse('c-role'); } catch (e) { err = e; }
  ok('an authorization refusal is not a success', err instanceof EnrollmentError && err.code === 'auth');

  // ── 404 ────────────────────────────────────────────────────────────────
  __resetEnrollmentInFlight();
  replyWith({ data: null, error: { status: 404, message: 'Course not found' } });
  err = null;
  try { await enrollInFreeCourse('gone'); } catch (e) { err = e; }
  ok('a missing/unpublished course is not_found', err instanceof EnrollmentError && err.code === 'not_found');

  // ── 409 on an OLDER server = already enrolled ──────────────────────────
  __resetEnrollmentInFlight();
  replyWith({ data: null, error: { status: 409, message: 'Already enrolled in this course' } });
  const legacy = await enrollInFreeCourse('c-409');
  ok('a legacy 409 is treated as already enrolled (the student IS in the course)',
    legacy.alreadyEnrolled === true && legacy.status === 'active');

  // ── network failure: never success ─────────────────────────────────────
  __resetEnrollmentInFlight();
  replyWith({ data: null, error: { status: 0, message: 'Network request failed' } });
  err = null;
  try { await enrollInFreeCourse('c-net'); } catch (e) { err = e; }
  ok('a network failure is `network` (no false success message)',
    err instanceof EnrollmentError && err.code === 'network');

  // ── retry after a failure actually re-requests ─────────────────────────
  apiCalls = [];
  replyWith({ data: { success: true, already_enrolled: false, enrollment_id: 'e-2', status: 'active' }, error: null });
  const retried = await enrollInFreeCourse('c-net');
  ok('a failed attempt does not poison later retries', retried.enrollmentId === 'e-2' && apiCalls.length === 1);

  // ── single-flight: concurrent taps = ONE request ───────────────────────
  __resetEnrollmentInFlight();
  apiCalls = [];
  replyWith(() => new Promise((resolve) => setTimeout(
    () => resolve({ data: { success: true, already_enrolled: false, enrollment_id: 'e-3', status: 'active' }, error: null }),
    20,
  )));
  const [a, b, c] = await Promise.all([
    enrollInFreeCourse('c-race'),
    enrollInFreeCourse('c-race'),
    enrollInFreeCourse('c-race'),
  ]);
  ok('three simultaneous taps send exactly one POST', apiCalls.length === 1, `sent ${apiCalls.length}`);
  ok('all three taps resolve with the same server result', a.enrollmentId === 'e-3' && b.enrollmentId === 'e-3' && c.enrollmentId === 'e-3');
  ok('different courses are independent requests', (() => {
    const before = apiCalls.length;
    replyWith({ data: { success: true, enrollment_id: 'e-4', status: 'active' }, error: null });
    void enrollInFreeCourse('c-other');
    return apiCalls.length === before + 1;
  })());

  /* ══ B. Screen wiring ══════════════════════════════════════════════════ */

  section('B. Both student entry points use the free path');

  const courseDetail = read('src/app/(app)/course/[id].tsx');
  const explore = read('src/app/(app)/(student)/explore.tsx');

  ok('course details enrolls free courses instead of opening the contact sheet',
    /enrollInFreeCourse\(id\)/.test(courseDetail) &&
    /isFreeCourse\(course\) \? \(/.test(courseDetail));

  ok('course details keeps the contact/purchase flow for paid courses',
    /\/\>\s*\)\s*:\s*\(\s*<NeuButton label=\{t\('course\.subscribe'\)\}/.test(courseDetail) &&
    /setShowContact\(true\)/.test(courseDetail));

  ok('a paid-course 402 falls back to that same contact sheet',
    /code === 'paid_course'[\s\S]{0,400}setShowContact\(true\)/.test(courseDetail));

  ok('success is announced only after the awaited server call',
    /const res = await enrollInFreeCourse\(id\);[\s\S]{0,400}showToast\(\{[\s\S]{0,120}type: 'success'/.test(courseDetail));

  ok('the button is disabled and shows a busy label while enrolling (no double submit)',
    /disabled=\{enrolling\}/.test(courseDetail) && /loading=\{enrolling\}/.test(courseDetail) &&
    /if \(enrolling \|\| !id\) return;/.test(courseDetail));

  ok('explore enrolls free courses from the list',
    /isFreeCourse\(item\)/.test(explore) && /enrollInFreeCourse\(item\.id\)/.test(explore));

  ok('explore marks the card enrolled immediately and updates the map',
    /setEnrolledIds\(/.test(explore) && /setEnrollmentMap\(/.test(explore));

  ok('explore keeps the contact sheet for paid courses and for a 402',
    /resolveCourseContact\(item\)[\s\S]{0,200}setSubscribeVisible\(true\)/.test(explore) &&
    /code === 'paid_course'/.test(explore));

  // Two guards, deliberately: the screen ignores a second tap while one is in
  // flight AND the module collapses concurrent calls for the same course into a
  // single POST (asserted in A2), so a race cannot create two enrollments.
  ok('explore blocks a second concurrent tap',
    /if \(enrollingId\) return;/.test(explore) && /enrollingId/.test(explore));

  ok('a failure message is localized in both modes (no invented success)',
    /t\('course\.enrollFailed'\)/.test(explore) && /t\('course\.enrollSuspended'\)/.test(explore) &&
    /t\('course\.enrollFailed'\)/.test(courseDetail));

  /* ══ C. Backend rules ══════════════════════════════════════════════════ */

  section('C. Backend enrollment rules (CourseController::enroll)');

  const controller = read('backend/src/Controllers/CourseController.php');
  const enrollFn = (() => {
    const start = controller.indexOf('public function enroll(Request $request): array');
    const end = controller.indexOf('public function archive(Request $request): array');
    return start >= 0 && end > start ? controller.slice(start, end) : '';
  })();

  ok('the enroll action exists and is routed', enrollFn.length > 0 &&
    /post\('\/courses\/\{id\}\/enroll', \[CourseController::class, 'enroll'\]/.test(read('backend/routes/api.php')));

  ok('the enrollment owner is the token subject alone',
    /\$studentId = \(string\) \(\$request->user\['id'\] \?\? ''\);/.test(enrollFn) &&
    !/student_id'\s*=>/.test(enrollFn));

  ok('self-enrollment is student-only', /if \(\$role !== 'student'\) \{[\s\S]{0,80}ApiException\(403/.test(enrollFn));

  ok('the price is read from the published row, never the request',
    /SELECT id, status, price_egp FROM courses WHERE id = \?/.test(enrollFn) &&
    !/\$request->(?:json|body)\s*\(/.test(enrollFn) &&
    !/\$body/.test(enrollFn));

  ok('a paid course is refused with 402 (no credit bypass)', /if \(\$price > 0\) \{[\s\S]{0,120}ApiException\(402/.test(enrollFn));

  ok('only a published course can be enrolled', /\$course\['status'\] !== 'published'/.test(enrollFn));

  ok('a repeat enrollment is idempotent (already_enrolled), not an error',
    /'already_enrolled' => true/.test(enrollFn) && !/ApiException\(409/.test(enrollFn));

  ok('a SUSPENDED enrollment is refused and never reactivated',
    /=== 'suspended'/.test(enrollFn) && /ApiException\(403, 'Your enrollment in this course is suspended'\)/.test(enrollFn) &&
    !/UPDATE enrollments/.test(enrollFn));

  ok('a concurrent duplicate (UNIQUE violation) resolves to success, not 500',
    /getCode\(\) !== '23000'/.test(enrollFn) && /catch \(\\PDOException \$e\)/.test(enrollFn));

  ok('the created enrollment is active and attributed to the direct method',
    /INSERT INTO enrollments \(id, student_id, course_id, enrollment_method, status, enrolled_at\)[\s\S]{0,120}'direct', 'active'/.test(enrollFn));

  ok('audit is written only on a genuine creation', 
    count(enrollFn, 'AuditService::write') === 1 &&
    enrollFn.indexOf('AuditService::write') > enrollFn.indexOf('$db->insert('));

  ok('the enrollment feature flag is still enforced server-side',
    /\$this->flags->assertEnabled\('course_enrollment', \$request\);/.test(enrollFn));

  // Paid-course paths must be untouched by this change: the doctor/admin grant
  // path still creates its own audited enrollment with its own method.
  ok('the audited staff/paid grant path is unchanged',
    /function grantAccess\(Request \$request\): array/.test(controller) &&
    /'admin_grant', 'active'/.test(controller) &&
    /enrollment_created_by_admin/.test(controller));

  ok('the paid purchase/contact flow is still the client\u2019s paid branch',
    /SubscribeSheet/.test(courseDetail) && /SubscribeSheet/.test(explore) &&
    /useDefaultContact|contact/.test(read('src/components/SubscribeSheet.tsx')));

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
