#!/usr/bin/env node
/**
 * Doctor flow fixes — regression suite.
 *
 * Covers four independent defects reported together:
 *   1. Doctor → Students: "Create Student" (and the icon-only bulk-import button
 *      beside it) opened Expo Router's "Unmatched Route" screen.
 *   2. Course Builder / editor rendered English labels in Arabic mode.
 *   3. Profile ▸ Settings rows rendered the icon touching the Arabic label.
 *   4. Course-scoped bulk student actions did not exist (and the backend had no
 *      course-scope check).
 *
 * Run: node tests/doctorCourseBulkAndSettingsFixes.test.cjs
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

/* ── compile the dictionary (pure modules only) ──────────────────────────── */
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-fixes-'));
execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(ROOT, 'src/lib/i18n/resources.ts'),
    path.join(ROOT, 'src/lib/i18n/detect.ts'),
    '--outDir', build,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--skipLibCheck',
    '--noEmitOnError', 'false',
  ],
  { stdio: 'pipe' },
);
const { en, ar } = require(path.join(build, 'resources.js'));

/** Strip // and /* *\/ comments so prose in docs/comments never trips a
 * "hardcoded literal" assertion. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const builderSrc = read('src/app/(app)/course-builder/[id].tsx');
const builderCode = stripComments(builderSrc);
const studentsSrc = read('src/app/(app)/(doctor)/students.tsx');
const createStudentSrc = read('src/app/(app)/(hubs)/create-student.tsx');
const drawerSrc = read('src/components/DrawerNav.tsx');
const doctorProfileSrc = read('src/app/(app)/(doctor)/dr-profile.tsx');
const studentProfileSrc = read('src/app/(app)/(student)/profile.tsx');
const settingsRowSrc = read('src/components/SettingsRow.tsx');
const apiSrc = read('src/lib/api.ts');
const bulkBackendSrc = read('backend/src/Controllers/StudentBulkController.php');

/* ── 1. routing ──────────────────────────────────────────────────────────── */
console.log('\nCreate Student routing');
check('students screen navigates to the group-free /create-student URL',
  studentsSrc.includes("router.push('/create-student'"));
check('no navigation to a group-qualified create-student href',
  !/push\('\/\(app\)\/\(doctor\)\/create-student'/.test(studentsSrc));
check('no remaining /(app)/(doctor)/bulk-import-students href in the students screen',
  !studentsSrc.includes('(app)/(doctor)/bulk-import-students'));
check('the unlabelled bulk-import icon button was removed from the action row',
  !/bulkImportA11y/.test(studentsSrc));
check('Create Student keeps its localized label',
  /t\('drStudents\.createStudent'\)/.test(studentsSrc));
check('Arabic Create Student wording is exactly «إنشاء طالب»',
  ar['drStudents.createStudent'] === 'إنشاء طالب');
check('English Create Student wording is exactly "Create Student"',
  en['drStudents.createStudent'] === 'Create Student');
// Doctor navigation no longer offers bulk import (product decision), while the
// capability itself stays available: the route/service exist and the ADMIN
// drawer keeps its unrelated /bulk-import entry.
const doctorDrawerSrc = drawerSrc.slice(
  drawerSrc.indexOf("if (role === 'doctor')"),
  drawerSrc.indexOf("if (role === 'admin')"),
);
check('the doctor drawer no longer lists bulk import',
  !doctorDrawerSrc.includes("'/bulk-import-students'")
  && !doctorDrawerSrc.includes('bulkImport'));
check('the doctor drawer keeps its remaining destinations in order (no empty gap left behind)',
  ['/dr-overview', '/courses', '/video-library', '/students', '/credits', '/notifications', '/dr-profile']
    .every((p) => doctorDrawerSrc.includes(`path: '${p}'`)));
check('Create Student is still offered where it belongs (Students screen)',
  /t\('drStudents\.createStudent'\)/.test(studentsSrc) && createStudentSrc.length > 0);
check('bulk import stays reachable for the admin role',
  drawerSrc.includes("path: '/bulk-import'") );
check('credentials screen route is group-free',
  createStudentSrc.includes("pathname: '/student-credentials'"));
check('no remaining /(app)/(doctor)/student-credentials href',
  !createStudentSrc.includes('(app)/(doctor)/student-credentials'));
check('the target screens actually exist as routes',
  fs.existsSync(path.join(ROOT, 'src/app/(app)/(hubs)/create-student.tsx'))
  && fs.existsSync(path.join(ROOT, 'src/app/(app)/(hubs)/student-credentials.tsx')));

/* ── 2. course-builder localization ──────────────────────────────────────── */
console.log('\nCourse builder localization');
check('course builder imports useTranslation', /useTranslation/.test(builderSrc));
check('course builder resolves t() at render', /const \{ t \} = useTranslation\(\)/.test(builderSrc));

const BANNED_LITERALS = [
  'Course Status', 'Course Title *', 'Short Description *', 'Full Description *',
  'Detailed course description', 'Learning & Access', 'Publish Checklist',
  'Start New Course', 'Save Settings', 'No sections yet', 'Upload Cover',
  'Replace Cover', 'Remove Cover', 'Bulk Import', 'Move Up', 'Move Down',
  'Save as Template', 'Duplicate Course', 'Archive Course', 'More Actions',
  'Select university', 'Select faculty', 'Contact Information',
  'Please add at least one contact method.',
];
for (const literal of BANNED_LITERALS) {
  check(`no hardcoded "${literal}" left in the builder`,
    !builderCode.includes(`"${literal}"`) && !builderCode.includes(`>${literal}<`));
}
check('status pills render localized status labels',
  /t\('courseStatus\.published'\)/.test(builderSrc) && /t\('courseStatus\.draft'\)/.test(builderSrc));
check('tab labels are localized', /cb\.tab\.info/.test(builderSrc) && /cb\.tab\.structure/.test(builderSrc) && /cb\.tab\.settings/.test(builderSrc));
check('lesson type/status helpers take the translator',
  /function lessonTypeLabel\(videoType: string \| undefined, t: Translate\)/.test(builderSrc)
  && /function lessonStatusLabel\(status: string \| undefined, t: Translate\)/.test(builderSrc));
check('back/chevron icons flip for RTL', /const BackIcon = isRTL \? ArrowRight : ArrowLeft/.test(builderSrc)
  && /const ChevronForward = isRTL \? ChevronLeft : ChevronRight/.test(builderSrc));
check('EGP label uses a logical margin (marginEnd), not marginRight',
  /marginEnd: 8/.test(builderSrc) && !/color: c\.primary, marginRight: 8/.test(builderSrc));

const referencedKeys = [...new Set(
  [...builderSrc.matchAll(/t\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1])
    .concat([...builderSrc.matchAll(/t\('([a-zA-Z0-9_.]+)',\s*\{/g)].map((m) => m[1])),
)];
const missingEn = referencedKeys.filter((k) => !(k in en));
const missingAr = referencedKeys.filter((k) => !(k in ar));
check('every key referenced by the builder exists in English', missingEn.length === 0, missingEn.join(', '));
check('every key referenced by the builder exists in Arabic', missingAr.length === 0, missingAr.join(', '));

const cbKeys = Object.keys(en).filter((k) => k.startsWith('cb.'));
check('course-builder namespace is non-trivial (≥ 100 keys)', cbKeys.length >= 100, String(cbKeys.length));
check('every cb.* key has an Arabic counterpart', cbKeys.every((k) => k in ar));
check('no empty cb.* translations',
  cbKeys.every((k) => String(en[k]).trim().length > 0 && String(ar[k]).trim().length > 0));
check('placeholders match between languages for every cb.* key', (() => {
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  return cbKeys.every((k) => ph(en[k]) === ph(ar[k]));
})());
check('Arabic course status terms are contextual (مسودة / منشور)',
  ar['courseStatus.draft'] === 'مسودة' && ar['courseStatus.published'] === 'منشور');
check('Arabic builder tab labels are Arabic', /[\u0600-\u06FF]/.test(ar['cb.tab.info'])
  && /[\u0600-\u06FF]/.test(ar['cb.tab.structure']) && /[\u0600-\u06FF]/.test(ar['cb.tab.settings']));

/* ── 3. settings-row spacing ─────────────────────────────────────────────── */
console.log('\nProfile / settings row spacing');
check('shared SettingsRow component exists', settingsRowSrc.length > 0);
check('SettingsRow spaces icon and label with gap, not a physical margin',
  /gap: 12/.test(settingsRowSrc) && !/margin(Left|Right):/.test(stripComments(settingsRowSrc)));
check('SettingsRow keeps a 48dp touch target', /minHeight: 48/.test(settingsRowSrc));
check('SettingsRow keeps the icon box from shrinking', /flexShrink: 0/.test(settingsRowSrc));
check('SettingsRow caps the label at two lines', /numberOfLines=\{2\}/.test(settingsRowSrc));
check('SettingsRow flips its chevron for RTL',
  /I18nManager\.isRTL/.test(settingsRowSrc) && /\? ChevronLeft : ChevronRight/.test(settingsRowSrc));
check('doctor profile uses the shared row for Change Password / Sign Out and info links',
  (doctorProfileSrc.match(/<SettingsRow/g) || []).length >= 2
  && /<item\.icon size=\{18\}/.test(doctorProfileSrc)
  && /label=\{item\.label\}/.test(doctorProfileSrc));
check('student profile uses the shared row',
  (studentProfileSrc.match(/<SettingsRow/g) || []).length >= 2
  && /label=\{t\(item\.labelKey\)\}/.test(studentProfileSrc));
check('no physical marginLeft text gap left in the doctor settings rows',
  !/fontWeight: '600', color: c\.text, marginLeft: 10/.test(doctorProfileSrc)
  && !/fontWeight: '600', color: c\.text, marginLeft: 10/.test(studentProfileSrc));
check('InfoRow uses gap and a direction-aware alignment in both profiles',
  /gap: 10/.test(doctorProfileSrc) && /gap: 10/.test(studentProfileSrc)
  && /I18nManager\.isRTL \? 'left' : 'right'/.test(doctorProfileSrc)
  && /I18nManager\.isRTL \? 'left' : 'right'/.test(studentProfileSrc));

/* ── 4. course-scoped bulk actions ───────────────────────────────────────── */
console.log('\nCourse-scoped bulk student actions');
check('students screen has a per-course select-all action', /selectCourseGroup/.test(studentsSrc));
check('per-course select-all is scoped to that course’s rows', /setSelected\(new Set\(items\.map\(e => e\.id\)\)\)/.test(studentsSrc));
check('selection remembers its course scope', /selectionCourse/.test(studentsSrc));
check('switching tabs clears a stale selection', /if \(selectMode\) exitSelectMode\(\)/.test(studentsSrc));
check('switching course clears a stale selection',
  /selectionCourse\.id !== course\.id\) exitSelectMode\(\)/.test(studentsSrc));
check('selection sends the course scope to the backend', /courseId: selectionCourse\?\.id/.test(studentsSrc));
check('selection bar states the scope explicitly', /bulk\.courseScopeLabel/.test(studentsSrc));
check('API forwards course_id', /course_id: params\.courseId/.test(apiSrc));
check('backend accepts and validates course_id', /course_id/.test(bulkBackendSrc)
  && /course_id is not a valid identifier/.test(bulkBackendSrc));
check('backend rejects ids outside the declared course',
  /not_in_course/.test(bulkBackendSrc));
check('backend keeps ownership enforcement (server-side truth)',
  /not_authorized/.test(bulkBackendSrc) && /doctor_id/.test(bulkBackendSrc));
check('backend dedupes ids before executing', /array_unique/.test(bulkBackendSrc));
check('backend audits the course scope', /'course_id' => \$courseId/.test(bulkBackendSrc));
check('empty selection cannot fire a bulk request',
  /if \(!action \|\| bulkExecuting \|\| selected\.size === 0\) return;/.test(studentsSrc));
check('duplicate requests are blocked while a batch is running', /bulkExecuting \|\| selected\.size === 0/.test(studentsSrc));
check('the confirmation names the course and the count',
  /bulkConfirm !== null && \(/.test(studentsSrc)
  && studentsSrc.includes("t('bulk.courseScopeLabel', { course: selectionCourse.title })")
  && /drStudents\.bulkRemovePrompt/.test(studentsSrc));
check('bulk result renders the out-of-course failure reason', /drStudents\.notInCourse/.test(studentsSrc));
check('Arabic scope labels exist', ['bulk.selectAllInCourse', 'bulk.courseScopeLabel', 'bulk.scopeAll', 'bulk.selectedInCourse', 'bulk.selectedInCourse', 'drStudents.notInCourse']
  .every((k) => k in ar && k in en));

/* ── 5. proposal isolation ───────────────────────────────────────────────── */
console.log('\nApproved design shipped, preview retired');
// The design was approved and promoted into the production screen. The temporary
// preview route and its preview-only dictionary keys are gone — a dev route that
// still shipped would be a second, drifting copy of the card.
check('temporary design-preview route is removed',
  !fs.existsSync(path.join(ROOT, 'src/app/(app)/(hubs)/course-card-preview.tsx')));
check('no preview-only strings remain in either dictionary',
  !Object.keys(en).some((k) => k.startsWith('proposal.')) &&
  !Object.keys(ar).some((k) => k.startsWith('proposal.')));
const coursesSrc = read('src/app/(app)/(doctor)/courses.tsx');
check('production course list renders the approved compact card',
  /filtered\.map\(course => \(/.test(coursesSrc) && /function DoctorCourseCard\(/.test(coursesSrc));
check('production card keeps every course action it had',
  ['drCourses.edit', 'drCourses.previewAsStudent', 'drCourses.delete']
    .every((k) => coursesSrc.includes(k)));
check('production card covers every status state',
  ['published:', 'draft:', 'hidden:', 'archived:'].every((s) => coursesSrc.includes(s)) &&
  /filterCoursesByStatus/.test(coursesSrc));
check('production card uses the app i18n layer', /useTranslation/.test(coursesSrc));
check('production card supports narrow and wide layouts',
  /wide=\{screenW >= 700\}/.test(coursesSrc) && /flexWrap/.test(coursesSrc));

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
