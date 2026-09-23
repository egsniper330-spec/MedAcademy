/**
 * Regression test — iOS LAUNCH BLACK SCREEN (screen-capture window reparent).
 *
 * Run: node .freebuff/run-state-tests.cjs   (auto-included by the runner)
 *
 * THE DEFECT THIS PINS:
 * expo-screen-capture's native preventScreenshots() calls
 * keyWindow.layer.removeFromSuperlayer() and reparents keyWindow.layer into
 * UITextField's private off-screen CALayer (this is how iOS screenshot
 * protection is implemented — there is no flag to set). If that reparent runs
 * in the SAME main-thread run-loop iteration as the CATransaction that presents
 * a frame, the window layer is never registered with the display compositor:
 * the app keeps rendering into an off-screen buffer, the display receives
 * nothing, and the screen is BLACK while JS happily keeps running.
 *
 * At cold start the FIRST root UI is the fail-closed update wall
 * (ForceUpdateGate: verdict UNKNOWN + evaluating → "Checking for updates…"),
 * and two inputs race:
 *   • isLoading  ← SessionProvider.getSession(), a LOCAL SecureStore read;
 *   • the wall   ← a NETWORK request to /app/version.
 * The local read resolves first, so an effect gated ONLY on `isLoading` fires
 * its reparent while the first frames are still being presented → the observed
 * sequence "Checking updates… → wall disappears → black screen".
 *
 * WHY STRUCTURAL: the contract is a native run-loop ordering guarantee. There
 * is no JS unit under test (the device/UI thread behaviour cannot be
 * reproduced in node), so — exactly like the rest of this repo's native-timing
 * protections — the shipped source shape is pinned: any reintroduction of an
 * un-deferred reparent, or removal of the presented-frame gate, fails here.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

// ── Root layout: the launch reparent must be gated AND deferred ──────────────
{
  const src = read('src/app/_layout.tsx');

  // Isolate RootScreenCapture (the root-level owner of the 'root-shell' lock).
  const start = src.indexOf('function RootScreenCapture()');
  const end = src.indexOf('function RootLayoutNav()');
  const root = start >= 0 && end > start ? src.slice(start, end) : '';
  ok(root.length > 0, 'root: RootScreenCapture located in the root layout');

  // The apply effect is the one that owns the initial protect/release decision.
  const applyStart = root.indexOf('const framePresented = useFirstFramePresented();');
  const applyEnd = root.indexOf('// Re-apply on every foreground transition');
  const apply = applyStart >= 0 && applyEnd > applyStart ? root.slice(applyStart, applyEnd) : '';
  ok(apply.length > 0, 'root: apply effect located (frame gate → native call)');

  // 1. BOTH guards required — isLoading alone is provably insufficient.
  ok(/if \(isLoading \|\| !framePresented\)/.test(apply),
    'root: apply effect gated on !isLoading AND a PRESENTED frame (isLoading alone is the launch race)');
  ok(/isLoading \|\| !framePresented[\s\S]*?return;/.test(apply),
    'root: the guard returns (no reparent) until both conditions hold');

  // 2. The native reparent is DEFERRED past the presenting run-loop iteration,
  //    and the deferral happens BEFORE the native call (ordering, not presence).
  const setT = apply.indexOf('setTimeout(');
  const prevent = apply.indexOf('preventScreenCaptureAsync(');
  const allow = apply.indexOf('allowScreenCaptureAsync(');
  ok(setT >= 0, 'root: native reparent wrapped in setTimeout(0)');
  ok(setT >= 0 && prevent > setT, 'root: preventScreenCaptureAsync is INSIDE setTimeout (never invoked synchronously from the effect body)');
  ok(setT >= 0 && allow > setT, 'root: allowScreenCaptureAsync is INSIDE setTimeout (Super Admin release path defers too)');
  ok(/clearTimeout\(timer\)/.test(apply), 'root: deferred reparent is cancelled on cleanup (no apply-after-unmount)');

  // 3. Dependencies: a change in frame presentation must re-run the effect.
  ok(/\}, \[isSuperAdmin, isLoading, framePresented\]\)/.test(apply),
    'root: framePresented is an effect dependency (latching, not a one-shot read)');

  // 4. Every ROOT-key reparent must be deferred. There are exactly two protect
  //    sites (the apply effect and the foreground re-apply); any NEW bare
  //    preventScreenCaptureAsync() would re-run preventScreenshots(), overwriting
  //    expo-screen-capture's saved originalParent with the ALREADY-reparented
  //    layer — a later release would then restore the window into a detached
  //    layer (same black screen, this time at logout/foreground).
  const preventSites = [];
  let scan = 0;
  for (;;) {
    const at = src.indexOf('preventScreenCaptureAsync(ROOT_SC_KEY)', scan);
    if (at < 0) break;
    preventSites.push(at);
    scan = at + 1;
  }
  ok(preventSites.length === 2,
    `root: exactly two protect sites for 'root-shell' — apply effect + foreground re-apply (found ${preventSites.length})`);
  preventSites.forEach((at, i) => {
    // The protect call must sit INSIDE a setTimeout callback: a timer opens
    // before it and is not yet closed ("}, 0);") at that point.
    const before = src.slice(Math.max(0, at - 900), at);
    const tIdx = before.lastIndexOf('setTimeout(');
    const between = tIdx >= 0 ? before.slice(tIdx) : '';
    ok(tIdx >= 0 && !/\},\s*0\);/.test(between),
      `root: protect site #${i + 1} is deferred (setTimeout callback encloses the native reparent)`);
  });

  // Releases (SA bypass / unmount) never reparent, so they may be immediate —
  // but they must exist for every protect site plus the unmount cleanup.
  const allowCount = (src.match(/allowScreenCaptureAsync\(ROOT_SC_KEY\)/g) || []).length;
  ok(allowCount === 3, `root: release sites = SA path + foreground + unmount cleanup (found ${allowCount})`);

  // 5. The presented-frame signal itself: two rAF ticks (commit + present) then a
  //    macrotask, with cancellation — the repo's existing after-paint convention.
  const rafCount = (src.match(/requestAnimationFrame\(/g) || []).length;
  ok(rafCount >= 2, `root: presented-frame signal uses two rAF ticks (found ${rafCount})`);
  ok(/cancelAnimationFrame\(raf1\)/.test(src) && /cancelAnimationFrame\(raf2\)/.test(src),
    'root: both rAF ticks are cancelled on unmount');
  ok(/process\.env\.EXPO_OS === 'web'/.test(src) && /preventScreenCaptureAsync/.test(src),
    'root: web short-circuit retained (native path is iOS/Android only)');

  // 6. Regression guard for the sibling call site that already carried the fix:
  //    the (app) shell's APP_SC_KEY reparent must stay deferred and ordered.
  const appShell = read('src/app/(app)/_layout.tsx');
  const shellKey = appShell.indexOf("const APP_SC_KEY");
  const shellPrevent = appShell.indexOf('preventScreenCaptureAsync(APP_SC_KEY)', shellKey);
  const shellTimer = appShell.indexOf('const timer = setTimeout(', shellKey);
  ok(shellKey >= 0 && shellTimer >= 0 && shellPrevent > shellTimer,
    'app shell: APP_SC_KEY reparent stays INSIDE setTimeout(0) (deferral contract preserved)');
}

console.log('──────────────────────────────────────────────');
if (failed === 0) {
  console.log(`RESULT: ${passed} passed, 0 failed`);
  console.log('ALL SCREEN-CAPTURE STARTUP TESTS PASSED');
} else {
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  FAILED: ' + f);
  process.exit(1);
}
