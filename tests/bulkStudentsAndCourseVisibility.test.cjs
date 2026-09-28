/**
 * bulkStudentsAndCourseVisibility — contract pins for two backend-authoritative
 * features:
 *
 *   PART 1 — Bulk student selection/actions
 *     • Real bulk endpoint (POST /students/bulk-action) — never client-side
 *       per-student fan-out of individual endpoints.
 *     • Server-side scope: doctor → own courses + enrollment visibility policy
 *       (mirrors DataController::ownerScope's enrollment branch); admin/SA →
 *       platform-wide. Out-of-scope ids are per-row rejections, never executed.
 *     • Per-row results (succeeded/skipped/failed + reasons) — the UI can
 *       never show a false "N succeeded".
 *     • One summary audit event (students_bulk_action).
 *     • UI: Select mode, All-visible vs Clear, count, confirmation before any
 *       destructive bulk action, accurate result modal, per-card actions
 *       hidden during Select mode.
 *
 *   PART 2 — Unpublished courses disappear from students (server-side)
 *     • Canonical field: courses.status ∈ {draft,published,hidden,archived}
 *       (chk_courses_status). "Unpublished" = status ≠ 'published'. No second
 *       publication system is introduced.
 *     • Student My Courses embed (enrollments → course) resolves NULL unless
 *       the course is published — enrollment rows are NOT deleted
 *       (unpublish ≠ unenroll; re-publish restores visibility).
 *     • Student embedded lesson trees (course → sections → lessons) only
 *       resolve published lessons (mirrors the direct-GET ownerScope rule).
 *     • Direct access already enforced by ownerScope (courses/lessons read
 *       scope = owner OR published for students) — pinned so it cannot regress.
 *     • VdoCipher otp() + offlineAuthorize() refuse students whose parent
 *       course is not published, even with an active enrollment. Existing
 *       offline downloads are NOT deleted by this change (offline entitlement
 *       keys on the enrollment row, which is preserved).
 *     • Staff (doctor/admin/super_admin) keep full management visibility.
 *
 * Assertion style: real source with comments stripped (like the other suites).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function check(name, cond, msg) {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name} — ${msg}`); }
}

function readCode(p) {
  let src = fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
  src = src.replace(/\/\*[\s\S]*?\*\//g, '');
  src = src.replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  return src;
}

console.log('\n── PART 1: Bulk backend (StudentBulkController + route) ──');
{
  const ctl = readCode('backend/src/Controllers/StudentBulkController.php');
  const routes = readCode('backend/routes/api.php');

  check('bulk route registered as POST with role middleware',
    /\$router->post\('\/students\/bulk-action',\s*\[StudentBulkController::class,\s*'handle'\],\s*\$auth \+ \['role' => \['doctor', 'admin', 'super_admin'\]\]\)/.test(routes),
    'POST /students/bulk-action route missing or lacks role middleware');

  check('controller re-checks roles standalone (defense in depth)',
    /in_array\(\$actorRole,\s*\['doctor',\s*'admin',\s*'super_admin'\],\s*true\)/.test(ctl),
    'role re-check missing');

  check('actions limited to existing individual capabilities',
    /const ACTIONS = \['suspend', 'resume', 'remove'\]/.test(ctl),
    'ACTIONS must mirror the individual per-card actions only');

  check('ids validated + capped before any DB work',
    /Uuid::normalize\(\(string\) \$raw\)/.test(ctl) && /MAX_IDS = 200/.test(ctl),
    'client-supplied ids are not validated/capped server-side');

  check('ONE server-side scoped fetch resolves ALL ids',
    /SELECT e\.id, e\.status, e\.visibility_level, e\.student_id, c\.doctor_id, c\.id AS course_id/.test(ctl) &&
    /FROM enrollments e\s*\n\s*JOIN courses c ON c\.id = e\.course_id\s*\n\s*WHERE e\.id IN/.test(ctl),
    'per-id authorization resolution missing');

  check('doctor scope = course ownership (server-enforced)',
    /\(string\) \$row\['doctor_id'\] !== \$actorId/.test(ctl),
    'doctor ownership check missing');

  check('doctor scope mirrors enrollment visibility policy',
    /\$row\['visibility_level'\] === null \|\| \$row\['visibility_level'\] === 'all'/.test(ctl),
    'visibility_level policy (all/NULL only for doctors) missing');

  check('out-of-scope ids reported as failures, never executed',
    /'reason' => 'not_authorized'/.test(ctl) && /'reason' => 'not_found'/.test(ctl),
    'per-row rejection reasons missing');

  check('suspend/resume are no-op safe (skipped when already in state)',
    /already_\{\$target\}/.test(ctl),
    'idempotent skip missing');

  check('remove mirrors the individual remove (earnings event, per-row transaction)',
    /doctor_earnings_events/.test(ctl) && /\$db->transaction\(/.test(ctl) && /DELETE FROM enrollments WHERE id = \?/.test(ctl),
    'remove business rule diverges from the individual action');

  check('per-row results always returned (accurate counts)',
    /'succeeded' => \$succeeded/.test(ctl) && /'failed' => \$failed/.test(ctl) && /'results' => \$results/.test(ctl),
    'response lacks exact per-row accounting');

  check('summary audit event written',
    /AuditService::write\(\$actorId, 'students_bulk_action'/.test(ctl),
    'audit event missing');

  check('NO per-student frontend fan-out of individual endpoints',
    !/for\s*\(.*of\s*.*selected.*\)\s*\{[\s\S]{0,200}suspendCourseSubscription/.test(readCode('src/app/(app)/(doctor)/students.tsx')),
    'the UI loops individual suspend calls instead of using the bulk endpoint');
}

console.log('\n── PART 1: Bulk frontend (Select mode UX) ──');
{
  const ui = readCode('src/app/(app)/(doctor)/students.tsx');
  const api = readCode('src/lib/api.ts');
  const php = readCode('src/client/php.ts');

  check('API client function targets the bulk endpoint',
    /export async function bulkStudentAction/.test(api) && /student-bulk-action/.test(api),
    'bulkStudentAction missing from the API layer');

  check('client route map resolves to the backend path',
    /'student-bulk-action':\s*'\/students\/bulk-action'/.test(php),
    'EDGE_FUNCTION_MAP entry missing');

  check('Select mode toggle exists',
    /Select students for bulk actions/.test(ui),
    'Select entry button missing');

  check('selection checkbox on cards only in Select mode',
    /selectMode && \(/.test(ui) && /accessibilityRole=\{selectMode \? 'checkbox' : undefined\}/.test(ui),
    'checkbox rendering not gated on select mode');

  check('selected card gets a subtle state (border, same card)',
    /selectMode && isSelected \? \{ borderWidth: 1\.5, borderColor: c\.primary \} : \{\}/.test(ui),
    'selected state missing');

  check('Select all visible + Clear + count present',
    /Select all visible students/.test(ui) && /Clear selection/.test(ui) && /\{selected\.size\} selected/.test(ui),
    'selection bar controls missing');

  check('Bulk Actions appears only with ≥1 selected',
    /selected\.size > 0 && \(/.test(ui),
    'bulk actions menu not gated on selection size');

  check('bulk options derive from the same per-row states as individual buttons',
    /selectedActiveCount > 0 && \(/.test(ui) && /selectedSuspendedCount > 0 && \(/.test(ui),
    'suspend/resume availability not derived from row states');

  check('confirmation modal before destructive bulk action',
    /setBulkConfirm\(null\)/.test(ui) && /Cancel<\/Text>/.test(ui),
    'confirmation/cancel flow missing');

  check('result modal reports accurate succeeded/failed/skipped',
    /\{bulkResult\.succeeded\} succeeded/.test(ui) && /bulkResult\.failed > 0/.test(ui),
    'accurate result display missing');

  check('individual per-card actions hidden during Select mode',
    /\{!selectMode && \(/.test(ui),
    'per-card action row not suppressed in select mode');

  check('exit select mode clears selection safely',
    /exitSelectMode/.test(ui) && /setSelected\(new Set\(\)\)/.test(ui),
    'selection cleanup on exit missing');

  check('"All visible" is scoped to the current tab list, not the database',
    /selectAllVisible|All visible/.test(ui) && /visibleEnrollments/.test(ui),
    'visible-list selection model missing');
}

console.log('\n── PART 2: Unpublished courses hidden from students (server-side) ──');
{
  const dc = readCode('backend/src/Controllers/DataController.php');
  const vdo = readCode('backend/src/Video/VdoCipherService.php');

  check('student many-to-one course embeds JOIN-scoped to published only',
    /hideUnpublishedCourses && \$rel\['table'\] === 'courses'/s.test(dc) &&
    /AND `__r\{\$i\}`\.`status` = 'published'/.test(dc) || /AND `\{\$alias\}`\.`status` = 'published'/.test(dc),
    'student course-embed JOIN condition missing the published filter');

  check('embed filter applies to students only (staff keep management visibility)',
    /\(\(string\)\s*\(\$request->user\['role'\]\s*\?\? ''\)\) === 'student'\)|\(\$request->user\['role'\] \?\? ''\) === 'student'/.test(dc),
    'role gate on the embed filter missing');

  check('buildMainSelect receives the student flag from select()',
    /buildMainSelect\(\s*\$table,\s*\$parsed,/.test(dc),
    'select() does not pass the visibility flag into buildMainSelect');

  check('embedded lesson tree published-only for students (defense in depth)',
    /\$rel\['table'\] === 'lessons' && \$viewerRole === 'student'/.test(dc) &&
    /\.`status` = 'published'`?/.test(dc),
    'fetchChildren lesson status filter missing');

  check('enrollment rows are NOT deleted by unpublish (no unenroll side effect)',
    !/DELETE FROM enrollments[\s\S]{0,80}unpublish/i.test(dc),
    'an unpublish path deletes enrollments');

  check('otp() blocks students when parent course is not published',
    /SELECT status FROM courses WHERE id = \?/.test(vdo) &&
    /This course is not available/.test(vdo),
    'course-status gate missing in the video service');

  check('course gate counts BOTH otp and offline authorization',
    (vdo.match(/This course is not available/g) || []).length === 2,
    'the offline twin path is missing the course-status gate');

  check('gate applies to students only (staff manage unpublished content)',
    /!\$isPrivileged/.test(vdo),
    'privileged bypass missing');

  check('canonical status field used (no second publication system)',
    /status.*'published'/.test(vdo) && !/is_published|published_at\s*=/i.test(vdo),
    'a parallel publication concept was introduced');

  // Direct-access enforcement that must not regress (ownerScope):
  check('direct course GET stays owner-OR-published for students (ownerScope)',
    /`courses`\.`doctor_id` = \? OR `courses`\.`status` = 'published'/.test(dc),
    'ownerScope courses read scope changed');

  check('student direct lesson GET stays published-only (ownerScope)',
    /`\{\$table\}`\.`status` = 'published'/.test(dc),
    'ownerScope lessons student filter changed');

  // Frontend My Courses keeps rendering the enrolled list; hidden courses
  // arrive with course === null and the screen already renders defensively.
  const myCourses = readCode('src/app/(app)/(student)/my-courses.tsx');
  check('My Courses tolerates hidden embeds (no crash on null course)',
    /sub\.course\?\.title/.test(myCourses),
    'my-courses renders course fields unguarded');

  // Offline downloads are NOT deleted by unpublish: entitlement keys on the
  // enrollment row (preserved), and this change touches no deletion path.
  const ent = readCode('src/lib/offlineEntitlement.ts');
  check('offline entitlement still keys on the enrollment row (downloads preserved)',
    /enrollmentRows/.test(ent),
    'offline entitlement model changed');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
