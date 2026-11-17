#!/usr/bin/env node
/**
 * Liquid Bar — indicator geometry and gesture contract.
 *
 * Regression guard for the on-device defect (Samsung SM-T505N, Android 12):
 * with the bar in Arabic RTL, the tab ICONS followed the route while the
 * Liquid bubble did not — it was absent on Home / Explore / My Materials and
 * sat under Home while Profile was open, and it could not be dragged.
 *
 * Proven cause (see the header comment in GlassTabBar.tsx):
 *   • the bubble's x/width came from each tab's `onLayout`, which reports
 *     width 0 (or a mirrored x) for a tab in this RTL row during the first
 *     layout pass — and that value was then kept, so the bubble had no size
 *     to paint or was parked on a stale x;
 *   • its opacity was an Animated value that only an effect could raise, so a
 *     skipped run left a present-but-invisible bubble.
 *
 * The fix derives the geometry from ONE row measurement and the tab count (the
 * tabs are `flex: 1`), places the bubble from the SAME index the icon tint is
 * derived from, and derives visibility from that geometry.
 *
 * Run: node tests/liquidBarGeometry.test.cjs
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILE = 'src/components/navigation/GlassTabBar.tsx';
const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${String(error.message).split('\n').join('\n      ')}`);
  }
}

/** Source with comments stripped, so assertions test CODE, not prose. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

console.log('\nGeometry is derived, not measured per tab');

check('a tab reports only its WIDTH (a stale or mirrored x is never used)', () => {
  assert.match(code, /onTabLayout\(route\.key, event\.nativeEvent\.layout\.width\)/);
  assert.ok(!/layout\.x/.test(code), 'per-tab x must not participate in the geometry');
});

check('the largest measured tab width wins (a zero/partial measurement cannot)', () => {
  assert.match(code, /const measuredTabWidth = useMemo\(\(\) => \{/);
  assert.match(code, /if \(Number\.isFinite\(w\) && w > max\) max = w;/);
});

check('the span takes the LARGER of independent, sanitised candidates', () => {
  // Measured tabs, the window and the pill's own width are all candidates and
  // the largest wins, so a device whose measurement reports 0 can never produce
  // a zero-width bubble.
  assert.match(code, /const windowWidth = Number\.isFinite\(rawWindowWidth\) && rawWindowWidth > 0 \? rawWindowWidth : 0;/);
  assert.match(code, /const pillSpan = pillWidth > 0 \? Math\.max\(pillWidth - 2, 0\) : 0;/);
  assert.match(
    code,
    /const rowSpan = Math\.max\(measuredTabWidth \* tabCount, windowSpan, pillSpan, 0\);/,
  );
  assert.match(code, /const tabWidth = tabCount > 0 && Number\.isFinite\(rowSpan\) \? rowSpan \/ tabCount : 0;/);
});

check('a non-finite position or width can never reach the transform', () => {
  assert.match(code, /if \(!Number\.isFinite\(target\)\) return;/);
  assert.match(code, /if \(!Number\.isFinite\(width\)\) return;/);
});

check('tab x is exact arithmetic from the solved tab width, mirrored for RTL', () => {
  assert.match(code, /const rowSpan = /);
  assert.match(
    code,
    /\(i: number\) => \(isRTL \? rowSpan - \(i \+ 1\) \* tabWidth : i \* tabWidth\),/,
  );
});

check('the bubble width is derived from the solved tab width and never collapses', () => {
  assert.match(
    code,
    /const indicatorWidth = tabCount > 0 \? Math\.max\(tabWidth - INDICATOR_INSET \* 2, 24\) : 0;/,
  );
});

console.log('\nVisibility can never be lost');

check('the bubble opacity is derived from geometry (not an Animated value)', () => {
  assert.match(code, /opacity: indicatorWidth > 0 \? 1 : 0,/);
  assert.ok(!/fade/.test(code), 'the animated opacity that could stick at 0 is gone');
});

check('a missing measurement keeps the placement instead of hiding the bubble', () => {
  assert.match(code, /if \(indicatorWidth <= 0\) return;/);
  assert.match(code, /if \(activeVisible < 0\) return;/);
});

check('the bubble is placed from the SAME index the icon tint uses', () => {
  assert.match(code, /const isFocused = routeIndex === activeIndex;/);
  assert.match(code, /const target = tabX\(activeVisible\) \+ INDICATOR_INSET;/);
});

console.log('\nMovement');

check('the first placement lands exactly (no slide from 0)', () => {
  assert.match(code, /translateX\.setValue\(target\);\s*\n\s*lastTarget\.current = target;/);
});

check('a tab change springs the bubble instead of jumping', () => {
  assert.match(code, /Animated\.spring\(translateX, \{\s*toValue: target,/);
  assert.match(code, /useNativeDriver: false,/);
});

check('the spring converges exactly on the target (interrupted frames included)', () => {
  assert.match(code, /\.start\(\(\) => \{[\s\S]{0,220}translateX\.setValue\(target\);[\s\S]{0,120}stretch\.setValue\(1\);/);
});

check('a geometry-only change (rotation, RTL flip) snaps without travel', () => {
  assert.match(code, /if \(previous === null \|\| Math\.abs\(previous - target\) < 0\.5\)/);
});

console.log('\nGestures');

check('the drag writes the finger coordinate straight into the bubble', () => {
  assert.match(code, /translateX\.setValue\(next\);/);
  assert.match(code, /const delta = gesture\.dx - dragStartDx\.current;/);
});

check('the grab is hit-tested against the measured pill rect', () => {
  assert.match(code, /measureInWindow/);
  assert.match(code, /const touchX = start\.x - rect\.x;/);
  assert.match(code, /const bubbleStart = liveX\.current;/);
});

check('release snaps to the NEAREST tab and only then navigates', () => {
  assert.match(code, /targets\.forEach\(\(tabX, i\) => \{/);
  assert.match(code, /if \(nearest === activeVisibleRef\.current\) return;/);
  assert.match(code, /pressRef\.current\(info\.key, info\.routeIndex, info\.name\)/);
});

check('the drag targets are derived, so a mis-measured tab cannot skew them', () => {
  assert.match(code, /\(\) => visibleRoutes\.map\(\(_, i\) => tabX\(i\) \+ INDICATOR_INSET\)/);
});

check('a cancelled gesture returns to the active tab without navigating', () => {
  const cancel = code.slice(code.indexOf('const cancelDrag'), code.indexOf('const panResponder'));
  assert.match(cancel, /settleAt\(/);
  assert.ok(!/pressRef/.test(cancel), 'cancel must not navigate');
});

console.log('\nPreserved design');

check('the shared pill, blur and stretch survive', () => {
  assert.match(code, /<BlurView/);
  assert.match(code, /scaleX: stretch/);
  assert.match(code, /borderRadius: INDICATOR_HEIGHT \/ 2/);
});

check('one indicator only (no per-tab pill)', () => {
  const instances = code.match(/styles\.indicator/g) || [];
  assert.strictEqual(instances.length, 1, `expected one indicator, found ${instances.length}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const { name, error } of failures) {
    console.error(`\nFAILED: ${name}\n${error && error.stack ? error.stack : error}`);
  }
  process.exit(1);
}
