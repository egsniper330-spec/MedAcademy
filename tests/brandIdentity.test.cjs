#!/usr/bin/env node
'use strict';
/**
 * brandIdentity.test.cjs — locks the MedAcademy identity assets, the iOS Home
 * Screen appearance variants, and the Expo icon wiring.
 *
 * This runs WITHOUT a build: it decodes the real PNGs, measures them, and checks
 * that what is on disk is what app.json claims — plus that repeating the
 * generator reproduces the committed bytes (drift detection).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { decodePng, SAFE_RATIO } = require('../scripts/generate-android-icon-assets');
const { PALETTE, SYMBOL, WORDMARK, PROVENANCE } = require('../scripts/brand/identity-paths');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; console.log('  ✘ ' + label); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const config = JSON.parse(read('app.json')).expo;

/** Stats over the painted (non-background) area of an icon. */
function stats(file) {
  const im = decodePng(path.join(ROOT, file));
  let opaque = 0, transparent = 0, lum = 0, n = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const hexes = new Map();
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    const i = (y * im.width + x) * 4;
    const a = im.data[i + 3];
    if (a < 250) transparent++;
    if (a < 8) continue;
    opaque++;
    const L = 0.299 * im.data[i] + 0.587 * im.data[i + 1] + 0.114 * im.data[i + 2];
    lum += L; n++;
    const hex = '#' + [im.data[i], im.data[i + 1], im.data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    hexes.set(hex, (hexes.get(hex) || 0) + 1);
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { im, opaque, transparent, meanLum: lum / n, bbox: { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 },
           dominant: [...hexes.entries()].sort((a, b) => b[1] - a[1])[0] };
}

/** Tight bbox of pixels that differ from the dominant (background) colour. */
function markBox(file, backgroundHex) {
  const im = decodePng(path.join(ROOT, file));
  const bg = [1, 3, 5].map((i) => parseInt(backgroundHex.slice(i, i + 2), 16));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    const i = (y * im.width + x) * 4;
    const d = Math.abs(im.data[i] - bg[0]) + Math.abs(im.data[i + 1] - bg[1]) + Math.abs(im.data[i + 2] - bg[2]);
    if (d > 60) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, x0, y0, n };
}

console.log('\nA. Vector masters exist and meet the measured fidelity floor');
for (const [name, p] of [['symbol', PROVENANCE.symbol], ['wordmark', PROVENANCE.wordmark]]) {
  ok(p.iou >= 0.95, `${name} reconstruction IoU ${p.iou} (>= 0.95 vs the approved artwork)`);
  ok(p.vertices >= 3 && p.loops >= 1, `${name} has ${p.loops} contours / ${p.vertices} vertices`);
}
ok(SYMBOL.length === PROVENANCE.symbol.loops, 'symbol contour count matches its provenance record');
ok(WORDMARK.length === PROVENANCE.wordmark.loops, 'wordmark contour count matches its provenance record (10 glyphs + 6 counters)');
ok(exists('assets/brand/medacademy-symbol.svg') && exists('assets/brand/medacademy-wordmark.svg'),
  'SVG masters are source-controlled for design handoff');
ok(/fill-rule="evenodd"/.test(read('assets/brand/medacademy-symbol.svg')), 'SVG master knocks out counters (even-odd)');

console.log('\nB. Android adaptive icon — transparent foreground inside the safe disc');
const fg = stats('assets/adaptive-icon.png');
ok(fg.im.width === 1024 && fg.im.height === 1024, 'adaptive foreground is 1024x1024');
ok(fg.transparent > 0, 'adaptive foreground HAS transparency (a full-bleed opaque foreground is the original bug)');
ok(fg.im.colorType === 6, 'adaptive foreground keeps an alpha channel (colour type 6)');
const radius = (1024 / 2) * SAFE_RATIO;
let inside = 0, solid = 0;
for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
  if (fg.im.data[(y * 1024 + x) * 4 + 3] < 128) continue;
  solid++;
  if (Math.hypot(x - 511.5, y - 511.5) <= radius) inside++;
}
ok(inside / solid >= 0.995, `symbol stays inside the 66/108 safe disc (${(100 * inside / solid).toFixed(2)} %)`);
ok(fg.bbox.y0 === 1024 - 1 - (1024 - 1 - fg.bbox.y1) || Math.abs(fg.bbox.y0 - (1024 - fg.bbox.y1 - 1)) <= 1,
  `vertically centred (top ${fg.bbox.y0}, bottom ${1024 - fg.bbox.y1 - 1})`);
ok(Math.abs(fg.bbox.x0 - (1024 - fg.bbox.x1 - 1)) <= 1, `horizontally centred (left ${fg.bbox.x0}, right ${1024 - fg.bbox.x1 - 1})`);
ok(config.android.adaptiveIcon.backgroundColor === PALETTE.navy,
  `adaptiveIcon.backgroundColor is the measured brand navy ${PALETTE.navy}`);

console.log('\nC. Android launcher wiring');
ok(config.android.icon === './assets/android-icon.png', 'android.icon set (the pre-26 legacy icon used to fall back to the full badge)');
ok(config.android.adaptiveIcon.foregroundImage === './assets/adaptive-icon.png', 'adaptiveIcon.foregroundImage set');
ok(config.android.adaptiveIcon.monochromeImage === './assets/adaptive-icon-monochrome.png',
  'adaptiveIcon.monochromeImage set (Android 13+ themed icons)');
const mono = stats('assets/adaptive-icon-monochrome.png');
ok(mono.im.colorType === 6 && mono.transparent > 0, 'monochrome layer is a transparent stencil the OS can tint');
const legacy = decodePng(path.join(ROOT, 'assets/android-icon.png'));
ok(legacy.colorType === 2, 'android-icon.png is opaque RGB (no alpha) so a legacy mask cannot reveal transparency');

console.log('\nD. iOS Home Screen appearance modes');
const iosIcon = config.ios.icon;
ok(iosIcon && typeof iosIcon === 'object' && !Array.isArray(iosIcon),
  'ios.icon is the object form Expo SDK 55 supports (light/dark/tinted)');
for (const key of ['light', 'dark', 'tinted']) {
  const p = iosIcon && iosIcon[key];
  ok(typeof p === 'string' && fs.existsSync(path.join(ROOT, p.replace('./', ''))), `ios.icon.${key} -> ${p} (exists)`);
}
ok(!('clear' in (iosIcon || {})), 'no invented "clear" key: this SDK only writes dark + tinted luminosity appearances');
const light = stats('assets/icon.png');
const dark = stats('assets/icon-dark.png');
const tinted = stats('assets/icon-tinted.png');
ok(light.im.width === 1024 && dark.im.width === 1024 && tinted.im.width === 1024, 'all three appearances are 1024x1024');
ok(light.im.colorType === 2 && dark.im.colorType === 2 && tinted.im.colorType === 2,
  'all three are opaque RGB — Expo flattens light/tinted over white and iOS rejects transparent app icons');
// identical mark geometry across appearances: same symbol, same proportions
const boxLight = markBox('assets/icon.png', light.dominant[0]);
const boxDark = markBox('assets/icon-dark.png', dark.dominant[0]);
ok(boxLight.n > 0 && boxDark.n > 0 && boxLight.w === boxDark.w && boxLight.h === boxDark.h,
  `dark variant uses the SAME symbol and proportions (mark ${boxDark.w}x${boxDark.h} vs ${boxLight.w}x${boxLight.h})`);
const lum = (hex) => 0.299 * parseInt(hex.slice(1, 3), 16) + 0.587 * parseInt(hex.slice(3, 5), 16) + 0.114 * parseInt(hex.slice(5, 7), 16);
ok(lum(dark.dominant[0]) < lum(light.dominant[0]) - 20,
  `dark tile is a deliberately deeper treatment (tile luminance ${lum(dark.dominant[0]).toFixed(0)} vs ${lum(light.dominant[0]).toFixed(0)})`);
ok(dark.dominant[0] !== light.dominant[0], `dark tile ${dark.dominant[0]} is re-chosen, not a darkened copy of ${light.dominant[0]}`);
ok(tinted.meanLum > 200 && markBox('assets/icon-tinted.png', tinted.dominant[0]).n > 0,
  `tinted appearance is a dark mark on a light field (dominant ${tinted.dominant[0]}) so the user's tint lands on the mark`);

console.log('\nE. In-app brand assets');
ok(config.icon === './assets/icon.png', 'root icon (fallback) still points at the default icon');
ok(config.web && config.web.favicon === './assets/favicon.png', 'web favicon wired');
const notif = (config.plugins || []).find((p) => Array.isArray(p) && p[0] === 'expo-notifications');
ok(notif && notif[1].icon === './assets/brand/notification-icon.png',
  'notification icon uses the white silhouette, not the opaque badge (Android renders opaque icons as a white blob)');
for (const [file, w, h] of [
  ['assets/brand/logo-light.png', 800, 240], ['assets/brand/logo-dark.png', 800, 240],
  ['assets/brand/drawer-logo-light.png', 560, 128], ['assets/brand/drawer-logo-dark.png', 560, 128],
  ['assets/brand/monogram-light.png', 400, 400], ['assets/brand/monogram-dark.png', 400, 400],
  ['assets/brand/splash.png', 1242, 2688], ['assets/favicon.png', 64, 64],
]) {
  const im = decodePng(path.join(ROOT, file));
  ok(im.width === w && im.height === h, `${file} is ${w}x${h} (unchanged canvas → BrandLogo ratios stay valid)`);
}
// polarity: the theme picks the file, so each must sit on the background it is named for
function polarity(file) {
  const im = decodePng(path.join(ROOT, file));
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < im.data.length; i += 4) {
    if (im.data[i + 3] < 128) continue;
    r += im.data[i]; g += im.data[i + 1]; b += im.data[i + 2]; n++;
  }
  return 0.299 * (r / n) + 0.587 * (g / n) + 0.114 * (b / n);
}
ok(polarity('assets/brand/logo-light.png') < 120, 'logo-light ink is dark (renders on a light surface)');
ok(polarity('assets/brand/logo-dark.png') > 180, 'logo-dark ink is light (renders on a dark surface)');
ok(polarity('assets/brand/monogram-light.png') < 120 && polarity('assets/brand/monogram-dark.png') > 180,
  'monogram polarity matches the theme each variant is named for');
ok(polarity('assets/brand/notification-icon.png') > 180, 'notification silhouette is light-on-transparent');

console.log('\nF. Single source of truth — nothing bypasses BrandLogo');
const srcFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) srcFiles.push(p.replace(/\\/g, '/'));
  }
})('src');
const direct = srcFiles.filter((f) => /require\(.*assets\/(icon|adaptive-icon|android-icon|brand\/)/.test(read(f))
  && !f.endsWith('src/components/BrandLogo.tsx'));
ok(direct.length === 0, `no screen requires a brand asset directly (${direct.join(', ') || 'none'})`);
const consumers = srcFiles.filter((f) => /<BrandLogo/.test(read(f)));
ok(consumers.length >= 6, `in-app branding goes through BrandLogo (${consumers.length} screens)`);
const brandLogo = read('src/components/BrandLogo.tsx');
ok(/useColorScheme/.test(brandLogo), 'BrandLogo still selects its variant from the existing theme mechanism');
ok(!/assets\/icon-(dark|tinted)\.png/.test(brandLogo), 'BrandLogo does not repurpose the Home Screen icon variants in-app');

console.log('\nG. The committed assets are reproducible from the generator');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-assets-'));
try {
  execFileSync(process.execPath, ['scripts/generate-android-icon-assets.js', '--out', tmp, '--quiet'], { cwd: ROOT });
  let same = 0, total = 0;
  for (const rel of ['adaptive-icon.png', 'adaptive-icon-monochrome.png', 'android-icon.png', 'icon.png',
    'icon-dark.png', 'icon-tinted.png', 'favicon.png', 'brand/logo-light.png', 'brand/logo-dark.png',
    'brand/monogram-light.png', 'brand/monogram-dark.png', 'brand/splash.png',
    'brand/medacademy-symbol.svg', 'brand/medacademy-wordmark.svg']) {
    total++;
    const a = fs.readFileSync(path.join(ROOT, 'assets', rel));
    const b = fs.readFileSync(path.join(tmp, rel));
    if (a.equals(b)) same++;
  }
  ok(same === total, `regenerating reproduces ${same}/${total} committed files byte-for-byte (no drift, deterministic)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} assertions passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
