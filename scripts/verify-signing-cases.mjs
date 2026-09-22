#!/usr/bin/env node
/**
 * verify-signing-cases.mjs — verify the signature-check semantics for all three
 * integrity cases using the EXACT algorithm the native module uses
 * (SecurityModule.checkSignatureValid: SHA-256 over the first signing-cert
 * DER bytes, uppercase hex, compared to the expected pin).
 *
 * Cases:
 *   A  production-signed APK  + pin configured  → VALID
 *   B  debug-signed APK       + pin configured  → signature_invalid (mismatch)
 *   C  any APK                + pin empty       → UNAVAILABLE (never tampered)
 *
 * Certificates are read from the APKv2 signing block via apksigner; the
 * "certificate SHA-256 digest" printed by apksigner IS the SHA-256 of the
 * certificate DER — the same digest the native code computes.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Windows .bat files must go through cmd.exe (Node ≥20 refuses to spawn .bat
// directly — EINVAL). Resolve the newest build-tools apksigner and wrap it.
const home = os.homedir();
const btDir = path.join(home, 'AppData', 'Local', 'Android', 'Sdk', 'build-tools');
const versions = fs.readdirSync(btDir).sort((a, b) => Number(b) - Number(a));
const apksignerBat = path.join(btDir, versions[0], 'apksigner.bat');
const isWin = process.platform === 'win32';
const apksignerCmd = isWin ? [ 'cmd.exe', '/d', '/s', '/c', apksignerBat ] : [ apksignerBat ];
const runApksigner = (args, apk) =>
  execFileSync(apksignerCmd[0], [...apksignerCmd.slice(1), ...args, apk], { encoding: 'utf8' });

const prodApk = 'android/app/build/outputs/apk/release/app-release.apk';
const debugApk = 'docs/artifacts/app-release-NEGATIVE-debug-signed.apk';
const pinFile = 'android/app/expected-cert-sha256.local';

const shaOf = (apk) => {
  const out = runApksigner(['verify', '--print-certs'], apk);
  const m = out.match(/certificate SHA-256 digest:\s*([0-9a-fA-F]{64})/);
  if (!m) throw new Error(`no SHA-256 digest in apksigner output for ${apk}`);
  return m[1].toUpperCase();
};

const prodSha = shaOf(prodApk);
const debugSha = shaOf(debugApk);
const pin = (fs.existsSync(pinFile) ? fs.readFileSync(pinFile, 'utf8').trim() : '').toUpperCase();

console.log('production APK cert :', prodSha);
console.log('debug-signed cert   :', debugSha);
console.log('expected pin        :', pin || '(EMPTY)');
console.log('');

const results = [];
// TEST A
results.push(['A production-signed + pin', pin !== '' && prodSha === pin ? 'VALID (signatureValid=true)' : 'FAIL']);
// TEST B
results.push(['B debug-signed + pin', pin !== '' && debugSha !== pin ? 'signature_invalid → COMPROMISED (correct)' : 'FAIL']);
// TEST C — the pin IS configured on this machine, so the unavailable state is
// verified STATICALLY (code-path proof), not dynamically: confirm the native
// check returns true/skip when the pin is empty and the JS layer refuses to
// flag signature_invalid without a configured fingerprint.
const kt = fs.readFileSync('android/app/src/main/java/com/medacademy/security/SecurityModule.kt', 'utf8');
const js = fs.readFileSync('src/lib/security.ts', 'utf8');
const nativeSkip = kt.includes('if (expected.isEmpty()) return true');
const jsGuard = js.includes('SIGNATURE_CHECK_READY && TRUSTED_CERTS.length > 0') &&
                js.includes("expectedCertConfigured:  rawFlags?.expectedCertConfigured ?? false");
results.push([
  'C no pin configured',
  nativeSkip && jsGuard
    ? 'UNAVAILABLE semantics verified in code (native skip + JS guard + expectedCertConfigured evidence) — NOT tampered'
    : 'FAIL',
]);

let ok = true;
for (const [name, verdict] of results) {
  const pass = !verdict.startsWith('FAIL');
  ok = ok && pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} → ${verdict}`);
}
process.exit(ok ? 0 : 1);
