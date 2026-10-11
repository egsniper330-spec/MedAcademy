'use strict';
/**
 * android-brand-resources.js — the ONE owner of the Android brand resources.
 *
 * WHY THIS EXISTS (root cause of "Android still shows the old branding")
 * ─────────────────────────────────────────────────────────────────────────────
 * `android/` is generated output. Every Android brand resource therefore has
 * exactly two possible sources of truth:
 *
 *   1. `app.json`      — the launcher icon, adaptive foreground/background,
 *                        monochrome layer and notification icon. Expo's own
 *                        prebuild plugins rasterize these from `assets/`.
 *   2. nothing at all  — the Android SPLASH SCREEN. `expo-splash-screen` is not
 *                        installed and `app.json` has no `splash` key, so NO
 *                        prebuild plugin owns `splashscreen_logo.png`,
 *                        `splashscreen_background` or `Theme.App.SplashScreen`.
 *                        Those files were last written by hand on 2026-09-19
 *                        and survive `expo prebuild --clean` untouched — which
 *                        is why the OLD launch-screen logo never went away no
 *                        matter how the assets were updated.
 *
 * On API 31+ there is a third symptom of the same gap: with no
 * `android:windowSplashScreenAnimatedIcon`, the OS falls back to drawing the
 * LAUNCHER ICON in the system splash. So a stale launcher icon was also a
 * stale launch screen.
 *
 * This module closes the gap by owning BOTH, from the single traced vector
 * master (`scripts/brand/identity-paths.js`) that also produces the in-app
 * logos — never by copying a bitmap out of a screenshot and never by
 * upscaling a smaller render:
 *
 *   mipmap-<density>/ic_launcher.png             legacy launcher icon  (pre-26)
 *   mipmap-<density>/ic_launcher_round.png       round launcher icon
 *   mipmap-<density>/ic_launcher_foreground.png  adaptive foreground (safe zone)
 *   mipmap-anydpi-v26/ic_launcher{,_round}.xml   adaptive icon descriptors
 *   drawable-<density>/notification_icon.png     notification status icon
 *   drawable-<density>/splashscreen_logo.png     launch-screen mark
 *   drawable/ic_launcher_background.xml          pre-31 splash layer-list
 *   values{,-night}/colors.xml                   splashscreen_background
 *   values/styles.xml                            Theme.App.SplashScreen
 *
 * It is invoked from two places, so the fix survives a clean prebuild AND
 * repairs the checkout that already exists:
 *   • plugins/withAndroidBranding.js — the Expo config plugin (prebuild)
 *   • scripts/apply-android-branding.js — the CLI (existing android/ tree)
 *
 * Geometry notes
 *   • The adaptive foreground and the splash mark are rendered by
 *     `fitInsideSafeDisc`, which measures the symbol's own radial extent and
 *     scales it so >=99.5 % of its opaque pixels lie inside the guaranteed
 *     visible disc (66/108 of the canvas). A circle, squircle, rounded square
 *     or teardrop mask therefore cannot clip it.
 *   • The legacy/round icon is the symbol on the brand-navy tile at the SAME
 *     proportions the iOS icon uses, so every platform shows one identity.
 *   • No mask, border or rounded corner is ever baked into a foreground.
 *
 * No dependency is added: every output is rasterized by the project's own
 * PNG encoder/rasterizer (`scripts/generate-android-icon-assets.js`).
 */

const fs = require('fs');
const path = require('path');

const { PALETTE, SYMBOL, bounds } = require('./identity-paths');
const {
  render,
  apply,
  fit,
  fitInsideSafeDisc,
  encodePng,
} = require('../generate-android-icon-assets');

const SYM_B = bounds(SYMBOL);

/** Android density buckets. `scale` is dp → px (mdpi is 1x). */
const DENSITIES = [
  { dir: 'mdpi', scale: 1 },
  { dir: 'hdpi', scale: 1.5 },
  { dir: 'xhdpi', scale: 2 },
  { dir: 'xxhdpi', scale: 3 },
  { dir: 'xxxhdpi', scale: 4 },
];

/** Nominal dp sizes — the canonical Android icon metrics. */
const LEGACY_ICON_DP = 48;        // pre-26 launcher icon / round icon
const ADAPTIVE_DP = 108;          // adaptive-icon layer canvas
const NOTIFICATION_DP = 24;       // status-bar notification icon
const SPLASH_LOGO_DP = 128;       // launch-screen mark box

/** Brand colours taken from the identity master (never re-typed hex). */
const BRAND = {
  light: PALETTE.navy,      // #0E2C46 — splash background, light configuration
  night: PALETTE.navyDeep,  // #081E33 — splash background, dark configuration
};

/** '#RRGGBB' → [r, g, b]. */
function toRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const WHITE = toRgb(PALETTE.onDark);
const NAVY = toRgb(PALETTE.navy);

/** Render → PNG bytes. `alpha: false` drops the alpha channel (opaque tiles). */
function png(size, layers, { alpha = true, ss = 4 } = {}) {
  const { data } = render(size, size, layers, ss, { alpha });
  return encodePng(size, size, data, alpha ? 6 : 2);
}

/* ───────────────────────── the four Android artworks ───────────────────── */

/**
 * Legacy / round launcher icon: opaque brand-navy tile, white symbol at 62 % of
 * the canvas — the exact geometry `assets/android-icon.png` uses, so the
 * pre-26 icon and the Play/iOS tile are one design.
 */
function legacyIcon(size) {
  const inset = { x: size * 0.19, y: size * 0.19, w: size * 0.62, h: size * 0.62 };
  return png(size, [
    { rect: { x: 0, y: 0, w: size, h: size }, color: NAVY },
    { loops: apply(SYMBOL, fit(SYMBOL, SYM_B, inset)), color: WHITE },
  ], { alpha: false });
}

/**
 * Adaptive foreground: TRANSPARENT, symbol only, fitted inside the guaranteed
 * visible disc by measuring its own radial extent. Equal to the approved
 * `assets/adaptive-icon.png` at the same canvas size.
 */
function adaptiveForeground(size) {
  const t = fitInsideSafeDisc(SYMBOL, SYM_B, size);
  return png(size, [{ loops: apply(SYMBOL, t), color: WHITE }]);
}

/**
 * Notification icon: a white silhouette on transparent (the OS tints it and
 * requires an alpha mask). 1/16 canvas inset keeps the glyph inside the
 * status-bar icon's optical bounds.
 */
function notificationIcon(size) {
  const pad = size / 16;
  const t = fit(SYMBOL, SYM_B, { x: pad, y: pad, w: size - 2 * pad, h: size - 2 * pad });
  return png(size, [{ loops: apply(SYMBOL, t), color: WHITE }]);
}

/**
 * Launch-screen mark: the same transparent, safe-disc-fitted symbol, so the
 * splash cannot be clipped by the API 31+ circular splash mask either.
 */
function splashLogo(size) {
  const t = fitInsideSafeDisc(SYMBOL, SYM_B, size);
  return png(size, [{ loops: apply(SYMBOL, t), color: WHITE }]);
}

/* ───────────────────────────── XML patching ────────────────────────────── */

/** Values are XML-escaped so a future palette entry cannot break the file. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Idempotently set `<color name="...">` inside a `<resources>` document.
 * Pure string work: these are small, stable, machine-generated resources and a
 * full XML round-trip would reformat (and churn) the whole file.
 */
function setColorResource(xml, name, value) {
  const line = '<color name="' + name + '">' + escapeXml(value) + '</color>';
  const re = new RegExp('<color\\s+name="' + name + '"\\s*>[\\s\\S]*?</color>');
  if (re.test(xml)) return xml.replace(re, line);
  if (/<resources\s*\/>/.test(xml)) {
    return '<resources>\n  ' + line + '\n</resources>\n';
  }
  return xml.replace(/<\/resources>/, '  ' + line + '\n</resources>');
}

/**
 * Replace a whole `<style>` block with a canonically formatted one (creating it
 * when absent). Rebuilding rather than item-patching keeps repeated runs
 * byte-stable, so "regenerate produced no diff" is a usable assertion.
 *
 * String concatenation is used deliberately in the RegExp construction: these
 * patterns carry XML-side semantics, and buildConfigGuards.test.cjs flags a
 * `${...}` interpolation inside a JS template literal as a possibly-leaked
 * Groovy variable.
 */
function setStyleBlock(xml, styleName, parent, lines) {
  const styleRe = new RegExp('\\s*<style\\s+name="' + styleName + '"[^>]*>[\\s\\S]*?</style>\n?');
  const block =
    '  <style name="' + styleName + '" parent="' + parent + '">\n' +
    lines.map((l) => '    ' + l).join('\n') + '\n' +
    '  </style>\n';
  // Both branches insert the SAME leading newline so the very first run is
  // already in the canonical form — a second run then rewrites nothing.
  if (styleRe.test(xml)) return xml.replace(styleRe, '\n' + block);
  return xml.replace(/<\/resources>/, '\n' + block + '</resources>');
}

/** Ensure `<resources>` declares the `tools` namespace (needed by targetApi). */
function ensureToolsNamespace(xml) {
  if (/<resources[^>]*xmlns:tools=/.test(xml)) return xml;
  return xml.replace(/<resources\b/, '<resources xmlns:tools="http://schemas.android.com/tools"');
}

/**
 * The pre-31 splash window background: brand colour + the centred mark.
 * The 31+ system splash ignores `windowBackground` and uses the dedicated
 * `windowSplashScreen*` items below, so both paths are covered.
 */
const SPLASH_BACKGROUND_DRAWABLE =
  '<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n' +
  '  <!-- Generated/maintained by scripts/brand/android-brand-resources.js — do not hand-edit. -->\n' +
  '  <item android:drawable="@color/splashscreen_background"/>\n' +
  '  <item>\n' +
  '    <bitmap android:gravity="center" android:src="@drawable/splashscreen_logo"/>\n' +
  '  </item>\n' +
  '</layer-list>\n';

/**
 * The splash theme.
 *
 * `android:windowSplashScreenAnimatedIcon` is the load-bearing item for the
 * reported "old logo on the initial launch screen": WITHOUT it, Android 12+
 * draws the app's LAUNCHER ICON in the system splash, so a stale launcher icon
 * meant a stale launch screen. Naming the mark explicitly decouples the two.
 */
function splashStyleItems() {
  return [
    '<item name="android:windowBackground">@drawable/ic_launcher_background</item>',
    '<item name="android:windowSplashScreenBackground" tools:targetApi="31">@color/splashscreen_background</item>',
    '<item name="android:windowSplashScreenAnimatedIcon" tools:targetApi="31">@drawable/splashscreen_logo</item>',
  ];
}

/* ──────────────────────────── the writer ───────────────────────────────── */

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_e) {
    return null;
  }
}

/**
 * Write only when the bytes differ, so re-running is a no-op (and CI can prove
 * "regenerating produced no diff"). `onWrite` receives the ABSOLUTE path.
 */
function writeIfChanged(file, content, { binary = false, onWrite } = {}) {
  let changed = true;
  try {
    const prev = fs.readFileSync(file);
    changed = binary ? !prev.equals(content) : prev.toString('utf8') !== content;
  } catch (_e) {
    changed = true;
  }
  if (!changed) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, binary ? undefined : 'utf8');
  if (onWrite) onWrite(file);
  return true;
}

/**
 * Delete a stale same-named sibling under a different extension. Android's
 * resource merger fails on two files that define the same resource in one
 * `res/` folder, and Expo's own icon pipeline emits `.webp` — so a hand-written
 * `.png` beside a leftover `.webp` would break the build instead of fixing it.
 */
function removeStaleExtension(file, onRemove) {
  const minified = file.replace(/\.png$/, '.webp');
  if (minified === file) return;
  if (fs.existsSync(minified)) {
    fs.unlinkSync(minified);
    if (onRemove) onRemove(minified);
  }
}

/**
 * Write every Android brand resource + patch the matching XML.
 *
 * @param {string} resDir `android/app/src/main/res` (absolute)
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {{ written: string[], removed: string[] }}
 */
function writeAndroidBrandResources(resDir, opts = {}) {
  const note = opts.log || (() => {});
  const written = [];
  const removed = [];
  const put = (file, content, binary) => {
    const did = writeIfChanged(file, content, {
      binary,
      onWrite: (f) => {
        written.push(f);
        note('wrote ' + path.relative(resDir, f));
      },
    });
    return did;
  };
  const drop = (file) => removeStaleExtension(file, (f) => {
    removed.push(f);
    note('removed stale ' + path.relative(resDir, f));
  });

  for (const { dir, scale } of DENSITIES) {
    const size = (dp) => Math.round(dp * scale);

    const legacyPath = path.join(resDir, 'mipmap-' + dir, 'ic_launcher.png');
    drop(legacyPath);
    put(legacyPath, legacyIcon(size(LEGACY_ICON_DP)), true);

    const roundPath = path.join(resDir, 'mipmap-' + dir, 'ic_launcher_round.png');
    drop(roundPath);
    put(roundPath, legacyIcon(size(LEGACY_ICON_DP)), true);

    const fgPath = path.join(resDir, 'mipmap-' + dir, 'ic_launcher_foreground.png');
    drop(fgPath);
    put(fgPath, adaptiveForeground(size(ADAPTIVE_DP)), true);

    // Android 13+ themed icon (the OS tints this stencil from the wallpaper
    // palette). A dedicated resource, not a shared alias, so a future
    // foreground change cannot silently alter the themed variant.
    put(
      path.join(resDir, 'mipmap-' + dir, 'ic_launcher_monochrome.png'),
      adaptiveForeground(size(ADAPTIVE_DP)),
      true
    );

    put(
      path.join(resDir, 'drawable-' + dir, 'notification_icon.png'),
      notificationIcon(size(NOTIFICATION_DP)),
      true
    );

    put(
      path.join(resDir, 'drawable-' + dir, 'splashscreen_logo.png'),
      splashLogo(size(SPLASH_LOGO_DP)),
      true
    );
  }

  // ── adaptive-icon descriptors (API 26+) ────────────────────────────────────
  // `<monochrome>` is the Android 13+ themed-icon layer. It is the same stencil
  // as the foreground; the OS tints it from the user's wallpaper palette.
  const adaptiveXml =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@color/iconBackground"/>\n' +
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n' +
    '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n' +
    '</adaptive-icon>\n';
  put(path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptiveXml, false);
  put(path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptiveXml, false);

  // ── pre-31 splash background ──────────────────────────────────────────────
  put(path.join(resDir, 'drawable', 'ic_launcher_background.xml'), SPLASH_BACKGROUND_DRAWABLE, false);

  // ── splash background colour, light + night ──────────────────────────────
  const valuesColors = path.join(resDir, 'values', 'colors.xml');
  const lightColorsXml = readIfExists(valuesColors);
  if (lightColorsXml !== null) {
    // `iconBackground` is the adaptive-icon background layer. It is pinned to
    // the same brand navy as `app.json`'s `android.adaptiveIcon.backgroundColor`
    // so the generated resource cannot drift away from the source config (it
    // previously held a third, slightly different navy: #081A35).
    let patched = setColorResource(lightColorsXml, 'splashscreen_background', BRAND.light);
    patched = setColorResource(patched, 'iconBackground', PALETTE.navy);
    put(valuesColors, patched, false);
  }
  const nightColors = path.join(resDir, 'values-night', 'colors.xml');
  const nightXml = readIfExists(nightColors);
  if (nightXml !== null) {
    put(nightColors, setColorResource(nightXml, 'splashscreen_background', BRAND.night), false);
  }

  // ── splash theme ─────────────────────────────────────────────────────────
  const valuesStyles = path.join(resDir, 'values', 'styles.xml');
  const stylesXml = readIfExists(valuesStyles);
  if (stylesXml !== null) {
    const patched = setStyleBlock(
      ensureToolsNamespace(stylesXml),
      'Theme.App.SplashScreen',
      'AppTheme',
      splashStyleItems()
    );
    put(valuesStyles, patched, false);
  }

  return { written, removed };
}

module.exports = {
  writeAndroidBrandResources,
  // Exported for tests/androidBranding.test.cjs — pure, no filesystem access.
  legacyIcon,
  adaptiveForeground,
  notificationIcon,
  splashLogo,
  setColorResource,
  setStyleBlock,
  ensureToolsNamespace,
  splashStyleItems,
  SPLASH_BACKGROUND_DRAWABLE,
  DENSITIES,
  LEGACY_ICON_DP,
  ADAPTIVE_DP,
  NOTIFICATION_DP,
  SPLASH_LOGO_DP,
  BRAND,
  toRgb,
};
