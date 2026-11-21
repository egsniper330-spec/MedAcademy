#!/usr/bin/env node
/**
 * FLOATING-WINDOW PROTECTION — REMOVAL CONTRACT.
 *
 * The floating-window ("another app is over MedAcademy") subsystem was removed
 * after repeated false positives: it was derived from the activity's window
 * FOCUS, which Recents, an app switch, a system dialog, a Samsung pop-up view
 * being closed and even our own cover view all change. Android exposes no window
 * enumeration to an ordinary app, so the condition could neither be proven nor
 * made reliable. This suite fails if any part of it comes back, and pins what
 * must remain independent of it.
 *
 * Run: node tests/floatingWindowGuard.test.cjs
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
const aggregator = read('src', 'lib', 'windowModeAggregator.ts');
const gate = read('src', 'app', '(app)', 'security-gate.tsx');
const resources = read('src', 'lib', 'i18n', 'resources.ts');
const nativeSecurity = read('src', 'lib', 'nativeSecurity.ts');
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

/** The Kotlin template (module + injected activity), without the JS upgrade guard. */
const KT = plugin.slice(0, plugin.indexOf('const WINDOW_MODE_ACTIVITY_MARKER'));
const OVERRIDES_START = plugin.indexOf('const WINDOW_MODE_ACTIVITY_OVERRIDES');
const OVERRIDES = plugin.slice(
  OVERRIDES_START,
  plugin.indexOf('`;', OVERRIDES_START) + 2, // the template literal itself, not the JS around it
);

console.log('Removal is complete');

check('no foreign-window mode, mode mapping or focus detector in the native template', () => {
  assert.ok(!/WINDOW_MODE_FOREIGN/.test(KT));
  assert.ok(!/foreignWindowFocused|topResumedSlot|setTopResumed/.test(KT));
  assert.ok(!/windowCoveredByOtherTask|scheduleForeignCheck|cancelForeignCheck/.test(KT));
});

check('the injected activity no longer overrides onTopResumedActivityChanged', () => {
  assert.ok(!/onTopResumedActivityChanged[\s\S]{0,120}super\./.test(OVERRIDES));
  assert.ok(!/topResumedActivity|foreignWindowCheck|activityPaused/.test(OVERRIDES));
});

check('the JS model has no foreign mode, copy or steps', () => {
  assert.ok(!/foreign_window|FOREIGN_WINDOW/.test(model));
  assert.strictEqual(modelMod.isProhibitedWindowMode('foreign_window'), false);
  assert.strictEqual(modelMod.isProhibitedWindowMode('multi_window'), true);
  assert.strictEqual(modelMod.isProhibitedWindowMode('picture_in_picture'), true);
});

check('the aggregator has no sticky-foreign / deferred-confirmation machinery', () => {
  const code = aggregator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/foreign|sticky|defer-confirm/i.test(code));
});

check('the JS applier and the gate have no foreign branch or page', () => {
  assert.ok(!/foreign_window/.test(securityContext));
  assert.ok(!/foreign_window|security\.window\.foreign/.test(gate));
});

check('both locales dropped the floating-window copy', () => {
  assert.ok(!/security\.window\.foreign/.test(resources));
});

check('the native flags advertise no obscured-window field at all', () => {
  // Removed end to end: no flag field, no protection field, no overlay verdict.
  assert.ok(!/windowObscured/.test(nativeSecurity));
  assert.ok(!/overlayProtectionInstalled/.test(nativeSecurity));
  assert.ok(!/overlayDetected/.test(nativeSecurity));
});

console.log('\nPreserved, independent protections');

check('split-screen and PiP are still prohibited and gated', () => {
  assert.ok(/if \(isInMultiWindowMode\) return WINDOW_MODE_MULTI/.test(KT));
  assert.ok(/if \(isInPictureInPictureMode\) return WINDOW_MODE_PIP/.test(KT));
  assert.ok(/ENGAGE|engageSecurityLock\(LOCK_SRC_WINDOW_MODE, \{ hard: true \}\)/.test(securityContext.replace('ENGAGE|', '')));
});

check('the obscured-touch (tapjacking) latch is GONE from the native template', () => {
  assert.ok(!KT.includes('FLAG_WINDOW_IS_OBSCURED'));
  assert.ok(!KT.includes('FLAG_WINDOW_IS_PARTIALLY_OBSCURED'));
  assert.ok(!KT.includes('revalidate-region-verified'));
  assert.ok(!/observeTouch|isOverlayLatched|coveredPoints/.test(KT));
});

check('overlay PREVENTION and its permission are gone too', () => {
  // KT only: the JS upgrade guard names retired symbols on purpose.
  assert.ok(!/applyHideOverlayWindows/.test(KT));
  assert.ok(!/HIDE_OVERLAY_WINDOWS/.test(KT));
  assert.ok(!/enableOverlayProtection|isWindowObscured/.test(KT));
});

check('VPN / proxy detection is untouched', () => {
  assert.ok(/object VpnWatch \{/.test(KT));
  assert.ok(/REASON_VPN/.test(KT));
  assert.ok(/fun detectProxy\(\): Boolean/.test(KT));
});

check('the release rule still needs a restored mode AND a fresh verdict', () => {
  assert.strictEqual(modelMod.canClearMultiWindowBlock({ modeRestored: false, hasFreshVerdict: true }), false);
  assert.strictEqual(modelMod.canClearMultiWindowBlock({ modeRestored: true, hasFreshVerdict: false }), false);
  assert.strictEqual(modelMod.canClearMultiWindowBlock({ modeRestored: true, hasFreshVerdict: true }), true);
});

check('every RN Modal in the app is still an AppModal (own dialogs are tracked)', () => {
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
    .filter((f) => !f.endsWith('AppModal.tsx'))
    .filter((f) => /<Modal[\s/>]/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(offenders, [], `raw <Modal> left in: ${offenders.join(', ')}`);
  assert.match(appModal, /registerOwnDialog\(\)/);
});

check('the own-dialog counter is reference-counted', () => {
  const release = ownDialogMod.registerOwnDialog();
  assert.strictEqual(ownDialogMod.hasOwnDialogOpen(), true);
  release();
  release();
  assert.strictEqual(ownDialogMod.hasOwnDialogOpen(), false, 'double release must not underflow');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
