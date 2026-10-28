'use strict';
/**
 * Load-test tooling — plan, guard rails, maths and report.
 *
 * ── What this pins ─────────────────────────────────────────────────────────
 * The suite used to default to 10 virtual users and HARD-FAIL above 50, so
 * "how many concurrent users can this host take?" was never actually asked. The
 * 200-user upgrade is only worth anything if that ceiling really moved and the
 * numbers it reports are the ones it measured, so these tests check the logic
 * that decides both:
 *
 *   P1  the default target is 200 and 200 is ACCEPTED — no silent cap at 10;
 *   P2  a target above the ceiling is an ERROR, not a quiet clamp;
 *   P3  a non-loopback host needs explicit approval (LOADTEST_APPROVED=1);
 *   P4  the stage ladder is bounded, ordered, ends at the target and respects
 *       MAX_TOTAL_SECONDS;
 *   P5  stop conditions carry `abortOnFail` and the configured numbers;
 *   P6  percentiles are computed from the samples (nearest-rank), and an empty
 *       sample reports null — never 0;
 *   P7  failures are classified (429 / 5xx / 508 / timeout / connection) so the
 *       report can separate "rate limited" from "the host fell over";
 *   P8  stop conditions fire on error rate, p95, p99, 5xx and timeouts, and
 *       "we never reached the configured VUs" is INCONCLUSIVE, not a pass;
 *   P9  the report names the highest healthy stage and where degradation starts;
 *   P9b workload classes (anonymous / authenticated / PDF / video) are reported
 *       separately, and a workload that was not exercised says so instead of
 *       borrowing a number from another row;
 *   P10 CSV output is stable and quoted;
 *   P11 the time-series buckets come from the raw k6 points;
 *   P12 the RUNNER enforces the approval gate itself (exit 2 with no traffic).
 *
 * The k6 scenario itself cannot run here (no API to load), so the runner guard
 * is exercised through `--plan`, which resolves everything without sending a
 * request. Everything else is the pure module shared by k6 and Node.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PLAN_MJS = path.join(ROOT, 'scripts', 'loadtest', 'lib', 'plan.mjs');

let passed = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label + (detail !== undefined ? ` — ${detail}` : ''));
    console.log(`  FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

(async () => {
  const plan = await import(pathToFileURL(PLAN_MJS).href);
  const {
    DEFAULT_STAGE_TARGETS,
    VU_CEILING,
    buildStages,
    buildReport,
    classifyOutcome,
    evaluateStage,
    maxDuration,
    percentiles,
    readPlan,
    reportCsvRows,
    renderMarkdown,
    thresholds,
    toCsv,
    totalSeconds,
    validatePlan,
  } = plan;

  // ── P1: the 10-user cap is gone ───────────────────────────────────────────
  section('P1 target and ceiling');
  eq(readPlan({}).targetVus, 200, 'the DEFAULT target is 200 virtual users');
  eq(VU_CEILING, 200, 'the hard ceiling is 200');
  eq(readPlan({ MAX_VUS: '200' }).targetVus, 200, 'MAX_VUS=200 is accepted');
  ok(validatePlan(readPlan({ MAX_VUS: '200', BASE_URL: 'http://127.0.0.1:8090' })).ok, 'a 200-VU loopback plan validates');
  eq(DEFAULT_STAGE_TARGETS[DEFAULT_STAGE_TARGETS.length - 1], 200, 'the default ladder ends at 200');

  // ── P2: above the ceiling is an error, never a clamp ──────────────────────
  section('P2 no silent clamping');
  const overVerdict = validatePlan(readPlan({ MAX_VUS: '500', BASE_URL: 'http://127.0.0.1:8090' }));
  ok(!overVerdict.ok, 'MAX_VUS=500 is refused');
  ok(
    overVerdict.errors.some((e) => /ceiling/.test(e)),
    'the refusal explains the ceiling'
  );
  eq(readPlan({ MAX_VUS: '500' }).targetVus, 500, 'the requested number is not rewritten to fit');

  // ── P3: approval gate ─────────────────────────────────────────────────────
  section('P3 live-target approval');
  const live = validatePlan(readPlan({ MAX_VUS: '50', BASE_URL: 'https://api.example.com' }));
  ok(!live.ok, 'a non-loopback host without approval is refused');
  ok(live.errors.some((e) => /LOADTEST_APPROVED/.test(e)), 'the refusal names LOADTEST_APPROVED');
  ok(
    validatePlan(readPlan({ MAX_VUS: '50', BASE_URL: 'https://api.example.com', LOADTEST_APPROVED: '1' })).ok,
    'the same host is allowed once approved'
  );
  ok(validatePlan(readPlan({ MAX_VUS: '5', BASE_URL: 'http://localhost:8090' })).ok, 'localhost needs no approval');

  // ── P4: staged ladder ─────────────────────────────────────────────────────
  section('P4 stage ladder');
  const ladder = readPlan({
    MAX_VUS: '200',
    STAGE_TARGETS: '10,25,50,100,150,200',
    STEP_RAMP_SECONDS: '30',
    STEP_HOLD_SECONDS: '60',
    RAMP_DOWN_SECONDS: '30',
    BASE_URL: 'http://127.0.0.1:8090',
  });
  const stages = buildStages(ladder);
  eq(stages[stages.length - 1].target, 0, 'the ladder ends by ramping down to 0');
  eq(stages[0].duration, '30s', 'each level ramps for STEP_RAMP_SECONDS');
  eq(stages[0].target, 10, 'the first level is 10 users (baseline)');
  ok(
    stages.map((s) => s.target).join(',') === '10,10,25,25,50,50,100,100,150,150,200,200,0',
    'every level is ramp+hold in ascending order',
    stages.map((s) => s.target).join(',')
  );
  eq(totalSeconds(ladder), 6 * 90 + 30, 'the total is the sum of the stages');
  eq(maxDuration(ladder), `${totalSeconds(ladder) + 60}s`, 'maxDuration adds a bounded grace window');
  const tooLong = validatePlan(
    readPlan({
      MAX_VUS: '200',
      STAGE_TARGETS: '10,200',
      STEP_HOLD_SECONDS: '500',
      MAX_TOTAL_SECONDS: '300',
      BASE_URL: 'http://127.0.0.1:8090',
    })
  );
  ok(tooLong.errors.some((e) => /MAX_TOTAL_SECONDS/.test(e)), 'a run longer than MAX_TOTAL_SECONDS is refused');

  // ── P5: thresholds are the stop conditions ────────────────────────────────
  section('P5 thresholds');
  const t = thresholds(readPlan({ MAX_VUS: '200', P95_MS: '2000', P99_MS: '4000', MAX_ERROR_RATE: '0.02' }));
  eq(t.http_req_failed[0].threshold, 'rate<0.02', 'the error-rate stop line is configured');
  eq(t.http_req_failed[0].abortOnFail, true, 'a failing stage ABORTS instead of pushing on');
  eq(t.http_req_duration[0].threshold, 'p(95)<2000', 'the p95 stop line is configured');
  ok(String(t.http_req_duration[1]).includes('p(99)<4000'), 'the p99 line is configured');

  // ── P6: percentiles from real samples ─────────────────────────────────────
  section('P6 percentiles');
  const p = percentiles([5, 1, 3, 2, 4]);
  eq(p.count, 5, 'the sample count is reported');
  eq(p.min, 1, 'min');
  eq(p.avg, 3, 'avg');
  eq(p.p50, 3, 'p50 (nearest rank)');
  eq(p.p90, 5, 'p90');
  eq(p.max, 5, 'max');
  const hundred = percentiles(Array.from({ length: 100 }, (_, i) => i + 1));
  eq(hundred.p50, 50, 'p50 of 1..100 is 50');
  eq(hundred.p95, 95, 'p95 of 1..100 is 95');
  eq(hundred.p99, 99, 'p99 of 1..100 is 99');
  const empty = percentiles([]);
  eq(empty.p95, null, 'an empty sample reports null p95 (never 0)');
  eq(empty.count, 0, 'an empty sample reports count 0');

  // ── P7: failure classification ────────────────────────────────────────────
  section('P7 failure classes');
  eq(classifyOutcome(200), 'ok', '200 → ok');
  eq(classifyOutcome(429), 'rate_limited', '429 → rate_limited');
  eq(classifyOutcome(401), 'auth', '401 → auth');
  eq(classifyOutcome(500), 'server_error', '500 → server_error');
  eq(classifyOutcome(508), 'entry_process_limit', '508 (CloudLinux entry processes) → entry_process_limit');
  eq(classifyOutcome(0), 'connection', 'status 0 → connection');
  eq(classifyOutcome(0, 'timeout'), 'timeout', 'a timeout is not just a dropped connection');

  // ── P8: stop conditions ───────────────────────────────────────────────────
  section('P8 stop conditions');
  const stopPlan = readPlan({ MAX_VUS: '200', P95_MS: '2000', P99_MS: '4000', MAX_ERROR_RATE: '0.02', BASE_URL: 'http://127.0.0.1:8090' });
  const healthy = evaluateStage(
    { requests: 1000, errorRate: 0.001, latency: { p95: 900, p99: 1500 }, achievedVus: 200, counters: {} },
    stopPlan
  );
  ok(!healthy.stop, 'a healthy stage does not stop the run');
  ok(healthy.inconclusive.length === 0, 'and is not inconclusive when it reached its VUs');

  const badErrors = evaluateStage(
    { requests: 100, errorRate: 0.05, latency: { p95: 900, p99: 1500 }, achievedVus: 200, counters: {} },
    stopPlan
  );
  ok(badErrors.stop && badErrors.reasons.some((r) => /error rate/.test(r)), 'an elevated error rate stops the run');

  const badP95 = evaluateStage(
    { requests: 100, errorRate: 0, latency: { p95: 2500, p99: 3000 }, achievedVus: 200, counters: {} },
    stopPlan
  );
  ok(badP95.stop && badP95.reasons.some((r) => /p95/.test(r)), 'a breached p95 stops the run');

  const bad5xx = evaluateStage(
    { requests: 1000, errorRate: 0.001, latency: { p95: 900, p99: 1500 }, achievedVus: 200, counters: { server_error: 40 } },
    stopPlan
  );
  ok(bad5xx.stop && bad5xx.reasons.some((r) => /server|entry-process/.test(r)), 'a 5xx cluster stops the run');

  const timeouts = evaluateStage(
    { requests: 1000, errorRate: 0.001, latency: { p95: 900, p99: 1500 }, achievedVus: 200, counters: { timeout: 40 } },
    stopPlan
  );
  ok(timeouts.stop && timeouts.reasons.some((r) => /timeout/.test(r)), 'timeouts stop the run');

  const unreached = evaluateStage(
    { requests: 50, errorRate: 0, latency: { p95: 900, p99: 1500 }, achievedVus: 12, counters: {} },
    stopPlan
  );
  ok(!unreached.stop, 'a generator-limited stage is not called a server failure');
  ok(
    unreached.inconclusive.some((r) => /12 of 200/.test(r)),
    'but it IS reported as inconclusive (achieved ≠ configured)'
  );

  // ── P9: report findings ───────────────────────────────────────────────────
  section('P9 report');
  const report = buildReport(stopPlan, [
    {
      label: 'vus-10',
      targetVus: 10,
      achievedVus: 10,
      requests: 900,
      rps: 9,
      errorRate: 0,
      latency: { min: 100, avg: 200, p50: 190, p90: 300, p95: 350, p99: 500, max: 900 },
      counters: {},
      endpoints: [{ name: 'GET /courses', count: 100, p50: 200, p95: 400, p99: 600, failed: 0 }],
    },
    {
      label: 'vus-100',
      targetVus: 100,
      achievedVus: 100,
      requests: 8000,
      rps: 80,
      errorRate: 0.001,
      latency: { min: 200, avg: 900, p50: 800, p90: 1500, p95: 1700, p99: 2600, max: 4000 },
      counters: { server_error: 2 },
      endpoints: [{ name: 'GET /courses', count: 900, p50: 900, p95: 1800, p99: 2600, failed: 2 }],
    },
  ]);
  eq(report.rows.length, 2, 'one row per stage');
  eq(report.summary.configuredTarget, 200, 'the configured target is reported');
  eq(report.summary.highestAchievedVus, 100, 'the highest ACHIEVED concurrency is reported separately');
  eq(report.summary.highestHealthyStage, 'vus-100', 'the highest healthy stage is named');
  ok(report.summary.degradationStartsAt !== null, 'degradation onset is detected (p95 ≥ 80% of the stop line)');
  eq(report.summary.degradationStartsAt.targetVus, 100, 'and attributed to the right stage');
  eq(report.summary.stoppedAt, null, 'no stage breached a hard stop line here');

  const md = renderMarkdown(report);
  ok(md.includes('200 VUs'), 'the markdown states the configured target');
  ok(md.includes('vus-100'), 'and includes the stage table');
  ok(md.includes('GET /courses'), 'and the per-endpoint table');
  // A report where NOTHING degraded must say so explicitly — the absence of a
  // ceiling inside the tested range is a result, not a capacity number.
  const healthyOnly = buildReport(stopPlan, [
    {
      label: 'vus-10',
      targetVus: 10,
      achievedVus: 10,
      requests: 900,
      rps: 9,
      errorRate: 0,
      latency: { min: 100, avg: 200, p50: 190, p90: 300, p95: 350, p99: 500, max: 900 },
      counters: {},
      endpoints: [],
    },
  ]);
  ok(
    /not a capacity ceiling/.test(renderMarkdown(healthyOnly)),
    'a report with no degradation says so and refuses to claim a ceiling'
  );

  const withNulls = buildReport(stopPlan, [
    { label: 'vus-10', targetVus: 10, achievedVus: null, requests: 0, rps: 0, errorRate: null, latency: { min: null, avg: null, p50: null, p90: null, p95: null, p99: null, max: null }, counters: {}, endpoints: [] },
  ]);
  const mdNulls = renderMarkdown(withNulls);
  ok(mdNulls.includes('n/a'), 'missing metrics render as n/a, never as 0');

  // ── P9b: workload classes stay separate ───────────────────────────────────
  // A single "N users" row would merge anonymous boot calls, signed-in reads,
  // PDF status and video metadata into a number that describes none of them.
  section('P9b workloads');
  const withWorkloads = buildReport(stopPlan, [
    {
      label: 'vus-10',
      targetVus: 10,
      achievedVus: 10,
      requests: 300,
      rps: 9,
      errorRate: 0,
      latency: { min: 100, avg: 200, p50: 190, p90: 300, p95: 350, p99: 500, max: 900 },
      counters: {},
      endpoints: [],
      workloads: [
        { name: 'anon-boot', title: 'Anonymous public API', measured: true, needs: null, requests: 100, failed: 0, p50: 180, p95: 300, p99: 400 },
        { name: 'auth-read', title: 'Authenticated student reads', measured: true, needs: null, requests: 200, failed: 1, p50: 210, p95: 360, p99: 520 },
        { name: 'pdf-generation', title: 'PDF watermark generation + queue worker', measured: false, needs: 'a disposable staging account', requests: 0, failed: 0, p50: null, p95: null, p99: null },
      ],
    },
  ]);
  eq(withWorkloads.rows[0].workloads.length, 3, 'the workload rows survive into the report');
  const mdWorkloads = renderMarkdown(withWorkloads);
  ok(mdWorkloads.includes('Workload classes'), 'the markdown has a workload section');
  ok(mdWorkloads.includes('anon-boot') && mdWorkloads.includes('auth-read'), 'measured workloads are listed separately');
  ok(/\|\s*pdf-generation\s*\|\s*\*\*no\*\*/.test(mdWorkloads), 'an unmeasured workload is marked NO, not reported as a number');
  ok(
    mdWorkloads.includes('not measured because') && mdWorkloads.includes('a disposable staging account'),
    'the reason a workload was not measured is stated'
  );
  ok(
    /may be quoted for it/.test(mdWorkloads),
    'the report warns that no other row may be quoted for an unmeasured workload'
  );

  // ── P10: CSV ──────────────────────────────────────────────────────────────
  section('P10 CSV');
  const csv = toCsv(reportCsvRows(report));
  const csvLines = csv.trim().split('\n');
  eq(csvLines[0].split(',')[0], 'stage', 'the header starts with the stage column');
  ok(csvLines.length === 3, 'one header + one row per stage', String(csvLines.length));
  ok(csvLines[1].includes('vus-10'), 'a stage row is present');
  const quoted = toCsv([{ a: 'x,y', b: 'he said "hi"' }]);
  ok(quoted.includes('"x,y"'), 'commas are quoted');
  ok(quoted.includes('"he said ""hi"""'), 'quotes are escaped');

  // ── P11: time series from k6 points ───────────────────────────────────────
  section('P11 time series');
  const { buildTimeSeries } = require(path.join(ROOT, 'scripts', 'loadtest', 'report.cjs'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-series-'));
  const ndjson = path.join(tmpDir, 'stage-10.ndjson');
  const base = Date.parse('2026-10-27T10:00:00Z');
  const points = [];
  for (let i = 0; i < 20; i += 1) {
    points.push({
      type: 'Point',
      metric: 'http_req_duration',
      data: { time: new Date(base + i * 1000).toISOString(), value: 100 + i * 10 },
    });
    points.push({
      type: 'Point',
      metric: 'http_req_failed',
      data: { time: new Date(base + i * 1000).toISOString(), value: i >= 15 ? 1 : 0 },
    });
  }
  fs.writeFileSync(ndjson, points.map((p) => JSON.stringify(p)).join('\n') + '\n');
  const series = buildTimeSeries(ndjson, 10, percentiles);
  eq(series.length, 2, '20 s of points in 10 s buckets → 2 buckets');
  eq(series[0].requests, 10, 'the first bucket counts its own requests');
  eq(series[0].rps, 1, 'and its requests per second');
  eq(series[1].errors, 5, 'errors are counted per bucket');
  eq(series[1].error_rate_pct, 50, 'and expressed as a percentage');
  ok(series[0].p95_ms < series[1].p95_ms, 'latency growth is visible across buckets');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // ── P12: the runner enforces the gate itself ──────────────────────────────
  section('P12 runner approval gate');
  const env = { ...process.env, BASE_URL: 'https://api.example.com', MAX_VUS: '200' };
  delete env.LOADTEST_APPROVED;
  const refused = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'loadtest', 'run-stages.cjs'), '--plan'], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  eq(refused.status, 2, 'the runner exits 2 for an unapproved live target');
  ok(/LOADTEST_APPROVED/.test(`${refused.stdout}${refused.stderr}`), 'and says why');

  const localPlan = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'loadtest', 'run-stages.cjs'), '--plan'],
    {
      env: { ...process.env, BASE_URL: 'http://127.0.0.1:8090', LOADTEST_APPROVED: '1', MAX_VUS: '200', STAGE_TARGETS: '10,25,50,100,150,200' },
      encoding: 'utf8',
      timeout: 30000,
    }
  );
  eq(localPlan.status, 0, 'a loopback 200-VU ladder is accepted');
  ok(/10 → 25 → 50 → 100 → 150 → 200/.test(localPlan.stdout), 'and prints the full ladder', localPlan.stdout);

  // ── P13: the scenario file carries no 10/50 cap ───────────────────────────
  // ── P13a: the timeseries output cannot fill the disk ─────────────
  section('P13a timeseries output is bounded');
  {
    // A real 200-VU stage wrote gigabytes of `--out json` and then could not
    // write its own summary, which every later step depends on. The output is a
    // diagnostic, so it is capped and the stage is reported as capped (not as a
    // broken k6 run).
    const runner = fs.readFileSync(path.join(ROOT, 'scripts/loadtest/run-stages.cjs'), 'utf8');
    ok(/LOADTEST_MAX_OUTPUT_MB/.test(runner), 'runner has a configurable output cap');
    ok(/outputCapped/.test(runner) && /child\.kill\('SIGKILL'\)/.test(runner),
      'and kills a stage that exceeds it');
    ok(/timeseries_output_cap/.test(runner), 'and reports the stop reason as a cap, not a k6 failure');
    ok(/not enough space|ENOSPC/i.test(runner), 'and explains a full disk when k6 cannot write at all');
  }

  section('P13 no leftover cap in the scenario');
  const configSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'loadtest', 'lib', 'config.js'), 'utf8');
  ok(!/'MAX_VUS',\s*10\)/.test(configSrc), 'config.js no longer defaults MAX_VUS to 10');
  ok(!/VU_CEILING\s*=\s*50/.test(configSrc), 'config.js no longer caps VUs at 50');
  const journeySrc = fs.readFileSync(path.join(ROOT, 'scripts', 'loadtest', 'student-journey.js'), 'utf8');
  ok(/sessionForVU/.test(journeySrc), 'the journey resolves a session PER VU');
  ok(/classifyOutcome/.test(journeySrc), 'and classifies every outcome for the report');
  ok(/epfail_|ep_/.test(journeySrc), 'and records per-endpoint metrics');

  section('P14 anonymous live probe mode (SESSION_MODE=none)');
  {
    // A live host with no dedicated test account must be measurable WITHOUT
    // touching a real student's session. `none` is that mode: public boot calls
    // only, no login, no token.
    // Loopback + approved-free: the mode itself must not need a live target.
    const baseEnv = { MAX_VUS: '25', BASE_URL: 'http://127.0.0.1:8090' };
    const anon = readPlan({ ...baseEnv, SESSION_MODE: 'none' });
    const anonVerdict = validatePlan(anon);
    eq(anon.sessionMode, 'none', 'SESSION_MODE=none is parsed, not coerced');
    ok(anonVerdict.ok, 'SESSION_MODE=none is a valid plan');
    ok(
      anonVerdict.warnings.some((w) => /boot endpoints only/i.test(w)),
      'and it warns that only public boot endpoints are exercised'
    );
    ok(
      !validatePlan(readPlan({ ...baseEnv, SESSION_MODE: 'bogus' })).ok,
      'an unknown SESSION_MODE is still rejected'
    );
    const configSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'loadtest', 'lib', 'config.js'), 'utf8');
    ok(
      /PLAN\.sessionMode === 'none'/.test(configSrc) && /mode: 'anonymous'/.test(configSrc),
      'config.js resolves an anonymous session for that mode'
    );
    ok(
      /PLAN\.sessionMode === 'none'/.test(
        fs.readFileSync(path.join(ROOT, 'scripts', 'loadtest', 'student-journey.js'), 'utf8')
      ),
      'the journey skips the authenticated fixture lookup in that mode'
    );
  }

  console.log('\n------------------------------------------------------------');
  if (failures.length > 0) {
    console.log(`${passed} passed, ${failures.length} FAILED`);
    for (const f of failures) console.log(` - ${f}`);
    process.exit(1);
  }
  console.log(`${passed} passed, 0 failed`);
  console.log('ALL LOAD-TEST CHECKS PASSED');
})();
