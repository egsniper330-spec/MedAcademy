#!/usr/bin/env node
/**
 * FOUR INDEPENDENT ANDROID SECURITY FAILURES — contracts.
 *
 * Run: node tests/androidWindowVpnHardening.test.cjs
 *
 * Part 1  foreign freeform / Samsung pop-up windows  → multi-signal evidence
 * Part 2  uncovered-area touch must not restore the app → sustained recovery
 * Part 3  ProxyPin pinned Activity                    → unresolved (Build 238: the
 *         UsageStats replay detector was measured ineffective and removed; no
 *         AccessibilityService is added)
 * Part 4  VPN must block BEFORE protected requests   → early watcher + barrier
 *
 * Part 5 pins INDEPENDENCE: the four signals keep their own source, reason,
 * marker and recovery condition; no signal's recovery may clear another.
 *
 * These are source-level contracts plus the emitted Kotlin. Android's actual
 * callback delivery and the physical scenarios are verified on the tablet.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const PLUGIN = read('plugins/withSecurityModule.js');
const CONTEXT = read('src/lib/SecurityContext.tsx');
const NATIVE_JS = read('src/lib/nativeSecurity.ts');
const YT = read('src/components/YouTubePlayer.tsx');
const LESSON = read('src/app/(app)/lesson/[id].tsx');
const APP_JSON = JSON.parse(read('app.json'));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

const obj = (start, end) => {
  const s = PLUGIN.indexOf(start);
  const e = PLUGIN.indexOf(end, s + 1);
  return s < 0 || e < 0 ? '' : PLUGIN.slice(s, e);
};
const VPNWATCH = obj('object VpnWatch {', ' * SecurityContainment \u2014 NATIVE containment');
const CONTAINMENT = obj('object SecurityContainment {', ' * SecurityModule \u2014 comprehensive native Android security checks.');
const BRIDGE = obj('object WindowModeBridge {', ' * VpnWatch \u2014 the EARLIEST');
const ACTIVITY = obj('MedAcademy multi-window guard', '/**\n * Insert the window-mode forwarders into a generated MainActivity');

// ── Part 1: multi-signal foreign-window evidence ────────────────────────────
console.log('\u2500\u2500 Part 1: foreign freeform / pop-up window evidence \u2500\u2500');
{
  check('1a: own multi-window / PiP state is still the first, positive classification',
    /if \(isInPictureInPictureMode\) return WINDOW_MODE_PIP[\s\S]{0,120}if \(isInMultiWindowMode\) return WINDOW_MODE_MULTI/.test(BRIDGE));
  check('1b: the focus-loss / top-resumed classification is GONE (floating-window removal)',
    !/WINDOW_MODE_FOREIGN|foreignWindowFocused|topResumedSlot|setTopResumed/.test(BRIDGE));
  check('1c: only split-screen and PiP are raised by the bridge',
    /val prohibited = mode == WINDOW_MODE_MULTI \|\| mode == WINDOW_MODE_PIP/.test(BRIDGE));
  check('1d: the UsageStats replay detector is GONE (measured ineffective, Build 238)',
    !/UsageStatsManager|queryEvents|foreignForegroundPackage|getForeignFocusEvidence/.test(PLUGIN) &&
      !/UsageStatsManager|getForeignFocusEvidence|lastForeignPackage/.test(NATIVE_JS));
  check('1e: no Usage Access permission or AppOps probe remains anywhere',
    !/OPSTR_GET_USAGE_STATS|lastUsageProbeElapsed|usageAccessGranted/.test(PLUGIN) &&
      !(APP_JSON.expo?.android?.permissions || []).some((p) => /USAGE_STATS/.test(p)));
  check('1e2: the permission is actively BLOCKED (stale manifest entry removed on merge)',
    (APP_JSON.expo?.android?.blockedPermissions || []).includes('android.permission.PACKAGE_USAGE_STATS'));
  check('1f: the independent window channels survive the overlay removal',
    /publishWindowMode\(mode, source\)/.test(PLUGIN) &&
      /SecurityContainment\.reportWindowMode\(mode, source\)/.test(PLUGIN) &&
      !CONTAINMENT.includes('FLAG_WINDOW_IS_PARTIALLY_OBSCURED'));
  check('1f2: the removed classification is documented, not silently dropped',
    /floating-window (protection )?(was )?removed|floating-window classification was/i.test(PLUGIN));
  check('1g: no accessibility service is added (optional/undecided, never required)',
    !/extends\s+AccessibilityService/.test(PLUGIN) &&
      !/BIND_ACCESSIBILITY_SERVICE/.test(PLUGIN) &&
      !/android\.accessibilityservice/.test(PLUGIN));
  check('1h: no hidden/reflection windowing API is used as a dependency',
    !/getDeclaredMethod|Class\.forName\([\"']android\.view/.test(PLUGIN));
  check('1i: the platform limitation is stated, not glossed over',
    /does not enumerate other apps|no window enumeration|Android exposes no window enumeration/i.test(PLUGIN));
  check('1j: resizeableActivity is never claimed to stop another app\'s float',
    !/resizeableActivity[\s\S]{0,120}prevent/i.test(PLUGIN));
  check('1k: HIDE_OVERLAY_WINDOWS is never claimed to hide a pinned Activity',
    !/setHideOverlayWindows[\s\S]{0,200}(pinned|TYPE_BASE_APPLICATION)/i.test(PLUGIN));
}

// ── Part 2: uncovered-area touch must not restore the app ───────────────────
console.log('\u2500\u2500 Part 2: partial obscuration + sustained recovery \u2500\u2500');
{
  check('2a: NO obscuration flag is read anywhere (touch evidence removed)',
    // The emitted Kotlin only: the JS upgrade guard names retired symbols.
    !/FLAG_WINDOW_IS_OBSCURED|FLAG_WINDOW_IS_PARTIALLY_OBSCURED/.test(CONTAINMENT) &&
      !/dispatchTouchEvent|observeTouch/.test(CONTAINMENT));
  check('2b: no overlay reason can be raised', !/REASON_OVERLAY/.test(PLUGIN));
  check('2c: no touch-driven recovery path remains', !/clean-touch-window-active|revalidate-/.test(PLUGIN));
  check('2d: the foreign sticky hold and its settle window are removed',
    !/RECOVERY_SETTLE_MS|recoveryStartedAtMs|foreignSticky|defer-confirm/.test(BRIDGE));
  check('2e: a prohibited reading is still accepted immediately',
    /if \(prohibited\) \{[\s\S]{0,260}accept\(mode, source\)[\s\S]{0,120}return "accept"/.test(BRIDGE));
  check('2f: a snapshot can never act in place of the activity callback',
    /val accepted = decision == "accept" \|\| decision == "replay"/.test(PLUGIN));
  check('2g: the paced confirming re-read is removed with the subsystem (no polling loop)',
    !/confirmRecoveryRunnable/.test(PLUGIN) && !/setInterval|scheduleAtFixedRate/.test(PLUGIN));
  check('2h: the region-bound overlay revalidation is REMOVED',
    !CONTAINMENT.includes('isPointInCoveredRegion') &&
      !CONTAINMENT.includes('revalidate-rejected-outside-region') &&
      !CONTAINMENT.includes('revalidate-region-verified'));
  check('2i: nothing can clear an overlay reason (the reason no longer exists)',
    !/clear\(REASON_OVERLAY/.test(CONTAINMENT));
  check('2j: reasons are still removed one at a time',
    CONTAINMENT.includes('removed = reasons.remove(reason)'));
}

// ── Part 3: ProxyPin pinned Activity ────────────────────────────────────────
console.log('\u2500\u2500 Part 3: pinned Activity \u2014 unresolved by design \u2500\u2500');
{
  check('3a: no WINDOW classification is derived from a package name',
    // Package names are used by the traffic-interception detector (a separate,
    // independently-reasoned signal); the window classifier must never read them.
    !/WINDOW_MODE_[A-Z_]+[\s\S]{0,200}getPackageInfo/.test(CONTAINMENT) &&
      !/\.packageName\s*(==|!=)\s*"/.test(PLUGIN));
  check('3b: the window-class limitation is documented, not claimed as detection',
    /Android exposes no window enumeration|no window enumeration/i.test(PLUGIN));
  check('3c: no AccessibilityService, accessibility permission or manifest entry is added',
    !/extends\s+AccessibilityService/.test(PLUGIN) &&
      !/BIND_ACCESSIBILITY_SERVICE/.test(PLUGIN) &&
      !/android\.accessibilityservice/.test(PLUGIN));
  check('3d: no touch-obscuration signal survives (removed subsystem)',
    !PLUGIN.includes('FLAG_WINDOW_IS_OBSCURED') &&
      !PLUGIN.includes('FLAG_WINDOW_IS_PARTIALLY_OBSCURED'));
  check('3e: the paused-visible window class is no longer treated as a finding',
    !/foreignWindowFocused|topResumedSlot/.test(BRIDGE) &&
      /WINDOW_MODE_MULTI/.test(BRIDGE));
  check('3f: the window reason keeps its own recovery (platform full-screen only)',
    /else if \(mode == WINDOW_MODE_FULLSCREEN\) \{\s*clear\(REASON_WINDOW/.test(CONTAINMENT) &&
      !CONTAINMENT.includes('clean-touch-window-active'));
}

// ── Part 4: VPN before protected requests ───────────────────────────────────
console.log('\u2500\u2500 Part 4: early VPN watcher + pre-network barrier \u2500\u2500');
{
  check('4a: a process-wide watcher exists independently of React Native',
    VPNWATCH.length > 0 && /object VpnWatch \{/.test(PLUGIN));
  check('4b: it is started from the ACTIVITY (before RN/JS), not only from the module',
    /SecurityContainment\.ensureVpnWatch\(applicationContext\)/.test(ACTIVITY) &&
      /fun ensureVpnWatch\(context/.test(CONTAINMENT));
  check('4c: the decision uses onCapabilitiesChanged (documented ordering)',
    /override fun onCapabilitiesChanged\([\s\S]{0,300}caps\.hasTransport\(NetworkCapabilities\.TRANSPORT_VPN\)/.test(VPNWATCH));
  check('4d: onAvailable is not used to read capabilities synchronously',
    !/override fun onAvailable[\s\S]{0,300}getNetworkCapabilities/.test(VPNWATCH));
  check('4e: the state is atomic and the change time is recorded',
    /@Volatile\s+var transportActive: Boolean/.test(VPNWATCH) && /var lastChangeMs: Long/.test(VPNWATCH));
  check('4f: a transition raises the INDEPENDENT vpn reason before any JS verdict',
    /SecurityContainment\.raise\(SecurityContainment\.REASON_VPN/.test(VPNWATCH));
  check('4g: "our traffic is tunnelled" is distinguished from "a VPN exists"',
    VPNWATCH.includes('transportActive') && VPNWATCH.includes('vpnPresent') &&
      /hasDefaultVpn/.test(VPNWATCH) && /hasAnyVpnNetwork/.test(VPNWATCH));
  check('4h: a clear only happens when NO VPN remains anywhere',
    /} else \{[\s\S]{0,400}SecurityContainment\.clear\(SecurityContainment\.REASON_VPN/.test(VPNWATCH));
  check('4i: a fast snapshot method exists (no network, no detector suite)',
    /fun getVpnSnapshot\(promise: Promise\)/.test(PLUGIN) && NATIVE_JS.includes('getNativeVpnSnapshot'));
  check('4j: unknown/unregistered is treated as BLOCKED by the JS barrier',
    /if \(!vpn \|\| !vpn\.registered\) return true/.test(CONTEXT));
  check('4k: the VPN barrier runs BEFORE the 14-detector evaluation',
    CONTEXT.indexOf('getNativeVpnSnapshot()', CONTEXT.indexOf('const checkBeforeVideo')) <
      CONTEXT.indexOf("runSharedFullCheck('pre-video')", CONTEXT.indexOf('const checkBeforeVideo')));
  check('4l: the PLAYER ITSELF refuses to create the WebView until the barrier clears',
    /if \(!vpnBarrierClear\) \{/.test(YT) &&
      /aspectRatio: 16 \/ 9/.test(YT) &&
      YT.indexOf('if (!vpnBarrierClear)') < YT.lastIndexOf('<WebView'));
  check('4m: the barrier applies to a freshly mounted player (every re-open path)',
    /useState\(false\)[\s\S]{0,400}getNativeVpnSnapshot\(\)/.test(YT));
  check('4n: playback still requires the full evaluation after the fast barrier',
    /const r = await runSharedFullCheck\('pre-video'\)/.test(CONTEXT));
  check('4o: the lesson still awaits the pre-video check before mounting a player',
    /const blocked = await checkBeforeVideo\(\);/.test(LESSON));
  check('4p: the transition is also handled while playing (native reason + webview stop)',
    /useSecurityWebViewStop\(wvRef\)/.test(YT) &&
      /REASON_VPN/.test(CONTAINMENT));
  check('4s: a clean JS verdict cannot clear the native VPN reason while a tunnel exists',
    /getNativeVpnSnapshot\(\)\.then\(\(snap\) => \{[\s\S]{0,320}if \(snap\.vpnTransport \|\| snap\.vpnPresent\) return;[\s\S]{0,160}clearNativeContainmentReason\('vpn'\)/.test(CONTEXT));
  check('4t: the clear is also refused when the native state is UNKNOWN',
    /if \(!snap \|\| !snap\.registered\) return; \/\/ unknown is not clearance/.test(CONTEXT));
  check('4q: no timeout was reduced and no detector was removed to buy speed',
    /const DETECTOR_TIMEOUT_MS = 10_000;/.test(read('src/lib/security.ts')));
  check('4r: the honest limitation is documented (a callback is not a packet firewall)',
    /NOT a packet firewall|cannot be recalled/i.test(PLUGIN) || /cannot be recalled/.test(read('src/lib/security.ts')));
}

// ── Part 5: the four signals stay independent ───────────────────────────────
console.log('\u2500\u2500 Part 5: independent reasons, markers and recoveries \u2500\u2500');
{
  check('5a: exactly two native reasons remain (window / vpn)',
    !CONTAINMENT.includes('REASON_OVERLAY') &&
      CONTAINMENT.includes('REASON_WINDOW = "window"') &&
      CONTAINMENT.includes('REASON_VPN = "vpn"'));
  check('5b: each remaining evidence source has its own timeline marker',
    !CONTAINMENT.includes('"touch-obscured"') &&
      CONTAINMENT.includes('"window-mode-" + decision') &&
      CONTAINMENT.includes('"vpn-active"') &&
      CONTAINMENT.includes('"vpn-cleared"'));
  check('5c: clearing the window reason never touches overlay or VPN',
    /else if \(mode == WINDOW_MODE_FULLSCREEN\) \{\s*clear\(REASON_WINDOW/.test(CONTAINMENT));
  check('5d: a VPN transition never clears the window or overlay reasons',
    !/SecurityContainment\.clear\(SecurityContainment\.REASON_(OVERLAY|WINDOW)/.test(VPNWATCH));
  check('5e: the reasons are still a set, removed one at a time',
    CONTAINMENT.includes('val reasons') && CONTAINMENT.includes('synchronized(reasons)'));
  check('5f: the gate lists every active reason from the native set',
    read('src/app/(app)/security-gate.tsx').includes('nativeReasons') ||
      read('src/lib/SecurityContext.tsx').includes('setNativeReasons'));
}

console.log('\n' + '\u2500'.repeat(60));
console.log('androidWindowVpnHardening: ' + passed + ' passed, ' + failed + ' failed');
console.log('NOTE: source-level contracts. Callback delivery, pinning behaviour and the');
console.log('four physical scenarios are verified on the tablet, not here.');
process.exit(failed === 0 ? 0 : 1);
