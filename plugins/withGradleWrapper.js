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

// ── gradle.properties: canonical managed keys (docs/build-troubleshooting.md BP-6/BP-8) ──
//
// The toolchain properties below stay as they were (they stop RNGP/Foojay
// from downloading a JDK at build time):
//
//   react.internal.disableJavaVersionAlignment — tells JdkConfiguratorUtils.kt
//     to skip calling kotlinExtension.jvmToolchain(17) on every Kotlin subproject.
//   org.gradle.java.installations.auto-provisioning=false — belt-and-suspenders
//     against Gradle auto-provisioning a JDK if a toolchain spec slips through.
//
// The daemon key is now MANAGED, not append-only (BP-6/BP-8): the historical
// block was re-appended on every prebuild (observed: org.gradle.daemon=false
// ×8) and daemon=false forced every build to fork its own single-use ~2 GB
// JVM. On the 7.6 GB dev machine, two overlapping builds (CI-agent script +
// user build) exhausted physical RAM and crashed the daemon with native
// malloc failures (all 8 hs_err_pid*.log files share that signature).
//
// Contract: every prebuild NORMALIZES gradle.properties — all copies of the
// managed keys and their comments are stripped, then exactly one canonical
// block is appended. Locally the daemon is ENABLED (one reused JVM serializes
// concurrent builds and frees its memory when idle); in CI (env CI or
// EAS_BUILD) it stays disabled for ephemeral containers.
const GRADLE_JVMARGS_LINE =
  // Conservative heap for a low-memory host: covers this project's R8/AGP peak
  // Java heap with SerialGC's small native overhead while leaving RAM for the
  // Kotlin daemon, Node.js (Metro bundling) and the OS. Never set Xmx above
  // ~half of physical RAM on such machines (BP-8).
  'org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m -XX:+UseSerialGC';

const C_TOOLCHAIN =
  '# Disable RN JVM toolchain alignment to prevent Foojay JDK download on build servers.';
const C_AUTOPROVISION =
  '# Disable Gradle auto-provisioning as belt-and-suspenders.';
const C_DAEMON_CI =
  '# Disable Gradle daemon for ephemeral CI containers.';
const C_DAEMON_ON_A =
  '# Gradle daemon ON locally: overlapping builds (agent + user) must share ONE JVM.';
const C_DAEMON_ON_B =
  '# BP-8: dual ~2 GB single-use JVMs exhausted this 7.6 GB machine (native-OOM JVM crashes).';
const C_DAEMON_ON_C =
  '# The reused daemon serializes concurrent builds and releases memory when idle.';

// Comment lines owned by this manager: stripped if present (any number of
// copies, including older wordings) and re-emitted in the canonical block.
const GRADLE_MANAGED_COMMENTS = [
  C_TOOLCHAIN,
  C_AUTOPROVISION,
  C_DAEMON_CI,
  C_DAEMON_ON_A,
  C_DAEMON_ON_B,
  C_DAEMON_ON_C,
];

const GRADLE_MANAGED_KEYS = [
  'react.internal.disableJavaVersionAlignment',
  'org.gradle.java.installations.auto-provisioning',
  'org.gradle.daemon',
  'org.gradle.daemon.idletimeout',
  'org.gradle.jvmargs',
];

const buildGradleDaemonBlock = () => {
  const isCI =
    process.env.CI === 'true' || process.env.CI === '1' || !!process.env.EAS_BUILD;
  const lines = [
    '',
    C_TOOLCHAIN,
    'react.internal.disableJavaVersionAlignment=true',
    C_AUTOPROVISION,
    'org.gradle.java.installations.auto-provisioning=false',
  ];
  if (isCI) {
    lines.push(C_DAEMON_CI, 'org.gradle.daemon=false');
  } else {
    lines.push(
      C_DAEMON_ON_A,
      C_DAEMON_ON_B,
      C_DAEMON_ON_C,
      'org.gradle.daemon=true',
      'org.gradle.daemon.idletimeout=1800'
    );
  }
  return lines.join('\n');
};

// Deterministic normalizer (pure string function, unit-testable): strip all
// managed keys/comments, then append the single canonical jvmargs + block.
const normalizeGradleProperties = (contents) => {
  const isManagedProp = (t) =>
    GRADLE_MANAGED_KEYS.some((k) => t === k || t.startsWith(k + '='));
  const isManagedComment = (t) => GRADLE_MANAGED_COMMENTS.indexOf(t) !== -1;

  const kept = [];
  for (const raw of String(contents).split(/\r?\n/)) {
    const t = raw.trim();
    if (isManagedProp(t) || isManagedComment(t)) continue;
    kept.push(raw);
  }
  // Collapse consecutive blanks left behind by stripped blocks, then drop
  // trailing blanks BEFORE appending the canonical block — otherwise each run
  // would accumulate one more blank line before it (not idempotent).
  const cleaned = [];
  for (const line of kept) {
    if (line.trim() === '' && cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
      continue;
    }
    cleaned.push(line);
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') cleaned.pop();

  cleaned.push(GRADLE_JVMARGS_LINE, buildGradleDaemonBlock());
  return cleaned.join('\n') + '\n';
};

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

      // ── 2. Normalize managed keys in gradle.properties (one canonical block) ──
      // BP-8: append-only injection re-appended org.gradle.daemon=false on every
      // prebuild (observed ×8) and forced each build to fork its own single-use
      // ~2 GB JVM; two overlapping builds then exhausted physical RAM on the
      // 7.6 GB dev machine and crashed the daemon (native-OOM JVM crashes,
      // e.g. hs_err_pid14468.log). The normalizer below is idempotent and
      // environment-aware (CI keeps daemon=false, local runs get the daemon).
      const gradlePropsFile = path.join(projectRoot, 'gradle.properties');
      if (fs.existsSync(gradlePropsFile)) {
        const before = fs.readFileSync(gradlePropsFile, 'utf8');
        const after = normalizeGradleProperties(before);
        if (after !== before) {
          fs.writeFileSync(gradlePropsFile, after, 'utf8');
          console.log(
            '[withGradleWrapper] Normalized gradle.properties (single canonical jvmargs/toolchain/daemon block)'
          );
        }
      } else {
        fs.writeFileSync(
          gradlePropsFile,
          GRADLE_JVMARGS_LINE + '\n' + buildGradleDaemonBlock() + '\n',
          'utf8'
        );
        console.log('[withGradleWrapper] Created gradle.properties with canonical managed Gradle settings');
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

        // ── 4. JVM target alignment (idempotent) ────────────────────────────
        // gradle.properties sets react.internal.disableJavaVersionAlignment=true
        // so Gradle never downloads a Foojay toolchain on build servers. That
        // flag also disables React Native's own Java/Kotlin alignment, leaving
        // library subprojects compiling Java at 1.8 while Kotlin compiles at
        // 17 — Gradle then fails with "Inconsistent JVM-target compatibility
        // detected for tasks compileReleaseJavaWithJavac (1.8) and
        // compileReleaseKotlin (17)".
        //
        // Instead of forcing one fixed version on every module (which would
        // mismatch modules that deliberately use a different Java target),
        // align Kotlin to EACH subproject's actual Java target, evaluated
        // lazily when the task is configured. We deliberately avoid
        // afterEvaluate: appending this block at the end of the root script
        // (after expo-root-project / react.rootproject) means some subprojects
        // may already be evaluated by the time it runs, and afterEvaluate on
        // an evaluated project throws "Cannot run Project.afterEvaluate…
        // when the project is already evaluated". tasks.configureEach is a
        // live registration and is safe in any evaluation order.
        const JVM_ALIGN_MARKER = 'MedAcademy: JVM target alignment';
        if (!contents.includes(JVM_ALIGN_MARKER)) {
          const jvmBlock = [
            '',
            '// ' + JVM_ALIGN_MARKER + ' (injected by plugins/withGradleWrapper.js).',
            '// react.internal.disableJavaVersionAlignment=true (gradle.properties)',
            '// disables React Native\'s Java/Kotlin alignment to avoid toolchain',
            '// downloads, so library subprojects would otherwise compile Java at',
            '// 1.8 while Kotlin compiles at 17 (Gradle "Inconsistent JVM-target',
            '// compatibility" failure). Align Kotlin to each subproject\'s real',
            '// Java target instead. Registered lazily at task-configuration time,',
            '// so it is safe regardless of subproject evaluation order.',
            'subprojects { proj ->',
            '  proj.tasks.configureEach { t ->',
            '    if (t instanceof org.jetbrains.kotlin.gradle.tasks.KotlinCompile) {',
            '      try {',
            "        def androidExt = t.project.extensions.findByName('android')",
            '        if (androidExt != null) {',
            "          def compat = String.valueOf(androidExt.compileOptions.sourceCompatibility)",
            "          t.compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.valueOf('JVM_' + compat.replace('.', '_')))",
            '        }',
            '      } catch (Throwable e) {',
            "        println('[jvm-align] WARNING: ' + proj.path + ' ' + t.name + ': ' + e.message)",
            '      }',
            '    }',
            '  }',
            '}',
            '',
          ].join('\n');
          fs.writeFileSync(buildGradleFile, contents + jvmBlock, 'utf8');
          console.log('[withGradleWrapper] Injected JVM target alignment into build.gradle');
        }
      }

      return cfg;
    },
  ]);
};

module.exports = withGradleWrapper;
// Exported for unit tests / offline normalization (see .freebuff/test-plugin-repairs.cjs):
module.exports.normalizeGradleProperties = normalizeGradleProperties;
module.exports.buildGradleDaemonBlock = buildGradleDaemonBlock;
module.exports.GRADLE_JVMARGS_LINE = GRADLE_JVMARGS_LINE;
