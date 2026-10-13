#!/usr/bin/env node
/**
 * Restored production security protections — regression suite.
 *
 * Run: node tests/securityProtectionRestored.test.cjs
 *
 * ─── THE REGRESSION THIS PINS ────────────────────────────────────────────────
 *
 * During an authorized real-device debugging session (fullscreen video
 * investigation) three protections were switched off IN THE SHIPPED SOURCE:
 *
 *   1. src/lib/screenCaptureGuard.ts
 *        const FLAG_SECURE_DEBUG_DISABLED = true;
 *      → preventScreenCaptureAsync() became an unconditional early-return, so
 *        native FLAG_SECURE was never applied in ANY build. Screenshot and
 *        screen-recording blocking, plus "hide from recents", were silently
 *        dead in the production release as well as in debug builds.
 *
 *   2. src/lib/security.ts
 *        const DEBUG_DISABLE_DEV_OPTIONS_AND_ADB = true;
 *      → detectDeveloperOptions() returned null before reading the native
 *        flags, so USB debugging (ADB) and Developer Options were never
 *        reported. Both are mandatory blocks per the security policy
 *        (developer_options bucket → block_login, weights 20 / 25), so a
 *        release build on a device with either enabled was allowed through.
 *
 *   3. src/lib/deviceKey.ts
 *      force-cleared the `developer_options` and `adb` fields of the signed
 *      security-evidence bundle, so the backend was told `false` for conditions
 *      that were never measured. Evidence must never be overridden client-side.
 *
 * ─── WHAT IS REQUIRED NOW ───────────────────────────────────────────────────
 *
 *   • Capture protection is the DEFAULT in every build, and the only escape
 *     hatch is an explicit DEVELOPMENT-build opt-in that a release bundle
 *     cannot reach (`__DEV__` is folded to `false` by the release compiler).
 *   • ADB / Developer-Options detection is unconditional again — no constant,
 *     flag, or env var can switch it off.
 *   • The evidence bundle reports what the device actually reported.
 *
 * The behavioural half compiles the SHIPPED guard source and drives it, so it
 * fails on a real behaviour change — not just on a renamed constant.
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

// ════════════════════════════════════════════════════════════════════════════
// PART A — the source carries no way to switch these protections off
// ════════════════════════════════════════════════════════════════════════════
console.log('\u2500\u2500 Part A: no production disable switch remains \u2500\u2500');
{
  const guard = read('src/lib/screenCaptureGuard.ts');
  const security = read('src/lib/security.ts');
  const deviceKey = read('src/lib/deviceKey.ts');

  ok(!/FLAG_SECURE_DEBUG_DISABLED/.test(guard),
    'A1: screenCaptureGuard has no blanket FLAG_SECURE disable constant');
  ok(!/TEMPORARY DEBUG GATE: skip the native FLAG_SECURE activation/.test(guard),
    'A2: screenCaptureGuard has no unconditional early-return in preventScreenCaptureAsync');
  ok(/const CAPTURE_PROTECTION_DISABLED\s*=/.test(guard),
    'A3: the single escape hatch is a named constant (reviewable in one place)');
  ok(/typeof __DEV__ !== 'undefined'/.test(guard) && /__DEV__ === true/.test(guard),
    'A4: the escape hatch is ANDed with __DEV__ (release bundles fold it to false)');
  ok(/EXPO_PUBLIC_DISABLE_CAPTURE_PROTECTION/.test(guard),
    'A5: the escape hatch additionally needs an explicit opt-in env var');

  ok(!/DEBUG_DISABLE_DEV_OPTIONS_AND_ADB/.test(security),
    'A6: security.ts has no ADB/developer-options disable constant');
  ok(/if \(flags\.adbEnabled\) \{/.test(security),
    'A7: adb_enabled is reported unconditionally');
  ok(/if \(flags\.developerOptionsEnabled\) \{/.test(security),
    'A8: developer_options_enabled is reported unconditionally');

  ok(!/DEBUG_DISABLE_DEV_OPTIONS_AND_ADB/.test(deviceKey),
    'A9: the evidence bundle has no ADB/developer-options override left');
  ok(/out\.developer_options = flags\.developerOptionsEnabled === true;/.test(deviceKey)
    && /out\.adb\s*= flags\.adbEnabled === true;/.test(deviceKey),
    'A10: evidence reports the measured flags verbatim');

  // The mandatory-block policy these feed must be unchanged.
  ok(/developer_options_enabled:\s*25,/.test(security) && /adb_enabled:\s*20,/.test(security),
    'A11: event weights are unchanged (developer_options_enabled 25, adb_enabled 20)');
  ok(/developer_options:\s*'block_login',/.test(security),
    'A12: the developer_options bucket is still block_login');
}

// ════════════════════════════════════════════════════════════════════════════
// PART B — drive the SHIPPED guard: protection is on, and only a dev build can
//          opt out
// ════════════════════════════════════════════════════════════════════════════
console.log('\u2500\u2500 Part B: native FLAG_SECURE actually applied \u2500\u2500');
{
  const babel = require(path.join(ROOT, 'node_modules', '@babel', 'core'));
  // Compiled inside the repo (git-ignored .freebuff/ workspace) so Node module
  // resolution still finds react/ etc. from node_modules when walking upward.
  const tmpRoot = path.join(ROOT, '.freebuff');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const outDir = fs.mkdtempSync(path.join(tmpRoot, 'secrestore-'));
  const stubPath = path.join(outDir, 'expo-screen-capture.js');

  // Minimal stub recording native calls (same contract as the real module).
  fs.writeFileSync(stubPath, `
    const calls = { prevent: 0, allow: 0 };
    async function preventScreenCaptureAsync() { calls.prevent += 1; }
    async function allowScreenCaptureAsync() { calls.allow += 1; }
    async function isAvailableAsync() { return true; }
    function addScreenshotListener() { return { remove() {} }; }
    const PermissionStatus = { GRANTED: 'granted' };
    module.exports = {
      calls, preventScreenCaptureAsync, allowScreenCaptureAsync, isAvailableAsync,
      addScreenshotListener, removeScreenshotListener: () => {}, useScreenshotListener: () => {},
      getPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
      requestPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
      enableAppSwitcherProtectionAsync: async () => {}, disableAppSwitcherProtectionAsync: async () => {},
      usePermissions: () => [], PermissionStatus,
    };
  `);

  const { code } = babel.transformSync(read('src/lib/screenCaptureGuard.ts'), {
    filename: 'screenCaptureGuard.ts',
    configFile: false,
    babelrc: false,
    plugins: [
      [require(path.join(ROOT, 'node_modules', '@babel', 'plugin-transform-typescript')), { isTSX: false, allExtensions: true }],
      require(path.join(ROOT, 'node_modules', '@babel', 'plugin-transform-modules-commonjs')),
    ],
  });
  // JSON.stringify so Windows backslashes survive as a valid JS string literal
  // in the generated file (a raw path would be read as \v / \s escapes).
  const compiled = code.replace(
    /require\("expo-screen-capture"\)/g,
    () => 'require(' + JSON.stringify(stubPath) + ')',
  );

  const guardPath = path.join(outDir, 'screenCaptureGuard.js');
  fs.writeFileSync(guardPath, compiled);

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const ENV_KEY = 'EXPO_PUBLIC_DISABLE_CAPTURE_PROTECTION';

  /** Fresh module evaluation so the module-scope constant is recomputed. */
  function load({ isDev, envValue }) {
    if (isDev) global.__DEV__ = true; else delete global.__DEV__;
    if (envValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = envValue;
    delete require.cache[guardPath];
    delete require.cache[stubPath];
    const guard = require(guardPath);
    const stub = require(stubPath);
    stub.calls.prevent = 0;
    stub.calls.allow = 0;
    return { guard, stub };
  }

  (async () => {
    // Scenario 1 — RELEASE build (no __DEV__, no env): protection must be on.
    {
      const { guard, stub } = load({ isDev: false, envValue: undefined });
      await guard.preventScreenCaptureAsync('app-shell'); await tick();
      ok(stub.calls.prevent === 1,
        'B1: release build applies native FLAG_SECURE (preventScreenshots ran once)');
      await guard.allowScreenCaptureAsync('app-shell'); await tick();
      ok(stub.calls.allow === 1,
        'B2: releasing the last lock restores capture exactly once');
    }

    // Scenario 2 — RELEASE build with the opt-in env var SET: still protected.
    //            This is the critical claim: the env var alone cannot weaken a
    //            shipped release.
    {
      const { guard, stub } = load({ isDev: false, envValue: '1' });
      await guard.preventScreenCaptureAsync('app-shell'); await tick();
      ok(stub.calls.prevent === 1,
        'B3: release build ignores EXPO_PUBLIC_DISABLE_CAPTURE_PROTECTION (no release opt-out exists)');
    }

    // Scenario 3 — DEV build, env var set: the documented escape hatch works.
    {
      const { guard, stub } = load({ isDev: true, envValue: '1' });
      await guard.preventScreenCaptureAsync('app-shell'); await tick();
      ok(stub.calls.prevent === 0,
        'B4: dev build honours the explicit opt-in (ADB screencap debugging possible)');
    }

    // Scenario 4 — DEV build, no env var: protection is still on by default.
    {
      const { guard, stub } = load({ isDev: true, envValue: undefined });
      await guard.preventScreenCaptureAsync('app-shell'); await tick();
      ok(stub.calls.prevent === 1,
        'B5: dev builds are protected by default too (opt-in, not opt-out)');
    }

    delete global.__DEV__;
    delete process.env[ENV_KEY];
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ }

    console.log('\n' + '\u2500'.repeat(46));
    console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
    if (failed) {
      console.log('\nFAILURES:');
      for (const f of failures) console.log('  \u2717 ' + f);
      process.exit(1);
    }
    console.log('ALL RESTORED-PROTECTION TESTS PASSED');
  })().catch((e) => {
    console.error('runner error:', e);
    process.exit(1);
  });
}
