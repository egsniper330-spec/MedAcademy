# Android release build — repeatable Windows procedure

The canonical, supported way to build the Android app on this machine.
It exists because of **BP-8** in [`build-troubleshooting.md`](build-troubleshooting.md):
disabling the Gradle daemon made every build fork its own ~2 GB JVM, and two
overlapping builds exhausted the 7.6 GB machine and crashed the daemon
("Gradle build daemon disappeared unexpectedly", `hs_err_pid*.log`).

## Required toolchain (do not substitute)

| Tool | Version | Resolved from |
|---|---|---|
| JDK | **17.0.12** (Oracle) | `JAVA_HOME` if set, else PATH — the same install Gradle already resolves today. Optional hardening pin (user scope, one line in PowerShell): `[Environment]::SetEnvironmentVariable('JAVA_HOME','D:\Gradle','User')` |
| Gradle | **8.13** | `android/gradle/wrapper/gradle-wrapper.properties` — always invoke through `gradlew.bat` |
| Android Gradle Plugin | 8.13.0 | resolved by the RN gradle plugin classpath |
| Kotlin | 2.1.20 | resolved by the RN gradle plugin classpath |
| React Native / Expo | 0.83.10 / SDK 55 | `package.json` |
| Android SDK | compileSdk/targetSdk 36, minSdk 24 | `android/gradle.properties` |

Never run a globally installed `gradle` — only the wrapper. Never let Gradle
download a JDK (the generated properties disable auto-provisioning/toolchain
alignment on purpose).

## Build command

```powershell
cd D:\v3\android
.\gradlew.bat assembleRelease
```

**Required on this 7.6 GB machine:** `METRO_MAX_WORKERS=2` must be present in
the environment that starts Gradle (the daemon passes it to the bundler
node process). It is set once at **user scope** — open a NEW terminal after
setting it and verify with `echo $env:METRO_MAX_WORKERS` (PowerShell) —
with:

```powershell
[Environment]::SetEnvironmentVariable('METRO_MAX_WORKERS','2','User')
```

Without it, Metro defaults to ~6 transform workers (half the 8 logical
cpus) inside a single node process; on this machine that process dies with a
native V8 OOM (`Zone Allocation failed` / `Committing semi space failed`) and
`:app:createBundleReleaseJsAndAssets` fails with exit 134 / 0x80000003. The
cap is read by the project's own `metro.config.js` (opt-in block at the
bottom of that file) and only affects bundling parallelism, never output.

Output APK: `android\app\build\outputs\apk\release\app-release.apk`.

Release signing is applied by `plugins/withProductionSigning.js`
(keystore lives in `android/keystores/`, not in git).

## Memory-safety rules (this is a 7.6 GB machine)

1. **One Gradle build at a time.** Never start a second `gradlew`/Android
   Studio build while one is running. The managed `org.gradle.daemon=true`
   makes consecutive builds reuse one JVM; two *concurrent* builds are always
   unsafe here regardless of settings.
2. The daemon heap is pinned at `-Xmx2048m` (SerialGC) in the generated
   `gradle.properties`. Do not raise it: crashes on this machine were **native**
   memory exhaustion, and a bigger heap makes them more likely.
3. Close memory-heavy apps (browsers with many tabs, emulators, games) before
   a release build; keep ~4 GB RAM free.
4. The daemon exits after 30 min idle (`org.gradle.daemon.idletimeout=1800`)
   and frees its memory. `.\gradlew.bat --stop` frees it immediately.

## If a build fails

1. Read the real error in the console — the build never swallows failures.
2. If you see `Gradle build daemon disappeared unexpectedly` or a new
   `android\hs_err_pid*.log`: free RAM (close apps), confirm no second
   Gradle/Java build is running (`tasklist | findstr /i java`), retry once.
   If it recurs, open the new `hs_err_pid*.log` header (problematic frame,
   `Out of Memory` line) and add it to BP-8 in
   `docs/build-troubleshooting.md` — do not "fix" it by raising `-Xmx`.
3. Suspect stale outputs (R8/dex oddities)? `.\gradlew.bat clean assembleRelease`
   — a clean build takes noticeably longer and re-runs R8 resource shrinking.
4. After editing `android/` config by hand, remember the next `expo prebuild`
   **normalizes** `gradle.properties` (single canonical jvmargs/toolchain/
   daemon block) — that is intended; change the plugin, not the file.

## Why the agent build used to succeed while yours failed

The CI-agent helper script and your build each forked their own single-use
JVM (daemon off). When they overlapped, the second JVM hit an exhausted
machine and crashed — that build failed, the first "succeeded". With the
daemon enabled and builds serialized through it, an overlapping invocation
simply waits for the running daemon instead of doubling memory use.

## iOS

iOS builds are out of scope here (Xcode; do not patch generated `ios/` files
by hand — regenerate via prebuild/config plugins).
