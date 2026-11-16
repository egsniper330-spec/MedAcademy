#!/usr/bin/env node
/**
 * Diagnostic (security-test) build — regression suite.
 *
 * Run: node tests/diagnosticSecurityBuild.test.cjs
 *
 * WHAT THIS LOCKS DOWN
 * ────────────────────
 * The diagnostic switch exists so a throwaway APK can reach the dashboard on a
 * tablet with Developer Options / USB debugging / Magisk / Xposed enabled, in
 * order to reproduce a crash with Logcat attached. The risk it carries is
 * obvious, so every property that keeps it out of production is asserted here:
 *
 *   1. EXECUTED BEHAVIOUR — the switch expression lifted out of
 *      src/lib/securityTestBuild.ts is actually evaluated against environments:
 *      it must require BOTH build-time keys, strict values, and nothing else.
 *   2. COMPILE-TIME ONLY — literal `process.env.X` access (Metro inlines only
 *      those), no storage / remote / route-param / Constants input.
 *   3. SCOPE — exactly the local device-environment findings are waived; the
 *      never-waive list (auth, VPN, overlay, recording, integrity, DRM) is not.
 *   4. WIRING — the filter runs on the produced findings BEFORE the risk score
 *      and therefore before `blocksLogin`; detectors themselves are untouched.
 *   5. BUILD HELD APART — eas.json: both keys in the internal `security-test`
 *      profile only, never in production, never submitted.
 *   6. GUARD SCRIPT — `scripts/check-diagnostic-build-guards.cjs` passes as
 *      shipped, and FAILS for a flag-only environment and for a wrong profile.
 *   7. VISIBLE MARKER — the banner exists, is gated on the constant, and is
 *      mounted at the app root.
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    failures.push({ label, message: e.message });
    console.log(`  ✗ ${label}\n      ${e.message.split('\n')[0]}`);
  }
}

const SWITCH_FILE = 'src/lib/securityTestBuild.ts';
const FLAG = 'EXPO_PUBLIC_SECURITY_TEST_BUILD';
const ACK = 'EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK';
const ACK_VALUE = 'security-test';

const switchSrc = read(SWITCH_FILE);

/** Implementation only — the module's own docs name the forbidden APIs. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const switchCode = stripComments(switchSrc);

// ── 1. Executed behaviour of the shipped expression ──────────────────────────
console.log('\n── 1. Executed switch behaviour (both keys required) ──');

function switchExpression() {
  const m = switchSrc.match(/export const SECURITY_TEST_BUILD: boolean =\s*([\s\S]*?);\s*\n/);
  assert.ok(m, 'SECURITY_TEST_BUILD assignment not found');
  return m[1];
}

/** Evaluate the ACTUAL shipped expression against a fake process.env. */
function evalSwitch(env) {
  // eslint-disable-next-line no-new-func
  return new Function('process', `return (${switchExpression()});`)({ env });
}

check('both keys present and correct → enabled', () => {
  assert.strictEqual(evalSwitch({ [FLAG]: '1', [ACK]: ACK_VALUE }), true);
});

check('flag alone → NOT enabled', () => {
  assert.strictEqual(evalSwitch({ [FLAG]: '1' }), false);
});

check('acknowledgement alone → NOT enabled', () => {
  assert.strictEqual(evalSwitch({ [ACK]: ACK_VALUE }), false);
});

check('empty environment → NOT enabled', () => {
  assert.strictEqual(evalSwitch({}), false);
});

check('wrong acknowledgement value → NOT enabled', () => {
  assert.strictEqual(evalSwitch({ [FLAG]: '1', [ACK]: 'production' }), false);
});

check('non-strict flag value ("true") → NOT enabled', () => {
  assert.strictEqual(evalSwitch({ [FLAG]: 'true', [ACK]: ACK_VALUE }), false);
});

// ── 2. Compile-time only ────────────────────────────────────────────────────
console.log('\n── 2. Build-time only, no runtime input ──');

check('flag compared with a literal member access and strict "1"', () => {
  assert.ok(switchCode.includes(`process.env.${FLAG} === '1'`),
    'must compare process.env.' + FLAG + ' === \'1\' (Metro inlines only static access)');
});

check('acknowledgement compared with a literal member access', () => {
  assert.ok(switchCode.includes(`process.env.${ACK} === '${ACK_VALUE}'`));
});

check('no dynamic process.env[...] access', () => {
  assert.ok(!/process\.env\[/.test(switchCode), 'dynamic env access is not inlined by Metro');
});

check('no storage / remote / Constants / route-param input', () => {
  for (const forbidden of ['AsyncStorage', 'SecureStore', 'expo-constants', 'Constants.', 'fetch(', 'route.params', 'useLocalSearchParams', 'useGlobalSearchParams']) {
    assert.ok(!switchCode.includes(forbidden), `switch must not read ${forbidden}`);
  }
});

check('no runtime setter is exported', () => {
  assert.ok(!/export (let|var) SECURITY_TEST_BUILD/.test(switchSrc), 'the constant must not be mutable');
  assert.ok(!/export function set[A-Z]/.test(switchSrc), 'there must be no runtime toggle');
});

// ── 3. Scope of the waiver ──────────────────────────────────────────────────
console.log('\n── 3. Waived scope ──');

const waived = (() => {
  const m = switchSrc.match(/DIAGNOSTIC_WAIVED_CHECKS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'DIAGNOSTIC_WAIVED_CHECKS list not found');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
})();

check('waives exactly the four required local checks (plus their siblings)', () => {
  for (const required of ['adb_enabled', 'xposed_detected', 'magisk_detected', 'developer_options_enabled']) {
    assert.ok(waived.includes(required), `${required} must be waived in the diagnostic build`);
  }
});

check('everything waived is a LOCAL DEVICE-environment finding', () => {
  const allowed = new Set([
    'developer_options_enabled', 'adb_enabled', 'debugger_attached', 'debug_detected',
    'root_detected', 'magisk_detected', 'xposed_detected', 'frida_detected',
  ]);
  for (const w of waived) assert.ok(allowed.has(w), `unexpected waived type: ${w}`);
  assert.strictEqual(waived.length, allowed.size, 'waived list length must match the audited set');
});

check('never waives auth / VPN / overlay / recording / integrity / DRM findings', () => {
  for (const forbidden of [
    'vpn_detected', 'proxy_detected', 'overlay_detected', 'screen_recording',
    'screen_being_recorded', 'signature_invalid', 'tampered', 'integrity_failure',
    'ssl_pinning_failure', 'multi_window', 'mock_location', 'jailbreak_detected',
    'play_integrity_failed', 'vdo_drm', 'watermark',
  ]) {
    assert.ok(!waived.includes(forbidden), `${forbidden} must NEVER be waived`);
  }
});

check('isSecurityTestBypassed is gated on the constant (no-op in production)', () => {
  assert.ok(/return SECURITY_TEST_BUILD && /.test(switchSrc),
    'the bypass helper must short-circuit on SECURITY_TEST_BUILD');
});

// ── 4. Wiring into the verdict ──────────────────────────────────────────────
console.log('\n── 4. Verdict wiring (filter before risk score) ──');

const securitySrc = read('src/lib/security.ts');

check('security.ts imports the shared bypass helper', () => {
  assert.ok(securitySrc.includes("from '@/lib/securityTestBuild'"));
  assert.ok(securitySrc.includes('isSecurityTestBypassed'));
});

check('the filter is applied exactly once', () => {
  const count = (securitySrc.match(/\.filter\(\(t\) => !isSecurityTestBypassed\(t\)\)/g) || []).length;
  assert.strictEqual(count, 1, `expected exactly one diagnostic filter, found ${count}`);
});

check('the filter runs BEFORE computeRiskScore / blocksLogin derivation', () => {
  const filterAt = securitySrc.indexOf('!isSecurityTestBypassed(t)');
  const scoreAt = securitySrc.indexOf('const riskScore = computeRiskScore(allThreats)');
  assert.ok(filterAt > 0 && scoreAt > 0, 'filter or risk-score line not found');
  assert.ok(filterAt < scoreAt, 'the diagnostic filter must run before the risk score is computed');
});

check('detectors are not removed — every finding is still produced', () => {
  const m = securitySrc.match(/const allThreats: SecurityThreat\[\] = \[([\s\S]*?)\]/);
  assert.ok(m, 'allThreats construction not found');
  for (const detector of ['rootThreat', 'vpnThreat', 'proxyThreat', 'debugThreat', 'devOptsThreat',
    'screenRecThreat', 'integrityThreat', 'fridaThreat', 'xposedThreat', 'magiskThreat',
    'overlayThreat', 'tamperThreat', 'piThreat', 'sslThreat']) {
    assert.ok(m[1].includes(detector), `${detector} must still be collected`);
  }
});

// ── 5. eas.json separation ──────────────────────────────────────────────────
console.log('\n── 5. eas.json: internal diagnostic profile only ──');

const eas = JSON.parse(read('eas.json'));

check('security-test declares both keys with the exact values', () => {
  const profile = eas.build['security-test'];
  assert.ok(profile, 'security-test profile missing');
  assert.strictEqual(profile.env[FLAG], '1');
  assert.strictEqual(profile.env[ACK], ACK_VALUE);
});

check('security-test stays an internal distribution build', () => {
  assert.strictEqual(eas.build['security-test'].distribution, 'internal');
});

check('no other profile declares either diagnostic key', () => {
  for (const [name, profile] of Object.entries(eas.build)) {
    if (name === 'security-test') continue;
    const env = profile.env ?? {};
    assert.ok(!(FLAG in env), `${name} must not set ${FLAG}`);
    assert.ok(!(ACK in env), `${name} must not set ${ACK}`);
  }
});

check('production profile and submit entry are clean', () => {
  assert.ok(!(FLAG in (eas.build.production.env ?? {})));
  assert.ok(!(ACK in (eas.build.production.env ?? {})));
  assert.ok(!JSON.stringify(eas.submit ?? {}).includes('security-test'));
});

// ── 6. Guard script, executed for real ──────────────────────────────────────
console.log('\n── 6. Build guard script (positive + negative) ──');

const GUARD = path.join(ROOT, 'scripts', 'check-diagnostic-build-guards.cjs');

function runGuard(extraEnv) {
  const env = { ...process.env };
  delete env[FLAG];
  delete env[ACK];
  delete env.EAS_BUILD_PROFILE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [GUARD], { encoding: 'utf8', env });
}

check('passes with a clean environment', () => {
  const r = runGuard({});
  assert.strictEqual(r.status, 0, `guard failed unexpectedly:\n${r.stdout}\n${r.stderr}`);
});

check('passes for an explicit security-test diagnostic build', () => {
  const r = runGuard({ [FLAG]: '1', [ACK]: ACK_VALUE, EAS_BUILD_PROFILE: 'security-test' });
  assert.strictEqual(r.status, 0, `guard should allow the diagnostic profile:\n${r.stdout}\n${r.stderr}`);
});

check('FAILS for a flag-only environment (stray variable)', () => {
  const r = runGuard({ [FLAG]: '1' });
  assert.notStrictEqual(r.status, 0, 'a lone EXPO_PUBLIC_SECURITY_TEST_BUILD must be rejected');
  assert.ok(/ACK|stray/i.test(r.stderr + r.stdout));
});

check('FAILS when the keys are set while building production', () => {
  const r = runGuard({ [FLAG]: '1', [ACK]: ACK_VALUE, EAS_BUILD_PROFILE: 'production' });
  assert.notStrictEqual(r.status, 0, 'production must never be allowed to carry the keys');
});

check('FAILS when the keys are set with no profile at all', () => {
  const r = runGuard({ [FLAG]: '1', [ACK]: ACK_VALUE });
  assert.notStrictEqual(r.status, 0, 'an ambiguous local build must be rejected');
});

// ── 7. Visible marker ───────────────────────────────────────────────────────
console.log('\n── 7. Visible diagnostic indicator ──');

const bannerSrc = read('src/components/DiagnosticModeBanner.tsx');

check('banner is gated on the build-time constant', () => {
  assert.ok(bannerSrc.includes("from '@/lib/securityTestBuild'"));
  assert.ok(/if \(!SECURITY_TEST_BUILD\) return null;/.test(bannerSrc),
    'the banner must render null when the switch is off');
});

check('banner is labelled unmistakably', () => {
  assert.ok(/DIAGNOSTIC BUILD/i.test(bannerSrc));
  assert.ok(/NOT FOR PRODUCTION/i.test(bannerSrc.replace(/\s+/g, ' ')) || /not for production/i.test(bannerSrc));
});

check('banner is mounted at the app root, above the navigator', () => {
  const rootLayout = read('src/app/_layout.tsx');
  const bannerAt = rootLayout.indexOf('<DiagnosticModeBanner />');
  const navAt = rootLayout.indexOf('<RootLayoutNav />');
  assert.ok(bannerAt > 0, '<DiagnosticModeBanner /> is not mounted in src/app/_layout.tsx');
  assert.ok(navAt > 0 && bannerAt < navAt, 'the banner must render above the navigator');
});

check('banner reads no runtime/remote input', () => {
  const bannerCode = stripComments(bannerSrc);
  for (const forbidden of ['AsyncStorage', 'SecureStore', 'fetch(', 'route.params', 'expo-constants']) {
    assert.ok(!bannerCode.includes(forbidden), `banner must not read ${forbidden}`);
  }
});

check('operator documentation exists', () => {
  const doc = read('docs/DIAGNOSTIC_SECURITY_BUILD.md');
  assert.ok(doc.includes(FLAG) && doc.includes(ACK), 'docs must name both build-time keys');
  assert.ok(/never/i.test(doc), 'docs must state the never-production rule');
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`RESULT: ${passed} passed, 0 failed`);
  console.log('Diagnostic build suite: OK');
  process.exit(0);
}
console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  • ${f.label}: ${f.message}`);
console.log('FAILURES PRESENT');
process.exit(1);
