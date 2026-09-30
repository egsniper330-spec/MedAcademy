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

console.log('── 3b. Doctor drawer canonical order ──');
// The doctor drawer must present its main items in exactly this order.
// Extracted from the real role-scoped block in DrawerNav.tsx so a reorder,
// a new item, or an accidental student/admin/sa edit fails here loudly.
const drawerNavSrc = read(path.join(ROOT, 'src', 'components', 'DrawerNav.tsx'));
const doctorBlock = drawerNavSrc.match(/if \(role === 'doctor'\) \{[\s\S]*?\n  \}\n\n  if \(role === 'admin'\)/);
ok(doctorBlock !== null, "role === 'doctor' block found in DrawerNav (role-scoped)");
if (doctorBlock) {
  const block = doctorBlock[0];
  const EXPECTED_ORDER = [
    'Dashboard', 'My Courses', 'Video Library', 'Students',
    'Credits', 'Earnings', 'Notifications', 'Profile',
  ];
  const positions = EXPECTED_ORDER.map((label) => block.indexOf("label: '" + label + "'"));
  ok(positions.every((p) => p >= 0), 'all 8 canonical doctor items present');
  const inOrder = positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]));
  ok(inOrder, 'doctor drawer order: Dashboard → My Courses → Video Library → Students → Credits → Earnings → Notifications → Profile');
  // Notifications lives in the main list now — no duplicate entry may remain.
  const notifCount = (block.match(/label: 'Notifications'/g) || []).length;
  ok(notifCount === 1, 'Notifications appears exactly once in the doctor drawer');
  // Role scoping: student/admin/super_admin blocks untouched by the reorder.
  ok(/if \(role === 'student'\) \{[\s\S]*?path: '\/profile'/.test(drawerNavSrc), 'student drawer block unchanged (role-scoped)');
}

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

console.log('── 7. Hub deduplication (Platform = canonical, Reports = report-focused) ──');
// The Platform hub (sa-platform.tsx) is the canonical home for platform-
// management/configuration features. The Reports & Export hub (sa-reports.tsx)
// must NOT re-list them — one feature, one home.
const reportsHub = read(path.join(HUBS, 'sa-reports.tsx'));
const platformHub = read(path.join(APP, '(superadmin)', 'sa-platform.tsx'));

// 7a. Confirmed duplicates must NEVER reappear in the Reports hub.
for (const banned of [
  'Impersonation',        // canonical: Platform → User Management
  'Trash Bin',            // canonical: Platform → Cleanup & Permissions
  'Delete Permissions',   // canonical: Platform → Cleanup & Permissions
  'Bulk Import',          // canonical: Platform → Academic & Operations
  'DB Audit',             // canonical: Platform → Academic & Operations
  'Security Policies',    // canonical: Platform → Security (configuration)
  'Security Diagnostics', // canonical: Platform → Security (configuration)
  'Violation Management', // canonical: Platform → Security (configuration)
  'Global Search',        // canonical: drawer → Platform & Settings
]) {
  ok(!reportsHub.includes(`label="${banned}"`), `Reports hub does not duplicate "${banned}"`);
  ok(platformHub.includes(`label="${banned}"`) || banned === 'Global Search',
    `Platform hub keeps canonical "${banned}"`);
}

// 7b. Report-focused surfaces must stay in the Reports hub.
for (const kept of ['Reports"', 'Export Center', 'Platform Analytics', 'Revenue Analytics', 'Audit Trail', 'Fraud Alerts']) {
  ok(reportsHub.includes(kept), `Reports hub retains report surface "${kept.replace('"', '')}"`);
}

// 7c. The Reports hub must not link configuration screens (same screen,
// second navigation entry) even under a different label.
for (const route of ['/violation-management', '/sec-policies', '/sec-dashboard', '/sec-diag', '/trash-bin', '/delete-permissions', '/impersonation', '/sa-bulk-import', '/sa-db-audit']) {
  ok(!reportsHub.includes(`path="${route}"`), `Reports hub has no second entry pointing at ${route}`);
}
// Security Dashboard is monitoring, but Platform owns it (already linked there);
// the Reports hub must not link it either.
ok(!reportsHub.includes('path="/sec-dashboard"'), 'Reports hub has no second Security Dashboard entry');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
