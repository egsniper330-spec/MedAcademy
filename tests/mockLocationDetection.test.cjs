#!/usr/bin/env node
/**
 * Mock-location detection — false-positive contract.
 *
 * OBSERVED ON THE PHYSICAL TABLET (SM-T505N, Android 12, stock Samsung):
 *   Every launch was hard-locked by the SecurityGate with risk score 20 and the
 *   copy "Insecure Build Detected / Install the official production release of
 *   the app." — on a legitimate, non-debuggable, non-test-only release APK.
 *
 * ROOT CAUSE:
 *   SecurityModule.detectMockLocation() had a third plane that treated the mere
 *   PRESENCE of android.permission.ACCESS_MOCK_LOCATION on ANY installed package
 *   as active mock GPS. ACCESS_MOCK_LOCATION is a signature|development
 *   permission granted at install time, and stock Google/Samsung images ship apps
 *   that hold it — on the tablet, `com.google.android.apps.restore`. The platform
 *   itself resolves the op to DENY for that package
 *     (appops get com.google.android.apps.restore android:mock_location
 *      → "No operations. Default mode: deny"),
 *   so the holder scan could only ever produce a false positive.
 *
 *   The JS layer then reported it as type 'debug_detected' (risk 20), which maps
 *   into the `debug` → block_login policy bucket, locking the whole app.
 *
 * SECOND, INDEPENDENT DEVICE-SPECIFIC FALSE POSITIVE (also pinned here):
 *   `Settings.Secure.ALLOW_MOCK_LOCATION` was read with NO API guard even though
 *   the platform stopped honoring it in API 23 (Marshmallow). A leftover value of
 *   1 — written by a pre-Marshmallow app, a GPS spoofing tool or an MDM suite and
 *   never cleaned up — was therefore treated as active mocking on a MODERN
 *   device, producing exactly the same block on the same APK that ran fine on a
 *   device without the stale setting. The legacy tier is now guarded to the API
 *   levels where the platform actually reads the setting; the AppOps plane stays
 *   authoritative everywhere else.
 *
 * WHAT THIS SUITE PINS
 *   A. plugins/withSecurityModule.js (source of truth for the generated Kotlin)
 *      - the authoritative AppOps plane is INTACT (a real mock provider blocks)
 *      - the legacy pre-API-23 plane is intact AND API-guarded
 *      - the permission-holder plane is GONE (regression guard)
 *   B. android/.../SecurityModule.kt — the generated file matches (catches a
 *      stale generated file, i.e. someone editing android/ without the plugin)
 *   C. src/lib/security.ts — a genuine mock-location flag still produces a threat
 *      (removing the false positive must not remove the protection)
 *
 * Usage: node tests/mockLocationDetection.test.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}

/** Extract a Kotlin function body by name (brace matching from the signature). */
function kotlinFn(source, name) {
  const sig = source.indexOf('fun ' + name + '(');
  if (sig < 0) return null;
  const open = source.indexOf('{', sig);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(sig, i + 1);
    }
  }
  return null;
}

const PLUGIN = 'plugins/withSecurityModule.js';
const GENERATED = 'android/app/src/main/java/com/medacademy/security/SecurityModule.kt';

/** Shared assertions for a Kotlin source that contains detectMockLocation. */
function assertPlanes(label, source) {
  const fn = kotlinFn(source, 'detectMockLocation');
  ok(fn !== null, `${label}: detectMockLocation() is present`);
  if (!fn) return;

  // ── Surviving planes ──────────────────────────────────────────────────────
  ok(/OPSTR_MOCK_LOCATION/.test(fn),
    `${label}: authoritative AppOps plane (OPSTR_MOCK_LOCATION) is intact`);
  ok(/MODE_ALLOWED/.test(fn),
    `${label}: AppOps plane still requires MODE_ALLOWED (a selected mock provider)`);
  ok(/AppOpsManager/.test(fn),
    `${label}: AppOpsManager is still consulted`);
  ok(/Settings\.Secure\.ALLOW_MOCK_LOCATION/.test(fn),
    `${label}: legacy pre-API-23 plane is intact`);

  // ── The removed false-positive plane ──────────────────────────────────────
  ok(!/getPackagesHoldingPermissions/.test(fn),
    `${label}: permission-HOLDER scan is gone (the production lockout cause)`);
  ok(!/ACCESS_MOCK_LOCATION/.test(fn),
    `${label}: no bare ACCESS_MOCK_LOCATION presence test remains`);

  // ── Plane count: exactly two positive returns ─────────────────────────────
  const returns = fn.match(/return true/g) || [];
  ok(returns.length === 2,
    `${label}: exactly two positive planes remain (found ${returns.length}) — AppOps + legacy flag`);

  // ── Legacy tier must be API-GUARDED (second device-specific false positive) ─
  // The platform stopped honoring Settings.Secure.ALLOW_MOCK_LOCATION in API 23;
  // reading a leftover value of 1 as evidence hard-locked legitimate release
  // installs (risk 20, "Insecure Build Detected") on devices that merely carried
  // the stale setting. Only the AppOps plane is authoritative on API 23+.
  ok(/Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.M/.test(fn),
    `${label}: legacy ALLOW_MOCK_LOCATION tier is guarded to API < 23`);
  ok(!/if \(legacyFlag != 0\) return true/.test(fn),
    `${label}: the unguarded legacy return is gone (APK-level regression guard)`);
  ok(/legacyFlag != 0 && Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.M/.test(fn),
    `${label}: legacy flag only counts where the platform still honors it`);
}

// ════════════════════════════════════════════════════════════════════════════
// A. Plugin template (source of truth)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nA. plugins/withSecurityModule.js (source of truth)');
const plugin = read(PLUGIN);
assertPlanes('plugin', plugin);
ok(/FALSE-POSITIVE FIX/.test(plugin),
  'plugin: doc comment records WHY the holder plane was removed (false positive)');
ok(/com\.google\.android\.apps\.restore/.test(plugin),
  'plugin: doc comment names the real-world package that triggered the lockout');
ok(/Default mode: deny/.test(plugin),
  'plugin: doc comment records the platform evidence (op resolves to deny for a holder)');

// ── Module still exposes the flag consumed by JS ───────────────────────────
ok(/putBoolean\("mockLocationDetected"/.test(plugin),
  'plugin: getSecurityFlags still publishes mockLocationDetected');
ok(/fun isMockLocationEnabled\(/.test(plugin),
  'plugin: the isMockLocationEnabled React method is still exposed');

// ════════════════════════════════════════════════════════════════════════════
// B. Generated Kotlin (must match the plugin — catches a stale android/)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nB. generated SecurityModule.kt');
if (!exists(GENERATED)) {
  ok(false, 'generated SecurityModule.kt not found (run: npx expo prebuild -p android)');
} else {
  assertPlanes('generated', read(GENERATED));
}

// ════════════════════════════════════════════════════════════════════════════
// C. JS layer — protection preserved
// ════════════════════════════════════════════════════════════════════════════
console.log('\nC. src/lib/security.ts + nativeSecurity.ts');
const security = read('src/lib/security.ts');
const jsFn = security.slice(security.indexOf('async function detectMockLocation'));
const jsBody = jsFn.slice(0, jsFn.indexOf('\n}\n') + 3);
ok(/flags\.mockLocationDetected/.test(jsBody),
  'js: detectMockLocation still reads the native mockLocationDetected flag');
ok(/detected: true/.test(jsBody) && /type: 'debug_detected'/.test(jsBody),
  'js: a genuine mock-location flag still reports a blocking threat (protection intact)');
ok(/process\.env\.EXPO_OS !== 'android'/.test(jsBody),
  'js: detector is Android-gated (iOS has no mock-location op)');

const native = read('src/lib/nativeSecurity.ts');
ok(/mockLocationDetected:/.test(native),
  'js: NativeSecurityFlags still declares mockLocationDetected');

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
