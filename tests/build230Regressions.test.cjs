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

check('the bubble is a PLAIN filled view: no transform / zIndex / overflow / child view', () => {
  const indicator = bar.slice(bar.indexOf('styles.indicator,'));
  const block = indicator.slice(0, indicator.indexOf('/>'));
  // Position and width are animated LAYOUT values, not a transform.
  assert.match(bar, /left: translateX,/);
  assert.match(bar, /width: indicatorWidthAnim,/);
  assert.match(bar, /backgroundColor: isDark \? 'rgba\(96,165,250,0\.30\)' : 'rgba\(30,144,255,0\.22\)',/);
  assert.ok(!/transform:/.test(block), 'the bubble must not rely on a transform layer');
  assert.ok(!/zIndex/.test(block), 'the bubble must not rely on zIndex inside the clipped pill');
  assert.ok(!/<LinearGradient/.test(block), 'the bubble must not depend on a child native view');
  const style = bar.slice(bar.indexOf('indicator: {'));
  const styleBlock = style.slice(0, style.indexOf('row: {'));
  assert.ok(!/zIndex/.test(styleBlock) && !/overflow/.test(styleBlock),
    'the bubble style must not clip or stack itself');
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

check('RTL ordering is the SAME visual order (reversed once, never double-mirrored)', () => {
  // The old contract was arithmetic mirroring PLUS a `row-reverse` row. Two
  // mirrorings of one list can disagree (a mirrored index lands on the opposite
  // tab), so the order is now reversed explicitly and the row stays ltr.
  assert.match(bar, /isRTL \? \[\.\.\.visibleRoutes\]\.reverse\(\) : visibleRoutes/);
  assert.match(bar, /i \* tabWidth/);
  assert.match(bar, /style=\{\[styles\.row, \{ direction: 'ltr' \}\]\}/);
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

check('foreign_window is reported on ANY focus loss (paused OR resumed — the missed pop-up case)', () => {
  assert.match(plugin, /if \(foreignWindowFocused\) return WINDOW_MODE_FOREIGN/);
  assert.ok(!/foreignWindowFocused && !appResumed/.test(plugin),
    'requiring a paused activity is exactly what missed a pop-up over a resumed app');
});

check('the activity checks its window is still visible before reporting a foreign window', () => {
  assert.match(plugin, /private var activityPaused = false/);
  assert.match(plugin, /override fun onPause\(\)[\s\S]{0,200}activityPaused = true/);
  assert.match(plugin, /override fun onResume\(\)[\s\S]{0,200}activityPaused = false/);
  assert.match(plugin, /decor\.windowVisibility != View\.VISIBLE\) return false/);
  // Focus loss alone is no longer the finding: it is a foreign APPLICATION only
  // when another activity owns the top-resumed slot, which is what makes an
  // app-wide lock safe (the notification shade leaves us top-resumed).
  assert.match(plugin, /if \(decor\.hasWindowFocus\(\)\) return false/);
  assert.match(plugin, /SDK_INT >= 29 && topResumedActivity\) return false[\s\S]{0,80}return true/);
  assert.match(plugin, /override fun onTopResumedActivityChanged\(isTopResumed: Boolean\)/);
});

check('returning to the front reports full-screen/focused at once', () => {
  assert.match(plugin, /override fun onResume\(\)[\s\S]{0,500}WindowModeBridge\.report\(isInMultiWindowMode\(\), isInPictureInPictureMode\(\), false, true\)/);
});

check('a focus loss IS reported while the app is resumed (the floating-window attack)', () => {
  // A pop-up over a still-resumed MedAcademy previously produced focus loss
  // with appResumed=true and was classified full screen — the whole bug. The
  // live lifecycle flag is now forwarded instead of hard-coded.
  assert.match(plugin, /WindowModeBridge\.report\(\s*\n\s*isInMultiWindowMode\(\),\s*\n\s*isInPictureInPictureMode\(\),\s*\n\s*true,\s*\n\s*!activityPaused,\s*\n\s*\)/);
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
