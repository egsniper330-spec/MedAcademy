#!/usr/bin/env node
/**
 * set-production-cert-sha256.mjs — write the PRODUCTION signing cert
 * fingerprint to android/app/expected-cert-sha256.local (gitignored).
 *
 * The fingerprint is PUBLIC material; the keystore password is read from
 * ~/.medacademy/release-keystore.password and is never printed or written.
 *
 * Usage:
 *   node scripts/set-production-cert-sha256.mjs            # auto: ~/.medacademy keystore
 *   node scripts/set-production-cert-sha256.mjs <keystore> [alias] [pwfile]
 *
 * After changing the signing identity: run this, then rebuild the release APK.
 * Rotate the backend pin separately (docs/PRODUCTION_SIGNING_SETUP.md).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const ks = process.argv[2] ?? path.join(home, '.medacademy', 'medacademy-release.keystore');
const alias = process.argv[3] ?? 'medacademy-prod';
const pwFile = process.argv[4] ?? path.join(home, '.medacademy', 'release-keystore.password');

if (!fs.existsSync(ks)) { console.error(`keystore not found: ${ks}`); process.exit(1); }
if (!fs.existsSync(pwFile)) { console.error(`password file not found: ${pwFile}`); process.exit(1); }
const storepass = fs.readFileSync(pwFile, 'utf8').trim();

// keytool -list -v output contains "SHA256: AA:BB:…" for the cert.
const out = execFileSync('keytool', [
  '-list', '-v',
  '-keystore', ks,
  '-storepass', storepass,
  '-alias', alias,
], { encoding: 'utf8' });

const m = out.match(/SHA256:\s*([0-9A-F:]{95})/);
if (!m) { console.error('SHA-256 fingerprint not found in keytool output'); process.exit(1); }
const sha256 = m[1].replace(/:/g, '');

if (!/^[0-9A-F]{64}$/.test(sha256)) {
  console.error('fingerprint failed 64-hex validation:', sha256);
  process.exit(1);
}

const outPath = path.resolve('android/app/expected-cert-sha256.local');
fs.writeFileSync(outPath, sha256 + '\n', 'utf8');
console.log('production cert SHA-256 written to', outPath);
console.log(sha256);
