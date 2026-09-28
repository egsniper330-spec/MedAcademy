/**
 * Automated tests for the OFFLINE ENTITLEMENT revalidation core.
 *
 * Run: node tests/offlineEntitlement.test.cjs
 *
 * Extracts the pure computeRevokedCourseIds decision function from
 * src/lib/offlineEntitlement.ts and asserts the product-spec policy:
 *   • student: enrollment-row existence is the entitlement (mirrors the
 *     backend's own offlineAuthorize predicate — no invented status filter)
 *   • privileged: the courses row is the entitlement; trashed ⇒ revoked
 *   • undeterminable server state (null rows) NEVER deletes (fail-open)
 *   • unknown role deletes nothing
 *   • empty device library short-circuits
 *   • idempotency shape: recomputation after removal finds nothing
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}

function section(title) { console.log('── ' + title + ' ──'); }

function compileModule(name, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enttest-'));
  const out = path.join(dir, name + '.js');
  const src = path.join(dir, name + '.ts');
  fs.writeFileSync(src, code, 'utf8');
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    src, '--outDir', dir, '--module', 'commonjs', '--target', 'es2020',
    '--skipLibCheck', '--noEmitOnError', 'false',
  ], { stdio: 'pipe' });
  return require(out);
}

const svcSrc = fs.readFileSync(path.join(ROOT, 'src/lib/offlineEntitlement.ts'), 'utf8');

// Extract everything between the PRIVILEGED_ROLES constant and the
// revalidateOfflineEntitlements service (the pure decision core).
const a = svcSrc.indexOf('const PRIVILEGED_ROLES');
const b = svcSrc.indexOf('export async function revalidateOfflineEntitlements');
if (a < 0 || b < 0) {
  console.error('FATAL: decision-core markers not found in offlineEntitlement.ts');
  process.exit(1);
}
let core = svcSrc.slice(a, b).replace(/import[^\n]*\n/g, '');
// The slice already carries the EntitlementRevalidationResult interface —
// compile the decision core standalone with no extra declarations.
const mod = compileModule('entitlement-core', core);
const computeRevokedCourseIds = mod.computeRevokedCourseIds;

// ── 1. Student path: enrollment-row existence ────────────────────────────────
section('Student entitlement (enrollment rows)');
{
  const courses = ['c1', 'c2', 'c3'];
  // All enrolled → nothing revoked
  assert(
    JSON.stringify(computeRevokedCourseIds('student', courses, [{ course_id: 'c1' }, { course_id: 'c2' }, { course_id: 'c3' }], null)) === '[]',
    'all enrolled → nothing revoked'
  );
  // One revoked (c2 missing from the server reply) → revoked
  const r1 = computeRevokedCourseIds('student', courses, [{ course_id: 'c1' }, { course_id: 'c3' }], null);
  assert(JSON.stringify(r1) === '["c2"]', 'missing enrollment → revoked (got ' + JSON.stringify(r1) + ')');
  // Server reply rows with null course_id are ignored, not crashes
  const r2 = computeRevokedCourseIds('student', ['c1'], [{ course_id: null }], null);
  assert(JSON.stringify(r2) === '["c1"]', 'null course_id rows do not grant access');
  // The client must NOT invent an enrollment status filter (server counts rows
  // without one in offlineAuthorize): a suspended row still grants here —
  // matching the server exactly, never stricter.
  const r3 = computeRevokedCourseIds('student', ['c1'], [{ course_id: 'c1', status: 'suspended' }], null);
  assert(JSON.stringify(r3) === '[]', 'no invented status filter (row existence matches server predicate)');
}

// ── 2. Privileged path: course row is the entitlement ────────────────────────
section('Privileged entitlement (course rows)');
{
  const courses = ['c1', 'c2', 'c3'];
  const rows = [{ id: 'c1', status: 'active' }, { id: 'c2', status: 'trashed' }, { id: 'c3', status: 'suspended' }];
  const r = computeRevokedCourseIds('doctor', courses, null, rows);
  assert(JSON.stringify(r) === '["c2"]', 'trashed course → revoked, suspended course kept (got ' + JSON.stringify(r) + ')');
  // Course deleted entirely (absent from reply) → revoked
  const r2 = computeRevokedCourseIds('doctor', ['c1', 'cX'], null, [{ id: 'c1', status: 'active' }]);
  assert(JSON.stringify(r2) === '["cX"]', 'hard-deleted course → revoked');
  // Every privileged role shares the path
  for (const role of ['doctor', 'assistant', 'admin', 'super_admin']) {
    const rr = computeRevokedCourseIds(role, ['c9'], null, [{ id: 'c9', status: 'active' }]);
    assert(JSON.stringify(rr) === '[]', role + ' with live course → kept');
  }
}

// ── 3. Fail-open: undeterminable state NEVER deletes ─────────────────────────
section('Fail-open safety (no deletion on uncertainty)');
{
  const courses = ['c1', 'c2'];
  // Network/auth/maintenance → query returned null → nothing deleted
  assert(JSON.stringify(computeRevokedCourseIds('student', courses, null, null)) === '[]', 'student + null enrollment reply → delete nothing');
  assert(JSON.stringify(computeRevokedCourseIds('doctor', courses, null, null)) === '[]', 'doctor + null course reply → delete nothing');
  // Unknown/missing role → nothing
  assert(JSON.stringify(computeRevokedCourseIds(null, courses, [{ course_id: 'c1' }], null)) === '[]', 'null role → delete nothing');
  assert(JSON.stringify(computeRevokedCourseIds('student', courses, null, null)) === '[]', 'missing data with student role → delete nothing');
  // Empty device library → trivially fine
  assert(JSON.stringify(computeRevokedCourseIds('student', [], [{ course_id: 'zzz' }], null)) === '[]', 'no downloads → no-op');
}

// ── 4. Idempotency shape ─────────────────────────────────────────────────────
section('Idempotency');
{
  // After a first pass removed c2, the device library no longer contains it;
  // recomputing over the REMAINING ids finds nothing further.
  const remaining = ['c1', 'c3'];
  const r = computeRevokedCourseIds('student', remaining, [{ course_id: 'c1' }, { course_id: 'c3' }], null);
  assert(JSON.stringify(r) === '[]', 're-run after removal finds nothing (idempotent)');
}

// ── 5. Source-level guards ───────────────────────────────────────────────────
section('Source guards');
{
  // The service must fail-open on query errors and throw-guards.
  assert(/if \(error \|\| !data\) return blocked;/.test(svcSrc), 'query error → blocked (no deletion)');
  assert(/} catch \{\s*\n\s*return blocked;/.test(svcSrc), 'network throw → blocked (no deletion)');
  // Deletion must go through the OFFICIAL mechanism only — the SDK wrapper is
  // used and the SDK is never imported/bypassed directly here.
  assert(svcSrc.includes('deleteOfflineVideo('), 'deletion uses the official deleteOfflineVideo mechanism');
  assert(!svcSrc.includes("from 'vdocipher-rn-bridge"), 'service does not import the SDK directly (official wrapper only)');
  // The screen must consult entitlements on refresh (wiring guard).
  const screen = fs.readFileSync(path.join(ROOT, 'src/app/(app)/offline-library.tsx'), 'utf8');
  assert(screen.includes('revalidateOfflineEntitlements'), 'offline-library screen wires entitlement revalidation');
  // offlineTransition must consult entitlements on reconnect (wiring guard).
  const transition = fs.readFileSync(path.join(ROOT, 'src/lib/offlineTransition.ts'), 'utf8');
  assert(transition.includes('revalidateOfflineEntitlements'), 'connectivity-restored path wires entitlement revalidation');
  // Offline-only guard: every call site in the screen sits AFTER a
  // connectivity check in the same flow (index of the check precedes
  // the LAST call in each refresh flow body).
  const focusIdx = screen.indexOf('void resyncOfflineLibrary();');
  const refreshIdx = screen.indexOf('await resyncOfflineLibrary();');
  assert(focusIdx > -1 && screen.lastIndexOf('st.isConnected', focusIdx) > -1,
    'focus-effect revalidation is gated behind a connectivity check');
  assert(refreshIdx > -1 && screen.lastIndexOf('st.isConnected', refreshIdx) > -1,
    'pull-to-refresh revalidation is gated behind a connectivity check');
}

console.log('');
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
