#!/usr/bin/env node
/**
 * FLOATING-WINDOW PROTECTION — REMOVAL + RETAINED-PROTECTION CONTRACT.
 *
 * The floating-window subsystem was removed because it inferred "another app is
 * over MedAcademy" from window FOCUS and touch flags. Recents, an ordinary app
 * switch, a system dialog and even the app's own dialogs change focus, and no
 * public Android API lets one app enumerate another app's windows — so the
 * detector produced false locks and could never prove the condition it claimed.
 *
 * WHAT THIS SUITE PROVES
 *   1. No floating-window / overlay signal can trigger a MedAcademy lock.
 *   2. The removed subsystem can emit no floating-window security finding.
 *   3. Split-screen detection still works.
 *   4. Picture-in-Picture detection still works.
 *   5. VPN detection still works.
 *   6. System-proxy detection still works.
 *   7. Denylisted interception-application detection still works.
 *   8. Multiple remaining security reasons aggregate correctly.
 *   9. Notification shade / ordinary app switching cannot cause a false lock.
 *
 * Static contracts are checked against the REAL sources (the Expo config plugin
 * emits the Kotlin, so the plugin is the native contract). Behavioural checks
 * execute the dependency-free state model. Physical Android behaviour is NOT
 * claimed here: that remains a device-verification item.
 *
 * Run: node tests/floatingWindowRemoval.test.cjs
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PLUGIN = read('plugins/withSecurityModule.js');
const CONTEXT = read('src/lib/SecurityContext.tsx');
const MODEL = read('src/lib/securityStateModel.ts');
const SECURITY = read('src/lib/security.ts');
const NATIVE_JS = read('src/lib/nativeSecurity.ts');
const GATE = read('src/app/(app)/security-gate.tsx');
const RESOURCES = read('src/lib/i18n/resources.ts');
const DEVICE_KEY = read('src/lib/deviceKey.ts');
/** The emitted Kotlin only — NOT the JS upgrade guard, which names retired
 *  symbols on purpose so an already-patched MainActivity is re-injected. */
const KOTLIN = PLUGIN.slice(0, PLUGIN.indexOf('const WINDOW_MODE_ACTIVITY_MARKER'));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

/** Compile one dependency-free model module and require the result. */
function buildModel(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-removal-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src', 'lib', file),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(tmp, file.replace(/\.ts$/, '.js')));
}

const M = buildModel('securityStateModel.ts');

const BLANK = {
  evaluating: false,
  hasVerdict: true,
  multiWindowBlocked: false,
  backgroundResumeBlocked: false,
  vpnBlocked: false,
  violationBlocked: false,
};
const state = (over) => M.resolveSecurityGateState({ ...BLANK, ...over });

// ══════════════════════════════════════════════════════════════════════════
console.log('\n1. A floating-window / overlay signal cannot lock the app');
// ══════════════════════════════════════════════════════════════════════════
{
  check('1a: the gate vocabulary has no overlay state',
    !M.SECURITY_GATE_STATES.includes('BLOCKED_OVERLAY')
    && !/BLOCKED_OVERLAY/.test(MODEL));
  check('1b: the gate inputs have no overlay field',
    !/overlayBlocked/.test(MODEL));
  check('1c: a residual overlayBlocked key alone resolves ALLOWED (no lock)',
    state({ overlayBlocked: true }) === 'ALLOWED');
  check('1d: no overlay lock source exists in the security context',
    !/LOCK_SRC_OVERLAY/.test(CONTEXT) && !/'overlay'/.test(CONTEXT));
  check('1e: no overlay reason is ever raised (or cleared) natively',
    !/REASON_OVERLAY/.test(PLUGIN)
    && !/raise\(\s*"overlay"/.test(PLUGIN)
    && !/clear\(\s*"overlay"/.test(PLUGIN));
  check('1f: the only overlay token left in the native reasons parser is absent',
    !/value === 'overlay'/.test(NATIVE_JS)
    && !/NativeContainmentReason[^\n]*'overlay'/.test(NATIVE_JS));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n2. The removed subsystem can emit no floating-window finding');
// ══════════════════════════════════════════════════════════════════════════
{
  check('2a: the overlay_detected event type no longer exists',
    !/overlay_detected/.test(SECURITY) && !/'overlay_detected'/.test(MODEL));
  check('2b: the overlay threat is not scored, mapped or policied',
    !/overlay_detected:\s*\d+/.test(SECURITY)
    && !/overlay:\s*\['overlay_detected'\]/.test(SECURITY)
    && !/overlay:\s*'(block|warn|log)_/.test(SECURITY));
  check('2c: no overlay detector remains in the pipeline',
    !/detectOverlay/.test(SECURITY) && !/isOverlayDetected/.test(SECURITY));
  check('2d: the native module exposes no overlay/obscured bridge',
    !/fun isOverlayDetected|fun isWindowObscured|fun enableOverlayProtection|obscuredStateChanged/.test(PLUGIN));
  check('2e: no touch-obscured / tapjacking evidence path remains',
    !/FLAG_WINDOW_IS_OBSCURED|FLAG_WINDOW_IS_PARTIALLY_OBSCURED|observeTouch|overlayLatched|coveredPoints/.test(KOTLIN));
  check('2f: no overlay control is offered on the gate',
    !M.isGateRecheckable('BLOCKED_OVERLAY'));
  check('2g: no user-facing overlay copy remains in either locale',
    !/security\.overlay\./.test(RESOURCES)
    && !/security\.gate\.stepsOverlay|security\.gate\.footerOverlay/.test(RESOURCES)
    && !/overlay_detected/.test(RESOURCES));
  check('2h: no overlay gate branch survives in the screen',
    !/overlayBlocked|security\.overlay/.test(GATE));
  check('2i: no overlay evidence field is signed into the device payload',
    !/out\.overlay\b/.test(DEVICE_KEY));
  check('2j: the floating-window permission is not declared by the plugin',
    !/HIDE_OVERLAY_WINDOWS/.test(PLUGIN));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n3. Split-screen detection still works');
// ══════════════════════════════════════════════════════════════════════════
{
  check('3a: multi_window is a prohibited mode',
    M.isProhibitedWindowMode('multi_window') === true);
  check('3b: a prohibited mode resolves the block page',
    state({ multiWindowBlocked: true, windowMode: 'multi_window' }) === 'BLOCKED_MULTI_WINDOW');
  check('3c: the page renders and blocks content',
    M.rendersBlockScreen('BLOCKED_MULTI_WINDOW') === true
    && M.isGateBlocked('BLOCKED_MULTI_WINDOW') === true);
  check('3d: release still needs a restored mode AND a fresh verdict',
    M.canClearMultiWindowBlock({ modeRestored: false, hasFreshVerdict: true }) === false
    && M.canClearMultiWindowBlock({ modeRestored: true, hasFreshVerdict: false }) === false
    && M.canClearMultiWindowBlock({ modeRestored: true, hasFreshVerdict: true }) === true);
  check('3e: the native bridge still classifies split-screen',
    /isInMultiWindowMode\) return WINDOW_MODE_MULTI/.test(PLUGIN)
    && /SecurityContainment\.reportWindowMode\(mode, source\)/.test(PLUGIN));
  check('3f: the UI still takes the hard lock and blocks content',
    /engageSecurityLock\(LOCK_SRC_WINDOW_MODE, \{ hard: true \}\)/.test(CONTEXT)
    && /blockProtectedContent\('multi-window'\)/.test(CONTEXT));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n4. Picture-in-Picture detection still works');
// ══════════════════════════════════════════════════════════════════════════
{
  check('4a: picture_in_picture is a prohibited mode',
    M.isProhibitedWindowMode('picture_in_picture') === true);
  check('4b: PiP resolves the block page with its own copy',
    state({ multiWindowBlocked: true, windowMode: 'picture_in_picture' }) === 'BLOCKED_MULTI_WINDOW'
    && M.windowModeBlockCopy('picture_in_picture').message !== M.windowModeBlockCopy('multi_window').message);
  check('4c: the native bridge still classifies PiP first',
    /if \(isInPictureInPictureMode\) return WINDOW_MODE_PIP/.test(PLUGIN));
  check('4d: PiP copy/steps exist and are mode-specific',
    M.windowModeBlockSteps('picture_in_picture').length >= 3
    && JSON.stringify(M.windowModeBlockSteps('picture_in_picture')) !== JSON.stringify(M.windowModeBlockSteps('multi_window')));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n5. VPN detection still works');
// ══════════════════════════════════════════════════════════════════════════
{
  check('5a: the native VPN watcher and reason still exist',
    /object VpnWatch \{/.test(PLUGIN) && /REASON_VPN = "vpn"/.test(PLUGIN));
  check('5b: a VPN reason resolves the connection page',
    state({ vpnBlocked: true }) === 'BLOCKED_VPN'
    && M.rendersBlockScreen('BLOCKED_VPN') === true);
  check('5c: the VPN policy floor is still block_login',
    /vpn:\s*'block_login'/.test(SECURITY)
    && /MANDATORY_CONNECTION_ACTION[^\n]*block_login/.test(MODEL));
  check('5d: the JS VPN detector still runs and can produce vpn_detected',
    /detectVPN\(\)/.test(SECURITY) && /'vpn_detected'/.test(SECURITY));
  check('5e: a VPN verdict still takes the hard native lock',
    /engageSecurityLock\(LOCK_SRC_NATIVE_VPN, \{ hard: true \}\)/.test(CONTEXT));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n6. System-proxy detection still works');
// ══════════════════════════════════════════════════════════════════════════
{
  check('6a: the native proxy probe still exists',
    /fun detectProxy\(\): Boolean/.test(PLUGIN));
  check('6b: the JS proxy detector is still in the pipeline',
    /track\('proxy',\s*\(\) => bounded\('proxy',\s*detectProxy\(\)/.test(SECURITY));
  check('6c: a proxy finding still blocks login',
    /proxy:\s*'block_login'/.test(SECURITY)
    && /proxy_detected/.test(SECURITY));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n7. Interception-application detection still works');
// ══════════════════════════════════════════════════════════════════════════
{
  const CATALOG = [
    'com.network.proxy', 'com.reqable.android',
    'tech.httptoolkit.android.v1', 'com.proxyman.proxymanandroid',
    'com.shafayat.proxly',
    'com.guoshi.httpcanary', 'com.guoshi.httpcanary.premium',
    'com.emanuelef.remote_capture', 'app.greyshirts.sslcapture',
  ];
  check('7a: all nine exact package ids are in the source catalog',
    CATALOG.every((pkg) => PLUGIN.includes(`'${pkg}'`)));
  check('7b: the manifest <queries> block is generated from that same catalog',
    /for \(const name of \[\.\.\.TARGET_APP_CATALOG, \.\.\.SECURITY_CHECK_PACKAGES\]\)/.test(PLUGIN)
    && /manifest\.queries/.test(PLUGIN));
  check('7c: QUERY_ALL_PACKAGES is still NOT requested',
    !/android\.permission\.QUERY_ALL_PACKAGES/.test(PLUGIN));
  check('7d: the catalog is matched by exact id (no wildcard/prefix/regex)',
    !/INTERCEPTION_TOOLS[\s\S]{0,4000}(startsWith\(|endsWith\(|Regex\(|\.matches\()/.test(PLUGIN)
    && /for \(tool in INTERCEPTION_TOOLS\)/.test(PLUGIN)
    && /pm\.getPackageInfo\(tool\.pkg, 0\)/.test(PLUGIN));
  check('7e: installed-tool evidence is still published to JS',
    /interceptionToolPackages/.test(PLUGIN) && /interceptionToolLabels/.test(PLUGIN));
  check('7f: the closing report does not claim traffic was intercepted',
    !/has intercepted traffic/i.test(PLUGIN) && !/successfully intercepted/i.test(SECURITY));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n8. Multiple remaining reasons aggregate correctly');
// ══════════════════════════════════════════════════════════════════════════
{
  const reasons = M.resolveGateReasons({
    ...BLANK,
    multiWindowBlocked: true,
    windowMode: 'multi_window',
    vpnBlocked: true,
    violationBlocked: true,
  });
  check('8a: every live reason is listed in one deterministic order',
    reasons.map((r) => r.kind).join(',') === 'window,vpn,violation');
  check('8b: a window reason still carries its mode',
    reasons[0].key === 'window:multi_window' && reasons[0].mode === 'multi_window');
  check('8c: the primary state is the most restrictive live cause',
    state({ multiWindowBlocked: true, vpnBlocked: true, violationBlocked: true }) === 'BLOCKED_MULTI_WINDOW');
  check('8d: a VPN alone outranks a generic violation but not the window state',
    state({ vpnBlocked: true, violationBlocked: true }) === 'BLOCKED_VPN'
    && state({ multiWindowBlocked: true, vpnBlocked: true }) === 'BLOCKED_MULTI_WINDOW');
  check('8e: the gate still renders the reason list from the same source',
    /const activeReasonRows = gateReasons\.map/.test(GATE)
    && /reason\.kind === 'window'/.test(GATE)
    && /reason\.kind === 'vpn'/.test(GATE));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n9. Notification shade / app switching cannot lock the app');
// ══════════════════════════════════════════════════════════════════════════
{
  check('9a: no window-focus override remains in the emitted Kotlin',
    !/onWindowFocusChanged/.test(KOTLIN));
  check('9b: no top-resumed / focus-loss classification remains',
    !/onTopResumedActivityChanged|topResumedActivity|topResumedSlot|foreignWindowFocused/.test(KOTLIN));
  check('9c: no usage-stats / foreground-app replay remains',
    !/UsageStatsManager|queryEvents|getForeignFocusEvidence/.test(KOTLIN));
  check('9d: no overlay appearance/visibility callback is registered',
    !/onWindowVisibilityChanged|APPEARANCE|WindowInsetsController.*overlay/i.test(PLUGIN));
  check('9e: a bare resume cannot raise a prohibited window mode',
    /"lifecycle"\)/.test(PLUGIN)
    && /WindowModeBridge\.report\(isInMultiWindowMode\(\), isInPictureInPictureMode\(\), "lifecycle"\)/.test(PLUGIN)
    && !/foreign_window|WINDOW_MODE_FOREIGN/.test(PLUGIN));
  check('9f: an unmeasured mode is never a finding',
    M.isProhibitedWindowMode('unknown') === false
    && state({}) === 'ALLOWED');
  check('9g: own dialogs are irrelevant to window mode (no focus inference)',
    !/hasOwnDialogOpen\(\)[\s\S]{0,200}overlay/i.test(CONTEXT));
  check('9h: an ordinary app switch leaves the gate in CHECKING (never a window block)',
    M.resolveSecurityGateState({ ...BLANK, evaluating: true, hasVerdict: false }) === 'CHECKING');
}

console.log('\n' + '\u2500'.repeat(62));
console.log('floatingWindowRemoval: ' + passed + ' passed, ' + failed + ' failed');
console.log('NOTE: source-level + pure-model proofs only. Android focus/callback delivery');
console.log('and the physical tray behaviour remain device-verification items.');
process.exit(failed === 0 ? 0 : 1);
