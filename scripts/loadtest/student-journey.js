/**
 * MedAcademy — student journey, up to 200 concurrent users (bounded, read-only).
 *
 * WHAT IT SIMULATES
 * ─────────────────
 * The requests the mobile app actually makes after launch, in the same order and
 * with a configurable anonymous share (the app's boot calls are unauthenticated,
 * the dashboard is not):
 *
 *   boot (anonymous)   GET /api/health · /app/version · /maintenance · /support/contact
 *   session            GET /auth/me
 *   dashboard          GET /courses · /notifications · /credits/me
 *   course             GET /courses/{id} · /courses/{id}/lessons
 *   settings/platform  GET /security/policies · /platform/branding · /platform/feature-flags
 *
 * Every one of these was verified read-only (no INSERT/UPDATE/DELETE reachable
 * from the handler). Nothing here enrolls, purchases, uploads, sends a
 * notification or deletes data.
 *
 * THE FIVE WORKLOAD CLASSES — kept apart on purpose
 * ─────────────────────────────────────────────
 * A single "200 users" number cannot describe a system whose anonymous boot
 * calls, signed-in reads, PDF work and video delivery have completely different
 * costs. Every request therefore carries a `workload` tag and its own metric, and
 * the report prints them as separate rows:
 *
 *   1 anon-boot           public boot calls            measured in every mode
 *   2 auth-read           signed-in student reads      needs a session
 *   3 pdf-availability    `GET /materials/pdf-status`  needs LOADTEST_PDF_MATERIAL_ID
 *   4 pdf-generation      worker + watermark render    NOT measured here (staging only)
 *   5 video-metadata      `GET /rpc/lesson-video-state` needs LOADTEST_VIDEO_LESSON_ID
 *     video-delivery      bytes from the VdoCipher CDN  NOT measured here at all
 *
 * Classes 4 and 5 (delivery) are NOT driven by this suite on purpose: 4 would
 * enqueue real watermark jobs and 5 would pull video from the provider's CDN,
 * neither of which measures THIS host. They are reported as `not measured` with
 * the reason rather than folded into a number they do not belong to.
 *
 * SESSIONS — one per virtual user
 * ───────────────────────────────
 * The previous suite logged in ONCE in setup() and shared that token, so 50 VUs
 * meant 50 requests from ONE device. Now each VU gets its own session:
 *
 *   SESSION_MODE=pool    (default) one pre-issued token per VU from
 *                        LOADTEST_TOKEN_POOL_FILE (see issue-tokens.php). No
 *                        login traffic at all, so the limiter is not measured.
 *   SESSION_MODE=login   each VU logs in once with its own account
 *                        (LOADTEST_ACCOUNTS_FILE / LOADTEST_STUDENT_EMAILS).
 *                        A 429 is retried with backoff and then falls back to
 *                        the anonymous workflow; it is counted, never hidden.
 *   SESSION_MODE=shared  legacy single token (baseline comparisons only).
 *
 * RUN (staging / local first — a live host needs LOADTEST_APPROVED=1)
 *   BASE_URL=http://127.0.0.1:8090 \
 *   LOADTEST_TOKEN_POOL_FILE=scripts/loadtest/.tokens.json \
 *   MAX_VUS=200 STAGE_TARGETS=10,25,50,100,150,200 \
 *   k6 run scripts/loadtest/student-journey.js
 *
 * The run is bounded by the stage ladder and `maxDuration` (stages + 60 s).
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  ACCOUNTS,
  PLAN,
  TOKEN_POOL,
  assertRunAllowed,
  authHeaders,
  boundedStages,
  joinUrl,
  login,
  pause,
  runMaxDuration,
  sessionForVU,
  standardThresholds,
} from './lib/config.js';
import { classifyOutcome, summarizeStage } from './lib/plan.mjs';

// Fails the run before any traffic when the plan is invalid, the target is not
// approved, or `shared` sessions would misdescribe the user count.
const VERDICT = assertRunAllowed();

/**
 * The read-only endpoint catalogue. `auth: false` endpoints are the public boot
 * calls; the rest need a session.
 */
/**
 * Fixture ids for the two optional workloads. Empty → the workload is reported
 * as not measured instead of being quietly skipped.
 */
const PDF_MATERIAL_ID = String((__ENV.LOADTEST_PDF_MATERIAL_ID || '')).trim();
const VIDEO_LESSON_ID = String((__ENV.LOADTEST_VIDEO_LESSON_ID || '')).trim();

/** Workload classes (see the header). `measured` is what the report repeats. */
const WORKLOADS = [
  { key: 'anon_boot', name: 'anon-boot', title: 'Anonymous public API', measured: true },
  { key: 'auth_read', name: 'auth-read', title: 'Authenticated student reads', measured: true },
  {
    key: 'pdf_availability',
    name: 'pdf-availability',
    title: 'PDF availability status (no generation)',
    measured: PDF_MATERIAL_ID !== '',
    needs: 'LOADTEST_PDF_MATERIAL_ID (+ a session)',
  },
  {
    key: 'pdf_generation',
    name: 'pdf-generation',
    title: 'PDF watermark generation + queue worker',
    measured: false,
    needs: 'a disposable staging account, seeded materials and its own worker run',
  },
  {
    key: 'video_metadata',
    name: 'video-metadata',
    title: 'Video metadata through the API',
    measured: VIDEO_LESSON_ID !== '',
    needs: 'LOADTEST_VIDEO_LESSON_ID (+ a session)',
  },
  {
    key: 'video_delivery',
    name: 'video-delivery',
    title: 'Actual video byte delivery',
    measured: false,
    needs: 'the VdoCipher CDN, which is not this host — never load tested from here',
  },
];

const ENDPOINTS = {
  health: { path: '/api/health', auth: false },
  version: { path: '/app/version', auth: false },
  maintenance: { path: '/maintenance', auth: false },
  support: { path: '/support/contact', auth: false },
  me: { path: '/auth/me', auth: true },
  courses: { path: '/courses', auth: true },
  notifications: { path: '/notifications', auth: true },
  credits: { path: '/credits/me', auth: true },
  policies: { path: '/security/policies', auth: true },
  branding: { path: '/platform/branding', auth: true },
  flags: { path: '/platform/feature-flags', auth: true },
  courseDetail: { path: '/courses/{id}', auth: true },
  courseLessons: { path: '/courses/{id}/lessons', auth: true },
  // Optional: exercised only when the matching fixture id is provided.
  pdfStatus: { path: '/materials/pdf-status', auth: true },
  videoState: { path: '/rpc/lesson-video-state', auth: true },
};

// Per-endpoint metrics, created once at init so every endpoint is reported
// separately (k6 does not export tag sub-metrics unless a threshold names them).
const EP = {};
for (const [key, spec] of Object.entries(ENDPOINTS)) {
  EP[key] = {
    path: spec.path,
    auth: spec.auth,
    trend: new Trend(`ep_${key}`, true),
    fail: new Counter(`epfail_${key}`),
  };
}

// Outcome classes (see classifyOutcome): the failure breakdown the report needs.
const OUTCOMES = [
  'ok',
  'rate_limited',
  'auth',
  'not_found',
  'client_error',
  'server_error',
  'entry_process_limit',
  'timeout',
  'connection',
  'other',
];
const outcomeCounters = {};
for (const name of OUTCOMES) outcomeCounters[name] = new Counter(`outcome_${name}`);

// One Trend/Counter pair per workload, so a workload's latency is never mixed
// with another's in the summary (k6 only exports tag sub-metrics a threshold
// names, so these are explicit).
const WL = {};
for (const w of WORKLOADS) {
  WL[w.name] = {
    trend: new Trend(`wl_${w.key}`, true),
    requests: new Counter(`wlreq_${w.key}`),
    fail: new Counter(`wlfail_${w.key}`),
  };
}

const loginRateLimited = new Counter('login_rate_limited');
const anonymousIterations = new Counter('anonymous_iterations');
const authenticatedIterations = new Counter('authenticated_iterations');
const authFallback = new Rate('auth_fallback');

function record(res, key, workload) {
  const endpoint = EP[key];
  endpoint.trend.add(res.timings.duration);
  const wl = workload ? WL[workload] : null;
  if (wl) {
    wl.trend.add(res.timings.duration);
    wl.requests.add(1);
  }
  const cls = classifyOutcome(res.status, res.error_code);
  outcomeCounters[cls].add(1);
  if (cls !== 'ok') {
    endpoint.fail.add(1);
    if (wl) wl.fail.add(1);
  }
  check(res, { [`${key}: 200`]: (r) => r.status === 200 });
  return res;
}

/**
 * One read, tagged with its endpoint AND its workload class.
 *
 * `path` overrides the catalogue path for the optional workloads, whose id does
 * not fit the `{id}` placeholder shape (they take a query parameter).
 */
function read(key, token, id, workload, overridePath) {
  const endpoint = EP[key];
  const path = overridePath || endpoint.path.replace('{id}', id || '');
  return record(
    http.get(joinUrl(path), {
      ...(endpoint.auth && token ? authHeaders(token) : {}),
      tags: { name: `GET ${endpoint.path}`, journey: 'student', workload: workload || 'anon-boot' },
      timeout: `${PLAN.timeoutMs}ms`,
    }),
    key,
    workload || 'anon-boot'
  );
}

export const options = {
  scenarios: {
    student_journey: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: boundedStages(),
      gracefulRampDown: '10s',
      gracefulStop: '15s',
      tags: { journey: 'student' },
    },
  },
  thresholds: standardThresholds(),
  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // NO `maxDuration` here: k6 rejects it as an unknown option (the old suite had
  // it too, so its "hard cap" never existed — the run was bounded only by the
  // stages). The stages ARE the bound, and run-stages.cjs additionally kills the
  // process at stages + a grace window.
  // NO `discardResponseBodies`: setup() parses GET /courses to learn the fixture
  // ids, and discarding bodies silently made that parse return null ("No courses
  // returned"), which is exactly the kind of false failure this tool must not
  // produce. The bodies here are small.
};

/** Kept for callers that import it; the runner enforces the same bound. */
export const MAX_RUN_DURATION = runMaxDuration();

export function setup() {
  // SESSION_MODE=none: a live, read-only capacity probe with NO account and NO
  // login traffic. There are no signed-in calls to make, so there are no course
  // fixtures to discover — every VU runs the anonymous boot workflow below.
  // This is the only honest way to load a production host that has no dedicated
  // test account (real students' sessions must never be used for this).
  if (PLAN.sessionMode === 'none') {
    return { courseIds: [], sessions: 0 };
  }

  // Otherwise a session is REQUIRED here only to learn the course fixture ids.
  // One login (or one pool token) is a single request, so it does not disturb
  // the per-IP limiter.
  let token = TOKEN_POOL.length > 0 ? TOKEN_POOL[0] : null;
  if (token === null && ACCOUNTS.length > 0) {
    token = login(ACCOUNTS[0].email, ACCOUNTS[0].password, 'setup');
  }
  if (token === null) {
    throw new Error(
      'No session available: set LOADTEST_TOKEN_POOL_FILE or LOADTEST_STUDENT_EMAIL/_PASSWORD. ' +
        'See scripts/loadtest/README.md (issue-tokens.php / seed-local.php).'
    );
  }

  const res = http.get(joinUrl('/courses'), {
    ...authHeaders(token),
    tags: { name: 'GET /courses (setup)' },
    timeout: `${PLAN.timeoutMs}ms`,
  });

  let courseIds = [];
  try {
    courseIds = (res.json('courses') || []).map((c) => c.id).filter(Boolean);
  } catch (e) {
    courseIds = [];
  }
  if (courseIds.length === 0) {
    throw new Error('No courses returned by GET /courses. Seed the fixtures first (scripts/loadtest/README.md).');
  }

  return { courseIds, sessions: TOKEN_POOL.length || ACCOUNTS.length };
}

export default function (data) {
  const session = sessionForVU();
  const token = session.token;
  if (session.rateLimited > 0) loginRateLimited.add(session.rateLimited);
  if (token === null) authFallback.add(1);

  // Boot calls: always anonymous, exactly like a cold app launch.
  read('health', null, null, 'anon-boot');
  read('version', null, null, 'anon-boot');

  const anonymous = token === null || Math.random() * 100 < PLAN.anonPercent;
  if (anonymous) {
    anonymousIterations.add(1);
    read('maintenance', null, null, 'anon-boot');
    read('support', null, null, 'anon-boot');
    pause();
    return;
  }

  authenticatedIterations.add(1);
  const pick = data.courseIds[Math.floor(Math.random() * data.courseIds.length)];

  read('me', token, null, 'auth-read');
  read('courses', token, null, 'auth-read');
  read('notifications', token, null, 'auth-read');
  read('credits', token, null, 'auth-read');
  read('courseDetail', token, pick, 'auth-read');
  read('courseLessons', token, pick, 'auth-read');
  read('policies', token, null, 'auth-read');
  read('branding', token, null, 'auth-read');
  read('flags', token, null, 'auth-read');

  // Optional workloads: only when the operator supplied the fixture id, because
  // an invented id would measure 404s and call it capacity.
  if (PLAN.pdfMaterialId !== '') {
    read(
      'pdfStatus',
      token,
      null,
      'pdf-availability',
      `/materials/pdf-status?material_id=${encodeURIComponent(PLAN.pdfMaterialId)}`
    );
  }
  if (PLAN.videoLessonId !== '') {
    read(
      'videoState',
      token,
      null,
      'video-metadata',
      `/rpc/lesson-video-state?lesson_id=${encodeURIComponent(PLAN.videoLessonId)}`
    );
  }

  pause();
}

export function teardown(data) {
  console.log(
    `sessions=${data.sessions} mode=${PLAN.sessionMode} target=${PLAN.targetVus} ` +
      `courses=${data.courseIds.length}${VERDICT.warnings.length ? ' warnings=' + VERDICT.warnings.length : ''}`
  );
}

/**
 * Write the machine-readable stage result the runner consumes.
 *
 * `LOADTEST_SUMMARY_FILE` must point into a directory that already exists (k6's
 * handleSummary cannot create one); run-stages.cjs always provides it.
 */
export function handleSummary(data) {
  const stage = summarizeStage(data);
  stage.label = __ENV.LOADTEST_STAGE_LABEL || `vus-${PLAN.targetVus}`;
  stage.targetVus = PLAN.targetVus;
  stage.endpoints = Object.entries(EP).map(([key, ep]) => {
    const m = data.metrics[`ep_${key}`];
    const failed = data.metrics[`epfail_${key}`];
    const v = (m && m.values) || {};
    return {
      name: `GET ${ep.path}`,
      count: v.count ?? null,
      p50: v.med ?? null,
      p90: v['p(90)'] ?? null,
      p95: v['p(95)'] ?? null,
      p99: v['p(99)'] ?? null,
      failed: (failed && failed.values && failed.values.count) || 0,
    };
  });
  stage.counters = {};
  for (const name of OUTCOMES) {
    const m = data.metrics[`outcome_${name}`];
    stage.counters[name] = (m && m.values && m.values.count) || 0;
  }
  // The workload breakdown: one row per class, with `measured` and the reason it
  // is not measured when it is not. This is the part that keeps anonymous boot
  // traffic from being reported as "student capacity".
  const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  stage.workloads = WORKLOADS.map((w) => {
    const m = data.metrics[`wl_${w.key}`];
    const requests = data.metrics[`wlreq_${w.key}`];
    const failed = data.metrics[`wlfail_${w.key}`];
    const v = (m && m.values) || {};
    const count = (requests && requests.values.count) || 0;
    return {
      name: w.name,
      title: w.title,
      measured: w.measured && count > 0,
      // Why there is no number: either the workload needs a fixture this run did
      // not supply, or it ran but produced no traffic in this session mode.
      needs: w.measured
        ? count > 0
          ? null
          : `implemented, but this run had no session (SESSION_MODE=${PLAN.sessionMode})`
        : w.needs || null,
      requests: count,
      failed: (failed && failed.values.count) || 0,
      p50: r2(v.med),
      p95: r2(v['p(95)']),
      p99: r2(v['p(99)']),
    };
  });
  stage.sessions = {
    mode: PLAN.sessionMode,
    distinctAvailable: TOKEN_POOL.length || ACCOUNTS.length,
    loginRateLimited: (data.metrics.login_rate_limited &&
      data.metrics.login_rate_limited.values.count) || 0,
    anonymousIterations:
      (data.metrics.anonymous_iterations && data.metrics.anonymous_iterations.values.count) || 0,
    authenticatedIterations:
      (data.metrics.authenticated_iterations && data.metrics.authenticated_iterations.values.count) || 0,
    fallbackRate: (data.metrics.auth_fallback && data.metrics.auth_fallback.values.rate) || 0,
  };

  const payload = JSON.stringify(
    {
      // The whole plan, so the report generator can re-validate it and state the
      // stop conditions the run was actually held to.
      plan: PLAN,
      stage,
      // Raw k6 metrics for the record (percentiles here are k6's own, computed
      // from every sample collected in this run).
      k6: { metrics: data.metrics },
    },
    null,
    2
  );

  const file = __ENV.LOADTEST_SUMMARY_FILE;
  return file ? { [file]: payload } : { stdout: '' };
}
