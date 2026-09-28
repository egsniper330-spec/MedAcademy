'use strict';
/**
 * Guard tests — iOS 26 Liquid Glass duplicate-back-button architecture fix.
 *
 * Pins the navigation-ownership contract introduced by the fix:
 *   1. Drawer-only ("hidden") screens are OUT of every role tab group and
 *      physically inside the (hubs) Stack group → their push/pop history is
 *      JS-owned (Expo Router), so the MedAcademy back button is the single
 *      back control and iOS 26's native tab-history back affordance has no
 *      hidden-scene entries to walk (it disappeared / can no longer land on
 *      More → Platform → Devices).
 *   2. Both RoleTabShells filter hidden registry entries — no platform
 *      re-registers drawer-only screens as tab scenes (regression guard for
 *      tabBarItemHidden-style registration).
 *   3. The (hubs) layout is a plain Stack with headerShown:false wrapped in
 *      DrawerProvider + DrawerNav (shell contract preserved: hamburger,
 *      safe area, drawer overlay).
 *   4. Liquid Glass preservation: the iOS shell still renders the native
 *      bottom-tabs navigator (no JS-bar substitution on iOS), and no BlurView
 *      / fake glass is introduced anywhere in the shells.
 *   5. Route identity: every moved file keeps its original route name (path
 *      segments from route groups are not part of URLs), so no router.push
 *      target or drawer path changed.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'app', '(app)');
const HUBS = path.join(APP, '(hubs)');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.error('  ✗ ' + label); }
}
function read(p) { return fs.readFileSync(p, 'utf8').replace(/\r/g, ''); }

console.log('── 1. Hidden screens physically moved to (hubs) ──');
// Registry is the source of truth for what is drawer-only per role.
const registry = read(path.join(ROOT, 'src', 'lib', 'nativeTabRegistry.tsx'));
function hiddenNames(sectionAnchor, endAnchor) {
  const a = registry.indexOf(sectionAnchor);
  const b = endAnchor ? registry.indexOf(endAnchor) : registry.length;
  const src = registry.slice(a, b);
  const names = [];
  const re = /\{\s*name:\s*'([^']+)',[^}]*hidden:\s*true\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) names.push(m[1]);
  return names;
}
const expectedHubs = [
  ...hiddenNames('DOCTOR_TABS', '/* ── Admin'),
  ...hiddenNames('ADMIN_TABS', '/* ── Super Admin'),
  ...hiddenNames('SUPERADMIN_TABS', null),
];
ok(expectedHubs.length >= 60, `registry declares ${expectedHubs.length} drawer-only screens (sanity)`);
let allInHubs = true, noneInRoles = true;
for (const name of expectedHubs) {
  if (!fs.existsSync(path.join(HUBS, name + '.tsx'))) allInHubs = false;
  for (const g of ['(doctor)', '(admin)', '(superadmin)']) {
    if (fs.existsSync(path.join(APP, g, name + '.tsx'))) noneInRoles = false;
  }
}
ok(allInHubs, 'every registry-hidden screen exists in (hubs)/');
ok(noneInRoles, 'no drawer-only screen remains inside a role tab group');

console.log('── 2. Role groups contain ONLY visible tabs + layout ──');
const visibleByRole = {
  '(doctor)': ['courses', 'dr-earnings', 'dr-overview', 'dr-profile', 'students'],
  '(admin)': ['academic', 'admin-overview', 'audit', 'devices', 'users'],
  '(superadmin)': ['sa-analytics', 'sa-finance', 'sa-overview', 'sa-platform', 'sa-users'],
};
for (const [group, visible] of Object.entries(visibleByRole)) {
  const files = fs.readdirSync(path.join(APP, group)).filter((f) => f !== '_layout.tsx');
  const names = files.map((f) => f.replace(/\.tsx$/, '')).sort();
  ok(
    JSON.stringify(names) === JSON.stringify([...visible].sort()),
    `${group} holds exactly its visible tabs (${names.join(', ')})`
  );
}

console.log('── 3. Shells exclude hidden entries (no tabBarItemHidden / href:null scene registration) ──');
const iosShell = read(path.join(ROOT, 'src', 'components', 'navigation', 'RoleTabShell.ios.tsx'));
const jsShell = read(path.join(ROOT, 'src', 'components', 'navigation', 'RoleTabShell.tsx'));
ok(/\.filter\(\(tab\) => tab\.hidden !== true\)/.test(iosShell), 'iOS shell filters hidden tabs');
ok(/\.filter\(\(tab\) => tab\.hidden !== true\)/.test(jsShell), 'JS shell filters hidden tabs (parity)');
ok(!iosShell.includes('tabBarItemHidden'), 'iOS shell no longer uses tabBarItemHidden scene registration');
ok(!jsShell.includes('href: tab.hidden ? null : undefined'), 'JS shell no longer registers href:null hidden scenes');

console.log('── 4. (hubs) layout contract ──');
const hubsLayout = read(path.join(HUBS, '_layout.tsx'));
ok(/<Stack screenOptions=\{\{ headerShown: false \}\}/.test(hubsLayout), '(hubs) layout is a Stack with headerShown:false (JS-owned history)');
ok(hubsLayout.includes('DrawerProvider') && hubsLayout.includes('<DrawerNav />'), '(hubs) keeps the drawer shell (hamburger + overlay)');
ok(!hubsLayout.includes('NativeBottomTabs') && !hubsLayout.includes('<Tabs'), '(hubs) is NOT a tab navigator');

console.log('── 5. Liquid Glass preservation on iOS ──');
ok(iosShell.includes('createNativeBottomTabNavigator'), 'iOS shell still uses the native bottom-tabs navigator (Liquid Glass bar intact)');
ok(!/from ['"]expo-blur/.test(iosShell), 'no BlurView import (fake glass) in the iOS shell');
ok(/backBehavior="history"/.test(iosShell), 'iOS tab navigator back follows real visit order (no fabricated history)');

console.log('── 6. Route identity unchanged (drawer paths still resolve) ──');
// Spot-check the routes named in the bug report + drawer: same file names exist at (hubs) level → same URLs.
for (const route of ['sa-devices', 'sa-audit', 'sa-content', 'notifications-center', 'global-search']) {
  ok(fs.existsSync(path.join(HUBS, route + '.tsx')), `/${route} still resolves (now as a hubs Stack screen)`);
}
// Visible tabs untouched in role groups.
for (const route of ['sa-users', 'sa-finance', 'devices', 'users']) {
  const found =
    fs.existsSync(path.join(APP, '(superadmin)', route + '.tsx')) ||
    fs.existsSync(path.join(APP, '(admin)', route + '.tsx'));
  ok(found, `/${route} still resolves as its role tab screen`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
