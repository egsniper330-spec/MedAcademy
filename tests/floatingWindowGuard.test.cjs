#!/usr/bin/env node
/**
 * Regression: another app floating OVER MedAcademy went undetected while
 * split-screen worked.
 *
 * Split-screen is positive platform state (Activity.isInMultiWindowMode). A
 * floating window from another task keeps our task resumed and full screen but
 * takes the ACTIVITY's window focus — the one documented signal an ordinary app
 * has. It is now reported as its own mode (`foreign_window`), so the existing
 * security gate, preflight and release rules apply unchanged.
 *
 * The app's own dialogs also take window focus, so they must suppress it.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const plugin = read('plugins', 'withSecurityModule.js');
const model = read('src', 'lib', 'securityStateModel.ts');
const securityContext = read('src', 'lib', 'SecurityContext.tsx');
const appModal = read('src', 'components', 'AppModal.tsx');
const ownDialogs = read('src', 'lib', 'ownDialogs.ts');

function loadTs(rel) {
  const js = ts.transpileModule(read.apply(null, rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const tmp = path.join(os.tmpdir(), `${path.basename(rel[rel.length - 1])}-${process.pid}.cjs`);
  fs.writeFileSync(tmp, js);
  const mod = require(tmp);
  fs.unlinkSync(tmp);
  return mod;
}

const modelMod = loadTs(['src', 'lib', 'securityStateModel.ts']);
const ownDialogMod = loadTs(['src', 'lib', 'ownDialogs.ts']);

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

console.log('Native signal');

check('a new prohibited mode exists for another app\'s window', () => {
  assert.match(plugin, /WINDOW_MODE_FOREIGN = "foreign_window"/);
});

check('focus counts while RESUMED too, and never outranks multi-window/PiP', () => {
  const modeOf = plugin.slice(plugin.indexOf('fun modeOf('), plugin.indexOf('fun modeOf(') + 1200);
  assert.match(modeOf, /if \(isInPictureInPictureMode\) return WINDOW_MODE_PIP/);
  assert.match(modeOf, /if \(isInMultiWindowMode\) return WINDOW_MODE_MULTI/);
  // ROOT CAUSE: the old rule required !appResumed, so a pop-up over a RESUMED
  // app was classified full screen and playback continued.
  assert.match(modeOf, /if \(foreignWindowFocused\) return WINDOW_MODE_FOREIGN/);
  assert.ok(!/foreignWindowFocused && appResumed/.test(modeOf));
});

check('the activity forwards window focus loss and re-reads it before reporting', () => {
  assert.match(plugin, /override fun onWindowFocusChanged\(hasFocus: Boolean\)/);
  assert.match(plugin, /val focused = try \{ !activity\.window\.decorView\.hasWindowFocus\(\) \}/);
  assert.match(plugin, /WindowModeBridge\.report\(\s*\n\s*isInMultiWindowMode\(\),\s*\n\s*isInPictureInPictureMode\(\),\s*\n\s*true,\s*\n\s*!activityPaused,/);
});

check('the periodic re-assert and the preflight read the same focus state', () => {
  const readMode = plugin.slice(plugin.indexOf('private fun readWindowMode'), plugin.indexOf('private fun readWindowMode') + 900);
  assert.match(readMode, /val focused = try \{ !activity\.window\.decorView\.hasWindowFocus\(\) \}/);
  assert.match(readMode, /focused,\s*\n\s*hostResumed,/);
});

check('split-screen protection is untouched (still reported first)', () => {
  assert.match(plugin, /Activity\.isInMultiWindowMode\(\)/);
  assert.match(plugin, /WINDOW_MODE_MULTI/);
  assert.match(plugin, /isInMultiWindowMode\(\)/);
});

console.log('\nJS policy');

check('the model treats a foreign window as prohibited', () => {
  assert.strictEqual(modelMod.isProhibitedWindowMode('foreign_window'), true);
  assert.strictEqual(modelMod.isProhibitedWindowMode('fullscreen'), false);
  assert.strictEqual(modelMod.isProhibitedWindowMode('unknown'), false);
});

check('it has its own blocking copy and steps (never called an overlay)', () => {
  const copy = modelMod.windowModeBlockCopy('foreign_window');
  assert.match(copy.title, /floating window/i);
  assert.match(copy.message, /floating window/i);
  assert.ok(!/overlay/i.test(copy.message), 'the overlay signal is separate and must not be claimed here');
  assert.strictEqual(modelMod.windowModeBlockSteps('foreign_window').length, 3);
});

check('the gate suppresses it while one of our own dialogs is open', () => {
  assert.match(securityContext, /incomingMode === 'foreign_window' && hasOwnDialogOpen\(\)/);
});

check('every RN Modal in the app is now an AppModal (own dialogs are tracked)', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.tsx')) files.push(p);
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  const offenders = files
    .filter((f) => !f.endsWith(`AppModal.tsx`))
    .filter((f) => /<Modal[\s/>]/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(offenders, [], `raw <Modal> left in: ${offenders.join(', ')}`);
  assert.match(appModal, /registerOwnDialog\(\)/);
  assert.match(appModal, /<Modal visible=\{visible\} \{\.\.\.rest\} \/>/);
});

check('the own-dialog counter is reference-counted', () => {
  const release = ownDialogMod.registerOwnDialog();
  assert.strictEqual(ownDialogMod.hasOwnDialogOpen(), true);
  release();
  release();
  assert.strictEqual(ownDialogMod.hasOwnDialogOpen(), false, 'double release must not underflow');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
