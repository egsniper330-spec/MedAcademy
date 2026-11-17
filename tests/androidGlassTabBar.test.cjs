/**
 * Android floating glass tab bar — regression guard.
 *
 * WHY THIS TEST EXISTS
 *   The dark band around the floating pill has been "fixed" and come back more
 *   than once, because the guarantee lives in two different files:
 *     1. GlassTabBar's root must be an ABSOLUTE, TRANSPARENT overlay (an
 *        in-flow bar reserves a strip that is painted by the screen background).
 *     2. The navigator's tab-bar wrapper must not paint either (its default
 *        style/shadow would draw a full-width band behind the pill).
 *   A refactor that drops either one reintroduces the symptom silently — the
 *   app still works, TypeScript still compiles. These assertions are cheap and
 *   fail loudly instead.
 *
 * Run: node tests/androidGlassTabBar.test.cjs
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const glass = read('src/components/navigation/GlassTabBar.tsx');
const shell = read('src/components/navigation/RoleTabShell.tsx');

let failures = 0;
function ok(condition, message) {
  if (condition) {
    console.log('  ok   ' + message);
  } else {
    failures += 1;
    console.error('  FAIL ' + message);
  }
}

console.log('\nGlassTabBar: overlay discipline');

// The root container must be absolute + transparent.
const outerBlock = glass.slice(glass.indexOf('  outer: {'), glass.indexOf('  pill: {'));
ok(/position:\s*'absolute'/.test(outerBlock), "GlassTabBar root is position:'absolute' (does not reserve a strip)");
ok(/backgroundColor:\s*'transparent'/.test(outerBlock), 'GlassTabBar root paints no background');
ok(/left:\s*0/.test(outerBlock) && /right:\s*0/.test(outerBlock) && /bottom:\s*0/.test(outerBlock),
  'GlassTabBar root is pinned to the bottom edge, full width');
ok(!/navSurface/.test(glass), 'GlassTabBar never paints the navigation-surface colour');

// The pill keeps its own surface — the fix must not make the bar invisible.
const pillBlock = glass.slice(glass.indexOf('  pill: {'), glass.indexOf('  indicator: {'));
ok(/height:\s*BAR_HEIGHT/.test(pillBlock), 'pill keeps its fixed height');
ok(/borderRadius:\s*BAR_HEIGHT\s*\/\s*2/.test(pillBlock), 'pill keeps its rounded capsule shape');
ok(/overflow:\s*'hidden'/.test(pillBlock), 'pill clips its blur to its own rounded bounds');

// The blur must stay real where Android supports it, with a legible fallback.
// The blur METHOD is Android-only and is spread in conditionally, so web gets
// expo-blur's browser implementation (backdrop-filter) instead of a dead prop.
ok(/blurMethod: 'dimezisBlurViewSdk31Plus'/.test(glass)
  && /Platform\.OS === 'web' \? \{\} : \{ blurMethod/.test(glass),
  'real Android blur is still requested (API 31+), and only on native');
ok(/<BlurView/.test(glass) && !/Platform\.OS !== 'web' \? \(/.test(glass),
  'the web preview renders the SAME BlurView (browser backdrop-filter), not a mock-up');
ok(/rgba\(\s*11\s*,\s*35\s*,\s*55\s*,\s*0\.62\s*\)/.test(glass)
  && /rgba\(\s*232\s*,\s*238\s*,\s*246\s*,\s*0\.62\s*\)/.test(glass),
  'pill keeps its translucent glass body (dark + light) as the no-blur fallback');

console.log('\nGlassTabBar: direct drag of the indicator');

ok(/PanResponder\.create\(/.test(glass), 'the drag uses a real PanResponder gesture, not simulated presses');
ok(/onStartShouldSetPanResponder: \(\) => false/.test(glass),
  'touch-down is never claimed, so button taps are untouched');
ok(/onStartShouldSetPanResponderCapture: \(event\) => \{[\s\S]*?touchStart\.current = [\s\S]*?return false;/.test(glass),
  'the capture phase only records the touch start and declines (children keep their taps)');
ok(/const DRAG_THRESHOLD = \d+/.test(glass), 'a movement threshold separates a tap from a drag');
ok(/Math\.abs\(gesture\.dx\) < DRAG_THRESHOLD/.test(glass), 'the threshold gates claiming the gesture');
ok(/Math\.abs\(gesture\.dx\) <= Math\.abs\(gesture\.dy\) \* 1\.2/.test(glass),
  'vertical gestures (scroll / system nav) are never claimed');
ok(/start\.x - rect\.x/.test(glass) && /measureInWindow/.test(glass),
  'the grab is hit-tested against the measured pill rect in page coordinates (never gestureState.x0)');
ok(/const touchStart = useRef\(/.test(glass), 'the touch start point is captured from the responder event');
ok(/translateX\.setValue\(next\)/.test(glass), 'during the drag the indicator is driven by the touch coordinate');
ok(/onPanResponderRelease/.test(glass) && /finishDrag/.test(glass), 'release resolves the drop position');
ok(/Math\.abs\(tabX - landed\)/.test(glass), 'release snaps to the NEAREST tab, measured (never hardcoded)');
ok(/useNativeDriver: false/.test(glass.slice(glass.indexOf('Animated.spring(translateX, {'))),
  'translateX is JS-driven so the finger can write it directly');
ok(/\.\.\.panResponder\.panHandlers/.test(glass), 'the gesture is attached to the glass pill itself');
ok(/onPanResponderTerminationRequest: \(\) => false/.test(glass), 'an active drag cannot be stolen mid-gesture');
ok(/cancelDrag/.test(glass), 'a cancelled gesture snaps back without navigating');

console.log('\nRoleTabShell: ONE authoritative Android navigation (no runtime switch)');

// The platform split must be BY FILE, not by a runtime Platform.OS branch: a
// runtime branch bundles both bars into Android and can flip at runtime (the
// "new bar disappears, old bar returns" defect).
ok(fs.existsSync(path.join(ROOT, 'src/components/navigation/RoleTabShell.android.tsx')),
  'Android has its own shell file (RoleTabShell.android.tsx)');

const androidShell = read('src/components/navigation/RoleTabShell.android.tsx');
const webShell = read('src/components/navigation/RoleTabShell.tsx');
// Comments explain the OLD/BROKEN alternatives by name; only real code counts.
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const androidCode = codeOf(androidShell);
const webCode = codeOf(webShell);

// One shared shell owns navigator/provider/tab-mapping logic (2026-11-15
// refactor); the platform files are thin wrappers around it.
ok(fs.existsSync(path.join(ROOT, 'src/components/navigation/RoleTabShellBase.tsx')),
  'the shared shell base exists (RoleTabShellBase.tsx)');
const baseCode = codeOf(read('src/components/navigation/RoleTabShellBase.tsx'));
ok(!/GlassTabBar|ResponsiveTabBar/.test(baseCode),
  'the shared shell names NO bar implementation (both stay isolated)');
ok(/<Tabs/.test(baseCode) && /DrawerProvider/.test(baseCode) && /<DrawerNav \/>/.test(baseCode),
  'the shared shell owns the navigator, provider and drawer shell');
ok(/\.filter\(\(tab\) => tab\.hidden !== true\)/.test(baseCode), 'the shared shell owns the hidden-tab filter');
ok(/lucideIcon/.test(baseCode) && /ICONS/.test(baseCode), 'the shared shell owns the registry icon mapping');
ok(/<RoleTabShellBase/.test(androidCode), 'the Android shell is a wrapper over the shared shell');
ok(/<RoleTabShellBase/.test(webCode), 'the web shell is a wrapper over the shared shell');
ok(/useCallback/.test(androidCode) && /useCallback/.test(webCode),
  'both wrappers keep a STABLE bar renderer (no remount on re-render)');
ok(/<GlassTabBar/.test(androidCode), 'the Android shell renders the glass bar');
ok(!/ResponsiveTabBar/.test(androidCode), 'the OLD bar is NOT importable in the Android shell (unreachable, not just unselected)');
ok(!/navSurface/.test(androidCode), 'the Android shell never paints the obsolete navigation surface');
ok(!/Platform\.OS/.test(androidCode), 'the Android shell has no runtime platform branch to get wrong');
ok(!/Platform\.OS/.test(webCode), 'the web shell has no runtime platform branch either');
ok(/<GlassTabBar/.test(webCode) && !/ResponsiveTabBar/.test(webCode),
  'the web shell renders the SAME glass pill (preview = the real component) and cannot fall back to the old bar');
[
  'src/app/(app)/(student)/_layout.tsx',
  'src/app/(app)/(doctor)/_layout.tsx',
  'src/app/(app)/(admin)/_layout.tsx',
  'src/app/(app)/(superadmin)/_layout.tsx',
].forEach((layout) => {
  const code = read(layout);
  ok(/import RoleTabShell from '@\/components\/navigation\/RoleTabShell'/.test(code),
    layout.split('/').slice(-2).join('/') + ' imports the BARE shell (file resolution decides, never a flag)');
});

// Navigator options live in ONE shared module-scope constant (stable identity,
// identical on Android and Web so the two glass surfaces cannot drift).
const optionsFile = codeOf(read('src/components/navigation/glassTabBarOptions.ts'));
ok(/backgroundColor:\s*'transparent'/.test(optionsFile),
  'navigator tab-bar wrapper is transparent (no opaque band behind the pill)');
ok(/borderTopWidth:\s*0/.test(optionsFile),
  'navigator tab-bar wrapper draws no top border');
ok(/elevation:\s*0/.test(optionsFile),
  'navigator tab-bar wrapper casts no Android elevation shadow');
ok(!/\bheight:/.test(optionsFile.slice(0, optionsFile.indexOf('};'))),
  'navigator options set no tab-bar height (the floating bar reserves no space)');
ok(/screenOptions={GLASS_TAB_BAR_SCREEN_OPTIONS}/.test(androidCode),
  'the Android navigator receives the shared glass options');
ok(/screenOptions={GLASS_TAB_BAR_SCREEN_OPTIONS}/.test(webCode),
  'the web navigator receives the SAME options (same transparency on both)');
ok(/import \{ GLASS_TAB_BAR_SCREEN_OPTIONS \}/.test(androidShell) && /import \{ GLASS_TAB_BAR_SCREEN_OPTIONS \}/.test(webShell),
  'both wrappers take the options from the shared module (no duplicated literal)');

// iOS must not be touched by any of this.
const iosShell = read('src/components/navigation/RoleTabShell.ios.tsx');
ok(!/GlassTabBar|tabBarStyle/.test(iosShell), 'the iOS shell is free of Android glass-bar code');

if (failures > 0) {
  console.error('\n' + failures + ' assertion(s) failed\n');
  process.exit(1);
}
console.log('\nAll Android glass-bar guards passed\n');
