/**
 * Regression: the cold-start spinner shows localized stage messages that are
 * wired to real startup state (session restore, security verdict), and every
 * stage key exists in both the English and Arabic dictionaries.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const STAGE_KEYS = [
  'startup.restoringSession',
  'startup.verifyingSecurity',
  'startup.preparingApp',
];

test('every startup stage key exists in English and Arabic', () => {
  const src = read('src/lib/i18n/resources.ts');
  for (const key of STAGE_KEYS) {
    const occurrences = src.split(`'${key}':`).length - 1;
    assert.equal(occurrences, 2, `${key} must be defined once per locale (found ${occurrences})`);
  }
});

test('Arabic and English verifying-security copy matches the required wording', () => {
  const src = read('src/lib/i18n/resources.ts');
  assert.match(src, /'startup\.verifyingSecurity': 'Verifying app security and privacy\.\.\.'/);
  assert.match(src, /'startup\.verifyingSecurity': '\u062c\u0627\u0631\u064d \u0627\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 \u0623\u0645\u0627\u0646 \u0648\u062e\u0635\u0648\u0635\u064a\u0629 \u0627\u0644\u062a\u0637\u0628\u064a\u0642\.\.\./);
});

test('startup spinner selects its stage from real state, not a fixed string', () => {
  const src = read('src/app/index.tsx');
  assert.match(src, /useSecurity\(\)/, 'must read the security verdict');
  assert.match(src, /isLoading\s*\n?\s*\?\s*'startup\.restoringSession'/, 'session restore stage');
  assert.match(src, /session && !securityVerified\s*\n?\s*\?\s*'startup\.verifyingSecurity'/, 'security stage only while a session awaits a verdict');
  assert.match(src, /accessibilityLiveRegion="polite"/, 'stage text announced to assistive tech');
});

test('startup stage message does not run on a timer or replace the spinner', () => {
  const src = read('src/app/index.tsx');
  assert.match(src, /<ActivityIndicator size="large" color="#1E90FF" \/>/, 'existing spinner kept');
  assert.doesNotMatch(src, /setInterval|setTimeout/, 'no timer-driven stage changes');
});
