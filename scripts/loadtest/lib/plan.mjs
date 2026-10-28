/**
 * plan.mjs — the load test's PLAN, its guard rails, and its maths.
 *
 * WHY THIS FILE IS PURE
 * ─────────────────────
 * Everything here is plain JavaScript: no `k6/*` import, no Node API. That is
 * deliberate, because it is used by THREE runtimes and must behave identically
 * in all of them:
 *
 *   • k6            (ES module import from the scenario files)
 *   • Node          (unit tests + the stage runner + the report generator)
 *   • a human       (`node scripts/loadtest/run-stages.cjs --plan`)
 *
 * The previous suite could not exceed 10 users by default and hard-failed above
 * 50 (`VU_CEILING`), so "how many users can this host take?" was never actually
 * asked. The ceiling here is 200 — the target the operator asked for — and it is
 * a CEILING, not a default that quietly caps a run: a target above it is a hard
 * error, and a target below it is never silently reduced.
 *
 * The one rule this file enforces on every path: **a number that was not
 * measured is not reported as a measurement.** Percentiles come from the sample
 * array k6 collected; anything unavailable is `null`/`'unavailable'`, never 0.
 */

/** The requested test target. */
export const TARGET_VUS = 200;

/** Hard ceiling. A higher target is refused, never clamped. */
export const VU_CEILING = 200;

/** The staged ladder the operator asked for (10 → 200). */
export const DEFAULT_STAGE_TARGETS = [10, 25, 50, 100, 150, 200];

/** Refuse to run longer than this without an explicit override. */
export const MAX_TOTAL_SECONDS = 3600;

/**
 * Session strategies.
 *
 *   pool   — one pre-issued token per VU (no login traffic)
 *   login  — each VU logs in once with its own account
 *   none   — no session at all: the public boot endpoints only. This is the
 *            mode for a LIVE read-only capacity probe when no dedicated test
 *            account exists. It measures PHP+DB request handling, NOT a
 *            signed-in student's workload, and the report says so.
 *   shared — legacy single token (baseline comparisons only)
 */
export const SESSION_MODES = ['pool', 'login', 'none', 'shared'];

function num(env, name, fallback) {
  const raw = env && env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(env, name, fallback) {
  const raw = env && env[name];
  return raw === undefined || raw === null || raw === '' ? fallback : String(raw);
}

function bool(env, name, fallback) {
  const raw = env && env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function intList(raw) {
  return String(raw)
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
}

/** True for loopback/local targets (safe by default). */
export function isLoopback(url) {
  const raw = String(url || '');
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw);
}

/**
 * Resolve the plan from an environment map (`__ENV` in k6, `process.env` in
 * Node). Pure: no globals, so the same map always yields the same plan and the
 * unit tests can pin every branch.
 */
export function readPlan(env = {}) {
  const targetVus = Math.trunc(num(env, 'MAX_VUS', TARGET_VUS));
  const stageTargetsRaw = str(env, 'STAGE_TARGETS', '');
  const stageTargets = stageTargetsRaw === '' ? null : intList(stageTargetsRaw);

  return {
    // ── identity / target ────────────────────────────────────────────────────
    baseUrl: str(env, 'BASE_URL', ''),
    targetVus,
    stageTargets,
    // ── shape ────────────────────────────────────────────────────────────────
    rampSeconds: Math.trunc(num(env, 'RAMP_SECONDS', 120)),
    holdSeconds: Math.trunc(num(env, 'HOLD_SECONDS', 180)),
    rampDownSeconds: Math.trunc(num(env, 'RAMP_DOWN_SECONDS', 30)),
    stepRampSeconds: Math.trunc(num(env, 'STEP_RAMP_SECONDS', 30)),
    stepHoldSeconds: Math.trunc(num(env, 'STEP_HOLD_SECONDS', 60)),
    thinkTimeMs: Math.trunc(num(env, 'THINK_TIME_MS', 800)),
    timeoutMs: Math.trunc(num(env, 'REQUEST_TIMEOUT_MS', 20000)),
    maxTotalSeconds: Math.trunc(num(env, 'MAX_TOTAL_SECONDS', MAX_TOTAL_SECONDS)),
    // ── stop conditions ──────────────────────────────────────────────────────
    maxErrorRate: num(env, 'MAX_ERROR_RATE', 0.02),
    p95Ms: num(env, 'P95_MS', 2000),
    p99Ms: num(env, 'P99_MS', 4000),
    maxServerErrorRate: num(env, 'MAX_SERVER_ERROR_RATE', 0.005),
    maxTimeoutRate: num(env, 'MAX_TIMEOUT_RATE', 0.005),
    // ── optional workload fixtures ───────────────────────────────────────────
    // Empty means "this workload is not measured", which the report states
    // explicitly. A guessed id would measure 404s instead of the endpoint.
    pdfMaterialId: str(env, 'LOADTEST_PDF_MATERIAL_ID', ''),
    videoLessonId: str(env, 'LOADTEST_VIDEO_LESSON_ID', ''),
    // ── sessions / mix ───────────────────────────────────────────────────────
    sessionMode: str(env, 'SESSION_MODE', 'pool'),
    anonPercent: num(env, 'ANON_PERCENT', 20),
    loginRetries: Math.trunc(num(env, 'LOGIN_RETRIES', 3)),
    distinctSessions: Math.trunc(num(env, 'DISTINCT_SESSIONS', 0)),
    // ── approval gate ────────────────────────────────────────────────────────
    approved: bool(env, 'LOADTEST_APPROVED', false),
    // ── labels ───────────────────────────────────────────────────────────────
    label: str(env, 'LOADTEST_LABEL', ''),
  };
}

/**
 * Validate a plan. Returns `{ok, errors, warnings}` — never throws, so a caller
 * can print every problem at once instead of one per run.
 */
export function validatePlan(plan) {
  const errors = [];
  const warnings = [];

  if (!Number.isFinite(plan.targetVus) || plan.targetVus < 1) {
    errors.push('MAX_VUS must be a positive integer');
  } else if (plan.targetVus > VU_CEILING) {
    // NOT clamped on purpose: silently running 50 when 200 was asked for is how
    // the old suite produced "capacity" numbers that described 10 users.
    errors.push(
      `MAX_VUS=${plan.targetVus} exceeds the hard ceiling of ${VU_CEILING}. ` +
        'Raise VU_CEILING deliberately (and only for an approved staging target).'
    );
  }

  if (plan.stageTargets) {
    if (plan.stageTargets.length === 0) {
      errors.push('STAGE_TARGETS was set but contains no positive numbers');
    }
    const over = plan.stageTargets.filter((t) => t > plan.targetVus);
    if (over.length > 0) {
      errors.push(`STAGE_TARGETS contains ${over.join(', ')}, above MAX_VUS=${plan.targetVus}`);
    }
    const last = plan.stageTargets[plan.stageTargets.length - 1];
    if (plan.stageTargets.length > 0 && last !== plan.targetVus) {
      warnings.push(
        `STAGE_TARGETS ends at ${last} but MAX_VUS=${plan.targetVus}: the run will stop at ${last}`
      );
    }
  }

  if (plan.rampSeconds < 5) errors.push('RAMP_SECONDS must be at least 5');
  if (plan.holdSeconds < 5) errors.push('HOLD_SECONDS must be at least 5');
  if (plan.rampDownSeconds < 1) errors.push('RAMP_DOWN_SECONDS must be at least 1');
  if (plan.stepRampSeconds < 1) errors.push('STEP_RAMP_SECONDS must be at least 1');
  if (plan.stepHoldSeconds < 1) errors.push('STEP_HOLD_SECONDS must be at least 1');
  if (plan.timeoutMs < 1000 || plan.timeoutMs > 60000) {
    errors.push('REQUEST_TIMEOUT_MS must be between 1000 and 60000');
  }
  if (plan.thinkTimeMs < 0 || plan.thinkTimeMs > 60000) {
    errors.push('THINK_TIME_MS must be between 0 and 60000');
  }
  if (!(plan.maxErrorRate > 0 && plan.maxErrorRate < 1)) {
    errors.push('MAX_ERROR_RATE must be between 0 and 1 (e.g. 0.02 = 2%)');
  }
  if (!(plan.p95Ms > 0) || plan.p95Ms >= plan.p99Ms) {
    errors.push('P95_MS and P99_MS must be positive with P95_MS < P99_MS');
  }
  if (!SESSION_MODES.includes(plan.sessionMode)) {
    errors.push(`SESSION_MODE must be one of ${SESSION_MODES.join(', ')}`);
  }
  if (plan.anonPercent < 0 || plan.anonPercent > 100) {
    errors.push('ANON_PERCENT must be between 0 and 100');
  }

  const seconds = totalSeconds(plan);
  if (seconds > plan.maxTotalSeconds) {
    errors.push(
      `the configured run is ${seconds}s, above MAX_TOTAL_SECONDS=${plan.maxTotalSeconds}`
    );
  }

  // ── approval gate ────────────────────────────────────────────────────────
  if (plan.baseUrl !== '' && !isLoopback(plan.baseUrl) && !plan.approved) {
    errors.push(
      `BASE_URL=${plan.baseUrl} is not loopback. A load test against a shared/live host ` +
        'needs explicit approval: set LOADTEST_APPROVED=1 only after that approval, and ' +
        'prefer a staging installation on the same plan.'
    );
  }
  if (plan.baseUrl === '') {
    warnings.push('BASE_URL is empty (the runner sets it; k6 needs it)');
  }

  if (plan.targetVus > 100) {
    warnings.push(
      `${plan.targetVus} concurrent users is a shared-hosting load test: keep the staged ` +
        'ramp, watch cPanel Resource Usage, and stop on the first 508/503.'
    );
  }
  if (plan.sessionMode === 'shared') {
    warnings.push(
      'SESSION_MODE=shared simulates ONE device, not ' + plan.targetVus + ' users. ' +
        'It is only for baseline comparisons.'
    );
  }
  if (plan.sessionMode === 'none') {
    warnings.push(
      'SESSION_MODE=none exercises the public boot endpoints only: the result measures ' +
        'PHP+DB request handling, not a signed-in student journey.'
    );
  }
  if (plan.sessionMode === 'pool' && plan.distinctSessions > 0 && plan.distinctSessions < plan.targetVus) {
    warnings.push(
      `the token pool has ${plan.distinctSessions} sessions for ${plan.targetVus} VUs: ` +
        'sessions will be reused (achieved distinct devices < VUs)'
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Throwing wrapper for k6 module scope (fails the run before any traffic). */
export function assertPlan(plan) {
  const verdict = validatePlan(plan);
  if (!verdict.ok) {
    throw new Error(
      'Refusing to start a load test:\n  - ' + verdict.errors.join('\n  - ') +
        (verdict.warnings.length ? '\nWarnings:\n  - ' + verdict.warnings.join('\n  - ') : '')
    );
  }
  return verdict;
}

/**
 * k6 `stages` for the plan.
 *
 * LADDER (default when STAGE_TARGETS is set): ramp to each level, hold, then ramp
 * to the next — so latency/error growth can be read per level in ONE run.
 * SINGLE: ramp once to MAX_VUS, hold, ramp down.
 *
 * Every form is bounded: the last stage ramps to 0 and the total is validated
 * against MAX_TOTAL_SECONDS.
 */
export function buildStages(plan) {
  const stages = [];
  if (plan.stageTargets && plan.stageTargets.length > 0) {
    const levels = [...new Set(plan.stageTargets)].sort((a, b) => a - b);
    let previous = 0;
    for (const level of levels) {
      stages.push({ duration: `${plan.stepRampSeconds}s`, target: level });
      stages.push({ duration: `${plan.stepHoldSeconds}s`, target: level });
      previous = level;
    }
    if (previous > 0) stages.push({ duration: `${plan.rampDownSeconds}s`, target: 0 });
    return stages;
  }
  stages.push({ duration: `${plan.rampSeconds}s`, target: plan.targetVus });
  stages.push({ duration: `${plan.holdSeconds}s`, target: plan.targetVus });
  stages.push({ duration: `${plan.rampDownSeconds}s`, target: 0 });
  return stages;
}

/** Sum of stage durations (seconds). */
export function totalSeconds(plan) {
  return buildStages(plan).reduce((sum, s) => sum + (parseInt(s.duration, 10) || 0), 0);
}

/** Hard wall-clock cap for k6: the stages plus a grace window for setup/teardown. */
export function maxDuration(plan, graceSeconds = 60) {
  return `${totalSeconds(plan) + graceSeconds}s`;
}

/**
 * k6 thresholds = the stop conditions.
 *
 * `abortOnFail` is what makes a stage SAFE on shared hosting: without it a
 * failing level keeps generating traffic for its whole hold. `delayAbortEval`
 * keeps a cold-start spike from killing a healthy run.
 */
export function thresholds(plan) {
  return {
    http_req_failed: [
      { threshold: `rate<${plan.maxErrorRate}`, abortOnFail: true, delayAbortEval: '15s' },
    ],
    http_req_duration: [
      { threshold: `p(95)<${plan.p95Ms}`, abortOnFail: true, delayAbortEval: '15s' },
      `p(99)<${plan.p99Ms}`,
      `avg<${Math.round(plan.p95Ms * 0.6)}`,
    ],
    checks: [`rate>${Math.max(0, 1 - plan.maxErrorRate - 0.01)}`],
  };
}

// ── Measurement maths ────────────────────────────────────────────────────────

/**
 * Percentiles from the RAW samples (nearest-rank, the same convention k6 uses).
 * `values` must be the measured samples; an empty array yields nulls rather than
 * zeros, so "no data" can never look like "0 ms".
 */
export function percentiles(values, points = [50, 90, 95, 99]) {
  const clean = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) {
    const empty = { count: 0, min: null, avg: null, max: null };
    for (const p of points) empty[`p${p}`] = null;
    return empty;
  }
  const at = (p) => {
    const rank = Math.ceil((p / 100) * clean.length) - 1;
    return clean[Math.min(clean.length - 1, Math.max(0, rank))];
  };
  const out = {
    count: clean.length,
    min: round2(clean[0]),
    avg: round2(clean.reduce((a, b) => a + b, 0) / clean.length),
    max: round2(clean[clean.length - 1]),
  };
  for (const p of points) out[`p${p}`] = round2(at(p));
  return out;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Bucket one outcome. `status === 0` means the request never completed (k6's
 * convention), so it is separated into timeout/connection instead of being
 * lumped into "4xx/5xx" — those are the two failures that actually suggest the
 * host is saturated or refusing entry processes.
 */
export function classifyOutcome(status, errorCode = '') {
  const code = String(errorCode || '').toLowerCase();
  const s = Number(status) || 0;
  if (code.includes('timeout') || code.includes('etimedout')) return 'timeout';
  if (s === 0) return 'connection';
  if (s >= 200 && s < 300) return 'ok';
  if (s === 429) return 'rate_limited';
  if (s === 401 || s === 403) return 'auth';
  if (s === 404) return 'not_found';
  if (s === 408) return 'timeout';
  if (s === 508) return 'entry_process_limit';
  if (s >= 500) return 'server_error';
  if (s >= 400) return 'client_error';
  return 'other';
}

function metricValues(summary, name) {
  const m = summary && summary.metrics && summary.metrics[name];
  return m && m.values ? m.values : null;
}

function pick(values, key, fallback = null) {
  if (!values) return fallback;
  const v = values[key];
  return Number.isFinite(v) ? v : fallback;
}

/** Two decimals, or null when the metric is missing (never 0 for "no data"). */
function roundOrNull(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : round2(v);
}

/**
 * Read ONE stage's k6 summary (the object `--summary-export` writes) into the
 * numbers the report uses. Everything missing is null, never invented.
 */
export function summarizeStage(summary) {
  const dur = metricValues(summary, 'http_req_duration');
  const reqs = metricValues(summary, 'http_reqs');
  const failed = metricValues(summary, 'http_req_failed');
  const vus = metricValues(summary, 'vus_max');
  const checks = metricValues(summary, 'checks');
  const iterations = metricValues(summary, 'iterations');

  return {
    requests: pick(reqs, 'count', 0),
    rps: pick(reqs, 'rate', 0),
    errorRate: pick(failed, 'rate', null),
    checksRate: pick(checks, 'rate', null),
    iterations: pick(iterations, 'count', 0),
    latency: {
      min: roundOrNull(pick(dur, 'min')),
      avg: roundOrNull(pick(dur, 'avg')),
      p50: roundOrNull(pick(dur, 'med')),
      p90: roundOrNull(pick(dur, 'p(90)')),
      p95: roundOrNull(pick(dur, 'p(95)')),
      p99: roundOrNull(pick(dur, 'p(99)')),
      max: roundOrNull(pick(dur, 'max')),
    },
    achievedVus: pick(vus, 'max', null),
  };
}

/**
 * Stop conditions for one finished stage, evaluated from MEASURED values.
 *
 * A stage fails closed on: overall error rate, p95, p99, server-error rate,
 * timeout rate, and (separately) "we never reached the configured concurrency" —
 * that last one is reported as `inconclusive`, not as a pass.
 */
export function evaluateStage(stage, plan) {
  const reasons = [];
  const inconclusive = [];

  if (stage.errorRate !== null && stage.errorRate > plan.maxErrorRate) {
    reasons.push(`error rate ${(stage.errorRate * 100).toFixed(2)}% > ${(plan.maxErrorRate * 100).toFixed(2)}%`);
  }
  if (stage.latency.p95 !== null && stage.latency.p95 > plan.p95Ms) {
    reasons.push(`p95 ${stage.latency.p95}ms > ${plan.p95Ms}ms`);
  }
  if (stage.latency.p99 !== null && stage.latency.p99 > plan.p99Ms) {
    reasons.push(`p99 ${stage.latency.p99}ms > ${plan.p99Ms}ms`);
  }

  const counters = stage.counters || {};
  const total = Math.max(1, stage.requests || 0);
  const serverErrors = (counters.server_error || 0) + (counters.entry_process_limit || 0);
  if (serverErrors / total > plan.maxServerErrorRate) {
    reasons.push(
      `${serverErrors} server/entry-process errors (${((serverErrors / total) * 100).toFixed(2)}% > ${(
        plan.maxServerErrorRate * 100
      ).toFixed(2)}%)`
    );
  }
  const timeouts = (counters.timeout || 0) + (counters.connection || 0);
  if (timeouts / total > plan.maxTimeoutRate) {
    reasons.push(`${timeouts} timeouts/connection failures (${((timeouts / total) * 100).toFixed(2)}%)`);
  }

  // Compare against THIS stage's target when it has one: in a staged report the
  // 10-VU baseline must not be called "inconclusive" for failing to reach 200.
  const target = Number.isFinite(stage.targetVus) && stage.targetVus > 0 ? stage.targetVus : plan.targetVus;
  if (stage.achievedVus !== null && target > 0 && stage.achievedVus < target * 0.9) {
    inconclusive.push(
      `only ${stage.achievedVus} of ${target} configured VUs were reached — ` +
        'the generator, not the server, may be the limit'
    );
  }

  return { stop: reasons.length > 0, reasons, inconclusive };
}

/**
 * Combine per-stage results into the report the operator reads.
 *
 * `degradation` is the FIRST stage whose measured p95 exceeds 80 % of the p95
 * stop line (or whose error rate exceeds half the limit) — "capacity starts
 * degrading here". If no stage crosses, it is null: the tested range simply did
 * not find a limit, which is a legitimate (and honestly reported) outcome.
 */
export function buildReport(plan, stages) {
  const rows = stages.map((s) => {
    const verdict = evaluateStage(s, plan);
    return {
      label: s.label,
      targetVus: s.targetVus,
      achievedVus: s.achievedVus,
      requests: s.requests,
      rps: round2(s.rps || 0),
      errorRate: s.errorRate === null ? null : round2(s.errorRate * 100),
      latency: s.latency,
      counters: s.counters || {},
      endpoints: s.endpoints || [],
      workloads: s.workloads || [],
      stop: verdict.stop,
      reasons: verdict.reasons,
      inconclusive: verdict.inconclusive,
      durationSeconds: s.durationSeconds ?? null,
    };
  });

  // "Degradation starts here" = first stage at 80 % of the p95 stop line, or at
  // half the error-rate stop line (row.errorRate is a percentage; the plan's
  // limit is a fraction, hence the ×100).
  const errorDegradationPct = (plan.maxErrorRate * 100) / 2;
  let degradation = null;
  for (const row of rows) {
    const p95 = row.latency.p95;
    const err = row.errorRate;
    if ((p95 !== null && p95 >= plan.p95Ms * 0.8) || (err !== null && err >= errorDegradationPct)) {
      degradation = { label: row.label, targetVus: row.targetVus, p95, errorRate: err };
      break;
    }
  }

  const stopped = rows.find((r) => r.stop) || null;
  const highestHealthy = [...rows].reverse().find((r) => !r.stop && r.inconclusive.length === 0) || null;

  return {
    generatedAt: new Date().toISOString(),
    baseUrl: plan.baseUrl,
    label: plan.label,
    plan: {
      targetVus: plan.targetVus,
      stageTargets: plan.stageTargets,
      sessionMode: plan.sessionMode,
      anonPercent: plan.anonPercent,
      thinkTimeMs: plan.thinkTimeMs,
      timeoutMs: plan.timeoutMs,
      p95Ms: plan.p95Ms,
      p99Ms: plan.p99Ms,
      maxErrorRate: plan.maxErrorRate,
    },
    rows,
    summary: {
      // The TARGET of this run is the top of the ladder actually attempted, not
      // the MAX_VUS default: reporting "configured target: 10" for a 10→200
      // ladder made every report look like the old 10-VU cap was still in force.
      configuredTarget: Math.max(plan.targetVus, ...rows.map((r) => r.targetVus || 0), 0),
      highestTargetAttempted: rows.length ? rows[rows.length - 1].targetVus : 0,
      highestAchievedVus: rows.reduce((max, r) => Math.max(max, r.achievedVus || 0), 0),
      stoppedAt: stopped ? { label: stopped.label, targetVus: stopped.targetVus, reasons: stopped.reasons } : null,
      highestHealthyStage: highestHealthy ? highestHealthy.label : null,
      degradationStartsAt: degradation,
      inconclusive: rows.some((r) => r.inconclusive.length > 0),
    },
  };
}

function fmt(v, suffix = '') {
  return v === null || v === undefined ? 'n/a' : `${v}${suffix}`;
}

/** Markdown for humans; the JSON/CSV next to it are for machines. */
export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Load test report${report.label ? ` — ${report.label}` : ''}`);
  lines.push('');
  lines.push(`- Target: \`${report.baseUrl || 'n/a'}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(
    `- Configured target: **${report.summary.configuredTarget} VUs** · highest achieved: **${report.summary.highestAchievedVus} VUs**`
  );
  lines.push(`- Sessions: ${report.plan.sessionMode} · anonymous mix: ${report.plan.anonPercent}%`);
  lines.push('');
  lines.push('| stage | VUs (target/achieved) | requests | req/s | p50 | p90 | p95 | p99 | errors | stop |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of report.rows) {
    lines.push(
      `| ${r.label} | ${r.targetVus}/${fmt(r.achievedVus)} | ${r.requests} | ${r.rps} | ` +
        `${fmt(r.latency.p50, ' ms')} | ${fmt(r.latency.p90, ' ms')} | ${fmt(r.latency.p95, ' ms')} | ` +
        `${fmt(r.latency.p99, ' ms')} | ${fmt(r.errorRate, ' %')} | ${r.stop ? 'yes' : 'no'} |`
    );
  }
  lines.push('');

  const endpoints = new Map();
  for (const r of report.rows) {
    for (const ep of r.endpoints) {
      const key = ep.name;
      if (!endpoints.has(key)) endpoints.set(key, []);
      endpoints.get(key).push({ stage: r.label, ...ep });
    }
  }
  if (endpoints.size > 0) {
    lines.push('## Per endpoint (worst stage)');
    lines.push('');
    lines.push('| endpoint | requests | p50 | p95 | p99 | failures |');
    lines.push('|---|---|---|---|---|---|');
    for (const [name, list] of endpoints) {
      const worst = list.reduce((a, b) => ((b.p95 || 0) > (a.p95 || 0) ? b : a), list[0]);
      lines.push(
        `| ${name} | ${worst.count ?? 'n/a'} | ${fmt(worst.p50, ' ms')} | ${fmt(worst.p95, ' ms')} | ` +
          `${fmt(worst.p99, ' ms')} | ${fmt(worst.failed, '')} |`
      );
    }
    lines.push('');
  }

  // Workload classes: a single "N users" row would merge anonymous boot calls,
  // signed-in reads, PDF status and video metadata into one meaningless number.
  const workloadNames = new Set();
  for (const r of report.rows) for (const w of r.workloads) workloadNames.add(w.name);
  if (workloadNames.size > 0) {
    lines.push('## Workload classes (kept separate on purpose)');
    lines.push('');
    lines.push('| workload | measured | requests | p50 | p95 | p99 | failures | not measured because |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const name of workloadNames) {
      // Worst stage per workload: the row that stresses it hardest.
      let worst = null;
      let measured = false;
      let needs = '';
      for (const r of report.rows) {
        for (const w of r.workloads) {
          if (w.name !== name) continue;
          if (w.measured) measured = true;
          if (!needs && w.needs) needs = w.needs;
          if (worst === null || (w.p95 || 0) > (worst.p95 || 0)) worst = w;
        }
      }
      if (worst === null) continue;
      lines.push(
        `| ${name} | ${measured ? 'yes' : '**no**'} | ${worst.requests} | ${fmt(worst.p50, ' ms')} | ` +
          `${fmt(worst.p95, ' ms')} | ${fmt(worst.p99, ' ms')} | ${worst.failed} | ${needs || '—'} |`
      );
    }
    lines.push('');
    lines.push(
      '> A workload marked **no** was NOT exercised in this run. Its capacity is unknown, and no number from ' +
        'the other rows may be quoted for it.'
    );
    lines.push('');
  }

  lines.push('## Findings');
  lines.push('');
  if (report.summary.stoppedAt) {
    lines.push(
      `- The run **stopped at ${report.summary.stoppedAt.targetVus} VUs**: ${report.summary.stoppedAt.reasons.join('; ')}.`
    );
  } else {
    lines.push('- No stage breached the configured stop conditions.');
  }
  if (report.summary.highestHealthyStage) {
    lines.push(`- Highest healthy stage: **${report.summary.highestHealthyStage}**.`);
  }
  if (report.summary.degradationStartsAt) {
    const d = report.summary.degradationStartsAt;
    lines.push(
      `- Degradation begins at **${d.targetVus} VUs** (p95 ${fmt(d.p95, ' ms')}, errors ${fmt(d.errorRate, ' %')}).`
    );
  } else {
    lines.push('- No degradation was observed in the tested range (this is not a capacity ceiling).');
  }
  if (report.summary.inconclusive) {
    lines.push(
      '- **Inconclusive**: at least one stage did not reach its configured concurrency; see the per-stage notes.'
    );
  }
  lines.push('');
  lines.push(
    '> Only numbers measured in this run appear above. Metrics the host does not expose are reported as `n/a`; ' +
      'an estimate is never presented as a measurement.'
  );
  return lines.join('\n') + '\n';
}

/** CSV rows for the stage table (stable column order). */
export function reportCsvRows(report) {
  return report.rows.map((r) => ({
    stage: r.label,
    target_vus: r.targetVus,
    achieved_vus: r.achievedVus ?? '',
    requests: r.requests,
    rps: r.rps,
    p50_ms: r.latency.p50 ?? '',
    p90_ms: r.latency.p90 ?? '',
    p95_ms: r.latency.p95 ?? '',
    p99_ms: r.latency.p99 ?? '',
    error_rate_pct: r.errorRate ?? '',
    server_errors: r.counters.server_error || 0,
    entry_process_limit: r.counters.entry_process_limit || 0,
    timeouts: r.counters.timeout || 0,
    connection_failures: r.counters.connection || 0,
    rate_limited: r.counters.rate_limited || 0,
    stopped: r.stop ? 1 : 0,
    reasons: r.reasons.join(' | '),
  }));
}

export function toCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}
