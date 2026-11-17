#!/usr/bin/env node
/**
 * Regression: the retired Offline Video page must be unreachable from the
 * student account (it belonged to the retired VdoCipher feature).
 *
 * Checked: the screens are gone, no navigation path (drawer, stack, route table,
 * cold-start router, lesson screen) can still reach them.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(root, ...p));

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    console.error(`  \u2717 ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
};

console.log('Offline Video page removed');

check('the screens no longer exist', () => {
  assert.strictEqual(exists('src', 'app', '(app)', 'offline-library.tsx'), false);
  assert.strictEqual(exists('src', 'app', '(app)', 'offline-course.tsx'), false);
});

check('the stack no longer registers them', () => {
  const layout = read('src', 'app', '(app)', '_layout.tsx');
  assert.ok(!/Stack\.Screen name="offline-library"/.test(layout));
  assert.ok(!/Stack\.Screen name="offline-course"/.test(layout));
});

check('the drawer has no entry pointing at them', () => {
  const drawer = read('src', 'components', 'DrawerNav.tsx');
  assert.ok(!/path: '\/offline-library'/.test(drawer), 'no drawer item may target the retired page');
});

check('the role route table no longer lists the page', () => {
  const routes = read('src', 'lib', 'navigation', 'rootRoutes.ts');
  assert.ok(!/'\/offline-library'/.test(routes));
});

check('no code pushes a navigation to the retired routes', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
        const text = fs.readFileSync(p, 'utf8');
        if (/['"`]\/offline-(library|course)/.test(text)) offenders.push(path.relative(root, p));
      }
    }
  };
  walk(path.join(root, 'src'));
  assert.deepStrictEqual(offenders, [], `still navigates to the retired page: ${offenders.join(', ')}`);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
