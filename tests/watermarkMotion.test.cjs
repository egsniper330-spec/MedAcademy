#!/usr/bin/env node
'use strict';
/**
 * watermarkMotion.test.cjs — the watermark's two new decisions.
 *
 * ── WHY THESE EXIST ──────────────────────────────────────────────────────────
 * Part A exercises the CONTINUOUS BILLIARD MOTION engine
 * (src/lib/watermarkMotion.ts) NUMERICALLY — it is compiled standalone with
 * tsc and driven with a seeded rng, so the invariants below are measured, not
 * read out of the source as text:
 *
 *   • the mark is inside the real video viewport on EVERY step, for every
 *     simulated size/shape/element-box (the reported "watermark partly
 *     outside the frame / clipped" bug);
 *   • reflection is exact — speed is preserved, no sticking to a wall, no
 *     energy loss, and a step can never tunnel through a wall (the reported
 *     "disappears" and the 1×1-clamp defect);
 *   • a resize/rotation re-projects the position synchronously, so the mark
 *     is legal the instant the container changes;
 *   • initial directions are varied and non-repeating (billiard, not one
 *     fixed slide).
 *
 * Part B exercises resolveWatermarkLayers (src/lib/watermarkLayers.ts): the
 * single platform-aware rule that decides whether the provider's burned-in
 * VdoCipher annotation or the app overlay is shown — including the Android
 * native case where neither layer used to render at all.
 *
 * Part C asserts the two players actually consume that single policy module,
 * so the rule cannot drift back into a second inline expression.
 *
 * No build, no device.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}
function section(name) { console.log(`\n── ${name} ──`); }

// ── Compile the pure modules standalone (both are dependency-free) ──────────
function buildModule(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmmotion-'));
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

const M = buildModule('watermarkMotion.ts');
const L = buildModule('watermarkLayers.ts');

/** Deterministic rng so a failure is reproducible. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const inBounds = (s, b, sz) =>
  s.x >= 0 && s.x <= Math.max(0, b.width - sz.width) &&
  s.y >= 0 && s.y <= Math.max(0, b.height - sz.height);

/* ══ A. CONTINUOUS BILLIARD MOTION ═════════════════════════════════════════ */
section('A. billiard motion — inside the video viewport');
{
  const cases = [
    { name: 'portrait phone player',      b: { width: 360,  height: 202 },  sz: { width: 190, height: 22 } },
    { name: 'landscape phone player',     b: { width: 640,  height: 360 },  sz: { width: 260, height: 24 } },
    { name: 'tablet player',              b: { width: 900,  height: 506 },  sz: { width: 300, height: 26 } },
    { name: 'fullscreen 4K-ish viewport', b: { width: 1920, height: 1080 }, sz: { width: 320, height: 28 } },
    { name: 'tiny player (mark wider than 10% of it)', b: { width: 320, height: 180 }, sz: { width: 250, height: 24 } },
  ];

  for (const t of cases) {
    const rng = makeRng(0xC0FFEE ^ t.b.width);
    let s = M.createWatermarkMotion(t.b, t.sz, rng);
    check(`A: ${t.name} — starts in bounds`, inBounds(s, t.b, t.sz));

    let okAll = true;
    let xFlips = 0;
    let yFlips = 0;
    for (let i = 0; i < 4000; i++) {
      const prev = s;
      s = M.stepWatermarkMotion(s, 1 / 60, t.b, t.sz);
      if (Math.sign(prev.vx) !== Math.sign(s.vx)) xFlips++;
      if (Math.sign(prev.vy) !== Math.sign(s.vy)) yFlips++;
      if (!inBounds(s, t.b, t.sz)) { okAll = false; break; }
    }
    check(`A: ${t.name} — stays in bounds for 4000 steps (67 s)`, okAll);
    // Billiard means BOTH axes reflect. A container only ~2 spans wide
    // yields few hits, so the bar is "several on each axis" rather than a
    // fixed total that would be unreachable for a large viewport.
    check(`A: ${t.name} — bounces off vertical AND horizontal walls (x=${xFlips}, y=${yFlips})`,
      xFlips >= 2 && yFlips >= 2);
  }

  // Speed preservation: an exact reflection must not slow the mark down.
  const b = { width: 400, height: 300 };
  const sz = { width: 100, height: 20 };
  const s0 = { x: 399.5, y: 150, vx: 200, vy: 60 };
  const s1 = M.stepWatermarkMotion(s0, 0.01, b, sz);
  check('A: hitting the right wall reflects x velocity', Math.sign(s1.vx) === -1);
  check('A: reflection preserves the speed magnitude',
    Math.abs(Math.hypot(s1.vx, s1.vy) - Math.hypot(s0.vx, s0.vy)) < 1e-9);
  check('A: the reflected remainder is used, not discarded (no sticking)',
    s1.x < 300);
}

section('B. billiard motion — robustness');
{
  const b = { width: 500, height: 300 };
  const sz = { width: 200, height: 24 };

  // dt clamping: a stalled frame (e.g. 3 s of blocking work) must not tunnel.
  const s = { x: 10, y: 10, vx: 40, vy: 30 };
  const stepped = M.stepWatermarkMotion(s, 3, b, sz);
  const maxTravel = M.WM_MOTION_MAX_STEP_S * Math.hypot(40, 30);
  check('B: a 3 s stall moves at most one clamped step',
    Math.hypot(stepped.x - s.x, stepped.y - s.y) <= maxTravel + 1e-6);
  check('B: …and never leaves the viewport after it', inBounds(stepped, b, sz));

  // dt = 0 must be a pure no-op (no NaN, no movement).
  const still = M.stepWatermarkMotion(s, 0, b, sz);
  check('B: dt=0 is a no-op', still.x === s.x && still.y === s.y);

  // Degenerate container: a 0×0 layout must never produce a NaN position or
  // an out-of-range one (the "watermark disappears when the container
  // collapses" case).
  const collapsed = M.stepWatermarkMotion(s, 1 / 60, { width: 0, height: 0 }, sz);
  check('B: a 0×0 container yields a 0,0 position (never NaN)',
    collapsed.x === 0 && collapsed.y === 0 && Number.isFinite(collapsed.x));

  // Element wider than its container: the X range floors at 0 (top-left pin),
  // while the axis that still has room keeps its real range.
  const overflow = M.stepWatermarkMotion(s, 1 / 60, { width: 100, height: 50 }, sz);
  check('B: an element wider than its container is pinned to x=0, never negative',
    overflow.x === 0);
  check('B: …and the axis with real room keeps its range (y within 0…26)',
    overflow.y >= 0 && overflow.y <= 26);

  // Clamp-on-size-change: the reported clipping bug was clamping a 1×1
  // assumption, then growing the element. Clamping with the REAL size is what
  // keeps the whole mark inside.
  const grown = M.clampWatermarkMotion(
    { x: 399, y: 290, vx: 20, vy: 20 },
    b,
    sz,
  );
  check('B: clamp uses the element box (x ≤ 300 for a 200px mark in 500)',
    grown.x === 300);
  check('B: clamp uses the element box (y ≤ 276 for a 24px mark in 300)',
    grown.y === 276);

  // Resize re-projection is synchronous and legal immediately.
  const portrait = { width: 360, height: 202 };
  const landscape = { width: 640, height: 360 };
  // In-bounds for portrait: x ∈ [0, 160], y ∈ [0, 178].
  const mid = { x: 80, y: 90, vx: 30, vy: -30 };
  const rotated = M.resolveWatermarkMotionBounds(mid, portrait, landscape, sz);
  check('B: rotation keeps the mark in the new bounds',
    inBounds(rotated, landscape, sz));
  check('B: rotation preserves velocity (no re-randomised teleport)',
    rotated.vx === mid.vx && rotated.vy === mid.vy);
  check('B: rotation scales the position proportionally',
    Math.abs(rotated.x - 80 * (landscape.width - sz.width) / (portrait.width - sz.width)) < 1e-6);
  check('B: …and lands inside the scaled span (x ≈ 220 of 440)',
    Math.abs(rotated.x - 220) < 1e-6);

  const shrunk = M.resolveWatermarkMotionBounds(mid, landscape, portrait, sz);
  check('B: shrinking the viewport still lands in bounds', inBounds(shrunk, portrait, sz));
  check('B: isWatermarkMotionInBounds agrees with the clamp',
    M.isWatermarkMotionInBounds(grown, b, sz) === true &&
    M.isWatermarkMotionInBounds({ x: 499, y: 0, vx: 0, vy: 0 }, b, sz) === false);

  // Varied, non-repeating initial directions. Each axis carries at least
  // WM_MOTION_MIN_AXIS_SHARE of the direction, so after normalisation the
  // horizontal share |vx|/speed is bounded by
  //     [MIN / √(1 + MIN²),  1 / √(1 + MIN²)]
  // because the extremes occur at the CORNERS (one axis at the MIN floor and
  // the other at 1), not at the 45° diagonal. At 0.6 that is 0.514…0.857.
  // Derive the band from the constant so retuning keeps this meaningful.
  const share = M.WM_MOTION_MIN_AXIS_SHARE;
  const denom = Math.sqrt(1 + share ** 2);
  const lo = share / denom;
  const hi = 1 / denom;
  const dirs = new Set();
  let diagonal = true;
  let ratioMin = 1;
  let ratioMax = 0;
  for (let i = 0; i < 200; i++) {
    const d = M.wmRandomDirection(makeRng(1000 + i));
    const ratio = Math.abs(d.vx) / Math.hypot(d.vx, d.vy);
    ratioMin = Math.min(ratioMin, ratio);
    ratioMax = Math.max(ratioMax, ratio);
    if (ratio < lo - 1e-9 || ratio > hi + 1e-9) diagonal = false;
    dirs.add(`${d.vx >= 0 ? '+' : '-'}${d.vy >= 0 ? '+' : '-'}`);
  }
  check('B: all four quadrants are used (non-repeating start direction)', dirs.size === 4);
  check('B: every start is clearly diagonal, never axis-aligned', diagonal);
  check(`B: …and the ratio band is the derived one (observed ${ratioMin.toFixed(3)}–${ratioMax.toFixed(3)} vs ${lo.toFixed(3)}–${hi.toFixed(3)})`,
    ratioMin >= lo - 1e-9 && ratioMax <= hi + 1e-9);

  const speeds = new Set();
  for (let i = 0; i < 100; i++) {
    speeds.add(M.wmRandomSpeed(makeRng(i)));
  }
  check('B: speed is drawn across the band, not constant', speeds.size > 90);
  const allInRange = [...speeds].every((v) => v >= M.WM_MOTION_MIN_SPEED && v <= M.WM_MOTION_MAX_SPEED);
  check('B: speed stays inside the declared band', allInRange);
}

/* ══ C. THE LAYER POLICY ═══════════════════════════════════════════════════ */
section('C. resolveWatermarkLayers — exactly one visible watermark');
{
  const resolve = L.resolveWatermarkLayers;

  // 1. iOS native + provider annotate → provider only (no duplicate).
  const ios = resolve({ platform: 'ios', playerKind: 'native', annotateApplied: true, hasIdentity: true });
  check('C: iOS native with annotate → provider only, no app overlay',
    ios.providerAnnotationVisible === true && ios.appOverlay === false && ios.reason === 'provider_only');

  // 2. THE ANDROID BUG: provider annotate attached, but the Android native SDK
  //    does not draw it → the app overlay must cover, or nothing is shown.
  const android = resolve({ platform: 'android', playerKind: 'native', annotateApplied: true, hasIdentity: true });
  check('C: Android native with annotate → APP overlay renders (no blank watermark)',
    android.appOverlay === true && android.providerAnnotationVisible === false);
  check('C: …and the reason names the Android-native case',
    android.reason === 'app_only_android_native');

  // 3. Web (iframe) is the VdoCipher web renderer → provider annotation draws.
  const web = resolve({ platform: 'web', playerKind: 'webview', annotateApplied: true, hasIdentity: true });
  check('C: web/webview with annotate → provider only',
    web.providerAnnotationVisible === true && web.appOverlay === false);

  // 4. Server did not attach annotate (capability fallback / no identity on
  //    the profile) → the app overlay is the watermark, everywhere.
  for (const p of ['android', 'ios', 'web']) {
    for (const k of ['native', 'webview']) {
      const r = resolve({ platform: p, playerKind: k, annotateApplied: false, hasIdentity: true });
      check(`C: ${p}/${k} without annotate → app overlay`, r.appOverlay === true && r.reason === 'app_only_annotate_off');
    }
  }

  // 5. No identity and no provider mark → NOTHING. Never fabricate a mark.
  const none = resolve({ platform: 'ios', playerKind: 'native', annotateApplied: false, hasIdentity: false });
  check('C: no identity + no annotate → nothing rendered',
    none.appOverlay === false && none.providerAnnotationVisible === false && none.reason === 'none_no_identity');

  // 6. The policy is total and never yields two visible layers.
  let doubleShown = 0;
  for (const platform of ['android', 'ios', 'web']) {
    for (const playerKind of ['native', 'webview']) {
      for (const annotateApplied of [true, false]) {
        for (const hasIdentity of [true, false]) {
          const r = resolve({ platform, playerKind, annotateApplied, hasIdentity });
          if (r.appOverlay && r.providerAnnotationVisible) doubleShown++;
        }
      }
    }
  }
  check('C: no combination ever shows BOTH layers (anti-duplication)', doubleShown === 0);

  // 7. The Android rule is one named constant, and its default is what fixes
  //    the reported absence.
  check('C: the Android-native override is a single exported constant',
    typeof L.ANDROID_NATIVE_RENDERS_PROVIDER_ANNOTATE === 'boolean');
  check('C: the constant currently says Android native does NOT draw the provider mark',
    L.ANDROID_NATIVE_RENDERS_PROVIDER_ANNOTATE === false);
  check('C: providerAnnotationRenders is the one place that decides',
    L.providerAnnotationRenders('android', 'native') === false &&
    L.providerAnnotationRenders('ios', 'native') === true &&
    L.providerAnnotationRenders('android', 'webview') === true);
}

/* ══ D. WIRING — one policy, three consumers ═══════════════════════════════ */
section('D. the players consume the single policy');
{
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const adapter = read('src/components/VdoCipherPlayerNativeAdapter.native.tsx');
  const webview = read('src/components/VdoCipherPlayerWebView.tsx');
  const offline = read('src/components/OfflineVideoPlayer.native.tsx');
  const overlay = read('src/components/NativeWatermarkOverlay.tsx');
  const motion  = read('src/lib/watermarkMotion.ts');

  // The native SDK adapter: no longer its own inline rule.
  check('D: native adapter calls resolveWatermarkLayers',
    /resolveWatermarkLayers\(\{/.test(adapter) && /playerKind: 'native'/.test(adapter));
  check('D: native adapter renders from the policy verdict',
    /watermarkLayers\.appOverlay/.test(adapter));
  check('D: native adapter no longer suppresses the overlay with its own inline rule',
    !/identity && !annotateApplied &&/.test(adapter));

  // The WebView/web player: same module, webview kind.
  check('D: WebView player calls resolveWatermarkLayers',
    /resolveWatermarkLayers\(\{/.test(webview) && /playerKind: 'webview'/.test(webview));
  check('D: WebView player gates the injected DOM watermark on the verdict',
    /watermarkLayers\.appOverlay \? watermarkId : undefined/.test(webview));

  // The offline player: the provider layer never applies to a persisted OTP.
  check('D: offline player routes through the same policy',
    /resolveWatermarkLayers\(\{/.test(offline) && /annotateApplied: false/.test(offline));

  // The overlay must not re-decide the layer policy on its own.
  check('D: the overlay never reads annotateApplied itself',
    !/annotateApplied/.test(overlay));
}

/* ══ E. LIFECYCLE / CLEANUP / PERFORMANCE CONTRACTS ════════════════════════ */
section('E. overlay lifecycle and cleanup');
{
  const overlay = fs.readFileSync(path.join(ROOT, 'src/components/NativeWatermarkOverlay.tsx'), 'utf8');
  const motion  = fs.readFileSync(path.join(ROOT, 'src/lib/watermarkMotion.ts'), 'utf8');

  // The frame loop is UI-thread and is stopped when the component unmounts.
  check('E: motion runs on a Reanimated frame callback (no JS timers)',
    /useFrameCallback\(/.test(overlay));
  check('E: the loop is deactivated on unmount',
    /return \(\) => frameCallback\.setActive\(false\)/.test(overlay));
  check('E: the loop is only armed from an effect, never from render',
    /useEffect\(\(\) => \{\s*frameCallback\.setActive\(true\)/.test(overlay));
  check('E: no self-rescheduling setTimeout remains',
    !/setTimeout\(\(\) =>\s*\{?move\(/.test(overlay));

  // The old 1×1-clamp defect: placement must wait for a real measurement.
  check('E: placement refuses to start before the pill is measured',
    /if \(pillWRef\.current <= 0 \|\| pillHRef\.current <= 0\) return;/.test(overlay));
  check('E: placement refuses to start with a 0×0 container',
    /if \(cW <= 0 \|\| cH <= 0\) return;/.test(overlay));

  // A container resize must re-project immediately, not on the next tick.
  check('E: container layout re-projects the motion synchronously',
    /const handleContainerLayout[\s\S]*?syncMotion\(\);/.test(overlay));
  check('E: the pill layout also re-clamps (its own size changed the bounds)',
    /const handlePillLayout[\s\S]*?syncMotion\(\);/.test(overlay));

  // Never intercepts the player controls.
  check('E: the overlay cannot swallow touches on the controls',
    /pointerEvents="none"/.test(overlay));

  // Diagnostics carry geometry only. Assert the CONSOLE CALLS themselves,
  // not the whole file — the surrounding comments legitimately spell out
  // "never a token/OTP" and a file-wide word search would match those.
  const logCalls = (overlay.match(/console\.(log|warn|error)\([\s\S]*?\);/g) || []);
  check('E: the overlay has diagnostics', logCalls.length > 0);
  check('E: no diagnostic interpolates a credential or an identity',
    !/\b(otp|playbackInfo|Apisecret|apiKey|secret)\b/.test(logCalls.join(' ')) &&
    !/\$\{\s*(identity|watermarkId|watermarkName)/.test(logCalls.join(' ')));
  check('E: the geometry guard reports dimensions only',
    /VDO_WM_GEOMETRY/.test(logCalls.join(' ')));

  // The motion engine keeps every coordinate legal by construction.
  check('E: the step function clamps both axes into range',
    /function advanceAxis\([\s\S]*?clamp\(next, 0, max\)/.test(motion));
  check('E: the engine is dependency-free (runs on the UI thread)',
    !/^import /m.test(motion) && !/require\(/.test(motion));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
