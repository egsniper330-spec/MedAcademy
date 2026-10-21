#!/usr/bin/env node
/**
 * Mock-location detection — REMOVAL contract.
 *
 * WHY THE DETECTOR WAS REMOVED (not "fixed" again)
 * ------------------------------------------------
 * Reported on an Android 16 / API 36 device (Developer options OFF, ADB OFF, no
 * debugger, non-test build, not emulated):
 *
 *   Device Risk Score: 20
 *   Finding: "Mock Location Detected"
 *   Report row: "Mock-location app selected: ON"
 *   → login blocked
 *
 * Two earlier fixes had already removed two false-positive planes (an
 * ACCESS_MOCK_LOCATION permission-HOLDER scan, then an unguarded
 * Settings.Secure.ALLOW_MOCK_LOCATION read). The remaining plane still could not
 * establish the condition:
 *
 *   • The only authoritative query is the CROSS-UID app-op read
 *       AppOpsManager.checkOpNoThrow(OPSTR_MOCK_LOCATION, otherUid, otherPkg)
 *     which requires android.permission.UPDATE_APP_OPS_STATS
 *     (protectionLevel signature|privileged|installer|role). A normal release APK
 *     cannot hold it: on stock AOSP the service throws, and the previous
 *     `getOrDefault(false)` reported that coverage gap as "no mock app".
 *   • On ROMs that DO answer, the value is the per-package android:mock_location
 *     app-op MODE, which is PERSISTED STATE. It survives the Developer-options
 *     toggle, can be preset by the OEM for a preinstalled package, and is not
 *     cleared when the user stops mocking. MODE_ALLOWED therefore proves none of
 *     the three facts the signal was read as: Developer options ON, a mock
 *     provider currently selected by the user, or locations being delivered now.
 *   • MedAcademy has no location-based feature, so a mock provider cannot defeat
 *     any protection this app actually enforces. The check only ever added risk
 *     20 and blocked login for something it could not establish.
 *
 * WHAT THIS SUITE PINS
 *   A. The detector is GONE from the native template (source of truth) and from
 *      the generated Kotlin: no function, no ReactMethod, no flag, no cross-UID
 *      app-op read, no deprecated ALLOW_MOCK_LOCATION read.
 *   B. The native→JS contract dropped the field — there is no `mockLocationDetected`
 *      in the interface or in the fail-safe defaults, so nothing can report it as
 *      ON, OFF or a fake "unavailable".
 *   C. The engine, the copy tables and the device-key evidence bundle have no
 *      mock-location path left. The temporary device security report built for
 *      this investigation has since been removed entirely.
 *   D. The backend no longer treats `mock_location` evidence as blocking, so a
 *      persisted finding from an older APK cannot keep denying login.
 *   E. Surviving device signals keep their exact behaviour: Developer options, ADB,
 *      debugger, test-only build, emulator, VPN, root, integrity, and the
 *      `debug_detected` risk weight (20) / `debug` → block_login bucket.
 *   F. Measurement semantics are untouched: an unavailable native batch is still
 *      distinguishable from a measured `false`, and a failed measurement is still
 *      not cached.
 *
 * Usage: node tests/mockLocationDetection.test.cjs
 */
'use strict';

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
  else { failed++; failures.push(msg); console.log('  \u2717 ' + msg); }
}

const PLUGIN = 'plugins/withSecurityModule.js';
const GENERATED = 'android/app/src/main/java/com/medacademy/security/SecurityModule.kt';
const SECURITY = read('src/lib/security.ts');
const NATIVE = read('src/lib/nativeSecurity.ts');

// ════════════════════════════════════════════════════════════════════════════
// A. Native detector removed (plugin template + generated Kotlin)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nA. native detector removed');

function assertRemoved(label, src) {
  ok(!/fun\s+detectMockLocation\s*\(/.test(src),
    `${label}: detectMockLocation() is gone`);
  ok(!/fun\s+isMockLocationEnabled\s*\(/.test(src),
    `${label}: the isMockLocationEnabled React method is gone`);
  ok(!/putBoolean\(\s*"mockLocationDetected"/.test(src),
    `${label}: getSecurityFlags publishes no mock-location field`);
  ok(!/OPSTR_MOCK_LOCATION/.test(src.replace(/\/\/[^\n]*/g, '')),
    `${label}: no cross-UID MOCK_LOCATION app-op read remains (code, not comment)`);
  ok(!/ALLOW_MOCK_LOCATION/.test(src.replace(/\/\/[^\n]*/g, '')),
    `${label}: the deprecated Settings.Secure.ALLOW_MOCK_LOCATION is not read at all`);
  ok(!/AppOpsManager/.test(src.replace(/\/\/[^\n]*/g, '')),
    `${label}: AppOpsManager is no longer imported/used`);
  ok(!/ACCESS_MOCK_LOCATION/.test(src) && !/getPackagesHoldingPermissions/.test(src),
    `${label}: no permission-holder heuristic remains`);
  // The removal must be DOCUMENTED where the code lives, so a future reader does
  // not "restore" the detector without re-encountering the evidence.
  ok(/UPDATE_APP_OPS_STATS/.test(src) && /MOCK-LOCATION DETECTION/.test(src),
    `${label}: the removal note records why the platform cannot answer this`);
}

const plugin = read(PLUGIN);
assertRemoved('plugin', plugin);

console.log('\nB. generated SecurityModule.kt');
if (!exists(GENERATED)) {
  ok(false, 'generated SecurityModule.kt not found (run: npx expo prebuild -p android)');
} else {
  assertRemoved('generated', read(GENERATED));
}

// ════════════════════════════════════════════════════════════════════════════
// C. Native → JS contract: no field, therefore no ON / OFF / fake "unavailable"
// ════════════════════════════════════════════════════════════════════════════
console.log('\nC. native → JS contract');
ok(!/mockLocationDetected/.test(NATIVE),
  'nativeSecurity: NativeSecurityFlags declares no mock-location field');
ok(!/mockLocationDetected:\s*(false|true)\s*,/.test(NATIVE),
  'nativeSecurity: no fail-safe default can be reported as a measured value');

// The two states that must stay distinct for every REMAINING signal: a measured
// false vs an unreachable module. Removing one field must not blur them.
ok(/_lastFlagsCallUnavailable\s*=\s*!measured/.test(NATIVE),
  'nativeSecurity: a failed measurement is still flagged unavailable');
ok(/_flagsCacheAt\s*=\s*measured\s*\?\s*Date.now\(\)\s*:\s*0/.test(NATIVE),
  'nativeSecurity: a failed measurement is still NOT cached (freshness preserved)');
ok(/export function wasLastSecurityFlagsCallUnavailable/.test(NATIVE),
  'nativeSecurity: the unavailable-vs-measured distinction is still exported');

// ════════════════════════════════════════════════════════════════════════════
// D. Engine + UI + evidence: no dead enforcement path
// ════════════════════════════════════════════════════════════════════════════
console.log('\nD. engine / copy / report / evidence');
ok(!/detectMockLocation|mockLocThreat/.test(SECURITY),
  'security.ts: the detector and its aggregation slot are gone');
ok(!/Mock location enabled/.test(SECURITY),
  'security.ts: the removed detector produces no detectionMethod string');
ok(!/mockLocationDetected/.test(read('src/lib/deviceKey.ts')),
  'deviceKey.ts: no mock-location evidence field is reported to the backend');
ok(!exists('src/lib/securitySignalReport.ts') && !exists('src/components/SecuritySignalReport.tsx'),
  'the temporary device security report is gone (no report vocabulary can carry a mock row)');
ok(!/mockLocationDetected/.test(read('src/app/(app)/(hubs)/sec-diag.tsx')),
  'sec-diag.tsx: the diagnostics table has no mock row');
ok(!/mockLocationDetected: \{/.test(read('src/app/(app)/security-diagnostics.tsx')),
  'security-diagnostics.tsx: the detector table has no mock entry');
ok(!/mock_location_detected:/.test(read('src/app/(auth)/security-warning.tsx')) &&
   !/mock_location_detected:/.test(read('src/app/(app)/security-warning.tsx')) &&
   !/mock_location_detected:/.test(read('src/app/(app)/security-gate.tsx')),
  'blocking screens: no copy entry for the removed finding');

const MODEL = read('src/lib/securityStateModel.ts');
ok(/['"]mock_location['"]/.test(MODEL) === false,
  'securityStateModel: the resolver never returns a mock-location copy key');

// API 36 / Developer options OFF: the report cannot invent a mock row even when
// a caller (or a stale persisted snapshot) supplies the old key. The row set is
// built exclusively from REPORT_SIGNALS, which no longer contains it — pinned in
// tests/debugModeFindingDiagnostics.test.cjs (5e-2) and asserted here in source.
const SCREENS = [
  'src/app/(auth)/security-warning.tsx',
  'src/app/(app)/security-warning.tsx',
  'src/app/(app)/security-gate.tsx',
];
ok(SCREENS.every((rel) => !/SecuritySignalReport|reportFindings/.test(read(rel))),
  'blocking screens: no device security report UI or payload remains');

// ════════════════════════════════════════════════════════════════════════════
// E. Backend: persisted findings cannot block after removal
// ════════════════════════════════════════════════════════════════════════════
console.log('\nE. backend enforcement');
const EVIDENCE = read('backend/src/Services/SecurityEvidenceService.php');
const blockingLine = (EVIDENCE.match(/\$blocking\s*=\s*\[[^\]]*\]/) || [''])[0];
ok(blockingLine.length > 0, 'backend: the evidence blocking list is still declared');
ok(!/'mock_location'/.test(blockingLine),
  'backend: mock_location is no longer blocking (stale rows cannot deny login)');
for (const sig of ['vpn', 'proxy', 'developer_options', 'adb', 'debugger', 'tampered', 'root', 'magisk', 'frida', 'xposed', 'emulator']) {
  ok(new RegExp(`'${sig}'`).test(blockingLine),
    `backend: ${sig} is still blocking (unrelated protection untouched)`);
}

// ════════════════════════════════════════════════════════════════════════════
// F. Surviving protections + risk semantics unchanged
// ════════════════════════════════════════════════════════════════════════════
console.log('\nF. surviving signals unchanged');
ok(/flags\.developerOptionsEnabled/.test(SECURITY),
  'security.ts: Developer Options detection is untouched');
ok(/flags\.adbEnabled/.test(SECURITY),
  'security.ts: ADB detection is untouched');
ok(/flags\.debuggerAttached/.test(SECURITY),
  'security.ts: debugger detection is untouched');
ok(/flags\.testOnlyBuild/.test(SECURITY),
  'security.ts: test-only build detection is untouched');
ok(/flags\.emulatorDetected/.test(SECURITY),
  'security.ts: emulator detection is untouched');
ok(/debugger_attached/.test(SECURITY) && /adb_enabled/.test(SECURITY) &&
   /developer_options_enabled/.test(SECURITY) && /virtual_device_detected/.test(MODEL),
  'the remaining debug-family findings keep their own copy keys');
ok(/debug_detected:\s*20,/.test(SECURITY),
  'risk weight for debug_detected is unchanged (20)');
ok(/debug:\s*'block_login'/.test(SECURITY),
  'the debug bucket still blocks login (no policy weakened)');
ok(/debug:\s*\['debug_detected', 'debugger_attached'\]/.test(SECURITY),
  'debug_detected still maps into the debug bucket');
ok(/vpn_detected:\s*15/.test(SECURITY) && /proxy_detected:\s*15/.test(SECURITY),
  'VPN/proxy weights unchanged');
ok(/play_integrity:\s*'block_login'/.test(SECURITY),
  'Play Integrity policy unchanged');
ok(!/if \(type === 'debug_detected'\) return 'ALLOWED'|mock_location[^\n]*block_login/.test(SECURITY),
  'no exemption or bypass was introduced for the removed signal');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
