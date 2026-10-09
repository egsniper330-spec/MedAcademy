#!/usr/bin/env node
/**
 * Fullscreen system-UI contract (Android navigation bar in fullscreen).
 *
 * REPORTED SYMPTOM (physical tablet):
 *   In fullscreen video a white/uniform strip stayed along the bottom of the
 *   screen and the video never filled the display.
 *
 * MEASURED ON THE DEVICE (SM-T505N, Android 12, landscape fullscreen):
 *   • bottom 40px = single uniform colour rgb(232,238,246), 100% share  → the OS
 *     navigation bar was visible
 *   • top 40px    = video content                                      → status
 *     bar correctly hidden
 *   • activity appBounds stayed [0,0][2000,1128] → 72px never given to the app
 *   • `NavigationBar0 ... mAnimationType=insets_animation` → a hide WAS in flight
 *
 * ROOT CAUSE
 *   `setVisibilityAsync('hidden')` is the correct edge-to-edge API
 *   (WindowInsetsControllerCompat.hide(navigationBars()) on the activity
 *   window), but the verification step read the state back IMMEDIATELY and,
 *   because the hide is an ANIMATED insets change, still saw 'visible' — then
 *   explicitly called `setVisibilityAsync('visible')`, undoing it for the whole
 *   session. `setBehaviorAsync` (a deprecated no-op under edge-to-edge) also sat
 *   on the same await chain ahead of the hide, so any future rejection there
 *   would have skipped the hide entirely.
 *
 * Usage: node tests/fullscreenSystemUi.test.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = 'src/lib/fullscreenSystemUi.ts';
const src = fs.readFileSync(path.join(ROOT, SRC), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}

function fnBody(name) {
  const start = src.indexOf('async function ' + name);
  const alt = src.indexOf('function ' + name);
  const at = start >= 0 ? start : alt;
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

console.log('\nA. hide path — no destructive verification');
const hide = fnBody('hideNavigationBar');
ok(hide !== null, 'hideNavigationBar() exists (extracted)');
if (hide) {
  ok(/setVisibilityAsync\('hidden'\)/.test(hide),
    'hide: calls setVisibilityAsync("hidden")');
  ok(!/setVisibilityAsync\('visible'\)/.test(hide),
    'hide: NEVER forces the bar back to "visible" (the self-undo bug)');
  ok(/getVisibilityAsync\(\)/.test(hide),
    'hide: still verifies with getVisibilityAsync()');
  ok(/HIDE_ATTEMPTS/.test(hide) && /for\s*\(/.test(hide),
    'hide: verification retries in a bounded loop (insets animation settles)');
  ok(/HIDE_SETTLE_MS/.test(hide) && /delay\(/.test(hide),
    'hide: waits between attempts instead of reading immediately');
}

console.log('\nB. deprecated no-op cannot skip the hide');
const behaviorIdx = hide ? hide.indexOf("setBehaviorAsync('overlay-swipe')") : -1;
const hideIdx = hide ? hide.indexOf("setVisibilityAsync('hidden')") : -1;
ok(behaviorIdx >= 0 && hideIdx >= 0, 'both setBehaviorAsync and the hide are present');
ok(behaviorIdx >= 0 && hideIdx > behaviorIdx,
  'order preserved: behavior then hide');
{
  // The setBehavior call must live inside its own try/catch so a rejection
  // cannot propagate out of the chain and skip the hide.
  const window = hide ? hide.slice(behaviorIdx - 120, behaviorIdx + 200) : '';
  ok(/try\s*\{/.test(window) && /catch\s*\{/.test(window),
    'setBehaviorAsync is isolated in its own try/catch (cannot short-circuit the hide)');
}

console.log('\nC. rotation re-assert');
ok(/Dimensions\.addEventListener\('change'/.test(src),
  'rotation: subscribes to Dimensions change while active');
ok(/function startReassertOnRotation|startReassertOnRotation\(\)/.test(src),
  'rotation: re-assert helper exists and is used');
ok(/dimsSubscription\?\.remove\(\)|dimsSubscription\.remove\(\)/.test(src),
  'rotation: listener removed on release (no leak)');
ok(/reassertFullscreenSystemUi/.test(src),
  'rotation: an explicit re-assert API is exported for hosts');
const reassert = fnBody('reassertFullscreenSystemUi');
ok(reassert !== null && /active/.test(reassert),
  'rotation: re-assert is a no-op unless fullscreen is active');

console.log('\nD. lifecycle safety');
ok(/refCount \+= 1/.test(src) && /Math\.max\(0, refCount - 1\)/.test(src),
  'lifecycle: ref-counted enter/exit');
ok(/Platform\.OS !== 'android'/.test(src),
  'lifecycle: Android-only (no-ops elsewhere)');
const release = fnBody('releaseFullscreenSystemUi');
ok(release !== null && /setVisibilityAsync\('visible'\)/.test(release),
  'lifecycle: exit restores the bar to visible');
ok(release !== null && /stopReassertOnRotation\(\)/.test(release),
  'lifecycle: release also stops the rotation listener');

console.log('\nF. fullscreen surface covers the DISPLAY, not the inset-adjusted window');
{
  const dimsSrc = fs.readFileSync(path.join(ROOT, 'src/lib/useFullscreenWindowDims.ts'), 'utf8');
  ok(/Dimensions\.get\('screen'\)/.test(dimsSrc),
    'dims: reads Dimensions.get("screen") (the display) for fullscreen sizing');
  ok(/scr\.width >= win\.width && scr\.height >= win\.height/.test(dimsSrc),
    'dims: uses the display only when it is at least as large as the window');
  ok(/return \{ width: win\.width, height: win\.height \};/.test(dimsSrc),
    'dims: falls back to the window size (defensive for odd OEMs)');
  ok(/2000x1128|1128|stable/.test(dimsSrc),
    'dims: records WHY — hiding the nav bar does not clear its stable inset');
}

console.log('\nE. evidence recorded in-source');
ok(/insets_animation|ANIMATED insets/.test(src),
  'docs: the animated-insets evidence is recorded');
ok(/232,238,246|appBounds/.test(src),
  'docs: the measured device evidence is recorded');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
