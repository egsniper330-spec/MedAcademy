# Temporarily disabled security checks (source-level)

Four local device-environment checks are disabled **in the source**, in
`src/lib/security.ts`, so the APK behaves normally on a test tablet that has USB
debugging / Developer Options / Magisk / Xposed enabled. This is a plain code
configuration — there is no build flag, no environment variable, no diagnostic
profile and no special build step. The APK is built by the normal
`.github/workflows/android-apk.yml` run.

## What is disabled

`TEMPORARILY_DISABLED_CHECKS` in `src/lib/security.ts`:

| Finding type | Disabled |
|---|---|
| `adb_enabled` (USB debugging) | yes |
| `developer_options_enabled` (Developer Options) | yes |
| `magisk_detected` (Magisk / Zygisk) | yes |
| `xposed_detected` (Xposed / LSPosed) | yes |

These four findings are dropped from the aggregated threat list **before** the
risk score and before every blocking or warning decision:

```ts
].filter((t): t is SecurityThreat => t !== null && t.detected)
  .filter((t) => !isCheckTemporarilyDisabled(t));   // ← the only change
```

Consequences: no login/dashboard block, no security warning screen, no routing
restriction for these four types, and they add nothing to the risk score.
The detectors themselves are untouched and still run; only their verdict for
these four types is ignored.

## What remains fully enforced

- Root detection **other than Magisk**, Frida detection, debugger detection.
- App integrity / tampering, Play Integrity, certificate pinning (TLS).
- VPN / proxy policy and overlay (tapjacking) protection.
- Screen-recording / screenshot protection, watermarks and PDF protection.
- Authentication, session validation, refresh tokens, backend authorization and
  every server-side check (no backend change at all).

Nothing else in `security.ts` or any other file was changed for this.

## How to re-enable

In `src/lib/security.ts`, set the entry to `false` (or delete the line):

```ts
export const TEMPORARILY_DISABLED_CHECKS = Object.freeze({
  adb_enabled: false,               // ← enforcement restored
  xposed_detected: false,
  magisk_detected: false,
  developer_options_enabled: false,
});
```

Ship a new build. That is the whole procedure: the table is the switch.

## Build

- Workflow: existing `.github/workflows/android-apk.yml` (`workflow_dispatch`),
  `:app:assembleRelease`, existing signing identity.
- `app.json`: `expo.android.versionCode` = **224** for this build (223 was an
  earlier, never-installed diagnostic build).
- Artifact: **MedAcademy-Android-APK** → `MedAcademy-v1.0.0-224.apk`.

## Device check

```bash
adb shell dumpsys package com.medacademy.app | grep versionCode    # expect 224
adb logcat | grep -E "detected threats|riskScore"
```

The device may still report `adb_enabled`, `xposed_detected`,
`magisk_detected`, `developer_options_enabled` in the detector output — that is
expected. What must be gone is any blocking consequence: login and the student
dashboard must open, and the risk score must not include those four types.
