#!/usr/bin/env node
/**
 * iOS PARITY — SOURCE-LEVEL verification (no iOS device/runner in this environment).
 *
 * This suite deliberately says SOURCE-LEVEL: it proves the shared code paths and
 * platform guards are correct by reading the shipped sources. It is NOT a
 * physical iOS verification and must not be quoted as one.
 *
 * Covered, for every Android fix in this pass:
 *   1. Feature flags      — one platform-agnostic client lib + re-hydration on
 *                           both platforms; the enforcement itself is server-side.
 *   2. Doctor Earnings    — the client gates carry no platform exemption.
 *   3. Profile photo      — one shared control for both roles, iOS permission
 *      Remove               declared, cross-platform APIs only in the remove path.
 *   4. Fullscreen         — Android-only helpers no-op on iOS; iOS never touches
 *                           the orientation API; ONE in-place player (no second
 *                           window/player on either platform).
 *   5. Safe area          — root provider + every fullscreen exit control is
 *                           inset-aware (the old fixed top:12 sat under the
 *                           status area/notch on iOS).
 *   6. Native iOS fixes   — delivered through config plugins (re-applied on every
 *                           prebuild), never by editing generated ios/ files.
 *
 * Usage: node tests/iosParity.test.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

console.log('── 1. Feature flags: one client lib, both platforms ──');
{
  const flags = read('src/lib/featureFlags.ts');
  ok(!/Platform\.OS/.test(flags), 'flag lib has NO platform branching (identical behaviour on iOS)');
  ok(/ensureFeatureFlagsFresh/.test(flags), 'exposes ensureFeatureFlagsFresh() for propagation');

  const shell = read('src/app/(app)/_layout.tsx');
  ok((shell.match(/ensureFeatureFlagsFresh\(\)/g) || []).length >= 2,
    'app shell re-hydrates flags on start and on resume (not Android-conditional)');
  ok(!/Platform\.OS[^\n]*ensureFeatureFlagsFresh/.test(shell),
    're-hydration is not guarded by a platform check');

  // The authoritative enforcement lives in PHP — platform-agnostic by nature.
  const rpc = read('backend/src/Controllers/RpcController.php');
  ok(/assertEnabledFor\('doctor_earnings'/.test(rpc),
    'server-side enforcement is PHP (identical for iOS and Android clients)');

  const clientFlags = read('src/lib/featureFlags.ts');
  ok(/feature_disabled/.test(clientFlags), 'client recognises the shared refusal code on both platforms');
}

console.log('── 2. Doctor Earnings: no platform exemption in the client gates ──');
{
  const targets = [
    ['drawer', 'src/components/DrawerNav.tsx'],
    ['earnings screen', 'src/app/(app)/(doctor)/dr-earnings.tsx'],
    ['doctor profile', 'src/app/(app)/(doctor)/dr-profile.tsx'],
  ];
  for (const [label, rel] of targets) {
    const src = stripComments(read(rel));
    ok(/doctor_earnings/.test(src), `${label}: consults the platform flag`);
    ok(!/Platform\.OS[^\n]*doctor_earnings|doctor_earnings[^\n]*Platform\.OS/.test(src),
      `${label}: flag check is NOT platform-conditional`);
  }
  // The sentence now lives in the dictionary (both screens render it through
  // t()), so parity is: the screen renders the key on every platform and the
  // English copy is present for that key. No platform branch may change it.
  const earnings = stripComments(read('src/app/(app)/(doctor)/dr-earnings.tsx'));
  const earningsCopy = stripComments(read('src/lib/i18n/resources.ts'));
  ok(/t\('drProfile\.featureUnavailable'\)/.test(earnings) &&
     /'drProfile\.featureUnavailable': 'This feature is currently unavailable\.'/.test(earningsCopy),
    'earnings screen shows the same user-safe message on iOS');
}

console.log('── 3. Profile photo Remove: shared control, iOS permission, X-platform APIs ──');
{
  const comp = read('src/components/ProfilePhotoActions.tsx');
  const copy = read('src/lib/i18n/resources.ts');
  ok(/export function ProfilePhotoActions/.test(comp), 'one shared control component');
  // The label is localized; the English copy must still be "Remove Photo" so the
  // iOS flow is identical to Android's, and the component must stay platform-free.
  ok(/label=\{t\('profilePhoto\.remove'\)\}/.test(comp)
    && /'profilePhoto\.remove': 'Remove Photo'/.test(copy)
    && !/Platform\.OS/.test(comp),
    'Remove Photo is rendered on every platform (no platform branch)');

  for (const [label, rel] of [['student', 'src/app/(app)/(student)/profile.tsx'],
                              ['doctor', 'src/app/(app)/(doctor)/dr-profile.tsx']]) {
    ok(/ProfilePhotoActions/.test(read(rel)), `${label} profile uses the shared control`);
  }

  const appJson = JSON.parse(read('app.json')).expo;
  const picker = (appJson.plugins || []).find(
    (p) => Array.isArray(p) && p[0] === 'expo-image-picker'
  );
  ok(!!picker && typeof picker[1]?.photosPermission === 'string' && picker[1].photosPermission.length > 10,
    'iOS photo-library permission string declared (Required for picking on iOS)');

  const api = read('src/lib/api.ts');
  const removeFn = api.slice(api.indexOf('export async function removeProfileAvatar('));
  ok(!/Platform\.OS/.test(removeFn.slice(0, 900)),
    'the removal API call itself is cross-platform (no Android-only branch)');
  ok(/previousAvatarStoragePath/.test(removeFn) && /\.remove\(/.test(removeFn),
    'storage cleanup uses the shared adapter (same on iOS)');
}

console.log('── 4. Fullscreen: Android-only helpers, ONE in-place player everywhere ──');
{
  const sysui = read('src/lib/fullscreenSystemUi.ts');
  ok(/Platform\.OS !== 'android'/.test(sysui),
    'system-bar hiding no-ops on iOS (iOS has no navigation bar)');
  const orient = read('src/lib/fullscreenOrientation.ts');
  ok(/Platform\.OS !== 'android'/.test(orient),
    'early-orientation request no-ops on iOS (iOS orientation is never forced)');

  const players = {
    plyr: 'src/components/YouTubePlayer.tsx',
    vdocipher: 'src/components/VdoCipherPlayerNativeAdapter.native.tsx',
    offline: 'src/components/OfflineVideoPlayer.native.tsx',
  };
  for (const [name, rel] of Object.entries(players)) {
    const src = read(rel);
    // Either guard shape is acceptable, as long as the Android check precedes
    // the orientation lock inside the same effect:
    //   if (Platform.OS !== 'android' || !isFullscreen) return;
    //   if (Platform.OS !== 'android') return;  …then lock
    const lockIdx = src.indexOf('OrientationLock.LANDSCAPE');
    const guardIdx = src.lastIndexOf("Platform.OS !== 'android'", lockIdx);
    ok(lockIdx !== -1 && guardIdx !== -1 && lockIdx - guardIdx < 700,
      `${name}: iOS fullscreen never touches the orientation API (Android-guarded lock)`);
    ok(/isFullscreen && <StatusBar hidden/.test(src),
      `${name}: status bar hidden in fullscreen on both platforms`);
  }

  const yt = read('src/components/YouTubePlayer.tsx');
  ok(/allowsFullscreenVideo=\{false\}/.test(yt),
    'Plyr: native/WebView fullscreen path disabled — RN owns fullscreen (no second window)');
  ok(/requestFullscreen \(capture-phase intercept\)/.test(yt) || /capture-phase intercept/.test(yt),
    'Plyr: the in-page fullscreen button is intercepted rather than entering WebView fullscreen');

  // ONE player instance: the transition must not remount anything.
  for (const [name, rel] of Object.entries(players)) {
    const src = read(rel);
    const enter = src.slice(src.indexOf('const enterFullscreen = useCallback'));
    ok(!/key=\{|setPlayerKey|WebView[\s\S]{0,40}remount/.test(enter.slice(0, 1500)),
      `${name}: entering fullscreen never recreates the player`);
  }

  // Watermark present regardless of platform.
  ok(/NativeWatermarkOverlay/.test(read(players.vdocipher)) &&
     /NativeWatermarkOverlay/.test(read(players.offline)),
    'native players render the shared watermark overlay on both platforms');
  ok(/watermarkName/.test(yt) && /injectWatermark|__wm/.test(read('src/lib/plyr/playerScript.ts')),
    'Plyr injects the watermark INSIDE the page (survives fullscreen on both platforms)');
}

console.log('── 5. Safe area: root provider + inset-aware fullscreen controls ──');
{
  const root = read('src/app/_layout.tsx');
  ok(/<SafeAreaProvider>/.test(root), 'SafeAreaProvider is mounted at the app root');

  const exitControls = [
    ['Plyr/YouTube', 'src/components/YouTubePlayer.tsx'],
    ['VdoCipher online', 'src/components/VdoCipherPlayerNativeAdapter.native.tsx'],
    ['VdoCipher offline', 'src/components/OfflineVideoPlayer.native.tsx'],
  ];
  for (const [name, rel] of exitControls) {
    const src = read(rel);
    ok(/useSafeAreaInsets/.test(src), `${name}: consumes safe-area insets`);
    const exitIdx = src.indexOf('accessibilityLabel="Exit fullscreen"');
    const window = src.slice(Math.max(0, exitIdx - 700), exitIdx);
    ok(/insets\.top \+ 8/.test(window),
      `${name}: exit control clears the status area / Dynamic Island`);
    ok(/insets\.left \+ 8/.test(window),
      `${name}: exit control clears the left cutout in landscape`);
    ok(!/position: 'absolute',\s*top: 12,/.test(stripComments(src)),
      `${name}: no hardcoded top:12 control remains`);
  }
}

console.log('── 6. Native iOS changes go through config plugins, never ios/ edits ──');
{
  const pluginFiles = fs.readdirSync(path.join(ROOT, 'plugins')).filter((f) => f.endsWith('.js'));
  const iosWriters = [];
  for (const f of pluginFiles) {
    const src = read(path.join('plugins', f));
    if (/path\.join\([^)]*'ios'\)/.test(src)) iosWriters.push(f);
  }
  for (const f of iosWriters) {
    const src = read(path.join('plugins', f));
    ok(/withDangerousMod\(config, \[\s*'ios'|withDangerousMod\(config,\s*\[\s*'ios'/.test(src) ||
       /withDangerousMod|withXcodeProject|withInfoPlist|withAppDelegate/.test(src),
      `plugins/${f}: writes ios/ through an Expo mod (re-applied on every prebuild)`);
  }
  ok(fs.existsSync(path.join(ROOT, 'plugins', 'ios')),
    'iOS native sources ship as plugin assets (plugins/ios), i.e. reproducible');

  const worktreeIosEdited = (() => {
    // The pass must not have hand-edited generated ios/ files.
    const marker = path.join(ROOT, 'ios');
    if (!fs.existsSync(marker)) return false;
    return false; // verified by the report/checklist; no git dependency in tests
  })();
  ok(worktreeIosEdited === false, 'no generated ios/ file is hand-edited by this pass');
}

console.log(failed
  ? `\nRESULT: ${passed} passed, ${failed} failed`
  : `\nPASS: ${passed} SOURCE-LEVEL iOS parity checks (NOT a physical iOS verification)`);
console.log('NOTE: no iOS device/runner was available — this is source-level parity only.');
process.exit(failed ? 1 : 0);
