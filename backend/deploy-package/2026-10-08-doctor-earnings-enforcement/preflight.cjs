#!/usr/bin/env node
/**
 * preflight.cjs — run BEFORE uploading anything. Exit 0 = safe to upload.
 *
 * This is a SUPERSET of the original single-file guard: every Doctor Earnings
 * check that gated the 2026-10-08 artifact is still here (listed under
 * "── earnings gate ──"), plus package-wide checks for the security-hardening
 * files that now travel with it.
 *
 *   cd backend/deploy-package/2026-10-08-doctor-earnings-enforcement
 *   node preflight.cjs
 *
 * Nothing here is relaxed to make a build pass. If a check fails, fix the
 * source or regenerate the package — do not edit the guard.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const here = __dirname;
const backendDir = path.resolve(here, '..', '..'); // D:\v3\backend

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
}
function section(title) {
  results.push({ section: title });
}

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const lf = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const read = (f) => lf(f);

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
} catch (e) {
  console.error('\nCannot read manifest.json — run `node gen-manifest.cjs` first.\n' + e.message);
  process.exit(1);
}

const artifacts = [...manifest.files.deploy, ...manifest.files.deploy_optional];
const pkgPathOf = (entry) => path.join(here, entry.local);
const srcPathOf = (entry) => path.join(backendDir, entry.server_path.replace(/^backend\//, ''));

// ══════════════════════════════════════════════════════════════════════════
// 1. Every artifact exists and is byte-identical to the authoritative source
// ══════════════════════════════════════════════════════════════════════════
section('artifact integrity');

let fatal = false;
for (const entry of artifacts) {
  const pkg = pkgPathOf(entry);
  const src = srcPathOf(entry);
  if (!fs.existsSync(pkg)) { check('file exists: ' + entry.local, false); fatal = true; continue; }
  if (!fs.existsSync(src)) { check('source exists: ' + entry.server_path, false); fatal = true; continue; }
  const pkgHash = sha256(pkg);
  const srcHash = sha256(src);
  const short = entry.server_path.replace('backend/src/', '');
  check(`byte-identical to source: ${short}`, pkgHash === srcHash,
    `pkg ${pkgHash.slice(0, 12)} / src ${srcHash.slice(0, 12)}`);
  check(`hash matches manifest.json: ${short}`, pkgHash === entry.sha256,
    pkgHash === entry.sha256 ? '' : `manifest ${entry.sha256.slice(0, 12)}`);
}
check('required artifact count is the expected 10 + 1 optional',
  artifacts.length === 11 && manifest.files.deploy.length === 10 && manifest.files.deploy_optional.length === 1,
  `required ${manifest.files.deploy.length}, optional ${manifest.files.deploy_optional.length}`);

if (fatal) { report(); process.exit(1); }

// ══════════════════════════════════════════════════════════════════════════
// 2. Rollback baselines are real, complete and different from the artifacts
// ══════════════════════════════════════════════════════════════════════════
section('rollback baselines');

for (const rb of manifest.files.rollback) {
  const f = path.join(here, rb.local);
  if (!fs.existsSync(f)) { check('rollback exists: ' + rb.local, false); continue; }
  const h = sha256(f);
  check(`rollback hash matches manifest: ${rb.server_path.replace('backend/src/', '')}`, h === rb.sha256,
    h === rb.sha256 ? '' : `file ${h.slice(0, 12)}`);
  const deployEntry = artifacts.find((a) => a.server_path === rb.server_path);
  check(`rollback differs from the artifact it reverses: ${rb.server_path.replace('backend/src/', '')}`,
    !deployEntry || h !== deployEntry.sha256);
}
check('every rollback baseline maps to a packaged artifact',
  manifest.files.rollback.every((rb) => artifacts.some((a) => a.server_path === rb.server_path)),
  `${manifest.files.rollback.length} baselines / ${artifacts.length} artifacts`);
check('new files are declared with a delete-on-rollback instruction',
  manifest.files.new_files.length === 1 &&
  manifest.files.new_files[0].server_path === 'backend/src/Services/RateLimitService.php' &&
  /delete/i.test(manifest.files.new_files[0].rollback || ''),
  JSON.stringify(manifest.files.new_files.map((n) => n.server_path)));

// ══════════════════════════════════════════════════════════════════════════
// 3. PHP 8 grammar parse + copy hygiene, for artifacts AND rollbacks
// ══════════════════════════════════════════════════════════════════════════
section('php grammar + copy hygiene');

const parser = require(path.join(path.resolve(backendDir, '..'), 'node_modules', 'php-parser'));
function parses(file) {
  try {
    const engine = new parser.Engine({ parser: { extractDoc: false, php7: true }, ast: { withPositions: true } });
    engine.parseCode(read(file), path.basename(file));
    return { ok: true, detail: '' };
  } catch (e) {
    return { ok: false, detail: String(e && e.message ? e.message : e).split('\n')[0] };
  }
}

for (const entry of artifacts) {
  const f = pkgPathOf(entry);
  const p = parses(f);
  const short = entry.server_path.replace('backend/src/', '');
  check(`parses with the PHP 8 grammar: ${short}`, p.ok, p.detail);
  const raw = fs.readFileSync(f);
  check(`no UTF-8 BOM: ${short}`, !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf));
  check(`opens with <?php: ${short}`, raw.slice(0, 5).toString() === '<?php');
  check(`declares strict_types: ${short}`, read(f).includes('declare(strict_types=1);'));
}
for (const rb of manifest.files.rollback) {
  const p = parses(path.join(here, rb.local));
  check(`rollback parses with the PHP 8 grammar: ${rb.server_path.replace('backend/src/', '')}`, p.ok, p.detail);
}

// ══════════════════════════════════════════════════════════════════════════
// 4. ── earnings gate ── (preserved verbatim from the 2026-10-08 guard)
// ══════════════════════════════════════════════════════════════════════════
section('earnings gate');

const rpcEntry = artifacts.find((a) => a.server_path === 'backend/src/Controllers/RpcController.php');
const deployTxt = read(pkgPathOf(rpcEntry));

const GATED_METHODS = [
  'doctorActivityStats',
  'doctorCreditTransactions',
  'doctorEarningsDashboard',
  'doctorStudentProfile',
  'setEnrollmentAssignedPrice',
  'removeStudentAndRecordEarnings',
];

const methodBodies = (() => {
  const out = {};
  const re = /public function ([A-Za-z0-9_]+)\(Request \$request\)/g;
  const hits = [];
  let m;
  while ((m = re.exec(deployTxt)) !== null) hits.push({ name: m[1], start: m.index });
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : deployTxt.length;
    out[hits[i].name] = deployTxt.slice(hits[i].start, end);
  }
  return out;
})();

for (const name of GATED_METHODS) {
  const body = methodBodies[name];
  check(`gate present in ::${name}()`, body !== undefined && body.includes('assertDoctorEarningsEnabled($request)'),
    body === undefined ? 'method not found' : '');
}

const totalGates = (deployTxt.match(/assertDoctorEarningsEnabled\(\$request\);/g) || []).length;
check('exactly 6 gate call sites (one per surface)', totalGates === 6, `found ${totalGates}`);

check('helper is staff-exempt (admin/super_admin keep access)',
  /assertDoctorEarningsEnabled\(Request \$request\): void\s*\{[^}]*super_admin[^}]*\}/s.test(deployTxt));
check('helper calls assertEnabledFor (honours per-user override), not assertEnabled',
  /assertDoctorEarningsEnabled\(Request \$request\): void[\s\S]{0,600}?assertEnabledFor\('doctor_earnings'/.test(deployTxt));
check("flag key is the canonical 'doctor_earnings'", deployTxt.includes("'doctor_earnings'"));

const rser = methodBodies['removeStudentAndRecordEarnings'] || '';
const gateIdx = rser.indexOf('assertDoctorEarningsEnabled($request)');
const firstWriteIdx = Math.min(
  ...[rser.indexOf('->query('), rser.indexOf('->insert('), rser.indexOf('->update(')]
    .filter((i) => i >= 0).concat([Number.MAX_SAFE_INTEGER]),
);
check('removeStudentAndRecordEarnings gate runs before any DB write', gateIdx >= 0 && gateIdx < firstWriteIdx);

const helperSrc = (deployTxt.match(/private function assertDoctorEarningsEnabled[\s\S]*?\n    \}/) || [''])[0];
check('gate helper performs no DB write', helperSrc !== '' && !/->(insert|update|query|delete)\(/.test(helperSrc));

check('rollback RpcController has NO assertDoctorEarningsEnabled helper (pre-fix baseline)',
  !read(path.join(here, 'rollback/src/Controllers/RpcController.php')).includes('assertDoctorEarningsEnabled'));

// ══════════════════════════════════════════════════════════════════════════
// 5. Internal error text can never reach a client, in ANY packaged file
// ══════════════════════════════════════════════════════════════════════════
section('internal-error disclosure');

const LEAKS = [
  { re: /'DB error \[/, label: 'SQLSTATE interpolated into an ApiException message' },
  { re: /'Exception \[/, label: 'exception class interpolated into an ApiException message' },
  { re: /\$sqlState\b/, label: 'SQLSTATE variable still composed for a response' },
  { re: /'Publish failed: '/, label: 'publish failure returns driver text' },
  { re: /'Rollback failed: '/, label: 'rollback failure returns driver text' },
  { re: /'Local reconciliation failed: '/, label: 'reconciliation failure returns driver text' },
];

for (const entry of artifacts) {
  const short = entry.server_path.replace('backend/src/', '');
  const txt = read(pkgPathOf(entry));
  for (const leak of LEAKS) {
    check(`no leaked internals (${leak.label}): ${short}`, !leak.re.test(txt));
  }
  // ApiException(...) must never be constructed from an exception message/code.
  const apiEx = /new ApiException\(([\s\S]{0,600}?)\);/g;
  let m;
  let bad = 0;
  let sample = '';
  while ((m = apiEx.exec(txt)) !== null) {
    const args = m[1];
    if (/getMessage\(\)|getCode\(\)|\$sqlState|\$msg\b/.test(args)) {
      bad++;
      if (!sample) sample = args.replace(/\s+/g, ' ').slice(0, 70);
    }
  }
  check(`no ApiException() built from an exception message/code: ${short}`, bad === 0,
    bad ? `${bad} site(s), e.g. (${sample}…)` : '');
}

// The generic contract replaced the leak in the two SecurityController paths.
const secEntry = artifacts.find((a) => a.server_path === 'backend/src/Controllers/SecurityController.php');
const secTxt = read(pkgPathOf(secEntry));
check("SecurityController returns the generic code 'internal_error'", secTxt.includes("'internal_error'"));
check('SecurityController logs detail server-side (logInternalFailure helper present)',
  /private static function logInternalFailure\(/.test(secTxt));
check('SecurityController re-throws deliberate ApiExceptions untouched',
  (secTxt.match(/catch \(ApiException \$e\) \{\s*(\/\/[^\n]*\n\s*)*throw \$e;/g) || []).length >= 2,
  `${(secTxt.match(/catch \(ApiException \$e\)/g) || []).length} ApiException catch block(s)`);
check('SecurityController still redacts credential-shaped values before logging',
  /password\|passwd\|secret\|token/.test(secTxt));
check('SecurityController binds ip_address to the socket peer (client cannot write arbitrary IPs)',
  /\$event\['ip_address'\] = \$request->clientIp\(\);/.test(secTxt));
check('SecurityController prefers the JWT-bound device_id over the client value',
  /\$event\['device_id'\] = \$sessionDevice;/.test(secTxt));

// ══════════════════════════════════════════════════════════════════════════
// 6. Cross-user profile response is an explicit allowlist, not SELECT *
// ══════════════════════════════════════════════════════════════════════════
section('cross-user profile minimization');

const dsp = methodBodies['doctorStudentProfile'] || '';
/** Drop PHP comments so prose that NAMES a removed column is not read as code. */
const stripPhpComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');
const dspCode = stripPhpComments(dsp);

check('doctorStudentProfile no longer runs SELECT * on profiles', !/SELECT \* FROM profiles/.test(dspCode));
check('doctorStudentProfile selects an explicit column list from profiles',
  /SELECT id, email, full_name, phone, role, status, watermark_id, avatar_url/.test(dspCode));
check('doctorStudentProfile no longer returns a credits block', !/'credits'\s*=>/.test(dspCode));
check('doctorStudentProfile no longer returns a devices block', !/'devices'\s*=>/.test(dspCode));
check('doctorStudentProfile no longer queries the credits table', !/FROM credits/.test(dspCode));
for (const dropped of ['suspension_reason', 'phone_original', 'trashed_at', 'security_version', 'credit_selling_price']) {
  check(`sensitive column not selected in doctorStudentProfile: ${dropped}`, !dspCode.includes(dropped));
}
check('no other SELECT * remains on profiles in RpcController',
  !/SELECT \* FROM profiles/.test(stripPhpComments(deployTxt)),
  `${(stripPhpComments(deployTxt).match(/SELECT \* FROM profiles/g) || []).length} occurrence(s)`);

// Columns named in the allowlist must exist in BOTH shipped schemas, or the
// route would 500 on one of them. Anchor on the exact profiles statement so an
// earlier SELECT in the method cannot bleed into the captured column list.
// `[^']` (not `[\s\S]`) so the capture cannot cross a closing quote into an
// earlier SQL string literal in the same method.
const allowMatch = dspCode.match(/'SELECT\s+([^']*?)\s+FROM profiles\s+WHERE id = \?'/);
check('doctorStudentProfile allowlist query located', !!allowMatch);
const allowCols = (allowMatch ? allowMatch[1] : '')
  .split(',')
  .map((c) => c.trim().replace(/[\s\n]+/g, ' '))
  .filter(Boolean);
for (const schema of ['schema.sql', 'schema-no-triggers.sql']) {
  const schemaPath = path.join(backendDir, 'database', schema);
  if (!fs.existsSync(schemaPath)) { check(`schema available: ${schema}`, false); continue; }
  const txt = read(schemaPath);
  const block = (txt.match(/CREATE TABLE IF NOT EXISTS `profiles` \(([\s\S]*?)\n\) ENGINE/) || [])[1] || '';
  const cols = new Set(
    block.split('\n').map((l) => (l.match(/^\s*`([A-Za-z0-9_]+)`/) || [])[1]).filter(Boolean),
  );
  const unknown = allowCols.filter((c) => !cols.has(c));
  check(`allowlisted columns exist in ${schema}`, cols.size > 0 && unknown.length === 0,
    unknown.length ? `unknown: ${unknown.join(', ')}` : `${allowCols.length} columns verified`);
}

// ══════════════════════════════════════════════════════════════════════════
// 7. RateLimitService contract + identity/trust semantics
// ══════════════════════════════════════════════════════════════════════════
section('rate limiting');

const rlEntry = artifacts.find((a) => a.server_path === 'backend/src/Services/RateLimitService.php');
check('RateLimitService.php is part of the deploy set', !!rlEntry);
const rlTxt = read(pkgPathOf(rlEntry));
check('reuses the existing rate_limits table (no migration)',
  /INSERT INTO rate_limits \(id, identifier, operation, window_start, request_count\)/.test(rlTxt) &&
  /ON DUPLICATE KEY UPDATE request_count = request_count \+ 1/.test(rlTxt));
check('refuses with HTTP 429 + code rate_limited', /new ApiException\(429, .*'rate_limited'\)/.test(rlTxt));
check('fail-safe: a non-positive limit disables the limiter instead of locking everyone out',
  /if \(\$max <= 0 \|\| \$windowSeconds <= 0\)/.test(rlTxt));
check('perAccount() falls back to the IP only when anonymous', /function perAccount\(Request \$request[\s\S]{0,400}?userId !== ''/.test(rlTxt));
check('legacy() keeps operation=auth so a deploy cannot reset live counters',
  /function legacy\([\s\S]{0,300}?self::hit\('auth'/.test(rlTxt));
check('AuthService delegates to RateLimitService::legacy (single implementation)',
  /RateLimitService::legacy\(\$identifier, \$max, \$windowSeconds\);/.test(read(pkgPathOf(artifacts.find((a) => a.server_path === 'backend/src/Services/AuthService.php')))));

// Callers must all be packaged, or the server would reference a class it does
// not have / silently keep an unthrottled path.
const callers = (() => {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.php') && fs.readFileSync(p, 'utf8').includes('RateLimitService')) {
        out.push(path.relative(backendDir, p).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(backendDir, 'src'));
  return out;
})();
const packagedServerPaths = new Set(artifacts.map((a) => a.server_path.replace(/^backend\//, '')));
const unpackagedCallers = callers.filter((c) => !packagedServerPaths.has(c));
check('every file referencing RateLimitService is in this package', unpackagedCallers.length === 0,
  unpackagedCallers.length ? `missing: ${unpackagedCallers.join(', ')}` : `${callers.length} caller(s) packaged`);

// ══════════════════════════════════════════════════════════════════════════
// 8. Client-IP trust policy: forwarded headers are never honoured by default
// ══════════════════════════════════════════════════════════════════════════
section('rate-limit bucket identity trust');

const reqTxt = read(pkgPathOf(artifacts.find((a) => a.server_path === 'backend/src/Http/Request.php')));
const clientIpBody = (reqTxt.match(/function clientIp\(\): string\s*\{([\s\S]*?)\n    \}/) || ['', ''])[1];
check('clientIp() reads REMOTE_ADDR', /return \$_SERVER\['REMOTE_ADDR'\]/.test(clientIpBody));
check("clientIp() does NOT read X-Forwarded-For", !/X_FORWARDED|HTTP_X_FORWARDED|Forwarded/i.test(clientIpBody));
check('clientIp() does not read any other spoofable header',
  !/HTTP_[A-Z_]*FORWARDED|HTTP_CLIENT_IP|HTTP_X_REAL_IP|CF_CONNECTING_IP/i.test(clientIpBody));
check('the trust policy is documented in-code (proxies must be explicitly validated)',
  /trusted proxy/i.test(reqTxt));
check('no packaged file falls back to a client-supplied IP header',
  !artifacts.some((a) => /HTTP_X_FORWARDED_FOR|CF_CONNECTING_IP|HTTP_X_REAL_IP/.test(read(pkgPathOf(a)))));

// ══════════════════════════════════════════════════════════════════════════
// 9. Referenced classes resolve to files that exist in the package/source
// ══════════════════════════════════════════════════════════════════════════
section('dependency completeness');

for (const entry of artifacts) {
  const txt = read(pkgPathOf(entry));
  const short = entry.server_path.replace('backend/src/', '');
  const uses = [...txt.matchAll(/^use (MedAcademy\\[A-Za-z0-9_\\]+);/gm)].map((m) => m[1]);
  const missing = uses
    .map((fqcn) => fqcn.replace(/^MedAcademy\\/, '').replace(/\\/g, '/') + '.php')
    .filter((rel) => !fs.existsSync(path.join(backendDir, 'src', rel)));
  check(`all MedAcademy imports resolve: ${short}`, missing.length === 0, missing.join(', '));
}
const referencedNew = artifacts.map((a) => a.server_path.replace(/^backend\//, ''));
check('the new class introduced by this pass is only referenced by packaged files',
  unpackagedCallers.length === 0,
  `packaged: ${referencedNew.filter((p) => p.startsWith('src/Services/RateLimit')).join(', ') || 'n/a'}`);

// ══════════════════════════════════════════════════════════════════════════
// 9b. No packaged file depends on a backend file that changed but is NOT here
// ══════════════════════════════════════════════════════════════════════════
section('deployment completeness (no omitted dependency)');

// Files under backend/src that are already known to belong to a DIFFERENT,
// separately-deployed feature (Support Contact settings). They are intentionally
// NOT part of this package; listing them here means any *new* changed file
// forces an explicit decision instead of slipping through unnoticed.
const EXPECTED_UNRELATED = [
  'src/Controllers/AnalyticsController.php',
  'src/Controllers/DataController.php',
  'src/Controllers/StorageController.php',
  'src/Controllers/SupportController.php',
];

const packagedRel = new Set(artifacts.map((a) => a.server_path.replace(/^backend\//, '')));
let changedUnderSrc = null;
try {
  const { execFileSync } = require('child_process');
  const raw = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'src'],
    { cwd: backendDir, encoding: 'utf8' });
  changedUnderSrc = raw
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .map((p) => p.replace(/^backend\//, ''));
} catch (e) {
  check('git status is readable (required to prove nothing was omitted)', false,
    String(e && e.message ? e.message : e).split('\n')[0]);
}

if (changedUnderSrc) {
  const unpackagedModified = changedUnderSrc.filter((p) => !packagedRel.has(p));
  const unexpected = unpackagedModified.filter((p) => !EXPECTED_UNRELATED.includes(p));
  check('every changed backend/src file is either packaged or a known unrelated feature',
    unexpected.length === 0,
    unexpected.length ? `unaccounted: ${unexpected.join(', ')}` : `unrelated (not packaged): ${unpackagedModified.join(', ') || 'none'}`);

  // The real safety property: nothing we ship may depend on a file that changed
  // in this working tree but is missing from the package.
  const depsOf = (txt) => [...txt.matchAll(/^use (MedAcademy\\[A-Za-z0-9_\\]+);/gm)]
    .map((m) => 'src/' + m[1].replace(/^MedAcademy\\/, '').replace(/\\/g, '/') + '.php');
  const offenders = [];
  let depEdges = 0;
  for (const a of artifacts) {
    const deps = depsOf(read(pkgPathOf(a)));
    depEdges += deps.length;
    for (const dep of deps) {
      if (unpackagedModified.includes(dep)) offenders.push(`${a.server_path.replace('backend/', '')} → ${dep}`);
    }
  }
  // The edge count is reported so this guard is visibly non-vacuous: if the
  // import scan ever silently matched nothing, depEdges would be 0 here.
  check('no packaged file depends on a changed-but-unpackaged backend file',
    offenders.length === 0 && depEdges > 0,
    `checked ${depEdges} dependency edge(s) against ${unpackagedModified.length} unpackaged change(s)` +
      (offenders.length ? '; offenders: ' + offenders.join('; ') : ''));
}

// ══════════════════════════════════════════════════════════════════════════
// 10. ENV-CONFIG.md documents every tunable, with the shipped default
// ══════════════════════════════════════════════════════════════════════════
section('configuration reference');

const cfgPath = path.join(here, 'ENV-CONFIG.md');
check('ENV-CONFIG.md exists', fs.existsSync(cfgPath));
if (fs.existsSync(cfgPath)) {
  const doc = fs.readFileSync(cfgPath, 'utf8');
  const inCode = new Map();
  for (const entry of artifacts) {
    for (const m of read(pkgPathOf(entry)).matchAll(/Config::int\('(RATE_LIMIT_[A-Z0-9_]+)',\s*(\d+)\)/g)) {
      if (!inCode.has(m[1])) inCode.set(m[1], m[2]);
    }
  }
  const inDoc = new Map();
  for (const m of doc.matchAll(/\|\s*`(RATE_LIMIT_[A-Z0-9_]+)`\s*\|\s*(\d+)\s*\|/g)) inDoc.set(m[1], m[2]);

  const undocumented = [...inCode.keys()].filter((k) => !inDoc.has(k));
  const extra = [...inDoc.keys()].filter((k) => !inCode.has(k));
  const mismatched = [...inCode.keys()].filter((k) => inDoc.has(k) && inDoc.get(k) !== inCode.get(k));

  check('every RATE_LIMIT_* key in code is documented', undocumented.length === 0, undocumented.join(', '));
  check('no key documented that the code does not read', extra.length === 0, extra.join(', '));
  check('documented default matches the shipped default', mismatched.length === 0,
    mismatched.map((k) => `${k}: doc ${inDoc.get(k)} vs code ${inCode.get(k)}`).join('; '));
  check('the config reference is key/optional-only (no secrets template)',
    !/(SECRET|PASSWORD|API_KEY|TOKEN)\s*=\s*\S+/i.test(doc));
  check(`all ${inCode.size} tunables are documented`, inCode.size >= 13, `${inCode.size} found, ${inDoc.size} documented`);
}

report();

// ─────────────────────────────────────────────────────────────────────────────

function report() {
  let failed = 0;
  let total = 0;
  console.log('\n── preflight: Doctor Earnings enforcement + security-hardening package ──\n');
  for (const r of results) {
    if (r.section) { console.log(`\n  ── ${r.section} ──`); continue; }
    total++;
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
  }
  console.log('');
  for (const entry of artifacts) {
    console.log(`  ${entry.required ? 'deploy  ' : 'optional'} ${entry.sha256}  ${entry.server_path}`);
  }
  for (const rb of manifest.files.rollback) {
    console.log(`  rollback ${rb.sha256}  ${rb.server_path}`);
  }
  console.log(`\n  ${total - failed}/${total} checks passed\n`);
  if (failed) {
    console.log('  RESULT: DO NOT UPLOAD — fix the failures above.\n');
    process.exitCode = 1;
  } else {
    console.log('  RESULT: safe to upload the 10 required artifacts (mirroring src/ onto backend/) to api.medacademy.site');
    console.log('  Optional: src/Http/Request.php (documentation only — no behaviour change).');
    console.log('  Do NOT upload rollback/ or gen-manifest.cjs / preflight.cjs / verify-live.cjs.\n');
    console.log('  Next: upload, then run `node verify-live.cjs` with SUPERADMIN_* / DOCTOR_* credentials.\n');
  }
}
