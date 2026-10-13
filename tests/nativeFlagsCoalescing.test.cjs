#!/usr/bin/env node
/**
 * Native security flag batch — per-cycle coalescing + failure handling.
 *
 * Run: node tests/nativeFlagsCoalescing.test.cjs
 *
 * ─── THE COST THIS PINS DOWN ────────────────────────────────────────────────
 *
 * `runSecurityChecks()` reads the native flag batch once per detector — 16
 * `await getNativeSecurityFlags()` call sites in src/lib/security.ts — and the
 * periodic pipeline repeats that every CONTINUOUS_CHECK_INTERVAL_MS (30 s) plus
 * on foreground resume. `getNativeSecurityFlags()` had NO cache, so a single
 * check cycle crossed the native bridge ~16 times, and each crossing re-reads
 * Settings.Global, the package manager and /proc inside Kotlin. The "warm up
 * the native flag batch cache ONCE" call in runSecurityChecks() was commented
 * as if it did this; nothing actually reused it.
 *
 * ─── WHAT MUST STAY TRUE (the safety half) ──────────────────────────────────
 *
 *  • A new check cycle ALWAYS performs a real measurement — the cache TTL is
 *    milliseconds, far shorter than the 30 s pipeline interval, so a stale
 *    reading cannot outlive the cycle that produced it.
 *  • FAILURES ARE NEVER CACHED. A call that cannot reach the module must leave
 *    the cache cold so the next caller retries, instead of inheriting a
 *    fail-safe default for the whole TTL window.
 *  • The `wasLastSecurityFlagsCallUnavailable()` contract is unchanged: it must
 *    be true exactly when the LAST batch call failed to measure.
 *  • Concurrent callers share one in-flight promise, so the batch is never
 *    half-applied.
 *  • iOS refreshes the synchronous snapshot too (it previously did not, so
 *    detectAppIntegrity() read SAFE_FLAGS on iOS after a successful read).
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

// ── Structural expectations (cheap, pin the seam) ───────────────────────────
console.log('\u2500\u2500 Structural: the coalescing seam exists \u2500\u2500');
{
  const src = read('src/lib/nativeSecurity.ts');
  ok(/const FLAGS_CACHE_TTL_MS\s*=\s*\d+;/.test(src),
    'S1: cache TTL is a named constant (reviewable)');
  ok(/_flagsInFlight/.test(src),
    'S2: concurrent callers share an in-flight promise');
  ok(/_flagsCacheAt = measured \? Date\.now\(\) : 0;/.test(src),
    'S3: failures leave the cache cold (measured=false → cacheAt 0, next call retries)');
  ok(/_lastFlagsCallUnavailable = !measured;/.test(src),
    'S4: the unavailable flag is still derived from the real measurement outcome');
  // The old buggy iOS branch returned without refreshing the sync snapshot.
  const iosBranch = src.slice(src.indexOf("Platform.OS === 'ios'"), src.indexOf('  // Web: no native module'));
  ok(/_lastMeasuredFlags = merged;/.test(iosBranch),
    'S5: the iOS branch refreshes _lastMeasuredFlags (getNativeSecurityFlagsSync parity)');
  ok(/_lastMeasuredFlags = merged;/.test(src.slice(src.indexOf("Platform.OS === 'android'"), src.indexOf("Platform.OS === 'ios'"))),
    'S6: the Android branch still refreshes _lastMeasuredFlags');
}

// ── Behavioural harness ─────────────────────────────────────────────────────
console.log('\u2500\u2500 Behavioural: one native read per cycle \u2500\u2500');
{
  const babel = require(path.join(ROOT, 'node_modules', '@babel', 'core'));
  const tmpRoot = path.join(ROOT, '.freebuff');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const outDir = fs.mkdtempSync(path.join(tmpRoot, 'flagscoalesce-'));

  const rnStub = path.join(outDir, 'react-native.js');
  const netinfoStub = path.join(outDir, 'netinfo.js');

  fs.writeFileSync(rnStub, `
    const state = { platform: 'android', nativeReads: 0, throwOnRead: false, advertised: {} };
    class NativeEventEmitter { addListener() { return { remove() {} }; } removeAllListeners() {} }
    const SecurityModule = {
      async getSecurityFlags() {
        state.nativeReads += 1;
        if (state.throwOnRead) throw new Error('native read failed');
        return state.advertised;
      },
    };
    const IOSSecurityModule = {
      async getSecurityFlags() {
        state.nativeReads += 1;
        if (state.throwOnRead) throw new Error('native read failed');
        return state.advertised;
      },
    };
    module.exports = {
      __state: state,
      Platform: { get OS() { return state.platform; }, select: (o) => o[state.platform] },
      NativeModules: { SecurityModule, IOSSecurityModule },
      NativeEventEmitter,
    };
  `);
  fs.writeFileSync(netinfoStub, `
    module.exports = { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }), useNetInfo: () => ({}) };
  `);

  const { code } = babel.transformSync(read('src/lib/nativeSecurity.ts'), {
    filename: 'nativeSecurity.ts',
    configFile: false,
    babelrc: false,
    plugins: [
      [require(path.join(ROOT, 'node_modules', '@babel', 'plugin-transform-typescript')), { isTSX: false, allExtensions: true }],
      require(path.join(ROOT, 'node_modules', '@babel', 'plugin-transform-modules-commonjs')),
    ],
  });
  const compiled = code
    .replace(/require\("react-native"\)/g, () => 'require(' + JSON.stringify(rnStub) + ')')
    .replace(/require\("@react-native-community\/netinfo"\)/g, () => 'require(' + JSON.stringify(netinfoStub) + ')');

  const modPath = path.join(outDir, 'nativeSecurity.js');
  fs.writeFileSync(modPath, compiled);

  const load = () => {
    delete require.cache[modPath];
    delete require.cache[rnStub];
    delete require.cache[netinfoStub];
    return { mod: require(modPath), rn: require(rnStub) };
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    // B1 — the actual runSecurityChecks shape: one warm-up call, then 15 more
    //      in the same cycle. Must be ONE native read, not 16.
    {
      const { mod, rn } = load();
      rn.__state.advertised = { developerOptionsEnabled: false, adbEnabled: false, rootDetected: false };
      const calls = [];
      calls.push(mod.getNativeSecurityFlags());                       // warm-up
      for (let i = 0; i < 15; i++) calls.push(mod.getNativeSecurityFlags()); // 15 detectors
      const results = await Promise.all(calls);
      ok(rn.__state.nativeReads === 1,
        'B1: 16 calls in one check cycle → exactly 1 native read (was 16)');
      ok(results.every((r) => r.rootDetected === false),
        'B2: every caller receives the same measurement (batch never half-applied)');
    }

    // B3 — a call immediately after the cycle is served from the short TTL.
    {
      const { mod, rn } = load();
      await mod.getNativeSecurityFlags();
      await mod.getNativeSecurityFlags();
      ok(rn.__state.nativeReads === 1,
        'B3: a follow-up call within the TTL does not re-cross the bridge');
    }

    // B4 — past the TTL a NEW cycle measures for real (freshness preserved).
    {
      const { mod, rn } = load();
      await mod.getNativeSecurityFlags();
      await sleep(600);
      await mod.getNativeSecurityFlags();
      ok(rn.__state.nativeReads === 2,
        'B4: past the TTL a new cycle performs a real measurement (no stale security state)');
    }

    // B5 — the measured value really does flow through to callers.
    {
      const { mod, rn } = load();
      rn.__state.advertised = { developerOptionsEnabled: true, adbEnabled: true };
      const flags = await mod.getNativeSecurityFlags();
      ok(flags.developerOptionsEnabled === true && flags.adbEnabled === true,
        'B5: measured developer-options/ADB values reach the caller (restored detections are fed)');
      ok(mod.wasLastSecurityFlagsCallUnavailable() === false,
        'B6: a successful read reports detection as AVAILABLE');
    }

    // B7 — FAILURES ARE NEVER CACHED: a second call must retry immediately.
    {
      const { mod, rn } = load();
      rn.__state.throwOnRead = true;
      await mod.getNativeSecurityFlags();
      const afterFirst = rn.__state.nativeReads;
      await mod.getNativeSecurityFlags();
      ok(rn.__state.nativeReads === afterFirst + 1,
        'B7: a failed read is NOT cached — the next caller retries instead of inheriting fail-safe defaults');
      ok(mod.wasLastSecurityFlagsCallUnavailable() === true,
        'B8: a failed read reports detection as UNAVAILABLE (fail-safe contract intact)');
    }

    // B9 — a failure must not be papered over by the coalescing cache: after
    //      the failure, a successful read must be able to recover immediately.
    {
      const { mod, rn } = load();
      rn.__state.throwOnRead = true;
      await mod.getNativeSecurityFlags();
      rn.__state.throwOnRead = false;
      rn.__state.advertised = { rootDetected: true };
      const flags = await mod.getNativeSecurityFlags();
      ok(flags.rootDetected === true && mod.wasLastSecurityFlagsCallUnavailable() === false,
        'B9: recovery is immediate after a transient native failure');
    }

    // B10 — iOS parity: the sync snapshot must be refreshed by a successful read.
    {
      const { mod, rn } = load();
      rn.__state.platform = 'ios';
      const before = mod.getNativeSecurityFlagsSync();
      ok(before.developerOptionsEnabled === false, 'B10: sync snapshot starts at the fail-safe default');
      rn.__state.advertised = { developerOptionsEnabled: true, jailbreakDetected: true };
      await mod.getNativeSecurityFlags();
      const after = mod.getNativeSecurityFlagsSync();
      ok(after.developerOptionsEnabled === true,
        'B11: iOS refreshes the sync snapshot too (detectAppIntegrity no longer reads SAFE_FLAGS on iOS)');
    }

    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ }

    console.log('\n' + '\u2500'.repeat(46));
    console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
    if (failed) {
      console.log('\nFAILURES:');
      for (const f of failures) console.log('  \u2717 ' + f);
      process.exit(1);
    }
    console.log('ALL NATIVE FLAG COALESCING TESTS PASSED');
  })().catch((e) => {
    console.error('runner error:', e);
    process.exit(1);
  });
}
