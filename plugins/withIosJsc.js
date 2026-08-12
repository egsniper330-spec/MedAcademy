// CommonJS — Expo config plugins are require()d by the prebuild pipeline.
// plugins/ is excluded from oxlint via .eslintignore.
//
// withIosJsc — force hermes_enabled: false in the generated iOS Podfile.
//
// WHY THIS EXISTS
// ───────────────
// The Expo-generated Podfile computes hermes_enabled dynamically:
//
//   use_react_native!(
//     :hermes_enabled => podfile_properties['expo.jsEngine'] == nil ||
//                        podfile_properties['expo.jsEngine'] == 'hermes',
//     ...
//   )
//
// In React Native 0.83, use_react_native! calls setup_hermes! during CocoaPods
// dependency resolution when hermes_enabled evaluates to true. This installs the
// hermes-engine pod even when Podfile.properties.json correctly contains
// expo.jsEngine=jsc, because the string comparison can silently fail (e.g.
// trailing whitespace, encoding differences, or env-var override).
//
// Additionally, react_native_post_install reads use_hermes() from jsengine.rb,
// which in RN 0.83 is hardcoded as !use_third_party_jsc(). Even with
// expo.jsEngine=jsc in Podfile.properties.json, if USE_THIRD_PARTY_JSC env var
// is absent, use_hermes() returns true and USE_HERMES=1 build setting is written,
// causing Xcode to link hermesvm.framework regardless.
//
// SOLUTION
// ────────
// Replace the dynamic expression with the literal `false` directly in the
// generated Podfile, so hermes_enabled is unconditionally false for iOS.
// This is the correct, deterministic fix: the decision is made at prebuild time
// (where we control the app.json configuration) rather than at pod install time
// (where env vars and string comparisons can silently differ).
//
// ANDROID IS UNAFFECTED
// ─────────────────────
// This plugin only modifies ios/Podfile. Android uses gradle properties
// (android/gradle.properties: hermesEnabled=true) which is controlled by the
// separate withJsEngineGradleProps plugin from @expo/prebuild-config.
// The global jsEngine:"hermes" in app.json continues to govern Android.
//
// IDEMPOTENCY
// ───────────
// The replacement targets the exact generated expression. If the expression has
// already been replaced with `false` on a previous prebuild run (the idempotency
// marker), the file is left untouched.

const fs   = require('fs');
const path = require('path');

const expoRoot = path.dirname(require.resolve('expo/package.json'));
const { withDangerousMod } = require(
  require.resolve('@expo/config-plugins', { paths: [expoRoot] })
);

// The exact expression Expo SDK 55 / RN 0.83 writes into the generated Podfile.
// Matches the :hermes_enabled line produced by withDefaultPlugins → withPodfile.
const HERMES_ENABLED_DYNAMIC =
  "podfile_properties['expo.jsEngine'] == nil || podfile_properties['expo.jsEngine'] == 'hermes'";

// The literal replacement: unconditionally false for iOS JSC.
const HERMES_ENABLED_FALSE = 'false';

// Idempotency marker — the string present in the Podfile after a successful run.
// If this is already in the :hermes_enabled line, we skip the replacement.
const ALREADY_PATCHED_MARKER = ':hermes_enabled => false';

/**
 * withIosJsc
 *
 * Expo config plugin that post-processes the generated ios/Podfile during
 * `expo prebuild` to set `hermes_enabled: false` unconditionally, ensuring
 * the iOS build uses system JavaScriptCore and never installs hermes-engine.
 */
const withIosJsc = (config) => {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(
        config.modRequest.platformProjectRoot,
        'Podfile'
      );

      if (!fs.existsSync(podfilePath)) {
        // Podfile not yet generated (can happen in dry-run mode); skip silently.
        return config;
      }

      let podfile = fs.readFileSync(podfilePath, 'utf8');

      // Idempotency: already patched from a previous prebuild run.
      if (podfile.includes(ALREADY_PATCHED_MARKER)) {
        return config;
      }

      if (!podfile.includes(HERMES_ENABLED_DYNAMIC)) {
        // The generated Podfile has changed format — log a warning so it's
        // visible in prebuild output, then leave the file untouched rather
        // than making a blind replacement.
        console.warn(
          '[withIosJsc] WARNING: could not find the expected :hermes_enabled ' +
          'expression in ios/Podfile. The Podfile may have changed format. ' +
          'Manual inspection required to ensure hermes_enabled is false for iOS.'
        );
        return config;
      }

      podfile = podfile.replace(HERMES_ENABLED_DYNAMIC, HERMES_ENABLED_FALSE);

      fs.writeFileSync(podfilePath, podfile, 'utf8');

      return config;
    },
  ]);
};

module.exports = withIosJsc;
