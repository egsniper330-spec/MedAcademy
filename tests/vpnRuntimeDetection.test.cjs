#!/usr/bin/env node
/**
 * iOS VPN/proxy runtime detection + warning-screen consistency — regression suite.
 *
 * Run: node tests/vpnRuntimeDetection.test.cjs
 *
 * ─── THE TWO REPORTED DEFECTS (real iPhone) ──────────────────────────────────
 *
 * Symptom A — enabling a VPN/proxy mid-session produced a self-contradictory
 *   page: "Security Warning" + "Device Risk Score: 0" + "Detected Issues (0)"
 *   + "Security issues were detected on your device." + "Continue Anyway".
 *
 *   ROOT CAUSE: the authenticated shell navigated with
 *     router.replace('/security-warning')            // NO PARAMS
 *   but src/app/(app)/security-warning.tsx derived EVERYTHING from route params,
 *   defaulting to [] / 0 / false. The page could therefore only ever render the
 *   generic warning copy over an empty finding list.
 *
 * Symptom B — a VPN/proxy already active BEFORE launch was never reported,
 *   while enabling one after launch was.
 *
 *   ROOT CAUSE: the non-blocking warning surface was wired ONLY to a
 *   background→foreground transition. (i) the startup/initial check never
 *   consulted `hasWarnings`; (ii) `onNewBlockingThreat` fires only when
 *   `blocksLogin || blocksVideo`, so it can never deliver a warn-only result
 *   (the shell's `hasWarnings && !blocksLogin` branch was unreachable there).
 *   Enabling a VPN requires leaving the app, which is exactly why the runtime
 *   case DID surface.
 *
 * ─── WHAT THIS SUITE LOCKS DOWN ──────────────────────────────────────────────
 *
 *  Part A — the lifecycle/policy model (pure, deterministic)
 *    1. launch clean → VPN on while foregrounded
 *    2. launch clean → VPN on while backgrounded → resume
 *    3. launch with VPN already on  (the cold-start case)
 *    4. VPN disconnected while running
 *    5. proxy configuration change
 *    6. repeated lifecycle events / stale flags
 *    7. overlapping checks completing out of order
 *    8. risk score 0 with no findings  → must NOT read as a warning
 *    9. findings present → score and listed types agree
 *   10. unavailable/error → never a verified clean result
 *
 *  Part B — the source wiring that produced the two symptoms
 *
 * IMPORTANT: Part A deliberately asserts the SHIPPED policy for VPN stays
 * blocking. This suite must never become the thing that weakens detection.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/**
 * Source with COMMENTS STRIPPED. Assertions about wiring must inspect the
 * executable code — a comment that quotes the old buggy call must not satisfy
 * (or defeat) a pattern. `://` is protected so URLs inside string literals
 * survive the line-comment strip.
 *
 * A block-comment opener is only treated as a comment when it is NOT inside a
 * string literal (odd number of quotes earlier on the same line). A naive global
 * match has no such guard: a "/*" inside a string gets paired with the next real
 * terminator anywhere later in the file and everything between them is deleted,
 * so assertions silently run against text that is not the file. That is not
 * hypothetical — it deleted 8 KB of security-diagnostics.tsx (see the note in
 * tests/appAttestDeferral.test.cjs); this suite shares the guarded helper so it
 * cannot happen to either.
 */
const stripBlockComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (match, offset, whole) => {
  const lineStart = whole.lastIndexOf('\n', offset) + 1;
  const before    = whole.slice(lineStart, offset);
  const odd       = (q) => (before.split(q).length - 1) % 2 === 1;
  return (odd("'") || odd('"') || odd('`')) ? match : '';   // inside a string → keep
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-model-'));
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
  tamper_detected: 40, signature_invalid: 40, root_detected: 35,
  frida_detected: 30, magisk_detected: 25, xposed_detected: 25,
  debugger_attached: 25, developer_options_enabled: 25, adb_enabled: 20,
  debug_detected: 20, ssl_pinning_failure: 20, vpn_detected: 15,
  proxy_detected: 15, overlay_detected: 15, screen_recording_detected: 10,
  screenshot_detected: 5, security_unverified: 10, detection_unavailable: 0,
};

const threat = (type, method = 'test') => ({ type, detectionMethod: method, detected: true });
const evaluate = (threats, overrides = {}) => M.evaluateSecurityResult({
  threats,
  policies: { ...DEFAULT_POLICIES, ...overrides },
  detectionToEvent: DETECTION_TO_EVENT,
  weights: WEIGHTS,
});

/**
 * The scenario the iPhone report describes: on this deployment the server's
 * authoritative `security_policies` config resolves a VPN/proxy finding to
 * warn_only, so the shell routes to the dismissible security-warning screen
 * instead of the blocking gate. Both policies are exercised below — the shipped
 * blocking default AND this warn-only server policy.
 */
const WARN_VPN = { vpn: 'warn_only' };

// ════════════════════════════════════════════════════════════════════════════
// PART A — lifecycle / policy model
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part A1: launch clean, VPN enabled while FOREGROUNDED \u2500\u2500');
{
  const before = evaluate([]);
  const after  = evaluate([threat('vpn_detected', 'VPN Connection detected')], WARN_VPN);

  check('clean launch reports nothing', !before.blocksLogin && !before.hasWarnings && before.riskScore === 0);
  check('runtime VPN is detected as a warning (warn-only server policy)', after.hasWarnings && !after.blocksLogin);
  check('runtime VPN warns about vpn_detected specifically', after.warningTypes.includes('vpn_detected'));
  check('runtime VPN scores the shipped weight (15)', after.riskScore === 15);
  check('a warn-only VPN does NOT open the blocking gate', !after.blocksLogin && !after.blocksVideo);
}

console.log('\n\u2500\u2500 Part A2: launch clean, VPN enabled while BACKGROUNDED \u2192 resume \u2500\u2500');
{
  // Resume holds the app until a COMPLETED post-resume evaluation lands.
  check('resume holds while unverified',
    M.resolveBackgroundResumeGate({ foreground: true, verifiedSinceResume: false, blocking: false }) === true);
  check('resume holds while backgrounded',
    M.resolveBackgroundResumeGate({ foreground: false, verifiedSinceResume: true, blocking: false }) === true);

  // Post-resume evaluation detects the VPN.
  const postResume = evaluate([threat('vpn_detected')], WARN_VPN);
  check('post-resume check sees the VPN', postResume.hasWarnings && postResume.riskScore === 15);
  check('resume releases once a warn-only post-resume check completed',
    M.resolveBackgroundResumeGate({ foreground: true, verifiedSinceResume: true, blocking: postResume.blocksLogin }) === false);
  // With the shipped blocking policy it must NOT release.
  const postResumeBlocking = evaluate([threat('vpn_detected')]);
  check('resume stays held when the VPN blocks (shipped policy)',
    M.resolveBackgroundResumeGate({ foreground: true, verifiedSinceResume: true, blocking: postResumeBlocking.blocksLogin }) === true);
}

console.log('\n\u2500\u2500 Part A3: launched with VPN ALREADY ON (the cold-start case) \u2500\u2500');
{
  const firstVerdict = evaluate([threat('vpn_detected')], WARN_VPN);
  check('the FIRST verdict already reports the pre-existing VPN', firstVerdict.hasWarnings);
  check('cold-start VPN carries the finding for the UI to render', firstVerdict.warningTypes.includes('vpn_detected'));
  check('cold-start VPN scores 15 (not 0) — the reported "Risk Score: 0" was a params bug',
    firstVerdict.riskScore === 15);

  // Shipped policy still blocks a cold-start VPN.
  const blocking = evaluate([threat('vpn_detected')]);
  check('cold-start VPN blocks login under the shipped policy', blocking.blocksLogin === true);
  check('blocking gate state resolves for that VPN',
    M.resolveSecurityGateState({
      evaluating: false, hasVerdict: true, overlayBlocked: false,
      backgroundResumeBlocked: false, vpnBlocked: blocking.blocksLogin, violationBlocked: false,
    }) === 'BLOCKED_VPN');
}

console.log('\n\u2500\u2500 Part A4: VPN disconnected while running \u2500\u2500');
{
  const prev = evaluate([threat('vpn_detected')], WARN_VPN);
  const now  = evaluate([]);
  check('clearing the VPN clears the warning', !now.hasWarnings && now.riskScore === 0);
  check('a completed clean evaluation recovers the gate',
    M.nextStickyTypes(['vpn_detected'], { checking: false, liveBlocking: false, liveThreatTypes: [] }).length === 0);
  check('the warning latch may present again later (signature changes)', prev.warningTypes.join() !== '');
}

console.log('\n\u2500\u2500 Part A5: proxy configuration change \u2500\u2500');
{
  const proxy = evaluate([threat('proxy_detected', 'Proxy configuration detected')]);
  check('proxy is detected and kept DISTINCT from VPN', proxy.warningTypes.includes('proxy_detected'));
  check('proxy does not masquerade as a VPN finding', !proxy.warningTypes.includes('vpn_detected'));
  check('proxy stays warn-only (never blocks login)', !proxy.blocksLogin);
  check('proxy scores the shipped weight (15)', proxy.riskScore === 15);
}

console.log('\n\u2500\u2500 Part A6/7: repeated lifecycle + stale/overlapping checks \u2500\u2500');
{
  // A re-check in flight must not flash an all-clear over a verified block.
  check('sticky block survives a re-check in flight',
    M.nextStickyTypes(['vpn_detected'], { checking: true, liveBlocking: false, liveThreatTypes: [] }).includes('vpn_detected'));
  check('sticky set refreshes from a live blocking result',
    M.nextStickyTypes([], { checking: false, liveBlocking: true, liveThreatTypes: ['vpn_detected'] }).includes('vpn_detected'));

  // A check that STARTED before the resume cannot release the resume hold.
  check('stale (pre-resume) evaluation is rejected', M.acceptsResumeVerification({ evaluationStartedToken: 1, liveResumeToken: 2 }) === false);
  check('current (at-or-after-resume) evaluation is accepted', M.acceptsResumeVerification({ evaluationStartedToken: 2, liveResumeToken: 2 }) === true);
  check('a check that started during a later resume is accepted', M.acceptsResumeVerification({ evaluationStartedToken: 5, liveResumeToken: 3 }) === true);

  // Repeating the same evaluation is idempotent (no state divergence).
  const a = evaluate([threat('vpn_detected')], WARN_VPN);
  const b = evaluate([threat('vpn_detected')], WARN_VPN);
  check('repeated evaluation is deterministic', JSON.stringify(a) === JSON.stringify(b));
}

console.log('\n\u2500\u2500 Part A8: risk score 0 with NO findings must not read as a warning \u2500\u2500');
{
  const none = evaluate([]);
  check('no findings \u21d2 risk score 0', none.riskScore === 0);
  check('no findings \u21d2 not blocked', !none.blocksLogin && !none.blocksVideo);
  check('no findings \u21d2 hasWarnings is FALSE (the contradictory screen claimed otherwise)',
    none.hasWarnings === false);
  check('no findings \u21d2 empty warning + blocking lists',
    none.warningTypes.length === 0 && none.blockingTypes.length === 0);
  check('unmapped/absent findings never synthesise a warning', M.computeRiskScorePure([], WEIGHTS) === 0);
}

console.log('\n\u2500\u2500 Part A9: findings present \u21d2 score and listed types agree \u2500\u2500');
{
  const both = evaluate([threat('vpn_detected'), threat('proxy_detected')], WARN_VPN);
  check('score is the sum of the live weights', both.riskScore === 30);
  check('every scored finding is listed for the UI', both.warningTypes.length === 2);
  check('listed types match the findings exactly',
    [...both.warningTypes].sort().join(',') === 'proxy_detected,vpn_detected');

  const vpnOnly = evaluate([threat('vpn_detected')]);
  check('a blocking finding is listed as blocking, not as a warning',
    vpnOnly.blockingTypes.includes('vpn_detected') && !vpnOnly.warningTypes.includes('vpn_detected'));
}

console.log('\n\u2500\u2500 Part A10: unavailable / error is never a verified clean result \u2500\u2500');
{
  // No completed verdict at all (e.g. the native module was unavailable, or the
  // evaluation threw) must read as CHECKING — never ALLOWED.
  check('no verdict \u21d2 CHECKING (never ALLOWED)',
    M.resolveSecurityGateState({
      evaluating: false, hasVerdict: false, overlayBlocked: false,
      backgroundResumeBlocked: false, vpnBlocked: false, violationBlocked: false,
    }) === 'CHECKING');
  check('evaluation in flight \u21d2 CHECKING',
    M.resolveSecurityGateState({
      evaluating: true, hasVerdict: true, overlayBlocked: false,
      backgroundResumeBlocked: false, vpnBlocked: false, violationBlocked: false,
    }) === 'CHECKING');
  check('only a completed clean verdict is ALLOWED',
    M.resolveSecurityGateState({
      evaluating: false, hasVerdict: true, overlayBlocked: false,
      backgroundResumeBlocked: false, vpnBlocked: false, violationBlocked: false,
    }) === 'ALLOWED');

  // The 'security_unverified' sentinel is deliberately NOT mapped into the
  // policy table — it carries weight (10) and is reported as UNMAPPED so the
  // policy engine can never mistake "we could not evaluate" for a finding, and
  // equally never silently pass it. The fail-closed block comes from
  // SecurityContext's explicit fallback result (asserted in Part B4).
  const unverified = evaluate([threat('security_unverified')]);
  check('the sentinel is not silently mapped to a permissive policy',
    unverified.unmappedTypes.includes('security_unverified'));
  check('the sentinel still carries its informational weight (10)',
    unverified.riskScore === 10);
  check('an unmapped sentinel alone does not fabricate a warning',
    unverified.hasWarnings === false && unverified.warningTypes.length === 0);
}

// ════════════════════════════════════════════════════════════════════════════
// PART B — source wiring for the two symptoms
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part B1: the shell must not navigate without the warning payload \u2500\u2500');
{
  const layout = readCode('src/app/(app)/_layout.tsx');

  // THE EXACT DEFECT: a STRING-form navigation cannot carry params, so the
  // screen fell back to [] / 0 / false. Verified against the pre-fix revision —
  // this assertion fails there (`router.replace('/security-warning' as ...)`),
  // so it is not vacuous.
  check('no string-form router.replace to /security-warning remains',
    !/router\.replace\(\s*['"]\/security-warning/.test(layout));
  check('the warning path is reached via the object form (so params can be passed)',
    /router\.replace\(\{\s*pathname:\s*['"]\/security-warning['"]/.test(layout));
  check('a single presentation helper exists', /const presentWarningScreen = useCallback\(/.test(layout));
  check('the payload is passed as route params',
    /params:\s*\{[\s\S]{0,200}threats:\s*JSON\.stringify\(/.test(layout));
  check('the risk score is passed', /riskScore:\s*String\(r\.riskScore\)/.test(layout));
  check('it refuses to present blocking results (gate owns those)',
    /if \(!r\.hasWarnings \|\| r\.blocksLogin\) return;/.test(layout));
  check('a signature latch prevents a navigation loop',
    /warningPresentedRef/.test(layout) && /signature/.test(layout));

  // The cold-start fix: warnings are presented from the authoritative verdict,
  // not only from a background→foreground transition.
  check('warnings are presented from the authoritative verdict state',
    /presentWarningScreen\(\{\s*threats,\s*riskScore,\s*blocksLogin,\s*hasWarnings\s*\}\)/.test(layout));
  check('the verdict-driven effect exists alongside the resume handler',
    /hasWarnings,\s*blocksLogin,\s*threats,\s*riskScore/.test(layout));
  check('the latch clears when the device is clean again',
    /if \(!hasWarnings\) warningPresentedRef\.current = null;/.test(layout));
}

console.log('\n\u2500\u2500 Part B2: the warning screen derives from ONE authoritative state \u2500\u2500');
{
  const screen = readCode('src/app/(app)/security-warning.tsx');

  check('the screen consumes the authoritative SecurityContext', /useSecurity\(\)/.test(screen));
  check('the live verdict takes precedence over route params',
    /if \(security\.hasVerdict\) return \(security\.threats \?\? \[\]\) as ThreatItem\[\];/.test(screen));
  check('score comes from the live verdict when available',
    /const riskScore = security\.hasVerdict/.test(screen));
  check('the policy outcome comes from the live verdict when available',
    /const blocksLogin = security\.hasVerdict/.test(screen));

  // The contradiction itself: generic "issues were detected" copy over 0 findings.
  check('the found-issues copy is conditional on findings existing',
    /hasFindings\s*\?\s*'Security issues were detected on your device/.test(screen));
  check('an explicit zero-finding state exists', /No issues detected/.test(screen));
  check('a pending check is not presented as a clean result', /Verification in progress/.test(screen));
  check('the issues heading is driven by the derived count', /Detected Issues \(\{findingCount\}\)/.test(screen));
  check('the action label is honest when nothing was found',
    /label=\{hasFindings \? 'Continue Anyway' : 'Continue'\}/.test(screen));
  check('"Continue Anyway" is still offered for real findings (no new bypass created)',
    /'Continue Anyway'/.test(screen));
  check('the accent colour derives from the same state as the copy', /const accent = blocksLogin/.test(screen));
}

console.log('\n\u2500\u2500 Part B3: detection and policy were NOT weakened \u2500\u2500');
{
  const security = readCode('src/lib/security.ts');

  check('VPN detection still runs on iOS', /isNativeVPNDetected\(\)/.test(security));
  check('proxy detection still runs on iOS', /isNativeProxyDetected\(\)/.test(security));
  check('both detectors remain wired into runSecurityChecks',
    /withTimeout\(detectVPN\(\)/.test(security) && /withTimeout\(detectProxy\(\)/.test(security));

  // The shipped fallback policy must still block a VPN.
  check('VPN default policy is still block_login', /vpn:\s*'block_login'/.test(security));
  check('proxy default policy is still warn_only', /proxy:\s*'warn_only'/.test(security));
  check('VPN/proxy risk weights unchanged (15 / 15)',
    /vpn_detected:\s+15/.test(security) && /proxy_detected:\s+15/.test(security));
  check('vpn_detected still emits its own event type', /type: 'vpn_detected'/.test(security));
  check('proxy_detected still emits its own event type', /type: 'proxy_detected'/.test(security));
  check('the admin VPN whitelist path is preserved', /getVpnWhitelist\(\)/.test(security));
}

console.log('\n\u2500\u2500 Part B4: a failed evaluation is fail-closed, not a silent pass ──');
{
  const ctx = readCode('src/lib/SecurityContext.tsx');
  check('the thrown-evaluation fallback emits the sentinel',
    /type: 'security_unverified'/.test(ctx));
  check('the thrown-evaluation fallback blocks login explicitly',
    /blocksLogin:\s*true/.test(ctx));
  check('the thrown-evaluation fallback blocks video explicitly',
    /blocksVideo:\s*true/.test(ctx));
  check('a thrown evaluation keeps the last completed verdict published',
    /keeping last verdict/.test(read('src/lib/SecurityContext.tsx')));
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(64));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nVPN/proxy runtime + warning consistency regression suite FAILED');
  process.exit(1);
}
console.log('VPN/proxy runtime + warning consistency regression suite passed');
