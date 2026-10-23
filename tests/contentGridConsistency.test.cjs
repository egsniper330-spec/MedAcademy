#!/usr/bin/env node
/**
 * Content-grid consistency — shared design tokens over per-screen offsets.
 *
 * OBSERVED ON THE PHYSICAL TABLET (SM-T505N, 1200x2000 @240dpi, light mode):
 *   1. Notifications cards rendered on a 30px grid (hardcoded `padding: 20`
 *      dp in the ScrollView) while Home/Explore/My Courses/Course details/
 *      Contact all render on the 45px `screenPx` grid — cards visibly jumped
 *      inward on the left/right edges when navigating between screens.
 *   2. The whole info/* family (About, Privacy, Terms, Contact) rendered
 *      PageHeader INSIDE the `padding: layout.screenPx` container, floating
 *      the back button ~45px inward (x=81,y=111) while every other screen
 *      (edit-profile, security, my-devices, offline-course, notifications,
 *      course details) renders it edge-aligned at the safe-area edge
 *      (x=24..36, y=66..74) — the contract documented in PageHeader.tsx.
 *
 * WHAT THIS SUITE PINS
 *   A. notifications.tsx follows the shared screen token for horizontal grid.
 *   B. info/* screens hoist PageHeader above the padded ScrollView so the
 *      header stays edge-aligned with the rest of the app.
 *   C. No other app route reintroduces the raw `padding: 20` container grid.
 *   D. The hoisted structure keeps background continuity (wrapper carries
 *      c.base) so no transparent gap appears behind the header.
 *
 * Usage: node tests/contentGridConsistency.test.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
const failures = [];

const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL  ${label}`); }
};

/* ── A. Notifications uses the shared screen token ──────────────────────── */
console.log('A. notifications horizontal grid');
const notif = read('src/app/(app)/notifications.tsx');
ok(/paddingHorizontal:\s*layout\.screenPx/.test(notif),
  'notifications content container uses layout.screenPx');
ok(!/contentContainerStyle=\{\{\s*padding:\s*20/m.test(notif),
  'notifications no longer hardcodes padding: 20 (30px grid on tablets)');
ok(/paddingBottom:\s*20/.test(notif),
  'vertical rhythm preserved (bottom padding retained)');

/* ── B. info/* headers hoisted above padded content ─────────────────────── */
console.log('B. info/* PageHeader placement');
// The title may be a literal or an i18n key — both are the same header row.
const infoFiles = [
  ['src/app/(app)/info/about.tsx', 'About Us', "title=\\{t\\('about\\.title'\\)\\}"],
  ['src/app/(app)/info/privacy.tsx', 'Privacy Policy', "title=\\{t\\('studentProfile\\.privacy'\\)\\}"],
  ['src/app/(app)/info/terms.tsx', 'Terms & Conditions', "title=\\{t\\('studentProfile\\.terms'\\)\\}"],
  ['src/app/(app)/info/contact.tsx', 'Contact Us', "title=\\{t\\('contact\\.title'\\)\\}"],
];
for (const [rel, title, headerAttr] of infoFiles) {
  const src = read(rel);
  const headerRe = new RegExp(`<PageHeader ${headerAttr} showBack />`);
  const hdrIdx = src.search(headerRe);
  ok(hdrIdx !== -1, `${path.basename(rel)}: PageHeader title "${title}" present`);

  // hoisted: PageHeader directly precedes the content ScrollView
  const hoisted = new RegExp(`<PageHeader ${headerAttr} showBack />\\s*<ScrollView`);
  ok(hoisted.test(src),
    `${path.basename(rel)}: PageHeader immediately precedes ScrollView (edge-aligned)`);

  // NOT inside the padded content container: the padded container must open
  // after the header, i.e. header index < padded contentContainerStyle index
  const padIdx = src.indexOf('contentContainerStyle={{ padding: layout.screenPx');
  if (padIdx !== -1) {
    ok(hdrIdx < padIdx,
      `${path.basename(rel)}: header sits outside the padded container`);
  }

  // wrapper carries the background so the hoist introduces no transparent gap
  const before = src.slice(Math.max(0, hdrIdx - 220), hdrIdx);
  ok(/backgroundColor:\s*c\.base/.test(before),
    `${path.basename(rel)}: wrapper View keeps c.base background behind header`);
}

/* ── C. no route reintroduces the raw 20dp container grid ───────────────── */
console.log('C. no raw padding:20 container grid in app routes');
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
};
const offenders = walk(path.join(ROOT, 'src/app'))
  .filter((p) => /contentContainerStyle=\{\{\s*padding:\s*20/m.test(read(path.relative(ROOT, p))));
ok(offenders.length === 0,
  `no app screen uses raw padding:20 content grid${offenders.length ? ` (found: ${offenders.map((p) => path.relative(ROOT, p)).join(', ')})` : ''}`);

/* ── D. the hoist wrapper closes (tsc is the full JSX gate; here we pin
        the specific structure this change introduced) ────────────────────── */
console.log('D. structural closure');
for (const [rel] of infoFiles) {
  const src = read(rel);
  ok(/<\/ScrollView>\s*<\/View>\s*\);\s*\}\s*$/.test(src),
    `${path.basename(rel)}: hoist wrapper closes after </ScrollView>`);
  ok((src.match(/<View\b/g) || []).length - ((src.match(/<View\b[^>]*\/>/g) || []).length)
      === (src.match(/<\/View>/g) || []).length,
    `${path.basename(rel)}: <View> tags balanced incl. self-closing`);
}

/* ── E. Explore list: header outside padded list, single padding source ─── */
console.log('E. explore list structure');
const explore = read('src/app/(app)/(student)/explore.tsx');
const hdrE = explore.indexOf('<PageHeader');
const flatE = explore.indexOf('<FlatList');
ok(hdrE !== -1 && flatE !== -1 && hdrE < flatE,
  'explore: PageHeader renders above the FlatList (edge-aligned)');
ok(!/ListHeader[\s\S]{0,400}?<PageHeader/.test(explore),
  'explore: PageHeader no longer inside ListHeader (was double-padded to x=90)');
const listHeaderBlock = explore.slice(
  explore.indexOf('const ListHeader'), explore.indexOf('const ListEmpty'));
ok(!/paddingHorizontal:\s*layout\.screenPx/.test(listHeaderBlock),
  'explore: ListHeader no longer stacks a second screenPx (cards/search share one grid)');

/* ── F. repo-wide: no PageHeader after a padded content container ──────── */
console.log('F. repo-wide PageHeader placement sweep');
const walk2 = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk2(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
};
const inset = [];
for (const f of walk2(path.join(ROOT, 'src/app'))) {
  const s = read(path.relative(ROOT, f));
  const hdr = s.indexOf('<PageHeader');
  if (hdr === -1) continue;
  const pad = /contentContainerStyle=\{\{[^}]*padding(Horizontal)?:/.exec(s);
  if (pad && pad.index < hdr) inset.push(path.relative(ROOT, f));
}
ok(inset.length === 0,
  `no screen renders PageHeader inside padded content${inset.length ? ` (found: ${inset.join(', ')})` : ''}`);

console.log(`\n═══ contentGridConsistency: ${passed} passed, ${failed} failed ═══`);
if (failed) { console.log(failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
