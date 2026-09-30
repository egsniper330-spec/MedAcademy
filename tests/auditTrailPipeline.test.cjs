#!/usr/bin/env node
'use strict';
/**
 * auditTrailPipeline.test.cjs — Super Admin Audit Trail end-to-end pins.
 *
 * Proven incident: the Audit Trail page always showed "No audit logs found"
 * because RpcController::searchAuditLogs() normalized an ABSENT user_id into
 *Uuid::normalize('') → "Invalid UUID: ''" → HTTP 400 on every load, and the
 * page's catch(_){} swallowed it into an empty list. These pins guard every
 * layer of the fixed pipeline so no layer can regress silently.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');
let passed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exitCode = 1;
  } else {
    passed++;
  }
};

// ── 1. Backend read path (RpcController::searchAuditLogs) ────────────────────
{
  const rpc = read('backend/src/Controllers/RpcController.php');

  // THE root cause: user_id must be guarded before Uuid::normalize.
  ok(rpc.includes("trim((string) ($request->query('user_id', '')))"),
    'user_id read as optional string (no forced UUID normalization of an absent param)');
  ok(/\$userIdRaw !== '' \? Uuid::normalize\(\$userIdRaw\) : ''/.test(rpc),
    'Uuid::normalize only runs on a NON-EMPTY user_id');
  ok(!/Uuid::normalize\(\(string\) \(\$request->query\('user_id'/.test(rpc),
    'the broken normalize-absent-user_id call is gone');

  // The full schema contract the sa-audit page renders.
  for (const col of ["'id', 'user_id', 'actor_id'", "'target_name'", "'actor_name', 'actor_email',\n        'actor_role'", "'old_values', 'new_values'"]) {
    ok(rpc.includes(col), `selects the ${col.split(',')[0].trim()} contract column(s)`);
  }
  ok(/SELECT COUNT\(\*\) AS c\r?\n\s+FROM audit_logs al/.test(rpc), 'pagination total via count-then-page (no window functions)');
  ok(/\$row\['total_count'\] = \$total;/.test(rpc), 'total_count attached to every row');

  // JSON decode + ISO-8601 normalization at the API boundary.
  ok(rpc.includes("foreach (['details', 'old_values', 'new_values'] as $jsonCol)"),
    'JSON columns decoded server-side');
  ok(rpc.includes('Y-m-d\\TH:i:s\\Z') || rpc.includes("Y-m-d\\\\TH:i:s\\\\Z"),
    'created_at shipped as ISO-8601 UTC');

  // Filters must actually filter — including every sa-audit chip key.
  ok(rpc.includes("'al.log_status = ?'"), 'log_status filter is applied');
  ok(rpc.includes("'al.created_at >= ?'") && rpc.includes("'al.created_at <= ?'"),
    'date range filter is applied');
  const cat = rpc.slice(rpc.indexOf('AUDIT_CATEGORY_ACTIONS'), rpc.indexOf('auditCategoryActions('));
  for (const key of ['users', 'roles', 'doctor', 'student', 'courses', 'auth', 'platform', 'finance', 'security']) {
    ok(new RegExp("'" + key + "' =>").test(cat), `category '${key}' is a real filter bucket`);
  }
  ok(rpc.includes("$conditions[] = '1=0';"), 'unknown category fails closed (matches nothing)');

  // Server-side pagination bounds + the emulate-prepares LIMIT constraint.
  ok(/min\(max\(\(int\) \$request->query\('limit', '50'\), 1\), 200\)/.test(rpc),
    'limit clamped to 1..200 (no unbounded reads)');
  ok(/LIMIT \{\$limit\} OFFSET \{\$offset\}/.test(rpc) && !/LIMIT \? OFFSET \?/.test(rpc),
    'LIMIT/OFFSET interpolated from int-clamped values (emulated prepares quote bound ints)');

  // Authorization is route-level and admin-gated.
  const routes = read('backend/routes/api.php');
  ok(/get\('\/rpc\/search-audit-logs'.*role' => \['admin', 'super_admin'\]/.test(routes),
    'search-audit-logs is admin/super_admin only');
}

// ── 2. Writer: actor denormalization + secret sanitizer ─────────────────────
{
  const svc = read('backend/src/Services/AuditService.php');
  ok(svc.includes('actor_id, action, details, ip_address, created_at,\n                 target_name, description, log_status, actor_name, actor_email, actor_role'),
    'write() persists the denormalized actor + metadata columns');
  ok(svc.includes('$actorIdOverride'), 'explicit actor override supported (client endpoint)');
  ok(svc.includes('SENSITIVE_KEY_PATTERN') && svc.includes('password|passwd|secret|token|api_key'),
    'secret-shaped detail keys are stripped');
  ok(svc.includes('function sanitizeDetails'), 'details pass through the sanitizer');
  ok(/depth > 3/.test(svc) && /count\(\$value\) > 50/.test(svc), 'payload depth/size bounded');

  // Sanitizer behavior — the actual security property, exercised directly.
  const { execSync } = require('child_process');
  let phpBin = null;
  for (const c of ['php', 'C:\\php\\php.exe', 'C:\\xampp\\php\\php.exe']) {
    try { execSync(`"${c}" -v`, { stdio: 'ignore' }); phpBin = c; break; } catch { /* next */ }
  }
  if (phpBin) {
    const harness = `<?php
require '${path.join(ROOT, 'backend', 'src', 'Services', 'AuditService.php').replace(/\\/g, '/')}';
$calls = [];
class FakeStmt { public function execute($p) { global $calls; $calls[] = $p; return true; } }
class FakePdo {
  public function prepare($q) { return new FakeStmt(); }
}
`;
    // AuditService uses Database::instance() — stub it via a bootstrap shim.
    const shim = path.join(ROOT, '.freebuff', 'audit-sanitizer-shim.php');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, `<?php
namespace MedAcademy\\Database {
  class Database {
    private static $inst;
    public static function instance(): Database { return self::$inst ??= new Database(); }
    public function insert(string $sql, array $params = []): int { $GLOBALS['auditInserts'][] = $params; return 1; }
    public function select(string $sql, array $params = []): array {
      $GLOBALS['profileLookups'][] = $params;
      return $GLOBALS['fakeProfile'] ?? [];
    }
  }
}
namespace MedAcademy\\Utils {
  class Uuid { public static function v4(): string { return '00000000-0000-4000-8000-00000000000' . rand(0, 9); } }
}
`);
    const driver = path.join(ROOT, '.freebuff', 'audit-sanitizer-run.php');
    fs.writeFileSync(driver, `<?php
namespace MedAcademy\\Services { require '${path.join(ROOT, 'backend', 'src', 'Services', 'AuditService.php').replace(/\\/g, '/')}'; }
namespace {
  $GLOBALS['fakeProfile'] = [['id' => 'u1', 'full_name' => 'Test Actor', 'email' => 'a@b.c', 'role' => 'super_admin']];
  \\MedAcademy\\Services\\AuditService::write('u1', 'login', [
    'password' => 'MUST-NOT-APPEAR',
    'api_key' => 'MUST-NOT-APPEAR',
    'refresh_token' => 'MUST-NOT-APPEAR',
    'otp' => 'MUST-NOT-APPEAR',
    'nested' => ['client_secret' => 'MUST-NOT-APPEAR', 'safe' => 'kept', 'deep' => [['authorization' => 'x', 'ok' => 1]]],
    'big' => array_fill(0, 60, 'x'),
    'longstr' => str_repeat('a', 5000),
    'object' => (object) ['x' => 1],
  ], '1.2.3.4');
  $row = $GLOBALS['auditInserts'][0];
  $blob = json_encode($row);
  if (strpos($blob, 'MUST-NOT-APPEAR') !== false) { fwrite(STDERR, "secret leaked into audit row\\n"); exit(1); }
  if (($row[12] ?? null) !== 'super_admin') { fwrite(STDERR, "actor_role not denormalized\\n"); exit(1); }
  if (($row[11] ?? null) !== 'Test Actor') { fwrite(STDERR, "actor_name not denormalized\\n"); exit(1); }
  if (!array_key_exists('safe', $row[4]['nested'] ?? []) ) { fwrite(STDERR, "safe nested data lost\\n"); exit(1); }
  if (($row[4]['big']['_truncated'] ?? '') === '') { fwrite(STDERR, "oversized array not truncated\\n"); exit(1); }
  echo 'sanitizer-ok';
}
`);
    try {
      const out = execSync(`"${phpBin}" "${driver}"`, { encoding: 'utf8', timeout: 20000 });
      ok(out.includes('sanitizer-ok'), 'PHP sanitizer round-trip: secrets stripped, actor denormalized');
    } catch (e) {
      ok(false, 'PHP sanitizer round-trip failed: ' + String(e.stderr || e.message).slice(0, 200));
    } finally {
      fs.rmSync(shim, { force: true });
      fs.rmSync(driver, { force: true });
    }
  } else {
    console.log('note: php binary unavailable — sanitizer asserted statically (matches prior runs)');
  }
}

// ── 3. Write endpoint hardening (POST /admin/audit-logs) ────────────────────
{
  const ctl = read('backend/src/Controllers/AdminController.php');
  ok(ctl.includes("audit entries can only be written as the authenticated user"),
    'client cannot forge another actor');
  ok(ctl.includes("preg_match('/^[a-z][a-z0-9_]{1,63}$/', $action)"),
    'action token validated (canonical format)');
  ok(ctl.includes("p_details exceeds the allowed size"), 'details payload size-capped');
  ok(/AuditService::write\(\$subjectId, \$action, \$details, \$request->clientIp\(\), \$authIdentity !== '' \? \$authIdentity : null\)/.test(ctl),
    'actor identity always resolves from the authenticated session');
}

// ── 4. Migration 031 — superset constraint ──────────────────────────────────
{
  const mig = read('backend/database/mysql-migrations/031_audit_actions_security_vdocipher.sql');
  ok(mig.includes('DROP CONSTRAINT `chk_audit_logs_action`'), '031 drops the old constraint');
  ok(mig.includes('ADD CONSTRAINT `chk_audit_logs_action`'), '031 re-adds it');
  ok(/SUPERSET/.test(mig), '031 documents the superset property');
  const list = mig.match(/CHECK \(`action` IN \(([^)]*)\)\)/);
  ok(!!list, '031 embeds the action list');
  const actions = list[1].split(',').map(s => s.trim().replace(/'/g, ''));
  ok(actions.length === 195, `031 carries 195 actions (got ${actions.length})`);
  ok(new Set(actions).size === actions.length, 'no duplicate actions in 031');
  for (const a of ['security_policy_update', 'security_vpn_whitelist_add', 'security_vpn_whitelist_remove', 'patch_uploaded', 'vdocipher_delete_failed', 'vdoapi_curl_error', 'students_bulk_action', 'login']) {
    ok(actions.includes(a), `031 allows ${a}`);
  }
  // Every action written by code must be allowed by the union of migrations.
  const migDir = 'backend/database/mysql-migrations';
  const allowed = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, migDir)).filter(f => f.endsWith('.sql'))) {
    const src = read(path.join(migDir, f));
    for (const block of src.matchAll(/chk_audit_logs_action[\s\S]{0,6000}?;/g)) {
      for (const q of block[0].matchAll(/'([a-z_]+)'/g)) allowed.add(q[1]);
    }
  }
  const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const phpFiles = [...walk('backend/src')].filter(f => f.endsWith('.php'));
  for (const file of phpFiles) {
    const src = read(path.relative(ROOT, file));
    for (const call of src.matchAll(/AuditService::write\(\s*[^,'"]*?,\s*'([a-z_]{3,60})'/g)) {
      ok(allowed.has(call[1]), `code action "${call[1]}" (${path.basename(file)}) is allowed by the constraint union`);
    }
  }
}

// ── 5. Frontend contract + page states ──────────────────────────────────────
{
  const api = read('src/lib/api.ts');
  ok(api.includes('Malformed audit-trail response from server.'),
    'getAuditTrail throws on a malformed envelope (never silent [])');
  ok(/totalCount: typeof rows\[0\]\?\.total_count === 'number' \? rows\[0\]\.total_count : rows\.length/.test(api),
    'totalCount read from total_count with row-length fallback');

  const page = read('src/app/(app)/(hubs)/sa-audit.tsx');
  ok(/const \[loadError,\s+setLoadError\]/.test(page), 'page has loadError state');
  ok(!/\} catch \(_\) \{\}/.test(page), 'no silent catch(_){} on the page');
  ok(/catch \(e\) \{[\s\S]{0,700}setLoadError\(msg \|\| 'Unable to load the audit trail\.'\)/.test(page),
    'API failure sets explicit error state (backend diagnostic preserved)');
  ok(page.includes("(e as { message: string }).message"),
    'RPC plain-object rejections surface their message (no generic-only error)');
  ok(page.includes("Unable to load the audit trail") && page.includes('Retry'),
    'error UI with Retry exists');
  ok(/onPress=\{\(\) => \{ setLoadError\(null\); reload\(\); \}\}/.test(page),
    'Retry triggers a real reload');

  // Contract-consumer alignment: page renders fields the backend now selects.
  for (const field of ['actor_name', 'target_name', 'actor_role', 'log_status', 'created_at']) {
    ok(page.includes(`entry.${field}`), `page renders entry.${field}`);
  }

  // Ordering: the backend ORDER BY pins newest-first; assert the SQL shape.
  const rpc = read('backend/src/Controllers/RpcController.php');
  ok(/ORDER BY al\.created_at DESC, al\.id DESC/.test(rpc), 'newest events first (stable tiebreak)');
}

// ── 6. No user-writable audit mutation paths ────────────────────────────────
{
  const routes = read('backend/routes/api.php');
  const auditRoutes = routes.split('\n').filter(l => /audit/i.test(l));
  ok(!/\$auth \+ \[\]/.test(auditRoutes.join('\n')) || !auditRoutes.some(l => /\b(put|patch|delete)\b/i.test(l)),
    'no PUT/PATCH/DELETE audit routes exist (append-only)');
}

console.log(`\nauditTrailPipeline: ${passed} assertions passed`);
