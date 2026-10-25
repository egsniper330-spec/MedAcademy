#!/usr/bin/env node
/**
 * instructorDashboardStats.test.cjs — the instructor dashboard must not label a
 * course COUNT as "Published".
 *
 * REPORTED: a statistic card read `Published 3`, which describes publication
 * state rather than how many courses the instructor owns.
 *
 * What is pinned here:
 *   1. The course count is labelled "Courses" / "عدد الدورات" and its value is
 *      the TOTAL number of the instructor's courses.
 *   2. The published-only figure still exists (scope unchanged — no query was
 *      narrowed) but is labelled as a SUBSET ("Published Courses" /
 *      "دورات منشورة"), so it can never be mistaken for the total again.
 *   3. Both keys exist in both locales.
 *
 * Run: node tests/instructorDashboardStats.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

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

const overview = code(read('src/app/(app)/(doctor)/dr-overview.tsx'));
const resources = read('src/lib/i18n/resources.ts');

console.log('\n1. The count is reported as a count of courses');
{
  ok('the label is the localized Courses key, not a status word',
    /StatCard label=\{t\('drOverview\.courses'\)\}/.test(overview) &&
    !/StatCard label=\{t\('nav\.myCourses'\)\}/.test(overview));
  ok('its value is the TOTAL of the instructor\'s courses',
    /StatCard label=\{t\('drOverview\.courses'\)\}\s+value=\{totalCourses\}/.test(overview) &&
    /const totalCourses\s+= courses\.length;/.test(overview));
}

console.log('\n2. The published-only figure keeps its scope, but says so');
{
  ok('a distinct subset card exists',
    /StatCard label=\{t\('drOverview\.publishedCourses'\)\}/.test(overview));
  ok('its value is still the published subset (scope unchanged)',
    /publishedCourses'\)\}\s+value=\{courses\.filter\(cr => cr\.status === 'published'\)\.length\}/.test(overview));
}

console.log('\n3. Localized in both languages');
{
  ok('English: Courses / Published Courses',
    /'drOverview\.courses': 'Courses'/.test(resources) &&
    /'drOverview\.publishedCourses': 'Published Courses'/.test(resources));
  ok('Arabic: عدد الدورات / دورات منشورة',
    /'drOverview\.courses': 'عدد الدورات'/.test(resources) &&
    /'drOverview\.publishedCourses': 'دورات منشورة'/.test(resources));
  ok('no dashboard card is left with a bare "Published" count',
    !/StatCard label=\{t\('drOverview\.published'\)\}/.test(overview));
}

console.log('\n' + (failed === 0 ? '✅' : '❌') + ` ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
