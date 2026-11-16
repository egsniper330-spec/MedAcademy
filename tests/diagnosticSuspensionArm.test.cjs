#!/usr/bin/env node
/**
 * The temporary security suspension must be armed by a value the BUNDLER CANNOT
 * MISREAD, and that fact must be provable before a 30-minute Android build.
 *
 * Run: node tests/diagnosticSuspensionArm.test.cjs
 *
 * WHY THIS SUITE LOOKS THE WAY IT DOES
 * ────────────────────────────────────
 * Android builds 223 and 43926766869 both produced a signed APK whose bundle
 * contained no diagnostic marker, even though the pre-build gate compiled the
 * switch to `true` in the same job. The switch therefore no longer depends on
 * `process.env.EXPO_PUBLIC_*` (which a Metro WORKER inlines at transform time,
 * and which that worker once saw as `undefined`); it is a source constant in
 * `src/lib/diagnosticBuildFlag.ts`, armed by the script under test.
 *
 * What is asserted, against `scripts/arm-diagnostic-suspension.cjs`:
 *
 *   1. `arm` refuses to run without BOTH authorisation keys (two-key policy),
 *      and writes nothing when it refuses.
 *   2. `arm` flips the flag module to `true`, preserves unrelated env values,
 *      and is idempotent.
 *   3. A conflicting env definition stops `arm` before anything is written.
 *   4. `verify` fails on an unarmed project, and passes on an armed one — with
 *      the decisive proof that the `[DIAG-BUILD]` marker SURVIVES Terser
 *      minification (exactly what the failing CI bundles lost).
 *   5. `disarm` restores `false`, removes the suspension lines it added, and
 *      leaves unrelated env content intact.
 *   6. The build guard rejects a checkout whose env files arm the switch, so an
 *      ordinary build cannot inherit the suspension.
 */

'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'arm-diagnostic-suspension.cjs');
const GUARD = path.join(ROOT, 'scripts', 'check-diagnostic-build-guards.cjs');

const FLAG = 'EXPO_PUBLIC_SECURITY_TEST_BUILD';
const ACK = 'EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK';
const KEYS = { [FLAG]: '1', [ACK]: 'security-test' };
const CHANNELS = ['.env', '.env.local', '.env.production', '.env.production.local'];
const FLAG_REL = path.join('src', 'lib', 'diagnosticBuildFlag.ts');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${String(error.message).split('\n').join('\n      ')}`);
  }
}

/** A throwaway project with the real switch/flag/banner sources. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medacademy-arm-'));
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });
  for (const rel of [FLAG_REL, path.join('src', 'lib', 'securityTestBuild.ts')]) {
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  fs.copyFileSync(
    path.join(ROOT, 'src', 'components', 'DiagnosticModeBanner.tsx'),
    path.join(dir, 'src', 'components', 'DiagnosticModeBanner.tsx'),
  );
  fs.writeFileSync(path.join(dir, '.env'), 'EXPO_PUBLIC_APP_ID=keep-me\n');
  return dir;
}

function run(args, { env = {}, script = SCRIPT } = {}) {
  const base = { ...process.env };
  delete base[FLAG];
  delete base[ACK];
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...base, ...env },
  });
}

function flagValue(dir) {
  const src = fs.readFileSync(path.join(dir, FLAG_REL), 'utf8');
  const m = /export const DIAGNOSTIC_BUILD_FLAG: boolean = (true|false);/.exec(src);
  assert.ok(m, 'flag declaration not found');
  return m[1];
}

function definitions(file, key) {
  return (fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}\\s*=`, 'gm')) || []).length;
}

console.log('\n=== Temporary security suspension: arming ===\n');

// ── 1. The two-key authorisation ─────────────────────────────────────────────
console.log('── 1. authorisation ──');

check('arm refuses without the keys and writes nothing', () => {
  const dir = makeProject();
  const result = run(['arm', '--root', dir]);
  assert.strictEqual(result.status, 1, 'arm must require both keys');
  assert.match(result.stderr, /refusing to arm/);
  assert.strictEqual(flagValue(dir), 'false', 'the flag must stay false');
  assert.deepStrictEqual(
    CHANNELS.filter((name) => fs.existsSync(path.join(dir, name))),
    ['.env'],
    'no env channel may be created when authorisation is missing',
  );
});

check('arm refuses a wrong acknowledgement value', () => {
  const dir = makeProject();
  const result = run(['arm', '--root', dir], { env: { [FLAG]: '1', [ACK]: 'production' } });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /"production" but "security-test" is required/);
  assert.strictEqual(flagValue(dir), 'false');
});

// ── 2. Arming flips the constant ─────────────────────────────────────────────
console.log('\n── 2. arming ──');

check('arm sets the flag true, preserves env values and is idempotent', () => {
  const dir = makeProject();
  const first = run(['arm', '--root', dir], { env: KEYS });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(flagValue(dir), 'true');

  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.ok(env.includes('EXPO_PUBLIC_APP_ID=keep-me'), 'unrelated value was lost');
  assert.ok(env.includes('TEMPORARY security suspension'), 'the block must be self-labelling');

  const second = run(['arm', '--root', dir], { env: KEYS });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(second.stdout, /already carries both keys/);
  for (const name of CHANNELS) {
    assert.strictEqual(definitions(path.join(dir, name), FLAG), 1, `${name}: one definition`);
  }
});

check('a conflicting env definition stops arm before anything is written', () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, '.env'), `${FLAG}=0\n`);
  const result = run(['arm', '--root', dir], { env: KEYS });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /conflicting definitions found \(nothing was written\)/);
  assert.strictEqual(flagValue(dir), 'false', 'the flag must not be touched');
  assert.deepStrictEqual(
    CHANNELS.filter((name) => fs.existsSync(path.join(dir, name))),
    ['.env'],
  );
});

// ── 3. Verification ──────────────────────────────────────────────────────────
console.log('\n── 3. verification ──');

check('verify fails on an unarmed project', () => {
  const dir = makeProject();
  const result = run(['verify', '--root', dir], { env: KEYS });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /nothing is armed/);
});

check('verify fails without the authorisation keys', () => {
  const dir = makeProject();
  assert.strictEqual(run(['arm', '--root', dir], { env: KEYS }).status, 0);
  const result = run(['verify', '--root', dir]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /refusing to arm/);
});

check('verify proves flag -> true switch -> markers survive minification', () => {
  const dir = makeProject();
  assert.strictEqual(run(['arm', '--root', dir], { env: KEYS }).status, 0);
  const result = run(['verify', '--root', dir], { env: KEYS });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /DIAGNOSTIC_BUILD_FLAG = true/);
  assert.match(result.stdout, /compiled SECURITY_TEST_BUILD === true/);
  assert.match(result.stdout, /exactly 8 findings are waived/);
  assert.match(
    result.stdout,
    /unrelated findings still block: vpn_detected, screen_recording, signature_invalid/,
  );
  assert.match(result.stdout, /\[DIAG-BUILD\] marker survives Terser minification/);
  assert.match(result.stdout, /"DIAGNOSTIC BUILD" marker is gated on the switch/);
});

// ── 4. Disarming restores enforcement ────────────────────────────────────────
console.log('\n── 4. disarm ──');

check('disarm resets the flag, strips only its own lines, and verify then fails', () => {
  const dir = makeProject();
  assert.strictEqual(run(['arm', '--root', dir], { env: KEYS }).status, 0);
  const result = run(['disarm', '--root', dir], { env: KEYS });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(flagValue(dir), 'false');

  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.strictEqual(env.trim(), 'EXPO_PUBLIC_APP_ID=keep-me', 'unrelated content must survive');
  for (const name of ['.env.local', '.env.production', '.env.production.local']) {
    assert.ok(!fs.existsSync(path.join(dir, name)), `${name} must be cleaned up`);
  }
  assert.strictEqual(run(['verify', '--root', dir], { env: KEYS }).status, 1);
});

// ── 5. Ordinary builds cannot inherit the suspension ─────────────────────────
console.log('\n── 5. build guard ──');

check('guard rejects a checkout whose env files arm the switch', () => {
  const dir = makeProject();
  assert.strictEqual(run(['arm', '--root', dir], { env: KEYS }).status, 0);
  const result = run([], { env: { MEDACADEMY_GUARD_ENV_ROOT: dir }, script: GUARD });
  assert.strictEqual(result.status, 1, 'the guard must fail on an armed checkout');
  assert.match(result.stderr, /declares the suspension keys/);
});

check('guard passes when no env file arms the switch', () => {
  const dir = makeProject();
  const result = run([], { env: { MEDACADEMY_GUARD_ENV_ROOT: dir }, script: GUARD });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(62));
console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFAILURES PRESENT');
  for (const { name } of failures) console.log(`  • ${name}`);
  console.log('='.repeat(62));
  process.exit(1);
}
console.log('Diagnostic suspension arming suite: OK');
console.log('='.repeat(62));
