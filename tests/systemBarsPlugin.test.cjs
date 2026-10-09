#!/usr/bin/env node
/**
 * Android system navigation bar — light/dark integration contract.
 *
 * The reported symptom was a DETACHED bright-white (or black) strip at the bottom
 * of the screen in the NORMAL app UI: `android:enforceNavigationBarContrast`
 * makes the OS paint an opaque scrim behind the transparent, edge-to-edge
 * navigation bar, and the scrim colour is chosen by the OS — so hardcoding a
 * colour can never fix it.
 *
 * This suite pins the fix end to end:
 *
 *   A. plugins/withSystemBars.js (theme level)
 *      - disables the OS contrast scrim in values/ and values-night/
 *      - seeds the per-theme ICON appearance (true in light, false in dark)
 *      - re-asserts a transparent navigationBarColor
 *      - is idempotent (a second prebuild changes nothing)
 *
 *   B. src/lib/useSystemBars.ts (runtime level)
 *      - maps dark → 'light' icons and light → 'dark' icons
 *      - never sets a background colour (no second owner of the surface)
 *
 *   C. src/app/_layout.tsx (edge-to-edge)
 *      - absolute position + transparent bar, no hardcoded solid colour
 *      - no hardcoded icon style (that was the dark-mode bug)
 *
 *   D. ownership: fullscreen is the ONLY thing that hides the bar.
 *
 * Usage: node tests/systemBarsPlugin.test.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}

const plugin = require(path.join(ROOT, 'plugins', 'withSystemBars.js'));
const { patchStyles, ensureToolsNamespace, NIGHT_STYLES_TEMPLATE, NAV_BAR_CONTRAST_ITEM } = plugin.__internal || {};

console.log('A: withSystemBars.js patches the Android theme correctly');
{
  ok(typeof plugin === 'function', 'plugin module is a config-plugin function');
  ok(!!patchStyles && !!ensureToolsNamespace, 'pure helpers are exposed for testing');

  // A light-theme styles.xml shaped like the Expo template (solid scrim enforced,
  // no navigationBarColor item, no tools namespace).
  const lightXml = `<resources>
  <style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar">
    <item name="android:editTextBackground">@drawable/rn_edit_text_material</item>
    <item name="colorPrimary">@color/colorPrimary</item>
    <item name="android:enforceNavigationBarContrast">true</item>
  </style>
</resources>
`;

  const light = patchStyles(lightXml, { lightNavBarIcons: true });

  ok(/xmlns:tools="http:\/\/schemas\.android\.com\/tools"/.test(light),
    'adds the tools namespace required by tools:targetApi');
  ok(/<item name="android:enforceNavigationBarContrast"[^>]*>false<\/item>/.test(light),
    'LIGHT: disables android:enforceNavigationBarContrast (removes the OS scrim)');
  ok(!/<item name="android:enforceNavigationBarContrast"[^>]*>true<\/item>/.test(light),
    'LIGHT: the old enforced-contrast value is gone, not duplicated');
  ok(/<item name="android:windowLightNavigationBar">true<\/item>/.test(light),
    'LIGHT: windowLightNavigationBar=true → dark icons on a light surface');
  ok(/<item name="android:navigationBarColor">@android:color\/transparent<\/item>/.test(light),
    'LIGHT: navigationBarColor stays transparent (edge-to-edge)');

  const lightAgain = patchStyles(light, { lightNavBarIcons: true });
  ok(lightAgain === light, 'patching twice is idempotent (safe on every prebuild)');

  const dark = patchStyles(light, { lightNavBarIcons: false });
  ok(/<item name="android:windowLightNavigationBar">false<\/item>/.test(dark),
    'DARK: windowLightNavigationBar=false → light icons on a dark surface');
  ok(/<item name="android:enforceNavigationBarContrast"[^>]*>false<\/item>/.test(dark),
    'DARK: contrast scrim stays disabled (no black band / white rectangle)');
  ok((dark.match(/windowLightNavigationBar/g) || []).length === 1,
    'no duplicate windowLightNavigationBar items after switching themes');

  ok(/name="android:enforceNavigationBarContrast"[^>]*>false/.test(NAV_BAR_CONTRAST_ITEM),
    'the shared contrast item constant is the disabled form');
  ok(/windowLightNavigationBar">false</.test(NIGHT_STYLES_TEMPLATE) &&
     /navigationBarColor">@android:color\/transparent</.test(NIGHT_STYLES_TEMPLATE),
    'the values-night template seeds dark icons + a transparent bar');
  ok(/enforceNavigationBarContrast"[^>]*>false</.test(NIGHT_STYLES_TEMPLATE),
    'the values-night template disables the contrast scrim too');

  const noStyle = ensureToolsNamespace('<resources></resources>');
  ok(/xmlns:tools=/.test(noStyle) && !/xmlns:tools=.*xmlns:tools=/.test(noStyle),
    'ensureToolsNamespace is idempotent');

  // A styles.xml WITHOUT an AppTheme must pass through untouched (never corrupt).
  const otherXml = '<resources>\n  <style name="Other"/>\n</resources>\n';
  ok(patchStyles(otherXml, { lightNavBarIcons: true }) === otherXml ||
     !/navigationBarColor/.test(patchStyles(otherXml, { lightNavBarIcons: true })),
    'a styles.xml without AppTheme is left functionally untouched');
}

console.log('B: useSystemBars.ts keeps the icon appearance in sync at runtime');
{
  const hook = read('src/lib/useSystemBars.ts');
  ok(/isDark \? 'light' : 'dark'/.test(hook),
    "hook maps dark mode → 'light' icons and light mode → 'dark' icons");
  ok(/setButtonStyleAsync/.test(hook), 'hook drives expo-navigation-bar icon style');
  ok(!/setBackgroundColorAsync/.test(hook),
    'hook never sets a bar background colour (the surface owns the colour, not the OS)');
  ok(/Platform\.OS !== 'android'/.test(hook), 'hook is Android-only (no-op elsewhere)');
  ok(/\[isDark\]/.test(hook), 'hook re-applies on every light↔dark change');
}

console.log('C: root layout is edge-to-edge with no hardcoded bar colour');
{
  const layout = read('src/app/_layout.tsx');
  // Strip line comments: the file documents the OLD hardcoded call in prose, and
  // a comment must never be mistaken for live code.
  const layoutCode = layout.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/setPositionAsync\('absolute'\)/.test(layoutCode),
    'layout sets the bar to absolute (content draws behind it)');
  ok(/setBackgroundColorAsync\('#00000000'\)/.test(layoutCode),
    'layout sets a fully transparent bar background (0x00000000), not white/black');
  ok(!/setButtonStyleAsync\(\s*'dark'\s*\)/.test(layoutCode),
    'layout no longer hardcodes the dark icon style (that froze dark-mode icons)');
  ok(/useSystemBars\(/.test(layout), 'layout delegates icon appearance to useSystemBars');
  ok(/expo-navigation-bar/.test(read('package.json')),
    'expo-navigation-bar is a declared dependency (not an implicit transitive import)');
}

console.log('D: ownership — only fullscreen hides the system bars');
{
  const fullscreen = read('src/lib/fullscreenSystemUi.ts');
  ok(/setVisibilityAsync|setPositionAsync|immersive/i.test(fullscreen),
    'fullscreen helper owns the hide/restore transition');
  ok(/show|restore|VISIBLE/i.test(fullscreen),
    'fullscreen helper restores the bars when leaving fullscreen');

  // No screen may hide the navigation bar on its own — that would fight the
  // fullscreen owner and leave the UI with a hidden bar after navigation.
  const screens = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) screens.push(full);
    }
  })(path.join(ROOT, 'src', 'app'));

  const offenders = [];
  for (const file of screens) {
    const src = fs.readFileSync(file, 'utf8');
    if (file.endsWith(path.join('lib', 'fullscreenSystemUi.ts'))) continue;
    if (/NavigationBar\.setVisibilityAsync/.test(src)) {
      offenders.push(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
  ok(offenders.length === 0,
    `no screen hides the system bars directly (offenders: ${offenders.join(', ') || 'none'})`);
}

console.log(failed
  ? `\nRESULT: ${passed} passed, ${failed} failed`
  : `\nPASS: ${passed} system-bar (light/dark nav bar) checks`);
process.exit(failed ? 1 : 0);
