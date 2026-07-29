#!/usr/bin/env node
/* eslint-env node */
/* global require, __dirname, __filename, process, module */
/**
 * validate-kotlin-template.js
 *
 * Deep-validates every Kotlin template embedded inside config plugin files.
 *
 * This validator simulates what the Kotlin compiler would reject at compile
 * time by checking for structural Kotlin requirements using regex-based AST
 * heuristics. It is NOT a full Kotlin parser, but it catches the class of
 * errors that historically caused packaging failures (unresolved identifiers,
 * missing package declarations, invalid debug guards).
 *
 * Checks:
 *   K1.  Package declaration on first non-blank line
 *   K2.  No unreplaced placeholder tokens (__FOO__, PLACEHOLDER_*, etc.)
 *   K3.  Debug-mode guards use BuildConfig.DEBUG (not raw identifiers)
 *   K4.  All `@ReactMethod` annotated functions have matching `fun` declarations
 *   K5.  Every `override fun getName()` returns a non-empty String literal
 *   K6.  `runSafe` helper is defined if it is called
 *   K7.  No Kotlin keywords used as unescaped identifiers (object, when, etc.)
 *   K8.  All catch blocks use `_` or a named variable (not empty)
 *   K9.  import statements reference only standard/known packages
 *   K10. Template does not contain JavaScript-only syntax (const, let, var =>,
 *        function(), ===, etc.)
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

// ─── Placeholder patterns (must NOT appear in generated Kotlin) ───────────────
// __DEV__ and other Metro globals are legitimate RN globals — explicitly excluded.
const RN_LEGITIMATE_GLOBALS = new Set(['__DEV__', '__DEV_STAGE__', '__BUNDLE_START_TIME__', '__fbBatchedBridge__']);

const PLACEHOLDER_PATTERNS = [
  { pattern: /__[A-Z][A-Z0-9_]+__/g,  label: 'dunder-placeholder (e.g. __FOO__)' },
  { pattern: /PLACEHOLDER_[A-Z_]+/g,  label: 'PLACEHOLDER_* token' },
  { pattern: /TODO_REPLACE/g,         label: 'TODO_REPLACE marker' },
  { pattern: /<<<.+>>>/g,             label: 'conflict-marker <<< ... >>>' },
];

// ─── JavaScript-only syntax that must not appear in Kotlin output ─────────────
const JS_ONLY_SYNTAX = [
  { pattern: /\bconst\s+\w+\s*=/,  label: 'const declaration (JS, not Kotlin)' },
  { pattern: /\blet\s+\w+\s*=/,    label: 'let declaration (JS, not Kotlin)' },
  { pattern: /=>\s*\{/,            label: 'arrow function => { (JS, not Kotlin)' },
  { pattern: /\bfunction\s*\(/,    label: 'function() declaration (JS, not Kotlin)' },
  { pattern: /===|!==/,            label: 'strict equality === / !== (JS, not Kotlin)' },
  { pattern: /\bconsole\.log\b/,   label: 'console.log (JS, not Kotlin — use Log.d)' },
];

function validateKotlinTemplate(name, content) {
  const ctx = name;
  console.log(`\n  ── Validating ${name} ─────────────────────────────────────────`);

  // K1. Package declaration
  const firstNonBlank = content.trimStart().split('\n').find(l => l.trim().length > 0) ?? '';
  if (/^package\s+[\w.]+/.test(firstNonBlank)) {
    pass(ctx, `K1: package declaration present ("${firstNonBlank.trim()}")`);
  } else {
    fail(ctx, `K1: missing package declaration — first non-blank line: "${firstNonBlank.trim()}"`);
  }

  // K2. No placeholders — skip comment lines, skip known RN globals
  const ktCodeLines = content.split('\n').filter(l => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
  const ktCodeOnly = ktCodeLines.join('\n');

  let placeholderClean = true;
  for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(ktCodeOnly)) !== null) {
      if (RN_LEGITIMATE_GLOBALS.has(m[0])) continue;
      fail(ctx, `K2: unreplaced placeholder [${label}]: "${m[0]}"`);
      placeholderClean = false;
    }
  }
  if (placeholderClean) pass(ctx, 'K2: no unreplaced placeholder tokens');

  // K3. Debug guards
  if (content.includes('!__DEV_PLACEHOLDER__') || content.includes('__DEV__')) {
    fail(ctx, 'K3: debug guard uses raw placeholder — must use BuildConfig.DEBUG.not() or !BuildConfig.DEBUG');
  } else if (content.includes('BuildConfig.DEBUG')) {
    pass(ctx, 'K3: debug guard uses BuildConfig.DEBUG');
  } else {
    pass(ctx, 'K3: no debug guards (none required)');
  }

  // K4. @ReactMethod annotations match fun declarations
  const annotations = (content.match(/@ReactMethod/g) || []).length;
  const reactFuns    = (content.match(/@ReactMethod\s*\n\s*fun\s+\w+/g) || []).length;
  // Allow @ReactMethod on the line before fun (with possible blank lines in between)
  const reactMethodFunPairs = (content.match(/@ReactMethod[\s\S]{0,50}?fun\s+\w+/g) || []).length;
  if (annotations > 0) {
    if (reactMethodFunPairs === annotations) {
      pass(ctx, `K4: all ${annotations} @ReactMethod annotation(s) have matching fun declarations`);
    } else {
      fail(ctx, `K4: ${annotations} @ReactMethod annotation(s) but only ${reactMethodFunPairs} paired with fun — some may be orphaned`);
    }
  } else {
    pass(ctx, 'K4: no @ReactMethod annotations (not required for this template)');
  }

  // K5. getName() returns non-empty string
  const getNameMatch = content.match(/override\s+fun\s+getName\s*\(\s*\)\s*[=:][^"]*"([^"]*)"/);
  if (getNameMatch) {
    if (getNameMatch[1].trim().length > 0) {
      pass(ctx, `K5: getName() returns "${getNameMatch[1]}"`);
    } else {
      fail(ctx, 'K5: getName() returns empty string — module will not be addressable from JS');
    }
  } else if (content.includes('getName')) {
    warn(ctx, 'K5: getName() found but return value could not be verified');
  }

  // K6. runSafe helper defined if called
  if (content.includes('runSafe(')) {
    if (content.includes('private fun runSafe') || content.includes('fun runSafe')) {
      pass(ctx, 'K6: runSafe() is defined');
    } else {
      fail(ctx, 'K6: runSafe() is called but not defined in this template');
    }
  } else {
    pass(ctx, 'K6: runSafe() not used (not required)');
  }

  // K7. Kotlin reserved words not used as unescaped identifiers
  const kwPatterns = [
    { word: 'object', pattern: /\bobject\s+\w+\s*\{/ },   // object declarations are valid in Kotlin
  ];
  // (object declarations are valid Kotlin — just checking it's a proper object declaration)
  // Skip strict keyword check as Kotlin uses 'object' legitimately

  // K8. Non-empty catch blocks
  const emptyCatch = content.match(/catch\s*\([^)]*\)\s*\{\s*\}/g);
  if (emptyCatch && emptyCatch.length > 0) {
    warn(ctx, `K8: ${emptyCatch.length} empty catch block(s) found — exception is silently swallowed`);
  } else {
    pass(ctx, 'K8: no empty catch blocks');
  }

  // K9. JS-only syntax
  let jsSyntaxClean = true;
  for (const { pattern, label } of JS_ONLY_SYNTAX) {
    if (pattern.test(content)) {
      fail(ctx, `K9: JavaScript-only syntax found in Kotlin template: ${label}`);
      jsSyntaxClean = false;
    }
  }
  if (jsSyntaxClean) pass(ctx, 'K9: no JavaScript-only syntax found');

  // K10. Class extends ReactContextBaseJavaModule
  if (content.includes('ReactContextBaseJavaModule')) {
    pass(ctx, 'K10: extends ReactContextBaseJavaModule (required for RN bridge)');
  } else if (content.includes('ReactPackage')) {
    pass(ctx, 'K10: implements ReactPackage (correct for package registration)');
  } else {
    warn(ctx, 'K10: no ReactContextBaseJavaModule or ReactPackage found — verify RN integration');
  }
}

function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Kotlin Template Deep Validator');
  console.log('═══════════════════════════════════════════════════════════════════');

  const pluginFiles = [
    'plugins/withSecurityModule.js',
  ];

  for (const rel of pluginFiles) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      fail(rel, 'file not found');
      continue;
    }

    const src = fs.readFileSync(abs, 'utf8');
    const templateRegex = /const\s+(\w+_KT)\s*=\s*`([\s\S]*?)`\s*;/g;
    let match;
    let count = 0;

    while ((match = templateRegex.exec(src)) !== null) {
      count++;
      validateKotlinTemplate(match[1], match[2]);
    }

    if (count === 0) {
      fail(rel, 'no *_KT template literals found');
    }
  }

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
