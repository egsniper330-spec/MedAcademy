#!/usr/bin/env node
'use strict';
/**
 * generate-website-brand-assets.js — rebuilds the medacademy.site brand assets
 * from the SAME traced vector masters the mobile app uses
 * (scripts/brand/identity-paths.js), so the website and the app present ONE
 * identical brand rather than two separately-traced copies of it.
 *
 * Why regenerate instead of copying assets/brand/*.png:
 *   • the app lockups carry ~14/15 px of canvas padding; a website header sizes
 *     by CSS height, so padding would render the artwork smaller than declared
 *     and differ between variants. Website assets are written TIGHT (ink edge to
 *     edge) so `height: 34px` is exactly the artwork height.
 *   • both theme variants are produced from one geometry pass, so they are
 *     pixel-identical in extent — swapping them cannot shift the header by a
 *     pixel when the theme toggles.
 *
 * The horizontal lockup reproduces the approved proportions exactly:
 * wordScale 0.38 / gapScale 0.16 gives ink aspect 3.676, which is what
 * assets/brand/logo-*.png measures (772×210).
 *
 * Output (all under website/assets/):
 *   logo-light.png          horizontal lockup, dark ink   — for LIGHT backgrounds
 *   logo-dark.png           horizontal lockup, white ink  — for DARK backgrounds
 *   logo-stacked-light.png  symbol over wordmark, dark ink
 *   logo-stacked-dark.png   symbol over wordmark, white ink
 *   favicon.svg             navy tile + white symbol (modern browsers)
 *   favicon.png             copied from the approved 64×64 brand favicon
 *   apple-touch-icon.png    opaque 180×180 navy tile + white symbol
 *
 * Usage: node scripts/generate-website-brand-assets.js
 */
const fs = require('fs');
const path = require('path');

const { render, apply, encodePng, lockupFit } = require('./generate-android-icon-assets');
const { SYMBOL, WORDMARK, PALETTE, bounds, toPathData } = require('./brand/identity-paths');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'website', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const say = (m) => console.log(m);
const rgb = (hex) => {
  const s = hex.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};

const SYM_B = bounds(SYMBOL);
const WORD_B = bounds(WORDMARK);

/** Tight lockup raster: box sized to the fitted content, so ink touches edges. */
function lockupRaster(ink, { stack, wordScale, gapScale }, targetH) {
  // 1. probe at a nominal height to learn the natural content aspect
  const probe = lockupFit({ x: 0, y: 0, w: 4000, h: 4000 }, { stack, wordScale, gapScale });
  const aspect = probe.content.w / probe.content.h;
  const H = Math.round(targetH);
  const W = Math.round(H * aspect);
  // 2. refit into the exact box — content now fills it edge to edge
  const L = lockupFit({ x: 0, y: 0, w: W, h: H }, { stack, wordScale, gapScale });
  const im = render(W, H, [
    { loops: apply(SYMBOL, L.symbol), color: ink },
    { loops: apply(WORDMARK, L.wordmark), color: ink },
  ], 4, { alpha: true });
  return { im, W, H, aspect };
}

/** Ink bbox of a rendered RGBA raster — used to prove the asset is tight. */
function inkBox(im) {
  const { data, width: w, height: h } = im;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 20) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function writePng(name, im) {
  fs.writeFileSync(path.join(OUT, name), encodePng(im.width, im.height, im.data, 6));
  return im;
}

/* ── 1. horizontal lockups (header) ──────────────────────────────────────── */
// wordScale 0.38 / gapScale 0.16 = the approved 3.676 ink aspect.
const HORIZ = { stack: false, wordScale: 0.38, gapScale: 0.16 };
say('horizontal lockups (aspect must match the approved 3.676):');
for (const [name, ink] of [['logo-light.png', PALETTE.ink], ['logo-dark.png', PALETTE.onDark]]) {
  const { im, W, H, aspect } = lockupRaster(ink, HORIZ, 300);
  const bb = inkBox(im);
  writePng(name, im);
  say(`  ${name.padEnd(18)} ${W}×${H}  ink ${bb.w}×${bb.h}  aspect ${aspect.toFixed(3)}  ` +
      `padding L/T/R/B ${bb.x0}/${bb.y0}/${W - 1 - bb.x1}/${H - 1 - bb.y1}`);
}

/* ── 2. stacked lockups (hero) ───────────────────────────────────────────── */
// wordScale 0.40 ≈ the board's stacked wordmark (61 px tall over a 151 px mark).
const STACK = { stack: true, wordScale: 0.40, gapScale: 0.24 };
say('stacked hero lockups:');
for (const [name, ink] of [['logo-stacked-light.png', PALETTE.ink], ['logo-stacked-dark.png', PALETTE.onDark]]) {
  const { im, W, H, aspect } = lockupRaster(ink, STACK, 620);
  const bb = inkBox(im);
  writePng(name, im);
  say(`  ${name.padEnd(24)} ${W}×${H}  ink ${bb.w}×${bb.h}  aspect ${aspect.toFixed(3)}  ` +
      `padding L/T/R/B ${bb.x0}/${bb.y0}/${W - 1 - bb.x1}/${H - 1 - bb.y1}`);
}

/* ── 3. theme-pair parity: identical extents, so no layout shift on toggle ── */
const dims = (n) => {
  const b = fs.readFileSync(path.join(OUT, n));
  return [b.readUInt32BE(16), b.readUInt32BE(20)].join('×');
};
for (const [a, b] of [['logo-light.png', 'logo-dark.png'], ['logo-stacked-light.png', 'logo-stacked-dark.png']]) {
  say(`  parity ${a} / ${b}: ${dims(a)} vs ${dims(b)} — ${dims(a) === dims(b) ? 'IDENTICAL' : 'MISMATCH'}`);
}

/* ── 4. SVG favicon: navy tile + white symbol ────────────────────────────── */
/** Transform placing the symbol (source units, origin SYM_B) inside `box`. */
function symbolTransform(box) {
  const k = Math.min(box.w / SYM_B.width, box.h / SYM_B.height);
  return {
    k,
    dx: box.x + (box.w - SYM_B.width * k) / 2 - SYM_B.x0 * k,
    dy: box.y + (box.h - SYM_B.height * k) / 2 - SYM_B.y0 * k,
  };
}

const TILE = 64;
const svgSymbol = (() => {
  const t = symbolTransform({ x: TILE * 0.19, y: TILE * 0.19, w: TILE * 0.62, h: TILE * 0.62 });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}">` +
    `<rect width="${TILE}" height="${TILE}" rx="${Math.round(TILE * 0.22)}" fill="${PALETTE.navy}"/>` +
    `<g transform="translate(${t.dx.toFixed(2)} ${t.dy.toFixed(2)}) scale(${t.k.toFixed(5)}) ` +
    `translate(${-SYM_B.x0} ${-SYM_B.y0})">` +
    `<path fill="${PALETTE.onDark}" fill-rule="evenodd" d="${toPathData(SYMBOL)}"/></g></svg>`;
})();
fs.writeFileSync(path.join(OUT, 'favicon.svg'), svgSymbol);
say(`  favicon.svg              ${(svgSymbol.length / 1024).toFixed(1)}KB  (navy tile + white symbol)`);

/* ── 5. opaque apple-touch-icon (iOS home screen) ────────────────────────── */
const AT = 180;
const atLayers = [
  { rect: { x: 0, y: 0, w: AT, h: AT }, color: rgb(PALETTE.navy) },
  { loops: apply(SYMBOL, symbolTransform({ x: AT * 0.19, y: AT * 0.19, w: AT * 0.62, h: AT * 0.62 })), color: rgb(PALETTE.onDark) },
];
const at = render(AT, AT, atLayers, 4, { alpha: false });
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), encodePng(at.width, at.height, at.data, 2));
say(`  apple-touch-icon.png     ${AT}×${AT}  opaque (iOS requires no alpha)`);

/* ── 6. approved 64×64 favicon, copied verbatim ─────────────────────────── */
fs.copyFileSync(path.join(ROOT, 'assets', 'brand', 'favicon.png'), path.join(OUT, 'favicon.png'));
say(`  favicon.png              copied from assets/brand/favicon.png (approved 64×64 tile)`);

say(`\ndone — ${fs.readdirSync(OUT).sort().join(', ')}`);
