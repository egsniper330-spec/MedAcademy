#!/usr/bin/env node
/**
 * TEMPORARY SECURITY SUSPENSION — arm, verify, disarm.
 *
 * ─── WHY THIS SCRIPT EXISTS ──────────────────────────────────────────────────
 * The diagnostic switch (`src/lib/securityTestBuild.ts`) waives the local
 * device-environment findings so a crash can be reproduced on a tablet with ADB
 * attached. Actor 1 of this mechanism used `process.env.EXPO_PUBLIC_*`, which a
 * release bundle inlines at transform time
 * (`babel-preset-expo/build/inline-env-vars.js`: `t.valueToNode(process.env[key])`
 * in production mode). Android builds 223 and 43926766869 proved that channel
 * unusable end to end:
 *
 *   • job-level `env:` did not reach the bundle (223);
 *   • writing the keys into every `.env` channel DID get loaded — the Gradle
 *     bundle task printed
 *       `env: load .env.production.local .env.local .env.production .env`
 *     and the pre-build gate in the SAME job compiled the switch to `true`;
 *   • yet the shipped, minified bundle contained no marker at all, i.e. the
 *     Metro worker that transformed the file had inlined `void 0`, and terser
 *     then deleted the diagnostic code as dead code.
 *
 * So the switch is now a plain source constant,
 * `src/lib/diagnosticBuildFlag.ts`. It cannot be misread by a worker, and the
 * minifier keeps it exactly as written. This script owns that file:
 *
 *   arm     both keys present in the environment → flag := true
 *   disarm  flag := false and remove the env lines this script added
 *   verify  prove the whole chain before a 30-minute Gradle build
 *   status  report what is armed, and from where
 *
 * ─── THE TWO KEYS ARE STILL THE AUTHORISATION ───────────────────────────────
 *   EXPO_PUBLIC_SECURITY_TEST_BUILD=1
 *   EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK=security-test
 * `arm` refuses to touch the flag unless BOTH are in its environment, so a
 * stray variable can never arm it (and a wrong value is never "corrected").
 * The workflow sets them at job level; `eas.json`'s `security-test` profile
 * declares them too.
 *
 * ─── ENV FILES (diagnostic channel only) ────────────────────────────────────
 * `arm` also writes the two keys into the project's env files, in the order
 * Expo's loader prefers them (`node_modules/@expo/env`, `getEnvFiles()`):
 *
 *   highest → lowest: .env.<mode>.local, .env.local, .env.<mode>, .env
 *
 * They are not what enables the build any more; they make the intent visible in
 * the bundle log (`env: export …`) and keep the EAS `security-test` path
 * consistent. A checkout whose env files declare the keys is rejected by
 * `scripts/check-diagnostic-build-guards.cjs`, and the checked-in flag is
 * `false`, so an ordinary build cannot inherit the suspension.
 *
 * USAGE
 *   node scripts/arm-diagnostic-suspension.cjs arm    [--root DIR] [--mode production] [--flag FILE]
 *   node scripts/arm-diagnostic-suspension.cjs verify [--root DIR] [--mode production] [--flag FILE]
 *   node scripts/arm-diagnostic-suspension.cjs disarm [--root DIR] [--mode production] [--flag FILE]
 *   node scripts/arm-diagnostic-suspension.cjs status [--root DIR] [--mode production] [--flag FILE]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FLAG_FILE_REL = 'src/lib/diagnosticBuildFlag.ts';
const FLAG_DECLARATION = /export const DIAGNOSTIC_BUILD_FLAG: boolean = (true|false);/;

const FLAG_KEY = 'EXPO_PUBLIC_SECURITY_TEST_BUILD';
const ACK_KEY = 'EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK';
const FLAG_VALUE = '1';
const ACK_VALUE = 'security-test';
const PAIRS = [
  [FLAG_KEY, FLAG_VALUE],
  [ACK_KEY, ACK_VALUE],
];
const BLOCK_COMMENT = '# TEMPORARY security suspension (crash investigation)';

/** The marker the shipped UI must contain, and the Logcat one-shot marker. */
const UI_MARKER = 'DIAGNOSTIC BUILD';
const LOG_MARKER = '[DIAG-BUILD]';

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
  const opts = { command: argv[0] || 'status', root: ROOT, mode: 'production', flag: null };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') opts.root = path.resolve(argv[++i]);
    else if (arg === '--mode') opts.mode = argv[++i];
    else if (arg === '--flag') opts.flag = path.resolve(argv[++i]);
    else fail(`Unknown argument: ${arg}`);
  }
  opts.flagFile = opts.flag || path.join(opts.root, FLAG_FILE_REL);
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

function writeMissing(file, { exists, missing }) {
  const prefix = exists && fs.readFileSync(file, 'utf8').length > 0 ? '\n' : '';
  const body = missing.map(([key, value]) => `${key}=${value}`).join('\n');
  fs.appendFileSync(file, `${prefix}${BLOCK_COMMENT} — remove to restore enforcement\n${body}\n`, 'utf8');
}

/** Channels, in the order the Expo env loader prefers them. */
function candidateFiles(mode) {
  return [`.env.${mode}.local`, '.env.local', `.env.${mode}`, '.env'];
}

// ── The flag module ─────────────────────────────────────────────────────────

function readFlag(file) {
  if (!fs.existsSync(file)) fail(`flag module not found: ${file}`);
  const match = FLAG_DECLARATION.exec(fs.readFileSync(file, 'utf8'));
  if (!match) fail(`cannot read DIAGNOSTIC_BUILD_FLAG from ${file}`);
  return match[1] === 'true';
}

function writeFlag(file, value) {
  if (!fs.existsSync(file)) fail(`flag module not found: ${file}`);
  const source = fs.readFileSync(file, 'utf8');
  if (!FLAG_DECLARATION.test(source)) fail(`cannot find the flag declaration in ${file}`);
  const next = source.replace(
    FLAG_DECLARATION,
    `export const DIAGNOSTIC_BUILD_FLAG: boolean = ${value};`,
  );
  if (next !== source) fs.writeFileSync(file, next, 'utf8');
  const now = readFlag(file);
  if (now !== value) fail(`failed to set DIAGNOSTIC_BUILD_FLAG to ${value} in ${file}`);
}

/** Fail unless both build-time keys authorise the suspension, with exact values. */
function requireAuthorisation() {
  // Literal member access on purpose: dynamic `process.env[...]` reads are
  // banned by the project's lint rules, because Metro never inlines them.
  const seen = {
    [FLAG_KEY]: process.env.EXPO_PUBLIC_SECURITY_TEST_BUILD,
    [ACK_KEY]: process.env.EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK,
  };
  for (const [key, value] of PAIRS) {
    const actual = seen[key];
    if (actual === undefined) {
      fail(
        `refusing to arm: ${key} is not set.\n` +
          '  Both keys must be present in the environment (the workflow sets them at\n' +
          '  job level; eas.json\'s security-test profile declares them too).',
      );
    }
    if (actual !== value) {
      fail(
        `refusing to arm: ${key} is "${actual}" but "${value}" is required.\n` +
          '  A conflicting value is never silently corrected.',
      );
    }
  }
  ok(`both authorisation keys present (${FLAG_KEY}=1, ${ACK_KEY}=security-test)`);
}

// ── Commands ────────────────────────────────────────────────────────────────

function commandArm({ root, mode, flagFile }) {
  console.log('Arming the temporary security suspension (compile-time constant):');
  requireAuthorisation();

  // Env files are a diagnostic channel only; validate every target first so a
  // conflict cannot leave the project half-armed.
  const plan = candidateFiles(mode).map((name) => {
    const file = path.join(root, name);
    return { name, file, ...analyzeFile(file) };
  });
  const conflicts = plan.flatMap((entry) => entry.conflicts.map((c) => `${entry.name}: ${c}`));
  if (conflicts.length > 0) {
    fail(
      'conflicting definitions found (nothing was written):\n  ' +
        conflicts.join('\n  ') +
        '\n\n  Remove those lines and re-run.',
    );
  }
  for (const entry of plan) {
    if (entry.missing.length === 0) {
      info(`${entry.name}: already carries both keys`);
      continue;
    }
    writeMissing(entry.file, entry);
    info(`${entry.name}: wrote ${entry.missing.map(([key]) => key).join(', ')}`);
  }

  writeFlag(flagFile, true);
  ok(`DIAGNOSTIC_BUILD_FLAG = true in ${path.relative(ROOT, flagFile) || flagFile}`);
  console.log('\nA normal build compiles the switch to `false` again once this file is `false`.');
}

function commandDisarm({ root, mode, flagFile }) {
  console.log('Disarming the temporary security suspension:');
  writeFlag(flagFile, false);
  ok(`DIAGNOSTIC_BUILD_FLAG = false in ${path.relative(ROOT, flagFile) || flagFile}`);

  const keyLine = new RegExp(`^\\s*(?:${FLAG_KEY}|${ACK_KEY})\\s*=`);
  for (const name of candidateFiles(mode)) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const kept = lines.filter((l) => !keyLine.test(l) && !l.includes(BLOCK_COMMENT));
    if (kept.length === lines.length) continue;
    const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    if (body.trim() === '') {
      fs.unlinkSync(file);
      info(`${name}: removed (it only held suspension keys)`);
    } else {
      fs.writeFileSync(file, body + '\n', 'utf8');
      info(`${name}: stripped the suspension lines`);
    }
  }
  console.log('\nThe repository copy of the flag file must stay `false` (the build guard enforces it).');
}

async function commandVerify({ root, mode, flagFile }) {
  console.log(`Verifying the suspension chain (root=${root}, mode=${mode}):`);

  requireAuthorisation();

  const expoEnv = require('@expo/env');
  const consulted = expoEnv.getEnvFiles({ mode, silent: true });
  const present = consulted.filter((name) => fs.existsSync(path.join(root, name)));
  console.log(`  env files consulted for this mode: ${consulted.join(' -> ')}`);
  console.log(`  present on disk: ${present.join(', ') || '(none)'}`);

  if (readFlag(flagFile) !== true) {
    fail(
      `${path.relative(ROOT, flagFile) || flagFile} is \`false\` — nothing is armed.\n` +
        '  Run `arm` first, or the APK would ship un-suspended.',
    );
  }
  ok('DIAGNOSTIC_BUILD_FLAG = true');

  // ── Compile the switch exactly as the Android release bundle does ─────────
  const babel = require('@babel/core');
  // Compiled from `root`, so the check exercises the flag module that the
  // bundler will actually use (and so the suite can verify a temp copy).
  const source = path.join(root, 'src/lib/securityTestBuild.ts');
  if (!fs.existsSync(source)) fail(`switch source not found: ${source}`);

  const caller = {
    name: 'metro',
    platform: 'android',
    bundler: 'metro',
    isDev: false, // release build
    isServer: false,
    isReactServer: false,
    isNodeModule: false,
    isHMREnabled: false,
    // CommonJS output so the compiled switch can be evaluated in-process.
    // (Metro's own caller uses `true`; the flag constant is identical either way.)
    supportsStaticESM: false,
  };
  const { code } = babel.transformFileSync(source, {
    presets: [['babel-preset-expo', {}]],
    filename: source,
    babelrc: false,
    configFile: false,
    caller,
  });
  ok('switch compiled in production mode');

  const sandboxModule = { exports: {} };
  // The only module the compiled switch may pull in is the flag module; wire it
  // to the flag file on disk so the evaluation uses the real, armed value.
  const sandboxRequire = (id) => {
    if (/diagnosticBuildFlag$/.test(id)) {
      const value = readFlag(flagFile);
      return { DIAGNOSTIC_BUILD_FLAG: value };
    }
    throw new Error(`compiled switch unexpectedly required "${id}"`);
  };
  new Function('exports', 'require', 'module', code)(
    sandboxModule.exports,
    sandboxRequire,
    sandboxModule,
  );
  const mod = sandboxModule.exports;

  if (mod.SECURITY_TEST_BUILD !== true) {
    fail(`compiled SECURITY_TEST_BUILD is ${String(mod.SECURITY_TEST_BUILD)}, expected true.`);
  }
  ok('compiled SECURITY_TEST_BUILD === true');

  const waived = Array.isArray(mod.DIAGNOSTIC_WAIVED_CHECKS) ? mod.DIAGNOSTIC_WAIVED_CHECKS : [];
  if ([...waived].sort().join(',') !== [...EXPECTED_WAIVED].sort().join(',')) {
    fail(
      `waived findings differ from the documented set.\n  expected: ${EXPECTED_WAIVED.join(', ')}\n  actual:   ${waived.join(', ')}`,
    );
  }
  ok(`exactly ${waived.length} findings are waived: ${waived.join(', ')}`);

  for (const type of EXPECTED_WAIVED) {
    if (mod.isSecurityTestBypassed({ type }) !== true) fail(`expected "${type}" to be waived`);
  }
  for (const type of STILL_BLOCKING) {
    if (mod.isSecurityTestBypassed({ type }) !== false) {
      fail(`"${type}" must still block, but the switch waives it`);
    }
  }
  ok(`unrelated findings still block: ${STILL_BLOCKING.join(', ')}`);

  // ── The decisive check: the marker must SURVIVE MINIFICATION ──────────────
  // This is precisely what failed in builds 223 / 43926766869: a `false` (or
  // undefined-tainted) constant let terser delete every marker as dead code.
  const { minify } = require('terser');
  const minified = await minify(code, { compress: true, mangle: true });
  if (!minified.code || !minified.code.includes(LOG_MARKER)) {
    fail(
      `the minified switch module no longer contains ${LOG_MARKER}.\n` +
        '  The diagnostic code is being treated as dead code — this APK would ship un-suspended.',
    );
  }
  ok(`the ${LOG_MARKER} marker survives Terser minification`);

  const bannerSource = fs.readFileSync(
    path.join(root, 'src/components/DiagnosticModeBanner.tsx'),
    'utf8',
  );
  if (!bannerSource.includes(UI_MARKER)) {
    fail(`src/components/DiagnosticModeBanner.tsx no longer contains "${UI_MARKER}"`);
  }
  if (!/if \(!SECURITY_TEST_BUILD\) return null;/.test(bannerSource)) {
    fail('the banner must remain gated on SECURITY_TEST_BUILD');
  }
  ok(`the visible "${UI_MARKER}" marker is gated on the switch`);

  console.log('\n\u2713 Suspension chain verified: flag -> switch true -> markers survive minification.\n');
}

function commandStatus({ root, mode, flagFile }) {
  console.log(`Suspension status (root=${root}, mode=${mode}):`);
  const flag = fs.existsSync(flagFile) ? readFlag(flagFile) : null;
  console.log(`  ${path.relative(ROOT, flagFile) || flagFile}: ${flag === null ? '(missing)' : flag ? 'true (ARMED)' : 'false (normal build)'}`);
  for (const name of candidateFiles(mode)) {
    const defs = readDefinitions(path.join(root, name));
    if (defs.size > 0) console.log(`  ${name}: ${[...defs.keys()].join(', ')}`);
  }
  const envArmed = process.env[FLAG_KEY] === FLAG_VALUE && process.env[ACK_KEY] === ACK_VALUE;
  console.log(`  authorisation keys in this environment: ${envArmed ? 'present' : 'absent'}`);
  if (flag === false) console.log('  -> normal build: the switch compiles to false');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === 'arm') return commandArm(opts);
  if (opts.command === 'verify') return commandVerify(opts);
  if (opts.command === 'disarm') return commandDisarm(opts);
  if (opts.command === 'status') return commandStatus(opts);
  fail(`Unknown command "${opts.command}" (expected arm | verify | disarm | status)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
