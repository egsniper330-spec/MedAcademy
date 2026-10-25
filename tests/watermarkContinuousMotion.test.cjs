#!/usr/bin/env node
'use strict';
/**
 * watermarkContinuousMotion.test.cjs — does the VdoCipher watermark ACTUALLY
 * move continuously, or does the engine merely contain a bouncing algorithm?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * On a physical iPhone the app-layer watermark sat still for long stretches and
 * only "jumped" occasionally. The motion ENGINE was correct; the PLUMBING was
 * not:
 *
 *   1. The engine's step functions were plain JS. The frame callback that calls
 *      them is a Reanimated WORKLET on the UI thread, and a worklet may only
 *      call other worklets — so the step threw / was rejected and the mark
 *      never advanced.
 *   2. The frame callback read geometry from React refs
 *      (`containerWRef.current`). A worklet captures plain objects at creation
 *      time, so on the UI thread those were stale (0) — the loop bailed out on
 *      every frame. The mark only moved when `syncMotion()` re-projected it from
 *      the JS thread on a layout pass, which is exactly "stationary, then an
 *      occasional jump".
 *
 * This suite therefore measures BOTH halves:
 *   A. NUMERICALLY — 60 s of simulated frames at 60 fps and 30 fps against the
 *      real engine: every frame advances, direction changes repeatedly, the
 *      mark never leaves the video box, and no 2-second window is stationary.
 *   B. STRUCTURALLY — the step functions carry `'worklet'`, and the frame
 *      callback reads shared values instead of refs.
 *
 * Run: node tests/watermarkContinuousMotion.test.cjs   (also part of `npm test`)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  }
}
function section(title) {
  console.log('\n── ' + title + ' ──');
}

/* ──────────────────────── compile the real engine ─────────────────────── */

const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-motion-'));
try {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src/lib/watermarkMotion.ts'),
      '--outDir', BUILD,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
} catch (e) {
  console.error('tsc failed:\n' + (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''));
  process.exit(1);
}
const {
  createWatermarkMotion,
  stepWatermarkMotion,
  isWatermarkMotionInBounds,
  WM_MOTION_MAX_STEP_S,
} = require(path.join(BUILD, 'watermarkMotion.js'));

/* ───────────────────────── simulation helper ──────────────────────────── */

/**
 * Drive the engine for `seconds` at `fps`, recording what a viewer would see.
 * The rng is seeded (mulberry32) so the run is reproducible.
 */
function simulate({ seconds, fps, width, height, pillW, pillH, seed }) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const bounds = { width, height };
  const size = { width: pillW, height: pillH };
  let state = createWatermarkMotion(bounds, size, rng);
  const dt = 1 / fps;
  const frames = Math.round(seconds * fps);

  let pathLength = 0;
  let reflections = 0;
  let stationaryFrames = 0;
  let outOfBounds = 0;
  const samples = []; // one every 2 s — what the DEV heartbeat reports

  for (let i = 0; i < frames; i++) {
    const prev = state;
    state = stepWatermarkMotion(state, dt, bounds, size);
    const moved = Math.hypot(state.x - prev.x, state.y - prev.y);
    pathLength += moved;
    if (moved < 1e-6) stationaryFrames++;
    const flipped = Math.sign(prev.vx) !== Math.sign(state.vx) ||
      Math.sign(prev.vy) !== Math.sign(state.vy);
    if (flipped) reflections++;
    if (!isWatermarkMotionInBounds(state, bounds, size)) outOfBounds++;
    if ((i + 1) % (fps * 2) === 0) samples.push({ x: state.x, y: state.y });
  }

  return { state, pathLength, reflections, stationaryFrames, outOfBounds, samples, frames };
}

/* ─────────────── A. 60 seconds of continuous billiard motion ──────────── */

section('A. 60 seconds, phone player (390×219) with a 200×34 pill');
const phone = simulate({ seconds: 60, fps: 60, width: 390, height: 219, pillW: 200, pillH: 34, seed: 12345 });

ok('every frame advances the mark (no dead frame loop)',
  phone.stationaryFrames === 0, `${phone.stationaryFrames} stationary frames of ${phone.frames}`);
ok('the mark never leaves the video box',
  phone.outOfBounds === 0, `${phone.outOfBounds} out-of-bounds frames`);
ok('it travels a visible distance (>= 1200 px in 60 s)',
  phone.pathLength >= 1200, `${phone.pathLength.toFixed(0)} px`);
ok('it changes direction repeatedly (>= 6 wall reflections)',
  phone.reflections >= 6, `${phone.reflections} reflections`);

// The defect the user described: long stationary stretches. Every 2 s sample
// must differ from the previous one by a visible amount.
let stalledSamples = 0;
for (let i = 1; i < phone.samples.length; i++) {
  const d = Math.hypot(phone.samples[i].x - phone.samples[i - 1].x, phone.samples[i].y - phone.samples[i - 1].y);
  if (d < 10) stalledSamples++;
}
ok('no 2-second window is stationary (< 10 px of travel)', stalledSamples === 0,
  `${stalledSamples} stalled windows`);
ok('all 30 two-second samples are inside the video box',
  phone.samples.every((p) => p.x >= 0 && p.x <= 390 - 200 && p.y >= 0 && p.y <= 219 - 34));

section('B. frame-rate independence (30 fps vs 60 fps)');
const phone30 = simulate({ seconds: 60, fps: 30, width: 390, height: 219, pillW: 200, pillH: 34, seed: 12345 });
ok('30 fps also moves on every frame', phone30.stationaryFrames === 0);
ok('30 fps stays in bounds', phone30.outOfBounds === 0);
const ratio = phone30.pathLength / phone.pathLength;
ok('the same trajectory is travelled at half the frame rate (within 15 %)',
  ratio > 0.85 && ratio < 1.15, `ratio ${ratio.toFixed(3)}`);
ok('a stalled frame cannot tunnel the mark out of the box (step clamp = ' +
  WM_MOTION_MAX_STEP_S + ' s)',
  (() => {
    const b = { width: 390, height: 219 };
    const sz = { width: 200, height: 34 };
    let st = createWatermarkMotion(b, sz, () => 0.5);
    for (let i = 0; i < 20; i++) {
      st = stepWatermarkMotion(st, 10, b, sz); // 10 s "frame" repeatedly
      if (!isWatermarkMotionInBounds(st, b, sz)) return false;
    }
    return true;
  })());

section('C. fullscreen / rotation re-projects without leaving the box');
const small = simulate({ seconds: 5, fps: 60, width: 390, height: 219, pillW: 200, pillH: 34, seed: 7 });
ok('a landscape box (844×390) still contains the mark after a resize',
  isWatermarkMotionInBounds(small.state, { width: 844, height: 390 }, { width: 200, height: 34 }));
ok('a tablet box (1024×640) still contains the mark',
  isWatermarkMotionInBounds(small.state, { width: 1024, height: 640 }, { width: 200, height: 34 }));

/* ─────────────────── D. the plumbing that made it freeze ──────────────── */

section('D. wiring: the UI-thread frame loop can actually run the step');
const engine = stripComments(read('src/lib/watermarkMotion.ts'));
const overlay = stripComments(read('src/components/NativeWatermarkOverlay.tsx'));

ok('the step function is a worklet (callable from the UI thread)',
  /export function stepWatermarkMotion\([\s\S]{0,400}'worklet';/.test(engine));
ok('its helpers are worklets too (a worklet may only call worklets)',
  /function advanceAxis\([\s\S]{0,400}'worklet';/.test(engine) &&
  /const clamp = \([\s\S]{0,120}'worklet';/.test(engine) &&
  /function maxCoord\([\s\S]{0,120}'worklet';/.test(engine));
ok('the frame callback is a worklet',
  /useFrameCallback\(\(info\) => \{\s*'worklet';/.test(overlay));
ok('the callback advances the motion every frame',
  /stepWatermarkMotion\(/.test(overlay) && /motionSV\.value = next/.test(overlay));
ok('geometry is read from SHARED VALUES inside the callback (not stale refs)',
  (() => {
    const start = overlay.indexOf('useFrameCallback(');
    const end = overlay.indexOf('}, false);', start);
    const body = overlay.slice(start, end > start ? end : overlay.length);
    return /containerWSV\.value/.test(body) && /pillWSV\.value/.test(body) &&
      !/containerWRef\.current/.test(body) && !/pillWRef\.current/.test(body);
  })());
ok('layout callbacks keep the shared geometry current',
  /containerWSV\.value = width/.test(overlay) && /pillWSV\.value = width/.test(overlay));
ok('the loop is deactivated on unmount (no leaked animation)',
  /frameCallback\.setActive\(false\)/.test(overlay));
ok('the DEV heartbeat reports whether the mark actually moved',
  /\[VDO_WM_MOVE\] moved=\$\{travelled > 0\.5 \? 'yes' : 'NO'\}/.test(overlay));

section('E. exactly one watermark layer is rendered per session');
const layers = stripComments(read('src/lib/watermarkLayers.ts'));
ok('one policy module decides the layer', /export function resolveWatermarkLayers/.test(layers));
ok('the anti-duplication contract still holds',
  /if \(providerVisible\) \{[\s\S]{0,220}appOverlay: false/.test(layers));
ok('the native players still consume that single policy',
  /resolveWatermarkLayers\(/.test(stripComments(read('src/components/VdoCipherPlayerNativeAdapter.native.tsx'))) &&
  /resolveWatermarkLayers\(/.test(stripComments(read('src/components/OfflineVideoPlayer.native.tsx'))));

/* ───────────────────────────── summary ────────────────────────────────── */

console.log('\n' + '─'.repeat(60));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('continuous-watermark suite FAILED.');
  process.exit(1);
}
console.log('continuous-watermark suite OK.');
