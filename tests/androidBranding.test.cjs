#!/usr/bin/env node
/**
 * Android branding coverage — asset, configuration and generated-resource suite.
 *
 * Run: node tests/androidBranding.test.cjs
 *
 * WHAT THIS LOCKS DOWN (root causes of "Android still shows the old branding")
 * ──────────────────────────────────────────────────────────────────────────
 * A. NOBODY OWNED THE ANDROID SPLASH. `expo-splash-screen` is not installed and
 *    app.json had no `splash` key, so no prebuild plugin wrote
 *    splashscreen_logo.png / splashscreen_background / Theme.App.SplashScreen.
 *    Those files were hand-written once and survived every prebuild, so the old
 *    mark and a WHITE background persisted no matter how `assets/` changed.
 *
 * B. ON API 31+ THE LAUNCH SCREEN *IS* THE LAUNCHER ICON. With no
 *    android:windowSplashScreenAnimatedIcon the Android 12+ system splash draws
 *    the launcher icon, which is why a stale launcher icon also looked like a
 *    stale launch screen.
 *
 * C. GENERATED OUTPUT HAD DRIFTED. `android/` is untracked build output, and
 *    the mipmaps / notification icons were rasterized from the PREVIOUS
 *    identity and never regenerated, because this project's build path is
 *    `gradlew assembleRelease` (no prebuild step).
 *
 * The fix is one source-controlled owner of every Android brand resource
 * (scripts/brand/android-brand-resources.js), invoked from BOTH the Expo config
 * plugin (durable across `prebuild --clean`) and a CLI (repairs the existing
 * checkout). These tests assert the outcome on the REAL files, not the
 * generator's own return values.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ── Minimal PNG decoder (grayscale/RGB/RGBA, 8-bit, non-interlaced) ──────────
function decodePng(file) {
  const b = fs.readFileSync(file);
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    if (type === 'IHDR') {
      ihdr = {
        w: b.readUInt32BE(off + 8),
        h: b.readUInt32BE(off + 12),
        depth: b[off + 16],
        color: b[off + 17],
        interlace: b[off + 20],
      };
    }
    if (type === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ihdr.color === 6 ? 4 : ihdr.color === 2 ? 3 : 1;
  const stride = ihdr.w * ch;
  const out = Buffer.alloc(ihdr.h * stride);
  let pos = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const bb = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + bb) & 255;
      else if (f === 3) v = (v + ((a + bb) >> 1)) & 255;
      else if (f === 4) {
        const pa = Math.abs(bb - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + bb - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 255;
      }
      cur[x] = v;
    }
  }
  return { w: ihdr.w, h: ihdr.h, ch, color: ihdr.color, interlace: ihdr.interlace, data: out };
}

/** Opaque-pixel bbox, padding, safe-disc containment, mean ink luminance. */
function analyse(file) {
  const im = decodePng(file);
  const { w, h, ch, data } = im;
  const alpha = ch === 4;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = (w / 2) * (66 / 108);
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  let inside = 0, outside = 0, inkSum = 0, inkN = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      const a = alpha ? data[i + 3] : 255;
      if (a < 8) continue;
      if (Math.hypot(x - cx, y - cy) <= R) inside++; else outside++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      inkSum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      inkN++;
    }
  }
  return {
    w, h, ch,
    padL: x0 === Infinity ? null : x0,
    padR: x1 < 0 ? null : w - 1 - x1,
    padT: y0 === Infinity ? null : y0,
    padB: y1 < 0 ? null : h - 1 - y1,
    insidePct: inside + outside ? (100 * inside) / (inside + outside) : 0,
    meanInkLum: inkN ? inkSum / inkN : 0,
  };
}

// ── Part 1: the source-controlled owners exist ──────────────────────────────
console.log('── Part 1: single source of truth ──');
{
  check('1a: the shared Android brand-resource generator exists',
    exists('scripts/brand/android-brand-resources.js'));
  check('1b: the Expo config plugin exists', exists('plugins/withAndroidBranding.js'));
  check('1c: the CLI that repairs an existing android/ tree exists',
    exists('scripts/apply-android-branding.js'));
  check('1d: the vector identity master it renders from exists',
    exists('scripts/brand/identity-paths.js'));
  check('1e: the generator adds NO dependency (pure Node PNG encoder)',
    !/require\(['"](sharp|canvas|jimp|pngjs)/.test(read('scripts/brand/android-brand-resources.js')));
}

// ── Part 2: Expo configuration ─────────────────────────────────────────────
console.log('── Part 2: app.json icon configuration ──');
{
  const app = JSON.parse(read('app.json'));
  const e = app.expo || app;
  check('2a: android.icon is set (pre-26 launcher icon)', typeof e.android.icon === 'string');
  check('2b: adaptiveIcon.foregroundImage is set', typeof e.android.adaptiveIcon.foregroundImage === 'string');
  check('2c: adaptiveIcon.backgroundColor is the brand navy',
    e.android.adaptiveIcon.backgroundColor.toUpperCase() === '#0E2C46');
  check('2d: adaptiveIcon.monochromeImage is configured (Android 13+ themed icons)',
    typeof e.android.adaptiveIcon.monochromeImage === 'string');
  check('2e: iOS icon variants are left intact (light/dark/tinted)',
    e.ios.icon.light === './assets/icon.png' && !!e.ios.icon.dark && !!e.ios.icon.tinted);
  for (const key of [
    e.icon,
    e.android.icon,
    e.android.adaptiveIcon.foregroundImage,
    e.android.adaptiveIcon.monochromeImage,
    e.ios.icon.light,
    e.ios.icon.dark,
    e.ios.icon.tinted,
  ]) {
    check('2f: referenced asset exists: ' + key, exists(key.replace(/^\.\//, '')));
  }
  check('2g: the Android branding plugin is registered in the plugins list',
    (e.plugins || []).includes('./plugins/withAndroidBranding'));
  check('2h: the application id is unchanged', e.android.package === 'com.medacademy.app');
}

// ── Part 3: legacy assets are gone and unreferenced ────────────────────────
console.log('── Part 3: legacy branding removed ──');
{
  check('3a: the legacy brand raster is deleted', !exists('assets/brand/icon.png'));
  check('3b: the legacy Python brand generator is deleted', !exists('assets/brand/generate_brand.py'));
  // Scan every source-controlled file that could reference it — EXCLUDING this
  // test, whose own pattern text would otherwise match itself.
  const NEEDLE = 'brand/' + 'icon.png';
  const scanRoots = ['src', 'tests', 'scripts', 'plugins', 'website'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|js|cjs|mjs|json|html|md)$/.test(entry.name)) continue;
      if (full.endsWith('androidBranding.test.cjs')) continue;
      if (fs.readFileSync(full, 'utf8').includes(NEEDLE)) offenders.push(path.relative(ROOT, full));
    }
  };
  for (const r of scanRoots) if (fs.existsSync(path.join(ROOT, r))) walk(path.join(ROOT, r));
  check('3c: the removed legacy asset is referenced nowhere in source (found: ' + offenders.length + ')',
    offenders.length === 0);
  check('3d: app.json references no removed asset', !read('app.json').includes(NEEDLE));
}

// ── Part 4: in-app branding stays centralized ─────────────────────────────
console.log('── Part 4: in-app branding (Android-visible screens) ──');
{
  check('4a: BrandLogo is the only module requiring brand assets',
    /require\('\.\.\/\.\.\/assets\/brand\/logo-light\.png'\)/.test(read('src/components/BrandLogo.tsx')));
  for (const [rel, why] of [
    ['src/app/(auth)/sign-in.tsx', 'Sign In'],
    ['src/app/(auth)/sign-up.tsx', 'Create Account'],
    ['src/components/DrawerNav.tsx', 'account/profile menu'],
    ['src/components/ForceUpdateScreen.tsx', 'update screen'],
    ['src/app/index.tsx', 'launch/loading screen'],
  ]) {
    const src = read(rel);
    check('4b: ' + why + ' renders the shared BrandLogo', /<BrandLogo/.test(src));
    check('4b: ' + why + ' does not require a brand asset directly',
      !/require\(['"][^'"]*assets\//.test(src));
  }
  check('4c: BrandLogo never stretches or crops (contentFit="contain")',
    /contentFit="contain"/.test(read('src/components/BrandLogo.tsx')));
  check('4d: BrandLogo selects its variant from the live theme (useColorScheme)',
    /useColorScheme/.test(read('src/components/BrandLogo.tsx')));
}

// ── Part 5: the GENERATED Android resources (real files on disk) ───────────
console.log('── Part 5: generated Android resources ──');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const HAS_ANDROID = fs.existsSync(RES);
if (!HAS_ANDROID) {
  console.log('  (skipped — android/ not generated in this checkout; the config plugin covers prebuild)');
} else {
  const DENS = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]];

  for (const [d, s] of DENS) {
    const fg = analyse(path.join(RES, 'mipmap-' + d, 'ic_launcher_foreground.png'));
    const want = Math.round(108 * s);
    check('5a: ' + d + ' adaptive foreground is ' + want + 'x' + want, fg.w === want && fg.h === want);
    check('5a: ' + d + ' adaptive foreground has alpha', fg.ch === 4);
    check('5a: ' + d + ' adaptive foreground fits the 66/108 safe disc (' + fg.insidePct.toFixed(2) + '%)',
      fg.insidePct >= 99.5);
    check('5a: ' + d + ' adaptive foreground is centred',
      Math.abs(fg.padL - fg.padR) <= 1 && Math.abs(fg.padT - fg.padB) <= 1);

    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const im = decodePng(path.join(RES, 'mipmap-' + d, name));
      check('5b: ' + d + ' ' + name + ' is opaque (no alpha)',
        im.color === 2 || im.color === 0);
    }
    check('5b: ' + d + ' ic_launcher_monochrome.png exists (themed icon layer)',
      fs.existsSync(path.join(RES, 'mipmap-' + d, 'ic_launcher_monochrome.png')));

    // No duplicate-resource hazard: Android fails the build when a .png and a
    // .webp define the same resource in one res/ folder.
    for (const [dir, n] of [
      ['mipmap', 'ic_launcher'], ['mipmap', 'ic_launcher_round'],
      ['mipmap', 'ic_launcher_foreground'], ['drawable', 'notification_icon'],
      ['drawable', 'splashscreen_logo'],
    ]) {
      const png = path.join(RES, dir + '-' + d, n + '.png');
      const webp = path.join(RES, dir + '-' + d, n + '.webp');
      check('5c: ' + d + ' ' + n + ' has no stale .webp sibling alongside',
        !fs.existsSync(png) || !fs.existsSync(webp));
    }

    const splash = analyse(path.join(RES, 'drawable-' + d, 'splashscreen_logo.png'));
    check('5d: ' + d + ' splash mark is transparent', splash.ch === 4);
    check('5d: ' + d + ' splash mark fits the API-31 safe circle (' + splash.insidePct.toFixed(2) + '%)',
      splash.insidePct >= 99.5);
    check('5d: ' + d + ' splash mark is centred',
      Math.abs(splash.padL - splash.padR) <= 1 && Math.abs(splash.padT - splash.padB) <= 1);

    const notif = analyse(path.join(RES, 'drawable-' + d, 'notification_icon.png'));
    check('5e: ' + d + ' notification icon is ' + Math.round(24 * s) + 'px with alpha',
      notif.w === Math.round(24 * s) && notif.ch === 4);
  }

  // ── XML contract ─────────────────────────────────────────────────────────
  const styles = read('android/app/src/main/res/values/styles.xml');
  check('5f: Theme.App.SplashScreen exists in values/styles.xml',
    /<style name="Theme\.App\.SplashScreen"/.test(styles));
  check('5f: the API 31+ splash icon is the BRAND MARK, not the launcher icon',
    /android:windowSplashScreenAnimatedIcon[^>]*>@drawable\/splashscreen_logo</.test(styles));
  check('5f: the API 31+ splash background is the brand colour resource',
    /android:windowSplashScreenBackground[^>]*>@color\/splashscreen_background</.test(styles));
  check('5f: the pre-31 splash windowBackground is still set',
    /android:windowBackground[^>]*>@drawable\/ic_launcher_background</.test(styles));

  const colors = read('android/app/src/main/res/values/colors.xml');
  const nightColors = read('android/app/src/main/res/values-night/colors.xml');
  check('5g: light splash background is brand navy #0E2C46',
    /splashscreen_background">#0E2C46</.test(colors));
  check('5g: night splash background is deep navy #081E33',
    /splashscreen_background">#081E33</.test(nightColors));
  check('5g: the legacy WHITE splash background is gone', !/splashscreen_background">#FFFFFF</.test(colors));
  check('5g: the adaptive icon background matches app.json (#0E2C46)',
    /iconBackground">#0E2C46</.test(colors));

  const adaptive = read('android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml');
  check('5h: the adaptive descriptor wires background/foreground/monochrome',
    /<background android:drawable="@color\/iconBackground"\/>/.test(adaptive)
    && /<foreground android:drawable="@mipmap\/ic_launcher_foreground"\/>/.test(adaptive)
    && /<monochrome android:drawable="@mipmap\/ic_launcher_monochrome"\/>/.test(adaptive));
  check('5h: no rounded-square / circular mask is baked into the foreground',
    !/(mask|border|corner)/i.test(adaptive));

  const layer = read('android/app/src/main/res/drawable/ic_launcher_background.xml');
  check('5i: the pre-31 splash layer-list centres the mark over the brand colour',
    /@color\/splashscreen_background/.test(layer) && /@drawable\/splashscreen_logo/.test(layer));
}

// ── Part 6: the generator is deterministic and idempotent ──────────────────
console.log('── Part 6: generator determinism ──');
{
  const brand = require(path.join(ROOT, 'scripts', 'brand', 'android-brand-resources.js'));
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-b-'));

  // A pristine res/ skeleton, exactly the files the generator patches.
  const seed = (dir) => {
    fs.mkdirSync(path.join(dir, 'values'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'values-night'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'values', 'colors.xml'),
      '<resources>\n  <color name="splashscreen_background">#FFFFFF</color>\n</resources>\n');
    fs.writeFileSync(path.join(dir, 'values-night', 'colors.xml'), '<resources/>\n');
    fs.writeFileSync(path.join(dir, 'values', 'styles.xml'),
      '<resources><style name="AppTheme" parent="X"></style></resources>\n');
  };
  seed(a);
  seed(b);

  const first = brand.writeAndroidBrandResources(a, {});
  const second = brand.writeAndroidBrandResources(a, {});
  brand.writeAndroidBrandResources(b, {});

  check('6a: a first run writes resources', first.written.length >= 30);
  check('6b: a second run writes NOTHING (idempotent)', second.written.length === 0 && second.removed.length === 0);

  // Byte-for-byte reproducibility (no timestamps, no RNG in the encoder).
  const names = fs.readdirSync(path.join(a, 'mipmap-mdpi')).sort();
  let identical = names.length > 0;
  for (const n of names) {
    const ba = fs.readFileSync(path.join(a, 'mipmap-mdpi', n));
    const bb = fs.readFileSync(path.join(b, 'mipmap-mdpi', n));
    if (!ba.equals(bb)) identical = false;
  }
  check('6c: two independent runs produce byte-identical assets', identical);

  const xml = fs.readFileSync(path.join(a, 'values', 'styles.xml'), 'utf8');
  check('6d: the generator creates Theme.App.SplashScreen when absent',
    /<style name="Theme\.App\.SplashScreen" parent="AppTheme">/.test(xml));
  check('6e: it rewrites the legacy white splash colour',
    /splashscreen_background">#0E2C46</.test(fs.readFileSync(path.join(a, 'values', 'colors.xml'), 'utf8')));

  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (!HAS_ANDROID) console.log('note: generated-resource checks were SKIPPED (no android/ tree present)');
process.exit(failed ? 1 : 0);
