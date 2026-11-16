#!/usr/bin/env node
/* eslint-env node */
/**
 * check-diagnostic-build-guards.cjs — BUILD GATE for the diagnostic
 * (security-test) build switch.
 *
 * PURPOSE
 * ───────
 * The diagnostic switch lets a throwaway APK reach the dashboard on a device
 * with Developer Options / USB debugging / Magisk / Xposed. That is exactly the
 * kind of switch that must be impossible to ship by accident, so this script
 * FAILS the build pipeline when the configuration could enable it in anything
 * other than the dedicated internal profile.
 *
 * WHERE IT RUNS
 * ─────────────
 *   npm run validate          (after scripts/validate-all.js)
 *   npm run prebuild:validate (same)
 * and it can be run directly:
 *   node scripts/check-diagnostic-build-guards.cjs
 *
 * CHECKS
 * ──────
 *  1. eas.json: BOTH diagnostic keys appear in the `security-test` profile and
 *     in NO other profile (production included).
 *  2. `security-test` must stay `distribution: internal` — never a store build.
 *  3. The `production` profile must not declare either key, and `submit` must
 *     not reference the diagnostic profile.
 *  4. Environment (the build actually about to run):
 *       • the flag alone is a FAILURE — the acknowledgement key is required;
 *       • if EAS_BUILD_PROFILE is present it must be `security-test`;
 *       • with no profile, MEDACADEMY_SECURITY_SUSPENSION=workflow is required
 *         (the temporary suspension in .github/workflows/android-apk.yml);
 *       • neither key may be set while building any other profile.
 *  5. Source: the switch is compile-time only (literal process.env member
 *     access, strict equality) and reads no runtime/storage/remote input.
 *  6. Source: the visible indicator is gated on that constant and mounted at
 *     the app root — a diagnostic build can never look like a production one.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const FLAG = 'EXPO_PUBLIC_SECURITY_TEST_BUILD';
const ACK = 'EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK';
const ACK_VALUE = 'security-test';
const DIAGNOSTIC_PROFILE = 'security-test';
/** Second sanctioned arming path: the temporary suspension in the GH workflow. */
const WORKFLOW_MARKER = 'MEDACADEMY_SECURITY_SUSPENSION';
const WORKFLOW_MARKER_VALUE = 'workflow';

const failures = [];
const notes = [];

function fail(msg) { failures.push(msg); }
function note(msg) { notes.push(msg); }

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ── 1–3. eas.json profile hygiene ─────────────────────────────────────────────
let eas;
try {
  eas = JSON.parse(read('eas.json'));
} catch (e) {
  fail(`eas.json could not be parsed: ${e.message}`);
}

if (eas) {
  const profiles = Object.entries(eas.build ?? {});

  for (const [name, profile] of profiles) {
    const env = profile.env ?? {};
    const hasFlag = Object.prototype.hasOwnProperty.call(env, FLAG);
    const hasAck = Object.prototype.hasOwnProperty.call(env, ACK);

    if (name === DIAGNOSTIC_PROFILE) {
      if (!hasFlag) fail(`eas.json: the "${name}" profile must set ${FLAG}=1 (it is the diagnostic profile).`);
      if (!hasAck) fail(`eas.json: the "${name}" profile must set ${ACK}=${ACK_VALUE}.`);
      if (hasFlag && env[FLAG] !== '1') fail(`eas.json: ${FLAG} in "${name}" must be exactly "1".`);
      if (hasAck && env[ACK] !== ACK_VALUE) fail(`eas.json: ${ACK} in "${name}" must be exactly "${ACK_VALUE}".`);
      if (profile.distribution !== 'internal') {
        fail(`eas.json: the "${name}" profile must stay distribution:"internal" (found ${JSON.stringify(profile.distribution)}).`);
      }
    } else {
      if (hasFlag || hasAck) {
        fail(`eas.json: profile "${name}" must NOT declare ${hasFlag ? FLAG : ACK}. Only "${DIAGNOSTIC_PROFILE}" may.`);
      }
    }
  }

  if (!Object.prototype.hasOwnProperty.call(eas.build ?? {}, DIAGNOSTIC_PROFILE)) {
    fail(`eas.json: the "${DIAGNOSTIC_PROFILE}" profile is missing.`);
  }

  const production = eas.build?.production ?? {};
  const prodEnv = production.env ?? {};
  if (Object.prototype.hasOwnProperty.call(prodEnv, FLAG) || Object.prototype.hasOwnProperty.call(prodEnv, ACK)) {
    fail('eas.json: the production profile must never declare the diagnostic keys.');
  }

  if (JSON.stringify(eas.submit ?? {}).includes(DIAGNOSTIC_PROFILE)) {
    fail(`eas.json: "submit" must not reference the "${DIAGNOSTIC_PROFILE}" profile.`);
  }
}

// ── 4. Environment of the build that is about to run ─────────────────────────
const envFlag = process.env[FLAG];
const envAck = process.env[ACK];
const envProfile = process.env.EAS_BUILD_PROFILE;
const envSuspension = process.env[WORKFLOW_MARKER];

if (envFlag !== undefined || envAck !== undefined) {
  if (envFlag !== '1') {
    fail(`${FLAG} is set but is not "1" — refusing: a half-set diagnostic switch is ambiguous.`);
  }
  if (envAck !== ACK_VALUE) {
    fail(`${FLAG} is set WITHOUT ${ACK}=${ACK_VALUE}. The second build-time key is required; the mode cannot be enabled by one stray variable.`);
  }
  if (envProfile !== undefined && envProfile !== DIAGNOSTIC_PROFILE) {
    fail(`The diagnostic keys are set while building profile "${envProfile}". They are only allowed for "${DIAGNOSTIC_PROFILE}".`);
  }
  // Two sanctioned ways to arm the switch, both explicit and both build-time:
  //   • EAS `security-test` profile (EAS_BUILD_PROFILE=security-test)
  //   • the temporary suspension in .github/workflows/android-apk.yml
  //     (MEDACADEMY_SECURITY_SUSPENSION=workflow)
  // Neither key set on its own, and no other profile, is accepted.
  if (envProfile === undefined && envSuspension !== WORKFLOW_MARKER_VALUE) {
    fail(
      `The diagnostic keys are set with neither EAS_BUILD_PROFILE=${DIAGNOSTIC_PROFILE}\n` +
      `         nor MEDACADEMY_SECURITY_SUSPENSION=${WORKFLOW_MARKER_VALUE}. An ambiguous enablement is refused.\n` +
      `         Unset ${FLAG} / ${ACK} before building anything else.`,
    );
  }
  if (failures.length === 0) {
    note(`Diagnostic build requested via ${envProfile ? `profile "${envProfile}"` : `the workflow marker (${WORKFLOW_MARKER})`} — allowed.`);
  }
}

// ── 5. The switch must be compile-time and literal ───────────────────────────
/**
 * Code only. The substrings below are checked against the IMPLEMENTATION; the
 * module's own documentation explains which APIs are forbidden ("no
 * AsyncStorage/SecureStore/process.env[...]"), so comments must not count as
 * usage — otherwise the guard would fail on its own documentation.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const switchSrc = codeOnly(read('src/lib/securityTestBuild.ts'));
const flagSrc = codeOnly(read('src/lib/diagnosticBuildFlag.ts'));
// The switch is a source CONSTANT, not `process.env`: a release bundle inlines
// EXPO_PUBLIC_* inside the Metro worker, and builds 223 / 43926766869 showed that
// worker can inline `undefined` while the bundling process itself sees the keys —
// after which the minifier deletes every diagnostic marker as dead code.
if (!/export const DIAGNOSTIC_BUILD_FLAG: boolean = false;/.test(flagSrc)) {
  fail(
    'src/lib/diagnosticBuildFlag.ts must declare `export const DIAGNOSTIC_BUILD_FLAG: boolean = false;`.\n' +
    '         A committed `true` would ship the security suspension in EVERY build.',
  );
}
if (/export\s+(?:let|var)\b/.test(flagSrc)) {
  fail('src/lib/diagnosticBuildFlag.ts must export only a `const` (never a runtime-reassignable flag).');
}
if (!switchSrc.includes("import { DIAGNOSTIC_BUILD_FLAG } from './diagnosticBuildFlag';")) {
  fail("src/lib/securityTestBuild.ts must import DIAGNOSTIC_BUILD_FLAG from './diagnosticBuildFlag'.");
}
if (!/export const SECURITY_TEST_BUILD: boolean = DIAGNOSTIC_BUILD_FLAG;/.test(switchSrc)) {
  fail('src/lib/securityTestBuild.ts must bind SECURITY_TEST_BUILD directly to DIAGNOSTIC_BUILD_FLAG.');
}
if (/process\.env\[/.test(switchSrc)) {
  fail('src/lib/securityTestBuild.ts must not use dynamic process.env[...] access — Metro does not inline it.');
}
for (const forbidden of ['AsyncStorage', 'SecureStore', 'expo-constants', 'Constants.', 'fetch(', 'route.params', 'useLocalSearchParams']) {
  if (switchSrc.includes(forbidden)) {
    fail(`src/lib/securityTestBuild.ts must not depend on runtime input ("${forbidden}" found): the switch is build-time only.`);
  }
}

// ── 5b. No env file on disk may arm the switch by itself ─────────────────────
// Release bundles inline EXPO_PUBLIC_* at transform time, and Expo's loader
// reads `.env.<mode>.local` -> `.env.local` -> `.env.<mode>` -> `.env`.
// A committed (or accidentally left-behind) env file carrying the two keys
// would arm the suspension in EVERY build of this checkout — the exact hidden
// bypass this guard exists to prevent. The workflow writes those files on the
// RUNNER only, through scripts/arm-diagnostic-suspension.cjs.
//
// `MEDACADEMY_GUARD_ENV_ROOT` lets the test suite point this scan at a temp
// directory instead of the real project.
const envRoot = process.env.MEDACADEMY_GUARD_ENV_ROOT || ROOT;
const ARMED_KEYS = ['EXPO_PUBLIC_SECURITY_TEST_BUILD', 'EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK'];
const strayEnvFiles = ['.env', '.env.local', '.env.production', '.env.production.local']
  .map((name) => path.join(envRoot, name))
  .filter((file) => {
    if (!fs.existsSync(file)) return false;
    const body = fs.readFileSync(file, 'utf8');
    return ARMED_KEYS.some((key) => new RegExp(`^\\s*${key}\\s*=`, 'm').test(body));
  });
if (strayEnvFiles.length > 0) {
  fail(
    `An env file in this checkout declares the suspension keys: ${strayEnvFiles
      .map((f) => path.basename(f))
      .join(', ')}.\n` +
      '         The temporary suspension is armed by the workflow ON THE RUNNER only.\n' +
      '         A local or committed env file would arm it in every build. Remove those\n' +
      '         lines (and delete .env.production / .env.production.local if present).',
  );
}

// ── 6. The visible indicator must exist, be gated, and be mounted ────────────
const bannerSrc = read('src/components/DiagnosticModeBanner.tsx');
if (!bannerSrc.includes("from '@/lib/securityTestBuild'")) {
  fail('src/components/DiagnosticModeBanner.tsx must derive its visibility from @/lib/securityTestBuild.');
}
if (!/if \(!SECURITY_TEST_BUILD\) return null;/.test(bannerSrc)) {
  fail('src/components/DiagnosticModeBanner.tsx must return null when SECURITY_TEST_BUILD is false.');
}
const rootLayout = read('src/app/_layout.tsx');
if (!rootLayout.includes('<DiagnosticModeBanner />')) {
  fail('src/app/_layout.tsx must mount <DiagnosticModeBanner /> at the app root.');
}

// ── Result ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error('\n❌ DIAGNOSTIC BUILD GUARD — FAILED\n');
  for (const f of failures) console.error(`   • ${f}`);
  console.error('\n   The diagnostic switch must never be able to reach production.\n');
  process.exit(1);
}

console.log('✅ DIAGNOSTIC BUILD GUARD — passed');
for (const n of notes) console.log(`   • ${n}`);
console.log('   • production profile declares no diagnostic keys');
console.log('   • switch is build-time only (literal, double-keyed)');
console.log('   • visible indicator mounted at the app root');
process.exit(0);
