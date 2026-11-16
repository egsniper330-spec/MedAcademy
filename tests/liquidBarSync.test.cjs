#!/usr/bin/env node
/**
 * Liquid Bar — indicator/route synchronisation and drag contract.
 *
 * Regression guard for the on-device defect (Samsung SM-T505N, Android 12):
 * opening Profile showed the Profile screen while the indicator stayed parked
 * under Home; touching the stale bubble navigated back to Home because the tab
 * under it was Home; and the bubble could disappear and then never come back.
 *
 * Captured on the device while the bug was live:
 *   activeVisible: 3, activeIndex: 3, tabCount: 4, isRTL: true, rowWidth: 770,
 *   measuredX: [577.33, 385.33, 192.67, 0], targetX: 6,
 *   lastTarget: 583.33, positioned: true
 * -> the state/geometry were right and the ROUTE had moved, but the rendered
 *    bubble was still at the old position and its opacity could end at 0.
 *
 * Run: node tests/liquidBarSync.test.cjs
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

/** The route→indicator sync effect body. */
const syncEffect = (() => {
  const start = src.indexOf('const routeKey = activeKey');
  assert.ok(start > 0, 'route→indicator sync block not found');
  return src.slice(src.lastIndexOf('useEffect(() => {', start), src.indexOf('}, [activeKey', start));
})();

/** The PanResponder block. */
const panBlock = src.slice(src.indexOf('PanResponder.create('), src.indexOf('const bottomPad'));

console.log('\n=== Liquid Bar sync ===\n');
console.log('\u2500\u2500 route \u2192 indicator \u2500\u2500');

check('placement is keyed on route identity, not on a pixel comparison alone', () => {
  assert.match(src, /const placedKey = useRef\(''\)/);
  assert.match(syncEffect, /const routeKey = activeKey \?\? `#\$\{activeVisible\}`/);
  assert.match(syncEffect, /placedKey\.current = routeKey/);
});

check('a route change always travels the bubble to the new target', () => {
  assert.match(syncEffect, /const routeChanged = placedKey\.current !== routeKey/);
  assert.match(syncEffect, /if \(!firstPlacement && !routeChanged\)/);
  assert.match(syncEffect, /Animated\.spring\(translateX, \{\s*\n\s*toValue: targetX,/);
});

check('a finished or interrupted animation still lands exactly on target', () => {
  assert.match(
    syncEffect,
    /\.start\(\(\{ finished \}\) => \{\s*\n\s*\/\/ Convergence guarantee[\s\S]*?translateX\.setValue\(targetX\);[\s\S]*?stretch\.setValue\(1\);[\s\S]*?\}\)/,
  );
});

check('same route with new geometry snaps instead of animating from stale x', () => {
  assert.match(syncEffect, /if \(lastTarget\.current !== targetX\) \{\s*\n\s*lastTarget\.current = targetX;\s*\n\s*translateX\.setValue\(targetX\);/);
});

check('a missing measurement never hides or resets the bubble', () => {
  // The old code faded the pill to 0 here; that is what made it disappear.
  assert.match(syncEffect, /if \(!activeLayout\) return;/);
  assert.doesNotMatch(src, /toValue: 0, duration: 140/);
  assert.doesNotMatch(src, /opacity: fade/);
  assert.match(src, /opacity: indicatorWidth > 0 \? 1 : 0,/);
});

check('the bubble is sized from the measured tab, never hardcoded', () => {
  assert.match(syncEffect, /const width = Math\.max\(activeLayout\.width - INDICATOR_INSET \* 2, 0\)/);
  assert.match(src, /setIndicatorWidth\(/);
});

check('no route index is hardcoded (works for every nav item and any role)', () => {
  assert.doesNotMatch(src, /activeVisible\s*===?\s*[0-9]/);
  assert.doesNotMatch(src, /routeIndex\s*===?\s*3\b/);
});

console.log('\n\u2500\u2500 drag contract \u2500\u2500');

check('touching the bubble alone never navigates (no claim on touch-down)', () => {
  assert.match(panBlock, /onStartShouldSetPanResponder: \(\) => false/);
  assert.match(panBlock, /onMoveShouldSetPanResponder: \(_event, gesture\) => \{[\s\S]*?Math\.abs\(gesture\.dx\) < DRAG_THRESHOLD/);
});

check('navigation happens only on release, to the nearest tab, and only if it differs', () => {
  const finish = src.slice(src.indexOf('const finishDrag'), src.indexOf('const cancelDrag'));
  assert.match(finish, /settleAt\(targets\[nearest\]\)/);
  assert.match(finish, /if \(nearest === activeVisibleRef\.current\) return;/);
  assert.match(finish, /pressRef\.current\(info\.key, info\.routeIndex, info\.name\)/);
});

check('a cancelled gesture returns to the active tab without navigating', () => {
  const cancel = src.slice(src.indexOf('const cancelDrag'), src.indexOf('const panResponder'));
  assert.match(cancel, /targetsRef\.current\[activeVisibleRef\.current\]/);
  assert.match(cancel, /settleAt\(/);
  assert.doesNotMatch(cancel, /pressRef\.current/);
});

check('the drag writes the finger position into the JS mirror used for hit-testing', () => {
  assert.match(panBlock, /translateX\.setValue\(next\);\s*\n\s*liveX\.current = next;/);
});

check('the release target list covers EVERY visible tab', () => {
  assert.match(src, /const tabTargets = useMemo\(\s*\n\s*\(\) => visibleRoutes\.map\(/);
  assert.match(src, /targetsRef\.current = tabTargets/);
});

console.log('\n' + '='.repeat(62));
console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name } of failures) console.log(`  \u2022 ${name}`);
  console.log('='.repeat(62));
  process.exit(1);
}
console.log('Liquid Bar sync: OK');
console.log('='.repeat(62));
