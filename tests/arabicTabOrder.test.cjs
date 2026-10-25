#!/usr/bin/env node
'use strict';
/**
 * arabicTabOrder.test.cjs — the bottom tab bar's PHYSICAL order in Arabic.
 *
 * REQUIREMENT
 *   English (left→right): Home → Discover → My Courses → Profile
 *   Arabic  (right→left): الرئيسية → استكشاف → دوراتي → الملف الشخصي
 * i.e. the Arabic row is the MIRROR of the English one, with Home at the RIGHT.
 *
 * ── WHY THIS IS NOT FREE ────────────────────────────────────────────────────
 * Two different surfaces render the bar and they mirror differently:
 *
 *   • JS bar (Android/web) — our own row. React Navigation's row would reverse
 *     automatically when `I18nManager.isRTL` is true, but that flag is only set
 *     AFTER the native relaunch that a language switch schedules, so on the
 *     launch where the user switches to Arabic the row is still LTR. Mirroring
 *     on top of the platform's own mirroring would reverse twice and leave the
 *     English order in Arabic.
 *   • iOS native bar (UITabBar/SwiftUI) — the system mirrors the items itself
 *     when the app is RTL, and cannot be told otherwise. Reversing the array
 *     unconditionally would double-reverse there.
 *
 * The fix is one deterministic rule per surface:
 *   JS bar   → `direction: 'ltr'` (neutral) + `flexDirection: row-reverse` in
 *              Arabic. The manual mirror is the only mirror.
 *   iOS bar  → reverse the array ONLY when the app direction and the platform
 *              direction disagree, which is exactly when the system will not
 *              produce the required order by itself.
 *
 * The mapping route ⇄ screen is never touched: items are still pressed by
 * `route.name`, so icons, active state, deep links and history are unchanged.
 *
 * Run: node tests/arabicTabOrder.test.cjs   (also part of `npm test`)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  }
}
function section(title) {
  console.log('\n── ' + title + ' ──');
}

const tabBar = stripComments(read('src/components/ResponsiveTabBar.tsx'));
const iosShell = stripComments(read('src/components/navigation/RoleTabShell.ios.tsx'));
const jsShell = stripComments(read('src/components/navigation/RoleTabShell.tsx'));
const registry = stripComments(read('src/lib/nativeTabRegistry.tsx'));
const resources = read('src/lib/i18n/resources.ts');

/* ─────────────────────────── 1. registry ──────────────────────────────── */

section('1. the registry keeps the English order (mapping is untouched)');
const studentBlock = registry.slice(
  registry.indexOf('export const STUDENT_TABS'),
  registry.indexOf('export const DOCTOR_TABS'),
);
const studentNames = [...studentBlock.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
ok('student tabs are registered in the canonical English order',
  JSON.stringify(studentNames) === JSON.stringify(['dashboard', 'explore', 'my-courses', 'profile']),
  studentNames.join(','));
ok('each student tab still carries its localized title key',
  ['tabs.home', 'tabs.explore', 'tabs.myCourses', 'tabs.profile']
    .every((k) => studentBlock.includes(k)));
ok('every student tab has an icon for both surfaces',
  (studentBlock.match(/icon:/g) || []).length === 4 &&
  (studentBlock.match(/sfSymbol:/g) || []).length === 4);

section('2. Arabic labels exist for all four tabs');
for (const key of ['tabs.home', 'tabs.explore', 'tabs.myCourses', 'tabs.profile']) {
  const occurrences = resources.split(`'${key}':`).length - 1;
  ok(`${key} is defined in both languages`, occurrences === 2, `${occurrences} definition(s)`);
}
ok('the Arabic tab labels are Arabic script',
  /'tabs\.home': '[^']*[\u0600-\u06FF]/.test(resources) &&
  /'tabs\.myCourses': '[^']*[\u0600-\u06FF]/.test(resources));

/* ────────────────────────── 3. the JS bar ─────────────────────────────── */

section('3. JS bar (Android/web): one physical mirror');
ok('the bar mirrors with flexDirection, not with Yoga direction',
  /flexDirection: isRTL \? 'row-reverse' : 'row'/.test(tabBar));
ok('the bar pins its own layout direction to ltr (no double reversal)',
  /direction: 'ltr'/.test(tabBar));
ok('it no longer relies on the platform reversing the row for it',
  !/direction: isRTL \? 'rtl' : 'ltr'/.test(tabBar));
ok('visible routes render in registry order (no local re-sorting)',
  /\{visibleRoutes\.map\(\(\{ route, descriptor, index \}\) => \{/.test(tabBar) &&
  !/visibleRoutes\.(sort|reverse)\(/.test(tabBar));
ok('pressing a tab still navigates by ROUTE NAME (mapping unchanged)',
  /navigation\.navigate\(routeName\)/.test(tabBar));
ok('the tab-press event still targets the row key',
  /target: routeKey/.test(tabBar));
ok('active state still comes from the navigator index, not the visual order',
  /const isFocused = activeIndex === index;/.test(tabBar));
ok('each tab still takes an equal share of the width',
  /flex: 1/.test(tabBar));

/* ───────────────────────── 4. the iOS native bar ──────────────────────── */

section('4. iOS native bar: the OFFICIAL layoutDirection prop (no array reversal)');
// ROOT CAUSE of the reported bug: reversing the `<Screen>` array cannot reorder
// a this-navigator's routes — Expo Router's `withLayoutContext` builds them from
// the router's own file-system order (`useSortedScreens` → `getSortedChildren`)
// and re-sorts our children by name. So the previous "manual mirror" was a no-op
// and Arabic showed Profile at the far right. The library's `layoutDirection`
// prop is applied natively as SwiftUI's `.environment(\.layoutDirection, …)` and
// mirrors the real tab bar.
ok('the native bar is driven by the official layoutDirection prop',
  /layoutDirection=\{appRTL \? 'rtl' : 'ltr'\}/.test(iosShell));
ok('it follows the APP locale (not the platform I18nManager state)',
  /const \{ isRTL: appRTL \} = useTranslation\(\)/.test(iosShell) &&
  !/I18nManager/.test(iosShell));
ok('it does NOT reverse the array (that is a no-op and would double-mirror)',
  !/\[\.\.\.visibleTabs\]\.reverse\(\)/.test(iosShell) &&
  !/needsManualMirror/.test(iosShell));
ok('hidden (drawer-only) screens are still excluded from the native bar',
  /tabs\.filter\(\(tab\) => tab\.hidden !== true\)/.test(iosShell));
ok('screens are still registered by NAME (route mapping unchanged)',
  /<NativeBottomTabs\.Screen[\s\S]{0,160}name=\{tab\.name\}/.test(iosShell));
ok('the initial route is still chosen by name, not by position',
  /initialRouteName=\{initialRouteName\}/.test(iosShell));

section('5. both shells stay wired to the same registry');
ok('the JS shell renders the role registry it was given',
  /tabs\s*\n?\s*\.filter\(\(tab\) => tab\.hidden !== true\)/.test(jsShell));
ok('role layouts pass the registry, never a hand-built list',
  ['(student)', '(doctor)', '(admin)', '(superadmin)'].every((role) => {
    const p = `src/app/(app)/${role}/_layout.tsx`;
    if (!fs.existsSync(path.join(ROOT, p))) return true;
    return /TABS/.test(read(p));
  }));

/* ───────────────────────────── summary ────────────────────────────────── */

console.log('\n' + '─'.repeat(60));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('Arabic tab-order suite FAILED.');
  process.exit(1);
}
console.log('Arabic tab-order suite OK.');
