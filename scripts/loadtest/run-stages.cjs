#!/usr/bin/env node
/**
 * run-stages.cjs — run the load-test ladder as a controlled SEQUENCE.
 *
 * Why a runner: a single k6 run with 200 VUs answers "what happens at 200"; it
 * does not answer "where does it start to hurt". This executes one stage at a
 * time (10 → 25 → 50 → 100 → 150 → 200 by default), evaluates the MEASURED
 * result after each one, and stops the sequence at the first failing stage.
 * Each stage is a separate k6 process, so a poisoned stage cannot leak state
 * into the next.
 *
 * SAFETY, IN ORDER OF IMPORTANCE
 *   • A non-loopback BASE_URL requires BOTH `--approve-live` and
 *     `LOADTEST_APPROVED=1`. Building this tool was not permission to load a
 *     shared production host; this is where that approval is checked.
 *   • Every stage is bounded by its stages + a kill timeout; `--plan` prints
 *     exactly what would run and sends no traffic.
 *   • Stop conditions are evaluated from k6's measured summary (error rate,
 *     p95, p99, 5xx/entry-process errors, timeouts). `--continue-on-fail`
 *     exists for lab work only.
 *
 * USAGE
 *   # 1. what would run (no traffic)
 *   BASE_URL=http://127.0.0.1:8090 node scripts/loadtest/run-stages.cjs --plan
 *
 *   # 2. the ladder against a LOCAL/STAGING API
 *   BASE_URL=http://127.0.0.1:8090 \
 *   LOADTEST_TOKEN_POOL_FILE=scripts/loadtest/.tokens.json \
 *   node scripts/loadtest/run-stages.cjs --results=scripts/loadtest/results/local
 *
 *   # 3. a single level
 *   node scripts/loadtest/run-stages.cjs --stages=50
 *
 *   # 4. a live host — ONLY after explicit approval
 *   BASE_URL=https://api.example.com LOADTEST_APPROVED=1 \
 *   node scripts/loadtest/run-stages.cjs --approve-live --stages=10
 *
 * Exit codes: 0 all stages healthy · 1 a stage breached a stop condition ·
 * 2 refused (bad plan / missing approval) · 3 the generator could not run.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(__dirname, 'student-journey.js');

function parseArgs(argv) {
  const out = { stages: null, approveLive: false, continueOnFail: false, plan: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--plan') out.plan = true;
    else if (arg === '--approve-live') out.approveLive = true;
    else if (arg === '--continue-on-fail') out.continueOnFail = true;
    else if (arg.startsWith('--stages=')) {
      out.stages = String(arg.slice('--stages='.length))
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v) && v > 0);
    } else if (arg.startsWith('--results=')) out.results = arg.slice('--results='.length);
    else if (arg.startsWith('--k6=')) out.k6 = arg.slice('--k6='.length);
    else if (arg.startsWith('--script=')) out.script = arg.slice('--script='.length);
    else if (arg.startsWith('--bucket=')) out.bucket = Number(arg.slice('--bucket='.length));
    else if (arg.startsWith('--ndjson=')) out.ndjson = arg.slice('--ndjson='.length) !== '0';
    else if (arg.startsWith('--stage-ramp=')) out.stageRamp = Number(arg.slice('--stage-ramp='.length));
    else if (arg.startsWith('--stage-hold=')) out.stageHold = Number(arg.slice('--stage-hold='.length));
    else if (arg.startsWith('--timeout-grace=')) out.timeoutGrace = Number(arg.slice('--timeout-grace='.length));
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

/** k6 binary: --k6, K6_BIN, the repo-local download, then PATH. */
function resolveK6(explicit) {
  if (explicit) return explicit;
  if (process.env.K6_BIN) return process.env.K6_BIN;
  const local = path.join(ROOT, '.freebuff', 'tools', 'k6', process.platform === 'win32' ? 'k6.exe' : 'k6');
  if (fs.existsSync(local)) return local;
  return 'k6';
}

function assertK6(k6) {
  return new Promise((resolve) => {
    const child = spawn(k6, ['version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

function runK6(k6, env, args, timeoutMs, outputFile) {
  return new Promise((resolve) => {
    const child = spawn(k6, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputCapped = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    // k6's `--out json` writes EVERY sample: at 200 VUs that is gigabytes per
    // stage (a real run filled a disk and then failed to write its own summary,
    // which surfaced as the useless message "k6 did not complete a run (exit 0)").
    // The output is a diagnostic, never evidence worth an unbounded disk, so a
    // stage is killed once it exceeds the cap and reported as such.
    const capBytes = Math.max(1, Number(process.env.LOADTEST_MAX_OUTPUT_MB || 512)) * 1024 * 1024;
    let watcher = null;
    if (outputFile) {
      watcher = setInterval(() => {
        try {
          const { size } = fs.statSync(outputFile);
          if (size > capBytes) {
            outputCapped = true;
            child.kill('SIGKILL');
          }
        } catch {
          /* the file is created lazily by k6 */
        }
      }, 500);
    }

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (watcher) clearInterval(watcher);
      resolve({ code, stdout, stderr, timedOut, outputCapped });
    });
  });
}

function readSummary(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function fmt(v, suffix = '') {
  return v === null || v === undefined ? 'n/a' : `${v}${suffix}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const planModule = await import(pathToFileURL(path.join(__dirname, 'lib', 'plan.mjs')).href);
  const { DEFAULT_STAGE_TARGETS, VU_CEILING, readPlan, validatePlan, evaluateStage, totalSeconds } = planModule;

  const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
  const stageTargets = args.stages || (process.env.STAGE_TARGETS
    ? process.env.STAGE_TARGETS.split(',').map((v) => Number(v.trim())).filter((v) => v > 0)
    : DEFAULT_STAGE_TARGETS);

  const basePlan = readPlan({ ...process.env, BASE_URL: baseUrl, MAX_VUS: String(Math.max(...stageTargets)) });
  const approved = process.env.LOADTEST_APPROVED === '1';

  // ── Refuse early, with every reason at once ────────────────────────────────
  const problems = [];
  if (!baseUrl) problems.push('BASE_URL is required');
  if (!approved) problems.push('LOADTEST_APPROVED=1 is required (a load test is a deliberate act)');
  if (!planModule.isLoopback(baseUrl) && !args.approveLive) {
    problems.push(
      `BASE_URL=${baseUrl} is not loopback: pass --approve-live (and only after the operator approved this target)`
    );
  }
  if (Math.max(...stageTargets) > VU_CEILING) {
    problems.push(`a stage above the ${VU_CEILING}-VU ceiling was requested`);
  }
  const planVerdict = validatePlan({ ...basePlan, stageTargets: null, targetVus: Math.max(...stageTargets) });
  problems.push(...planVerdict.errors);

  if (args.plan) {
    console.log('Resolved staged plan (no traffic):');
    console.log(`  target          : ${baseUrl || '(BASE_URL missing)'}`);
    console.log(`  stages          : ${stageTargets.join(' → ')}`);
    console.log(`  per stage       : ramp ${basePlan.stepRampSeconds}s · hold ${basePlan.stepHoldSeconds}s (ladder)`);
    console.log(`  single stage    : ramp ${basePlan.rampSeconds}s · hold ${basePlan.holdSeconds}s · down ${basePlan.rampDownSeconds}s`);
    console.log(`  sessions        : ${basePlan.sessionMode} (${basePlan.distinctSessions || 'pool/account file'} sessions)`);
    console.log(`  think time      : ${basePlan.thinkTimeMs} ms · timeout ${basePlan.timeoutMs} ms`);
    console.log(
      `  stop lines      : errors > ${(basePlan.maxErrorRate * 100).toFixed(2)}% · p95 > ${basePlan.p95Ms} ms · ` +
        `p99 > ${basePlan.p99Ms} ms · 5xx > ${(basePlan.maxServerErrorRate * 100).toFixed(2)}%`
    );
    console.log(`  approval        : ${approved ? 'LOADTEST_APPROVED=1' : 'MISSING (LOADTEST_APPROVED=1)'}`);
    const total = stageTargets.length * (basePlan.stepRampSeconds + basePlan.stepHoldSeconds);
    console.log(`  estimated total : ~${Math.round(total / 60)} min (plus one ramp-down per stage)`);
    if (problems.length > 0) {
      console.log('\nThis plan would be REFUSED:');
      for (const p of problems) console.log(`  - ${p}`);
      process.exit(2);
    }
    console.log('\nThis plan would be accepted.');
    return;
  }

  if (problems.length > 0) {
    console.error('Refusing to run:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }

  // k6 resolves `open()` paths relative to the SCRIPT file, not the cwd, so any
  // file the scenario reads at init must reach it as an absolute path.
  if (process.env.LOADTEST_TOKEN_POOL_FILE && !path.isAbsolute(process.env.LOADTEST_TOKEN_POOL_FILE)) {
    process.env.LOADTEST_TOKEN_POOL_FILE = path.resolve(ROOT, process.env.LOADTEST_TOKEN_POOL_FILE);
  }
  if (process.env.LOADTEST_ACCOUNTS_FILE && !path.isAbsolute(process.env.LOADTEST_ACCOUNTS_FILE)) {
    process.env.LOADTEST_ACCOUNTS_FILE = path.resolve(ROOT, process.env.LOADTEST_ACCOUNTS_FILE);
  }

  const k6 = resolveK6(args.k6);
  if (!(await assertK6(k6))) {
    console.error(`k6 could not be started (${k6}). See scripts/loadtest/README.md §1.`);
    process.exit(3);
  }

  // Raw per-sample NDJSON is what the time-series CSV is built from, but it is
  // also the only thing here that grows without bound (hundreds of MB during a
  // 200-VU run), so it can be switched off with --ndjson=0 on a small disk.
  const wantNdjson = args.ndjson !== false;

  const resultsDir = path.resolve(args.results || path.join(__dirname, 'results', new Date().toISOString().replace(/[:.]/g, '-')));
  fs.mkdirSync(resultsDir, { recursive: true });
  const script = args.script ? path.resolve(ROOT, args.script) : SCRIPT;

  console.log(`target      : ${baseUrl}`);
  console.log(`script      : ${path.relative(ROOT, script)}`);
  console.log(`results     : ${resultsDir}`);
  console.log(`stages      : ${stageTargets.join(' → ')}`);
  console.log('');

  const failedStages = [];
  for (const target of stageTargets) {
    const label = `vus-${target}`;
    const summaryFile = path.join(resultsDir, `stage-${target}.stage.json`);
    const ndjsonFile = path.join(resultsDir, `stage-${target}.ndjson`);

    // One level per process: single ramp to the target, hold, ramp down. The
    // ladder lives in the runner, so a stage cannot inherit a previous stage's
    // already-warm VUs (and the report can attribute latency to one level).
    const stagePlan = readPlan({
      ...process.env,
      BASE_URL: baseUrl,
      MAX_VUS: String(target),
      STAGE_TARGETS: '',
      RAMP_SECONDS: String(args.stageRamp || basePlan.rampSeconds),
      HOLD_SECONDS: String(args.stageHold || basePlan.holdSeconds),
      RAMP_DOWN_SECONDS: String(basePlan.rampDownSeconds),
    });
    const stageVerdict = validatePlan(stagePlan);
    if (!stageVerdict.ok) {
      console.error(`stage ${label} is invalid: ${stageVerdict.errors.join('; ')}`);
      process.exit(2);
    }

    const duration = totalSeconds(stagePlan);
    const timeoutMs = (duration + Number(args.timeoutGrace || 180)) * 1000;
    console.log(`▶ ${label}: ${duration}s shape (max ${Math.round(timeoutMs / 1000)}s wall)`);

    const started = Date.now();
    const k6Args = ['run', '--quiet', '--no-usage-report'];
    if (wantNdjson) k6Args.push('--out', `json=${ndjsonFile}`);
    k6Args.push(script);
    const result = await runK6(
      k6,
      {
        BASE_URL: baseUrl,
        MAX_VUS: String(target),
        STAGE_TARGETS: '',
        RAMP_SECONDS: String(stagePlan.rampSeconds),
        HOLD_SECONDS: String(stagePlan.holdSeconds),
        RAMP_DOWN_SECONDS: String(stagePlan.rampDownSeconds),
        LOADTEST_STAGE_LABEL: label,
        LOADTEST_SUMMARY_FILE: summaryFile,
      },
      k6Args,
      timeoutMs,
      wantNdjson ? ndjsonFile : null
    );

    if (result.timedOut) {
      console.error(`  ✗ ${label} exceeded its ${Math.round(timeoutMs / 1000)}s wall-clock cap and was killed`);
      failedStages.push({ label, reasons: [`runner timeout after ${Math.round(timeoutMs / 1000)}s`] });
      break;
    }

    if (result.outputCapped) {
      // Not a server result: the timeseries file hit LOADTEST_MAX_OUTPUT_MB. Say
      // so instead of reporting a broken k6 run, and stop the ladder — a full
      // disk would otherwise corrupt the summary this report is built from.
      console.error(`  ✗ ${label}: timeseries output exceeded LOADTEST_MAX_OUTPUT_MB (${process.env.LOADTEST_MAX_OUTPUT_MB || 512} MB); stage killed`);
      failedStages.push({ label, reasons: ['timeseries_output_cap'] });
      break;
    }

    // k6 exit codes: 0 = clean, 99 = a threshold aborted the run (a RESULT, and
    // the summary is still written), anything else = the script itself failed
    // (e.g. 107 = an exception in setup/init). A summary file alone is not proof
    // of a valid run: the first harness run "succeeded" with 1 request and 0
    // iterations because setup() had thrown — exactly the silent failure this
    // check exists to prevent.
    const payload = readSummary(summaryFile);
    const scriptFailure = result.code !== 0 && result.code !== 99;
    if (payload === null || scriptFailure || (payload.stage && payload.stage.iterations === 0)) {
      console.error(`  ✗ ${label}: k6 did not complete a run (exit ${result.code}).`);
      if (/not enough space|ENOSPC|No space left/i.test(`${result.stderr}\n${result.stdout}`)) {
        console.error('  the disk is full: k6 could not write its timeseries/summary. Re-run with --ndjson=0 (aggregate metrics still work) or free space.');
      }
      const detail = `${result.stderr}\n${result.stdout}`
        .split('\n')
        .filter((line) => /level=error|Error:|exception/i.test(line))
        .slice(-6)
        .join('\n');
      if (detail) console.error(detail);
      process.exit(3);
    }

    const stage = payload.stage;
    const verdict = evaluateStage(stage, stagePlan);
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(
      `  ${verdict.stop ? '✗' : '✓'} ${label}: ${stage.requests} req · ${stage.rps}/s · ` +
        `p50 ${fmt(stage.latency.p50, 'ms')} · p95 ${fmt(stage.latency.p95, 'ms')} · ` +
        `p99 ${fmt(stage.latency.p99, 'ms')} · errors ${fmt(stage.errorRate === null ? null : (stage.errorRate * 100).toFixed(2), '%')} ` +
        `· ${elapsed}s`
    );
    for (const r of verdict.reasons) console.log(`      stop: ${r}`);
    for (const i of verdict.inconclusive) console.log(`      note: ${i}`);

    if (verdict.stop) {
      failedStages.push({ label, reasons: verdict.reasons });
      if (!args.continueOnFail) {
        console.log('  stopping the sequence at the first failing stage (override with --continue-on-fail)');
        break;
      }
    }
  }

  // Report over whatever stages produced a summary.
  const { spawnSync } = require('child_process');
  const report = spawnSync(process.execPath, [path.join(__dirname, 'report.cjs'), `--results=${resultsDir}`, `--bucket=${args.bucket || 10}`], {
    stdio: 'inherit',
  });
  if (report.status !== 0) console.error('report generation failed (stage files are still in the results directory)');

  if (failedStages.length > 0) {
    console.error(`\nStopped: ${failedStages.map((s) => s.label).join(', ')} breached a stop condition.`);
    process.exit(1);
  }
  console.log('\nAll stages stayed inside the configured stop conditions.');
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
