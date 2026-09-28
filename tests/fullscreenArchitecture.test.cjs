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
  ok(/expo-screen-orientation/.test(s), 'online adapter: orientation locking used for fullscreen');
  ok(/shouldAllowFullscreen/.test(s), 'online adapter: security gate re-validated at fullscreen entry');
  // App-level fullscreen control present (iOS had no SDK fullscreen button).
  ok(/aria-label="Enter fullscreen"|accessibilityLabel="Enter fullscreen"/.test(s) ||
     /Enter fullscreen/.test(s), 'online adapter: app-level Enter fullscreen control rendered');
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

console.log('──────────────────────────────────────────────');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
