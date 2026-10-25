#!/usr/bin/env node
/**
 * arabicRtlAndContactWarning.test.cjs — Arabic RTL headings, the localization
 * coverage of the screens named in the request, and the red "no default
 * contact" warning.
 *
 * ── 1. RTL HEADING ROOT CAUSE ───────────────────────────────────────────────
 * With Arabic selected, the page title on Notifications / About / Contact /
 * Terms / Privacy stayed against the LEFT edge. Nothing was styled wrongly: the
 * title had no `textAlign`, so React Native resolved it through
 * `I18nManager.isRTL` — the NATIVE layout flag, which only flips after the
 * relaunch `applyRTL()` schedules. Until that relaunch (and permanently in any
 * build where the native flag is not set) Arabic copy was laid out with English
 * direction rules.
 *
 * The fix makes the shared PageHeader follow the APP locale it already uses for
 * `t()` and for the back-arrow glyph: explicit `textAlign` + `writingDirection`
 * from the locale, and a physically mirrored row. Icons and copy are untouched,
 * so English layouts are byte-for-byte the same as before.
 *
 * ── 2. LOCALIZATION COVERAGE ────────────────────────────────────────────────
 * The screens named in the request must contain no hardcoded English, and every
 * static key they reference must exist in BOTH dictionaries with Arabic script
 * and identical placeholders.
 *
 * ── 3. CONTACT WARNING ─────────────────────────────────────────────────────
 * A missing default contact must be a RED, localized, accessible, DISABLED
 * option; the "still checking" state must not look like it.
 *
 * Run: node tests/arabicRtlAndContactWarning.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require(path.join(__dirname, '..', 'node_modules/typescript'));

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures.push(label + (detail ? ` (${detail})` : '')); console.log('  ✗ ' + label); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

/* ── dictionaries ─────────────────────────────────────────────────────────── */

const resourceSource = read('src/lib/i18n/resources.ts');
const compiled = ts.transpile(resourceSource, {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
});
const resourceModule = { exports: {} };
vm.runInNewContext(compiled, { exports: resourceModule.exports, module: resourceModule, require });
const { en, ar } = resourceModule.exports;

const ARABIC = /[\u0600-\u06FF]/;
const placeholders = (value) =>
  [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

/* ── the screens in scope ─────────────────────────────────────────────────── */

const SCREENS = {
  'Doctor · Video Library': 'src/app/(app)/(doctor)/video-library.tsx',
  'Doctor · Students': 'src/app/(app)/(doctor)/students.tsx',
  'Doctor · Balance (credits)': 'src/app/(app)/(hubs)/credits.tsx',
  'Doctor & Student · Notifications': 'src/app/(app)/notifications.tsx',
  'Student · My Courses': 'src/app/(app)/(student)/my-courses.tsx',
  'Student · Offline Videos (library)': 'src/app/(app)/offline-library.tsx',
  'Student · Offline Videos (course)': 'src/app/(app)/offline-course.tsx',
  'About Us': 'src/app/(app)/info/about.tsx',
  'Contact Us': 'src/app/(app)/info/contact.tsx',
  'Terms & Conditions': 'src/app/(app)/info/terms.tsx',
  'Privacy Policy': 'src/app/(app)/info/privacy.tsx',
};

/* ══ 1. RTL header ════════════════════════════════════════════════════════ */

section('1. Shared page header follows the APP locale, not the native flag');

const header = read('src/components/PageHeader.tsx');

ok('the header subscribes to the active locale', /useTranslation\(\)/.test(header) && /isRTL/.test(header));
ok('the title is aligned from the locale', /const textAlign = isRTL \? 'right' : 'left';/.test(header));
ok('the title sets textAlign AND writingDirection (no implicit direction)',
  /textAlign,\s*writingDirection: isRTL \? 'rtl' : 'ltr',/.test(header));
ok('the subtitle is aligned the same way (both lines, not just the title)',
  /textAlign,\s*writingDirection: isRTL \? 'rtl' : 'ltr',[\s\S]{0,40}numberOfLines=\{1\}/.test(header));
ok('the row is physically mirrored so the leading control sits on the right',
  /flexDirection: isRTL \? 'row-reverse' : 'row'/.test(header));
ok('spacing is a gap, not a physical margin that would point the wrong way',
  /gap: spacing\.sm \+ spacing\.xs/.test(header) && !/marginLeft:/.test(header) && !/marginRight:/.test(header));
ok('the back affordance mirrors by GLYPH (the platform does not mirror icons)',
  /isRTL\s*\?\s*<ArrowRight size=\{iconSize\.lg\}/.test(header));
// Comments in the file explain the old I18nManager behaviour; only real CODE
// depending on the native flag would be a regression.
const headerCode = header
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
ok('the header does NOT depend on I18nManager for its alignment (regression guard)',
  !/I18nManager/.test(headerCode));
ok('nothing is horizontally flipped / mirrored wholesale',
  !/scaleX\(-1\)/.test(header));

section('1b. Every affected page renders that shared header with a translated title');

for (const [label, rel] of [
  ['Notifications', 'src/app/(app)/notifications.tsx'],
  ['About Us', 'src/app/(app)/info/about.tsx'],
  ['Contact Us', 'src/app/(app)/info/contact.tsx'],
  ['Terms & Conditions', 'src/app/(app)/info/terms.tsx'],
  ['Privacy Policy', 'src/app/(app)/info/privacy.tsx'],
]) {
  const src = read(rel);
  const m = src.match(/<PageHeader\s+title=\{([^}]+)\}/);
  ok(`${label} uses PageHeader with a localized title`,
    /import \{ PageHeader \}/.test(src) && !!m && /^t\('/.test(m[1].trim()),
    m ? m[1] : 'no title expression');
  ok(`${label} passes no hardcoded English title`, !/<PageHeader\s+title="/.test(src));
  ok(`${label} imports the i18n layer`, /from '@\/lib\/i18n'/.test(src));
}

/* ══ 2. Localization coverage ═════════════════════════════════════════════ */

section('2. No hardcoded English left on the named screens');

let audit = null;
try {
  audit = JSON.parse(execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/i18n-coverage.js'), '--json', '--top', '1000'],
    { encoding: 'utf8', cwd: ROOT },
  ));
} catch (e) {
  ok('the i18n audit script runs', false, e.message);
}

if (audit) {
  ok('the i18n audit script runs and reports a total', typeof audit.total === 'number');
  const flagged = new Map(audit.top.map((f) => [f.file, f.hits]));
  for (const [label, rel] of Object.entries(SCREENS)) {
    const hits = flagged.get(rel) || [];
    // The ONE accepted exception: the redemption-code FORMAT hint in Balance is
    // a data pattern (MED-XXXX-…), not copy, and is identical in both locales.
    const copy = hits.filter((h) => !/^MED-[X-]+$/.test(h.text.trim()));
    ok(`${label} has no hardcoded English copy`, copy.length === 0,
      copy.map((h) => `L${h.line}: ${h.text}`).join(' | '));
  }
}

section('2b. Every key those screens reference exists in English AND Arabic');

const missing = [];
const notArabic = [];
const placeholderMismatch = [];
for (const [label, rel] of Object.entries(SCREENS)) {
  const src = read(rel);
  const keys = new Set([...src.matchAll(/\bt\(\s*'([\w.]+)'/g)].map((m) => m[1]));
  for (const key of keys) {
    if (!(key in en)) { missing.push(`${label}: ${key} (en)`); continue; }
    if (!(key in ar)) { missing.push(`${label}: ${key} (ar)`); continue; }
    if (ARABIC.test(en[key]) === false && !ARABIC.test(ar[key])) notArabic.push(`${label}: ${key}`);
    if (placeholders(en[key]) !== placeholders(ar[key])) {
      placeholderMismatch.push(`${label}: ${key} (${placeholders(en[key])} vs ${placeholders(ar[key])})`);
    }
  }
}
ok('no referenced key is missing from either dictionary', missing.length === 0, missing.slice(0, 6).join(' | '));
ok('every Arabic value contains Arabic script', notArabic.length === 0, notArabic.slice(0, 6).join(' | '));
ok('English and Arabic placeholders match (no broken interpolation)',
  placeholderMismatch.length === 0, placeholderMismatch.slice(0, 6).join(' | '));

section('2c. The upload-queue panel (nested in Video Library) is translated too');

const queue = read('src/components/VideoUploadQueue.tsx');
ok('status labels come from the dictionary', /labelKey: 'uploadQueue\.status\./.test(queue) && !/label: 'Waiting…'/.test(queue));
ok('stage labels come from the dictionary', /labelKey: 'uploadQueue\.stage\./.test(queue));
ok('queue actions and hints are translated',
  ['uploadQueue.retry', 'uploadQueue.replace', 'uploadQueue.integrityVerified',
   'uploadQueue.timeoutHint', 'uploadQueue.recoveringHint', 'uploadQueue.complete',
   'uploadQueue.recovery.title', 'uploadQueue.recovery.body', 'uploadQueue.bulk.retryAllFailed',
   'uploadQueue.bulk.clearCompleted', 'uploadQueue.title'].every((k) => queue.includes(k)));
ok('every uploadQueue key exists in both dictionaries with Arabic script',
  Object.keys(en).filter((k) => k.startsWith('uploadQueue.')).every((k) => k in ar && ARABIC.test(ar[k])));
ok('queue placeholders match between languages',
  Object.keys(en).filter((k) => k.startsWith('uploadQueue.'))
    .every((k) => placeholders(en[k]) === placeholders(ar[k])));

/* ══ 3. Missing default contact = RED warning ═════════════════════════════ */

section('3. Missing default contact is a red, localized, disabled warning');

const builder = read('src/app/(app)/course-builder/[id].tsx');

ok('the exact English wording is unchanged', en['cb.contact.useDefaultUnavailable'] ===
  'Unavailable — configure this in your Profile page');
ok('the exact Arabic wording requested is present', ar['cb.contact.useDefaultUnavailable'] ===
  'غير متاحة — يمكن إعدادها من صفحة الملف الشخصي');

ok('a missing default is rendered in red in BOTH themes (contrast preserved)',
  /const warningColor = isDark \? '#F87171' : '#DC2626';/.test(builder) &&
  /color: warningColor/.test(builder));

ok('the warning is emphasised (bold) rather than muted',
  /fontSize: 11, marginTop: 2, fontWeight: '700',\s*color: warningColor/.test(builder));

ok('the option stays DISABLED when the default is unusable',
  /disabled: !defaultContactUsable/.test(builder) && /disabled=\{opt\.disabled\}/.test(builder) &&
  /if \(!opt\.disabled\) setUseDefaultContact/.test(builder));

ok('the disabled option keeps readable contrast while still looking unavailable',
  /opacity: opt\.disabled \? \(opt\.warning \? 0\.85 : 0\.55\) : 1/.test(builder));

ok('"still checking" is visually distinct from "confirmed missing"',
  /warning: defaultContactState === 'missing'/.test(builder) &&
  /defaultContactState === 'unknown' \? t\('cb\.contact\.useDefaultChecking'\)/.test(builder) &&
  /\} : \{\s*fontSize: 11, marginTop: 2, \.\.\.mutedTextStyle\(c, 0\.45\)/.test(builder));

ok('screen readers hear the unavailable reason with the option',
  /accessibilityLabel=\{opt\.hint \? `\$\{opt\.label\}\. \$\{opt\.hint\}` : opt\.label\}/.test(builder) &&
  /accessibilityHint=\{opt\.hint \?\? undefined\}/.test(builder));

ok('the state change is announced on Android',
  /accessibilityLiveRegion="polite"/.test(builder));

ok('contact values are VALIDATED, not merely non-empty',
  /const usable = wa\.length >= 6 \|\| \/\^\[A-Za-z0-9_\]\{3,\}\$\/\.test\(tg\) \|\| ph\.length >= 4;/.test(builder));

ok('unknown (profile still loading) is never treated as confirmed missing',
  /if \(!profile \|\| isProfileLoading\) return 'unknown';/.test(builder));

ok('a confirmed-missing default cannot stay selected',
  /if \(defaultContactState !== 'missing'\) return;[\s\S]{0,80}setUseDefaultContact\(false\);/.test(builder));

ok('this is the only place the default-contact option is offered (no second copy to diverge)',
  (read('src/app/(app)/course-builder/[id].tsx').match(/cb\.contact\.useDefault'/g) || []).length === 1);

section('Summary');
console.log(`\n${passed} passed; ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
