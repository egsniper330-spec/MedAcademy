#!/usr/bin/env node
/**
 * Animated driver consistency — Android crash guard.
 *
 * React Native marks EVERY animated value attached to a view as "native" as
 * soon as one animation on that view runs with `useNativeDriver: true`
 * (AnimatedProps.__makeNative() walks every style node). A JS-driven animation
 * on such a value then throws inside Animation.start():
 *
 *   Error: Attempting to run JS driven animation on animated node that has
 *   been moved to "native" earlier by starting an animation with
 *   `useNativeDriver: true`
 *
 * On Android that exception is rethrown on the native-modules thread and kills
 * the process — it crashed the app on launch when the dashboard mounted the
 * tab bar (indicator pill: `fade` native, `translateX`/`stretch` JS).
 *
 * This test fails if any Animated.View mixes a native-driven value with a
 * JS-driven value in the same style, and locks GlassTabBar specifically.
 *
 * Run: node tests/animatedDriverConsistency.test.cjs
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

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

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

/**
 * The brace-balanced `{ … }` config object that starts at or after `from`.
 * Balanced matching matters: a fixed-width window would swallow the NEXT
 * animation in the same effect and report a driver that does not belong here.
 */
function configObject(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** var name → Set of drivers ('native' | 'js') used by explicit animations. */
function driverMap(src) {
  const map = new Map();
  const re = /Animated\.(?:timing|spring|decay)\(\s*([A-Za-z_$][\w$]*)\s*,/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const config = configObject(src, m.index + m[0].length - 1);
    const d = /useNativeDriver:\s*true/.test(config)
      ? 'native'
      : /useNativeDriver:\s*false/.test(config)
        ? 'js'
        : null;
    if (!d) continue;
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(d);
  }
  return map;
}

/** Style text of every opening tag that starts at `<Animated.View`. */
function animatedViewTags(src) {
  const tags = [];
  const re = /<Animated\.View\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + '<Animated.View'.length;
    let braces = 0;
    let quote = null;
    while (i < src.length) {
      const ch = src[i];
      if (quote) {
        if (ch === quote && src[i - 1] !== '\\') quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '{' || ch === '(') {
        braces++;
      } else if (ch === '}' || ch === ')') {
        braces--;
      } else if ((ch === '>' || ch === '/') && braces === 0) {
        break;
      }
      i++;
    }
    tags.push(src.slice(m.index, i));
  }
  return tags;
}

const files = walk(SRC);

console.log('\n=== Animated driver consistency ===\n');
console.log('── repo scan ──');

const violations = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes('Animated.View')) continue;
  const drivers = driverMap(src);
  if (drivers.size === 0) continue;
  for (const tag of animatedViewTags(src)) {
    const native = [];
    const js = [];
    for (const [name, set] of drivers) {
      // Match the value position only: `opacity: fade` must count `fade`, not
      // the style key `opacity`.
      if (!new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b(?!\\s*:)`).test(tag)) continue;
      if (set.has('native')) native.push(name);
      if (set.has('js')) js.push(name);
    }
    if (native.length > 0 && js.length > 0) {
      violations.push(`${rel(file)}: native=[${native.join(', ')}] js=[${js.join(', ')}]`);
    }
  }
}

check('no Animated.View mixes native-driven and JS-driven values', () => {
  assert.deepStrictEqual(violations, [], `mixed-driver views (fatal on Android):\n${violations.join('\n')}`);
});

console.log('\n── GlassTabBar indicator (the crash) ──');

const tabBar = fs.readFileSync(path.join(SRC, 'components/navigation/GlassTabBar.tsx'), 'utf8');
const tabDrivers = driverMap(tabBar);

check('the shared indicator values all stay JS-driven', () => {
  for (const name of ['translateX', 'stretch']) {
    assert.ok(tabDrivers.has(name), `${name} must be animated`);
    assert.deepStrictEqual(
      [...tabDrivers.get(name)],
      ['js'],
      `${name} lives on the same Animated.View as the JS-driven transform, so it must never be native-driven`,
    );
  }
  // The bubble's opacity must NOT be an animated value any more: it is derived
  // from the geometry, so a skipped effect cannot leave a present-but-invisible
  // bubble (the reported "indicator missing" defect).
  assert.ok(!tabDrivers.has('fade'), 'the indicator opacity must stay derived, not animated');
});

check('the indicator view carries derived opacity + ANIMATED LAYOUT left/width (no transform)', () => {
  assert.match(
    tabBar,
    /left: translateX,\s*\n\s*width: indicatorWidthAnim,\s*\n\s*backgroundColor:[\s\S]{0,400}opacity: indicatorWidth > 0 \? 1 : 0,/,
  );
  assert.ok(
    !/transform:\s*\[\{\s*translateX/.test(tabBar),
    'the bubble must not be painted through a transform layer (it painted nothing on the tablet)',
  );
});

check('the crash rule is documented next to the effect', () => {
  assert.match(tabBar, /ONE DRIVER PER VIEW/);
  assert.match(tabBar, /AnimatedProps\.__makeNative/);
});

check('translateX is still positioned directly from touch coordinates', () => {
  assert.match(tabBar, /translateX\.setValue\(/);
});

console.log('\n' + '='.repeat(62));
console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name } of failures) console.log(`  • ${name}`);
  console.log('='.repeat(62));
  process.exit(1);
}
console.log('Animated driver consistency: OK');
console.log('='.repeat(62));
