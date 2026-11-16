# Diagnostic (security-test) build — operator guide

A **temporary, build-time-only** switch that lets a throwaway APK reach the
dashboard on a test device whose environment would normally be blocked
(Developer Options, USB debugging, Magisk, Xposed/LSPosed). It exists so a crash
can be reproduced with Logcat attached.

- Implementation: `src/lib/securityTestBuild.ts`
- Visible marker: `src/components/DiagnosticModeBanner.tsx` (mounted in `src/app/_layout.tsx`)
- Build gate: `scripts/check-diagnostic-build-guards.cjs` (runs in `npm run validate` and `npm run prebuild:validate`)
- Regression suite: `tests/diagnosticSecurityBuild.test.cjs`

> ⚠️ This mode must never be used for a build that reaches users. It waives
> **local device-environment findings only**, for the **blocking decision only**.
> Detection still runs and every finding is still reported to the backend.

---

## 1. What is waived

Only these threat types, and only when both build-time keys are present:

```
developer_options_enabled
adb_enabled
debugger_attached
debug_detected
root_detected
magisk_detected
xposed_detected
frida_detected
```

## 2. What is **never** waived

Authentication and authorization, backend enforcement, VPN/overlay policy,
screen-recording detection, signature/Play Integrity/tamper checks, certificate
pinning, multi-window enforcement, watermarking and PDF protection. The
detectors are not modified or deleted — `runSecurityChecks()` still produces
every finding and `logThreats()` still reports it; the diagnostic filter removes
the waived types from `allThreats` **before** `computeRiskScore()` and therefore
before `blocksLogin` is derived.

---

## 3. How to enable it

Both variables must be present **while the JS bundle is built**. One is not
enough — the second key is what makes an accidental enablement impossible.

| Variable | Value |
|---|---|
| `EXPO_PUBLIC_SECURITY_TEST_BUILD` | `1` |
| `EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK` | `security-test` |

### Option A — EAS profile (already configured)

```bash
npx eas build --profile security-test --platform android
```

`eas.json` → `build.security-test` is `distribution: "internal"` and sets both
keys. It is the **only** profile allowed to declare them.

### Option B — local release build

**bash / Git Bash**

```bash
export EXPO_PUBLIC_SECURITY_TEST_BUILD=1
export EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK=security-test
export EAS_BUILD_PROFILE=security-test
npx expo run:android --variant release
```

**PowerShell**

```powershell
$env:EXPO_PUBLIC_SECURITY_TEST_BUILD="1"
$env:EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK="security-test"
$env:EAS_BUILD_PROFILE="security-test"
npx expo run:android --variant release
```

`EAS_BUILD_PROFILE=security-test` is required for a local build: with the keys
set and no profile, `scripts/check-diagnostic-build-guards.cjs` **fails on
purpose** so the build cannot be ambiguous.

### Before building

Bump `expo.android.versionCode` in `app.json` (e.g. `223`) so the diagnostic
install is distinguishable from production in `dumpsys package`.

### After building

Unset the three variables in that shell. Never put either key in `.env`,
`.env.production`, `.env.local`, CI secrets or any committed file — only the
`security-test` profile in `eas.json` carries them.

---

## 4. Verify on the device

```bash
# 1. which build is installed?
adb shell dumpsys package com.medacademy.app | grep -E "versionCode|lastUpdateTime"

# 2. is the diagnostic switch actually active in THIS install?
adb logcat -c
adb shell monkey -p com.medacademy.app -c android.intent.category.LAUNCHER 1
adb logcat | grep -E "DIAG-BUILD"
```

Expected when active:

```
[DIAG-BUILD] ACTIVE — this is a DIAGNOSTIC build. Local device-environment checks
are waived for the BLOCKING decision only: developer_options_enabled, adb_enabled,
… NOT FOR PRODUCTION.
```

A production build prints **nothing** matching `DIAG-BUILD`.

3. The app root shows a permanent red bar:
   **`DIAGNOSTIC BUILD — SECURITY CHECKS WAIVED`** with the waived-check list.
   It is rendered above the navigator, so it is visible on the login screen and
   on every route.

If the bar is missing, the bundle was built without both keys — rebuild; do not
look for a runtime workaround (there is none).

---

## 5. Guardrails that keep it out of production

`node scripts/check-diagnostic-build-guards.cjs` (also part of
`npm run validate` / `npm run prebuild:validate`) fails when:

1. any `eas.json` profile other than `security-test` declares either key;
2. `security-test` stops being `distribution: "internal"`;
3. the `production` profile declares either key, or `submit` references the
   diagnostic profile;
4. the flag is set in the environment **without** the acknowledgement key, or
   while `EAS_BUILD_PROFILE` names a different profile, or with no profile at all;
5. the switch stops being compile-time only (dynamic `process.env[...]`, or any
   `AsyncStorage` / `SecureStore` / `expo-constants` / `fetch` / route-param read);
6. the visible indicator is removed, ungated, or no longer mounted at the root.

`tests/diagnosticSecurityBuild.test.cjs` asserts the same invariants plus the
exact waived-set contents and the position of the filter relative to
`computeRiskScore()`.

---

## 6. Turning it off

```bash
# local build: just unset the variables (new shell, or:)
unset EXPO_PUBLIC_SECURITY_TEST_BUILD EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK EAS_BUILD_PROFILE
```

No source change is needed — with the keys absent, `SECURITY_TEST_BUILD`
compiles to `false`, `isSecurityTestBypassed()` always returns `false`, and the
banner renders `null`. Delete the installed diagnostic APK and reinstall a
normal build.
