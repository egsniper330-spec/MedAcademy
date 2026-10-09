#!/usr/bin/env node
/**
 * Role-aware navigation — a role must only ever render ITS OWN bottom tabs.
 *
 * THE BUG THIS LOCKS DOWN
 * ────────────────────────
 * A signed-in doctor was shown the STUDENT bottom tabs (Home / Explore /
 * My Courses / Profile) and had to open the hamburger menu to reach their own
 * Dashboard. Root cause was a chain, not a single typo:
 *
 *   1. `(app)/_layout.tsx` redirects to the role dashboard exactly ONCE per
 *      identity. It sets `hasNavigated.current = true` BEFORE it branches, so
 *      the force-password-change branch consumes the guard without ever
 *      reaching a dashboard redirect.
 *   2. `(auth)/force-password-change.tsx` then did
 *      `router.replace('/dashboard')` — a STUDENT literal — for every role.
 *   3. `(auth)/security-warning.tsx` and `(app)/security-warning.tsx` defaulted
 *      their redirect to a student dashboard literal too, and took it from a
 *      client-suppliable route param.
 *
 * Because (1) was already spent, nothing ever corrected (2) or (3): the doctor
 * stayed on the student tab bar until they used the drawer.
 *
 * WHAT THIS LOCKS DOWN
 * ────────────────────
 *   A. Every role tab group enforces membership from inside the group, with the
 *      right role, so no event ordering can leave a foreign role mounted.
 *   B. The role → dashboard table agrees with the tab registry (the dashboard
 *      is each role's first visible tab) and every mapped route file exists.
 *   C. No screen defaults to a student dashboard literal for an arbitrary role.
 *   D. The guard resolves the role from the backend-verified profile store —
 *      never from a route param or navigation state.
 *   E. The guard cannot loop: unmapped roles resolve to `null` and no-op.
 *
 * Run: node tests/roleNavigation.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'app', '(app)');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r/g, '');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

const roleRoutes = read('src/lib/roleRoutes.ts');
const guard = read('src/components/navigation/useRoleTabGuard.ts');
const registry = read('src/lib/nativeTabRegistry.tsx');

// ─── A. Every role group guards itself ───────────────────────────────────────

const GROUPS = [
  { dir: '(student)', group: 'student', role: 'student' },
  { dir: '(doctor)', group: 'doctor', role: 'doctor' },
  { dir: '(admin)', group: 'admin', role: 'admin' },
  { dir: '(superadmin)', group: 'superadmin', role: 'super_admin' },
];

for (const g of GROUPS) {
  check(`A1 ${g.dir} layout enforces role membership via useRoleTabGuard('${g.group}')`, () => {
    const src = read(path.join('src/app/(app)', g.dir, '_layout.tsx'));
    ok(
      src.includes(`useRoleTabGuard('${g.group}')`),
      `${g.dir}/_layout.tsx does not call useRoleTabGuard('${g.group}')`,
    );
    ok(
      src.includes('useRoleTabGuard'),
      `${g.dir}/_layout.tsx does not import the guard`,
    );
  });
}

check('A2 the guard runs BEFORE the shell renders (hooks cannot be conditional)', () => {
  for (const g of GROUPS) {
    const src = read(path.join('src/app/(app)', g.dir, '_layout.tsx'));
    const guardIdx = src.indexOf(`useRoleTabGuard('${g.group}')`);
    const shellIdx = src.indexOf('<RoleTabShell');
    ok(guardIdx >= 0 && shellIdx > guardIdx, `${g.dir}: guard must precede <RoleTabShell`);
  }
});

check('A3 no role layout renders another role’s tab registry', () => {
  const registryOf = {
    '(student)': 'STUDENT_TABS',
    '(doctor)': 'DOCTOR_TABS',
    '(admin)': 'ADMIN_TABS',
    '(superadmin)': 'SUPERADMIN_TABS',
  };
  for (const g of GROUPS) {
    const src = read(path.join('src/app/(app)', g.dir, '_layout.tsx'));
    const expected = registryOf[g.dir];
    ok(src.includes(expected), `${g.dir} should render ${expected}`);
    for (const [dir, name] of Object.entries(registryOf)) {
      if (dir === g.dir) continue;
      // A group MAY import another registry only if it never renders it.
      const uses = new RegExp(`<RoleTabShell[^>]*\\b${name}\\b`, 's');
      ok(!uses.test(src), `${g.dir} renders ${name} (belongs to ${dir})`);
    }
  }
});

// ─── B. Role → dashboard table agrees with the registry ──────────────────────

function registrySection(startAnchor, endAnchor) {
  const a = registry.indexOf(startAnchor);
  ok(a >= 0, `registry section ${startAnchor} not found`);
  const b = endAnchor ? registry.indexOf(endAnchor) : registry.length;
  return registry.slice(a, b);
}
function firstVisibleEntry(section) {
  const re = /\{\s*name:\s*'([^']+)'[^}]*\}/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    if (!/hidden:\s*true/.test(m[0])) return m[1];
  }
  return null;
}

const SECTIONS = [
  { group: 'student', anchor: 'STUDENT_TABS', end: '/* ── Doctor' },
  { group: 'doctor', anchor: 'DOCTOR_TABS', end: '/* ── Admin' },
  { group: 'admin', anchor: 'ADMIN_TABS', end: '/* ── Super Admin' },
  { group: 'superadmin', anchor: 'SUPERADMIN_TABS', end: null },
];

const DASHBLOCK = (roleRoutes.match(/ROLE_DASHBOARD[^{]*\{([\s\S]*?)\n\};/) || [])[1] || '';
const GROUPBLOCK = (roleRoutes.match(/GROUP_ROLE[^{]*\{([\s\S]*?)\n\};/) || [])[1] || '';

function lookupRoleForGroup(group) {
  const m = GROUPBLOCK.match(new RegExp(`${group}:\\s*'([^']+)'`));
  return m ? m[1] : null;
}
function lookupDashForRole(role) {
  const m = DASHBLOCK.match(new RegExp(`${role}:\\s*'([^']+)'`));
  return m ? m[1] : null;
}

for (const s of SECTIONS) {
  check(`B1 ${s.group}: ROLE_DASHBOARD target is that group’s first visible tab`, () => {
    const section = registrySection(s.anchor, s.end);
    const first = firstVisibleEntry(section);
    ok(first, `no visible entry found in ${s.anchor}`);

    const role = lookupRoleForGroup(s.group);
    ok(role, `GROUP_ROLE has no entry for group ${s.group}`);
    const dash = lookupDashForRole(role);
    ok(dash, `ROLE_DASHBOARD has no entry for role ${role}`);
    const target = dash.split('/').pop();
    ok(
      target === first,
      `ROLE_DASHBOARD[${role}] = ${dash} resolves to "${target}" but ${role}’s first tab is "${first}"`,
    );
  });
}

check('B2 every mapped dashboard route file actually exists', () => {
  const map = roleRoutes.match(/ROLE_DASHBOARD[^{]*\{([\s\S]*?)\n\};/);
  ok(map, 'ROLE_DASHBOARD table not found');
  const entries = [...map[1].matchAll(/(\w+):\s*'\/([\w-]+)'/g)];
  ok(entries.length >= 4, `expected 4 role entries, found ${entries.length}`);
  const groupDir = {
    student: '(student)',
    doctor: '(doctor)',
    admin: '(admin)',
    super_admin: '(superadmin)',
  };
  for (const [, role, route] of entries) {
    const dir = groupDir[role];
    ok(dir, `no group directory known for role ${role}`);
    ok(
      fs.existsSync(path.join(APP, dir, `${route}.tsx`)),
      `route /${route} has no file at src/app/(app)/${dir}/${route}.tsx`,
    );
  }
});

check('B3 the guard targets the same table the root redirect uses', () => {
  const rootLayout = read('src/app/(app)/_layout.tsx');
  ok(
    rootLayout.includes("router.replace('/dr-overview'"),
    'root layout no longer routes doctors to /dr-overview',
  );
  ok(
    rootLayout.includes("router.replace('/dashboard'"),
    'root layout no longer routes students to /dashboard',
  );
});

// ─── C. No student-dashboard literals for arbitrary roles ────────────────────

check('C1 force-password-change routes by the authenticated role', () => {
  const src = read('src/app/(auth)/force-password-change.tsx');
  ok(
    !/router\.replace\(\s*['"]\/dashboard['"]/.test(src),
    "still hardcodes router.replace('/dashboard') — a doctor would land on student tabs",
  );
  ok(src.includes('dashboardPathForRole(profile?.role)'), 'does not resolve the destination from the profile');
});

for (const f of ['src/app/(auth)/security-warning.tsx', 'src/app/(app)/security-warning.tsx']) {
  check(`C2 ${f.replace('src/app/', '')} does not default its redirect to a student dashboard`, () => {
    const src = read(f);
    ok(
      !/params\.redirect\s*\?\?\s*['"][^'"]*dashboard['"]/.test(src),
      "still falls back to a student dashboard literal (params.redirect ?? '/…/dashboard')",
    );
    ok(src.includes('dashboardPathForRole'), 'does not resolve the destination from the profile');
  });
}

check('C3 the security-warning destinations are not trusted blindly', () => {
  for (const f of ['src/app/(auth)/security-warning.tsx', 'src/app/(app)/security-warning.tsx']) {
    const src = read(f);
    ok(
      /warningRedirect\s*&&\s*warningRedirect\.length\s*>\s*0/.test(src),
      `${f}: a client-suppliable redirect param is still used without a length check`,
    );
  }
});

// ─── D. The guard trusts the backend profile, not the route ──────────────────

check('D1 the guard reads the role from the profile store', () => {
  ok(guard.includes("from '@/lib/store'"), 'guard does not read useProfileStore');
  ok(guard.includes('profile.role'), 'guard does not read profile.role');
});

check('D2 the guard never reads the role from search params or navigation state', () => {
  ok(!guard.includes('useLocalSearchParams'), 'guard must not read role from route params');
  ok(!guard.includes('useNavigationState'), 'guard must not read role from navigation state');
});

check('D3 the guard defers instead of fighting force-password-change', () => {
  ok(guard.includes('force_password_change'), 'guard must yield to the force-password-change flow');
});

check('D4 the guard never evicts an offline cold-launch destination', () => {
  ok(guard.includes("startsWith('/offline-')"), 'guard must preserve /offline-* destinations');
});

// ─── E. No redirect loops ────────────────────────────────────────────────────

check('E1 dashboardPathForRole returns null for unknown roles', () => {
  const m = roleRoutes.match(/export function dashboardPathForRole[\s\S]{0,400}?return null;/);
  ok(m, 'dashboardPathForRole has no null path for unmapped roles');
  ok(roleRoutes.includes('ROLE_DASHBOARD[role] ?? null'), 'lookup must be total (?? null)');
});

check('E2 the guard bails when there is no destination', () => {
  ok(/if \(!dest \|\| dest === pathname\) return;/.test(guard), 'guard must no-op without a destination');
});

check('E3 every ROLE_DASHBOARD value is outside its own wrong group', () => {
  // A destination that resolved back into the group being guarded would loop.
  const okPairings = {
    student: '(student)',
    doctor: '(doctor)',
    admin: '(admin)',
    super_admin: '(superadmin)',
  };
  const map = roleRoutes.match(/ROLE_DASHBOARD[^{]*\{([\s\S]*?)\n\};/);
  const entries = [...map[1].matchAll(/(\w+):\s*'\/([\w-]+)'/g)];
  const routeToGroup = {};
  for (const [group, dir] of Object.entries({ student: '(student)', doctor: '(doctor)', admin: '(admin)', superadmin: '(superadmin)' })) {
    void group;
    for (const f of fs.readdirSync(path.join(APP, dir))) {
      if (f.endsWith('.tsx') && f !== '_layout.tsx') routeToGroup[f.replace('.tsx', '')] = dir;
    }
  }
  for (const [, role, route] of entries) {
    ok(
      routeToGroup[route] === okPairings[role],
      `/${route} lives in ${routeToGroup[route]} but is the destination for role ${role}`,
    );
  }
});

// ─── Report ──────────────────────────────────────────────────────────────────

console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed.`);
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`${passed} assertions passed.`);
console.log('Role navigation regression suite: OK');
