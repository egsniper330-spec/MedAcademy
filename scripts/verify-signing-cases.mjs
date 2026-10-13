#!/usr/bin/env node
/**
 * verify-signing-cases.mjs — verify the signature-check semantics for all
 * integrity cases using the EXACT algorithm the native module uses
 * (SecurityModule.checkSignatureValid: SHA-256 over the signing-cert DER bytes,
 * uppercase hex, compared to the expected pin).
 *
 * Dynamic cases (need a built APK + the Android SDK on this machine):
 *   A  production-signed APK  + pin configured → VALID
 *   B  debug-signed APK       + pin configured → signature_invalid (mismatch)
 *
 * Static cases (always run — no APK, no SDK, no build required):
 *   C  pin missing  → the native check must SKIP (UNAVAILABLE), never fail
 *   D  pin supply chain → the pin reaches BuildConfig, and a release build that
 *      would carry an EMPTY pin is BLOCKED rather than shipped unverifiable
 *
 * Anything that cannot be measured on this machine is reported as SKIPPED with
 * the reason — never silently treated as a pass. Exit code is 0 only when no
 * case FAILED (skips do not fail the run).
 *
 * This script never reads the keystore password and never prints key material.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = []; // [name, verdict, isFailure]
const record = (name, verdict, isFailure = verdict.startsWith('FAIL')) =>
  results.push([name, verdict, isFailure]);

// ── locate the Android SDK's apksigner (optional) ────────────────────────────
function findApksigner() {
  const btDir = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'build-tools');
  if (!fs.existsSync(btDir)) return null;
  const versions = fs.readdirSync(btDir).sort((a, b) => Number(b) - Number(a));
  for (const v of versions) {
    const bat = path.join(btDir, v, 'apksigner.bat');
    const bin = path.join(btDir, v, 'apksigner');
    if (fs.existsSync(bat)) return isWin() ? ['cmd.exe', '/d', '/s', '/c', bat] : [bat];
    if (fs.existsSync(bin)) return [bin];
  }
  return null;
}
const isWin = () => process.platform === 'win32';

const shaOf = (apksigner, apk) => {
  const out = execFileSync(apksigner[0], [...apksigner.slice(1), 'verify', '--print-certs', apk], { encoding: 'utf8' });
  const m = out.match(/certificate SHA-256 digest:\s*([0-9a-fA-F]{64})/);
  if (!m) throw new Error(`no SHA-256 digest in apksigner output for ${apk}`);
  return m[1].toUpperCase();
};

// ── inputs ──────────────────────────────────────────────────────────────────
const prodApk    = 'android/app/build/outputs/apk/release/app-release.apk';
const negativeApks = [
  'docs/artifacts/app-release-NEGATIVE-debug-signed.apk',
  'docs/artifacts/app-release-DEBUGSIGNED-archived.apk',
];
const pinFile    = 'android/app/expected-cert-sha256.local';
const apksigner  = findApksigner();

// ── generated-tree prerequisite ─────────────────────────────────────────────
// Cases C and D read files that `npx expo prebuild -p android` GENERATES; they
// are not committed. On a clean checkout those reads used to throw an uncaught
// ENOENT, which told the operator nothing. A missing generated tree is a
// PREREQUISITE problem: it is reported as a deliberate FAIL (never a silent
// skip, so the release gate stays fail-closed) naming the exact command.
const GENERATED = {
  securityModule: 'android/app/src/main/java/com/medacademy/security/SecurityModule.kt',
  appGradle: 'android/app/build.gradle',
};
const PREREQ_HINT = 'run: npx expo prebuild -p android (the generated android/ tree is not committed)';
const generatedMissing = Object.entries(GENERATED)
  .filter(([, p]) => !fs.existsSync(p))
  .map(([k, p]) => `${k} (${p})`);
/** Read a generated file, or null when the prebuild prerequisite is missing. */
const genRead = (key) => (fs.existsSync(GENERATED[key]) ? fs.readFileSync(GENERATED[key], 'utf8') : null);

const pin = (fs.existsSync(pinFile) ? fs.readFileSync(pinFile, 'utf8').trim() : '').toUpperCase();
console.log('expected pin  :', pin || '(EMPTY on this machine)');
console.log('apksigner     :', apksigner ? 'found' : 'NOT FOUND (dynamic cases will be skipped)');
console.log('generated tree:', generatedMissing.length === 0
  ? 'present (static cases C and D are measurable)'
  : `MISSING — ${generatedMissing.join(', ')}; ${PREREQ_HINT}`);
console.log('');

// ── A / B: dynamic, need a built APK ────────────────────────────────────────
if (!apksigner) {
  record('A production-signed + pin', 'SKIPPED — no Android SDK build-tools apksigner on this machine');
  record('B debug-signed + pin', 'SKIPPED — same reason');
} else if (!fs.existsSync(prodApk)) {
  record('A production-signed + pin', `SKIPPED — no release APK at ${prodApk} (run a release build first)`);
  record('B debug-signed + pin', 'SKIPPED — same reason');
} else {
  const prodSha = shaOf(apksigner, prodApk);
  console.log('release APK cert:', prodSha);
  record('A production-signed + pin',
    pin !== '' && prodSha === pin ? 'VALID (signatureValid=true)' : 'FAIL — APK cert does not match the configured pin');

  const neg = negativeApks.find((p) => fs.existsSync(p));
  if (!neg) {
    record('B debug-signed + pin',
      'SKIPPED — no archived debug-signed APK (export one to docs/artifacts/app-release-NEGATIVE-debug-signed.apk to enable this negative test)');
  } else {
    const debugSha = shaOf(apksigner, neg);
    console.log('debug-signed cert:', debugSha);
    record('B debug-signed + pin',
      pin !== '' && debugSha !== pin ? 'signature_invalid → COMPROMISED (correct)' : 'FAIL — debug cert was accepted');
  }
}

// ── C: the pin-missing case is code-path proven (static) ────────────────────
{
  const kt = genRead('securityModule');
  const js = fs.readFileSync('src/lib/security.ts', 'utf8');
  const nativeSkips = kt !== null && kt.includes('if (expected.isEmpty()) return true');
  const reportsUnavailable = kt !== null && kt.includes('r.putBoolean("expectedCertConfigured", expectedCertSha256().isNotEmpty())');
  const jsIntegrityGuard  = js.includes('flags.expectedCertConfigured === true && flags.signatureValid === false');
  const jsTamperGuard     = /SIGNATURE_CHECK_READY && TRUSTED_CERTS\.length > 0 && buildPinnedCert/.test(js);
  record('C pin missing = UNAVAILABLE',
    kt === null
      ? `FAIL — PREREQUISITE MISSING: ${GENERATED.securityModule}; ${PREREQ_HINT}`
      : nativeSkips && reportsUnavailable && jsIntegrityGuard && jsTamperGuard
        ? 'native skips + reports expectedCertConfigured=false; BOTH JS detectors require a build-time pin before accepting signatureValid — never "tampered"'
        : 'FAIL — a skipped signature check can still be read as verified');
}

// ── D: the pin must actually reach the build, and an empty pin must block ───
{
  const plugin = fs.readFileSync('plugins/withProductionSigning.js', 'utf8');
  const gradle = genRead('appGradle');
  const injected = gradle !== null && gradle.includes('buildConfigField "String", "EXPECTED_CERT_SHA256"');
  const guarded  = gradle !== null && gradle.includes('release cert-pin fail-closed guard')
    && gradle.includes('packageRelease') && gradle.includes('GradleException');
  const sources  = gradle !== null
    && ['expectedCertSha256', 'MEDA_EXPECTED_CERT_SHA256', 'expected-cert-sha256.local']
      .every((s) => plugin.includes(s) && gradle.includes(s));
  record('D pin supply + fail-closed release',
    gradle === null
      ? `FAIL — PREREQUISITE MISSING: ${GENERATED.appGradle}; ${PREREQ_HINT}`
      : injected && guarded && sources
      ? 'pin resolved from gradle property / env / expected-cert-sha256.local into BuildConfig; a release packaging task with an EMPTY pin throws GradleException'
      : `FAIL — injected=${injected} guarded=${guarded} allSourcesDocumented=${sources}`);
}

// ── report ──────────────────────────────────────────────────────────────────
let failed = false;
for (const [name, verdict, isFailure] of results) {
  const tag = verdict.startsWith('SKIPPED') ? 'SKIP' : isFailure ? 'FAIL' : 'PASS';
  if (isFailure) failed = true;
  console.log(`${tag}  ${name.padEnd(30)} → ${verdict}`);
}
const skipped = results.filter(([, v]) => v.startsWith('SKIPPED')).length;
if (skipped) console.log(`\n${skipped} case(s) skipped — see docs/PRODUCTION_SIGNING_SETUP.md for the APK/SDK prerequisites.`);
process.exit(failed ? 1 : 0);
