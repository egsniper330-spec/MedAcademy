#!/usr/bin/env node
/**
 * Centralized security gate state — regression suite for the PURE model.
 *
 * Run: node tests/securityGateState.test.cjs   (or npm run test:state)
 *
 * WHAT THIS LOCKS DOWN (root causes, each one a real observed defect)
 * ──────────────────────────────────────────────────────────────────────────
 * 1. NO COMMON VOCABULARY. Gate visibility was derived from `blocksLogin`
 *    alone, so an overlay/tapjacking signal and a background→resume transition
 *    — which are NOT policy findings — had no representation. Folding them into
 *    `blocksLogin` would have shown the wrong copy and collapsed three distinct
 *    recovery paths into one; leaving them out meant they never gated at all.
 *    resolveSecurityGateState() is now the single closed vocabulary.
 *
 * 2. BLOCKED → CHECKING → TEMP-ALLOWED. A re-check in flight must never
 *    downgrade a verified block into something a consumer could read as
 *    recoverable, and UNKNOWN must never read as ALLOWED (the startup-flash
 *    contract). The precedence order encodes both.
 *
 * 3. HOME → REOPEN → UNPROTECTED WINDOW. The previous resume path re-checked
 *    but held nothing, so the last pre-background verdict kept the app usable
 *    while the fresh check ran. resolveBackgroundResumeGate() holds from the
 *    instant the app leaves the foreground until a COMPLETED post-resume
 *    evaluation passes.
 *
 * 4. STALE VERDICT RELEASING A NEWER HOLD. A check that began BEFORE the resume
 *    could land afterwards and unblock the app on evidence that predates the
 *    state it claims to verify. acceptsResumeVerification() rejects it.
 *
 * 5. DISMISS-THE-WARNING BYPASS. Clearing the overlay gate must require BOTH a
 *    cleared platform signal AND a fresh verdict — never merely that the user
 *    acknowledged the warning. canClearOverlayBlock() encodes that.
 *
 * The module is dependency-free by design (see its header), so it is compiled
 * standalone here — matching tests/securityLock.test.cjs.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

function buildModel() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-model-'));
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

const NO_INPUT = {
  evaluating: false,
  hasVerdict: true,
  overlayBlocked: false,
  backgroundResumeBlocked: false,
  vpnBlocked: false,
  violationBlocked: false,
};

const state = (over) => M.resolveSecurityGateState({ ...NO_INPUT, ...over });

// ── Part 1: the closed vocabulary ────────────────────────────────────────────
console.log('── Part 1: state vocabulary ──');
{
  const expected = [
    'CHECKING', 'BLOCKED_OVERLAY', 'BLOCKED_BACKGROUND_RESUME',
    'BLOCKED_VPN', 'BLOCKED_SECURITY_VIOLATION', 'ALLOWED',
  ];
  check('1a: exactly the six required states are enumerated',
    JSON.stringify(M.SECURITY_GATE_STATES) === JSON.stringify(expected));
}

// ── Part 2: precedence (fail-closed, most-trusted-blocker first) ─────────────
console.log('── Part 2: precedence ──');
{
  check('2a: nothing blocking + verdict → ALLOWED', state({}) === 'ALLOWED');

  check('2b: overlay outranks every other cause',
    state({ overlayBlocked: true, backgroundResumeBlocked: true, vpnBlocked: true, violationBlocked: true })
      === 'BLOCKED_OVERLAY');

  check('2c: background/resume outranks VPN and violation',
    state({ backgroundResumeBlocked: true, vpnBlocked: true, violationBlocked: true })
      === 'BLOCKED_BACKGROUND_RESUME');

  check('2d: VPN outranks a generic violation',
    state({ vpnBlocked: true, violationBlocked: true }) === 'BLOCKED_VPN');

  check('2e: a non-VPN policy block → BLOCKED_SECURITY_VIOLATION',
    state({ violationBlocked: true }) === 'BLOCKED_SECURITY_VIOLATION');

  // THE invariant that closes BLOCKED → CHECKING → TEMP-ALLOWED.
  check('2f: a live block outranks a check in flight (never downgraded to CHECKING)',
    state({ evaluating: true, violationBlocked: true }) === 'BLOCKED_SECURITY_VIOLATION');
  check('2g: a live block outranks a check in flight even while re-validating a sticky block',
    state({ evaluating: true, hasVerdict: true, vpnBlocked: true }) === 'BLOCKED_VPN');
}

// ── Part 3: UNKNOWN is never ALLOWED (startup-flash contract) ────────────────
console.log('── Part 3: fail-closed on an unverified state ──');
{
  check('3a: no completed verdict → CHECKING, never ALLOWED',
    state({ hasVerdict: false }) === 'CHECKING');
  check('3b: evaluating with a completed verdict and nothing blocking → CHECKING',
    state({ evaluating: true }) === 'CHECKING');
  check('3c: cold start with a check running is still CHECKING',
    state({ hasVerdict: false, evaluating: true }) === 'CHECKING');
  check('3d: CHECKING is not a block (the gate does not mount)',
    M.isGateBlocked('CHECKING') === false && M.isGateBlocked('ALLOWED') === false);
  check('3e: every BLOCKED_* state is a block',
    ['BLOCKED_OVERLAY', 'BLOCKED_BACKGROUND_RESUME', 'BLOCKED_VPN', 'BLOCKED_SECURITY_VIOLATION']
      .every((s) => M.isGateBlocked(s) === true));
}

// ── Part 4: background → resume gate ────────────────────────────────────────
console.log('── Part 4: background/resume hold ──');
{
  const g = (over) => M.resolveBackgroundResumeGate({
    foreground: true, verifiedSinceResume: true, blocking: false, ...over,
  });

  check('4a: leaving the foreground IMMEDIATELY holds, with no verification yet',
    g({ foreground: false, verifiedSinceResume: false }) === true);
  check('4b: backgrounded even after a clean pre-background verification still holds',
    g({ foreground: false, verifiedSinceResume: true }) === true);
  check('4c: resumed but not yet verified → still held (no unprotected window)',
    g({ foreground: true, verifiedSinceResume: false }) === true);
  check('4d: resumed + verified + nothing blocking → released',
    g({ foreground: true, verifiedSinceResume: true, blocking: false }) === false);
  check('4e: resumed + verified + blocking stays held',
    g({ foreground: true, verifiedSinceResume: true, blocking: true }) === true);
  check('4f: a blocking verdict in the background keeps the hold',
    g({ foreground: false, verifiedSinceResume: true, blocking: true }) === true);
  check('4g: a timed-out / failed evaluation leaves verifiedSinceResume false → held',
    g({ foreground: true, verifiedSinceResume: false, blocking: false }) === true);
}

// ── Part 5: stale-async guard for the resume verification ───────────────────
console.log('── Part 5: stale asynchronous results ──');
{
  const a = (evaluationStartedToken, liveResumeToken) =>
    M.acceptsResumeVerification({ evaluationStartedToken, liveResumeToken });

  check('5a: an evaluation that started AFTER the resume is accepted', a(3, 3) === true);
  check('5b: an evaluation that started BEFORE the resume is rejected', a(2, 3) === false);
  check('5c: rapid second background invalidates the first resume\u2019s evaluation', a(3, 4) === false);
  check('5d: never backgrounded (token 0) accepts a token-0 evaluation', a(0, 0) === true);
  check('5e: a superseded older evaluation can never look fresh', a(1, 9) === false);
}

// ── Part 6: overlay release rule (no dismiss-the-warning bypass) ────────────
console.log('── Part 6: overlay gate release rule ──');
{
  const c = (signalCleared, hasFreshVerdict) => M.canClearOverlayBlock({ signalCleared, hasFreshVerdict });

  check('6a: signal cleared AND a fresh verdict → may clear', c(true, true) === true);
  check('6b: acknowledging the warning with the signal still live CANNOT clear', c(false, true) === false);
  check('6c: a cleared signal with NO fresh verdict cannot clear (dismiss is not verification)',
    c(true, false) === false);
  check('6d: neither condition → cannot clear', c(false, false) === false);
}

// ── Part 7: recheck control eligibility ────────────────────────────────────
console.log('── Part 7: which states offer a recheck control ──');
{
  check('7a: overlay is recheckable', M.isGateRecheckable('BLOCKED_OVERLAY') === true);
  check('7b: background/resume is recheckable', M.isGateRecheckable('BLOCKED_BACKGROUND_RESUME') === true);
  check('7c: a VPN block is NOT recheckable (retrying cannot change the device)',
    M.isGateRecheckable('BLOCKED_VPN') === false);
  check('7d: a generic violation is NOT recheckable',
    M.isGateRecheckable('BLOCKED_SECURITY_VIOLATION') === false);
  check('7e: ALLOWED / CHECKING offer nothing', !M.isGateRecheckable('ALLOWED') && !M.isGateRecheckable('CHECKING'));
}

// ── Part 8: required copy + documented platform limits ─────────────────────
console.log('── Part 8: overlay copy and documented detection limits ──');
{
  const required =
    'An overlay or another app may be interfering with MedAcademy. ' +
    'Close the interfering app and verify security to continue.';
  check('8a: the overlay warning message matches the specification verbatim',
    M.OVERLAY_WARNING_COPY.message === required);
  check('8b: the overlay warning is titled "Security warning"',
    M.OVERLAY_WARNING_COPY.title === 'Security warning');
  check('8c: the platform limits are documented (>= 4 honest statements)',
    Array.isArray(M.OVERLAY_DETECTION_LIMITS) && M.OVERLAY_DETECTION_LIMITS.length >= 4);
  check('8d: the limits name the API-29 flag-reporting floor',
    M.OVERLAY_DETECTION_LIMITS.some((l) => /API 29/.test(l)));
  check('8e: the limits state that another app\u2019s windows cannot be enumerated',
    M.OVERLAY_DETECTION_LIMITS.some((l) => /enumerate/i.test(l)));
  check('8f: the limits state the system-overlay exemption',
    M.OVERLAY_DETECTION_LIMITS.some((l) => /system-signed/i.test(l)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
