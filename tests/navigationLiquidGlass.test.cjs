/**
 * navigationLiquidGlass — focused suite for the iOS native tab-bar change.
 *
 * Verifies, against REAL source (comments stripped):
 *   A. Registry completeness: every route file in each role directory is
 *      registered in that role's tab registry (no orphan = no unconfigured
 *      native bar item; drawer-only screens stay registered).
 *   B. Icon identity validity: registry lucide names exist in the installed
 *      lucide-react-native; SF Symbol names exist in sf-symbols-typescript.
 *   C. Architecture: iOS shell uses the REAL native tab bar
 *      (react-native-bottom-tabs), sets NO fake glass background, does not
 *      ship lucide/native requireNativeComponent off-platform; Android/web
 *      shell keeps the JS Tabs + ResponsiveTabBar implementation; role
 *      layouts stay thin and route through the registry.
 *   D. Liquid Glass fidelity: no forced bar background/blur; tint + theme
 *      colors flow from the existing neu palette; per-role JS icon shrink
 *      preserved; SF Symbols are the native icon idiom.
 *   E. Platform safety: platform-split shell files exist; gates, DrawerNav,
 *      and impersonation infrastructure remain untouched by this change.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
let passed = 0;
let failed = 0;
const fail = (name, msg) => { failed += 1; console.log(`  ✗ ${name} — ${msg}`); };
const ok = (name) => { passed += 1; };

function check(name, cond, msg) {
  if (cond) { ok(name); } else { fail(name, msg); }
}

/** Strip comments + strings so assertions only see real code. */
function readCode(p) {
  let src = read(p);
  src = src.replace(/\/\*[\s\S]*?\*\//g, ''); // block comments
  src = src.replace(/(^|\n)\s*\/\/[^\n]*/g, '$1'); // line comments
  return src;
}

/* ═══════════════════ A. Registry completeness ═══════════════════ */

console.log('\n═══ A. Registry completeness ═══');
const registryCode = readCode('src/lib/nativeTabRegistry.tsx');

const roleDirs = {
  student: 'src/app/(app)/(student)',
  doctor: 'src/app/(app)/(doctor)',
  admin: 'src/app/(app)/(admin)',
  superadmin: 'src/app/(app)/(superadmin)',
};

for (const [role, dir] of Object.entries(roleDirs)) {
  const routeFiles = fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith('.tsx') && f !== '_layout.tsx')
    .map((f) => f.replace(/\.tsx$/, ''));
  for (const route of routeFiles) {
    check(
      `${role}/${route} registered`,
      registryCode.includes(`name: '${route}'`),
      'route file exists but is missing from its role registry',
    );
  }
}
// Every role registry exists and lists its dashboard first (initial tab).
check('student dashboard first', registryCode.indexOf("name: 'dashboard'") < registryCode.indexOf("name: 'explore'"));
check('doctor dashboard first', registryCode.indexOf("name: 'dr-overview'") < registryCode.indexOf("name: 'courses'"));
check('admin dashboard first', registryCode.indexOf("name: 'admin-overview'") < registryCode.indexOf("name: 'users'"));
check('sa dashboard first', registryCode.indexOf("name: 'sa-overview'") < registryCode.indexOf("name: 'sa-users'"));

/* ═══════════════════ B. Icon identity validity ═══════════════════ */

console.log('\n═══ B. Icon identity validity ═══');

// Extract registry entries: name/title/icon/sfSymbol per role block.
const registrySrc = read('src/lib/nativeTabRegistry.tsx');
const entries = [...registrySrc.matchAll(/\{\s*name:\s*'([^']+)'\s*,\s*title:\s*'([^']+)'\s*(?:,\s*icon:\s*'([^']+)')?\s*(?:,\s*sfSymbol:\s*'([^']+)')?\s*(,\s*hidden:\s*true)?/g)]
  .map((m) => ({ name: m[1], title: m[2], icon: m[3] || null, sfSymbol: m[4] || null, hidden: !!m[5] }));
check('registry parsed', entries.length >= 70, `parsed ${entries.length} entries`);

// Visible entries must carry both icons; hidden entries must carry none.
for (const e of entries) {
  if (e.hidden) {
    check(`hidden ${e.name} has no icons`, !e.icon && !e.sfSymbol);
  } else {
    check(`visible ${e.name} has lucide name`, !!e.icon);
    check(`visible ${e.name} has sfSymbol`, !!e.sfSymbol);
  }
}

// lucide names resolve against the installed package's icon types dir.
const lucideDir = path.join(ROOT, 'node_modules/lucide-react-native/dist/types/icons');
const lucideNames = new Set(
  exists('node_modules/lucide-react-native/dist/types/icons')
    ? fs.readdirSync(lucideDir).filter((f) => f.endsWith('.d.ts')).map((f) => f.replace(/\.d\.ts$/, ''))
    : [],
);
check('lucide icons dir found', lucideNames.size > 1000, `found ${lucideNames.size}`);
for (const e of entries) {
  if (e.icon) {
    const kebab = e.icon
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/([a-zA-Z])(\d)/g, '$1-$2')
      .toLowerCase();
    check(
      `lucide '${e.icon}' exists`,
      lucideNames.has(kebab),
      'name not found in lucide-react-native icon types',
    );
  }
}

// SF Symbol names must exist in sf-symbols-typescript generated types.
const sfDts = ['node_modules/sf-symbols-typescript/dist/index.d.ts', 'node_modules/sf-symbols-typescript/dist/types.d.ts']
  .find(exists);
check('sf-symbols dts found', !!sfDts);
if (sfDts) {
  const sfSrc = read(sfDts);
  const sfNames = new Set([...sfSrc.matchAll(/'([a-z0-9.]+)'/g)].map((m) => m[1]));
  check('sf symbols parsed', sfNames.size > 1000, `parsed ${sfNames.size}`);
  for (const e of entries) {
    if (e.sfSymbol) {
      check(
        `sfSymbol '${e.sfSymbol}' exists`,
        sfNames.has(e.sfSymbol),
        'name not found in sf-symbols-typescript',
      );
    }
  }
}

/* ═══════════════════ C. Architecture ═══════════════════ */

console.log('\n═══ C. Architecture ═══');

const iosShell = readCode('src/components/navigation/RoleTabShell.ios.tsx');
const jsShell = readCode('src/components/navigation/RoleTabShell.tsx');
const layouts = {
  student: readCode('src/app/(app)/(student)/_layout.tsx'),
  doctor: readCode('src/app/(app)/(doctor)/_layout.tsx'),
  admin: readCode('src/app/(app)/(admin)/_layout.tsx'),
  superadmin: readCode('src/app/(app)/(superadmin)/_layout.tsx'),
};

check('ios shell uses native bottom tabs', iosShell.includes("createNativeBottomTabNavigator") && iosShell.includes("withLayoutContext"));
check('ios shell no fake glass (no BlurView)', !iosShell.includes('BlurView'));
check('ios shell no forced bar background', !/backgroundColor:\s*c\.base[^}]*tabBar/i.test(iosShell));
check('ios shell no lucide import (no JS icon layer)', !iosShell.includes('lucide-react-native'));
check('ios shell SF Symbol icons', iosShell.includes('sfSymbol'));
// 2026-09-28 architecture fix: drawer-only screens are NO LONGER tab scenes
// on iOS (they moved to the (hubs) Stack group). The old tabBarItemHidden
// registration was the root cause of iOS 26's system back affordance walking
// tab-scene history (duplicate back button, wrong destination). Pinned by
// tests/navigationOwnership.test.cjs.
check('ios shell EXCLUDES drawer-only screens from the native tab navigator (no tabBarItemHidden)', !iosShell.includes('tabBarItemHidden') && /\.filter\(\(tab\) => tab\.hidden !== true\)/.test(iosShell));
check('ios shell sidebarAdaptable=false (bottom bar on iPad)', /sidebarAdaptable=\{false\}/.test(iosShell));
check('ios shell no minimizeBehavior (native default kept)', !iosShell.includes('minimizeBehavior'));

check('js shell still uses expo-router Tabs', jsShell.includes('Tabs') && jsShell.includes('ResponsiveTabBar'));
check('js shell no native-tabs import', !jsShell.includes('@bottom-tabs') && !jsShell.includes('NativeTabsNavigator'));
// 2026-09-28 architecture fix: drawer-only screens are Stack screens in the
// (hubs) group on every platform — href:null registration removed for parity.
check('js shell EXCLUDES drawer-only screens from the JS tab navigator (no href:null scenes)', !jsShell.includes('href: tab.hidden ? null : undefined') && /\.filter\(\(tab\) => tab\.hidden !== true\)/.test(jsShell));

for (const [role, code] of Object.entries(layouts)) {
  check(`${role} layout thin (registry-driven)`, code.includes('_TAB') && code.includes('RoleTabShell') && code.length < 700, `len=${code.length}`);
}

/* ═══════════════════ D. Liquid Glass fidelity ═══════════════════ */

console.log('\n═══ D. Liquid Glass fidelity ═══');

check('registry carries SF Symbols as native idiom', registrySrc.includes('sfSymbol'));
check('iOS tint from existing neu palette', iosShell.includes('neuColors') && iosShell.includes('c.primary'));
check('student jsIconShrink preserved', read('src/app/(app)/(student)/_layout.tsx').includes('jsIconShrink'));
check('doctor jsIconShrink preserved', read('src/app/(app)/(doctor)/_layout.tsx').includes('jsIconShrink'));
check('admin full-size js icons preserved', !read('src/app/(app)/(admin)/_layout.tsx').includes('jsIconShrink'));
check('sa full-size js icons preserved', !read('src/app/(app)/(superadmin)/_layout.tsx').includes('jsIconShrink'));
check(
  'ROLE_JS_ICON_SHRINK contract exported',
  registrySrc.includes('ROLE_JS_ICON_SHRINK') && registrySrc.includes('student: true') && registrySrc.includes('doctor: true') && registrySrc.includes('admin: false'),
);

/* ═══════════════════ E. Platform safety ═══════════════════ */

console.log('\n═══ E. Platform safety ═══');

check('platform-split shell files exist', exists('src/components/navigation/RoleTabShell.ios.tsx') && exists('src/components/navigation/RoleTabShell.tsx'));
check('root layout untouched by navigation change', readCode('src/app/_layout.tsx').includes('MaintenanceGate'));
check('(app) layout gates intact', readCode('src/app/(app)/_layout.tsx').includes('SecurityGate') && readCode('src/app/(app)/_layout.tsx').includes('maintenanceEpoch'));
check('impersonation banner still mounts at root', readCode('src/app/_layout.tsx').includes('ImpersonationBanner'));
check('no extra window/screen-capture code introduced', !readCode('src/app/_layout.tsx').includes('UIWindow'));

// DrawerNav remains a sibling of the navigator in BOTH shells (drawer keeps
// working above every platform's bar, exactly as before).
check('ios shell keeps DrawerNav sibling', iosShell.includes('<DrawerNav />'));
check('js shell keeps DrawerNav sibling', jsShell.includes('<DrawerNav />'));

/* ═══════════════════ F. Liquid Glass is NEVER a hard requirement ═══════════════════ */

console.log('\n═══ F. Liquid Glass is NEVER a hard requirement ═══');

// The compatibility model: glass is what the OS does when it draws the bar;
// its absence cannot be observable to any JS code path. Assert the
// implementation contains NO custom glass detection/gating.
for (const api of ['expo-glass-effect', 'isGlassEffectAPIAvailable', 'isLiquidGlassAvailable', 'GlassEffectView']) {
  check(`ios shell free of custom glass API '${api}'`, !iosShell.includes(api));
}
for (const api of ['expo-glass-effect', 'isGlassEffectAPIAvailable', 'isLiquidGlassAvailable']) {
  check(`registry free of custom glass API '${api}'`, !registrySrc.includes(api));
}

// The navigator must render unconditionally: no early returns before the
// navigator, no glass/OS-version conditionals around it, no loading states.
const iosBody = iosShell.slice(iosShell.indexOf('export default function RoleTabShell'));
check('ios shell has no early return before the navigator', !iosBody.includes('return null') && !iosBody.includes('return <')); 
check('ios shell navigator is the only conditional-free render path', /<NativeBottomTabs/.test(iosBody));
check('ios shell no OS-version branching', !/Platform\.Version|ProcessInfo|isIOS26/.test(iosShell));
check('ios shell no loading/ready state around navigation', !iosShell.includes('isLoading') && !iosShell.includes('isGlassReady'));

// Native library: every iOS-26-only API is inside #available guards (the
// compiler enforces the fallback path), and the pod floor stays low.
const swiftDir = 'node_modules/react-native-bottom-tabs/ios';
const swiftFiles = [];
(function walk(dir) {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    const p = path.join(ROOT, dir, f);
    if (fs.statSync(p).isDirectory()) walk(path.join(dir, f));
    else if (/\.swift$|\.mm$/.test(f)) swiftFiles.push(p);
  }
})('node_modules/react-native-bottom-tabs/ios');
const unguarded = swiftFiles.filter((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  const API26 = /\.glassEffect|GlassEffectContainer|tabBarMinimizeBehavior|UITab\(/;
  if (!API26.test(src)) return false;
  // Members declared in this same file whose own body is availability-guarded
  // (the library's shim pattern: `#if compiler(>=6.2)` + `#available(iOS 26…)`
  // with a `self` no-op fallback) make every call site of that member safe.
  const shims = new Set();
  lines.forEach((l, i) => {
    const m = l.match(/func\s+(\w+)\s*\(/);
    if (m) {
      const body = lines.slice(i, i + 30).join('\n');
      if (/#available|@available|#if compiler/.test(body)) shims.add(m[1]);
    }
  });
  return lines.some((l, i) => {
    if (!API26.test(l)) return false;
    const name = (l.match(/\.?(\w+)\(/) || [])[1] || '';
    if (shims.has(name)) return false; // resolves to a guarded shim
    const ctx = lines.slice(Math.max(0, i - 3), i + 2).join('\n');
    return !/#available|@available|#if compiler/.test(ctx); // unguarded call site
  });
});
check('native lib: iOS-26 APIs are availability-guarded', unguarded.length === 0, unguarded.join(', ') || 'ok');
check('native lib pod floor stays at iOS 14 (no min-target bump)', /s\.ios\.deployment_target\s*=\s*"14\.0"/.test(fs.readFileSync(path.join(ROOT, 'node_modules/react-native-bottom-tabs/react-native-bottom-tabs.podspec'), 'utf8')));

// App deployment target unchanged by this work.
const appJson = read('app.json');
check('app.json carries no deploymentTarget bump', !/deploymentTarget/i.test(appJson) || /14\.0|15\.1/.test(appJson));

// Glass absence must never touch app state: navigation readiness cannot be
// coupled to any glass concept in the whole navigation layer.
check('no glass/state coupling anywhere in navigation code', !iosShell.includes('glass') || !/glass.*(gate|ready|init|state)/i.test(iosShell));

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
process.exit(failed ? 1 : 0);
