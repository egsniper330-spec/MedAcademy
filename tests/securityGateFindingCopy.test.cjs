#!/usr/bin/env node
/**
 * Gate finding copy vs. the condition that actually fired — regression suite.
 *
 * Run: node tests/securityGateFindingCopy.test.cjs
 *
 * OBSERVED ON A PHYSICAL DEVICE (the defect this locks down):
 *   SECURITY BLOCK ACTIVE / "Insecure Build Detected — Install the official
 *   production release of the app." / Risk Score: 20 — on a legitimate,
 *   production-signed release APK whose signing cert matched the configured
 *   EXPECTED_CERT_SHA256 pin.
 *
 * WHY IT WAS POSSIBLE:
 *   The engine reports THREE unrelated conditions as the single event type
 *   `debug_detected` (weight 20, policy bucket `debug` → block_login):
 *     • a test-only / debuggable build        (testOnlyBuild, __DEV__)
 *     • a mock-location provider selected     (AppOps OPSTR_MOCK_LOCATION, or the
 *                                              pre-API-23 ALLOW_MOCK_LOCATION flag)
 *     • an emulator-like device               (emulatorDetected)
 *   The gate had ONE piece of copy for that event, and it asserted a build
 *   problem. For the device-condition cases the displayed finding contradicted
 *   the measurement AND gave advice that cannot work (reinstalling the official
 *   release never clears a mock-location setting).
 *
 * WHAT THIS SUITE PINS
 *   1. resolveFindingCopyKey() routes a mock-location / emulator finding to its
 *      OWN copy key, and leaves every other event type — including a genuine
 *      `debug_detected` from a test-only or debuggable build — untouched.
 *   2. The gate's copy table describes the device conditions accurately and no
 *      longer tells those users to reinstall the app.
 *   3. NOTHING about the enforcement changed: same event type, same weight (20),
 *      same `debug` → block_login policy, same gate decision. This is a
 *      presentation fix, not a bypass.
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

/** Compile the dependency-free state model standalone (house pattern). */
function buildModel() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-key-model-'));
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
const GATE = read('src/app/(app)/security-gate.tsx');
const SECURITY = read('src/lib/security.ts');
const RESOURCES = read('src/lib/i18n/resources.ts');

/**
 * The gate's English copy table was replaced by the shared translation
 * resources (`security.gate.event.<key>.{title,instruction}`); the gate keeps
 * a KEY SET (which events have copy) and resolves the text at render time.
 * These helpers pin the copy in the dictionaries instead of the screen.
 */
function dictValue(key, localeStart) {
  const re = new RegExp("^  '" + key.replace(/\\./g, '\\.') + "': '(.*)',$", 'm');
  const scope = localeStart ? RESOURCES.slice(localeStart) : RESOURCES;
  const m = scope.match(re);
  return m ? m[1] : null;
}
const AR_START = RESOURCES.indexOf('export const ar');

/** English title + instruction for one gate event key, or null when absent. */
function copyEntry(key) {
  const title = dictValue(`security.gate.event.${key}.title`);
  const instruction = dictValue(`security.gate.event.${key}.instruction`);
  return title === null || instruction === null ? null : `${title} ${instruction}`;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Copy-key routing (the pure mapping, unit-tested)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n1. resolveFindingCopyKey()');
{
  const K = M.resolveFindingCopyKey;

  // Mock location is no longer a producer of `debug_detected`: the whole
  // detector was removed (it could not be established reliably on modern
  // Android — see docs/MOCK_LOCATION_REMOVAL.md). A legacy detectionMethod
  // string therefore must NOT resurrect a dedicated copy key; it falls back to
  // the generic event copy, exactly like any unknown method.
  check('1a: a removed mock-location finding cannot resurrect its own copy key',
    K('debug_detected', 'Mock location enabled') === 'debug_detected' &&
    K('debug_detected', 'Mock location enabled') !== 'mock_location_detected');

  check('1b: an emulator finding gets its own key',
    K('debug_detected', 'Emulator / debug environment detected') === 'virtual_device_detected');

  check('1c: a genuine test-only build keeps the build copy (unchanged behaviour)',
    K('debug_detected', 'test-only build flag') === 'debug_detected');

  check('1d: __DEV__ debug mode keeps the build copy (unchanged behaviour)',
    K('debug_detected', 'Debug mode active') === 'debug_detected');

  check('1e: a missing detectionMethod never invents a device-condition key',
    K('debug_detected') === 'debug_detected' && K('debug_detected', null) === 'debug_detected');

  check('1f: every other event type passes through untouched',
    K('root_detected', 'su binary found') === 'root_detected' &&
    K('signature_invalid', 'App signature verification failed') === 'signature_invalid' &&
    K('vpn_detected', 'VPN interface') === 'vpn_detected');
}

// ════════════════════════════════════════════════════════════════════════════
// 2. The rendered copy tells the truth for the device conditions
// ════════════════════════════════════════════════════════════════════════════
console.log('\n2. gate copy table');
{
  const virt = copyEntry('virtual_device_detected');
  const build = copyEntry('debug_detected');

  check('2a: the removed mock-location copy entry is gone (no dead UI path)',
    copyEntry('mock_location_detected') === null);
  check('2b: virtual_device_detected has its own entry', virt !== null);

  check('2c: the emulator copy does not claim an insecure build and does not tell the user to reinstall',
    virt !== null &&
    !/Insecure Build/i.test(virt) &&
    !/official production release/i.test(virt));

  check('2e: virtual-device copy does not claim an insecure build either',
    virt !== null &&
    !/Insecure Build/i.test(virt) &&
    !/official production release/i.test(virt) &&
    /physical Android device/i.test(virt));

  check('2f: the genuine build-identity finding keeps its intended instruction',
    build !== null &&
    /Insecure Build Detected/.test(build) &&
    /official production release/i.test(build));

  check('2g: the gate resolves findings through resolveFindingCopyKey (live path)',
    /liveCopyKeys\s*=\s*threats\.map\(\(t\)\s*=>\s*resolveFindingCopyKey\(t\.type,\s*t\.detectionMethod\)\)/.test(GATE));

  check('2h: the async blocking path resolves the same way (no divergent copy)',
    /gateTypesRef\.current = result\.threats\.map\(\(t\) => resolveFindingCopyKey\(t\.type, t\.detectionMethod\)\)/.test(GATE));

  check('2i: the rendered finding list is built from those keys',
    /const types = liveBlocking \? liveCopyKeys : stickyTypes;/.test(GATE));

  // The English copy table in the screen was replaced by the dictionaries:
  // the gate keeps only the SET of events that have copy, and resolves the
  // text with t() at render time (so the language follows the device).
  check('2j: the gate no longer keeps its own English copy table',
    /GATE_EVENT_KEYS: ReadonlySet<string>/.test(GATE) &&
    /t\(`security\.gate\.event\.\$\{type\}\.title`\)/.test(GATE) &&
    /t\(`security\.gate\.event\.\$\{type\}\.instruction`\)/.test(GATE) &&
    !/GATE_EVENT_COPY/.test(GATE));

  // The unknown-event fallback is the ONLY row for an event without copy.
  check('2k: an unknown event still gets the generic row instead of a raw key',
    /t\('security\.gate\.unknownTitle'\)/.test(GATE) &&
    /t\('security\.gate\.unknownInstruction'\)/.test(GATE));

  // Both languages must carry every gate event's title and instruction.
  const eventKeys = [...GATE.matchAll(/^\s{2}'([a-z_]+)',/gm)]
    .map((m) => m[1]);
  const missingAr = eventKeys.filter((k) =>
    dictValue(`security.gate.event.${k}.title`, AR_START) === null ||
    dictValue(`security.gate.event.${k}.instruction`, AR_START) === null);
  const missingEn = eventKeys.filter((k) =>
    dictValue(`security.gate.event.${k}.title`) === null ||
    dictValue(`security.gate.event.${k}.instruction`) === null);
  check('2l: every gated event has copy in BOTH dictionaries',
    eventKeys.length >= 15 && missingAr.length === 0 && missingEn.length === 0);
  check('2m: the Arabic gate copy is really Arabic (no English placeholder)',
    eventKeys.every((k) => /[\u0600-\u06FF]/.test(
      dictValue(`security.gate.event.${k}.title`, AR_START) ?? '')));
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Enforcement unchanged — this is a presentation fix, never a bypass
// ════════════════════════════════════════════════════════════════════════════
console.log('\n3. enforcement unchanged');
{
  check('3a: the event type is still debug_detected for the remaining producer (policy/audit vocabulary intact)',
    /type: 'debug_detected',\s*\n\s*detectionMethod: 'Emulator \/ debug environment detected'/.test(SECURITY));

  check('3b: debug_detected still weighs 20 (risk score semantics unchanged)',
    /debug_detected:\s*20,/.test(SECURITY));

  check('3c: the debug bucket is still block_login (the block is NOT weakened)',
    /debug:\s*'block_login'/.test(SECURITY));

  check('3d: debug_detected still maps into the debug bucket',
    /debug:\s*\['debug_detected', 'debugger_attached'\]/.test(SECURITY));

  const risk = M.computeRiskScorePure(
    [{ type: 'debug_detected', detectionMethod: 'Emulator / debug environment detected', detected: true }],
    { debug_detected: 20 },
  );
  check('3e: the same single emulator finding still scores 20 (enforcement unchanged)',
    risk === 20);

  check('3f: the gate still blocks on the same centralized state (no new escape hatch)',
    M.isGateBlocked('BLOCKED_SECURITY_VIOLATION') === true &&
    M.isGateBlocked('ALLOWED') === false);

  const PLUGIN = read('plugins/withSecurityModule.js');
  check('3g: the mock-location detector is GONE from the native template (not merely disabled)',
    !/fun isMockLocationEnabled\(/.test(PLUGIN) &&
    !/fun detectMockLocation\(/.test(PLUGIN) &&
    !/putBoolean\("mockLocationDetected"/.test(PLUGIN));

  check('3h: the removal is documented in the template itself (why it could not be trusted)',
    /MOCK-LOCATION DETECTION - REMOVED|MOCK-LOCATION DETECTION — REMOVED/.test(PLUGIN) &&
    /UPDATE_APP_OPS_STATS/.test(PLUGIN));

  check('3i: removing it left the surviving device detectors untouched',
    /fun isDeveloperOptionsEnabled\(/.test(PLUGIN) &&
    /fun isAdbEnabled\(/.test(PLUGIN) &&
    /fun isDebuggerAttached\(/.test(PLUGIN) &&
    /fun detectEmulator\(/.test(PLUGIN) &&
    /fun detectVpn\(/.test(PLUGIN));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nFAILURES: see the \u274c lines above.');
  process.exit(1);
}
