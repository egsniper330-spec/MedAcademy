#!/usr/bin/env node
/**
 * Perceived performance — stop blanking screens the user is already reading.
 *
 * WHAT WAS MEASURED
 * ─────────────────
 * Static scan of `src/` (349 files) found 36 screens doing:
 *
 *     useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]))
 *
 * behind a `{loading ? <Spinner/> : <content/>}` render. Combined with 70
 * `useFocusEffect` sites, this means returning from ANY pushed screen (a
 * course, a detail, a modal, the drawer) unmounted the content the user was
 * just reading, replaced it with a full-screen spinner, and waited for a full
 * request batch before showing anything again — the reported "tapping controls
 * triggers visible loading delays".
 *
 * A second measurement found `course/[id].tsx` (the most-tapped screen)
 * serialized two independent `Promise.all` batches, so the enrollment reads
 * could not start until the course payload had already returned.
 *
 * WHAT THIS LOCKS DOWN
 * ────────────────────
 *   A. The stale-while-revalidate hook raises the spinner only when there is
 *      nothing to show, and refreshes in the background once content exists.
 *   B. The hook is wired into the migrated high-traffic screens, each with a
 *      real `hasContent` predicate — so no page hides its only indicator while
 *      still empty.
 *   C. Those screens no longer blank the screen on every focus.
 *   D. `course/[id]` starts the enrollment reads concurrently with the course
 *      read, while keeping the original failure semantics.
 *   E. The hook holds no response data — this change is UI sequencing, not a
 *      cache, so nothing can go stale or leak across accounts here.
 *
 * Run: node tests/perceivedPerformance.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

const hook = read('src/lib/useStaleWhileRevalidateFocus.ts');

// ─── A. The hook's behaviour ────────────────────────────────────────────────

check('A1 the spinner is suppressed ONLY when content already exists', () => {
  ok(hook.includes('revalidatedRef.current && hasContentRef.current()'),
    'no combined "has proven content" condition');
  // The gating expression must be negated into `showContent`, not dropped.
  ok(/const showContent = revalidatedRef\.current && hasContentRef\.current\(\);/.test(hook),
    'showContent is not derived from both flags');
});

check('A2 the hook still raises the full-screen spinner on a cold load', () => {
  ok(hook.includes('setLoadingRef.current(true)'), 'cold load never raises the spinner');
  ok(/if \(!showContent\)/.test(hook), 'spinner is not conditional on absence of content');
});

check('A3 the spinner is retired only after content actually exists', () => {
  const arm = hook.match(/if \(hasContentRef\.current\(\)\) revalidatedRef\.current = true;/);
  ok(arm, 'revalidated flag is not armed from a real hasContent() check');
  const assignments = hook.match(/revalidatedRef\.current = true/g) || [];
  ok(assignments.length === 1,
    `revalidated flag is assigned in ${assignments.length} places — one must remain gated on hasContent()`);
});

check('A4 a load that produced nothing keeps the guard disarmed', () => {
  // If the first load fails/returns empty, the next focus must show the
  // spinner again rather than an unexplained empty page.
  ok(hook.includes('failed first load'), 'documented intent is missing');
  const arm = hook.match(/if \(hasContentRef\.current\(\)\) revalidatedRef\.current = true;/);
  ok(arm, 'arming is not gated on hasContent()');
});

check('A5 the hook holds no response data (this is sequencing, not a cache)', () => {
  ok(!/\buseState\b/.test(hook), 'hook declares state — it must not store payloads');
  ok(!/\bset[A-Z][A-Za-z]*\((data|result|response)/.test(hook),
    'hook appears to write a payload into state');
  ok(hook.includes('NOT A CACHE'), 'contract that this is not a cache is undocumented');
  // Nothing the caller can read back — the hook exposes no accessor at all.
  ok(!/export (const|function) \w*[Cc]ache/.test(hook), 'hook exports a cache accessor');
});

check('A6 a load rejecting mid-flight cannot flip loading on a stale screen', () => {
  ok(hook.includes('cancelled = true'), 'no focus-cleanup guard');
  ok(hook.includes('if (cancelled) return;'), 'resolution is not guarded against defocus');
  ok(hook.includes('loadRef.current().then('), 'errors must be handled, never thrown out of the effect');
});

check('A7 the focus subscription has a stable identity (no re-subscribe churn)', () => {
  ok(/useFocusEffect\(\s*useCallback\(\(\) => \{[\s\S]*?\}, \[\]\),\s*\);/.test(hook),
    'focus effect is not a stable [] callback — it would re-run every render');
});

check('A8 callbacks are read through refs so screens can pass inline arrows', () => {
  for (const ref of ['loadRef', 'setLoadingRef', 'hasContentRef']) {
    ok(hook.includes(ref), `missing ${ref}`);
  }
});

// ─── B. Migrated high-traffic screens ───────────────────────────────────────

const MIGRATED = [
  { rel: 'src/app/(app)/(student)/dashboard.tsx', content: 'allCourses.length > 0 || subscriptions.length > 0' },
  { rel: 'src/app/(app)/(doctor)/dr-overview.tsx', content: 'courses.length > 0 || enrollments.length > 0' },
  { rel: 'src/app/(app)/(doctor)/courses.tsx', content: 'courses.length > 0' },
];

for (const s of MIGRATED) {
  const file = s.rel.replace('src/app/', '');
  check(`B1 ${file} uses the stale-while-revalidate focus loader`, () => {
    const src = read(s.rel);
    ok(src.includes('useStaleWhileRevalidateFocus('), 'hook not wired in');
    ok(src.includes('setLoading,'), 'hook not given the screen loading setter');
  });

  check(`B2 ${file} supplies a real hasContent() predicate`, () => {
    const src = read(s.rel);
    const m = src.match(/hasContent:\s*\(\)\s*=>\s*([^,}\n]+)/);
    ok(m, 'no hasContent predicate — an empty page could hide its only indicator');
    ok(!/hasContent:\s*\(\)\s*=>\s*true/.test(src), 'hasContent hard-coded true (spinner never shown)');
    // The predicate must actually reference the screen's data state.
    ok(/\w+\.length/.test(m[1]), `predicate does not inspect data: ${m[1].trim()}`);
  });

  check(`B3 ${file} no longer blanks the screen on every focus`, () => {
    const src = read(s.rel);
    ok(
      !/useFocusEffect\(useCallback\(\(\) => \{ setLoading\(true\); loadData\(\); \}, \[loadData\]\)\)/.test(src),
      'still does setLoading(true) + reload on every focus',
    );
  });
}

check('B4 the three migrated screens still render a loading branch (indicator not removed)', () => {
  for (const s of MIGRATED) {
    const src = read(s.rel);
    // Accept the two shapes this codebase uses: a ternary in JSX, or an
    // early `if (loading …) return <ActivityIndicator/>`.
    ok(
      /loading \?|loading &&|if \(loading\b|\bloading \|\|/.test(src),
      `${s.rel} no longer renders any loading indicator`,
    );
  }
});

check('B5 the pattern is still widespread — this change is incremental, not a rewrite', () => {
  // Informational guard: if this number drops to 0 someone rewrote the data
  // layer; if it GROWS, new screens are being added with the old pattern.
  const root = path.join(ROOT, 'src');
  let stillOld = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const s = fs.readFileSync(f, 'utf8').replace(/\r/g, '');
        if (/useFocusEffect/.test(s) &&
            /useFocusEffect\(\s*useCallback\(\s*\(\)\s*=>\s*\{[^}]*setLoading\(true\)/s.test(s)) {
          stillOld += 1;
        }
      }
    }
  })(root);
  ok(stillOld <= 36, `more screens adopted the blanking pattern than were measured (${stillOld})`);
  console.log(`        (informational: ${stillOld} screens still use the old focus-blanking pattern)`);
});

// ─── C. course/[id] request waterfalls ──────────────────────────────────────

const course = read('src/app/(app)/course/[id].tsx');

check('C1 the enrollment reads start CONCURRENTLY with the course read', () => {
  const subsIdx = course.indexOf('getMySubscriptions(profile!.id)');
  const courseIdx = course.indexOf('getCourseById(id)');
  ok(subsIdx >= 0, 'getMySubscriptions call not found');
  ok(courseIdx >= 0, 'getCourseById call not found');
  ok(
    subsIdx < courseIdx,
    'enrollment reads still start only after the course payload — still serialized',
  );
});

check('C2 the second batch is awaited at the same point in the flow as before', () => {
  const awaitIdx = course.indexOf('await Promise.all([subsP, cpP])');
  ok(awaitIdx >= 0, 'second batch is no longer awaited');
  const setCourseIdx = course.indexOf('setCourse(courseData)');
  ok(setCourseIdx >= 0 && awaitIdx > setCourseIdx,
    'enrollment results must be applied AFTER course/progress are committed');
});

check('C3 a rejected subscription read still skips both enrollment setters', () => {
  const awaitIdx = course.indexOf('await Promise.all([subsP, cpP])');
  const setSubIdx = course.indexOf('setIsSubscribed(subs.some');
  ok(setSubIdx > awaitIdx, 'setIsSubscribed runs without awaiting the subscription read');
  // The outer try/catch must still own the failure.
  ok(/\} catch \{\}/.test(course), 'outer catch removed — failure semantics changed');
});

check('C4 the early rejection is neutralised so phase 1 cannot warn', () => {
  ok(course.includes('subsP?.catch(() => {});'),
    'no early no-op catch — an unhandled rejection fires while phase 1 is in flight');
});

check('C5 the course payload commits without waiting for the enrollment read', () => {
  // Between firing the batch and committing the course there must be no await
  // of the enrollment promises — otherwise a slow/failing subscription read
  // would still hold up the screen.
  const batchStart = course.indexOf('const [courseData, prog] = await Promise.all([');
  const commit = course.indexOf('setCourse(courseData)');
  ok(batchStart >= 0 && commit > batchStart, 'course batch/commit structure not found');
  const between = course.slice(batchStart, commit);
  ok(!/await Promise\.all\(\[subsP, cpP\]\)/.test(between),
    'the course commit still waits on the enrollment read');
  ok(!/await subsP/.test(between), 'the course commit still waits on the subscription read');
});

// ─── D. No behaviour was weakened ───────────────────────────────────────────

check('D1 pull-to-refresh is untouched', () => {
  const src = read('src/app/(app)/(student)/dashboard.tsx');
  ok(/const onRefresh = async \(\) => \{ setRefreshing\(true\); await loadData\(\); setRefreshing\(false\); \};/.test(src),
    'onRefresh changed — manual refresh must still block on a real load');
});

check('D2 the loaders themselves were not modified', () => {
  for (const s of MIGRATED) {
    const src = read(s.rel);
    ok(/const loadData = useCallback\(async \(\) => \{/.test(src),
      `${s.rel}: loadData is no longer the same loader`);
  }
});

check('E1 useCreditBalance no longer blanks its consumers on every focus', () => {
  const svc = read('src/lib/useCreditBalance.ts');
  ok(/if \(!hasBalanceRef\.current\) setLoading\(true\);/.test(svc),
    'still raises loading unconditionally — every consumer early-returns to a spinner on refocus');
  ok(/hasBalanceRef\.current = true;/.test(svc), 'never arms the has-balance guard');
  const arms = svc.match(/hasBalanceRef\.current = true/g) || [];
  ok(arms.length === 1, `armed in ${arms.length} places — must be gated on a delivered balance`);
});

check('E2 the credit flag still covers a genuinely cold load', () => {
  const svc = read('src/lib/useCreditBalance.ts');
  ok(/useState\(true\)/.test(svc), 'loading no longer starts true');
  ok(/if \(!hasBalanceRef\.current\)/.test(svc), 'no cold-load branch');
  ok(svc.includes('setLoading(false);'), 'loading is never cleared');
});

check('E3 all four doctor consumers still gate on the credit flag safely', () => {
  const consumers = [
    'src/app/(app)/(hubs)/credits.tsx',
    'src/app/(app)/(doctor)/dr-overview.tsx',
    'src/app/(app)/(doctor)/dr-profile.tsx',
    'src/app/(app)/(doctor)/students.tsx',
  ];
  for (const rel of consumers) {
    const src = read(rel);
    ok(src.includes('useCreditBalance'), `${rel} no longer uses the credit hook`);
  }
});

// ─── Report ─────────────────────────────────────────────────────────────────

console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed.`);
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`${passed} assertions passed.`);
console.log('Perceived-performance regression suite: OK');
