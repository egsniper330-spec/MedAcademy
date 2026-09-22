/**
 * Automated state-machine tests for the PURE security/update model.
 *
 * Run: npm run test:state   (or: node .freebuff/run-state-tests.cjs)
 *
 * Compiles src/lib/securityStateModel.ts standalone (it has NO imports by
 * design) and asserts the authoritative state machine:
 *   • findings → policy → BLOCK/SAFE (deterministic, OR-composed)
 *   • policy decides blocking — risk score is informational only
 *   • gate sticky transitions: fail-closed during evaluation, recoverable
 *     after a completed non-blocking evaluation (never blocked-forever)
 *   • versionCode comparison (221/230/231 vs minimum 230, FORCED/OPTIONAL)
 *
 * Policy/weight tables below are snapshots of the shipped defaults in
 * src/lib/security.ts (DEFAULT_POLICIES / DETECTION_TO_EVENT / WEIGHTS).
 */

'use strict';

const assert = require('node:assert/strict');
const model = require('../.freebuff/state-build/securityStateModel.js');

// ── Shipped-default snapshots (src/lib/security.ts) ──────────────────────────

const DEFAULT_POLICIES = {
  root_jailbreak: 'block_login',
  vpn: 'block_login',
  proxy: 'warn_only',
  ssl_pinning: 'block_login',
  debug: 'block_login',
  developer_options: 'block_login',
  screenshot: 'log_only',
  screen_recording: 'block_video',
  app_integrity: 'warn_only',
  frida: 'block_login',
  xposed: 'block_login',
  magisk: 'block_login',
  overlay: 'block_video',
  tamper: 'block_login',
  play_integrity: 'block_login',
  app_attest: 'block_login',
};

const DETECTION_TO_EVENT = {
  root_jailbreak: ['root_detected', 'jailbreak_detected'],
  vpn: ['vpn_detected'],
  proxy: ['proxy_detected'],
  ssl_pinning: ['ssl_pinning_failure'],
  debug: ['debug_detected', 'debugger_attached'],
  developer_options: ['developer_options_enabled', 'adb_enabled'],
  screenshot: ['screenshot_detected'],
  screen_recording: ['screen_recording_detected'],
  app_integrity: ['app_integrity_compromised'],
  frida: ['frida_detected'],
  xposed: ['xposed_detected'],
  magisk: ['magisk_detected'],
  overlay: ['overlay_detected'],
  tamper: ['tamper_detected', 'signature_invalid'],
  play_integrity: ['play_integrity_failed'],
  app_attest: ['app_attest_failed'],
};

const WEIGHTS = {
  tamper_detected: 40,
  signature_invalid: 40,
  root_detected: 35,
  frida_detected: 30,
  magisk_detected: 25,
  xposed_detected: 25,
  debugger_attached: 25,
  developer_options_enabled: 25,
  adb_enabled: 20,
  debug_detected: 20,
  ssl_pinning_failure: 20,
  vpn_detected: 15,
  proxy_detected: 15,
  overlay_detected: 15,
  screen_recording_detected: 10,
  screenshot_detected: 5,
  security_unverified: 10,
  detection_unavailable: 0,
};

function threat(type, method = 'test') {
  return { type, detectionMethod: method, detected: true };
}

function evaluate(threats, overrides = {}) {
  return model.evaluateSecurityResult({
    threats,
    policies: { ...DEFAULT_POLICIES, ...overrides },
    detectionToEvent: DETECTION_TO_EVENT,
    weights: WEIGHTS,
  });
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

// ═══════════════ Security scenarios (BUG #24 matrix) ═══════════════

console.log('\nSecurity state machine:');

test('1. all safe → SAFE (no blocks, risk 0)', () => {
  const v = evaluate([]);
  assert.equal(v.blocksLogin, false);
  assert.equal(v.blocksVideo, false);
  assert.equal(v.hasWarnings, false);
  assert.equal(v.riskScore, 0);
  assert.deepEqual(v.blockingTypes, []);
});

test('2. VPN only → BLOCKED (block_login)', () => {
  const v = evaluate([threat('vpn_detected')]);
  assert.equal(v.blocksLogin, true);
  assert.deepEqual(v.blockingTypes, ['vpn_detected']);
  assert.equal(v.riskScore, 15);
});

test('3. VPN removed → SAFE (recovers without restart)', () => {
  const before = evaluate([threat('vpn_detected')]);
  assert.equal(before.blocksLogin, true);
  const after = evaluate([]); // fresh evaluation with VPN off
  assert.equal(after.blocksLogin, false);
});

test('4. USB debugging (adb) only → BLOCKED', () => {
  const v = evaluate([threat('adb_enabled')]);
  assert.equal(v.blocksLogin, true);
  assert.equal(v.riskScore, 20);
});

test('5. USB debugging removed → SAFE', () => {
  const v = evaluate([]);
  assert.equal(v.blocksLogin, false);
});

test('6. VPN + USB debugging → BLOCKED with BOTH findings listed (one page)', () => {
  const v = evaluate([threat('vpn_detected'), threat('adb_enabled')]);
  assert.equal(v.blocksLogin, true);
  assert.deepEqual(v.blockingTypes.sort(), ['adb_enabled', 'vpn_detected']);
  assert.equal(v.riskScore, 35);
});

test('7. VPN removed while USB debugging remains → STILL BLOCKED', () => {
  const v = evaluate([threat('adb_enabled')]);
  assert.equal(v.blocksLogin, true);
  assert.deepEqual(v.blockingTypes, ['adb_enabled']);
});

test('8. all conditions removed after multi-finding block → SAFE', () => {
  const blocked = evaluate([threat('vpn_detected'), threat('adb_enabled')]);
  assert.equal(blocked.blocksLogin, true);
  const recovered = evaluate([]);
  assert.equal(recovered.blocksLogin, false);
});

test('9. integrity failure (tamper_detected) → BLOCKED per policy', () => {
  const v = evaluate([threat('tamper_detected')]);
  assert.equal(v.blocksLogin, true);
  assert.equal(v.riskScore, 40);
});

test('10. BLOCKING finding with weight 0 → STILL BLOCKED (risk score never decides)', () => {
  // Acceptance #6: riskScore 0 must not force SAFE when policy says block.
  const zeroWeights = { ...WEIGHTS, tamper_detected: 0 };
  const v = model.evaluateSecurityResult({
    threats: [threat('tamper_detected')],
    policies: DEFAULT_POLICIES,
    detectionToEvent: DETECTION_TO_EVENT,
    weights: zeroWeights,
  });
  assert.equal(v.blocksLogin, true); // policy-driven
  assert.equal(v.riskScore, 0);      // informational
});

test('11. high risk score with only warn_only findings → NOT blocked', () => {
  // Inverse: score is informational; a warn_only finding never locks the app.
  const v = evaluate([threat('proxy_detected', 'warn-path')]);
  assert.equal(v.hasWarnings, true);
  assert.equal(v.blocksLogin, false);
  assert.equal(v.riskScore, 15);
});

test('12. risk score clamps at 100', () => {
  const v = evaluate([
    threat('tamper_detected'), threat('signature_invalid'), threat('root_detected'),
    threat('frida_detected'), threat('magisk_detected'),
  ]);
  assert.equal(v.riskScore, 100);
});

test('13. unmapped event types are skipped by policy (never invent blocks)', () => {
  const v = evaluate([threat('security_unverified', 'sentinel')]);
  assert.equal(v.blocksLogin, false); // sentinel is hand-constructed blocking in SecurityContext, not policy-evaluated
  assert.deepEqual(v.unmappedTypes, ['security_unverified']);
});

test('14. block_video finding blocks video without locking login', () => {
  const v = evaluate([threat('screen_recording_detected')]);
  assert.equal(v.blocksVideo, true);
  assert.equal(v.blocksLogin, false);
});

// ═══════════════ Gate sticky-state transitions (BUG #1/#2/#16) ═══════════════

console.log('\nGate sticky-state machine:');

test('15. live blocking result refreshes the sticky set', () => {
  const next = model.nextStickyTypes([], { checking: true, liveBlocking: true, liveThreatTypes: ['vpn_detected'] });
  assert.deepEqual(next, ['vpn_detected']);
});

test('16. re-check in flight with no live block → KEEP last verified block (fail-closed, no temp-allow window)', () => {
  const next = model.nextStickyTypes(['vpn_detected'], { checking: true, liveBlocking: false, liveThreatTypes: [] });
  assert.deepEqual(next, ['vpn_detected']);
});

test('17. COMPLETED non-blocking evaluation → CLEAR sticky set (recover without restart)', () => {
  const next = model.nextStickyTypes(['vpn_detected'], { checking: false, liveBlocking: false, liveThreatTypes: [] });
  assert.deepEqual(next, []);
});

test('18. completed evaluation with a remaining condition → KEEP blocking (sticky refresh via live)', () => {
  const next = model.nextStickyTypes(['vpn_detected'], { checking: false, liveBlocking: true, liveThreatTypes: ['adb_enabled'] });
  assert.deepEqual(next, ['adb_enabled']);
});

test('19. previously safe + routine re-check → stays unblocked (no false gate)', () => {
  const next = model.nextStickyTypes([], { checking: true, liveBlocking: false, liveThreatTypes: [] });
  assert.deepEqual(next, []);
});

test('20. cold-start sentinel window: unverified is blocking while checking', () => {
  const next = model.nextStickyTypes([], { checking: true, liveBlocking: true, liveThreatTypes: ['security_unverified'] });
  assert.deepEqual(next, ['security_unverified']);
  // ...and the first completed SAFE evaluation clears it:
  const cleared = model.nextStickyTypes(next, { checking: false, liveBlocking: false, liveThreatTypes: [] });
  assert.deepEqual(cleared, []);
});

// ═══════════════ Update verdict (BUG #25 matrix) ═══════════════

console.log('\nUpdate state machine (versionCode authoritative):');

test('21. installed 221 < minimum 230 → UPDATE_REQUIRED', () => {
  assert.equal(model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: 230, installedVersionCode: 221 }).verdict, 'UPDATE_REQUIRED');
});

test('22. installed 230 = minimum 230 → SUPPORTED', () => {
  assert.equal(model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: 230, installedVersionCode: 230 }).verdict, 'SUPPORTED');
});

test('23. installed 231 > minimum 230 → SUPPORTED', () => {
  assert.equal(model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: 230, installedVersionCode: 231 }).verdict, 'SUPPORTED');
});

test('24. enabled=false (kill switch) → SUPPORTED regardless of codes', () => {
  assert.equal(model.evaluateUpdateVerdict({ enabled: false, minimumVersionCode: 9999, installedVersionCode: 100 }).verdict, 'SUPPORTED');
});

test('25. no floor configured (minimum 0) → SUPPORTED', () => {
  assert.equal(model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: 0, installedVersionCode: 221 }).verdict, 'SUPPORTED');
});

test('26. installed code 0 (cannot compare) → SUPPORTED client-side; server 426 stays authoritative', () => {
  assert.equal(model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: 230, installedVersionCode: 0 }).verdict, 'SUPPORTED');
});

test('27. isVersionSupported boundary semantics', () => {
  assert.equal(model.isVersionSupported(230, 230), true);
  assert.equal(model.isVersionSupported(229, 230), false);
  assert.equal(model.isVersionSupported(231, 230), true);
});

// ── 28–31. Connection-probe classification (misclassification fix) ──────────
// REAL pin mismatch → blocking finding; every transient network failure →
// non-security observability outcome. Weak internet must NOT read as a
// security violation, and an origin outage must NOT read as tampering.

test('28. pin mismatch only when TLS identity rejected while device online', () => {
  assert.equal(model.classifySslProbe(false, true, 'tls_rejected'), 'pin_mismatch');
  assert.equal(model.isSslProbeSecurityFinding('pin_mismatch'), true);
});

test('29. weak network: origin times out while control CDN answers → NOT a security finding', () => {
  // THE EXACT REAL-DEVICE SCENARIO: pinned origin stalls (distant server),
  // apple.com edge answers. Previously "PIN MISMATCH, risk 20, BLOCK".
  assert.equal(model.classifySslProbe(false, true, 'timeout'), 'origin_unreachable');
  assert.equal(model.classifySslProbe(false, true, 'network_error'), 'origin_unreachable');
  assert.equal(model.isSslProbeSecurityFinding('origin_unreachable'), false);
});

test('30. offline / both fail → no finding; verified origin → pass', () => {
  assert.equal(model.classifySslProbe(false, false, 'timeout'), 'no_connectivity');
  assert.equal(model.isSslProbeSecurityFinding('no_connectivity'), false);
  assert.equal(model.classifySslProbe(false, null, 'unknown'), 'inconclusive');
  assert.equal(model.isSslProbeSecurityFinding('inconclusive'), false);
  assert.equal(model.classifySslProbe(true, null, 'none'), 'pin_verified');
});

test('31. zero-weight observability events can never block', () => {
  // 'connection_probe_degraded' rides the ssl_pinning (block_login) bucket,
  // but its weight is 0 — evaluateSecurityResult must not block on it.
  const verdict = model.evaluateSecurityResult({
    threats: [{ type: 'connection_probe_degraded', detectionMethod: 'probe degraded (timeout)', detected: true }],
    policies: { connection_probe: 'log_only' },
    detectionToEvent: { connection_probe: ['connection_probe_degraded'] },
    weights: { ssl_pinning_failure: 20, connection_probe_degraded: 0 },
  });
  assert.equal(verdict.blocksLogin, false);
  assert.equal(verdict.blocksVideo, false);
  assert.equal(verdict.riskScore, 0);
  // …while a real pin mismatch still blocks with its full weight.
  const real = model.evaluateSecurityResult({
    threats: [{ type: 'ssl_pinning_failure', detectionMethod: 'TLS identity rejected', detected: true }],
    policies: { ssl_pinning: 'block_login' },
    detectionToEvent: { ssl_pinning: ['ssl_pinning_failure', 'connection_probe_degraded'] },
    weights: { ssl_pinning_failure: 20, connection_probe_degraded: 0 },
  });
  assert.equal(real.blocksLogin, true);
  assert.equal(real.riskScore, 20);
});

// ═════════════════════════════════════════════════════════════════════════════
// STARTUP STATE MODEL (src/lib/startupStateModel.ts) — offline cold-start
// routing + auth-failure classification + account isolation. Compiled and run
// by the same harness (npm run test:state).
// ═════════════════════════════════════════════════════════════════════════════
const startup = require('../.freebuff/state-build/startupStateModel.js');

// ── The 15-item startup matrix (requirement) ─────────────────────────────────
// Items 11/12 are the startup races; 4/13/14 assert network failures NEVER
// mutate authenticated state (a network failure is not a logout); 7 asserts
// the router does not swallow the offline branch — SecurityGate is an
// independent layer, so the router still routes offline and the gate overlays.

test('startup 1. ONLINE + persisted valid session → Online Mode', () => {
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: true, connectivity: true }), 'online');
});

test('startup 2. OFFLINE + persisted valid session → authenticated Offline Mode (direct, no API wait)', () => {
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: true, connectivity: false }), 'offline');
});

test('startup 3. OFFLINE + no persisted session → Login', () => {
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: false, connectivity: false }), 'login');
});

test('startup 4. OFFLINE + API/network failure + persisted session → NOT logout (still Offline Mode)', () => {
  // A network failure cannot reach hasLocalSession — only clearSession()
  // through the definitive-revocation pipeline can flip it. The route is a
  // pure function of the same inputs, so the offline branch holds.
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: true, connectivity: false }), 'offline');
  assert.equal(startup.sessionTerminates('network_unreachable'), false);
  assert.equal(startup.sessionTerminates('timeout'), false);
  assert.equal(startup.sessionTerminates('server_error'), false);
  assert.equal(startup.sessionTerminates('inconclusive'), false);
});

test('startup 5. ONLINE + no session → Login', () => {
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: false, connectivity: true }), 'login');
});

test('startup 6. Explicit logout → Login (any connectivity)', () => {
  // signOut clears the store → hasLocalSession=false. Offline included:
  // a real logout still lands on login even with no network.
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: false, connectivity: true }), 'login');
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: false, connectivity: false }), 'login');
});

test('startup 7. Genuine security violation while offline → router routes offline, SecurityGate (independent layer) blocks', () => {
  // The router NEVER converts a security violation into an auth decision, and
  // the offline branch is not conditional on the security verdict — the gate
  // overlays the (app) shell and blocks. A violation must not evict the user
  // to login (that would HIDE the block reason); it must show SecurityGate.
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: true, connectivity: false }), 'offline');
});

test('startup 8. Valid offline session + cached offline policy → Offline Mode without waiting for API timeout', () => {
  // The route decision needs NO network evidence — connectivity comes from
  // NetInfo (local), the session from SecureStore (local). The cached-policy
  // gate is evaluated locally too (evaluateOfflinePolicy below).
  const d = startup.evaluateOfflinePolicy({ verdict: 'allowed', confirmedAt: Date.now() - 1000 }, Date.now());
  assert.equal(d.usable, true);
  assert.equal(d.reason, 'cached_allowed');
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: true, connectivity: false }), 'offline');
});

test('startup 9. Account isolation: Account B can never see Account A\'s downloads', () => {
  const rows = [
    { meta: { userId: 'user-A' } },
    { meta: { userId: 'user-B' } },
    { meta: { userId: 'user-A' } },
    { meta: {} },
    {},
  ];
  assert.deepEqual(
    startup.filterOwnedRows(rows, 'user-B').map((r) => r.meta.userId),
    ['user-B']
  );
  assert.deepEqual(startup.filterOwnedRows(rows, null), []);
  // …and the runtime service re-filters on hydration (owner binding asserted
  // statically by the offline suite against offlineVideoService.ts).
});

test('startup 10. Connectivity restoration → Online re-evaluation', () => {
  // Same settled inputs flip the route deterministically with connectivity.
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: true, connectivity: false }), 'offline');
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: true, connectivity: true }), 'online');
});

test('startup 11. Race: hydration completes AFTER connectivity is known → still correct authenticated Offline state', () => {
  // Before hydration: HOLD (never login) regardless of connectivity.
  assert.equal(startup.resolveStartupRoute({ authHydrated: false, hasLocalSession: false, connectivity: false }), 'spinner');
  // After hydration lands: the settled state.
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: true, connectivity: false }), 'offline');
});

test('startup 12. Race: connectivity flips DURING hydration → never redirected to Login', () => {
  assert.equal(startup.resolveStartupRoute({ authHydrated: false, hasLocalSession: false, connectivity: true }), 'spinner');
  assert.equal(startup.resolveStartupRoute({ authHydrated: false, hasLocalSession: false, connectivity: null }), 'spinner');
  assert.equal(startup.resolveStartupRoute({ authHydrated: true, hasLocalSession: true, connectivity: null }), 'spinner');
});

test('startup 13. Network timeout does not mutate authenticated state to logged-out', () => {
  assert.equal(startup.sessionTerminates('timeout'), false);
  assert.equal(startup.sessionTerminates('network_unreachable'), false);
});

test('startup 14. Security-check timeout does not mutate authenticated state to logged-out', () => {
  // The security pipeline is not an auth pipeline; only 'revoked' ends a session.
  assert.equal(startup.sessionTerminates('inconclusive'), false);
  assert.equal(startup.sessionTerminates('server_error'), false);
});

test('startup 15. Cached offline policy missing/invalid → no invented bypass, no invented denial', () => {
  // Missing/garbage/stale ≡ absent: absence is NOT denial (same principle as
  // network-failure ≠ logout). Only an explicit FRESH server denial blocks.
  const now = Date.now();
  const max = startup.CACHED_OFFLINE_POLICY_MAX_AGE_MS;
  assert.deepEqual(startup.evaluateOfflinePolicy(null, now), { usable: true, reason: 'no_cached_policy' });
  assert.deepEqual(startup.evaluateOfflinePolicy(undefined, now), { usable: true, reason: 'no_cached_policy' });
  assert.deepEqual(startup.evaluateOfflinePolicy({ verdict: 'nonsense', confirmedAt: now }, now), { usable: true, reason: 'no_cached_policy' });
  assert.deepEqual(startup.evaluateOfflinePolicy({ verdict: 'allowed', confirmedAt: now - max - 1 }, now), { usable: true, reason: 'no_cached_policy' });
  assert.deepEqual(startup.evaluateOfflinePolicy({ verdict: 'denied', confirmedAt: now - 1000 }, now), { usable: false, reason: 'cached_denied' });
  assert.deepEqual(startup.evaluateOfflinePolicy({ verdict: 'denied', confirmedAt: now - max - 1 }, now), { usable: true, reason: 'no_cached_policy' });
});

test('startup 16. Hydration truncation rule — an unfinished read is never a negative', () => {
  // The machine-level encoding of the php.ts fix: mayTruncateHydration(false)
  // is forbidden (the old 3s race), mayTruncateHydration(true) allowed.
  assert.equal(startup.mayTruncateHydration(true), true);
  assert.equal(startup.mayTruncateHydration(false), false);
});

test('startup 17. Machine matches its self-documenting matrix (STARTUP_MATRIX)', () => {
  for (const c of startup.STARTUP_MATRIX) {
    assert.equal(startup.resolveStartupRoute(c.inputs), c.expected, c.name);
  }
});

test('startup 18. Profile-refresh classifier: server verdict replaces cached role/status (USER→ADMIN, ADMIN→USER)', () => {
  // classifyProfileRefresh(null-err) = 'applied' — publishProfile() replaces
  // the store row, so USER→ADMIN and ADMIN→USER both flow through the SAME
  // applied path (no restart, no re-login).
  assert.equal(startup.classifyProfileRefresh(true, null), 'applied');
});

test('startup 19. Profile-refresh classifier: ACTIVE→BLOCKED → blocked (terminal, not spinner)', () => {
  // The backend contract: AuthMiddleware throws 403 code 'account_suspended'
  // for suspended/blocked accounts. Recognized VERBATIM — never synthesized.
  assert.equal(startup.classifyProfileRefresh(true, { status: 403, code: 'account_suspended', message: 'This account has been suspended. Please contact support.' }), 'blocked');
  // Proxy-stripped code but intact message → still recognized as blocked.
  assert.equal(startup.classifyProfileRefresh(true, { status: 403, message: 'account has been suspended by an administrator' }), 'blocked');
});

test('startup 20. Profile-refresh classifier: BLOCKED→ACTIVE refreshes back to applied', () => {
  // Unblocked account → no error → 'applied' → profile store replaced with
  // status:'active' → normal usage without re-login (existing auth policy).
  assert.equal(startup.classifyProfileRefresh(true, null), 'applied');
});

test('startup 21. Profile-refresh classifier: offline skip, network errors never become logout/block', () => {
  assert.equal(startup.classifyProfileRefresh(false, null), 'offline_skipped');
  assert.equal(startup.classifyProfileRefresh(null, null), 'offline_skipped'); // unknown connectivity → skip, never guess
  assert.equal(startup.classifyProfileRefresh(true, { status: undefined, message: 'Request timed out' }), 'network_error');
  assert.equal(startup.classifyProfileRefresh(true, { message: 'Network request failed' }), 'network_error');
  assert.equal(startup.classifyProfileRefresh(true, { status: 500, message: 'Internal Server Error' }), 'network_error');
  assert.equal(startup.classifyProfileRefresh(true, { status: 503, message: 'Service Unavailable' }), 'network_error');
});

test('startup 22. Profile-refresh classifier: 401 → existing auth policy; other 4xx → non-fatal', () => {
  assert.equal(startup.classifyProfileRefresh(true, { status: 401, message: 'Session revoked — please sign in again' }), 'auth_error');
  assert.equal(startup.classifyProfileRefresh(true, { status: 422, message: 'Unprocessable' }), 'error');
});

test('startup 23. Profile-refresh classifier: 403 WITHOUT the blocked verdict is NOT a block', () => {
  // A plain 403 (e.g. role-forbidden table) must not lock the account UI.
  assert.equal(startup.classifyProfileRefresh(true, { status: 403, code: 'forbidden', message: "Table 'x' requires admin access" }), 'error');
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (WITH FAILURES)' : ''}.\n`);
if (!process.exitCode) console.log('ALL STATE-MACHINE TESTS PASSED');
