#!/usr/bin/env node
/**
 * Archived Courses — regression suite (Doctor quick action).
 *
 * THE REPORTED BUG
 * ────────────────
 * Doctor ▸ Dashboard ▸ Archived courses always rendered "0 archived / No archived
 * courses", in English, inside a page with a large dead area.
 *
 * ROOT CAUSE (verified against the code, not the screenshot)
 * ───────────────────────────────────────────────────────────
 * 1. GET /analytics/archived-courses was guarded `role => admin|super_admin`.
 *    The screen is opened from the DOCTOR dashboard, so every doctor request
 *    was refused (403), the client's catch emptied the list, and the empty
 *    state rendered — deterministically, for every doctor with any number of
 *    archived courses. Archiving itself persisted correctly
 *    (`status='archived'` + `archived_at`), so nothing was "lost".
 * 2. The payload carried 5 of the 10 fields the client contract needs, wrapped
 *    in `{ courses: [...] }`, while the old client read a bare array.
 * 3. Every string on the screen was a hardcoded English literal and the empty
 *    state was an unframed icon under a fixed pad (the huge blank area).
 *
 * These tests pin the fixed contract end-to-end at the source level plus the
 * shared archived-state semantics (src/lib/courseStatus.ts) so a future edit
 * cannot silently resurrect the empty list.
 *
 * Run: node tests/archivedCourses.test.cjs
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

const screen = read('src/app/(app)/archived-courses/index.tsx');
const apiSrc = read('src/lib/api.ts');
const routes = read('backend/routes/api.php');
const controller = read('backend/src/Controllers/AnalyticsController.php');
const courseController = read('backend/src/Controllers/CourseController.php');
const client = read('src/client/php.ts');

/* ── compile the shared dictionary + status model ────────────────────────── */

const build = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-courses-'));
const compile = (rel, outName) => {
  const out = path.join(build, outName);
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, rel),
      '--outDir', out,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(out, path.basename(rel).replace(/\.ts$/, '.js')));
};
const { en, ar } = compile('src/lib/i18n/resources.ts', 'i18n');
const status = compile('src/lib/courseStatus.ts', 'status');

/* ── 1. the endpoint the doctor's quick action calls is doctor-accessible ── */

console.log('\n1. endpoint authorization + routing');
const archivedRoute = routes.split('\n').find((l) => l.includes("'/analytics/archived-courses'")) || '';
check('the archived-courses route exists', archivedRoute !== '');
check('doctors may call it (root cause of the permanent empty list)',
  /'role' => \['doctor', 'admin', 'super_admin'\]/.test(archivedRoute), archivedRoute.trim());
check('it still requires authentication', /\[AnalyticsController::class, 'archivedCourses'\], \$auth/.test(archivedRoute));
check('the client RPC name maps to that route',
  client.includes("'get_archived_courses':             '/analytics/archived-courses'"));
check('the screen calls the client helper, not a hand-built URL',
  /getArchivedCourses\(/.test(screen) && !/fetch\(/.test(screen));

/* ── 2. ownership: doctors see only their own, staff see all ─────────────── */

console.log('\n2. ownership and authorization boundaries');
const handler = controller.slice(
  controller.indexOf('public function archivedCourses'),
  controller.indexOf('public function courseDeleteStats'),
);
check('the actor comes from the session, never from the request body',
  /\$request->user\['id'\]/.test(handler) && !/body\('doctor_id'\)/.test(handler));
check('a doctor is scoped to courses they own',
  /c\.doctor_id = \?/.test(handler) && /!\s*\$isStaff/.test(handler));
check('a non-doctor, non-staff caller is refused',
  /ApiException\(403/.test(handler));
check('staff may narrow the list with a bound doctor_id (never interpolated)',
  /doctor_id/.test(handler) && !/\$doctorId.*\$where\.=.{0,20}\$doctorId/.test(handler));
check('the query is parameterised (no string concatenation of ids)',
  /\$params\[\] = \$userId/.test(handler) && /\$params\[\] = \$doctorId/.test(handler));

/* ── 3. archived state: status OR legacy timestamp, never one alone ─────── */

console.log('\n3. archived-state representation');
check('a row counts as archived on status OR archived_at (legacy rows survive)',
  /\(c\.status = 'archived' OR c\.archived_at IS NOT NULL\)/.test(handler));
check('nothing filters archived rows out of this list (the only NULL test is the sort key)',
  !/status != 'archived'/.test(handler)
  && !/AND\s+c\.archived_at IS NULL/i.test(handler)
  && !/\bWHERE\s+c\.archived_at IS NULL/i.test(handler));
check('archive persists BOTH status and archived_at',
  /SET status = 'archived', archived_at = UTC_TIMESTAMP\(6\), archived_by = \?/.test(courseController));
check('restore returns the course to draft and clears the archive markers',
  /status = \?, archived_at = NULL, archived_by = NULL/.test(courseController));
check('shared helper treats a timestamp as archived even with a published status',
  status.normalizeCourseStatus({ status: 'published', archived_at: '2026-01-01' }) === 'archived');
check('shared helper treats status="archived" with no timestamp as archived',
  status.isCourseArchived({ status: 'archived' }) === true || status.normalizeCourseStatus({ status: 'archived' }) === 'archived');
check('isCoursePublished is false for an archived course',
  status.isCoursePublished({ status: 'archived' }) === false);

/* ── 4. business rules: catalog hidden, enrolled students unaffected ────── */

console.log('\n4. catalog visibility and enrolled access');
check('archived courses are not `published`, so the student catalog excludes them',
  /\(c\.status = 'published'/.test(courseController));
check('an existing non-suspended enrollment still grants visibility/access',
  /EXISTS \(SELECT 1 FROM enrollments e/.test(courseController)
  && /e\.status IS NULL OR e\.status <> 'suspended'/.test(courseController));
check('restore/unarchive stays available from the archived screen',
  /restoreCourse\(/.test(screen) && /archived\.restore/.test(screen));

/* ── 5. payload contract: what the client needs is actually returned ────── */

console.log('\n5. API payload contract');
for (const field of ['c.id', 'c.title', 'c.doctor_id', 'c.status', 'c.archived_at', 'c.archived_by', 'c.archive_reason']) {
  check(`handler selects ${field}`, handler.includes(field));
}
check('handler joins doctor and archiver names',
  /doctor_name/.test(handler) && /archived_by_name/.test(handler));
check('handler returns distinct student accounts (not join rows)',
  /COUNT\(DISTINCT e\.student_id\)/.test(handler));
check('handler returns a lesson count', /COUNT\(\*\) FROM lessons l WHERE l\.course_id = c\.id/.test(handler));
check('handler returns enrollments for reconciliation', /AS enrollments_count/.test(handler));
check('handler still wraps the list in `courses` (documented contract)',
  /return \['courses' => \$courses \?\? \[\]\]/.test(handler));
check('client tolerates BOTH a bare array and the wrapped object (no more silent empty)',
  /Array\.isArray\(data\)/.test(apiSrc)
  && /Array\.isArray\(\(data as \{ courses\?: ArchivedCourse\[\] \}\)\.courses\)/.test(apiSrc));
check('client type carries the ownership + archive fields',
  /export interface ArchivedCourse/.test(apiSrc)
  && /archived_at: string \| null/.test(apiSrc)
  && /archived_by_name: string \| null/.test(apiSrc));

/* ── 6. UI: localized, gated, balanced empty state, real data ───────────── */

console.log('\n6. screen behaviour');
check('screen is gated to the roles the API authorizes',
  /\['doctor', 'admin', 'super_admin'\]\.includes\(role\)/.test(screen));
check('no client-side role filter discards rows the API returned',
  !/courses\.filter\([^)]*archived/.test(screen));
check('search only filters by title/doctor (never by status)',
  /course\.title/.test(screen) && /course\.doctor_name/.test(screen));
check('loading state is localized and shown while fetching',
  /t\('archived\.loading'\)/.test(screen) && /loading \?/.test(screen));
check('error state is localized and offers retry',
  /archived\.errorTitle/.test(screen) && /archived\.retry/.test(screen));
check('empty state distinguishes "no matches" from "nothing archived"',
  /archived\.noMatchTitle/.test(screen) && /archived\.emptyTitle/.test(screen));
check('empty state is a bounded card (no unbounded pad), centred in the space left',
  /<NeuCard style=\{\{ alignItems: 'center', paddingVertical: 26/.test(screen)
  && /flexGrow: 1, justifyContent: 'center'/.test(screen));
check('count in the subtitle comes from the loaded rows',
  /tCount\('archived\.courseCount', courses\.length\)/.test(screen));
check('rows render title, doctor, archive date, students and lessons',
  /course\.title/.test(screen) && /course\.doctor_name/.test(screen)
  && /formatLocalizedDate\(course\.archived_at/.test(screen)
  && /archived\.students/.test(screen) && /drCourses\.lessonCount/.test(screen));
check('permanent deletion is Super Admin only',
  /isSuperAdmin &&/.test(screen));
check('Back has a role-appropriate fallback (no dead end from a drawer entry)',
  /backFallback =/.test(screen) && /\(doctor\)\/dr-overview/.test(screen)
  && /\(admin\)\/admin-overview/.test(screen) && /\(superadmin\)\/sa-overview/.test(screen));

console.log('\n7. localization');
const usedKeys = Array.from(new Set(
  Array.from(screen.matchAll(/\bt(?:Count)?\('([a-zA-Z0-9_.]+)'/g)).map((m) => m[1]),
));
// Count keys are CLDR-pluralised (`key.one`, `key.other`, ...), so a key is
// present when its base form or any plural variant is defined.
const present = (dict, key) => (key in dict)
  || Object.keys(dict).some((k) => k.startsWith(key + '.'));
const missingEn = usedKeys.filter((k) => !present(en, k));
const missingAr = usedKeys.filter((k) => !present(ar, k));
check(`every key used by the screen exists in English (${usedKeys.length} keys checked)`,
  missingEn.length === 0, missingEn.join(', '));
check('every key used by the screen exists in Arabic',
  missingAr.length === 0, missingAr.join(', '));
check('Arabic copy is actually Arabic (not English fallback)',
  /[\u0600-\u06FF]/.test(ar['archived.title'] || '') && /[\u0600-\u06FF]/.test(ar['archived.emptyTitle'] || ''));
check('English copy is English',
  /Archived/i.test(en['archived.title'] || ''));
check('Arabic count string is pluralised via the i18n count helper',
  /archived\.courseCount/.test(screen) && /tCount\(/.test(screen));

// No untranslated JSX text nodes (the original bug's "No archived courses").
const jsxText = Array.from(screen.matchAll(/>\s*([A-Za-z][A-Za-z ,.'!?-]{3,})\s*</g))
  .map((m) => m[1].trim())
  .filter((s) => s.length > 3);
check('no hardcoded English text nodes remain in the screen',
  jsxText.length === 0, jsxText.slice(0, 5).join(' | '));

/* ── 8. route wiring ────────────────────────────────────────────────────── */

console.log('\n8. route + navigation wiring');
check('screen lives at the group-free /archived-courses route the dashboard uses',
  exists('src/app/(app)/archived-courses/index.tsx'));
check('doctor dashboard quick action points at it',
  /route: '\/\(app\)\/archived-courses'/.test(read('src/app/(app)/(doctor)/dr-overview.tsx')));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
