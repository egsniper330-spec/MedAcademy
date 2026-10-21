#!/usr/bin/env node
/**
 * Doctor → Courses status tabs — regression suite.
 *
 * THE REPORTED BUG
 * ────────────────
 * Selecting "Drafts" showed published courses (and "Published" showed drafts),
 * in Arabic and English. Two independent causes:
 *
 *   1. the screen relied on `?status=` from a PHP endpoint that IGNORED the
 *      parameter and returned every course the doctor owns;
 *   2. the tab change never even re-ran the loader (`useStaleWhileRevalidateFocus`
 *      keeps a stable focus subscription), so the rendered rows were whatever
 *      the first request returned.
 *
 * The fix is one shared, pure predicate (src/lib/courseStatus.ts) applied to the
 * rows the screen already holds. These tests pin its semantics: mixed data,
 * status aliases, archived rows, empty lists, ordering and the All tab.
 *
 * Run: node tests/courseStatusFilter.test.cjs
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

/* ── compile the pure module ─────────────────────────────────────────────── */

const build = fs.mkdtempSync(path.join(os.tmpdir(), 'course-status-'));
execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(ROOT, 'src/lib/courseStatus.ts'),
    '--outDir', build,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--skipLibCheck',
    '--noEmitOnError', 'false',
  ],
  { stdio: 'pipe' },
);
const {
  normalizeCourseStatus,
  matchesCourseStatusTab,
  filterCoursesByStatus,
  countByStatusTab,
  isCoursePublished,
  isCourseArchived,
} = require(path.join(build, 'courseStatus.js'));

/* ── fixtures ───────────────────────────────────────────────────────────── */

const MIXED = [
  { id: 'a', title: 'Cardiology', status: 'published', archived_at: null },
  { id: 'b', title: 'Pharmacology draft', status: 'draft', archived_at: null },
  { id: 'c', title: 'Anatomy', status: 'Published', archived_at: null }, // case
  { id: 'd', title: 'Hidden course', status: 'hidden', archived_at: null },
  { id: 'e', title: 'Archived published', status: 'published', archived_at: '2026-09-01T10:00:00Z' },
  { id: 'f', title: 'Legacy active', status: 'active', archived_at: null },
  { id: 'g', title: 'Legacy empty status', status: '', archived_at: null },
  { id: 'h', title: 'Unknown status', status: 'review', archived_at: null },
  { id: 'i', title: 'Status archived', status: 'archived', archived_at: null },
];

console.log('\nnormalization');
check('published → published', normalizeCourseStatus({ status: 'published' }) === 'published');
check('PUBLISHED (case) → published', normalizeCourseStatus({ status: 'PUBLISHED' }) === 'published');
check('  published (whitespace) → published', normalizeCourseStatus({ status: '  published ' }) === 'published');
check('active → published (legacy)', normalizeCourseStatus({ status: 'active' }) === 'published');
check('draft → draft', normalizeCourseStatus({ status: 'draft' }) === 'draft');
check('empty → draft (DB default)', normalizeCourseStatus({ status: '' }) === 'draft');
check('missing status → draft', normalizeCourseStatus({}) === 'draft');
check('null course → unknown', normalizeCourseStatus(null) === 'unknown');
check('hidden → hidden', normalizeCourseStatus({ status: 'hidden' }) === 'hidden');
check('archived status → archived', normalizeCourseStatus({ status: 'archived' }) === 'archived');
check('unrecognized → unknown (never published/draft)',
  normalizeCourseStatus({ status: 'review' }) === 'unknown');
check('archived_at beats a published status',
  normalizeCourseStatus({ status: 'published', archived_at: '2026-01-01T00:00:00Z' }) === 'archived');
check('isCourseArchived true for timestamp', isCourseArchived({ archived_at: '2026-01-01' }) === true);
check('isCourseArchived false for null', isCourseArchived({ archived_at: null }) === false);
check('isCoursePublished honors archive',
  isCoursePublished({ status: 'published', archived_at: '2026-01-01' }) === false);

console.log('\ntab membership');
check('All includes every row', filterCoursesByStatus(MIXED, 'all').length === MIXED.length);
check('Drafts contains only drafts',
  filterCoursesByStatus(MIXED, 'draft').every((c) => normalizeCourseStatus(c) === 'draft'));
check('Drafts ids are exactly {b, g}',
  filterCoursesByStatus(MIXED, 'draft').map((c) => c.id).join(',') === 'b,g');
check('Published contains only published (incl. legacy active)',
  filterCoursesByStatus(MIXED, 'published').map((c) => c.id).join(',') === 'a,c,f');
check('Published never contains a draft', !matchesCourseStatusTab({ status: 'draft' }, 'published'));
check('Published never contains an archived row',
  !matchesCourseStatusTab({ status: 'published', archived_at: '2026-01-01' }, 'published'));
check('Drafts never contains an archived row',
  !matchesCourseStatusTab({ status: 'draft', archived_at: '2026-01-01' }, 'draft'));
check('hidden is not in Drafts', !matchesCourseStatusTab({ status: 'hidden' }, 'draft'));
check('unknown is only in All', !matchesCourseStatusTab({ status: 'review' }, 'published')
  && !matchesCourseStatusTab({ status: 'review' }, 'draft'));

console.log('\ncontract details');
const originalOrder = MIXED.map((c) => c.id).join(',');
check('filtering preserves input order',
  filterCoursesByStatus(MIXED, 'all').map((c) => c.id).join(',') === originalOrder);
check('input array is not mutated', MIXED.map((c) => c.id).join(',') === originalOrder);
check('empty list → empty result for every tab',
  ['all', 'draft', 'published'].every((tab) => filterCoursesByStatus([], tab).length === 0));
check('null list is tolerated', filterCoursesByStatus(null, 'draft').length === 0);
const counts = countByStatusTab(MIXED);
check('counts: all', counts.all === 9);
check('counts: draft', counts.draft === 2);
check('counts: published', counts.published === 3);

// A larger page-sized batch (defensive: filtering must not depend on size).
const LARGE = Array.from({ length: 200 }, (_, i) => ({
  id: 'c' + i,
  status: i % 3 === 0 ? 'published' : i % 3 === 1 ? 'draft' : 'hidden',
}));
check('200-row batch: published count', filterCoursesByStatus(LARGE, 'published').length === 67);
check('200-row batch: draft count', filterCoursesByStatus(LARGE, 'draft').length === 67);

/* ── wiring assertions (the screen must actually use the shared filter) ──── */

console.log('\nwiring');
const coursesSrc = read('src/app/(app)/(doctor)/courses.tsx');
check('courses screen imports filterCoursesByStatus', /filterCoursesByStatus/.test(coursesSrc));
check('courses screen filters with the active tab', /filterCoursesByStatus\(\s*courses\s*,\s*statusFilter\s*\)/.test(coursesSrc));
check('courses screen no longer asks the server for one status at a time',
  !/getCoursesWithArchived\(\{[^}]*status:\s*statusFilter/.test(coursesSrc));

const controllerSrc = read('backend/src/Controllers/CourseController.php');
check('backend /courses honours the status query parameter',
  /\$request->query\('status'\)/.test(controllerSrc) && /c\.status = \?/.test(controllerSrc));
check('backend validates the status whitelist', /'draft', 'published', 'hidden', 'archived'/.test(controllerSrc));
check('backend excludes archived rows when the client asks for live rows',
  /archived_at IS NULL/.test(controllerSrc));
check('backend returns updated_at + archived_at for client sorting/badges',
  /c\.updated_at, c\.archived_at/.test(controllerSrc));

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
