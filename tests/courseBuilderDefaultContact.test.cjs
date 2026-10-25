#!/usr/bin/env node
/**
 * courseBuilderDefaultContact.test.cjs — "Use my default contact information"
 * must be OFFERED ONLY when the doctor actually has usable defaults.
 *
 * REPORTED: the option stayed selectable for an instructor with no default
 * contact settings, so the course inherited nothing and students saw a Subscribe
 * sheet with no doctor contact at all.
 *
 * What is pinned here:
 *   1. Availability is derived from the AUTHORITATIVE profile columns delivery
 *      reads (contact_whatsapp / contact_telegram / contact_phone) — the same
 *      ones resolveCourseContact() uses, not some other "settings" object.
 *   2. Three states, never two: `unknown` while the profile is loading (or never
 *      loaded) must NOT claim "you have no defaults", and must not be selectable
 *      either.
 *   3. A whitespace/garbage value is NOT a configured contact (the "empty object
 *      that looks configured" trap).
 *   4. The disabled state is accessible (state + hint) and visibly dimmed.
 *   5. A confirmed-missing default never overwrites manually entered course
 *      contact values.
 *
 * Run: node tests/courseBuilderDefaultContact.test.cjs
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

const builder = code(read('src/app/(app)/course-builder/[id].tsx'));
const store = code(read('src/lib/store.ts'));
const subscribe = code(read('src/lib/subscribeContact.ts'));
const resources = read('src/lib/i18n/resources.ts');

console.log('\n1. Availability comes from the columns delivery actually reads');
{
  ok('it reads the profile contact columns',
    /profile\.contact_whatsapp/.test(builder) &&
    /profile\.contact_telegram/.test(builder) &&
    /profile\.contact_phone/.test(builder));
  ok('the same channel set the Subscribe sheet resolves',
    /doc\?\.contact_whatsapp/.test(subscribe) &&
    /doc\?\.contact_telegram/.test(subscribe) &&
    /doc\?\.contact_phone/.test(subscribe));
  ok('the store declares those fields on the profile type',
    /contact_whatsapp\?: string \| null;/.test(store) &&
    /contact_telegram\?: string \| null;/.test(store) &&
    /contact_phone\?: string \| null;/.test(store));
}

console.log('\n2. Three states — "not loaded" is never reported as "missing"');
{
  ok('the state type has unknown / available / missing',
    /'unknown' \| 'available' \| 'missing'/.test(builder));
  ok('a missing/unloaded profile resolves to unknown',
    /if \(!profile \|\| isProfileLoading\) return 'unknown';/.test(builder));
  ok('the option is disabled unless the state is available',
    /const defaultContactUsable = defaultContactState === 'available';/.test(builder) &&
    /disabled: !defaultContactUsable/.test(builder));
}

console.log('\n3. Empty or unusable values do not count as configured');
{
  ok('whatsapp needs real digits (not whitespace/dashes)',
    /const wa = \(profile\.contact_whatsapp \?\? ''\)\.replace\(\/\[\^\\d\]\/g, ''\)/.test(builder) &&
    /wa\.length >= 6/.test(builder));
  ok('telegram needs a handle, not an empty string',
    /\/\^\[A-Za-z0-9_\]\{3,\}\$\/\.test\(tg\)/.test(builder));
  ok('phone needs dialable digits',
    /ph\.length >= 4/.test(builder));
}

console.log('\n4. The disabled state is visible AND accessible');
{
  ok('the pressable is disabled and marked as a radio',
    /disabled=\{opt\.disabled\}/.test(builder) &&
    /accessibilityRole="radio"/.test(builder));
  ok('assistive tech gets selected + disabled state',
    /accessibilityState=\{\{ selected, disabled: opt\.disabled \}\}/.test(builder));
  ok('the explanation is exposed as an accessibility hint',
    /accessibilityHint=\{opt\.hint \?\? undefined\}/.test(builder));
  // Dimmed remains the "unavailable" signal, but a CONFIRMED missing default is
  // additionally a red warning and keeps more contrast (0.85) so that warning
  // stays readable in both themes. A merely-disabled row is dimmed to 0.55.
  ok('the unavailable row is visibly dimmed',
    /opacity: opt\.disabled \? \(opt\.warning \? 0\.85 : 0\.55\) : 1/.test(builder));
  ok('the confirmed-missing row keeps enough contrast for its red warning',
    /opt\.warning \? 0\.85/.test(builder));
  ok('the unavailable option cannot be selected by pressing it',
    /onPress=\{\(\) => \{ if \(!opt\.disabled\) setUseDefaultContact\(opt\.value\); \}\}/.test(builder));
}

console.log('\n5. Localized copy (en + ar) for both hints');
{
  const en = (k) => new RegExp(`'${k.replace(/\./g, '\\.')}': '[^']+'`).test(resources);
  ok('MISSING hint exists in English with the required wording',
    /'cb\.contact\.useDefaultUnavailable': 'Unavailable — configure this in your Profile page'/.test(resources));
  ok('MISSING hint exists in Arabic',
    /'cb\.contact\.useDefaultUnavailable': 'غير متاحة — يمكن إعدادها من صفحة الملف الشخصي'/.test(resources));
  ok('CHECKING hint exists in both locales',
    en('cb.contact.useDefaultChecking') &&
    /'cb\.contact\.useDefaultChecking': 'جارٍ التحقق/.test(resources));
}

console.log('\n6. A confirmed-missing default switches to custom — safely');
{
  ok('the fallback runs only for a CONFIRMED missing state',
    /if \(defaultContactState !== 'missing'\) return;/.test(builder));
  ok('it never runs while the state is unknown (loading is not a decision)',
    !/defaultContactState !== 'available'[\s\S]{0,80}setUseDefaultContact\(false\)/.test(builder));
  ok('it does not touch manually entered contact values',
    !/defaultContactState[\s\S]{0,200}setContact(Whatsapp|Telegram|Phone)\(/.test(builder));
  ok('the custom-contact fields are still the ones saved for a custom course',
    /use_default_contact: useDefaultContact/.test(builder) &&
    /whatsapp: !useDefaultContact \? \(contactWhatsapp \|\| undefined\) : undefined/.test(builder));
}

console.log('\n' + (failed === 0 ? '✅' : '❌') + ` ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
