#!/usr/bin/env node
/**
 * state-build-models.cjs — compile the PURE, dependency-free state models
 * (src/lib/securityStateModel.ts, src/lib/startupStateModel.ts,
 * src/lib/maintenanceStateModel.ts) into plain CommonJS in
 * `scripts/state-build/` so the tests in tests/ can `require()` them without a
 * bundler, Babel, or a running Metro.
 *
 * Shared by:
 *   • scripts/run-state-tests.cjs — builds, then runs the state/offline suites
 *   • scripts/run-all-tests.cjs   — builds only if the output is missing, so
 *     `node scripts/run-all-tests.cjs` works from a clean checkout
 *
 * The output directory is git-ignored and regenerated on every run; it contains
 * no secrets (it is the compiled form of files already in the repository).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATE_BUILD_DIR = path.join(__dirname, 'state-build');

const SOURCES = [
  'src/lib/securityStateModel.ts',
  'src/lib/startupStateModel.ts',
  'src/lib/maintenanceStateModel.ts',
];

/** Compiled model filenames, e.g. ['securityStateModel.js', …]. */
const OUTPUT_FILES = SOURCES.map((rel) => rel.split('/').pop().replace(/\.ts$/, '.js'));

/** True when every compiled model is already present. */
function stateModelsBuilt() {
  return OUTPUT_FILES.every((f) => fs.existsSync(path.join(STATE_BUILD_DIR, f)));
}

/** Recompile all models into scripts/state-build/. Throws on failure. */
function buildStateModels() {
  fs.mkdirSync(STATE_BUILD_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'statebuild-'));
  const entries = SOURCES.map((rel) => path.join(ROOT, rel));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...entries,
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' }
  );
  for (const rel of SOURCES) {
    const flat = rel.split('/').pop().replace(/\.ts$/, '.js');
    fs.copyFileSync(path.join(tmp, flat), path.join(STATE_BUILD_DIR, flat));
  }
}

module.exports = { STATE_BUILD_DIR, OUTPUT_FILES, SOURCES, stateModelsBuilt, buildStateModels };
