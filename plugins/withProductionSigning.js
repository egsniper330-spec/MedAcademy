// CommonJS — Expo config plugin: production release signing + integrity pin.
//
// Purpose
// ───────
// /android is a generated (gitignored) folder. This plugin re-applies the
// production signing configuration on every prebuild so the configuration can
// never silently regress to `signingConfig signingConfigs.debug`.
//
// What it does
//   1. Adds a fail-closed `release` signingConfig reading credentials from
//      LOCAL-ONLY sources (never committed to Git):
//        - android/gradle.properties.local      (machine-local, gitignored)
//        - ~/.medacademy/signing.properties     (machine-wide override)
//        - MEDA_UPLOAD_* environment variables  (CI)
//   2. Points buildTypes.release at the production config. Release builds FAIL
//      when no production keystore is configured — never fall back to debug.
//   3. Injects the production cert SHA-256 into release BuildConfig as
//      EXPECTED_CERT_SHA256 (public material) so SecurityModule verifies the
//      runtime signing cert against the expected production fingerprint.
//      Resolution: gradle property expectedCertSha256 / MEDA_EXPECTED_CERT_SHA256
//      env / android/expected-cert-sha256.local (written by
//      scripts/set-production-cert-sha256.mjs, gitignored).
//
// The current android/app/build.gradle has been patched to match this plugin's
// output (see docs/PRODUCTION_SIGNING_SETUP.md).
const fs   = require('fs');
const path = require('path');
// Resolve @expo/config-plugins from expo's own package tree (pnpm-safe — same
// pattern as plugins/withProguardRules.js).
const expoRoot = path.dirname(require.resolve('expo/package.json'));
const { withAppBuildGradle } = require(
  require.resolve('@expo/config-plugins', { paths: [expoRoot] })
);

function withProductionSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let c = cfg.modResults.contents;

    // ── 1+2: fail-closed release signingConfig ─────────────────────────────
    if (!c.includes('signingConfigs.release')) {
      const oldSigning = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;
      const newSigning = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        // ── MedAcademy PRODUCTION signing identity (stable — never regenerate) ──
        // Credentials come from LOCAL ONLY sources (never committed to Git):
        //   1. android/gradle.properties.local      (untracked, machine-local)
        //   2. ~/.medacademy/signing.properties     (shared machine-wide override)
        //   3. Environment variables (MEDA_UPLOAD_STORE_FILE etc., CI)
        // Fail-closed: if no production keystore is configured, release builds
        // FAIL rather than silently falling back to the debug keystore.
        release {
            // Local credential loader — gradle does NOT auto-read *.local files.
            // Priority: repo-local gradle.properties.local →
            //           ~/.medacademy/signing.properties → gradle property → env.
            // Values are NEVER committed; the keystore lives outside the repo.
            def signingProps = new Properties()
            ['gradle.properties.local', System.getProperty('user.home') + '/.medacademy/signing.properties'].each { candidate ->
                def f = new File(candidate)
                if (f.exists()) {
                    f.withInputStream { signingProps.load(it) }
                }
            }
            def cred = { String key ->
                (signingProps.getProperty(key) ?: findProperty(key) ?: System.getenv(key) ?: '').toString()
            }
            def releaseStoreFile     = cred('MEDA_UPLOAD_STORE_FILE')
            def releaseStorePassword = cred('MEDA_UPLOAD_STORE_PASSWORD')
            def releaseKeyAlias      = cred('MEDA_UPLOAD_KEY_ALIAS')
            def releaseKeyPassword   = cred('MEDA_UPLOAD_KEY_PASSWORD')
            storeFile     releaseStoreFile     != '' ? file(releaseStoreFile) : null
            storePassword releaseStorePassword
            keyAlias      releaseKeyAlias
            keyPassword   releaseKeyPassword
        }
    }`;
      if (c.includes(oldSigning)) {
        c = c.replace(oldSigning, newSigning);
      }

      // Point release at the production config (idempotent).
      c = c.replace(
        /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/s,
        '$1signingConfig signingConfigs.release',
      );
    }

    // ── 3: EXPECTED_CERT_SHA256 into defaultConfig BuildConfig ─────────────
    // Regression guard: this field historically existed only in a HAND-EDITED
    // build.gradle, so a fresh `expo prebuild --clean` (regenerated android/)
    // silently dropped it — and SecurityModule.checkSignatureValid() then skipped
    // signature verification entirely (empty expectedCertSha256() → return true).
    // It goes into defaultConfig (NOT the release buildType) because the Kotlin
    // reader uses a DIRECT static reference (com.medacademy.app.BuildConfig
    // .EXPECTED_CERT_SHA256), which must compile in debug builds too.
    if (!c.includes('EXPECTED_CERT_SHA256')) {
      const anchor = `buildConfigField "String", "REACT_NATIVE_RELEASE_LEVEL"`;
      const injection = [
        `        // ── Integrity bootstrap pin (public material, safe to embed) ──────────`,
        `        // SHA-256 of the PRODUCTION signing cert, read at Gradle-configuration`,
        `        // time. SecurityModule.expectedCertSha256() reads it via a DIRECT static`,
        `        // reference (R8-safe; the older reflective read let R8 prune the field`,
        `        // and silently disabled signature verification). Empty on dev machines`,
        `        // without the pin. Resolution order: gradle property expectedCertSha256 /`,
        `        // MEDA_EXPECTED_CERT_SHA256 env / android/app/expected-cert-sha256.local`,
        `        // (written by scripts/set-production-cert-sha256.mjs, gitignored).`,
        `        def expectedCert = (findProperty('expectedCertSha256') ?: System.getenv('MEDA_EXPECTED_CERT_SHA256') ?: '').toString()`,
        `        if (expectedCert == '') {`,
        `            def certFile = rootProject.file('app/expected-cert-sha256.local')`,
        `            if (certFile.exists()) {`,
        `                expectedCert = certFile.text.trim()`,
        `            }`,
        `        }`,
        `        buildConfigField "String", "EXPECTED_CERT_SHA256", "\\"${expectedCert.trim()}\\"`,
        `        buildConfigField "String", "API_SPKI_PINS", "\\"\\"\\"\"\\"`,
      ].join('\n');
      if (c.includes(anchor)) {
        c = c.replace(anchor, anchor + '\n' + injection);
      } else {
        // Fail loudly rather than silently shipping without the integrity pin.
        throw new Error(
          '[withProductionSigning] cannot inject EXPECTED_CERT_SHA256: the REACT_NATIVE_RELEASE_LEVEL buildConfigField anchor is missing from android/app/build.gradle. The build.gradle template changed — update plugins/withProductionSigning.js anchors.',
        );
      }
    }

    cfg.modResults.contents = c;
    return cfg;
  });
}

module.exports = withProductionSigning;
