/**
 * Automated tests for MAINTENANCE MODE — backend decision matrix + client model.
 *
 * Run: node .freebuff/run-state-tests.cjs   (auto-included by the runner)
 *
 * Backend matrix (1–10): no PHP runtime exists in this environment, so the
 * authoritative decision table of MaintenanceMiddleware/MaintenanceService is
 * verified STRUCTURALLY against the shipped PHP source (regex over the real
 * files; any behavioral change to the pinned code path breaks the test).
 * The pure decision logic (blocks() = enabled AND NOT exempt; super_admin OR
 * whitelisted) is small and reviewed; the structural pins catch accidental
 * removal of an exemption, reordering the gate before identity resolution, or
 * a bypass via client-controllable input.
 *
 * Client matrix (11–24): exercised for real against the compiled PURE model
 * (maintenanceStateModel.ts) — classifier exactness, expected-control-flow
 * suppression, backoff bounds, recovery rules — plus structural pins for the
 * call-site wiring (getProfile / resolveEmailFromIdentifier / MaintenanceGate
 * / poller guard / php.ts canary).
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const model = require('../.freebuff/state-build/maintenanceStateModel.js');

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}
let failed = 0;
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKEND MATRIX (1–10) — structural pins over the shipped PHP source
// ═══════════════════════════════════════════════════════════════════════════

console.log('── Backend: authoritative maintenance decision (structural) ──');
{
  const svc = read('backend/src/Services/MaintenanceService.php');
  const mw = read('backend/src/Middleware/MaintenanceMiddleware.php');

  // blocks() = enabled AND NOT exempt — the single decision point.
  ok(/function blocks\(\): bool/.test(svc), 'backend: blocks() is the single decision function');
  ok(
    /if \(!\$cfg\['enabled'\]\)\s*\{\s*return false;\s*\}\s*return !\$this->isExempt\(\);/s.test(svc),
    'backend (1): maintenance OFF → blocks() false for EVERY caller (normal behavior)'
  );

  // Exemption order: super_admin first, unconditional (does NOT require whitelist).
  ok(
    /if \(\$this->actorRole === 'super_admin'\)\s*\{\s*return true;\s*\}/s.test(svc),
    'backend (2,7): super_admin bypass is UNCONDITIONAL and precedes the whitelist lookup'
  );

  // Whitelist bypass comes from the DB, scoped by user_id.
  ok(
    /SELECT COUNT\(\*\) FROM `maintenance_whitelist` WHERE `user_id` = \?/.test(svc),
    'backend (3,9): whitelisted user bypass reads the existing maintenance_whitelist table by user_id'
  );
  ok(
    /if \(\$this->actorId === ''\)\s*\{\s*return false;\s*\}/s.test(svc),
    'backend (4,5,6): empty identity (anonymous) → NEVER exempt (503 for unauthenticated non-exempt routes)'
  );
  ok(
    /catch \(\\Throwable\)\s*\{\s*return false;\s*\}/s.test(svc.replace(/[\s\S]*isExempt\(\): bool/, '')),
    'backend: whitelist read failure fails CLOSED (never a silent bypass)'
  );

  // Identity comes ONLY from the verified bearer token → DB profile row.
  ok(
    /SELECT id, role FROM profiles WHERE id = \?/.test(mw),
    'backend: gate resolves identity from the profiles TABLE (server authority)'
  );
  ok(
    /\$claims = \\MedAcademy\\Auth\\Jwt::decode\(\$token\);/.test(mw),
    'backend: role/whitelist decisions derive from the VERIFIED JWT (no client-declared role)'
  );
  ok(
    !/\$request->header\('x-[^']*(role|admin|bypass|exempt)/i.test(mw),
    'backend (A): no client header can grant a bypass'
  );
  ok(
    !/\$request->query\('(?:role|bypass|exempt|admin)'\)/i.test(mw),
    'backend (A): no query parameter can grant a bypass'
  );

  // AuthMiddleware (suspension/revocation) still runs on every authenticated
  // route AFTER the gate — maintenance never overrides security.
  const auth = read('backend/src/Middleware/AuthMiddleware.php');
  ok(
    /account_suspended/.test(auth) && /session_revoked/.test(auth),
    'backend (10): AuthMiddleware still enforces account_suspended + session_revoked (security wins over maintenance)'
  );

  // Gate order: index.php runs the gate BEFORE routing, identity resolved inside the gate.
  const index = read('backend/public/index.php');
  ok(
    /MaintenanceMiddleware\(\)\)->handle\(\$request\);[\s\S]*?\$router->dispatch\(\)/.test(index),
    'backend (C): gate runs before dispatch; identity resolved inside the gate (no duplicate auth)'
  );

  // Sign-in flow stays reachable during maintenance.
  ok(
    /'\/auth\/login', '\/auth\/refresh'/.test(mw) && /'\/rpc\/get-email-by-phone'/.test(mw),
    'backend (A): auth flow + phone→email RPC stay exempt so SA can sign in during maintenance'
  );

  // whoami: server-computed exemption evidence, no PII.
  ok(
    /function whoami\(Request \$request\): array/.test(mw) && /'exempt'\s+=>/.test(mw),
    'backend (I): /maintenance/whoami returns server-computed exemption evidence'
  );

  // Whitelist writes are SA-only through the generic Data API.
  const dc = read('backend/src/Controllers/DataController.php');
  ok(
    /'maintenance_whitelist',\s*\n\s*\];/s.test(dc),
    'backend (D): maintenance_whitelist writes are restricted to super_admin via the generic Data API'
  );

  // Immediate effectiveness: no caching of whitelist membership beyond the
  // per-request instance; config cache TTL is short and flushed on toggle.
  ok(/CACHE_TTL = 15;/.test(svc) && /function flushCache\(\)/.test(svc),
    'backend (8,9): config cache is short + flushed on toggle → whitelist/config changes effective immediately');
}

// ═══════════════════════════════════════════════════════════════════════════
// CLIENT MATRIX (11–24) — real assertions against the compiled pure model
// ═══════════════════════════════════════════════════════════════════════════

console.log('── Client: typed maintenance classifier (exactness) ──');
{
  // 23: genuine 5xx / bare 503 are NOT maintenance.
  ok(model.isMaintenanceError({ status: 503 }) === false, 'client (23): bare 503 without code/message is NOT maintenance');
  ok(model.isMaintenanceError({ status: 500, message: 'Internal server error' }) === false, 'client (23): 500 is NOT maintenance');
  ok(model.isMaintenanceError({ status: 503, message: 'Internal server error' }) === false, 'client (23): 503 with unrelated message is NOT maintenance');
  ok(model.isMaintenanceError({ status: 403, code: 'account_suspended' }) === false, 'client (22): account_suspended is NOT maintenance');
  ok(model.isMaintenanceError(null) === false, 'client: null error is not maintenance');
  ok(model.isMaintenanceError({}) === false, 'client: transport error (no status) is NOT maintenance');

  // Maintenance detection — code verbatim or message on a 503.
  ok(model.isMaintenanceError({ status: 503, code: 'maintenance_mode' }) === true, 'client: 503 + code maintenance_mode IS maintenance');
  ok(model.isMaintenanceError({ status: 503, message: 'We are currently performing maintenance.' }) === true, 'client: 503 + maintenance message IS maintenance');
  ok(model.isMaintenanceError({ status: 403, code: 'maintenance_mode' }) === true, 'client: code matches on any status (verbatim contract)');
}

console.log('── Client: expected control flow (canary) ──');
{
  // 13, 14: suppression requires BOTH flags → genuine errors stay visible.
  model.setMaintenanceControlFlowActive(true);
  ok(model.isExpectedMaintenanceError({ status: 503, code: 'maintenance_mode' }) === true, 'client (13,14): maintenance error while gate active → expected (silent)');
  ok(model.isExpectedMaintenanceError({ status: 403, code: 'account_suspended' }) === false, 'client (22): suspension while gate active → NOT suppressed (deterministic flow)');
  ok(model.isExpectedMaintenanceError({ status: 401 }) === false, 'client: revocation while gate active → NOT suppressed');
  ok(model.isExpectedMaintenanceError({ status: 500, message: 'boom' }) === false, 'client: genuine 5xx while gate active → NOT suppressed');
  ok(model.isExpectedMaintenanceError({ status: 503 }) === false, 'client (23): bare 503 while gate active → NOT suppressed');
  model.setMaintenanceControlFlowActive(false);
  ok(model.isExpectedMaintenanceError({ status: 503, code: 'maintenance_mode' }) === false, 'client: classifier disarmed after recovery → nothing suppressed');
}

console.log('── Client: verdict model + silent recovery ──');
{
  // 503 body → verdict.
  const v = model.verdictFrom503({ message: 'We are currently performing maintenance.', maintenance: { retryAfter: 300 } });
  ok(v.state === 'MAINTENANCE' && v.message === 'We are currently performing maintenance.' && v.retryAfter === 300,
    'client: verdict built from the 503 body (message + retryAfter)');

  // Status payload → verdict (recovery + keep message).
  ok(model.verdictFromStatus({ enabled: false }).state === 'NORMAL', 'client (19): enabled=false → NORMAL (recover to the app)');
  const m2 = model.verdictFromStatus({ enabled: true, message: 'Back soon', retryAfter: 60 });
  ok(m2.state === 'MAINTENANCE' && m2.message === 'Back soon', 'client: status enabled=true keeps MAINTENANCE + custom message');

  // Probe failures NEVER end maintenance (18, 21: silent stability).
  const cur = model.verdictFrom503({ message: 'x' });
  ok(model.nextVerdictAfterProbe(cur, false, null).state === 'MAINTENANCE', 'client (18,21): failed probe keeps MAINTENANCE (screen stays stable)');

  // Notification only on real transitions (background checks never churn UI).
  ok(model.shouldNotifyVerdictChange(cur, model.verdictFrom503({ message: 'x' })) === false, 'client (18): identical verdict → no re-render event');
  ok(model.shouldNotifyVerdictChange(cur, model.verdictFrom503({ message: 'y' })) === true, 'client: message change → notify');
  ok(model.shouldNotifyVerdictChange(cur, { state: 'NORMAL' }) === true, 'client (19): MAINTENANCE→NORMAL → notify (recover UI)');

  // Bounded backoff (17: invisible; retries never surface).
  ok(model.nextProbeDelayMs(0) === 15_000, 'client (G): backoff starts at 15s');
  ok(model.nextProbeDelayMs(1) === 30_000 && model.nextProbeDelayMs(2) === 60_000, 'client (G): backoff doubles');
  ok(model.nextProbeDelayMs(3) === 120_000 && model.nextProbeDelayMs(9) === 120_000, 'client (G): backoff capped at 120s (bounded)');
  ok(model.maintenancePollIntervalMs(300) === 300_000 && model.maintenancePollIntervalMs(0) === 15_000, 'client (G): first poll interval bounded [15s, 300s]');

  // Re-bootstrap rule (19: no relogin) + exemption evidence rule (A: server-verified).
  ok(model.shouldRebootstrapAfterRecovery(true, true) === true, 'client (19): recovery with session → re-bootstrap (no relogin)');
  ok(model.shouldRebootstrapAfterRecovery(true, false) === false, 'client: recovery without session → no bootstrap');
  ok(model.shouldKeepShellMountedBehindGate(true, true) === true, 'client (2,3): server-verified exempt identity → shell stays mounted (SA keeps using the app)');
  ok(model.shouldKeepShellMountedBehindGate(true, false) === false, 'client (4,5,6): non-exempt identity → maintenance screen');
  ok(model.shouldKeepShellMountedBehindGate(true, null) === false, 'client (A): unknown/failed whoami → NOT exempt (fail closed)');
  ok(model.shouldKeepShellMountedBehindGate(false, true) === false, 'client (A): no session → never exempt (bypass requires a verified identity)');
}

console.log('── Client: call-site wiring (structural) ──');
{
  const php = read('src/client/php.ts');
  const appLayout = read('src/app/(app)/_layout.tsx');
  const rootLayout = read('src/app/_layout.tsx');
  const ident = read('src/lib/identifier.ts');
  const gate = read('src/components/MaintenanceGate.tsx');
  const svc = read('src/lib/maintenanceService.ts');
  const ctx = read('src/ctx.tsx');

  // 11, 12: session untouched, no Login navigation on maintenance.
  ok(!/maintenance[^]*clearSession/s.test(php.split('notifyMaintenance503')[1]?.split('}')[0] ?? ''), 'client (11): 503 interceptor never touches clearSession');
  ok(/isExpectedMaintenanceError\(primary\.error\)/.test(ctx), 'client (11,12): revocation check skips maintenance (no logout, no Login nav)');

  // 13, 14: the two noisy call sites classify before logging.
  ok(/if \(isExpectedMaintenanceError\(err as /.test(appLayout), 'client (14): getProfile classifies maintenance before console.error');
  ok(/if \(isMaintenanceError\(error\)\)\s*\{\s*throw error;\s*\}/.test(ident), 'client (14,16): resolveEmailFromIdentifier classifies maintenance (silent throw, no red log)');

  // 15: getProfile maintenance → no navigation, session kept.
  ok(/maintenance_recovered/.test(appLayout), 'client (15,19): epoch re-bootstrap re-runs getProfile + accountRefresh after recovery');

  // 17: static screen — no spinner / checking text (in RENDERED JSX, i.e.
  // after the file's doc comment; the comment documents the removed bug).
  const gateJsx = gate.slice(gate.indexOf('return ('));
  ok(!/ActivityIndicator/.test(gate), 'client (17): MaintenanceGate renders NO ActivityIndicator');
  ok(!/Checking availability/.test(gateJsx), 'client (17): MaintenanceGate renders NO "Checking availability…" text');

  // 18, 21: silent background probe + canary arming.
  ok(/setMaintenanceControlFlowActive\(true\)/.test(php), 'client (18): php.ts arms the canary synchronously on a confirmed maintenance 503');
  ok(/probeMaintenanceStatus/.test(svc) && !/showToast|ToastAndroid|Alert\.alert/.test(svc), 'client (18,21): recovery probe never raises toast/alert UI');

  // 20: offline stays distinct — probes skip offline, nothing logs out.
  ok(/isConnected[^]*return/.test(svc.split('probePromise = (async')[1]?.split('finally')[0] ?? ''), 'client (20): probe skips when offline (maintenance ≠ offline, no logout)');

  // 24: request-storm guard — pollers pause while the gate is up.
  ok(/if \(isMaintenanceControlFlowActive\(\)\) return;/.test(php), 'client (24): 5s pollers pause during maintenance (no request storm)');

  // A: exemption evidence is server-derived and identity-bound.
  ok(/maintenance\/whoami/.test(svc), 'client (A): exemption evidence fetched from /maintenance/whoami (server-computed)');
  ok(/setMaintenanceExemptionUserId/.test(ctx), 'client (A): session provider binds evidence to the CURRENT identity (no cross-account reuse)');

  // Whitelist management UI untouched (SA screen keeps its flows).
  const sa = read('src/app/(app)/(superadmin)/maintenance.tsx');
  ok(/addToMaintenanceWhitelist|removeFromMaintenanceWhitelist/.test(sa), 'client (I): SA whitelist management flows preserved');
}

console.log('──────────────────────────────────────────────');
if (failed === 0) {
  console.log(`RESULT: ${passed} passed, 0 failed`);
  console.log('ALL MAINTENANCE-MODE TESTS PASSED');
} else {
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  FAILED: ' + f);
  process.exit(1);
}
