#!/usr/bin/env node
/**
 * Central security lock — behavior + integration regression suite.
 *
 * THE DEFECT THIS LOCKS DOWN
 * ──────────────────────────
 * Enforcement was split across two disconnected flags:
 *   • the block SCREEN was driven by `blocksLogin` (SecurityGate overlay), while
 *   • the native PLAYER was stopped by `blocksVideo` — and ONLY that.
 *
 * VPN/proxy policy is `block_login` (src/lib/security.ts DEFAULT_POLICIES), so
 * a detected VPN produced `blocksLogin:true, blocksVideo:false`: the gate
 * rendered full-screen but the VdoCipher native player was never unmounted and
 * kept playing (and holding audio) BEHIND the gate. Nothing aborted in-flight
 * protected requests, nothing stopped progress/refresh traffic, and nothing
 * blocked NEW requests while blocked. The detection→enforcement latency was
 * also dominated by a 1.5s debounce plus a network-bound full check cycle.
 *
 * The fix is a single central lock (src/lib/securityLock.ts) that
 *   • composes independent signal holders (race-safe release),
 *   • contains immediately: aborts registered in-flight requests + invokes
 *     registered playback stoppers,
 *   • and is driven both by the authoritative verdict (HARD) and by the fast
 *     native TRANSPORT_VPN signal (provisional).
 *
 * Part A compiles the pure module standalone and exercises its behavior.
 * Part B asserts the runtime integration points exist (source-level), following
 * the convention used by the other architecture suites.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

// ── Build the pure module standalone (dependency-free by design) ─────────────
function buildLock() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seclock-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src', 'lib', 'securityLock.ts'),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(tmp, 'securityLock.js'));
}

const lock = buildLock();

// ── Part A: pure lock behavior ──────────────────────────────────────────────
console.log('── Part A: central lock behavior ──');
{
  lock._resetSecurityLockForTests();
  check('A1: starts unlocked', lock.isSecurityLocked() === false);
  check('A1: starts non-hard', lock.isSecurityLockHard() === false);

  const seen = [];
  const unsub = lock.subscribeSecurityLock((s) => seen.push(s));
  check('A2: subscribe fires immediately with current state', seen.length === 1 && seen[0].locked === false);

  lock.engageSecurityLock('native-vpn');
  check('A3: soft engage locks', lock.isSecurityLocked() === true);
  check('A3: soft engage is NOT hard', lock.isSecurityLockHard() === false);
  check('A3: subscriber notified on engage', seen[seen.length - 1].locked === true);
  check('A3: source recorded', lock.getSecurityLockState().sources.includes('native-vpn'));

  lock.engageSecurityLock('verdict', { hard: true });
  check('A4: hard holder makes the lock hard', lock.isSecurityLockHard() === true);

  // A later SOFT engage on the SAME source must not downgrade an authoritative block.
  lock.engageSecurityLock('verdict');
  check('A5: soft re-engage never downgrades an existing hard holder', lock.isSecurityLockHard() === true);

  lock.releaseSecurityLock('verdict');
  check('A6: releasing the hard holder leaves the soft holder (still locked)', lock.isSecurityLocked() === true);
  check('A6: and the lock is no longer hard', lock.isSecurityLockHard() === false);

  lock.releaseSecurityLock('native-vpn');
  check('A7: releasing the last holder unlocks', lock.isSecurityLocked() === false);

  unsub();
  const before = seen.length;
  lock.engageSecurityLock('x');
  check('A8: unsubscribed listener is not notified', seen.length === before);
  lock.releaseAllSecurityLocks();
}

// ── Part A2: containment — aborts in-flight requests ────────────────────────
console.log('── Part A2: containment (abort in-flight protected requests) ──');
{
  lock._resetSecurityLockForTests();

  let abortedA = 0;
  let abortedB = 0;
  const unregA = lock.registerProtectedAbort({ abort: () => { abortedA++; } });
  const unregB = lock.registerProtectedAbort({ abort: () => { abortedB++; } });
  check('A9: registered in-flight count is 2', lock._protectedInflightForTests() === 2);

  lock.engageSecurityLock('verdict', { hard: true });
  check('A10: engage aborts in-flight request A', abortedA === 1);
  check('A10: engage aborts in-flight request B', abortedB === 1);
  check('A10: registry is drained after containment', lock._protectedInflightForTests() === 0);

  // Containment runs ONCE per unlock→lock transition (a soft→hard upgrade must
  // not re-abort an already-drained registry).
  let abortedC = 0;
  // While LOCKED, a new registration must be aborted immediately (no slip-in).
  const unregC = lock.registerProtectedAbort({ abort: () => { abortedC++; } });
  check('A11: request registered WHILE LOCKED is aborted immediately', abortedC === 1);
  check('A11: and is not retained', lock._protectedInflightForTests() === 0);
  unregC();

  // Unregistering a settled request must remove it from the registry.
  lock.releaseAllSecurityLocks();
  let abortedD = 0;
  const unregD = lock.registerProtectedAbort({ abort: () => { abortedD++; } });
  unregD();
  check('A12: unregister removes the request from the registry', lock._protectedInflightForTests() === 0);
  lock.engageSecurityLock('verdict');
  check('A12: an unregistered (settled) request is never aborted', abortedD === 0);
  lock.releaseAllSecurityLocks();

  void unregA; void unregB;
}

// ── Part A3: containment — playback stoppers ────────────────────────────────
console.log('── Part A3: containment (immediate playback stop) ──');
{
  lock._resetSecurityLockForTests();
  let pauses = 0;
  const unreg = lock.registerPlaybackStopper(() => { pauses++; });
  check('A13: stopper registered', lock._playbackStoppersForTests() === 1);

  lock.engageSecurityLock('native-vpn');
  check('A14: soft engage invokes the playback stopper', pauses === 1);

  // Soft→hard upgrade must NOT double-pause (containment is per transition).
  lock.engageSecurityLock('verdict', { hard: true });
  check('A15: soft→hard upgrade does not re-run containment', pauses === 1);

  lock.releaseSecurityLock('native-vpn');
  lock.releaseSecurityLock('verdict');
  lock.engageSecurityLock('verdict', { hard: true });
  check('A16: a fresh lock transition pauses again', pauses === 2);

  lock.releaseAllSecurityLocks();
  unreg();
  check('A17: unregister removes the stopper', lock._playbackStoppersForTests() === 0);
  lock.engageSecurityLock('verdict');
  check('A17: an unregistered stopper is never called', pauses === 2);
  lock.releaseAllSecurityLocks();

  // A throwing stopper must not break enforcement or other stoppers.
  let second = 0;
  lock.registerPlaybackStopper(() => { throw new Error('player gone'); });
  lock.registerPlaybackStopper(() => { second++; });
  lock.engageSecurityLock('verdict');
  check('A18: a throwing stopper does not block the others', second === 1);
  lock._resetSecurityLockForTests();

  // ── A19: LATE-MOUNTED players ────────────────────────────────────────────
  // `contain()` fires once per transition into `locked`. A player that finishes
  // initializing AFTER containment (a WebView that committed its document late,
  // or a route that mounts the player while the lock is already up) would never
  // be stopped — so playback could begin on an already-locked screen. Registering
  // a stopper while locked must stop it immediately; same for a protected
  // request that tries to start behind the gate.
  let lateMounted = 0;
  lock.engageSecurityLock('native-vpn');
  check('A19: nothing was registered when containment ran', lateMounted === 0);
  lock.registerPlaybackStopper(() => { lateMounted++; });
  check('A19: a stopper registered while LOCKED fires immediately', lateMounted === 1);
  lock.engageSecurityLock('verdict', { hard: true });
  check('A19: the subsequent soft→hard upgrade does not re-invoke it', lateMounted === 1);

  let lateRefused = 0;
  lock.registerProtectedAbort({ abort: () => { lateRefused++; } });
  check('A19: a protected request registered while LOCKED aborts at once', lateRefused === 1);

  // ── A20-A22: containment instrumentation ─────────────────────────────────
  const d = lock.getContainmentDiagnostics();
  check('A20: monotonic timings exist for lock / abort / player-stop',
    typeof d.lockEngagedMs === 'number'
    && typeof d.abortInitiatedMs === 'number'
    && typeof d.abortCompletedMs === 'number'
    && typeof d.playerStopCompletedMs === 'number');
  check('A20: timings are ordered lock ≤ abort-start ≤ abort-done ≤ player-stop',
    d.lockEngagedMs <= d.abortInitiatedMs
    && d.abortInitiatedMs <= d.abortCompletedMs
    && d.abortCompletedMs <= d.playerStopCompletedMs);
  check('A20: requests refused behind the gate are counted',
    d.refusedProtectedRequests >= 1);
  // A REFUSED request never started, so it must NOT stamp the last-start mark —
  // that mark exists to prove no protected request began after containment.
  check('A20: a refused request does not count as a started request',
    d.lastProtectedRequestStartMs === null);

  const baseline = d.abortedRequests;
  const snap = lock.getContainmentDiagnostics();
  snap.abortedRequests = 999;
  check('A22: the snapshot is a COPY — a caller cannot mutate the real record',
    lock.getContainmentDiagnostics().abortedRequests === baseline);

  // A clean sweep must report exactly what it stopped and aborted.
  lock._resetSecurityLockForTests();
  lock.registerPlaybackStopper(() => { /* stopped */ });
  lock.registerProtectedAbort({ abort: () => { /* aborted */ } });
  lock.engageSecurityLock('native-vpn');
  const c = lock.getContainmentDiagnostics();
  check('A21: the sweep counts players stopped and requests aborted',
    c.stoppedPlayers === 1 && c.abortedRequests === 1);
  check('A21: a fresh containment re-stamps its timings', typeof c.lockEngagedMs === 'number');
  check('A21: the last protected request START is timestamped',
    typeof c.lastProtectedRequestStartMs === 'number');
  check('A21: that start precedes lock engagement (containment closed the window)',
    c.lastProtectedRequestStartMs <= c.lockEngagedMs);

  // ── A23: native-signal receipt marking ──────────────────────────────────
  lock._resetSecurityLockForTests();
  lock.markNativeVpnSignal(1234);
  const n1 = lock.getContainmentDiagnostics();
  check('A23: native signal time and JS receipt time are recorded',
    n1.nativeSignalMs === 1234 && typeof n1.jsReceiptMs === 'number');
  lock.markNativeVpnSignal(null);
  const n2 = lock.getContainmentDiagnostics();
  check('A23: a native signal without a reported time still stamps JS receipt',
    n2.nativeSignalMs === null && typeof n2.jsReceiptMs === 'number');

  lock._resetSecurityLockForTests();
}

// ── Part B: runtime integration (source-level assertions) ───────────────────
console.log('── Part B: runtime integration ──');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const php = read('src/client/php.ts');
check('B1: transport imports the central lock', /from '@\/lib\/securityLock'/.test(php));
check('B2: transport refuses protected requests while locked (fail-closed gate before fetch)',
  /if \(isSecurityLocked\(\) && !isLockExempt\(path\)\)/.test(php));
check('B3: the gate returns a distinct SECURITY_LOCK code', /code: 'SECURITY_LOCK'/.test(php));
check('B4: in-flight requests are registered for abort', /registerProtectedAbort\(controller\)/.test(php));
check('B5: the abort registration is released on settle', /unregisterAbort\(\)/.test(php));
check('B6: a lock abort is NOT reported as a 30s timeout',
  /request aborted by security lock/.test(php));
check('B7: policy/audit/logout paths stay exempt so the app can report + recover',
  /'\/security\/policies'/.test(php) && /'\/security\/events'/.test(php) && /'\/auth\/logout'/.test(php));
check('B8: token refresh is frozen while locked',
  /security lock active — refresh deferred until unlock/.test(php) &&
  /scheduleRefreshAfterUnlock\(\);/.test(php));
check('B8b: a frozen refresh is never treated as a session failure',
  !/AUTH_REFRESH_SUPPRESSED[\s\S]{0,200}await clearSession\(\)/.test(php));

const ctx = read('src/lib/SecurityContext.tsx');
check('B9: context engages a HARD lock from the authoritative verdict',
  /engageSecurityLock\(LOCK_SRC_VERDICT, \{ hard: true \}\)/.test(ctx));
check('B10: context releases the verdict holder when the verdict clears',
  /releaseSecurityLock\(LOCK_SRC_VERDICT\)/.test(ctx));
// The provisional native holder may be dropped ONLY by a verdict that STARTED
// at or after the newest native signal. A verdict that began before the VPN
// signal cannot speak for the VPN state now in force, so letting it release
// containment would reopen the interception window this feature closes.
check('B11: provisional native containment is released only by a verdict that observed the latest native signal',
  /if \(hasVerdict && verdictNativeSeqRef\.current >= nativeSignalSeqRef\.current\)/.test(ctx)
  && /releaseSecurityLock\(LOCK_SRC_NATIVE_VPN\)/.test(ctx));
check('B11b: the native signal bumps the sequence the verdict records at check START',
  /nativeSignalSeqRef\.current \+= 1/.test(ctx)
  && /const nativeSeqAtStart = nativeSignalSeqRef\.current/.test(ctx)
  && /verdictNativeSeqRef\.current = nativeSeqAtStart/.test(ctx));
check('B11c: a fresh verdict re-runs the release decision even with identical flags',
  /setVerdictSerial\(\(s\) => s \+ 1\)/.test(ctx) && /verdictSerial\]/.test(ctx));
check('B12: the native TRANSPORT_VPN callback contains IMMEDIATELY (no verdict wait)',
  /engageSecurityLock\(LOCK_SRC_NATIVE_VPN\)/.test(ctx));
check('B13: containment respects the admin VPN whitelist', /isVpnWhitelistKnownNonEmpty\(\)/.test(ctx));
check('B14: Super Admin is exempt from containment', /if \(isSuperAdmin\) \{\s*\n\s*releaseSecurityLock\(LOCK_SRC_NATIVE_VPN\)/.test(ctx));
check('B15: locks are session-scoped (cleared on logout/account switch)', /releaseAllSecurityLocks\(\)/.test(ctx));
check('B16: the lock state is exposed to consumers',
  /securityLocked:\s+lockState\.locked/.test(ctx) && /securityLockHard:\s+lockState\.hard/.test(ctx));

const hook = read('src/lib/useSecurityPlaybackStop.ts');
check('B17: playback-stop hook registers with the lock', /registerPlaybackStopper\(/.test(hook));
check('B18: it pauses the native player via the documented instance method', /playerRef\.current\?\.pause\?\.\(\)/.test(hook));

const online = read('src/components/VdoCipherPlayerNativeAdapter.native.tsx');
check('B19: online player uses the containment hook', /const playerRef = useSecurityPlaybackStop\(\)/.test(online));
check('B20: online player attaches the ref to the native view', /<VdoPlayerView\s*\n\s*ref=\{playerRef\}/.test(online));
check('B20b: the ref cast introduces no second "<VdoPlayerView" token', (online.match(/<VdoPlayerView/g) || []).length === 1);

const offline = read('src/components/OfflineVideoPlayer.native.tsx');
check('B21: offline player uses the containment hook', /const playerRef = useSecurityPlaybackStop\(\)/.test(offline));
check('B22: offline player attaches the ref to the native view', /<VdoPlayerView\s*\n\s*ref=\{playerRef\}/.test(offline));
check('B22b: the ref introduces no second "<VdoPlayerView" token', (offline.match(/<VdoPlayerView/g) || []).length === 1);

const lesson = read('src/app/(app)/lesson/[id].tsx');
check('B23: lesson player mount is keyed on the HARD lock (not just blocksVideo)',
  /!blocksVideo && !securityLockHard && \(lesson\.video_type/.test(lesson));
check('B24: lesson collapse effect reacts to the hard lock', /if \(!blocksVideo && !securityLockHard\) return;/.test(lesson));
check('B25: the player is destroyed for a login-blocking finding too',
  /setPlayerVisible\(false\)/.test(lesson));
check('B26: fullscreen entry is refused while the hard lock is held',
  /isSuperAdmin \|\| \(!blocksVideo && !securityLockHard\)/.test(lesson));

const offCourse = read('src/app/(app)/offline-course.tsx');
const offLib = read('src/app/(app)/offline-library.tsx');
for (const [name, src] of [['offline-course', offCourse], ['offline-library', offLib]]) {
  check(`B27: ${name} tears the player down on the hard lock`, /blocksVideo \|\| securityLockHard/.test(src));
}

// The bridge declaration must expose the pause method the hook relies on.
const dts = read('src/types/vdocipher-rn-bridge.d.ts');
check('B28: bridge declaration exposes the documented pause()', /pause\(\): void;/.test(dts));

// ── Part C: WebView-player containment + containment instrumentation ─────────
// A react-native-webview instance has NO native `pause()`. Registering the
// VdoPlayerView stopper on a WebView therefore made containment a SILENT NO-OP:
// the lock engaged, the gate rendered, and the embedded YouTube/VdoCipher player
// kept playing behind it. Part C locks down the WebView-aware stopper, the
// late-mount guard, and the latency instrumentation.

const wvHook = read('src/lib/useSecurityWebViewStop.ts');
check('C1: a WebView-aware playback stopper exists',
  /export function useSecurityWebViewStop/.test(wvHook));
check('C2: it registers with the central lock', /registerPlaybackStopper\(/.test(wvHook));
check('C3: it halts loading AND injects a containment script',
  /wv\.stopLoading\?\.\(\)/.test(wvHook)
  && /wv\.injectJavaScript\?\.\(WEBVIEW_CONTAINMENT_SCRIPT\)/.test(wvHook));
check('C4: the script pauses the live Plyr instance and any raw media element',
  /window\.__plyr/.test(wvHook) && /querySelectorAll\('video, audio'\)/.test(wvHook));
check('C5: cross-origin iframe players are torn down — the only supported stop',
  /querySelectorAll\('iframe'\)/.test(wvHook) && /removeChild/.test(wvHook));
check('C6: the script is idempotent and never throws into containment',
  /__medaSecurityStopped/.test(wvHook) && /catch \(e\) \{\}/.test(wvHook));

const yt = read('src/components/YouTubePlayer.tsx');
check('C7: the YouTube WebView player registers the WebView-aware stopper',
  /useSecurityWebViewStop\(wvRef\)/.test(yt));
check('C8: that stopper is bound to the WebView actually rendered', /ref=\{wvRef\}/.test(yt));

const vdoWv = read('src/components/VdoCipherPlayerWebView.tsx');
check('C9: the VdoCipher WebView player registers the WebView-aware stopper',
  /useSecurityWebViewStop\(playerWebViewRef\)/.test(vdoWv));
check('C9b: its stopper is bound to the mounted WebView node',
  /playerWebViewRef\.current = node/.test(vdoWv));
check('C10: it no longer CALLS the native stopper that cannot stop a WebView',
  !/=\s*useSecurityPlaybackStop\(/.test(vdoWv)
  && !/import \{[^}]*\buseSecurityPlaybackStop\b[^}]*\}/.test(vdoWv));
check('C10b: the native-only stopper is still used by the NATIVE players',
  /useSecurityPlaybackStop/.test(online) && /useSecurityPlaybackStop/.test(offline));

const lockSrc = read('src/lib/securityLock.ts');
check('C11: a player that mounts AFTER containment is stopped on registration',
  /a player that is not ready must not break containment/.test(lockSrc)
  && /registerPlaybackStopper[\s\S]{0,600}if \(holders\.size > 0\)/.test(lockSrc));
check('C12: containment records monotonic timings (lock → abort → stop)',
  /diagnostics\.lockEngagedMs = nowMs\(\)/.test(lockSrc)
  && /diagnostics\.abortInitiatedMs = nowMs\(\)/.test(lockSrc)
  && /diagnostics\.abortCompletedMs = nowMs\(\)/.test(lockSrc)
  && /diagnostics\.playerStopCompletedMs = nowMs\(\)/.test(lockSrc));
check('C13: the last protected request start is timestamped',
  /diagnostics\.lastProtectedRequestStartMs = nowMs\(\)/.test(lockSrc));
check('C14: requests refused behind a live lock are counted (gate-breach telemetry)',
  /diagnostics\.refusedProtectedRequests\+\+/.test(lockSrc));
check('C15: per-containment counts are refreshed, not one-shot',
  /diagnostics\.abortedRequests {2}= pending\.length/.test(lockSrc)
  && /diagnostics\.stoppedPlayers = stops\.length/.test(lockSrc));
check('C16: diagnostics carry timestamps and counts only (privacy-safe)',
  /export interface ContainmentDiagnostics/.test(lockSrc)
  && !/ContainmentDiagnostics[\s\S]{0,900}(url|token|header|body|email|userId)/i.test(lockSrc));
check('C17: JS receipt is stamped BEFORE containment runs in the VPN handler',
  ctx.indexOf('markNativeVpnSignal(') > -1
  && ctx.indexOf('markNativeVpnSignal(') < ctx.indexOf('engageSecurityLock(LOCK_SRC_NATIVE_VPN)'));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
