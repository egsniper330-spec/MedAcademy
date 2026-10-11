#!/usr/bin/env node
'use strict';
/**
 * websiteContactLinks.test.cjs — locks the two regressions that broke the
 * public site (medacademy.site).
 *
 * ISSUE 1 — the Contact Us page opened the wrong destinations.
 *   contact.html carried the real accounts, but js/main.js kept a duplicate
 *   CONTACT_LINKS copy and ran setAttribute('href', …) over every row at
 *   runtime, so the HTML values could never take effect. The HTML is now the
 *   single source of truth: no JS may rewrite a contact href, and the old
 *   placeholder destinations must not exist anywhere in the site.
 *
 * ISSUE 2 — the Download APK button never produced a download.
 *   Three stacked causes, two of which are code and are locked here:
 *     (a) the button shipped `hidden` and was only ever unhidden from a
 *         releases.json callback — that file 404s, so the button never
 *         appeared at all;
 *     (b) its href was the query string `https://medacademy.site?app.apk`,
 *         which returns the homepage HTML rather than a file;
 *     (c) /app.apk itself was not reachable on the host — a hosting upload,
 *         which no repository test can verify.
 *
 * These checks read the source only. They prove the markup and JS are correct;
 * they do NOT prove the button downloads on a real browser or that the host
 * serves /app.apk — those are covered in the manual/live section of the report.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGES = ['website/index.html', 'website/download.html', 'website/contact.html'];
const contactHtml = read('website/contact.html');
const downloadHtml = read('website/download.html');
const js = read('website/js/main.js');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  \u2714 ' + label); }
  else { failed++; console.log('  \u2718 ' + label); }
}
function section(n) { console.log('\n' + n); }

/* ══ 1. contact.html is the single source of truth ═══════════════════════ */
section('1. contact.html carries real, well-formed destinations');

const rows = [...contactHtml.matchAll(
  /<a class="contact-row" data-contact="([a-z]+)" href="([^"]*)"([^>]*)>/g
)].map((m) => ({ key: m[1], href: m[2], attrs: m[3] }));

ok(rows.length === 5, `five contact rows render (found ${rows.length})`);
ok(new Set(rows.map((r) => r.key)).size === rows.length,
  'no duplicate data-contact keys');

const find = (k) => rows.find((r) => r.key === k);

const EXPECTED = {
  facebook:  /^https:\/\/(www\.)?facebook\.com\/[A-Za-z0-9._-]+\/?$/,
  instagram: /^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._-]+\/?$/,
  whatsapp:  /^https:\/\/wa\.me\/\d{6,15}$/,
  telegram:  /^https:\/\/t\.me\/[A-Za-z0-9_]{3,}$/,
  email:     /^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/,
};

for (const [key, re] of Object.entries(EXPECTED)) {
  const row = find(key);
  ok(!!row, `${key}: row present`);
  if (row) ok(re.test(row.href), `${key}: href is a real destination (${row.href})`);
}

// Every external channel keeps the safe rel/target it had before.
for (const key of ['facebook', 'instagram', 'whatsapp', 'telegram']) {
  const row = find(key);
  if (!row) continue;
  ok(/target="_blank"/.test(row.attrs) && /rel="noopener noreferrer"/.test(row.attrs),
    `${key}: opens externally with noopener noreferrer`);
}
ok(!/target=/.test(find('email').attrs), 'email: stays in the same tab (mailto:)');

/* ══ 2. no JS may rewrite a contact href ══════════════════════════════════ */
section('2. main.js does not override the contact hrefs');

ok(!/\b(?:let|const|var)\s+CONTACT_LINKS\b/.test(js),
  'the duplicate CONTACT_LINKS map is gone');

const cStart = js.indexOf("querySelectorAll('.contact-row");
const cEnd = js.indexOf('});', cStart);
const contactBlock = cStart === -1 ? '' : js.slice(cStart, cEnd === -1 ? js.length : cEnd);
ok(cStart !== -1, 'the contact block still exists (progressive enhancement kept)');
ok(!/setAttribute\('href'/.test(contactBlock),
  'the contact block writes NO href — it may only add aria-label');
ok(/aria-label/.test(contactBlock), 'the email row still gets its accessible label');

// The exact placeholder values that were being applied at runtime must be gone.
const PLACEHOLDERS = [
  "facebook:  'https://facebook.com'",
  "instagram: 'https://instagram.com'",
  "whatsapp:  'https://wa.me/'",
  "telegram:  'https://t.me/'",
];
for (const p of PLACEHOLDERS) {
  ok(!PAGES.concat('website/js/main.js').some((f) => read(f).includes(p)),
    `placeholder removed: ${p.trim()}`);
}

/* ══ 3. the Download APK button is a real direct link ═════════════════════ */
section('3. download.html: direct, visible APK link');

const apkTag = (downloadHtml.match(/<a[^>]*id="androidApk"[^>]*>/) || [''])[0];
ok(apkTag.length > 0, '#androidApk anchor present');
ok(!/\shidden(\s|>)/.test(apkTag), 'the button is NOT hidden (no JS gate)');

const apkHref = (apkTag.match(/href="([^"]*)"/) || [])[1] || '';
ok(apkHref.length > 0, 'the button has an href');
ok(apkHref === '/app.apk' || apkHref === 'https://medacademy.site/app.apk',
  `href is the same-origin APK path (${apkHref})`);
ok(!/\?app\.apk/.test(apkHref), 'href is NOT the malformed query string ?app.apk');
ok(!/#$/.test(apkHref) && apkHref !== '#', 'href is NOT the empty "#" placeholder');
ok(/^https?:\/\//.test(apkHref) === apkHref.startsWith('http') && apkHref.startsWith('/'),
  'href is root-relative, so it cannot cross origin');
ok(/download="[^"]+\.apk"/.test(apkTag), 'a download attribute names the saved file');
ok(!/target="_blank"/.test(apkTag), 'no target=_blank — the file downloads, it does not open a tab');
ok(!/releases\.json/.test(apkTag), 'the markup does not depend on a release manifest');

section('4. main.js treats releases.json as an optional enhancement');
const aStart = js.indexOf("getElementById('androidApk')");
const apkBlock = aStart === -1 ? '' : js.slice(aStart, aStart + 900);
ok(aStart !== -1, 'the APK enhancement block still exists');
ok(!/\.hidden\s*=\s*(true|false)/.test(apkBlock),
  'the APK block never toggles .hidden — it can no longer hide the button');
ok(/releases\.json/.test(apkBlock), 'a version manifest is still honoured when present');

/* ══ 5. cache-busting so a stale main.js cannot resurrect either bug ══════ */
section('5. the behavioural script is cache-busted on every page');
for (const page of PAGES) {
  const html = read(page);
  ok(/<script src="js\/main\.js\?v=[^"]+"><\/script>/.test(html),
    `${page.replace('website/', '')}: js/main.js is loaded with a ?v= cache-buster`);
}

section('6. surrounding behaviour preserved');
ok(/⬇ Download APK/.test(downloadHtml), 'the button label is unchanged');
ok((downloadHtml.match(/id="androidApk"/g) || []).length === 1,
  'exactly one APK button (no duplicate controls)');
// Count real rows only — the explanatory comment above the list also
// mentions <a class="contact-row">, so the raw string is not enough.
ok((contactHtml.match(/<a class="contact-row" data-contact=/g) || []).length === 5,
  'contact rows unchanged in count — layout untouched');

/* ══ verdict ═════════════════════════════════════════════════════════════ */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
