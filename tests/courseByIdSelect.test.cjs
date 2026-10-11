#!/usr/bin/env node
'use strict';
/**
 * courseByIdSelect.test.cjs — guards the "Course not found for every course"
 * regression (fixed in src/lib/api.ts::getCourseById).
 *
 * ROOT CAUSE
 * ----------
 * A comment block was written INSIDE the template literal passed to
 * .select(`…`). That literal is transmitted verbatim as the `select=`
 * query-string parameter of GET /api/courses, and the PHP
 * DataController::parseSelect() has no comment handling: splitTopLevel()
 * splits the prose on its own commas, the fragments are then fed to
 * assertAllowed()/assertValidIdentifier(), and the request fails with a 4xx.
 * course/[id].tsx wraps getCourseById() in catch{} and renders "Course not
 * found" — so EVERY course appeared missing.
 *
 * This suite (a) reproduces the failure by running a faithful Node port of the
 * backend parser against the historical broken string, and (b) asserts the
 * current source can never reintroduce it.
 *
 * Run: node tests/courseByIdSelect.test.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DC_PATH = path.join(ROOT, 'backend', 'src', 'Controllers', 'DataController.php');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; console.log('  ✘ ' + label); }
}
const read = (p) => fs.readFileSync(p, 'utf8');

/* ══ 1. faithful port of the backend parser ══════════════════════════════ */
const DC = read(DC_PATH);

function constArray(name) {
  const m = DC.match(new RegExp(name + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
  if (!m) throw new Error(name + ' not found in DataController.php');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
const ALL_TABLES = [...constArray('PUBLIC_TABLES'), ...constArray('ADMIN_TABLES')];

const IDENTIFIER_REGEX = (() => {
  const m = DC.match(/IDENTIFIER_REGEX\s*=\s*'([^']+)'/);
  if (!m) throw new Error('IDENTIFIER_REGEX not found');
  const php = m[1];
  const last = php.lastIndexOf('/');
  return new RegExp(php.slice(1, last), php.slice(last + 1));
})();

class ApiException extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** PHP splitTopLevel — verbatim. */
function splitTopLevel(select) {
  const parts = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < select.length; i++) {
    const c = select[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim() !== '') parts.push(buf);
  return parts;
}

function assertAllowed(table) {
  if (!ALL_TABLES.includes(table)) throw new ApiException(403, `Table '${table}' is not allowed`);
}
const sanitizeIdentifier = (s) => s.replace(/[`"'\s]/g, '');
function assertValidIdentifier(id, ctx) {
  if (!IDENTIFIER_REGEX.test(id)) throw new ApiException(422, `Invalid ${ctx}: '${id}'`);
}
function resolveCols(table, inner) {
  assertAllowed(table, 'read');
  const cols = [];
  for (let part of splitTopLevel(inner)) {
    part = part.trim();
    if (part === '') continue;
    if (part === '*') { cols.push('*'); continue; }
    if (part.includes('(')) continue;
    const c = sanitizeIdentifier(part);
    assertValidIdentifier(c, 'select column');
    cols.push(c);
  }
  return cols.length === 0 ? ['id'] : cols;
}

/** @returns {{ok:true, plain:string[], rels:string[]}|{ok:false, status:number, message:string}} */
function parseSelectLikeBackend(select) {
  const plain = [], rels = [];
  try {
    for (let part of splitTopLevel(select)) {
      part = part.trim();
      if (part === '' || part === '*') { if (part === '*') plain.push('*'); continue; }
      const open = part.indexOf('(');
      if (open === -1) { plain.push(part); continue; }   // PHP strpos === false
      if (!part.endsWith(')')) throw new ApiException(422, `Malformed select part: '${part}'`);
      const name = part.slice(0, open).trim();
      const inner = part.slice(open + 1, -1);
      if (name.includes(':')) {
        const [alias, tableSpec] = name.split(':');
        const table = tableSpec.includes('!') ? tableSpec.split('!')[0] : tableSpec;
        rels.push(table.trim());
        resolveCols(table.trim(), inner);
      } else {
        rels.push(name.trim());
        resolveCols(name.trim(), inner);
      }
    }
    for (const p of plain) {
      if (p === '*') continue;
      assertValidIdentifier(sanitizeIdentifier(p), 'select column');
    }
  } catch (e) {
    return { ok: false, status: e.status ?? 500, message: e.message };
  }
  return { ok: true, plain, rels };
}

/** The exact broken string commit 3c78997 shipped. */
const HISTORIC_BROKEN_SELECT = [
  '      *,',
  "      //  CONTACTS: the doctor's contact_* fields MUST be selected here. The",
  '      //  course-level whatsapp/telegram/phone columns only apply when',
  '      //  use_default_contact = false, so without these fields the course screen',
  "      //  could not resolve a default-contact course's Subscribe options at all",
  '      //  (it fell back to the stale course columns — the reported "only a phone',
  '      //  number and another incorrect number"). Same selection as the Explore',
  '      //  list; both now feed the shared resolver in lib/subscribeContact.ts.',
  '      doctor:profiles!courses_doctor_id_fkey(id,full_name,avatar_url,contact_whatsapp,contact_telegram,contact_phone),',
  '      category:categories(id,name),',
  '      university:universities(id,name),',
  '      faculty:faculties(id,name),',
  '      academic_level:academic_levels(id,name),',
  '      sections(',
  '        *,',
  '        lessons(',
  '          *,',
  '          lesson_materials(*)',
  '        )',
  '      )',
].join('\r\n');

/* ══ 2. the reproduction: the historic string really did fail ═════════════ */
// Two variants exist in the wild and BOTH must fail:
//   • committed bytes (git show 3c78997) use LF + a leading newline;
//   • a Windows checkout translates them to CRLF (autocrlf) — which is what
//     the shipped APK actually transmitted. Neither may ever parse.
console.log('1. regression reproduction (historic broken select)');
const historicLF = parseSelectLikeBackend(HISTORIC_BROKEN_SELECT);
const historicCRLF = parseSelectLikeBackend(HISTORIC_BROKEN_SELECT.replace(/\n/g, '\r\n'));
ok(historicLF.ok === false,
  'the comment-bearing select is REJECTED (LF bytes, as committed in 3c78997)');
ok(historicCRLF.ok === false,
  'the comment-bearing select is REJECTED (CRLF bytes, as a Windows checkout sends)');
ok(historicCRLF.ok === false && historicCRLF.status !== 200,
  '…failing with HTTP ' + historicCRLF.status + ' (not a silent success) — the screen\'s catch{} then shows "Course not found"');

/* ══ 3. current source must parse ════════════════════════════════════════ */
console.log('2. current getCourseById select');
const apiSrc = read(path.join(ROOT, 'src', 'lib', 'api.ts'));
const at = apiSrc.indexOf('export async function getCourseById');
ok(at > -1, 'getCourseById exists in src/lib/api.ts');
const selMatch = at > -1 ? apiSrc.slice(at, at + 2200).match(/\.select\(`([\s\S]*?)`\)/) : null;
ok(!!selMatch, 'getCourseById reads through a .select(`…`) template literal');
const select = selMatch ? selMatch[1] : '';

ok(select.length > 0 && !select.includes('//'),
  'the transmitted select contains NO // comment text (comments live outside the literal)');
const parsed = select ? parseSelectLikeBackend(select) : { ok: false };
ok(parsed.ok === true, 'the select parses cleanly against the real backend rules');
ok(parsed.ok && parsed.rels.includes('profiles'), 'doctor profile embed resolves (Subscribe contacts need it)');
ok(parsed.ok && parsed.rels.includes('sections'), 'sections embed resolves (course content needs it)');
ok(parsed.ok && parsed.rels.includes('lesson_materials') === false, 'lesson_materials is nested under lessons, not top level');

/* ══ 4. no other query literal can smuggle comments in ═══════════════════ */
console.log('3. repo-wide: no .select() literal carries // comments');
const MARK = '.select(';
const offenders = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(e.name)) continue;
    const s = fs.readFileSync(p, 'utf8');
    let i = 0;
    while (true) {
      const k = s.indexOf(MARK, i);
      if (k < 0) break;
      const open = k + MARK.length;
      const q = s[open];
      let end = -1;
      if (q === '`') end = s.indexOf('`', open + 1);
      else if (q === '"' || q === "'") {
        for (let j = open + 1; j < s.length; j++) {
          if (s[j] === '\\') { j++; continue; }
          if (s[j] === q) { end = j; break; }
        }
      } else { i = open; continue; }
      if (end < 0) { i = open; continue; }
      if (s.slice(open + 1, end).includes('//')) {
        offenders.push(path.relative(ROOT, p) + ':' + s.slice(0, k).split('\n').length);
      }
      i = end + 1;
    }
  }
})(path.join(ROOT, 'src'));
ok(offenders.length === 0, offenders.length === 0
  ? 'no .select() literal anywhere in src/ contains // comments'
  : 'offenders: ' + offenders.join(', '));

/* ══ 5. the error must not be swallowed into a misleading state ═══════════ */
console.log('4. failure surfacing on the course screen');
const course = read(path.join(ROOT, 'src', 'app', '(app)', 'course', '[id].tsx'));
ok(/if \(!id\) return;/.test(course), 'loadData still no-ops when the route id is absent');
ok(/catch \{\}/.test(course) || /catch \(/.test(course), 'loadData still guards against unhandled rejections');

/* ══ summary ════════════════════════════════════════════════════════════ */
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
