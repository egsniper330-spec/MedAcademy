'use strict';
/**
 * Bottom-navigation clearance + top-inset regression tests.
 *
 * Reported defects:
 *   1. "Content on several screens extends underneath the fixed bottom tab bar.
 *      It can be scrolled up to reveal it, but snaps straight back."
 *      Root cause: on iOS the role shell uses the REAL native tab bar
 *      (react-native-bottom-tabs → UIKit), which is drawn outside the RN view
 *      hierarchy and floats OVER the content, while `useSafeAreaInsets()` only
 *      reports the home indicator. The bar's own height was never reserved, so
 *      the tail of the content sat under it and could only be rubber-banded into
 *      view (bounce, then snap back — the scrollable extent never covered it).
 *   2. "The doctor's profile avatar/header is clipped at the top."
 *      Root cause: that header is a sibling of the scroll container and used a
 *      hardcoded paddingTop: 20 with no status-bar / Dynamic-Island inset.
 *
 * These tests execute the REAL clearance module (through the project's
 * TypeScript) for iOS and Android/web, and pin the shared wiring that makes the
 * value reach every screen from one place.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const ts = require(path.join(ROOT, 'node_modules', 'typescript'));

/** Load a TS module as CJS with a stubbed `react-native`. */
function loadModule(relPath, platform) {
  const src = read(relPath);
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const m = { exports: {} };
  const fakeRequire = (id) => {
    if (id === 'react-native') return { Platform: platform };
    throw new Error('unexpected require: ' + id);
  };
  new Function('module', 'exports', 'require', js)(m, m.exports, fakeRequire);
  return m.exports;
}

/* ───────────── 1. iOS: reserve the native bar's own height ─────────────── */

const IOS_18 = loadModule('src/lib/tabBarClearance.ios.ts', { OS: 'ios', Version: '18.5' });
const IOS_26 = loadModule('src/lib/tabBarClearance.ios.ts', { OS: 'ios', Version: '26.0' });

ok(IOS_18.tabBarClearance(false) === 49,
  'iOS < 26: portrait reserves the standard UITabBar height (49 pt)');
ok(IOS_18.tabBarClearance(true) === 32,
  'iOS < 26: landscape reserves the compact UITabBar height (32 pt)');
ok(IOS_26.tabBarClearance(false) === 56,
  'iOS 26+: portrait reserves the floating Liquid Glass bar height (56 pt)');
ok(IOS_26.tabBarClearance(true) === 44,
  'iOS 26+: landscape reserves the floating bar height (44 pt)');
ok(IOS_26.LIQUID_GLASS_TAB_BAR === true && IOS_18.LIQUID_GLASS_TAB_BAR === false,
  'the Liquid Glass branch is selected by iOS major version (>= 26)');
ok(IOS_18.tabBarClearance() === 49,
  'portrait is the default (no argument)');

/* ───── 2. Android / web: the JS bar is in the flow → NO extra space ─────── */

const OTHER = loadModule('src/lib/tabBarClearance.ts', { OS: 'android', Version: 34 });
ok(OTHER.tabBarClearance(false) === 0 && OTHER.tabBarClearance(true) === 0,
  'Android/web: zero extra clearance (the in-flow JS bar already shrinks the viewport)');
ok(!/from 'react-native'/.test(read('src/lib/tabBarClearance.ts')),
  'the non-iOS module imports nothing native (safe for the web bundle)');

/* ───── 3. one shared wiring point feeds every screen ───────────────────── */

const ds = read('src/lib/ds.ts');
ok(/import \{ tabBarClearance \} from '@\/lib\/tabBarClearance'/.test(ds),
  'useLayout() pulls the platform clearance from the shared module');
ok(/const barClearance = tabBarClearance\(win\.width > win\.height\)/.test(ds),
  'clearance is recomputed on orientation change (width > height)');
ok(/const pageBottom\s*=\s*safeBottom\(insets\.bottom, barClearance\)/.test(ds),
  'non-scrolling page padding includes the bar clearance');
ok(/\(extra = 0\) => safeBottom\(insets\.bottom, extra \+ barClearance\)/.test(ds),
  'scrollBottom() adds the bar clearance to every scroll container');
ok(/barClearance,/.test(ds),
  'the clearance is exposed on the layout object for floating elements');

/* ─────────────── 4. wrappers inherit it — no per-screen padding ─────────── */

const adaptive = read('src/components/AdaptiveScreen.tsx');
ok(/layout\.scrollBottom\(extraBottom\)/.test(adaptive),
  'AdaptiveScreen routes its bottom padding through the shared scrollBottom()');
ok(!/paddingBottom: *(4[0-9]|5[0-9]|6[0-9])\b/.test(adaptive),
  'AdaptiveScreen does not hardcode a bar-height bottom padding of its own');

/* ───── 5. doctor profile header: status-bar / Dynamic-Island inset ─────── */

const profile = read('src/app/(app)/(doctor)/dr-profile.tsx');
ok(/paddingTop: layout\.headerTop/.test(profile),
  'the doctor profile header uses the shared header top inset');
ok(!/paddingTop: 20, paddingHorizontal: layout\.screenPx/.test(profile),
  'the hardcoded paddingTop: 20 header is gone');
ok(/PageHeader/.test(read('src/components/PageHeader.tsx')) &&
   /safeTop\(insets\.top\)/.test(read('src/components/PageHeader.tsx')),
  'screens that use PageHeader still get the same inset primitive');

/* ─────────── 6. nothing re-introduces a programmatic scroll reset ──────── */

const offenders = [];
function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}
for (const f of walk(path.join(ROOT, 'src'), [])) {
  const s = fs.readFileSync(f, 'utf8');
  if (/scrollToOffset\(\s*\{\s*offset:\s*0/.test(s) || /scrollTo\(\s*\{\s*y:\s*0\s*\}\)/.test(s)) {
    offenders.push(path.relative(ROOT, f));
  }
}
ok(offenders.length === 0,
  'no screen force-resets its scroll position (snap-back was the bounce, not a reset): ' + offenders.join(', '));

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
