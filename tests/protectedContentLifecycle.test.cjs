#!/usr/bin/env node
/**
 * Protected-content lifecycle + app-access separation — regression suite.
 *
 * Run: node tests/protectedContentLifecycle.test.cjs
 *
 * THE DEFECT THIS LOCKS DOWN
 * ──────────────────────────
 * Backgrounding the app engaged the HARD `background-resume` security lock.
 * That lock unmounted the native player (destroying the VdoCipher session/OTP
 * and playback position), suspended the app's own network traffic and left the
 * whole shell blocked until a post-resume evaluation landed. A normal
 * Home-and-return therefore felt like the entire application was security
 * blocked.
 *
 * THE CONTRACT ASSERTED HERE
 * ──────────────────────────
 *  • APP ACCESS (layer 1) is blocked ONLY by a confirmed violation/signal
 *    (verdict, native VPN, overlay, prohibited window mode). Continuous
 *    monitoring and the periodic cadence are unchanged.
 *  • PROTECTED CONTENT (layer 2) is a separate fail-closed machine: only
 *    `allowed` may render video; backgrounding conceals immediately; a resume
 *    re-verifies while the video stays hidden; a timeout/exception never
 *    authorizes; stale async results can never override a newer decision.
 *  • The native surface is paused and hidden at the view level
 *    (ProtectedContentSurface), the same player/OTP session is reused, and the
 *    watermark overlay still lives inside the player container.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

function build(rel) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-content-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, rel),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(tmp, path.basename(rel).replace(/\.ts$/, '.js')));
}

const P = build('src/lib/protectedContentState.ts');
const M = build('src/lib/securityStateModel.ts');
const CONTEXT = read('src/lib/SecurityContext.tsx');
const SURFACE = read('src/components/ProtectedContentSurface.tsx');
// The retired native VdoCipher players and the offline player are gone; the
// LIVE player is the WebView one (YouTubePlayer), which is what must comply.
const WEBVIEW = read('src/components/YouTubePlayer.tsx');
const VISIBILITY = read('src/lib/protectedContentVisibility.ts');
const WEBVIEW_STOP = read('src/lib/useSecurityWebViewStop.ts');
const LOCK = read('src/lib/securityLock.ts');

const init = P.INITIAL_PROTECTED_CONTENT_STATE;
const reduce = P.reduceProtectedContent;

// ── Part 1: the pure fail-closed state machine ────────────────────────────
console.log('\u2500\u2500 Part 1: protected-content state machine \u2500\u2500');
{
  check('1a: initial state HIDES video before any validation',
    init.status === 'checking'
    && P.isProtectedContentVisible(init) === false
    && P.isProtectedContentConcealed(init) === true);

  const bg = reduce({ ...init, status: 'allowed', requestId: 4 }, { type: 'background', requestId: 5 });
  check('1b: backgrounding hides protected video immediately and bumps the request id',
    bg.status === 'background_hidden' && bg.requestId === 5 && P.isProtectedContentVisible(bg) === false);

  const fg = reduce(bg, { type: 'foreground', requestId: 6 });
  check('1c: returning to the foreground is CHECKING (video stays hidden, app is not blocked)',
    fg.status === 'checking' && fg.requestId === 6 && P.isProtectedContentVisible(fg) === false);

  const started = reduce(fg, { type: 'check-started', requestId: 7, reason: 'resume' });
  const ok = reduce(started, { type: 'check-succeeded', requestId: 7 });
  check('1d: a successful check restores video access', ok.status === 'allowed' && P.isProtectedContentVisible(ok));

  const blocked = reduce(started, { type: 'check-failed', requestId: 7 });
  check('1e: a failed check keeps video hidden (blocked)',
    blocked.status === 'blocked' && P.isProtectedContentVisible(blocked) === false);

  const errored = reduce(started, { type: 'check-error', requestId: 7 });
  check('1f: an exception/timeout keeps video hidden (error) and never grants access',
    errored.status === 'error' && P.isProtectedContentVisible(errored) === false);

  check('1g: an app-level security block conceals protected content at once',
    reduce({ ...init, status: 'allowed', requestId: 3 }, { type: 'app-blocked', requestId: 4 }).status === 'blocked');
}

// ── Part 2: stale results and rapid transitions ───────────────────────────
console.log('\u2500\u2500 Part 2: concurrency / stale-async safety \u2500\u2500');
{
  const s0 = reduce(init, { type: 'check-started', requestId: 10 });
  const s1 = reduce(s0, { type: 'check-started', requestId: 11 });

  check('2a: an OLDER successful result can never override a newer verification',
    reduce(s1, { type: 'check-succeeded', requestId: 10 }).status === 'checking');
  check('2b: the matching (newer) result does apply',
    reduce(s1, { type: 'check-succeeded', requestId: 11 }).status === 'allowed');

  // Rapid background → foreground → background while a check was running.
  const rapidBg = reduce(s1, { type: 'background', requestId: 12 });
  const rapidFg = reduce(rapidBg, { type: 'foreground', requestId: 13 });
  check('2c: a check started before the transition cannot reveal video after a rapid cycle',
    reduce(rapidFg, { type: 'check-succeeded', requestId: 11 }).status === 'checking');
  check('2d: a clean verdict cannot reveal video while the app is backgrounded',
    reduce(rapidBg, { type: 'check-succeeded', requestId: 12 }).status === 'background_hidden');
  check('2e: an older check-started event cannot regress the live request id',
    reduce(rapidFg, { type: 'check-started', requestId: 12 }).requestId === 13);
  check('2f: app-blocked invalidates in-flight protected checks',
    reduce(
      reduce(rapidFg, { type: 'app-blocked', requestId: 14 }),
      { type: 'check-succeeded', requestId: 13 },
    ).status === 'blocked');
  check('2g: only `allowed` is visible (exhaustive over every status)',
    P.PROTECTED_CONTENT_STATUSES.every((status) =>
      P.isProtectedContentVisible({ status, requestId: 1, reason: null }) === (status === 'allowed')));
}

// ── Part 3: timeout is evidence, never authorization ──────────────────────
console.log('\u2500\u2500 Part 3: bounded verification timeout \u2500\u2500');
{
  check('3a: nothing pending is never overdue',
    P.isProtectedContentVerificationOverdue({ startedAtMs: null, nowMs: 1e9 }) === false);
  check('3b: below the threshold is not overdue',
    P.isProtectedContentVerificationOverdue({
      startedAtMs: 1000,
      nowMs: 1000 + P.PROTECTED_CONTENT_VERIFICATION_TIMEOUT_MS - 1,
    }) === false);
  check('3c: past the threshold IS overdue (the caller keeps media hidden)',
    P.isProtectedContentVerificationOverdue({
      startedAtMs: 1000,
      nowMs: 1000 + P.PROTECTED_CONTENT_VERIFICATION_TIMEOUT_MS,
    }) === true);
  check('3d: garbage timestamps are never treated as overdue',
    P.isProtectedContentVerificationOverdue({ startedAtMs: NaN, nowMs: 5 }) === false);
}

// ── Part 4: app-access layer is untouched; lifecycle no longer blocks it ──
console.log('\u2500\u2500 Part 4: app access vs protected content \u2500\u2500');
{
  check('4a: leaving the foreground NEVER engages the global app-access lock',
    !/enterBackgroundHold\('appstate='/.test(CONTEXT)
    && /if \(leavingForeground && !protectedHiddenRef\.current\)/.test(CONTEXT)
    && /setProtectedContentConcealed\(true, 'appstate=' \+ nextState\);/.test(CONTEXT));
  check('4b: returning does NOT engage a global hold (navigation is immediately usable)',
    !/enterBackgroundHold\('resumed'\)/.test(CONTEXT)
    && /resumeTokenRef\.current \+= 1;[\s\S]{0,200}setProtectedContentConcealed\(true, 'resume-verification'\);/.test(CONTEXT));
  check('4c: the startup hold still exists (cold-start containment preserved)',
    /if \(result === null\) enterBackgroundHold\('session-start'\);/.test(CONTEXT));
  check('4d: a confirmed verdict still engages the HARD app-access lock',
    /engageSecurityLock\(LOCK_SRC_VERDICT, \{ hard: true \}\)/.test(CONTEXT));
  check('4e: a blocking verdict also conceals protected content',
    /if \(r\.blocksLogin \|\| r\.blocksVideo\) \{\s*blockProtectedContent\('app-security-block'\);/.test(CONTEXT)
    && /blockProtectedContent\('verdict'\)/.test(CONTEXT));
  check('4f: continuous monitoring cadence is unchanged (30 s scheduler remains)',
    /const CONTINUOUS_CHECK_INTERVAL_MS = 30_000;/.test(CONTEXT)
    && /setInterval\(\(\) => \{ void runPeriodicCheckRef\.current\(\); \}, CONTINUOUS_CHECK_INTERVAL_MS\)/.test(CONTEXT));
  // HARD containment, not provisional: a soft holder left the WebView mounted
  // (screens destroy the player only on `securityLockHard`), so the embedded
  // YouTube player kept issuing requests for the whole verdict window.
  check('4g: the native VPN callback contains app access immediately with a HARD lock',
    /engageSecurityLock\(LOCK_SRC_NATIVE_VPN, \{ hard: true \}\);/.test(CONTEXT)
    && /blockProtectedContent\('native-vpn'\);/.test(CONTEXT));
  check('4h: the multi-window block still conceals protected content (no overlay path)',
    /blockProtectedContent\('multi-window'\);/.test(CONTEXT)
    && !/blockProtectedContent\('overlay'\);/.test(CONTEXT));
  check('4i: exactly ONE AppState listener exists in the security context',
    (CONTEXT.match(/AppState\.addEventListener\('change',/g) || []).length === 1);
  check('4j: the resume path runs the SAME authoritative evaluation (no weaker checks)',
    /const r = await runEvaluation\(reason\);/.test(CONTEXT)
    && /const scope: SecurityCheckScope = \(reason\.startsWith\('resume'\) \|\| reason === 'periodic'\)/.test(CONTEXT));
  check('4k: the reveal is gated on a post-resume verdict (acceptsResumeVerification)',
    /acceptsResumeVerification\(\{\s*evaluationStartedToken: evaluationStartTokenRef\.current,[\s\S]{0,180}liveResumeToken:       resumeTokenRef\.current,/.test(CONTEXT)
    && /setProtectedContentConcealed\(false, 'verdict-clean'\);/.test(CONTEXT));
  check('4k-2: a clean verdict cannot reveal video over a newer VPN/window signal',
    /verdictNativeSeqRef\.current < nativeSignalSeqRef\.current/.test(CONTEXT)
    && /liveLock\.sources\.includes\(LOCK_SRC_WINDOW_MODE\)/.test(CONTEXT)
    && !/LOCK_SRC_OVERLAY/.test(CONTEXT));
  check('4l: transport/network lock still exists for confirmed app blocks',
    /if \(isSecurityLocked\(\) && !isLockExempt\(path\)\) \{/.test(read('src/client/php.ts')));
  check('4m: server-side security enforcement is unchanged (no bypass added)',
    !/SECURITY_BYPASS|skipSecurityCheck|disableSecurity/i.test(read('backend/src/Controllers/SecurityController.php'))
    && /MANDATORY_BLOCK/.test(read('backend/src/Controllers/SecurityController.php')));
  check('4n: CHECKING never renders the app-wide block page (navigation stays available)',
    M.rendersBlockScreen('CHECKING') === false
    && M.rendersBlockScreen('ALLOWED') === false
    && M.rendersBlockScreen('BLOCKED_BACKGROUND_RESUME') === false);
  check('4o: confirmed violations still render the authoritative block page',
    ['BLOCKED_VPN', 'BLOCKED_SECURITY_VIOLATION', 'BLOCKED_MULTI_WINDOW']
      .every((s) => M.rendersBlockScreen(s) === true));
  check('4p: the gate state during a pending resume is CHECKING, never ALLOWED',
    M.resolveSecurityGateState({
      evaluating: true, hasVerdict: true, overlayBlocked: false, multiWindowBlocked: false,
      backgroundResumeBlocked: false, vpnBlocked: false, violationBlocked: false,
    }) === 'CHECKING');
}

// ── Part 5: native concealment + VdoCipher/watermark preservation ─────────
console.log('\u2500\u2500 Part 5: native concealment and VdoCipher preservation \u2500\u2500');
{
  check('5a: concealment bus is fail-closed before any decision',
    /let concealed = true;/.test(VISIBILITY)
    && /if \(concealed\) \{[\s\S]{0,160}concealer\.conceal\(lastReason\);/.test(VISIBILITY));
  // ROOT CAUSE (device-proven): alpha-only concealment left the WebView mounted
  // and, on this device, a composited alpha/zIndex layer inside a clipped parent
  // painted nothing — so the video stayed visible and kept decoding. The boundary
  // now UNMOUNTS the player while concealed (no frame, no media request) and the
  // cover is a plain filled view with no layering tricks.
  check('5b: surface DESTROYS the player while concealed (unmount, not alpha)',
    /\{visible \? \(/.test(SURFACE)
    && /\{children\}/.test(SURFACE)
    && !/hostConcealed/.test(SURFACE)
    && !/zIndex: 9998/.test(SURFACE)
    && !/elevation: 30/.test(SURFACE));
  check('5c: surface applies concealment synchronously on the AppState edge',
    /registerProtectedContentConcealer\(\{/.test(SURFACE)
    && /conceal: \(reason\) => \{/.test(SURFACE)
    && /setNativeProps/.test(SURFACE));
  check('5c-2: concealment is RENDER state, so the unmount cannot be skipped',
    /const visible = allowedByState && !busConcealed;/.test(SURFACE)
    && /setBusConcealed\(true\)/.test(SURFACE)
    && /setBusConcealed\(false\)/.test(SURFACE));
  check('5d: the retired native/offline players are gone (single player path)',
    !fs.existsSync(path.join(ROOT, 'src/components/VdoCipherPlayerNativeAdapter.native.tsx'))
    && !fs.existsSync(path.join(ROOT, 'src/components/OfflineVideoPlayer.native.tsx')));
  check('5j: the WebView fallback soft-pauses (does NOT detach the iframe) on conceal',
    /WEBVIEW_SOFT_PAUSE_SCRIPT/.test(WEBVIEW)
    && /<ProtectedContentSurface/.test(WEBVIEW)
    && !/WEBVIEW_CONTAINMENT_SCRIPT/.test(WEBVIEW.split('useSecurityWebViewStop(')[1] || ''));
  check('5k: the HARD WebView containment (confirmed block) is preserved',
    /__medaSecurityStopped/.test(WEBVIEW_STOP)
    && /frames\[j\]\.parentNode\.removeChild\(frames\[j\]\)/.test(WEBVIEW_STOP));
  check('5l: the security lock still stops playback synchronously for confirmed blocks',
    /registerPlaybackStopper/.test(LOCK) && /for \(const stop of stops\)/.test(LOCK));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nPROTECTED CONTENT LIFECYCLE TESTS FAILED');
  process.exit(1);
}
console.log('\nALL PROTECTED CONTENT LIFECYCLE TESTS PASSED');
