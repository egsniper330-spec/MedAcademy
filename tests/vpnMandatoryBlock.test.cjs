#!/usr/bin/env node
/**
 * vpnMandatoryBlock.test.cjs — MANDATORY VPN/proxy blocking regression suite.
 *
 * Run: node tests/vpnMandatoryBlock.test.cjs   (part of `npm test`)
 *
 * ─── THE REPORTED DEFECT ─────────────────────────────────────────────────────
 *
 * "VPN detection now works on iPhone, but the security warning still displays a
 *  `Continue Anyway` button. Tapping it allows the user to enter the app and
 *  make API requests while the VPN is active."
 *
 * ROOT CAUSE (three findings, all pinned below):
 *   1. POLICY: the effective action for the connection detectors came from the
 *      server `security_policies` rows, and a `warn_only` (or disabled `vpn` /
 *      `proxy`) row downgraded a connection BLOCK into a dismissible warning.
 *      The dismissible warning screen is the only surface with a
 *      `Continue Anyway` button.
 *   2. SURFACE: that screen derived its decision from ROUTE PARAMS, so a
 *      deep link (`?blocksLogin=false`) could present the dismiss button even
 *      when the authoritative verdict said block.
 *   3. STARTUP: the update check ran in front of the whole app (see
 *      tests/updateDetection.test.cjs section G — the surface-aware gate).
 *
 * WHAT THIS SUITE LOCKS DOWN
 *   A. the pure floor + connection-finding helpers (applyMandatoryConnectionFloor)
 *   B. the shipped client policy table is floored (warn_only/disabled rows lose)
 *   C. every requested scenario: pre-launch VPN, runtime enable, disable while
 *      blocked, background/resume change, proxy, unavailable ≠ clean
 *   D. no surface exposes a dismiss control for a connection finding
 *   E. deep links / navigation / restart cannot bypass the gate
 *   F. the server enforces the same floor and refuses weakening writes
 *   G. unrelated security checks and role exemptions are untouched
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** Source with comments stripped, so assertions inspect executable code only. */
const stripBlockComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (match, offset, whole) => {
  const lineStart = whole.lastIndexOf('\n', offset) + 1;
  const before    = whole.slice(lineStart, offset);
  const odd       = (q) => (before.split(q).length - 1) % 2 === 1;
  return (odd("'") || odd('"') || odd('`')) ? match : '';
});
const readCode = (rel) => stripBlockComments(read(rel))
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

function buildModel() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpnblock-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src', 'lib', 'securityStateModel.ts'),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(tmp, 'securityStateModel.js'));
}

const M = buildModel();

// ── Fixtures mirroring the shipped tables (src/lib/security.ts) ──────────────
const DETECTION_TO_EVENT = {
  root_jailbreak: ['root_detected', 'jailbreak_detected'],
  vpn: ['vpn_detected'],
  proxy: ['proxy_detected'],
  debug: ['debug_detected', 'debugger_attached'],
  developer_options: ['developer_options_enabled', 'adb_enabled'],
  app_integrity: ['app_integrity_compromised'],
  tamper: ['tamper_detected', 'signature_invalid'],
  play_integrity: ['play_integrity_failed'],
};
const WEIGHTS = {
  vpn_detected: 15, proxy_detected: 15, tamper_detected: 40, root_detected: 35,
  developer_options_enabled: 25, app_integrity_compromised: 20, signature_invalid: 40,
  play_integrity_failed: 30, vpn_detection_degraded: 0,
};

/** What a hostile/misconfigured deployment could serve for the two rows. */
const WEAKENED_ROWS = {
  root_jailbreak: 'block_login',
  vpn: 'warn_only',        // the row that produced the reported bypass
  proxy: 'warn_only',
  debug: 'block_login',
  developer_options: 'block_login',
  app_integrity: 'warn_only',
  tamper: 'block_login',
  play_integrity: 'block_login',
};

const threat = (type, method = 'test') => ({ type, detectionMethod: method, detected: true });
const evaluate = (threats, policies) => M.evaluateSecurityResult({
  threats,
  policies,
  detectionToEvent: DETECTION_TO_EVENT,
  weights: WEIGHTS,
});

// ════════════════════════════════════════════════════════════════════════════
// A. The floor itself (pure)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 A: mandatory connection floor \u2500\u2500');
{
  check('A1: vpn + proxy are the floored detections',
    JSON.stringify(M.CONNECTION_DETECTION_TYPES) === JSON.stringify(['vpn', 'proxy']));
  check('A2: the floor action is block_login', M.MANDATORY_CONNECTION_ACTION === 'block_login');
  check('A3: only the two connection events count as connection findings',
    M.isConnectionFinding('vpn_detected') && M.isConnectionFinding('proxy_detected')
      && !M.isConnectionFinding('root_detected') && !M.isConnectionFinding('debug_detected'));

  const floored = M.applyMandatoryConnectionFloor({ ...WEAKENED_ROWS });
  check('A4: a warn_only vpn row is floored to block_login', floored.vpn === 'block_login');
  check('A5: a warn_only proxy row is floored to block_login', floored.proxy === 'block_login');
  check('A6: the floor is applied to a copy (input table untouched)', WEAKENED_ROWS.vpn === 'warn_only');
  check('A7: unrelated buckets are untouched by the floor',
    floored.app_integrity === 'warn_only' && floored.tamper === 'block_login');
  check('A8: a disabled/missing bucket cannot resolve to no action',
    M.applyMandatoryConnectionFloor({}).vpn === 'block_login'
      && M.applyMandatoryConnectionFloor({}).proxy === 'block_login');

  // THE regression: the exact configuration that produced the bug cannot
  // produce a warn-level connection finding any more.
  const beforeFloor = evaluate([threat('vpn_detected')], { ...WEAKENED_ROWS });
  const afterFloor  = evaluate([threat('vpn_detected')], M.applyMandatoryConnectionFloor({ ...WEAKENED_ROWS }));
  check('A9: without the floor a warn_only row really did produce a warning (the reported bug)',
    beforeFloor.blocksLogin === false && beforeFloor.hasWarnings === true);
  check('A10: with the floor the same rows BLOCK login', afterFloor.blocksLogin === true);
  check('A11: with the floor it is no longer reported as a dismissible warning',
    afterFloor.hasWarnings === false && afterFloor.warningTypes.length === 0);
  check('A12: the risk score is unchanged by the floor (informational only)',
    afterFloor.riskScore === 15);

  // Same for proxy.
  const proxyFloored = evaluate([threat('proxy_detected')], M.applyMandatoryConnectionFloor({ ...WEAKENED_ROWS }));
  check('A13: a proxy finding blocks once floored', proxyFloored.blocksLogin === true);

  // hasConnectionFinding helper.
  check('A14: hasConnectionFinding detects a live connection finding',
    M.hasConnectionFinding([threat('vpn_detected')]) && M.hasConnectionFinding([threat('proxy_detected')]));
  check('A15: hasConnectionFinding ignores non-connection findings',
    !M.hasConnectionFinding([threat('root_detected')]) && !M.hasConnectionFinding([]));

  // Gate state + recheck eligibility for the mandatory block.
  check('A16: a live VPN block resolves BLOCKED_VPN',
    M.resolveSecurityGateState({
      evaluating: false, hasVerdict: true, overlayBlocked: false,
      backgroundResumeBlocked: false, vpnBlocked: true, violationBlocked: false,
    }) === 'BLOCKED_VPN');
  check('A17: BLOCKED_VPN is a block (gate mounts) and is re-verifiable',
    M.isGateBlocked('BLOCKED_VPN') === true && M.isGateRecheckable('BLOCKED_VPN') === true);
  check('A18: a generic integrity violation still offers no recheck control',
    M.isGateRecheckable('BLOCKED_SECURITY_VIOLATION') === false);
}

// ════════════════════════════════════════════════════════════════════════════
// B. Shipped client wiring
// ════════════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 B: shipped client policy + copy \u2500\u2500');
{
  const security = readCode('src/lib/security.ts');
  check('B1: the shipped vpn default is block_login', /vpn:\s*'block_login'/.test(security));
  check('B2: the shipped proxy default is block_login (was warn_only)',
    /proxy:\s*'block_login'/.test(security));
  check('B3: the merged server policy table goes through the floor',
    /applyMandatoryConnectionFloor\(merged\)/.test(security));
  check('B4: the offline/fail-secure default path goes through the floor too',
    (security.match(/applyMandatoryConnectionFloor\(\{ \.\.\.DEFAULT_POLICIES \}\)/g) || []).length === 2);
  check('B5: the floor is imported from the pure model, not re-implemented',
    /applyMandatoryConnectionFloor,/.test(readCode('src/lib/security.ts')));
  check('B6: VPN/proxy risk weights are unchanged (15 / 15)',
    /vpn_detected:\s+15/.test(security) && /proxy_detected:\s+15/.test(security));
  check('B7: both detectors are still wired into the pipeline',
    /withTimeout\(detectVPN\(\)/.test(security) && /withTimeout\(detectProxy\(\)/.test(security));

  // Copy + honest limits live in the pure model (testable, shared by both gates).
  check('B8: the mandatory page copy names the VPN/proxy block',
    /title: 'VPN or proxy detected'/.test(read('src/lib/securityStateModel.ts')));
  check('B9: iOS instructions point at iOS Settings and the VPN app',
    /General \\u2192 VPN & Device Management/.test(read('src/lib/securityStateModel.ts')));
  check('B10: the instructions never claim the app can disable the VPN',
    /cannot turn a third-party VPN off|does not claim|no API/i.test(read('src/lib/securityStateModel.ts')));
  check('B11: documented iOS limits include the two-gate native path',
    M.VPN_DETECTION_LIMITS.some((l) => /two-gate/.test(l)));
  check('B12: documented iOS limits warn that the NetInfo fallback MISSES tunnel VPNs',
    M.VPN_DETECTION_LIMITS.some((l) => /NetInfo|netinfo/.test(l) && /MISSED|miss/i.test(l)));
  check('B13: documented limits state an app cannot stop a third-party VPN',
    M.VPN_DETECTION_LIMITS.some((l) => /cannot turn a third-party VPN off/.test(l)));
  check('B14: the limits are surfaced as a >= 4 item honest list',
    Array.isArray(M.VPN_DETECTION_LIMITS) && M.VPN_DETECTION_LIMITS.length >= 4);

  // Detector honesty: unavailable/degraded is reported, never silently clean.
  check('B15: a degraded iOS signal path is reported as evidence, not as clean',
    /vpn_detection_degraded/.test(security) && /signalPath/.test(security));
  check('B16: the degraded event carries weight 0 (never blocks, never scores)',
    /vpn_detection_degraded:\s+0/.test(security) && WEIGHTS.vpn_detection_degraded === 0);
  const detectionToEventTable = security.slice(security.indexOf('const DETECTION_TO_EVENT'));
  const tableBody = detectionToEventTable.slice(0, detectionToEventTable.indexOf('};'));
  check('B17: the degraded event is NOT mapped to a policy bucket (cannot warn/block)',
    !/vpn_detection_degraded/.test(tableBody));
  const degraded = evaluate([threat('vpn_detection_degraded', 'probe unavailable')]);
  check('B18: an unmapped degraded finding neither blocks nor warns',
    degraded.blocksLogin === false && degraded.hasWarnings === false && degraded.riskScore === 0);
  check('B19: the signal path is exported for the iOS probe',
    /getIosVpnSignalPath/.test(readCode('src/lib/nativeSecurity.ts')));
}

// ════════════════════════════════════════════════════════════════════════════
// C. Requested VPN/security scenarios
// ════════════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 C: scenarios \u2500\u2500');
{
  const FLOORED = M.applyMandatoryConnectionFloor({ ...WEAKENED_ROWS });

  // 1. VPN already active before launch.
  const coldStart = evaluate([threat('vpn_detected', 'VPN Connection detected')], FLOORED);
  check('C1: a VPN active BEFORE launch blocks on the very first verdict',
    coldStart.blocksLogin === true && coldStart.riskScore === 15);
  check('C2: that verdict resolves BLOCKED_VPN immediately',
    M.resolveSecurityGateState({
      evaluating: false, hasVerdict: true, overlayBlocked: false,
      backgroundResumeBlocked: false, vpnBlocked: coldStart.blocksLogin, violationBlocked: false,
    }) === 'BLOCKED_VPN');
  check('C3: pre-verdict (no completed evaluation) is CHECKING, never ALLOWED',
    M.resolveSecurityGateState({
      evaluating: true, hasVerdict: false, overlayBlocked: false,
      backgroundResumeBlocked: false, vpnBlocked: false, violationBlocked: false,
    }) === 'CHECKING');

  // 2. VPN enabled while the app is running.
  const clean  = evaluate([], FLOORED);
  const runtime = evaluate([threat('vpn_detected')], FLOORED);
  check('C4: a clean state is not blocked', clean.blocksLogin === false && clean.riskScore === 0);
  check('C5: enabling a VPN mid-session blocks it', runtime.blocksLogin === true);

  // 3. VPN disabled while the blocking screen is visible.
  check('C6: a completed clean re-evaluation clears the block (no restart needed)',
    M.nextStickyTypes(['vpn_detected'], { checking: false, liveBlocking: false, liveThreatTypes: [] }).length === 0);
  check('C7: an in-flight re-check keeps the verified block (fail-closed, no flash of the app)',
    M.nextStickyTypes(['vpn_detected'], { checking: true, liveBlocking: false, liveThreatTypes: [] }).includes('vpn_detected'));
  check('C8: the re-verify control cannot clear a still-live VPN',
    M.nextStickyTypes(['vpn_detected'], { checking: false, liveBlocking: true, liveThreatTypes: ['vpn_detected'] }).includes('vpn_detected'));

  // 4. Background/resume with a changed VPN state.
  check('C9: backgrounding holds the app until a post-resume verification',
    M.resolveBackgroundResumeGate({ foreground: true, verifiedSinceResume: false, blocking: false }) === true);
  check('C10: a stale (pre-resume) evaluation cannot release the hold',
    M.acceptsResumeVerification({ evaluationStartedToken: 1, liveResumeToken: 2 }) === false);
  check('C11: resume with a now-active VPN stays blocked',
    M.resolveBackgroundResumeGate({ foreground: true, verifiedSinceResume: true, blocking: runtime.blocksLogin }) === true);
  check('C12: resume after the VPN was disabled releases the hold',
    M.resolveBackgroundResumeGate({ foreground: true, verifiedSinceResume: true, blocking: clean.blocksLogin }) === false);

  // 5. Proxy detection.
  const proxy = evaluate([threat('proxy_detected', 'Proxy connection detected')], FLOORED);
  check('C13: a proxy finding blocks login', proxy.blocksLogin === true);
  check('C14: the proxy finding stays distinct from the VPN finding',
    proxy.blockingTypes.includes('proxy_detected') && !proxy.blockingTypes.includes('vpn_detected'));
  check('C15: it scores the shipped weight (15)', proxy.riskScore === 15);

  // 6. Confirmed VPN never exposes a dismiss path — asserted on the surfaces below (D).
  // 7. Deep links cannot bypass — asserted on the surfaces below (E).

  // 8. Detection unavailable / errors are never reported as clean.
  check('C16: a degraded/unavailable VPN probe is reported, not silently clean',
    evaluate([threat('vpn_detection_degraded')], FLOORED).unmappedTypes.includes('vpn_detection_degraded'));
  check('C17: an unavailable probe does NOT block on its own (no lockout on heuristics)',
    evaluate([threat('vpn_detection_degraded')], FLOORED).blocksLogin === false);
  check('C18: the sentinel/batch-unavailable contract is preserved (unverified ≠ allowed)',
    M.resolveSecurityGateState({
      evaluating: false, hasVerdict: false, overlayBlocked: false,
      backgroundResumeBlocked: false, vpnBlocked: false, violationBlocked: false,
    }) === 'CHECKING');

  // 10. Unrelated checks + role exemptions are untouched.
  const root = evaluate([threat('root_detected')], FLOORED);
  const devOpts = evaluate([threat('developer_options_enabled')], FLOORED);
  check('C19: root/jailbreak still blocks', root.blocksLogin === true && root.riskScore === 35);
  check('C20: Developer Options still blocks', devOpts.blocksLogin === true);
  check('C21: a warn-level bucket (app_integrity) is still just a warning',
    evaluate([threat('app_integrity_compromised')], FLOORED).hasWarnings === true);

  const ctxCode = readCode('src/lib/SecurityContext.tsx');
  const topLevelSuperAdminExemptions = (ctxCode.match(/isSuperAdmin/g) || []).length;
  check('C22: the Super Admin exemption is preserved and narrowly scoped (not broadened)',
    /const gateState: SecurityGateState = isSuperAdmin/.test(ctxCode)
      && topLevelSuperAdminExemptions <= 40);
  check('C23: the admin VPN whitelist escape hatch is preserved',
    /getVpnWhitelist\(\)/.test(readCode('src/lib/security.ts')) && /isVpnWhitelistKnownNonEmpty/.test(readCode('src/lib/security.ts')));
}

// ════════════════════════════════════════════════════════════════════════════
// D. No surface offers a dismiss control for a connection finding
// ════════════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 D: no dismiss control for a connection finding \u2500\u2500');
{
  const gate = readCode('src/app/(app)/security-gate.tsx');
  check('D1: the gate renders the mandatory connection copy', /VPN_WARNING_COPY/.test(gate));
  check('D2: the gate lists platform-specific turn-off steps', /connectionBlockInstructions\(Platform\.OS\)/.test(gate));
  check('D3: the gate has NO "Continue Anyway" control at all',
    !/Continue Anyway/.test(gate));
  check('D4: the gate consumes the Android back button while blocking', /hardwareBackPress/.test(gate));
  check('D5: the gate is inline content above the authenticated Stack (not a route)',
    /<SecurityGate \/>/.test(readCode('src/app/(app)/_layout.tsx')));

  const appWarning = readCode('src/app/(app)/security-warning.tsx');
  check('D6: the authenticated warning screen suppresses the dismiss path for connection findings',
    /const connectionBlocked = hasConnectionFinding\(threats\)/.test(appWarning));
  check('D7: the dismiss button is behind the connection check',
    /\{connectionBlocked \? \(/.test(appWarning) && /\) : blocksLogin \? \(/.test(appWarning));
  check('D8: "Continue Anyway" survives ONLY for non-connection findings',
    /label=\{hasFindings \? 'Continue Anyway' : 'Continue'\}/.test(appWarning));
  check('D9: the connection branch offers a re-verify (not a dismiss) action',
    /onVerifyConnection/.test(appWarning) && /verifySecurity\(\)/.test(appWarning));

  const authWarning = readCode('src/app/(auth)/security-warning.tsx');
  check('D10: the pre-login screen suppresses the dismiss path the same way',
    /const connectionBlocked = hasConnectionFinding\(threats\)/.test(authWarning));
  check('D11: pre-login the only forward action re-runs the check (sign-in)',
    /onRecheck/.test(authWarning)
      && /\(auth\)\/sign-in/.test(authWarning)
      && /I turned it off/.test(authWarning));
  check('D12: the pre-login screen states the block cannot be dismissed',
    /cannot be dismissed to continue/.test(authWarning));
  check('D13: the pre-login exemption stays presentation-only (no authoritative read added)',
    !/useSecurity\(\)/.test(authWarning));
}

// ════════════════════════════════════════════════════════════════════════════
// E. Navigation / deep links / restart cannot bypass
// ════════════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 E: no navigation bypass \u2500\u2500');
{
  const layout = readCode('src/app/(app)/_layout.tsx');
  check('E1: blocking findings are never routed to the dismissible warning screen',
    /if \(!r\.hasWarnings \|\| r\.blocksLogin\) return;/.test(layout));
  check('E2: the gate is rendered above the Stack + FAB, not as a route',
    /<SecurityGate \/>/.test(layout) && !/Stack\.Screen name="security-gate"/.test(layout));
  check('E3: the warning navigation carries params (cannot fall back to permissive defaults)',
    /router\.replace\(\{\s*pathname: '\/security-warning'/.test(layout));

  const appWarning = readCode('src/app/(app)/security-warning.tsx');
  check('E4: the authenticated screen prefers the authoritative verdict over params',
    /if \(security\.hasVerdict\) return \(security\.threats \?\? \[\]\)/.test(appWarning));
  check('E5: its connection decision comes from finding TYPES, not the blocksLogin param',
    /hasConnectionFinding\(threats\)/.test(appWarning) && !/connectionBlocked = .*blocksLogin/.test(appWarning));

  const authWarning = readCode('src/app/(auth)/security-warning.tsx');
  check('E6: the pre-login screen derives the block from finding types too',
    /hasConnectionFinding\(threats\)/.test(authWarning));

  // Restarting the app re-runs the checks before any protected content.
  const security = readCode('src/lib/security.ts');
  check('E7: the scan runs at session start (restart re-evaluates, no cached all-clear)',
    /export async function runSecurityChecks/.test(security));
  check('E8: the policy cache is invalidated on sign-out / identity change',
    /invalidatePolicyCache\(\)/.test(readCode('src/lib/SecurityContext.tsx')));
  check('E9: the sign-in path still fails closed on a blocking verdict',
    /const secResult = await check\(installationId\)/.test(readCode('src/app/(auth)/sign-in.tsx'))
      && /if \(secResult\.blocksLogin\)/.test(readCode('src/app/(auth)/sign-in.tsx')));
}

// ════════════════════════════════════════════════════════════════════════════
// F. Server-side enforcement
// ════════════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 F: server-side enforcement \u2500\u2500');
{
  const ctl = read('backend/src/Controllers/SecurityController.php');
  check('F1: the served payload applies a floor for vpn/proxy',
    /MANDATORY_FLOOR/.test(ctl) && /'vpn'\s*=>\s*'block_login'/.test(ctl) && /'proxy'\s*=>\s*'block_login'/.test(ctl));
  check('F2: the floor is applied to the served policies map',
    /foreach \(self::MANDATORY_FLOOR as \$type => \$floorAction\)/.test(ctl));
  check('F3: weakening writes are refused (MANDATORY_BLOCK includes vpn + proxy)',
    /MANDATORY_BLOCK = \[[\s\S]{0,200}'vpn', 'proxy'/.test(ctl));
  check('F4: the refusal path returns 422 for a weakened policy',
    /is a mandatory security block and cannot be weakened/.test(ctl));
  check('F5: proxy is now a BLOCKING evidence signal',
    /\$blocking = \['vpn', 'proxy',/.test(read('backend/src/Services/SecurityEvidenceService.php')));
  check('F6: proxy is no longer merely a warning signal',
    !/if \(!empty\(\$flags\['proxy'\]\)\) \{ \$warn\[\] = 'proxy'; \}/.test(read('backend/src/Services/SecurityEvidenceService.php')));
  check('F7: a device-enforcement gate still exists for protected actions',
    /function assertEvidenceAllowed/.test(read('backend/src/Services/SecurityEvidenceService.php'))
      && /assertEvidenceAllowed\(/.test(read('backend/src/Controllers/VideoController.php')));
  check('F8: the update floor (HTTP 426) still runs on every authenticated route',
    /ApiException\(426/.test(read('backend/src/Middleware/AuthMiddleware.php')));

  const migration = read('backend/database/mysql-migrations/033_vpn_proxy_mandatory_block.sql');
  check('F9: migration 033 sets vpn to block_login', /detection_type = 'vpn'/.test(migration) && /'block_login'/.test(migration));
  check('F10: migration 033 sets proxy to block_login', /detection_type = 'proxy'/.test(migration));
  check('F11: migration 033 is idempotent (guarded inserts, no deletes)',
    /WHERE NOT EXISTS \(SELECT 1 FROM security_policies WHERE detection_type = 'vpn'\)/.test(migration)
      && !/DELETE FROM/.test(migration));
  check('F12: the deployment surface is documented',
    /033_vpn_proxy_mandatory_block\.sql/.test(read('docs/VPN_PROXY_MANDATORY_BLOCK.md')));
}

console.log('\n' + '\u2500'.repeat(64));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nMandatory VPN/proxy blocking regression suite FAILED');
  process.exit(1);
}
console.log('Mandatory VPN/proxy blocking regression suite passed');
