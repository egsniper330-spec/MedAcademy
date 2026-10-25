#!/usr/bin/env node
/**
 * iphoneStartupPerformance.test.cjs — the iPhone "everything shows a spinner
 * for ages" regression, pinned so it cannot come back.
 *
 * ── WHAT ACTUALLY MADE iOS SLOW (root cause, verified in the code) ───────────
 *
 *  1. TWO identical `get-security-policies` GETs per evaluation.
 *     `getSecurityPolicies()` and `getVpnWhitelist()` each fetched the SAME
 *     endpoint (it returns `{ policies, vpn_whitelist }` in one payload), and
 *     the whitelist fetch ran INSIDE detectVPN() while the policy fetch ran
 *     AFTER the detector batch — so the two round trips were also serialised
 *     with the whole detector pipeline between them. The startup network lock
 *     defers every protected screen request until this evaluation completes,
 *     which is exactly why every screen sat on a loading state.
 *
 *  2. Screens raised a full-screen spinner on EVERY focus
 *     (`useFocusEffect(() => { setLoading(true); load(); })`) and threw away
 *     data they had just fetched. Returning from any pushed screen blanked the
 *     list and waited for the whole request batch again.
 *
 *  3. Video Library re-ran its focus effect on every KEYSTROKE (the search box
 *     and the server query were the same state), so typing produced one GET and
 *     one spinner per character.
 *
 * ── WHAT THIS SUITE CHECKS ──────────────────────────────────────────────────
 *  • one and only one config request, shared by both caches, started BEFORE
 *    the detectors (so the network wait overlaps the native probes);
 *  • the security decision itself is untouched: same endpoint, same timeout,
 *    same 5-minute TTL, same mandatory connection floor, all detectors still
 *    run, resume still only reuses a PASSING TLS probe;
 *  • the listed screens refresh without blanking, and cannot start two batches
 *    for one visit;
 *  • Video Library debounces and binds its input to the typed value.
 *
 * Run: node tests/iphoneStartupPerformance.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures.push(label + (detail ? ` (${detail})` : '')); console.log('  ✗ ' + label); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }
const count = (haystack, needle) => haystack.split(needle).length - 1;

const security = read('src/lib/security.ts');
const swrHook = read('src/lib/useStaleWhileRevalidateFocus.ts');
const videoLibrary = read('src/app/(app)/(doctor)/video-library.tsx');
const students = read('src/app/(app)/(doctor)/students.tsx');
const doctorCourses = read('src/app/(app)/(doctor)/courses.tsx');
const drOverview = read('src/app/(app)/(doctor)/dr-overview.tsx');
const studentDash = read('src/app/(app)/(student)/dashboard.tsx');
const explore = read('src/app/(app)/(student)/explore.tsx');
const notifications = read('src/app/(app)/notifications.tsx');
const courseDetail = read('src/app/(app)/course/[id].tsx');
const credits = read('src/app/(app)/(hubs)/credits.tsx');

/* ══ 1. One config request, started early ═════════════════════════════════ */

section('1. Security config: ONE request instead of two, started before the probes');

ok('exactly one place invokes get-security-policies',
  count(security, "functions.invoke('get-security-policies'") === 1,
  `found ${count(security, "functions.invoke('get-security-policies'")}`);

ok('both caches are filled by one shared single-flight fetch',
  /let securityConfigInFlight: Promise<void> \| null = null;/.test(security) &&
  /async function loadSecurityConfigOnce\(\): Promise<void> \{[\s\S]*?if \(securityConfigInFlight\) return securityConfigInFlight;/.test(security) &&
  /async function getVpnWhitelist\(\): Promise<string\[\]> \{[\s\S]*?await loadSecurityConfigOnce\(\);/.test(security));

ok('getSecurityPolicies() uses the shared fetch too',
  /export async function getSecurityPolicies\(\)[\s\S]*?await loadSecurityConfigOnce\(\);/.test(security));

ok('the shared payload fills the VPN whitelist (same response, not a second GET)',
  /const list = payload\?\.vpn_whitelist;/.test(security) &&
  /vpnWhitelistFetched = true;/.test(security) &&
  /vpnWhitelistExpiry = now \+ POLICY_TTL_MS;/.test(security));

// The regression was ORDER: the policy GET used to run after the detector
// batch, so it could never overlap the native probes.
const earlyStart = security.indexOf('const policiesP = getSecurityPolicies();');
const detectorBatch = security.indexOf('] = await Promise.all([');
ok('the config request starts BEFORE the detector batch (network overlaps native probes)',
  earlyStart > 0 && detectorBatch > earlyStart,
  `start=${earlyStart} batch=${detectorBatch}`);

/* ══ 2. The security decision is unchanged ════════════════════════════════ */

section('2. Security enforcement is NOT weakened to gain speed');

ok('fail-secure defaults + mandatory connection floor are still applied',
  count(security, 'applyMandatoryConnectionFloor({ ...DEFAULT_POLICIES })') >= 2);

ok('policy TTL is still 5 minutes (no indefinite / stale reuse)',
  /const POLICY_TTL_MS = 5 \* 60 \* 1000;/.test(security));

ok('an offline device still takes the fail-secure fast path (no permissive default)',
  /if \(process\.env\.EXPO_OS !== 'web'\) \{[\s\S]*?Network\.getNetworkStateAsync\(\)[\s\S]*?applyMandatoryConnectionFloor\(\{ \.\.\.DEFAULT_POLICIES \}\)/.test(security));

ok('every detector is still evaluated in the pipeline',
  ['root', 'vpn', 'proxy', 'debug', 'devOptions', 'screenRec', 'frida', 'xposed', 'magisk', 'overlay', 'tamper', 'platformIntegrity', 'ssl']
    .every((name) => new RegExp(`track\\('${name}'`).test(security)));

ok('resume only reuses a VERIFIED PASSING TLS probe (never an unverified one)',
  /scope === 'resume' && Date\.now\(\) - _sslProbePassedAt < SSL_PROBE_REUSE_MS/.test(security) &&
  /_sslProbePassedAt = Date\.now\(\)/.test(security));

ok('a logout/identity switch discards an in-flight config response',
  /securityConfigGeneration \+= 1;/.test(security) &&
  /if \(generation !== securityConfigGeneration\) return;/.test(security));

ok('a failed whitelist fetch still leaves VPN detection ACTIVE (fail closed)',
  /export function isVpnWhitelistKnownNonEmpty\(\): boolean \{\s*return vpnWhitelistFetched && vpnWhitelist\.length > 0;/.test(security));

/* ══ 3. Screens refresh instead of blanking ═══════════════════════════════ */

section('3. The listed screens use stale-while-revalidate on focus');

for (const [label, src] of [
  ['Doctor Video Library', videoLibrary],
  ['Doctor Students', students],
  ['Doctor Courses', doctorCourses],
  ['Doctor Overview', drOverview],
  ['Student Dashboard', studentDash],
  ['Student Explore / My Courses list', explore],
  ['Notifications (both roles)', notifications],
  ['Course details', courseDetail],
]) {
  ok(`${label} refreshes in place (useStaleWhileRevalidateFocus)`,
    /useStaleWhileRevalidateFocus\(/.test(src));
}

ok('the hook keeps a spinner only when there is genuinely nothing to show',
  /if \(!showContent\) \{[\s\S]*?setLoadingRef\.current\(true\);/.test(swrHook));

ok('the hook cannot start two request batches for one visit',
  /if \(inFlightRef\.current\) \{[\s\S]*?return \(\) => \{\};/.test(swrHook) &&
  /inFlightRef\.current = true;/.test(swrHook) &&
  /\.finally\(\(\) => \{\s*inFlightRef\.current = false;/.test(swrHook));

ok('the hook holds no response data of its own (it only sequences the spinner)',
  !/useRef<.*\[\]>/.test(swrHook) && !/useState/.test(swrHook));

ok('no focus-driven full-screen spinner is left in Video Library / Students',
  !/setLoading\(true\)/.test(videoLibrary) && !/setLoading\(true\)/.test(students));

// Video Library DOES keep one focus effect — the throttled VdoCipher
// reconciliation. It is allowed only because it is rate-limited and never
// blanks the list; that is asserted here so it cannot grow into a loader.
ok('the remaining Video Library focus effect is throttled and never blanks the list',
  /AUTO_SYNC_INTERVAL_MS/.test(videoLibrary) &&
  /now - lastAutoSyncRef\.current > AUTO_SYNC_INTERVAL_MS/.test(videoLibrary) &&
  /useFocusEffect\(useCallback\(\(\) => \{\s*if \(!isStaff && canSync\)/.test(videoLibrary));

/* ══ 4. Video Library: one request per settled query ══════════════════════ */

section('4. Video Library search no longer fetches per keystroke');

ok('typing state is separate from the debounced query',
  /const \[searchInput, setSearchInput\] = useState\(''\);/.test(videoLibrary) &&
  /setTimeout\(\(\) => setSearch\(next\), 300\)/.test(videoLibrary));

ok('the input is bound to what the user types (not the debounced value)',
  /value=\{searchInput\}/.test(videoLibrary) && !/value=\{search\}/.test(videoLibrary));

ok('the clear button applies to the typed value',
  /\{searchInput\.length > 0 && \(/.test(videoLibrary));

ok('pull-to-refresh has its own indicator (loading is not reused)',
  /const \[refreshingList, setRefreshingList\] = useState\(false\);/.test(videoLibrary) &&
  /refreshing=\{refreshingList\}/.test(videoLibrary));

ok('filter/sort changes still refetch, guarded so a render cannot trigger it',
  /const prevFilterKeyRef = useRef\(filterKey\);/.test(videoLibrary) &&
  /if \(prevFilterKeyRef\.current === filterKey\) return;/.test(videoLibrary));

/* ══ 5. Balance / credits: no blocking focus refetch loop ═════════════════ */

section('5. Balance (credits) screen');

// Balance is derived state, not a focus-driven spinner: it shows the loading
// indicator only while there is nothing to display, so returning to the screen
// keeps the numbers on screen instead of replacing them with a spinner.
ok('credits loading is derived from "no data yet" rather than set on focus',
  /const loading = \(balLoading \|\| txLoading\) && transactions\.length === 0 && !credits;/.test(credits) &&
  !/useFocusEffect\(useCallback\(\(\) => \{\s*set.*Loading\(true\)/.test(credits));

ok('credits focus refresh keeps existing transactions (background revalidate)',
  /useFocusEffect\(useCallback\(\(\) => \{ loadHistory\(\); \}, \[loadHistory\]\)\)/.test(credits) &&
  /txLoading/.test(credits));

section('Summary');
console.log(`\n${passed} passed; ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
