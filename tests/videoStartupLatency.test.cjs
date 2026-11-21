#!/usr/bin/env node
/**
 * VIDEO STARTUP LATENCY — the execution architecture, measured honestly.
 *
 * Run: node tests/videoStartupLatency.test.cjs
 *
 * ─── WHAT WAS ACTUALLY HAPPENING ───────────────────────────────────────────
 *
 * `checkBeforeVideo()` → `runGuardedCheck('pre-video')` → `runSecurityChecks()`
 * with scope 'full'. The 14 detectors were NEVER sequential: they run in ONE
 * `Promise.all`, so the wall-clock cost is the SLOWEST detector, not the sum.
 * The real defects were elsewhere:
 *
 *   1. NO MEASURABLE EVIDENCE. Per-detector timings were printed only in DEV
 *      (or behind EXPO_PUBLIC_SECURITY_DIAGNOSTICS), so on the release APK there
 *      was no way to attribute the delay to a named detector.
 *   2. DUPLICATE WORK. Two surfaces ask for the pre-video check in the same
 *      gesture (player mount + shouldAllowPlayback) and a bootstrap/resume
 *      evaluation can be in flight; runGuardedCheck's generation guard then
 *      DISCARDED the older run, so the full pipeline (network-bound Play
 *      Integrity nonce round trip + TLS probe) ran twice and a verdict was
 *      thrown away.
 *   3. FAIL-OPEN ON A MISSING VERDICT. A timed-out mandatory detector resolved
 *      to "no threat", and a superseded pre-video result returned false
 *      (= allowed).
 *
 * These are source-level + contract assertions. The per-detector millisecond
 * numbers come from the `[SecurityCheck][timing]` line on the device.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const SECURITY = read('src/lib/security.ts');
const CONTEXT = read('src/lib/SecurityContext.tsx');
const LESSON = read('src/app/(app)/lesson/[id].tsx');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

const pipeline = (() => {
  const start = SECURITY.indexOf('] = await Promise.all([');
  const end = SECURITY.indexOf('const integrityThreat', start);
  return start < 0 || end < 0 ? '' : SECURITY.slice(start, end);
})();
const checkBeforeVideo = (() => {
  const start = CONTEXT.indexOf('const checkBeforeVideo = useCallback');
  const end = CONTEXT.indexOf('const reset = useCallback', start);
  return start < 0 || end < 0 ? '' : CONTEXT.slice(start, end);
})();

// ── Part 1: concurrency, not sequencing ────────────────────────────────────
console.log('\u2500\u2500 Part 1: how the detectors actually execute \u2500\u2500');
{
  const tracked = [...pipeline.matchAll(/track\('([A-Za-z]+)'/g)].map((m) => m[1]);
  check('1a: every detector is started in ONE Promise.all (concurrent, not sequential)',
    /\] = await Promise\.all\(\[/.test(pipeline) &&
      !/\bawait track\(/.test(pipeline));
  check('1b: the 13 async detectors are all present (14 with the synchronous app-integrity check)',
    tracked.length === 13 &&
      // 'overlay' is deliberately absent: removed with the floating-window
      // protection subsystem, never replaced by another window signal.
      !tracked.includes('overlay') &&
      ['root', 'vpn', 'proxy', 'interception', 'debug', 'devOptions', 'screenRec', 'frida',
        'xposed', 'magisk', 'tamper', 'platformIntegrity', 'ssl'].every((n) => tracked.includes(n)));
  check('1c: the synchronous detector adds no wall-clock wait',
    /const integrityThreat = detectAppIntegrity\(\);/.test(SECURITY));
  check('1d: every detector is individually bounded by DETECTOR_TIMEOUT_MS',
    (pipeline.match(/bounded\(/g) || []).length >= 13 &&
      /const bounded = <T,>\(name: string, p: Promise<T>, fallback: \(\) => T\): Promise<T> =>\s*withTimeout\(p, DETECTOR_TIMEOUT_MS/.test(SECURITY));
  check('1e: the timeout bound is a named constant (not a magic number)',
    /const DETECTOR_TIMEOUT_MS = 10_000;/.test(SECURITY));
  check('1f: the network policy fetch overlaps the native probes (no serial round trip)',
    SECURITY.indexOf('const policiesP = getSecurityPolicies();') <
      SECURITY.indexOf('] = await Promise.all(['));
  check('1g: the native flag batch is read ONCE per cycle and reused by the detectors',
    /let rawFlags: Awaited<ReturnType<typeof getNativeSecurityFlags>>/.test(SECURITY));
  check('1h: no detector is executed twice inside one evaluation',
    new Set(tracked).size === tracked.length);
}

// ── Part 2: per-detector timing evidence is obtainable on a RELEASE build ───
console.log('\u2500\u2500 Part 2: timing evidence \u2500\u2500');
{
  const timingBlock = (() => {
    const start = SECURITY.indexOf("'[SecurityCheck][timing]");
    return start < 0 ? '' : SECURITY.slice(Math.max(0, start - 900), start + 600);
  })();
  check('2a: per-detector timings are captured for every detector',
    /timings\[name\] = Date\.now\(\) - t0;/.test(SECURITY));
  check('2b: the timing line is emitted on EVERY build (not DEV-only)',
    /'\[SecurityCheck\]\[timing\] scope='/.test(SECURITY) &&
      !/if \(__DEV__ \|\| process\.env\.EXPO_PUBLIC_SECURITY_DIAGNOSTICS === '1'\) \{\s*const ordered/.test(SECURITY));
  check('2c: the line names each detector with its own duration',
    /' detectors=' \+ ordered\.map\(\(\[k, v\]\) => k \+ ':' \+ v\)\.join\(','\)/.test(SECURITY));
  check('2d: the timings travel with the verdict (usable by callers, not just logs)',
    /scope, timings, degradedDetectors,/.test(SECURITY) && /timings\?:\s+Record<string, number>/.test(SECURITY));
  check('2e: the log carries names and durations only (privacy contract stated)',
    /PRIVACY: detector names and millisecond durations only/.test(SECURITY));
}

// ── Part 3: no duplicated evaluation work ──────────────────────────────────
console.log('\u2500\u2500 Part 3: concurrency dedup (share the run, cache nothing) \u2500\u2500');
{
  check('3a: checkBeforeVideo joins an in-flight FULL evaluation',
    /const r = await runSharedFullCheck\('pre-video'\)/.test(checkBeforeVideo) &&
      /SHARED_FULL_EVAL_MAX_MS/.test(CONTEXT));
  check('3b: only an IN-FLIGHT run is joined — a completed verdict is never reused',
    /const inFlight = sharedFullEvalRef\.current;\s*if \(inFlight && Date\.now\(\) - inFlight\.startedAt <= SHARED_FULL_EVAL_MAX_MS\)/.test(CONTEXT) &&
      !/sharedFullEvalRef\.current = \{ promise: Promise\.resolve/.test(CONTEXT));
  check('3c: the shared slot is released in a finally block (never leaks a stale promise)',
    /finally \{[\s\S]{0,220}sharedFullEvalRef\.current\?\.promise === promise\) sharedFullEvalRef\.current = null;/.test(CONTEXT));
  check('3d: the join window is bounded by the detector timeout (still a fresh measurement)',
    /const SHARED_FULL_EVAL_MAX_MS = 10_000;/.test(CONTEXT));
  check('3e: an invalidating change starts a NEW evaluation (never served from the slot)',
    /runGuardedCheck\(reason\)[\s\S]{0,120}sharedFullEvalRef\.current = \{ promise, startedAt \}/.test(CONTEXT) &&
      /if \(r\) publishVerdictRef\.current\(r\)/.test(CONTEXT));
  check('3f: both playback surfaces still re-validate through checkBeforeVideo',
    /const blocked = await checkBeforeVideo\(\);/.test(LESSON) &&
      /return !\(await checkBeforeVideo\(\)\)/.test(LESSON));
}

// ── Part 4: fail closed on a missing / failed mandatory verdict ─────────────
console.log('\u2500\u2500 Part 4: fail-closed guarantees \u2500\u2500');
{
  check('4a: a missing pre-video verdict REFUSES playback (was: returned false = allowed)',
    /if \(!r\) \{[\s\S]{0,700}return true;/.test(checkBeforeVideo) &&
      !/if \(!r\) \{[\s\S]{0,300}return false;/.test(checkBeforeVideo));
  check('4b: mandatory detectors whose verdict is missing block playback',
    /const PRE_PLAYBACK_MANDATORY_DETECTORS: readonly string\[\] = \['vpn', 'platformIntegrity', 'ssl'\];/.test(CONTEXT) &&
      /const missing = \(r\.degradedDetectors \?\? \[\]\)\.filter/.test(checkBeforeVideo) &&
      /if \(missing\.length > 0\) \{[\s\S]{0,300}return true;/.test(checkBeforeVideo));
  check('4c: the degradation ledger records every fallback (throw OR timeout)',
    /degradedDetectors\.push\(name\);/.test(SECURITY) &&
      /degradedDetectors\?: string\[\]/.test(SECURITY));
  check('4d: a genuinely offline device is NOT treated as degraded (documented supported state)',
    /genuinelyOffline \? Promise\.resolve\(null\) : runPlayIntegrityCheck\(\)/.test(SECURITY) &&
      /bounded\(\s*'platformIntegrity',[\s\S]{0,120}genuinelyOffline/.test(SECURITY));
  check('4e: a timed-out VPN probe is a degradation finding, not a clean device',
    /track\('vpn',[\s\S]{0,200}vpnDetectionDegradedThreat/.test(SECURITY));
  check('4f: a blocked verdict still blocks (SELECTOR is the policy model, not a shortcut)',
    /const \{ blocksLogin, blocksVideo, hasWarnings \} = verdict;/.test(SECURITY) &&
      /return r\.blocksVideo;/.test(checkBeforeVideo));
  check('4g: playback is authorised only after the native window/overlay preflight',
    /nativeWindowPreflightRef\.current\(\)\) return true;/.test(checkBeforeVideo) &&
      checkBeforeVideo.indexOf('nativeWindowPreflightRef.current') < checkBeforeVideo.indexOf("await runSharedFullCheck('pre-video')"));
  check('4h: no timeout was reduced and no detector was removed to gain speed',
    /const DETECTOR_TIMEOUT_MS = 10_000;/.test(SECURITY) &&
      !/DETECTOR_TIMEOUT_MS = [0-9]{1,4};/.test(SECURITY));
  check('4i: Play Integrity is still evaluated (never skipped for speed)',
    /runPlayIntegrityCheck\(\)/.test(SECURITY) &&
      !/platformIntegrity[\s\S]{0,80}Promise\.resolve\(null\)\s*,?\s*\)\s*,?\s*track\('ssl'/.test(SECURITY));
}

console.log('\n' + '\u2500'.repeat(60));
console.log('videoStartupLatency: ' + passed + ' passed, ' + failed + ' failed');
console.log('NOTE: source-level contracts. The millisecond attribution comes from the');
console.log('"[SecurityCheck][timing]" line printed on the device.');
process.exit(failed === 0 ? 0 : 1);
