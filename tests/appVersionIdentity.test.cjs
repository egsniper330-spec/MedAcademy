/**
 * iOS app version / build identity + forced-update comparison.
 *
 * Run: node tests/appVersionIdentity.test.cjs
 *
 * The reported defect: a build configured as app.json `version: "1.0.844"`,
 * `ios.buildNumber: "221"` displayed "Current version 1.0 (Build 1)" and was
 * blocked by the update floor (minimum 221).
 *
 * Root cause: plugins/withDynamicVersions.js rewrote both Info.plist values to
 * the Xcode tokens '$(MARKETING_VERSION)' / '$(CURRENT_PROJECT_VERSION)' and
 * nothing ever set those build settings, so they stayed at Xcode's template
 * defaults (1.0 / 1). The plugin is therefore executed for real below — not
 * merely pattern-matched — to prove the values it now writes.
 *
 * Covered:
 *   A. iOS identity resolution from the Expo config.
 *   B. The config plugin writes the REAL version/build into Info.plist.
 *   C. Xcode build settings stay in sync with the same values.
 *   D. The runtime identity source (expo-application) and its safe fallbacks.
 *   E. Comparison semantics (equal / newer / older / unknown / disabled).
 *   F. Backend ⇄ client field mapping, and per-platform independence.
 *   G. Android is untouched by the iOS fix.
 *   H. A failed update check never invents a version or a block.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log(`  ✔ ${msg}`);
}

/** Strip // and /* *\/ comments so a check can never pass by matching prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const plugin = require(path.join(ROOT, 'plugins/withDynamicVersions.js'));

/** Runs the plugin's Info.plist mod exactly as prebuild would, over a plist
 *  that still carries an older build's values. */
function applyInfoPlist(config, existing) {
  const built = plugin(config);
  const mod = built.mods.ios.infoPlist;
  assert.equal(typeof mod, 'function', 'plugin registers an ios infoPlist mod');
  return Promise.resolve(
    mod({
      modRequest: { projectRoot: ROOT, platform: 'ios' },
      modResults: { ...existing },
    }),
  ).then((r) => r.modResults);
}

(async () => {
  // ── A. Identity resolution ────────────────────────────────────────────────
  console.log('\nA. iOS identity resolved from the Expo config');
  const identity = plugin.resolveIosVersionIdentity;
  ok(typeof identity === 'function', 'plugin exposes resolveIosVersionIdentity (pure)');

  ok(
    identity({ version: '1.0.844', ios: { buildNumber: '221' } }).shortVersion === '1.0.844',
    'CFBundleShortVersionString ← expo.version (1.0.844)',
  );
  ok(
    identity({ version: '1.0.844', ios: { buildNumber: '221' } }).buildNumber === '221',
    'CFBundleVersion ← expo.ios.buildNumber (221)',
  );
  ok(
    identity({ version: '1.0.844', ios: { version: '2.0.0', buildNumber: 222 } }).shortVersion === '2.0.0',
    'ios.version overrides version for the short version string (Expo semantics)',
  );
  ok(
    identity({ version: '1.0.844', ios: { buildNumber: 222 } }).buildNumber === '222',
    'a numeric ios.buildNumber is normalised to a string',
  );
  const unset = identity({ version: '1.0.844', ios: {} });
  ok(unset.buildNumber === '', 'missing ios.buildNumber resolves to "" (left untouched, not tokenised)');
  ok(identity({ ios: {} }).shortVersion === '', 'missing version resolves to "" (no invented 1.0)');

  // ── B. Info.plist gets the real values ────────────────────────────────────
  console.log('\nB. Info.plist receives the real version/build');
  const plistSrc = stripComments(read('plugins/withDynamicVersions.js'));
  ok(
    !/modResults\['CFBundle(ShortVersionString|Version)'\]\s*=\s*'\$\('/.test(plistSrc),
    'plugin no longer assigns unresolved Xcode tokens to Info.plist',
  );

  const applied = await applyInfoPlist(
    { name: 'MedAcademy', slug: 'medacademy', version: '1.0.844', ios: { buildNumber: '221' } },
    { CFBundleShortVersionString: '1.0.432', CFBundleVersion: '1' },
  );
  ok(applied.CFBundleShortVersionString === '1.0.844', 'Info.plist CFBundleShortVersionString = 1.0.844');
  ok(applied.CFBundleVersion === '221', 'Info.plist CFBundleVersion = 221');
  ok(
    !/^\$\(/.test(applied.CFBundleShortVersionString) && !/^\$\(/.test(applied.CFBundleVersion),
    'neither value is an unresolved $(…) token',
  );

  const untouched = await applyInfoPlist(
    { name: 'MedAcademy', slug: 'medacademy', version: '1.0.844', ios: {} },
    { CFBundleShortVersionString: '1.0.844', CFBundleVersion: '9' },
  );
  ok(
    untouched.CFBundleVersion === '9',
    'unconfigured buildNumber leaves the existing value alone (never overwritten with a token)',
  );

  // ── C. Xcode build settings stay in sync ─────────────────────────────────
  console.log('\nC. Xcode build settings mirror the same values');
  ok(plistSrc.includes('withXcodeProject'), 'plugin patches the Xcode project too');
  ok(
    /buildSettings\.MARKETING_VERSION\s*=\s*shortVersion/.test(plistSrc),
    'MARKETING_VERSION ← the same short version',
  );
  ok(
    /buildSettings\.CURRENT_PROJECT_VERSION\s*=\s*buildNumber/.test(plistSrc),
    'CURRENT_PROJECT_VERSION ← the same build number',
  );
  ok(/pbxXCBuildConfigurationSection/.test(plistSrc), 'iterates every build configuration');

  // ── D. Runtime identity source ───────────────────────────────────────────
  console.log('\nD. Runtime identity (expo-application native metadata)');
  const appIdentity = read('src/lib/appIdentity.ts');
  ok(appIdentity.includes("from 'expo-application'"), 'appIdentity uses expo-application');
  ok(
    appIdentity.includes('nativeApplicationVersion') && appIdentity.includes('nativeBuildVersion'),
    'reads Application.nativeApplicationVersion + nativeBuildVersion (iOS CFBundle*)',
  );
  ok(
    appIdentity.indexOf('nativeBuild') < appIdentity.indexOf('expoConfig?.ios?.buildNumber'),
    'native metadata is preferred; Constants.expoConfig is only the fallback',
  );
  ok(
    /buildNumber:\s*0\b/.test(appIdentity),
    'an unknown identity resolves to build 0 (never a fabricated 1)',
  );
  ok(
    !/buildNumber:\s*1\b/.test(appIdentity),
    'no hardcoded build number 1 anywhere in the identity source',
  );

  const svc = read('src/lib/updateConfigService.ts');
  ok(
    /INSTALLED_CODE\s*=\s*getNativeBuildNumber\(\)/.test(svc),
    'updateConfigService takes the code from the native identity module',
  );
  ok(
    /INSTALLED_CODE > 0 \? \{ 'X-App-Version-Code'/.test(svc),
    'the /app/version request omits X-App-Version-Code when the build is unknown',
  );

  const phpClient = read('src/client/php.ts');
  ok(
    /if \(appVersionCode > 0\) headers\['X-App-Version-Code'\]/.test(phpClient),
    'authenticated requests also omit the header when the build is unknown',
  );

  const screen = read('src/components/ForceUpdateScreen.tsx');
  ok(
    screen.includes("update.installedVersionName || '—'"),
    'the update screen shows an em dash instead of a fabricated version',
  );
  ok(
    screen.includes('update.installedVersionCode > 0'),
    'the build number is only rendered when it is actually known',
  );

  // ── E. Comparison semantics ──────────────────────────────────────────────
  console.log('\nE. Comparison semantics (integer versionCode only)');
  const model = require(path.join(ROOT, 'scripts/state-build/securityStateModel.js'));
  const verdict = (installed, minimum) =>
    model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: minimum, installedVersionCode: installed })
      .verdict;

  ok(verdict(221, 221) === 'SUPPORTED', 'installed 221 = minimum 221 → SUPPORTED (no false block)');
  ok(verdict(222, 221) === 'SUPPORTED', 'installed 222 > minimum 221 → SUPPORTED');
  ok(verdict(220, 221) === 'UPDATE_REQUIRED', 'installed 220 < minimum 221 → UPDATE_REQUIRED');
  ok(verdict(1, 221) === 'UPDATE_REQUIRED', 'a genuinely stale build 1 < 221 is still blocked');
  ok(verdict(0, 221) === 'SUPPORTED', 'unknown identity stands down (never blocks on missing metadata)');
  ok(
    model.evaluateUpdateVerdict({ enabled: false, minimumVersionCode: 221, installedVersionCode: 1 }).verdict ===
      'SUPPORTED',
    'disabled policy → SUPPORTED (kill switch preserved)',
  );
  ok(
    model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: 0, installedVersionCode: 1 }).verdict ===
      'SUPPORTED',
    'no floor configured → SUPPORTED',
  );
  ok(
    !/parseFloat|parseInt\([^)]*Version|localeCompare/.test(
      read('src/lib/securityStateModel.ts').slice(
        read('src/lib/securityStateModel.ts').indexOf('export function evaluateUpdateVerdict'),
        read('src/lib/securityStateModel.ts').indexOf('export function evaluateUpdateVerdict') + 700,
      ),
    ),
    'the verdict uses numeric comparison — no string/lexicographic compare on version names',
  );

  // ── F. Backend ⇄ client contract + per-platform independence ─────────────
  console.log('\nF. Backend field mapping and platform independence');
  const backend = read('backend/src/Services/AppUpdateService.php');
  const publicPayload = backend.slice(
    backend.indexOf('public function publicPayload'),
    backend.indexOf('public function upsert'),
  );
  for (const key of [
    'latestVersion',
    'latestVersionCode',
    'minimumVersionCode',
    'updateMode',
    'updateUrl',
    'releaseNotes',
    'enabled',
    'platform',
  ]) {
    ok(publicPayload.includes(`'${key}'`), `publicPayload emits ${key} (client contract field)`);
  }
  ok(
    /'latestVersion'\s*=>\s*\(string\)\s*\$row\['latest_version_name'\]/.test(publicPayload),
    'latestVersion ← latest_version_name',
  );
  ok(
    /'latestVersionCode'\s*=>\s*\(int\)\s*\$row\['latest_version_code'\]/.test(publicPayload),
    'latestVersionCode ← latest_version_code (integer)',
  );
  ok(
    /'minimumVersionCode'\s*=>\s*\(int\)\s*\$row\['minimum_version_code'\]/.test(publicPayload),
    'minimumVersionCode ← minimum_version_code (integer)',
  );
  const clientConfig = svc.slice(
    svc.indexOf('export interface RemoteUpdateConfig'),
    svc.indexOf('export interface UpdateState'),
  );
  for (const key of ['latestVersion', 'latestVersionCode', 'minimumVersionCode', 'updateMode', 'updateUrl']) {
    ok(clientConfig.includes(`${key}?`), `client RemoteUpdateConfig declares ${key}`);
  }

  const evaluate = backend.slice(
    backend.indexOf('public function evaluate'),
    backend.indexOf('private function codeOrNull'),
  );
  ok(
    evaluate.includes('activeFor($platform)'),
    'evaluate() resolves the floor per platform (iOS and Android are independent)',
  );
  ok(
    /if \(\$min <= 0 \|\| \$versionCode >= \$min\)/.test(evaluate),
    'server floor: versionCode >= minimum → pass (same rule as the client)',
  );
  ok(
    /if \(\$platform === null \|\| \$versionCode === null\)/.test(evaluate),
    'absent identity headers are treated as unknown, not as version 0',
  );

  // ── G. Android untouched ────────────────────────────────────────────────
  console.log('\nG. Android behaviour preserved');
  ok(
    /withGradleProperties/.test(plistSrc) && /APP_VERSION_CODE/.test(plistSrc),
    'the Android gradle.properties injection is unchanged',
  );
  // android/ is generated by prebuild (gitignored) — assert on it only when it
  // exists locally, but always assert the plugin still writes the values.
  const gradlePath = path.join(ROOT, 'android/app/build.gradle');
  const gradlePropsPath = path.join(ROOT, 'android/gradle.properties');
  if (fs.existsSync(gradlePath) && fs.existsSync(gradlePropsPath)) {
    const gradle = read('android/app/build.gradle');
    ok(gradle.includes("findProperty('APP_VERSION_CODE')"), 'build.gradle still reads APP_VERSION_CODE');
    ok(gradle.includes("findProperty('APP_VERSION_NAME')"), 'build.gradle still reads APP_VERSION_NAME');
    const appJson = JSON.parse(read('app.json')).expo;
    const gradleProps = read('android/gradle.properties');
    ok(
      gradleProps.includes(`APP_VERSION_CODE=${appJson.android.versionCode}`) &&
        gradleProps.includes(`APP_VERSION_NAME=${appJson.version}`),
      'android/gradle.properties carries the configured versionCode/versionName',
    );
  } else {
    console.log('  ↷ android/ not prebuilt here — runtime gradle assertions skipped');
  }

  // ── H. Failure paths ─────────────────────────────────────────────────────
  console.log('\nH. A failed check never invents a version or a block');
  ok(
    /lastCheckFailed: true/.test(svc) && /verdict: 'UNKNOWN'/.test(svc),
    'a failed attempt leaves the verdict UNKNOWN and records the failure',
  );
  ok(
    /recordFailedAttempt/.test(svc),
    'the shared failure path is used for network errors and endpoint errors',
  );
  ok(
    !/versionName: '1\.0'/.test(svc) && !/latestVersionName: '1\.0/.test(svc),
    'no hardcoded 1.0 fallback version in the update service',
  );

  // ── I. EAS versioning source ────────────────────────────────────────────
  console.log('\nI. EAS builds from the local app config');
  const eas = JSON.parse(read('eas.json'));
  ok(
    eas.cli.appVersionSource === 'local',
    'eas.json cli.appVersionSource = "local" (app.json is the source of truth)',
  );
  for (const [name, profile] of Object.entries(eas.build || {})) {
    ok(
      profile.autoIncrement === undefined,
      `build profile "${name}" has no autoIncrement (the committed build number is built verbatim)`,
    );
  }
  const appJsonExpo = JSON.parse(read('app.json')).expo;
  ok(
    /^\d+$/.test(String(appJsonExpo.ios.buildNumber)),
    'expo.ios.buildNumber is a plain integer in app.json',
  );
  ok(
    Number.isInteger(appJsonExpo.android.versionCode),
    'expo.android.versionCode is an integer in app.json',
  );
  const versionDoc = read('docs/APP_VERSIONING.md');
  ok(
    versionDoc.includes('eas build:version:get') && versionDoc.includes('eas build:version:set'),
    'docs/APP_VERSIONING.md documents the EAS remote version commands',
  );

  console.log(`\n${pass} assertions passed.`);
})().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
