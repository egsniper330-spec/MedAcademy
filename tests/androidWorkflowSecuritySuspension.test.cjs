#!/usr/bin/env node
/**
 * Temporary security suspension in the GitHub Actions APK workflow.
 *
 * Run: node tests/androidWorkflowSecuritySuspension.test.cjs
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * The blocking local device-environment checks were temporarily suspended so a
 * crash can be reproduced on a tablet with ADB attached. That suspension is
 * armed ONLY by build-time variables in `.github/workflows/android-apk.yml`, and
 * the APK must keep being produced by that same, unchanged workflow (same
 * signing identity, same package id).
 *
 * What is asserted:
 *
 *   1. THE WORKFLOW IS STILL THE WORKFLOW — manual dispatch only, Expo prebuild
 *      + `:app:assembleRelease`, same artifact name, the production signing
 *      secrets and the apksigner identity check untouched.
 *   2. THE SUSPENSION IS ARMED AT JOB LEVEL — both switch keys plus the workflow
 *      acknowledgement marker, so the Gradle bundling step inherits them.
 *   3. CI PROVES IT REACHED THE BUNDLE — the workflow inspects the APK's own
 *      `assets/index.android.bundle` for the diagnostic marker and fails the
 *      build if it is missing (env / Metro / Babel drift cannot slip through).
 *   4. IT IS IDENTIFIABLE — `versionCode` bumped to 223, package unchanged.
 *   5. RESTORATION WORKS — the shipped switch expression, evaluated with the
 *      workflow's env minus the three keys, is `false`; the guard script
 *      rejects stray/ambiguous enables and production.
 *   6. THE CHECKLIST EXISTS — docs/TEMP_SECURITY_SUSPENSION.md documents every
 *      change and every reversion step.
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WORKFLOW_PATH = '.github/workflows/android-apk.yml';
const workflowSrc = read(WORKFLOW_PATH);
const workflow = YAML.parse(workflowSrc);

const FLAG = 'EXPO_PUBLIC_SECURITY_TEST_BUILD';
const ACK = 'EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK';
const ACK_VALUE = 'security-test';
const MARKER = 'MEDACADEMY_SECURITY_SUSPENSION';
const MARKER_VALUE = 'workflow';

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

// `on:` may parse as the string 'on' (YAML 1.2) or boolean true (YAML 1.1).
const triggers = workflow.on ?? workflow[true] ?? {};
const job = workflow.jobs?.['android-apk'];
const steps = job?.steps ?? [];
const stepNames = steps.map((s) => s.name);
const stepBy = (name) => steps.find((s) => s.name === name) ?? {};
const scriptOf = (step) => String(step.run ?? '');

// ── 1. Same workflow, same signing, same artifact ───────────────────────────
console.log('\n── 1. The existing production workflow is still the producer ──');

check('workflow name and manual-only trigger unchanged', () => {
  assert.strictEqual(workflow.name, 'Android APK Build');
  assert.ok(triggers.workflow_dispatch, 'workflow_dispatch trigger missing');
  for (const auto of ['push', 'pull_request', 'schedule', 'workflow_call']) {
    assert.ok(!triggers[auto], `${auto} must not trigger this workflow`);
  }
});

check('still builds a signed release APK with Gradle', () => {
  assert.strictEqual(job['runs-on'], 'ubuntu-24.04');
  const prebuild = steps.find((s) => scriptOf(s).includes('npx expo prebuild --platform android'));
  assert.ok(prebuild, 'expo prebuild step missing');
  const build = steps.find((s) => scriptOf(s).includes(':app:assembleRelease'));
  assert.ok(build, 'assembleRelease step missing');
});

check('signing configuration and identity verification untouched', () => {
  for (const secret of ['ANDROID_KEYSTORE_BASE64', 'MEDA_UPLOAD_STORE_PASSWORD', 'MEDA_UPLOAD_KEY_PASSWORD']) {
    assert.ok(workflowSrc.includes(secret), `${secret} reference removed`);
  }
  assert.ok(stepNames.includes('Restore production keystore and derive cert fingerprint'));
  assert.ok(stepNames.includes('Verify APK signature, identity and checksum'));
  const verify = scriptOf(stepBy('Verify APK signature, identity and checksum'));
  // The workflow invokes it as `"$BT/apksigner" verify --print-certs`.
  assert.ok(/apksigner"?\s+verify/.test(verify), 'APK signature verification removed');
  assert.ok(verify.includes('com.medacademy.app'), 'package identity check removed');
});

check('artifact name (the one I download) unchanged', () => {
  const upload = stepBy('Upload APK artifact');
  assert.strictEqual(upload.with?.name, 'MedAcademy-Android-APK');
  assert.ok(String(upload.with?.path ?? '').includes('MedAcademy-*.apk'));
});

// ── 2. Suspension armed at JOB level ─────────────────────────────────────────
console.log('\n── 2. Build-time suspension is armed at job level ──');

const jobEnv = job?.env ?? {};

check('job env declares both switch keys with exact values', () => {
  assert.strictEqual(String(jobEnv[FLAG]), '1', `${FLAG} must be '1' at job level`);
  assert.strictEqual(String(jobEnv[ACK]), ACK_VALUE, `${ACK} must be '${ACK_VALUE}' at job level`);
});

check('job env declares the workflow acknowledgement marker', () => {
  assert.strictEqual(String(jobEnv[MARKER]), MARKER_VALUE);
});

check('no step overrides the suspension keys', () => {
  for (const step of steps) {
    const env = step.env ?? {};
    for (const key of [FLAG, ACK, MARKER]) {
      if (key in env) {
        throw new Error(`step "${step.name}" redefines ${key} — the job-level value must stay authoritative`);
      }
    }
  }
});

check('expressions are not written into a step-local shell that Gradle cannot see', () => {
  // The keys must live in the YAML env block, not be exported inside a run block
  // (a per-step `export` would vanish before Gradle's bundling task).
  assert.ok(!/export\s+EXPO_PUBLIC_SECURITY_TEST_BUILD/.test(workflowSrc),
    'the switch must be declared in env:, not exported inside a single step');
});

check('fresh dependency install and no Metro/bundle cache restore', () => {
  assert.ok(workflowSrc.includes('npm ci'), 'npm ci missing');
  assert.ok(!/actions\/cache[\s\S]{0,200}(\.expo|metro)/i.test(workflowSrc),
    'a Metro/.expo cache restore could serve a bundle built without the keys');
  assert.ok(!workflowSrc.includes('--clear-metro-cache'), 'unexpected metro cache flag');
});

// ── 3. CI proves the waiver reached the bundle ──────────────────────────────
console.log('\n── 3. CI inspects the APK bundle ──');

check('workflow verifies the APK bundle contains the diagnostic marker', () => {
  const step = steps.find((s) => /Verify APK bundle contains the diagnostic switch/.test(String(s.name ?? '')));
  assert.ok(step, 'the APK-bundle verification step is missing');
  const run = scriptOf(step);
  assert.ok(run.includes('assets/index.android.bundle'), 'must inspect the APK JS bundle');
  assert.ok(run.includes('DIAGNOSTIC BUILD'), 'must assert the diagnostic banner marker');
  assert.ok(/exit 1/.test(run), 'must fail the build when the marker is absent');
});

check('the bundle check runs AFTER the APK is produced and verified', () => {
  const idxBuild = stepNames.indexOf('Build signed release APK (Gradle)');
  const idxVerifySig = stepNames.indexOf('Verify APK signature, identity and checksum');
  const idxBundle = stepNames.findIndex((n) => /Verify APK bundle contains the diagnostic switch/.test(n));
  const idxUpload = stepNames.indexOf('Upload APK artifact');
  assert.ok(idxBuild > -1 && idxVerifySig > -1 && idxBundle > -1 && idxUpload > -1);
  assert.ok(idxBundle > idxBuild && idxBundle > idxVerifySig, 'bundle check must run after build + signature check');
  assert.ok(idxBundle < idxUpload, 'bundle check must run before the artifact is published');
});

// ── 4. Identifiable build ───────────────────────────────────────────────────
console.log('\n── 4. Identifiable app version ──');

const appJson = JSON.parse(read('app.json'));

check('versionCode bumped past the shipped 222', () => {
  assert.ok(Number(appJson.expo.android.versionCode) >= 223,
    `expected versionCode >= 223, found ${appJson.expo.android.versionCode}`);
});

check('package id and version name unchanged', () => {
  assert.strictEqual(appJson.expo.android.package, 'com.medacademy.app');
  assert.strictEqual(appJson.expo.version, '1.0.0');
});

// ── 5. Restoration path actually restores protection ────────────────────────
console.log('\n── 5. Restoration restores protection ──');

const switchSrc = read('src/lib/securityTestBuild.ts');
const switchExpr = (() => {
  const m = switchSrc.match(/export const SECURITY_TEST_BUILD: boolean =\s*([\s\S]*?);\s*\n/);
  assert.ok(m, 'SECURITY_TEST_BUILD assignment not found');
  return m[1];
})();

/** Evaluate the ACTUAL shipped switch expression against an env object. */
const evalSwitch = (env) => new Function('process', `return (${switchExpr});`)({ env });

/** The env a NORMAL build of this workflow would provide. */
function envWithoutSuspension() {
  const env = { ...jobEnv };
  delete env[FLAG];
  delete env[ACK];
  delete env[MARKER];
  return env;
}

check('armed workflow env → switch ON', () => {
  assert.strictEqual(evalSwitch(jobEnv), true);
});

check('workflow env with the three keys removed → switch OFF (protection restored)', () => {
  const restored = envWithoutSuspension();
  assert.strictEqual(evalSwitch(restored), false);
  // The unrelated public config must survive the reversion untouched.
  assert.strictEqual(restored.EXPO_PUBLIC_APP_ID, 'app-czyg340mpc75');
  assert.strictEqual(restored.CI, '1');
});

check('removing only ONE key is not enough to keep the suspension', () => {
  const partial = { ...jobEnv };
  delete partial[ACK];
  assert.strictEqual(evalSwitch(partial), false, 'the acknowledgement key must be mandatory');
});

const GUARD = path.join(ROOT, 'scripts', 'check-diagnostic-build-guards.cjs');

function runGuard(extraEnv) {
  const env = { ...process.env };
  delete env[FLAG];
  delete env[ACK];
  delete env[MARKER];
  delete env.EAS_BUILD_PROFILE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [GUARD], { encoding: 'utf8', env });
}

check('build guard accepts the workflow suspension', () => {
  const r = runGuard({ [FLAG]: '1', [ACK]: ACK_VALUE, [MARKER]: MARKER_VALUE });
  assert.strictEqual(r.status, 0, `guard rejected the sanctioned workflow env:\n${r.stdout}\n${r.stderr}`);
});

check('build guard still rejects a stray single variable', () => {
  const r = runGuard({ [FLAG]: '1' });
  assert.notStrictEqual(r.status, 0, 'a lone flag must remain rejected');
});

check('build guard still rejects the keys when building production', () => {
  const r = runGuard({ [FLAG]: '1', [ACK]: ACK_VALUE, [MARKER]: MARKER_VALUE, EAS_BUILD_PROFILE: 'production' });
  assert.notStrictEqual(r.status, 0, 'production must never carry the suspension keys');
});

check('build guard passes for a normal (restored) workflow env', () => {
  const restored = envWithoutSuspension();
  const r = runGuard(restored);
  assert.strictEqual(r.status, 0, `guard must pass for a restored build:\n${r.stdout}\n${r.stderr}`);
});

// ── 6. Restoration documentation ────────────────────────────────────────────
console.log('\n── 6. Restoration checklist ──');

check('suspension and restoration are documented', () => {
  const doc = read('docs/TEMP_SECURITY_SUSPENSION.md');
  assert.ok(doc.includes(FLAG) && doc.includes(ACK) && doc.includes(MARKER),
    'docs must name all three build-time variables');
  assert.ok(/TEMPORARY/i.test(doc), 'docs must be marked temporary');
  assert.ok(/Restoration checklist/i.test(doc), 'docs must contain a restoration checklist');
  for (const artefact of ['android-apk.yml', 'versionCode', 'TEMP_SECURITY_SUSPENSION']) {
    assert.ok(doc.includes(artefact), `docs must mention ${artefact}`);
  }
});

check('workflow itself warns that the build is temporarily suspended', () => {
  assert.ok(/TEMPORARY SECURITY SUSPENSION/.test(workflowSrc),
    'the workflow must carry the temporary-suspension banner comment');
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(62)}`);
if (failures.length === 0) {
  console.log(`RESULT: ${passed} passed, 0 failed`);
  console.log('Workflow security-suspension suite: OK');
  process.exit(0);
}
console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  • ${f.label}: ${f.message}`);
console.log('FAILURES PRESENT');
process.exit(1);
