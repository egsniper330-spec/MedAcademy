# Changelog — MedAcademy V562 → V568

**Version Range:** V562 (initial baseline) → V568 (Complete UI/UX Responsiveness Audit)  
**Date:** 2026-07-13  
**Total Files Changed:** 50 (49 modified, 1 newly added, 0 deleted)

---

## Version History

| Version | Commit   | Description |
|---------|----------|-------------|
| V562    | `4081345`| Initial project setup — baseline |
| V563    | —        | Pre-session state (no separate commit) |
| V564    | `2a0b3c0` | Notifications Header — Redesigned |
| V565    | `6ab598e` | Android Security Module — Full Root-Cause Investigation & Fix |
| V566    | `8ef3562` | Preview Fixed |
| V567    | `8ef3562` | Preview Fixed (same commit) |
| V568    | `4cc2f09` | Complete UI/UX Responsiveness Audit |

---

## Newly Added Files

| File | Description |
|------|-------------|
| `src/app/(app)/security-diagnostics.tsx` | **NEW** — Full Security Diagnostics screen (460 lines). Accessible from the superadmin overview. Shows native `SecurityModule` registration proof, raw `getSecurityFlags()` JSON, execution time, per-detector value with native API explanation, and Android API restriction reference. Added in V566. |

---

## Modified Files

### Configuration

| File | Change Summary |
|------|----------------|
| `app.json` | Updated app metadata to reflect latest version state. |
| `plugins/withSecurityModule.js` | Re-synced the embedded Kotlin template with the clean on-disk `SecurityModule.kt` to prevent re-corruption of the null-byte bug on future `expo prebuild --clean` runs. |

### Root Layout

| File | Change Summary |
|------|----------------|
| `src/app/(app)/_layout.tsx` | Added `SafeAreaProvider` as the outermost wrapper to ensure `useSafeAreaInsets()` returns correct values on Android (was returning `{top:0, bottom:0}` on all Android devices without it). |

### Auth Screens

| File | Change Summary |
|------|----------------|
| `src/app/(auth)/force-password-change.tsx` | Added `useSafeAreaInsets`; replaced hardcoded `paddingBottom: 60` with `Math.max(insets.bottom, 30) + 30` so the submit button is never hidden behind gesture nav bar. |
| `src/app/(auth)/security-warning.tsx` | Added `useSafeAreaInsets`; replaced hardcoded `paddingBottom: 48` with `Math.max(insets.bottom, 24) + 24`. |

### App Screens — Shared

| File | Change Summary |
|------|----------------|
| `src/app/(app)/notifications.tsx` | Major redesign (139 lines changed). Replaced fully custom fixed app-bar (hardcoded `APP_BAR_CONTENT_HEIGHT = 56`) with the standard `<PageHeader>` component. Added `DrawerProvider` + `DrawerNav` wrapper so hamburger menu works correctly. Recalculated empty-state vertical centering formula to match new header geometry. |
| `src/app/(app)/course/[id].tsx` | Replaced hardcoded `top: 50` absolute back-button overlay with `top: insets.top + 10` — now correctly clears notch, Dynamic Island, and Android punch-hole on all devices. Added `useSafeAreaInsets` import and hook. Added bottom content padding. |
| `src/app/(app)/course-builder/[id].tsx` | Updated inline header top offset from `insets.top > 0 ? insets.top + 8 : 20` to `insets.top > 0 ? insets.top + 10 : 24`. Added `hitSlop: 8` to back button. Added responsive bottom padding. |
| `src/app/(app)/lesson-editor/[id].tsx` | Same inline header offset fix as `course-builder`. Added `useSafeAreaInsets`; responsive bottom padding via `Math.max(insets.bottom, 24) + 24`. |
| `src/app/(app)/edit-profile.tsx` | Added `useSafeAreaInsets`; replaced hardcoded bottom padding with insets-aware value. |
| `src/app/(app)/security.tsx` | Added `useSafeAreaInsets`; replaced hardcoded bottom padding with insets-aware value. |
| `src/app/(app)/my-devices.tsx` | Added `useSafeAreaInsets`; replaced hardcoded bottom padding with insets-aware value. |
| `src/app/(app)/login-history.tsx` | Added `useSafeAreaInsets`; replaced hardcoded `paddingBottom: 32` with `Math.max(insets.bottom, 16) + 16`. |
| `src/app/(app)/user-activity.tsx` | Added `useSafeAreaInsets`; replaced hardcoded `paddingBottom: 60` with `Math.max(insets.bottom, 30) + 30`. |
| `src/app/(app)/archived-courses/index.tsx` | Added `useSafeAreaInsets`; replaced hardcoded bottom padding with insets-aware value. |
| `src/app/(app)/info/about.tsx` | Added `useSafeAreaInsets`; replaced hardcoded bottom padding with insets-aware value. |
| `src/app/(app)/info/privacy.tsx` | Added `useSafeAreaInsets`; replaced hardcoded bottom padding with insets-aware value. |
| `src/app/(app)/info/terms.tsx` | Added `useSafeAreaInsets`; replaced hardcoded bottom padding with insets-aware value. |

### App Screens — Student Role

| File | Change Summary |
|------|----------------|
| `src/app/(app)/(student)/dashboard.tsx` | Added `useSafeAreaInsets`; replaced hardcoded `paddingBottom` with `Math.max(insets.bottom, N/2) + N/2`. |
| `src/app/(app)/(student)/explore.tsx` | Added `useSafeAreaInsets`; responsive bottom padding for tab-bar overlap fix. |
| `src/app/(app)/(student)/my-courses.tsx` | Added `useSafeAreaInsets`; added `contentContainerStyle` with insets-aware bottom padding. |
| `src/app/(app)/(student)/profile.tsx` | Added `useSafeAreaInsets`; replaced hardcoded bottom padding with insets-aware value. |

### App Screens — Doctor Role

| File | Change Summary |
|------|----------------|
| `src/app/(app)/(doctor)/dr-overview.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(doctor)/courses.tsx` | Added `useSafeAreaInsets`; responsive bottom padding; removed absolute positioning from search icon. |
| `src/app/(app)/(doctor)/dr-profile.tsx` | Added `useSafeAreaInsets` to main `DoctorProfile` component AND to `EarningsTab` sub-component (which was previously missing its own hook, causing `insets` to be undefined in the tab's render scope). |
| `src/app/(app)/(doctor)/dr-earnings.tsx` | Added `useSafeAreaInsets` to `StudentProfileModal` sub-component (injected correctly in function body, not type-params block). Fixed `paddingBottom: 48` in modal `ScrollView` to `Math.max(insets.bottom, 24) + 24`. |
| `src/app/(app)/(doctor)/video-library.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(doctor)/student-credentials.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(doctor)/bulk-import-students.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(doctor)/create-student.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |

### App Screens — Admin Role

| File | Change Summary |
|------|----------------|
| `src/app/(app)/(admin)/admin-overview.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(admin)/video-settings.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(admin)/video-health.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(admin)/system-providers.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(admin)/enrollment-manager.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(admin)/audit.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(admin)/codes.tsx` | Added `useSafeAreaInsets`; responsive bottom padding; removed `position: 'absolute'` from search icon — icon now sits in flex row. |
| `src/app/(app)/(admin)/bulk-credits.tsx` | Added `useSafeAreaInsets`; responsive bottom padding; removed absolute positioning from search icon. |
| `src/app/(app)/(admin)/code-history.tsx` | Added `useSafeAreaInsets`; responsive bottom padding; removed absolute positioning from search icon. |

### App Screens — Superadmin Role

| File | Change Summary |
|------|----------------|
| `src/app/(app)/(superadmin)/sa-overview.tsx` | Added link/button to new Security Diagnostics screen under Platform & Settings. |
| `src/app/(app)/(superadmin)/violation-management.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(superadmin)/sec-policies.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(superadmin)/trash-bin.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(superadmin)/sec-dashboard.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(superadmin)/sa-audit.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(superadmin)/content-protection.tsx` | Added `useSafeAreaInsets`; responsive bottom padding. |
| `src/app/(app)/(superadmin)/sa-credits.tsx` | Added `useSafeAreaInsets`; responsive bottom padding; removed absolute positioning from search icon. |
| `src/app/(app)/(superadmin)/sa-doctor-earnings.tsx` | Added `useSafeAreaInsets` to `StudentProfileModal` sub-component (same fix as `dr-earnings.tsx`). Responsive bottom padding. |

---

## Deleted Files

None.

---

## Summary of Changes by Category

| Category | Files | Description |
|----------|-------|-------------|
| Safe-area bottom padding | 47 | All hardcoded `paddingBottom: N` replaced with `Math.max(insets.bottom, N/2) + N/2` |
| Back-button overlay positioning | 1 | `course/[id].tsx`: `top: 50` → `insets.top + 10` |
| Sub-component insets injection | 3 | `EarningsTab`, `StudentProfileModal` (×2) — hook added to function body scope |
| Search icon positioning | 4 | `codes`, `bulk-credits`, `sa-credits`, `code-history`: removed `position: 'absolute'` |
| Notifications header | 1 | Full redesign using `PageHeader` + `DrawerProvider` wrapper |
| Android native security | 2 | `SecurityModule.kt` null-byte fix, `withSecurityModule.js` re-sync |
| New screens | 1 | `security-diagnostics.tsx` — superadmin security debug screen |
| Root layout | 1 | `SafeAreaProvider` added as outermost tree wrapper |

---

*Generated by MedAcademy patch tooling — 2026-07-13*
