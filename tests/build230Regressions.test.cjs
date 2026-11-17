#!/usr/bin/env node
/**
 * Regression suite for the build-230 device failures.
 *
 * These are the four confirmed, user-observed bugs, each asserted against the
 * REAL mechanism that caused it — not against a claim that a fix "exists":
 *
 *   1. The Liquid bar bubble painted nothing on the tablet (an elevated child
 *      inside a clipped, rounded parent is composited away on Android).
 *   2. The first intentional play was silent (the audio reconciliation latched
 *      on the provider's own autoplay 'play' event, before any user gesture).
 *   3. A foreign floating window was not detected (the mode required the app to
 *      be RESUMED, which is exactly the state another app's window takes away).
 *   4. A false "full-screen required" warning appeared on the notification
 *      shade and on returning from another app (focus loss while RESUMED was
 *      treated as a foreign window).
 *
 * Runs with plain node — no bundler, no device.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    console.error(`  \u2717 ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
};

/* ───────────────────────────── 1. Liquid bar indicator ──────────────────── */

console.log('Liquid bar: the bubble can actually paint on Android');

const bar = read('src/components/navigation/GlassTabBar.tsx');

check('the indicator carries NO elevation (elevation inside a clipped rounded parent is composited away)', () => {
  // The indicator's own style block: from `styles.indicator` usage to the next
  // sibling. A stray `elevation:` there is the device bug.
  const indicator = bar.slice(bar.indexOf('styles.indicator,'));
  const block = indicator.slice(0, indicator.indexOf('/>'));
  assert.ok(!/elevation\s*:/.test(block), 'the indicator must not set elevation');
  // The style itself must not either.
  const style = bar.slice(bar.indexOf('indicator: {'));
  assert.ok(!/elevation\s*:/.test(style.slice(0, style.indexOf('row: {'))), 'styles.indicator must not set elevation');
});

check('z-order is explicit: the bubble sits under the row, above the glass layers', () => {
  assert.match(bar, /zIndex: 0[\s\S]{0,200}row: \{|zIndex: 0/);
  const style = bar.slice(bar.indexOf('indicator: {'));
  assert.match(style.slice(0, style.indexOf('row: {')), /zIndex:\s*0/);
  assert.match(style.slice(style.indexOf('row: {')), /zIndex:\s*1/);
});

check('the approved liquid gradient lives INSIDE the bubble (not only a flat wash)', () => {
  const indicator = bar.slice(bar.indexOf('styles.indicator,'));
  const block = indicator.slice(0, indicator.indexOf('</Animated.View>'));
  assert.match(block, /<LinearGradient/);
  assert.match(block, /colors=/);
});

check('the bubble is placed from the route on the first frame (no effect that must "win")', () => {
  assert.match(bar, /if \(previous === null \|\| Math\.abs\(previous - target\) < 0\.5\)/);
  assert.match(bar, /translateX\.setValue\(target\)/);
});

check('geometry cannot be poisoned by a non-finite measurement', () => {
  assert.match(bar, /Number\.isFinite\(rawWindowWidth\)/);
  assert.match(bar, /if \(!Number\.isFinite\(target\)\) return;/);
  assert.match(bar, /Math\.max\(tabWidth - INDICATOR_INSET \* 2, 24\)/);
});

check('RTL ordering is unchanged', () => {
  assert.match(bar, /isRTL \? rowSpan - \(i \+ 1\) \* tabWidth : i \* tabWidth/);
  assert.match(bar, /flexDirection: isRTL \? 'row-reverse' : 'row'/);
});

/* ───────────────────────────── 2. Plyr first-play audio ─────────────────── */

console.log('\nPlyr audio: the first intentional play is audible');

const playerScript = read('src/lib/plyr/playerScript.ts');

check('the one-shot latch that consumed the reconciliation is gone', () => {
  assert.ok(!/audioPolicyApplied/.test(playerScript), 'a latch on the FIRST play event fired before any user gesture');
});

check('the reconciliation is gated on a real user gesture, not on the play event alone', () => {
  assert.match(playerScript, /var userGestureSeen = false;/);
  assert.match(playerScript, /if \(!userGestureSeen\) return;/);
  // The centre play control records the gesture.
  assert.match(playerScript, /userGestureSeen = true;[\s\S]{0,200}togglePlayback\(\);/);
});

check('a deliberate student mute is respected in BOTH directions', () => {
  assert.match(playerScript, /setTimeout\(function \(\) \{\s*try \{ userChoseMute = player\.muted === true; \}/);
  assert.match(playerScript, /if \(userChoseMute\) return;/);
});

check('the provider-level mute is probed, not just the Plyr wrapper flag', () => {
  assert.match(playerScript, /player\.embed\.getPlayer\(\)\.isMuted\(\)/);
});

/* ───────────────── 3 + 4. Foreign-window detection and false warnings ───── */

console.log('\nWindow focus: foreign windows are caught, system UI is not');

const plugin = read('plugins/withSecurityModule.js');

check('foreign_window requires a PAUSED activity (another task took the top-resumed slot)', () => {
  assert.match(plugin, /if \(foreignWindowFocused && !appResumed\) return WINDOW_MODE_FOREIGN/);
});

check('the activity reports its own paused state and checks the window is still visible', () => {
  assert.match(plugin, /private var activityPaused = false/);
  assert.match(plugin, /override fun onPause\(\)[\s\S]{0,200}activityPaused = true/);
  assert.match(plugin, /override fun onResume\(\)[\s\S]{0,200}activityPaused = false/);
  assert.match(plugin, /decor\.windowVisibility != View\.VISIBLE\) return false/);
  assert.match(plugin, /return activityPaused/);
});

check('returning to the front reports full-screen/focused at once', () => {
  assert.match(plugin, /override fun onResume\(\)[\s\S]{0,500}WindowModeBridge\.report\(isInMultiWindowMode\(\), isInPictureInPictureMode\(\), false, true\)/);
});

check('a focus loss no longer reports foreign while the app is resumed', () => {
  // The old call hard-coded appResumed = true, which made a shade pull a
  // confirmed foreign window.
  assert.ok(
    !/report\(isInMultiWindowMode\(\), isInPictureInPictureMode\(\), true, true\)/.test(plugin),
    'focus loss must not be reported as a foreign window while resumed',
  );
  assert.match(plugin, /if \(windowCoveredByOtherTask\(\)\) \{\s*WindowModeBridge\.report\(isInMultiWindowMode\(\), isInPictureInPictureMode\(\), true, false\)/);
});

check('our own dialogs still cannot trip the gate', () => {
  const ctx = read('src/lib/SecurityContext.tsx');
  assert.match(ctx, /incomingMode === 'foreign_window' && hasOwnDialogOpen\(\)/);
});

check('split-screen and PiP still outrank the focus-based mode', () => {
  const modeOf = plugin.slice(plugin.indexOf('fun modeOf('), plugin.indexOf('fun modeOf(') + 700);
  const pipIdx = modeOf.indexOf('if (isInPictureInPictureMode) return WINDOW_MODE_PIP');
  const multiIdx = modeOf.indexOf('if (isInMultiWindowMode) return WINDOW_MODE_MULTI');
  const foreignIdx = modeOf.indexOf('WINDOW_MODE_FOREIGN');
  assert.ok(pipIdx >= 0 && multiIdx > pipIdx && foreignIdx > multiIdx, 'PiP, then multi-window, then foreign');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
