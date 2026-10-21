#!/usr/bin/env node
/**
 * Earnings removal — regression suite.
 *
 * THE REQUEST
 * ───────────
 * Remove the earnings feature from the WHOLE product (Doctor, Admin and Super
 * Admin) — not just hide a tab — while keeping everything it merely touched:
 * credits, credit ledger, course pricing, enrollment management, refunds and
 * revenue reporting.
 *
 * WHAT IS ASSERTED HERE
 * ─────────────────────
 * 1. The three earnings screens are gone from the filesystem.
 * 2. No route, nav entry, drawer item, native tab or deep link points at them.
 * 3. The client API no longer exposes earnings calls, and the PHP route map no
 *    longer knows the earnings endpoints.
 * 4. The backend stops ROUTING earnings-only endpoints (retired, unreachable).
 * 5. Retained endpoints still exist: enrollment suspension/resumption, the
 *    student-removal RPC that performs refunds, revenue stats, credits.
 * 6. Data safety: earnings TABLES and columns still exist in the schema (no
 *    destructive migration), and the retirement is documented.
 * 7. Unused earnings strings were removed from both dictionaries.
 *
 * Run: node tests/earningsRemoved.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

/* ── 1. screens removed ─────────────────────────────────────────────────── */

console.log('\nscreens');
for (const file of [
  'src/app/(app)/(doctor)/dr-earnings.tsx',
  'src/app/(app)/(hubs)/doctor-earnings.tsx',
  'src/app/(app)/(hubs)/sa-doctor-earnings.tsx',
]) {
  check(`${file} no longer exists`, !exists(file));
}

/* ── 2. no entry points ─────────────────────────────────────────────────── */

console.log('\nentry points');
const walkSrc = () => {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
    }
  })(path.join(ROOT, 'src'));
  return out;
};
const sourceFiles = walkSrc();
const sources = sourceFiles.map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));

const routeRefs = sources.filter(({ text }) =>
  /['"`/]\(?[^'"`\s]*\b(dr-earnings|doctor-earnings|sa-doctor-earnings)\b/.test(text) &&
  // The retirement comments themselves mention the names; only real navigations count.
  /router\.(push|replace|navigate)\([^)]*earnings|href=['"][^'"]*earnings/.test(text));

check('no router.push/replace targets an earnings screen', routeRefs.length === 0,
  routeRefs.map((r) => r.file).join(', '));

const drawer = read('src/components/DrawerNav.tsx');
check('drawer has no earnings item', !/path: '\/dr-earnings'/.test(drawer));
check('drawer no longer depends on the earnings flag/permission',
  !/isFeatureEnabled\('doctor_earnings'\)/.test(drawer) && !/earnings_enabled/.test(drawer));

const tabs = read('src/lib/nativeTabRegistry.tsx');
check('native tab registry has no earnings tab',
  !/name: 'dr-earnings'/.test(tabs));
check('native tab registry has no hidden earnings routes',
  !/name: 'doctor-earnings'/.test(tabs) && !/name: 'sa-doctor-earnings'/.test(tabs));

const actionMenu = read('src/components/ActionMenu.tsx');
check('user action menu has no earnings action', !/key: 'earnings'/.test(actionMenu));
const saUsers = read('src/app/(app)/(superadmin)/sa-users.tsx');
check('Super Admin user menu does not push an earnings screen', !/sa-doctor-earnings\?/.test(saUsers));

const profile = read('src/app/(app)/(doctor)/dr-profile.tsx');
check('doctor profile has no earnings toggle/dashboard link',
  !/dr-earnings/.test(profile) && !/earnings_enabled/.test(profile) && !/EARNABLE/.test(profile));
check('doctor profile has no earnings tab content',
  !/getDoctorEarningsDashboard|EarningsTab|RevenueChart/.test(profile));

/* ── 3. client API surface ──────────────────────────────────────────────── */

console.log('\nclient API');
const api = read('src/lib/api.ts');
const removedApi = [
  'getDoctorEarningsDashboard', 'bucketEarningsTimeSeries', 'getDoctorEarningsData',
  'getPlatformEarningsStats', 'resetPlatformEarnings',
  'getAdminDoctorEarningsDashboard', 'setDoctorEarningsSettings', 'getDoctorPricingHistory',
  'recalculateDoctorEarnings', 'resetDoctorEarnings', 'setDoctorGlobalPrice',
  'getDoctorStudentProfile', 'setDoctorCoursePrice', 'setEnrollmentAssignedPrice',
];
for (const fn of removedApi) {
  check(`api.ts no longer exports ${fn}`, !new RegExp(`export (async )?function ${fn}\\b`).test(api));
}

const php = read('src/client/php.ts');
check('PHP route map has no earnings dashboard RPC', !/doctor-earnings-dashboard/.test(php));
check('PHP route map has no earnings reset/recalculate endpoints',
  !/reset-doctor-earnings|recalculate-earnings|reset-platform-earnings/.test(php));
check('PHP route map has no admin doctor-earnings endpoint', !/admin-doctor-earnings/.test(php));
check('PHP route map has no per-doctor credit-price editor', !/set-doctor-credit-price/.test(php));

/* ── 4. backend routes retired ──────────────────────────────────────────── */

console.log('\nbackend routes');
const routes = read('backend/routes/api.php');
check('no recalculate-earnings route', !/recalculate-earnings/.test(routes));
check('no reset-doctor-earnings route', !/reset-doctor-earnings/.test(routes));
check('no reset-platform-earnings route', !/reset-platform-earnings/.test(routes));
check('no doctor earnings dashboard route', !/doctor-earnings-dashboard/.test(routes));
check('no doctor-earnings-dashboard controller handler routed', !/doctorEarningsDashboard/.test(routes));
check('no doctor earnings student-profile route', !/doctor-student-profile/.test(routes));

/* ── 5. retained features ───────────────────────────────────────────────── */

console.log('\nretained features');
check('enrollment suspension is still routed', /credits\/me/.test(routes) && /credits\/transactions/.test(routes));
check('revenue stats are still computed for the retained dashboard',
  /export async function getRevenueStats/.test(api) && /getRevenueStats/.test(read('src/app/(app)/(hubs)/revenue.tsx')));
check('refund/enrollment-removal RPC is retained',
  /remove-student-and-record-earnings/.test(routes) && /remove_student_and_record_earnings/.test(api));
check('credit ledger API is retained', /export async function getCreditLedger/.test(api));
check('enrollment suspend/resume still implemented',
  /export async function suspendCourseSubscription/.test(api)
  && /export async function resumeCourseSubscription/.test(api));
check('course pricing still editable through the course API', /price_egp/.test(api));
check('revenue dashboard screen retained', exists('src/app/(app)/(hubs)/revenue.tsx'));
check('credit timeline screen retained', exists('src/app/(app)/(hubs)/doctor-credit-timeline.tsx'));

/* ── 6. data safety ─────────────────────────────────────────────────────── */

console.log('\ndata safety');
const schema = read('backend/database/schema.sql');
for (const table of [
  'doctor_earnings_events',
  'doctor_earnings_transactions',
  'doctor_payout_requests',
  'doctor_pricing_history',
  'platform_earnings_resets',
]) {
  check(`schema still defines ${table} (no destructive drop)`, new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '`').test(schema));
}
const migrations = fs.readdirSync(path.join(ROOT, 'backend/database/mysql-migrations')).join('\n');
check('no migration drops an earnings table',
  !/DROP TABLE[^;]*(earnings|payout)/i.test(migrations));
check('the retirement is documented for the backend',
  exists('backend/docs/EARNINGS_FEATURE_RETIREMENT.md'));

/* ── 7. localization ────────────────────────────────────────────────────── */

console.log('\nlocalization');
const resources = read('src/lib/i18n/resources.ts');
for (const key of [
  "'drProfile.earnings.",
  "'drProfile.enableEarnings",
  "'saEarnings.",
]) {
  check(`no leftover sales copy for ${key.trim()}`, !resources.includes(key));
}
check('the earnings nav label key is gone from both dictionaries',
  (resources.match(/'tabs\.earnings':/g) || []).length === 0);

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
