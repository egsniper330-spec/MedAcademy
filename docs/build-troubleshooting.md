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

---

## BP-7 · VdoCipher offline: Android renderer error + iOS "Tracks Not Found" — investigation record (2026-09-27)

- **Platform:** Android + iOS (offline DRM downloads/playback)
- **Observed failure:** Android — download shows complete, playback fails with
  "The DRM player could not play this download. renderer error". iOS —
  download fails at the options step with "Tracks Not Found".
- **Investigation (all verified against source + official docs, no guessing):**

  1. **"renderer error" = VdoCipher error 6120** (official error-code table:
     "Renderer Error ... make sure you are not loading more than one
     VdoPlayer instance at any given time, as that would make this error much
     more common"). Related documented codes: 6102 ("Internal Database Error —
     can occur for offline videos if the download is not yet complete or it
     failed. You can only load videos which completed successfully"), 6101/
     6122 (secure-decoder), 6157-class (Widevine CDM state), 6187 (rental
     keys expired). The app previously displayed the raw message only — no
     code capture, no reconciliation of local 'completed' state against the
     SDK registry, so a non-completed download could reach the player.

  2. **"Tracks Not Found" is emitted by the official iOS bridge itself**
     (`vdocipher-rn-bridge/ios/VdoDownload.swift` → `getDownloadOptions`:
     `if qualities.count == 0 { errorCallback("Tracks Not Found") }`). It
     means `VdoAsset.getVideoQualities()` returned zero renditions — an
     account/media-level condition (FairPlay/offline not enabled for the
     account, media still processing, or no downloadable renditions for the
     player profile). It is NOT a client track-filtering bug: our selection
     logic already follows the official rule (Android = 1 video + 1 audio,
     iOS = video only) and the iOS enqueue path uses `selections.first` →
     `asset.startDownload(...)` exactly as the bridge expects.

  3. **Media3 compatibility verified, not assumed:** VdoCipher Android SDK
     1.29.9's Maven POM requires `androidx.media3:*:1.8.0` (runtime scope);
     expo-video pins exactly `androidxMedia3Version = "1.8.0"`. The Gradle
     graph is aligned — do NOT upgrade/downgrade Media3 in this project.

  4. **Backend offline OTP verified correct** per
     docs/server/playbackauth/offline: `licenseRules` is a serialized JSON
     STRING (`json_encode([canPersist => true, rentalDuration => h*3600])`),
     90-day default, operator-configurable via `security_config.extras.
     offline_rental_hours`. NEVER turn `licenseRules` into a nested JSON
     object — the license server requires the string form.

- **Fixes applied:**
  - `src/lib/offlineVideoService.ts`: sanitized diagnostics (`[offline-dl]`
    mediaId/track inventory/selected indices — never otp/playbackInfo/secret),
    optional official `customPlayerId` passthrough (`buildOfflineOptionParams`),
    and `reconcileOfflineMediaState()` — authoritative SDK-registry check that
    reconciles/removes local 'completed' rows the SDK contradicts.
  - `src/components/OfflineVideoPlayer.native.tsx`: playback-time completion
    guard (refuses to mount a doomed DRM load on a non-completed download),
    exact error-code capture + classification (6187/6102/6120/CDM classes) →
    honest per-class messages, single VdoPlayerView instance pinned by test.
  - `backend/src/Video/VdoCipherService.php`: optional `VDO_CUSTOM_PLAYER_ID`
    env passthrough in the offline-authorize response (empty = unchanged
    behavior; account default player).
  - Guards: `tests/offlinePipeline.test.cjs` (37 assertions: track edges,
    error classification, diagnostics hygiene, OTP contract, reconciliation,
    single-instance + Media3 pin) + updated `tests/offlineState.test.cjs`.

- **What NOT to do:**
  - Do not "fix" renderer errors by catching and rewording only — capture the
    code, reconcile with the SDK registry, and surface the documented cause.
  - Do not add a second VdoPlayerView (Modal fullscreen twin) to the offline
    player — multi-instance is the documented 6120 amplifier.
  - Do not select audio tracks on iOS (the bridge uses `selections.first` as
    the video quality) or invent tracks when the SDK returns none.
  - Do not bump Media3 independently of `com.vdocipher.aegis:vdocipher-android`
    — match the SDK POM (1.8.0 as of 1.29.9).
  - Do not log otp/playbackInfo/API secret in diagnostics — mediaId, counts,
    bitrates, indices, and sanitized messages only.

- **Account/dashboard items that CANNOT be verified or fixed from code**
  (must be confirmed in the VdoCipher dashboard by the operator):
  - iOS FairPlay offline configured for the account (prerequisite for all iOS
    offline downloads — its absence reproduces "Tracks Not Found" exactly).
  - The specific media has completed processing and has downloadable
    renditions.
  - `VDO_CUSTOM_PLAYER_ID` set on the backend IF VdoCipher support provides a
    player profile required for offline renditions (otherwise leave empty).

- **Prevention:** the guard suite fails CI on regressions of every contract
  above (run `node tests/offlinePipeline.test.cjs`).

---

## Regression-class summary (for future agents)

| Class | Signal | First response |
|---|---|---|
| Plugin emits broken Groovy / crashes prebuild | eslint `no-undef` in `plugins/`, or byte-drift vs generated file | Fix emission to single-quoted exact bytes; run guard G1 |
| CI fails where local npm works | npm-version-sensitive step (`npm ci`) | Reproduce with `npm exec --package npm@10 -- npm ci --dry-run` |
| Exit 127 in CI script step | script names an uninstalled binary | Guard G3; keep lint real |
| JVM/native crash mid-build (no code error) | `hs_err_pid*.log`, OOM in R8 | Free host RAM; keep bounded JVM props; never disable minify |
| Missing native libraries after prebuild changes | runtime class-not-found / dex gaps | NEVER replace RN's default native build config with custom CMake — historical regression, do not repeat |

## API contract mismatch: screen crashes with `.map is not a function`

**Case study: Security Dashboard (2026-09) — `riskyDevices.map is not a function`.**
The Supabase-era RPC `get_risky_devices` was migrated to
`GET /analytics/risky-devices`, but the PHP port returned
`{ devices: [{ id, device_name, last_active_at, ... }] }` while the screen
expected the original contract `RiskyDevice[]` with fields
(`device_id, user_name, user_email, max_risk_score, event_types, last_seen`).
The object wrapper was stored as array state → crash on open.

**Why the project allowed it:** the RPC-bridge (`src/client/php.ts`) maps RPC
names to REST routes and returns whatever the route handler returns — there is
no shape validation at the boundary, and screens blind-cast `res.data as T`.
Any field/wrapper drift between a Supabase function and its PHP port compiles
clean and crashes at runtime.

**Prevention:**
- When porting a Supabase RPC to PHP, copy the ORIGINAL function's return
  shape (column aliases included) — do not invent a new shape.
- At the UI boundary, unwrap documented envelopes explicitly and guard with
  `Array.isArray` / object checks that THROW (never silently coerce to `[]`).
  A failed call must surface as an error banner, never as a fake empty state.
- Pin both sides with a contract test (see `tests/securityDashboardContract.test.cjs`).
- Grep for other consumers of the same RPC before changing either side.

Related, same class: `get_security_stats` had the same drift (no window
params, no per-category counters); fixed together with risky-devices in
`AnalyticsController` (2026-09).

## Guard suite

Run `node tests/buildConfigGuards.test.cjs` — covers G1 (emission
interpolations), G2 (stub validity), G3 (lint real), G4 (lockfile sync). It
must stay green in every commit that touches `plugins/`, `metro-stubs/`,
`package.json`, or `eslint.config.js`.

## Video fullscreen must never mount a second player surface (2026-09)

**Class:** architecture regression — fullscreen "implemented" as a second
player instance inside a React Native `<Modal>` (a second native window).
On rotation the modal window's surface is torn down/recreated around a live
decoder session while the duplicate instance re-initialises DRM → black
video with live audio. It also duplicated the watermark surface and (on iOS)
fought over the bridge's shared player view-controller.

**Rule:** fullscreen = layout, never a new surface. ONE player instance whose
container toggles inline ↔ absolute-fill (`style={isFullscreen ? FS : INLINE}`).
Never put the player JSX behind `{isFullscreen && …}` or `key={…isFullscreen…}`.
For a web player (Plyr), the single WebView's container toggles the same way.
When a host screen's fullscreen expansion must cover the whole screen, the
player must be a DIRECT child of the screen root ("pinned-player" layout,
see `src/app/(app)/lesson/[id].tsx`), not a child of a ScrollView — an
absolute-fill inside a ScrollView only covers the scroll content box.

**Watermark:** the server-side VdoCipher `annotate` option (the
`"User\nID: MED-####"` burned into the stream) was removed from
`VdoCipherService` — the client overlay `Name • MED-####` from
`watermarkIdentity.resolveWatermarkIdentity` is the single watermark across
online/offline Vdo and Plyr. Do not reintroduce an annotate payload in any
OTP; do not add a second client overlay.

**Guard suite:** `node tests/fullscreenArchitecture.test.cjs` — pins single
mounts (no `<Modal>`, one `<VdoPlayerView>`/`<WebView>`/`<VideoPlayer>`), no
mount-time conditionals/keys on fullscreen state, in-place container toggles,
pinned-player lesson layout, annotate removal, canonical label, and the
rotation-survival manifest `configChanges`. Must stay green for every change
to `VdoCipherPlayer*`, `OfflineVideoPlayer*`, `YouTubePlayer`, the lesson
screen, or `VdoCipherService.php`.
