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

  // (1) Exactly ONE user-facing fullscreen ENTRY per platform.
  // Android: the SDK's own control-bar button is HIDDEN by the bridge (it runs
  // the SDK default fullscreen, which promotes the surface above the RN tree and
  // buries the watermark), so the app renders the single entry — and it MUST be
  // wired to the canonical in-place path. iOS: the SDK's own button stays the
  // single entry, so the app must not render a second one there.
  const enterControls = (s.match(/accessibilityLabel="Enter fullscreen"/g) || []).length;
  ok(enterControls === 1, `${p}: exactly ONE app-level enter-fullscreen control`);
  ok(/!isFullscreen && Platform\.OS === 'android' && \([\s\S]{0,400}Enter fullscreen/.test(s),
    `${p}: the app enter control is Android-only (iOS keeps the SDK button as its single entry)`);
  ok(/onPress=\{\(\) => void enterFullscreen\(\)\}/.test(s),
    `${p}: the app enter control calls the canonical enterFullscreen() (gated, in-place)`);
  // Exactly ONE rendered Maximize2 element (the single enter control) plus its
  // import — so 1 JSX usage, not 1 raw occurrence.
  ok((s.match(/<Maximize2\b/g) || []).length === 1, `${p}: exactly one rendered Maximize2 icon (the single enter control)`);
  ok(/import \{[^}]*\bMaximize2\b[^}]*\} from 'lucide-react-native'/.test(s),
    `${p}: Maximize2 icon imported from lucide-react-native`);
  ok(/onEnterFullscreen=\{/.test(s), `${p}: SDK fullscreen event still mapped into the app state (iOS path)`);

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
  // iOS BLACK-FRAME guard (audio-continues-video-gone class): the WebView must
  // stay COORDINATED through the fullscreen/rotation transition — never
  // remounted, never display:none'd, and always a live flex child of the
  // expanding container so its native frame never collapses to zero.
  ok(!/display:\s*['"]none['"]/.test(s), 'Plyr: WebView never hidden via display:none (surface-loss class)');
  ok(!/opacity:\s*0/.test(s), 'Plyr: WebView never faded via opacity:0 (surface-loss class)');
  ok(/style=\{\{ flex: 1, backgroundColor: '#000' \}\}/.test(s),
    'Plyr: WebView is a coordinated flex child of the fullscreen container (frame never zero-size)');
  // Web branch: the iframe key is the LATCHED src — stable identity across
  // pseudo-fullscreen and parent re-renders (no reload → no blank frame).
  ok(/key=\{src\}/.test(s), 'Plyr web: iframe key is the latched src (identity-stable)');
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
  // PIN UPDATED (explicit-pixel fullscreen fix): the card must expand to the
  // FULL SCREEN when fullscreen. Edge-anchored absolute-fill collapses to
  // height 0 when an ancestor transiently lays out at 0 during the
  // enter+rotate churn (measured doc=1331x0 → black frame / vanished
  // watermark). The fill now uses CONCRETE window dimensions, which are
  // ancestor-independent. top:0/left:0 + explicit width/height + zIndex 110.
  ok(/position: 'absolute', top: 0, left: 0, width: fsWin\.width, height: fsWin\.height, zIndex: 110/.test(s),
    'lesson: player host card receives explicit-pixel fullscreen fill (ancestor-collapse fix)');
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

console.log('── Native bridge patch: SDK fullscreen must never bury the RN watermark ──');
{
  const PATCH = 'patches/vdocipher-rn-bridge+2.0.1.patch';
  ok(exists(PATCH), 'vdocipher-rn-bridge 2.0.1 patch exists (source-controlled bridge fix)');
  const patch = read(PATCH);
  // ANDROID: the bridge's FullscreenActionListener returning false = "not
  // handled" → SDK DEFAULT fullscreen re-parents the video surface above the
  // whole React tree (watermark buried). The patch makes RN the owner.
  ok(patch.includes('ReactVdoPlayerUIView.java'), 'patch touches the Android new-arch player view');
  ok(patch.includes('-            return false;') && patch.includes('+            return true;'),
    'Android: SDK default fullscreen DISABLED — listener now reports "handled" (watermark stays above video)');
  // iOS: the embedded VdoPlayerViewController view must be re-framed on every
  // layout pass, or the video surface keeps its pre-rotation (portrait) frame.
  ok(patch.includes('RCTVdoPlayerUIView.swift') && patch.includes('override func layoutSubviews()'),
    'iOS: embedded player view re-framed on layout (video follows rotation)');
  ok(patch.includes('vcView.frame = self.bounds'),
    'iOS: re-frame target is the embedded VC view (portrait-locked surface fix)');
  // iOS offline: zero-quality assets must NEVER be cached (the poisoned-cache
  // "Tracks Not Found" defect) — evict + refuse-to-cache + stage telemetry.
  ok(patch.includes('AssetList.swift') && patch.includes('getVideoQualities().isEmpty'),
    'iOS offline: zero-quality assets are evicted / never cached');
  ok(patch.includes('VdoDownload.swift') && patch.includes('stage=get_video_qualities'),
    'iOS offline: get_video_qualities stage telemetry present (decisive evidence chain)');
  ok(patch.includes('stage=native_asset_init') && patch.includes('stage=native_asset_cache'),
    'iOS offline: asset-init/cache stage telemetry present');
  // No credentials in telemetry.
  ok(!patch.includes('playbackInfo:') || !/print\(.*(otp|playbackInfo|token)/i.test(patch.split('MEDACADEMY').join('')),
    'telemetry logs no credentials');
}

console.log('── Single fullscreen entry: the SDK\'s own fullscreen controls are hidden ──');
{
  // The app's canonical in-place fullscreen is the only path that keeps the
  // watermark visible, so the SDK's own fullscreen button must never be
  // reachable. Pins: the bridge hides BOTH of those controls surgically, the
  // hide ships inside the source-controlled patch, the patch still parses with
  // patch-package's own parser, and the app-level control remains the single
  // fullscreen ownership path.
  const BRIDGE =
    'node_modules/vdocipher-rn-bridge/android/src/main/java/com/vdocipher/rnbridge/ReactVdoPlayerUIView.java';
  const PATCH = 'patches/vdocipher-rn-bridge+2.0.1.patch';
  ok(exists(BRIDGE), 'bridge player view present (hide lives where the controls are created)');
  const b = read(BRIDGE);

  // (1) A real method that is actually invoked where the control bar is created.
  ok(/private\s+void\s+hideSdkFullscreenControls\s*\(/.test(b),
    'bridge: hideSdkFullscreenControls() exists (not a comment-only mention)');
  ok(/private\s+void\s+scheduleHideSdkFullscreenControls\s*\(/.test(b),
    'bridge: scheduleHideSdkFullscreenControls() exists so the hide can be re-armed');
  ok(/scheduleHideSdkFullscreenControls\(\)/.test(b),
    'bridge: the hide is invoked where the fragment/control bar is created');

  // (2) BOTH controls are handled, by their public resource ids.
  const enterRefs = (b.match(/vdo_enter_fullscreen/g) || []).length;
  const exitRefs  = (b.match(/vdo_exit_fullscreen/g) || []).length;
  ok(enterRefs >= 1 && exitRefs >= 1,
    `bridge: hides BOTH SDK fullscreen controls (enter id refs=${enterRefs}, exit id refs=${exitRefs})`);
  ok(/getId\(\) == enterId \|\| v\.getId\(\) == exitId/.test(b),
    'bridge: the visibility change is gated on the two fullscreen ids only');

  // (3) SURGICAL: exactly one GONE application site in the whole file, controls
  // explicitly kept enabled — play/seek/quality/captions are never touched.
  const goneSites = (b.match(/setVisibility\s*\(\s*View\.GONE\s*\)/g) || []).length;
  ok(goneSites === 1,
    `bridge: exactly ONE GONE site (the two fullscreen ids) — found ${goneSites}`);
  ok(/putBoolean\("showControls",\s*true\)/.test(b),
    'bridge: SDK control bar still enabled (hide is per-button, not showControls=false)');
  ok(!/showControls\s*=\s*false/.test(b),
    'bridge: never disables the whole SDK control bar');

  // (4) The hide ships in the source-controlled patch — a fresh install keeps it.
  const bridgePatch = read(PATCH);
  ok(exists(PATCH) && bridgePatch.includes('hideSdkFullscreenControls'),
    'source-controlled bridge patch carries the hide (survives a fresh install)');
  ok(bridgePatch.includes('vdo_enter_fullscreen') && bridgePatch.includes('vdo_exit_fullscreen'),
    'patch: hides BOTH SDK fullscreen ids');
  ok(/^\+.*setVisibility\(View\.GONE\)/m.test(bridgePatch),
    'patch: adds the GONE call itself (not just the method signature)');
  ok(/^\+.*scheduleHideSdkFullscreenControls\(\);/m.test(bridgePatch),
    'patch: wires the hide into fragment/control-bar creation');

  // (5) patch-package compatibility: standard unified diff with balanced,
  // node_modules-relative headers (what `patch -p1` / patch-package reads).
  const diffSections = (bridgePatch.match(/^diff --git a\/.+ b\/.+$/gm) || []);
  ok(diffSections.length === 4,
    `patch: exactly 4 file sections (1 Android + 3 iOS) — got ${diffSections.length}`);
  const minusHeaders = (bridgePatch.match(/^--- a\/node_modules\/vdocipher-rn-bridge\//gm) || []);
  const plusHeaders = (bridgePatch.match(/^\+\+\+ b\/node_modules\/vdocipher-rn-bridge\//gm) || []);
  ok(minusHeaders.length === 4 && plusHeaders.length === 4,
    `patch: balanced --- a/ +++ b/ headers on node_modules paths (-p1) — ${minusHeaders.length}/${plusHeaders.length}`);
  ok(/^@@/m.test(bridgePatch), 'patch: hunk headers present');
  // Parse it with patch-package's OWN parser — the exact code postinstall runs.
  ok(exists('node_modules/patch-package/dist/patch/parse.js'),
    'patch-package parser module available (postinstall dependency)');
  try {
    const { parsePatchFile } = require(path.join(ROOT, 'node_modules/patch-package/dist/patch/parse.js'));
    const parsed = parsePatchFile(bridgePatch);
    ok(Object.keys(parsed).length >= 4,
      `patch-package parser accepts the patch (${Object.keys(parsed).length} files parsed)`);
  } catch (e) {
    ok(false, `patch-package parser rejects the patch: ${e.message}`);
  }
  // Existing iOS portions must remain untouched by the Android hide work.
  for (const ios of ['ios/AssetList.swift', 'ios/RCTVdoPlayerUIView.swift', 'ios/VdoDownload.swift']) {
    ok(bridgePatch.includes(ios), `patch: iOS portion intact — ${ios}`);
  }

  // (6) The app control is the SOLE fullscreen ownership path: no direct native
  // fullscreen command that would bypass the canonical (gated, in-place) entry.
  const on = read(ONLINE_ADAPTER);
  const off = read(OFFLINE_PLAYER);
  ok(!/enterFullscreenV2|dispatchViewManagerCommand/.test(on + off),
    'players: no direct native fullscreen command (canonical enterFullscreen()/exitFullscreen() only)');
  ok((on.match(/accessibilityLabel="Enter fullscreen"/g) || []).length === 1,
    'online adapter: exactly ONE app-level fullscreen control');
  ok((off.match(/accessibilityLabel="Enter fullscreen"/g) || []).length === 1,
    'offline player: exactly ONE app-level fullscreen control');

  // (7) The watermark self-proof must NEVER run in production.
  ok(/debugProve=\{__DEV__\}/.test(on),
    'online adapter: debugProve wired to __DEV__ (no prove loop in release)');
  ok(!/debugProve=\{true\}/.test(on + off),
    'players: no hard-coded debugProve={true} left');
  const wmOverlay = read('src/components/NativeWatermarkOverlay.tsx');
  ok(/if \(!debugProve \|\| !__DEV__\) return;/.test(wmOverlay),
    'watermark: prove loop bails before scheduling in release builds (no interval, no measureInWindow)');
  ok(/debugProve = false/.test(wmOverlay),
    'watermark: debugProve defaults to off');
  ok(!/RELEASE_DIAG\s*=\s*true/.test(on + read('src/components/YouTubePlayer.tsx')),
    'release diagnostics dev-gated (RELEASE_DIAG=false — no console overhead in production)');
}

console.log('── Plyr fullscreen surface diagnostics + identity stability ──');
{
  const YT = 'src/components/YouTubePlayer.tsx';
  const yt = read(YT);
  for (const tag of ['PLYR_FS_ENTER', 'PLYR_FS_EXIT', 'PLYR_FS_ORIENTATION', 'PLYR_FS_WEBVIEW_FRAME']) {
    ok(yt.includes(tag), `Plyr: ${tag} diagnostic present (evidence chain, dev-only)`);
  }
  ok(/__DEV__/.test(yt), 'Plyr: diagnostics are dev-gated');
  // Black-frame prevention pins: source identity must be stable across the
  // fullscreen toggle (a source change reloads the WebView = blank surface).
  ok(/resumeLatched/.test(yt), 'Plyr: resumePosition latched (no mid-session html rebuild)');
  const web = read('src/components/YouTubePlayer.tsx');
  ok(web.includes('key={src}'), 'Plyr web: key pinned to stable src identity');
  // Surface-recovery architecture: in-page video nudge + host injection.
  const ps = read('src/lib/plyr/playerScript.ts');
  ok(ps.includes('__plyrSurfaceNudge') && ps.includes("querySelector('video')"),
    'Plyr: in-page video surface nudge present (compositor re-allocation without reload)');
  ok(/addEventListener\('resize'/.test(ps), 'Plyr: nudge auto-arms on in-page resize (fullscreen/rotation)');
  ok(yt.includes('__plyrSurfaceNudge'), 'Plyr: host injects the nudge after fullscreen/rotation settles');
  ok(yt.includes('rotationNudgeTimerRef'), 'Plyr: rotation-while-fullscreen nudge wired (timer cleaned up)');
}

console.log('── VdoCipher watermark geometry evidence chain ──');
{
  const ad = read('src/components/VdoCipherPlayerNativeAdapter.native.tsx');
  for (const tag of ['VDO_WM_FULLSCREEN_CONTAINER', 'VDO_WM_OVERLAY_FRAME']) {
    ok(ad.includes(tag), `VdoCipher: ${tag} geometry diagnostic present (dev-only)`);
  }
  // Watermark must remain INSIDE the fullscreen container (same hierarchy as
  // VdoPlayerView) — it is a sibling rendered after the player, before the
  // exit control, inside the SAME expanding View. This is the architecture
  // guarantee that the watermark can never be orphaned in a old hierarchy.
  const overlay = read('src/components/NativeWatermarkOverlay.tsx');
  ok(overlay.includes('onContainerLayout'), 'Watermark: container-layout hook exists for geometry evidence');
  ok(/position: 'absolute'/.test(overlay) && overlay.includes('pointerEvents="none"'),
    'Watermark: absolute-fill + pointerEvents none (over video, never intercepts controls)');
}

console.log('──────────────────────────────────────────────');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
