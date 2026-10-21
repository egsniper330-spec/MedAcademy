#!/usr/bin/env node
/**
 * Navigation drawer direction — RTL/LTR geometry for every role.
 *
 * Run: node tests/navigationDrawerDirection.test.cjs   (also part of `npm test`)
 *
 * ROOT CAUSE PINNED HERE
 * The hamburger is the first child of a `flexDirection: 'row'` header, so React
 * Native already moved it to the RIGHT in Arabic. The drawer panel was not
 * direction-aware: it was pinned with physical `left: 0`, slid in from
 * `translateX: -DRAWER_WIDTH`, its shadow pointed right (+8) and its backdrop
 * covered `left: DRAWER_WIDTH`. Nothing mirrors those values, so the panel
 * opened on the LEFT edge while the trigger sat on the right.
 *
 * WHAT THIS SUITE VERIFIES
 *   1. The pure geometry model for LTR and RTL (edge, closed offset, backdrop,
 *      border, shadow, chevron, active rule).
 *   2. Tablet width and degenerate widths (rotation / split view).
 *   3. The `position` helpers actually produce mirrored style objects.
 *   4. DrawerNav consumes the model — no physical `left: 0` panel, no
 *      `-DRAWER_WIDTH` slide, direction-aware border/shadow/chevron/backdrop.
 *   5. ONE drawer serves all four roles (student, doctor, admin, super_admin),
 *      and role-specific items/gating are untouched.
 *   6. Direction-sensitive icons in shared chrome (back arrow, nav chevrons).
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Comments must not count as code when asserting on source. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}

/* ───────────────────────── compile the pure model ──────────────────────── */

const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), 'drawer-'));
try {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src/lib/ui/drawerDirection.ts'),
      '--outDir', BUILD,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
} catch (e) {
  console.error('  ✗ could not compile src/lib/ui/drawerDirection.ts');
  console.error(String(e.stderr || e.stdout || e.message).slice(0, 3000));
  process.exit(1);
}

const { drawerDirection, panelEdgeStyle, backdropEdgeStyle } = require(
  path.join(BUILD, 'drawerDirection.js'),
);

const PHONE = 290;
const TABLET = 320;

/* ────────────────────────────── LTR ────────────────────────────────────── */

console.log('\nLTR geometry (unchanged behaviour)');
const ltr = drawerDirection(false, PHONE);
check('panel is pinned to the LEFT edge', ltr.side === 'left');
check('closed offset is -width (off-screen left)', ltr.closedOffset === -PHONE);
check('open offset is 0', ltr.openOffset === 0);
check('backdrop occupies the opposite (right) side', ltr.oppositeSide === 'right');
check('backdrop width equals the drawer width', ltr.backdropWidth === PHONE);
check('hairline border on the content-facing (right) edge', ltr.borderEdge === 'right');
check('shadow points right (+1)', ltr.shadowSign === 1);
check('forward chevron points right', ltr.forwardChevron === 'right');
check('active rule on the left (inline-start)', ltr.activeRuleEdge === 'left');
check('isRTL false', ltr.isRTL === false);

/* ────────────────────────────── RTL ────────────────────────────────────── */

console.log('\nRTL geometry (the fix)');
const rtl = drawerDirection(true, PHONE);
check('panel is pinned to the RIGHT edge', rtl.side === 'right');
check('closed offset is +width (off-screen right)', rtl.closedOffset === PHONE);
check('open offset is 0', rtl.openOffset === 0);
check('backdrop occupies the opposite (left) side', rtl.oppositeSide === 'left');
check('hairline border on the content-facing (left) edge', rtl.borderEdge === 'left');
check('shadow points left (-1)', rtl.shadowSign === -1);
check('forward chevron points left', rtl.forwardChevron === 'left');
check('active rule on the right (inline-start)', rtl.activeRuleEdge === 'right');
check('isRTL true', rtl.isRTL === true);

// Invariants that must hold in both directions.
for (const [label, model] of [['LTR', ltr], ['RTL', rtl]]) {
  check(`${label}: the closed offset hides exactly one panel width`,
    Math.abs(model.closedOffset) === PHONE);
  check(`${label}: the closed offset pushes the panel off its own edge`,
    model.side === 'right' ? model.closedOffset > 0 : model.closedOffset < 0);
  check(`${label}: the panel opens to offset 0`, model.openOffset === 0);
}

/* ─────────────────────── position style helpers ────────────────────────── */

console.log('\nposition helpers are mirrored');
check('LTR panel is `left: 0`', panelEdgeStyle(ltr).left === 0 && panelEdgeStyle(ltr).right === undefined);
check('RTL panel is `right: 0`', panelEdgeStyle(rtl).right === 0 && panelEdgeStyle(rtl).left === undefined);
check('LTR backdrop is `right: 0` + width',
  backdropEdgeStyle(ltr).right === 0 && backdropEdgeStyle(ltr).width === PHONE);
check('RTL backdrop is `left: 0` + width',
  backdropEdgeStyle(rtl).left === 0 && backdropEdgeStyle(rtl).width === PHONE);
check('panel and backdrop never occupy the same edge',
  panelEdgeStyle(ltr).left === 0 && backdropEdgeStyle(ltr).left === undefined);

/* ───────────────────── tablet + degenerate widths ──────────────────────── */

console.log('\nresponsive widths');
const tabletRtl = drawerDirection(true, TABLET);
check('tablet RTL closes by the tablet width', tabletRtl.closedOffset === TABLET);
check('tablet RTL backdrop matches the panel', tabletRtl.backdropWidth === TABLET);
const zero = drawerDirection(true, 0);
check('a zero width does not produce NaN', Number.isFinite(zero.closedOffset) && zero.closedOffset === 0);
const negative = drawerDirection(true, -50);
check('a negative width is coerced safely', negative.closedOffset === 0);
const nan = drawerDirection(false, Number.NaN);
check('NaN width is coerced safely', nan.closedOffset === 0);

/* ─────────────────────── DrawerNav wiring (source) ─────────────────────── */

console.log('\nDrawerNav wiring');
const drawer = stripComments(read('src/components/DrawerNav.tsx'));
check('imports the pure direction model', /from '@\/lib\/ui\/drawerDirection'/.test(drawer));
check('builds the model from the app direction', /drawerDirection\(isRTL, DRAWER_WIDTH\)/.test(drawer));
check('reads isRTL from the i18n context', /useTranslation\(\)/.test(drawer));
check('panel edge comes from panelEdgeStyle', /panelEdgeStyle\(dir\)/.test(drawer));
check('backdrop edge comes from backdropEdgeStyle', /backdropEdgeStyle\(dir\)/.test(drawer));
check('slide starts at the model closed offset',
  /new Animated\.Value\(dir\.closedOffset\)/.test(drawer) &&
  /slideAnim\.setValue\(dir\.closedOffset\)/.test(drawer));
check('slide target comes from the model',
  /toValue: isOpen \? dir\.openOffset : dir\.closedOffset/.test(drawer));
check('no hardcoded left pin on the panel', !/position: 'absolute', top: 0, left: 0, bottom: 0/.test(drawer));
check('no hardcoded -DRAWER_WIDTH slide', !/-DRAWER_WIDTH/.test(drawer));
check('border edge follows the model', /dir\.borderEdge/.test(drawer));
check('shadow direction follows the model', /8 \* dir\.shadowSign/.test(drawer));
check('active-row rule uses the direction-aware borderStart* (not borderLeft*)',
  /borderStartWidth/.test(drawer) && !/borderLeftWidth: isDark && active/.test(drawer));
check('panel hairline is chosen from the model, not fixed to one edge',
  /dir\.borderEdge === 'left'/.test(drawer));
check('nav chevron is direction-aware',
  /isRTL \? ChevronLeft : ChevronRight/.test(drawer));
check('badge label is localized (no raw "items")', !/`\$\{item\.badge\} items`/.test(drawer));
check('drawer still closes on backdrop press', /onPress=\{closeDrawer\}/.test(drawer));
check('drawer still has its own close control', /t\('nav\.closeMenu'\)/.test(drawer));

/* ───────────────────────── one drawer, four roles ──────────────────────── */

console.log('\nall four roles');
for (const role of ['student', 'doctor', 'admin']) {
  check(`getNavSections has a branch for ${role}`, new RegExp(`role === '${role}'`).test(drawer));
}
check('super_admin keeps its consolidated hub IA', /super_admin/.test(drawer) && /sa-overview/.test(drawer));
// Earnings was retired from the product: the drawer must not carry the entry or
// its flags any more (the server keeps the key only for data protection).
check('drawer no longer exposes a doctor earnings entry',
  !/earningsEnabled|platformEarningsOn|doctor_earnings|nav\.earnings/.test(drawer));
check('every drawer label is localized through t()',
  !/label: '(?!.*\(\')[A-Z][a-z]+ [A-Z]/.test(drawer));

// The SAME component must be mounted by every role shell / hub group.
const SHELLS = [
  'src/components/navigation/RoleTabShell.tsx',
  'src/components/navigation/RoleTabShell.ios.tsx',
  'src/app/(app)/(hubs)/_layout.tsx',
  'src/app/(app)/notifications.tsx',
  'src/app/(app)/offline-library.tsx',
  'src/app/(app)/offline-course.tsx',
  'src/app/(app)/security-diagnostics.tsx',
];
const notWired = SHELLS.filter((rel) => {
  const src = read(rel);
  return !(/<DrawerNav \/>/.test(src) && /DrawerProvider/.test(src));
});
check('every shell mounts the shared DrawerNav' +
  (notWired.length ? `: ${notWired.join(', ')}` : ''), notWired.length === 0);

// No role may ship its own drawer implementation.
const roleLayouts = [
  'src/app/(app)/(student)/_layout.tsx',
  'src/app/(app)/(doctor)/_layout.tsx',
  'src/app/(app)/(admin)/_layout.tsx',
  'src/app/(app)/(superadmin)/_layout.tsx',
];
const ownDrawer = roleLayouts.filter((rel) => /position: 'absolute'[\s\S]{0,200}DRAWER_WIDTH/.test(read(rel)));
check('no role layout re-implements the drawer panel', ownDrawer.length === 0);
check('role layouts delegate to the shared shell',
  roleLayouts.every((rel) => /RoleTabShell/.test(read(rel))));

/* ────────────────── shared chrome: directional icons ──────────────────── */

console.log('\nshared chrome');
const pageHeader = stripComments(read('src/components/PageHeader.tsx'));
// The back affordance is a directional arrow, not a mirrored glyph: RTL gets the
// right-pointing icon, LTR keeps the left-pointing one. Both must be present in
// the same back-button block (tests/offlineState.test.cjs also pins ArrowLeft
// there, so a single-icon rotate trick cannot satisfy this suite).
check('back arrow follows the reading direction',
  /isRTL\s*\n?\s*\?\s*<ArrowRight/.test(pageHeader) && /<ArrowLeft/.test(pageHeader));
check('hamburger has a localized accessibility label',
  /t\('nav\.openMenu'\)/.test(read('src/components/HamburgerButton.tsx')));

// The hamburger itself stays the first row child, so the layout engine places
// it on the inline-start edge in both directions — moving it manually would
// double-mirror.
check('hamburger is still positioned by the row, not by manual sides',
  !/left:|right:/.test(stripComments(read('src/components/HamburgerButton.tsx'))));
check('drawer does not hardcode a global row-reverse fix', !/row-reverse/.test(drawer));

/* ─────────────────────────────── summary ──────────────────────────────── */

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nDrawer direction suite FAILED.');
  process.exit(1);
}
