#!/usr/bin/env node
/**
 * TEMPORARY SECURITY SUSPENSION — arming and verification of the build-time
 * diagnostic switch (`src/lib/securityTestBuild.ts`).
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * A release bundle does not read `process.env` at runtime. Inside Metro/Babel,
 * `babel-preset-expo/build/inline-env-vars.js` replaces every
 * `process.env.EXPO_PUBLIC_*` read with the VALUE PRESENT IN THE BUNDLER
 * PROCESS at transform time:
 *
 *     if (isProduction) path.replaceWith(t.valueToNode(process.env[key]));
 *     else              path.replaceWith(memberExpression(<expo/virtual/env>, key));
 *
 * So the two keys must exist in the environment of the process that compiles
 * the bundle — the node process Gradle starts for
 * `:app:createBundleReleaseJsAndAssets`. Job-level `env:` alone proved
 * unreliable for that (build 223 shipped a bundle with no marker while the
 * build itself succeeded), while the same task demonstrably runs Expo's env
 * loader (its log shows `env: load …` / `env: export …`). This script therefore
 * writes the keys into the project's env FILES, which that loader reads, and
 * then verifies the whole chain end to end before a 30-minute Gradle build.
 *
 * ENV FILE PRECEDENCE (from `node_modules/@expo/env`, `getEnvFiles()`)
 *   highest -> lowest:  .env.<mode>.local, .env.local, .env.<mode>, .env
 *   (`.env.local` is skipped in `test` mode; when NODE_ENV is unset only
 *    `.env.local` and `.env` are consulted.)
 * `loadEnvFiles()` never overwrites a variable already present in the system
 * environment — which is why a stray `EXPO_PUBLIC_SECURITY_TEST_BUILD=0` in
 * the shell can never be "fixed up" here, and must fail loudly instead.
 *
 * The keys are the literal, non-secret strings below. They are written by
 * `arm` on the runner only; a committed copy is rejected by
 * `scripts/check-diagnostic-build-guards.cjs`.
 *
 * USAGE
 *   node scripts/arm-diagnostic-suspension.cjs arm    [--root DIR] [--mode production]
 *   node scripts/arm-diagnostic-suspension.cjs verify [--root DIR] [--mode production]
 *   node scripts/arm-diagnostic-suspension.cjs status [--root DIR] [--mode production]
 *
 * REMOVAL (restores normal security everywhere): delete this script, its two
 * workflow steps, the job `env:` keys and the verify/summary blocks — see
 * docs/TEMP_SECURITY_SUSPENSION.md. `src/` needs no change: without the keys
 * the switch compiles to `false`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const FLAG_KEY = 'EXPO_PUBLIC_SECURITY_TEST_BUILD';
const ACK_KEY = 'EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK';
const FLAG_VALUE = '1';
const ACK_VALUE = 'security-test';
const PAIRS = [
  [FLAG_KEY, FLAG_VALUE],
  [ACK_KEY, ACK_VALUE],
];

/** File that the switch's visible marker lives in, asserted after compilation. */
const MARKER = 'DIAGNOSTIC BUILD';

/** The eight findings the switch is allowed to waive — nothing else. */
const EXPECTED_WAIVED = [
  'developer_options_enabled',
  'adb_enabled',
  'debugger_attached',
  'debug_detected',
  'root_detected',
  'magisk_detected',
  'xposed_detected',
  'frida_detected',
];

/** Findings that must STILL block, proving the waiver is not a blanket bypass. */
const STILL_BLOCKING = ['vpn_detected', 'screen_recording', 'signature_invalid'];

function ok(msg) {
  console.log(`  \u2713 ${msg}`);
}
function info(msg) {
  console.log(`  \u00b7 ${msg}`);
}
function fail(msg) {
  console.error(`\n\u2717 ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { command: argv[0] || 'status', root: ROOT, mode: 'production' };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') opts.root = path.resolve(argv[++i]);
    else if (arg === '--mode') opts.mode = argv[++i];
    else fail(`Unknown argument: ${arg}`);
  }
  return opts;
}

/** Read `KEY=value` pairs we care about from a .env file, without parsing it. */
function readDefinitions(file) {
  if (!fs.existsSync(file)) return new Map();
  const found = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key !== FLAG_KEY && key !== ACK_KEY) continue;
    found.set(key, rawValue.trim().replace(/^['"]|['"]$/g, ''));
  }
  return found;
}

/**
 * Inspect a target file without touching it: which of the two pairs are
 * missing, and which are already defined with a different value.
 */
function analyzeFile(file) {
  const exists = fs.existsSync(file);
  const current = readDefinitions(file);
  const conflicts = [];
  const missing = [];
  for (const [key, value] of PAIRS) {
    if (!current.has(key)) missing.push([key, value]);
    else if (current.get(key) !== value) conflicts.push(`${key}=${current.get(key)}`);
  }
  return { exists, current, conflicts, missing };
}

/** Append the missing pairs, preserving every unrelated line in the file. */
function writeMissing(file, { exists, missing }) {
  const prefix = exists && fs.readFileSync(file, 'utf8').length > 0 ? '\n' : '';
  const body = missing.map(([key, value]) => `${key}=${value}`).join('\n');
  fs.appendFileSync(
    file,
    `${prefix}# TEMPORARY security suspension (crash investigation) — remove to restore enforcement\n${body}\n`,
    'utf8',
  );
}

/** Channels, in the order the env loader prefers them. */
function candidateFiles(mode) {
  return [
    `.env.${mode}.local`, // highest priority, git-ignored (`.env*.local`)
    '.env.local', // loaded in every non-test mode, git-ignored
    `.env.${mode}`, // production-mode fallback, NOT git-ignored (guard rejects a local copy)
    '.env', // mode-independent, always loaded, lowest priority
  ];
}

function commandArm({ root, mode }) {
  console.log('Arming the temporary security suspension (env files only, no secrets):');

  // Phase 1 — inspect EVERY target first, so a conflict cannot leave the
  // project half-armed (some files written, others refused).
  const plan = candidateFiles(mode).map((name) => {
    const file = path.join(root, name);
    return { name, file, ...analyzeFile(file) };
  });
  const conflicts = plan.flatMap((entry) =>
    entry.conflicts.map((conflict) => `${entry.name}: ${conflict}`),
  );
  if (conflicts.length > 0) {
    fail(
      'conflicting definitions found (nothing was written):\n  ' +
        conflicts.join('\n  ') +
        '\n\n  The suspension must never be armed on top of a conflicting local value.\n' +
        '  Remove those lines and re-run.',
    );
  }

  // Phase 2 — write only what is missing.
  const written = [];
  for (const entry of plan) {
    if (entry.missing.length === 0) {
      info(`${entry.name}: already carries both keys`);
      continue;
    }
    writeMissing(entry.file, entry);
    written.push(entry.name);
    info(`${entry.name}: wrote ${entry.missing.map(([key]) => key).join(', ')}`);
  }

  const armed = readDefinitions(path.join(root, '.env'));
  console.log(
    `\nArmed via: ${written.length > 0 ? written.join(', ') : '(already present)'}\n` +
      `Directory now defines: ${[...armed.keys()].join(', ') || '(none)'} in .env\n` +
      'Values are the literal strings documented in docs/TEMP_SECURITY_SUSPENSION.md.',
  );
}

/**
 * Verify the full chain, exactly as Metro/Babel will execute it:
 *   1. Expo's env loader reads the project's .env files
 *   2. the two keys are present in the process environment
 *   3. Babel compiles the switch in PRODUCTION mode (no `expo/virtual/env` reference)
 *   4. the compiled module evaluates to `SECURITY_TEST_BUILD === true`
 *   5. the waived set is exactly the eight intended findings, and unrelated
 *      findings still block
 */
function commandVerify({ root, mode }) {
  console.log(`Verifying the suspension chain (root=${root}, mode=${mode}):`);

  const expoEnv = require('@expo/env');
  const activeFiles = expoEnv.getEnvFiles({ mode, silent: true });
  const present = activeFiles.filter((name) => fs.existsSync(path.join(root, name)));
  console.log(`  env files consulted for this mode: ${activeFiles.join(' -> ')}`);
  console.log(`  present on disk: ${present.join(', ') || '(none)'}`);

  const loaded = expoEnv.loadProjectEnv(root, { mode, silent: true });
  const env = process.env;

  for (const [key, value] of PAIRS) {
    if (env[key] === value) {
      ok(`${key} is "${value}" in the bundler environment`);
    } else if (env[key] === undefined) {
      fail(
        `${key} is not defined for mode "${mode}".\n` +
          `  Files present: ${present.join(', ') || '(none)'}\n` +
          '  The suspension would compile to `false` and the APK would ship un-suspended.',
      );
    } else {
      fail(
        `${key} is "${env[key]}" but "${value}" is required.\n` +
          '  A value already present in the system environment is never overwritten by\n' +
          '  the env files — remove the conflicting export and re-run.',
      );
    }
  }
  if (loaded && loaded.result === 'skipped') {
    info('env loader reported "skipped" (another loader already ran in this process)');
  }

  // ── Compile the switch the way the Android release bundle does ────────────
  const babel = require('@babel/core');
  const source = path.join(ROOT, 'src/lib/securityTestBuild.ts');
  if (!fs.existsSync(source)) fail(`switch source not found: ${source}`);

  const caller = {
    name: 'metro',
    platform: 'android',
    bundler: 'metro',
    isDev: false, // ← release build: values are inlined as literals
    isServer: false,
    isReactServer: false,
    isNodeModule: false,
    isHMREnabled: false,
    // CommonJS output so the compiled switch can be evaluated in-process.
    // (Metro's own caller uses `true`; the inlining above is identical either way.)
    supportsStaticESM: false,
  };
  const { code } = babel.transformFileSync(source, {
    presets: [['babel-preset-expo', {}]],
    filename: source,
    babelrc: false,
    configFile: false,
    caller,
  });

  if (/expo\/virtual\/env/.test(code)) {
    fail(
      'the switch compiled in DEVELOPMENT mode (it still reads `expo/virtual/env`).\n' +
        '  A release bundle would not evaluate the keys. The Gradle bundle task must\n' +
        '  run with `--dev false` / NODE_ENV=production.',
    );
  }
  ok('switch compiled in production mode (env values inlined as literals)');

  // ── Evaluate the compiled module to read the real switch value ────────────
  const sandboxModule = { exports: {} };
  const unexpectedRequire = (id) => {
    throw new Error(`compiled switch unexpectedly required "${id}"`);
  };
  new Function('exports', 'require', 'module', code)(
    sandboxModule.exports,
    unexpectedRequire,
    sandboxModule,
  );
  const mod = sandboxModule.exports;

  if (mod.SECURITY_TEST_BUILD !== true) {
    fail(
      `compiled SECURITY_TEST_BUILD is ${String(mod.SECURITY_TEST_BUILD)}, expected true.\n` +
        '  The keys reached Babel but the switch still evaluates false.',
    );
  }
  ok('compiled SECURITY_TEST_BUILD === true');

  const waived = Array.isArray(mod.DIAGNOSTIC_WAIVED_CHECKS) ? mod.DIAGNOSTIC_WAIVED_CHECKS : [];
  const waivedSet = [...waived].sort().join(',');
  if (waivedSet !== [...EXPECTED_WAIVED].sort().join(',')) {
    fail(
      `waived findings differ from the documented set.\n  expected: ${EXPECTED_WAIVED.join(', ')}\n  actual:   ${waived.join(', ')}`,
    );
  }
  ok(`exactly ${waived.length} findings are waived: ${waived.join(', ')}`);

  // `isSecurityTestBypassed` takes a threat object (`{ type }`), exactly what
  // security.ts passes from its `.filter((t) => …)` before computeRiskScore.
  for (const type of EXPECTED_WAIVED) {
    if (mod.isSecurityTestBypassed({ type }) !== true) {
      fail(`expected "${type}" to be waived, but it still blocks`);
    }
  }
  ok('waived findings are excluded from the blocking verdict');

  for (const type of STILL_BLOCKING) {
    if (mod.isSecurityTestBypassed({ type }) !== false) {
      fail(`"${type}" must still block, but the switch waives it — refusing this build`);
    }
  }
  ok(`unrelated findings still block: ${STILL_BLOCKING.join(', ')}`);

  if (typeof mod.logDiagnosticBuildStatus === 'function') {
    const original = console.warn;
    let emitted = '';
    console.warn = (...args) => {
      emitted += args.join(' ');
    };
    try {
      mod.logDiagnosticBuildStatus();
    } finally {
      console.warn = original;
    }
    if (!emitted.includes('DIAG-BUILD')) {
      fail('logDiagnosticBuildStatus() did not emit the [DIAG-BUILD] marker');
    }
    ok('the one-shot [DIAG-BUILD] marker is emitted by the compiled module');
  }

  const markerSource = fs.readFileSync(
    path.join(ROOT, 'src/components/DiagnosticModeBanner.tsx'),
    'utf8',
  );
  if (!markerSource.includes(MARKER)) {
    fail(
      `src/components/DiagnosticModeBanner.tsx no longer contains "${MARKER}" —\n` +
        '  the APK bundle check would have nothing to find.',
    );
  }
  ok(`the visible "${MARKER}" marker is present in the shipped UI source`);

  console.log('\n\u2713 Suspension chain verified: env files -> Metro/Babel -> true switch.\n');
}

function commandStatus({ root, mode }) {
  console.log(`Suspension status (root=${root}, mode=${mode}):`);
  let any = false;
  for (const name of candidateFiles(mode)) {
    const defs = readDefinitions(path.join(root, name));
    if (defs.size === 0) continue;
    any = true;
    console.log(`  ${name}: ${[...defs.keys()].join(', ')}`);
  }
  const envArmed = process.env[FLAG_KEY] === FLAG_VALUE && process.env[ACK_KEY] === ACK_VALUE;
  console.log(`  process environment: ${envArmed ? 'armed' : 'not armed'}`);
  if (!any && !envArmed) {
    console.log('  -> no suspension source found: a normal build compiles the switch to false');
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === 'arm') return commandArm(opts);
  if (opts.command === 'verify') return commandVerify(opts);
  if (opts.command === 'status') return commandStatus(opts);
  fail(`Unknown command "${opts.command}" (expected arm | verify | status)`);
}

main();
