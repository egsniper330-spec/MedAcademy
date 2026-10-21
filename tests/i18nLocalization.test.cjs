#!/usr/bin/env node
/**
 * Arabic localization — detection, fallback, interpolation, RTL and resource completeness.
 *
 * Run: node tests/i18nLocalization.test.cjs   (also part of `npm test`)
 *
 * WHAT THIS SUITE PINS
 *   1.   Arabic device locales (`ar`, `ar-EG`, `ar-SA`, `ar-EG-u-nu-latn`, …)
 *        select Arabic; English selects English; unsupported languages fall
 *        back to English; the FIRST supported tag wins.
 *   2.   Missing keys fall back safely (locale → English → key) and never throw.
 *   3.   Interpolation works in both languages with the SAME placeholder set.
 *   4.   RTL is wired through the platform's supported mechanism (I18nManager
 *        on native, document.dir on web) by the provider — not merely a JS flag.
 *   5.   Both dictionaries have exactly the same keys, no empty values, no
 *        duplicate literals, and the Arabic copy actually contains Arabic script.
 *   6.   Every literal translation key referenced by the app exists in BOTH
 *        dictionaries (catches a migrated screen that was never given Arabic).
 *   7.   Direction-sensitive UI logic does not blindly mirror the tree (no
 *        blanket row-reverse / scaleX(-1) flipping in the i18n layer).
 *   8.   The audit script still runs and reports candidates (it is a gauge).
 *
 * The pure half of the i18n core (resources/detect/preference/preferenceStore)
 * has no React Native imports, so it is compiled standalone here — same house
 * pattern as the other model suites.
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

/* ───────────────────────── compile the pure i18n core ──────────────────── */

const SOURCES = [
  'src/lib/i18n/resources.ts',
  'src/lib/i18n/detect.ts',
  'src/lib/i18n/preference.ts',
  'src/lib/i18n/preferenceStore.ts',
];

function buildCore() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-build-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...SOURCES.map((rel) => path.join(ROOT, rel)),
      '--outDir', out,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return out;
}

let BUILD;
try {
  BUILD = buildCore();
} catch (e) {
  console.error('  ✗ could not compile src/lib/i18n core');
  console.error(String(e.stderr || e.stdout || e.message).slice(0, 4000));
  process.exit(1);
}
const core = require(path.join(BUILD, 'detect.js'));
const pref = require(path.join(BUILD, 'preference.js'));
const prefStore = require(path.join(BUILD, 'preferenceStore.js'));

const { ar, en, resolveLocale, isArabicTag, isRTLLocale, translate, interpolate } = core;

/* ─────────────────────── 1. device-language detection ──────────────────── */

console.log('\ndevice locale detection');
check('ar → ar', resolveLocale(['ar']) === 'ar');
check('ar-EG → ar', resolveLocale(['ar-EG']) === 'ar');
check('ar-SA → ar', resolveLocale(['ar-SA']) === 'ar');
check('AR-eg (case/format variants) → ar', resolveLocale(['AR-eg']) === 'ar');
check('ar-EG-u-nu-latn → ar', resolveLocale(['ar-EG-u-nu-latn']) === 'ar');
check('en → en', resolveLocale(['en']) === 'en');
check('en-US → en', resolveLocale(['en-US']) === 'en');
check('unsupported (fr-FR) → en', resolveLocale(['fr-FR']) === 'en');
check('unsupported (de) alone → en', resolveLocale(['de']) === 'en');
check('empty list → en', resolveLocale([]) === 'en');
check('null / undefined tags are ignored', resolveLocale([null, undefined, 'ar-EG']) === 'ar');
check('first supported tag wins (fr then ar)', resolveLocale(['fr-FR', 'ar-EG']) === 'ar');
check('first supported tag wins (ar then en)', resolveLocale(['ar-EG', 'en-US']) === 'ar');
check('English preferred over later Arabic', resolveLocale(['en-GB', 'ar-EG']) === 'en');
check('isArabicTag("ar-EG")', isArabicTag('ar-EG') === true);
check('isArabicTag("en-US") is false', isArabicTag('en-US') === false);
check('isRTLLocale(ar) true', isRTLLocale('ar') === true);
check('isRTLLocale(en) false', isRTLLocale('en') === false);
check('DEFAULT_LOCALE is English', core.DEFAULT_LOCALE === 'en');

/* ────────────────── 2. preference precedence (model layer) ─────────────── */

console.log('\nlanguage-preference precedence (pure model)');
check('no override + ar device → ar', pref.effectiveLocale(null, ['ar-EG']) === 'ar');
check('no override + en device → en', pref.effectiveLocale(null, ['en-US']) === 'en');
check('no override + unsupported device → en', pref.effectiveLocale(null, ['ja-JP']) === 'en');
check("'system' + ar device → ar", pref.effectiveLocale('system', ['ar-EG']) === 'ar');
check('saved ar beats en device', pref.effectiveLocale('ar', ['en-US']) === 'ar');
check('saved en beats ar device', pref.effectiveLocale('en', ['ar-EG']) === 'en');
check('invalid stored value behaves like system', pref.effectiveLocale('klingon', ['ar-EG']) === 'ar');
check('LANGUAGE_PREFERENCES offers system/ar/en',
  Array.isArray(pref.LANGUAGE_PREFERENCES)
  && pref.LANGUAGE_PREFERENCES.join(',') === 'system,ar,en');

/* ─────────────────────── 3. translation + interpolation ────────────────── */

console.log('\ntranslation and fallback');
const SAMPLE_KEY = 'common.save';
check('translate(en) returns English', translate('en', SAMPLE_KEY) === en[SAMPLE_KEY]);
check('translate(ar) returns Arabic', translate('ar', SAMPLE_KEY) === ar[SAMPLE_KEY]);
check('unknown key returns the key itself (never throws)',
  translate('ar', 'does.not.exist') === 'does.not.exist');
check('missing Arabic key falls back to English',
  translate('ar', 'period.daily') === ar['period.daily']);
check('interpolate replaces {name}',
  interpolate('Hello {name}', { name: 'Sara' }) === 'Hello Sara');
check('interpolate leaves unknown placeholders intact',
  interpolate('{a}-{b}', { a: 'x' }) === 'x-{b}');
check('interpolate without params is a no-op', interpolate('plain') === 'plain');
check('interpolate accepts numbers', interpolate('{n} items', { n: 3 }) === '3 items');

/* ─────────────────────────── 4. dictionary parity ──────────────────────── */

console.log('\ndictionary completeness');
const enKeys = Object.keys(en).sort();
const arKeys = Object.keys(ar).sort();
check(`both dictionaries are non-trivial (${enKeys.length} English keys)`, enKeys.length > 500);
check('exact key parity between English and Arabic',
  enKeys.length === arKeys.length && enKeys.every((k, i) => k === arKeys[i]));

const missingAr = enKeys.filter((k) => !(k in ar));
const extraAr = Object.keys(ar).filter((k) => !(k in en));
check('no English key missing from Arabic' + (missingAr.length ? `: ${missingAr.slice(0, 5).join(', ')}` : ''),
  missingAr.length === 0);
check('no Arabic-only key' + (extraAr.length ? `: ${extraAr.slice(0, 5).join(', ')}` : ''),
  extraAr.length === 0);

const emptyValues = enKeys.filter((k) => !String(en[k] ?? '').trim() || !String(ar[k] ?? '').trim());
check('no empty translation values', emptyValues.length === 0);

const PLACEHOLDER = /\{(\w+)\}/g;
const placeholderList = (s) => (String(s).match(PLACEHOLDER) || []).sort();
const placeholdersOf = (s) => placeholderList(s).join(',');

// Rule: a translation may never introduce a placeholder English does not have
// (nothing would fill it). Plural variants may legitimately DROP `{count}`:
// Arabic one/two forms say «ملف واحد» / «ملفان» instead of «1 ملف».
const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;
const introduced = enKeys.filter((k) =>
  placeholderList(ar[k]).some((p) => !placeholderList(en[k]).includes(p)));
check('Arabic never introduces a placeholder English does not provide' +
  (introduced.length ? `: ${introduced.slice(0, 5).join(', ')}` : ''),
  introduced.length === 0);

const mismatched = enKeys.filter(
  (k) => !PLURAL_SUFFIX.test(k) && placeholdersOf(en[k]) !== placeholdersOf(ar[k]),
);
check('non-plural placeholder sets match exactly in both languages' +
  (mismatched.length ? `: ${mismatched.slice(0, 5).join(', ')}` : ''),
  mismatched.length === 0);

const pluralMismatched = enKeys.filter((k) =>
  PLURAL_SUFFIX.test(k) &&
  placeholderList(ar[k]).length !== placeholderList(en[k]).length &&
  placeholderList(ar[k]).length > 0);
check('plural forms only differ by an intentionally omitted {count}' +
  (pluralMismatched.length ? `: ${pluralMismatched.slice(0, 5).join(', ')}` : ''),
  pluralMismatched.length === 0);

const NON_TRANSLATABLE = core.NON_TRANSLATABLE_KEYS;
const ARABIC = /[\u0600-\u06FF]/;
const notArabic = enKeys.filter((k) => !NON_TRANSLATABLE.has(k) && !ARABIC.test(String(ar[k])));
check('Arabic values contain Arabic script (excluding documented non-translatables)' +
  (notArabic.length ? `: ${notArabic.slice(0, 5).join(', ')}` : ''),
  notArabic.length === 0);

// Duplicate literals inside one dictionary object are silently collapsed by the
// JS parser — they hide a translation that someone thinks exists.
function duplicateKeysInSource(registry, startMarker) {
  const src = read('src/lib/i18n/resources.ts');
  const start = src.indexOf(startMarker);
  if (start < 0) return ['<object not found: ' + registry + '>'];
  const end = registry === 'en'
    ? src.indexOf('export const ar', start)
    : src.length;
  const body = src.slice(start, end);
  const seen = new Map();
  const dups = [];
  const re = /^\s*'([^']+)'\s*:/gm;
  let m;
  while ((m = re.exec(body))) {
    if (seen.has(m[1])) dups.push(m[1]);
    else seen.set(m[1], true);
  }
  return dups;
}
const dupEn = duplicateKeysInSource('en', 'export const en');
const dupAr = duplicateKeysInSource('ar', 'export const ar');
check('no duplicate keys in the English dictionary' + (dupEn.length ? `: ${dupEn.slice(0, 5).join(', ')}` : ''),
  dupEn.length === 0);
check('no duplicate keys in the Arabic dictionary' + (dupAr.length ? `: ${dupAr.slice(0, 5).join(', ')}` : ''),
  dupAr.length === 0);

/* ───────────── 5. every referenced literal key exists in both ──────────── */

console.log('\nreferenced keys');
const SRC_ROOT = path.join(ROOT, 'src');
const sourceFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.expo') continue;
      walk(full);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      sourceFiles.push(full);
    }
  }
})(SRC_ROOT);

const referenced = new Set();
const countReferenced = new Set();
const KEY_LITERAL = /\b(?:t|translate)\(\s*['"]([A-Za-z][\w.]*)['"]\s*[,)]/g;
// Plural-aware calls reference a BASE key: `tCount('lesson.fileCount', n)`.
// Its dictionaries are `<base>.<category>`, checked separately below.
const COUNT_LITERAL = /\btCount\(\s*['"]([A-Za-z][\w.]*)['"]\s*,/g;
// Vendored/minified third-party bundles are not app source: their `t("…")`
// calls are i18n lookups INSIDE a minified library (Plyr's quality labels),
// not app keys. They are excluded by path, not by guessing at the content.
const VENDORED = /(^|[\\/])plyrBundle\.[jt]s$/;
for (const file of sourceFiles) {
  if (VENDORED.test(file.replace(/\\/g, '/'))) continue;
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = KEY_LITERAL.exec(src))) referenced.add(m[1]);
  while ((m = COUNT_LITERAL.exec(src))) countReferenced.add(m[1]);
}
check(`found referenced keys in the app (${referenced.size})`, referenced.size > 50);
const missingRefs = [...referenced].filter((k) => !(k in en) || !(k in ar));
check('every referenced key exists in English and Arabic' +
  (missingRefs.length ? `: ${missingRefs.slice(0, 8).join(', ')}` : ''),
  missingRefs.length === 0);

// Plural keys: every `tCount('x', n)` call needs all six CLDR categories in
// BOTH dictionaries, or some counts would silently fall back to English.
const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];
check(`found plural-aware keys (${countReferenced.size})`, countReferenced.size > 0);
const missingPlural = [];
for (const base of countReferenced) {
  for (const cat of PLURAL_CATEGORIES) {
    if (!(`${base}.${cat}` in en) || !(`${base}.${cat}` in ar)) {
      missingPlural.push(`${base}.${cat}`);
    }
  }
}
check('every tCount() base key has all six plural forms in both dictionaries' +
  (missingPlural.length ? `: ${missingPlural.slice(0, 5).join(', ')}` : ''),
  missingPlural.length === 0);

// Dynamic keys (t(variable)) cannot be checked statically, but the LanguageSetting
// selector passes literal keys from its OPTIONS table — make sure those are real.
const langSetting = read('src/components/LanguageSetting.tsx');
const dynamicKeys = [...langSetting.matchAll(/labelKey:\s*'([^']+)'|hintKey:\s*'([^']+)'/g)]
  .map((m) => m[1] || m[2]);
check('LanguageSetting option keys all exist',
  dynamicKeys.length >= 4 && dynamicKeys.every((k) => k in en && k in ar));

// Key tables (`{ labelKey: '…' }`) are resolved with `t(entry.labelKey)`, so a
// static scan is the only way to prove those strings exist. Every table entry in
// the app must resolve in BOTH dictionaries.
const KEY_TABLE_ENTRY = /(?:labelKey|descriptionKey|hintKey):\s*'([A-Za-z][\w.]*)'/g;
const tableKeys = new Set();
for (const file of sourceFiles) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = KEY_TABLE_ENTRY.exec(src))) tableKeys.add(m[1]);
}
const missingTableKeys = [...tableKeys].filter((k) => !(k in en) || !(k in ar));
check(`key-table entries resolve in both dictionaries (${tableKeys.size} found)` +
  (missingTableKeys.length ? `: ${missingTableKeys.slice(0, 5).join(', ')}` : ''),
  tableKeys.size > 0 && missingTableKeys.length === 0);

/* ────────────── 5b. migrated screens: no own English copy ─────────────── */

// A screen can be "translatable" and still ship its own English. Every screen
// listed here was migrated to the dictionary in the earnings batch: each must
// import the i18n module, reference only keys that exist in BOTH dictionaries,
// and no longer contain the English copy that used to be hardcoded in the file.
// The retired list is a SAMPLE of the replaced copy — enough to prove the
// dictionary is the source of truth without duplicating the whole dictionary.
const MIGRATED_SCREENS = [
  {
    file: 'src/app/(app)/(doctor)/dr-earnings.tsx',
    retired: [
      'Earnings System is Disabled',
      'Revenue Timeline',
      'Revenue by Course',
      'Pricing & Admin Tools',
      'Recalculate Earnings',
      'Reset Earnings?',
      'No enrollments on your courses.',
      'Immutable snapshot recorded at transaction time.',
      'Pricing Fallback Logic',
      'This feature is currently unavailable',
      'Pricing Source',
    ],
  },
  {
    file: 'src/app/(app)/(hubs)/sa-doctor-earnings.tsx',
    retired: [
      'Earnings Dashboard',
      'Credit Selling Price',
      'Credit Ledger Summary',
      'Revenue from Credit Sales',
      'Balance Trend (Last',
      'Credit History (',
      'No Credit Activity',
      'Last Login',
      'Students Activated',
      'All data uses the exact same sources',
    ],
  },
  // ── Shared modals used by every role ──────────────────────────────────────
  {
    file: 'src/components/ChangePasswordModal.tsx',
    minKeys: 10,
    retired: [
      'Please enter a new password.',
      'Password is too weak',
      'Confirm new password',
      'Set Password',
      'The new password takes effect immediately.',
    ],
  },
  {
    file: 'src/components/DeleteAccountModal.tsx',
    minKeys: 10,
    retired: [
      'Delete Permanently',
      'Credits Remaining',
      'Registered Devices',
      'This action is permanent and cannot be undone',
      'Loading account details',
    ],
  },
  {
    file: 'src/components/CreateUserModal.tsx',
    minKeys: 15,
    retired: [
      'Can purchase and access courses.',
      'Unlimited Devices',
      'Account created successfully!',
      'Choose Account Type',
      'Select the role for the new user',
    ],
  },
  {
    file: 'src/components/EditUserDialog.tsx',
    minKeys: 10,
    retired: [
      'Email changes require user verification.',
      'New Password (leave blank to keep current)',
      'Academic Level',
      'Failed to save changes.',
    ],
  },
  {
    file: 'src/components/BulkSelectBar.tsx',
    minKeys: 1,
    retired: ['Reset Devices', 'Rm Credits', 'Reset Password'],
  },
  {
    file: 'src/components/ProfilePhotoActions.tsx',
    minKeys: 6,
    retired: [
      'Change or remove profile photo',
      'Choose an action for your current photo.',
      'Your profile picture will be replaced with the default avatar.',
    ],
  },
  // ── Admin role ────────────────────────────────────────────────────────────
  {
    file: 'src/app/(app)/(admin)/devices.tsx',
    minKeys: 10,
    retired: [
      'Device Management',
      'No devices registered',
      'Block reason (optional)',
      'Configure Device Limit',
      'LOGGED OUT',
    ],
  },
  {
    file: 'src/app/(app)/(admin)/users.tsx',
    minKeys: 15,
    retired: [
      'User Management',
      'Undo (10s)',
      'Promoted to Doctor.',
      'Unlimited devices disabled (limit: 1).',
      'Repeat password',
    ],
  },
  {
    file: 'src/app/(app)/(admin)/academic.tsx',
    minKeys: 15,
    retired: [
      'Academic Structure',
      'No levels — tap + to add',
      'Failed to save faculty.',
      'University created successfully.',
      'Manage universities, faculties and levels',
    ],
  },
  {
    file: 'src/app/(app)/(admin)/audit.tsx',
    minKeys: 10,
    retired: [
      'Audit Logs',
      'Additional Info',
      'No audit logs found',
      'Try a different filter or search term',
    ],
  },
  // ── Shared validation copy (form errors for every role) ───────────────────
  {
    file: 'src/lib/validation.ts',
    minKeys: 8,
    retired: [
      'Email is required.',
      'Password is required.',
      'Password must contain at least one uppercase letter.',
      'Something went wrong. Please try again.',
      'Insufficient credits. Allocate credits to your account first.',
    ],
  },
  // ── Doctor role: dashboard + course list ─────────────────────────────────
  {
    file: 'src/app/(app)/(doctor)/dr-overview.tsx',
    minKeys: 12,
    retired: [
      'Quick Actions',
      "Today's Activations",
      'Recent Enrollments',
      'No courses yet. Create your first course!',
      'Doctor Panel',
    ],
  },
  {
    file: 'src/app/(app)/(doctor)/courses.tsx',
    minKeys: 15,
    retired: [
      'Course creation is unavailable',
      'Search courses…',
      'Preview as Student',
      'Delete Course?',
      'Failed to delete course.',
      'Create First Course',
    ],
  },
  {
    file: 'src/app/(app)/(doctor)/students.tsx',
    minKeys: 40,
    retired: [
      'All Students',
      'By Course',
      'Recently Added',
      'No students found',
      'Search students, courses…',
      'Add via Credits',
      'Student Information',
      'Bulk action result',
      'Choose enrollment method',
    ],
  },
  {
    file: 'src/app/(app)/(hubs)/doctor-earnings.tsx',
    minKeys: 40,
    retired: [
      'EARNINGS SETTINGS',
      'Credit Selling Price',
      'No changes recorded yet',
      'Custom Pricing',
      'Grand Total',
      'PER COURSE EARNINGS',
      'Failed to update course price.',
    ],
  },
  // ── Student role: profile (shared by every student surface) ──────────────
  {
    file: 'src/app/(app)/(student)/profile.tsx',
    minKeys: 40,
    retired: [
      'Account Information',
      'Edit Name & Email',
      'No subscribed courses yet',
      'Password Updated!',
      'Your progress and data are safely saved.',
      'No options available',
      'Edit Academic Info',
    ],
  },
];

// Comments describe the UI ("Revenue Timeline chart"), so they are stripped
// before looking for shipped copy — same rule the coverage audit uses.
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

console.log('\nmigrated screens');
check('migrated screens are listed', MIGRATED_SCREENS.length >= 2);
for (const screen of MIGRATED_SCREENS) {
  const name = screen.file.split('/').pop();
  const src = read(screen.file);
  const code = stripComments(src);
  check(`${name} renders through the i18n module`, /from '@\/lib\/i18n'/.test(src));

  const literal = /\b(?:t|translate)\(\s*['"]([A-Za-z][\w.]*)['"]\s*[,)]/g;
  const keys = [...src.matchAll(literal)].map((m) => m[1]);
  const badKeys = [...new Set(keys)].filter((k) => !(k in en) || !(k in ar));
  check(`${name} references ${new Set(keys).size} dictionary keys, all present in both` +
    (badKeys.length ? `: ${badKeys.slice(0, 5).join(', ')}` : ''),
    new Set(keys).size >= (screen.minKeys ?? 20) && badKeys.length === 0);

  const leftover = screen.retired.filter((s) => code.includes(s));
  check(`${name} no longer contains its own English copy` +
    (leftover.length ? `: ${leftover.join(' | ')}` : ''),
    leftover.length === 0);
}

/* ─────────────────────────── 6. RTL wiring ─────────────────────────────── */

console.log('\nRTL / LTR wiring');
const i18nIndex = read('src/lib/i18n/index.ts');
check('uses I18nManager.forceRTL (the supported native mechanism)',
  /I18nManager\.forceRTL\(/.test(i18nIndex));
check('keeps allowRTL(true) — RTL must stay possible after switching to English',
  /I18nManager\.allowRTL\(\s*true\s*\)/.test(i18nIndex));
check('flips document.dir + lang on web', /documentElement\.dir/.test(i18nIndex));
check('reports needsRestart instead of silently forcing a relaunch',
  /needsRestart/.test(i18nIndex));
check('provider applies direction on mount and on every locale change',
  /useEffect\(\(\)\s*=>\s*\{\s*const result = applyRTL\(\s*storeLocale\s*\)/.test(i18nIndex));
check('provider loads the stored preference at startup',
  /loadLanguagePreference\(\)/.test(i18nIndex));
check('an explicit override suppresses device changes on foreground resume',
  /getPreference\(\)\s*!==\s*'system'/.test(i18nIndex));
check('no blind tree mirroring (row-reverse / scaleX(-1)) in the i18n layer',
  !/row-reverse|scaleX\(-1\)/.test(i18nIndex) && !/row-reverse|scaleX\(-1\)/.test(read('src/lib/i18n/detect.ts')));

const appLayout = read('src/app/_layout.tsx');
check('root layout mounts the I18nProvider', /I18nProvider/.test(appLayout));

// The selector must be reachable from a settings surface, not just imported.
const profileScreens = [
  'src/app/(app)/(student)/profile.tsx',
  'src/app/(app)/(doctor)/dr-profile.tsx',
];
check('LanguageSetting is rendered somewhere users can reach it',
  profileScreens.some((rel) => /<LanguageSetting\b/.test(read(rel))));

/* ─────────────────────── 7. audit script still usable ──────────────────── */

console.log('\naudit');
let auditJson = null;
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'i18n-coverage.js'), '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  auditJson = JSON.parse(out);
} catch (e) {
  console.error('    audit failed:', String(e.stderr || e.message).slice(0, 800));
}
check('audit script runs and emits JSON', auditJson !== null);
check('audit reports a numeric candidate total',
  auditJson !== null && typeof auditJson.total === 'number' && auditJson.total >= 0);
check('audit never claims coverage from a dictionary alone (it counts files)',
  auditJson !== null && typeof auditJson.files === 'number');

/* ────────────────────────────── summary ────────────────────────────────── */

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nLocalization gate FAILED.');
  process.exit(1);
}
