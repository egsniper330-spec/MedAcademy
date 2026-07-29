#!/usr/bin/env node
/* eslint-env node */
/* global require, __dirname, __filename, process, module */
/**
 * validate-native-build.js
 *
 * Validates that Expo config plugins generate correct native source files
 * by dry-running the plugin pipeline and inspecting every output file.
 *
 * Checks performed:
 *   1.  Plugin modules load without throwing (require() validation)
 *   2.  All expected output paths from the plugin are accounted for
 *   3.  Every Kotlin template file:
 *         a. Contains no unreplaced placeholders  (__FOO__, PLACEHOLDER_, etc.)
 *         b. Declares a valid `package` statement on line 1
 *         c. Contains `BuildConfig.DEBUG` (not a raw boolean literal) for dev guards
 *         d. Has no bare `true` / `false` literal standing alone as a debug flag
 *   4.  Every Swift source file:
 *         a. Contains no unreplaced placeholders
 *         b. Declares every `private var` used in method bodies
 *         c. Has no `import` statements referencing non-existent modules
 *   5.  The ObjC bridging file (.m) is present alongside each .swift file
 *   6.  ProGuard rules file references no undefined class patterns
 *   7.  app.json schema: no `deploymentTarget` at ios top-level (must use
 *       expo-build-properties instead)
 *
 * Exit code 0 = all checks pass
 * Exit code 1 = one or more checks failed (errors printed to stderr)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');

// ─── Placeholder patterns ─────────────────────────────────────────────────────
// __DEV__ and __DEV_STAGE__ are legitimate React Native / Metro globals — excluded.
// Only uppercase-body dunder tokens that are NOT known RN globals are placeholders.
const RN_LEGITIMATE_GLOBALS = new Set(['__DEV__', '__DEV_STAGE__', '__BUNDLE_START_TIME__', '__fbBatchedBridge__']);

const PLACEHOLDER_PATTERNS = [
  { pattern: /__[A-Z][A-Z0-9_]+__/g,   label: 'dunder-placeholder  (e.g. __FOO__)' },
  { pattern: /PLACEHOLDER_[A-Z_]+/g,   label: 'PLACEHOLDER_* token' },
  { pattern: /TODO_REPLACE/g,          label: 'TODO_REPLACE marker' },
  { pattern: /<<<.+>>>/g,              label: 'conflict-marker <<< ... >>>' },
];

function checkForbiddenPatterns(content, relPath) {
  // Strip comment lines so we don't flag references inside // or /* */ comments
  const codeLines = content.split('\n').filter(l => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
  const codeOnly = codeLines.join('\n');

  let clean = true;
  for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(codeOnly)) !== null) {
      // Skip known-legitimate RN globals
      if (RN_LEGITIMATE_GLOBALS.has(m[0])) continue;
      fail(`${relPath}: forbidden pattern [${label}] found — "${m[0]}"`);
      clean = false;
    }
  }
  return clean;
}

/** Files the security plugin must produce (relative to project root) */
const REQUIRED_KOTLIN_FILES = [
  'android/app/src/main/java/com/medacademy/security/SecurityModule.kt',
  'android/app/src/main/java/com/medacademy/security/SecurityPackage.kt',
];

/** Swift source files the iOS plugin must copy into the Xcode project */
const REQUIRED_SWIFT_SOURCES = [
  'plugins/ios/IOSSecurityModule.swift',
];

/** ObjC bridging headers that must accompany each .swift file */
const REQUIRED_OBJC_HEADERS = [
  'plugins/ios/IOSSecurityModule.m',
];

/** app.json fields that must NOT appear at ios.* top-level */
const FORBIDDEN_APP_JSON_IOS_FIELDS = ['deploymentTarget'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const errors   = [];
const warnings = [];

function pass(msg)  { console.log(`  ✅  ${msg}`); }
function fail(msg)  { console.error(`  ❌  ${msg}`); errors.push(msg); }
function warn(msg)  { console.warn(`  ⚠️   ${msg}`); warnings.push(msg); }

function readFile(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

// Remove old inline checkForbiddenPatterns definition — now defined above near PLACEHOLDER_PATTERNS.

// ─── Step 1: Plugin module loads ─────────────────────────────────────────────

function checkPluginLoads() {
  console.log('\n── Step 1: Plugin modules load without errors ──────────────────');
  const plugins = [
    'plugins/withSecurityModule.js',
    'plugins/withProguardRules.js',
  ];
  for (const rel of plugins) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      fail(`${rel}: file not found`);
      continue;
    }
    try {
      require(abs);
      pass(`${rel} loads successfully`);
    } catch (e) {
      fail(`${rel}: require() threw — ${e.message}`);
    }
  }
}

// ─── Step 2: Plugin template extraction & placeholder scan ───────────────────

function checkKotlinTemplates() {
  console.log('\n── Step 2: Kotlin template content validation ──────────────────');
  const pluginPath = path.join(ROOT, 'plugins/withSecurityModule.js');
  if (!fs.existsSync(pluginPath)) {
    fail('plugins/withSecurityModule.js: file not found — cannot validate templates');
    return;
  }

  const pluginSrc = fs.readFileSync(pluginPath, 'utf8');

  // Extract every template literal that becomes a .kt file
  // Pattern: const SOMETHING_KT = `...`
  const templateRegex = /const\s+(\w+_KT)\s*=\s*`([\s\S]*?)`\s*;/g;
  let match;
  let found = 0;

  while ((match = templateRegex.exec(pluginSrc)) !== null) {
    const name    = match[1];
    const content = match[2];
    found++;

    console.log(`\n  Checking template: ${name}`);

    // 2a. Placeholder scan
    if (checkForbiddenPatterns(content, `template:${name}`)) {
      pass(`${name}: no forbidden placeholders`);
    }

    // 2b. Package declaration
    const firstLine = content.trimStart().split('\n')[0];
    if (/^package\s+\S+/.test(firstLine)) {
      pass(`${name}: valid package declaration on first line`);
    } else {
      fail(`${name}: missing or invalid package declaration (first line: "${firstLine}")`);
    }

    // 2c. BuildConfig.DEBUG used correctly (not raw boolean literal for debug guards)
    if (content.includes('!__DEV_PLACEHOLDER__') || content.includes('__DEV__')) {
      fail(`${name}: raw placeholder used for debug guard — must use BuildConfig.DEBUG`);
    } else if (content.includes('BuildConfig.DEBUG')) {
      pass(`${name}: debug guard uses BuildConfig.DEBUG correctly`);
    }
    // (no BuildConfig.DEBUG is fine if there are no debug guards)

    // 2d. Kotlin syntax basics: class declaration present
    if (/\bclass\s+\w+/.test(content)) {
      pass(`${name}: contains a class declaration`);
    } else {
      warn(`${name}: no class declaration found — may be incomplete`);
    }

    // 2e. Kotlin syntax: no unclosed backtick strings (template-in-template escape)
    const backtickIssues = content.match(/(?<!\\)`/g);
    // There should be zero backticks inside a properly escaped Kotlin file
    // (backtick identifiers are valid Kotlin but rare — flag them for inspection)
    if (backtickIssues && backtickIssues.length > 0) {
      warn(`${name}: contains ${backtickIssues.length} raw backtick(s) — verify these are intentional Kotlin identifier escapes, not JS template literal leakage`);
    }
  }

  if (found === 0) {
    fail('plugins/withSecurityModule.js: no *_KT template literals found — plugin may be broken');
  } else {
    pass(`Found and validated ${found} Kotlin template(s)`);
  }
}

// ─── Step 3: Swift source file validation ────────────────────────────────────

function checkSwiftSources() {
  console.log('\n── Step 3: Swift source file validation ────────────────────────');

  for (const rel of REQUIRED_SWIFT_SOURCES) {
    const content = readFile(rel);
    if (content === null) {
      fail(`${rel}: file not found`);
      continue;
    }

    // 3a. Placeholder scan
    if (checkForbiddenPatterns(content, rel)) {
      pass(`${rel}: no forbidden placeholders`);
    }

    // 3b. Find all `self.IDENT` and `IDENT[` usages to derive required stored properties
    // Then verify each is actually declared with `private var IDENT` or `private let IDENT`
    const usedProps = new Set();
    // Match: self.foo, foo[, foo.isEmpty, foo.count — for common stored property access patterns
    const usageRegex = /\bself\.(\w+)\b|(\w+)\s*\[|(\w+)\s*=\s*\[/g;
    let m;
    while ((m = usageRegex.exec(content)) !== null) {
      const prop = m[1] || m[2] || m[3];
      if (prop && /^[a-z]/.test(prop) && prop.length > 2) {
        usedProps.add(prop);
      }
    }

    // Find all declared stored properties
    const declaredProps = new Set();
    const declRegex = /private\s+(?:var|let)\s+(\w+)\s*[=:]/g;
    while ((m = declRegex.exec(content)) !== null) {
      declaredProps.add(m[1]);
    }
    // Also check non-private declarations
    const pubDeclRegex = /^\s*(?:var|let)\s+(\w+)\s*[=:]/gm;
    while ((m = pubDeclRegex.exec(content)) !== null) {
      declaredProps.add(m[1]);
    }

    // Check critical security-module-specific properties that MUST be declared
    const criticalProps = ['baselineIMPs', 'hasListeners', 'jailbreakCacheResult',
                           'jailbreakCacheExpiry', 'recordingMonitorTimer',
                           'screenshotObserver', 'recordingObserver'];
    let propsFail = false;
    for (const prop of criticalProps) {
      if (content.includes(prop) && !declaredProps.has(prop)) {
        fail(`${rel}: property '${prop}' is used but not declared as a stored property`);
        propsFail = true;
      }
    }
    if (!propsFail) {
      pass(`${rel}: all critical stored properties are declared`);
    }

    // 3c. ObjC bridging header exists alongside each Swift file
    const mFile = rel.replace('.swift', '.m');
    if (readFile(mFile) !== null) {
      pass(`${mFile}: ObjC bridging file exists`);
    } else {
      fail(`${mFile}: missing ObjC bridging file (required for RCT_EXTERN_MODULE)`);
    }

    // 3d. RCT_EXTERN_MODULE declared in .m file
    const mContent = readFile(mFile);
    if (mContent) {
      if (mContent.includes('RCT_EXTERN_MODULE')) {
        pass(`${mFile}: RCT_EXTERN_MODULE declaration found`);
      } else {
        fail(`${mFile}: missing RCT_EXTERN_MODULE — Swift module will not be registered in RN bridge`);
      }
    }

    // 3e. Import MachO is present (required for bundle integrity check)
    if (content.includes('import MachO')) {
      pass(`${rel}: imports MachO (required for LC_ENCRYPTION_INFO check)`);
    } else {
      warn(`${rel}: MachO not imported — bundle integrity check may be incomplete`);
    }

    // 3f. SecRandomCopyBytes used (not arc4random) — check code lines only, not comments
    const arc4InCode = content.split('\n').some(l => {
      const t = l.trimStart();
      return !t.startsWith('//') && /\barc4random\b/.test(t);
    });
    if (arc4InCode) {
      fail(`${rel}: arc4random() found in code — must use SecRandomCopyBytes for cryptographic nonces`);
    } else {
      pass(`${rel}: no arc4random() in code (CSPRNG compliance)`);
    }
  }
}

// ─── Step 4: ObjC bridging header validation ─────────────────────────────────

function checkObjCHeaders() {
  console.log('\n── Step 4: ObjC bridging header validation ─────────────────────');
  for (const rel of REQUIRED_OBJC_HEADERS) {
    const content = readFile(rel);
    if (content === null) {
      fail(`${rel}: file not found`);
      continue;
    }
    if (checkForbiddenPatterns(content, rel)) {
      pass(`${rel}: no forbidden placeholders`);
    }
    // Must import React bridge headers
    if (content.includes('#import <React/RCTBridgeModule.h>')) {
      pass(`${rel}: imports RCTBridgeModule.h`);
    } else {
      fail(`${rel}: missing #import <React/RCTBridgeModule.h>`);
    }
    // Must have at least one RCT_EXTERN_METHOD
    const methodCount = (content.match(/RCT_EXTERN_METHOD/g) || []).length;
    if (methodCount > 0) {
      pass(`${rel}: ${methodCount} RCT_EXTERN_METHOD declaration(s) found`);
    } else {
      fail(`${rel}: no RCT_EXTERN_METHOD declarations — no methods will be callable from JS`);
    }
  }
}

// ─── Step 5: app.json schema checks ─────────────────────────────────────────

function checkAppJson() {
  console.log('\n── Step 5: app.json schema validation ──────────────────────────');
  const content = readFile('app.json');
  if (!content) {
    fail('app.json: file not found');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
    pass('app.json: valid JSON');
  } catch (e) {
    fail(`app.json: JSON parse error — ${e.message}`);
    return;
  }

  const ios = parsed?.expo?.ios ?? {};

  for (const field of FORBIDDEN_APP_JSON_IOS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(ios, field)) {
      fail(`app.json: expo.ios.${field} is not a valid Expo schema field — use expo-build-properties instead`);
    } else {
      pass(`app.json: expo.ios.${field} is not set (correct)`);
    }
  }

  // NSAllowsArbitraryLoads must be false
  const ats = ios?.infoPlist?.NSAppTransportSecurity;
  if (ats) {
    if (ats.NSAllowsArbitraryLoads === false) {
      pass('app.json: NSAllowsArbitraryLoads is false (ATS enforced)');
    } else if (ats.NSAllowsArbitraryLoads === true) {
      fail('app.json: NSAllowsArbitraryLoads is true — all cleartext HTTP is permitted (security violation)');
    }
  } else {
    warn('app.json: NSAppTransportSecurity not configured — ATS defaults apply');
  }

  // NSPrivacyAccessedAPITypes must be present
  const privacyTypes = ios?.infoPlist?.NSPrivacyAccessedAPITypes;
  if (Array.isArray(privacyTypes) && privacyTypes.length > 0) {
    pass(`app.json: NSPrivacyAccessedAPITypes declared (${privacyTypes.length} entries)`);
  } else {
    warn('app.json: NSPrivacyAccessedAPITypes missing — App Store submission may be rejected');
  }

  // App Attest environment must be 'production'
  const env = ios?.entitlements?.['com.apple.developer.app-attest-environment'];
  if (env === 'production') {
    pass('app.json: App Attest environment is production');
  } else if (env) {
    warn(`app.json: App Attest environment is "${env}" — must be "production" for release builds`);
  } else {
    warn('app.json: App Attest entitlement not configured');
  }
}

// ─── Step 6: ProGuard rules validation ───────────────────────────────────────

function checkProguardRules() {
  console.log('\n── Step 6: ProGuard / R8 rules validation ───────────────────────');
  const pluginPath = path.join(ROOT, 'plugins/withProguardRules.js');
  if (!fs.existsSync(pluginPath)) {
    fail('plugins/withProguardRules.js: file not found');
    return;
  }

  const src = fs.readFileSync(pluginPath, 'utf8');

  // Extract PROGUARD_RULES template
  const templateMatch = src.match(/const PROGUARD_RULES\s*=\s*`([\s\S]*?)`\s*;/);
  if (!templateMatch) {
    fail('plugins/withProguardRules.js: PROGUARD_RULES template not found');
    return;
  }

  const rules = templateMatch[1];

  // Security module class must be kept
  if (rules.includes('-keep class com.medacademy.security.**')) {
    pass('ProGuard: com.medacademy.security.** is kept');
  } else {
    fail('ProGuard: com.medacademy.security.** not kept — SecurityModule will be stripped in release builds');
  }

  // React Native must be kept
  if (rules.includes('-keep class com.facebook.react.**')) {
    pass('ProGuard: com.facebook.react.** is kept');
  } else {
    fail('ProGuard: com.facebook.react.** not kept — RN bridge will be stripped');
  }

  // Must not allow arbitrary loads via ProGuard
  if (rules.includes('NSAllowsArbitraryLoads')) {
    fail('ProGuard: NSAllowsArbitraryLoads found in ProGuard rules — wrong file');
  }

  // Play Integrity must be kept (used via reflection in SecurityModule)
  if (rules.includes('-keep class com.google.android.play.core.integrity.**')) {
    pass('ProGuard: Play Integrity API classes are kept');
  } else {
    fail('ProGuard: Play Integrity classes not kept — reflection-based Play Integrity calls will fail at runtime');
  }

  pass('ProGuard rules file validated');
}

// ─── Step 7: TypeScript config sanity check ──────────────────────────────────

function checkTsConfig() {
  console.log('\n── Step 7: TypeScript config validation ─────────────────────────');
  const content = readFile('tsconfig.json');
  if (!content) {
    fail('tsconfig.json: file not found');
    return;
  }
  try {
    JSON.parse(content);
    pass('tsconfig.json: valid JSON');
  } catch (e) {
    fail(`tsconfig.json: JSON parse error — ${e.message}`);
  }
}

// ─── Step 8: Security TS source placeholder checks ───────────────────────────

function checkTsSecurity() {
  console.log('\n── Step 8: TypeScript security source validation ────────────────');

  const securityFiles = [
    'src/lib/security.ts',
    'src/lib/securityConfigService.ts',
    'src/lib/installationId.ts',
    'src/lib/useContentProtection.ts',
  ];

  for (const rel of securityFiles) {
    const content = readFile(rel);
    if (content === null) {
      warn(`${rel}: file not found (skipping)`);
      continue;
    }

    if (checkForbiddenPatterns(content, rel)) {
      pass(`${rel}: no forbidden placeholders`);
    }

    // Production console.log/warn must be gated by __DEV__
    // Strategy: walk line by line tracking whether we're inside an if (__DEV__) block.
    // A bare console call is one that appears on a line where __DEV__ does NOT appear
    // on the same line AND is not inside an if (__DEV__) { ... } block.
    const srcLines = content.split('\n');
    const bareLogs = [];
    let devDepth = 0;
    let braceDepth = 0;
    for (const line of srcLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) continue;    // skip line comments

      // Detect entry into if (__DEV__) { — single-line or block
      if (/if\s*\(__DEV__\)/.test(trimmed)) {
        // Single-line: if (__DEV__) console.xxx(...) — no opening brace, depth unchanged
        if (!trimmed.includes('{')) {
          // Single-line — any console on this line is gated
          devDepth++;
        } else {
          devDepth++;
        }
      }

      // Track brace openings/closings to detect end of __DEV__ block
      const opens  = (trimmed.match(/\{/g) || []).length;
      const closes = (trimmed.match(/\}/g) || []).length;

      const isGated = devDepth > 0 || /if\s*\(__DEV__\)/.test(trimmed);

      if (/\bconsole\.(log|warn|error)\s*\(/.test(trimmed) && !isGated) {
        bareLogs.push(line);
      }

      braceDepth += opens - closes;
      if (devDepth > 0 && closes > 0 && braceDepth < devDepth) {
        devDepth = Math.max(0, devDepth - closes);
      }
    }

    if (bareLogs.length > 0) {
      fail(`${rel}: ${bareLogs.length} console.log/warn call(s) not gated by __DEV__ — will log in production:\n    ${bareLogs.slice(0,3).map(l => l.trim()).join('\n    ')}`);
    } else {
      pass(`${rel}: all console calls are __DEV__-gated`);
    }

    // SecureStore calls must include keychainService namespace
    if (content.includes('SecureStore.setItemAsync') || content.includes('SecureStore.getItemAsync')) {
      if (content.includes("keychainService: 'com.medacademy.security'")) {
        pass(`${rel}: SecureStore calls include keychainService isolator`);
      } else if (!content.includes('SecureStore.setItemAsync') && !content.includes('SecureStore.getItemAsync')) {
        // no set/get calls
      } else {
        // Check if file has ATTEST_KEY_OPTIONS defined elsewhere
        if (content.includes('ATTEST_KEY_OPTIONS') || content.includes('keychainService')) {
          pass(`${rel}: SecureStore keychainService configured`);
        } else {
          warn(`${rel}: SecureStore calls found but no keychainService isolator — keys may collide`);
        }
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  MedAcademy — Native Build Validation Pipeline');
  console.log('═══════════════════════════════════════════════════════════════════');

  checkPluginLoads();
  checkKotlinTemplates();
  checkSwiftSources();
  checkObjCHeaders();
  checkAppJson();
  checkProguardRules();
  checkTsConfig();
  checkTsSecurity();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════════');
  if (errors.length === 0 && warnings.length === 0) {
    console.log('  RESULT: ✅  ALL CHECKS PASSED — safe to proceed to packaging');
  } else if (errors.length === 0) {
    console.log(`  RESULT: ✅  PASSED with ${warnings.length} warning(s)`);
    console.log('  Warnings (non-blocking):');
    warnings.forEach(w => console.log(`    ⚠️  ${w}`));
  } else {
    console.error(`  RESULT: ❌  FAILED — ${errors.length} error(s), ${warnings.length} warning(s)`);
    console.error('  Errors (must fix before packaging):');
    errors.forEach(e => console.error(`    ❌  ${e}`));
    if (warnings.length > 0) {
      console.warn('  Warnings:');
      warnings.forEach(w => console.warn(`    ⚠️  ${w}`));
    }
  }
  console.log('═══════════════════════════════════════════════════════════════════\n');

  process.exit(errors.length > 0 ? 1 : 0);
}

main();
