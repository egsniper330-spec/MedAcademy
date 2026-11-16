# TEMPORARY security suspension in the GitHub Actions APK build

*(This document: `docs/TEMP_SECURITY_SUSPENSION.md`.)*

> ⚠️ **TEMPORARY — REMOVE WHEN THE CRASH INVESTIGATION IS DONE.**
> The APK produced by `.github/workflows/android-apk.yml` while this suspension is
> active does **not** block access on a device with Developer Options / USB
> debugging / Magisk / Xposed. It must be treated as an internal test build and
> must never be distributed to users.

Purpose: reach the dashboard on the test tablet **with ADB attached**, so the
dashboard-rendering crash can be captured from Logcat.

The mechanism is the diagnostic switch (`src/lib/securityTestBuild.ts`), whose
value is now a **source constant** in `src/lib/diagnosticBuildFlag.ts`. The
repository copy of that constant is `false`; `scripts/arm-diagnostic-suspension.cjs`
flips it to `true` on the build runner, and **only** when both authorisation keys
below are present. Nothing in the app reads storage, the network, route params or
any runtime preference, so the suspension cannot be turned on or off at runtime —
and it disappears completely when the constant is `false` again.

| Build-time variable | Value | Where |
|---|---|---|
| `EXPO_PUBLIC_SECURITY_TEST_BUILD` | `1` | job `env:` of `android-apk.yml` (authorisation) |
| `EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK` | `security-test` | job `env:` of `android-apk.yml` (authorisation) |
| `MEDACADEMY_SECURITY_SUSPENSION` | `workflow` | job `env:` of `android-apk.yml` (build guard acknowledgement; not read by the app) |

### Why it is not a `process.env` switch any more

A release bundle inlines `process.env.EXPO_PUBLIC_*` **as literals** at transform
time (`babel-preset-expo/build/inline-env-vars.js` → `t.valueToNode(process.env[key])`
when the caller is not a dev build) — but it does so inside a **Metro worker**.
Two signed builds proved that channel unusable end to end:

* **build 223** — job-level `env:` never reached the bundler: the APK was signed
  and produced, its bundle contained neither marker.
* **run 43926766869** — the keys were written into every env-file channel; the
  Gradle bundle task logged
  `env: load .env.production.local .env.local .env.production .env`, the pre-build
  gate compiled the switch to `true` in the same job, and the shipped, minified
  bundle still contained **no** marker. The worker had inlined `void 0` for the
  flag, and Terser then deleted every diagnostic branch as dead code.

A value that cannot be observed where it is consumed is not a usable build input,
so the switch is a plain constant the bundler cannot misread. The two keys survive
as the **authorisation** for arming (both are required, no default, no wildcard),
and they are also written into the env files so the intent is visible in the
bundle log. A checkout whose env files or flag module would arm the suspension is
rejected by the build guard.

---

## 1. Files changed for the temporary suspension

| File | Change | Reversion |
|---|---|---|
| `.github/workflows/android-apk.yml` | job `env:` gains the three variables (marked `TEMPORARY SECURITY SUSPENSION`); new step **“Arm the temporary security suspension for the bundle”** (appends the keys to the runner's `.env`, writes `.env.production`); new step **“Verify APK bundle contains the diagnostic switch”**; one `⚠️ Security` line in the build summary | delete the marked env block, the arming step, the verify step, and the summary block |
| `src/lib/diagnosticBuildFlag.ts` | the compile-time flag the switch reads; committed as `false`, armed to `true` on the runner only | **keep at `false`** — the build guard rejects a committed `true` |
| `src/lib/securityTestBuild.ts` | switch bound to that flag, exports the frozen waived-check list, a status helper and the one-shot `[DIAG-BUILD]` marker | **keep** — it is inert (compiles to `false`) in every normal build |
| `src/components/DiagnosticModeBanner.tsx` | red `DIAGNOSTIC BUILD — SECURITY CHECKS WAIVED` bar at the app root | **keep** — renders `null` when the switch is off |
| `src/app/_layout.tsx` | mounts that banner above the navigator | **keep** (harmless when inert) |
| `app.json` | `expo.android.versionCode` `222` → **`223`** (identify this APK) | set back to the next real version you intend to publish |
| `eas.json` | `security-test` profile carries the two keys (unrelated to this workflow) | unchanged by this task |
| `package.json` | `validate` / `prebuild:validate` also run the build guard | keep |
| `scripts/check-diagnostic-build-guards.cjs` | guard; now also accepts `MEDACADEMY_SECURITY_SUSPENSION=workflow` as the second sanctioned arming path | keep |
| `scripts/arm-diagnostic-suspension.cjs` | `arm` / `verify` / `status` for the env-file arming; owns the file precedence, refuses conflicts, and proves the compiled switch is `true` | delete when restoring |
| `tests/androidWorkflowSecuritySuspension.test.cjs` | regression suite for this suspension + its restoration | keep |
| `tests/diagnosticSuspensionArm.test.cjs` | regression suite for the arming/verification script (9 assertions) | delete with the script |
| `tests/diagnosticSecurityBuild.test.cjs` | regression suite for the switch itself | keep |
| `docs/DIAGNOSTIC_SECURITY_BUILD.md` | switch documentation | keep |

**Nothing else was touched:** no signing configuration, no keystore, no package
ID, no `Submit`/EAS workflow, no backend, no Portal, no website, no iOS code.

## 2. Enforcement paths temporarily disabled

Only the **local blocking decision** ignores these finding types
(`src/lib/security.ts`, the single `.filter((t) => !isSecurityTestBypassed(t))`
applied to `allThreats` **before** `computeRiskScore()`):

```
developer_options_enabled   adb_enabled        debugger_attached   debug_detected
root_detected               magisk_detected    xposed_detected     frida_detected
```

Because `blocksLogin` is derived from the filtered risk score, this single filter
is what stops every downstream consequence for those types:

| Enforcement path | Behaviour while suspended |
|---|---|
| `blocksLogin` (SecurityContext → `SecurityGate`, non-dismissible) | not raised for the eight types |
| Forced logout / `blocksVideo` | not raised for the eight types |
| Security-warning screen routing | not raised for the eight types |
| Navigation restrictions sourced from the verdict | not applied for the eight types |

### Still fully enforced (unchanged)

- Authentication, session validation, refresh-token handling, sign-out.
- Backend authorization and every API check (no server-side change whatsoever).
- VPN / proxy policy, overlay (tapjacking) detection, multi-window enforcement.
- Screen-recording / screenshot protection (`FLAG_SECURE`), watermarking, PDF protection.
- Signature verification, Play Integrity, tamper checks, certificate pinning.
- Role routing and every permission/capability check.

### Not faked, not hidden

Every detector still runs and `logThreats()` still reports every finding —
including the eight waived types — to the backend. The verdict simply does not
block on them. Nothing reports a fake "clean" result: `SecurityContext` logs the
filtered verdict, and the app shows the red diagnostic banner on every screen.

## 3. How to build it

```bash
git add -A && git commit -m "TEMP: suspend local device-environment blocking for crash investigation"
git push          # the workflow builds the pushed commit — uncommitted changes are invisible to Actions
```

Then run **Actions → “Android APK Build” → Run workflow** (the same workflow as
always; `workflow_dispatch` only). Download `MedAcademy-Android-APK` →
`MedAcademy-v1.0.0-223.apk`.

The workflow now fails on purpose if the waiver did not reach the bundle:

```
Verify APK bundle contains the diagnostic switch
  JS bundle entries in the APK: ['assets/index.android.bundle']
  extracted assets/index.android.bundle (8464725 bytes)
  Diagnostic markers in the shipped bundle:
  DIAG-BUILD
  DIAGNOSTIC BUILD
  OK — the APK's JS bundle contains the diagnostic build marker.
```

When the marker is missing the step prints a `why the marker is missing` group
(bundle size, plus a count of dev-style `EXPO_PUBLIC_SECURITY_TEST_BUILD`
references — a non-zero count means the bundle was not compiled in production
mode) and then fails, so an un-suspended APK is never published. The extraction
uses `python3`, so a missing archive tool can no longer masquerade as
“marker not found”.

### The two steps that arm and prove it

1. **Arm the temporary security suspension for the bundle** —
   `node scripts/arm-diagnostic-suspension.cjs arm`. Refuses to run unless both
   authorisation keys are in its environment, then sets the flag module to
   `true` and writes the two keys into every env-file channel the Expo loader
   consults (`.env.<mode>.local` → `.env.local` → `.env.<mode>` → `.env`),
   preserving all unrelated values. A conflicting definition (e.g. a leftover
   `EXPO_PUBLIC_SECURITY_TEST_BUILD=0`) stops it **before anything is written**.
   The runner-side env files are never committed and the build guard rejects any
   checkout that declares the keys.
2. **Verify the suspension reaches the compiler (pre-build gate)** —
   `node scripts/arm-diagnostic-suspension.cjs verify`. Runs in seconds and
   proves the real chain before Gradle spends 30 minutes: flag module `true` →
   `src/lib/securityTestBuild.ts` compiles in production mode →
   `SECURITY_TEST_BUILD === true` → exactly the eight documented findings waived
   → `vpn_detected`, `screen_recording`, `signature_invalid` still block → and,
   decisively, **`[DIAG-BUILD]` survives Terser minification**, which is exactly
   what the two failing builds lost.

Both commands accept `--root DIR`, `--mode production` and `--flag FILE`, and are
exercised end-to-end by `tests/diagnosticSuspensionArm.test.cjs`. `disarm` reverses
both the flag and the env-file lines; `status` reports what is armed.

## 4. Verify on the tablet

```bash
adb shell dumpsys package com.medacademy.app | grep -E "versionCode|lastUpdateTime"   # expect 223
adb logcat -c
adb shell monkey -p com.medacademy.app -c android.intent.category.LAUNCHER 1
adb logcat | grep -E "DIAG-BUILD|SecurityContext.*setResult"
```

Expected: `[DIAG-BUILD] ACTIVE …`, the red banner at the top of every screen, and
`blocksLogin=false`. Without the suspension the same device reports
`threats='adb_enabled,xposed_detected,magisk_detected' blocksLogin=true`.

## 5. Restoration checklist (do all of it)

1. **Revert the workflow** — in `.github/workflows/android-apk.yml`:
   - delete the job-`env:` block that starts with
     `# ⚠️  TEMPORARY SECURITY SUSPENSION` (the three variables);
   - delete the step `Arm the temporary security suspension for the bundle`
     (and the comment block above it) and the step
     `Verify the suspension reaches the compiler (pre-build gate)`;
   - delete the step `Verify APK bundle contains the diagnostic switch`;
   - delete the `⚠️ Security` block in `Build summary` (comment
     `# TEMPORARY (security suspension)`);
   - delete `scripts/arm-diagnostic-suspension.cjs` and
     `tests/diagnosticSuspensionArm.test.cjs`.
2. **Set the versionCode** in `app.json` to the next version you intend to ship
   (`223` was the suspended build — publish `224` or higher).
3. **Confirm the flag is `false`** — `src/lib/diagnosticBuildFlag.ts` must read
   `export const DIAGNOSTIC_BUILD_FLAG: boolean = false;` (it is committed that
   way; `node scripts/arm-diagnostic-suspension.cjs disarm` restores it and strips
   any suspension lines from the env files). With `false` the switch is inert:
   `SECURITY_TEST_BUILD === false`, `isSecurityTestBypassed()` always `false`, the
   banner renders `null`, and `security.ts` filters nothing — and the minifier
   deletes the diagnostic code from the bundle entirely. (Deleting the switch is
   optional; if you do, also delete the flag module, the banner, its mount, the
   guard script, the test suites and their `package.json` hooks.)
4. **Prove protection is back, before publishing:**
   ```bash
   node tests/androidWorkflowSecuritySuspension.test.cjs   # restoration assertions
   node tests/diagnosticSecurityBuild.test.cjs             # switch stays inert
   node scripts/check-diagnostic-build-guards.cjs          # no stray keys anywhere
   npm run validate                                        # native build suite
   ```
5. **Negative proof after installing the restored APK:** on the same tablet, with
   ADB still enabled, the app must again report
   `blocksLogin=true` for `adb_enabled,xposed_detected,magisk_detected` and must
   show the SecurityGate instead of the dashboard. If it still reaches the
   dashboard, the keys are still being injected somewhere — grep the workflow,
   `eas.json` and your shell environment for `EXPO_PUBLIC_SECURITY_TEST_BUILD`.
6. Delete the suspended APK (`versionCode 223`) from the tablet.
