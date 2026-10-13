/**
 * verify-bundle-order.js
 *
 * Runs Metro's runBuild() programmatically with the project's metro.config.js
 * to produce a real iOS production bundle, then statically verifies that:
 *
 *  1. fast-text-encoding (the polyfill) appears BEFORE expo-router/entry
 *  2. fast-text-encoding appears BEFORE exceljs.bare.js
 *  3. exceljs.bare.js is present in the bundle (confirms it's still bundled)
 *  4. The polyfill's scope assignment line is present
 *     (scope.TextEncoder = scope.TextEncoder || v)
 *
 * Exit 0 = all checks pass.
 * Exit 1 = at least one check failed.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');

const PROJECT_ROOT  = '/workspace/app-czyg340mpc75';
const metro  = require(path.join(PROJECT_ROOT, 'node_modules/metro/src/index.js'));

const BUNDLE_OUTPUT = '/tmp/ios-prod-verify.bundle';
const ENTRY_FILE    = path.join(PROJECT_ROOT, 'node_modules/expo-router/entry.js');

async function main() {
  console.log('\n=== iOS Production Bundle Order Verification ===\n');

  // ── 1. Load metro config (the project's own metro.config.js) ──────────────
  console.log('[1/4] Loading metro.config.js ...');
  let metroConfig;
  try {
    const { loadConfig } = require(path.join(PROJECT_ROOT, 'node_modules/metro-config/src/index.js'));
    // loadConfig(argv, defaultConfigOverrides)
    // argv.config = path to config file; argv.cwd used for resolution
    metroConfig = await loadConfig(
      { config: path.join(PROJECT_ROOT, 'metro.config.js'), cwd: PROJECT_ROOT },
      {}
    );
  } catch (e) {
    console.error('    loadConfig failed:', e.message);
    process.exit(1);
  }
  console.log('      ✓ metro config loaded');
  const polyfillNames = metroConfig.serializer?.polyfillModuleNames ?? [];
  console.log('      polyfillModuleNames:', polyfillNames);
  if (!polyfillNames.some(p => p.includes('text-encoding'))) {
    console.error('  ✗ FAIL: text-encoding polyfill NOT in polyfillModuleNames');
    process.exit(1);
  }
  console.log('      ✓ text-encoding.js is registered in polyfillModuleNames');

  // ── 2. Run Metro bundle (iOS, production, no minify for readability) ───────
  console.log('\n[2/4] Running Metro iOS production bundle ...');
  fs.mkdirSync('/tmp/ios-assets-verify', { recursive: true });
  try {
    await metro.runBuild(metroConfig, {
      entry: ENTRY_FILE,
      out: BUNDLE_OUTPUT,
      platform: 'ios',
      dev: false,
      minify: false,
      sourceMap: false,
    });
  } catch (e) {
    console.error('    Metro runBuild failed:', e.message);
    process.exit(1);
  }

  const stat = fs.statSync(BUNDLE_OUTPUT);
  console.log(`      ✓ Bundle produced: ${BUNDLE_OUTPUT} (${(stat.size/1024/1024).toFixed(1)} MB)`);

  // ── 3. Find byte offsets of critical sections ──────────────────────────────
  console.log('\n[3/4] Scanning bundle for module ordering ...');
  const bundle = fs.readFileSync(BUNDLE_OUTPUT, 'utf8');

  // Markers to search for
  const POLYFILL_MARKER  = 'fast-text-encoding';          // comment or require path
  const SCOPE_ASSIGN     = 'scope.TextEncoder=scope.TextEncoder||';
  const EXCELJS_MARKER   = 'exceljs.bare.js';             // Metro inline source comment
  const EXCELJS_CODE     = 'typeof TextEncoder';          // the failing line in exceljs
  const ENTRY_MARKER     = 'expo-router/entry';           // entry module wrapper

  const posPolyfill  = bundle.indexOf(POLYFILL_MARKER);
  const posAssign    = bundle.indexOf(SCOPE_ASSIGN);
  const posExceljs   = bundle.indexOf(EXCELJS_MARKER);
  const posExceljsTE = bundle.indexOf(EXCELJS_CODE);
  const posEntry     = bundle.indexOf(ENTRY_MARKER);

  const fmt = (pos) => pos === -1 ? 'NOT FOUND' : `offset ${pos}`;
  console.log(`      fast-text-encoding marker : ${fmt(posPolyfill)}`);
  console.log(`      scope.TextEncoder= assign  : ${fmt(posAssign)}`);
  console.log(`      exceljs.bare.js marker     : ${fmt(posExceljs)}`);
  console.log(`      typeof TextEncoder (exceljs): ${fmt(posExceljsTE)}`);
  console.log(`      expo-router/entry marker   : ${fmt(posEntry)}`);

  // ── 4. Assert ordering ─────────────────────────────────────────────────────
  console.log('\n[4/4] Asserting execution order ...');
  let failures = 0;

  function check(label, condition, detail) {
    if (condition) {
      console.log(`      ✓ ${label}`);
    } else {
      console.error(`      ✗ FAIL: ${label}`);
      if (detail) console.error(`          ${detail}`);
      failures++;
    }
  }

  // fast-text-encoding must appear in the bundle
  check(
    'fast-text-encoding is present in bundle',
    posPolyfill !== -1,
    'fast-text-encoding code not found — polyfill was not bundled'
  );

  // The scope.TextEncoder assignment must be present (polyfill body)
  check(
    'scope.TextEncoder=scope.TextEncoder||v assignment present',
    posAssign !== -1,
    'fast-text-encoding install code missing — module may have been tree-shaken'
  );

  // exceljs must be present (confirms it's still bundled, not accidentally removed)
  check(
    'exceljs.bare.js is present in bundle',
    posExceljs !== -1 || posExceljsTE !== -1,
    'exceljs not found in bundle — import chain may have changed'
  );

  // polyfill must come BEFORE exceljs in the bundle
  if (posPolyfill !== -1 && (posExceljs !== -1 || posExceljsTE !== -1)) {
    const exceljsPos = posExceljs !== -1 ? posExceljs : posExceljsTE;
    check(
      `polyfill (offset ${posPolyfill}) is BEFORE exceljs (offset ${exceljsPos})`,
      posPolyfill < exceljsPos,
      `polyfill offset ${posPolyfill} > exceljs offset ${exceljsPos} — wrong order!`
    );
  }

  // polyfill must come BEFORE expo-router/entry in the bundle
  if (posPolyfill !== -1 && posEntry !== -1) {
    check(
      `polyfill (offset ${posPolyfill}) is BEFORE expo-router/entry (offset ${posEntry})`,
      posPolyfill < posEntry,
      `polyfill offset ${posPolyfill} > entry offset ${posEntry} — wrong order!`
    );
  }

  // scope assign must come BEFORE exceljs TextEncoder check
  if (posAssign !== -1 && posExceljsTE !== -1) {
    check(
      `scope.TextEncoder= (offset ${posAssign}) is BEFORE typeof TextEncoder in exceljs (offset ${posExceljsTE})`,
      posAssign < posExceljsTE,
      `TextEncoder is NOT set before exceljs runs — fix is ineffective!`
    );
  }

  console.log('\n' + '='.repeat(50));
  if (failures === 0) {
    console.log('✅  ALL CHECKS PASSED — polyfill executes before exceljs on iOS');
    console.log('    TextEncoder will be present in global scope before exceljs');
    console.log('    evaluates its module-level code on JSC.');
  } else {
    console.error(`❌  ${failures} CHECK(S) FAILED — review output above`);
  }
  console.log('='.repeat(50) + '\n');

  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
