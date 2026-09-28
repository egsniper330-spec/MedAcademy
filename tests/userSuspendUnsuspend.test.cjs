/**
 * Automated tests for the SUSPEND / UNSUSPEND admin action flow.
 *
 * Run: node tests/userSuspendUnsuspend.test.cjs
 *
 * Pins the product contract:
 *   • ACTIVE    → menu shows Suspend (never Unsuspend)
 *   • SUSPENDED → menu shows Unsuspend (manual AND security-triggered —
 *                 both write status='suspended'; the same action clears both)
 *   • BLOCKED   → menu shows Unblock (legacy blocked flow preserved)
 *   • exactly one of the suspend-family pair is shown at a time
 *   • the unsuspend handler goes through the audited set_user_status RPC
 *     (updateUserStatus) with status='active' — the backend's own
 *     enforcement path (SessionManager revoke + audit) — not a bypass
 *   • local UI state updates only mirror the status the backend persisted
 *   • confirmation uses ConfirmDialog (cross-platform; Alert.alert is a
 *     silent no-op on web)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}
function section(title) { console.log('── ' + title + ' ──'); }

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '');

const menuSrc = read('src/components/ActionMenu.tsx');
const saSrc = read('src/app/(app)/(superadmin)/sa-users.tsx');
const adminSrc = read('src/app/(app)/(admin)/users.tsx');
const backendSrc = read('backend/src/Controllers/AdminController.php');

// ── A. ActionMenu defines the new actions ────────────────────────────────────
section('ActionMenu definitions');
assert(/'suspend' \| 'unsuspend'/.test(menuSrc), 'ActionKey type includes suspend + unsuspend');
assert(/\{ key: 'unsuspend',\s*label: 'Unsuspend'/.test(menuSrc), 'unsuspend action defined with label Unsuspend');
assert(/\{ key: 'suspend',\s*label: 'Suspend'/.test(menuSrc), 'suspend action defined with label Suspend');
assert(/case 'unsuspend':\s*return <UserCheck/.test(menuSrc), 'unsuspend renders an icon');
assert(/case 'suspend':\s*return <UserX/.test(menuSrc), 'suspend renders an icon');

// ── B. Status→action mapping (the core bug fix) ─────────────────────────────
section('Status→action mapping (both Users screens)');
for (const [name, src] of [['sa-users', saSrc], ['admin users', adminSrc]]) {
  assert(/status === 'blocked'\)\s+base\.splice\(1, 0, 'unblock'\)/.test(src), `${name}: blocked → unblock`);
  assert(/status === 'suspended'\)\s+base\.splice\(1, 0, 'unsuspend'\)/.test(src), `${name}: suspended → unsuspend (security + manual)`);
  assert(/else\s+base\.splice\(1, 0, 'suspend'\)/.test(src), `${name}: default (active) → suspend`);
  // The old broken shape ("blocked → unblock ELSE block") must be gone.
  assert(!/=== 'blocked'\) base\.splice\(1, 0, 'unblock'\);\s*\n\s*else\s+base\.splice\(1, 0, 'block'\)/.test(src),
    `${name}: no longer falls back to 'block' for suspended users`);
  // Exactly one of each pair — suspend never coexists with unsuspend in one
  // mapping branch (structural guard: the three branches are mutually exclusive).
  assert((src.match(/base\.splice\(1, 0, '(?:unblock|unsuspend|suspend)'\)/g) || []).length === 3,
    `${name}: exactly three mutually exclusive status branches`);
}

// ── C. Handlers: audited RPC, server-truth local state ──────────────────────
section('Handlers use the audited backend path');
for (const [name, src] of [['sa-users', saSrc], ['admin users', adminSrc]]) {
  assert(/unsuspend:\s*async \(\) => \{ await updateUserStatus\(id, 'active'\)/.test(src),
    `${name}: unsuspend → updateUserStatus(active) (audited set_user_status RPC)`);
  assert(/suspend:\s*async \(\) => \{ await updateUserStatus\(id, 'suspended'\)/.test(src),
    `${name}: suspend → updateUserStatus(suspended)`);
  // Local state mirrors the PERSISTED status, never a mislabeled one.
  assert(!/await blockUser\(id\);/.test(src), `${name}: no blockUser drift (block = suspended server-side)`);
  assert(/status: 'suspended' \} : u\)/.test(src), `${name}: local state set to 'suspended' (what the server wrote)`);
}

// ── D. Confirmation is cross-platform ───────────────────────────────────────
section('Cross-platform confirmation');
for (const [name, src] of [['sa-users', saSrc], ['admin users', adminSrc]]) {
  assert(src.includes("from '@/components/ConfirmDialog'"), `${name}: imports ConfirmDialog`);
  assert(/title: key === 'unsuspend' \? 'Unsuspend user\?'/.test(src), `${name}: Unsuspend confirmation title`);
  assert(/<ConfirmDialog\s+visible=\{!!confirm\}/.test(src), `${name}: ConfirmDialog rendered`);
}

// ── E. Backend: endpoint exists, authorization enforced, audit correct ──────
section('Backend enforcement + audit');
assert(/post\('\/admin\/users\/\{id\}\/status'/.test(read('backend/routes/api.php')),
  'route POST /admin/users/{id}/status exists (role-gated admin+super_admin)');
assert(/Cannot suspend or delete your own account/.test(backendSrc), 'self-suspension guard intact');
assert(/revokeAllForUser\(\$userId, 'status_changed:' \. \$status\)/.test(backendSrc),
  'session revocation on status change intact (all devices)');
assert(/\$auditAction = \$status === 'active' \? 'user_activated' : 'user_suspended';/.test(backendSrc),
  'audit event reflects direction (user_activated on unsuspend, user_suspended on suspend)');
// Restore semantics: active clears the security-suspension flag.
assert(/UPDATE profiles SET status = \?, is_suspended = \?, suspension_at = NULL/.test(backendSrc),
  'status=active clears is_suspended + suspension_at (security suspension included)');
// Security enforcement untouched: SessionManager still rejects suspended/blocked.
const smSrc = read('backend/src/Auth/SessionManager.php');
assert(/in_array\(\$profile\['status'\], \['suspended', 'blocked'\], true\)/.test(smSrc),
  'SessionManager token gate intact (suspension still blocks auth until unsuspended)');

console.log('');
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
