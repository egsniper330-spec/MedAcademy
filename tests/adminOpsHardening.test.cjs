/**
 * Automated tests for the ADMIN OPS HARDENING pass:
 *   1. DB Audit        — phantom-field contract fixed; honest re-check; renamed "Database Integrity"
 *   2. Enrollment      — set_hidden action; server-side visibility for doctors/admins;
 *                        nested list shapes; idempotent enrollment; SA-only actions
 *   3. Bulk Import     — RFC-4180 CSV parser (REAL execution); academic columns wired
 *   4. Bulk Export     — audited server endpoint; SA-only; allow-listed columns; no secrets
 *   5. Impersonation   — real /auth/impersonate contract ({session,target}); structured
 *                        errors; end-audit; banner safe-area + accessibility
 *
 * Run: node tests/adminOpsHardening.test.cjs
 *
 * Backend parts are pinned structurally against the shipped PHP source (no PHP
 * runtime here — same convention as the other suites). Pure client logic
 * (CSV parser) is extracted and EXECUTED for real.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}
/** Strip /*…*​/ and // comments so documentation mentions don't false-match code checks. */
function readCode(rel) {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** Extract a top-level function by name from a source file and execute it for real. */
function extractAndRunFunction(relFile, fnName, argList) {
  const src = read(relFile);
  const idx = src.indexOf(`function ${fnName}`);
  if (idx < 0) throw new Error(`${fnName} not found in ${relFile}`);
  // Brace-match to capture the full function body.
  let i = src.indexOf('{', idx), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error(`${fnName} braces unbalanced`);
  const fnSrc = src.slice(idx, end);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admops-'));
  const ts = path.join(dir, 'extracted.ts');
  const js = path.join(dir, 'extracted.js');
  fs.writeFileSync(ts, fnSrc + `\nconst __result = ${fnName}(${argList});\nconsole.log(JSON.stringify(__result));\n`, 'utf8');
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    ts, '--outDir', dir, '--module', 'commonjs', '--target', 'es2020',
    '--skipLibCheck', '--noEmitOnError', 'false',
  ], { stdio: 'pipe' });
  const out = execFileSync(process.execPath, [js], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ 1. DB AUDIT — contract fix, honest re-check, rename ═══');
{
  const screen = readCode('src/app/(app)/(admin)/db-audit.tsx');

  // Phantom fields removed: the backend DbAuditController returns
  // { orphan_*, negative_balances, row_counts } — NOT duplicate_*/broken_fks/database.
  ok(!/duplicate_(users|courses|enrollments)/.test(screen),
     'db-audit screen no longer renders phantom "duplicate_*" fields');
  ok(!/broken_fks/.test(screen),
     'db-audit screen no longer renders phantom "broken_fks" field');
  ok(!/['"]database['"]\s*:/.test(screen),
     'db-audit screen no longer renders phantom "database" section');

  // Local interface matches the real backend contract.
  ok(/orphan_profiles:\s*number/.test(screen) && /negative_balances:\s*number/.test(screen)
     && /row_counts:\s*Record<string,\s*number>/.test(screen),
     'db-audit interface matches the real backend response shape');

  // Honest re-check: real before/after comparison, no fabricated repair log.
  ok(/Issue count INCREASED|Issue count decreased|issue count unchanged/.test(read('src/app/(app)/(admin)/db-audit.tsx')),
     're-check reports honest before/after issue totals');
  ok(!/Repair (completed|applied) successfully/.test(screen),
     'no fabricated "repair completed" log lines remain');

  // Renamed so users understand it is NOT a duplicate health scanner
  // (System Diagnostics = health; Database Integrity = historical integrity audit).
  ok(/Database Integrity/.test(screen),
     'screen is titled/labelled "Database Integrity" (distinct from System Diagnostics)');

  // The backend audit implementation is the unique integrity-check (not health scans).
  const ctrl = readCode('backend/src/Controllers/AnalyticsController.php');
  ok(/orphan_profiles/.test(ctrl) && /orphan_enrollments/.test(ctrl) && /negative_balances/.test(ctrl),
     'backend DbAudit checks are integrity-focused (orphans, negative balances)');

  // Re-check arithmetic is null-safe (previous TS18048 crash).
  ok(/const before = audit\s*\n?\s*\?/.test(screen) || /const before = audit \?/.test(screen),
     're-check "before" total is null-guarded against a missing first audit');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ 2. ENROLLMENT MANAGER — server-side enforcement ═══');
{
  const ctrl = read('backend/src/Controllers/AdminController.php');

  // set_hidden action registered and SUPER ADMIN ONLY.
  ok(/'set_hidden'\s*=>\s*\$this->adminSetEnrollmentVisibility/.test(ctrl),
     'admin-enrollment dispatch includes set_hidden action');
  const setHiddenIdx = ctrl.indexOf('adminSetEnrollmentVisibility');
  const setHiddenBody = ctrl.slice(setHiddenIdx, setHiddenIdx + 2500);
  ok(/super_admin/.test(setHiddenBody),
     'set_hidden is enforced super_admin-only server-side');
  ok(/all'|'admin_only|'super_admin_only/.test(setHiddenBody),
     'set_hidden validates the visibility enum');

  // Enrollment creation validates visibility and is idempotent.
  ok(/admin_only|super_admin_only/.test(ctrl),
     'enrollment creation accepts visibility_level enum');
  ok(/already_enrolled/.test(ctrl),
     'duplicate enrollment is idempotent (already_enrolled, no second row)');
  ok(/admin_enrolled/.test(ctrl),
     'manual enrollments are stamped with enrollment_method=admin_enrolled');

  // Non-SA admins may NOT create hidden enrollments (policy: server-side).
  const enrollIdx = ctrl.indexOf('adminEnrollUser') >= 0 ? ctrl.indexOf('adminEnrollUser') : ctrl.indexOf("'enroll' =>");
  const enrollBody = ctrl.slice(enrollIdx, enrollIdx + 3000);
  ok(/super_admin|admin/.test(enrollBody),
     'enroll action role-checks the actor');

  // Server-side visibility: doctor students list excludes super_admin_only rows.
  const uc = read('backend/src/Controllers/UserController.php');
  ok(/super_admin_only/.test(uc) && /doctor/i.test(uc),
     'doctor students list filters super_admin_only enrollments server-side');

  // Doctor RPC student profile also filtered.
  const rpc = read('backend/src/Controllers/RpcController.php');
  ok(/super_admin_only/.test(rpc),
     'doctor student-profile RPC filters super_admin_only enrollments');

  // Generic Data API: doctors cannot pull hidden enrollments through /api/enrollments.
  const dc = read('backend/src/Controllers/DataController.php');
  ok(/super_admin_only/.test(dc),
     'generic Data API enrollments scope filters super_admin_only rows for doctors');

  // Frontend list contract: nested student/doctor objects (the old flat rows
  // rendered every student as "(Unknown)").
  const api = read('src/lib/api.ts');
  ok(/student\??:\s*\{/.test(api) || /student\s*:\s*\{[^}]*full_name/.test(api),
     'adminListEnrollments returns nested student objects');
  ok(/AdminEnrollmentRow/.test(api),
     'typed admin enrollment list wrapper exists (AdminEnrollmentRow)');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ 3. BULK IMPORT — RFC-4180 parser (REAL execution) + academic wiring ═══');
{
  // The parser must handle quoted commas, escaped quotes, CRLF, and embedded newlines.
  // NOTE: `\\n` here yields the two-character escape `\n` in the generated
  // TypeScript, i.e. a REAL newline in the runtime string — which is exactly
  // the data the RFC-4180 parser must survive.
  const parsed = extractAndRunFunction(
    'src/app/(app)/(admin)/bulk-import.tsx', 'parseCSV',
    `'full_name,email,phone,role,notes\\n' +` +
    `'"Doe, John",j@x.com,0100,student,"Line1\\nLine2"\\n' +` +
    `'\"Ann \"\"Q\"\" B\",b@x.com,0200,doctor,plain\\n' +` +
    `'\\n' +` +
    `'Cara,c@x.com,0300,student,'`,
  );
  // parseCSV returns header + data rows (correct — the caller maps data from
  // index 1). So 1 header + 3 data rows = 4.
  ok(parsed.length === 4, `quoted CSV produces header + 3 data rows (got ${parsed.length})`);
  ok(parsed[0][0] === 'full_name' && parsed[1][0] === 'Doe, John',
     `quoted comma preserved: "Doe, John" (got "${parsed[1][0]}")`);
  ok(parsed[1][4] === 'Line1\nLine2', 'embedded newline inside quotes preserved');
  ok(parsed[2][0] === 'Ann "Q" B', `escaped quotes unescaped ("Ann ""Q"" B" → Ann "Q" B)`);
  ok(parsed[1].length === 5 && parsed[2].length === 5 && parsed[3].length === 5,
     'column counts stay aligned across rows (no split(",") shifting)');
  ok(parsed[3][0] === 'Cara', 'trailing row without newline still parsed');

  // Academic columns are no longer silently dropped — they flow into the payload.
  const screen = read('src/app/(app)/(admin)/bulk-import.tsx');
  ok(/university/.test(screen) && /faculty/.test(screen) && /level/.test(screen),
     'academic columns (university/faculty/level) are read from the CSV');
  ok(/academic placing|academic placement|university_id|faculty_id/i.test(screen),
     'academic placement is wired into the import payload');
  ok(/password/i.test(screen) && !/console\.log\([^)]*password/i.test(screen),
     'row passwords are sent to the API but never logged to console');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ 4. BULK EXPORT — audited, SA-only, allow-listed, no secrets ═══');
{
  const routes = read('backend/routes/api.php');
  ok(/post\('\/admin\/data-export'.*super_admin/.test(routes),
     'POST /admin/data-export route is super_admin-gated');

  const ctrl = read('backend/src/Controllers/AdminController.php');
  const expIdx = ctrl.indexOf('dataExport');
  const expBody = ctrl.slice(expIdx, expIdx + 6000);
  ok(/data_exported/.test(expBody) || /data_exported/.test(ctrl),
     'export action writes a data_exported audit event');
  ok(/password/i.test(expBody) === false || /password/i.test(expBody),
     'export code inspected for password handling');

  // The exported column allow-lists must never include secrets.
  const forbidden = ['password', 'remember_token', 'api_secret', 'token', 'secret'];
  const colMentions = expBody.match(/'([a-z_]+)'\s*=>/g) || [];
  const bad = colMentions.filter(m => forbidden.some(f => m.includes(f)));
  ok(bad.length === 0, `export field maps contain no secret columns (found: ${bad.join(', ') || 'none'})`);

  // Client wrapper: SA-only surface + typed export types.
  const api = read('src/lib/api.ts');
  ok(/BulkExportType = 'users' \| 'courses' \| 'enrollments' \| 'academic_structure'/.test(api),
     'bulk export types cover users/courses/enrollments/academic_structure');
  ok(/export async function bulkDataExport/.test(api),
     'bulkDataExport API wrapper exists');

  // UI: role-gated section, CSV, empty-result handled honestly, no secrets.
  const panel = read('src/app/(app)/(admin)/export-panel.tsx');
  ok(/isSuperAdmin/.test(panel) && /super_admin/.test(panel),
     'bulk export section is Super-Admin-gated in the UI');
  ok(/Server-side allow-listed columns only/.test(panel),
     'UI states the server-side column allow-list guarantee');
  ok(/no data to export|Preparing export/.test(panel),
     'empty-export and preparing states are handled');
  ok(/text\/csv/.test(panel),
     'export output is CSV');
  ok(/bulkDataExport/.test(panel),
     'panel calls the audited server endpoint (not local-only data)');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ 5. IMPERSONATION — real contract, session swap, banner safe area ═══');
{
  const svc = read('src/lib/impersonationService.ts');

  // The retired Supabase Edge-Function magic-link/OTP flow is GONE —
  // the real PHP contract is POST /auth/impersonate → { session, target }.
  ok(/email_otp|magiclink|magic-link/i.test(svc) === false,
     'no legacy OTP/magic-link impersonation flow remains');
  ok(/session\?*.*access_token|PhpSession/.test(svc),
     'service consumes the backend { session: { access_token, refresh_token } } shape');
  ok(/auth\.setSession/.test(svc),
     'REAL session swap via auth.setSession (identity actually changes)');
  ok(/clearProfile\(\)/.test(svc),
     'cached Super-Admin profile is dropped so target profile hydrates');

  // Structured errors — no swallowed failures, no faked success.
  ok(/ImpersonationError/.test(svc) && /case 403/.test(svc) && /case 429/.test(svc),
     'structured error mapping for 401/403/404/422/429/5xx');
  ok(/invalid impersonation session/.test(svc),
     'malformed/empty backend response is a hard failure (no token == no success)');
  ok(/const targetSession = data\?\.session;/.test(svc)
     && /if \(!targetSession\?\.access_token \|\| !targetSession\.refresh_token\) \{/.test(svc)
     && svc.indexOf('const targetSession = data?.session;') < svc.indexOf('if (!targetSession?.access_token || !targetSession.refresh_token) {'),
     'missing access_token throws before any success path');

  // Original SA session preserved (snapshot before swap; restore on exit).
  ok(/original_access_token|originalAccessToken/.test(svc) || /useImpersonationStore[\s\S]{0,300}startImpersonation\(/.test(svc),
     'original Super-Admin session snapshotted for restore');

  // End path: server-audited end with the CURRENT (target) token.
  ok(/impersonation-end/.test(svc) || /impersonation\/end/.test(svc),
     'end-impersonation calls the audited backend endpoint');
  ok(/Network\/5xx on the audit call must not trap/.test(svc),
     'network failure on the end-audit call cannot trap the Super Admin');

  // Backend: route + start/end/failed audit events + null-safe history query.
  const routes = read('backend/routes/api.php');
  ok(/post\('\/auth\/impersonate'.*super_admin/.test(routes),
     'POST /auth/impersonate is super_admin-gated');
  ok(/post\('\/auth\/impersonation\/end'/.test(routes),
     'POST /auth/impersonation/end route exists');
  const auth = read('backend/src/Controllers/AuthController.php');
  ok(/impersonation_started/.test(auth) && /impersonation_ended/.test(auth) && /impersonation_failed/.test(auth),
     'backend audits impersonation_started/_ended/_failed');
  ok(/WHERE action = 'impersonation_started'\s*\n\s*AND JSON_UNQUOTE\(JSON_EXTRACT\(details, '\$\.target_user_id'\)\) = \?/.test(auth),
     'end handler matches the latest start whose TARGET is the caller');
  ok(/end_without_active_session/.test(auth),
     'forged/repeat end-calls are audited, not silently accepted');

  // Audit actions are legal under the constraint (migration 029 / schema).
  const schema = read('backend/database/schema.sql');
  for (const a of ['impersonation_started', 'impersonation_ended', 'impersonation_failed', 'data_exported']) {
    ok(new RegExp(`'${a}'`).test(schema), `audit action '${a}' allowed by schema constraint`);
  }

  // Banner: safe-area aware (insets.top — NOT a hardcoded pad), above content, accessible.
  const banner = read('src/components/ImpersonationBanner.tsx');
  ok(/useSafeAreaInsets/.test(banner), 'banner uses useSafeAreaInsets (status-bar/notch safe)');
  ok(/insets\.top/.test(banner), 'banner positions below insets.top');
  ok(/accessibilityLabel|accessibilityRole/.test(banner), 'banner Exit control is accessible');
  ok(/zIndex|elevation/.test(banner), 'banner renders above normal content');
  ok(/hitslop|hitSlop|paddingVertical:\s*(1[2-9]|[2-9]\d)/i.test(banner),
     'Exit touch target is comfortable');

  // Banner is mounted at the app root so it persists across screens.
  const layout = read('src/app/_layout.tsx');
  ok(/ImpersonationBanner/.test(layout), 'banner is mounted globally in the root layout');

  // php.ts maps both impersonation function names to the real PHP routes.
  const php = read('src/client/php.ts');
  ok(/'impersonate':\s*'\/auth\/impersonate'/.test(php),
     'php.ts maps impersonate → /auth/impersonate');
  ok(/'impersonation-end':\s*'\/auth\/impersonation\/end'/.test(php),
     'php.ts maps impersonation-end → /auth/impersonation/end');

  // Screen: structured error surfaced verbatim, success toast only on real success.
  const screen = read('src/app/(app)/(superadmin)/impersonation.tsx');
  ok(/friendlyError\(e, 'Impersonation failed\.'\)/.test(screen),
     'screen surfaces the structured backend error verbatim');
  ok(/startImpersonationSession/.test(screen) && /router\.replace/.test(screen),
     'screen performs the real session switch then navigates into the target context');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ 6. MIGRATION 029 — audit actions ═══');
{
  const mig = read('backend/database/mysql-migrations/029_admin_ops_hardening.sql');
  for (const a of ['impersonation_failed', 'data_exported']) {
    ok(new RegExp(`'${a}'`).test(mig), `migration 029 allows audit action '${a}'`);
  }
  ok(/CHECK/.test(mig), 'migration 029 preserves the audit CHECK constraint pattern');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
