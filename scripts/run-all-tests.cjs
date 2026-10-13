#!/usr/bin/env node
/**
 * run-all-tests.cjs — run every regression suite in tests/ and summarise.
 *
 * WHY: the suites were only ever run ad-hoc (a shell loop), so there was no
 * single entry point a human or CI could trust. `npm test` now builds the pure
 * state models first (via `npm run test:state`) and then runs every
 * `tests/*.test.cjs` here.
 *
 * Semantics are deliberately simple and honest:
 *   • every suite is run, even after a failure (one run shows all damage);
 *   • a suite passes only on exit code 0;
 *   • the exit code is non-zero when any suite failed;
 *   • each suite is bounded by a timeout so a hang cannot wedge the run.
 *
 * Usage:
 *   node scripts/run-all-tests.cjs            # all suites
 *   node scripts/run-all-tests.cjs offline    # only suites whose name matches
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stateModelsBuilt, buildStateModels } = require('./state-build-models.cjs');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const PER_TEST_TIMEOUT_MS = 180_000;

// Four suites require the compiled pure state models. Build them up-front when
// missing so this runner works from a clean checkout on its own.
if (!stateModelsBuilt()) {
  console.log('Compiling pure state models (scripts/state-build/)…');
  try {
    buildStateModels();
  } catch (e) {
    console.error('state-build failed:', e.message);
    process.exit(1);
  }
}

const filter = process.argv[2] ?? '';
const suites = fs
  .readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('.test.cjs'))
  .filter((f) => (filter ? f.includes(filter) : true))
  .sort();

if (suites.length === 0) {
  console.error(`no test suites found in ${TESTS_DIR}${filter ? ` matching "${filter}"` : ''}`);
  process.exit(1);
}

const failed = [];
const started = Date.now();

console.log(`Running ${suites.length} suite(s)…\n`);
for (const suite of suites) {
  const file = path.join(TESTS_DIR, suite);
  const proc = spawnSync(process.execPath, [file], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: PER_TEST_TIMEOUT_MS,
  });
  const status = proc.status ?? 1;
  const ok = status === 0;
  if (!ok) failed.push(suite);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${suite}\n`);
  if (!ok) {
    // Surface the real reason — never hide a failure behind a summary line.
    const tail = (s) => (s ?? '').trim().split('\n').slice(-12).join('\n        ');
    const out = tail(proc.stdout);
    const err = tail(proc.stderr);
    if (out) console.log(`        ${out}`);
    if (err) console.log(`        stderr: ${err}`);
    if (proc.error) console.log(`        spawn error: ${proc.error.message}`);
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${'─'.repeat(60)}`);
console.log(`${suites.length - failed.length} passed, ${failed.length} failed  (${secs}s)`);
if (failed.length) {
  console.log('\nFailed suites:');
  for (const f of failed) console.log(`  - ${f}`);
}
process.exit(failed.length ? 1 : 0);
