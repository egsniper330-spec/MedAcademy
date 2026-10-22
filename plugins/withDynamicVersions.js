// CommonJS — Expo config plugins are require()d by the prebuild pipeline.
// plugins/ is excluded from oxlint via .eslintignore.
//
// withDynamicVersions — ensures iOS and Android version strings always match
// the app.json that the CI platform updates before every build.
//
// STRATEGY (v3 — gradle.properties approach):
//   Previous attempts injected a Groovy JsonSlurper block into build.gradle.
//   That caused failures on CI build servers due to:
//     - import statement position (must precede all other statements in strict Gradle)
//     - UTF-8 box-drawing characters in comments breaking non-UTF-8 build locales
//     - rootDir path assumption being wrong in CI sandbox layout
//
//   New approach:
//     Android: write APP_VERSION_NAME and APP_VERSION_CODE into gradle.properties
//              via withGradleProperties, then reference them in build.gradle with
//              findProperty() — pure key=value, no Groovy parsing, no imports,
//              no path assumptions, works in every Gradle version and locale.
//     iOS:     Info.plist gets the REAL values (CFBundleShortVersionString =
//              config.version, CFBundleVersion = config.ios.buildNumber) and
//              the Xcode build settings MARKETING_VERSION /
//              CURRENT_PROJECT_VERSION are kept in sync with them.
//
// BUG THIS FIXES (iOS forced-update mismatch): the previous iOS step replaced
// both Info.plist values with the tokens '$(MARKETING_VERSION)' and
// '$(CURRENT_PROJECT_VERSION)', but nothing ever set those build settings —
// Expo prebuild does not write them and they stay at Xcode's template defaults
// (1.0 / 1). The built app therefore reported "1.0 (build 1)" no matter what
// app.json said (version 1.0.844, ios.buildNumber 221), the client sent
// X-App-Version-Code: 1 to the backend, and the version floor blocked it.
// Changing ios.buildNumber had zero effect because the value was overwritten
// in the same prebuild pass that wrote it.

const path = require('path');
// Resolve @expo/config-plugins from expo's own package tree so we always get
// the SDK-55-compatible version (55.x), not any top-level project override.
const expoRoot = path.dirname(require.resolve('expo/package.json'));
const {
  withAppBuildGradle,
  withGradleProperties,
  withInfoPlist,
  withXcodeProject,
} = require(require.resolve('@expo/config-plugins', { paths: [expoRoot] }));

// ─── Android: write version into gradle.properties ───────────────────────────

function withDynamicAndroidVersion(config) {
  // Step 1: Inject APP_VERSION_NAME and APP_VERSION_CODE into gradle.properties.
  // withGradleProperties receives an array of { type, key, value } objects.
  // The plugin merges them — existing keys with same name are replaced.
  config = withGradleProperties(config, (cfg) => {
    const version     = config.version      || '1.0.0';
    const versionCode = (config.android && config.android.versionCode)
      ? String(config.android.versionCode)
      : '1';

    // Remove any previous entries for these keys (idempotent)
    cfg.modResults = cfg.modResults.filter(
      (item) => item.key !== 'APP_VERSION_NAME' && item.key !== 'APP_VERSION_CODE'
    );
    cfg.modResults.push({ type: 'property', key: 'APP_VERSION_NAME', value: version });
    cfg.modResults.push({ type: 'property', key: 'APP_VERSION_CODE', value: versionCode });
    return cfg;
  });

  // Step 2: Replace versionCode / versionName in build.gradle with findProperty() calls.
  // Also strip any leftover JsonSlurper / _dyn* lines from previous plugin versions.
  config = withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents;

    // -- Remove all traces of previous JsonSlurper-based approach --
    // Pattern A: our old plugin block (has unique header comment)
    contents = contents.replace(
      /[ \t]*\/\/ ── Dynamic version from app\.json[^\n]*\n([ \t]*[^\n]*\n)*?[ \t]*\/\/[ \t─]+\n/g,
      ''
    );
    // Pattern B: stray orphan lines
    const orphanPatterns = [
      /^import groovy\.json\.JsonSlurper[^\n]*\n/gm,
      /^def _dynRoot\s*=[^\n]*\n/gm,
      /^def _dynJson\s*=[^\n]*\n/gm,
      /^def _dynVersion\s*=[^\n]*\n/gm,
      /^def _dynBuild\s*=[^\n]*\n/gm,
      /^def appJsonFile\s*=[^\n]*\n/gm,
      /^def appJson\s*=[^\n]*\n/gm,
      /^def appVersion\s*=[^\n]*\n/gm,
      /^def appBuild\s*=[^\n]*\n/gm,
    ];
    for (const re of orphanPatterns) {
      contents = contents.replace(re, '');
    }

    // -- Replace versionCode / versionName lines (line-anchored, idempotent) --
    // Match ONLY lines where the value is NOT already our findProperty() call,
    // to prevent double-substitution on repeated prebuild runs.
    // Use Integer.parseInt() to avoid Groovy ambiguity where
    // `versionCode (expr)` is parsed as a method call instead of assignment.
    // Idempotency guard: match any line that is NOT already the exact target form.
    const TARGET_VERSION_CODE = "Integer.parseInt((findProperty('APP_VERSION_CODE') ?: '1').toString())";
    const TARGET_VERSION_NAME = "(findProperty('APP_VERSION_NAME') ?: '1.0.0').toString()";

    contents = contents.replace(
      /^(\s*versionCode\s+)(.+)$/mg,
      (match, prefix, value) => {
        if (value.trim() === TARGET_VERSION_CODE) return match; // already correct
        return prefix + TARGET_VERSION_CODE;
      }
    );
    contents = contents.replace(
      /^(\s*versionName\s+)(.+)$/mg,
      (match, prefix, value) => {
        if (value.trim() === TARGET_VERSION_NAME) return match; // already correct
        return prefix + TARGET_VERSION_NAME;
      }
    );

    cfg.modResults.contents = contents;
    return cfg;
  });

  return config;
}

// ─── iOS: write the real version / build into Info.plist ─────────────────────

/**
 * The identity iOS will actually carry, resolved the same way Expo does
 * (`ios.version` overrides `version` for CFBundleShortVersionString;
 * `ios.buildNumber` is CFBundleVersion). Empty string = not configured, in
 * which case the value already in the project is left untouched instead of
 * being replaced by a token that resolves to nothing.
 */
function resolveIosVersionIdentity(config) {
  const ios = config.ios || {};
  const shortVersion = String(ios.version || config.version || '').trim();
  const buildNumber = String(ios.buildNumber || '').trim();
  return { shortVersion, buildNumber };
}

function withDynamicIOSVersion(config) {
  const { shortVersion, buildNumber } = resolveIosVersionIdentity(config);

  // 1. Info.plist — the values expo-application (and therefore the forced
  //    update screen) reports at runtime.
  config = withInfoPlist(config, (cfg) => {
    if (shortVersion) cfg.modResults['CFBundleShortVersionString'] = shortVersion;
    if (buildNumber)  cfg.modResults['CFBundleVersion'] = buildNumber;
    return cfg;
  });

  // 2. Xcode build settings — keep MARKETING_VERSION /
  //    CURRENT_PROJECT_VERSION equal to the same values so Xcode's UI, CI
  //    tooling and any remaining $(MARKETING_VERSION) reference can never
  //    disagree with the Info.plist above.
  config = withXcodeProject(config, (cfg) => {
    let section = null;
    try {
      section = cfg.modResults.pbxXCBuildConfigurationSection();
    } catch {
      return cfg; // no project to patch (e.g. a config-only evaluation)
    }
    for (const key of Object.keys(section || {})) {
      const entry = section[key];
      if (!entry || typeof entry !== 'object' || !entry.buildSettings) continue;
      if (shortVersion) entry.buildSettings.MARKETING_VERSION = shortVersion;
      if (buildNumber)  entry.buildSettings.CURRENT_PROJECT_VERSION = buildNumber;
    }
    return cfg;
  });

  return config;
}

// ─── Combined export ──────────────────────────────────────────────────────────

const withDynamicVersions = (config) => {
  config = withDynamicAndroidVersion(config);
  config = withDynamicIOSVersion(config);
  return config;
};

module.exports = withDynamicVersions;
// Exposed for tests (tests/appVersionIdentity.test.cjs) — pure, no config mods.
module.exports.resolveIosVersionIdentity = resolveIosVersionIdentity;
