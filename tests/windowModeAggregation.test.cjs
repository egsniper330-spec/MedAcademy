#!/usr/bin/env node
/**
 * WINDOW-MODE STATE AGGREGATION — one authoritative belief from several producers.
 *
 * Run: node tests/windowModeAggregation.test.cjs
 *
 * SCOPE AFTER THE FLOATING-WINDOW REMOVAL
 *
 *   The floating-window ("foreign window") classification was removed: it was
 *   derived from window-FOCUS loss, fired on Recents / app switches / pop-up
 *   view teardown, and Android exposes no API that could prove it. This suite now
 *   pins the part that remains and must never regress:
 *
 *     • the reducer accepts a prohibited reading immediately, from any producer;
 *     • duplicate reports are inert (no action, no emission, no timeline mark);
 *     • a weak full-screen snapshot cannot clear a prohibited hold;
 *     • activity-level evidence may clear it;
 *     • out-of-order observations never overwrite newer evidence;
 *     • 'unknown' is never a finding and never a clearance;
 *     • NO foreign-window vocabulary survives in the native template, the
 *       reducer or the JS applier.
 *
 * Part 1 executes the real reducer (src/lib/windowModeAggregator.ts).
 * Part 2 pins the emitted Kotlin decision table the reducer mirrors.
 * Part 3 pins reason independence (clearing window never clears VPN/overlay).
 *
 * These are NOT physical proof: Android's callback delivery and the real
 * transition timing are verified on the device.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const PLUGIN = read('plugins/withSecurityModule.js');
const CONTEXT = read('src/lib/SecurityContext.tsx');
const NATIVE_JS = read('src/lib/nativeSecurity.ts');
const AGGREGATOR = read('src/lib/windowModeAggregator.ts');
const AGGREGATOR_CODE_ONLY = AGGREGATOR
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

/** The Kotlin object body, isolated so assertions cannot leak into the module. */
function objBody(startMarker, endMarker) {
  const start = PLUGIN.indexOf(startMarker);
  const end = PLUGIN.indexOf(endMarker, start + 1);
  if (start < 0 || end < 0) return '';
  return PLUGIN.slice(start, end);
}
const BRIDGE = objBody('object WindowModeBridge {', ' * SecurityContainment \u2014 NATIVE containment');
const CONTAINMENT = objBody('object SecurityContainment {', ' * SecurityModule \u2014 comprehensive native Android security checks.');

/** Compile the dependency-free reducer and require the result. */
function buildModel(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'windowmode-model-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src', 'lib', file),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(tmp, file.replace(/\.ts$/, '.js')));
}

// ── Part 1: the reducer is the single decision point ────────────────────────
console.log('\u2500\u2500 Part 1: reducer behaviour (executed) \u2500\u2500');
{
  const { decideWindowMode, initialWindowModeState } = buildModel('windowModeAggregator.ts');
  if (typeof decideWindowMode !== 'function') {
    console.error('  \u274c reducer did not compile');
    process.exit(1);
  }

  /** Fresh chain + a monotonic sequence, exactly as the app drives it. */
  const chain = () => {
    let state = initialWindowModeState();
    let seq = 0;
    return {
      send(mode, evidence) {
        const t = decideWindowMode(state, { mode, evidence, seq: ++seq });
        state = t.state;
        return t;
      },
      sendAt(mode, evidence, at) {
        const t = decideWindowMode(state, { mode, evidence, seq: at });
        state = t.state;
        return t;
      },
      get state() { return state; },
    };
  };

  // ── Repeated identical reports ────────────────────────────────────────────
  {
    const c = chain();
    const first = c.send('fullscreen', 'read');
    check('1a: the first real measurement is accepted (measured becomes true)',
      first.decision === 'accept' && first.acceptedMode === 'fullscreen' && c.state.measured);

    const dup1 = c.send('fullscreen', 'read');
    const dup2 = c.send('fullscreen', 'flags');
    const dup3 = c.send('fullscreen', 'layout');
    check('1b: a repeated identical report is a duplicate, never an action',
      dup1.decision === 'duplicate' && dup2.decision === 'duplicate' && dup3.decision === 'duplicate');
    check('1c: a duplicate carries NO accepted mode (nothing to act on)',
      dup1.acceptedMode === null && dup2.acceptedMode === null && dup3.acceptedMode === null);
    check('1d: duplicates are counted so the churn stays measurable',
      c.state.suppressed === 3);
    check('1e: a duplicate never marks a state change', c.state.lastSeq >= 4 && c.state.mode === 'fullscreen');
  }

  // ── Split-screen is raised immediately ────────────────────────────────────
  {
    const c = chain();
    c.send('fullscreen', 'read');
    const t = c.send('multi_window', 'flags');
    check('1f: split-screen is accepted IMMEDIATELY from a snapshot producer (no debounce)',
      t.decision === 'accept' && t.acceptedMode === 'multi_window' &&
        t.reason === 'prohibited-mode-accepted-immediately');
    const pip = c.send('picture_in_picture', 'layout');
    check('1g: PiP is accepted immediately too', pip.decision === 'accept' && pip.acceptedMode === 'picture_in_picture');
  }

  // ── A weak snapshot cannot clear a prohibited hold ────────────────────────
  {
    const c = chain();
    c.send('fullscreen', 'read');
    c.send('multi_window', 'activity');
    const weak = c.send('fullscreen', 'layout');
    check('1h: a weak full-screen snapshot CANNOT clear a split-screen hold',
      weak.decision === 'rejected' && weak.acceptedMode === null);
    check('1i: the hold is still in force after the weak snapshot', c.state.mode === 'multi_window');
    const flagSnap = c.send('fullscreen', 'flags');
    check('1j: the flag batch is weak evidence too (same state, same refusal)',
      flagSnap.decision === 'rejected' && c.state.mode === 'multi_window');
    check('1k: refusals are counted', c.state.rejected === 2);
  }

  // ── Activity-level recovery ───────────────────────────────────────────────
  {
    const c = chain();
    c.send('multi_window', 'activity');
    const release = c.send('fullscreen', 'activity');
    check('1l: activity-level full-screen evidence releases the hold at once',
      release.decision === 'accept' && release.acceptedMode === 'fullscreen' && c.state.mode === 'fullscreen');
    const resumeRelease = chain();
    resumeRelease.send('picture_in_picture', 'activity');
    check('1m: a resume read is activity-level evidence as well',
      resumeRelease.send('fullscreen', 'resume').decision === 'accept');
    const dupAfter = c.send('fullscreen', 'layout');
    check('1n: once released, the restored state is inert to repeats', dupAfter.decision === 'duplicate');
    const c2 = chain();
    c2.send('multi_window', 'activity');
    check('1o: a repeated prohibited reading is deduplicated, not re-raised',
      c2.send('multi_window', 'layout').decision === 'duplicate');
  }

  // ── Out-of-order reports ──────────────────────────────────────────────────
  {
    const c = chain();
    c.send('fullscreen', 'read');            // seq 1
    c.send('multi_window', 'activity');      // seq 2
    const stale = c.sendAt('fullscreen', 'layout', 1);
    check('1t: an older observation is dropped instead of overwriting newer evidence',
      stale.decision === 'rejected' && stale.reason === 'out-of-order-observation');
    check('1u: the newer evidence survives the stale report', c.state.mode === 'multi_window');
    check('1v: the dropped observation is counted', c.state.rejected === 1);
  }

  // ── Unmeasurable moments ──────────────────────────────────────────────────
  {
    const c = chain();
    const before = c.send('unknown', 'flags');
    check('1z1: an unmeasurable reading is neither a finding nor a clearance',
      before.decision === 'ignore-unknown' && before.acceptedMode === null && !c.state.measured);
    c.send('multi_window', 'activity');
    check('1z2: an unmeasurable reading cannot clear a live violation',
      c.send('unknown', 'flags').decision === 'ignore-unknown' && c.state.mode === 'multi_window');
  }

  // ── The state object is never mutated in place ────────────────────────────
  {
    const start = initialWindowModeState();
    const snapshot = JSON.stringify(start);
    decideWindowMode(start, { mode: 'multi_window', evidence: 'activity', seq: 1 });
    check('1z3: decideWindowMode() is pure (the input state is untouched)',
      JSON.stringify(start) === snapshot);
  }

  // ── The removed classification cannot be reintroduced through the reducer ──
  {
    const c = chain();
    c.send('fullscreen', 'read');
    const stray = c.send('foreign_window', 'activity');
    check('1z4: the reducer has no foreign mode (an unexpected string is not prohibited)',
      !/foreign_window/.test(AGGREGATOR) && stray.acceptedMode !== 'foreign_window');
    // Comments may EXPLAIN the removal; the CODE must not carry the vocabulary.
    const AGGREGATOR_CODE = AGGREGATOR_CODE_ONLY;
    check('1z5: the reducer type carries only fullscreen / multi / PiP / unknown',
      /'fullscreen'/.test(AGGREGATOR_CODE) && /'multi_window'/.test(AGGREGATOR_CODE) &&
        /'picture_in_picture'/.test(AGGREGATOR_CODE) && /'unknown'/.test(AGGREGATOR_CODE) &&
        !/foreign/.test(AGGREGATOR_CODE));
    check('1z6: the reducer exposes no sticky-foreign machinery',
      !/foreignSticky|defer-confirm|recovery/i.test(AGGREGATOR));
  }
}

// ── Part 2: the native mirror — one funnel, dedup BEFORE action ─────────────
console.log('\u2500\u2500 Part 2: native aggregator + no redundant cover work \u2500\u2500');
{
  check('2a: ONE funnel receives every producer (activity callbacks and module reads)',
    BRIDGE.includes('fun observe(mode: String, source: String): String') &&
      /fun report\([\s\S]{0,400}observe\(mode, source\)/.test(BRIDGE));
  check('2b: the decision table names its three outcomes',
    ['"accept"', '"duplicate"', '"unknown"'].every((d) => BRIDGE.includes(d)));
  check('2c: a duplicate is detected BEFORE any containment action',
    /if \(measured && mode == lastReported\)[\s\S]{0,120}suppressed \+= 1[\s\S]{0,80}return "duplicate"/.test(BRIDGE));
  check('2d: a prohibited reading (multi / PiP) is raised immediately, from any producer',
    /val prohibited = mode == WINDOW_MODE_MULTI \|\| mode == WINDOW_MODE_PIP[\s\S]{0,400}accept\(mode, source\)[\s\S]{0,120}return "accept"/.test(BRIDGE));
  check('2e: raising never goes through a postDelayed/delay',
    !/prohibited[\s\S]{0,260}postDelayed/.test(BRIDGE));
  check('2f: no window may be classified from focus loss',
    !/foreignWindowFocused|topResumedSlot|WINDOW_MODE_FOREIGN|hasWindowFocus/.test(BRIDGE));
  check('2g: no recovery hysteresis / sticky hold survives',
    !/foreignSticky|RECOVERY_SETTLE_MS|recoveryStartedAtMs|defer-confirm/.test(BRIDGE));
  check('2h: activity-level evidence is the authoritative source',
    /private fun isAuthoritative\(source: String\): Boolean =\s*source == "lifecycle"/.test(BRIDGE));
  check('2i: the mapping is PiP, then multi-window, then full screen',
    /if \(isInPictureInPictureMode\) return WINDOW_MODE_PIP[\s\S]{0,120}if \(isInMultiWindowMode\) return WINDOW_MODE_MULTI[\s\S]{0,80}return WINDOW_MODE_FULLSCREEN/.test(BRIDGE));
  check('2j: the activity reports mode changes with a source label',
    /WindowModeBridge\.report\(isInMultiWindowMode, isInPictureInPictureMode\(\), "mode-change"\)/.test(PLUGIN));
  check('2k: the activity reports the mode on resume (replay of real state)',
    /WindowModeBridge\.report\(isInMultiWindowMode\(\), isInPictureInPictureMode\(\), "lifecycle"\)/.test(PLUGIN));
  check('2l: duplicate / suppressed counters still exist for release measurement',
    BRIDGE.includes('var suppressed: Int') && BRIDGE.includes('var lastCollapsed: Int'));
  check('2m: containment itself dedups the mode it acts on',
    CONTAINMENT.includes('lastContainmentWindowMode') &&
      /if \(mode == lastContainmentWindowMode\) return/.test(CONTAINMENT));
  check('2n: reportWindowMode does not mark on every call',
    !/fun reportWindowMode\(mode: String, source: String\) \{[\s\S]{0,200}mark\("window-mode"/.test(CONTAINMENT));
  check('2o: the timeline marker explains accepted decisions',
    CONTAINMENT.includes('fun noteWindowDecision(') &&
      CONTAINMENT.includes('"window-mode-" + decision'));
  check('2p: non-accepted decisions are rate-limited (the buffer explains, not floods)',
    CONTAINMENT.includes('WINDOW_MODE_MARK_MIN_MS') &&
      /if \(!always && windowMarkAtElapsed != 0L/.test(CONTAINMENT));
  check('2q: the module acts ONLY on an accepted/replayed decision',
    /val accepted = decision == "accept" \|\| decision == "replay"/.test(PLUGIN) &&
      /if \(accepted\) \{[\s\S]{0,400}SecurityContainment\.reportWindowMode\(mode, source\)/.test(PLUGIN));
  check('2r: a duplicate/unknown decision returns before any containment call',
    /if \(decision == "duplicate" \|\| decision == "unknown"\) return/.test(PLUGIN));
  check('2s: publishWindowMode only feeds the aggregator (it cannot re-raise by itself)',
    /private fun publishWindowMode\(mode: String, source: String\) \{[\s\S]{0,240}WindowModeBridge\.observe\(mode, source\)[\s\S]{0,40}\}/.test(PLUGIN) &&
      !/private fun publishWindowMode[\s\S]{0,300}SecurityContainment\.reportWindowMode/.test(PLUGIN));
  check('2t: the JS bridge event is emitted only on an accepted transition',
    /if \(changed \|\| decision == "replay"\)[\s\S]{0,200}emitWindowModeChanged/.test(PLUGIN));
  check('2v: counters are readable over the bridge (release-build measurement)',
    PLUGIN.includes('out.putInt("windowSuppressed"') &&
      NATIVE_JS.includes('windowSuppressed: number'));
  check('2w: the gate prints the aggregation counters with the timeline',
    // Only counters that still EXIST natively: the rejected/deferred tallies
    // belonged to the removed weak-evidence path, so printing them would be a
    // permanently-zero diagnostic.
    read('src/app/(app)/security-gate.tsx').includes('timeline.windowSuppressed') &&
      read('src/app/(app)/security-gate.tsx').includes('timeline.windowCollapsed') &&
      !read('src/app/(app)/security-gate.tsx').includes('timeline.windowRejected'));
  check('2x: no confirmRecoveryRunnable / paced re-read remains',
    !/confirmRecoveryRunnable/.test(PLUGIN));
  check('2y: no touch/poll loop was added to replace the removed detector',
    !/setInterval|scheduleAtFixedRate/.test(PLUGIN));
}

// ── Part 3: the JS authority uses the same reducer ──────────────────────────
console.log('\u2500\u2500 Part 3: JS belief + reason independence \u2500\u2500');
{
  check('3a: JS routes every reading through the reducer',
    CONTEXT.includes('decideWindowMode(windowModeChainRef.current') &&
      CONTEXT.includes('windowModeChainRef.current = transition.state'));
  check('3b: a JS event is activity-level evidence',
    /onNativeWindowModeChanged\(\(reading\)[\s\S]{0,400}applyWindowModeReading\(reading\.mode, true, 'activity'\)/.test(CONTEXT));
  check('3c: a JS preflight/reassert snapshot cannot flip the belief',
    /const transition = decideWindowMode[\s\S]{0,1600}if \(transition\.decision !== 'accept' \|\| !transition\.acceptedMode\) return;/.test(CONTEXT));
  check('3d: JS keeps no deferred-confirmation path for a removed mode',
    !/defer-confirm/.test(CONTEXT) && !/applyWindowModeReadingRef/.test(CONTEXT));
  check('3e: clearing the WINDOW reason never touches overlay or VPN',
    /else if \(mode == WINDOW_MODE_FULLSCREEN\) \{\s*clear\(REASON_WINDOW/.test(CONTAINMENT) &&
      !/clear\(REASON_OVERLAY[\s\S]{0,80}reportWindowMode/.test(CONTAINMENT));
  check('3f: a window raise never clears another reason',
    /if \(prohibited\) \{\s*raise\(REASON_WINDOW/.test(CONTAINMENT) &&
      !/raise\(REASON_WINDOW[\s\S]{0,240}clear\(REASON_(OVERLAY|VPN)/.test(CONTAINMENT));
  check('3g: the reason set is still removed one reason at a time',
    CONTAINMENT.includes('removed = reasons.remove(reason)') &&
      CONTAINMENT.includes('nowEmpty = reasons.isEmpty()'));
  check('3h: the overlay latch and its declaration are GONE (removed subsystem)',
    !PLUGIN.includes('android.permission.HIDE_OVERLAY_WINDOWS') &&
      !PLUGIN.includes('setHideOverlayWindows') &&
      !PLUGIN.includes('REASON_OVERLAY'));
  check('3i: the JS model/copy has no foreign-window page left',
    !/foreign_window/.test(read('src/lib/securityStateModel.ts')) &&
      !/security\.window\.foreign/.test(read('src/lib/i18n/resources.ts')) &&
      !/foreign_window/.test(read('src/app/(app)/security-gate.tsx')));
  check('3j: split-screen and PiP still take the HARD app-wide lock',
    /engageSecurityLock\(LOCK_SRC_WINDOW_MODE, \{ hard: true \}\)/.test(CONTEXT) &&
      /blockProtectedContent\('multi-window'\)/.test(CONTEXT));
}

console.log('\n' + '\u2500'.repeat(60));
console.log('windowModeAggregation: ' + passed + ' passed, ' + failed + ' failed');
console.log('NOTE: source-level + reducer contracts. Real transition timing, the');
console.log('cover flap and the physical overlay matrix are verified on the device.');
process.exit(failed === 0 ? 0 : 1);
