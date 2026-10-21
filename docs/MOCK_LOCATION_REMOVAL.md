# Mock-location detection — removed (investigation record)

**Status:** removed from the client and from backend blocking enforcement.
**Reported on:** Android 16 / API 36 device, release install.
**Not verified on that physical phone** (it was not available for inspection); the
conclusions below are from the code, the Android platform contract, and the
device report itself.

---

## 1. What the device reported

| Signal | Report value |
|---|---|
| Developer options | off |
| USB debugging (ADB) | off |
| Debugger connected | off |
| Test-only build flag | off |
| Emulator / virtual device | off |
| **Mock-location app selected** | **on** |

Result: finding **“Mock Location Detected”**, `debug_detected`, device risk score
**20**, login blocked at the pre-auth gate.

## 2. Exact source of the `ON`

The `ON` came from the **native flag only**. The full path was:

```
SecurityModule.detectMockLocation()                       (plugins/withSecurityModule.js → generated SecurityModule.kt)
  └─ AppOpsManager.checkOpNoThrow(OPSTR_MOCK_LOCATION, appInfo.uid, appInfo.packageName)
       for EVERY installed package; return true on the first MODE_ALLOWED
  └─ getSecurityFlags() → putBoolean("mockLocationDetected", mockLoc)
       (wrapped in runCatching { … }.getOrDefault(false))
  └─ src/lib/nativeSecurity.ts  → NativeSecurityFlags.mockLocationDetected
       (500 ms batch cache; fail-safe default false; `_lastFlagsCallUnavailable`
        recorded when the module call fails)
  └─ src/lib/security.ts detectMockLocation()
       → { type: 'debug_detected', detectionMethod: 'Mock location enabled' }
  └─ DETECTION_TO_EVENT / computeRiskScore → debug_detected = 20, bucket `debug`
       → policy `debug: 'block_login'` → login blocked
  └─ resolveFindingCopyKey('debug_detected', 'Mock location enabled')
       → 'mock_location_detected' → “Mock Location Detected”
  └─ SecuritySignalReport REPORT_SIGNALS row “Mock-location app selected” (temporary report, since removed)
  └─ deviceKey.collectEvidenceFlags() → evidence.mock_location = true
       → backend SecurityEvidenceService::deriveAssurance $blocking[] → BLOCKED
```

Two earlier fixes had already removed two planes of this detector:

* the **ACCESS_MOCK_LOCATION permission-holder scan** (a preinstalled package
  merely *holding* the permission blocked a stock tablet);
* the **unguarded `Settings.Secure.ALLOW_MOCK_LOCATION`** read (a stale `1`
  left behind by an old app/MDM blocked modern devices).

What remained — and produced this report — was the **cross-UID AppOps read**. The
deprecated setting was *not* the source (it was already API-guarded, and the
generated Kotlin still logged it without ever returning it on API ≥ 23).

## 3. Why the remaining plane cannot establish the condition

**The query itself is privileged.** `AppOpsManager.checkOpNoThrow(op, uid, pkg)`
for a *different* UID is a cross-package app-ops read. The platform enforces
`android.permission.UPDATE_APP_OPS_STATS`, whose protection level is
`signature|privileged|installer|role` — a normal release APK cannot hold it. On
stock AOSP the app-ops service rejects the call, so the call throws and
`getOrDefault(false)` reported the **coverage gap as “no mock app”**. On ROMs that
do answer, the check silently succeeds.

**What the answer means on those ROMs.** The value is the per-package
`android:mock_location` app-op **mode**, which is *persisted state*:

* it is **not cleared** when Developer options are switched off;
* it can be **preset by the OEM** for a preinstalled package the user never chose;
* it records “this package *may* mock locations”, not “a mock provider is selected
  right now” and not “locations are being mocked”.

So `MODE_ALLOWED` for *some* installed package proves none of the three facts the
signal was read as (Developer options on / a mock app selected by the user /
mocking happening now). On the reporting device it coexisted with **Developer
options off** — exactly the stale/preset case the platform does not distinguish.

**No concrete security requirement.** MedAcademy has no location-based feature
(no maps, no geofencing, no location-gated content). A mock provider cannot defeat
any protection this app enforces — content protection, DRM, watermarking, device
binding, integrity and the remaining device-state checks are all independent of
location. The check only added risk 20 and a login block.

**Therefore:** the result could not be “corrected” into a truthful `unknown`
either, because **no measurable path exists at all** for a third-party APK — the
fail-safe (`false`) would be a false clean claim on lax ROMs, and a permanently
`unknown`/`unavailable` field would describe a detector that no longer measures
anything. The check was removed instead of being neutralised. This is a
technically justified correction, not a weight change, exemption or policy bypass:
every other device-state check keeps its exact behaviour.

## 4. What was removed

| Layer | Change |
|---|---|
| `plugins/withSecurityModule.js` | `detectMockLocation()`, the `isMockLocationEnabled` ReactMethod, the `mockLocationDetected` flag and its log line, and the now-unused `AppOpsManager` / `LocationManager` imports. A removal note records the platform evidence so the detector is not “restored” without re-reading it. |
| generated `android/.../SecurityModule.kt` | Same removal (generated from the plugin; `expo prebuild` reproduces it). |
| `src/lib/nativeSecurity.ts` | `mockLocationDetected` dropped from `NativeSecurityFlags` and from the fail-safe defaults — no ON/OFF/fake-unavailable field remains. |
| `src/lib/security.ts` | `detectMockLocation()` and its aggregation slot removed; no `debug_detected` producer and no risk contribution remains. |
| `src/lib/securityStateModel.ts` | `resolveFindingCopyKey` no longer routes a mock-location method to a copy key. |
| `src/lib/securitySignalReport.ts`, `SecuritySignalReport` | **Removed entirely** once the investigation closed: the temporary Device Security Report is no longer rendered on any screen, and both files are deleted. `expo-clipboard` / `expo-device` stay (used elsewhere). |
| `src/app/(auth)/security-warning.tsx`, `(app)/security-warning.tsx`, `(app)/security-gate.tsx` | `mock_location_detected` copy entries removed (no dead UI path). |
| `src/app/(app)/security-diagnostics.tsx`, `(hubs)/sec-diag.tsx` | Diagnostics rows/entries removed; the API-limits card now states the removal and why. |
| `src/lib/deviceKey.ts` | `evidence.mock_location` no longer sent. |
| `backend/src/Services/SecurityEvidenceService.php` | `'mock_location'` removed from `$blocking` so persisted evidence rows written by older APKs can no longer deny login. **Backend deploy required.** |

**Deliberately untouched:** Developer options, ADB, debugger, test-only build,
emulator, root, Magisk, Frida/Xposed, overlay, tamper/signature, VPN/proxy, Play
Integrity, multi-window, forced update, Super Admin exemption, server-side
authorization, `debug_detected` weight 20 and `debug → block_login`.

## 5. What remains unconfirmed without the phone

* which package held `MODE_ALLOWED` on that exact ROM (the log line
  `[detectMockLocation] MOCK_LOCATION granted to …` would name it);
* whether that ROM enforces `UPDATE_APP_OPS_STATS` (it clearly answered the query);
* whether the app-op survived a Developer-options toggle on that device.

None of these change the decision: the signal cannot distinguish those cases, so
it was never able to support a login block.

## 6. Verification

Automated (`npm test`):

* `tests/mockLocationDetection.test.cjs` — removal contract across native, JS,
  UI, report and backend layers; surviving detectors and risk semantics pinned.
* `tests/debugModeFindingDiagnostics.test.cjs` — report cannot print a mock row;
  API 36 snapshots; unavailable vs measured-`false`; freshness/caching.
* `tests/securityGateFindingCopy.test.cjs` — no copy key, no weakened block.
* `tests/appAttestDeferral.test.cjs` — `mockLocationDetected` absent from the engine.

**Physical-device state:** not verified on the affected phone. A new APK is
required to ship the removal (JS + native module change); until it is installed,
the old build keeps blocking that device.
