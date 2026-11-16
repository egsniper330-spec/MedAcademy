# TEMPORARY security suspension in the GitHub Actions APK build

*(This document: `docs/TEMP_SECURITY_SUSPENSION.md`.)*

> ⚠️ **TEMPORARY — REMOVE WHEN THE CRASH INVESTIGATION IS DONE.**
> The APK produced by `.github/workflows/android-apk.yml` while this suspension is
> active does **not** block access on a device with Developer Options / USB
> debugging / Magisk / Xposed. It must be treated as an internal test build and
> must never be distributed to users.

Purpose: reach the dashboard on the test tablet **with ADB attached**, so the
dashboard-rendering crash can be captured from Logcat.

The mechanism is the existing build-time diagnostic switch
(`src/lib/securityTestBuild.ts`). It is armed **only** when both keys below are
present while the JS bundle is compiled. Nothing in the app reads storage, the
network, route params or any runtime preference, so the suspension cannot be
turned off or on at runtime — and it disappears completely when the keys are gone.

| Build-time variable | Value | Where |
|---|---|---|
| `EXPO_PUBLIC_SECURITY_TEST_BUILD` | `1` | job `env:` of `android-apk.yml` |
| `EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK` | `security-test` | job `env:` of `android-apk.yml` |
| `MEDACADEMY_SECURITY_SUSPENSION` | `workflow` | job `env:` of `android-apk.yml` (build guard acknowledgement; not read by the app) |

Because these are **job-level** environment variables, they are inherited by the
Gradle `:app:assembleRelease` process, whose bundling task runs Metro/Babel — the
point where `process.env.EXPO_PUBLIC_*` is inlined into the shipped bundle.

---

## 1. Files changed for the temporary suspension

| File | Change | Reversion |
|---|---|---|
| `.github/workflows/android-apk.yml` | job `env:` gains the three variables (marked `TEMPORARY SECURITY SUSPENSION`); new step **“Verify APK bundle contains the diagnostic switch”**; one `⚠️ Security` line in the build summary | delete the marked env block, the whole verify step, and the summary block |
| `src/lib/securityTestBuild.ts` | switch now requires **both** keys, exports the frozen waived-check list, a status helper and the one-shot `[DIAG-BUILD]` marker | **keep** — it is inert (compiles to `false`) in every normal build |
| `src/components/DiagnosticModeBanner.tsx` | red `DIAGNOSTIC BUILD — SECURITY CHECKS WAIVED` bar at the app root | **keep** — renders `null` when the switch is off |
| `src/app/_layout.tsx` | mounts that banner above the navigator | **keep** (harmless when inert) |
| `app.json` | `expo.android.versionCode` `222` → **`223`** (identify this APK) | set back to the next real version you intend to publish |
| `eas.json` | `security-test` profile carries the two keys (unrelated to this workflow) | unchanged by this task |
| `package.json` | `validate` / `prebuild:validate` also run the build guard | keep |
| `scripts/check-diagnostic-build-guards.cjs` | guard; now also accepts `MEDACADEMY_SECURITY_SUSPENSION=workflow` as the second sanctioned arming path | keep |
| `tests/androidWorkflowSecuritySuspension.test.cjs` | regression suite for this suspension + its restoration | keep |
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
  Diagnostic markers found in the APK bundle:
  DIAG-BUILD
  DIAGNOSTIC BUILD
  OK — the APK's JS bundle contains the diagnostic build marker.
```

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
   - delete the step `Verify APK bundle contains the diagnostic switch`
     (the comment above it starts `# ── TEMPORARY (security suspension)`);
   - delete the `⚠️ Security` block in `Build summary` (comment
     `# TEMPORARY (security suspension)`).
2. **Set the versionCode** in `app.json` to the next version you intend to ship
   (`223` was the suspended build — publish `224` or higher).
3. **Leave the switch code in place** — with no keys it is inert:
   `SECURITY_TEST_BUILD === false`, `isSecurityTestBypassed()` always `false`,
   the banner renders `null`, and `security.ts` filters nothing. (Deleting it is
   optional; if you do, also delete the banner, its mount, the guard script, the
   two test suites and their `package.json` hooks.)
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
