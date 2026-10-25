#!/usr/bin/env node
/**
 * VdoCipher player — single-initialisation (6120) and offline recovery.
 *
 * Run: node tests/vdoPlayerSingleInitAnd6120.test.cjs   (part of `npm test`)
 *
 * THE FAILURE THAT WAS REPORTED
 * ─────────────────────────────
 * Offline playback showed VdoCipher error 6120 ("Renderer Error"). VdoCipher's
 * official error table (https://www.vdocipher.com/docs/mobile/android/error-codes/)
 * documents 6120 as a renderer/decoder failure that is "much more common" when
 * more than one VdoPlayer is initialised/active at a time, and recommends
 * releasing players properly. It is NOT the documented expired-license error —
 * that is 6187.
 *
 * ROOT CAUSE FOUND IN THE BRIDGE
 * ──────────────────────────────
 * vdocipher-rn-bridge's Android `ReactVdoPlayerUIViewManagerImpl#setEmbedInfo`
 * does not diff its input: every time React hands it an object it rebuilds
 * VdoInitParams and calls `vdoPlayer.load(params)` again
 * (node_modules/vdocipher-rn-bridge/android/src/main/java/com/vdocipher/rnbridge/
 *  ReactVdoPlayerUIViewManagerImpl.java → `vdoPlayerView.load(initParams)`).
 *
 * Both adapters passed an INLINE object literal, so every state change on the
 * screen (loading flag, watermark flags, fullscreen, ready flag, error) produced
 * a new object and a fresh `load()` — i.e. repeated player initialisations over
 * the same live session. Memoising the payload makes the native side initialise
 * exactly once per session.
 *
 * This suite also pins the offline license contract that offline playback
 * depends on (canPersist + rentalDuration) and the new one-tap retry path.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ok    ' + name);
  } else {
    failed++;
    console.error('  FAIL  ' + name + (detail ? ` — ${detail}` : ''));
  }
}

const ONLINE = 'src/components/VdoCipherPlayerNativeAdapter.native.tsx';
const OFFLINE = 'src/components/OfflineVideoPlayer.native.tsx';
const online = stripComments(read(ONLINE));
const offline = stripComments(read(OFFLINE));

/* ───────────────────── the bridge really does re-load ──────────────────── */

console.log('\nBridge behaviour this fix is based on');
const bridgeManager = read(
  'node_modules/vdocipher-rn-bridge/android/src/main/java/com/vdocipher/rnbridge/ReactVdoPlayerUIViewManagerImpl.java',
);
ok('setEmbedInfo builds init params and calls load() unconditionally',
  /public void setEmbedInfo\(/.test(bridgeManager) && /vdoPlayerView\.load\(initParams\)/.test(bridgeManager));
ok('load() forwards straight to VdoPlayer.load (a full re-initialisation)',
  /public void load\(VdoInitParams params\)[\s\S]{0,200}vdoPlayer\.load\(params\)/.test(
    read('node_modules/vdocipher-rn-bridge/android/src/main/java/com/vdocipher/rnbridge/ReactVdoPlayerUIView.java'),
  ));

/* ─────────────────────── stable embedInfo (the fix) ────────────────────── */

console.log('\nOnline adapter: one initialisation per session');
ok('embedInfo is memoised', /const embedInfo = useMemo\(/.test(online));
ok('it depends only on the OTP + playback info',
  /useMemo\(\s*\(\) => \(\{ otp: otp \?\? '', playbackInfo: playbackInfo \?\? '', enableAutoResume: true \}\),\s*\[otp, playbackInfo\]/.test(online));
ok('the memoised object is what the native view receives',
  /embedInfo=\{embedInfo\}/.test(online));
ok('no inline embedInfo literal remains (it re-loaded the player every render)',
  !/embedInfo=\{\{/.test(online));
ok('one player view per session', (online.match(/<VdoPlayerView\b/g) || []).length === 1);

console.log('\nOffline player: one initialisation per downloaded video');
ok('offlineEmbedInfo is memoised on the media id',
  /const offlineEmbedInfo = useMemo\(\s*\(\) => \(\{ offline: true as const, mediaId: entry\.meta\.mediaId \}\),\s*\[entry\.meta\.mediaId\]/.test(offline));
ok('the memoised object is passed to the native view', /embedInfo=\{offlineEmbedInfo\}/.test(offline));
ok('no inline offline embedInfo literal remains', !/embedInfo=\{\{/.test(offline));
ok('one player view per session', (offline.match(/<VdoPlayerView\b/g) || []).length === 1);
ok('the memo is declared before the first early return (hook order is stable)',
  offline.indexOf('const offlineEmbedInfo = useMemo(') < offline.indexOf('if (expired) {'));

/* ───────────────────────────── 6120 recovery ───────────────────────────── */

console.log('\n6120 recovery path');
ok('the failed player is retried with a fresh native instance',
  /const \[playerAttempt, setPlayerAttempt\] = useState\(0\)/.test(offline) &&
  /key=\{`vdo-offline-\$\{entry\.meta\.mediaId\}-\$\{playerAttempt\}`\}/.test(offline));
ok('retry clears the error, the ready flag and bumps the attempt',
  /const retryPlayback = useCallback\(\(\) => \{[\s\S]{0,160}setError\(null\);[\s\S]{0,80}setReady\(false\);[\s\S]{0,80}setPlayerAttempt\(\(a\) => a \+ 1\);/.test(offline));
ok('the error surface offers the retry action', /actionLabel=\{error\.expired \? undefined : t\('common\.retry'\)\}/.test(offline));
ok('an expired rental is NEVER offered a retry (needs a new download)',
  /onAction=\{error\.expired \? undefined : retryPlayback\}/.test(offline));
ok('the error message component renders an optional action button',
  /function OfflinePlayerMessage\(\{[\s\S]{0,400}onAction/.test(offline) &&
  /onPress=\{onAction\}/.test(offline));
ok('6120 stays classified as a renderer error, not a licence expiry',
  /classifyOfflineLoadError\(code\)/.test(offline) &&
  /kind === 'renderer'/.test(offline) &&
  /kind === 'expired'/.test(offline));

/* ────────────────── offline license contract (unchanged) ───────────────── */

console.log('\nOffline DRM contract the download depends on');
const vdo = read('backend/src/Video/VdoCipherService.php');
ok('offline OTP requests a persistent licence (canPersist: true)',
  /'canPersist'\s*=>\s*true/.test(vdo));
ok('offline OTP carries a rental duration in seconds',
  /'rentalDuration'\s*=>\s*\$rentalHours \* 3600/.test(vdo));
ok('the app plays downloads through the official offline embedInfo (mediaId)',
  /offline: true as const, mediaId/.test(offline));

/* ───────────────────────── watermark motion parity ─────────────────────── */

console.log('\nWatermark layers');
const layers = stripComments(read('src/lib/watermarkLayers.ts'));
ok('exactly one watermark layer is chosen per session',
  /providerAnnotationVisible: true,\s*appOverlay: false/.test(layers) &&
  /appOverlay: true/.test(layers));
ok('the app layer (the only one that can animate) keeps continuous motion',
  /createWatermarkMotion/.test(stripComments(read('src/components/NativeWatermarkOverlay.tsx'))));
ok('the offline player renders the app watermark layer',
  /watermarkLayers\.appOverlay && \(/.test(offline));

/* ─────────────────────────────── summary ───────────────────────────────── */

console.log('\n──────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
