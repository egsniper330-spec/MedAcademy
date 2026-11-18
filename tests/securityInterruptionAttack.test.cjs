#!/usr/bin/env node
/**
 * Security interruption attacks — regression suite.
 *
 * Run: node tests/securityInterruptionAttack.test.cjs
 *
 * LOCKS DOWN THE THREE REAL-DEVICE FAILURES (Samsung SM-T505N, build 230):
 *
 *   A. Leaving MedAcademy and returning left the lesson video visible and
 *      playable. The player was only CONCEALED (alpha + an opaque sibling) and
 *      stayed mounted; its resume script then continued the old position.
 *   B. A floating / pop-up window over a RESUMED MedAcademy never engaged
 *      protection: the native mode mapping required the Activity to be PAUSED,
 *      so focus loss while resumed was classified as full screen.
 *   C. The Liquid Bar bubble was laid out and hit-testable (dragging the
 *      invisible bubble really did switch tabs) but painted nothing, because it
 *      was a transformed / clipped / z-indexed layer inside the clipped pill.
 *
 * These assertions are the CONTRACT, not a snapshot of one implementation: the
 * player must be destroyed on interruption, a stale verdict must never
 * authorize, playback must always need a fresh preflight plus an explicit tap,
 * and the bubble must be a plain filled view.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  \u2717 ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

function build(rel) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'security-attack-'));
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
const CONTEXT = read('src/lib/SecurityContext.tsx');
const SURFACE = read('src/components/ProtectedContentSurface.tsx');
const PLAYER = read('src/components/YouTubePlayer.tsx');
const LESSON = read('src/app/(app)/lesson/[id].tsx');
const PLUGIN = read('plugins/withSecurityModule.js');
const BAR = read('src/components/navigation/GlassTabBar.tsx');

const reduce = P.reduceProtectedContent;
const init = { ...P.INITIAL_PROTECTED_CONTENT_STATE };

/* ───────── A. Foreground interruption must invalidate authorization ─────── */

console.log('A. Leaving and returning cannot resume the old playback');

check('A1: the initial state hides video before any verdict', () => {
  assert.equal(init.status, 'checking');
  assert.equal(P.isProtectedContentVisible(init), false);
});

check('A2: a background edge hides video and issues a NEW request id', () => {
  const next = reduce(init, { type: 'background', requestId: 7 });
  assert.equal(next.status, 'background_hidden');
  assert.equal(next.requestId, 7);
  assert.equal(P.isProtectedContentVisible(next), false);
});

check('A3: a verdict obtained BEFORE the interruption can never authorize after it', () => {
  // The check that was in flight when the app left the foreground finishes
  // later with the OLD id. It must be discarded.
  const backgrounded = reduce(init, { type: 'background', requestId: 2 });
  const stale = reduce(backgrounded, { type: 'check-succeeded', requestId: 1 });
  assert.equal(stale.status, 'background_hidden');
  assert.equal(P.isProtectedContentVisible(stale), false);
});

check('A4: returning stays hidden (checking) until a fresh verdict lands', () => {
  const resumed = reduce(reduce(init, { type: 'background', requestId: 2 }), {
    type: 'foreground', requestId: 3,
  });
  assert.equal(resumed.status, 'checking');
  assert.equal(P.isProtectedContentVisible(resumed), false);
  const clean = reduce(resumed, { type: 'check-succeeded', requestId: 3 });
  assert.equal(clean.status, 'allowed');
});

check('A5: a background edge during a verification invalidates it (late success ignored)', () => {
  const started = reduce(init, { type: 'check-started', requestId: 4 });
  const backgrounded = reduce(started, { type: 'background', requestId: 5 });
  const late = reduce(backgrounded, { type: 'check-succeeded', requestId: 4 });
  assert.equal(late.status, 'background_hidden');
});

check('A6: the player is DESTROYED while concealed (children are not rendered)', () => {
  assert.match(SURFACE, /\{visible \? \(/);
  assert.match(SURFACE, /\) : \(/);
  assert.ok(!/hostConcealed/.test(SURFACE), 'alpha-only concealment is gone');
});

check('A7: the lesson screen unmounts the player whenever protection is not `allowed`', () => {
  assert.match(LESSON, /if \(protectedContent\.visible\) return;/);
  assert.match(LESSON, /setPlayerVisible\(false\);/);
  // The play area shows an opaque cover while unauthorised.
  assert.match(LESSON, /!protectedContent\.visible \? \(/);
});

check('A8: reveal NEVER auto-resumes playback', () => {
  assert.ok(!/WEBVIEW_RESUME_SCRIPT/.test(PLAYER), 'no resume script may be imported or injected');
  const reveal = PLAYER.slice(PLAYER.indexOf('const revealWebPlayer'), PLAYER.indexOf('const revealWebPlayer') + 700);
  assert.ok(!/injectJavaScript/.test(reveal), 'reveal must not call into the player');
});

check('A9: every NEW playback runs a fresh preflight + explicit tap', () => {
  assert.match(LESSON, /const handlePlay = useCallback\(async \(\) => \{/);
  assert.match(LESSON, /const blocked = await checkBeforeVideo\(\);/);
  assert.match(CONTEXT, /const checkBeforeVideo = useCallback\(async \(\): Promise<boolean> => \{/);
  // Native window preflight BEFORE the policy check, on Android.
  assert.match(CONTEXT, /if \(await nativeWindowPreflightRef\.current\(\)\) return true;/);
});

check('A10: a VPN/proxy enabled while backgrounded is caught by the resume verification', () => {
  assert.match(CONTEXT, /requestResumeVerification\('resume'\)/);
  assert.match(CONTEXT, /resumeTokenRef\.current \+= 1;/);
  // A verdict that started before the resume cannot release the hold.
  assert.match(CONTEXT, /acceptsResumeVerification\(\{/);
});

check('A11: generation guards reject a stale evaluation result', () => {
  assert.match(CONTEXT, /if \(gen !== checkGenRef\.current\)/);
  assert.match(CONTEXT, /if \(requestId !== protectedRequestIdRef\.current\) return;/);
});

/* ───────── B. Floating / pop-up window over a RESUMED app ───────────────── */

console.log('\nB. Floating window over a resumed app blocks playback');

check('B1: the native mapping reports foreign_window on focus loss, resumed or not', () => {
  assert.match(PLUGIN, /if \(foreignWindowFocused\) return WINDOW_MODE_FOREIGN/);
  assert.ok(
    !/foreignWindowFocused && !appResumed/.test(PLUGIN),
    'requiring a paused activity is exactly the missed pop-up case',
  );
});

check('B2: the coverage check no longer requires the activity to be paused', () => {
  const covered = PLUGIN.slice(
    PLUGIN.indexOf('private fun windowCoveredByOtherTask'),
    PLUGIN.indexOf('private fun cancelForeignCheck'),
  );
  assert.match(covered, /if \(decor\.hasWindowFocus\(\)\) return false/);
  assert.match(covered, /return true/);
  assert.ok(!/return activityPaused/.test(covered), 'a resumed app must still be reportable');
});

check('B3: a live focus loss schedules a settled re-read (no stale event state)', () => {
  assert.match(PLUGIN, /override fun onWindowFocusChanged\(hasFocus: Boolean\)/);
  assert.match(PLUGIN, /postDelayed\(check, 700L\)/);
  assert.match(PLUGIN, /if \(windowCoveredByOtherTask\(\)\)/);
});

check('B4: JS blocks PROTECTED CONTENT for a foreign window without taking over the app', () => {
  const apply = CONTEXT.slice(
    CONTEXT.indexOf('const applyWindowModeReading'),
    CONTEXT.indexOf('nativeWindowPreflightRef.current = async'),
  );
  assert.match(apply, /if \(mode === 'foreign_window'\) \{/);
  assert.match(apply, /blockProtectedContent\('foreign-window'\)/);
  // No hard app-wide lock for a focus loss (shade / own dialog are the same signal).
  assert.ok(
    !/engageSecurityLock\(LOCK_SRC_WINDOW_MODE, \{ hard: true \}\);\s*\n\s*blockProtectedContent\('foreign-window'\)/.test(apply),
    'a focus loss must not raise the app-wide gate',
  );
});

check('B5: a clean verdict cannot reveal video while the window mode is prohibited', () => {
  assert.match(CONTEXT, /if \(isProhibitedWindowMode\(windowModeRef\.current\)\) \{/);
  assert.match(CONTEXT, /protected content stays hidden — window mode is still prohibited/);
});

check('B6: our own dialogs still cannot trip the gate', () => {
  assert.match(CONTEXT, /incomingMode === 'foreign_window' && hasOwnDialogOpen\(\)/);
});

check('B7: split-screen and PiP keep their hard app-level block', () => {
  assert.match(CONTEXT, /engageSecurityLock\(LOCK_SRC_WINDOW_MODE, \{ hard: true \}\)/);
  assert.match(CONTEXT, /blockProtectedContent\('multi-window'\)/);
});

check('B8: the pre-play preflight refuses a prohibited window mode', () => {
  assert.match(CONTEXT, /return isProhibitedWindowMode\(reading\.mode\);/);
  assert.match(CONTEXT, /return isProhibitedWindowMode\(windowModeRef\.current\);/);
});

/* ───────── C. Liquid Bar bubble must be paintable ───────────────────────── */

console.log('\nC. Liquid Bar bubble is a plain, paintable view');

check('C1: position and width are animated LAYOUT props, not a transform', () => {
  assert.match(BAR, /left: translateX,/);
  assert.match(BAR, /width: indicatorWidthAnim,/);
  // Scoped to the bubble's own render block (other views may animate transforms).
  const block = BAR.slice(BAR.indexOf('styles.indicator,'), BAR.indexOf('/>', BAR.indexOf('styles.indicator,')));
  assert.ok(!/transform/.test(block), 'no transform may be used for the bubble');
});

check('C2: no zIndex / elevation / overflow / child view on the bubble', () => {
  const block = BAR.slice(BAR.indexOf('styles.indicator,'), BAR.indexOf('/>', BAR.indexOf('styles.indicator,')));
  assert.ok(!/zIndex/.test(block));
  assert.ok(!/elevation/.test(block));
  assert.ok(!/<LinearGradient/.test(block));
  const style = BAR.slice(BAR.indexOf('indicator: {'), BAR.indexOf('row: {'));
  assert.ok(!/zIndex/.test(style) && !/overflow/.test(style) && !/elevation/.test(style));
});

check('C3: the bubble has a real fill and a derived opacity', () => {
  assert.match(BAR, /backgroundColor: isDark \? 'rgba\(96,165,250,0\.30\)' : 'rgba\(30,144,255,0\.22\)'/);
  assert.match(BAR, /opacity: indicatorWidth > 0 \? 1 : 0,/);
});

check('C4: a zero/unknown geometry still keeps a visible bubble (never width 0)', () => {
  assert.match(BAR, /Math\.max\(tabWidth - INDICATOR_INSET \* 2, 24\)/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const { name, error } of failures) {
    console.error(`\nFAILED: ${name}\n${error && error.stack ? error.stack : error}`);
  }
  process.exit(1);
}
