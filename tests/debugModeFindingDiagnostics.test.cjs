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
 *   THREE metrologically different conditions produce that ONE event type:
 *     • __DEV__ JS bundle                        ('Debug mode active')
 *     • emulator-like device                     ('Emulator / debug environment detected')
 *     • test-only / debuggable install           ('test-only build flag')
 *
 *   A fourth producer — a selected mock-location app ('Mock location enabled') —
 *   was REMOVED outright after it hard-blocked an Android 16 / API 36 device with
 *   Developer options OFF. The platform cannot tell this app whether the app-op
 *   it reads is a live selection, a stale leftover or an OEM preset, so the
 *   signal could not establish the condition it claimed. See
 *   docs/MOCK_LOCATION_REMOVAL.md. The removal is pinned here too.
 *
 * WHAT THIS SUITE PINS
 *   1. Copy routing: the warning screens resolve the finding's label from the
 *      engine's own detectionMethod (resolveFindingCopyKey), so an emulator
 *      finding is no longer rendered as "Debug Mode Active" — and the removed
 *      mock-location producer cannot resurrect a copy key.
 *   2. Enforcement is UNCHANGED for the surviving producers: same event type,
 *      same weight (20), same `debug` → block_login policy, still one block
 *      decision per finding; no dismiss control was added anywhere.
 *   3. The TEMPORARY device security report that was added to diagnose this
 *      false positive has been REMOVED: no screen renders it, and its component
 *      and pure builder are deleted. (expo-clipboard / expo-device stay — they
 *      are used by unrelated features.)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const resourcesSrc = read('src/lib/i18n/resources.ts');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.error('  ❌ ' + name); }
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
  };
}

const { model: M } = buildModels();
const SECURITY = read('src/lib/security.ts');
const appScreen  = read(APP_WARNING);
const authScreen = read(AUTH_WARNING);
const signIn     = read('src/app/(auth)/sign-in.tsx');

// ════════════════════════════════════════════════════════════════════════════
// 1. The engine's copy routing (pure)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n1. resolveFindingCopyKey — the remaining producers of debug_detected');
{
  const K = M.resolveFindingCopyKey;
  // The mock-location producer was REMOVED (not re-labelled): a legacy
  // detectionMethod string must not resurrect a dedicated copy key, and there is
  // no mock-location copy entry left to route to.
  check('1a: the removed mock-location producer cannot resurrect a copy key',
    K('debug_detected', 'Mock location enabled') === 'debug_detected' &&
    K('debug_detected', 'Mock location enabled') !== 'mock_location_detected');
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
      /function threatMeta\((?:t|item): ThreatItem\)[\s\S]{0,280}resolveFindingCopyKey\((?:t|item)\.type, (?:t|item)\.detectionMethod\)/.test(src));
    check(`2b ${label}: the render path uses threatMeta(t)`,
      /const meta = threatMeta\(t\);/.test(src) &&
      !/const meta = THREAT_META\[t\.type\] \?\?/.test(src));
    check(`2c ${label}: has NO copy entry for the removed mock-location condition`,
      !/mock_location_detected/.test(src));
    // The labels are translated now: the table keeps the ICON for the condition
    // and the dictionary owns the copy, so both halves are pinned here.
    check(`2d ${label}: has a copy entry for the virtual-device condition`,
      /virtual_device_detected:\s*\{ icon: \w+ \}/.test(src) &&
      /'security\.threat\.virtual_device_detected\.label': 'Unsupported Device Detected'/.test(resourcesSrc));
    check(`2e ${label}: keeps the build-identity label for a genuine build finding`,
      /debug_detected:\s*\{ icon: \w+ \}/.test(src) &&
      /'security\.threat\.debug_detected\.label': 'Debug Mode Active'/.test(resourcesSrc));
    check(`2f ${label}: still falls back for unknown event types`,
      // The generic fallback is now a translation key; the icon still comes from
      // the table's default entry.
      /const copyKey = base \? key : 'unknown';/.test(src) &&
      /security\.threat\.\$\{copyKey\}\.label/.test(src) &&
      /\.\.\.\(base \?\? \{ icon: ShieldAlert \}\)/.test(src));
    // The detectionMethod must actually REACH the screen: sign-in posts the full
    // threat objects (type + detectionMethod), not bare types.
    check(`2g ${label}: detection method is available to the resolver`,
      /JSON\.stringify\(secResult\.threats\)/.test(signIn));
  }

  // No new escape hatch: the only dismiss control stays the single pre-existing
  // "Continue Anyway", and the blocked branch still offers support contact.
  // Labels are translated now, so count the translation key (still one per screen).
  const countContinue = (src) => (stripComments(src).match(/security\.continueAnyway/g) ?? []).length;
  check('2h: no additional dismiss control was introduced on the blocking screens',
    countContinue(authScreen) === 1 && countContinue(appScreen) === 1);
  check('2i: the emulator copy never tells the user to reinstall the app',
    !/Unsupported Device Detected[^\n]*official production release/.test(authScreen));
  for (const [label, src] of [['(app)', appScreen], ['(auth)', authScreen]]) {
    check(`2k ${label}: the compromised-device warning is translated`,
      /t\('security\.compromisedWarning'\)/.test(stripComments(src)) &&
      !/Continuing on a compromised device/.test(stripComments(src)));
    check(`2l ${label}: the security footer is translated`,
      /t\('security\.footerTitle'\)/.test(src) &&
      /t\('security\.footerMonitoring'\)/.test(src) &&
      !/All security events are logged and monitored\./.test(stripComments(src)));
  }
  check('2m (app): the informational-continue branch is translated too',
    /t\('security\.noFindingsHint'\)/.test(appScreen) &&
    /t\('security\.continue'\)/.test(appScreen) &&
    !/'Continue Anyway' : 'Continue'/.test(stripComments(appScreen)));

  check('2j: no user-facing copy still instructs the removed mock-location fix',
    !/Select mock location app/.test(authScreen) &&
    !/Select mock location app/.test(appScreen) &&
    !/Mock Location Detected/.test(authScreen) &&
    !/Mock Location Detected/.test(appScreen));
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
// 4. The temporary device security report is GONE
// ════════════════════════════════════════════════════════════════════════════
console.log('\n4. temporary device security report removed');
{
  check('4a: its component and pure builder no longer exist',
    !fs.existsSync(path.join(ROOT, REPORT_COMP)) &&
    !fs.existsSync(path.join(ROOT, REPORT_LIB)));

  // Nothing under src/ may import, render or even reference the removed report.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        const rel = path.relative(ROOT, full).replace(/\\/g, '/');
        const src = fs.readFileSync(full, 'utf8');
        if (/SecuritySignalReport|securitySignalReport|buildSecuritySignalReport|reportFindings/.test(src)) {
          offenders.push(rel);
        }
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  check('4b: no source file imports, renders or references it', offenders.length === 0);
  if (offenders.length) console.error('     offenders: ' + offenders.join(', '));

  check('4c: the three blocking screens carry no report markup or payload',
    [APP_WARNING, AUTH_WARNING, 'src/app/(app)/security-gate.tsx'].every((rel) => {
      const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      return !/SecuritySignalReport|reportFindings|device security report/i.test(code);
    }));

  // Dependencies that merely hosted the report are still used elsewhere and must
  // not be dropped with it.
  const pkg = JSON.parse(read('package.json'));
  check('4d: expo-clipboard is retained (profile / ID copy surfaces still use it)',
    typeof pkg.dependencies['expo-clipboard'] === 'string');
  check('4e: expo-device is retained (sign-in device evidence still uses it)',
    typeof pkg.dependencies['expo-device'] === 'string');
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
    /testOnlyBuild:\s*false,/.test(NATIVE) &&
    (NATIVE.match(/measured: false/g) ?? []).length >= 2);

  check('6c-2: the native contract has no mock-location field left to default',
    !/mockLocationDetected/.test(NATIVE));

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
