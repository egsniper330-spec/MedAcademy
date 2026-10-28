#!/usr/bin/env node
/**
 * headerRtlDirection.test.cjs — the Doctor header's menu button must sit at the
 * top-RIGHT in Arabic and stay top-LEFT in English.
 *
 * ROOT CAUSE PINNED HERE
 * ──────────────────────
 * `PageHeader` mirrored its row with `flexDirection: isRTL ? 'row-reverse' : 'row'`
 * — but `flexDirection` is NOT physical in React Native. Yoga flips the main
 * axis whenever the LAYOUT direction is RTL, which it is on a native Arabic
 * launch (`I18nManager.isRTL`). The unpinned `row-reverse` was therefore
 * resolved back to left-to-right, and the hamburger rendered in the top-LEFT
 * corner of Video Library, Students, My Balance and Notifications on iOS and
 * Android. The web build has no Yoga direction, so it looked correct there —
 * which is exactly why the defect survived review.
 *
 * The fix is the contract the rest of the app already follows: pin the row with
 * `direction: 'ltr'` so the mirror is the ONLY one, and mirror the safe-area
 * padding physically (the leading control clears the edge it actually sits on).
 *
 * WHAT THIS CHECKS
 *   1. PageHeader mirrors the row AND pins `direction: 'ltr'`.
 *   2. DashboardHeader does too (its right-actions row inherits the pin).
 *   3. ResponsiveTabBar and the drawer track keep the same contract.
 *   4. INVARIANT: no `flexDirection: isRTL ? ...` anywhere in src/ is left
 *      unpinned — the general form of this bug.
 *   5. PageHeader's RTL leading padding is the RIGHT inset; LTR's is the left.
 *   6. The four reported screens render through the shared PageHeader (so the
 *      fix reaches them and cannot drift per screen).
 *   7. English is unchanged: the LTR branch still pins 'row'.
 *
 * Run: node tests/headerRtlDirection.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name + (detail ? `  [${detail}]` : ''));
  }
}
function section(name) {
  console.log('\n── ' + name + ' ──');
}
/** Drop full-line comments so prose about the fix cannot satisfy a pin. */
function code(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const page = code(read('src/components/PageHeader.tsx'));
const dash = code(read('src/components/DashboardHeader.tsx'));
const tabs = code(read('src/components/ResponsiveTabBar.tsx'));
const drawer = code(read('src/lib/ui/drawerDirection.ts'));

// ════════════════════════════════════════════════════════════════════════════
section('1. PageHeader mirrors once AND pins the row');
// ════════════════════════════════════════════════════════════════════════════
check('mirrors the row for Arabic', /flexDirection: isRTL \? 'row-reverse' : 'row'/.test(page));
check('pins the row to ltr (otherwise Yoga re-flips it)', /direction: 'ltr'/.test(page),
  'direction: ltr missing — this is the bug');
check('keeps the leading control first in the tree',
  /flexDirection[^;]*\n[\s\S]{0,120}?<HamburgerButton plain \/>/.test(page),
  'hamburger is the first child of the header row');
check('English branch is untouched: LTR renders a plain `row`',
  /isRTL \? 'row-reverse' : 'row'/.test(page));

// ════════════════════════════════════════════════════════════════════════════
section('2. DashboardHeader keeps the same contract');
// ════════════════════════════════════════════════════════════════════════════
check('mirrors its row', /flexDirection: isRTL \? 'row-reverse' : 'row'/.test(dash));
check('pins it to ltr', /direction: 'ltr'/.test(dash));

// ════════════════════════════════════════════════════════════════════════════
section('3. Other RTL surfaces use the same single-mirror contract');
// ════════════════════════════════════════════════════════════════════════════
check('tab bar mirrors and pins', /isRTL \? 'row-reverse' : 'row'/.test(tabs) && /direction: 'ltr'/.test(tabs));
check('drawer track places the panel physically',
  /trackFlexDirection/.test(drawer) && /row-reverse/.test(drawer));

// ════════════════════════════════════════════════════════════════════════════
section('4. INVARIANT: no unpinned mirrored row anywhere in src/');
// ════════════════════════════════════════════════════════════════════════════
{
  const files = walk('src');
  const offenders = [];
  for (const rel of files) {
    const src = code(read(rel));
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/flexDirection: isRTL \?/.test(line)) return;
      // The pin may sit just above (same object literal) or on the next lines.
      const window = lines.slice(Math.max(0, i - 3), i + 8).join('\n');
      if (!/direction: 'ltr'/.test(window) && !/direction: dir\./.test(window)) {
        offenders.push(rel + ':' + (i + 1));
      }
    });
  }
  check('every `flexDirection: isRTL ? ...` row is pinned to ltr',
    offenders.length === 0,
    offenders.join(', ') || 'none');
}

// ════════════════════════════════════════════════════════════════════════════
section('5. The leading control clears the edge it actually sits on');
// ════════════════════════════════════════════════════════════════════════════
check('PageHeader: RTL pads with the RIGHT safe-area inset',
  /paddingRight: isRTL \? rightPad \+ spacing\.sm : rightPad/.test(page));
check('PageHeader: RTL does not add the leading gap to the left inset',
  /paddingLeft: isRTL \? leftPad : leftPad \+ spacing\.sm/.test(page));
check('DashboardHeader: same physical padding rule',
  /paddingRight: isRTL \? rightPad \+ spacing\.sm : rightPad/.test(dash)
  && /paddingLeft: isRTL \? leftPad : leftPad \+ spacing\.sm/.test(dash));

// ════════════════════════════════════════════════════════════════════════════
section('6. The reported screens share the fixed header');
// ════════════════════════════════════════════════════════════════════════════
for (const screen of [
  'src/app/(app)/(doctor)/video-library.tsx',
  'src/app/(app)/(doctor)/students.tsx',
  'src/app/(app)/(hubs)/credits.tsx',
  'src/app/(app)/notifications.tsx',
]) {
  const src = code(read(screen));
  check(`${screen.split('/').pop()} renders the shared PageHeader`,
    /import \{ PageHeader \} from '@\/components\/PageHeader'/.test(src) && /<PageHeader/.test(src));
  check(`${screen.split('/').pop()} has no hand-rolled hamburger row`,
    !/HamburgerButton/.test(src));
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(60));
if (failed > 0) {
  console.error(`${passed} passed, ${failed} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
