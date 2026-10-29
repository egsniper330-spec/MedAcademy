#!/usr/bin/env node
/**
 * dashboardLoadPhases.test.cjs — the student dashboard must paint the
 * student's OWN content without waiting for the public catalogue.
 *
 * ROOT CAUSE PINNED HERE
 * ──────────────────────
 * `loadData()` awaited ONE `Promise.all` of four unrelated reads:
 *
 *     getMySubscriptionsCached(profile.id)   ← the student's own courses
 *     getUnreadNotificationCount(profile.id) ← the student's own badge
 *     getPublishedCourses()                  ← the PUBLIC catalogue
 *     getCategories()                        ← near-static reference data
 *
 * `setLoading(false)` ran only after ALL FOUR resolved, and the whole screen
 * body (`My Courses`, the stat carousel, everything) is behind that flag. So
 * the first usable screen was gated by the SLOWEST request — and the two
 * slowest, payload-heaviest reads are the ones the student's own content does
 * not depend on at all. On a large catalogue that is pure added latency on
 * every cold launch, which is exactly the reported "it takes too long to open
 * even on a fast connection".
 *
 * THE FIX — two phases, no extra requests
 * ──────────────────────────────────────
 *   Phase 1 (blocks the first render): enrollments + unread count.
 *   Phase 2 (behind it):               catalogue + categories.
 *
 * The same four requests are still made, once each, concurrent within their
 * phase — this removes a dependency, not work.
 *
 * WHAT THIS CHECKS
 *   1. Phase 1 contains ONLY the student's own reads.
 *   2. `setLoading(false)` runs between the phases (the screen is released
 *      before the catalogue request is even started).
 *   3. The catalogue + categories are awaited AFTER that release.
 *   4. No request is duplicated and none was dropped.
 *   5. A dedicated `catalogueLoading` state exists and gates the Explore
 *      section, so phase 2 cannot flash the "no new courses" empty state — a
 *      false empty state would be a regression, not an optimisation.
 *   6. Both phases end in a terminal state, including on failure (`finally`),
 *      so the screen can never spin forever.
 *   7. The stale-while-revalidate contract still works: a return visit keeps
 *      the existing content instead of blanking to a spinner.
 *
 * Run: node tests/dashboardLoadPhases.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCREEN = 'src/app/(app)/(student)/dashboard.tsx';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name + (detail ? `  [${detail}]` : ''));
  }
}
function section(name) {
  console.log('\n── ' + name + ' ──');
}
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const raw = read(SCREEN);
const src = code(raw);

// The loadData body only (from the callback to the dependency array).
const start = src.indexOf('const loadData = useCallback');
const end = src.indexOf('}, [profile]);', start);
const body = start < 0 ? '' : src.slice(start, end > start ? end : start + 4000);

/* ══ 1. Phase 1 is the student's own data only ══════════════════════════ */

section('1. Phase 1 blocks on the student’s OWN data only');

check('loadData exists', body.length > 0);

const firstAwait = body.indexOf('Promise.all');
const firstBatch = firstAwait < 0 ? '' : body.slice(firstAwait, body.indexOf(']', firstAwait) + 1);

check('the first batch reads the student’s enrollments',
  /getMySubscriptionsCached\(profile\.id\)/.test(firstBatch));
check('the first batch reads the unread notification count',
  /getUnreadNotificationCount\(profile\.id\)/.test(firstBatch));
check('the first batch does NOT contain the public catalogue',
  !/getPublishedCourses\(\)/.test(firstBatch), firstBatch.replace(/\s+/g, ' '));
check('the first batch does NOT contain the category list',
  !/getCategories\(\)/.test(firstBatch), firstBatch.replace(/\s+/g, ' '));

/* ══ 2. The screen is released before the catalogue is requested ════════ */

section('2. The first usable screen is released before phase 2 starts');

// The release we care about is the one after phase 1 has committed. The
// no-profile guard also clears the flags, earlier in the body, so anchor on the
// commit instead of on the first literal occurrence.
const commitAt = body.indexOf('setSubscriptions(subs)');
const releaseAt = body.indexOf('setLoading(false)', commitAt);
const catalogueAt = body.indexOf('getPublishedCourses()');

check('the student’s data is committed first', commitAt > 0);
check('the release happens after that commit', releaseAt > commitAt,
  `commit@${commitAt} release@${releaseAt}`);
check('the catalogue request is started AFTER the screen is released',
  releaseAt > 0 && catalogueAt > releaseAt,
  `release@${releaseAt} catalogue@${catalogueAt}`);
check('both of the student’s values are committed before the release',
  /setSubscriptions\(subs\)/.test(body.slice(0, releaseAt))
  && /setUnreadCount\(count\)/.test(body.slice(0, releaseAt)));
check('the timing mark is recorded at the release, not after the catalogue',
  /setLoading\(false\)[\s\S]{0,200}markPerf\('screen-data'\)/.test(body));

/* ══ 3. Phase 2 still loads catalogue + categories ══════════════════════ */

section('3. Phase 2 loads the catalogue and categories');

check('the catalogue is still fetched after the release',
  catalogueAt > releaseAt && /setAllCourses\(courses\)/.test(body));
check('the categories are still fetched after the release',
  /getCategories\(\)/.test(body) && /setCategories\(cats\)/.test(body));
check('phase 2 runs the two reads concurrently (one Promise.all)',
  (body.match(/Promise\.all/g) || []).length === 2);
check('image prefetch still happens once the catalogue lands',
  /prefetchCourseImages\(courseImageUrlsFrom\(courses\)\)/.test(body));

/* ══ 4. No duplicated / dropped requests ════════════════════════════════ */

section('4. Same four requests, once each — no duplication');

for (const call of [
  'getMySubscriptionsCached(profile.id)',
  'getUnreadNotificationCount(profile.id)',
  'getPublishedCourses()',
  'getCategories()',
]) {
  const n = (body.match(new RegExp(call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  check(`${call} is requested exactly once per load`, n === 1, String(n));
}

/* ══ 5. No false empty state while phase 2 is in flight ════════════════ */

section('5. The Explore section cannot flash a false empty state');

check('a catalogue-specific loading flag exists',
  /const \[catalogueLoading, setCatalogueLoading\] = useState\(true\)/.test(src));
check('the Explore branch checks it BEFORE the empty state',
  /\{catalogueLoading \? \([\s\S]{0,600}?\) : filteredExplore\.length === 0 \? \(/.test(src));
check('the in-flight branch shows an indicator, not the “no courses” copy',
  (() => {
    const from = src.indexOf('{catalogueLoading ? (');
    const to = src.indexOf(') : filteredExplore.length === 0 ? (', from);
    if (from < 0 || to < 0) return false;
    const seg = src.slice(from, to);
    return /ActivityIndicator/.test(seg) && !/home\.noNewCourses|home\.noCoursesMatchSearch/.test(seg);
  })());

/* ══ 6. Terminal state on every path ═══════════════════════════════════ */

section('6. Both phases always reach a terminal state');

check('a finally block clears both flags',
  /finally \{[\s\S]{0,300}setLoading\(false\);[\s\S]{0,120}setCatalogueLoading\(false\);/.test(body));
check('the no-profile early return clears both flags too',
  /if \(!profile\) \{ setLoading\(false\); setCatalogueLoading\(false\); return; \}/.test(body));

/* ══ 7. Stale-while-revalidate is unchanged ════════════════════════════ */

section('7. Return visits still keep content instead of blanking');

check('SWR still reads hasContent from loaded data',
  /useStaleWhileRevalidateFocus\(loadData, \{[\s\S]{0,200}hasContent: \(\) => allCourses\.length > 0 \|\| subscriptions\.length > 0/.test(src));
check('loadData is not resetting catalogueLoading on every visit (would blank Explore)',
  !/setCatalogueLoading\(true\)/.test(src));

/* ════════════════════════════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
if (failed > 0) {
  console.error(`${passed} passed, ${failed} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
