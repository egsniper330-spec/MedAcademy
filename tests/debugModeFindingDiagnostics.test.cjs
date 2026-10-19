#!/usr/bin/env node
/**
 * Debug-state false positive — finding copy, enforcement and diagnostics.
 *
 * Run: node tests/debugModeFindingDiagnostics.test.cjs
 *
 * REPORTED ON A PHYSICAL ANDROID DEVICE (release install, works on other
 * devices, phone NOT available for inspection):
 *
 *   Access Blocked / Device Risk Score: 20 / Detected Issues (1)
 *   → "Debug Mode Active"  ("Your device or app is running in a debug environment.")
 *
 * TRACED IN THE CODE (see docs/DEBUG_MODE_FALSE_POSITIVE_INVESTIGATION.md):
 *   sign-in → SecurityContext.check() → runSecurityChecks() → detector →
 *   threat { type: 'debug_detected' } (weight 20, bucket `debug` → block_login)
 *   → router.push('/(auth)/security-warning', { threats, riskScore, blocksLogin:'true' })
 *   → THREAT_META[type].label.
 *
 *   FOUR metrologically different conditions produce that ONE event type:
 *     • __DEV__ JS bundle                        ('Debug mode active')
 *     • emulator-like device                     ('Emulator / debug environment detected')
 *     • test-only / debuggable install           ('test-only build flag')
 *     • selected mock-location app               ('Mock location enabled')
 *
 * WHAT THIS SUITE PINS
 *   1. Copy routing: the warning screens resolve the finding's label from the
 *      engine's own detectionMethod (resolveFindingCopyKey), so a mock-location
 *      or emulator finding is no longer rendered as "Debug Mode Active".
 *   2. Enforcement is UNCHANGED: same event type, same weight (20), same
 *      `debug` → block_login policy, still one block decision per finding; no
 *      dismiss control was added anywhere.
 *   3. The diagnostic report is read-only: it cannot unblock, cannot write to
 *      the backend, cannot change a policy or the risk score, reports an
 *      UNMEASURED signal as "unknown" (never as clean), and collects only the
 *      six debug-family signals plus coarse build/API identity and a timestamp.
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

/**
 * Strip block + line comments before structural assertions. Prose must never be
 * able to satisfy — or defeat — a guard (the same rule
 * scripts/check-security-param-authority.js follows by analysing the AST).
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const APP_WARNING  = 'src/app/(app)/security-warning.tsx';
const AUTH_WARNING = 'src/app/(auth)/security-warning.tsx';
const REPORT_COMP  = 'src/components/SecuritySignalReport.tsx';
const REPORT_LIB   = 'src/lib/securitySignalReport.ts';

/** Compile the dependency-free modules standalone and require them (house pattern). */
function buildModels() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-finding-model-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src', 'lib', 'securityStateModel.ts'),
      path.join(ROOT, REPORT_LIB),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return {
    model:  require(path.join(tmp, 'securityStateModel.js')),
    report: require(path.join(tmp, 'securitySignalReport.js')),
  };
}

const { model: M, report: R } = buildModels();
const SECURITY = read('src/lib/security.ts');
const appScreen  = read(APP_WARNING);
const authScreen = read(AUTH_WARNING);
const reportComp = read(REPORT_COMP);
const signIn     = read('src/app/(auth)/sign-in.tsx');

// ════════════════════════════════════════════════════════════════════════════
// 1. The engine's copy routing (pure)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n1. resolveFindingCopyKey — the four producers of debug_detected');
{
  const K = M.resolveFindingCopyKey;
  check('1a: mock location → its own key (not a build/debug claim)',
    K('debug_detected', 'Mock location enabled') === 'mock_location_detected');
  check('1b: emulator → its own key',
    K('debug_detected', 'Emulator / debug environment detected') === 'virtual_device_detected');
  check('1c: test-only build keeps the build key',
    K('debug_detected', 'test-only build flag') === 'debug_detected');
  check('1d: __DEV__ bundle keeps the build key',
    K('debug_detected', 'Debug mode active') === 'debug_detected');
  check('1e: a missing detectionMethod never invents a device-state key',
    K('debug_detected') === 'debug_detected' && K('debug_detected', null) === 'debug_detected');
  check('1f: unrelated event types pass through untouched',
    K('developer_options_enabled', 'Developer options enabled') === 'developer_options_enabled' &&
    K('adb_enabled', 'USB debugging (ADB) enabled') === 'adb_enabled' &&
    K('debugger_attached', 'Debugger attached') === 'debugger_attached');
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Both blocking screens report the measured condition
// ════════════════════════════════════════════════════════════════════════════
console.log('\n2. security-warning screens — accurate labels');
{
  for (const [label, src] of [['(app)', appScreen], ['(auth)', authScreen]]) {
    check(`2a ${label}: renders findings through the shared resolver`,
      /function threatMeta\(t: ThreatItem\)[\s\S]{0,200}resolveFindingCopyKey\(t\.type, t\.detectionMethod\)/.test(src));
    check(`2b ${label}: the render path uses threatMeta(t)`,
      /const meta = threatMeta\(t\);/.test(src) &&
      !/const meta = THREAT_META\[t\.type\] \?\?/.test(src));
    check(`2c ${label}: has a copy entry for the mock-location condition`,
      /mock_location_detected:\s*\{ label: 'Mock Location Detected'/.test(src));
    check(`2d ${label}: has a copy entry for the virtual-device condition`,
      /virtual_device_detected:\s*\{ label: 'Unsupported Device Detected'/.test(src));
    check(`2e ${label}: keeps the build-identity label for a genuine build finding`,
      /debug_detected:\s*\{ label: 'Debug Mode Active'/.test(src));
    check(`2f ${label}: still falls back for unknown event types`,
      /Security Issue/.test(src) && /icon: ShieldAlert,/.test(src));
    // The detectionMethod must actually REACH the screen: sign-in posts the full
    // threat objects (type + detectionMethod), not bare types.
    check(`2g ${label}: detection method is available to the resolver`,
      /JSON\.stringify\(secResult\.threats\)/.test(signIn));
  }

  // No new escape hatch: the only dismiss control stays the single pre-existing
  // "Continue Anyway", and the blocked branch keeps showing support + diagnostic.
  const countContinue = (src) => (stripComments(src).match(/Continue Anyway/g) ?? []).length;
  check('2h: no additional dismiss control was introduced on the blocking screens',
    countContinue(authScreen) === 1 && countContinue(appScreen) === 1);
  check('2i: the mock/emulator copy never tells the user to reinstall the app',
    !/Unsupported Device Detected[^\n]*official production release/.test(authScreen) &&
    !/Mock Location Detected[^\n]*official production release/.test(authScreen));
  check('2j: the mock-location copy names the actionable fix',
    /Select mock location app/.test(authScreen) && /Select mock location app/.test(appScreen));
}

// ════════════════════════════════════════════════════════════════════════════
// 3. ENFORCEMENT — untouched (no bypass was introduced)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n3. enforcement unchanged');
{
  check('3a: debug_detected still weighs 20', /debug_detected:\s*20,/.test(SECURITY));
  check('3b: debug_detected still maps into the blocking `debug` bucket',
    /debug:\s*\['debug_detected', 'debugger_attached'\]/.test(SECURITY));
  check('3c: the `debug` policy bucket is still block_login',
    /debug:\s*'block_login'/.test(SECURITY));
  check('3d: the `developer_options` bucket is still block_login',
    /developer_options:\s*'block_login'/.test(SECURITY));
  check('3e: the detection is still mandatory (no disable switch reintroduced)',
    !/ALLOW_DEVELOPER_OPTIONS|DEBUG_DISABLE|SKIP_DEBUG_DETECTION/.test(SECURITY));

  // The four producers must each still block, with the same score.
  const policies = { debug: 'block_login', developer_options: 'block_login' };
  const detectionToEvent = { debug: ['debug_detected', 'debugger_attached'],
                             developer_options: ['developer_options_enabled', 'adb_enabled'] };
  const weights = { debug_detected: 20, developer_options_enabled: 25, adb_enabled: 20 };
  const flavors = [
    ['__DEV__ bundle', 'Debug mode active'],
    ['emulator-like device', 'Emulator / debug environment detected'],
    ['test-only build', 'test-only build flag'],
    ['mock-location app', 'Mock location enabled'],
  ];
  for (const [name, method] of flavors) {
    const v = M.evaluateSecurityResult({
      threats: [{ type: 'debug_detected', detectionMethod: method, detected: true }],
      policies,
      detectionToEvent,
      weights,
    });
    check(`3f: ${name} still blocks login with risk 20`,
      v.blocksLogin === true && v.riskScore === 20);
  }
  const clean = M.evaluateSecurityResult({
    threats: [], policies, detectionToEvent, weights,
  });
  check('3g: a device with no finding is still unblocked (no over-blocking)',
    clean.blocksLogin === false && clean.riskScore === 0);
}

// ════════════════════════════════════════════════════════════════════════════
// 4. The device-side diagnostic
// ════════════════════════════════════════════════════════════════════════════
console.log('\n4. SecuritySignalReport — read-only, honest, minimal');
{
  // 4a. It cannot act on the security decision. Comments are stripped first so a
  // doc sentence can neither satisfy nor defeat these assertions.
  const compCode = stripComments(reportComp);
  const libCode  = stripComments(read(REPORT_LIB));
  const forbidden = [
    'logSecurityEvent', 'logThreats', 'setResult', 'verifySecurity',
    'invalidatePolicyCache', 'backendClient', 'fetch(', 'router.', 'apiFetch',
  ];
  for (const token of forbidden) {
    check(`4a: the report never references ${token}`,
      !compCode.includes(token) && !libCode.includes(token));
  }
  check('4b: it offers no dismiss/continue/verify control',
    !/Continue|try again|Verification|Verify/i.test(compCode) &&
    !/Continue|try again/i.test(libCode));
  check('4c: it reads the measured native flags and their availability',
    /getNativeSecurityFlags\(\)/.test(reportComp) &&
    /wasLastSecurityFlagsCallUnavailable\(\)/.test(reportComp));
  check('4d: it copies the report through the clipboard',
    /Clipboard\.setStringAsync\(reportText\)/.test(reportComp));
  check('4e: it states that it cannot unlock the app',
    /cannot unlock the app/.test(reportComp));
  check('4f: both blocking screens render it on their blocked paths',
    (authScreen.match(/<SecuritySignalReport findings=\{reportFindings\} \/>/g) ?? []).length >= 2 &&
    (appScreen.match(/<SecuritySignalReport findings=\{reportFindings\} \/>/g) ?? []).length >= 2);

  // 4g. Signal scope: ONLY the debug-family signals (nothing else is harvested).
  check('4g: exactly the six debug-state signals are collected',
    R.REPORT_SIGNALS.length === 6 &&
    R.REPORT_SIGNALS.map((s) => s.key).join(',') ===
      'developerOptionsEnabled,adbEnabled,debuggerAttached,testOnlyBuild,emulatorDetected,mockLocationDetected');
  check('4h: no credential/identifier field is collected',
    !/token|password|email|imei|serial|android_id|userId|user_id/i.test(libCode));

  // ── Release-UI accessibility (the question this suite previously assumed) ──
  const GATE = read('src/app/(app)/security-gate.tsx');
  const gateCode = stripComments(GATE);
  const authCode = stripComments(authScreen);
  check('4i: the PRE-LOGIN block branch renders the card (no session needed)',
    /blocksLogin \? \(/.test(authCode) &&
    /Login is blocked by your organization/.test(authCode) &&
    /<SecuritySignalReport findings=\{reportFindings\} \/>/.test(authCode));
  check('4j: the in-app AUTHORITATIVE gate renders it too (policy blocks never route to /security-warning)',
    /import \{ SecuritySignalReport \} from '@\/components\/SecuritySignalReport'/.test(GATE) &&
    /<SecuritySignalReport findings=\{reportFindings\} \/>/.test(gateCode) &&
    // Window-state causes render no findings list and no report: irrelevant copy
    // on a split-screen / overlay page.
    /!overlayBlocked && !windowModeBlockedState && \(/.test(gateCode));
  check('4k: the card is NOT gated on Super Admin, a session, __DEV__ or a route param',
    !/isSuperAdmin|useSecurity|session|__DEV__|params\./.test(reportComp) &&
    !/process\.env\.EXPO_PUBLIC|DEV_ROUTE/.test(reportComp));
  check('4l: it re-reads on foreground (a user changing a setting comes back to the same screen)',
    /AppState\.addEventListener\('change', \(state\) => \{\n\s+if \(state === 'active'\) void load\(\);/.test(reportComp));
  check('4m: a FAILED copy is surfaced, not silently swallowed',
    /setCopyFailed\(true\)/.test(reportComp) && /copyFailed &&/.test(reportComp));
  check('4n: the route file is auto-registered by the (auth) Stack (no hidden route)',
    /<Stack screenOptions=\{\{ headerShown: false \}\} \/>/.test(read('src/app/(auth)/_layout.tsx')) &&
    /<Stack.Screen name="\(auth\)" \/>/.test(read('src/app/_layout.tsx')));
  check('4o: the card writes nothing and offers no action beyond re-read/copy',
    (reportComp.match(/onPress=/g) ?? []).length === 2 &&
    !/router|apiFetch|backendClient|logThreats|logSecurityEvent/.test(compCode));
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Report CONTENT (the pure builder, actually executed)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n5. report content');
{
  const mockLocationOn = {
    platform: 'android',
    apiLevel: 33,
    deviceManufacturer: 'samsung',
    deviceModel: 'SM-T505N',
    osVersion: '13',
    osBuildFingerprint: 'samsung/gta4lwifi/gta4lwifi:13/TP1A/123:user/release-keys',
    appVersion: '1.0.844',
    appBuildNumber: 844,
    nativeModuleAvailable: true,
    signals: {
      developerOptionsEnabled: false,
      adbEnabled: false,
      debuggerAttached: false,
      testOnlyBuild: false,
      emulatorDetected: false,
      mockLocationDetected: true,
    },
    findings: [{
      label: 'Mock Location Detected',
      type: 'debug_detected',
      detectionMethod: 'Mock location enabled',
    }],
    generatedAt: Date.UTC(2026, 9, 19, 10, 30, 0),
  };
  const text = R.buildSecuritySignalReport(mockLocationOn);

  check('5a: the report identifies the device conditions that can cause the block',
    /Mock-location app selected: on/.test(text) &&
    /Developer options: off/.test(text) &&
    /Emulator \/ virtual device: off/.test(text));
  check('5b: it carries the finding, its event type and the detector description',
    /Mock Location Detected \[debug_detected\]/.test(text) &&
    /detector: Mock location enabled/.test(text));
  check('5c: it carries build/API identity and a timestamp',
    /API 33/.test(text) && /samsung SM-T505N/.test(text) &&
    /1\.0\.844 \(build 844\)/.test(text) &&
    /Generated: 2026-10-19T10:30:00\.000Z/.test(text));
  check('5d: it states that it cannot unblock the app',
    /read-only: it does not change the risk score and cannot unblock the app/.test(text));
  check('5e: the same snapshot builds the same report (no hidden clock)',
    R.buildSecuritySignalReport(mockLocationOn) === text);

  // A payload with an unmeasured signal must NOT read as clean.
  const unmeasured = {
    ...mockLocationOn,
    nativeModuleAvailable: false,
    signals: { mockLocationDetected: undefined },
    findings: [{ label: 'Debug Mode Active', type: 'debug_detected', detectionMethod: 'Debug mode active' }],
  };
  const unmeasuredText = R.buildSecuritySignalReport(unmeasured);
  check('5f: an unreachable native module is reported as UNAVAILABLE, not clean',
    /UNAVAILABLE/.test(unmeasuredText) &&
    /could NOT be measured/.test(unmeasuredText) &&
    !/Native security module: measured/.test(unmeasuredText));
  // Two DIFFERENT unmeasured states, both never "off":
  //   • module unreachable → every row is "unavailable" (the values are the
  //     fail-safe defaults, so printing them as "off" would be a false clean
  //     claim on the screen a blocked user depends on);
  //   • module measured but this key absent → "unknown".
  check('5g: an unreachable module reports every signal as UNAVAILABLE, never "off"',
    /Mock-location app selected: unavailable/.test(unmeasuredText) &&
    !/: off/.test(unmeasuredText));
  const measuredMissing = {
    ...mockLocationOn,
    signals: { ...mockLocationOn.signals, mockLocationDetected: undefined },
  };
  check('5g-2: a missing key on a MEASURED device reads "unknown"',
    /Mock-location app selected: unknown/.test(R.buildSecuritySignalReport(measuredMissing)));
  check('5g-3: the label helper distinguishes all four states',
    R.signalValueLabel(true, true) === 'on' &&
    R.signalValueLabel(false, true) === 'off' &&
    R.signalValueLabel(undefined, true) === 'unknown' &&
    R.signalValueLabel(false, false) === 'unavailable');

  check('5h: signalValueLabel never conflates unknown with off',
    R.signalValueLabel(true) === 'on' &&
    R.signalValueLabel(false) === 'off' &&
    R.signalValueLabel(undefined) === 'unknown' &&
    R.signalValueLabel(null) === 'unknown');

  check('5i: a device with no findings does not fabricate one',
    /\(none reported in this evaluation\)/.test(
      R.buildSecuritySignalReport({ ...mockLocationOn, findings: [] })));
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Detector separation, native mapping and freshness (the remaining
//    false-positive questions that can be answered from the code alone)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n6. detector separation / mapping / freshness');
{
  const debugFn = SECURITY.slice(
    SECURITY.indexOf('async function detectDebug'),
    SECURITY.indexOf('async function detectDeveloperOptions'),
  );
  const devOptsFn = SECURITY.slice(
    SECURITY.indexOf('async function detectDeveloperOptions'),
    SECURITY.indexOf('async function detectScreenRecording'),
  );
  const NATIVE = read('src/lib/nativeSecurity.ts');

  check('6a: detectDebug can only fire on __DEV__ or a native emulator signal',
    (debugFn.match(/type: 'debug_detected'/g) ?? []).length === 2 &&
    /if \(__DEV__\)/.test(debugFn) && /flags\.emulatorDetected/.test(debugFn) &&
    !/developerOptionsEnabled|adbEnabled|testOnlyBuild|mockLocationDetected/.test(debugFn));

  check('6b: detectDeveloperOptions keeps the four surfaces independent and ordered',
    devOptsFn.indexOf('flags.debuggerAttached') < devOptsFn.indexOf('flags.adbEnabled') &&
    devOptsFn.indexOf('flags.adbEnabled') < devOptsFn.indexOf('flags.developerOptionsEnabled') &&
    devOptsFn.indexOf('flags.developerOptionsEnabled') < devOptsFn.indexOf('flags.testOnlyBuild') &&
    /'debugger_attached'/.test(devOptsFn) && /'adb_enabled'/.test(devOptsFn) &&
    /'developer_options_enabled'/.test(devOptsFn) &&
    (devOptsFn.match(/type: 'debug_detected'/g) ?? []).length === 1);

  check('6c: a missing/failed native batch yields fail-safe FALSE flags, so it cannot invent a debug finding',
    /emulatorDetected:\s*false,/.test(NATIVE) &&
    /mockLocationDetected:\s*false,/.test(NATIVE) &&
    /testOnlyBuild:\s*false,/.test(NATIVE) &&
    (NATIVE.match(/measured: false/g) ?? []).length >= 2);

  check('6d: a failed measurement is never cached (the next check re-measures)',
    /_lastFlagsCallUnavailable = !measured/.test(NATIVE) &&
    /_flagsCacheAt = measured \? Date.now\(\) : 0/.test(NATIVE));

  check('6e: sign-in evaluates the device BEFORE any session exists (fresh, not cached)',
    signIn.indexOf('const secResult = await check(installationId)') > 0 &&
    signIn.indexOf('await check(installationId)') < signIn.indexOf('signInWithPassword') &&
    /await runGuardedCheck\(\)/.test(read('src/lib/SecurityContext.tsx')) &&
    // The __DEV__ producer keeps the exact detectionMethod the resolver matches
    // (any change to this string must be reflected in resolveFindingCopyKey).
    /type: 'debug_detected', detectionMethod: 'Debug mode active'/.test(SECURITY));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
