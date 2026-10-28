/**
 * Shared configuration and session handling for the MedAcademy k6 load tests.
 *
 * The PLAN (target users, ramp, stop conditions, guard rails) lives in
 * `lib/plan.mjs`, which is runtime-free so the same rules are unit-tested in
 * Node. This file is the thin k6 side: it turns the plan into k6 `options` and
 * gives every scenario the same authentication helpers.
 *
 * ── WHAT CHANGED FROM THE 10-USER SUITE ──────────────────────────────────────
 *   1. `MAX_VUS` no longer defaults to 10 and no longer throws above 50; the
 *      ceiling is 200 (`VU_CEILING`), which is the target the operator asked
 *      for. A target above it is a hard error, never a silent clamp.
 *   2. SESSIONS ARE PER-VU. The old journey logged in once in `setup()` and
 *      shared that token with every virtual user, so "50 VUs" was 50 requests
 *      on ONE device. `SESSION_MODE=pool` gives every VU its own token from a
 *      pool; `SESSION_MODE=login` logs each VU in once with its own account;
 *      `SESSION_MODE=shared` is kept only for baseline comparisons.
 *   3. A non-loopback `BASE_URL` requires `LOADTEST_APPROVED=1`: permission to
 *      build the tool is not permission to load a shared production host.
 *
 *   BASE_URL                     API root (no trailing slash) — required
 *   MAX_VUS                      peak virtual users (default 200, ceiling 200)
 *   STAGE_TARGETS                latch ladder, e.g. "10,25,50,100,150,200"
 *   RAMP_SECONDS / HOLD_SECONDS / RAMP_DOWN_SECONDS      single-ramp shape
 *   STEP_RAMP_SECONDS / STEP_HOLD_SECONDS                ladder shape
 *   THINK_TIME_MS                pause per iteration (default 800)
 *   REQUEST_TIMEOUT_MS           per-request timeout (default 20000)
 *   MAX_TOTAL_SECONDS            refuse a longer plan (default 3600)
 *   MAX_ERROR_RATE               error-rate stop line (default 0.02)
 *   P95_MS / P99_MS              latency stop lines (default 2000 / 4000)
 *   MAX_SERVER_ERROR_RATE        ⁵xx stop line (default 0.005)
 *   MAX_TIMEOUT_RATE             timeout/connection stop line (default 0.005)
 *   ANON_PERCENT                 share of iterations that skip authentication
 *   SESSION_MODE                 pool | login | shared (default pool)
 *   LOADTEST_TOKEN_POOL_FILE     JSON {tokens:[...]} produced by issue-tokens.php
 *   LOADTEST_STUDENT_EMAIL(S) / LOADTEST_STUDENT_PASSWORD
 *   LOADTEST_ACCOUNTS_FILE       JSON [{email,password}, ...] for SESSION_MODE=login
 *   LOGIN_RETRIES                retries after a 429 (default 3)
 *   LOADTEST_APPROVED            "1" = a non-loopback target was approved
 *
 * No credential or host is ever committed: everything comes from the
 * environment. See scripts/loadtest/README.md.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import {
  TARGET_VUS,
  VU_CEILING,
  assertPlan,
  buildStages,
  isLoopback,
  maxDuration,
  readPlan,
  thresholds,
} from './plan.mjs';

/** The resolved plan for this run (validated by `assertRunAllowed()`). */
export const PLAN = readPlan(__ENV);

export function env(name, fallback) {
  const v = __ENV[name];
  return v === undefined || v === '' ? fallback : v;
}

export function requireEnv(name) {
  const v = env(name);
  if (!v) {
    throw new Error(`Missing required environment variable ${name}. See scripts/loadtest/README.md`);
  }
  return v;
}

export function num(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function baseUrl() {
  return requireEnv('BASE_URL').replace(/\/+$/, '');
}

export function joinUrl(path) {
  return `${baseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Fail the whole run (before any traffic) when the plan is unsafe.
 *
 * Called at module scope by every scenario file: k6 evaluates init context
 * once, so an invalid plan or an unapproved live target stops immediately
 * instead of after the first thousand requests.
 */
export function assertRunAllowed() {
  if (!PLAN.baseUrl) {
    throw new Error('BASE_URL is required (e.g. BASE_URL=http://127.0.0.1:8090)');
  }
  const verdict = assertPlan(PLAN);
  if (!isLoopback(PLAN.baseUrl) && PLAN.sessionMode === 'shared') {
    throw new Error(
      'SESSION_MODE=shared against a non-loopback host measures one device, so the result ' +
        'would not describe ' + PLAN.targetVus + ' users. Use pool or login.'
    );
  }
  return verdict;
}

// ── Scenario shape (kept under the old names so smoke.js is untouched) ───────

/** k6 stages for this plan (ladder when STAGE_TARGETS is set). */
export function boundedStages() {
  return buildStages(PLAN);
}

/** Hard wall-clock cap: stages + 60 s of setup/teardown grace. */
export function runMaxDuration() {
  return maxDuration(PLAN, 60);
}

/** Thresholds = stop conditions (abortOnFail), derived from the plan. */
export function standardThresholds() {
  return thresholds(PLAN);
}

export function pause() {
  if (PLAN.thinkTimeMs > 0) sleep(PLAN.thinkTimeMs / 1000);
}

export function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
}

export function requestOptions(tagName, token) {
  const opts = {
    tags: { name: tagName },
    timeout: `${PLAN.timeoutMs}ms`,
  };
  if (token) {
    opts.headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }
  return opts;
}

// ── Accounts & session pool ─────────────────────────────────────────────────

/**
 * Accounts available for SESSION_MODE=login.
 *
 * Priority: LOADTEST_ACCOUNTS_FILE (JSON array of {email,password}), then
 * LOADTEST_STUDENT_EMAILS (comma separated) + LOADTEST_STUDENT_PASSWORD, then
 * the single LOADTEST_STUDENT_EMAIL/_PASSWORD pair.
 *
 * Read at init context only: k6 forbids file access inside a VU.
 */
function readAccounts() {
  const file = env('LOADTEST_ACCOUNTS_FILE', '');
  if (file) {
    try {
      const parsed = JSON.parse(open(file));
      const list = Array.isArray(parsed) ? parsed : parsed.accounts || [];
      const clean = list
        .filter((a) => a && typeof a.email === 'string' && a.email !== '')
        .map((a) => ({ email: String(a.email), password: String(a.password || '') }));
      if (clean.length > 0) return clean;
    } catch (e) {
      throw new Error(`LOADTEST_ACCOUNTS_FILE could not be read as JSON: ${e.message}`);
    }
  }
  const password = env('LOADTEST_STUDENT_PASSWORD', '');
  const emails = String(env('LOADTEST_STUDENT_EMAILS', '') || env('LOADTEST_STUDENT_EMAIL', ''))
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  return emails.map((email) => ({ email, password }));
}

export const ACCOUNTS = readAccounts();

/** Pre-issued access tokens (SESSION_MODE=pool), read once at init. */
export function readTokenPool() {
  const file = env('LOADTEST_TOKEN_POOL_FILE', '');
  if (!file) return [];
  try {
    const parsed = JSON.parse(open(file));
    const list = Array.isArray(parsed) ? parsed : parsed.tokens || [];
    return list.filter((t) => typeof t === 'string' && t.length > 20);
  } catch (e) {
    throw new Error(`LOADTEST_TOKEN_POOL_FILE could not be read as JSON: ${e.message}`);
  }
}

export const TOKEN_POOL = readTokenPool();

/**
 * Per-VU session state. k6 gives every VU its own JS runtime, so this module
 * variable is private to that VU — which is exactly the "one session per device"
 * property the shared-token suite did not have.
 */
let vuSession = null; // {token, email, mode, logins, failed}

/** The account assigned to this VU (stable across iterations). */
export function accountForVU(vu, accounts = ACCOUNTS) {
  if (accounts.length === 0) return null;
  return accounts[Math.max(0, vu - 1) % accounts.length];
}

/** The token assigned to this VU from the pre-issued pool, or null. */
export function pooledTokenForVU(vu, pool = TOKEN_POOL) {
  if (pool.length === 0) return null;
  return pool[Math.max(0, vu - 1) % pool.length];
}

/**
 * Login, tolerating the documented per-IP rate limit.
 *
 * A 429 is NOT a failed request for capacity purposes: it is the limiter doing
 * its job, and 200 logins from one generator IP will always hit it. It is
 * counted (`rate_limited`) and retried with backoff; if the retries are
 * exhausted the VU continues **anonymously** instead of aborting the run, and
 * the report shows the reduced authenticated concurrency.
 */
export function loginSoft(email, password, tag) {
  let backoffMs = 400;
  for (let attempt = 0; attempt <= PLAN.loginRetries; attempt++) {
    const res = http.post(joinUrl('/auth/login'), JSON.stringify({ email, password }), {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'POST /auth/login', journey: tag || 'auth' },
      timeout: `${PLAN.timeoutMs}ms`,
    });
    if (res.status === 200) {
      let token = null;
      try {
        token = res.json('session.access_token');
      } catch (e) {
        token = null;
      }
      check(res, { 'login: access token present': () => Boolean(token) });
      return { token, status: 200, rateLimited: false };
    }
    if (res.status === 429) {
      if (attempt === PLAN.loginRetries) {
        return { token: null, status: 429, rateLimited: true };
      }
      sleep(backoffMs / 1000);
      backoffMs *= 2;
      continue;
    }
    // Any other status: no retry, no token. The caller falls back to anonymous
    // reads and the failure is visible in the counters.
    return { token: null, status: res.status, rateLimited: false };
  }
  return { token: null, status: 0, rateLimited: false };
}

/**
 * Login and REQUIRE success (setup / smoke). Throws so a broken credential is a
 * loud failure rather than a silent 401 storm.
 */
export function login(email, password, tag) {
  const res = http.post(joinUrl('/auth/login'), JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'POST /auth/login', journey: tag || 'auth' },
    timeout: `${PLAN.timeoutMs}ms`,
  });
  const ok = check(res, {
    'login: status is 200': (r) => r.status === 200,
    'login: access token present': (r) => {
      try {
        return Boolean(r.json('session.access_token'));
      } catch (e) {
        return false;
      }
    },
  });
  if (!ok) {
    throw new Error(`Login failed for ${email}: HTTP ${res.status} ${String(res.body).slice(0, 200)}`);
  }
  return res.json('session.access_token');
}

/**
 * The session for this VU, resolved once.
 *
 * Returns `{token, email, mode}`; `token` is null when the VU has no session
 * (no pool entry, no account, or the login was refused) and the caller must use
 * the anonymous workflows. `stats` is returned so the scenario can count
 * logins / rate-limit hits.
 */
export function sessionForVU() {
  if (vuSession !== null) return vuSession;
  const vu = typeof __VU === 'number' ? __VU : 1;

  if (PLAN.sessionMode === 'none') {
    // Anonymous capacity probe: no token, no login traffic. Every iteration
    // runs the public boot calls (see student-journey.js), which is the only
    // workload that is safe to drive at scale without a test account.
    vuSession = { token: null, email: null, mode: 'anonymous', logins: 0, rateLimited: 0 };
    return vuSession;
  }

  if (PLAN.sessionMode === 'pool') {
    const token = pooledTokenForVU(vu);
    vuSession = { token, email: null, mode: token ? 'pool' : 'anonymous', logins: 0, rateLimited: 0 };
    return vuSession;
  }

  const account = accountForVU(vu);
  if (account === null) {
    vuSession = { token: null, email: null, mode: 'anonymous', logins: 0, rateLimited: 0 };
    return vuSession;
  }

  const result = loginSoft(account.email, account.password, 'iteration');
  vuSession = {
    token: result.token,
    email: account.email,
    mode: result.token ? 'login' : 'anonymous',
    logins: 1,
    rateLimited: result.rateLimited ? 1 : 0,
  };
  return vuSession;
}

/** Forget this VU's session (used by tests and by a 401 recovery path). */
export function resetSessionForVU() {
  vuSession = null;
}

/**
 * A read request that asserts an expected status, tags the metric by endpoint,
 * and returns the response. `token` may be null for anonymous workflows.
 */
export function getJson(path, token, expectedStatus, name) {
  const res = http.get(joinUrl(path), requestOptions(`GET ${name || path}`, token));
  check(res, {
    [`${name || path}: ${expectedStatus}`]: (r) => r.status === expectedStatus,
  });
  return res;
}

export { TARGET_VUS, VU_CEILING };
