// CommonJS — Expo config plugins are require()d by the prebuild pipeline.
// plugins/ is excluded from oxlint via .eslintignore.
//
// withIosJsc — iOS JSC configuration applied to the generated Podfile.
//
// PART 1: force hermes_enabled: false in the generated Podfile
// ─────────────────────────────────────────────────────────────
// The Expo-generated Podfile computes hermes_enabled dynamically:
//
//   use_react_native!(
//     :hermes_enabled => podfile_properties['expo.jsEngine'] == nil ||
//                        podfile_properties['expo.jsEngine'] == 'hermes',
//     ...
//   )
//
// This patch replaces the dynamic expression with the literal `false`, ensuring
// the :hermes_enabled argument passed into use_react_native!() is false.
//
// NOTE: In React Native 0.83.x, use_react_native!() ignores the :hermes_enabled
// parameter entirely (line 78 of react_native_pods.rb unconditionally sets a
// local `hermes_enabled = true`). The actual gate is the react_native_pods.rb
// patch applied in the GitHub Actions workflow step "Patch react_native_pods.rb
// for JSC support" (step 5a), which runs after expo prebuild and before pod
// install. This Podfile patch is retained as defence-in-depth: if a future RN
// version fixes the parameter-ignore bug, the generated Podfile is already
// correct.
//
// PART 2: register React-jsc as a local pod
// ──────────────────────────────────────────
// When USE_THIRD_PARTY_JSC=1 is set during `pod install`, React Native 0.83's
// jsengine.rb calls depend_on_js_engine(spec) for every pod that uses
// install_modules_dependencies() (e.g. RNGestureHandler, RNReanimated, etc.).
// depend_on_js_engine adds `s.dependency 'React-jsc'` to each such pod.
//
// CocoaPods resolves 'React-jsc' by looking for a podspec with that name.
// 'React-jsc' is NOT in the public CocoaPods spec repository — it is a LOCAL
// podspec shipped inside @react-native-community/javascriptcore:
//   node_modules/@react-native-community/javascriptcore/React-jsc.podspec
//
// Without an explicit `pod 'React-jsc', :path => ...` declaration in the
// Podfile, CocoaPods cannot find the specification and pod install fails with:
//   [!] Unable to find a specification for `React-jsc`
//       depended upon by `RNGestureHandler` (and other pods)
//
// This plugin injects the local pod declaration into the generated Podfile
// so CocoaPods resolves React-jsc correctly on every clean prebuild.
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
// Both replacements target exact generated strings. If already applied on a
// previous prebuild run, the file is left untouched.

const fs   = require('fs');
const path = require('path');

const expoRoot = path.dirname(require.resolve('expo/package.json'));
const { withDangerousMod } = require(
  require.resolve('@expo/config-plugins', { paths: [expoRoot] })
);

// ── Part 1: hermes_enabled patch ─────────────────────────────────────────────

// The exact expression Expo SDK 55 / RN 0.83 writes into the generated Podfile.
const HERMES_ENABLED_DYNAMIC =
  "podfile_properties['expo.jsEngine'] == nil || podfile_properties['expo.jsEngine'] == 'hermes'";

// The literal replacement: unconditionally false for iOS JSC.
const HERMES_ENABLED_FALSE = 'false';

// Idempotency marker for Part 1.
const ALREADY_PATCHED_HERMES = ':hermes_enabled => false';

// ── Part 2: React-jsc local pod declaration ──────────────────────────────────

// The anchor string in the generated Podfile — the newline + 2-space indent that
// Expo SDK 55 emits immediately before `use_react_native!(` inside the target block.
// We anchor on the full "\n  use_react_native!(" so we preserve the indentation
// of the surrounding code and insert the pod declaration as a properly-indented
// line inside the target block, NOT at Podfile root scope.
const USE_REACT_NATIVE_ANCHOR = '\n  use_react_native!(';

// The local pod declaration to inject, including the leading newline so it
// appears as a separate line before use_react_native!, indented to match the
// surrounding target block (2-space indent).
// Path is relative to ios/ (the CocoaPods installation root).
const REACT_JSC_INSERTION =
  "\n  pod 'React-jsc', :path => '../node_modules/@react-native-community/javascriptcore'";

// Idempotency marker for Part 2.
const ALREADY_HAS_REACT_JSC = "pod 'React-jsc'";

/**
 * withIosJsc
 *
 * Expo config plugin that post-processes the generated ios/Podfile during
 * `expo prebuild`:
 *   1. Sets `hermes_enabled: false` unconditionally (JSC, not Hermes).
 *   2. Injects `pod 'React-jsc', :path => ...` so CocoaPods can resolve the
 *      React-jsc dependency that RN 0.83 adds via install_modules_dependencies
 *      when USE_THIRD_PARTY_JSC=1 is set during pod install.
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
      let changed = false;

      // ── Part 1: hermes_enabled => false ────────────────────────────────────
      if (!podfile.includes(ALREADY_PATCHED_HERMES)) {
        if (!podfile.includes(HERMES_ENABLED_DYNAMIC)) {
          console.warn(
            '[withIosJsc] WARNING: could not find the expected :hermes_enabled ' +
            'expression in ios/Podfile. The Podfile may have changed format. ' +
            'Manual inspection required to ensure hermes_enabled is false for iOS.'
          );
        } else {
          podfile = podfile.replace(HERMES_ENABLED_DYNAMIC, HERMES_ENABLED_FALSE);
          changed = true;
          console.log('[withIosJsc] Patched :hermes_enabled => false in ios/Podfile.');
        }
      }

      // ── Part 2: pod 'React-jsc' local path declaration ─────────────────────
      if (!podfile.includes(ALREADY_HAS_REACT_JSC)) {
        // Find "\n  use_react_native!(" — the anchor with its leading newline+indent
        // exactly as Expo SDK 55 generates it inside the target block.
        const idx = podfile.indexOf(USE_REACT_NATIVE_ANCHOR);
        if (idx === -1) {
          console.warn(
            '[withIosJsc] WARNING: could not find `  use_react_native!(` in ' +
            'ios/Podfile. React-jsc pod declaration was NOT injected. ' +
            'pod install with USE_THIRD_PARTY_JSC=1 will fail.'
          );
        } else {
          // Insert REACT_JSC_INSERTION (starts with \n) right before the anchor
          // so it appears as:
          //   pod 'React-jsc', :path => '...'
          //   use_react_native!(
          // both correctly indented inside the target block.
          podfile =
            podfile.slice(0, idx) +
            REACT_JSC_INSERTION +
            podfile.slice(idx);
          changed = true;
          console.log('[withIosJsc] Injected React-jsc local pod declaration into ios/Podfile.');
        }
      }

      if (changed) {
        fs.writeFileSync(podfilePath, podfile, 'utf8');
      }

      return config;
    },
  ]);
};

module.exports = withIosJsc;
