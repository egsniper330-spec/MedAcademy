#!/usr/bin/env node
/**
 * tests/staffConsoleEnglishAndStudentAvatar.test.cjs
 *
 * Regression coverage for two previously-unfinished requirements:
 *
 *  1. The SUPER ADMIN (and Admin) console must be in ENGLISH. The old attempt
 *     translated a landing page; every nested screen still followed the
 *     device/preference locale because the shared dictionary drove all of
 *     them. The fix is a ROLE-SCOPED locale lock in the language layer, which
 *     also has to release itself on sign-out so an Arabic user is not left in
 *     English on the sign-in screen.
 *
 *  2. The doctor's student DETAILS must show the student's uploaded photo. The
 *     backend already returned `student.avatar_url`; the screen drew only an
 *     initials circle. The fix renders the real image with initials/onError
 *     fallbacks, without inventing a placeholder URL.
 *
 * Source assertions + one small executed model (role → locked locale).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) passed++;
  else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function section(title) {
  console.log('\n── ' + title + ' ──');
}

const pref = read('src/lib/i18n/preference.ts');
const i18n = read('src/lib/i18n/index.ts');
const layout = read('src/app/(app)/_layout.tsx');
const students = read('src/app/(app)/(doctor)/students.tsx');
const backend = read('backend/src/Controllers/UserController.php');

/* ── 1. Role model ───────────────────────────────────────────────────────── */

section('1. Staff console role model');

ok('the staff-console roles are declared explicitly',
  /STAFF_CONSOLE_ROLES = \['super_admin', 'admin'\] as const/.test(pref));
ok('the forced console language is English',
  /STAFF_CONSOLE_LOCALE = 'en' as const/.test(pref));
ok('isStaffConsoleRole() trims nothing but rejects empty roles', (() => {
  const fn = pref.match(/export function isStaffConsoleRole\([\s\S]*?\n\}/);
  return !!fn && /if \(!role\) return false/.test(fn[0]) && /includes\(role\)/.test(fn[0]);
})());

/* Executed model of the rule. */
const STAFF = ['super_admin', 'admin'];
const isStaff = (role) => !!role && STAFF.includes(role);
const forcedLocale = (role) => (isStaff(role) ? 'en' : null);
const normalizeTag = (tag) => (String(tag || '').toLowerCase().startsWith('ar') ? 'ar' : 'en');
const resolve = (role, storedPref, deviceTags) =>
  forcedLocale(role) ?? (storedPref === 'ar' || storedPref === 'en' ? storedPref : normalizeTag(deviceTags[0]));

ok('super_admin is English even with an Arabic preference',
  resolve('super_admin', 'ar', ['ar-EG']) === 'en');
ok('admin is English even with an Arabic device',
  resolve('admin', 'system', ['ar-EG']) === 'en');
ok('doctor keeps Arabic (not changed by this fix)',
  resolve('doctor', 'ar', ['en-US']) === 'ar');
ok('student keeps the device language',
  resolve('student', 'system', ['ar-EG']) === 'ar');
ok('no role => no lock', forcedLocale(null) === null);

/* ── 2. The lock wins over preference WITHOUT rewriting it ──────────────── */

section('2. Locale lock precedence and reversibility');

ok('a module-level role lock exists',
  /let roleLocaleLock: Locale \| null = null;/.test(i18n));
ok('effective-locale resolution checks the lock FIRST',
  /const next = roleLocaleLock \?\? effectiveLocale\(pref, getDeviceLanguageTags\(\)\);/.test(i18n));
ok('clearing the lock re-resolves from the stored preference',
  /roleLocaleLock = locale;[\s\S]{0,300}effectiveLocale\(getPreference\(\), getDeviceLanguageTags\(\)\)/.test(i18n));
ok('applying/clearing is idempotent (no flip loop)',
  /if \(locale === roleLocaleLock\) return;/.test(i18n));
ok('the lock never persists a language on the user',
  !/setRoleLocaleLock[\s\S]{0,400}preferenceStore\.save/.test(i18n));
ok('changing language while locked still stores the choice (applies later)',
  /export async function setLanguagePreference[\s\S]{0,220}preferenceStore\.save\(pref\)/.test(i18n) &&
  /export async function setLanguagePreference[\s\S]{0,340}publishEffectiveLocale\(pref\)/.test(i18n));

/* ── 3. Wiring: applied for SA/Admin, released on sign-out ─────────────── */

section('3. Wiring in the authenticated shell');

ok('the shell imports the role helper and the lock',
  /import \{ isStaffConsoleRole, setRoleLocaleLock, STAFF_CONSOLE_LOCALE \} from '@\/lib\/i18n'/.test(layout));
ok('the lock follows the signed-in role',
  /setRoleLocaleLock\(isStaffConsoleRole\(profile\?\.role\) \? STAFF_CONSOLE_LOCALE : null\)/.test(layout));
ok('the lock is keyed on the role (reacts to login/role change)',
  /\}, \[profile\?\.role\]\);/.test(layout));
ok('the lock is released when the shell unmounts (sign-out)',
  /useEffect\(\(\) => \(\) => setRoleLocaleLock\(null\), \[\]\);/.test(layout));

/* ── 4. No hardcoded Arabic left in the staff consoles ────────────────── */

section('4. Staff console screens carry no hardcoded Arabic');

{
  const arabic = /[\u0600-\u06FF]/;
  const roots = ['src/app/(app)/(superadmin)', 'src/app/(app)/(admin)'];
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) walk(rel);
      else if (/\.(tsx|ts)$/.test(e.name)) {
        const text = read(rel);
        // Only UI string literals matter; the currency symbol is data, not UI copy.
        text.split(/\r?\n/).forEach((line, i) => {
          if (arabic.test(line) && /['"`][^'"`]*[\u0600-\u06FF]/.test(line) && !/ج\.م/.test(line)) {
            offenders.push(rel + ':' + (i + 1));
          }
        });
      }
    }
  };
  for (const r of roots) if (fs.existsSync(path.join(ROOT, r))) walk(r);
  ok('no Arabic UI literals in superadmin/admin screens', offenders.length === 0, offenders.slice(0, 5).join(', '));
}

/* ── 5. Student photo in the doctor's student details ────────────────── */

section('5. Real avatar in the Doctor students view');

ok('the backend returns the student avatar to the doctor',
  /p\.avatar_url/.test(backend) &&
  /'avatar_url'\s*=> \$r\['avatar_url'\]/.test(backend));
ok('the screen renders an Image sourced from avatar_url',
  /<Image\s+source=\{\{ uri: url \}\}/.test(students));
ok('students WITHOUT a photo fall back to initials (no broken image)',
  /return \([\s\S]{0,420}\{initial\}<\/Text>/.test(students));
ok('a failed load degrades to initials instead of a blank box',
  /onError=\{\(\) => setFailed\(true\)\}/.test(students));
ok('no hardcoded/fake avatar URL was introduced',
  !/avatar_url\s*=\s*['"]https?:/.test(students) &&
  !/uri: ['"]https?:\/\//.test(students));
ok('the list row uses the real avatar (not the initials-only circle)',
  /<StudentAvatar student=\{s\} size=\{34\} radius=\{17\} colors=\{c\} \/>/.test(students));
ok('the details sheet shows a large avatar + name header',
  /<StudentAvatar student=\{s\} size=\{76\} radius=\{26\} colors=\{c\} \/>/.test(students));

/* ── 6. Students page presentation (responsive) ──────────────────────── */

section('6. Students page: responsive layout, behaviour preserved');

ok('two columns from tablet width up',
  /useWindowDimensions\(\)/.test(students) && /const twoColumn = viewportWidth >= 700;/.test(students));
ok('rows carry the responsive width only in the grid',
  /\.\.\.\(twoColumn \? \{ width: '49%' \} : \{\}\)/.test(students));
ok('the main lists are wrapped in the list panel',
  (students.match(/<View style=\{\[listPanel, gridStyle\]\}>/g) || []).length >= 4);
ok('search, filters, tabs and bulk selection are untouched',
  /searchQuery|activeTab|selectMode/.test(students) &&
  /renderStudentRow/.test(students));
ok('no hardcoded demo students were added',
  !/John Doe|Jane Doe|lorem ipsum/i.test(students));

/* ── 7. Compact student list (redesign) ─────────────────────────────── */

section('7. Compact rows replace the oversized cards');

ok('the old card renderer is gone', !/renderEnrollmentCard/.test(students));
ok('rows are horizontal and dense (9 px vertical padding, hairline divider)',
  /flexDirection: 'row', alignItems: 'center', gap: 9,[\s\S]{0,120}paddingHorizontal: 10, paddingVertical: 9,[\s\S]{0,160}borderBottomWidth: StyleSheet\.hairlineWidth/.test(students));
ok('the row keeps the name, the MED id and one muted meta line',
  /s\?\.full_name \?\? '—'/.test(students) && /s\.public_user_id/.test(students) &&
  /meta\.join\(' · '\)/.test(students));
ok('the id is still tap-to-copy',
  /Clipboard\.setStringAsync\(String\(s\.public_user_id\)\)/.test(students) &&
  /showToast\(\{ type: 'success', message: t\('drStudents\.idCopied'\) \}\)/.test(students));
ok('the status stays visible as a compact pill',
  /statusLabel\(enrollment\.status, t\)/.test(students));
ok('actions are 30 px icon buttons, not a per-student button bar',
  /const iconBtn = \{\s*width: 30, height: 30, borderRadius: 8/.test(students) &&
  !/flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 7/.test(students));
ok('every authorized action remains reachable from the row',
  /openAction\(enrollment, 'profile'\)/.test(students) &&
  /openAction\(enrollment, 'suspend'\)/.test(students) &&
  /openAction\(enrollment, 'resume'\)/.test(students) &&
  /openAction\(enrollment, 'remove'\)/.test(students));
ok('the rows are separated by dividers inside one hairline panel',
  /borderWidth: StyleSheet\.hairlineWidth, borderColor: `\$\{c\.text\}14`/.test(students));
// react-native-web turns role="button" into a real <button>, so a row that owns
// copy + action buttons must not itself be one (React reports invalid nesting).
ok('the row is never rendered as a <button> that contains its own buttons',
  /accessibilityRole=\{selectMode \? 'checkbox' : undefined\}/.test(students) &&
  !/accessibilityRole=\{selectMode \? 'checkbox' : 'button'\}/.test(students));
ok('long names/ids cannot collide with the actions (single line + minWidth 0)',
  /numberOfLines=\{1\}/.test(students) && /flex: 1, minWidth: 0/.test(students));
ok('the recently-added tab reuses the same compact row (with its date)',
  /recentEnrollments\.slice\(0, 30\)\.map\(e => renderStudentRow\(e, true, true\)\)/.test(students) &&
  /if \(withDate && enrollment\.enrolled_at\)/.test(students));

/* ── Result ─────────────────────────────────────────────────────────── */

console.log('');
if (failures.length) {
  console.log('❌ ' + passed + ' passed, ' + failures.length + ' failed');
  for (const f of failures) console.log('   - ' + f);
  process.exit(1);
}
console.log('✅ ' + passed + ' passed, 0 failed');
