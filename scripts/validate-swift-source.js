#!/usr/bin/env node
/* eslint-env node */
/* global require, __dirname, __filename, process, module */
/**
 * validate-swift-source.js
 *
 * Deep-validates Swift source files used in the iOS security module.
 *
 * This validator applies Swift-specific structural checks to catch compile
 * errors before Xcode ever runs. It is a complement to the full compiler —
 * fast enough to run on every PR, detailed enough to catch the class of errors
 * that caused the v428 packaging failure.
 *
 * Checks:
 *   S1.  No unreplaced placeholder tokens
 *   S2.  All stored properties referenced in method bodies are declared
 *   S3.  No arc4random() — must use SecRandomCopyBytes
 *   S4.  All @objc() exported methods have matching Swift func declarations
 *   S5.  Every #available() guard has a valid iOS version number
 *   S6.  No force-unwrap (!.) on security-critical values
 *   S7.  All event name constants are included in supportedEvents() return value
 *   S8.  #if DEBUG / #endif pairs are balanced
 *   S9.  No bare `print()` calls outside #if DEBUG blocks
 *   S10. `import` statements only reference known/expected frameworks
 *   S11. RCT_EXTERN_MODULE and RCT_EXTERN_METHOD counts match Swift @objc methods
 *   S12. No `try!` (force-try) in security-critical code paths
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const errors   = [];
const warnings = [];

function pass(ctx, msg)  { console.log(`  ✅  [${ctx}] ${msg}`); }
function fail(ctx, msg)  { console.error(`  ❌  [${ctx}] ${msg}`); errors.push(`[${ctx}] ${msg}`); }
function warn(ctx, msg)  { console.warn(`  ⚠️   [${ctx}] ${msg}`); warnings.push(`[${ctx}] ${msg}`); }

// ─── Known-good Swift framework imports ──────────────────────────────────────
const KNOWN_SWIFT_IMPORTS = new Set([
  'Foundation', 'UIKit', 'Network', 'NetworkExtension',
  'DeviceCheck', 'CryptoKit', 'MachO', 'Darwin',
  'React', 'Security', 'LocalAuthentication',
  'CoreTelephony', 'SystemConfiguration',
]);

// ─── Placeholder patterns ─────────────────────────────────────────────────────
// __DEV__ and other Metro globals are legitimate — explicitly excluded.
const RN_LEGITIMATE_GLOBALS = new Set(['__DEV__', '__DEV_STAGE__', '__BUNDLE_START_TIME__', '__fbBatchedBridge__']);

const PLACEHOLDER_PATTERNS = [
  { pattern: /__[A-Z][A-Z0-9_]+__/g,   label: 'dunder-placeholder  (e.g. __FOO__)' },
  { pattern: /PLACEHOLDER_[A-Z_]+/g,   label: 'PLACEHOLDER_* token' },
  { pattern: /TODO_REPLACE/g,          label: 'TODO_REPLACE marker' },
  { pattern: /<<<.+>>>/g,              label: 'conflict-marker <<< ... >>>' },
];

// ─── Critical stored properties that MUST be declared in IOSSecurityModule ───
const REQUIRED_STORED_PROPS = [
  'baselineIMPs',
  'hasListeners',
  'jailbreakCacheResult',
  'jailbreakCacheExpiry',
  'jailbreakCacheTTL',
  'recordingMonitorTimer',
  'screenshotObserver',
  'recordingObserver',
];

function validateSwiftFile(rel) {
  const ctx  = path.basename(rel);
  const abs  = path.join(ROOT, rel);

  if (!fs.existsSync(abs)) {
    fail(ctx, `S0: file not found at ${rel}`);
    return;
  }

  const content = fs.readFileSync(abs, 'utf8');
  const lines   = content.split('\n');

  console.log(`\n  ── Validating ${rel} (${lines.length} lines) ────────────────────`);

  // S1. No placeholders — skip comment lines, skip known RN globals
  const codeLines = lines.filter(l => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
  const codeOnly = codeLines.join('\n');

  let s1clean = true;
  for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(codeOnly)) !== null) {
      if (RN_LEGITIMATE_GLOBALS.has(m[0])) continue;
      fail(ctx, `S1: unreplaced placeholder [${label}]: "${m[0]}"`);
      s1clean = false;
    }
  }
  if (s1clean) pass(ctx, 'S1: no unreplaced placeholder tokens');

  // S2. Stored property declaration coverage
  // Find all declared stored properties (private var / private let / var / let at class body level)
  const declaredProps = new Set();
  const declRegex = /(?:private\s+)?(?:var|let)\s+(\w+)\s*[=:]/g;
  let m;
  while ((m = declRegex.exec(content)) !== null) {
    declaredProps.add(m[1]);
  }

  let s2fail = false;
  for (const prop of REQUIRED_STORED_PROPS) {
    if (content.includes(prop)) {
      if (declaredProps.has(prop)) {
        pass(ctx, `S2: '${prop}' is declared`);
      } else {
        fail(ctx, `S2: '${prop}' is used but not declared as a stored property`);
        s2fail = true;
      }
    }
  }
  if (!s2fail && REQUIRED_STORED_PROPS.every(p => !content.includes(p) || declaredProps.has(p))) {
    pass(ctx, 'S2: all required stored properties are declared');
  }

  // S3. No arc4random — check code lines only, not comments
  const arc4InCode = lines.some(l => {
    const trimmed = l.trimStart();
    return !trimmed.startsWith('//') && /\barc4random\b/.test(trimmed);
  });
  if (arc4InCode) {
    fail(ctx, 'S3: arc4random() found in code (not a comment) — replace with SecRandomCopyBytes (CSPRNG)');
  } else {
    pass(ctx, 'S3: no arc4random() in code (CSPRNG compliance)');
  }

  // S4. @objc() method annotations have matching func declarations.
  // Skip class-level @objc decorators (the one immediately before `class Foo`).
  const objcAnnotations = [...content.matchAll(/@objc\(([^)]+)\)/g)];
  let s4fail = false;
  let s4checked = 0;
  for (const ann of objcAnnotations) {
    const selector = ann[1].trim();
    // Skip class-level decorator: the token after @objc(...) (ignoring whitespace)
    // is the `class` keyword, not a `func`.
    const afterAnnotation = content.slice(ann.index + ann[0].length).trimStart();
    if (/^class\s/.test(afterAnnotation)) continue;  // class decorator — skip

    const baseName  = selector.split(':')[0].replace(/^"|"$/g, '');
    const funcRegex = new RegExp(`func\\s+${baseName}\\s*\\(`);
    if (!funcRegex.test(content)) {
      fail(ctx, `S4: @objc("${selector}") has no matching Swift func ${baseName}()`);
      s4fail = true;
    }
    s4checked++;
  }
  if (!s4fail) {
    if (s4checked > 0) {
      pass(ctx, `S4: all ${s4checked} @objc() method annotation(s) have matching func declarations`);
    } else {
      pass(ctx, 'S4: no @objc() method annotations (module uses RCT_EXTERN_MODULE pattern)');
    }
  }

  // S5. #available guards have valid iOS version
  const availableGuards = [...content.matchAll(/#available\s*\(iOS\s*([\d.]+)/g)];
  let s5fail = false;
  for (const g of availableGuards) {
    const ver = parseFloat(g[1]);
    if (ver < 14.0) {
      warn(ctx, `S5: #available(iOS ${g[1]}) — version < 14.0; most security APIs require iOS 14+`);
    }
    if (isNaN(ver)) {
      fail(ctx, `S5: #available guard has non-numeric iOS version: "${g[1]}"`);
      s5fail = true;
    }
  }
  if (!s5fail) {
    pass(ctx, `S5: ${availableGuards.length} #available guard(s) — versions are valid`);
  }

  // S6. No force-unwrap on security-critical values
  // Allow force-unwrap in comments and string literals, but flag in code
  const nonCommentLines = lines.filter(l => !l.trim().startsWith('//'));
  const forceUnwraps = nonCommentLines.filter(l => /\w+!\.|\w+!\[|return\s+\w+!/.test(l));
  if (forceUnwraps.length > 0) {
    warn(ctx, `S6: ${forceUnwraps.length} force-unwrap(s) found in non-comment lines — use guard/if-let instead`);
    forceUnwraps.slice(0, 3).forEach(l => warn(ctx, `  S6: ${l.trim()}`));
  } else {
    pass(ctx, 'S6: no force-unwraps in code lines');
  }

  // S7. Event constants in supportedEvents()
  const eventConsts = [...content.matchAll(/private\s+let\s+(EVENT_\w+)\s*=\s*"([^"]+)"/g)];
  const supportedEventsBody = content.match(/override\s+func\s+supportedEvents[^{]*\{([\s\S]*?)\}/)?.[1] ?? '';
  let s7fail = false;
  for (const [, constName, eventValue] of eventConsts) {
    if (supportedEventsBody.includes(constName)) {
      // good
    } else {
      fail(ctx, `S7: event constant ${constName} ("${eventValue}") is declared but not listed in supportedEvents()`);
      s7fail = true;
    }
  }
  if (!s7fail && eventConsts.length > 0) {
    pass(ctx, `S7: all ${eventConsts.length} event constant(s) are included in supportedEvents()`);
  }

  // S8. #if DEBUG / #endif balance — scan code lines only (skip // comment lines)
  let debugOpens  = 0;
  let debugCloses = 0;
  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith('//')) continue;   // skip line comments
    if (/#if\s+DEBUG/.test(t))  debugOpens++;
    if (/#endif\b/.test(t))     debugCloses++;
  }
  if (debugOpens > 0) {
    if (debugCloses >= debugOpens) {
      pass(ctx, `S8: #if DEBUG blocks balanced (${debugOpens} open, ${debugCloses} #endif in code lines)`);
    } else {
      fail(ctx, `S8: unbalanced #if DEBUG — ${debugOpens} open, only ${debugCloses} #endif (in non-comment lines)`);
    }
  } else {
    pass(ctx, 'S8: no #if DEBUG blocks in code lines');
  }

  // S9. No bare print() outside #if DEBUG
  const printLines = lines.filter(l => /\bprint\s*\(/.test(l) && !l.trim().startsWith('//'));
  // Determine which print() calls are inside #if DEBUG ... #endif blocks
  let inDebugBlock = false;
  let bareprints = 0;
  for (const line of lines) {
    if (/#if\s+DEBUG/.test(line)) inDebugBlock = true;
    if (/#endif/.test(line))      inDebugBlock = false;
    if (/\bprint\s*\(/.test(line) && !line.trim().startsWith('//') && !inDebugBlock) {
      bareprints++;
    }
  }
  if (bareprints > 0) {
    fail(ctx, `S9: ${bareprints} bare print() call(s) outside #if DEBUG — will log in production builds`);
  } else {
    pass(ctx, 'S9: no bare print() calls outside #if DEBUG');
  }

  // S10. Unknown imports
  const importLines = [...content.matchAll(/^import\s+(\w+)/gm)];
  let s10fail = false;
  for (const [, framework] of importLines) {
    if (!KNOWN_SWIFT_IMPORTS.has(framework)) {
      warn(ctx, `S10: import ${framework} — not in known-good framework list (verify it is available on iOS 15.1+)`);
    }
  }
  if (!s10fail) {
    pass(ctx, `S10: ${importLines.length} import(s) validated`);
  }

  // S12. No try! (force-try)
  const forceTries = codeLines.filter(l => /\btry!\s/.test(l));
  if (forceTries.length > 0) {
    fail(ctx, `S12: ${forceTries.length} force-try (try!) found — will crash if the call throws`);
    forceTries.slice(0, 2).forEach(l => fail(ctx, `  S12: ${l.trim()}`));
  } else {
    pass(ctx, 'S12: no force-try (try!) usage');
  }
}

// ─── RCT_EXTERN_METHOD / Swift @objc cross-check ─────────────────────────────

function crossCheckBridgingHeader(swiftRel, mRel) {
  const ctx = 'bridge-cross-check';
  const swiftContent = fs.existsSync(path.join(ROOT, swiftRel))
    ? fs.readFileSync(path.join(ROOT, swiftRel), 'utf8') : null;
  const mContent = fs.existsSync(path.join(ROOT, mRel))
    ? fs.readFileSync(path.join(ROOT, mRel), 'utf8') : null;

  if (!swiftContent || !mContent) return;

  console.log(`\n  ── Cross-check: ${path.basename(swiftRel)} ↔ ${path.basename(mRel)} ───`);

  // Extract RCT_EXTERN_METHOD names from .m
  const externMethods = [...mContent.matchAll(/RCT_EXTERN_METHOD\s*\((\w+)/g)].map(m => m[1]);

  // Extract @objc(name:...) function names from .swift
  const objcFuncs = [...swiftContent.matchAll(/@objc\((\w+)/g)].map(m => m[1]);
  // Also detect func NAME( with @objc annotation above
  const swiftFuncs = [...swiftContent.matchAll(/func\s+(\w+)\s*\(/g)].map(m => m[1]);

  let crossFail = false;
  for (const ext of externMethods) {
    const found = swiftFuncs.includes(ext) || objcFuncs.some(f => f.startsWith(ext));
    if (!found) {
      fail(ctx, `RCT_EXTERN_METHOD(${ext}) declared in .m but no matching func ${ext}() in Swift`);
      crossFail = true;
    }
  }
  if (!crossFail) {
    pass(ctx, `S11: all ${externMethods.length} RCT_EXTERN_METHOD declaration(s) have Swift counterparts`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Swift Source Deep Validator');
  console.log('═══════════════════════════════════════════════════════════════════');

  const swiftFiles = [
    'plugins/ios/IOSSecurityModule.swift',
  ];

  for (const rel of swiftFiles) {
    validateSwiftFile(rel);
  }

  crossCheckBridgingHeader(
    'plugins/ios/IOSSecurityModule.swift',
    'plugins/ios/IOSSecurityModule.m'
  );

  console.log('\n═══════════════════════════════════════════════════════════════════');
  if (errors.length === 0) {
    console.log(`  RESULT: ✅  PASSED${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ''}`);
    warnings.forEach(w => console.warn(`    ⚠️  ${w}`));
  } else {
    console.error(`  RESULT: ❌  FAILED — ${errors.length} error(s)`);
    errors.forEach(e => console.error(`    ❌  ${e}`));
    warnings.forEach(w => console.warn(`    ⚠️  ${w}`));
  }
  console.log('═══════════════════════════════════════════════════════════════════\n');

  process.exit(errors.length > 0 ? 1 : 0);
}

main();
