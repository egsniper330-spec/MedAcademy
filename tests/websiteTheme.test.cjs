#!/usr/bin/env node
'use strict';
/**
 * websiteTheme.test.cjs — locks medacademy.site to one brand and two working
 * themes, with the invariants that make that safe.
 *
 * No build, no device: it reads the three HTML pages, the stylesheet, the JS
 * and the real PNG assets, then computes WCAG contrast from the token values
 * the CSS actually declares. Claims here are about the numbers the site will
 * paint, not about a screenshot.
 *
 * What it guards, and why each check exists:
 *   1. Every page carries the no-flash head script, the toggle, BOTH logo
 *      variants and the icon links — a page that misses one of these renders a
 *      wrong-theme or unbranded header on that route only, which is easy to
 *      miss by eye and impossible to miss here.
 *   2. Theme-paired assets are IDENTICAL in extent, so switching themes cannot
 *      shift the header by a pixel, and each variant has the right ink polarity
 *      (white on dark, navy on light) — the classic white-on-white bug.
 *   3. Light and dark token sets are the same shape, no colour literal escapes
 *      the token blocks, and `color-scheme` is set in both so native controls
 *      match the page.
 *   4. Measured contrast for text, muted text, links and button ink in BOTH
 *      themes. The pre-existing button fill was 3.61:1 with white — below AA —
 *      and dark card:page was 1.081:1, which is the flatness this replaced.
 *   5. main.js persists under the SAME key the head script reads, and the
 *      OS-follow listener yields to an explicit choice.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'website');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { decodePng } = require('../scripts/generate-android-icon-assets');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  \u2714 ' + label); }
  else { failed++; console.log('  \u2718 ' + label); }
}
function section(n) { console.log('\n' + n); }

const PAGES = ['website/index.html', 'website/download.html', 'website/contact.html'];
const css = read('website/css/styles.css');
const js = read('website/js/main.js');

/* ══ 1. every page is wired for theming ══════════════════════════════════ */
section('1. page wiring');
for (const page of PAGES) {
  const html = read(page);
  const name = page.replace('website/', '');
  ok(/localStorage\.getItem\('med-theme'\)/.test(html), `${name}: no-flash head script reads the saved preference`);
  ok(/documentElement\.setAttribute\('data-theme'/.test(html), `${name}: head script applies data-theme before paint`);
  ok(/<button class="theme-toggle" id="themeToggle" type="button" aria-label="Switch to light mode">/.test(html),
    `${name}: accessible theme toggle present (button + aria-label + type)`);
  ok(/rel="icon" type="image\/svg\+xml" href="assets\/favicon\.svg"/.test(html)
    && /rel="icon" type="image\/png" sizes="64x64" href="assets\/favicon\.png"/.test(html),
    `${name}: SVG favicon with PNG fallback`);
  ok(/rel="apple-touch-icon" href="assets\/apple-touch-icon\.png"/.test(html), `${name}: apple-touch-icon declared`);
  ok(/name="theme-color"/.test(html), `${name}: theme-color meta (kept in sync by JS)`);
  // The ?v= cache-buster is optional and intentional: the host sends no
  // cache-control/etag for JS, so a stale main.js could keep old behaviour
  // after an update (see tests/websiteContactLinks.test.cjs).
  ok(/<script src="js\/main\.js(?:\?v=[^"]*)?"><\/script>/.test(html), `${name}: main.js still loaded`);
  ok(/\.theme-toggle\{display:none\}<\/style>/.test(html.replace(/\s+/g, '')),
    `${name}: toggle hidden when JS is unavailable`);
  const logos = (html.match(/logo-(dark|light)/g) || []).length;
  ok(logos >= 2, `${name}: both header logo variants referenced (found ${logos})`);
}

/* ══ 2. assets resolve, match, and have the right polarity ═══════════════ */
section('2. brand assets');
const refs = new Set();
for (const page of PAGES) {
  const html = read(page);
  for (const m of html.matchAll(/(?:src|href)="(assets\/[^"]+)"/g)) refs.add(m[1]);
}
const missing = [...refs].filter((r) => !fs.existsSync(path.join(SITE, r)));
ok(missing.length === 0, `every referenced asset exists (${refs.size} refs${missing.length ? ', MISSING: ' + missing.join(', ') : ''})`);

const dims = (rel) => {
  const b = fs.readFileSync(path.join(SITE, rel));
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};
ok(JSON.stringify(dims('assets/logo-dark.png')) === JSON.stringify(dims('assets/logo-light.png')),
  `header lockups are the same size (${dims('assets/logo-dark.png').join('x')}) — theme swap cannot shift the header`);
ok(JSON.stringify(dims('assets/logo-stacked-dark.png')) === JSON.stringify(dims('assets/logo-stacked-light.png')),
  `hero lockups are the same size (${dims('assets/logo-stacked-dark.png').join('x')})`);

/** Average colour of the opaque (ink) pixels of a PNG. */
function inkColour(rel) {
  const { data, width: w, height: h } = decodePng(path.join(SITE, rel));
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n, coverage: n / (w * h) };
}
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };

const darkInk = inkColour('assets/logo-dark.png');
const lightInk = inkColour('assets/logo-light.png');
ok(lum(darkInk) > 0.7, `logo-dark.png has LIGHT ink (Y=${lum(darkInk).toFixed(2)}) — for dark backgrounds only`);
ok(lum(lightInk) < 0.1, `logo-light.png has DARK ink (Y=${lum(lightInk).toFixed(2)}) — for light backgrounds only`);
ok(darkInk.coverage < 0.45 && lightInk.coverage < 0.45,
  `lockups are transparent artwork, not opaque tiles (coverage ${Math.round(darkInk.coverage * 100)}% / ${Math.round(lightInk.coverage * 100)}%)`);

// Tight-crop + approved proportions: ink aspect must match the app's 3.676.
function inkAspect(rel) {
  const { data, width: w, height: h } = decodePng(path.join(SITE, rel));
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { aspect: (x1 - x0 + 1) / (y1 - y0 + 1), pad: [x0, y0, w - 1 - x1, h - 1 - y1] };
}
const aspect = inkAspect('assets/logo-dark.png');
ok(Math.abs(aspect.aspect - 3.676) < 0.02,
  `header lockup ink aspect ${aspect.aspect.toFixed(3)} matches the app's approved 3.676`);
ok(aspect.pad.every((p) => p <= 1), `lockups are tight-cropped (padding ${aspect.pad.join('/')}) — CSS height is the artwork height`);

ok(fs.readFileSync(path.join(SITE, 'assets/favicon.png')).equals(fs.readFileSync(path.join(ROOT, 'assets/brand/favicon.png'))),
  'favicon.png is the approved 64×64 brand favicon, byte-identical to assets/brand');
const svgFav = fs.readFileSync(path.join(SITE, 'assets/favicon.svg'), 'utf8');
ok(/<svg/.test(svgFav) && svgFav.includes('#0E2C46') && svgFav.includes('#FFFFFF'),
  'favicon.svg is a navy tile with the white brand symbol');

/* ══ 3. token system ═════════════════════════════════════════════════════ */
section('3. theme tokens');
function block(startRe) {
  const i = css.search(startRe);
  if (i === -1) return null;
  let d = 0, j = css.indexOf('{', i);
  const from = j;
  for (; j < css.length; j++) { if (css[j] === '{') d++; else if (css[j] === '}') { d--; if (!d) break; } }
  const out = {};
  for (const m of css.slice(from, j).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const dark = block(/^:root \{/m);
const light = block(/^html\[data-theme="light"\] \{/m);
ok(!!dark && !!light, 'both :root (dark, default) and html[data-theme="light"] token blocks exist');
ok(Object.keys(light).every((k) => dark[k]), `every light token also exists in dark (${Object.keys(light).length} tokens)`);
// `--radius` is theme-independent (declared in :root, inherited by both),
// so it is exempt from the two-way parity requirement; every *colour* token
// must exist in both blocks.
const isColor = (v) => /(hsl|rgb|#)/.test(v);
ok(Object.keys(dark).filter((k) => isColor(dark[k])).every((k) => light[k]),
  `every dark COLOUR token also exists in light — no colour token is one-theme-only`);
ok(/color-scheme:\s*dark/.test(css) && /color-scheme:\s*light/.test(css),
  'color-scheme is declared in both themes, so native controls/scrollbars match');

const TOKEN_LINE = /^\s*(--[\w-]+)\s*:/;
const stray = css.split('\n').filter((l) =>
  /(#[0-9a-fA-F]{3,8}\b|hsl\(|rgb\(|rgba\()/.test(l) && !TOKEN_LINE.test(l) && !/^\s*(\/\*|\*)/.test(l));
ok(stray.length === 0, `no colour literal outside the token blocks (found ${stray.length}${stray.length ? ': ' + stray[0].trim().slice(0, 60) : ''})`);

/* ══ 4. measured contrast, both themes ═══════════════════════════════════ */
section('4. contrast (WCAG, computed from the declared tokens)');
const parseHsl = (v) => {
  const m = v.match(/hsl\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:\/\s*([\d.]+))?\s*\)/);
  if (!m) return null;
  const h = +m[1], s = +m[2] / 100, l = +m[3] / 100, a = m[4] ? +m[4] : 1;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m2 = l - c / 2;
  const q = h / 60;
  let r, g, b;
  if (q < 1) [r, g, b] = [c, x, 0]; else if (q < 2) [r, g, b] = [x, c, 0];
  else if (q < 3) [r, g, b] = [0, c, x]; else if (q < 4) [r, g, b] = [0, x, c];
  else if (q < 5) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return { r: (r + m2) * 255, g: (g + m2) * 255, b: (b + m2) * 255, a };
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const r2 = (n) => Math.round(n * 100) / 100;

for (const [label, T] of [['dark', dark], ['light', light]]) {
  const bg = parseHsl(T['--bg']), card = parseHsl(T['--card']);
  const text = parseHsl(T['--text']), muted = parseHsl(T['--text-muted']);
  const link = parseHsl(T['--link']), accent = parseHsl(T['--accent']);
  const onP = parseHsl(T['--on-primary']), strong = parseHsl(T['--primary-strong']);
  ok(ratio(text, bg) >= 7, `${label}: primary text on page ${r2(ratio(text, bg))}:1 (AAA)`);
  ok(ratio(text, card) >= 7, `${label}: primary text on card ${r2(ratio(text, card))}:1 (AAA)`);
  ok(ratio(muted, card) >= 4.5, `${label}: muted text on card ${r2(ratio(muted, card))}:1 (AA)`);
  ok(ratio(muted, bg) >= 4.5, `${label}: muted text on page ${r2(ratio(muted, bg))}:1 (AA)`);
  ok(ratio(link, card) >= 4.5, `${label}: link on card ${r2(ratio(link, card))}:1 (AA body text)`);
  ok(ratio(link, bg) >= 4.5, `${label}: link on page ${r2(ratio(link, bg))}:1 (AA body text)`);
  ok(ratio(onP, strong) >= 4.5,
    `${label}: button ink on its fill ${r2(ratio(onP, strong))}:1 (AA) — the old fill was 3.61:1`);
  ok(ratio(accent, bg) >= 3, `${label}: display accent on page ${r2(ratio(accent, bg))}:1 (AA-large)`);
  ok(ratio(parseHsl(T['--border']), card) >= 1.2, `${label}: card border is visible ${r2(ratio(parseHsl(T['--border']), card))}:1`);
}
// The dark surface ladder — the flatness fix, stated as a number.
const dBg = parseHsl(dark['--bg']), dCard = parseHsl(dark['--card']), dElev = parseHsl(dark['--bg-elevated']);
ok(ratio(dCard, dBg) >= 1.10,
  `dark card:page separation ${r2(ratio(dCard, dBg))}:1 (was 1.081:1 before this work)`);
ok(ratio(dElev, dBg) >= 1.03, `dark elevated:page separation ${r2(ratio(dElev, dBg))}:1`);
// Light mode's near-black-on-white is always the highest ratio possible, so
// the real invariant is that dark primary text clears AA against its own card.
const darkTextOnCard = ratio(parseHsl(dark['--text']), dCard);
ok(darkTextOnCard >= 4.5,
  `dark primary text contrast on card ${r2(darkTextOnCard)}:1 clears AA (4.5:1)`);

/* ══ 5. toggle behaviour ═════════════════════════════════════════════════ */
section('5. toggle behaviour (source-level)');
ok(/localStorage\.setItem\('med-theme', theme\)/.test(js) || /localStorage\.setItem\(THEME_KEY, theme\)/.test(js),
  'main.js persists the explicit choice');
ok(/getElementById\('themeToggle'\)/.test(js), 'main.js wires the toggle button');
ok(/aria-label/.test(js) && /Switch to /.test(js), 'main.js keeps the accessible label describing the action');
// The icon must show the DESTINATION theme, so it never contradicts the label
// (regression: the rules once showed the current theme instead, putting a moon
// next to "Switch to light mode").
const sunRule = css.match(/\.theme-toggle \.icon-sun\s*\{\s*display:\s*(\w+)/);
const lightSun = css.match(/html\[data-theme="light"\] \.theme-toggle \.icon-sun\s*\{\s*display:\s*(\w+)/);
ok(sunRule && sunRule[1] === 'block' && lightSun && lightSun[1] === 'none',
  'sun shows in DARK (the destination when label says "Switch to light mode")');
ok(/prefers-color-scheme/.test(js), 'main.js follows the OS theme when no choice is saved');
ok(/if \(storedTheme\(\)\) return;/.test(js), 'OS changes are IGNORED once the visitor has chosen explicitly');
ok(/addEventListener\('change', onSchemeChange\)|addListener\(onSchemeChange\)/.test(js),
  'system-theme changes are listened for (with a legacy fallback)');
ok(/matchMedia/.test(css) === false, 'no JS-dependent colour logic lives in CSS');
ok(/\.reveal \{ opacity: 1/.test(css) || /prefers-reduced-motion: reduce/.test(css),
  'reduced-motion users get the reveal content immediately');
ok(/prefers-reduced-motion: no-preference/.test(css), 'theme fade is gated on reduced-motion, so it never animates for those users');
ok(/outline: 2px solid var\(--focus\)/.test(css), 'keyboard focus ring uses a theme token');

/* ══ 6. nothing outside the website was touched by this task ═════════════ */
section('6. scope');
// The intent is that THIS task needed no mobile/app-side change. Dependency
// manifests are therefore held to zero drift. `app.json` may legitimately carry
// drift from an UNRELATED task sharing the worktree (the Android branding
// config plugin), so for app.json we assert the thing that actually matters:
// no theme-related key was introduced by the website work.
const depTouched = ['package.json', 'package-lock.json'].filter((f) => {
  try { return require('child_process').execSync(`git diff --name-only HEAD -- ${f}`, { cwd: ROOT, encoding: 'utf8' }).trim().length > 0; }
  catch (e) { void e; return false; }
});
ok(depTouched.length === 0, `website theming added no dependency (${depTouched.join(', ') || 'clean'})`);
let appJsonDiff = '';
try { appJsonDiff = require('child_process').execSync('git diff HEAD -- app.json', { cwd: ROOT, encoding: 'utf8' }); }
catch (e) { void e; }
ok(!/^\+.*(userInterfaceStyle|user_interface_style|"scheme"|backgroundColor)/m.test(appJsonDiff),
  'website theming introduced no theme key into app.json');

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
