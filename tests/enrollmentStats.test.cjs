#!/usr/bin/env node
/**
 * Enrollment statistics — the counting rules, the Admin/Super Admin contract and
 * the two-metric UI switch.
 *
 * Run: node tests/enrollmentStats.test.cjs   (also part of `npm test`)
 *
 * WHY THIS SUITE EXISTS
 * "How many students?" has two correct answers and one wrong one:
 *
 *   • Unique Students   — distinct student ACCOUNTS (one student, five courses → 1)
 *   • Total Enrollments — student↔course enrolments (that student → 5)
 *   • WRONG: deduplicating students across courses when the admin asked for
 *     enrollments (five courses silently becoming one), or vice-versa.
 *
 * The backend aggregate is SQL, which cannot run here (no database is touched by
 * this project's test suite). This suite therefore pins the feature from three
 * directions:
 *
 *   1. EXECUTED RULES — src/lib/enrollmentStats.ts is compiled and called. The
 *      counting acceptance examples are evaluated by a reference model written
 *      directly from the documented rules, so the semantics are checked with
 *      real numbers, not prose.
 *   2. SQL CONTRACT — static assertions that each aggregate in
 *      EnrollmentStatsController derives from the same eligible pair set
 *      (`GROUP BY e.student_id, e.course_id`), applies the same status/role/
 *      trash/course filters, and cannot be inflated by a duplicate row or a
 *      second JOIN.
 *   3. AUTHORIZATION + WIRING — every route is admin/super_admin only, the
 *      controller performs no writes, and the screen renders both metrics
 *      through one selector with translated labels.
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
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}

/* ─────────────────────────── compile pure modules ──────────────────────── */

const SOURCES = [
  'src/lib/enrollmentStats.ts',
  'src/lib/i18n/resources.ts',
  'src/lib/i18n/detect.ts',
];

const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), 'enrollment-stats-'));
try {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...SOURCES.map((rel) => path.join(ROOT, rel)),
      '--outDir', BUILD,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
} catch (e) {
  console.error('  ✗ could not compile the enrollment statistics modules');
  console.error(String(e.stderr || e.stdout || e.message).slice(0, 4000));
  process.exit(1);
}

function findEmitted(fileName) {
  const stack = [BUILD];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === fileName) return full;
    }
  }
  throw new Error('tsc did not emit ' + fileName);
}

const stats = require(findEmitted('enrollmentStats.js'));
const i18n = require(findEmitted('detect.js'));

const {
  metricValue, sumMetric, reconciles, headlineCards, countingModeLabelKey,
  countingModeHintKey, nextSort, pageWindow, pageCaption, doctorsQuery, coursesQuery,
  clampPage, clampPerPage, getCountingMode, setCountingMode, resetCountingMode,
  courseStatusKey, doctorLabelKey, policyNoteKeys, rowKey,
  DEFAULT_COUNTING_MODE, COUNTING_MODES, MIN_PER_PAGE, MAX_PER_PAGE, DEFAULT_PER_PAGE,
} = stats;

/* ───────── 1. Reference model of the documented backend counting rules ──── */

/**
 * Mirrors EnrollmentStatsController's eligibility + aggregation rules:
 *   • status NULL or 'active'
 *   • student-role profiles only, not trashed
 *   • courses not permanently deleted; archived only when opted in
 *   • one row per (student, course) pair BEFORE any aggregation
 * Returns both metrics for the platform, each course and each doctor.
 */
function aggregate(rows, opts = {}) {
  const includeArchived = !!opts.includeArchived;
  const eligible = rows.filter((r) =>
    (r.status === null || r.status === undefined || r.status === 'active') &&
    r.role === 'student' &&
    r.trashed !== true &&
    r.courseDeleted !== true &&
    (includeArchived || r.courseArchived !== true));

  const pairs = new Map();
  for (const row of eligible) {
    pairs.set(`${row.student}\u0000${row.course}`, row);
  }
  const list = [...pairs.values()];

  const byCourse = new Map();
  const byDoctor = new Map();
  for (const row of list) {
    if (!byCourse.has(row.course)) byCourse.set(row.course, { course: row.course, doctor: row.doctor, rows: [] });
    byCourse.get(row.course).rows.push(row);
    if (!byDoctor.has(row.doctor)) byDoctor.set(row.doctor, { doctor: row.doctor, rows: [] });
    byDoctor.get(row.doctor).rows.push(row);
  }

  return {
    enrollments: list.length,
    uniqueStudents: new Set(list.map((r) => r.student)).size,
    courses: [...byCourse.values()].map((c) => ({
      course: c.course,
      doctor: c.doctor,
      enrollments: c.rows.length,
      uniqueStudents: new Set(c.rows.map((r) => r.student)).size,
    })),
    doctors: [...byDoctor.values()].map((d) => ({
      doctor: d.doctor,
      enrollments: d.rows.length,
      uniqueStudents: new Set(d.rows.map((r) => r.student)).size,
    })),
  };
}

const rowOf = (student, course, doctor, extra = {}) => ({
  student, course, doctor, status: 'active', role: 'student', trashed: false,
  courseArchived: false, courseDeleted: false, ...extra,
});

console.log('\ncounting rules (executed model)');

// 1. Student A in Course 1 + Course 2 → 2 enrollments, 1 unique student.
{
  const result = aggregate([rowOf('A', 'C1', 'X'), rowOf('A', 'C2', 'X')]);
  check('1. same student in two courses → 2 enrollments, 1 unique student',
    result.enrollments === 2 && result.uniqueStudents === 1);
}

// 2. A in 3 courses of the SAME doctor → 3 enrollments for that doctor.
{
  const result = aggregate([rowOf('A', 'C1', 'X'), rowOf('A', 'C2', 'X'), rowOf('A', 'C3', 'X')]);
  const doctor = result.doctors[0];
  check('2. A in 3 courses of one doctor → 3 enrollments for that doctor',
    doctor.enrollments === 3);
  check('2b. …but only 1 unique student for that doctor',
    doctor.uniqueStudents === 1);
}

// 3. A in courses of 2 doctors → contributes to EACH doctor's totals.
{
  const result = aggregate([rowOf('A', 'C1', 'X'), rowOf('A', 'C2', 'Y')]);
  const byDoctor = Object.fromEntries(result.doctors.map((d) => [d.doctor, d]));
  check('3. shared student counts in both doctors\' totals',
    byDoctor.X.enrollments === 1 && byDoctor.X.uniqueStudents === 1 &&
    byDoctor.Y.enrollments === 1 && byDoctor.Y.uniqueStudents === 1);
  check('3b. platform totals stay deduplicated for unique students',
    result.enrollments === 2 && result.uniqueStudents === 1);
}

// 4. Ten distinct students in one course → 10.
{
  const rows = Array.from({ length: 10 }, (_, i) => rowOf(`S${i}`, 'C1', 'X'));
  const result = aggregate(rows);
  check('4. ten distinct students in one course → 10 enrollments',
    result.enrollments === 10 && result.courses[0].enrollments === 10);
  check('4b. and 10 unique students', result.uniqueStudents === 10 && result.courses[0].uniqueStudents === 10);
}

// 5. Duplicate rows for the same (student, course) never inflate anything.
{
  const result = aggregate([
    rowOf('A', 'C1', 'X'), rowOf('A', 'C1', 'X'), rowOf('A', 'C1', 'X'),
    rowOf('A', 'C2', 'X'),
  ]);
  check('5. duplicate (student, course) rows collapse to one',
    result.enrollments === 2 && result.uniqueStudents === 1 &&
    result.courses.find((c) => c.course === 'C1').enrollments === 1);
  check('5b. doctor totals are not inflated by duplicates either',
    result.doctors[0].enrollments === 2);
}

// 6. Eligibility: suspended, trashed, non-student, deleted/archived course.
{
  const base = [rowOf('A', 'C1', 'X'), rowOf('B', 'C1', 'X')];
  const suspended = aggregate([...base, rowOf('C', 'C1', 'X', { status: 'suspended' })]);
  check('6. suspended enrollments are excluded',
    suspended.enrollments === 2 && suspended.uniqueStudents === 2);

  const trashed = aggregate([...base, rowOf('D', 'C1', 'X', { trashed: true })]);
  check('6b. trashed students are excluded',
    trashed.enrollments === 2 && trashed.uniqueStudents === 2);

  const doctor = aggregate([...base, rowOf('E', 'C1', 'X', { role: 'doctor' })]);
  const admin = aggregate([...base, rowOf('F', 'C1', 'X', { role: 'admin' })]);
  const superAdmin = aggregate([...base, rowOf('G', 'C1', 'X', { role: 'super_admin' })]);
  check('6c. doctor accounts are never counted as students',
    doctor.enrollments === 2 && doctor.uniqueStudents === 2);
  check('6d. admin accounts are never counted as students',
    admin.enrollments === 2 && admin.uniqueStudents === 2);
  check('6e. super_admin accounts are never counted as students',
    superAdmin.enrollments === 2 && superAdmin.uniqueStudents === 2);

  const archived = aggregate([...base, rowOf('H', 'C3', 'X', { courseArchived: true })]);
  check('6f. archived courses are excluded by default',
    archived.enrollments === 2 && !archived.courses.some((c) => c.course === 'C3'));
  const withArchived = aggregate([...base, rowOf('H', 'C3', 'X', { courseArchived: true })], { includeArchived: true });
  check('6g. …and included when explicitly requested',
    withArchived.enrollments === 3 && withArchived.courses.some((c) => c.course === 'C3'));

  const deleted = aggregate([...base, rowOf('I', 'C4', 'X', { courseDeleted: true })], { includeArchived: true });
  check('6h. permanently deleted courses are never counted',
    deleted.enrollments === 2 && !deleted.courses.some((c) => c.course === 'C4'));
}

// 7. The documented two-student / two-course example, end to end.
{
  const result = aggregate([rowOf('A', 'C1', 'X'), rowOf('A', 'C2', 'X'), rowOf('B', 'C1', 'X')]);
  const c1 = result.courses.find((c) => c.course === 'C1');
  const c2 = result.courses.find((c) => c.course === 'C2');
  check('7. platform: 3 enrollments / 2 unique students',
    result.enrollments === 3 && result.uniqueStudents === 2);
  check('7b. Course 1: 2 and 2', c1.enrollments === 2 && c1.uniqueStudents === 2);
  check('7c. Course 2: 1 and 1', c2.enrollments === 1 && c2.uniqueStudents === 1);
  check('7d. Doctor X (both courses): 3 enrollments / 2 unique students',
    result.doctors.length === 1 &&
    result.doctors[0].enrollments === 3 && result.doctors[0].uniqueStudents === 2);
  check('7e. empty dataset aggregates to honest zeros',
    aggregate([]).enrollments === 0 && aggregate([]).uniqueStudents === 0);
}

// 8. Reconciliation: Σ per-course enrollments == platform total.
{
  const result = aggregate([
    rowOf('A', 'C1', 'X'), rowOf('A', 'C2', 'X'), rowOf('B', 'C1', 'X'),
    rowOf('C', 'C3', 'Y'), rowOf('C', 'C4', 'Y'),
  ]);
  const courseSum = result.courses.reduce((sum, c) => sum + c.enrollments, 0);
  check('8. Σ course enrollments equals the platform total',
    courseSum === result.enrollments && reconciles(courseSum, result.enrollments));
  check('8b. a mismatch is reported, not rounded away',
    reconciles(courseSum, result.enrollments + 1) === false);
}

/* ───────────────────── 2. metric selection (both modes) ────────────────── */

console.log('\nmetric selection');

const sample = { unique_students: 2, enrollments: 7 };
check('9. unique mode reads unique_students', metricValue(sample, 'unique_students') === 2);
check('9b. enrollments mode reads enrollments (no dedupe)', metricValue(sample, 'enrollments') === 7);
check('9c. the two modes are never the same figure for a multi-course student',
  metricValue(sample, 'unique_students') !== metricValue(sample, 'enrollments'));
check('9d. missing values render 0, never NaN',
  metricValue({}, 'enrollments') === 0 && metricValue({ enrollments: null }, 'enrollments') === 0);
check('9e. negative/garbage values clamp to 0',
  metricValue({ enrollments: -3 }, 'enrollments') === 0 &&
  metricValue({ enrollments: Number.NaN }, 'enrollments') === 0);
check('9f. sumMetric sums the SELECTED mode only',
  sumMetric([{ unique_students: 2, enrollments: 5 }, { unique_students: 1, enrollments: 3 }], 'unique_students') === 3 &&
  sumMetric([{ unique_students: 2, enrollments: 5 }, { unique_students: 1, enrollments: 3 }], 'enrollments') === 8);

const cards = headlineCards({ unique_students: 12, enrollments: 40 }, 'unique_students');
check('10. headline cards show the selected metric first and the other beside it',
  cards.primary === 12 && cards.secondary === 40 && cards.secondaryMode === 'enrollments');
const cards2 = headlineCards({ unique_students: 12, enrollments: 40 }, 'enrollments');
check('10b. switching the mode swaps the cards (never mixes them)',
  cards2.primary === 40 && cards2.secondary === 12 && cards2.secondaryMode === 'unique_students');

/* ───────────────── 3. sort, paging, filters, query building ────────────── */

console.log('\nsorting, paging and filters');

check('11. a new count column starts descending',
  nextSort({ sort: 'name', order: 'asc' }, 'enrollments').order === 'desc');
check('11b. the same column flips direction',
  nextSort({ sort: 'enrollments', order: 'desc' }, 'enrollments').order === 'asc' &&
  nextSort({ sort: 'enrollments', order: 'asc' }, 'enrollments').order === 'desc');
check('11c. alphabetical columns start ascending',
  nextSort({ sort: 'enrollments', order: 'desc' }, 'name').order === 'asc' &&
  nextSort({ sort: 'enrollments', order: 'desc' }, 'title').order === 'asc');

check('12. page window keeps 1 and the last page reachable',
  JSON.stringify(pageWindow(1, 5)) === JSON.stringify([1, 2, 5]) &&
  JSON.stringify(pageWindow(3, 5)) === JSON.stringify([1, 2, 3, 4, 5]) &&
  JSON.stringify(pageWindow(5, 5)) === JSON.stringify([1, 4, 5]));
check('12b. page window survives a single page and garbage input',
  JSON.stringify(pageWindow(1, 1)) === JSON.stringify([1]) &&
  JSON.stringify(pageWindow(0, 0)) === JSON.stringify([1]));
check('12c. page caption never claims a page beyond the last',
  pageCaption(9, 3, 55) === '3 / 3 · 55' && pageCaption(1, 1, 0) === '1 / 1 · 0');

check('13. per_page is clamped to the server maximum', clampPerPage(5000) === MAX_PER_PAGE &&
  clampPerPage(1) === MIN_PER_PAGE && clampPerPage(undefined) === DEFAULT_PER_PAGE);
check('13b. page numbers are clamped to >= 1', clampPage(-4) === 1 && clampPage(2.7) === 2);

const dq = doctorsQuery({ page: 2, perPage: 50, includeArchived: true });
check('14. doctor query carries paging + archived flag and a sensible default sort',
  dq.page === 2 && dq.per_page === 50 && dq.include_archived === true &&
  dq.sort === 'unique_students' && dq.order === 'desc');

const cq = coursesQuery({ doctorId: 'doc-1', search: '  cardio ', sort: 'enrollments', order: 'asc' });
check('14b. course query forwards the doctor filter and the trimmed search',
  cq.doctor_id === 'doc-1' && cq.search === 'cardio' && cq.sort === 'enrollments' && cq.order === 'asc');
check('14c. an empty doctor filter is omitted (means "all doctors")',
  coursesQuery({ doctorId: '   ' }).doctor_id === undefined &&
  coursesQuery({}).doctor_id === undefined);
check('14d. an empty search is omitted (no LIKE %% scan)',
  doctorsQuery({ search: '   ' }).search === undefined);

/* ─────────────────────────── 4. mode persistence ───────────────────────── */

console.log('\ncounting mode state');

resetCountingMode();
check('15. the default mode is Unique Students', getCountingMode() === DEFAULT_COUNTING_MODE &&
  DEFAULT_COUNTING_MODE === 'unique_students');
check('15b. switching the mode is remembered across views',
  setCountingMode('enrollments') === 'enrollments' && getCountingMode() === 'enrollments');
check('15c. an unknown mode falls back to the default instead of corrupting state',
  setCountingMode('nonsense') === DEFAULT_COUNTING_MODE);
check('15d. exactly two modes are offered, both distinct',
  COUNTING_MODES.length === 2 && new Set(COUNTING_MODES).size === 2);

/* ─────────────────────── 5. labels, status, policy ─────────────────────── */

console.log('\nlabels and policy');

check('16. each mode has its own label key',
  countingModeLabelKey('unique_students') === 'enrollmentStats.mode.uniqueStudents' &&
  countingModeLabelKey('enrollments') === 'enrollmentStats.mode.actualEnrollments');
check('16b. each mode has its own explanation key',
  countingModeHintKey('unique_students') === 'enrollmentStats.mode.uniqueStudentsHint' &&
  countingModeHintKey('enrollments') === 'enrollmentStats.mode.actualEnrollmentsHint');
check('16c. an archived course is labelled archived even if status lags behind',
  courseStatusKey({ status: 'published', archived_at: '2026-01-01T00:00:00Z' }) === 'enrollmentStats.courseStatus.archived');
check('16d. published / draft are labelled from status',
  courseStatusKey({ status: 'published', archived_at: null }) === 'enrollmentStats.courseStatus.published' &&
  courseStatusKey({ status: 'draft', archived_at: null }) === 'enrollmentStats.courseStatus.draft');
check('16e. a course with no doctor is flagged as unassigned, not hidden',
  doctorLabelKey({ doctor_id: null, doctor_name: null }) === 'enrollmentStats.unassignedDoctor' &&
  doctorLabelKey({ doctor_id: 'x', doctor_name: 'Dr X' }) === null);
check('16f. policy note reflects the archived toggle',
  policyNoteKeys({ include_archived: false }).includes('enrollmentStats.policy.excludesArchived') &&
  policyNoteKeys({ include_archived: true }).includes('enrollmentStats.policy.includesArchived'));
check('16g. policy note states students-only + duplicates collapsed',
  policyNoteKeys({ student_role_only: true, counts_are_distinct: true })
    .includes('enrollmentStats.policy.studentsOnly') &&
  policyNoteKeys({ student_role_only: true, counts_are_distinct: true })
    .includes('enrollmentStats.policy.duplicatesCollapsed'));
check('16h. no policy is echoed → no note is invented', policyNoteKeys(null).length === 0);
check('16i. row keys prefer the course id, else the doctor id',
  rowKey({ course_id: 'c1' }) === 'c1' && rowKey({ doctor_id: 'd1' }) === 'd1');

/* ─────────────────────────── 6. localization ───────────────────────────── */

console.log('\nlabels in both languages');

const en = i18n.translate.bind(null, 'en');
const ar = i18n.translate.bind(null, 'ar');
const enDict = require(findEmitted('resources.js')).en;
const arDict = require(findEmitted('resources.js')).ar;

check('17. English metric labels read as two different metrics',
  en('enrollmentStats.mode.uniqueStudents') === 'Unique Students' &&
  en('enrollmentStats.mode.actualEnrollments') === 'Total Enrollments');
check('17b. Arabic metric labels are natural MSA and distinct',
  ar('enrollmentStats.mode.uniqueStudents') === 'الطلاب بالحسابات' &&
  ar('enrollmentStats.mode.actualEnrollments') === 'إجمالي التسجيلات الفعلية');
check('17c. Arabic labels are actually Arabic (no English fallback leaking)',
  /[\u0600-\u06FF]/.test(ar('enrollmentStats.title')) &&
  !/[A-Za-z]{3,}/.test(ar('enrollmentStats.mode.uniqueStudents')));
check('17d. both reconciliation messages interpolate in both languages',
  en('enrollmentStats.reconcile.ok', { sum: 7, total: 7 }).includes('7') &&
  ar('enrollmentStats.reconcile.mismatch', { sum: 6, total: 7 }).includes('6') &&
  ar('enrollmentStats.reconcile.mismatch', { sum: 6, total: 7 }).includes('7'));
check('17e. the truncated detail caption interpolates', 
  en('enrollmentStats.detail.partial', { shown: 3, total: 9 }).includes('3') &&
  ar('enrollmentStats.detail.partial', { shown: 3, total: 9 }).includes('9'));

// Every key the module or the screen references must exist in BOTH dictionaries.
const screenSrc = read('src/app/(app)/(hubs)/enrollment-stats.tsx');
const moduleSrc = read('src/lib/enrollmentStats.ts');
const referenced = new Set(
  [...(screenSrc + moduleSrc).matchAll(/'((?:enrollmentStats|nav\.enrollmentStats)[A-Za-z0-9_.]*)'/g)].map((m) => m[1]),
);
const missingEn = [...referenced].filter((k) => !(k in enDict));
const missingAr = [...referenced].filter((k) => !(k in arDict));
check(`18. all ${referenced.size} referenced keys exist in English`, referenced.size > 20 && missingEn.length === 0);
check('18b. …and in Arabic', missingAr.length === 0);
if (missingEn.length) console.error('        missing (en): ' + missingEn.join(', '));
if (missingAr.length) console.error('        missing (ar): ' + missingAr.join(', '));
check('18c. every Arabic enrollment-stats string is non-empty and non-English',
  Object.entries(arDict)
    .filter(([k]) => k.startsWith('enrollmentStats.'))
    .every(([, v]) => typeof v === 'string' && v.trim().length > 0 && /[\u0600-\u06FF]/.test(v)));

/* ───────────────── 7. backend SQL + authorization contract ──────────────── */

console.log('\nbackend contract');

const php = read('backend/src/Controllers/EnrollmentStatsController.php');
const phpCode = php.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const routes = read('backend/routes/api.php');

check('19. aggregates collapse duplicate (student, course) rows before counting',
  /GROUP BY e\.student_id, e\.course_id/.test(php) &&
  /COUNT\(\*\) AS enrollments/.test(php));
check('19b. unique students is a DISTINCT count over the same pair set',
  /COUNT\(DISTINCT pairs\.student_id\) AS unique_students/.test(php));
check('19c. per-course and per-doctor sets both come from eligiblePairsSql()',
  /function enrollmentsPerCourseSql[\s\S]{0,1600}eligiblePairsSql\(/.test(php) &&
  /function enrollmentsPerDoctorSql[\s\S]{0,1600}eligiblePairsSql\(/.test(php));
check('19d. the platform total uses the SAME pair set as the course rows (reconcilable)',
  /function summary[\s\S]{0,600}eligiblePairsSql/.test(php));
check('19e. only active (or null) enrollments count',
  /\{\$alias\}\.status IS NULL OR \{\$alias\}\.status = 'active'/.test(php));
check('19f. student-role profiles only',
  /s\.role = 'student'/.test(php));
check('19g. trashed students excluded', /s\.trashed_at IS NULL/.test(php));
check('19h. permanently deleted courses never count', /permanently_deleted = 0/.test(php));
check('19i. archived courses are excluded by default and opt-in', /archived_at IS NULL/.test(php) &&
  /if \(!\$includeArchived\)/.test(php));
check('20. the controller performs no writes (read-only endpoint)',
  !/\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/i.test(phpCode));
check('20b. per_page is clamped server-side', /MAX_PER_PAGE = 100/.test(php) &&
  /if \(\$perPage > self::MAX_PER_PAGE\)/.test(php));
check('20c. LIMIT/OFFSET use the validated ints, never raw input',
  /LIMIT \{\$perPage\} OFFSET \{\$offset\}/.test(php) &&
  !/LIMIT \{\$q\[/.test(php));
check('20d. sort columns come from a whitelist', /DOCTOR_SORTS/.test(php) && /COURSE_SORTS/.test(php) &&
  /\$allowed\[\$requested\] \?\? \$allowed\[\$default\]/.test(php));
check('20e. an unknown doctor/course is a 404, not an empty 200',
  /Doctor not found/.test(php) && /Course not found/.test(php));
check('21. all five routes require admin or super_admin',
  (routes.match(/\/analytics\/enrollment-stats[^\n]*'role' => \['admin', 'super_admin'\]/g) ?? []).length === 5);
check('21b. every enrollment route is authenticated', !/enrollment-stats[^\n]*\$auth,/.test(routes) &&
  (routes.match(/\/analytics\/enrollment-stats[^\n]*\$auth \+/g) ?? []).length === 5);
check('21c. no route exposes enrollment stats to doctors/students',
  !/enrollment-stats[^\n]*'role' => \['doctor'/.test(routes) &&
  !/enrollment-stats[^\n]*'role' => \['student'/.test(routes));

/* ──────────────────── 8. client wiring + screen contract ───────────────── */

console.log('\nclient wiring');

const phpClient = read('src/client/php.ts');
const api = read('src/lib/api.ts');

check('22. the RPC map routes each call to its endpoint',
  /'get_enrollment_stats'\s*:\s*'\/analytics\/enrollment-stats'/.test(phpClient) &&
  /'get_enrollment_stats_doctors'\s*:\s*'\/analytics\/enrollment-stats\/doctors'/.test(phpClient) &&
  /'get_enrollment_stats_courses'\s*:\s*'\/analytics\/enrollment-stats\/courses'/.test(phpClient) &&
  /'get_enrollment_doctor_stats'\s*:\s*'\/analytics\/enrollment-stats\/doctors\/\{id\}'/.test(phpClient) &&
  /'get_enrollment_course_stats'\s*:\s*'\/analytics\/enrollment-stats\/courses\/\{id\}'/.test(phpClient));
check('22b. they are GET RPCs (query params, not POST bodies)',
  /GET_RPCS[\s\S]{0,900}'get_enrollment_stats'/.test(phpClient));
check('22c. path parameters are bound from doctor_id / course_id',
  /'get_enrollment_doctor_stats'\s*:\s*\{\s*id:\s*'doctor_id'/.test(phpClient) &&
  /'get_enrollment_course_stats'\s*:\s*\{\s*id:\s*'course_id'/.test(phpClient));
check('23. the client exposes both metrics on row and totals types',
  /interface EnrollmentStatsTotals[\s\S]{0,400}unique_students: number;[\s\S]{0,200}enrollments: number;/.test(api) &&
  /interface EnrollmentCourseStatRow[\s\S]{0,900}unique_students: number;/.test(api));
check('23b. the five client functions exist and throw on error',
  ['getEnrollmentStats', 'getEnrollmentStatsDoctors', 'getEnrollmentStatsCourses',
    'getEnrollmentDoctorStats', 'getEnrollmentCourseStats']
    .every((fn) => new RegExp(`export async function ${fn}\\(`).test(api)));

check('24. the screen renders both metrics for every row',
  /metricValue\(row, 'unique_students'\)/.test(screenSrc) &&
  /metricValue\(row, 'enrollments'\)/.test(screenSrc));
check('24b. the mode selector drives the shared state',
  /onPress=\{\(\) => chooseMode\(m\)\}/.test(screenSrc) &&
  /setCountingMode\(next\)/.test(screenSrc) &&
  /getCountingMode\(\)/.test(screenSrc));
check('24c. the mode is restored from the shared state, not re-initialised to a constant',
  /useState<EnrollmentCountingMode>\(getCountingMode\(\)\)/.test(screenSrc));
check('24d. loading, empty and error states all exist',
  /ActivityIndicator/.test(screenSrc) && /enrollmentStats\.empty/.test(screenSrc) &&
  /enrollmentStats\.retry/.test(screenSrc));
check('24e. search is debounced (no request per keystroke)',
  /setTimeout\(\(\) => \{[\s\S]{0,220}\}, 350\)/.test(screenSrc));
check('24f. a late response cannot overwrite a newer one',
  /requestId\.current/.test(screenSrc) && /id !== requestId\.current\) return/.test(screenSrc));
check('24g. filters + sort + pagination reset/forward correctly',
  /setPage\(1\)/.test(screenSrc) && /nextSort\(prev, column\)/.test(screenSrc) &&
  /pageWindow\(meta\.page, meta\.total_pages\)/.test(screenSrc));
check('24h. no hardcoded English metric labels in the screen',
  !/'(Unique Students|Total Enrollments|No enrollments match|Include archived)'/.test(screenSrc));
check('24i. all visible copy goes through the translation function',
  /t\('enrollmentStats\.title'\)/.test(screenSrc) && /t\(countingModeLabelKey\(mode\)\)/.test(screenSrc));
check('25. the SA wrapper reuses the shared screen with its own back target',
  /EnrollmentStatsScreen backTo="\/sa-analytics"/.test(read('src/app/(app)/(hubs)/sa-enrollment-stats.tsx')));
check('25b. the admin dashboard links to it',
  /path: '\/\(app\)\/enrollment-stats'/.test(read('src/app/(app)/(admin)/admin-overview.tsx')));
check('25c. the Super Admin analytics hub links to it',
  /'\/sa-enrollment-stats'/.test(read('src/app/(app)/(superadmin)/sa-analytics.tsx')));
check('25d. the admin drawer links to it with a translated label',
  /t\('nav\.enrollmentStats'\)[\s\S]{0,60}\/enrollment-stats/.test(read('src/components/DrawerNav.tsx')));

/* ─────────────────────────────── summary ──────────────────────────────── */

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nEnrollment statistics suite FAILED.');
  process.exit(1);
}
