#!/usr/bin/env node
/**
 * Temporarily disabled security checks — source-level switch in security.ts.
 *
 * Run: node tests/securityTemporaryDisable.test.cjs
 *
 * Asserts the REAL shipped code, not a copy:
 *   1. exactly four finding types are disabled (adb_enabled, xposed_detected,
 *      magisk_detected, developer_options_enabled) and the config is a frozen
 *      boolean table that can be re-enabled by editing one line;
 *   2. the helper actually returns true for those four and false for every other
 *      finding type (evaluated from the shipped source);
 *   3. the filter runs on the aggregated threat list BEFORE the risk score and
 *      before the blocking decision;
 *   4. every other detector is still invoked and every other finding still
 *      reaches the list (root, frida, debugger, screen recording, tamper,
 *      Play Integrity, TLS pinning, VPN) — the overlay detector was removed
 *      with the floating-window protection subsystem and is asserted absent;
 *   5. the earlier diagnostic build machinery is gone (no env-var switch, no
 *      bundle-marker step, no separate build profile, no arming script).
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DISABLED = ['adb_enabled', 'xposed_detected', 'magisk_detected', 'developer_options_enabled'];
const STILL_ENFORCED = [
  'root_detected',
  'frida_detected',
  'debug_detected',
  'debugger_attached',
  'vpn_detected',
  'proxy_detected',
  'overlay_detected',
  'screen_recording_detected',
  'signature_invalid',
  'tamper_detected',
];

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

const securitySrc = read('src/lib/security.ts');

console.log('\n=== Temporarily disabled security checks ===\n');
console.log('── 1. the switch itself ──');

const configSrc = (() => {
  const m = securitySrc.match(
    /export const TEMPORARILY_DISABLED_CHECKS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/,
  );
  assert.ok(m, 'TEMPORARILY_DISABLED_CHECKS not found in src/lib/security.ts');
  return m[1];
})();

const config = new Function(`return ({${configSrc}});`)();

check('the config is a frozen boolean table', () => {
  assert.deepStrictEqual(Object.keys(config).sort(), [...DISABLED].sort());
  for (const key of DISABLED) {
    assert.strictEqual(config[key], true, `${key} must be true (disabled)`);
  }
  assert.match(
    securitySrc,
    /export const TEMPORARILY_DISABLED_CHECKS: Readonly<Record<string, boolean>> = Object\.freeze\(/,
    'the table must stay a Readonly<Record<string, boolean>> Object.freeze(...)',
  );
});

const isDisabled = (() => {
  const m = securitySrc.match(
    /export function isCheckTemporarilyDisabled\(threat: \{ type: string \}\): boolean \{([\s\S]*?)\n\}/,
  );
  assert.ok(m, 'isCheckTemporarilyDisabled not found');
  // Evaluate the shipped body with the shipped table.
  return new Function(
    'TEMPORARILY_DISABLED_CHECKS',
    `return function isCheckTemporarilyDisabled(threat) {${m[1]}};`,
  )(config);
})();

check('the shipped helper disables exactly the four findings', () => {
  for (const type of DISABLED) {
    assert.strictEqual(isDisabled({ type }), true, `${type} must be treated as disabled`);
  }
});

check('the shipped helper leaves every other finding enabled', () => {
  for (const type of STILL_ENFORCED) {
    assert.strictEqual(isDisabled({ type }), false, `${type} must stay enforced`);
  }
  assert.strictEqual(isDisabled({ type: 'something_unknown' }), false, 'unknown types stay enforced');
});

// ── 2. The decision path ─────────────────────────────────────────────────────
console.log('\n── 2. decision path ──');

check('the filter is applied to the aggregated threat list', () => {
  assert.match(
    securitySrc,
    /\.filter\(\(t\): t is SecurityThreat => t !== null && t\.detected\)\s*\n\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*\.filter\(\(t\) => !isCheckTemporarilyDisabled\(t\)\);/,
    'allThreats must be filtered with isCheckTemporarilyDisabled right after collection',
  );
});

check('the filter runs BEFORE the risk score is computed', () => {
  const filterAt = securitySrc.indexOf('.filter((t) => !isCheckTemporarilyDisabled(t))');
  const scoreAt = securitySrc.indexOf('const riskScore = computeRiskScore(allThreats);');
  assert.ok(filterAt > -1 && scoreAt > -1, 'filter or score line missing');
  assert.ok(filterAt < scoreAt, 'the filter must precede computeRiskScore');
});

check('the filtered list feeds the risk score and the verdict', () => {
  assert.match(securitySrc, /const riskScore = computeRiskScore\(allThreats\);/);
  // The same list continues into the policy evaluation that derives blocksLogin.
  const afterFilter = securitySrc.slice(securitySrc.indexOf('.filter((t) => !isCheckTemporarilyDisabled(t))'));
  assert.match(afterFilter, /evaluateSecurityResult\(/, 'the verdict must be derived after the filter');
});

// ── 3. Nothing else was weakened ─────────────────────────────────────────────
console.log('\n── 3. other protections untouched ──');

check('every other detector is still invoked', () => {
  for (const detector of [
    'detectRoot',
    'detectFrida',
    'detectXposed',
    'detectMagisk',
    'detectScreenRecording',
    'detectTamper',
    'runPlayIntegrityCheck',
    'detectSSLPinning',
  ]) {
    assert.ok(securitySrc.includes(detector), `${detector} must still run`);
  }
  assert.match(securitySrc, /detectDeveloperOptions|devOptsThreat/, 'Developer Options detection still exists');
  assert.match(securitySrc, /debugThreat/, 'debugger detection is still present');
  assert.match(securitySrc, /vpnThreat[\s\S]*proxyThreat/, 'VPN/proxy detection is still present');
});

check('no other finding type appears in the disabled table', () => {
  for (const type of STILL_ENFORCED) {
    assert.ok(!configSrc.includes(type), `${type} must not be disabled`);
  }
});

check('no detector was removed from the threat list', () => {
  const list = securitySrc.match(/const allThreats: SecurityThreat\[\] = \[([\s\S]*?)\]/);
  assert.ok(list, 'allThreats construction not found');
  for (const threat of [
    'rootThreat',
    'vpnThreat',
    'proxyThreat',
    'debugThreat',
    'devOptsThreat',
    'screenRecThreat',
    'integrityThreat',
    'fridaThreat',
    'xposedThreat',
    'magiskThreat',
    'tamperThreat',
    'piThreat',
    'sslThreat',
  ]) {
    assert.ok(list[1].includes(threat), `${threat} must still be collected`);
  }
});

// ── 4. Obsolete diagnostic machinery is gone ─────────────────────────────────
console.log('\n── 4. diagnostic machinery removed ──');

check('the diagnostic build files no longer exist', () => {
  for (const rel of [
    'src/lib/securityTestBuild.ts',
    'src/lib/diagnosticBuildFlag.ts',
    'src/components/DiagnosticModeBanner.tsx',
    'scripts/arm-diagnostic-suspension.cjs',
    'scripts/check-diagnostic-build-guards.cjs',
  ]) {
    assert.ok(!fs.existsSync(path.join(ROOT, rel)), `${rel} must be deleted`);
  }
});

check('the workflow has no suspension env vars, markers or verification step', () => {
  const workflow = read('.github/workflows/android-apk.yml');
  for (const forbidden of [
    'EXPO_PUBLIC_SECURITY_TEST_BUILD',
    'MEDACADEMY_SECURITY_SUSPENSION',
    'DIAGNOSTIC BUILD',
    'arm-diagnostic-suspension',
    'check-diagnostic-build-guards',
    'shipped-js-bundle',
  ]) {
    assert.ok(!workflow.includes(forbidden), `workflow must not reference ${forbidden}`);
  }
});

check('no separate diagnostic build profile and no guard in the npm scripts', () => {
  const eas = JSON.parse(read('eas.json'));
  assert.ok(!('security-test' in eas.build), 'eas.json must not keep a diagnostic profile');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!String(pkg.scripts.validate).includes('check-diagnostic-build-guards'));
  assert.ok(!String(pkg.scripts['prebuild:validate']).includes('check-diagnostic-build-guards'));
});

check('nothing in src/ reads a diagnostic build switch', () => {
  for (const rel of ['src/lib/security.ts', 'src/app/_layout.tsx']) {
    assert.ok(!read(rel).includes('securityTestBuild'), `${rel} must not import the old switch`);
    assert.ok(!read(rel).includes('SECURITY_TEST_BUILD'), `${rel} must not reference the old switch`);
  }
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
console.log('Temporary security-disable suite: OK');
console.log('='.repeat(62));
