#!/usr/bin/env node
/**
 * report.cjs — turn k6 stage results into the report the operator reads.
 *
 * INPUTS (written by run-stages.cjs / student-journey.js)
 *   <results>/stage-<n>.stage.json   one summary per stage (k6 handleSummary)
 *   <results>/stage-<n>.ndjson       optional raw k6 `--out json` points
 *
 * OUTPUTS
 *   <results>/report.json            machine-readable (per stage + findings)
 *   <results>/report.md              the readable summary
 *   <results>/stages.csv             stage table (spreadsheet-friendly)
 *   <results>/timeseries.csv         per-bucket RPS / latency / errors over time
 *
 * WHY IT EXISTS SEPARATELY FROM k6
 *   k6's own summary is per-run. The capacity question is a SEQUENCE of runs
 *   (10 → 200 users), so the aggregation — stop reasons, the highest healthy
 *   stage, where degradation begins — has to happen across files. All maths is
 *   the pure code in lib/plan.mjs, which is unit-tested in Node.
 *
 * Nothing here invents a number: a missing metric is null, and the markdown says
 * so. Time-series percentiles are computed from the individual samples k6
 * recorded, not interpolated from the run summary.
 *
 * USAGE
 *   node scripts/loadtest/report.cjs --results=scripts/loadtest/results/latest
 *   node --test? no: this is a plain CLI; the tests live in tests/loadtestPlan.test.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const [k, v] = arg.slice(2).split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

/** Stage summary files, ordered by their numeric target. */
function listStageFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^stage-\d+\.stage\.json$/.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => Number(/(\d+)/.exec(path.basename(a))[1]) - Number(/(\d+)/.exec(path.basename(b))[1]));
}

/**
 * Bucketed time series from a k6 NDJSON stream.
 *
 * Each bucket reports requests, req/s, p50/p95 of the durations recorded in that
 * bucket, and the error rate — that is how "when did it start to degrade?" is
 * answered from data rather than from impression.
 */
function buildTimeSeries(ndjsonPath, bucketSeconds, percentiles) {
  if (!fs.existsSync(ndjsonPath)) return [];
  const durations = [];
  const failures = [];
  const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n');
  for (const line of lines) {
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (e) {
      continue; // a truncated last line must not abort the report
    }
    if (row.type !== 'Point' || !row.data || typeof row.data.time !== 'string') continue;
    const t = Date.parse(row.data.time);
    if (!Number.isFinite(t)) continue;
    if (row.metric === 'http_req_duration') durations.push({ t, v: Number(row.data.value) });
    else if (row.metric === 'http_req_failed') failures.push({ t, v: Number(row.data.value) });
  }
  if (durations.length === 0) return [];

  const start = Math.min(...durations.map((d) => d.t));
  const width = Math.max(1, bucketSeconds) * 1000;
  const buckets = new Map();
  for (const d of durations) {
    const idx = Math.floor((d.t - start) / width);
    if (!buckets.has(idx)) buckets.set(idx, { durations: [], errors: 0, failures: 0 });
    buckets.get(idx).durations.push(d.v);
  }
  for (const f of failures) {
    const idx = Math.floor((f.t - start) / width);
    if (!buckets.has(idx)) buckets.set(idx, { durations: [], errors: 0, failures: 0 });
    const b = buckets.get(idx);
    b.failures += 1;
    if (f.v > 0) b.errors += 1;
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, b]) => {
      const p = percentiles(b.durations);
      return {
        bucket_start_seconds: idx * (width / 1000),
        requests: b.durations.length,
        rps: Math.round((b.durations.length / (width / 1000)) * 100) / 100,
        p50_ms: p.p50,
        p95_ms: p.p95,
        p99_ms: p.p99,
        errors: b.errors,
        error_rate_pct: b.durations.length ? Math.round((b.errors / b.durations.length) * 10000) / 100 : null,
      };
    });
}

async function main() {
  const args = parseArgs(process.argv);
  const resultsDir = path.resolve(String(args.results || path.join(__dirname, 'results', 'latest')));
  const bucketSeconds = Number(args.bucket || 10);

  const planModule = await import(pathToFileURL(path.join(__dirname, 'lib', 'plan.mjs')).href);
  const { buildReport, renderMarkdown, reportCsvRows, toCsv, validatePlan } = planModule;

  const files = listStageFiles(resultsDir);
  if (files.length === 0) {
    console.error(`No stage results in ${resultsDir}. Run scripts/loadtest/run-stages.cjs first.`);
    process.exit(2);
  }

  const stages = [];
  let plan = null;
  for (const file of files) {
    const payload = readJson(file);
    if (payload.plan && plan === null) plan = payload.plan;
    stages.push(payload.stage);
  }
  if (plan === null) {
    console.error('Stage files carry no plan; re-run with the current student-journey.js.');
    process.exit(2);
  }

  // The report's plan shape mirrors lib/plan.mjs; validate the parts it uses.
  const verdict = validatePlan(plan);
  const report = buildReport(plan, stages);
  report.validation = { ok: verdict.ok, errors: verdict.errors, warnings: verdict.warnings };

  // Time series (optional: only when k6 --out json was used).
  const series = [];
  for (const file of files) {
    const base = path.basename(file, '.stage.json');
    const ndjson = path.join(resultsDir, `${base}.ndjson`);
    for (const row of buildTimeSeries(ndjson, bucketSeconds, planModule.percentiles)) {
      series.push({ stage: base.replace('stage-', 'vus-'), ...row });
    }
  }

  fs.writeFileSync(path.join(resultsDir, 'report.json'), JSON.stringify({ ...report, timeseries: series }, null, 2));
  fs.writeFileSync(path.join(resultsDir, 'report.md'), renderMarkdown(report));
  fs.writeFileSync(path.join(resultsDir, 'stages.csv'), toCsv(reportCsvRows(report)));
  fs.writeFileSync(path.join(resultsDir, 'timeseries.csv'), toCsv(series));

  process.stdout.write(renderMarkdown(report));
  process.stdout.write(`\nWrote ${path.join(resultsDir, 'report.md')}, report.json, stages.csv, timeseries.csv\n`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || String(e));
    process.exit(1);
  });
}

module.exports = { buildTimeSeries, listStageFiles };
