// CommonJS — Expo config plugin (no ESM, no TypeScript).
// plugins/ is excluded from oxlint via .eslintignore.
//
// withGradleWrapper — forces gradle-wrapper.properties to use Gradle 8.13
// after every expo prebuild run.
//
// WHY THIS IS NEEDED:
//   Expo SDK 55 / React Native 0.83 ships with Gradle 9.0.0 in its template.
//   foojay-resolver-convention v0.8.0 (pulled in by the RN Gradle plugin's
//   settings.gradle includeBuild) references JvmVendorSpec.IBM_SEMERU which
//   was REMOVED from Gradle 9.0.0's public API, causing:
//
//     NoSuchFieldError: IBM_SEMERU
//     at org.gradle.toolchains.foojay.DistributionsKt...
//
//   This crash happens at project configuration time — before any compilation —
//   which is why CI builds fail instantly with "Packaging failed".
//
//   Gradle 8.13 is fully compatible with foojay 0.8.0 and with all other
//   plugins used by this project. This plugin pins the wrapper so prebuild
//   can never silently reset it back to 9.0.0.
//
// APPROACH:
//   Use withDangerousMod (file-system mod) to directly overwrite
//   android/gradle/wrapper/gradle-wrapper.properties after the normal
//   prebuild mods have run (finalize phase).

const path = require('path');
const fs   = require('fs');

const GRADLE_VERSION = '8.13';

const WRAPPER_CONTENT = [
  'distributionBase=GRADLE_USER_HOME',
  'distributionPath=wrapper/dists',
  `distributionUrl=https\\://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip`,
  'networkTimeout=10000',
  'validateDistributionUrl=true',
  'zipStoreBase=GRADLE_USER_HOME',
  'zipStorePath=wrapper/dists',
  '',
].join('\n');

// Properties to append to gradle.properties after every prebuild.
// These prevent Gradle / RNGP from trying to download a JDK at build time:
//
//   react.internal.disableJavaVersionAlignment — tells JdkConfiguratorUtils.kt
//     to skip calling kotlinExtension.jvmToolchain(17) on every Kotlin subproject.
//     Without this, Gradle's Foojay Disco provisioner tries to download JDK 17
//     over the network, timing out on restricted CI build servers.
//
//   org.gradle.java.installations.auto-provisioning=false — belt-and-suspenders:
//     prevents Gradle itself from auto-provisioning a JDK even if some other
//     toolchain spec slips through.
//
//   org.gradle.daemon=false — CI builds run in ephemeral containers; the
//     Gradle daemon provides no speedup there and can cause stale-process issues.
const GRADLE_PROPS_ADDITIONS = [
  '',
  '# Disable RN JVM toolchain alignment to prevent Foojay JDK download on build servers.',
  'react.internal.disableJavaVersionAlignment=true',
  '# Disable Gradle auto-provisioning as belt-and-suspenders.',
  'org.gradle.java.installations.auto-provisioning=false',
  '# Disable Gradle daemon for ephemeral CI containers.',
  'org.gradle.daemon=false',
].join('\n');

// VdoCipher Maven repo line to inject into android/build.gradle allprojects.repositories.
// expo-build-properties extraMavenRepos does NOT reliably inject into the root
// build.gradle allprojects block (only into the app subproject). We add it here
// via a direct file patch so EAS can resolve vdocipher-rn-bridge artifacts.
const VDOCIPHER_MAVEN_LINE =
  "    // VdoCipher SDK — required for vdocipher-rn-bridge\n" +
  "    maven { url 'https://github.com/VdoCipher/maven-repo/raw/master/repo' }";

const withGradleWrapper = (config) => {
  // Resolve withDangerousMod from expo's own package tree so we always get the
  // SDK-55-compatible version (55.x), not any unrelated top-level project dep.
  const expoRoot = path.dirname(require.resolve('expo/package.json'));
  const { withDangerousMod } = require(
    require.resolve('@expo/config-plugins', { paths: [expoRoot] })
  );

  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const projectRoot = cfg.modRequest.platformProjectRoot;

      // ── 1. Pin gradle-wrapper.properties to Gradle 8.13 ─────────────────────
      const wrapperDir = path.join(projectRoot, 'gradle', 'wrapper');
      const wrapperFile = path.join(wrapperDir, 'gradle-wrapper.properties');
      if (!fs.existsSync(wrapperDir)) {
        fs.mkdirSync(wrapperDir, { recursive: true });
      }
      fs.writeFileSync(wrapperFile, WRAPPER_CONTENT, 'utf8');
      console.log(
        `[withGradleWrapper] Pinned gradle-wrapper.properties to Gradle ${GRADLE_VERSION}`
      );

      // ── 2. Inject toolchain-disable properties into gradle.properties ────────
      const gradlePropsFile = path.join(projectRoot, 'gradle.properties');
      if (fs.existsSync(gradlePropsFile)) {
        let contents = fs.readFileSync(gradlePropsFile, 'utf8');
        // Idempotent: only append if not already present
        if (!contents.includes('react.internal.disableJavaVersionAlignment')) {
          contents += GRADLE_PROPS_ADDITIONS;
          fs.writeFileSync(gradlePropsFile, contents, 'utf8');
          console.log(
            '[withGradleWrapper] Injected disableJavaVersionAlignment + auto-provisioning=false into gradle.properties'
          );
        }
      }

      // ── 3. Inject VdoCipher Maven repo into root build.gradle ───────────────
      // expo-build-properties extraMavenRepos targets only the app subproject
      // repositories block, not the root allprojects block. VdoCipher's AAR is
      // resolved from the root block, so we patch it here.
      const buildGradleFile = path.join(projectRoot, 'build.gradle');
      if (fs.existsSync(buildGradleFile)) {
        let contents = fs.readFileSync(buildGradleFile, 'utf8');
        // Idempotent: only inject if not already present
        if (!contents.includes('VdoCipher/maven-repo')) {
          // Insert after the last maven { } line inside allprojects.repositories
          // The marker is 'maven { url \'https://www.jitpack.io\' }' which is
          // always present in the RN template allprojects block.
          contents = contents.replace(
            /(maven \{ url 'https:\/\/www\.jitpack\.io' \})/,
            `$1\n${VDOCIPHER_MAVEN_LINE}`
          );
          fs.writeFileSync(buildGradleFile, contents, 'utf8');
          console.log('[withGradleWrapper] Injected VdoCipher Maven repo into build.gradle');
        }
      }

      return cfg;
    },
  ]);
};

module.exports = withGradleWrapper;
