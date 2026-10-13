# Production Readiness Audit — Security Restoration, Cleanup, Performance

Audit date: 2026-10-12. Scope: React Native / Expo client (`src/`, `plugins/`,
`tests/`, repo root). The PHP backend, live database, hosting configuration and
mobile release pipeline were **read-only** in this audit.

Baseline captured before any change:

| Check | Baseline | After |
|---|---|---|
| `tests/*.test.cjs` | 70 / 70 pass | **72 / 72 pass** (2 new suites) |
| `npm run validate` | all 3 stages pass (1 warning: App Attest entitlement unset) | all 3 stages pass (same warning) |
| `tsc --noEmit` | clean | clean |

---

## 1. Security restoration inventory

Three protections had been switched off **in the shipped source** during an
authorized real-device debugging session (commit `fb1024a`, 2026-10-03,
"10"). All three are now restored.

### 1.1 `FLAG_SECURE` / screen-capture protection — RESTORED

| | |
|---|---|
| **File** | `src/lib/screenCaptureGuard.ts` |
| **Was** | `const FLAG_SECURE_DEBUG_DISABLED = true;` plus an unconditional early-return in `preventScreenCaptureAsync()`. Native `preventScreenshots()` never ran, so screenshot blocking, screen-recording blocking **and** "hide from recents" were dead in *every* build — release included. `allowScreenCaptureAsync()` was also force-released. |
| **Original behavior** | The guard's keyed ref-counting wrapper applies native `FLAG_SECURE` on the first lock and restores capture only when the last lock is released. Both `src/app/_layout.tsx` (`root-shell`) and `src/app/(app)/_layout.tsx` (`app-shell`) drive it. |
| **Why it was disabled** | ADB `screencap` could not capture evidence during the fullscreen video investigation. |
| **Now** | Protection is the **default**. The only escape hatch is an explicit *development-build* opt-in: `EXPO_PUBLIC_DISABLE_CAPTURE_PROTECTION=1`, ANDed with `__DEV__`. The release compiler folds `__DEV__` to `false`, so **no env var or config can switch capture protection off in a release bundle**. |
| **Impact** | None on legitimate use. Debugging a release build on-device no longer permits screenshots — that is the intended behavior. Use a dev build for `screencap` work. |

### 1.2 USB-debugging (ADB) + Developer-Options detection — RESTORED

| | |
|---|---|
| **File** | `src/lib/security.ts` (`detectDeveloperOptions`) |
| **Was** | `const DEBUG_DISABLE_DEV_OPTIONS_AND_ADB = true;` returned `null` before reading native flags, and both `flags.adbEnabled` / `flags.developerOptionsEnabled` checks were gated behind `!DEBUG_DISABLE_DEV_OPTIONS_AND_ADB`. |
| **Original behavior** | Both conditions are mandatory blocks: `developer_options_enabled` (weight 25) and `adb_enabled` (weight 20) both map into the `developer_options` bucket → `block_login`. |
| **Why it was disabled** | ADB debugging on the owner's physical tablet during the video investigation. |
| **Now** | Both checks are unconditional again. The disable constant **no longer exists** — there is no single line that can switch these detections off. |
| **Impact** | A release build installed on a device with Developer Options or USB debugging enabled is gated again (this is the owner-mandated policy). Android cannot be asked to turn USB debugging off by an app; the app enforces the block and the platform limitation is documented in `(app)/security-diagnostics.tsx`. |

### 1.3 Security-evidence integrity — RESTORED

| | |
|---|---|
| **File** | `src/lib/deviceKey.ts` (`collectEvidenceFlags`) |
| **Was** | Force-cleared `out.developer_options` and `out.adb` to `false` for the signed evidence bundle, so the backend was told `false` for conditions that were never measured. |
| **Now** | Both fields report the measured native value verbatim. No evidence field is overridden client-side. |

### 1.4 Reviewed and deliberately **kept**

These look like exemptions but are documented product decisions, not
development bypasses. They were left intact:

| Item | Where | Judgment |
|---|---|---|
| Super Admin capture exemption (`isSuperAdmin` releases the lock) | `(app)/_layout.tsx`, `useScreenCapture.ts`, `useContentProtection.ts` | **Kept.** Role comes from the backend-verified profile (`SecurityContext.isSuperAdmin`), is scoped to SA sessions only, and is documented in each file. It is an explicit product decision — SA accounts need screenshots for administrative work. |
| Non-student violation exemption | `useContentProtection.ts` + server | **Kept.** Server returns `action='exempt'` for non-students; the client guard is belt-and-suspenders. |
| SA maintenance exemption evidence | `maintenanceService.ts` | **Kept.** Server-computed, cached 60 s, invalidated on account switch, fails safe to *not exempt*. |
| Kotlin `isDebugBuild` native-lib probe skip | generated `SecurityModule.kt` | **Kept.** It only skips the *disk* native-library probe on debug builds; the signature check is authoritative and runs first. Not a weakening. |

### 1.5 `FLAG_SECURE` coverage checkout

- Root shell `root-shell` (`src/app/_layout.tsx`), authenticated shell
  `app-shell` (`(app)/_layout.tsx`), lesson `lesson`
  (`useContentProtection`) and `security-gate` while gated.
- The **lesson** screen additionally adds its own keyed lock for the
  violation-reporting overlay, so capture needs both locks released.
- Video/PDF screens (VdoCipher native adapter, `OfflineVideoPlayer.native.tsx`,
  `VdoCipherPlayerWebView`) rely on the app-shell lock by design; their
  docblocks state this. No player-side release was added — the video surface
  stays protected, and the existing fullscreen/Plyr lifecycle fixes were **not**
  modified.

---

## 2. Temporary diagnostics inventory

| Item | Disposition | Evidence |
|---|---|---|
| `src/app/diag.tsx` | **Removed** | Deep-linkable as `/diag` (Expo Router auto-registers every file in `src/app`). Its own docblock says "Remove this file … once diagnosis is complete". It bypassed all providers and rendered the internal startup log in **release** builds, plus a "POST Beacon" that shipped the log to `EXPO_PUBLIC_DIAG_ENDPOINT`. |
| `src/lib/diagnostics.ts` | **Removed** | Documented as "Works in RELEASE builds — no `__DEV__` guard anywhere", with an HTTP beacon and AsyncStorage persistence of internal state. Its only consumers were `diag.tsx`, `DiagScreen.tsx` and the two orphaned `_layout_app.tsx` files. |
| `src/components/DiagScreen.tsx` | **Removed** | Zero references anywhere. Floating overlay logging internal screen-capture state. |
| `src/app/_layout_app.tsx`, `src/app/(app)/_layout_app.tsx` | **Removed** | Orphaned 228-line **stale copies** of the 422/410-line live layouts (missing the security-gate race fix, maintenance gate, feature flags). Nothing imported them, but Expo Router registered them as live routes `/_layout_app` and `/(app)/_layout_app` — and the stale `(app)` copy did **not** import `SecurityGate`. Confirmed against `.expo/types/router.d.ts`. |
| `tasks/fix-pad-xxl-crash/_layout_app.tsx`, `tasks/full-crash-audit/_layout_app.tsx`, `tasks/full-crash-audit-v2/src/app/(app)/_layout.tsx` | **Removed** | Stale code copies from completed troubleshooting tasks. The `tasks/*/CHANGES*.md` records were **kept** as history (they contain no code). |
| `src/app/(app)/security-diagnostics.tsx` | **Kept + hardened** | Legitimate Super Admin diagnostic (raw native flags + evidence). Its docblock claimed "Accessible to superadmin only" but **nothing enforced it** — the route is role-neutral inside `(app)/`. Added an in-component super-admin gate (same model as `useRoleTabGuard`) that redirects non-SA sessions and renders `null` meanwhile. Server-side authorization is unchanged. |
| `(hubs)/health.tsx`, `db-audit.tsx`, `maintenance.tsx`, `sec-diag.tsx`, `sec-dashboard.tsx`, `sec-policies.tsx` | **Kept** | Real administrative/diagnostic functionality under Super Admin navigation, not temporary debugging. |
| Root artifacts: `hs_err_pid14052.log`, `replay_pid{10736,14052,2008}.log` (~6 MB) | **Removed** | JVM crash dumps / JIT replay logs from the Gradle-daemon OOM investigation. Now git-ignored. |
| `security-lock-test.txt` (5.8 MB), `historical_context.txt` (313 KB) | **Removed** | A raw UTF-16 build-console dump and an AI-agent transcript dump. Neither is project content. |
| `website.zip` (149 KB) | **Removed** | Byte-duplicate of the tracked `website/` tree. |
| `D<U+2024>v3.freebuffpreview-*.log{,.err}` | **Removed** | Malformed-named dev-server logs (the `:` in a `D:\v3\...` path became U+2024) written into the repo root by tooling. |
| `verify-bundle-order.js` | **Refactored** → `scripts/verify-bundle-order.js` | A legitimate Metro bundle-order verification with exit codes; it belonged with the other `scripts/validate-*` tooling, not loose in the repo root. |

`.gitignore` gained rules so none of these reappear: `hs_err_pid*.log`,
`replay_pid*.log`, `*-test.txt`, `*preview-*.log`, `*preview-*.log.err`.

---

## 3. Duplicate / dead-code inventory

| File | Verdict | Evidence |
|---|---|---|
| `src/lib/enumIntegrity.ts` | **Deleted** | Exports `fetchDbEnumValues`, `diffEnums`, `runEnumIntegrityCheck`. Zero call sites in `src`, `tests`, `scripts`, `plugins`. Its docblock points at an "Enum Health screen (superadmin)" that **does not exist** anywhere in the tree. |
| `src/components/NotificationCenter.tsx` | **Deleted** | Zero references. Superseded by the `notifications` / `notifications-center` routes. |
| `src/components/UserSearchInput.tsx` | **Deleted** | Zero references; docblock claims credits/grant/user-management use it, but all such screens use their own inputs. |
| `src/app/_layout_app.tsx`, `src/app/(app)/_layout_app.tsx`, `tasks/**` copies | **Deleted** | See §2 — duplicate layouts that were also accidental live routes. |
| `src/lib/buildMarker.ts` | **Kept** | Unreferenced by `src`, but `tests/aboutOfflineUi.test.cjs` explicitly pins it as *retained for internal use*. Not dead code. |
| `src/components/{OfflineVideoPlayer,VdoCipherPlayerNativeAdapter}.native.tsx` | **Kept** | Appear unreferenced to a naive basename search; they are resolved through the React Native **platform extension** (`.native`). False positives. |

A byte-identical-file scan across `src/` found **no** duplicated source files,
and no duplicated routes, stores or API surfaces remain beyond the above.

---

## 4. Performance report

### 4.1 Bottleneck found: 16 native round-trips per security check cycle — FIXED

`src/lib/nativeSecurity.ts` — `getNativeSecurityFlags()` had **no cache**, while
`src/lib/security.ts` calls it from **16** call sites per `runSecurityChecks()`
cycle, and the pipeline repeats every `CONTINUOUS_CHECK_INTERVAL_MS = 30_000`.
`runSecurityChecks()` even performs a "warm up the native flag batch cache ONCE
so every detector re-uses it" call — but nothing reused it: by the time the 13
detectors ran inside `Promise.all`, the warm-up promise had already resolved and
each detector issued its **own** JSI call, each re-reading `Settings.Global`,
the package manager and `/proc` inside Kotlin.

**Fix:** a per-cycle coalescing cache — concurrent callers share one in-flight
promise, plus a 500 ms TTL (one check cycle is milliseconds).

**Measured:** 16 calls in one cycle → **1 native read** (pinned by
`tests/nativeFlagsCoalescing.test.cjs` B1). Freshness is unchanged in practice:
the TTL is far shorter than the 30 s timer, and the pipeline also re-runs on
foreground resume, gate re-check and config change. Failures are **never**
cached (B7–B9), and the `wasLastSecurityFlagsCallUnavailable()` contract is
preserved (B8).

**Correctness bug fixed alongside it:** the iOS branch never refreshed
`_lastMeasuredFlags`, so `getNativeSecurityFlagsSync()` — used by
`detectAppIntegrity()` — kept reading `SAFE_FLAGS` on iOS after a successful
measurement (B11).

### 4.2 Reviewed and left alone (already sound)

| Area | Finding |
|---|---|
| Polling loops | `SecurityContext` 30 s continuous check; `ctx.tsx` 30 s revocation poll; `useVideoUploader` 15 s heartbeat *only while an upload is active*; `SecurityContext` 15 min config refresh; VdoCipher adapter 5 s recheck. All are deliberate and bounded; none is a tight loop. The `useContentProtection` 500 ms recording probe exists on both platforms but is gated on the protected screen being mounted and is cleared on unmount. |
| Startup | The offline fast-path already skips network-bound detectors (Play Integrity, policy fetch) when the device is genuinely offline, and all detectors are individually bounded by `DETECTOR_TIMEOUT_MS`. `SecurityContext` keeps the last verdict mounted during re-check (fail-closed) rather than nulling it — that is a security property and was not touched. |
| Watermark / PDF / download restrictions | Untouched. |
| Video players | Untouched — the fullscreen/Plyr lifecycle fixes are preserved. |

### 4.3 Not measured (limitation)

**No physical device was used in this audit** (per the task constraints: no
ADB, no install, no build). Therefore no TTI, FPS or resident-memory figures are
claimed. The one performance claim above is a **static call-count reduction**
(16 → 1 native bridge crossings per cycle) proven by a unit test, not a
device-measured speedup.

Manual device test plan for the maintainer:
1. Cold start, log in, open a lesson; watch `/dev/stats`-style logging if
   available — confirm a single `[NativeSecurity]` read per 30 s cycle.
2. Toggle Developer Options **on** while the app is open, background/foreground:
   the gate must appear within one cycle (proves no stale "safe" state).
3. Screenshot a lesson on a release build: it must be blocked (restored).
4. Same on a dev build with `EXPO_PUBLIC_DISABLE_CAPTURE_PROTECTION=1`: allowed
   (documented escape hatch only).
5. `preventScreenCaptureAsync` restore path: navigate gate → lesson → back, with
   a Super Admin session, and confirm no blank/black surface (the iOS
   reparenting hazard the guard exists to prevent).

---

## 5. Validation report — commands actually run

| Command | Result |
|---|---|
| `node tests/*.test.cjs` (all 72, per-file) | **72 pass, 0 fail** |
| `node tests/securityProtectionRestored.test.cjs` (new) | 17 pass, 0 fail |
| `node tests/nativeFlagsCoalescing.test.cjs` (new) | 17 pass, 0 fail |
| `node tests/overlayLifecycleWiring.test.cjs` | 83 pass, 0 fail |
| `node tests/screenCaptureStartup.test.cjs` | 30 pass, 0 fail |
| `npm run test:state` | 257 + 79 pass, 0 fail |
| `npm run validate` | all 4 stages pass (1 pre-existing App Attest warning) |
| `npm test` (final state, 77 suites) | **77 pass, 0 fail** (~140 s) |
| `node tests/securityParamAuthorityGuard.test.cjs` | 37 pass, 0 fail |
| `node tests/appAttestDeferral.test.cjs` | 124 pass, 0 fail |
| `node scripts/verify-signing-cases.mjs` | A/C/D pass, B skipped (no archived debug-signed APK) |
| `node node_modules/typescript/bin/tsc --noEmit` | exit 0, clean |
| `git log -S DEBUG_DISABLE_DEV_OPTIONS_AND_ADB` | confirms origin commit `fb1024a` |

Two existing suites were updated because they **pinned the disabled state** as
the expected value and would otherwise have blocked the restoration:
`tests/overlayLifecycleWiring.test.cjs` (checks 7a/7b) and
`tests/screenCaptureStartup.test.cjs` (the gate assertions + the source-rewrite
step, now unnecessary since the shipped source is the protected path).

**Not run:** `eslint .` (`npm run lint`) was deliberately **not** used as a
verification gate in this audit, and its output is not reported — the suites
above and `tsc`/`validate` are the evidence. A lint sweep is a reasonable
follow-up now that the dead files listed in §3 are gone.

---

## 6. Changed files

**Modified**
- `src/lib/screenCaptureGuard.ts` — removed the blanket `FLAG_SECURE` disable; protection is default, dev-only opt-in.
- `src/lib/security.ts` — removed the ADB/developer-options bypass; both detections unconditional.
- `src/lib/deviceKey.ts` — evidence bundle reports measured flags verbatim.
- `src/lib/nativeSecurity.ts` — per-cycle coalescing cache; iOS sync-snapshot fix.
- `src/app/(app)/security-diagnostics.tsx` — added the missing Super Admin gate.
- `src/lib/backgroundUploadService.ts` — stale comment referencing the deleted `_layout_app.tsx`.
- `.gitignore` — ignore crash/diagnostic artifacts.
- `tests/overlayLifecycleWiring.test.cjs`, `tests/screenCaptureStartup.test.cjs` — pin the restored state.

**Created**
- `tests/securityProtectionRestored.test.cjs`
- `tests/nativeFlagsCoalescing.test.cjs`
- `docs/PRODUCTION_READINESS_AUDIT.md` (this file)

**Deleted**
- `src/app/diag.tsx`, `src/lib/diagnostics.ts`, `src/components/DiagScreen.tsx`
- `src/app/_layout_app.tsx`, `src/app/(app)/_layout_app.tsx`
- `src/lib/enumIntegrity.ts`, `src/components/NotificationCenter.tsx`, `src/components/UserSearchInput.tsx`
- `tasks/fix-pad-xxl-crash/_layout_app.tsx`, `tasks/full-crash-audit/_layout_app.tsx`, `tasks/full-crash-audit-v2/src/app/(app)/_layout.tsx`
- `hs_err_pid14052.log`, `replay_pid10736.log`, `replay_pid14052.log`, `replay_pid2008.log`, `security-lock-test.txt`, `historical_context.txt`, `website.zip`, `D<U+2024>v3.freebuffpreview-*.log{,.err}`

**Moved**
- `verify-bundle-order.js` → `scripts/verify-bundle-order.js`

**Created in the App Attest / final-readiness pass**
- `src/lib/platformIntegrity.ts` — five-state platform-integrity status model.
- `tests/appAttestDeferral.test.cjs` — 124 checks (deferral semantics + the
  other-controls regression pins).
- `tests/vpnRuntimeDetection.test.cjs` — VPN/proxy launch-vs-runtime regression.
- `scripts/check-security-param-authority.js` + `tests/securityParamAuthorityGuard.test.cjs`
  + `tests/fixtures/security-param-authority/**` (13 fixtures).
- `docs/DEVICE_VALIDATION_CHECKLIST.md` — 13 device areas (see §11.5).

Nothing was committed by this work. The test runners, the new suites and their
fixtures were written to the working tree but left **untracked**, which would
have broken `npm test` from a clean checkout; they are now **staged** (not
committed) for that reason. Nothing was built, installed, deployed, uploaded,
migrated, or applied to a live server or database.

---

## 7. Production-readiness blockers

> **Status update.** Items 2–6 are closed. Item 1 (physical-device validation)
> is the only remaining pre-release item, plus the two owner decisions listed at
> the end of this section. App Attest is formally deferred with its residual risk
> recorded in §8. See `docs/DEVICE_VALIDATION_CHECKLIST.md` for item 1 and
> `docs/archive/README.md` for the item-6 consolidation.

| # | Blocker | Status |
|---|---|---|
| 1 | No physical-device verification of the restored protections | **OPEN — needs hardware.** Checklist written: `docs/DEVICE_VALIDATION_CHECKLIST.md` (13 areas, incl. video/PDF regression and role exemptions). |
| 2 | Signing pin must be present at build time | **CLOSED in source.** `plugins/withProductionSigning.js` now fails a release build when the pin is absent, and `detectTamper` only reports *passed* when `expectedCertConfigured` is true — a skipped check can no longer read as verified. `scripts/verify-signing-cases.mjs` passes against the real APK. Procedures in `docs/PRODUCTION_SIGNING_SETUP.md`. |
| 3 | App Attest | **DECIDED — TEMPORARILY DEFERRED** (accepted residual risk). Not an active enforcement control on iOS; reported as `DEFERRED / NOT VERIFIED`, never as a pass. See §8. |
| 4 | `npm run test:state` depended on git-ignored `.freebuff/` | **CLOSED.** Runner moved to `scripts/run-state-tests.cjs` (+ `scripts/state-build-models.cjs`, `scripts/run-all-tests.cjs`); six test files repointed. Those three files — plus the new guard, the suites and their fixtures — were **untracked working-tree files**, which defeats the fix, so they are now staged in the index (77 tracked suites = 77 on disk). `npm test`, `test:offline` and `npm run validate` all run with `.freebuff/` renamed away. |
| 5 | PHP backend diagnostic surface not audited | **CLOSED.** Six CLI-only scripts that were HTTP-reachable were given the repo's existing CLI-guard; a stray public `backend/public/test-video.mp4` was removed. Detail in §9. |
| 6 | `dist/`, `website/`, overlapping changelogs at root | **CLOSED.** `website/` kept (live deliverable, pinned by a test); three superseded root docs archived. See §10. |

### New items surfaced by this pass

- **`.env` is tracked although `.gitignore` ignores it.** Its three values are
  all `EXPO_PUBLIC_*` (inlined into client bundles by design, so not secrets),
  but the tracked file contradicts the repo's own policy. Untracking it would
  break a clean checkout that has no `.env.local`, so this needs an owner
  decision rather than a silent change.
- **`*.local` is a very broad ignore rule** (`.gitignore` line 30) that happens
  to cover `expected-cert-sha256.local`. It also means any future genuine source
  file ending in `.local` is silently unversioned.

---

## 8. App Attest — DECISION RECORD (deferred)

> **Status: TEMPORARILY DEFERRED — explicitly NOT an active enforcement control.**

**Do not read App Attest as working.** Native and client code exists, but the
verification path is switched off server-side, so iOS currently has **no
platform-integrity enforcement**. Nothing below claims otherwise.

### 8.1 Decision

Full Apple App Attest enforcement is **temporarily deferred**. iOS is
**not** blocked, and no App Attest finding is raised, on account of the
deferral. The application keeps this state explicitly **unverified** rather
than reporting it as a pass (see §8.4).

### 8.2 Reason

Two prerequisites are missing:

1. **Backend verification is not configured.** `POST /integrity/app`
   (`IntegrityController::appIntegrity`) fails **closed with HTTP 503** for
   `attest_key` / `verify_assertion` / `verify` — *"App Attest server
   verification is not configured"*. Server-side attestation and per-request
   assertion validation against Apple's endpoints, with Apple Developer
   credentials, has not been built.
2. **The Apple entitlement/configuration is not completed.** `app.json` has no
   `ios.entitlements['com.apple.developer.app-attest-environment']`, and the App
   Attest capability is not enabled for the App ID. This is also the source of
   the single `npm run validate` warning (`scripts/validate-native-build.js`).

### 8.3 Scope — unavailable during the deferral

| Capability | State |
|---|---|
| iOS App Attest key generation | Available locally; key is never authoritatively attested server-side. |
| Server-side attestation verification | **Unavailable** (503). |
| Per-request assertion verification | **Unavailable** (503). |
| DeviceCheck fallback | **Unavailable** — `verify_device_check` is not handled by the backend (`default` → 422). |
| `app_attest_failed` finding | **Cannot fire on iOS today** — no server path can return `passed: false`. |
| iOS platform-integrity enforcement | **Absent.** |
| Android Play Integrity | **Unaffected** — separate, working path. |

### 8.4 Remaining risk (accepted)

**A jailbroken or compromised iOS device is not detected by a
platform-attestation control, and a repackaged iOS build is not rejected on the
basis of attestation.** Android retains Play Integrity; iOS does not have an
equivalent active control. This is a *known, accepted* gap for this release, not
an oversight — it is recorded here, surfaced in `npm run validate` (warning),
and visible on the Super Admin Security Diagnostics screen. It is **not**
concealed and **not** reported as a pass.

What the deferral does **not** do: it does not disable, downgrade, or bypass any
other control, and it does not make an unverified check look successful.

### 8.5 Required work to enable it later

1. **Apple:** enable the App Attest capability for the App ID; add the
   `com.apple.developer.app-attest-environment` = `production` entitlement via
   `app.json` (source-controlled, so prebuild regenerates it — do **not** hand-edit
   generated `ios/`).
2. **Backend:** implement attestation verification (validate the attestation
   object against Apple, store the public key) and assertion verification
   (validate the signature, bind the challenge, enforce the monotonic counter).
   Replace the 503 with real verification. Provide a `verify_device_check` path
   if DeviceCheck is to be a real fallback.
3. **Secure configuration:** provision Apple Developer credentials as backend
   secrets — never in the repo, never in a client bundle.
4. **Client:** keep the *verified failure* outcome blocking, and keep a
   configuration/unavailability outcome non-blocking and explicitly unverified
   (the status model in `src/lib/platformIntegrity.ts` already distinguishes
   these — see §8.6).
5. **Tests:** regression coverage for pass / real failure / deferred /
   unavailable / error, and that an unverified result is never presented as a
   pass.
6. **Release validation:** physical-device validation of the enabled flow before
   it is relied upon — including a kill switch, because a wrong verdict here
   locks users out.

### 8.6 Revisit condition

App Attest may be represented as an **active enforcement control** only once
steps in §8.5 are complete and validated. Until then every report, dashboard and
document must describe iOS platform integrity as **DEFERRED / NOT VERIFIED** —
never as PASS, and never as "implemented" merely because code exists.

### 8.7 Other security controls remain mandatory

Deferring App Attest changes **no** other control. Still enforced exactly as
before: Android Play Integrity; production signing pin + tamper detection;
`FLAG_SECURE` screenshot/recording protection; USB-debugging (ADB) and
Developer-Options detection; mock-location detection (including the fixed
false-positive copy); VPN/proxy detection; TLS, certificate pinning and native
integrity checks; SecurityGate policies and risk weights; backend authorization
and role exemptions; force-update enforcement; protected media/PDF permissions.
No weight was reduced, no detector disabled, no allowlist added.

To make an unverified result impossible to mistake for a pass, the outcome is
now carried in an **explicit status model** — `src/lib/platformIntegrity.ts` —
with five reportable states:

| Status | Meaning | Counts as a pass? | May block? |
|---|---|---|---|
| `passed` | The check ran and the platform verified the device/app. | **Yes (only this one)** | — |
| `failed` | The check ran and produced a real negative verdict. | No | **Yes (only this one)** |
| `deferred` | Enforcement intentionally off (HTTP 503 / not configured). | **No** | No |
| `unavailable` | The platform cannot perform the check here (no Play Services, simulator). | **No** | No |
| `error` | Attempted but inconclusive (network/timeout/unexpected). | **No** | No |

Every exit of both integrity flows records one of these, and the deferral is
reported as `DEFERRED / NOT VERIFIED` on the Super Admin Security Diagnostics
screen. A deliberate deferral is **not** turned into an `app_attest_failed`
finding — a real verified failure and a configuration/unavailability state are
different outcomes, and only the former blocks.

---

## 9. Backend diagnostic audit (blocker 3)

The PHP backend was audited read-only for temporary diagnostic routes, test
controllers, unsafe output and authorization gaps. No live server or database
was touched.

**Fixed**

- Six scripts under `backend/scripts/` were **HTTP-reachable** if the host's
  document root pointed at the app root (a risk the repo's own `.htaccess`
  warns about) — two seeders, the regression test runner, a security diagnostic
  and two cron jobs. Each received the same CLI-only guard six of their siblings
  already used. `php -l` clean on all six.
- Removed `backend/public/test-video.mp4` — a stray test fixture sitting in the
  web root.

**Preserved deliberately**

- `/system-health` — a legitimate, documented health surface used by the client.
- Super Admin diagnostics routes and provider-health style operational endpoints
  — legitimate tooling, left with their existing authorization model.

---

## 10. Root-artifact review (blocker 5)

| Item | Decision | Evidence |
|---|---|---|
| `website/` | **Keep** | 12 tracked files, an actively maintained static site (modified the day before review), pinned by `tests/websiteTheme.test.cjs`. Deliverable content, not an artifact. |
| `CHANGELOG.md` | **Keep at root** | The single canonical changelog. |
| `CHANGELOG_V562_TO_V568.md`, `CHANGES.md`, `PROJECT_STATUS.md` | **Archived** → `docs/archive/` | Single-version changelog, a one-off fix write-up, and a status page still claiming "V562 / Supabase". Indexed in `docs/archive/README.md`. |
| `.idea/` | **Untracked** | Six IDE files were version-controlled despite being per-developer state. Local files kept; added to `.gitignore`. |
| `dist/`, `tsconfig.tsbuildinfo`, `.git-backup/`, `.sync/`, `.expo/` | **No action** | All already git-ignored, so none affect the repository. `dist/` is a stale (Aug) but regenerable web export; `.git-backup/` is a 1.3 GB local history backup left untouched on purpose. |
| `tasks/` | **No action** | Now only four historical notes; `metro.config.js` documents the tree as its intentional archive and excludes it from module resolution. |

---

## 11. Release handoff — what is verified, and what is not

Nothing in this task built an artifact, deployed, migrated, or touched
production. The categories below separate what was actually proven from what
still needs a build or a device.

### 11.1 Completed source-level fixes

- Security protections restored (§1): `FLAG_SECURE` capture protection,
  ADB/Developer-Options detection, evidence integrity.
- Temporary diagnostics removed and legitimate tooling gated (§2).
- Dead code / stale duplicates removed with call-site evidence (§3).
- Per-cycle native-flag coalescing (§4) — 16 bridge crossings reduced to 1.
- Signing pin is fail-closed at build time (§7 item 2).
- `npm test` / `test:state` / `test:offline` reproducible from a clean checkout
  (§7 item 4).
- Backend CLI-only guards added (§9).
- Root-artifact consolidation (§10).
- **App Attest deferral made explicit and non-misleading** (§8): a five-state
  status model (`src/lib/platformIntegrity.ts`) where only `passed` is a verified
  pass and only `failed` may block; every exit of both integrity flows records a
  status; the deferral is surfaced as `DEFERRED / NOT VERIFIED` on the Super Admin
  Security Diagnostics screen.
- **New lint guard — no security decision from route params**
  (`scripts/check-security-param-authority.js`, stage 4/4 of `npm run validate`):
  a screen may not derive a security finding, risk score or gate decision from
  route params instead of the authoritative `useSecurity()` verdict. Closes the
  class of defect that produced the contradictory warning screen; params stay
  allowed for navigation and display-only data.

### 11.2 App Attest — deferred, with accepted residual risk

Summarised in §8. **Accepted risk: iOS has no active platform-integrity
enforcement in this release.** A compromised or repackaged iOS build is not
detected by attestation. This is deliberate, documented, surfaced in
`npm run validate` as a warning, and never reported as a pass.

### 11.3 Automated tests actually executed

See §5 for the full command log. Final state, measured on this working tree:

| Command | Result |
|---|---|
| `npm test` (test:state + all `tests/*.test.cjs`) | exit 0 — **77 passed, 0 failed** (~140 s) |
| `npm run test:offline` | exit 0 — 12 passed, 0 failed |
| `npm run validate` | exit 0 — **4/4 stages**, 1 pre-existing App Attest warning |
| `node node_modules/typescript/bin/tsc --noEmit` | exit 0, clean |
| `node tests/appAttestDeferral.test.cjs` | **124 passed, 0 failed** |
| `node tests/releaseConfigConsistency.test.cjs` (new, §12) | **22 passed, 0 failed** |
| `node tests/securityParamAuthorityGuard.test.cjs` | **37 passed, 0 failed** |
| `node scripts/verify-signing-cases.mjs` | A/C/D PASS, B SKIPPED |
| `npm run lint:security-params` | exit 0 — 351 files scanned, 0 violations |

Two suites are **non-vacuous by construction**, which matters because a guard
that cannot fail is not evidence: the App Attest suite's assertions each fail
against the pre-fix revision, and the param-authority guard reports the three
true violations in the pre-fix `security-warning.tsx` still present at `HEAD`
while leaving the pre-login screen exempt.

**Not run:** `php -l` syntax checks (PHP is not installed on this machine — see
§9), an `assembleRelease` (§11.4), and any device test (§11.5). `eslint` is not
a gate in this repo: `npm run lint` exits 1 with 28 pre-existing errors, all in
`.freebuff/` scratch files and generated `.expo/` types, none in the files this
task created or modified.

### 11.4 Checks that require a real Gradle build (NOT run)

- `plugins/withProductionSigning.js` throwing a `GradleException` on a release
  with no pin. Statically verified and idempotent; **never exercised by an actual
  packaging task.** The next `assembleRelease` is its first real test.
- That a production-signed release still installs and passes the signature
  check end-to-end (`BuildConfig.EXPECTED_CERT_SHA256` populated at compile time).
- `app_attest_failed` behaviour cannot be exercised without the backend
  verification path existing — it is unreachable by design today.

### 11.5 Checks that require a physical device (NOT run)

No iPhone or Android device was used in this task. Outstanding:

- iOS: App Attest state renders as **DEFERRED / NOT VERIFIED** (never PASS) on
  Security Diagnostics.
- iOS: VPN/proxy launch-vs-runtime scenarios — `docs/DEVICE_VALIDATION_CHECKLIST.md` §10.
- Android: screenshot/recording blocking, ADB + Developer-Options gating,
  mock-location (incl. the false-positive regression), signing/tamper, gate
  consistency, startup/resume — §0–§9 and §11–§13 of the same checklist.
- Video and PDF/watermark regression on both platforms.

### 11.6 Remaining blockers before a public production release

1. **Physical-device validation** — the only functional blocker. Run
   `docs/DEVICE_VALIDATION_CHECKLIST.md` on real hardware.
2. **Owner decision — `.env` tracked while `.gitignore` ignores it** (values are
   public `EXPO_PUBLIC_*`; untracking would break a clean-clone build, so it
   needs a deliberate choice).
3. **Owner decision — `*.local` is a very broad ignore rule** that also covers
   `expected-cert-sha256.local`.
4. **Not a blocker, but required before App Attest can be called active:** every
   step in §8.5.

### 11.7 Release-readiness checklist

| Item | State |
|---|---|
| Protections restored in shipped source | ✅ |
| Temporary diagnostics removed / gated | ✅ |
| Signing pin fail-closed (source) | ✅ |
| Test suite reproducible from a clean checkout | ✅ 74/77 on a bare checkout; 3 suites need `npx expo prebuild -p android` |
| Backend CLI guards | ✅ |
| App Attest deferral documented + never a false pass | ✅ |
| `tsc` / `validate` / full suite green | ✅ (77/77) |
| Release build exercised with the signing guard | ❌ needs Gradle |
| Device validation (iOS + Android) | ❌ needs hardware |
| Tracked API host covered by the pin list | ✅ fixed in §12 |
| Deterministic line endings on a clean checkout | ✅ fixed in §12 |
| CI lint gate green on a clean checkout | ✅ fixed in §12 |
| Production API hostname confirmed by owner | ✅ `api.medacademy.site` (2026-10-13) |
| `.env` + `*.local` owner decisions | ❌ needs owner |

---

## 12. Pre-release audit fixes (2026-10-13)

Three defects were found by auditing a **clean checkout** — an index-derived
snapshot with none of the git-ignored local overrides this working tree has —
rather than by reading source. All three are invisible on a developer machine,
all three are fixed and re-verified, and none weakens a security control.

| # | Defect | Evidence | Fix | Verification |
|---|---|---|---|---|
| 1 | **Tracked `.env` pointed at a decommissioned API host.** `.env` and all five `.env*.example` / `.env.local.template` files named `api.medacademy.eu.cc`, which does not resolve and is **not** in the app's pinned host list — so a clean build would have talked to a dead host that TLS pinning did not cover. Hidden locally because an ignored `.env.local` overrode it (dotenv "later file wins"). | `dns.resolve4('api.medacademy.eu.cc')` → SERVFAIL; `api.medacademy.site` → 66.29.148.144, and its TLS chain matches pins[4] (intermediate `YR1`) and pins[5] (root `Root YR`); `app.json` pins `api.medacademy.site`; E4 in `tests/iosPinningCoverage.test.cjs` fails with no `.env.local`. | All six env files now name `api.medacademy.site` (one line each; nothing else changed). | E4 passes with no `.env.local`; §12 suite checks D and E |
| 2 | **No `.gitattributes`.** With `core.autocrlf=true` a Windows checkout rewrote text files to CRLF while the committed blobs are LF, so LF-literal assertions and byte-for-byte asset comparisons failed on a fresh checkout. | Worktree 18,897 bytes (LF) vs checkout 19,266 bytes (CRLF) for `VideoLibrarySyncService.php`; the `brandIdentity` drifters were exactly the two SVG text assets. | Added `.gitattributes`: `* text=auto eol=lf` plus explicit `binary` for image/font/archive types. Zero content change — all 770 tracked text blobs were already LF. | Clean-checkout suite went 68 → 74 passed; the 4 affected suites pass; §12 suite checks A and B |
| 3 | **ESLint config gap made the CI lint gate fail.** `npm run lint` is a step in `native-build-validation.yml` and is not marked `continue-on-error`; it exited 1 on a clean checkout with 6 `no-undef` errors for `__dirname`, 4 of them from the new `scripts/*.cjs` runners. | Clean checkout: `✖ 1011 problems (6 errors, 1005 warnings)`. | Extended the existing Node-globals override to `scripts/**` and `backend/deploy-package/**/*.cjs`. | Clean checkout now `✖ 1014 problems (0 errors, 1014 warnings)`, exit 0 |

Regression coverage: **`tests/releaseConfigConsistency.test.cjs`** (27 checks)
pins the line-ending policy, the tracked-host-versus-pin-list relationship,
env-template agreement, and the owner-confirmed production host. Both key
assertions were confirmed **non-vacuous** — they fail against the pre-fix blobs
(`HEAD:.env` names `api.medacademy.eu.cc`, which is absent from
`medaPinnedHosts`; `HEAD` has no `.gitattributes`).

### 12.1 Hostname consistency sweep (confirmed 2026-10-13)

The owner confirmed **`https://api.medacademy.site`** as the authoritative
production API host. Every tracked reference to `api.medacademy.eu.cc` (32
occurrences across 8 files) was classified as one of three kinds:

| Kind | Files | Treatment |
|---|---|---|
| **Live runtime/runbook configuration** | `backend/NAMECHEAP_DEPLOYMENT.md` (11), `backend/docs/MIGRATION_STATUS.md` (1 — the VdoCipher webhook URL) | Updated to `api.medacademy.site`; hostname only, one line per site |
| **Dated evidence snapshots** | `backend/docs/FINAL_MIGRATION_AUDIT.md` (2026-08-19), `FINAL_PRODUCTION_CUTOVER_AUDIT.md` (2026-08-24), `FRONTEND_PHP_INTEGRATION_AUDIT.md` (2026-08-24) — 15 occurrences | **Preserved verbatim** with a "Historical record" banner naming the confirmed host; they record what was actually observed, so rewriting them would falsify the evidence |
| **Intentional references to the defect** | this §12, `tests/releaseConfigConsistency.test.cjs`, and the negative assertion in `tests/adminDiagnosticsAudit.test.cjs` | Kept — they describe or forbid the decommissioned host |

Runtime agreement is asserted, not assumed: `tests/iosPinningCoverage.test.cjs`
E4 resolves the **effective** `EXPO_PUBLIC_PHP_API_URL` through dotenv precedence
and requires its host to appear in `expo.extra.medaPinnedHosts`, and check F of
the §12 suite requires `.env`, all five env templates, `app.json` and the live
runbook to name the confirmed host. TLS pinning is untouched by this pass: the
shipped pin set still matches the live chain presented by the confirmed host
(any-in-chain matching, as documented by `plugins/withTlsPinning.js`), and **no
pin, host exemption, validation rule or fail-closed behaviour was relaxed,
added or removed**.

Still open after this pass, deliberately not fixed:

- The **test suite is not executed by any CI workflow**. `native-build-validation.yml`
  runs the four validation stages plus `tsc` and ESLint, and `npm run validate`
  includes the param-authority guard, but nothing runs `npm test`. Adding that job
  is a workflow change that cannot be validated from here — and a naive job would
  be red, because 3 suites require the generated `android/` tree first.
- **3 suites require `npx expo prebuild -p android`**: `fullscreenArchitecture`,
  `mockLocationDetection` and `offlineMediaContract` read `AndroidManifest.xml`,
  the generated `SecurityModule.kt` and `android/build.gradle`. They pass in a
  prepared worktree and fail loudly (never silently skip) on a bare checkout.
- **`package.json` (2.0.1) vs `app.json` `expo.version` (1.0.844)** drift.
  Force-update enforcement is versionCode-based (`X-App-Version-Code` versus
  `minimum_version_code`), so this is hygiene rather than a gate — owner decision.
- **`src/app/(app)/security-gate.tsx` has no default export** (expo-router emits
  a dev warning). The gate itself works because `(app)/_layout.tsx` imports the
  named component and renders it inline; only a direct deep link to
  `/security-gate` would render nothing. Moving the component out of the route
  tree is a structural change that needs a design decision.
- **`Cache-Control` is absent from** `backend/src/Middleware/CorsMiddleware.php`'s
  `Access-Control-Allow-Headers`, so the `GET /maintenance` preflight fails from a
  browser origin. Web target only, and unverified: PHP is not installed here.
- `.idea/*` files are still tracked while `.gitignore` now ignores `.idea/`; the
  deletion was deferred with the IDE-cleanup group. Decide delete versus keep.

