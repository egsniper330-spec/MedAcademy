# Build Troubleshooting — Observed Failures & Prevention

> **Scope rule:** this file documents ONLY failures actually observed in this
> repository (during build recovery 2026-09-26/27 or confirmed project
> history). No generic guesses. Each entry: exact failure → root cause → fix →
> prevention, plus "what NOT to do".

---

## BP-1 · Config-plugin Groovy emission used a LIVE JS interpolation → next clean prebuild crashes

- **Date/context:** 2026-09-27, build-recovery audit of `plugins/`.
- **Platform:** Android (Expo prebuild).
- **Exact failure:** no current build failure — the successful `assembleRelease`
  used the already-generated `android/` folder. The bug was latent: any future
  `expo prebuild --clean` (including CI's `native-build-validation` Android
  job) would crash.
- **Root cause:** `plugins/withProductionSigning.js` emitted the Gradle line
  `buildConfigField "String", "EXPECTED_CERT_SHA256", "\<expectedCert.trim()\>"` from
  inside a **JS template literal**, so `${expectedCert.trim()}` was a **live JS
  interpolation**. `expectedCert` is a *Groovy* variable that only exists in
  the generated `build.gradle`; in JS scope it is undefined → the next prebuild
  throws `ReferenceError: expectedCert is not defined` and Android prebuild
  dies. The same line also emitted a 4-quote `API_SPKI_PINS` value where the
  proven-good generated file has 2 (harmless in Groovy, but proof the emission
  had drifted from ground truth).
- **How it was found:** ESLint `no-undef` on `plugins/` flagged `expectedCert`;
  byte-comparison against the generated (build-proven) `android/app/build.gradle`
  confirmed the emitted-output drift.
- **Correct fix:** rewrite both emission lines as **single-quoted JS strings**
  carrying the exact byte content of the generated ground truth (Groovy does
  its own `${...}` interpolation at Gradle configuration time). Verified by
  executing the emission array and diffing byte-for-byte against the file that
  produced `BUILD SUCCESSFUL`.
- **Files involved:** `plugins/withProductionSigning.js`.
- **What NOT to do:** do not "fix" a Gradle error by editing the generated
  `android/` folder — it is gitignored and regenerated. Emitted-Gradle text
  inside a config plugin must never sit in a JS backtick template when it
  contains Groovy `${...}`; use single quotes.
- **Prevention:** `tests/buildConfigGuards.test.cjs` guard **G1** scans every
  `plugins/*.js` for template-literal interpolations of identifiers not
  declared in JS (parameters/destructuring whitelisted). Mutation-tested:
  reintroducing the bug turns the suite red.

## BP-2 · `npm run lint` invoked a nonexistent binary → CI lint gate exit 127

- **Date/context:** 2026-09-27, CI `native-build-validation.yml` static job.
- **Platform:** CI (both `native-build-validation` and the lint step of iOS
  validation), and locally.
- **Exact failure:** `sh -e -c "npm run lint"` → exit **127** (command not
  found). `package.json` declared `"lint": "devkit-lint"`; no such package is
  installed (not in `node_modules/.bin`, not global).
- **Root cause:** lint script referenced a tool that was never added to the
  project. npm's `ELIFECYCLE 127` surfaced as a red X with no direct annotation.
- **Correct fix:** `"lint": "eslint ."` (real, installed, project-wide), plus
  making `eslint .` actually pass: flat-config overrides giving node globals to
  CommonJS tooling dirs (`tests/*.cjs`, `plugins/`, `metro-stubs/`,
  `backend/tests/`), `no-var` off for the vendored generated
  `babel-plugins/plugin-lucide-react-native.js`, `--fix` applied to the 79
  mechanical `no-var` errors in `metro-stubs/`, and 6 real
  `react/no-unescaped-entities` errors fixed in `src/` screens. Final state:
  `npm run lint` → **0 errors** (1010 pre-existing warnings remain, non-fatal).
- **Files involved:** `package.json`, `eslint.config.js`,
  `metro-stubs/*.js` (12 files, auto-fix), `plugins/withNativeUpload.js`
  (2 real `var` → `let`), plus the 6 `src/**` files with unescaped entities.
- **What NOT to do:** do not name a script after a tool you have not installed;
  do not weaken the lint gate to silence it — fix the script and the code.
- **Prevention:** guard **G3** pins that `scripts.lint` starts with a locally
  resolvable runner and uses eslint; guard **G2** keeps every metro stub
  parseable (the `--fix` sweep must never break them).

## BP-3 · `npm ci` hard-fails on npm 10: lockfile missing `@expo/metro-runtime`

- **Date/context:** 2026-09-27, iOS workflow runs 36271881235 / 36271881160.
- **Platform:** CI (GitHub Actions `ios-build.yml`, npm 10) — did NOT fail on
  local npm 11, which silently patches the tree.
- **Exact failure:** `npm ci` → `` `npm ci` can only install packages when your
  package.json and package-lock.json are in sync. Missing:
  @expo/metro-runtime@55.0.12 from lock file``.
- **Root cause:** `@expo/metro-runtime` was added to `package.json`
  (devDependencies) without regenerating `package-lock.json`; npm 11 tolerates
  it, npm 10 does not. Same root cause killed three consecutive workflow runs.
- **Correct fix:** run `npm install` with the local npm to write the lockfile
  entry, verify with **npm 10** (`npm exec --yes --package npm@10 -- npm ci
  --dry-run`) — the exact CI reproduction — before pushing.
- **Files involved:** `package-lock.json`.
- **What NOT to do:** never hand-edit the lockfile; never "fix" CI by switching
  the workflow to `npm install` (loses reproducibility); never switch to pnpm.
- **Prevention:** guard **G4** asserts every `package.json` dependency exists
  in `package-lock.json` (fast local approximation of npm 10's check).

## BP-4 · Host JVM OOM during `assembleRelease` (JVM crash, not a code failure)

- **Date/context:** 2026-09-26, first local release attempt (`hs_err_pid*.log`
  in `android/`, plus `.freebuff/android-build.log`).
- **Platform:** Android (local Windows build host, RAM-constrained).
- **Exact failure:** Gradle/JVM native crash during R8/minify —
  `OutOfMemoryError` / SIGSEGV in the daemon; no Kotlin or Gradle error at all.
- **Root cause:** build-host memory pressure (Metro dev server + browser
  running concurrently; R8 needs >2 GB heap on this dependency set).
- **Correct fix:** stop the dev server before release builds; keep the
  existing bounded JVM settings (`gradle.properties`:
  `-Xmx2560m -XX:MaxMetaspaceSize=512m -XX:+UseSerialGC`,
  `com.android.tools.r8.threadCount=2` — documented in
  `plugins/withProguardRules.js`). Result: `BUILD SUCCESSFUL in 40m 45s`.
- **Files involved:** none (operational; existing plugin already documents the
  mitigation).
- **What NOT to do:** do not raise `-Xmx` past the host commit limit; do not
  disable minification to dodge OOM (ships unobfuscated release dex).
- **Prevention:** none automated (host-specific); noted here so future agents
  stop the dev server first.

## BP-5 · Windows quirk: `gradlew.bat` unresolvable by cmd in the project cwd

- **Date/context:** 2026-09-26, launching Gradle detached from Git Bash.
- **Platform:** local Windows build host.
- **Exact failure:** `cmd /c gradlew.bat …` inside `android/` fails with
  "not recognized" even though the file exists —
  `NoDefaultCurrentDirectoryInExePath` behavior; Git Bash additionally mangles
  `cmd`'s `/d` flag and `pushd` doesn't propagate through the launcher chain.
- **Correct fix:** invoke the wrapper by **absolute path**:
  `cmd /c "D:\v3\android\gradlew.bat assembleRelease"` with the cd inside the
  cmd command string.
- **What NOT to do:** do not conclude the wrapper is missing; do not install a
  global gradle.
- **Prevention:** documented here; scripts should always use the absolute
  wrapper path on this machine.

## BP-6 · Generated `gradle.properties` accumulated 5 duplicate toolchain blocks

- **Date/context:** 2026-09-26, pre-release inspection of `android/gradle.properties`.
- **Platform:** Android (generated folder).
- **Exact failure:** `react.internal.disableJavaVersionAlignment`,
  `org.gradle.java.installations.auto-provisioning=false`,
  `org.gradle.daemon=false` appeared **five times** — harmless to Gradle (last
  wins) but evidence that an earlier plugin version appended without an
  idempotency guard.
- **Root cause:** append-only property injection in a previous
  `withGradleWrapper` revision (the current version guards on content).
- **Correct fix:** current plugin hardened further: it now **dedupes** on every
  prebuild (keeps the first block, strips later re-appended blocks) so the
  generated file converges regardless of history. Verified by simulation
  (`.freebuff/test-plugin-repairs.cjs`): 5 duplicated blocks → exactly 1,
  unrelated properties preserved.
- **Files involved:** `plugins/withGradleWrapper.js`.
- **What NOT to do:** do not edit `android/gradle.properties` by hand to remove
  duplicates — prebuild regenerates it; fix the plugin.
- **Prevention:** simulation test in this repo's `.freebuff` tooling; guard
  **G1**-style content checks run over `plugins/` in
  `tests/buildConfigGuards.test.cjs`.

---

## Regression-class summary (for future agents)

| Class | Signal | First response |
|---|---|---|
| Plugin emits broken Groovy / crashes prebuild | eslint `no-undef` in `plugins/`, or byte-drift vs generated file | Fix emission to single-quoted exact bytes; run guard G1 |
| CI fails where local npm works | npm-version-sensitive step (`npm ci`) | Reproduce with `npm exec --package npm@10 -- npm ci --dry-run` |
| Exit 127 in CI script step | script names an uninstalled binary | Guard G3; keep lint real |
| JVM/native crash mid-build (no code error) | `hs_err_pid*.log`, OOM in R8 | Free host RAM; keep bounded JVM props; never disable minify |
| Missing native libraries after prebuild changes | runtime class-not-found / dex gaps | NEVER replace RN's default native build config with custom CMake — historical regression, do not repeat |

## Guard suite

Run `node tests/buildConfigGuards.test.cjs` — covers G1 (emission
interpolations), G2 (stub validity), G3 (lint real), G4 (lockfile sync). It
must stay green in every commit that touches `plugins/`, `metro-stubs/`,
`package.json`, or `eslint.config.js`.
