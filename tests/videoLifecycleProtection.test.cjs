#!/usr/bin/env node
/**
 * Video lifecycle + window-state protection — regression guard.
 *
 * Three regressions are pinned here, one describe-style section each:
 *
 *   1. FOREGROUND EXIT — the LIVE lesson player (YouTube/Plyr WebView) must be
 *      paused and covered the moment the app leaves the foreground. It was not:
 *      `ProtectedContentSurface` + the soft-pause/resume scripts shipped only
 *      inside the retired VdoCipher players, so nothing concealed the WebView
 *      that actually plays lessons.
 *
 *   2. FIRST-PLAY AUDIO — Plyr/YouTube started the first playback muted (platform
 *      autoplay policy) and nothing reconciled the provider's mute flag, so
 *      audio only came back after a second, user-initiated play.
 *
 *   3. WINDOW STATE — the overlay / split-screen gate was fed ONLY by the native
 *      event stream, so a missed edge (monitoring installed late, activity
 *      recreated, dropped emitter event) left a violation undetected. Every
 *      evaluation now re-installs and RE-READS the authoritative platform state.
 *
 * Run: node tests/videoLifecycleProtection.test.cjs
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const player = read('src/components/YouTubePlayer.tsx');
const surface = read('src/components/ProtectedContentSurface.tsx');
const visibility = read('src/lib/protectedContentVisibility.ts');
const stopHook = read('src/lib/useSecurityWebViewStop.ts');
const playerScript = read('src/lib/plyr/playerScript.ts');
const context = read('src/lib/SecurityContext.tsx');
const security = read('src/lib/security.ts');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${String(error.message).split('\n').join('\n      ')}`);
  }
}

// ─── 1. The live player is inside the concealment boundary ───────────────────

console.log('\nForeground exit — live WebView player');

check('YouTubePlayer imports ProtectedContentSurface and the soft pause/resume scripts', () => {
  assert.match(player, /import \{ ProtectedContentSurface \} from '\.\/ProtectedContentSurface'/);
  assert.match(player, /WEBVIEW_SOFT_PAUSE_SCRIPT/);
  assert.match(player, /WEBVIEW_RESUME_SCRIPT/);
});

check('the WebView is rendered INSIDE ProtectedContentSurface (not merely nearby)', () => {
  const open = player.indexOf('<ProtectedContentSurface');
  const webview = player.indexOf('<WebView', open);
  const close = player.indexOf('</ProtectedContentSurface>', open);
  assert.ok(open > -1, 'ProtectedContentSurface is not rendered by the live player');
  assert.ok(webview > open, 'the WebView is not a child of the concealment boundary');
  assert.ok(close > webview, 'the concealment boundary does not wrap the WebView');
});

check('conceal pauses the real player through the non-destructive script', () => {
  assert.match(player, /const concealWebPlayer = useCallback\(/);
  assert.match(player, /injectJavaScript\?\.\(WEBVIEW_SOFT_PAUSE_SCRIPT\)/);
  assert.match(player, /onConceal=\{concealWebPlayer\}/);
});

check('reveal resumes through the script that only resumes what was playing', () => {
  assert.match(player, /const revealWebPlayer = useCallback\(/);
  assert.match(player, /injectJavaScript\?\.\(WEBVIEW_RESUME_SCRIPT\)/);
  assert.match(player, /onReveal=\{revealWebPlayer\}/);
});

check('soft pause pauses Plyr AND every media element, remembering the prior state', () => {
  const script = stopHook.slice(
    stopHook.indexOf('export const WEBVIEW_SOFT_PAUSE_SCRIPT'),
    stopHook.indexOf('export const WEBVIEW_RESUME_SCRIPT'),
  );
  assert.match(script, /plyr\.pause\(\)/);
  assert.match(script, /media\[i\]\.pause\(\)/);
  assert.match(script, /__medaProtectedWasPlaying/);
});

check('resume never starts a player the student had paused', () => {
  const script = stopHook.slice(stopHook.indexOf('export const WEBVIEW_RESUME_SCRIPT'));
  assert.match(script, /if \(!window\.__medaProtectedWasPlaying\) return true;/);
});

check('an authorized reveal releases the app-level containment flag', () => {
  const script = stopHook.slice(stopHook.indexOf('export const WEBVIEW_RESUME_SCRIPT'));
  assert.match(script, /window\.__medaSecurityStopped = false;/);
  assert.ok(
    script.indexOf('window.__medaSecurityStopped = false;') <
      script.indexOf('if (!window.__medaProtectedWasPlaying)'),
    'the containment flag must be released before the resume decision',
  );
});

check('the surface is fail-closed and registered with the synchronous bus', () => {
  assert.match(surface, /registerProtectedContentConcealer\(/);
  assert.match(surface, /const visible = allowedByState && !concealedRef\.current;/);
  assert.match(visibility, /let concealed = true;/);
});

check('the security context conceals synchronously on the background edge', () => {
  assert.match(context, /dispatchProtectedContent\(\{\s*\n\s*type: 'background'/);
  assert.match(context, /setProtectedContentConcealed\(true, 'appstate=' \+ nextState\)/);
});

check('video is not revealed until a post-resume verdict passes', () => {
  assert.match(context, /acceptsResumeVerification\(\{/);
  assert.match(context, /setProtectedContentConcealed\(false, 'verdict-clean'\)/);
});

// ─── 2. Plyr first-play audio ────────────────────────────────────────────────

console.log('\nPlyr first-play audio');

check('the first play reconciles a provider-applied mute exactly once', () => {
  assert.match(playerScript, /var audioPolicyApplied = false;/);
  assert.match(playerScript, /function reconcileFirstPlayAudio\(\)/);
  assert.match(playerScript, /if \(audioPolicyApplied\) return;/);
  assert.match(playerScript, /audioPolicyApplied = true;/);
});

check('the reconciliation runs from the play event (a real user gesture)', () => {
  const playHandler = playerScript.slice(
    playerScript.indexOf("player.on('play', function () {"),
    playerScript.indexOf("player.on('pause', function () {"),
  );
  assert.match(playHandler, /reconcileFirstPlayAudio\(\)/);
});

check('it only clears a mute the PLATFORM applied, never the student\'s own', () => {
  assert.match(playerScript, /var userChoseMute = false;/);
  assert.match(playerScript, /if \(userChoseMute\) return;/);
  assert.match(playerScript, /el\.getAttribute\('data-plyr'\) === 'mute'/);
});

check('it never writes audio state for an already-audible player', () => {
  assert.match(playerScript, /if \(player\.muted !== true\) return;/);
  assert.match(playerScript, /if \(!\(player\.volume > 0\)\) player\.volume = 1;/);
});

// ─── 3. Window state is re-read, not just event-delivered ────────────────────

console.log('\nWindow state — overlay / split-screen');

check('every evaluation re-reads the authoritative platform window state', () => {
  assert.match(context, /await nativeWindowReassertRef\.current\(\);/);
  const reassertIndex = context.indexOf('await nativeWindowReassertRef.current();');
  const guardedIndex = context.indexOf('return await runGuardedCheck(reason);', reassertIndex);
  assert.ok(guardedIndex > reassertIndex, 'the re-read must precede the policy evaluation');
});

check('the re-read reinstalls overlay protection and multi-window monitoring', () => {
  const body = context.slice(context.indexOf('nativeWindowReassertRef.current = async'));
  assert.match(body, /await enableNativeOverlayProtection\(\);/);
  assert.match(body, /await enableNativeWindowModeMonitoring\(\);/);
  assert.match(body, /const reading = await getNativeWindowMode\(\);/);
});

check('an unmeasurable mode is never treated as a clearance', () => {
  const body = context.slice(context.indexOf('nativeWindowReassertRef.current = async'));
  assert.match(body, /if \(!reading\.measured\) return;/);
});

check('a prohibited mode engages the same hard lock the event path engages', () => {
  const body = context.slice(context.indexOf('nativeWindowReassertRef.current = async'));
  assert.match(body, /applyWindowModeReading\(reading\.mode, false\)/);
  const apply = context.slice(
    context.indexOf('const applyWindowModeReading = useCallback'),
    context.indexOf('nativeWindowPreflightRef.current = async'),
  );
  assert.match(apply, /engageSecurityLock\(LOCK_SRC_WINDOW_MODE, \{ hard: true \}\)/);
});

check('overlay and multi-window blocks render the authoritative gate', () => {
  assert.match(context, /lockState\.sources\.includes\(LOCK_SRC_OVERLAY\)/);
  assert.match(context, /lockState\.sources\.includes\(LOCK_SRC_WINDOW_MODE\)/);
});

// ─── 4. The authorized-disabled checks stay disabled ─────────────────────────

console.log('\nSecurity configuration is untouched');

check('the four authorized temporary disables are unchanged', () => {
  const block = security.slice(
    security.indexOf('TEMPORARILY_DISABLED_CHECKS'),
    security.indexOf('TEMPORARILY_DISABLED_CHECKS') + 1400,
  );
  for (const key of [
    'adb_enabled',
    'xposed_detected',
    'magisk_detected',
    'developer_options_enabled',
  ]) {
    assert.match(block, new RegExp(`${key}:\\s*true`), `${key} is no longer disabled`);
  }
});

check('overlay and multi-window are NOT disabled checks', () => {
  const block = security.slice(
    security.indexOf('TEMPORARILY_DISABLED_CHECKS'),
    security.indexOf('TEMPORARILY_DISABLED_CHECKS') + 1400,
  );
  assert.ok(!/overlay/.test(block), 'overlay protection must not be disabled');
  assert.ok(!/multi_?window/i.test(block), 'split-screen protection must not be disabled');
  assert.ok(!/window_mode/i.test(block), 'window-mode protection must not be disabled');
});

check('the temporary FLAG_SECURE switch is still off', () => {
  const guard = fs.readFileSync(path.join(ROOT, 'src/lib/screenCaptureGuard.ts'), 'utf8');
  assert.match(guard, /SCREEN_CAPTURE_PROTECTION_ENABLED\s*=\s*false/);
});

// ─── Result ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const { name, error } of failures) {
    console.error(`\nFAILED: ${name}\n${error && error.stack ? error.stack : error}`);
  }
  process.exit(1);
}
