#!/usr/bin/env node
/**
 * plugins/withProductionSigning.js — Android release signing + cert pin contract.
 *
 * REGRESSION THAT BROKE THE GITHUB APK BUILD (run 43752564626):
 *
 *   * Where: android/app/build.gradle line: 98
 *   * What went wrong: A problem occurred evaluating project ':app'.
 *   > Could not find method buildConfigField() for arguments
 *     [String, REACT_NATIVE_RELEASE_LEVEL] on DefaultConfig$AgpDecorated
 *
 * The plugin injected the EXPECTED_CERT_SHA256 block by replacing the
 * **2-argument PREFIX** of the template's single statement
 *
 *     buildConfigField "String", "REACT_NATIVE_RELEASE_LEVEL", "\"...\""
 *
 * so the injected statements landed *inside* that call. It stayed invisible on
 * developer machines because a hand-patched android/app/build.gradle already
 * contained EXPECTED_CERT_SHA256 and the idempotence guard skipped injection —
 * only a clean `expo prebuild` (exactly what CI does) reproduced it.
 *
 * This suite pins the fix against the REAL template text from
 * expo-template-bare-minimum (the file `expo prebuild` generates):
 *
 *   A. the release-level `buildConfigField` statement stays whole,
 *   B. no `buildConfigField` is ever emitted with fewer than three arguments,
 *   C. the pin is injected INSIDE `defaultConfig { }` (BuildConfig must compile
 *      in debug builds too),
 *   D. production signing survives: signingConfigs.release exists, release uses
 *      it, the debug keystore is referenced exactly once (no debug fallback),
 *   E. the fail-closed release guard is appended,
 *   F. the mod is idempotent, CRLF-safe, and survives the template being
 *      re-wrapped across lines.
 *
 * Usage: node tests/productionSigningPlugin.test.cjs
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const plugin = require(path.join(ROOT, 'plugins', 'withProductionSigning.js'));

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}

/** Verbatim excerpt of expo-template-bare-minimum/android/app/build.gradle. */
const TEMPLATE = [
  'apply plugin: "com.android.application"',
  'apply plugin: "org.jetbrains.kotlin.android"',
  '',
  'android {',
  '    buildToolsVersion rootProject.ext.buildToolsVersion',
  '    compileSdk rootProject.ext.compileSdkVersion',
  '',
  '    namespace "com.helloworld"',
  '    defaultConfig {',
  '        applicationId "com.helloworld"',
  '        minSdkVersion rootProject.ext.minSdkVersion',
  '        targetSdkVersion rootProject.ext.targetSdkVersion',
  '        versionCode 1',
  '        versionName "1.0"',
  '',
  '        buildConfigField "String", "REACT_NATIVE_RELEASE_LEVEL", "\\"${findProperty(\'reactNativeReleaseLevel\') ?: \'stable\'}\\"',
  '    }',
  '    signingConfigs {',
  '        debug {',
  "            storeFile file('debug.keystore')",
  "            storePassword 'android'",
  "            keyAlias 'androiddebugkey'",
  "            keyPassword 'android'",
  '        }',
  '    }',
  '    buildTypes {',
  '        debug {',
  '            signingConfig signingConfigs.debug',
  '        }',
  '        release {',
  '            // Caution! In production, you need to generate your own keystore file.',
  '            // see https://reactnative.dev/docs/signed-apk-android.',
  '            signingConfig signingConfigs.debug',
  '            minifyEnabled enableMinifyInReleaseBuilds',
  '            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"',
  '        }',
  '    }',
  '}',
  '',
  'dependencies {',
  '    implementation("com.facebook.react:react-android")',
  '}',
  '',
].join('\n');

/** Runs the plugin's appBuildGradle mod the same way expo prebuild does. */
function applyMod(contents) {
  const config = plugin({ name: 'MedAcademy', slug: 'medacademy', version: '1.0.0' });
  const key = Object.keys(config.mods.android).find((k) => /buildgradle/i.test(k));
  const holder = { modRequest: {}, modResults: { contents, language: 'groovy' } };
  config.mods.android[key](holder);
  return holder.modResults.contents;
}

/** Extracts a top-level `name { ... }` block by brace counting. */
function blockOf(text, header) {
  const start = text.search(new RegExp('^\\s*' + header + '[ \\t]*\\{', 'm'));
  if (start < 0) return '';
  const openAt = text.indexOf('{', start);
  let depth = 0;
  for (let i = openAt; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

const out = applyMod(TEMPLATE);
const outLines = out.split('\n');
const defaultConfig = blockOf(out, 'defaultConfig');
const releaseLevelLines = outLines.filter((l) => l.includes('REACT_NATIVE_RELEASE_LEVEL'));
const shortCalls = outLines.filter((l) => /^\s*buildConfigField\s+"String"\s*,\s*"[A-Za-z_]+"\s*$/.test(l));

// ── A. the template's own statement must survive untouched ───────────────────
ok(releaseLevelLines.length === 1,
  `the REACT_NATIVE_RELEASE_LEVEL statement appears exactly once (found ${releaseLevelLines.length})`);
ok(releaseLevelLines.length === 1
  && /^\s*buildConfigField\s+"String"\s*,\s*"REACT_NATIVE_RELEASE_LEVEL"\s*,\s*".*"\s*$/.test(releaseLevelLines[0]),
  'the REACT_NATIVE_RELEASE_LEVEL buildConfigField keeps all three arguments on one line');

// ── B. never emit an incomplete buildConfigField call ────────────────────────
ok(shortCalls.length === 0,
  `no buildConfigField is emitted with two arguments (found: ${shortCalls.join(' | ') || 'none'})`);

// ── C. the pin goes INSIDE defaultConfig ─────────────────────────────────────
ok(defaultConfig.length > 0, 'defaultConfig { } block is present in the output');
ok(defaultConfig.includes('EXPECTED_CERT_SHA256'),
  'EXPECTED_CERT_SHA256 buildConfigField is injected inside defaultConfig');
ok(defaultConfig.includes('buildConfigField "String", "EXPECTED_CERT_SHA256"'),
  'the pin is a String buildConfigField (not a comment)');
ok(/def expectedCert = \(findProperty\('expectedCertSha256'\)/.test(defaultConfig),
  'the pin resolves expectedCertSha256 / MEDA_EXPECTED_CERT_SHA256 / expected-cert-sha256.local');
ok(defaultConfig.includes('buildConfigField "String", "API_SPKI_PINS"'),
  'API_SPKI_PINS is written from the real apiSpkiPins property');

// braces inside the extracted block must balance (splicing accidents break this)
const bracesBalanced = (defaultConfig.match(/\{/g) || []).length
  === (defaultConfig.match(/\}/g) || []).length;
ok(bracesBalanced, 'defaultConfig braces stay balanced after injection');

// ── D. production signing survives, with no debug fallback ───────────────────
ok(out.includes('signingConfigs.release'), 'a release signingConfig is injected');
ok(out.includes('signingConfig signingConfigs.release'), 'the release buildType uses signingConfigs.release');
ok((out.match(/signingConfig signingConfigs\.debug/g) || []).length === 1,
  'the debug keystore is referenced exactly once (debug buildType only)');
ok(!/signingConfigs\.release\s*\{\s*storeFile\s+null/.test(out),
  'the release signing config is fail-closed (no silent debug fallback)');

// ── E. fail-closed release guard ─────────────────────────────────────────────
ok(out.includes('[MedAcademy] RELEASE BUILD BLOCKED'),
  'the fail-closed release guard is appended');
ok(/graph\.allTasks\.any \{ t ->[\s\S]*assembleRelease/.test(out),
  'the guard is task-graph aware (only release packaging is blocked)');

// ── F. idempotence and formatting robustness ─────────────────────────────────
ok(applyMod(out) === out, 'running the plugin twice produces an identical file');

const crlf = applyMod(TEMPLATE.replace(/\n/g, '\r\n'));
ok(crlf.split('\r\n').filter((l) => l.includes('REACT_NATIVE_RELEASE_LEVEL')).length === 1,
  'CRLF line endings do not shift the injection point');
ok(!crlf.split('\r\n').some((l) => /^\s*buildConfigField\s+"String"\s*,\s*"[A-Za-z_]+"\s*$/.test(l)),
  'CRLF line endings do not produce an incomplete buildConfigField');

const wrapped = TEMPLATE.replace(
  '        buildConfigField "String", "REACT_NATIVE_RELEASE_LEVEL", "\\"${findProperty(\'reactNativeReleaseLevel\') ?: \'stable\'}\\"',
  '        buildConfigField "String", "REACT_NATIVE_RELEASE_LEVEL",\n            "\\"${findProperty(\'reactNativeReleaseLevel\') ?: \'stable\'}\\"",',
);
const wrappedOut = applyMod(wrapped);
ok(wrappedOut.includes('buildConfigField "String", "REACT_NATIVE_RELEASE_LEVEL",'),
  'a re-wrapped (multi-line) release-level statement is left intact');
ok((wrappedOut.match(/REACT_NATIVE_RELEASE_LEVEL/g) || []).length === 1,
  'no duplicate release-level statement after a re-wrapped template');

console.log(failed
  ? `\nRESULT: ${passed} passed, ${failed} failed`
  : `\nPASS: ${passed} production-signing (Android APK signing + cert pin) checks`);
process.exit(failed ? 1 : 0);
