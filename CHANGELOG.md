# MedAcademy Mobile — Changelog V553 → V562

All dates are UTC+8 (Asia/Shanghai). Commits are from the `main` branch (shallow clone).

---

## V562 — Security Module: Complete Audit & Hardening
**Date:** 2026-08-01  
**Commit:** `0bc9fff`

### Security Changes
- **VPN Detection (Android) — previously always `false`:**  
  Replaced `expo-network.NetworkStateType.VPN` (only fires when VPN is primary transport) with a two-tier native approach:  
  - Tier 1: `ConnectivityManager.getAllNetworks()` + `getNetworkCapabilities(TRANSPORT_VPN)` — detects VPN-over-WiFi and VPN-over-cellular  
  - Tier 2: `NetworkInterface` scan for `tun*`, `vpn*`, `ppp*`, `ipsec*` interfaces  
- **Root Detection (Android) — was single JS check:**  
  Added 6 independent native heuristics in `SecurityModule.kt`:  
  1. 20+ `su` binary path scan  
  2. Dangerous system props (`ro.debuggable=1`, `ro.secure=0`)  
  3. `test-keys` in `Build.TAGS`  
  4. `/system` write test  
  5. Shell `which su`  
  6. Root management package scan (Magisk, SuperSU, KingRoot, etc.)  
- **Emulator Detection (Android) — was single JS check:**  
  Added 5 native heuristics:  
  1. `Build.FINGERPRINT` contains `generic`/`unknown`/`vbox`  
  2. `Build.MODEL`/`Build.HARDWARE` matches goldfish/ranchu/Genymotion/sdk  
  3. `Build.MANUFACTURER` is `unknown` or Genymotion  
  4. QEMU system properties (`ro.kernel.qemu`, `ro.product.device`)  
  5. Sensor count = 0  
- **Mock Location Detection (Android) — completely absent before:**  
  Three-tier detection added:  
  1. `AppOpsManager.OPSTR_MOCK_LOCATION` for all installed apps (API 23+)  
  2. `Settings.Secure.ALLOW_MOCK_LOCATION` legacy flag (pre-API 23)  
  3. Installed packages holding `ACCESS_MOCK_LOCATION` permission  
- **Removed silent `catch { return null }` swallowing** across all detectors in `security.ts`  
- **All Phase 2 detectors** (Frida, Xposed, Magisk, Overlay, Tamper) now log results  
- **`getSecurityFlags()`** wires all 4 new Phase 3 flags: `vpnDetected`, `rootDetected`, `emulatorDetected`, `mockLocationDetected`  
- **`runSecurityChecks()`** dumps complete raw native flags at startup; `detectMockLocation()` added and wired in

### Native Android Changes
- `android/app/src/main/java/com/medacademy/security/SecurityModule.kt`:  
  - Added `isVpnActive()`, `isRooted()`, `isEmulator()`, `isMockLocationEnabled()` as individual `@ReactMethod` exports  
  - Added private `detectVpn()`, `detectRoot()`, `detectEmulator()`, `detectMockLocation()` implementations  
  - Added imports: `ConnectivityManager`, `NetworkCapabilities`, `NetworkInterface`, `SensorManager`, `Sensor`, `LocationManager`, `AppOpsManager`, `BufferedReader`, `InputStreamReader`  
  - `getSecurityFlags()` now returns 15 boolean flags (was 11)  
  - `Log.d(TAG, ...)` added at every decision branch for real-device diagnostics

### UI Changes
- `src/app/(app)/(superadmin)/sec-diag.tsx` fully rewritten:  
  - **Live Device Checks panel** — 14 native security checks shown with DETECTED/CLEAR badges  
  - **"Run Checks" button** — re-runs `getNativeSecurityFlags()` on demand  
  - **"Native Threats" counter** in summary row  
  - Raw boolean value shown next to each check  
  - Last-checked timestamp  
  - Error state if native module unavailable

### Files Modified
- `android/app/src/main/java/com/medacademy/security/SecurityModule.kt`
- `src/app/(app)/(superadmin)/sec-diag.tsx`
- `src/lib/nativeSecurity.ts`
- `src/lib/security.ts`
- `app.json` (version bump)

---

## V561 — English Digit Standardization: Complete
**Date:** 2026-08-01  
**Commit:** `692f7b9`

### Bug Fixes
- Fixed all `toLocaleString()` and `toLocaleDateString()` calls that used the device's system locale (causing Arabic/Persian numerals on some Android devices)  
- All date/time formatting now explicitly passes `'en-US'` locale with consistent options: `{ month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }`  
- `undefined` locale arguments replaced with `'en-US'` in enrollment-manager and other files  
- `src/lib/currency.ts` and `src/lib/utils.ts` hardened with explicit locale

### Files Modified (47 files total)
**Admin screens:**
- `src/app/(app)/(admin)/admin-credits.tsx`
- `src/app/(app)/(admin)/audit.tsx`
- `src/app/(app)/(admin)/codes.tsx`
- `src/app/(app)/(admin)/db-audit.tsx`
- `src/app/(app)/(admin)/doctor-credit-timeline.tsx`
- `src/app/(app)/(admin)/doctor-earnings.tsx`
- `src/app/(app)/(admin)/enrollment-manager.tsx`
- `src/app/(app)/(admin)/global-search.tsx`
- `src/app/(app)/(admin)/notifications-center.tsx`
- `src/app/(app)/(admin)/reports.tsx`
- `src/app/(app)/(admin)/revenue-analytics.tsx`
- `src/app/(app)/(admin)/users.tsx`
- `src/app/(app)/(admin)/video-health.tsx`
- `src/app/(app)/(admin)/video-monitor.tsx`
- `src/app/(app)/(admin)/video-settings.tsx`

**Doctor screens:**
- `src/app/(app)/(doctor)/courses.tsx`
- `src/app/(app)/(doctor)/credits.tsx`
- `src/app/(app)/(doctor)/dr-earnings.tsx`
- `src/app/(app)/(doctor)/dr-overview.tsx`
- `src/app/(app)/(doctor)/dr-profile.tsx`
- `src/app/(app)/(doctor)/students.tsx`
- `src/app/(app)/(doctor)/video-library.tsx`

**Superadmin screens:**
- `src/app/(app)/(superadmin)/health.tsx`
- `src/app/(app)/(superadmin)/impersonation.tsx`
- `src/app/(app)/(superadmin)/sa-audit.tsx`
- `src/app/(app)/(superadmin)/sa-credits.tsx`
- `src/app/(app)/(superadmin)/sa-doctor-earnings.tsx`
- `src/app/(app)/(superadmin)/sa-overview.tsx`
- `src/app/(app)/(superadmin)/sa-users.tsx`
- `src/app/(app)/(superadmin)/sec-dashboard.tsx`
- `src/app/(app)/(superadmin)/sec-diag.tsx`
- `src/app/(app)/(superadmin)/trash-bin.tsx`
- `src/app/(app)/(superadmin)/violation-management.tsx`

**Shared app screens:**
- `src/app/(app)/archived-courses/index.tsx`
- `src/app/(app)/course-builder/[id].tsx`
- `src/app/(app)/course/[id].tsx`
- `src/app/(app)/lesson-editor/[id].tsx`
- `src/app/(app)/login-history.tsx`
- `src/app/(app)/my-devices.tsx`
- `src/app/(app)/notifications.tsx`
- `src/app/(app)/user-activity.tsx`

**Components & Libraries:**
- `src/components/VideoHealthDetails.tsx`
- `src/components/VideoLibraryPicker.tsx`
- `src/lib/currency.ts`
- `src/lib/utils.ts`
- `app.json` (version bump)

---

## V560 — Contact Us Screen Redesigned
**Date:** 2026-08-01  
**Commit:** `1335df4`

### UI Changes
- `src/app/(app)/info/contact.tsx` fully redesigned with Neumorphic styling  
- Added structured contact sections (email, phone, social links)  
- Improved layout, typography, and card hierarchy

### Files Modified
- `src/app/(app)/info/contact.tsx`
- `app.json` (version bump)

---

## V559 — Session Isolation Bug Fixed
**Date:** 2026-08-01  
**Commit:** `45c8b11`

### Bug Fixes
- Fixed session isolation issue where switching between user roles (student/doctor/admin) could retain stale state from the previous session  
- `src/app/(app)/_layout.tsx`: Added role-change detection that clears persisted state before mounting the new session  
- `src/components/DrawerNav.tsx`: Clears cached user data on logout/role-switch  
- `src/lib/store.ts`: Added `clearSessionState()` and ensured store resets on auth change  
- `src/app/(app)/(doctor)/dr-profile.tsx`: Reset local state on unmount to prevent ghost data  
- `src/app/(app)/(student)/profile.tsx`: Same fix as dr-profile

### Files Modified
- `src/app/(app)/_layout.tsx`
- `src/app/(app)/(doctor)/dr-profile.tsx`
- `src/app/(app)/(student)/profile.tsx`
- `src/components/DrawerNav.tsx`
- `src/lib/store.ts`
- `app.json` (version bump)

---

## V558 — Notifications Header & Empty State Redesigned
**Date:** 2026-08-01  
**Commit:** `ad35c95`

### UI Changes
- `src/app/(app)/notifications.tsx` redesigned:  
  - New header with notification count badge  
  - Redesigned empty state with icon and descriptive copy  
  - Improved list item layout and read/unread visual distinction  
  - Pull-to-refresh indicator improvements

### Files Modified
- `src/app/(app)/notifications.tsx`
- `app.json` (version bump)

---

## V557 — App Icon
**Date:** 2026-08-01  
**Commit:** `8c4183a`

### UI Changes
- Updated app icon assets: `assets/icon.png`, `assets/adaptive-icon.png`, `assets/brand/icon.png`  
- `app.json` updated to reference new icon paths

### Files Modified
- `app.json`
- `assets/icon.png` *(binary asset)*
- `assets/adaptive-icon.png` *(binary asset)*
- `assets/brand/icon.png` *(binary asset)*

---

## V556 — (Prior to this handoff range — see previous CHANGELOG)
*Not included in this package.*

---

## V555 — (Prior to this handoff range)
*Not included in this package.*

---

## V554 — (Prior to this handoff range)
*Not included in this package.*

---

## V553 — (Prior to this handoff range — baseline for this delta)
*Not included in this package. This is the baseline version against which V554–V562 changes were applied.*

---

*Note: The version numbering V553–V562 maps to the git commit sequence as follows:*

| Version | Git Commit | Date | Title |
|---------|-----------|------|-------|
| V562 | `0bc9fff` | 2026-08-01 | Security Module — Complete Audit & Hardening |
| V561 | `692f7b9` | 2026-08-01 | English Digit Standardization — Complete |
| V560 | `1335df4` | 2026-08-01 | Contact Us Screen Redesigned |
| V559 | `45c8b11` | 2026-08-01 | Session Isolation Bug Fixed |
| V558 | `ad35c95` | 2026-08-01 | Notifications Header & Empty State Redesigned |
| V557 | `8c4183a` | 2026-08-01 | App Icon |
| V553–V556 | *(baseline)* | — | Pre-existing features (see project history) |
