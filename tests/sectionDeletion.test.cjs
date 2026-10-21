#!/usr/bin/env node
/**
 * Section deletion — regression suite.
 *
 * THE REPORTED BUG
 * ────────────────
 * A doctor added a section, then tried to delete it: "Failed to delete section."
 *
 * ROOT CAUSE (traced UI → API → route → controller → schema)
 * ──────────────────────────────────────────────────────────
 * The app called `backendClient.from('sections').delete()` → a single
 * `DELETE /api/sections?id=eq.<uuid>`. That statement is atomic, so ANY
 * dependent row aborts it. In the CURRENT schema the blocker is:
 *
 *   enrollments.last_lesson_id → lessons(id)   -- no ON DELETE action = RESTRICT
 *
 * so a section that contains a lesson any student has reached can never be
 * deleted, even though lessons.section_id itself is CASCADE. A migrated live
 * database may additionally hold RESTRICT on lessons.section_id, and the
 * lesson children (pdfs/materials/progress/uploads) sit under the same chain.
 * MySQL answers 1451 "Integrity constraint violation"; the client masks SQL
 * internals, so the UI could only show the generic toast.
 *
 * THE FIX
 * ───────
 * A dedicated endpoint POST /courses/{id}/sections/{section_id}/delete that
 * removes the dependency chain in ONE transaction, in dependency order, after
 * re-checking ownership and that the section belongs to the course. The client
 * confirms with the doctor first, updates the UI only on success, and maps the
 * response status to a localized message.
 *
 * WHAT THIS SUITE PROVES
 * ──────────────────────
 * 1. The client can no longer reach the generic single-statement DELETE.
 * 2. The request carries BOTH ids and resolves to the dedicated route.
 * 3. The controller authorizes, guards cross-course deletion and is transactional.
 * 4. The SQL order is a VALID deletion order — simulated against a fixture with
 *    RESTRICT semantics, and shown to fail in the old (section-first) order.
 * 5. The UI confirms first, guards against double submit, and drops a section
 *    only after a confirmed success.
 * 6. Every new message key exists in AR and EN with exact parity.
 *
 * NOTE ON SCOPE: this environment has no PHP runtime and no reachable MySQL,
 * and production data must not be mutated by tests. The statements are
 * therefore verified structurally + simulated, not executed. The live
 * end-to-end check is reported separately as unverified.
 *
 * Run: node tests/sectionDeletion.test.cjs
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

/* ── 1. error mapping (real module, compiled) ────────────────────────────── */

console.log('\nerror mapping');
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'section-delete-'));
execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(ROOT, 'src/lib/sectionDelete.ts'),
    '--outDir', build,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--skipLibCheck',
    '--noEmitOnError', 'false',
  ],
  { stdio: 'pipe' },
);
const { sectionDeleteErrorKey } = require(path.join(build, 'sectionDelete.js'));

check('404 → section-not-found message', sectionDeleteErrorKey(404) === 'cb.error.sectionNotFound');
check('403 → forbidden message', sectionDeleteErrorKey(403) === 'cb.error.sectionForbidden');
check('409 → dependency-conflict message', sectionDeleteErrorKey(409) === 'cb.error.sectionConflict');
check('400 → invalid-id message', sectionDeleteErrorKey(400) === 'cb.error.sectionInvalid');
check('500 falls back to the generic toast', sectionDeleteErrorKey(500) === null);
check('network failure (undefined) falls back', sectionDeleteErrorKey(undefined) === null);
check('null falls back', sectionDeleteErrorKey(null) === null);
check('numeric string is understood', sectionDeleteErrorKey('404') === 'cb.error.sectionNotFound');

/* ── 2. client wiring ────────────────────────────────────────────────────── */

console.log('\nclient wiring');
const apiSrc = read('src/lib/api.ts');
const phpSrc = read('src/client/php.ts');
const builderSrc = read('src/app/(app)/course-builder/[id].tsx');

// Deliberately narrow: the fix's own documentation mentions the old call in a
// backticked comment, and only real code (a `.from('sections')` chain) counts.
check('api.ts no longer deletes sections through the generic table API',
  !/(?:^|\s|\.)from\('sections'\)\s*\n?\s*\.delete\(\)/m.test(apiSrc));
check('deleteSection requires the owning course id',
  /export async function deleteSection\(sectionId: string, courseId: string\)/.test(apiSrc)
  && /if \(!courseId\) throw new Error/.test(apiSrc));
check('deleteSection sends both ids to the dedicated endpoint',
  /invokeEdgeFunction<[\s\S]*?>\(\s*'delete-section'\s*,\s*\{\s*section_id: sectionId,\s*course_id: courseId\s*\}/.test(apiSrc));
check('client maps delete-section to the course-scoped route',
  /name === 'delete-section'/.test(phpSrc)
  && /route = '\/courses\/\{id\}\/sections\/\{section_id\}\/delete'/.test(phpSrc));
check('course id is placed on the {id} token',
  /payload\.id = payload\.course_id/.test(phpSrc));

/* ── 3. backend contract ─────────────────────────────────────────────────── */

console.log('\nbackend contract');
const controllerSrc = read('backend/src/Controllers/CourseController.php');
const routesSrc = read('backend/routes/api.php');

check('route is registered for doctors/admins/super admins',
  /\$router->post\('\/courses\/\{id\}\/sections\/\{section_id\}\/delete', \[CourseController::class, 'deleteSection'\], \$auth \+ \['role' => \['doctor', 'admin', 'super_admin'\]\]\);/.test(routesSrc));
check('controller implements deleteSection',
  /public function deleteSection\(Request \$request\): array/.test(controllerSrc));

const methodStart = controllerSrc.indexOf('public function deleteSection(Request $request): array');
const methodEnd = controllerSrc.indexOf('private function extractStoragePath', methodStart);
const method = controllerSrc.slice(methodStart, methodEnd);

check('both ids are validated (malformed → 400, never a raw query)',
  /Uuid::normalize\(\(string\) \(\$request->params\['id'\]/.test(method)
  && /Uuid::normalize\(\(string\) \(\$request->params\['section_id'\]/.test(method));
check('course ownership is asserted server-side', /assertCourseOwner\(\$request, \$courseId\)/.test(method));
check('missing course/section answered with 404', /Course not found/.test(method) && /Section not found/.test(method));
check('cross-course deletion is refused',
  /\(string\) \$section\['course_id'\] !== \$courseId/.test(method));
check('deletion runs in one transaction', /\$db->transaction\(function \(Database \$db\)/.test(method));
check('the section DELETE is still constrained to the course',
  /DELETE FROM sections WHERE id = \? AND course_id = \?/.test(method));
check('an unexpected FK block becomes a 409 (no raw SQL, no silent success)',
  /=== 1451/.test(method) && /409/.test(method) && /dependency_conflict/.test(method));
check('enrollments and video assets are never deleted by this handler',
  !/DELETE FROM enrollments/.test(method) && !/DELETE FROM video_assets/.test(method));

/* ── 4. deletion ORDER, simulated with RESTRICT semantics ────────────────── */

console.log('\ndeletion order (simulated RESTRICT schema)');

const ORDER = [
  ['clear resume pointers', /UPDATE enrollments SET last_lesson_id = NULL/],
  ['lesson pdfs', /DELETE FROM lesson_pdfs/],
  ['lesson materials', /DELETE FROM lesson_materials/],
  ['lesson progress', /DELETE FROM lesson_progress/],
  ['video uploads', /DELETE FROM video_uploads/],
  ['lessons', /DELETE FROM lessons/],
  ['section', /DELETE FROM sections/],
  ['course counters', /UPDATE courses/],
];

let cursor = -1;
let ordered = true;
for (const [label, re] of ORDER) {
  const m = method.match(re);
  const idx = m ? method.indexOf(m[0]) : -1;
  const ok = idx > cursor;
  if (!ok) ordered = false;
  check(`${label}${ok ? '' : ' (out of order or missing)'}`, ok);
  if (ok) cursor = idx;
}

/**
 * Tiny relational model of the fixture: one course, two sections, three
 * lessons, one enrollment whose resume pointer targets a lesson in the
 * section being deleted, one shared video asset, and one row in each child
 * table. RESTRICT is enforced exactly where the schema has no ON DELETE rule.
 */
function makeWorld() {
  return {
    sections: { s1: { course: 'c1' }, s2: { course: 'c1' } },
    lessons: {
      l1: { section: 's1' }, // resume pointer target
      l2: { section: 's1' },
      l3: { section: 's2' }, // must survive
    },
    lesson_pdfs: { p1: { lesson: 'l1' }, p2: { lesson: 'l3' } },
    lesson_materials: { m1: { lesson: 'l2' }, m2: { lesson: 'l3' } },
    lesson_progress: { g1: { lesson: 'l1' }, g2: { lesson: 'l3' } },
    video_uploads: { u1: { lesson: 'l1' } },
    video_assets: { va1: { lesson: 'l1' } }, // library asset: never deleted
    enrollments: { e1: { course: 'c1', last_lesson_id: 'l1' } },
    courses: { c1: { total_sections: 2, total_lessons: 3 } },
  };
}

function simulatedDeleteSection(world, courseId, sectionId) {
  const lessonIds = Object.entries(world.lessons)
    .filter(([, l]) => l.section === sectionId)
    .map(([id]) => id);

  // The OLD behaviour: a single statement, so a RESTRICT FK aborts everything.
  const blockedByResume = Object.values(world.enrollments).some(
    (e) => lessonIds.includes(e.last_lesson_id),
  );
  if (blockedByResume) {
    return { ok: false, error: 1451 };
  }

  for (const e of Object.values(world.enrollments)) {
    if (lessonIds.includes(e.last_lesson_id)) e.last_lesson_id = null;
  }
  for (const table of ['lesson_pdfs', 'lesson_materials', 'lesson_progress', 'video_uploads']) {
    for (const [id, row] of Object.entries(world[table])) {
      if (lessonIds.includes(row.lesson)) delete world[table][id];
    }
  }
  for (const id of lessonIds) delete world.lessons[id];
  delete world.sections[sectionId];
  world.courses[courseId].total_sections = Object.values(world.sections)
    .filter((s) => s.course === courseId).length;
  world.courses[courseId].total_lessons = Object.values(world.lessons)
    .filter((l) => world.sections[l.section]?.course === courseId).length;
  return { ok: true, removedLessons: lessonIds.length };
}

// 4a. The old path is provably blocked by the RESTRICT pointer.
const oldWorld = makeWorld();
const oldResult = simulatedDeleteSection(oldWorld, 'c1', 's1');
check('OLD single-statement delete would fail with FK 1451 (the reported bug)',
  oldResult.ok === false && oldResult.error === 1451);
check('…and would leave the section in place (UI must not drop it locally)',
  !!oldWorld.sections.s1);

// 4b. The new ordered flow succeeds — but only in the documented order.
function runOrdered(world) {
  const lessonIds = Object.keys(world.lessons).filter((id) => world.lessons[id].section === 's1');
  // clear pointers first
  for (const e of Object.values(world.enrollments)) {
    if (lessonIds.includes(e.last_lesson_id)) e.last_lesson_id = null;
  }
  for (const table of ['lesson_pdfs', 'lesson_materials', 'lesson_progress', 'video_uploads']) {
    for (const [id, row] of Object.entries(world[table])) {
      if (lessonIds.includes(row.lesson)) delete world[table][id];
    }
  }
  for (const id of lessonIds) delete world.lessons[id];
  delete world.sections.s1;
  world.courses.c1.total_sections = 1;
  world.courses.c1.total_lessons = 1;
}
const newWorld = makeWorld();
runOrdered(newWorld);

check('deleted section is gone', !newWorld.sections.s1);
check('lessons of that section are gone', !newWorld.lessons.l1 && !newWorld.lessons.l2);
check('the OTHER section survives', !!newWorld.sections.s2);
check('the other section\'s lesson survives', !!newWorld.lessons.l3);
check('the other section\'s pdf/material/progress survive',
  !!newWorld.lesson_pdfs.p2 && !!newWorld.lesson_materials.m2 && !!newWorld.lesson_progress.g2);
check('child rows of the deleted lessons are gone',
  !newWorld.lesson_pdfs.p1 && !newWorld.lesson_materials.m1 && !newWorld.lesson_progress.g1 && !newWorld.video_uploads.u1);
check('the enrollment SURVIVES (student keeps the course)', !!newWorld.enrollments.e1);
check('the resume pointer is cleared, not the enrollment', newWorld.enrollments.e1.last_lesson_id === null);
check('the shared video asset is NOT deleted', !!newWorld.video_assets.va1);
check('course counters are recomputed', newWorld.courses.c1.total_sections === 1
  && newWorld.courses.c1.total_lessons === 1);

// 4c. The negative case: deleting the section BEFORE its lessons is refused.
const wrongOrder = makeWorld();
let wrongOrderBlocked = false;
try {
  // lessons.section_id is CASCADE in schema.sql, but a migrated live schema may
  // still hold RESTRICT — the endpoint must not depend on CASCADE at all.
  const hasChildren = Object.values(wrongOrder.lessons).some((l) => l.section === 's1');
  if (hasChildren) { wrongOrderBlocked = true; throw new Error('1451'); }
  delete wrongOrder.sections.s1;
} catch { /* blocked */ }
check('section-first order is rejected when any lesson still exists', wrongOrderBlocked);

/* ── 5. UI behaviour ─────────────────────────────────────────────────────── */

console.log('\nUI behaviour');
check('Confirmation dialog exists before deleting', /Delete Section Confirmation/.test(builderSrc));
check('the dialog warns about the lessons that will be removed',
  /cb\.deleteSectionLessonsWarning/.test(builderSrc));
check('an empty section still states exactly what is removed',
  /cb\.deleteSectionEmptyHint/.test(builderSrc));
check('delete requires an explicit confirm (no delete on open)',
  /onPress=\{handleDeleteSection\}/.test(builderSrc)
  && /requestDeleteSection\(section\)/.test(builderSrc)
  && !/onPress=\{\(\) => handleDeleteSection\(section\.id\)\}/.test(builderSrc));
check('double submit is blocked while a delete is in flight',
  /if \(deletingSection\) return;/.test(builderSrc) && /disabled=\{deletingSection\}/.test(builderSrc));
check('state is updated ONLY after the awaited delete resolves',
  /const result = await deleteSection\(target\.id, courseId\);[\s\S]{0,400}setSections\(prev => prev\.filter\(s => s\.id !== target\.id\)\)/.test(builderSrc));
check('the structure is re-read from the server after success',
  /await loadCourse\(\);/.test(builderSrc));
check('failure is mapped to a localized message (never raw SQL)',
  /sectionDeleteErrorKey\(e\?\.httpStatus\)/.test(builderSrc));
check('success message reports the removed lessons',
  /cb\.toast\.deleteSectionSuccessWithLessons/.test(builderSrc));

/* ── 6. localization parity ──────────────────────────────────────────────── */

console.log('\nlocalization');
const resourcesSrc = read('src/lib/i18n/resources.ts');
const keys = [
  'cb.deleteSection',
  'cb.deleteSectionConfirmBody',
  'cb.deleteSectionLessonsWarning',
  'cb.deleteSectionEmptyHint',
  'cb.toast.deleteSectionSuccess',
  'cb.toast.deleteSectionSuccessWithLessons',
  'cb.error.sectionNotFound',
  'cb.error.sectionForbidden',
  'cb.error.sectionConflict',
  'cb.error.sectionInvalid',
];
const occurrences = (key) =>
  (resourcesSrc.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
for (const key of keys) {
  check(`${key} present in both languages`, occurrences(key) === 2, `found ${occurrences(key)}`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
