#!/usr/bin/env node
/**
 * Auth screen vertical layout — regression suite.
 *
 * Run: node tests/authLayoutCentering.test.cjs
 *
 * ─── THE DEFECT THIS PINS ────────────────────────────────────────────────────
 *
 * The Create Account screen (`src/app/(auth)/sign-up.tsx`) rendered its whole
 * block flush under the status bar on a tall iPhone, with all the slack
 * collected below the form.
 *
 * Root cause: its ScrollView `contentContainerStyle` had `flexGrow: 1` but NOT
 * `justifyContent: 'center'`. flexGrow stretches the content container to the
 * full viewport, which leaves the children pinned to the TOP of that box — so
 * any screen where the form is shorter than the visible area shows a top-hugging
 * block and dead space underneath. Sign In
 * (`src/app/(auth)/sign-in.tsx`) has carried `justifyContent: 'center'` since
 * the initial project upload; sign-up never did, so the two auth screens
 * disagreed about the same layout primitive.
 *
 * ─── WHY STRUCTURAL ─────────────────────────────────────────────────────────
 *
 * The contract is layout, not computation: with `flexGrow: 1` +
 * `justifyContent: 'center'` the block centres while it fits, and once the
 * content is taller than the viewport (small screen, landscape, keyboard open)
 * the container grows to the content height, centring becomes a no-op and the
 * ordinary scroll path takes over. There is no JS unit under test — the repo
 * pins these native-layout contracts by source shape, as it does elsewhere.
 *
 * No network, no device, no build.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(msg); console.log('  \u2717 ' + msg); }
}

/**
 * Extract a balanced JSX object-literal block: everything from the first `{{`
 * after `anchor` up to its matching `}}`. Line comments are stripped first so a
 * brace mentioned in prose cannot skew the count.
 */
function extractStyleBlock(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) return null;
  const open = src.indexOf('{{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length - 1; i++) {
    const two = src.slice(i, i + 2);
    if (two === '{{') { depth++; i++; continue; }
    if (two === '}}') { depth--; i++; if (depth === 0) return src.slice(open, i + 1); continue; }
  }
  return null;
}

const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '');

const SCREENS = {
  'Sign In': 'src/app/(auth)/sign-in.tsx',
  'Create Account': 'src/app/(auth)/sign-up.tsx',
};

console.log('\u2500\u2500 Both auth screens centre their content block \u2500\u2500');
for (const [name, rel] of Object.entries(SCREENS)) {
  const src = read(rel);
  const raw = extractStyleBlock(src, 'contentContainerStyle={');
  ok(raw !== null, `${name}: ScrollView contentContainerStyle located`);
  if (!raw) continue;
  const block = stripComments(raw);

  ok(/flexGrow:\s*1/.test(block),
    `${name}: container has flexGrow: 1 (needed for centring to have slack to distribute)`);
  ok(/justifyContent:\s*'center'/.test(block),
    `${name}: container centres vertically (justifyContent: 'center')`);
  ok(/paddingTop:\s*layout\.headerTop/.test(block),
    `${name}: top safe area applied via layout.headerTop (never a hardcoded offset)`);

  // No fixed heights and no magic top/bottom offsets — the block must stay
  // adaptive across screen sizes, aspect ratios and safe areas.
  ok(!/(^|[\s,{])(height|minHeight|maxHeight):\s*\d/.test(block),
    `${name}: container uses no fixed pixel height`);
  ok(!/(^|[\s,{])margin(Top|Bottom):\s*-?\d/.test(block),
    `${name}: container uses no hardcoded vertical margin`);
  ok(!/(^|[\s,{])padding(Top|Bottom):\s*\d/.test(block),
    `${name}: container uses no hardcoded vertical padding`);
  ok(!/position:\s*'absolute'/.test(block),
    `${name}: container is not absolutely positioned`);
}

console.log('\u2500\u2500 Create Account also respects the bottom safe area \u2500\u2500');
{
  const src = read(SCREENS['Create Account']);
  const block = stripComments(extractStyleBlock(src, 'contentContainerStyle={') ?? '');
  ok(/paddingBottom:\s*safeBottom\(/.test(block),
    'Create Account: bottom padding uses safeBottom(...) so the last row clears the '
    + 'home indicator / Android nav bar');

  // pageBottom/scrollBottom include tab-bar clearance; auth screens have no tab
  // bar, so reserving a native tab bar here would be wrong.
  ok(!/pageBottom|scrollBottom/.test(block),
    'Create Account: does NOT reserve tab-bar clearance (auth screens have no tab bar)');
}

console.log('\u2500\u2500 Keyboard + scroll behaviour unchanged \u2500\u2500');
for (const [name, rel] of Object.entries(SCREENS)) {
  const src = read(rel);
  ok(/automaticallyAdjustKeyboardInsets=\{process\.env\.EXPO_OS === 'ios'\}/.test(src),
    `${name}: iOS keyboard insets still applied by the native ScrollView`);
  ok(/behavior=\{undefined\}[^\n]*native inset only/.test(src)
    || /behavior=\{undefined\}/.test(src),
    `${name}: KeyboardAvoidingView still relies on the native keyboard inset`);
  ok(/keyboardShouldPersistTaps="handled"/.test(src),
    `${name}: keyboardShouldPersistTaps="handled" (first tap still activates the control)`);
}

console.log('\u2500\u2500 Registration behaviour untouched \u2500\u2500');
{
  const src = read(SCREENS['Create Account']);
  // The fix is layout-only: the submit path, validation and role assignment
  // must be exactly as before.
  // The button label is translated now; the submit CONTROL must still be there
  // and must still call the same handler.
  ok(/label=\{t\('signUp\.createAccount'\)\}/.test(src) && /onPress=\{handleSignUp\}/.test(src),
    'Create Account: submit button still present');
  ok(/router\.replace\('\/\(auth\)\/sign-in'\)/.test(src),
    'Create Account: post-registration redirect unchanged');
  ok(/role:\s*'student'/.test(src), 'Create Account: self-registration role still hardcoded to student');
  ok(/validateNationalNumber\(country, nationalPhone\.trim\(\)\)/.test(src),
    'Create Account: phone validation unchanged');
}

console.log('\n' + '\u2500'.repeat(46));
console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  \u2717 ' + f);
  process.exit(1);
}
console.log('ALL AUTH LAYOUT TESTS PASSED');
