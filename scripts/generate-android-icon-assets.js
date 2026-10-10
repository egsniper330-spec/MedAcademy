#!/usr/bin/env node
/* global Buffer, __dirname */
'use strict';
/**
 * generate-android-icon-assets.js — renders the MedAcademy launcher/OS icons AND
 * the in-app brand assets from the vector identity in scripts/brand/identity-paths.js.
 *
 *     node scripts/generate-android-icon-assets.js                 # writes into assets/
 *     node scripts/generate-android-icon-assets.js --out <dir>     # stage elsewhere
 *     node scripts/generate-android-icon-assets.js --out <dir> --quiet
 *
 * Pure Node — no Pillow, no sharp, no canvas, no new dependency. Every output is
 * rasterized from the same vector contours at its own resolution, so nothing is
 * ever an upscale of a smaller bitmap.
 *
 * ─── WHY THIS FILE CHANGED ─────────────────────────────────────────────────
 * It used to draw the OLD mark (graduation cap + book + play) from hardcoded
 * geometry, and only the three Android launcher files. The identity has been
 * replaced, so the geometry now comes from the traced vector master, and the one
 * command that owns "brand raster assets" owns all of them.
 *
 * ─── WHAT THE ROOT CAUSE OF THE CROPPED LAUNCHER ICON WAS ──────────────────
 * `assets/adaptive-icon.png` was a byte-for-byte copy of the full app icon: an
 * OPAQUE 1024² badge containing mark + wordmark + tagline, artwork edge to edge
 * (measured ink bbox == the whole canvas). Android never shows that square: on
 * API 26+ the launcher masks the adaptive icon to a circle / squircle / rounded
 * square / teardrop, of which only the centred 66/108 dp disc is guaranteed
 * visible. An opaque full-bleed foreground therefore loses its outer third on
 * every launcher, which is the cut-off text that was reported. The same opaque
 * badge was also the pre-26 (masked to a circle) icon, the iOS icon and the
 * notification icon, because `android.icon` was never set.
 *
 * ─── THE FIX ───────────────────────────────────────────────────────────────
 *   • adaptive foreground: TRANSPARENT, symbol only, fitted inside the 66/108
 *     safe disc by measuring its own radial extent — verified below
 *   • monochrome layer: the same symbol as a single-colour stencil for Android
 *     13+ themed icons (the OS tints it) — now actually configured in app.json
 *   • legacy / round / iOS icon (`android-icon.png`, `icon.png`): the symbol on
 *     brand navy, full bleed, and `icon.png` written WITHOUT an alpha channel
 *     because iOS app icons must be opaque
 *   • in-app lockups, monogram, splash and favicon: symbol + traced wordmark,
 *     in the light-on-dark and dark-on-light treatments the theme needs
 * No mask, border or rounded corner is ever baked into a foreground.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { PALETTE, SYMBOL, WORDMARK, PROVENANCE, bounds, toPathData } = require('./brand/identity-paths');

const ROOT = path.join(__dirname, '..');

/* ───────────────────────── geometry → pixels ───────────────────────────── */

const SYM_B = bounds(SYMBOL);
const WORD_B = bounds(WORDMARK);

/** Scale + offset mapping contour units to output pixels. */
function fit(loops, b, box) {
  const k = Math.min(box.w / b.width, box.h / b.height);
  return { k, dx: box.x + (box.w - b.width * k) / 2 - b.x0 * k, dy: box.y + (box.h - b.height * k) / 2 - b.y0 * k };
}

const apply = (loops, t) => loops.map((loop) => loop.map(([x, y]) => [x * t.k + t.dx, y * t.k + t.dy]));

/** Even-odd point-in-polygon across every loop of a layer (so counters knock out). */
function insideLoops(loops, px, py) {
  let odd = false;
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, yi] = loop[i], [xj, yj] = loop[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) odd = !odd;
    }
  }
  return odd;
}

/** Edges of a contour set, horizontals dropped (they contribute no crossings). */
function buildEdges(loops) {
  const edges = [];
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [x0, y0] = loop[j], [x1, y1] = loop[i];
      if (y0 === y1) continue;
      edges.push([x0, y0, x1, y1]);
    }
  }
  return edges;
}

const rectLoops = (r) => [[[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]];

/**
 * Scanline rasterizer with vertical supersampling and exact horizontal coverage.
 *
 * Cost is O(rows × supersample × edges) rather than O(pixels × supersample² ×
 * edges), which is what makes the 1242×2688 splash instant instead of minutes.
 * Layers paint bottom-up; every layer is an even-odd contour set (a rect is just
 * its 4-corner loop), so counters knock out correctly.
 */
function render(width, height, layers, ss = 4, { alpha = true } = {}) {
  const buf = new Float64Array(width * height * 4);
  const cover = new Float64Array(width * height);
  for (const L of layers) {
    const edges = buildEdges(L.rect ? rectLoops(L.rect) : L.loops);
    cover.fill(0);
    const xs = [];
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let j = 0; j < ss; j++) {
        const py = y + (j + 0.5) / ss;
        xs.length = 0;
        for (let e = 0; e < edges.length; e++) {
          const [x0, y0, x1, y1] = edges[e];
          if ((y0 > py) !== (y1 > py)) xs.push(x0 + ((py - y0) * (x1 - x0)) / (y1 - y0));
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const a = xs[i], b = xs[i + 1];
          if (b <= a) continue;
          const first = Math.max(0, Math.floor(a));
          const last = Math.min(width - 1, Math.ceil(b) - 1);
          for (let px = first; px <= last; px++) {
            const l = a > px ? a : px;
            const r = b < px + 1 ? b : px + 1;
            if (r > l) cover[row + px] += (r - l) / ss;
          }
        }
      }
    }
    const [cr, cg, cb] = L.color;
    for (let i = 0; i < cover.length; i++) {
      const a = cover[i] > 1 ? 1 : cover[i];
      if (a <= 0) continue;
      const o = i * 4;
      buf[o] += (cr - buf[o]) * a;
      buf[o + 1] += (cg - buf[o + 1]) * a;
      buf[o + 2] += (cb - buf[o + 2]) * a;
      buf[o + 3] += (255 - buf[o + 3]) * a;
    }
  }
  const out = Buffer.alloc(width * height * (alpha ? 4 : 3));
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (alpha) {
      out[o] = Math.round(buf[o]); out[o + 1] = Math.round(buf[o + 1]);
      out[o + 2] = Math.round(buf[o + 2]); out[o + 3] = Math.round(buf[o + 3]);
    } else {
      out[o / 4 * 3] = Math.round(buf[o]); out[o / 4 * 3 + 1] = Math.round(buf[o + 1]); out[o / 4 * 3 + 2] = Math.round(buf[o + 2]);
    }
  }
  return { width, height, data: out };
}

const rgb = (hex) => {
  const s = hex.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};

/* ─────────────────────────────── PNG codec ─────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** colorType 6 = RGBA, 2 = RGB (no alpha — required for iOS app icons). */
function encodePng(width, height, data, colorType = 6) {
  const ch = colorType === 6 ? 4 : 3;
  const stride = width * ch;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  let pos = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`${file}: unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error(`${file}: unsupported colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch, out = Buffer.alloc(width * height * 4);
  let src = 0, prev = Buffer.alloc(stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); };
  for (let y = 0; y < height; y++) {
    const filter = raw[src++], line = Buffer.from(raw.subarray(src, src + stride)); src += stride;
    if (filter === 1) for (let i = ch; i < stride; i++) line[i] = (line[i] + line[i - ch]) & 255;
    else if (filter === 2) for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 255;
    else if (filter === 3) for (let i = 0; i < stride; i++) { const l = i >= ch ? line[i - ch] : 0; line[i] = (line[i] + ((l + prev[i]) >> 1)) & 255; }
    else if (filter === 4) for (let i = 0; i < stride; i++) { const l = i >= ch ? line[i - ch] : 0, ul = i >= ch ? prev[i - ch] : 0; line[i] = (line[i] + paeth(l, prev[i], ul)) & 255; }
    else if (filter !== 0) throw new Error(`${file}: unknown filter ${filter}`);
    for (let x = 0; x < width; x++) {
      const s = x * ch, d = (y * width + x) * 4;
      if (ch <= 2) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = ch === 2 ? line[s + 1] : 255; }
      else { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = ch === 4 ? line[s + 3] : 255; }
    }
    prev = line;
  }
  return { width, height, colorType, data: out };
}

/* ─────────────────────────────── outputs ───────────────────────────────── */

const CANVAS = 1024;
const SAFE_RATIO = 66 / 108;                 // guaranteed-visible disc / adaptive canvas
const SAFE_RADIUS = (CANVAS / 2) * SAFE_RATIO;
const MIN_INSIDE = 0.995;
const WHITE = rgb(PALETTE.onDark);
const NAVY = rgb(PALETTE.navy);
const INK = rgb(PALETTE.ink);

/** Symbol fitted inside the adaptive safe disc, sized by measuring its own extents. */
function fitInsideSafeDisc(loops, b, canvas = CANVAS) {
  const radius = (canvas / 2) * SAFE_RATIO;
  /* centre is derived in probe space, below */
  // Probe at a modest resolution, then find the largest uniform scale that keeps
  // >= 99.5 % of the covered pixels inside the disc.
  const PROBE = 512;
  const probe = fit(loops, b, { x: 0, y: 0, w: PROBE, h: PROBE });
  const t = apply(loops, probe);
  const centre = PROBE / 2 - 0.5;
  // Radial extent of the OUTLINE, densified, expressed in symbol units — so a
  // candidate scale k can be tested against the disc without re-rasterizing.
  const radii = [];
  for (const loop of t) {
    for (let i = 0; i < loop.length; i++) {
      const [x0, y0] = loop[i], [x1, y1] = loop[(i + 1) % loop.length];
      const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let s = 0; s <= steps; s++) {
        const x = x0 + (x1 - x0) * (s / steps), y = y0 + (y1 - y0) * (s / steps);
        radii.push(Math.hypot(x - centre, y - centre) / probe.k);
      }
    }
  }
  radii.sort((a, b2) => a - b2);
  let k = 0;
  for (let cand = canvas / b.width; cand > 0.2; cand -= 0.01) {
    let inside = 0;
    for (const r of radii) if (r * cand <= radius) inside++;
    if (inside / radii.length >= MIN_INSIDE) { k = cand; break; }
  }
  if (!k) throw new Error('could not fit the symbol inside the safe disc');
  const f = fit(loops, b, { x: 0, y: 0, w: b.width * k, h: b.height * k });
  f.dx += (canvas - b.width * k) / 2;
  f.dy += (canvas - b.height * k) / 2;
  return f;
}

/** Stacked lockup geometry (symbol + wordmark) fitted into a box. */
function lockupFit(box, { stack = false, wordScale = 0.38, gapScale = 0.16 } = {}) {
  const probeH = 1000;
  const sk = probeH / SYM_B.height;
  const wk = (probeH * wordScale) / WORD_B.height;
  const gap = probeH * gapScale;
  const symW = SYM_B.width * sk, wordW = WORD_B.width * wk, wordH = WORD_B.height * wk;
  const contentW = stack ? Math.max(symW, wordW) : symW + gap + wordW;
  const contentH = stack ? probeH + gap + wordH : probeH;
  const F = Math.min(box.w / contentW, box.h / contentH);
  const w = contentW * F, h = contentH * F;
  const ox = box.x + (box.w - w) / 2, oy = box.y + (box.h - h) / 2;
  const sT = { k: sk * F, dx: 0, dy: 0 };
  const wT = { k: wk * F, dx: 0, dy: 0 };
  if (stack) {
    sT.dx = ox + (w - symW * F) / 2 - SYM_B.x0 * sT.k;
    sT.dy = oy - SYM_B.y0 * sT.k;
    wT.dx = ox + (w - wordW * F) / 2 - WORD_B.x0 * wT.k;
    wT.dy = oy + (probeH + gap) * F - WORD_B.y0 * wT.k;
  } else {
    sT.dx = ox - SYM_B.x0 * sT.k;
    sT.dy = oy + (h - probeH * F) / 2 - SYM_B.y0 * sT.k;
    wT.dx = ox + (symW + gap) * F - WORD_B.x0 * wT.k;
    wT.dy = oy + (h - wordH * F) / 2 - WORD_B.y0 * wT.k;
  }
  return { symbol: sT, wordmark: wT, content: { w, h, ox, oy } };
}

function marginOf(img) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    const opaque = img.data[i + 3] > 8;
    const differs = img.data[i] + img.data[i + 1] + img.data[i + 2] < 690 || img.data[i + 3] < 250;
    if (opaque && differs) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (!n) return null;
  return { left: x0, right: img.width - 1 - x1, top: y0, bottom: img.height - 1 - y1, bbox: { w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const OUT = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : path.join(ROOT, 'assets'));
  const quiet = argv.includes('--quiet');
  const say = (...a) => { if (!quiet) console.log(...a); };

  fs.mkdirSync(path.join(OUT, 'brand'), { recursive: true });
  const written = [];
  const write = (rel, buf) => { const f = path.join(OUT, rel); fs.writeFileSync(f, buf); written.push(rel); return f; };
  const png = (rel, width, height, layers, opts = {}) =>
    write(rel, encodePng(width, height, render(width, height, layers, opts.ss ?? 4, { alpha: opts.alpha ?? true }).data, opts.alpha === false ? 2 : 6));

  say(`identity: symbol ${SYM_B.width.toFixed(0)}×${SYM_B.height.toFixed(0)} units (IoU ${PROVENANCE.symbol.iou}), ` +
      `wordmark ${WORD_B.width.toFixed(0)}×${WORD_B.height.toFixed(0)} units (IoU ${PROVENANCE.wordmark.iou})`);
  say(`writing to ${path.relative(ROOT, OUT) || '.'}`);

  /* ── 1. adaptive foreground: transparent, symbol inside the safe disc ── */
  const safe = fitInsideSafeDisc(SYMBOL, SYM_B);
  png('adaptive-icon.png', CANVAS, CANVAS, [{ loops: apply(SYMBOL, safe), color: WHITE }], { ss: 4 });

  /* ── 2. monochrome stencil for Android 13+ themed icons ── */
  png('adaptive-icon-monochrome.png', CANVAS, CANVAS, [{ loops: apply(SYMBOL, safe), color: WHITE }], { ss: 4 });

  /* ── 3. legacy / round / iOS icon: navy square, white symbol, full bleed ── */
  const iconInset = { x: CANVAS * 0.19, y: CANVAS * 0.19, w: CANVAS * 0.62, h: CANVAS * 0.62 };
  const iconT = fit(SYMBOL, SYM_B, iconInset);
  const iconLayers = [
    { rect: { x: 0, y: 0, w: CANVAS, h: CANVAS }, color: NAVY },
    { loops: apply(SYMBOL, iconT), color: WHITE },
  ];
  png('android-icon.png', CANVAS, CANVAS, iconLayers, { ss: 4, alpha: false });
  // iOS app icons must be OPAQUE: written without an alpha channel.
  png('icon.png', CANVAS, CANVAS, iconLayers, { ss: 4, alpha: false });
  /* ── 3b. iOS Home Screen appearance variants (iOS 18+) ──────────────────
   * Expo prebuild flattens the light ("any") and tinted variants over WHITE and
   * strips their alpha, while the dark variant keeps transparency. Each file is
   * therefore designed for the treatment it will actually receive:
   *   dark   — a deliberately deeper near-black navy tile with the same white
   *            symbol at identical proportions. Not a darkened copy of the light
   *            icon: the tile colour is re-chosen for the dark Home Screen.
   *   tinted — the dark mark on a WHITE field, because iOS derives the tinted
   *            appearance from the artwork luminance. A navy tile would flatten
   *            into a solid tint block with no readable mark.
   */
  const DARK_TILE = rgb('#05101C');
  png('icon-dark.png', CANVAS, CANVAS, [
    { rect: { x: 0, y: 0, w: CANVAS, h: CANVAS }, color: DARK_TILE },
    { loops: apply(SYMBOL, iconT), color: WHITE },
  ], { ss: 4, alpha: false });
  png('icon-tinted.png', CANVAS, CANVAS, [
    { rect: { x: 0, y: 0, w: CANVAS, h: CANVAS }, color: rgb('#FFFFFF') },
    { loops: apply(SYMBOL, iconT), color: INK },
  ], { ss: 4, alpha: false });


  /* ── 4. notification icon: white silhouette on transparent ── */
  png('brand/notification-icon.png', 256, 256, [{ loops: apply(SYMBOL, fit(SYMBOL, SYM_B, { x: 16, y: 16, w: 224, h: 224 })), color: WHITE }], { ss: 4 });

  /* ── 5. in-app lockups ── */
  for (const [name, color, box] of [
    ['logo-light.png', INK, { x: 0, y: 0, w: 800, h: 240 }],
    ['logo-dark.png', WHITE, { x: 0, y: 0, w: 800, h: 240 }],
    ['drawer-logo-light.png', INK, { x: 0, y: 0, w: 560, h: 128 }],
    ['drawer-logo-dark.png', WHITE, { x: 0, y: 0, w: 560, h: 128 }],
  ]) {
    const mIn = Math.round(box.h * 0.06);
    const L = lockupFit({ x: mIn, y: mIn, w: box.w - 2 * mIn, h: box.h - 2 * mIn });
    png(`brand/${name}`, box.w, box.h, [
      { loops: apply(SYMBOL, L.symbol), color },
      { loops: apply(WORDMARK, L.wordmark), color },
    ], { ss: 4 });
  }

  /* ── 6. monogram ── */
  for (const [name, color] of [['monogram-light.png', INK], ['monogram-dark.png', WHITE]]) {
    const m = 0.08;
    const L = fit(SYMBOL, SYM_B, { x: 400 * m, y: 400 * m, w: 400 * (1 - 2 * m), h: 400 * (1 - 2 * m) });
    png(`brand/${name}`, 400, 400, [{ loops: apply(SYMBOL, L), color }], { ss: 4 });
  }

  /* ── 7. favicon (both locations the project references) ── */
  const favLayers = [
    { rect: { x: 0, y: 0, w: 64, h: 64 }, color: NAVY },
    { loops: apply(SYMBOL, fit(SYMBOL, SYM_B, { x: 12, y: 12, w: 40, h: 40 })), color: WHITE },
  ];
  png('favicon.png', 64, 64, favLayers, { ss: 6 });
  png('brand/favicon.png', 64, 64, favLayers, { ss: 6 });

  /* ── 8. splash: brand navy, white stacked lockup, centred ── */
  const SPLASH = { w: 1242, h: 2688 };
  const splashBox = { x: SPLASH.w * 0.12, y: SPLASH.h * 0.33, w: SPLASH.w * 0.76, h: SPLASH.h * 0.22 };
  const SL = lockupFit(splashBox, { stack: true, wordScale: 0.38, gapScale: 0.22 });
  png('brand/splash.png', SPLASH.w, SPLASH.h, [
    { rect: { x: 0, y: 0, w: SPLASH.w, h: SPLASH.h }, color: NAVY },
    { loops: apply(SYMBOL, SL.symbol), color: WHITE },
    { loops: apply(WORDMARK, SL.wordmark), color: WHITE },
  ], { ss: 2 });

  /* ── 9. the same masters as SVG, for design/handoff ── */
  const svg = (loops, b, title) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${(b.x0 - 1).toFixed(2)} ${(b.y0 - 1).toFixed(2)} ${(b.width + 2).toFixed(2)} ${(b.height + 2).toFixed(2)}" role="img" aria-label="${title}">\n` +
    `  <title>${title}</title>\n` +
    `  <path fill="${PALETTE.ink}" fill-rule="evenodd" d="${toPathData(loops)}"/>\n` +
    `</svg>\n`;
  write('brand/medacademy-symbol.svg', Buffer.from(svg(SYMBOL, SYM_B, 'MedAcademy symbol'), 'utf8'));
  write('brand/medacademy-wordmark.svg', Buffer.from(svg(WORDMARK, WORD_B, 'MedAcademy wordmark'), 'utf8'));

  /* ─────────────────────────── self-checks ───────────────────────────── */
  const fg = decodePng(path.join(OUT, 'adaptive-icon.png'));
  let solid = 0, inside = 0, bx0 = CANVAS, by0 = CANVAS, bx1 = -1, by1 = -1;
  for (let y = 0; y < CANVAS; y++) for (let x = 0; x < CANVAS; x++) {
    if (fg.data[(y * CANVAS + x) * 4 + 3] < 128) continue;
    solid++;
    if (Math.hypot(x - (CANVAS - 1) / 2, y - (CANVAS - 1) / 2) <= SAFE_RADIUS) inside++;
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  const pad = { left: bx0, right: CANVAS - 1 - bx1, top: by0, bottom: CANVAS - 1 - by1 };
  const ios = decodePng(path.join(OUT, 'icon.png'));
  say('\n── self-checks ───────────────────────────────');
  say(`adaptive foreground: symbol ${bx1 - bx0 + 1}×${by1 - by0 + 1} px, padding L/R/T/B ${pad.left}/${pad.right}/${pad.top}/${pad.bottom}`);
  say(`                     inside safe disc ${(100 * inside / solid).toFixed(2)} % of opaque pixels`);
  say(`icon.png colour type ${ios.colorType} (2 = RGB, no alpha — iOS requirement)`);
  for (const nm of ['logo-light.png', 'logo-dark.png', 'drawer-logo-light.png', 'drawer-logo-dark.png', 'monogram-light.png', 'monogram-dark.png']) {
    const m = marginOf(decodePng(path.join(OUT, 'brand', nm)));
    say(`brand/${nm.padEnd(22)} ink ${m.bbox.w}×${m.bbox.h}  padding L/R/T/B ${m.left}/${m.right}/${m.top}/${m.bottom}`);
  }
  if (Math.abs(pad.left - pad.right) > 1 || Math.abs(pad.top - pad.bottom) > 1) throw new Error('adaptive foreground is not centred');
  if (inside / solid < MIN_INSIDE) throw new Error('adaptive foreground escapes the safe disc');
  if (ios.colorType !== 2) throw new Error('icon.png must be RGB without alpha');
  say(`✓ ${written.length} files written`);
}

if (require.main === module) main();

module.exports = { render, insideLoops, fit, apply, encodePng, decodePng, lockupFit, fitInsideSafeDisc, marginOf, CANVAS, SAFE_RADIUS, SAFE_RATIO };
