#!/usr/bin/env node
/**
 * run-state-tests.cjs — compiles the PURE, dependency-free state models
 * (src/lib/securityStateModel.ts, src/lib/startupStateModel.ts,
 * src/lib/maintenanceStateModel.ts) standalone and hands the compiled
 * CommonJS modules to the test files in tests/.
 *
 * WHY THIS IS TRACKED (was .freebuff/run-state-tests.cjs)
 * ──────────────────────────────────────────────────────
 * The runner used to live in `.freebuff/`, which `.gitignore` excludes — so
 * `npm run test:state` could not run from a clean checkout, and the compiled
 * models it produces were unavailable to four suites that require them. The
 * harness is not secret, contains no credentials and depends only on node
 * built-ins plus the repo's own `typescript`; it belongs in `scripts/` with the
 * other validation tooling.
 *
 * Output goes to `scripts/state-build/` (git-ignored, regenerated every run).
 * The tests resolve the compiled models from `scripts/state-build` first and
 * fall back to the legacy `.freebuff/state-build` so nothing that already
 * existed on a developer machine breaks.
 *
 * Usage:
 *   node scripts/run-state-tests.cjs                 # default state/offline suites
 *   node scripts/run-state-tests.cjs <file> [file…]  # specific tests/*.cjs files
 *
 * Exit code is non-zero if any suite fails (failures are never swallowed).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildStateModels } = require('./state-build-models.cjs');

const ROOT = path.resolve(__dirname, '..');

// Suites that consume the compiled models (plus the offline regression set that
// used to be wired to the now-missing .freebuff/run-offline-tests.cjs).
const DEFAULT_TESTS = [
  'securityStateModel.test.cjs',
  'offlineState.test.cjs',
  'maintenanceMode.test.cjs',
];

function run(testFile) {
  const proc = spawnSync(process.execPath, [testFile], { stdio: 'inherit' });
  return proc.status ?? 1;
}

const TESTS_DIR = path.join(ROOT, 'tests');
const requested = process.argv.slice(2);
const testFiles = requested.length > 0 ? requested : DEFAULT_TESTS;

let exit = 0;
try {
  buildStateModels();
} catch (e) {
  console.error('state-build failed:', e.message);
  process.exit(1);
}

for (const f of testFiles) {
  const p = path.isAbsolute(f) ? f : path.join(TESTS_DIR, f);
  if (!fs.existsSync(p)) {
    console.error(`state-test file not found: ${f}`);
    exit = exit || 1;
    continue;
  }
  const code = run(p);
  if (code !== 0) exit = code;
}
process.exit(exit);
