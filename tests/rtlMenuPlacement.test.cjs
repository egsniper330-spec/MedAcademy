#!/usr/bin/env node
/**
 * RTL/LTR anchored-menu placement — the fix for "buttons moved right, menu
 * opened on the left".
 *
 * Run: node tests/rtlMenuPlacement.test.cjs   (also part of `npm test`)
 *
 * ROOT CAUSE PINNED HERE
 * Anchored menus were hand-rolled absolute views with a physical side
 * (`right: 0`). React Native never mirrors `right`/`left`, so in Arabic the
 * trigger moved to the inline-start (right) edge while the menu still opened
 * toward the left — and could leave the screen. Placement is now a pure
 * function of the trigger rect + window + direction
 * (src/lib/ui/anchoredMenuPosition.ts), exercised here for:
 *
 *   1. LTR: menu's LEFT edge aligns to the trigger's left edge.
 *   2. RTL: menu's RIGHT edge aligns to the trigger's right edge (inline-start).
 *   3. A trigger near the inline-end edge still opens fully on-screen.
 *   4. Collision fallback: if the preferred alignment would overflow, the
 *      opposite edge is used and the menu stays visible (no hardcoded side).
 *   5. Vertical: opens below, flips above when there is no room, never
 *      overflows, and caps its height so it scrolls instead.
 *   6. Small windows / split view: width and height are clamped.
 *   7. Wiring: the shared component measures the trigger in window space, feeds
 *      the app's real direction, and no screen keeps a hardcoded-side menu.
 *
 * The placement math is verified numerically. Actual on-screen rendering on a
 * device/emulator is NOT simulated here — see the limitation note in
 * docs/LOCALIZATION.md.
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

/* ────────────────────── compile the pure placement module ──────────────── */

const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-'));
try {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src/lib/ui/anchoredMenuPosition.ts'),
      '--outDir', BUILD,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
} catch (e) {
  console.error('  ✗ could not compile src/lib/ui/anchoredMenuPosition.ts');
  console.error(String(e.stderr || e.stdout || e.message).slice(0, 3000));
  process.exit(1);
}

const { computeMenuPlacement, inlineStartEdge, menuDirection } = require(
  path.join(BUILD, 'anchoredMenuPosition.js'),
);

const WINDOW = { width: 390, height: 844 }; // typical phone portrait
const place = (over) =>
  computeMenuPlacement({
    window: WINDOW,
    direction: 'ltr',
    gap: 6,
    margin: 8,
    ...over,
  });

/** Menu fully inside the window (with margin)? */
function insideScreen(p, win = WINDOW) {
  return (
    p.left >= 8 - 0.001 &&
    p.left + p.width <= win.width - 8 + 0.001 &&
    p.top >= 8 - 0.001 &&
    p.top <= win.height - 8 + 0.001
  );
}

/* ───────────────────────────── 1. direction ────────────────────────────── */

console.log('\ndirection semantics');
check("inline-start is the LEFT edge in LTR", inlineStartEdge('ltr') === 'left');
check("inline-start is the RIGHT edge in RTL", inlineStartEdge('rtl') === 'right');
check("menuDirection(true) === 'rtl'", menuDirection(true) === 'rtl');
check("menuDirection(false) === 'ltr'", menuDirection(false) === 'ltr');

/* ─────────────────────── 2. LTR keeps current behaviour ────────────────── */

console.log('\nLTR: left edge aligned to the trigger');
const ltrAnchor = { x: 120, y: 100, width: 100, height: 40 };
const ltr = place({ anchor: ltrAnchor, menuWidth: 180, menuHeight: 200, direction: 'ltr' });
check('left === trigger.x (menu grows rightwards)', ltr.left === 120);
check("align === 'start'", ltr.align === 'start');
check('top === trigger bottom + gap', ltr.top === 100 + 40 + 6);
check('not flipped', ltr.flipped === false);
check('not collided', ltr.collided === false);
check('fully on screen', insideScreen(ltr));
check('width is the requested width', ltr.width === 180);

/* ───────────────────────── 3. RTL opens rightwards ─────────────────────── */

console.log('\nRTL: RIGHT edge aligned to the trigger (the reported bug)');
const rtlAnchor = { x: 240, y: 100, width: 100, height: 40 }; // near the right edge
const rtl = place({ anchor: rtlAnchor, menuWidth: 180, menuHeight: 200, direction: 'rtl' });
check('menu right edge === trigger right edge',
  Math.abs(rtl.left + rtl.width - (rtlAnchor.x + rtlAnchor.width)) < 0.001);
check('menu grows LEFTWARDS from the trigger', rtl.left < rtlAnchor.x);
check('it does NOT start at the trigger left edge (the old bug)',
  rtl.left !== rtlAnchor.x);
check("align === 'start' (inline-start, not physical left)", rtl.align === 'start');
check('not collided', rtl.collided === false);
check('fully on screen', insideScreen(rtl));

// Same trigger, opposite direction → the menu must sit on the other side.
// (Mid-screen anchor so neither alignment collides.)
const midAnchor = { x: 140, y: 100, width: 60, height: 40 };
const midRtl = place({ anchor: midAnchor, menuWidth: 120, menuHeight: 200, direction: 'rtl' });
const midLtr = place({ anchor: midAnchor, menuWidth: 120, menuHeight: 200, direction: 'ltr' });
check('RTL aligns the menu to the trigger right edge',
  Math.abs(midRtl.left + midRtl.width - (midAnchor.x + midAnchor.width)) < 0.001);
check('LTR aligns the menu to the trigger left edge', midLtr.left === midAnchor.x);
check('the same trigger places the menu differently per direction',
  midRtl.left !== midLtr.left);

/* ─────────── 4. collision fallback keeps the menu visible ──────────────── */

console.log('\ncollision handling');
// RTL trigger hard against the LEFT edge: aligning its right edge would push
// the menu off the left side, so the opposite alignment is used.
const leftEdgeRtlAnchor = { x: 4, y: 300, width: 56, height: 40 };
const collidedRtl = place({
  anchor: leftEdgeRtlAnchor, menuWidth: 200, menuHeight: 220, direction: 'rtl',
});
check('RTL near the left edge is clamped inside the screen', insideScreen(collidedRtl));
check('collision is reported (deliberate fallback, not silent clipping)',
  collidedRtl.collided === true);
check("fallback uses the opposite alignment ('end')", collidedRtl.align === 'end');
check('fallback still honours the margin', collidedRtl.left >= 8);

// LTR trigger hard against the RIGHT edge.
const rightEdgeLtrAnchor = { x: 360, y: 300, width: 24, height: 40 };
const collidedLtr = place({
  anchor: rightEdgeLtrAnchor, menuWidth: 200, menuHeight: 220, direction: 'ltr',
});
check('LTR near the right edge is clamped inside the screen', insideScreen(collidedLtr));
check('LTR collision is reported', collidedLtr.collided === true);

/* ─────────────────────────── 5. vertical fit ───────────────────────────── */

console.log('\nvertical placement');
const lowAnchor = { x: 100, y: 780, width: 100, height: 40 };
const flipped = place({ anchor: lowAnchor, menuWidth: 160, menuHeight: 240, direction: 'ltr' });
check('no room below → flipped above the trigger', flipped.flipped === true);
check('flipped menu ends above the trigger', flipped.top + 240 <= lowAnchor.y + 0.001);
check('flipped menu stays on screen', insideScreen(flipped));

const hugeMenu = place({ anchor: { x: 100, y: 200, width: 100, height: 40 }, menuWidth: 200, menuHeight: 900, direction: 'ltr' });
check('an over-tall menu is height-capped instead of overflowing',
  hugeMenu.maxHeight <= WINDOW.height - 8);
check('maxHeight leaves room for the trigger area', hugeMenu.maxHeight < WINDOW.height);

/* ───────────────────── 6. small window / split view ────────────────────── */

console.log('\nsmall windows');
const SMALL = { width: 320, height: 480 };
const tiny = computeMenuPlacement({
  anchor: { x: 250, y: 400, width: 60, height: 40 },
  menuWidth: 300,
  menuHeight: 300,
  window: SMALL,
  direction: 'rtl',
});
check('width never exceeds the window minus margins', tiny.width <= SMALL.width - 16);
check('tiny-window menu is still fully on screen', insideScreen(tiny, SMALL));
check('tiny-window menu has a usable maxHeight', tiny.maxHeight >= 0);

// Property sweep: for every direction and a range of anchors, never overflow.
let overflow = 0;
for (const direction of ['ltr', 'rtl']) {
  for (let x = 0; x <= WINDOW.width - 40; x += 17) {
    for (const menuWidth of [120, 200, 300]) {
      for (const menuHeight of [80, 400, 900]) {
        const p = place({
          anchor: { x, y: 120, width: 40, height: 36 },
          menuWidth, menuHeight, direction,
        });
        if (p.left < 8 - 0.001 || p.left + p.width > WINDOW.width - 8 + 0.001) overflow++;
        if (p.top < 8 - 0.001) overflow++;
      }
    }
  }
}
check('no horizontal/vertical overflow across a sweep of anchors and sizes', overflow === 0);

/* ──────────────────────── 7. component wiring ──────────────────────────── */

console.log('\nwiring');
/** Comments must not count as code when asserting on source. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const component = stripComments(read('src/components/AnchoredMenu.tsx'));
check('the shared menu uses the pure placement function',
  /computeMenuPlacement\(/.test(component) && /from '@\/lib\/ui\/anchoredMenuPosition'/.test(component));
check('it measures the trigger in WINDOW coordinates', /measureInWindow\(/.test(component));
check('it passes the app direction, not a hardcoded one',
  /direction:\s*menuDirection\(isRTL\)/.test(component));
check('it reads the direction from the i18n context', /useTranslation\(\)/.test(component));
check('it has an inline mode for triggers inside a native Modal',
  /inline/.test(component) && /PortalOverlay/.test(component));
check('no hardcoded physical side in the shared menu',
  !/right:\s*0\b/.test(component) && !/left:\s*0\b/.test(component));
check('no blind tree mirroring (row-reverse / scaleX(-1))', !/row-reverse|scaleX\(-1\)/.test(component));

// The two menus that existed must now use the shared component.
const videoLibrary = read('src/app/(app)/(hubs)/video-library.tsx');
const picker = read('src/components/VideoLibraryPicker.tsx');
check('video-library sort menu uses AnchoredMenu', /<AnchoredMenu/.test(videoLibrary));
check('VideoLibraryPicker sort menu uses AnchoredMenu', /<AnchoredMenu/.test(picker));
check('VideoLibraryPicker menu is inline (inside a native Modal)', /inline\b/.test(picker));
// A MENU sits BELOW its trigger (non-zero offset); `top: 0, left: 0` is a
// fullscreen layer (player / scrim), not an anchored menu.
const HARDCODED_SIDE_MENU = /position: 'absolute', top: (?!0\b)\d+, (?:right|left): 0\b/;
check('no hardcoded-side dropdown remains in video-library',
  !HARDCODED_SIDE_MENU.test(videoLibrary));
check('no hardcoded-side dropdown remains in VideoLibraryPicker',
  !HARDCODED_SIDE_MENU.test(picker));

// App-wide sweep: no other file may reintroduce a hardcoded-side MENU
// (full-fill overlays — `top: 0, left: 0, right: 0, bottom: 0` — are layers,
// not anchored menus, and are excluded).
const srcFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name)) srcFiles.push(full);
  }
})(path.join(ROOT, 'src'));

const offenders = srcFiles.filter((file) => {
  const lines = stripComments(fs.readFileSync(file, 'utf8')).split(/\r?\n/);
  return lines.some((line) => HARDCODED_SIDE_MENU.test(line) && !/bottom: 0/.test(line));
});
check('no screen keeps a hardcoded-side absolute menu' +
  (offenders.length ? `: ${offenders.map((f) => path.relative(ROOT, f)).join(', ')}` : ''),
  offenders.length === 0);

/* ─────────────────────────── summary ──────────────────────────────────── */

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nRTL menu placement suite FAILED.');
  process.exit(1);
}
