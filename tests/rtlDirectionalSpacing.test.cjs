#!/usr/bin/env node
/**
 * rtlDirectionalSpacing.test.cjs — student-facing screens must express spacing
 * and accent borders with LOGICAL properties so Arabic mirrors correctly.
 *
 * ROOT CAUSE PINNED HERE
 * ──────────────────────
 * React Native mirrors `flexDirection: 'row'`, `textAlign`, `margin`/`padding`
 * (unqualified) and `alignItems` from `I18nManager.isRTL` — but it does NOT
 * mirror the PHYSICAL edge properties:
 *
 *     marginLeft / marginRight / paddingLeft / paddingRight
 *     borderLeftWidth / borderRightWidth / borderLeftColor / borderRightColor
 *     left / right   (absolute positioning)
 *
 * Every one of those is a one-sided value, so in Arabic the gap landed on the
 * wrong side of an icon, an accent bar drawn with `borderLeftWidth` stayed on
 * the physically-left edge while the row's content started on the right (it
 * read as a detached stripe belonging to the neighbouring row), and badges
 * pinned with `right:` sat in the corner the reading order had already left.
 *
 * THE FIX IS STRUCTURAL, NOT PER-SCREEN
 * ─────────────────────────────────────
 * The logical equivalents are resolved by Yoga from the layout direction:
 *
 *     marginStart / marginEnd / paddingStart / paddingEnd
 *     borderStartWidth / borderEndWidth / borderStartColor
 *     start / end
 *
 * so English lays out exactly as before (start = left) and Arabic mirrors with
 * NO `isRTL ? … : …` branch. That matters a second time: a manual branch
 * combined with the automatic mirroring is precisely the "double reversal"
 * class of bug this repo has already been bitten by (see drawerDirection.ts).
 *
 * WHAT THIS CHECKS
 *   1. No physical horizontal margin/padding in the student-facing screens.
 *   2. No physical accent border (borderLeft… / borderRight…) in them either.
 *   3. CourseCard pins its badges with `end`, and ProfilePhotoActions' camera
 *      badge with `end` — the two components where a wrong corner is most
 *      visible (a card grid and the avatar header).
 *   4. Deliberately-LTR values stay readable: phone/WhatsApp/Telegram/price
 *      inputs still carry `writingDirection: 'ltr'` (that is CORRECT, not a
 *      bug — an Arabic phone number must not be reordered).
 *   5. The download/preparation panel is fully localized: every state string
 *      comes from `t(...)`, and each key exists in BOTH locales.
 *
 * Run: node tests/rtlDirectionalSpacing.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
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

/**
 * Strip comments so PROSE about the fix can never satisfy a structural pin
 * (and so a commented-out physical property is not reported as a defect).
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/* ══ 1/2. Student-facing screens use logical edges ═══════════════════════ */

section('1. Student-facing screens — logical horizontal spacing');

// Every screen a STUDENT actually sees in Arabic. Staff-console screens are
// deliberately excluded: they are locked to English by the i18n role lock, so
// their physical value columns are a layout choice, not an RTL defect.
const STUDENT_SCREENS = [
  'src/app/(app)/(student)/dashboard.tsx',
  'src/app/(app)/(student)/explore.tsx',
  'src/app/(app)/(student)/my-courses.tsx',
  'src/app/(app)/(student)/profile.tsx',
  'src/app/(app)/lesson/[id].tsx',
  'src/app/(app)/course/[id].tsx',
  'src/app/(app)/edit-profile.tsx',
  'src/app/(app)/notifications.tsx',
  'src/app/(app)/offline-library.tsx',
  'src/app/(app)/offline-course.tsx',
  'src/app/(app)/login-history.tsx',
  'src/app/(app)/my-devices.tsx',
  'src/app/(app)/security.tsx',
];

const PHYSICAL_SPACING = /\b(?:margin|padding)(?:Left|Right)\s*:/g;
const PHYSICAL_BORDER = /\bborder(?:Left|Right)(?:Width|Color|Style)?\s*:/g;

for (const screen of STUDENT_SCREENS) {
  const src = code(read(screen));
  const name = screen.split('/').pop();

  const spacing = [...src.matchAll(PHYSICAL_SPACING)].map((m) => m[0].trim());
  check(`${name}: no physical marginLeft/Right or paddingLeft/Right`,
    spacing.length === 0, spacing.join(','));

  const border = [...src.matchAll(PHYSICAL_BORDER)].map((m) => m[0].trim());
  check(`${name}: no physical borderLeft/borderRight accent`,
    border.length === 0, border.join(','));
}

section('2. The logical form is actually used (not merely absent)');

{
  // The accent stripe on the security-warning panels: `borderStartWidth` so it
  // sits on the START edge, which is the right-hand edge in Arabic.
  const lesson = code(read('src/app/(app)/lesson/[id].tsx'));
  check('lesson security panels draw the accent on the START edge',
    /borderStartWidth:\s*4, borderStartColor: '#EF4444'/.test(lesson)
    && /borderStartWidth:\s*3, borderStartColor: '#F59E0B'/.test(lesson));

  const profile = code(read('src/app/(app)/(student)/profile.tsx'));
  check('student profile uses marginStart/marginEnd for icon gaps',
    /marginStart: 7/.test(profile) && /marginEnd: 12/.test(profile));

  const course = code(read('src/app/(app)/course/[id].tsx'));
  check('course metrics grid separates columns on the END edge',
    /borderEndWidth: i < 2 \? 1 : 0/.test(course));

  const notifications = code(read('src/app/(app)/notifications.tsx'));
  check('notifications uses marginStart/marginEnd',
    /marginEnd: 12/.test(notifications) && /marginStart: 8/.test(notifications));
}

/* ══ 3. Component badges sit on the trailing corner ══════════════════════ */

section('2b. Shared components + auth/doctor surfaces — logical edges');

// These are audited separately because a defect here is multiplied by every
// screen that consumes the component, not confined to one route.
const SHARED_AND_ROLE_SCREENS = [
  'src/components/NeuInputRow.tsx',      // every form field + search bar in the app
  'src/components/Toast.tsx',            // every success/error message
  'src/components/VideoUploadQueue.tsx',
  'src/app/(auth)/sign-up.tsx',
  'src/app/(auth)/security-warning.tsx', // security gate, student-facing
  'src/app/(app)/security-warning.tsx',
  'src/app/(app)/(doctor)/dr-profile.tsx',
  'src/app/(app)/lesson-editor/[id].tsx',
];

for (const file of SHARED_AND_ROLE_SCREENS) {
  const src = code(read(file));
  const name = file.split('/').pop();
  const spacing = [...src.matchAll(PHYSICAL_SPACING)].map((m) => m[0].trim());
  check(`${name}: no physical marginLeft/Right or paddingLeft/Right`,
    spacing.length === 0, spacing.join(','));
  const border = [...src.matchAll(PHYSICAL_BORDER)].map((m) => m[0].trim());
  check(`${name}: no physical borderLeft/borderRight accent`,
    border.length === 0, border.join(','));
}

{
  // The toast accent stripe and the security-card stripes must be START edges,
  // and the doctor profile field labels must lead-gap off the icon.
  const toast = code(read('src/components/Toast.tsx'));
  check('toast accent bar is on the START edge',
    /borderStartWidth: 4/.test(toast) && !/borderLeftWidth: 4/.test(toast));
  check('toast dismiss control is separated with marginStart',
    /marginStart: 8/.test(toast));

  for (const f of ['src/app/(auth)/security-warning.tsx', 'src/app/(app)/security-warning.tsx']) {
    const src = code(read(f));
    check(`${f.split('/').pop()}: all five security cards use a START accent`,
      (src.match(/borderStartWidth: 4/g) || []).length === 5,
      String((src.match(/borderStartWidth: 4/g) || []).length));
  }

  const neuInput = code(read('src/components/NeuInputRow.tsx'));
  check('form field leading icon uses marginEnd',
    /marginEnd: spacing\.sm/.test(neuInput));
  check('form field trailing element uses marginStart',
    /marginStart: spacing\.sm/.test(neuInput));

  const dr = code(read('src/app/(app)/(doctor)/dr-profile.tsx'));
  check('doctor profile label/error gaps follow the direction',
    (dr.match(/marginStart: (?:7|6)/g) || []).length === 4,
    String((dr.match(/marginStart: (?:7|6)/g) || []).length));

  const editor = code(read('src/app/(app)/lesson-editor/[id].tsx'));
  check('lesson-editor warning cards use a START accent',
    (editor.match(/borderStartWidth: 3/g) || []).length === 4,
    String((editor.match(/borderStartWidth: 3/g) || []).length));
}

section('2c. The single-mirror surfaces are NOT converted (no double mirroring)');

{
  // PageHeader / DashboardHeader pin `direction: 'ltr'` on the row so that
  // `row-reverse` is exactly one physical mirror. Their padding therefore MUST
  // stay physical: `paddingStart` would resolve against the pinned `ltr` and
  // pad the wrong edge. Converting them "for consistency" is the bug.
  for (const f of ['src/components/PageHeader.tsx', 'src/components/DashboardHeader.tsx']) {
    const src = code(read(f));
    const name = f.split('/').pop();
    check(`${name}: row is pinned to ltr (the single mirror)`, /direction: 'ltr'/.test(src));
    check(`${name}: padding stays physical, intentionally`,
      /paddingLeft: isRTL \?/.test(src) && /paddingRight: isRTL \?/.test(src));
  }

  // The drawer picks its hairline edge from the computed side, so it must stay
  // a physical border too (a logical one would flip with the panel direction).
  const drawer = code(read('src/components/DrawerNav.tsx'));
  check('drawer hairline follows the computed borderEdge',
    /dir\.borderEdge === 'left'/.test(drawer)
    && /borderLeftWidth: isDark/.test(drawer)
    && /borderRightWidth: isDark/.test(drawer));
}

section('3. Badges use `end` (trailing corner in BOTH directions)');

{
  const card = code(read('src/components/CourseCard.tsx'));
  check('the enrolled badge is pinned with end, never right',
    /top: layout\.pad\.sm, end: layout\.pad\.sm/.test(card)
    && !/top: layout\.pad\.sm, right: layout\.pad\.sm/.test(card));
  check('the compact thumbnail completion badge is pinned with end',
    /bottom: 4, end: 4/.test(card) && !/bottom: 4, right: 4/.test(card));

  const photo = code(read('src/components/ProfilePhotoActions.tsx'));
  check('the avatar camera badge is pinned with end',
    /bottom: 0, end: 0/.test(photo) && !/bottom: 0, right: 0/.test(photo));
}

/* ══ 4. Inherently-LTR values stay LTR ═══════════════════════════════════ */

section('4. Inherently-LTR values are deliberately not mirrored');

{
  // A phone number, a handle or a price must never be reordered by the
  // surrounding RTL context. `writingDirection: 'ltr'` + textAlign left is the
  // CORRECT treatment here, and this pins that it was not "fixed" away.
  const builder = code(read('src/app/(app)/course-builder/[id].tsx'));
  const forced = (builder.match(/writingDirection: 'ltr'/g) || []).length;
  check('course-builder keeps LTR writing direction for phone/handle/price fields',
    forced >= 4, String(forced));
  check('those fields sit inside a direction-aware row',
    /direction: isRTL \? 'rtl' : 'ltr'/.test(builder));
}

/* ══ 5. The PDF preparation panel is fully localized ════════════════════ */

section('5. Download / preparation panel copy comes from i18n');

{
  const lesson = code(read('src/app/(app)/lesson/[id].tsx'));
  const i18n = read('src/lib/i18n/resources.ts');
  const en = i18n.slice(0, i18n.indexOf('export const ar'));
  const ar = i18n.slice(i18n.indexOf('export const ar'));

  // The panel had four hardcoded English states plus two hardcoded sentences.
  // Arabic users saw English inside an otherwise Arabic screen.
  const keys = [
    'lesson.downloadComplete',
    'lesson.downloadFailed',
    'lesson.preparingPdf',
    'lesson.downloadingNow',
    'lesson.preparingPdfDesc',
    'lesson.fileSavedShareSheet',
  ];

  check('the panel resolves every state through t(...)',
    keys.every((k) => lesson.includes(`t('${k}')`)),
    keys.filter((k) => !lesson.includes(`t('${k}')`)).join(','));

  const count = (haystack, key) =>
    (haystack.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
  check('every key exists exactly once in BOTH locales',
    keys.every((k) => count(en, k) === 1 && count(ar, k) === 1),
    keys.filter((k) => count(en, k) !== 1 || count(ar, k) !== 1).join(','));

  // No hardcoded English sentence may remain in the panel's visible copy.
  for (const literal of ['Download Complete', 'Download Failed', 'Preparing your PDF', 'File saved.']) {
    check(`no hardcoded "${literal}" left in the lesson screen`,
      !lesson.includes(`'${literal}`) && !lesson.includes(`>${literal}`));
  }

  // Arabic must actually be Arabic (not an English fallback), and the two
  // locales must agree on placeholders so t() cannot throw on a missing param.
  const arabic = (key) =>
    (ar.match(new RegExp(`'${key.replace(/\./g, '\\.')}': '(.*?)',`)) || [])[1] || '';
  check('the Arabic panel strings contain Arabic script',
    keys.filter((k) => k !== 'lesson.preparingPdf').every((k) => /[\u0600-\u06FF]/.test(arabic(k))),
    keys.filter((k) => !/[\u0600-\u06FF]/.test(arabic(k))).join(','));

  const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  const enP = (key) => (en.match(new RegExp(`'${key.replace(/\./g, '\\.')}': '(.*?)',`)) || [])[1] || '';
  check('en and ar agree on placeholders for every panel key',
    keys.every((k) => placeholders(enP(k)) === placeholders(arabic(k))));
  check('the Arabic "preparing" copy is Arabic too',
    /[\u0600-\u06FF]/.test(arabic('lesson.preparingPdf')));
}

/* ════════════════════════════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
if (failed > 0) {
  console.error(`${passed} passed, ${failed} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
