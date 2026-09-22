#!/usr/bin/env node
/**
 * apply-production-cert-pin.mjs — generate APPEND-ONLY SQL that trusts the
 * MedAcademy PRODUCTION signing certificate in security_config.expected_cert_sha256s.
 *
 * SAFETY CONTRACT (fixes the earlier overwrite bug):
 *   - The generated UPDATE NEVER REPLACES the existing JSON array. It appends
 *     the new fingerprint INSIDE the existing array, preserving every current
 *     entry verbatim.
 *   - Idempotent: if the fingerprint is ALREADY trusted (case-insensitive), the
 *     UPDATE matches ZERO rows — no duplicate, and security_version is NOT
 *     incremented (requirement: bump exactly once per actual change).
 *   - MariaDB/MySQL compatibility: uses ONLY CONCAT / SUBSTRING / CHAR_LENGTH /
 *     TRIM / UPPER / LIKE / CASE — no JSON_ARRAY_APPEND or other functions whose
 *     availability differs between MySQL and MariaDB versions on cPanel hosting.
 *     (Deployment target per backend/README.md: "PHP 8.x + MySQL/MariaDB".)
 *   - Guard rails: only rows whose value LOOKS like a JSON array (starts with
 *     '[') are touched; a malformed value is left untouched so the pre-check
 *     below surfaces it instead of the UPDATE corrupting it.
 *   - Applying still requires DB credentials, which this script deliberately
 *     does not hold. Run the printed SQL as a DB administrator. Nothing is
 *     executed automatically.
 *
 * Usage:
 *   node scripts/apply-production-cert-pin.mjs              # auto: ~/.medacademy keystore
 *   node scripts/apply-production-cert-pin.mjs <keystore> [alias] [pwfile]
 *   node scripts/apply-production-cert-pin.mjs --demo       # simulate the transformation
 *
 * To add a FUTURE certificate (e.g. Play App Signing): run this script with that
 * keystore — the append-only UPDATE adds it alongside the current certs, giving
 * the rotation window where both are trusted. Never hand-edit the array.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Demo mode: simulate the generated SQL's string logic on an example array ──
// Mirrors the UPDATE expression below EXACTLY (same CONCAT argument order,
// including the closing ']') so the transformation can be verified WITHOUT
// touching any database. Also asserts the result parses as valid JSON.
function simulate(currentArrayJson, newCert) {
  const inner = currentArrayJson.substring(1, currentArrayJson.length - 1);
  const innerTrimmedLen = inner
    .replace(/^\[+/, '').replace(/\]+$/, '')
    .replace(/^\]+/, '').replace(/\[+$/, '').length;
  const comma = innerTrimmedLen === 0 ? '' : ', ';
  // CONCAT('[', inner, comma, '"<cert>"', ']')
  return `[${inner}${comma}"${newCert}"]`;
}
function assertValidJson(value, label) {
  try { JSON.parse(value); } catch (e) {
    console.error(`  INVALID JSON for ${label}: ${value} (${e.message})`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
if (args[0] === '--demo') {
  const NEW = '62E8539CBD1A66FE9E0AE2839D4C3B2C63EF896AE52F13ECBB37CDFDBEFF3784';
  const cases = [
    ['["OLD_CERT_A","OLD_CERT_B"]', 'two existing certs → appended'],
    ['[]', 'empty array → no leading comma'],
    [`["${NEW}"]`, 'cert already present → SQL matches 0 rows, NO change'],
  ];
  for (const [current, label] of cases) {
    const already =
      current.toUpperCase().includes(`"${NEW}"`);
    const after = already ? current : simulate(current, NEW);
    assertValidJson(after, label);
    console.log(`CURRENT:  ${current}`);
    console.log(`AFTER:    ${after}${already ? '  (unchanged — 0 rows matched)' : ''}`);
    console.log(`          (${label}; valid JSON: yes)`);
    console.log('');
  }
  process.exit(0);
}

// ── Extract the production certificate fingerprint ───────────────────────────
const home = os.homedir();
const ks = args[0] ?? path.join(home, '.medacademy', 'medacademy-release.keystore');
const alias = args[1] ?? 'medacademy-prod';
const pwFile = args[2] ?? path.join(home, '.medacademy', 'release-keystore.password');

if (!fs.existsSync(ks)) { console.error(`keystore not found: ${ks}`); process.exit(1); }
if (!fs.existsSync(pwFile)) { console.error(`password file not found: ${pwFile}`); process.exit(1); }
const storepass = fs.readFileSync(pwFile, 'utf8').trim();

const out = execFileSync('keytool', [
  '-list', '-v', '-keystore', ks, '-storepass', storepass, '-alias', alias,
], { encoding: 'utf8' });

const m = out.match(/SHA256:\s*([0-9A-F:]{95})/);
if (!m) { console.error('SHA-256 fingerprint not found in keytool output'); process.exit(1); }
const sha256 = m[1].replace(/:/g, '');
if (!/^[0-9A-F]{64}$/.test(sha256)) {
  console.error('fingerprint failed 64-hex validation:', sha256);
  process.exit(1);
}

// ── Generate the SQL ──────────────────────────────────────────────────────────
console.log('-- =====================================================================');
console.log('-- MedAcademy production certificate pin — APPEND-ONLY, IDEMPOTENT.');
console.log('-- Target table: security_config (server-controlled trust source served');
console.log('-- by GET /security/config → client securityConfigService → TRUSTED_CERTS).');
console.log('--');
console.log('-- Compatibility: uses ONLY CONCAT / SUBSTRING / CHAR_LENGTH / TRIM /');
console.log('-- UPPER / LIKE / CASE — safe on MySQL AND MariaDB (cPanel shared hosting,');
console.log('-- exact engine/version unknown by design, so no JSON_* functions).');
console.log('-- Live DB confirmed: MariaDB 11.4.13, column is LONGTEXT with');
console.log('-- CHECK (json_valid(expected_cert_sha256s)) — the closing ] below is what');
console.log('-- keeps the produced value valid so that CHECK never rejects the UPDATE.');
console.log('--');
console.log('-- Behaviour:');
console.log('--   * existing certificates are preserved verbatim (append inside the');
console.log('--     existing array — never overwrite)');
console.log('--   * cert already trusted → 0 rows matched, NO duplicate, security_version');
console.log('--     NOT incremented (safe to re-run)');
console.log('--   * security_version increments exactly once per actual change');
console.log('-- =====================================================================');
console.log('');
console.log('-- STEP 1 — PRE-CHECK: capture the current value (your rollback point).');
console.log('-- Abort and investigate if the value is not a JSON array starting with [');
console.log('-- or if it already contains the cert below.');
console.log('SELECT id, expected_cert_sha256s, security_version');
console.log('FROM security_config WHERE is_active = 1;');
console.log('');
console.log('-- STEP 2 — APPLY (append the production cert, preserve everything else):');
console.log('-- Expression: "[" + existing inner content + optional ", " + new cert + "]"');
console.log('UPDATE security_config');
console.log('SET expected_cert_sha256s = CONCAT(');
console.log("      '[',");
console.log('      SUBSTRING(expected_cert_sha256s, 2, CHAR_LENGTH(expected_cert_sha256s) - 2),');
console.log("      CASE WHEN CHAR_LENGTH(TRIM(TRAILING ']' FROM TRIM(LEADING '[' FROM expected_cert_sha256s))) = 0");
console.log("           THEN '' ELSE ', ' END,");
console.log(`      '"${sha256}"',`);
console.log("      ']'");
console.log('    ),');
console.log('    security_version = security_version + 1,');
console.log('    updated_at = UTC_TIMESTAMP(6)');
console.log('WHERE is_active = 1');
console.log("  AND expected_cert_sha256s LIKE '[%'");
console.log(`  AND UPPER(expected_cert_sha256s) NOT LIKE '%${sha256}%';`);
console.log('');
console.log('-- STEP 3 — VERIFY: array must contain ALL previous certs plus the new one,');
console.log('-- and security_version must be exactly +1 from the STEP 1 reading.');
console.log('-- (Re-running STEP 2 must report 0 rows affected and NO further bump.)');
console.log('SELECT expected_cert_sha256s, security_version');
console.log('FROM security_config WHERE is_active = 1;');
console.log('');
console.log('-- ROLLBACK (if ever needed): restore the value captured in STEP 1,');
console.log('-- e.g.  UPDATE security_config SET expected_cert_sha256s = \'<STEP-1 VALUE>\',');
console.log('--       security_version = security_version + 1 WHERE is_active = 1;');
console.log('');
console.log(`-- New fingerprint: ${sha256}`);
