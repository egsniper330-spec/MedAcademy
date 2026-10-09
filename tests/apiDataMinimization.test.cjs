#!/usr/bin/env node
/**
 * API data-minimization + cross-user response contract.
 *
 * THE DEFECT THIS LOCKS DOWN
 * ──────────────────────────
 * `get_doctor_student_profile` returned `SELECT * FROM profiles` for ANOTHER
 * user. The handler had been narrowed to an `unset()` list of four columns —
 * a blocklist, so any column added later ships automatically. The row still
 * carried trash internals, security internals and doctor finance
 * configuration that no doctor-facing screen reads.
 *
 * What it asserts now:
 *   1. The cross-user profile read is an explicit column ALLOWLIST.
 *   2. Every known-sensitive column is absent from that allowlist.
 *   3. Every field the doctor UI actually consumes is still present.
 *   4. Dead cross-user blocks (credits, devices) are gone.
 *   5. Authorization precedes data: role gate + shared-enrollment check +
 *      session-derived doctor identity (never a client-supplied doctor id).
 *   6. The remaining full-row reads are the staff-only ones, still role gated.
 *   7. The named columns exist in BOTH shipped schemas, so the allowlist can
 *      never turn a doctor read into an unknown-column 500.
 *
 * Source-level: no PHP runtime exists in this environment.
 *
 * Usage: node tests/apiDataMinimization.test.cjs
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'backend', 'src');
const BACKEND = path.join(REPO, 'backend');
const ROUTES = path.join(BACKEND, 'routes', 'api.php');

let checks = 0;
let failures = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL ' + name + (detail ? '  — ' + detail : ''));
  }
}

/** Blank PHP comments so prose cannot satisfy a check. */
function stripPhpComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.php')) files.push(full);
  }
})(SRC);

const src = {};
for (const f of files) src[f] = fs.readFileSync(f, 'utf8');
const rel = (f) => path.relative(REPO, f).replace(/\\/g, '/');
const codeOf = (f) => stripPhpComments(src[f]);
const byRel = (r) => files.find((f) => rel(f) === r);

/** Extract a top-level `function <name>(...)` body by brace matching. */
function bodyOf(code, name) {
  const idx = code.indexOf('function ' + name + '(');
  if (idx === -1) return null;
  const open = code.indexOf('{', idx);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Column list of `profiles` in a schema file.
 *
 * Deliberately indexOf-based (not a nested regex): the schema is a large
 * multi-table dump and a `[\s\S]*?` match is both slow and easy to get wrong.
 * We slice from the CREATE TABLE header to its terminating `) ENGINE=`.
 */
function tableColumns(schemaFile, table) {
  const s = fs.readFileSync(path.join(BACKEND, 'database', schemaFile), 'utf8');
  const header = 'CREATE TABLE IF NOT EXISTS `' + table + '`';
  const start = s.indexOf(header);
  if (start === -1) return null;
  const engine = s.indexOf(') ENGINE=', start);
  if (engine === -1) return null;
  const body = s.slice(start + header.length, engine);
  const cols = [];
  const re = /^[ \t]+`([a-z_0-9]+)`/gm;
  let m;
  while ((m = re.exec(body)) !== null) cols.push(m[1]);
  return cols;
}

// ── 0. Locate the handler ───────────────────────────────────────────────────
const rpcPath = byRel('backend/src/Controllers/RpcController.php');
check('M0: RpcController.php found', !!rpcPath);
const rpcCode = rpcPath ? codeOf(rpcPath) : '';
const doctorBody = bodyOf(rpcCode, 'doctorStudentProfile') || '';
check('M0: doctorStudentProfile handler found', doctorBody.length > 0);

// ── 1. Allowlist, not blocklist ─────────────────────────────────────────────
const selectMatch = doctorBody.match(/SELECT\s+([\s\S]*?)\s+FROM\s+profiles\s+WHERE\s+id\s*=/i);
check('M1: profile read is an explicit SELECT <columns> allowlist', !!selectMatch);

const SCHEMA_COLS = tableColumns('schema.sql', 'profiles');
check(
  'M1: profiles columns read from schema.sql',
  Array.isArray(SCHEMA_COLS) && SCHEMA_COLS.length > 30,
  String(SCHEMA_COLS && SCHEMA_COLS.length)
);

const selected = selectMatch
  ? [...selectMatch[1].matchAll(/\b([a-z_0-9]+)\b/g)]
      .map((m) => m[1])
      .filter((c) => SCHEMA_COLS && SCHEMA_COLS.includes(c))
      .filter((c, i, a) => a.indexOf(c) === i)
  : [];
check('M1: allowlist resolves to real profiles columns', selected.length >= 15, 'resolved ' + selected.length);
check('M1: no `SELECT * FROM profiles` remains in the handler', !doctorBody.includes('SELECT * FROM profiles'));
check(
  'M1: no blocklist-style unset() guards remain (the allowlist is the only filter)',
  !/unset\(\s*\$profile\s*\[/.test(doctorBody)
);

// ── 2. Sensitive columns must NOT be selected ───────────────────────────────
const FORBIDDEN = {
  'suspension metadata': ['suspension_reason', 'suspension_at', 'suspension_device'],
  'prior phone value': ['phone_original'],
  'trash internals': [
    'trashed_at', 'trash_expires_at', 'trashed_by', 'trash_reason',
    'pre_trash_status', 'delete_permissions',
  ],
  'security internals': ['security_version', 'force_password_change', 'violation_count', 'strike_count'],
  'finance configuration': [
    'credit_selling_price', 'custom_pricing_enabled', 'earnings_mode', 'earnings_enabled',
    'doctor_global_price', 'doctor_pricing_mode',
  ],
};
for (const label of Object.keys(FORBIDDEN)) {
  const leaked = FORBIDDEN[label].filter((c) => selected.includes(c));
  check('M2: ' + label + ' excluded', leaked.length === 0, leaked.join(', '));
}

// ── 3. Fields the doctor UI consumes must still be present ──────────────────
// src/lib/api.ts DoctorStudentProfile + the modal in dr-profile.tsx
const UI_REQUIRED = ['id', 'full_name', 'phone', 'email', 'avatar_url', 'watermark_id', 'created_at', 'role', 'status'];
const missing = UI_REQUIRED.filter((c) => !selected.includes(c));
check('M3: every field the doctor UI reads is still returned', missing.length === 0, missing.join(', '));

// ── 4. Dead cross-user blocks removed ───────────────────────────────────────
check('M4: no cross-user `credits` read (credits is doctor-scoped anyway)', !doctorBody.includes('SELECT * FROM credits'));
check('M4: no cross-user `devices` read', !doctorBody.includes('FROM devices WHERE user_id = ?'));
check(
  'M4: response no longer advertises credits/devices',
  !/'credits'\s*=>/.test(doctorBody) && !/'devices'\s*=>/.test(doctorBody)
);
check(
  'M4: enrollment projection is an explicit column list',
  /SELECT\s+e\.id,\s*e\.course_id,\s*e\.enrolled_at,\s*e\.status,\s*c\.title\s+AS\s+course_title/.test(doctorBody)
);
check(
  'M4: enrollments still filtered by the visibility policy in SQL',
  doctorBody.includes("visibility_level = 'all'")
);

// ── 5. Authorization precedes the data read ─────────────────────────────────
const routesRaw = fs.readFileSync(ROUTES, 'utf8');
const profileRoute = routesRaw.split('\n').find((l) => l.includes('/rpc/doctor-student-profile')) || '';
check('M5: route requires authentication', profileRoute.includes('$auth'));
check("M5: route requires the doctor role", /role'\s*=>\s*\[\s*'doctor'\s*\]/.test(profileRoute));
check(
  'M5: server derives the doctor id from the session, not the request',
  doctorBody.includes("$doctorId = $request->user['id']")
);
check(
  'M5: shared-enrollment check runs before any profile data is returned',
  doctorBody.indexOf('No shared enrollment with this student') !== -1 &&
    doctorBody.indexOf('No shared enrollment with this student') < doctorBody.indexOf('FROM profiles WHERE id =')
);
check('M5: handler is gated by the doctor_earnings feature flag', doctorBody.includes('assertDoctorEarningsEnabled'));

// ── 6. Remaining full-row reads are staff-only ──────────────────────────────
const otherFullReads = [];
for (const f of files) {
  if (/SELECT \* FROM profiles/.test(codeOf(f))) otherFullReads.push(rel(f));
}
check(
  'M6: only the two staff-facing handlers still read a full profile row',
  otherFullReads.length === 2 &&
    otherFullReads.includes('backend/src/Controllers/AdminController.php') &&
    otherFullReads.includes('backend/src/Controllers/AnalyticsController.php'),
  otherFullReads.join(', ')
);
for (const route of ['/admin/users/{id}', '/analytics/user-profile/{id}']) {
  const line = routesRaw.split('\n').find((l) => l.includes("'" + route + "'")) || '';
  check(
    'M6: ' + route + ' is staff role gated',
    line.includes('$auth') && line.includes("['admin', 'super_admin']"),
    line.trim()
  );
}

// ── 7. The documented UI contract still lines up ────────────────────────────
const apiTs = fs.readFileSync(path.join(REPO, 'src', 'lib', 'api.ts'), 'utf8');
const typeBlock = (apiTs.match(/export interface DoctorStudentProfile \{([\s\S]*?)\n\}/) || [])[1] || '';
check('M7: client contract type exists', !!typeBlock);
const declared = typeBlock ? [...typeBlock.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]) : [];
for (const f of ['id', 'full_name', 'phone', 'email', 'avatar_url', 'watermark_id', 'created_at']) {
  check(
    "M7: client declares '" + f + "' and the server still supplies it",
    declared.includes(f) && selected.includes(f)
  );
}

// ── 8. The allowlist is portable across BOTH shipped schemas ────────────────
for (const schemaFile of ['schema.sql', 'schema-no-triggers.sql']) {
  const cols = tableColumns(schemaFile, 'profiles');
  if (!cols) {
    check('M8: ' + schemaFile + ' profiles table parsed', false);
    continue;
  }
  const unknown = selected.filter((c) => !cols.includes(c));
  check(
    'M8: every selected column exists in ' + schemaFile,
    unknown.length === 0,
    unknown.join(', ')
  );
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures > 0) {
  console.log('FAILURES: ' + failures);
  process.exit(1);
}
console.log('PASS: cross-user profile response is allowlisted, authorized and contract-stable');
