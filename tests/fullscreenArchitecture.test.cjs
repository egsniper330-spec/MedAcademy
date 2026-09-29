'use strict';
/**
 * Guard tests — fullscreen rotation black-screen fix + duplicate watermark fix.
 *
 * PIN 1 — Single-instance in-place fullscreen (rotation black-screen root cause):
 *   The previous architecture mounted a SECOND player surface inside a React
 *   Native <Modal>. A Modal is a second native window/dialog; on rotation its
 *   surface is torn down and recreated around a live decoder session while the
 *   duplicate instance re-initialises DRM → black video with live audio.
 *   The correct architecture (now pinned): ONE player instance whose container
 *   toggles inline ↔ absolute-fill. Pinned for all three players:
 *     - VdoCipherPlayerNativeAdapter.native.tsx (VdoCipher online)
 *     - OfflineVideoPlayer.native.tsx           (VdoCipher offline)
 *     - YouTubePlayer.tsx                       (Plyr / WebView)
 *   and the lesson screen's pinned-player layout (player as direct child of
 *   the screen root so absolute-fill covers the whole screen).
 *
 * PIN 2 — Exactly one watermark renderer, canonical label only:
 *   The duplicate "User\nID: MED-####" watermark was produced SERVER-SIDE by
 *   VdoCipherService::buildAnnotate() burning a stream annotation into the
 *   video. It is removed; the canonical client overlay "User • MED-####"
 *   (watermarkIdentity.resolveWatermarkIdentity) is the single source.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }

/* ───────────────────────── PIN 1: fullscreen architecture ───────────────── */

const ONLINE_ADAPTER = 'src/components/VdoCipherPlayerNativeAdapter.native.tsx';
const OFFLINE_PLAYER = 'src/components/OfflineVideoPlayer.native.tsx';
const PLYR_PLAYER    = 'src/components/YouTubePlayer.tsx';
const LESSON         = 'src/app/(app)/lesson/[id].tsx';

console.log('── No Modal/second native window in any fullscreen-capable player ──');
for (const p of [ONLINE_ADAPTER, OFFLINE_PLAYER, PLYR_PLAYER]) {
  const s = read(p);
  // No RN Modal may be used to host the player surface in these files.
  ok(!/<Modal[\s>]/.test(s), `${p}: must not mount a <Modal> (second native window → rotation black screen)`);
}

console.log('── Online VdoCipher adapter: ONE native player instance, in-place ──');
{
  const s = read(ONLINE_ADAPTER);
  ok((s.match(/<VdoPlayerView/g) || []).length === 1,
    'VdoCipherPlayerNativeAdapter.native.tsx: exactly one <VdoPlayerView> JSX mount');
  ok(/isFullscreen/.test(s) && /position:\s*'absolute'/.test(s),
    'online adapter: fullscreen toggles the container style in place (absolute-fill)');
  // The instance must NOT be remounted on fullscreen change: no `key=` derived
  // from isFullscreen, no conditional mount around <VdoPlayerView>.
  ok(!/key=\{[^}]*isFullscreen/.test(s), 'online adapter: player key must not depend on isFullscreen');
  {
    // The player itself must never sit behind a mount-time conditional —
    // `{isFullscreen && <VdoPlayerView …>` / ternary mounting would unmount
    // and remount the decoder surface on every toggle (siblings like
    // `{isFullscreen && <StatusBar/>}` are fine).
    ok(!/isFullscreen\s*&&\s*<VdoPlayerView/.test(s), 'online adapter: no mount-time conditional around <VdoPlayerView> (&&)');
    ok(!/isFullscreen\s*\?\s*<VdoPlayerView/.test(s), 'online adapter: no mount-time conditional around <VdoPlayerView> (ternary)');
    // The mount must instead live inside a style-toggled container.
    ok(/style=\{isFullscreen\s*\?/.test(s), 'online adapter: player container style toggles inline ↔ fullscreen');
  }
  ok(/expo-screen-orientation/.test(s), 'online adapter: orientation locking used for fullscreen (Android path)');
  ok(/shouldAllowFullscreen/.test(s), 'online adapter: security gate re-validated at fullscreen entry');
}

console.log('── iOS fullscreen contract: ONE control, NO forced landscape, no second presentation ──');
for (const p of [ONLINE_ADAPTER, OFFLINE_PLAYER]) {
  const s = read(p);

  // (1) Exactly ONE enter control: the SDK control-bar button (both platforms
  // since bridge 2.9.4) via onEnterFullscreen. The app must NOT render its own
  // duplicate enter button (the old Maximize2 overlay created a second
  // fullscreen system → two opposite buttons + split-screen UI).
  ok(!/Maximize2/.test(s), `${p}: no app-level duplicate enter-fullscreen button (Maximize2 removed)`);
  ok(!/accessibilityLabel="Enter fullscreen"/.test(s), `${p}: no second "Enter fullscreen" control rendered by the app`);
  ok(/onEnterFullscreen=\{/.test(s), `${p}: SDK fullscreen event is mapped into the app state (single control path)`);

  // (2) iOS NEVER calls any orientation API — Portrait stays Portrait,
  // Landscape stays Landscape, system Rotation Lock is never overridden.
  // Structural pin: every lockAsync call must sit behind the Android guard.
  const guards = (s.match(/Platform\.OS !== 'android'/g) || []).length;
  ok(guards >= 1, `${p}: orientation locks are Android-gated (iOS never locked)`);
  const firstLock = s.indexOf('ScreenOrientation.lockAsync');
  const lastGuardBeforeLock = s.lastIndexOf("Platform.OS !== 'android'", firstLock);
  ok(firstLock === -1 || (lastGuardBeforeLock !== -1 && s.indexOf('useEffect', Math.max(0, lastGuardBeforeLock - 200)) < firstLock),
    `${p}: no lockAsync is reachable on iOS (guard precedes every lock)`);
  ok(!/unlockAsync/.test(s), `${p}: no unlockAsync (no forced-rotation bypass)`);

  // (3) ONE fullscreen state — no parallel native/modal fullscreen systems.
  ok((s.match(/useState\(false\)/g) || []).length >= 1 && /isFullscreen/.test(s), `${p}: single isFullscreen state`);
  ok(!/nativeFullscreen|modalFullscreen|isNativeFullscreen/.test(s), `${p}: no parallel native/modal fullscreen state`);

  // (4) No native second presentation: enterFullscreenV2 must never be called
  // (it drives the SDK's own enterFullscreen() → a second fullscreen system
  // racing the app's in-place expansion).
  ok(!/enterFullscreenV2/.test(s), `${p}: enterFullscreenV2 never called (no second native presentation)`);

  // (5) Safe-area exit control (never under the Dynamic Island / status area).
  ok(/insets\.top/.test(s), `${p}: fullscreen exit control offset respects safe-area insets`);

  // (6) Same player through the transition (style-toggled container, no remount).
  ok((s.match(/<VdoPlayerView/g) || []).length === 1 && !/key=\{[^}]*isFullscreen/.test(s),
    `${p}: ONE VdoPlayerView, never remounted by fullscreen state`);
}

console.log('── Responsive rotation: NO forced orientation on iOS, OS-driven rotation allowed ──');
{
  // (1) app.json pins the iPhone supported orientations via ios.infoPlist —
  // this wins over the abstract "orientation" property in Expo's prebuild
  // (createInfoPlistPluginWithPropertyGuard respects an explicit infoPlist
  // value and only warns). Portrait-only made the app UNABLE to rotate even
  // with Rotation Lock off — the stuck-portrait root cause.
  const appJson = JSON.parse(read('app.json'));
  const orients = appJson.expo?.ios?.infoPlist?.UISupportedInterfaceOrientations;
  ok(Array.isArray(orients) && orients.includes('UIInterfaceOrientationLandscapeLeft') && orients.includes('UIInterfaceOrientationLandscapeRight'),
    'app.json: iPhone supports landscape orientations (responsive rotation possible at all)');
  ok(orients.includes('UIInterfaceOrientationPortrait'), 'app.json: portrait still supported (entering fullscreen never rotates)');
  ok(appJson.expo.orientation === 'portrait', 'app.json: abstract orientation stays portrait (Android + iPad unaffected)');

  // (2) No player may force a rotation on iOS. Structural pin: every
  // lockAsync must be guarded by Platform.OS !== 'android' (or unconditional
  // Android-only restore semantics), and NO fullscreen enter path may lock
  // LANDSCAPE unconditionally.
  for (const p of [ONLINE_ADAPTER, OFFLINE_PLAYER, PLYR_PLAYER]) {
    const s = read(p);
    if (!/ScreenOrientation/.test(s)) continue; // fully responsive player
    const firstLock = s.indexOf('ScreenOrientation.lockAsync');
    const guard = s.lastIndexOf("Platform.OS !== 'android'", firstLock);
    ok(guard !== -1 && guard < firstLock, `${p}: every orientation lock is Android-gated (iOS never locked)`);
  }

  // (3) No player forces landscape on iOS by any other means: no
  // unlockAsync (forced-rotation bypass) anywhere.
  for (const p of [ONLINE_ADAPTER, OFFLINE_PLAYER, PLYR_PLAYER]) {
    ok(!/unlockAsync/.test(read(p)), `${p}: no unlockAsync (no forced rotation)`);
  }

  // (4) The online + offline players keep pure style-toggled containers —
  // the SAME instance re-measures when the OS rotates (no remount, no
  // Modal, no second window).
  for (const p of [ONLINE_ADAPTER, OFFLINE_PLAYER]) {
    const s = read(p);
    ok(/FULLSCREEN_STYLE|position: 'absolute'/.test(s) && !/key=\{[^}]*isFullscreen/.test(s),
      `${p}: absolute-fill container is style-toggled (rotation only re-measures)`);
  }

  // (5) Android Plyr contract: LANDSCAPE while fullscreen, PORTRAIT_UP
  // restored on exit (Android-gated only).
  {
    const s = read(PLYR_PLAYER);
    ok(/Platform\.OS !== 'android' \|\| !isFullscreen/.test(s), 'Plyr: orientation effect Android-gated');
    ok(/OrientationLock\.LANDSCAPE/.test(s) && /OrientationLock\.PORTRAIT_UP/.test(s), 'Plyr: Android landscape contract with PORTRAIT_UP restore');
  }
}

console.log('── Offline VdoCipher player: ONE native player instance, in-place ──');
{
  const s = read(OFFLINE_PLAYER);
  ok((s.match(/<VdoPlayerView/g) || []).length === 1,
    'OfflineVideoPlayer.native.tsx: exactly one <VdoPlayerView> JSX mount');
  ok(!/key=\{[^}]*isFullscreen/.test(s), 'offline player: player key must not depend on isFullscreen');
  ok(/shouldAllowFullscreen/.test(s) || /fullscreenGate|checkBeforeVideo/.test(s),
    'offline player: fullscreen remains gated');
  ok(/Enter fullscreen|enterFullscreen/.test(s),
    'offline player: app-level fullscreen entry control (iOS parity)');
}

console.log('── Plyr/YouTube player: ONE WebView instance, in-place fullscreen ──');
{
  const s = read(PLYR_PLAYER);
  // Count JSX mounts only: a mount is `<WebView` at end-of-line (props on the
  // following lines). This excludes the `useRef<WebView>` type parameter and
  // the header comment.
  ok((s.match(/<WebView\s*$/gm) || []).length === 1,
    'YouTubePlayer.tsx: exactly one <WebView> JSX mount (no second modal WebView)');
  ok(!/modalHtml/.test(s), 'YouTubePlayer.tsx: old modal-only HTML document removed');
  ok(!/key=\{[^}]*isFullscreen/.test(s), 'YouTubePlayer.tsx: WebView key must not depend on isFullscreen');
  // RESUME-LATCH pin: the WebView source identity must never change mid-session
  // (an identity change reloads the WebView — blank surface + position reset).
  // Both sub-components latch resumePosition to its initial value and the memo
  // deps exclude it.
  ok(/resumePosition: initialResume/.test(s), 'YouTubePlayer.tsx: resumePosition is latched to its initial value');
  ok(/resumeLatched\.current/.test(s), 'YouTubePlayer.tsx: player source uses the latched resume value');
  ok(!/resumeAt:\s*resumePosition/.test(s), 'YouTubePlayer.tsx: playerHtml memo no longer consumes the moving prop');
  ok(/isFullscreen/.test(s) && /position:\s*'absolute'/.test(s),
    'YouTubePlayer.tsx: fullscreen toggles the WebView container in place');
}

console.log('── Lesson screen: pinned-player layout (fullscreen covers the screen) ──');
{
  const s = read(LESSON);
  ok((s.match(/<VideoPlayer/g) || []).length === 1,
    'lesson: exactly one <VideoPlayer> mount (no duplicate player for fullscreen)');
  ok(/isPinnedPlayer/.test(s), 'lesson: pinned-player layout branch exists');
  // The player must be a direct child of the screen root (not inside the
  // ScrollView): the player JSX appears BEFORE the first <ScrollView> and the
  // ScrollViews are rendered after/inside the pinned branch.
  const playerIdx = s.indexOf('<VideoPlayer');
  const scrollIdx  = s.indexOf('<ScrollView');
  ok(playerIdx !== -1 && scrollIdx !== -1 && playerIdx < scrollIdx,
    'lesson: <VideoPlayer> is rendered outside (before) any <ScrollView>');
  ok(!/fullscreen Modal/i.test(s), 'lesson: stale "fullscreen Modal" references removed');

  // SPLIT-SCREEN FIX pin: the absolute-fill style is applied at the HOST
  // ancestor (the player's direct-parent NeuCard) — Yoga positions absolute
  // children against their DIRECT parent, so expanding only the adapter's own
  // container would fill just the 16:9 card (header + card + black void).
  ok(/position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 110/.test(s),
    'lesson: player host card receives the absolute-fill style when fullscreen (split-screen fix)');
  // WATERMARK LAYERING pin: the fullscreen content ScrollView must sit at a
  // STRICTLY LOWER z than the player host card. An equal-zIndex sibling tie
  // let the opaque content layer paint OVER the player container — the video
  // stayed visible (native layer wins) but the RN watermark overlay was
  // buried → "watermark disappears in fullscreen". Both fullscreen
  // ScrollViews must carry zIndex 10 (or lower).
  {
    const sv = s.match(/<ScrollView[\s\S]{0,400}?style=\{isFullscreen\s*\?[^}]*\}/g) || [];
    ok(sv.length >= 2, 'lesson: both fullscreen ScrollViews found for the z-order pin');
    for (const block of sv) {
      const m = block.match(/zIndex:\s*(\d+)/);
      ok(m && parseInt(m[1], 10) < 110, `lesson: fullscreen content layer z (${m ? m[1] : 'none'}) < player host z 110 (watermark must stay above content)`);
    }
  }
  // The host expansion is style-only: content stays mounted (hidden via
  // conditional JSX is NOT allowed for the player itself — only the header
  // row is conditionally rendered, which does not contain the player).
  ok(/scrollEnabled=\{!isFullscreen\}/.test(s),
    'lesson: scroll frozen while fullscreen (style-only host expansion, no remount)');
}

console.log('── Props plumbing: gate + onFullscreen forwarded through wrappers ──');
{
  const vdo = read('src/components/VdoCipherPlayer.tsx');
  const vp  = read('src/components/VideoPlayer.tsx');
  ok(/shouldAllowFullscreen/.test(vdo), 'VdoCipherPlayer: forwards shouldAllowFullscreen');
  ok(/shouldAllowFullscreen/.test(vp),  'VideoPlayer: forwards shouldAllowFullscreen');
  ok(!/fullscreen Modal/i.test(vdo) && !/fullscreen Modal/i.test(vp),
    'wrapper docs no longer reference the removed fullscreen Modal');
}

/* ───────────────────────── PIN 2: watermark single source ───────────────── */

console.log('── Duplicate server-side watermark renderer removed ──');
{
  const svc = read('backend/src/Video/VdoCipherService.php');
  // The method is gone; only its removal NOTE (a comment) may remain.
  ok(!/function\s+buildAnnotate/.test(svc), 'VdoCipherService.php: buildAnnotate() method removed (stream-burned "ID: MED-####" watermark)');
  ok(!/'annotate'\s*=>/.test(svc), 'VdoCipherService.php: no annotate payload composed into any OTP options');
  ok(!/ID:\s*["'\.]/.test(svc), 'VdoCipherService.php: no "ID: " label composed anywhere');
}

console.log('── Canonical client watermark intact in every player ──');
{
  const ident = read('src/lib/watermarkIdentity.ts');
  ok(/•/.test(ident), 'watermarkIdentity: canonical "Name • MED-####" label format');
  ok(/resolveWatermarkIdentity/.test(ident), 'watermarkIdentity: resolver export present');

  for (const p of [ONLINE_ADAPTER, OFFLINE_PLAYER]) {
    const s = read(p);
    ok(/resolveWatermarkIdentity|NativeWatermarkOverlay/.test(s),
      `${p}: renders the canonical overlay via watermarkIdentity`);
  }
  const plyr = read(PLYR_PLAYER);
  ok(/•/.test(plyr) || /watermarkLabel|watermark/.test(plyr.toLowerCase()),
    'Plyr/YouTube player: canonical watermark overlay present');
  // No player composes the old "ID:" label client-side either.
  for (const p of [ONLINE_ADAPTER, OFFLINE_PLAYER, PLYR_PLAYER]) {
    ok(!/ID:\s*MED|'ID:|`ID:|"ID:/.test(read(p)), `${p}: no legacy "ID: MED-####" label produced`);
  }
}

console.log('── No fake visual suppression of the old watermark ──');
{
  // The old renderer must be REMOVED, not hidden with opacity:0.
  for (const p of [ONLINE_ADAPTER, OFFLINE_PLAYER]) {
    const s = read(p);
    const suppressed = s.match(/opacity:\s*0[\s,}][^\n]*\n[^\n]*(MED|watermark|Watermark)/);
    ok(!suppressed, `${p}: old watermark is removed, not opacity-hidden`);
  }
}

console.log('── Security surfaces untouched ──');
{
  ok(exists('src/components/RecordingBlockedOverlay.tsx'), 'RecordingBlockedOverlay still present');
  ok(exists('src/app/(app)/security-gate.tsx'), 'security-gate screen still present');
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  ok(/configChanges=[^>]*orientation/.test(manifest) && /configChanges=[^>]*screenSize/.test(manifest),
    'Android manifest: activity survives rotation (in-place fullscreen prerequisite)');
  ok(/FLAG_SECURE|setFlags/.test(read('src/lib/nativeSecurity.ts') || '') ||
     exists('src/lib/nativeSecurity.ts'), 'native security lib present');
}

console.log('── DEV player-session observability: ONE mounted VdoPlayer invariant ──');
{
  const SESSION = 'src/lib/vdoPlayerSession.ts';
  ok(exists(SESSION), 'vdoPlayerSession.ts: dev-only mount counter exists');
  const ss = read(SESSION);
  ok(/__DEV__/.test(ss), 'vdoPlayerSession: counters are dev-only no-ops in release builds');
  ok(/playerSessionMount/.test(ss) && /playerSessionUnmount/.test(ss), 'vdoPlayerSession: mount/unmount API present');
  const on = read(ONLINE_ADAPTER);
  const off = read(OFFLINE_PLAYER);
  ok(/VdoSessionScope/.test(on), 'online adapter: real player tree wrapped in a session scope');
  ok(/VdoSessionScope/.test(off), 'offline player: real player tree wrapped in a session scope');
  // Scopes must wrap the ACTUAL player render (after early-exit loading/error
  // paths), not the component mount — otherwise loading states inflate counts.
  ok(on.indexOf('function VdoSessionScope') < on.indexOf('<VdoSessionScope tag'), 'online adapter: scope defined before use');
  ok(off.indexOf('function VdoSessionScope') < off.indexOf('<VdoSessionScope tag'), 'offline player: scope defined before use');
  // The lesson screen must unmount the ONLINE player on blur so offline
  // playback never starts with a second live native player (6120 evidence).
  const lesson = read(LESSON);
  ok(/useFocusEffect[\s\S]{0,220}setPlayerVisible\(false\)/.test(lesson),
    'lesson: online player unmounts on screen blur (no second live VdoPlayer during offline playback)');
}

console.log('──────────────────────────────────────────────');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
