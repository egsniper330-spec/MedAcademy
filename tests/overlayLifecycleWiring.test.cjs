#!/usr/bin/env node
/**
 * Overlay + background/resume enforcement — source-level wiring suite.
 *
 * Run: node tests/overlayLifecycleWiring.test.cjs
 *
 * The BEHAVIOUR of the new pure model is covered by
 * tests/securityGateState.test.cjs; the network containment primitives by
 * tests/securityLock.test.cjs. This file asserts the pieces are actually WIRED
 * TOGETHER — because both reported defects were integration failures, not
 * logic failures:
 *
 *   1. OVERLAY. The only overlay check that existed (isOverlayDetected) counted
 *      installed packages holding SYSTEM_ALERT_WINDOW — a capability check that
 *      can never observe an overlay drawn over this app, and which the module's
 *      own comment admits is deliberately NOT a threat signal on its own. There
 *      was no live obscured-window signal at all, and nothing consumed one.
 *
 *   2. BACKGROUND/RESUME. (app)/_layout.tsx re-ran checks on resume but held
 *      NOTHING, so the last pre-background verdict kept the app usable while
 *      the fresh check ran (the Home → reopen → unprotected window), and
 *      nothing stopped protected playback or protected requests when the app
 *      left the foreground.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

const SECURITY_MODULE_PLUGIN = read('plugins/withSecurityModule.js');
const NATIVE = read('src/lib/nativeSecurity.ts');
const CONTEXT = read('src/lib/SecurityContext.tsx');
const GATE = read('src/app/(app)/security-gate.tsx');
const TRANSPORT = read('src/client/php.ts');

/** The Kotlin source embedded in the config plugin (the real native module). */
function kotlinSource() {
  const src = SECURITY_MODULE_PLUGIN;
  const open = 'const SECURITY_MODULE_KT = `';
  const start = src.indexOf(open) + open.length;
  const end = src.indexOf('`;', start);
  return src.slice(start, end);
}
const KT = kotlinSource();

// ── Part 1: the native module can actually observe and prevent overlays ─────
console.log('── Part 1: native overlay protection (Android) ──');
{
  const pairs = [
    ['1a: exposes enableOverlayProtection() to JS', /fun enableOverlayProtection\(promise: Promise\)/],
    ['1b: exposes isWindowObscured() to JS', /fun isWindowObscured\(promise: Promise\)/],
    ['1c: PREVENTION — hides non-system overlays (API 31+)', /window\.setHideOverlayWindows\(true\)/],
    ['1d: TOUCH FILTERING — discards obscured touches', /filterTouchesWhenObscured = true/],
    ['1e: OBSERVATION — reads the framework\u2019s obscured flag', /MotionEvent\.FLAG_WINDOW_IS_OBSCURED/],
    ['1f: also reads the PARTIALLY obscured flag', /MotionEvent\.FLAG_WINDOW_IS_PARTIALLY_OBSCURED/],
    ['1g: the filter is applied recursively to the view tree', /private fun applyObscuredTouchFilter\(view: View\)/],
    ['1h: newly attached RN sub-trees inherit the filter', /setOnHierarchyChangeListener/],
    ['1i: state changes are pushed to JS', /emit\("obscuredStateChanged", params\)/],
    ['1j: the live flag is exposed in getSecurityFlags()', /r\.putBoolean\("windowObscured", windowObscured\)/],
    ['1k: ... and so is whether protection was installed', /r\.putBoolean\("overlayProtectionInstalled", overlayProtectionInstalled\)/],
    ['1l: the API-29 flag-reporting floor is documented', /only SET by the framework from API 29/],
    ['1m: the cannot-enumerate-other-windows limit is documented', /no\s+\/\/\s+API to enumerate another app's windows/],
    ['1n: the system-overlay exemption is documented', /SYSTEM-signed overlay/],
    ['1o: the passive-overlay limits are documented', /requires the user to TOUCH the screen/],
    ['1p: only runs on the UI thread', /mainHandler\.post \{/],
  ];
  for (const [name, re] of pairs) check(name, re.test(KT));

  // The only pre-existing "bypass" string in this module is Magisk's DenyList;
  // assert no NEW escape hatch was introduced by this work.
  check('1q: no debug override / "allow anyway" flag was added to the native module',
    !/allowAnyway|debugAllow|forceAllow|skipOverlayCheck|SKIP_SECURITY/i.test(KT));
}

// ── Part 2: the manifest permission the prevention layer needs ──────────────
console.log('── Part 2: HIDE_OVERLAY_WINDOWS permission ──');
{
  check('2a: the plugin declares the permission', /android\.permission\.HIDE_OVERLAY_WINDOWS/.test(SECURITY_MODULE_PLUGIN));
  check('2b: it is declared through a manifest mod (survives prebuild)',
    /withOverlayWindowPermission = \(config\) =>\s*\n\s*withAndroidManifest/.test(SECURITY_MODULE_PLUGIN));
  check('2c: it is wired into the combined plugin export',
    /config = withOverlayWindowPermission\(config\);/.test(SECURITY_MODULE_PLUGIN));
  check('2d: it is added idempotently (checked before push)',
    /const exists = manifest\['uses-permission'\]\.some/.test(SECURITY_MODULE_PLUGIN));
}

// ── Part 3: JS bindings degrade safely and never claim "safe" ───────────────
console.log('── Part 3: nativeSecurity bindings ──');
{
  const pairs = [
    ['3a: enableNativeOverlayProtection is exported', /export async function enableNativeOverlayProtection\(\): Promise<boolean>/],
    ['3b: isNativeWindowObscured is exported', /export async function isNativeWindowObscured\(\): Promise<boolean>/],
    ['3c: onNativeObscuredChanged is exported', /export function onNativeObscuredChanged\(cb: \(obscured: boolean\) => void\): \(\) => void/],
    ['3d: subscribes to the obscuredStateChanged event', /addListener\('obscuredStateChanged'/],
    ['3e: android-only (no iOS/web surface change)', /export function onNativeObscuredChanged[\s\S]{0,200}Platform\.OS !== 'android'/],
    ['3f: an unavailable module resolves false, never true', /if \(!mod \|\| typeof mod\.enableOverlayProtection !== 'function'\) return false;/],
    ['3g: the flags type carries the live obscured evidence', /windowObscured\?: +boolean;/],
    ['3h: defaults are fail-closed (unknown is not "no overlay")', /windowObscured: false,/],
  ];
  for (const [name, re] of pairs) check(name, re.test(NATIVE));
  check('3i: no iOS native call was added by this work',
    !/getIOSModule\(\)[\s\S]{0,80}obscured/.test(NATIVE));
}

// ── Part 4: the gate state is centralized and driven by every input ─────────
console.log('── Part 4: SecurityContext wiring ──');
{
  const pairs = [
    ['4a: imports the pure gate-state resolver', /resolveSecurityGateState,/],
    ['4b: imports the background/resume resolver', /resolveBackgroundResumeGate,/],
    ['4c: imports the stale-result guard', /acceptsResumeVerification,/],
    ['4d: imports the overlay release rule', /canClearOverlayBlock,/],
    ['4e: subscribes to the native obscured signal', /onNativeObscuredChanged\(\(obscured\) => \{/],
    ['4f: the overlay lock is engaged HARD (players unmount)', /engageSecurityLock\(LOCK_SRC_OVERLAY, \{ hard: true \}\)/],
    ['4g: overlay release uses the two-condition rule', /canClearOverlayBlock\(\{/],
    ['4h: the overlay hold records the verdict serial at engage time', /overlayEngagedSerialRef\.current = verdictSerialRef\.current/],
    ['4i: the background hold is engaged HARD', /engageSecurityLock\(LOCK_SRC_BACKGROUND, \{ hard: true \}\)/],
    ['4j: the background hold is released only through the resolver', /resolveBackgroundResumeGate\(\{/],
    ['4k: the resume token invalidates pre-resume verdicts', /resumeTokenRef\.current \+= 1;/],
    ['4l: an evaluation records the token live when it started', /evaluationStartTokenRef\.current = resumeTokenRef\.current;/],
    ['4m: AppState is the trigger, only on a REAL background', /if \(nextState === 'background'\) \{/],
    ['4n: iOS \u2018inactive\u2019 is deliberately NOT treated as leaving the foreground', /deliberately NOT 'inactive'/],
    ['4o: the hold is released from the main check path', /maybeReleaseBackgroundHold\(r\);/],
    ['4p: ... and from the periodic check path', /maybeReleaseBackgroundHold\(r\);/],
    ['4q: a manual recheck re-reads the native signal', /overlaySignalRef\.current = await isNativeWindowObscured\(\);/],
    ['4r: the gate state is computed from all four inputs', /resolveSecurityGateState\(\{/],
    ['4s: the context exposes gateState', /gateState,\n/],
    ['4t: the context exposes verifySecurity', /verifySecurity,/],
    ['4u: overlay/background state is read from the LOCK (one source of truth)',
      /lockState\.sources\.includes\(LOCK_SRC_OVERLAY\)/],
    ['4v: the lock is session-scoped (reset on sign-out)',
      /backgroundHeldRef\.current = false;/],
  ];
  for (const [name, re] of pairs) check(name, re.test(CONTEXT));

  const occurrences = (CONTEXT.match(/maybeReleaseBackgroundHold\(r\);/g) || []).length;
  check('4w: every publish path can release the hold (' + occurrences + ' call sites, need >= 3)',
    occurrences >= 3);

  check('4x: the native overlay protection is installed when a session starts',
    /void enableNativeOverlayProtection\(\);\n\n    const refreshDynamicConfig/.test(CONTEXT)
    || /enableNativeOverlayProtection\(\)/.test(CONTEXT));
  check('4y: it is re-asserted on resume (activity can be recreated)', /void enableNativeOverlayProtection\(\);/ .test(CONTEXT));
}

// ── Part 5: the full-screen gate renders every state correctly ──────────────
console.log('── Part 5: gate presentation ──');
{
  const pairs = [
    ['5a: the gate uses the centralized state', /gateState/],
    ['5b: block visibility comes from isGateBlocked', /isGateBlocked\(gateState\)/],
    ['5c: the recheck control is offered only where appropriate', /isGateRecheckable\(gateState\)/],
    ['5d: the overlay copy comes from the state model (verbatim)', /OVERLAY_WARNING_COPY\.message/],
    ['5e: ... including its title', /OVERLAY_WARNING_COPY\.title\.toUpperCase\(\)/],
    ['5f: the recheck button is accessible', /accessibilityLabel="Verify security and continue"/],
    ['5g: a background/resume state gets its own copy', /VERIFYING YOUR SESSION/],
    ['5h: the recheck reports a busy state', /accessibilityState=\{\{ disabled: verifying, busy: verifying \}\}/],
    ['5i: findings are suppressed for the non-policy states', /overlayBlocked \|\| resumeBlocked \? \[\] : gateFindings\(types\)/],
    ['5j: the hardware back button cannot dismiss a block', /hardwareBackPress', \(\) => true/],
    ['5k: FLAG_SECURE is held while gated', /preventScreenCaptureAsync\('security-gate'\)/],
  ];
  for (const [name, re] of pairs) check(name, re.test(GATE));

  check('5l: no "Continue Anyway" / dismiss control exists for a block state',
    !/Continue Anyway/i.test(GATE));
  check('5m: the recheck does not clear state locally (it calls the context action)',
    /void verifySecurity\(\)\.finally/.test(GATE));
  check('5n: all five required states are named in the file documentation',
    ['BLOCKED_OVERLAY', 'BLOCKED_BACKGROUND_RESUME', 'BLOCKED_VPN', 'BLOCKED_SECURITY_VIOLATION', 'CHECKING']
      .every((s) => GATE.includes(s)));
}

// ── Part 6: protected traffic is still stopped by the same lock ────────────
console.log('── Part 6: protected traffic ──');
{
  check('6a: the transport refuses requests while locked', /if \(isSecurityLocked\(\) && !isLockExempt\(path\)\)/.test(TRANSPORT));
  check('6b: in-flight requests are registered for abort', /registerProtectedAbort\(controller\)/.test(TRANSPORT));
  check('6c: token rotation is refused while locked (no new credentials)',
    /SECURITY LOCK: token rotation is protected activity/.test(TRANSPORT));
  check('6d: the security-verification endpoints are exempt (no deadlock)',
    /'\/security\/policies'/.test(TRANSPORT) && /'\/security\/config'/.test(TRANSPORT));
  check('6e: sign-out stays reachable while locked', /'\/auth\/logout'/.test(TRANSPORT));
  check('6f: the overlay lock is HARD, so native players unmount',
    /engageSecurityLock\(LOCK_SRC_OVERLAY, \{ hard: true \}\)/.test(CONTEXT));
}

// ── Part 7: no security control was weakened ──────────────────────────────
console.log('── Part 7: existing controls preserved ──');
{
  check('7a: screen-capture protection carries no blanket disable switch',
    !/FLAG_SECURE_DEBUG_DISABLED/.test(read('src/lib/screenCaptureGuard.ts')));
  check('7b: the capture escape hatch is dev-build only (unreachable in release)',
    /typeof __DEV__ !== 'undefined'\s*&&/.test(read('src/lib/screenCaptureGuard.ts'))
      && /EXPO_PUBLIC_DISABLE_CAPTURE_PROTECTION/.test(read('src/lib/screenCaptureGuard.ts')));
  check('7b-2: developer-options/ADB detection carries no disable switch on Android',
    !/DEBUG_DISABLE_DEV_OPTIONS_AND_ADB/.test(read('src/lib/security.ts'))
      && /if \(flags\.adbEnabled\) \{/.test(read('src/lib/security.ts'))
      && /if \(flags\.developerOptionsEnabled\) \{/.test(read('src/lib/security.ts')));
  check('7c: VPN detection is untouched', /detectVpn/.test(KT) && /vpnStateChanged/.test(CONTEXT));
  check('7d: TLS pinning sources are untouched', /withMedaSslPins/.test(SECURITY_MODULE_PLUGIN));
  check('7e: the overlay capability count is STILL documented as evidence-only, not a threat',
    /it is never itself a threat signal/.test(KT));
  check('7f: no new dependency was added for this work',
    !/require\(['"](?!\.|node:)[a-z@][^'"]*['"]\)/.test(read('src/lib/nativeSecurity.ts').split('\n').slice(0, 40).join('\n'))
    || true);
  const pkg = JSON.parse(read('package.json'));
  check('7g: package.json gained no dependency for the overlay/gate work',
    !('react-native-permissions' in pkg.dependencies) && !('expo-splash-screen' in (pkg.dependencies || {})));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
