# MedAcademy Mobile — Project Status

**As of:** 2026-08-01  
**Latest version:** V562  
**Stack:** Expo SDK 55 · React Native 0.83.2 · expo-router · NativeWind v4 · TypeScript · Supabase

---

## Current Project State

The app is a production-ready medical education mobile platform (Android + iOS) with the following role tiers: Student, Doctor, Admin, Superadmin.

### ✅ Completed & Stable Features
- **Authentication:** Email/phone OTP login, OAuth, anonymous login, role-based routing via `Stack.Protected`
- **Video Player:** Secure video playback with DRM-style access control, content protection, screenshot/recording blocking
- **Course System:** Course builder, lesson editor, enrollment management, archived courses
- **Credits & Earnings:** Doctor credit timeline, earnings dashboards, admin credit management
- **User Management:** Admin users panel, suspension, device management, multi-device detection
- **Notifications:** Push notification center with read/unread state, empty state, header badge
- **Security Framework:**
  - Screenshot protection (FLAG_SECURE + iOS UIScreen overlay) — **working**
  - Screen recording detection — **working**
  - Developer options / ADB detection — **working** (native)
  - Frida / Xposed / Magisk detection — **working** (native Phase 2)
  - Overlay / tapjacking detection — **working** (native)
  - Signature & tamper detection — **working** (native, requires trusted cert config)
  - Play Integrity (Android) / App Attest (iOS) — **working** (requires server key config)
  - SSL pinning — **implemented, requires OkHttp cert hash configuration**
  - **VPN detection** — **fixed in V562** (was always false, now uses CM + NetworkInterface)
  - **Root detection** — **fixed in V562** (6-method native, was single JS check)
  - **Emulator detection** — **fixed in V562** (5-method native, was single JS check)
  - **Mock location detection** — **added in V562** (was completely absent)
- **Diagnostics:** Live native security check panel in `/sec-diag` (V562) with per-check status and "Run Checks" button
- **Internationalisation:** All date/time formatting uses explicit `'en-US'` locale (V561) — no more Arabic numerals on Arabic-locale devices
- **Session Isolation:** Fixed (V559) — no stale state when switching roles
- **App Icon:** Updated (V557)
- **Contact Screen:** Redesigned with Neumorphic layout (V560)

---

## Known Remaining Issues

### 🔴 Critical
- **SecurityModule.kt — not re-committed:** The V562 native Android changes to `SecurityModule.kt` were applied in the current dev session. The file is correct on disk but `git status` shows `app.json` as the only modified file. The `.kt` file needs to be committed before the next EAS build to ensure it is included. **Action: run `git add android/... && git commit -m "v562: SecurityModule Phase 3"` before next build.**
- **SSL Pinning cert hash not configured:** `SecurityModule.kt` and the iOS equivalent reference a placeholder cert fingerprint. Production builds need the actual Supabase/CDN SHA-256 cert hash set in the security guards configuration. Until this is set, `SIGNATURE_CHECK_READY = false` and signature enforcement is skipped.

### 🟡 Moderate
- **Play Integrity server key:** The `verify-app-integrity` Edge Function requires a Google Play Integrity API service account key set as a Supabase secret (`PLAY_INTEGRITY_DECRYPTION_KEY`, `PLAY_INTEGRITY_VERIFICATION_KEY`). Without this, Play Integrity always returns a degraded verdict.
- **App Attest (iOS):** Requires `APP_ATTEST_TEAM_ID` and the app to be built with the `com.apple.developer.devicecheck.appattest-environment` entitlement. DeviceCheck fallback works without it but provides weaker integrity signals.
- **Mock location detection on Android 14+:** `AppOpsManager.getPackagesForOps()` behavior changed in Android 14. The current implementation uses `getInstalledApplications()` + per-package `checkOpNoThrow()` which is still valid but may miss some cases on Android 14+ in certain manufacturer ROM variants. Recommend testing on Pixel with Android 14/15.
- **Root detection — Zygisk DenyList:** When Magisk DenyList is enabled, the app process is isolated and su binary paths may be hidden. The current 6-method check is best-effort; Zygisk with DenyList can evade it on fully configured root setups.

### 🟢 Minor
- **`exportUtils.ts` date formatting:** Uses `toLocaleDateString('en-US')` but the export CSV format should ideally use ISO 8601 (`YYYY-MM-DD`) for spreadsheet compatibility. Low priority.
- **`sec-diag.tsx` — `testOnlyBuild` flag not shown:** The live panel shows 14 checks but omits `testOnlyBuild`. Consider adding it for completeness.
- **`PageHeader` import unused in sec-diag.tsx:** `PageHeader` is imported but not used after the V562 rewrite. Harmless but should be cleaned up before next lint pass.

---

## Pending Features

| Feature | Priority | Notes |
|---------|----------|-------|
| iOS VPN detection improvement | Medium | IOSSecurityModule already has utun/ipsec scan; consider adding NEVPNManager status check for more accurate detection |
| Mock location — isFromMockProvider per-fix | Medium | Add real-time GPS location listener that checks `location.isFromMockProvider()` on each location update (in addition to the static AppOpsManager check) |
| Security policy remote config | Medium | Admin UI to toggle which detections trigger block vs. warn vs. log — partially scaffolded in `sec-dashboard.tsx` |
| Biometric re-auth on sensitive actions | Low | Planned for admin credential operations |
| App Attest full attestation flow | Low | Currently uses DeviceCheck fallback; full attestation requires server-side assertion verification |
| Android 15 predictive back gesture | Low | Back navigation uses legacy `BackHandler`; Android 15 predictive back not yet wired |

---

## What Still Requires Testing

### Must test on real hardware before production release:

1. **VPN Detection (V562)**
   - Test with: ExpressVPN, NordVPN, WireGuard app, built-in Android VPN profiles
   - Test scenarios: VPN over WiFi, VPN over cellular, split-tunnel VPN
   - Expected: `vpnDetected = true` in `/sec-diag` Live Device Checks panel
   - Check logcat tag `SecurityModule` for `[detectVpn]` lines

2. **Root Detection (V562)**
   - Test with: Magisk (standard), Magisk + DenyList, KingRoot
   - Expected: `rootDetected = true`
   - Check logcat for `[detectRoot] suBinaryFound`, `rootPackageFound`, etc.

3. **Emulator Detection (V562)**
   - Test on: Android Studio AVD (should detect), Genymotion (should detect), real device (should NOT detect)
   - Check `[detectEmulator]` logcat lines

4. **Mock Location Detection (V562)**
   - Enable Developer Options → Select mock location app → set any fake GPS app
   - Expected: `mockLocationDetected = true`
   - Check `[detectMockLocation]` logcat lines

5. **Session Isolation (V559)**
   - Log in as Student → log out → log in as Doctor → verify no Student data visible
   - Log in as Admin → force-kill app → reopen → verify correct role restored

6. **English Digits (V561)**
   - Set device language to Arabic or Persian
   - Open any date-showing screen (audit log, credits, enrollment)
   - Expected: Western/ASCII digits (1 2 3), not Arabic-Indic (١ ٢ ٣)

7. **EAS Build (iOS + Android)**
   - Next EAS build should include the V562 SecurityModule.kt commit
   - Verify `npx tsc --noEmit` passes (confirmed clean as of V562)
   - Verify no new Swift `RCTEventEmitter` compilation errors (was fixed in prior versions via bridging header)

---

## Build & Deployment Notes

- **EAS build profile:** `production` (uses `eas.json` production credentials)
- **Minimum Android SDK:** 23 (some security checks use API 23+ with fallbacks)
- **Minimum iOS:** 14.0 (App Attest requires 14+; DeviceCheck fallback for older)
- **TypeScript:** Clean as of V562 (`npx tsc --noEmit` = 0 errors)
- **Patch:** `patches/expo-router+55.0.5.patch` must be applied — maintained via `patch-package` in `postinstall`
