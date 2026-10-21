#!/usr/bin/env node
/**
 * App-language preference — persistence, precedence, failures and reset.
 *
 * Run: node tests/languagePreference.test.cjs   (also part of `npm test`)
 *
 * WHAT THIS SUITE PINS (the contract of src/lib/i18n/preference.ts +
 * preferenceStore.ts, which are pure and therefore executable here):
 *   1. PRECEDENCE: stored override  ›  device language  ›  English fallback.
 *      A saved Arabic override beats an English device and vice versa.
 *   2. DEFAULT: with nothing stored the device decides — Arabic device locale
 *      (including regional variants) → Arabic; English → English; anything
 *      unsupported → English.
 *   3. PERSISTENCE: the choice survives a fresh store instance (a "relaunch")
 *      over the same backing storage.
 *   4. RETURN TO SYSTEM DEFAULT: saving 'system' REMOVES the key, so device
 *      detection resumes and later device changes are honoured again.
 *   5. INVALID VALUES: legacy/garbage/blank stored values are treated as "no
 *      override" — they never trap the app in an unexpected language.
 *   6. STORAGE FAILURES: read/write errors and a missing storage module never
 *      crash; they degrade to 'system' / `persisted: false` so the UI can tell
 *      the truth instead of silently showing a language that will not persist.
 *   7. RUNTIME ORDERING (static check on src/lib/i18n/index.ts): the write is
 *      attempted before the locale is published, so the displayed language is
 *      always the one that was stored; and no code path logs out or resets the
 *      session when the language changes.
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

/* ───────────────────── compile the pure preference core ────────────────── */

const SOURCES = [
  'src/lib/i18n/resources.ts',
  'src/lib/i18n/detect.ts',
  'src/lib/i18n/preference.ts',
  'src/lib/i18n/preferenceStore.ts',
];

const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-pref-'));
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
  console.error('  ✗ could not compile the preference core');
  console.error(String(e.stderr || e.stdout || e.message).slice(0, 4000));
  process.exit(1);
}

const pref = require(path.join(BUILD, 'preference.js'));
const { createPreferenceStore } = require(path.join(BUILD, 'preferenceStore.js'));

const KEY = pref.LANGUAGE_PREFERENCE_STORAGE_KEY;

/* ─────────────────────── a faithful in-memory AsyncStorage ─────────────── */

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const calls = [];
  return {
    map,
    calls,
    async getItem(k) { calls.push(['get', k]); return map.has(k) ? map.get(k) : null; },
    async setItem(k, v) { calls.push(['set', k, v]); map.set(k, v); },
    async removeItem(k) { calls.push(['remove', k]); map.delete(k); },
  };
}

/** A storage backend where every operation throws (quota / permissions / corrupted). */
function brokenStorage(error = new Error('storage unavailable')) {
  return {
    async getItem() { throw error; },
    async setItem() { throw error; },
    async removeItem() { throw error; },
  };
}

/* ─────────────────────────────── 1. precedence ─────────────────────────── */

console.log('\nprecedence: stored override › device › English');
check('saved ar beats an English device', pref.effectiveLocale('ar', ['en-US']) === 'ar');
check('saved en beats an Arabic device', pref.effectiveLocale('en', ['ar-EG']) === 'en');
check('saved ar beats a multi-tag English device list',
  pref.effectiveLocale('ar', ['en-GB', 'en-US', 'fr']) === 'ar');
check('no override → Arabic device', pref.effectiveLocale(null, ['ar-EG']) === 'ar');
check('no override → English device', pref.effectiveLocale(null, ['en']) === 'en');
check('no override → unsupported device falls back to English',
  pref.effectiveLocale(null, ['ru-RU']) === 'en');
check('no override → empty device list falls back to English', pref.effectiveLocale(null, []) === 'en');
check("'system' behaves exactly like no override (Arabic device)",
  pref.effectiveLocale('system', ['ar-SA']) === 'ar');
check("'system' behaves exactly like no override (English device)",
  pref.effectiveLocale('system', ['en-US']) === 'en');

/* ───────────────────── 2. parsing stored / invalid values ──────────────── */

console.log('\nparsing stored values');
check("parsePreference('ar') → 'ar'", pref.parsePreference('ar') === 'ar');
check("parsePreference('EN') normalises to 'en'", pref.parsePreference('EN') === 'en');
check("parsePreference(' ar ') trims to 'ar'", pref.parsePreference(' ar ') === 'ar');
check("parsePreference('system') → 'system'", pref.parsePreference('system') === 'system');
check("legacy 'auto' means system", pref.parsePreference('auto') === 'system');
check("legacy 'device' means system", pref.parsePreference('device') === 'system');
check("empty string means system", pref.parsePreference('') === 'system');
check('garbage returns null (no override)', pref.parsePreference('klingon') === null);
check('JSON-ish garbage returns null', pref.parsePreference('{"lang":"ar"}') === null);
check('null returns null', pref.parsePreference(null) === null);
check('numbers return null', pref.parsePreference(42) === null);
check('object returns null', pref.parsePreference({ language: 'ar' }) === null);

/* ───────────────────────── 3. persistence across launches ──────────────── */

console.log('\npersistence across launches');
(async () => {
  const storage = makeStorage();

  const first = createPreferenceStore(storage);
  check('fresh install loads as system', (await first.load()) === 'system');

  const saved = await first.save('ar');
  check('saving ar reports success', saved === true);
  check('ar was written to the documented key', storage.map.get(KEY) === 'ar');
  check('store exposes the key it uses', first.key === KEY);

  // "Relaunch": a brand-new store over the same backing storage.
  const second = createPreferenceStore(storage);
  const reloaded = await second.load();
  check('a relaunch still sees the Arabic override', reloaded === 'ar');
  check('the stored override still beats an English device',
    pref.effectiveLocale(reloaded, ['en-US']) === 'ar');

  const savedEn = await second.save('en');
  check('switching to English reports success', savedEn === true);
  const third = createPreferenceStore(storage);
  check('a relaunch sees the English override', (await third.load()) === 'en');
  check('the stored English override beats an Arabic device',
    pref.effectiveLocale(await third.load(), ['ar-EG']) === 'en');

  /* ─────────────── 4. returning to the system default ──────────────────── */

  console.log('\nreturning to the system default');
  const backToSystem = await third.save('system');
  check('saving system reports success', backToSystem === true);
  check('the stored key is REMOVED (not written as "system")', !storage.map.has(KEY));
  check('removeItem was used for the reset',
    storage.calls.some(([op, k]) => op === 'remove' && k === KEY));

  const fourth = createPreferenceStore(storage);
  const afterReset = await fourth.load();
  check('after reset a relaunch loads as system', afterReset === 'system');
  check('after reset the device decides again (Arabic device)',
    pref.effectiveLocale(afterReset, ['ar-EG']) === 'ar');
  check('after reset the device decides again (English device)',
    pref.effectiveLocale(afterReset, ['en-US']) === 'en');

  /* ──────────────── 5. invalid stored values / storage failures ────────── */

  console.log('\ninvalid values and storage failures');
  const corrupt = createPreferenceStore(makeStorage({ [KEY]: 'zz-invalid' }));
  check('an unparseable stored value loads as system', (await corrupt.load()) === 'system');

  const legacy = createPreferenceStore(makeStorage({ [KEY]: 'auto' }));
  check('a legacy "auto" value loads as system', (await legacy.load()) === 'system');

  const emptyVal = createPreferenceStore(makeStorage({ [KEY]: '' }));
  check('an empty stored value loads as system', (await emptyVal.load()) === 'system');

  const readBroken = createPreferenceStore(brokenStorage());
  check('a read failure loads as system instead of throwing', (await readBroken.load()) === 'system');

  const writeBroken = createPreferenceStore(brokenStorage());
  check('a write failure resolves false (not a throw)', (await writeBroken.save('ar')) === false);

  const removeBroken = createPreferenceStore(brokenStorage());
  check('a remove failure resolves false', (await removeBroken.save('system')) === false);

  const noStorage = createPreferenceStore(null);
  check('missing storage module loads as system', (await noStorage.load()) === 'system');
  check('missing storage module reports an unpersisted save',
    (await noStorage.save('ar')) === false);

  // A broken store must never crash the app or invent a language.
  check('a broken store still yields a usable locale',
    ['ar', 'en'].includes(pref.effectiveLocale(await readBroken.load(), ['ar-EG'])));

  /* ───────────────────── 6. runtime wiring (static) ────────────────────── */

  console.log('\nruntime wiring (src/lib/i18n/index.ts)');
  const index = read('src/lib/i18n/index.ts');

  const saveIdx = index.indexOf('await preferenceStore.save(pref)');
  const publishIdx = index.indexOf('publishEffectiveLocale(pref)', saveIdx);
  check('the write happens BEFORE the locale is published (no silent mismatch)',
    saveIdx > -1 && publishIdx > saveIdx);
  check('a failed write is reported, not swallowed', /persisted/.test(index));
  check('changing language notifies subscribers (in-place repaint)',
    /notifyListeners\(\)/.test(index));
  check('runtime change never clears the session / tokens',
    !/(clearSession|signOut|logout|removeItem\(['"]@?token|AsyncStorage\.clear)/i.test(index));
  check('the provider re-resolves on foreground return while following the device',
    /AppState\.addEventListener/.test(index) && /getPreference\(\)\s*!==\s*'system'/.test(index));
  check('the restart requirement is surfaced, not hidden', /rtlNeedsRestart/.test(index));

  /* ──────────────────────────── summary ────────────────────────────────── */

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.error('\nLanguage-preference suite FAILED.');
    process.exit(1);
  }
})().catch((e) => {
  console.error('\nLanguage-preference suite crashed:', e);
  process.exit(1);
});
