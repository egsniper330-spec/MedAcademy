#!/usr/bin/env node
/**
 * Student greeting + language selector — layout and direction regressions.
 *
 * Run: node tests/studentGreetingAndLanguageSelector.test.cjs  (part of `npm test`)
 *
 * TWO REPORTED DEFECTS PINNED HERE
 * ───────────────────────────────
 * 1. STUDENT GREETING. The header showed the translated ROLE ("Student" /
 *    "طالب") where the second line belongs, so the account name never appeared
 *    and the block read as "Student / Welcome". The required order is
 *    greeting first, account name underneath, in both languages.
 *
 * 2. LANGUAGE SELECTOR. Arabic and English sat in one undivided box with a
 *    floating check that had no fixed position of its own, so it read as
 *    belonging to the gap between rows (and could be pushed around by a long
 *    translated label). The fix is a fixed-size radio marker on EVERY row at
 *    the leading edge, plus real per-row separation.
 *
 * The name is DATA: this suite also asserts that it is never translated,
 * transliterated, or replaced by a role label.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Comments must not satisfy a source assertion. */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const stripComments = code;

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

/* ─────────────────────────── student greeting ──────────────────────────── */

console.log('\nStudent dashboard greeting');
const dashboard = stripComments(read('src/app/(app)/(student)/dashboard.tsx'));

// The greeting line is `home.hello` ("Hello" / "مرحباً") — kept separate from
// `home.welcome` because that key still serves as a role label on other
// dashboards. Line 1 = greeting, line 2 = the account name (below).
ok("greeting is the localized greeting word (line 1)",
  /<DashboardHeader[\s\S]*?greeting=\{t\('home\.hello'\)\}/.test(dashboard));
ok('the account name is the second line',
  /<DashboardHeader[\s\S]*?subtitle=\{accountName\}/.test(dashboard));
ok('the account name comes from the authenticated profile (not a role label)',
  /profile\?\.full_name\?\.trim\(\)/.test(dashboard));

/* ── the BLOCK, not just the text, must follow the locale ─────────────────
 * The reported defect was "the greeting is still on the upper-left in Arabic"
 * even though every Text already had `textAlign: 'right'`. The cause was in the
 * shared header: the title stack is a COLUMN, so its `alignItems` resolves on
 * the HORIZONTAL cross axis — and under `direction: 'rtl'` Yoga FLIPS that axis,
 * so `flex-end` meant LEFT. rtl + flex-end mirrored twice and pinned the whole
 * block (greeting + account name) to the left edge.
 *
 * The contract pinned here: the stack is physically anchored — pinned to ltr so
 * `flex-end` IS the right edge — and the text inside still follows the locale. */
const headerSrc = stripComments(read('src/components/DashboardHeader.tsx'));
ok('the greeting stack anchors the whole block to the locale edge',
  /alignItems: isRTL \? 'flex-end' : 'flex-start'/.test(headerSrc));
ok('the stack is pinned to a physical direction (no double mirror)',
  /flex: 1,[\s\S]{0,220}alignItems: isRTL \? 'flex-end' : 'flex-start',\s*direction: 'ltr',/.test(headerSrc) &&
  !/alignItems: isRTL \? 'flex-end' : 'flex-start',\s*direction: isRTL \? 'rtl'/.test(headerSrc));
ok('the greeting text itself still follows the locale',
  /textAlign: isRTL \? 'right' : 'left'/.test(headerSrc));
ok('an empty name falls back to a localized string',
  /profile\?\.full_name\?\.trim\(\)\s*\|\|\s*t\('common\.user'\)/.test(dashboard));
ok('the translated ROLE label is no longer passed to the header',
  !/roleLabel=\{t\('role\.student'\)\}/.test(dashboard));
ok('the name is never routed through a translator',
  !/t\('common\.user'\)\s*\|\|\s*profile/.test(dashboard) &&
  !/t\(accountName\)/.test(dashboard));
ok('the header exposes a localized accessibility label for the name line',
  /subtitleAccessibilityLabel=\{t\('home\.signedInAs'/.test(dashboard));

/* ─────────────────────── DashboardHeader contract ──────────────────────── */

console.log('\nDashboardHeader renders the subtitle');
const header = stripComments(read('src/components/DashboardHeader.tsx'));

ok('DashboardHeader accepts subtitle + its a11y label',
  /subtitle\?:\s*string/.test(header) && /subtitleAccessibilityLabel\?:\s*string/.test(header));
ok('subtitle is rendered after the greeting line',
  header.indexOf('{greeting}') < header.indexOf('{subtitle}'));
ok('subtitle alignment follows the app direction',
  /\{subtitle \?[\s\S]*?textAlign: isRTL \? 'right' : 'left'/.test(header));
ok('subtitle does NOT force a writing direction on the name',
  !/\{subtitle \?[\s\S]{0,700}writingDirection/.test(header));
ok('subtitle is single-line and truncates instead of pushing actions away',
  /\{subtitle \?[\s\S]{0,700}numberOfLines=\{1\}/.test(header));

/* ─────────────────────────── language selector ─────────────────────────── */

console.log('\nLanguage selector layout');
const lang = stripComments(read('src/components/LanguageSetting.tsx'));

ok('each option still renders as one radio row',
  /accessibilityRole="radio"/.test(lang) && /OPTIONS\.map/.test(lang));
ok('rows are no longer laid out with space-between (that is what crowded them)',
  !/justifyContent: 'space-between'/.test(lang));
ok('rows have real separation (gap or margin), not zero spacing',
  /gap: 10/.test(lang));
ok('tappable height meets the 44dp minimum',
  /minHeight: 56/.test(lang));
ok('every row carries the selection marker (not only the selected one)',
  /width: 22,[\s\S]{0,200}borderRadius: 11/.test(lang));
const rowIdx = lang.indexOf('accessibilityRole="radio"');
const markerIdx = lang.indexOf('width: 22,');
const labelIdx = lang.indexOf('{ flex: 1, minWidth: 0 }');
ok('the marker comes BEFORE the label in the row (leading edge, mirrors in RTL)',
  rowIdx >= 0 && markerIdx > rowIdx && labelIdx > markerIdx,
  `row=${rowIdx} marker=${markerIdx} label=${labelIdx}`);
ok('the marker is placed by the row, never by a physical left/right pin',
  !/\bright: 0\b/.test(lang) && !/\bleft: 0\b/.test(lang));
const markerBlock = lang.slice(markerIdx, markerIdx + 900);
ok('the check is drawn INSIDE the marker (cannot drift to the gap)',
  /<Check/.test(markerBlock) && /<ActivityIndicator/.test(markerBlock));
ok('the label column flexes and can shrink (long translations never clip)',
  /\{ flex: 1, minWidth: 0 \}/.test(lang));
ok('selected state is exposed to assistive tech',
  /accessibilityState=\{\{ selected, disabled: busy, busy: busy && selected \}\}/.test(lang));
ok('the selector keeps persistence feedback (saved / save-failed toasts)',
  /t\('language\.saved'\)/.test(lang) && /t\('language\.saveFailed'\)/.test(lang));

/* ─────────────────────────────── summary ───────────────────────────────── */

console.log('\n──────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
