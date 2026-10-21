#!/usr/bin/env node
/**
 * Contextual back navigation — regression suite.
 *
 * THE REPORTED BUG
 * ────────────────
 * Screens opened from a dashboard quick action kept the hamburger (there was no
 * way Back to the dashboard), while drawer destinations could show a Back arrow
 * that popped to an unrelated screen. The control was hardcoded per screen, so
 * the SAME route behaved wrongly depending on how the user arrived.
 *
 * THE CONTRACT PINNED HERE
 * ────────────────────────
 *   1. drawer / tab bar entry        → menu  (even for a nested-looking route)
 *   2. quick action / card / link    → back  (even for a main destination)
 *   3. no intent (deep link, cold start, browser refresh)
 *                                    → route classification, then real history,
 *                                      then the role dashboard fallback
 *   4. never a Back with nowhere to go, never a menu without a drawer
 *
 * Run: node tests/contextualBackNavigation.test.cjs
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

/* ── compile the pure resolver (no React/Expo deps) ──────────────────────── */

const build = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-intent-'));
execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(ROOT, 'src/lib/navigation/navIntent.ts'),
    '--outDir', build,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--skipLibCheck',
    '--noEmitOnError', 'false',
  ],
  { stdio: 'pipe' },
);
const {
  resolveHeaderControl,
  markEntryIntent,
  peekEntryIntent,
  consumeEntryIntent,
  clearEntryIntents,
  normalizeRoutePath,
  INTENT_TTL_MS,
} = require(path.join(build, 'navIntent.js'));

const resolve = (over = {}) => resolveHeaderControl({
  intent: null,
  isRootDestination: false,
  canGoBack: false,
  hasFallback: false,
  insideDrawer: true,
  ...over,
});

/* ── 1. main drawer / tab destinations keep the menu ─────────────────────── */

console.log('\n1. main navigation destinations retain the menu control');
check('drawer intent → menu', resolve({ intent: 'main' }).control === 'menu');
check('drawer intent beats a nested-route classification',
  resolve({ intent: 'main', isRootDestination: false, canGoBack: true }).control === 'menu');
check('root destination with no intent (cold start) → menu',
  resolve({ isRootDestination: true }).control === 'menu');
check('main intent never synthesises a fallback',
  resolve({ intent: 'main', hasFallback: true }).useFallback === false);

/* ── 2. quick actions / nested entries show Back ─────────────────────────── */

console.log('\n2. quick-action and nested entries show Back');
check('quick-action intent → back',
  resolve({ intent: 'nested', canGoBack: true }).control === 'back');
check('quick-action intent on a MAIN destination → back',
  resolve({ intent: 'nested', isRootDestination: true, canGoBack: true }).control === 'back');
check('quick-action intent with no history uses the dashboard fallback',
  resolve({ intent: 'nested', hasFallback: true }).useFallback === true);
check('nested route with history → back (no fallback needed)',
  resolve({ canGoBack: true }).useFallback === false);

/* ── 3. no-history / direct entry safety ─────────────────────────────────── */

console.log('\n3. direct entry (deep link, refresh, restored session) is safe');
const noHistoryNested = resolve({ isRootDestination: false, canGoBack: false, hasFallback: true });
check('nested, no history, fallback available → back via fallback',
  noHistoryNested.control === 'back' && noHistoryNested.useFallback === true);

const noHistoryNoFallback = resolve({ isRootDestination: false, canGoBack: false, hasFallback: false });
check('no history and no fallback → menu, never a dead Back',
  noHistoryNoFallback.control === 'menu');

const stackNoDrawer = resolve({ insideDrawer: false, canGoBack: false, hasFallback: true });
check('screen outside the drawer still gets a usable Back (fallback)',
  stackNoDrawer.control === 'back' && stackNoDrawer.useFallback === true);

const stackNoDrawerNoFallback = resolve({ insideDrawer: false, canGoBack: false, hasFallback: false });
check('screen outside the drawer with no fallback → back, not a dead menu',
  stackNoDrawerNoFallback.control === 'back');
check('menu is degraded to Back when no drawer can open it',
  resolve({ insideDrawer: false, canGoBack: true, intent: 'main' }).control === 'back');

/* ── 4. explicit screen overrides ────────────────────────────────────────── */

console.log('\n4. explicit overrides still win (legacy props preserved)');
check('explicit back wins over a main intent',
  resolve({ explicitMode: 'back', intent: 'main', canGoBack: true }).control === 'back');
check('explicit menu wins over a nested intent',
  resolve({ explicitMode: 'menu', intent: 'nested', canGoBack: true }).control === 'menu');
check('legacy showBack still resolves to Back',
  resolve({ showBack: true, canGoBack: true }).control === 'back');

/* ── 5. intent store: one-shot, path-normalised, TTL-bounded ─────────────── */

console.log('\n5. entry intent store');
clearEntryIntents();
check('no mark → null', peekEntryIntent('/students') === null);

markEntryIntent('/(app)/(doctor)/students', 'nested');
check('group segments are ignored when marking',
  peekEntryIntent('/students') === 'nested',
  JSON.stringify(peekEntryIntent('/students')));
check('query strings are ignored',
  peekEntryIntent('/students?tab=active') === 'nested');
check('trailing slash and case are ignored',
  peekEntryIntent('/Students/') === 'nested');

check('first consume returns the mark', consumeEntryIntent('/students') === 'nested');
check('second consume returns null (one-shot; cannot leak into a later visit)',
  consumeEntryIntent('/students') === null);

markEntryIntent('/courses', 'main');
check('a newer intent replaces an older one for the same path',
  peekEntryIntent('/courses') === 'main');
markEntryIntent('/courses', 'nested');
check('re-marking overwrites (no queue of stale intents)',
  peekEntryIntent('/courses') === 'nested');

clearEntryIntents();
markEntryIntent('/legacy', 'main');
check('marks expire after the TTL', (() => {
  // Fast-forward only the clock the store reads.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + INTENT_TTL_MS + 1;
    return consumeEntryIntent('/legacy') === null;
  } finally {
    Date.now = realNow;
  }
})());

check('normalizeRoutePath keeps dynamic segments',
  normalizeRoutePath('/(app)/course/abc-123') === '/course/abc-123');
check('normalizeRoutePath root', normalizeRoutePath('/(app)/') === '/');
check('normalizeRoutePath tolerates null', normalizeRoutePath(null) === '');

/* ── 6. wiring: who marks what ───────────────────────────────────────────── */

console.log('\n6. wiring — drawer/tab mark "main", quick actions mark "nested"');
const drawer = read('src/components/DrawerNav.tsx');
const tabBar = read('src/components/ResponsiveTabBar.tsx');
const quickAction = read('src/components/QuickActionBtn.tsx');
const pageHeader = read('src/components/PageHeader.tsx');
const saOverview = read('src/app/(app)/(superadmin)/sa-overview.tsx');
const saContent = read('src/app/(app)/(hubs)/sa-content.tsx');
const saReports = read('src/app/(app)/(hubs)/sa-reports.tsx');
const drOverview = read('src/app/(app)/(doctor)/dr-overview.tsx');
const studentDash = read('src/app/(app)/(student)/dashboard.tsx');
const adminOverview = read('src/app/(app)/(admin)/admin-overview.tsx');

check('drawer navigation marks its destination as a main entry',
  /markEntryIntent\(path, 'main'\)/.test(drawer));
check('bottom tab bar marks its destination as a main entry',
  /markEntryIntent\('\/' \+ routeName, 'main'\)/.test(tabBar));
check('quick-action tiles mark their destination as nested',
  /markEntryIntent\(path, 'nested'\)/.test(quickAction));
check('PageHeader resolves its control through the shared hook, not a hardcoded guess',
  /useNavHeader\(/.test(pageHeader) && !/showBack\s*\?\s*<BackButton/.test(pageHeader));
check('PageHeader degrades a menu to Back when no drawer can open',
  /insideDrawer/.test(pageHeader));

check('super admin dashboard stat cards / hub rows mark nested entries',
  (saOverview.match(/markEntryIntent\(path, 'nested'\)/g) || []).length >= 2);
check('super admin dashboard global-search shortcut marks a nested entry',
  /markEntryIntent\('\/sa-global-search', 'nested'\)/.test(saOverview));
check('content hub rows mark nested entries',
  /markEntryIntent\(path, 'nested'\)/.test(saContent));
check('reports hub rows mark nested entries',
  /markEntryIntent\(path, 'nested'\)/.test(saReports));
check('doctor dashboard students shortcut marks a nested entry',
  /markEntryIntent\('\/\(app\)\/\(doctor\)\/students', 'nested'\)/.test(drOverview));
check('doctor dashboard courses shortcut marks a nested entry',
  /markEntryIntent\('\/\(app\)\/\(doctor\)\/courses', 'nested'\)/.test(drOverview));
check('student dashboard my-courses shortcut marks a nested entry',
  /markEntryIntent\('\/\(app\)\/\(student\)\/my-courses', 'nested'\)/.test(studentDash));
check('admin dashboard notifications shortcut marks a nested entry',
  /markEntryIntent\('\/\(app\)\/notifications', 'nested'\)/.test(adminOverview));

/* ── 7. classification source of truth ───────────────────────────────────── */

console.log('\n7. root-destination classification matches the shells');
const registry = read('src/lib/nativeTabRegistry.tsx');
const roots = read('src/lib/navigation/rootRoutes.ts');

check('rootRoutes derives tabs from nativeTabRegistry (no duplicated tab list)',
  /from '@\/lib\/nativeTabRegistry'/.test(roots));
for (const constName of ['STUDENT_TABS', 'DOCTOR_TABS', 'ADMIN_TABS', 'SUPERADMIN_TABS']) {
  check(`rootRoutes consumes ${constName}`, new RegExp(constName).test(roots));
}
check('role dashboards have a safe fallback',
  /\(student\)\/dashboard/.test(roots) && /\(doctor\)\/dr-overview/.test(roots)
  && /\(admin\)\/admin-overview/.test(roots) && /\(superadmin\)\/sa-overview/.test(roots));

// Every admin drawer path must be classified as a root destination, otherwise a
// drawer entry would show Back instead of the menu.
const doctorSection = drawer.slice(drawer.indexOf("if (role === 'doctor')"), drawer.indexOf("if (role === 'admin')"));
const adminSection = drawer.slice(drawer.indexOf("if (role === 'admin')"), drawer.indexOf('// ── super_admin'));
const superSection = drawer.slice(drawer.indexOf('// ── super_admin'));
const pathsIn = (src) => Array.from(src.matchAll(/path: '([^']+)'/g)).map((m) => m[1]);

// The classification is tabs (from the registry) + DRAWER_ONLY paths, so a
// drawer destination is covered when it appears in EITHER source.
const tabsBlock = (name) => registry.slice(registry.indexOf(`${name}: RoleTabDef[] = [`), registry.indexOf('];', registry.indexOf(`${name}: RoleTabDef[] = [`)));
const tabNames = (name) => new Set(Array.from(tabsBlock(name).matchAll(/name: '([^']+)'/g)).map((m) => '/' + m[1]));
const drawerOnlyBlock = (role) => roots.slice(roots.indexOf(`  ${role}: [`), roots.indexOf('],', roots.indexOf(`  ${role}: [`)));

const adminDrawerOnly = drawerOnlyBlock('admin');
const superDrawerOnly = drawerOnlyBlock('super_admin');
const adminTabs = tabNames('ADMIN_TABS');
const superTabs = tabNames('SUPERADMIN_TABS');

for (const p of pathsIn(adminSection)) {
  check(`admin drawer destination classified as root: ${p}`,
    adminDrawerOnly.includes(`'${p}'`) || adminTabs.has(p));
}
for (const p of pathsIn(superSection)) {
  check(`super admin drawer destination classified as root: ${p}`,
    superDrawerOnly.includes(`'${p}'`) || superTabs.has(p));
}

/* ── 8. role-specific behaviour ──────────────────────────────────────────── */

console.log('\n8. roles and RTL');
const pageHeaderSrc = pageHeader;
check('Back arrow follows reading direction (RTL aware)',
  /isRTL\s*\?\s*<ArrowRight/.test(pageHeaderSrc) && /<ArrowLeft/.test(pageHeaderSrc));
check('doctor tab bar carries the role tab registry (no per-role header hack)',
  /DOCTOR_TABS/.test(read('src/app/(app)/(doctor)/_layout.tsx')));
check('student tab shell untouched by the header change',
  /STUDENT_TABS/.test(read('src/app/(app)/(student)/_layout.tsx')));

/* ── summary ─────────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
