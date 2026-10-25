#!/usr/bin/env node
/**
 * supportContactFlows.test.cjs — Subscribe contact unification + Support
 * Settings save/read regression.
 *
 * ── P2 root cause (pinned here) ──────────────────────────────────────────────
 * TWO Subscribe implementations existed:
 *   • Explore → `resolveContact()` (honours use_default_contact) + SubscribeSheet
 *   • course details → legacy ContactSheet fed straight from the course-LEVEL
 *     whatsapp/telegram/phone columns, ignoring use_default_contact — and
 *     getCourseById() did not even SELECT the doctor's contact fields, so a
 *     default-contact course resolved to stale course numbers ("only a phone
 *     number and another incorrect number").
 * Both screens now share ONE resolver and ONE sheet.
 *
 * ── P3 root cause (pinned here) ──────────────────────────────────────────────
 * The admin endpoint validated the values BEFORE normalizing them, and its
 * validator rejected the exact formats the admin UI advertises
 * ('+1 555 000 0000' with spaces; 't.me/username' with a slash) → HTTP 422 →
 * "Failed to save WhatsApp/Telegram". Website passed because its validation is
 * lenient. `canonicalize()` now maps the documented formats first, and the
 * screen surfaces the server message.
 *
 * Run: node tests/supportContactFlows.test.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failures.push(msg); console.error('  ✗ ' + msg); }
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// ── Compile the pure resolver module and exercise the REAL code ──────────────
const ts = require(path.join(ROOT, 'node_modules', 'typescript'));
function loadResolver() {
  const src = read('src/lib/subscribeContact.ts');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  return mod.exports;
}
const R = loadResolver();

console.log('── Resolver: use_default_contact decides whose contacts are used ──');
{
  const doctor = { id: 'd1', full_name: 'Dr', contact_whatsapp: '+201000000001', contact_telegram: '@doc_tg', contact_phone: '+201000000002' };

  const defaultCourse = { id: 'c1', doctor, use_default_contact: null, whatsapp: '+209999999999', telegram: '@stale', phone: '+209999999998' };
  const r1 = R.resolveCourseContact(defaultCourse);
  ok(r1.whatsapp === '+201000000001' && r1.telegram === '@doc_tg' && r1.phone === '+201000000002',
    'use_default_contact = null (default) → the DOCTOR contacts win, never the course columns');

  const explicit = { id: 'c2', doctor, use_default_contact: true, whatsapp: '+209999999999', telegram: '@stale', phone: '+209999999998' };
  const r2 = R.resolveCourseContact(explicit);
  ok(r2.whatsapp === '+201000000001' && r2.telegram === '@doc_tg' && r2.phone === '+201000000002',
    'use_default_contact = true → the DOCTOR contacts win');

  const own = { id: 'c3', doctor, use_default_contact: false, whatsapp: '+201111111111', telegram: '@own', phone: '+201222222222' };
  const r3 = R.resolveCourseContact(own);
  ok(r3.whatsapp === '+201111111111' && r3.telegram === '@own' && r3.phone === '+201222222222',
    'use_default_contact = false → the COURSE contacts win (documented override preserved)');

  // The PHP data adapter preserves joined rows as arrays for legacy shapes.
  const arrayDoctor = { id: 'c4', doctor: [doctor], use_default_contact: true };
  ok(R.resolveCourseContact(arrayDoctor).whatsapp === '+201000000001',
    'array-shaped doctor relation resolves identically (adapter compatibility)');

  ok(!R.hasAnyContact(R.resolveCourseContact({ id: 'c5', use_default_contact: true, doctor: null })),
    'no doctor + no course contacts → hasAnyContact() false (the sheet then falls back to Super Admin contacts)');
  ok(R.hasAnyContact({ whatsapp: '+201000000001' }), 'hasAnyContact() true for a single usable contact');
  ok(!R.hasAnyContact({ whatsapp: '   ' }), 'whitespace-only values are treated as absent (disabled flag respected)');
}

console.log('── URL builders: only safe, correct destinations ──');
{
  ok(R.contactUrl('whatsapp', '+20 102 108 2886') === 'https://wa.me/201021082886',
    'whatsapp: spaces and the leading + are stripped (wa.me takes digits only)');
  ok(R.contactUrl('whatsapp', '00201021082886') === 'https://wa.me/00201021082886',
    'whatsapp: a stored number is never mangled beyond scheme-safe digits');
  ok(R.contactUrl('telegram', '@Eg_SNIPER') === 'https://t.me/Eg_SNIPER', 'telegram: @handle → t.me/handle');
  ok(R.contactUrl('telegram', 't.me/Eg_SNIPER') === 'https://t.me/Eg_SNIPER', 'telegram: bare t.me/handle accepted');
  ok(R.contactUrl('telegram', 'https://t.me/Eg_SNIPER') === 'https://t.me/Eg_SNIPER', 'telegram: full https URL passes through');
  ok(R.contactUrl('phone', '+20 102 108 2886') === 'tel:+201021082886', 'phone: formatted number → tel:+E164');
  ok(R.contactUrl('email', 'support@medacademy.site') === 'mailto:support@medacademy.site', 'email → mailto:');
  ok(R.contactUrl('email', 'not-an-email') === null, 'email: invalid address renders nothing');
  ok(R.contactUrl('x', '@medacademy') === 'https://x.com/medacademy', 'x: @handle → x.com/handle');
  ok(R.contactUrl('x', 'twitter.com/medacademy') === 'https://x.com/medacademy', 'x: twitter.com/handle accepted');
  ok(R.contactUrl('website', 'medacademy.site') === 'https://medacademy.site', 'website: bare domain gets https://');
  ok(R.contactUrl('website', 'https://medacademy.site/contact.html') === 'https://medacademy.site/contact.html',
    'website: full URL passes through unchanged');

  // Scheme safety — a stored value must never inject another scheme.
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'intent://x']) {
    ok(R.contactUrl('website', bad) === null, `website: refuses ${bad}`);
  }
  ok(R.contactUrl('phone', 'x') === null, 'phone: non-numeric value renders nothing');
  ok(R.contactUrl('whatsapp', '') === null && R.contactUrl('telegram', null) === null,
    'empty / null contact values render nothing');

  // Super Admin public list mapping.
  ok(R.supportPlatformKey('whatsapp') === 'whatsapp' && R.supportPlatformKey('website') === 'website',
    'supportPlatformKey maps the public endpoint keys');
  ok(R.supportPlatformKey('discord') === null, 'supportPlatformKey ignores unknown platforms');
  ok(R.safeSupportUrl('https://wa.me/201021082886') === 'https://wa.me/201021082886', 'safeSupportUrl accepts https');
  ok(R.safeSupportUrl('tel:+201021082886') === 'tel:+201021082886', 'safeSupportUrl accepts tel:');
  ok(R.safeSupportUrl('mailto:a@b.com') === 'mailto:a@b.com', 'safeSupportUrl accepts mailto:');
  ok(R.safeSupportUrl('javascript:alert(1)') === null, 'safeSupportUrl refuses javascript:');
  ok(R.safeSupportUrl('') === null, 'safeSupportUrl refuses empty');

  ok((R.SUBSCRIBE_CONTACT_ORDER || []).includes('email') &&
     (R.SUBSCRIBE_CONTACT_ORDER || []).includes('x') &&
     (R.SUBSCRIBE_CONTACT_ORDER || []).includes('website'),
    'the sheet can render WhatsApp, Telegram, phone, email, X/Twitter and website');
}

console.log('── ONE shared flow: both Subscribe entry points use it ──');
{
  ok(exists('src/lib/subscribeContact.ts'), 'src/lib/subscribeContact.ts exists (single resolver)');
  ok(!exists('src/components/ContactSheet.tsx'),
    'the legacy duplicate ContactSheet is deleted (no second contact UI)');

  const course = read('src/app/(app)/course/[id].tsx');
  ok(/from '@\/components\/SubscribeSheet'/.test(course), 'course details renders the shared SubscribeSheet');
  ok(!/<ContactSheet/.test(course) && !/from '@\/components\/ContactSheet'/.test(course),
    'course details no longer renders the legacy ContactSheet');
  ok(/contact=\{resolveCourseContact\(course\)\}/.test(course),
    'course details resolves via the shared resolver (use_default_contact honoured)');
  ok(!/course\.whatsapp \|\| course\.telegram \|\| course\.phone/.test(course),
    'course details no longer gates the Subscribe action on the stale course-level columns');
  ok(/\{\!previewMode && \!isSubscribed \? \(/.test(course),
    'course details offers Subscribe whenever the viewer is not a subscriber (the sheet reports the empty state)');

  const explore = read('src/app/(app)/(student)/explore.tsx');
  ok(/from '@\/lib\/subscribeContact'/.test(explore), 'Explore imports the shared resolver');
  ok(/resolveCourseContact\(item\)/.test(explore), 'Explore resolves via the shared resolver');
  ok(!/^function resolveContact\(/m.test(explore), 'the private duplicate resolver is gone from Explore');

  // The shared sheet is the only implementation.
  const sheet = read('src/components/SubscribeSheet.tsx');
  ok(/getPublicSupportContacts/.test(sheet),
    'the sheet falls back to the Super Admin support contacts when nothing is configured');
  ok(/safeSupportUrl/.test(sheet) && /contactUrl/.test(sheet),
    'every rendered destination is built/validated by the shared helpers');
  // The three states are still distinct AND every one of them is translated
  // (the sheet used to render hardcoded English under an Arabic UI).
  ok(/course\.subscribeSheetLoading/.test(sheet) && /course\.subscribeSheetEmpty/.test(sheet) &&
     /course\.subscribeSheetError/.test(sheet),
    'loading, empty and error states are all present');
  ok(/course\.subscribeSheetTitle/.test(sheet) && /course\.subscribeSheetHint/.test(sheet),
    'the sheet title and hint are localized, not hardcoded English');
  ok(/direction: isRTL \? 'rtl' : 'ltr'/.test(sheet),
    'the sheet lays itself out for the active locale (RTL mirrors rows and icons)');
  ok(/CONTACT_LABEL_KEYS/.test(sheet),
    'contact channel labels go through the dictionary while custom labels stay data');
  ok(/onPress=\{retry\}/.test(sheet), 'the error state offers a retry (no silent failure)');
  ok(!/\+?\d{9,}/.test(sheet.replace(/\/\/[^\n]*/g, '')), 'no hardcoded phone number anywhere in the sheet');
}

console.log('── getCourseById must select the doctor contact fields ──');
{
  const api = read('src/lib/api.ts');
  const m = api.match(/export async function getCourseById[\s\S]*?\.single\(\)/);
  ok(!!m, 'getCourseById located');
  const body = m ? m[0] : '';
  ok(/doctor:profiles!courses_doctor_id_fkey\([^)]*contact_whatsapp[^)]*contact_telegram[^)]*contact_phone[^)]*\)/.test(body),
    'getCourseById selects the doctor contact_whatsapp/contact_telegram/contact_phone fields');
  ok(/use_default_contact/.test(body) || /\*/.test(body),
    'getCourseById still returns the course-level columns + use_default_contact (star select)');
}

console.log('── P3: the admin validator accepts the formats the UI advertises ──');
const BS = String.fromCharCode(92); // '' — avoids double-escaping confusion in regex needles
{
  const ctrl = read('backend/src/Controllers/SupportController.php');

  ok(/private function canonicalize\(string \$key, string \$value\): string/.test(ctrl),
    'SupportController has a canonicalize() step');
  ok(/\$value = \$this->canonicalize\(\$key, \$value\);\s*\n\s*\/\/ Validate the value/.test(ctrl) ||
     /\$value = \$this->canonicalize\(\$key, \$value\);[\s\S]{0,200}\$this->validateValue\(\$key, \$value\)/.test(ctrl),
    'canonicalize() runs BEFORE validateValue() (the reported 422 cause)');

  // WhatsApp placeholder: '+1 555 000 0000' (spaces) must survive.
  ok(ctrl.includes(`preg_replace('/${BS}s+/', '', $value)`),
    'all whitespace is stripped first — the "+1 555 000 0000" placeholder validates');
  ok(/case 'whatsapp':/.test(ctrl) && /wa\\\.me\|api\\\.whatsapp\\\.com/.test(ctrl),
    'whatsapp accepts a wa.me / api.whatsapp.com link as well as a raw number');
  ok(ctrl.includes(`$number = preg_replace('/[^${BS}d+]/', '', $value)`),
    'whatsapp formatting characters are stripped from raw numbers');
  ok(/return \$number !== '' \? \$number : \$value;/.test(ctrl),
    'an unparseable whatsapp value is passed through so the validator returns a REAL error, never a silent empty save');

  // Telegram hint: 'Enter a @username, t.me/username, or full Telegram URL'.
  ok(/'telegram'\s*=>\s*\['telegram\.me\/', 't\.me\/'\]/.test(ctrl),
    'telegram accepts the documented t.me/username form (the slash used to 422)');
  ok(/return ltrim\(\$value, '@\/'\);/.test(ctrl), 'handles are reduced to a canonical value before validation');
  ok(/'x'\s*=>\s*\['twitter\.com\/', 'x\.com\/'\]/.test(ctrl), 'x/twitter accepts x.com/ and twitter.com/ forms');
  ok(/'facebook'\s*=>\s*\[/.test(ctrl) && /'instagram'\s*=>\s*\[/.test(ctrl),
    'facebook/instagram accept their documented URL forms too');
  ok(/case 'phone':[\s\S]{0,400}preg_replace/.test(ctrl) && ctrl.includes(`preg_replace('/${BS}D/', '', $value)`),
    'phone strips spaces/dashes/parentheses before the digits-only check');

  // The public read path stays unauthenticated + enabled-only.
  ok(/public function publicContact\(Request \$request\): void/.test(ctrl), 'publicContact() exists (no auth)');
  ok(/WHERE `enabled` = 1/.test(ctrl), 'the public endpoint returns ONLY enabled contacts');
  ok(/if \(\$value === ''\) \{\s*\n\s*continue;/.test(ctrl), 'the public endpoint skips empty values');

  // No silent failures on the admin screen: surface the server message.
  const screen = read('src/app/(app)/(hubs)/sa-support-settings.tsx');
  ok(/catch \(e: unknown\)/.test(screen) && /serverMsg/.test(screen),
    'the admin screen surfaces the server validation message instead of a bare "Failed to save"');
  ok(!/setDrafts\(defaultDrafts\(\)\)/.test(screen.replace(/const \[drafts[^\n]*/g, '')),
    'a failed save never wipes the drafts (unsaved form values are preserved)');

  // The block screen keeps its own retry + honest error copy.
  const warn = read('src/app/(app)/security-warning.tsx');
  ok(/setSupportError\(true\)/.test(warn) && /loadSupportContacts/.test(warn),
    'the blocked screen distinguishes a fetch failure from "not configured" and can retry');
  const php = read('src/client/php.ts');
  ok(/LOCK_EXEMPT_PREFIXES[\s\S]{0,400}'\/support\/contact'/.test(php),
    'the security lock exempts /support/contact so the blocked screen can always load it');
}

console.log(failed_line());
function failed_line() {
  return failures.length
    ? `\nRESULT: ${passed} passed, ${failures.length} failed`
    : `\nPASS: ${passed} subscribe/support-contact checks`;
}
process.exit(failures.length ? 1 : 0);
