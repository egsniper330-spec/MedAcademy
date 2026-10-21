#!/usr/bin/env node
/**
 * Localized date formatting — regression suite.
 *
 * WHY
 * ───
 * Doctor Dashboard "Recent Enrollments" rendered dates with a raw
 * `new Date(created_at)` + `toLocaleDateString`. The backend pins MySQL to UTC
 * (backend/src/bootstrap.php, Database::instance()) and serializes DATETIME as
 * "YYYY-MM-DD HH:MM:SS" with NO zone marker, which V8 parses as LOCAL time —
 * so every timestamp shifted by the device's UTC offset. The month names also
 * followed the device rather than the app's selected language.
 *
 * src/lib/i18n/date.ts is now the single formatter. These tests pin:
 *   • UTC parsing for bare server timestamps (no shift),
 *   • explicit offsets and date-only values are respected,
 *   • Arabic and English month names per the SELECTED app language,
 *   • Latin digits in both languages (app-wide digit policy),
 *   • unparseable values render an em dash instead of "Invalid Date".
 *
 * Run: node tests/localizedDates.test.cjs
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

const build = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-date-'));
execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(ROOT, 'src/lib/i18n/date.ts'),
    path.join(ROOT, 'src/lib/i18n/detect.ts'),
    path.join(ROOT, 'src/lib/i18n/resources.ts'),
    '--outDir', build,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--skipLibCheck',
    '--noEmitOnError', 'false',
  ],
  { stdio: 'pipe' },
);
const {
  parseServerDate,
  formatLocalizedDate,
  DATE_PLACEHOLDER,
  DATE_LOCALE_TAGS,
} = require(path.join(build, 'date.js'));

console.log('\nUTC handling (no local-time shift)');
const utc = parseServerDate('2026-10-21 12:00:00');
check('bare DATETIME parses to a Date', utc instanceof Date && !Number.isNaN(utc.getTime()));
check('bare DATETIME is treated as UTC (12:00Z, not 12:00 local)',
  utc instanceof Date && utc.toISOString() === '2026-10-21T12:00:00.000Z',
  utc instanceof Date ? utc.toISOString() : 'n/a');

const withMs = parseServerDate('2026-10-21 12:00:00.123456');
check('microsecond DATETIME parses as UTC',
  withMs instanceof Date && withMs.toISOString().startsWith('2026-10-21T12:00:00'),
  withMs instanceof Date ? withMs.toISOString() : 'n/a');

const isoZ = parseServerDate('2026-10-21T12:00:00Z');
check('explicit Z is preserved', isoZ instanceof Date && isoZ.toISOString() === '2026-10-21T12:00:00.000Z');

const offset = parseServerDate('2026-10-21T14:00:00+02:00');
check('explicit offset is honored',
  offset instanceof Date && offset.toISOString() === '2026-10-21T12:00:00.000Z',
  offset instanceof Date ? offset.toISOString() : 'n/a');

const noZoneIso = parseServerDate('2026-10-21T12:00:00');
check('naive ISO datetime is treated as UTC',
  noZoneIso instanceof Date && noZoneIso.toISOString() === '2026-10-21T12:00:00.000Z');

const dateOnly = parseServerDate('2026-10-21');
check('date-only stays on the same calendar day (local, no shift)',
  dateOnly instanceof Date && dateOnly.getFullYear() === 2026
  && dateOnly.getMonth() === 9 && dateOnly.getDate() === 21,
  dateOnly instanceof Date ? dateOnly.toString() : 'n/a');

check('Date objects pass through', (() => {
  const d = new Date('2026-10-21T12:00:00Z');
  const p = parseServerDate(d);
  return p instanceof Date && p.getTime() === d.getTime();
})());
check('epoch millis are accepted', parseServerDate(1792000000000) instanceof Date);
check('garbage → null', parseServerDate('not-a-date') === null);
check('empty string → null', parseServerDate('') === null);
check('null / undefined → null', parseServerDate(null) === null && parseServerDate(undefined) === null);

console.log('\nlocale rendering');
const iso = '2026-10-21T12:00:00Z';
const en = formatLocalizedDate(iso, 'en');
const ar = formatLocalizedDate(iso, 'ar');
check('English uses Latin month name', /Oct/i.test(en), en);
check('Arabic uses an Arabic month name', /[\u0600-\u06FF]/.test(ar), ar);
check('English includes the year', en.includes('2026'), en);
check('Arabic includes the year in Latin digits', /2026/.test(ar), ar);
check('no Arabic-Indic digits in Arabic output', !/[\u0660-\u0669]/.test(ar), ar);
check('no Arabic-Indic digits in English output', !/[\u0660-\u0669]/.test(en), en);
check('short style omits the year', !/2026/.test(formatLocalizedDate(iso, 'en', { style: 'short' })));
check('withTime adds a time', /:|AM|PM|ص|م/.test(formatLocalizedDate(iso, 'en', { withTime: true })));
check('invalid value → placeholder', formatLocalizedDate('nope', 'en') === DATE_PLACEHOLDER);
check('null value → placeholder', formatLocalizedDate(null, 'ar') === DATE_PLACEHOLDER);
check('Arabic tag forces Latin digits', DATE_LOCALE_TAGS.ar.includes('nu-latn'));

console.log('\nwiring');
const dashboard = read('src/app/(app)/(doctor)/dr-overview.tsx');
check('doctor dashboard uses formatLocalizedDate', /formatLocalizedDate\(/.test(dashboard));
check('doctor dashboard no longer builds dates with new Date(...).toLocaleDateString',
  !/new Date\(e\.created_at\)\.toLocaleDateString/.test(dashboard));
check('recent-enrollment row separates the date onto its own line',
  /Calendar size=/.test(dashboard) && /dateLabel/.test(dashboard));
check('timestamp column keeps no physical marginRight',
  !/marginRight: layout\.pad\.md \}>\s*<Text[^>]*>\{e\.student/.test(dashboard));

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
