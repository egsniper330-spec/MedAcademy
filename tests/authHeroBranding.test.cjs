#!/usr/bin/env node
'use strict';
/**
 * authHeroBranding.test.cjs — locks the Sign In / Create Account welcome screen
 * (src/app/index.tsx) to the official MedAcademy brand mark.
 *
 * No build, no device: it reads the screen and the shared component, then measures
 * the real monogram PNGs so the sizing maths in the screen comment stays true.
 *
 * Regression it guards:
 *   the hero used to be a decorative primary-coloured tile holding a generic
 *   `ShieldPlus` lucide glyph — which is not the MedAcademy logo at all.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { decodePng } = require('../scripts/generate-android-icon-assets');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; console.log('  ✘ ' + label); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const src = read('src/app/index.tsx');
const logo = read('src/components/BrandLogo.tsx');

/* ── the generic shield is gone ─────────────────────────────────────────── */
ok(!/ShieldPlus/.test(src), 'landing screen no longer imports or renders the generic ShieldPlus glyph');
ok(!/from 'lucide-react-native'/.test(src), 'landing screen pulls in no icon glyph at all for its hero');

/* ── the official asset, through the shared component ───────────────────── */
ok(/import \{ BrandLogo \} from '@\/components\/BrandLogo'/.test(src),
  'hero uses the shared BrandLogo component (official assets, single source of truth)');
ok(/<BrandLogo\s+variant="monogram"/.test(src),
  'hero renders the official MedAcademy monogram variant, not a recreated or substitute icon');
ok(!/require\(.*assets/.test(src),
  'screen does not reach into asset paths itself — asset selection stays centralised in BrandLogo');

/* ── theme selection is real, not hardcoded ─────────────────────────────── */
ok(/const dark\s*=\s*scheme === 'dark'/.test(logo) && /useColorScheme\(\)/.test(logo),
  'BrandLogo derives light/dark from useColorScheme (the app theme, no separate state)');
ok(/mono_l:/.test(logo) && /mono_d:/.test(logo) &&
   /case 'monogram':[\s\S]*?dark \? ASSETS\.mono_d : ASSETS\.mono_l/.test(logo),
  'monogram resolves to the white-ink asset in dark mode and the dark-ink asset in light mode');

/* ── proportions ────────────────────────────────────────────────────────── */
ok(/contentFit="contain"/.test(logo), 'BrandLogo uses contentFit="contain" — never stretched or cropped');
ok(/monogram:\s*1,/.test(logo), 'monogram aspect ratio is 1:1, matching the square asset');

/* ── responsive sizing from the shared token ────────────────────────────── */
ok(/useLayout\(\)/.test(src) && /layout\.heroIconSize/.test(src),
  'hero size derives from layout.heroIconSize (fluid 72–104dp) instead of a fixed pixel size');
ok(!/width:\s*88,\s*height:\s*88/.test(src), 'the old hardcoded 88×88 hero box is gone');

/* ── preserved behaviour: name, actions, routing ─────────────────────────── */
ok(/\{branding\.app_name\}/.test(src),
  'the server-managed platform name still renders as the wordmark (stays admin-configurable)');
ok(/router\.push\('\/\(auth\)\/sign-in'\)/.test(src), 'Sign In target unchanged: /(auth)/sign-in');
ok(/router\.push\('\/\(auth\)\/sign-up'\)/.test(src), 'Create Account target unchanged: /(auth)/sign-up');
ok(/label="Sign In"|label=\{t\('common\.signIn'\)\}/.test(src) &&
  /label="Create Account"|label=\{t\('common\.createAccount'\)\}/.test(src),
  'both authentication actions still render');
ok(/resolveStartupRoute\(/.test(src), 'cold-start routing (resolveStartupRoute) untouched');
ok(/variant="secondary"/.test(src), 'the secondary treatment of Create Account is preserved');

/* ── the real assets back the sizing maths ──────────────────────────────── */
const INK = 'assets/brand/monogram-light.png';
const INK_D = 'assets/brand/monogram-dark.png';
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

function measure(p) {
  const img = decodePng(path.join(ROOT, p));
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1, n = 0, acc = [0, 0, 0], minA = 255;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4, a = img.data[i + 3];
    if (a < minA) minA = a;
    if (a <= 8) continue;
    n++; acc[0] += img.data[i]; acc[1] += img.data[i + 1]; acc[2] += img.data[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { w: img.width, h: img.height, ink: acc.map((v) => Math.round(v / n)), minA,
    bw: x1 - x0 + 1, bh: y1 - y0 + 1, pad: { L: x0, R: img.width - 1 - x1, T: y0, B: img.height - 1 - y1 } };
}

const ml = measure(INK), md = measure(INK_D);
ok(ml.w === ml.h && md.w === md.h, `both monogram assets are square (${ml.w}×${ml.h}, ${md.w}×${md.h})`);
ok(ml.bw === ml.bh && Math.abs(ml.bw / ml.w - 0.84) < 0.01,
  `monogram ink is ~84% of the canvas (${ml.bw}/${ml.w}) — the basis of the ×1.35 sizing`);
ok(Math.abs(ml.pad.L - ml.pad.R) <= 1 && Math.abs(ml.pad.T - ml.pad.B) <= 1,
  `monogram ink is centred in its canvas (pad L/R/T/B ${ml.pad.L}/${ml.pad.R}/${ml.pad.T}/${ml.pad.B})`);
ok(ml.minA === 0 && md.minA === 0, 'both monogram assets carry real transparency (minAlpha 0)');
ok(lum(ml.ink) < 0.25, `light-mode monogram ink is dark (Y=${lum(ml.ink).toFixed(3)}, ${'#' + ml.ink.map((v) => v.toString(16).padStart(2, '0')).join('')})`);
ok(lum(md.ink) > 0.5, `dark-mode monogram ink is light (Y=${lum(md.ink).toFixed(3)}, ${'#' + md.ink.map((v) => v.toString(16).padStart(2, '0')).join('')})`);
ok(lum(ml.ink) < lum(md.ink), 'the two variants are genuinely different assets (no white-on-white / dark-on-dark)');

/* the screen's own maths: ink must stay inside the panel at the smallest width */
const heroIconSize = (short) => Math.round(88 * (0.82 + (1.18 - 0.82) * Math.min(1, Math.max(0, (short - 320) / (1024 - 320)))));
const factor = Number((src.match(/layout\.heroIconSize \* ([\d.]+)/) || [])[1]);
ok(Number.isFinite(factor) && factor > 1,
  `screen sizes the hero as heroIconSize × ${factor} to compensate the asset's 8% canvas padding`);
const box320 = Math.round(heroIconSize(320) * factor);
ok(box320 < 320 * 0.8, `at a 320dp-wide screen the logo box is ${box320}px — comfortably inside the 320px viewport`);
ok(Math.round(box320 * 0.84) >= 72, `and its ink stays ${Math.round(box320 * 0.84)}dp — not so small that the mark stops reading`);

console.log(`\n${passed} assertions passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
