#!/usr/bin/env node
/**
 * gen-manifest.cjs — regenerate manifest.json from the CURRENT source tree.
 *
 * Run this after copying artifacts into src/ so the recorded hashes always
 * describe the bytes actually sitting in the package:
 *
 *     node gen-manifest.cjs
 *
 * It refuses to write a manifest if any artifact is not byte-identical to its
 * `backend/src/...` counterpart, so a stale copy can never be signed off.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const here = __dirname;
const backendDir = path.resolve(here, '..', '..'); // D:\v3\backend

/**
 * [ package-local path, server-relative path, required?, what changed ]
 * `required: false` means the file is behaviourally inert (comment-only) and
 * can be skipped without losing any security property.
 */
const ARTIFACTS = [
  ['src/Controllers/RpcController.php', 'src/Controllers/RpcController.php', true,
    'Doctor Earnings gate on all six doctor-callable earnings surfaces; explicit column allowlist in doctorStudentProfile(); per-IP throttle on the two public identifier lookups.'],
  ['src/Controllers/SecurityController.php', 'src/Controllers/SecurityController.php', true,
    'Stops returning SQLSTATE/driver text to clients (generic 500 + protected log); re-throws deliberate ApiExceptions; per-account throttle on /security/events; server-observed ip_address/device_id override client-claimed values.'],
  ['src/Controllers/SecurityEvidenceController.php', 'src/Controllers/SecurityEvidenceController.php', true,
    'Per-account throttles on device-key registration, challenge issuance and evidence submission.'],
  ['src/Controllers/IntegrityController.php', 'src/Controllers/IntegrityController.php', true,
    'Per-account throttles on Play Integrity and App Integrity actions (network-bound / state-creating).'],
  ['src/Controllers/AuthController.php', 'src/Controllers/AuthController.php', true,
    'Per-IP throttles on the two public pre-login identifier endpoints.'],
  ['src/Services/RateLimitService.php', 'src/Services/RateLimitService.php', true,
    'NEW FILE — shared fixed-window rate limiter (reuses the existing rate_limits table; no migration).'],
  ['src/Services/AuthService.php', 'src/Services/AuthService.php', true,
    'Throttles refresh, forgot-password (per-IP + per-hashed-identifier), reset-password and change-password; login/register delegate to RateLimitService with unchanged identifier+operation so live counters are not reset.'],
  ['src/Services/SecurityService.php', 'src/Services/SecurityService.php', true,
    'Normalizes all client-supplied telemetry before insert (clamps risk_score 0..100, whitelists policy_action, bounds free-text, refuses non-array metadata) and stops leaking SQL internals on insert failure.'],
  ['src/Services/AppReleaseService.php', 'src/Services/AppReleaseService.php', true,
    'Publish/rollback failures return a generic message; real detail goes to the protected log with credential-shaped values redacted.'],
  ['src/Services/VideoLibrarySyncService.php', 'src/Services/VideoLibrarySyncService.php', true,
    'Local-reconciliation failure no longer returns driver text to a doctor-reachable route.'],
  ['src/Http/Request.php', 'src/Http/Request.php', false,
    'Documentation only — records the clientIp() trust policy (REMOTE_ADDR, never X-Forwarded-For). No behaviour change.'],
];

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const deploy = [];
const optional = [];
const problems = [];

for (const [local, serverRel, required, change] of ARTIFACTS) {
  const pkgPath = path.join(here, local);
  const srcPath = path.join(backendDir, serverRel);
  if (!fs.existsSync(pkgPath)) { problems.push(`missing package artifact: ${local}`); continue; }
  if (!fs.existsSync(srcPath)) { problems.push(`missing source: backend/${serverRel}`); continue; }
  const pkgHash = sha256(pkgPath);
  const srcHash = sha256(srcPath);
  if (pkgHash !== srcHash) {
    problems.push(`${local} is NOT byte-identical to backend/${serverRel} (pkg ${pkgHash.slice(0, 12)} vs src ${srcHash.slice(0, 12)})`);
    continue;
  }
  const entry = {
    local,
    server_path: `backend/${serverRel}`,
    sha256: pkgHash,
    bytes: fs.statSync(pkgPath).size,
    required,
    change,
    source: `backend/${serverRel} (byte-identical)`,
  };
  (required ? deploy : optional).push(entry);
}

// ── rollback baselines (git HEAD, captured at package build time) ───────────
const rollback = [];
for (const entry of [...deploy, ...optional]) {
  const rbRel = entry.server_path.replace(/^backend\//, '');
  const rbPath = path.join(here, 'rollback', rbRel);
  if (!fs.existsSync(rbPath)) continue; // new file → no baseline (see new_files)
  rollback.push({
    local: `rollback/${rbRel}`,
    server_path: entry.server_path,
    sha256: sha256(rbPath),
    bytes: fs.statSync(rbPath).size,
    provenance: `git HEAD:${entry.server_path} (pre-change baseline)`,
  });
}

const newFiles = deploy
  .filter((e) => !rollback.some((r) => r.server_path === e.server_path))
  .map((e) => ({ server_path: e.server_path, rollback: 'delete the file (it does not exist in the pre-change tree)' }));

if (problems.length) {
  console.error('\nRefusing to write manifest.json:\n');
  for (const p of problems) console.error('  ✗ ' + p);
  console.error('');
  process.exit(1);
}

const manifest = {
  package: '2026-10-08-doctor-earnings-enforcement',
  regenerated: '2026-10-09',
  purpose: 'Doctor Earnings server-side enforcement (all six doctor-callable surfaces) PLUS the backend security-hardening pass: internal-error disclosure removed, cross-user profile response minimized, and rate limiting added to abuse-prone endpoints.',
  supersedes: 'The original 2026-10-08 single-file artifact (RpcController.php only). Same target and same gate semantics; additional files carry the security-hardening changes from the same working tree.',
  target: {
    api_base: 'https://api.medacademy.site',
    document_root: 'backend/public',
    upload_root: 'backend/',
  },
  layout: 'Package mirrors the server tree: src/<...> maps 1:1 onto backend/src/<...>.',
  files: { deploy, deploy_optional: optional, rollback, new_files: newFiles },
  database_changes: [],
  env_changes: [],
  env_optional_keys_documented_in: 'ENV-CONFIG.md',
  routes_touched: [
    'GET  /rpc/doctor-activity-stats/{doctorId}',
    'GET  /rpc/doctor-credit-transactions/{doctorId}',
    'GET  /rpc/doctor-earnings-dashboard/{doctorId}',
    'POST /rpc/doctor-student-profile',
    'POST /rpc/set-enrollment-assigned-price',
    'POST /rpc/remove-student-and-record-earnings',
    'POST /rpc/check-registration-conflicts',
    'POST /rpc/get-email-by-phone',
    'POST /auth/lookup',
    'POST /auth/pre-login-check',
    'POST /auth/refresh',
    'POST /auth/forgot-password',
    'POST /auth/reset-password',
    'POST /auth/change-password',
    'POST /security/events',
    'POST /security/violations',
    'POST /security/device-keys',
    'POST /security/challenge',
    'POST /security/evidence',
    'POST /integrity/play',
    'POST /integrity/app',
  ],
  scripts: {
    generate_manifest: 'node gen-manifest.cjs',
    preflight: 'node preflight.cjs',
    verify_live: 'node verify-live.cjs',
  },
};

fs.writeFileSync(path.join(here, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json written — ${deploy.length} required, ${optional.length} optional, ${rollback.length} rollback baselines, ${newFiles.length} new file(s).`);
