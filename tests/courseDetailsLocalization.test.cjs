#!/usr/bin/env node
/**
 * Course details screen — full localization (Arabic + English).
 *
 * Run: node tests/courseDetailsLocalization.test.cjs   (part of `npm test`)
 *
 * THE REPORTED DEFECT
 * ───────────────────
 * With Arabic selected, app/course/[id].tsx still rendered English: the
 * difficulty badge, "1 lessons", "Course Content", "1 sections · 1 lessons",
 * "Subscribe", "New Section", "Free", "About This Course", "done", "Available
 * <date>" and the whole progress widget. Every one of those is APPLICATION
 * COPY, so every one now goes through the existing i18n layer.
 *
 * WHAT MUST *NOT* CHANGE
 * ──────────────────────
 * Course titles, section names, lesson titles, instructor names, tags,
 * descriptions and the price amount are DATA (doctor/admin-authored). They are
 * rendered verbatim — translating them would corrupt stored content. This
 * suite asserts both sides of that line, and that both locales carry every key
 * the screen references.
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

const COURSE = 'src/app/(app)/course/[id].tsx';
const PROGRESS = 'src/components/CourseProgressBar.tsx';
const course = stripComments(read(COURSE));
const progress = stripComments(read(PROGRESS));
const resources = read('src/lib/i18n/resources.ts');

/* ─────────────────────────── no hardcoded copy ─────────────────────────── */

console.log('\nNo app copy left as an English literal');
const LEGACY_LITERALS = [
  'Course not found',
  'Course Archived',
  'Preview as Student',
  'Exit student preview',
  'About This Course',
  'Course Content',
  'Certificate on completion',
  'Free preview available',
  'Sequential learning path',
  "label=\"Subscribe\"",
  'remaining`',
  '% complete',
  'sub="done"',
  'sub="left"',
  'Go back',
];
for (const literal of LEGACY_LITERALS) {
  ok(`"${literal.replace(/"/g, '')}" is translated, not hardcoded`,
    !course.includes(literal) && !progress.includes(literal));
}

ok("language badge no longer prints the raw English vocabulary by default",
  /languageKey\(course\.language\)/.test(course));
ok('difficulty badge is mapped to difficulty.* keys',
  /DIFFICULTY_KEYS\[course\.difficulty\]/.test(course));
ok('dates follow the app language (no en-US date literals)',
  !/toLocaleDateString\('en-US'/.test(course) && /formatLocalizedDate\(/.test(course));

/* ─────────────────────────── data stays verbatim ───────────────────────── */

console.log('\nAuthor-authored data is never translated');
ok('course title rendered raw', /\{course\.title\}/.test(course));
ok('section title rendered raw', /\{section\.title\}/.test(course));
ok('lesson title rendered raw', /lesson\.title/.test(course) && !/t\(lesson\.title\)/.test(course));
ok('instructor name rendered raw', /\{course\.doctor\?\.full_name \?\? course\.instructor_name\}/.test(course));
ok('descriptions rendered raw',
  /\{course\.short_description\}/.test(course) && /\{course\.full_description\}/.test(course));
ok('tags rendered raw', /\{tag\}/.test(course));
ok('no course-authored field is passed to t()',
  !/t\((course|section|lesson)\.(title|name|description)\b/.test(course));

/* ─────────────────────── direction-aware alignment ─────────────────────── */

console.log('\nRTL / LTR alignment');
ok('direction is derived from the i18n layer, not the device',
  /isRTL \} = useTranslation\(\)/.test(course));
ok('label blocks follow the app direction',
  /const txtAlign = isRTL \? 'right' as const : 'left' as const/.test(course));
ok('content heading is aligned by direction', /textAlign: txtAlign/.test(course));
ok('no row-reverse hacks were introduced', !/row-reverse/.test(course));

/* ───────────────────────── every referenced key exists ─────────────────── */

console.log('\nDictionary coverage for every referenced key');
const refs = new Set();
for (const m of (course + progress).matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) refs.add(m[1]);
for (const m of (course + progress).matchAll(/\btCount\('([a-zA-Z0-9_.]+)'/g)) refs.add(m[1]);

const enBlock = resources.slice(resources.indexOf('export const en'), resources.indexOf('export const ar'));
const arBlock = resources.slice(resources.indexOf('export const ar'));
const enKeys = new Set([...enBlock.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
const arKeys = new Set([...arBlock.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));

const PLURAL = ['.zero', '.one', '.two', '.few', '.many', '.other'];
// `tCount('base', n)` resolves to `base.<plural-category>`, so a plural base is
// satisfied when every category exists in both languages (checked below).
const hasPlural = (k, dict) => PLURAL.some((s) => dict.has(k + s));

ok(`the screen references ${refs.size} dictionary keys`, refs.size > 10);
const missing = [...refs].filter(
  (k) => (!enKeys.has(k) && !hasPlural(k, enKeys)) || (!arKeys.has(k) && !hasPlural(k, arKeys)),
);
ok('every referenced key exists in English AND Arabic' +
  (missing.length ? `: ${missing.join(', ')}` : ''), missing.length === 0);

const pluralBases = [...refs].filter((k) => PLURAL.some((s) => enKeys.has(k + s)));
ok('plural keys are complete in both languages',
  pluralBases.every((b) => PLURAL.every((s) => enKeys.has(b + s) && arKeys.has(b + s))),
  pluralBases.join(', '));
ok('section counts are plural-aware (Arabic has its own dual/plural forms)',
  /tCount\('course\.sectionCount'/.test(course) && /tCount\('home\.lessonsCount'/.test(course));
ok('"done" counts use an interpolated localized sentence',
  /t\('course\.doneOfTotal', \{ done:/.test(course));

/* ─────────────────────────── progress widget ───────────────────────────── */

console.log('\nProgress widget labels');
ok('percent-complete label is localized', /t\('course\.pctComplete', \{ pct \}\)/.test(progress));
ok('remaining time is localized', /formatRemaining\(remainingSeconds, t\)/.test(progress));
ok('done/left captions are localized',
  /sub=\{t\('course\.doneShort'\)\}/.test(progress) && /sub=\{t\('course\.leftShort'\)\}/.test(progress));

/* ─────────────────────────────── summary ───────────────────────────────── */

console.log('\n──────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
