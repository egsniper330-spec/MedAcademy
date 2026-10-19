#!/usr/bin/env node
/**
 * Multi-window / split-screen enforcement — regression suite.
 *
 * Run: node tests/multiWindowGate.test.cjs
 *
 * WHAT THIS LOCKS DOWN
 * ──────────────────────────────────────────────────────────────────────────
 * MedAcademy must only run full-screen. Split-screen (and any other Android
 * multi-window mode, including our own picture-in-picture) is a MANDATORY block:
 * protected content and playback stay closed, there is no "Continue Anyway", and
 * access returns only when the platform reports the app back in full screen AND
 * a fresh authoritative verdict has landed.
 *
 * Four kinds of assertion, because the previous security defects in this
 * codebase were integration failures rather than logic failures:
 *
 *   1. PURE MODEL (compiled standalone, like tests/securityGateState.test.cjs):
 *      the new gate state, its precedence, its release rule and its copy.
 *   2. NATIVE (the Kotlin template embedded in plugins/withSecurityModule.js,
 *      which IS the shipped native module): the documented APIs are actually
 *      read, the state is pushed to JS, and there is no polling loop.
 *   3. THE MAIN-ACTIVITY PATCH: exercised for real through the plugin's exported
 *      pure patcher (idempotency, refusal on foreign sources, completeness).
 *   4. WIRING: the native signal reaches the lock, the lock drives the gate, and
 *      the gate renders the restriction without a dismiss path.
 *
 * DOCUMENTED LIMITS ARE ASSERTED TOO: the suite checks that the implementation
 * does NOT claim to detect another app's windows (no accessibility service, no
 * usage-access permission, no invented finding).
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

// ── The pure model, compiled exactly as the app compiles it ──────────────────
function buildModel() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multiwin-model-'));
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

const PLUGIN = read('plugins/withSecurityModule.js');
const NATIVE = read('src/lib/nativeSecurity.ts');
const CONTEXT = read('src/lib/SecurityContext.tsx');
const GATE = read('src/app/(app)/security-gate.tsx');
/** GATE with block comments stripped, so a comment that QUOTES a forbidden
 *  label cannot satisfy (or defeat) a pattern. Mirrors the helper in
 *  tests/overlayLifecycleWiring.test.cjs / tests/vpnMandatoryBlock.test.cjs. */
const GATE_CODE = GATE.replace(/\/\*[\s\S]*?\*\//g, (match, offset, whole) => {
  const lineStart = whole.lastIndexOf('\n', offset) + 1;
  const before = whole.slice(lineStart, offset);
  const odd = (q) => (before.split(q).length - 1) % 2 === 1;
  return (odd("'") || odd('"') || odd('`')) ? match : '';
}).split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

/** The Kotlin source embedded in the config plugin (the real native module). */
function kotlinSource() {
  const src = PLUGIN;
  const open = 'const SECURITY_MODULE_KT = `';
  const start = src.indexOf(open) + open.length;
  const end = src.indexOf('`;', start);
  return src.slice(start, end);
}
const KT = kotlinSource();

const NO_INPUT = {
  evaluating: false,
  hasVerdict: true,
  overlayBlocked: false,
  multiWindowBlocked: false,
  backgroundResumeBlocked: false,
  vpnBlocked: false,
  violationBlocked: false,
};
const state = (over) => M.resolveSecurityGateState({ ...NO_INPUT, ...over });

// ── Part 1: the state exists, blocks, and never offers a dismiss path ───────
console.log('\u2500\u2500 Part 1: gate state + precedence \u2500\u2500');
{
  check('1a: BLOCKED_MULTI_WINDOW is part of the closed vocabulary',
    M.SECURITY_GATE_STATES.includes('BLOCKED_MULTI_WINDOW'));
  check('1b: it is a blocking state (the gate mounts)',
    M.isGateBlocked('BLOCKED_MULTI_WINDOW') === true);
  check('1c: a prohibited window mode resolves BLOCKED_MULTI_WINDOW',
    state({ multiWindowBlocked: true }) === 'BLOCKED_MULTI_WINDOW');
  check('1d: it outranks the background/resume hold, VPN and any policy violation',
    state({ multiWindowBlocked: true, backgroundResumeBlocked: true, vpnBlocked: true, violationBlocked: true })
      === 'BLOCKED_MULTI_WINDOW');
  check('1e: the live overlay signal still outranks it (untrusted touch path first)',
    state({ multiWindowBlocked: true, overlayBlocked: true }) === 'BLOCKED_OVERLAY');
  check('1f: a live block outranks a check in flight (no BLOCKED \u2192 CHECKING \u2192 TEMP-ALLOWED race)',
    state({ multiWindowBlocked: true, evaluating: true, hasVerdict: false }) === 'BLOCKED_MULTI_WINDOW');
  // Requiring BOTH missing inputs false is what keeps a window-mode restriction
  // from ever being read as an unverified (CHECKING) state.
  check('1g: with the flag false the state is driven by the remaining inputs only',
    state({}) === 'ALLOWED' && state({ evaluating: true }) === 'CHECKING');

  // REQUIRED BY THE SPEC: no control may let the user past the restriction while
  // the prohibited state is live. No recheck button, no dismiss, no acknowledgement.
  check('1h: the multi-window state offers NO recheck/dismiss control',
    M.isGateRecheckable('BLOCKED_MULTI_WINDOW') === false);
  check('1i: ... while the causes a user can act on still do offer one',
    M.isGateRecheckable('BLOCKED_OVERLAY') === true
    && M.isGateRecheckable('BLOCKED_VPN') === true);
  // The resume hold has no page and always completes on its own, so it offers
  // no control (and no way to mistake one for a dismiss path).
  check('1i-2: the resume hold offers no control (no page, self-completing)',
    M.isGateRecheckable('BLOCKED_BACKGROUND_RESUME') === false
    && M.rendersBlockScreen('BLOCKED_BACKGROUND_RESUME') === false);
}

// ── Part 2: release rule (platform restored AND a fresh verdict) ────────────
console.log('\u2500\u2500 Part 2: release rule \u2500\u2500');
{
  const c = (modeRestored, hasFreshVerdict) => M.canClearMultiWindowBlock({ modeRestored, hasFreshVerdict });

  check('2a: back in full screen AND a fresh verdict \u2192 may clear', c(true, true) === true);
  check('2b: a fresh verdict while STILL in the prohibited mode cannot clear', c(false, true) === false);
  check('2c: full screen with NO fresh verdict cannot clear (the event alone is not verification)',
    c(true, false) === false);
  check('2d: neither condition \u2192 cannot clear', c(false, false) === false);

  // Only the two platform modes count as prohibited; 'unknown' is unmeasured and
  // must never become a finding (fail-safe, not fail-silent).
  check('2e: split-screen and PiP are the prohibited modes',
    M.isProhibitedWindowMode('multi_window') === true && M.isProhibitedWindowMode('picture_in_picture') === true);
  check('2f: full screen is permitted', M.isProhibitedWindowMode('fullscreen') === false);
  check('2g: an UNMEASURED mode ("unknown") is never a finding',
    M.isProhibitedWindowMode('unknown') === false
    && M.isProhibitedWindowMode(null) === false
    && M.isProhibitedWindowMode(undefined) === false
    && M.isProhibitedWindowMode('') === false);
}

// ── Part 3: copy \u2014 split screen and PiP are worded separately, never as an overlay ──
console.log('\u2500\u2500 Part 3: blocking copy + honest limits \u2500\u2500');
{
  const split = M.MULTI_WINDOW_WARNING_COPY;
  const pip = M.PICTURE_IN_PICTURE_WARNING_COPY;

  check('3a: the split-screen copy names the condition and the required action',
    /split-screen/i.test(split.message) && /full-screen/i.test(split.message));
  check('3b: the PiP copy names the floating window explicitly',
    /floating window/i.test(pip.message) && /picture-in-picture/i.test(pip.message));
  check('3c: the two messages are different (one condition, one action each)', split.message !== pip.message);
  check('3d: windowModeBlockCopy selects by the mode actually reported',
    M.windowModeBlockCopy('picture_in_picture') === pip && M.windowModeBlockCopy('multi_window') === split);
  check('3e: an unknown/absent mode falls back to the split-screen copy, NOT to a PiP claim',
    M.windowModeBlockCopy('unknown') === split
    && M.windowModeBlockCopy(undefined) === split
    && M.windowModeBlockCopy(null) === split);
  check('3f: neither message claims an overlay was detected',
    !/overlay/i.test(split.message) && !/overlay/i.test(pip.message));
  check('3g: the overlay copy is untouched and still its own message',
    M.OVERLAY_WARNING_COPY.message.includes('overlay or another app may be interfering'));

  const splitSteps = M.windowModeBlockSteps('multi_window');
  const pipSteps = M.windowModeBlockSteps('picture_in_picture');
  check('3h: recovery steps exist for both modes and differ',
    splitSteps.length >= 3 && pipSteps.length >= 3
    && JSON.stringify(splitSteps) !== JSON.stringify(pipSteps));
  check('3i: the split-screen steps tell the user to go full-screen',
    splitSteps.some((s) => /full screen/i.test(s)));
  check('3j: the PiP steps tell the user to close the floating window',
    pipSteps.some((s) => /floating/i.test(s)));

  const limits = M.MULTI_WINDOW_DETECTION_LIMITS;
  check('3k: the documented limits are substantial (>= 5 honest statements)', limits.length >= 5);
  check('3l: they state that another app\u2019s windows cannot be enumerated',
    limits.some((l) => /no public API/i.test(l)) && limits.some((l) => /another app/i.test(l)));
  check('3m: they state that no permission is requested for this check',
    limits.some((l) => /No permission|no permission/i.test(l)));
  check('3n: they state that accessibility-based observation was deliberately not used',
    limits.some((l) => /accessibility service/i.test(l)));
  check('3o: they state that multi-window and overlay are different measurements',
    limits.some((l) => /never conflated|DIFFERENT measurements/i.test(l)));
  check('3p: they state that an unavailable measurement is "unknown", not "full-screen"',
    limits.some((l) => /unknown/i.test(l) && /never as proof/i.test(l)));
}

// ── Part 4: the native module really uses the documented Android APIs ───────
console.log('\u2500\u2500 Part 4: native detection (Kotlin) \u2500\u2500');
{
  const pairs = [
    ['4a: reads Activity.isInMultiWindowMode()', /activity\.isInMultiWindowMode\(\)/],
    ['4b: reads Activity.isInPictureInPictureMode()', /activity\.isInPictureInPictureMode\(\)/],
    ['4c: PiP is classified BEFORE multi-window (PiP implies multi-window)',
      /fun modeOf\(isInMultiWindowMode: Boolean, isInPictureInPictureMode: Boolean\): String \{\n\s+if \(isInPictureInPictureMode\) return WINDOW_MODE_PIP\n\s+if \(isInMultiWindowMode\) return WINDOW_MODE_MULTI\n\s+return WINDOW_MODE_FULLSCREEN/],
    ['4d: exposes getWindowMode() to JS', /fun getWindowMode\(promise: Promise\)/],
    ['4e: exposes enableWindowModeMonitoring() to JS', /fun enableWindowModeMonitoring\(promise: Promise\)/],
    ['4f: pushes real transitions to JS', /emit\("windowModeChanged", params\)/],
    ['4g: the event carries the mode and the measured flag',
      /params\.putString\("mode", mode\)/],
    ['4h: the activity callback is relayed through a process-wide bridge', /object WindowModeBridge \{/],
    ['4i: the bridge retains the last reported mode for a late module instance',
      /var lastReported: String = WINDOW_MODE_UNKNOWN/],
    ['4j: the watcher re-reads on a window LAYOUT pass (split-screen resizes us)',
      /addOnLayoutChangeListener\(windowModeLayoutListener\)/],
    ['4k: the watcher re-reads on host RESUME (direct launch into split-screen)',
      /reactContext\.addLifecycleEventListener\(listener\)/],
    ['4l: the resume hook re-reads the mode', /override fun onHostResume\(\) \{/],
    ['4m: repeated reports of the same mode are deduplicated (no event storm)',
      /val changed = mode != windowMode \|\| !windowModeMeasured/],
    ['4n: monitoring is installed with the module (not only from JS)',
      /Handler\(Looper\.getMainLooper\(\)\)\.post \{ installWindowModeMonitoring\(\) \}/],
    ['4o: everything is torn down with the module',
      /tearDownWindowModeMonitoring\(\)/],
    ['4p: getSecurityFlags() carries the window-mode evidence',
      /r\.putString\("windowMode", windowMode\)/],
    ['4q: ... including the measured flag that distinguishes "unknown" from "full screen"',
      /r\.putBoolean\("windowModeMeasured", windowModeMeasured\)/],
    ['4r: the UI-thread requirement is respected (reads posted to the main handler)',
      /refreshWindowModeOnMain/],
    ['4s: the other-apps-windows limit is documented in the module',
      /no public API for one app to enumerate/i],
    ['4t: the OEM floating-window limit is documented', /OEM floating-window|vendor UI/],
  ];
  for (const [name, re] of pairs) check(name, re.test(KT));

  check('4u: an unreadable/absent activity reports "unknown", never "fullscreen"',
    /private fun readWindowMode\(activity: Activity\?\): String \{\n\s+if \(activity == null\) return WINDOW_MODE_UNKNOWN/.test(KT));
  check('4v: a failed read never OVERWRITES the last measured mode with a guess',
    /if \(mode == WINDOW_MODE_UNKNOWN\) return windowMode/.test(KT));
  check('4w: nothing is published for an unmeasured state',
    /private fun publishWindowMode\(mode: String, source: String\) \{\n\s+if \(mode == WINDOW_MODE_UNKNOWN\) return/.test(KT));
  check('4x: no polling loop was added (no timer/interval in the Kotlin module)',
    !/setInterval|Timer\(\)|scheduleAtFixedRate|postDelayed\(\s*\{[^}]*windowMode/i.test(KT));
  check('4y: no new native bypass/override flag was introduced',
    !/allowSplitScreen|skipMultiWindow|forceAllow|debugAllow/i.test(KT));
}

// ── Part 5: the MainActivity patch is real, idempotent and safe ────────────
console.log('\u2500\u2500 Part 5: MainActivity forwarders (plugin) \u2500\u2500');
{
  const plugin = require(path.join(ROOT, 'plugins', 'withSecurityModule.js'));
  check('5a: the plugin exports the pure patcher for testability',
    typeof plugin.patchMainActivityForWindowMode === 'function');
  check('5b: it is wired into the combined plugin export (withMainActivity mod)',
    /config = withMainActivityWindowMode\(config\);/.test(PLUGIN)
    && /return withMainActivity\(config, \(cfg\) => \{/.test(PLUGIN));

  // The REAL generated activity (android/ is prebuild output, so the plugin is
  // the source of truth — but when the directory exists the patch is exercised
  // against the actual file, not a fixture).
  const realPath = path.join(
    ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'medacademy', 'app', 'MainActivity.kt',
  );
  const source = fs.existsSync(realPath)
    ? fs.readFileSync(realPath, 'utf8')
    : 'package com.medacademy.app\n\nimport android.os.Build\nimport android.os.Bundle\n\nimport com.facebook.react.ReactActivity\n\nclass MainActivity : ReactActivity() {\n  override fun getMainComponentName(): String = "main"\n}\n';
  const patched = plugin.patchMainActivityForWindowMode(source);

  check('5c: the patch applies to the generated MainActivity', patched !== source);
  check('5d: it forwards the API 26+ multi-window overload',
    /override fun onMultiWindowModeChanged\(isInMultiWindowMode: Boolean, newConfig: Configuration\) \{\n\s+super\.onMultiWindowModeChanged\(isInMultiWindowMode, newConfig\)\n\s+WindowModeBridge\.report\(isInMultiWindowMode, isInPictureInPictureMode\(\)\)/.test(patched));
  check('5e: it ALSO forwards the API 24-25 overload (minSdk is 24, so both are needed)',
    /@Deprecated\("Deprecated in Java"\)\n\s+override fun onMultiWindowModeChanged\(isInMultiWindowMode: Boolean\) \{/.test(patched));
  check('5f: it forwards the picture-in-picture transition too',
    /override fun onPictureInPictureModeChanged\(isInPictureInPictureMode: Boolean, newConfig: Configuration\) \{/.test(patched));
  check('5g: both imports are added',
    /^import android\.content\.res\.Configuration$/m.test(patched)
    && /^import com\.medacademy\.security\.WindowModeBridge$/m.test(patched));
  check('5h: the patch is IDEMPOTENT (a second prebuild cannot double-inject)',
    plugin.patchMainActivityForWindowMode(patched) === patched);
  check('5i: the forwarders land INSIDE the class (before the final brace)',
    patched.lastIndexOf('override fun onPictureInPictureModeChanged') < patched.lastIndexOf('}')
    && (patched.match(/\{/g) || []).length === (patched.match(/\}/g) || []).length);
  check('5j: a Java/foreign source is refused unchanged',
    plugin.patchMainActivityForWindowMode('package x;\npublic class MainActivity extends ReactActivity {}')
      === 'package x;\npublic class MainActivity extends ReactActivity {}');
  check('5k: empty/garbage input is refused unchanged',
    plugin.patchMainActivityForWindowMode('') === ''
    && plugin.patchMainActivityForWindowMode(null) === null
    && plugin.patchMainActivityForWindowMode(undefined) === undefined);
  // ALL-OR-NOTHING: when the forwarders cannot be installed completely (here:
  // there is no import block to anchor on), the source is returned untouched
  // rather than half-patched — a half-patched activity would silently leave the
  // layout watcher and the resume hook as the only triggers.
  const foreign = 'package x\nclass MainActivity {\n  override fun a() {}\n}\n';
  check('5l: an unanchorable source is REJECTED entirely (all-or-nothing)',
    plugin.patchMainActivityForWindowMode(foreign) === foreign
    && plugin.patchMainActivityForWindowMode(foreign).includes('onMultiWindowModeChanged') === false);
  check('5m: a source WITH an import block is patched completely',
    /import android\.content\.res\.Configuration/.test(
      plugin.patchMainActivityForWindowMode('package x\nimport android.os.Bundle\n\nclass MainActivity : ReactActivity() {\n  override fun a() {}\n}\n'),
    ));
}

// ── Part 6: JS bindings degrade safely and never claim full screen ─────────
console.log('\u2500\u2500 Part 6: JS bridge (nativeSecurity) \u2500\u2500');
{
  const pairs = [
    ['6a: getNativeWindowMode() is exported', /export async function getNativeWindowMode\(\): Promise<NativeWindowModeReading>/],
    ['6b: enableNativeWindowModeMonitoring() is exported',
      /export async function enableNativeWindowModeMonitoring\(\): Promise<boolean>/],
    ['6c: onNativeWindowModeChanged() is exported',
      /export function onNativeWindowModeChanged\(/],
    ['6d: it subscribes to the windowModeChanged event', /addListener\('windowModeChanged'/],
    ['6e: the subscription is Android-only', /export function onNativeWindowModeChanged\([\s\S]{0,220}Platform\.OS !== 'android'/],
    ['6f: an absent module resolves the honest "unknown", measured:false',
      /const UNMEASURED_WINDOW_MODE: NativeWindowModeReading = \{\n\s+mode: 'unknown',\n\s+inMultiWindow: false,\n\s+inPictureInPicture: false,\n\s+measured: false,\n\};/],
    ['6g: a THROWN read is unmeasured, never "full-screen"',
      /catch \{\n\s+\/\/ A thrown read is unmeasured, never "full-screen"\.\n\s+return UNMEASURED_WINDOW_MODE;/],
    ['6h: a thrown install resolves false (never "enforced")',
      /if \(!mod \|\| typeof mod\.enableWindowModeMonitoring !== 'function'\) return false;/],
    ['6i: the flags type carries the window-mode evidence', /windowMode\?: +string;/],
    ['6j: ... and the measured flag', /windowModeMeasured\?: +boolean;/],
    ['6k: the fail-safe defaults are "unknown"/unmeasured',
      /windowMode: 'unknown',\n\s+inMultiWindowMode: false,\n\s+inPictureInPictureMode: false,\n\s+windowModeMeasured: false,/],
  ];
  for (const [name, re] of pairs) check(name, re.test(NATIVE));
  check('6l: no iOS native call was added by this work',
    !/getIOSModule\(\)[\s\S]{0,120}windowMode/i.test(NATIVE.replace(/^[^]*?\*\//, '')));
}

// ── Part 7: the signal drives the lock, and the lock drives the gate ───────
console.log('\u2500\u2500 Part 7: enforcement wiring (SecurityContext) \u2500\u2500');
{
  const pairs = [
    ['7a: the multi-window hold has its own lock source', /const LOCK_SRC_WINDOW_MODE = 'window-mode';/],
    ['7b: a prohibited mode engages the lock HARD (playback unmounts, traffic is refused)',
      /engageSecurityLock\(LOCK_SRC_WINDOW_MODE, \{ hard: true \}\)/],
    ['7c: the hold records the verdict serial at engage time',
      /windowModeEngagedSerialRef\.current = verdictSerialRef\.current;/],
    ['7d: release uses the two-condition pure rule', /canClearMultiWindowBlock\(\{/],
    ['7e: ... with the mode read from the live platform signal',
      /modeRestored:    !isProhibitedWindowMode\(windowModeRef\.current\)/],
    ['7f: the gate state input is wired', /multiWindowBlocked,/],
    ['7g: the native transition subscription feeds the state', /onNativeWindowModeChanged\(\(reading\) => \{/],
    ['7h: returning to full screen requests a FRESH verdict before unblocking',
      /if \(requestVerdict && mode === 'fullscreen'\) void check\(\);/],
    ['7i: a session start takes ONE authoritative reading (launched into split-screen)',
      /enableNativeWindowModeMonitoring\(\)\.then\(\(\) => getNativeWindowMode\(\)\)/],
    ['7j: the resume path re-installs the triggers and re-reads', /getNativeWindowMode\(\)[\s\S]{0,120}reading\.measured/],
    ['7k: a manual re-verify re-reads the window mode',
      /const reading = await getNativeWindowMode\(\);/],
    ['7l: the re-verify also re-evaluates the multi-window release',
      /tryReleaseOverlayLock\(\);\n\s+tryReleaseWindowModeLock\(\);/],
    ['7m: every landed verdict gives the hold its chance to release',
      /tryReleaseWindowModeLock\(\);/],
    ['7n: the belief is session-scoped (reset on sign-out)',
      /windowModeRef\.current = 'unknown';/],
    ['7o: the context exposes the state and the reported mode',
      /multiWindowBlocked,\n\s+windowMode:/],
    ['7p: an unmeasured reading is never applied as a state', /if \(reading\.measured\) applyWindowModeReading/],
    ['7q: the blocking copy describes the mode the HOLD is about (not a stale live reading)',
      /windowMode:          multiWindowBlocked \? windowModeEngagedModeRef\.current : windowModeRef\.current/],
  ];
  for (const [name, re] of pairs) check(name, re.test(CONTEXT));

  check('7r: the multi-window state is read from the LOCK (one source of truth)',
    /lockState\.sources\.includes\(LOCK_SRC_WINDOW_MODE\)/.test(CONTEXT));
  check('7s: the overlay path is untouched by this work (its signal, engage and release remain)',
    /onNativeObscuredChanged\(\(obscured\) => \{/.test(CONTEXT)
    && /engageSecurityLock\(LOCK_SRC_OVERLAY, \{ hard: true \}\)/.test(CONTEXT)
    && /canClearOverlayBlock\(\{/.test(CONTEXT));
}

// ── Part 8: the gate renders the restriction with no way past it ───────────
console.log('\u2500\u2500 Part 8: gate presentation \u2500\u2500');
{
  const pairs = [
    ['8a: the gate branches on the new state', /gateState === 'BLOCKED_MULTI_WINDOW'/],
    ['8b: copy comes from the pure model, selected by the reported mode',
      /windowModeBlockCopy\(windowMode\)/],
    ['8c: recovery steps come from the pure model', /windowModeBlockSteps\(windowMode\)/],
    ['8d: the steps section is labelled for this cause', /'HOW TO RETURN TO FULL SCREEN'/],
    ['8e: the policy finding list is suppressed for this window-state cause',
      /overlayBlocked \|\| windowModeBlockedState \? \[\] : gateFindings\(types\)/],
    ['8f: no risk score is presented for a non-policy window state',
      /hasVerdict && !overlayBlocked && !windowModeBlockedState/],
    ['8g: the screen states that access returns automatically', /access returns automatically as soon as it is full-screen again/],
    ['8h: the hardware back button cannot dismiss it', /hardwareBackPress', \(\) => true/],
    ['8i: FLAG_SECURE is held while this block is up', /preventScreenCaptureAsync\('security-gate'\)/],
  ];
  for (const [name, re] of pairs) check(name, re.test(GATE));

  check('8j: no recheck/dismiss control is rendered for the multi-window state',
    !/windowModeBlockedState[\s\S]{0,400}Verify security and continue/.test(GATE_CODE));
  check('8k: the recheck control is still offered for the causes that remain actionable',
    /isGateRecheckable\(gateState\)/.test(GATE) && /accessibilityLabel="Verify security and continue"/.test(GATE));
  check('8l: no "Continue Anyway" / dismiss control exists anywhere in the gate',
    !/Continue Anyway/i.test(GATE_CODE));
  check('8m: the new state is documented in the file header',
    GATE.includes('BLOCKED_MULTI_WINDOW'));

  // NO BYPASS THROUGH NAVIGATION OR APP STATE. The gate is rendered by the
  // authenticated layout ABOVE the whole Stack as inline content — not a route
  // and not a Modal — so the restriction it displays (including the multi-window
  // one) cannot be navigated around, deep-linked past, or dismissed by an app
  // state change.
  const APP_LAYOUT = read('src/app/(app)/_layout.tsx');
  check('8n: the gate is mounted by the authenticated layout, not as a route',
    /import \{ SecurityGate \} from '@\/app\/\(app\)\/security-gate';/.test(APP_LAYOUT)
    && /<SecurityGate \/>/.test(APP_LAYOUT)
    && !/security-gate/.test(read('src/app/(app)/_layout.tsx').split('\n').filter((l) => /Stack\.Screen|href/.test(l)).join('\n')));
}

// ── Part 9: existing security controls are unchanged ──────────────────────
console.log('\u2500\u2500 Part 9: existing controls unchanged \u2500\u2500');
{
  const SECURITY = read('src/lib/security.ts');

  check('9a: no new risk event/weight was invented for a window state',
    !/multi_window|multiWindow|split_screen|splitScreen/i.test(SECURITY));
  check('9b: the security engine (detectors, weights, policies) is untouched by this work',
    !/isProhibitedWindowMode|windowModeBlockCopy/.test(SECURITY));
  check('9c: no accessibility / usage-access / task-enumeration permission was added',
    !/BIND_ACCESSIBILITY_SERVICE|PACKAGE_USAGE_STATS|GET_TASKS|ACCESSIBILITY_SERVICE/.test(PLUGIN));
  check('9d: no new Android permission was added for multi-window detection',
    (PLUGIN.match(/android\.permission\.[A-Z_]+/g) || []).every((p) => [
      'android.permission.HIDE_OVERLAY_WINDOWS',
      'android.permission.QUERY_ALL_PACKAGES',
    ].includes(p) || !/ACCESSIBILITY|USAGE_STATS|TASKS|OVERLAY_WINDOWS|SYSTEM_ALERT/.test(p)));
  check('9e: the proguard keep rules still cover the security package (nothing stripped)',
    /-keep class com\.medacademy\.security\.\*\*/.test(read('plugins/withProguardRules.js')));
  check('9f: VPN / overlay / screenshot / forced-update suites still exist and are wired',
    fs.existsSync(path.join(ROOT, 'tests/vpnMandatoryBlock.test.cjs'))
    && fs.existsSync(path.join(ROOT, 'tests/overlayLifecycleWiring.test.cjs'))
    && fs.existsSync(path.join(ROOT, 'tests/updateDetection.test.cjs')));

  // ROLE EXEMPTION UNCHANGED: the backend-verified Super Admin bypass keeps
  // applying to this new cause exactly as it does to every other one — and it is
  // still the Super Admin check (and the gate state for it) that decides, never a
  // client-supplied value or a route param (see scripts/check-security-param-authority.js).
  check('9g: the Super Admin exemption still applies to the multi-window cause',
    /const applyWindowModeReading = useCallback\(\(mode: string, requestVerdict: boolean\) => \{\n\s+windowModeRef\.current = mode;\n\s+if \(isSuperAdmin\) return;/.test(CONTEXT));
  check('9h: the gate state is forced ALLOWED for a Super Admin session (unchanged)',
    /const gateState: SecurityGateState = isSuperAdmin\s*\n?\s*\? 'ALLOWED'/.test(CONTEXT));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
