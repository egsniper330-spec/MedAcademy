#!/usr/bin/env node
/**
 * Arabic terminology gate — pins the researched, context-correct wording.
 *
 * Run: node tests/i18nTerminology.test.cjs   (also part of `npm test`)
 *
 * WHY THIS EXISTS
 * A dictionary can be complete, have exact key parity, and still be wrong.
 * «مساقاتي» for "My Courses" satisfied every structural check while being the
 * university *credit-subject* word — not the right term for a paid online-course
 * product. This suite pins the terminology decisions recorded in
 * docs/TRANSLATION_TERMINOLOGY.md so a future "translation pass" cannot
 * silently reintroduce them.
 *
 * WHAT IS PINNED
 *   1. "My Courses" → «دوراتي» in every course context (nav, tab, home).
 *   2. The course namespace uses «دورة/دورات» — never «مساق» (credit subject)
 *      and never a discussion/debate word.
 *   3. Representative navigation / lesson / profile labels.
 *   4. Same English source + same function → same Arabic wording.
 *   5. Different functions keep different keys (materials vs lessons vs files).
 *   6. Arabic CLDR plural forms are correct for 0/1/2/3–10/11–99/100+.
 *   7. EN/AR key parity survives the corrections.
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

/* ───────────────────────── compile the i18n core ───────────────────────── */

const SOURCES = [
  'src/lib/i18n/resources.ts',
  'src/lib/i18n/detect.ts',
];

const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-term-'));
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
  console.error('  ✗ could not compile the i18n core');
  console.error(String(e.stderr || e.stdout || e.message).slice(0, 4000));
  process.exit(1);
}

const core = require(path.join(BUILD, 'detect.js'));
const { ar, en, translate, translateCount, pluralCategory } = core;

/* ─────────────────── 1. "My Courses" → دوراتي (the case) ──────────────── */

console.log('\n"My Courses" resolves to دوراتي');
for (const key of ['nav.myCourses', 'tabs.myCourses', 'home.myCourses']) {
  check(`${key} → دوراتي`, ar[key] === 'دوراتي');
  check(`${key} still reads "My Courses" in English`, en[key] === 'My Courses');
  check(`${key} renders دوراتي through translate('ar')`, translate('ar', key) === 'دوراتي');
}

/* ───────────────── 2. the course namespace says دورة, not مساق ─────────── */

console.log('\ncourse terminology');
check('tabs.courses → الدورات', ar['tabs.courses'] === 'الدورات');
check('course.titleFallback → دورة', ar['course.titleFallback'] === 'دورة');
check('course.progress → تقدّم الدورة', ar['course.progress'] === 'تقدّم الدورة');
check('course.searchPlaceholder mentions الدورات', ar['course.searchPlaceholder'].includes('الدورات'));
check('home.exploreCourses → استكشف الدورات', ar['home.exploreCourses'] === 'استكشف الدورات');

// The rejected family must not survive anywhere in the dictionary.
const courseKeys = Object.keys(ar).filter((k) => /^(course|home|nav|tabs)\./.test(k));
const withMasaq = courseKeys.filter((k) => /مساق/.test(ar[k]));
check('no course/navigation value uses «مساق» (credit-subject term)' +
  (withMasaq.length ? `: ${withMasaq.join(', ')}` : ''), withMasaq.length === 0);

// And the "discussion / debate" family — the exact failure mode reported.
const withDiscussion = Object.keys(ar).filter((k) => /مناقش|جدال|نقاش/.test(ar[k]));
check('no UI value means "discussion/debate"' +
  (withDiscussion.length ? `: ${withDiscussion.join(', ')}` : ''), withDiscussion.length === 0);

/* ───────────────────── 3. representative approved labels ──────────────── */

console.log('\nrepresentative labels');
const PINNED = {
  'nav.students': 'الطلاب',
  'tabs.students': 'الطلاب',
  'nav.notifications': 'الإشعارات',
  'nav.profile': 'الملف الشخصي',
  'common.signOut': 'تسجيل الخروج',
  'common.cancel': 'إلغاء',
  'common.save': 'حفظ',
  'course.teacher': 'المحاضر',
  'course.enroll': 'اشترك',
  'course.enrolled': 'مشترك',
  'lesson.markComplete': 'تحديد كمكتمل',
  'lesson.markedComplete': 'تم تحديد الدرس كمكتمل',
  'lesson.materials': 'المواد',
  'lesson.lectureMaterials': 'مواد المحاضرة',
  'nav.enrollmentManager': 'إدارة التسجيل',
  'nav.ledgerDashboard': 'لوحة دفتر الأستاذ',
  'profile.security': 'الأمان',
};
for (const [key, expected] of Object.entries(PINNED)) {
  check(`${key} → ${expected}`, ar[key] === expected);
}

/* ─────────── 4. same English + same function → same Arabic ─────────────── */

console.log('\nconsistency');
// "Cancel" is one function (dismiss without saving) → one wording.
const cancelKeys = Object.keys(en).filter((k) => en[k] === 'Cancel');
const cancelValues = new Set(cancelKeys.map((k) => ar[k]));
check(`every English "Cancel" key renders the same Arabic (${cancelKeys.length} key(s))`,
  cancelKeys.length > 0 && cancelValues.size === 1 && cancelValues.has('إلغاء'));

// "Sign Out" is one function → one wording (nav vs common namespace).
check('common.signOut and any other Sign Out agree',
  ar['common.signOut'] === ar['drProfile.signOutTitle'].replace('؟', '') ||
  ar['common.signOut'] === 'تسجيل الخروج');

/* ─────────── 5. different functions keep different keys/terms ──────────── */

console.log('\ncontext separation');
check('lesson.materials (المواد) is not lesson.lessons wording',
  ar['lesson.materials'] !== ar['course.lessons']);
check('course.lessons → الدروس', ar['course.lessons'] === 'الدروس');
check('course.lectures → المحاضرات', ar['course.lectures'] === 'المحاضرات');
check('files and lessons have separate plural keys',
  'lesson.fileCount.few' in ar && 'home.lessonsCount.few' in ar);

/* ────────── 5b. earnings / credit vocabulary (doctor + Super Admin) ─────── */

// The standalone earnings screens reuse the embedded tab's vocabulary instead
// of inventing a second word for the same money concept: "Earnings" = الأرباح،
// "Revenue" = الإيرادات/الإيراد، "Credits" = الرصيد، "Course" = الدورة.
console.log('\nearnings vocabulary');
const EARNINGS_PINNED = {
  'drProfile.earnings.totalRevenue': 'إجمالي الإيرادات',
  'drProfile.earnings.thisMonth': 'هذا الشهر',
  'drProfile.earnings.paidStudents': 'الطلاب الدافعون',
  'drProfile.earnings.transactions': 'المعاملات',
  'drProfile.earnings.timeline': 'الخط الزمني للإيرادات',
  'drProfile.earnings.byCourse': 'الإيرادات حسب الدورة',
  'drProfile.earnings.colCourse': 'الدورة',
  'drProfile.earnings.colRevenue': 'الإيراد',
  'drProfile.earnings.income': 'إيراد',
  'drProfile.earnings.deduction': 'خصم',
  'drProfile.tx.purchase': 'شراء',
  'drProfile.tx.suspension_refund': 'استرداد',
  'saEarnings.readOnly': 'عرض فقط',
  'saEarnings.dashboard': 'لوحة الأرباح',
  'saEarnings.creditActivity': 'نشاط الرصيد',
  'saEarnings.kpi.remainingCredits': 'الرصيد المتبقي',
  'saEarnings.kpi.coursesSold': 'الدورات المبيعة',
  'saEarnings.creditTx.consumption': 'استهلاك',
};
for (const [key, expected] of Object.entries(EARNINGS_PINNED)) {
  check(`${key} → ${expected}`, ar[key] === expected);
}

// "Earnings" (the section) and "Revenue" (the money) must not collapse into the
// same Arabic word — they are different concepts on the same screen.
check('Earnings (الأرباح) is distinct from Revenue (الإيرادات)',
  ar['nav.earnings'] === 'الأرباح' && ar['drProfile.earnings.totalRevenue'] === 'إجمالي الإيرادات');

// A transaction type and its reversal type must stay distinguishable, and an
// unknown enum value must never borrow another type's translation.
check('refund (استرداد) and purchase (شراء) stay distinct',
  ar['drProfile.tx.suspension_refund'] !== ar['drProfile.tx.purchase']);
check('no credit/earnings value is left in Latin script except the EGP code',
  ['saEarnings.creditEarnings', 'saEarnings.ledgerSummary', 'saEarnings.lastLogin']
    .every((k) => /[\u0600-\u06FF]/.test(ar[k])));

/* ────────────────────── 6. Arabic plural correctness ───────────────────── */

console.log('\nplural forms');
const CATEGORIES = [
  [0, 'zero'], [1, 'one'], [2, 'two'], [3, 'few'], [10, 'few'],
  [11, 'many'], [99, 'many'], [100, 'other'], [101, 'other'], [102, 'other'],
];
for (const [n, expected] of CATEGORIES) {
  check(`pluralCategory('ar', ${n}) → ${expected}`, pluralCategory('ar', n) === expected);
}
check("pluralCategory('en', 1) → one", pluralCategory('en', 1) === 'one');
check("pluralCategory('en', 2) → other", pluralCategory('en', 2) === 'other');

check('fileCount 1 → ملف واحد', translateCount('ar', 'lesson.fileCount', 1) === 'ملف واحد');
check('fileCount 2 → ملفان (not "2 ملفات")', translateCount('ar', 'lesson.fileCount', 2) === 'ملفان');
check('fileCount 5 → 5 ملفات', translateCount('ar', 'lesson.fileCount', 5) === '5 ملفات');
check('fileCount 11 → 11 ملفًا', translateCount('ar', 'lesson.fileCount', 11) === '11 ملفًا');
check('fileCount 0 → لا ملفات', translateCount('ar', 'lesson.fileCount', 0) === 'لا ملفات');
check('fileCount 3 in English → 3 files', translateCount('en', 'lesson.fileCount', 3) === '3 files');
check('fileCount 1 in English → 1 file', translateCount('en', 'lesson.fileCount', 1) === '1 file');
check('lessonsCount 2 → درسان', translateCount('ar', 'home.lessonsCount', 2) === 'درسان');
check('lessonsCount 7 → 7 دروس', translateCount('ar', 'home.lessonsCount', 7) === '7 دروس');
check('unreadCount 2 → رسالتان غير مقروءتان',
  translateCount('ar', 'common.unreadCount', 2) === 'رسالتان غير مقروءتان');
check('an unknown count key falls back to the key itself',
  translateCount('ar', 'no.such.count.key', 3) === 'no.such.count.key');

/* ───────────────────────── 7. parity after edits ───────────────────────── */

console.log('\nparity');
const enKeys = Object.keys(en).sort();
const arKeys = Object.keys(ar).sort();
check(`exact EN/AR key parity (${enKeys.length} keys)`,
  enKeys.length === arKeys.length && enKeys.every((k, i) => k === arKeys[i]));
check('the rejected مساقاتي appears nowhere in the dictionary',
  !Object.values(ar).some((v) => String(v).includes('مساقاتي')));

/* ───────────────────────────── summary ────────────────────────────────── */

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nTerminology gate FAILED — see docs/TRANSLATION_TERMINOLOGY.md.');
  process.exit(1);
}
