#!/usr/bin/env node
/**
 * Navigation loading behaviour — no re-blanking, no duplicate requests, no
 * thumbnail stampede, bounded resume probing.
 *
 * Run: node tests/navigationLoadingAndPrefetch.test.cjs   (part of `npm test`)
 *
 * THE REPORTED SYMPTOMS
 * ─────────────────────
 * • "Moving between sections and courses repeatedly triggers noticeable loading
 *   delays": every focus of the course screen called setLoading(true) + a full
 *   refetch, so the most-tapped screen in the app blanked to a spinner each time
 *   it regained focus.
 * • "Course thumbnails take too long to appear after login": the dashboard
 *   prefetched EVERY published course image at once, competing with the list's
 *   own image requests for the same connection.
 * • A focus that fires twice (nested navigator remount, modal close) started
 *   two identical request batches.
 *
 * WHY THE SECURITY PATH IS PART OF A PERFORMANCE SUITE
 * ────────────────────────────────────────────────────
 * The background→foreground hold waits for the slowest security detector, and
 * the TLS-pinning probe used to be the slowest (an 8 s GET of the API root on
 * every resume). Nothing about detection was relaxed: HEAD still completes the
 * handshake that the probe classifies, and the bound only got shorter.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ok    ' + name);
  } else {
    failed++;
    console.error('  FAIL  ' + name + (detail ? ` — ${detail}` : ''));
  }
}

/* ────────────────────────── no re-blanking ─────────────────────────────── */

console.log('\nCourse screen keeps its content while it revalidates');
const course = stripComments(read('src/app/(app)/course/[id].tsx'));
ok('uses the shared stale-while-revalidate focus hook',
  /useStaleWhileRevalidateFocus\(loadData, \{ setLoading, hasContent: hasCourseContent \}\)/.test(course));
ok('the old spinner-on-every-focus path is gone',
  !/useFocusEffect\(useCallback\(\(\) => \{ setLoading\(true\); loadData\(\); \}/.test(course));
ok('content is only considered valid for THIS course id',
  /course\.id === id/.test(course));
ok('the first visit still shows the full-screen spinner',
  /if \(loading && !course\) return \(/.test(course));
ok('a background refresh never blanks content that is already on screen',
  !/if \(loading\) return \(/.test(course));

console.log('\nThe hook itself');
const hook = stripComments(read('src/lib/useStaleWhileRevalidateFocus.ts'));
ok('a load already in flight is not duplicated',
  /const inFlightRef = useRef\(false\)/.test(hook) && /if \(inFlightRef\.current\) \{/.test(hook));
ok('the guard is released when the load settles',
  /\.finally\(\(\) => \{\s*inFlightRef\.current = false;\s*\}\)/.test(hook));
ok('the hook still caches no response data', !/setData|useState<.*\[\]>/.test(hook));
ok('an empty screen still shows the loading state (no silent blank page)',
  /if \(!showContent\) \{[\s\S]{0,120}setLoadingRef\.current\(true\)/.test(hook));

console.log('\nThe dashboard keeps its stale-while-revalidate behaviour');
const dash = stripComments(read('src/app/(app)/(student)/dashboard.tsx'));
ok('dashboard uses the shared hook',
  /useStaleWhileRevalidateFocus\(loadData, \{/.test(dash));

/* ─────────────────────── bounded image prefetch ────────────────────────── */

console.log('\nImage prefetch is bounded');
const prefetch = stripComments(read('src/lib/imagePrefetch.ts'));
ok('a prefetch budget constant exists', /export const PREFETCH_LIMIT = 8/.test(prefetch));
ok('the burst stops at the budget', /started >= budget/.test(prefetch) && /started\+\+/.test(prefetch));
ok('already-warmed urls are still skipped (no repeat downloads)',
  /warmed\.has\(uri\)/.test(prefetch));
ok('web stays a no-op (browser cache already does this)', /Platform\.OS === 'web'/.test(prefetch));
ok('cards still fall back gracefully when an image fails',
  /onError=\{\(\) => setFailed\(true\)\}/.test(stripComments(read('src/components/CourseThumbnail.tsx'))));

/* ───────────────────── resume latency of the security probe ────────────── */

console.log('\nTLS-pinning probe is bounded for resume');
const security = stripComments(read('src/lib/security.ts'));
ok('the origin probe is a HEAD request', /fetchWithTimeout\(phpApiUrl, 5000, 'HEAD'\)/.test(security));
ok('the 8 s GET probe is gone', !/fetchWithTimeout\(phpApiUrl, 8000, 'GET'\)/.test(security));
ok('pin-mismatch classification is unchanged',
  /tls_rejected/.test(security) && /SSLPeerUnverifiedException/.test(security));
ok('every detector is still time-bounded and run in parallel',
  /DETECTOR_TIMEOUT_MS = 10_000/.test(security) && /Promise\.all\(\[/.test(security));
ok('genuinely-offline fast path is unchanged',
  /genuinelyOffline/.test(security));

/* ─────────────── single native player while navigating (6120) ──────────── */

console.log('\nLeaving the lesson unmounts the native player');
const lesson = stripComments(read('src/app/(app)/lesson/[id].tsx'));
ok('the lesson player is unmount-gated on blur',
  /setPlayerVisible\(false\)/.test(lesson) && /playerVisible/.test(lesson));

/* ─────────────────────────────── summary ───────────────────────────────── */

console.log('\n──────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
