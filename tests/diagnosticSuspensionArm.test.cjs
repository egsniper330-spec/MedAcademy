#!/usr/bin/env node
/**
 * The temporary security suspension must be armed through env FILES (the only
 * channel that reliably reaches the Gradle-spawned Metro process) and must be
 * verifiable before a 30-minute Android build.
 *
 * Run: node tests/diagnosticSuspensionArm.test.cjs
 *
 * What is asserted, against `scripts/arm-diagnostic-suspension.cjs`:
 *
 *   1. `status` reports "not armed" for a clean project.
 *   2. `arm` preserves unrelated env values, writes both keys exactly once into
 *      every channel the Expo loader consults, and is idempotent.
 *   3. `arm` refuses a conflicting definition and writes NOTHING (no half-armed
 *      project).
 *   4. `verify` fails before arming, and fails when a stray shell export
 *      contradicts the required value (the loader never overwrites it).
 *   5. `verify` passes after arming and proves the real chain: env files ->
 *      Expo loader -> Babel production inlining -> SECURITY_TEST_BUILD === true,
 *      exactly eight waived findings, unrelated findings still blocking.
 *   6. The build guard rejects a checkout whose env files arm the switch, so an
 *      ordinary build can never inherit the suspension.
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
const CHANNELS = ['.env', '.env.local', '.env.production', '.env.production.local'];

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

function run(args, { cwd = ROOT, env = {}, script = SCRIPT } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'medacademy-arm-'));
}

function definitions(file, key) {
  if (!fs.existsSync(file)) return 0;
  return (fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}\\s*=`, 'gm')) || []).length;
}

console.log('\n=== Temporary security suspension: env-file arming ===\n');

// ── 1. A clean project is reported as unarmed ────────────────────────────────
console.log('── 1. clean project ──');

check('status reports "not armed" and points at the inert switch', () => {
  const dir = tempDir();
  const result = run(['status', '--root', dir]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /no suspension source found/);
  assert.match(result.stdout, /compiles the switch to false/);
});

// ── 2. Arming writes the env-file channels ───────────────────────────────────
console.log('\n── 2. arming ──');

check('arm preserves unrelated values and writes both keys once per channel', () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, '.env'),
    'EXPO_PUBLIC_APP_ID=keep-me\nEXPO_PUBLIC_PHP_API_URL=https://example.test/index.php\n',
  );
  const result = run(['arm', '--root', dir]);
  assert.strictEqual(result.status, 0, result.stderr);

  const body = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.ok(body.includes('EXPO_PUBLIC_APP_ID=keep-me'), 'existing value was lost');
  assert.ok(
    body.includes('EXPO_PUBLIC_PHP_API_URL=https://example.test/index.php'),
    'existing URL was lost',
  );
  for (const name of CHANNELS) {
    assert.strictEqual(definitions(path.join(dir, name), FLAG), 1, `${name}: ${FLAG}`);
    assert.strictEqual(definitions(path.join(dir, name), ACK), 1, `${name}: ${ACK}`);
  }
  assert.match(body, /TEMPORARY security suspension/, 'the block must be self-labelling');
});

check('arm is idempotent (no duplicate definitions, exit 0)', () => {
  const dir = tempDir();
  assert.strictEqual(run(['arm', '--root', dir]).status, 0);
  const again = run(['arm', '--root', dir]);
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stdout, /already present/);
  for (const name of CHANNELS) {
    assert.strictEqual(definitions(path.join(dir, name), FLAG), 1, `${name}: ${FLAG}`);
  }
});

// ── 3. Conflicts are refused atomically ──────────────────────────────────────
console.log('\n── 3. conflicting definitions ──');

check('arm refuses a conflicting value and writes nothing', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, '.env'), `${FLAG}=0\n`);
  const result = run(['arm', '--root', dir]);
  assert.strictEqual(result.status, 1, 'a conflicting definition must fail the arming');
  assert.match(result.stderr, /conflicting definitions found \(nothing was written\)/);
  const stray = CHANNELS.filter((name) => fs.existsSync(path.join(dir, name)));
  assert.deepStrictEqual(stray, ['.env'], 'no channel may be created on a conflict');
});

// ── 4. Verification fails without the keys ───────────────────────────────────
console.log('\n── 4. verification before arming ──');

check('verify fails on an unarmed project and names the missing key', () => {
  const dir = tempDir();
  const result = run(['verify', '--root', dir]);
  assert.strictEqual(result.status, 1, 'an unarmed project must not verify');
  assert.match(result.stderr, new RegExp(`${FLAG} is not defined`));
  assert.match(result.stderr, /would compile to `false`/);
});

check('verify refuses a stray shell export instead of silently ignoring it', () => {
  const dir = tempDir();
  assert.strictEqual(run(['arm', '--root', dir]).status, 0);
  const result = run(['verify', '--root', dir], { env: { [FLAG]: '0' } });
  assert.strictEqual(result.status, 1, 'a contradicting system env value must fail');
  assert.match(result.stderr, /is "0" but "1" is required/);
});

// ── 5. The real chain verifies ───────────────────────────────────────────────
console.log('\n── 5. verification after arming ──');

check('verify proves env -> Babel -> true switch and the waiver set', () => {
  const dir = tempDir();
  assert.strictEqual(run(['arm', '--root', dir]).status, 0);
  const result = run(['verify', '--root', dir]);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /env files consulted for this mode: \.env\.production\.local -> \.env\.local -> \.env\.production -> \.env/);
  assert.match(result.stdout, /compiled in production mode/);
  assert.match(result.stdout, /compiled SECURITY_TEST_BUILD === true/);
  assert.match(result.stdout, /exactly 8 findings are waived/);
  assert.match(result.stdout, /unrelated findings still block: vpn_detected, screen_recording, signature_invalid/);
  assert.match(result.stdout, /one-shot \[DIAG-BUILD\] marker is emitted/);
});

// ── 6. Ordinary builds cannot inherit the suspension ─────────────────────────
console.log('\n── 6. build guard ──');

check('guard rejects a checkout whose env files arm the switch', () => {
  const dir = tempDir();
  assert.strictEqual(run(['arm', '--root', dir]).status, 0);
  const result = run([], { env: { MEDACADEMY_GUARD_ENV_ROOT: dir }, script: GUARD });
  assert.strictEqual(result.status, 1, 'the guard must fail on an armed checkout');
  assert.match(result.stderr, /declares the suspension keys/);
});

check('guard passes when no env file arms the switch', () => {
  const dir = tempDir();
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
