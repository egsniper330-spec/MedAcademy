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
check('ios shell tabBarItemHidden for drawer routes', iosShell.includes('tabBarItemHidden'));
check('ios shell sidebarAdaptable=false (bottom bar on iPad)', /sidebarAdaptable=\{false\}/.test(iosShell));
check('ios shell no minimizeBehavior (native default kept)', !iosShell.includes('minimizeBehavior'));

check('js shell still uses expo-router Tabs', jsShell.includes('Tabs') && jsShell.includes('ResponsiveTabBar'));
check('js shell no native-tabs import', !jsShell.includes('@bottom-tabs') && !jsShell.includes('NativeTabsNavigator'));
check('js shell preserves href null for drawer routes', jsShell.includes('href: tab.hidden ? null : undefined'));

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

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
process.exit(failed ? 1 : 0);
