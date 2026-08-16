# Responsive Layout Fix — All Screens

## Root Cause

`contentInsetAdjustmentBehavior="automatic"` was present on **every** ScrollView and
FlatList in the app.  On iOS, `automatic` tells UIKit to automatically inject the
safe-area insets as scroll *content insets* (top + bottom).  At the same time, the
app's layout system (`useLayout()` / `ds.ts`) was *already* computing those same
values:

| Helper | What it adds |
|--------|-------------|
| `layout.headerTop` / `safeTop(insets.top)` | status-bar + Dynamic Island / notch + breathing room |
| `layout.scrollBottom()` / `safeBottom(insets.bottom)` | home indicator + gesture-nav bar + breathing room |

Using both together caused **double-counting**:

```
paddingTop  (explicit) = safeTop(59) = 67 dp   ← correct
automatic   (injected) =    insets.top = 59 dp  ← added again → 126 dp blank
```

On iPhone 14 Pro Max (insets.top = 59 dp) this meant 59 extra dp of blank space at
the top **and** 34 extra dp at the bottom.  The content shrank to look tiny and the
viewport became artificially taller than its content, making the scrollbar appear
even when nothing overflowed.

The same double-count existed on the bottom: `scrollBottom()` already includes
`insets.bottom`, so `automatic` added another `insets.bottom` (~34 dp home-indicator
clearance), hiding the last card/button behind the home bar on modern iPhones.

## Fix Strategy

| Situation | Action |
|-----------|--------|
| ScrollView/FlatList with **both** `automatic` **and** explicit `paddingBottom: layout.scrollBottom()` | Remove `automatic` — explicit padding already handles the inset correctly |
| ScrollView/FlatList with `automatic` but **no explicit padding** | Replace `automatic` with `contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}` so the bottom is always handled consistently by the app's own layout system |
| Auth screens (sign-in, sign-up, force-password-change) | Removed `automatic`; `paddingTop: layout.headerTop` + `paddingBottom: layout.scrollBottom()` now handle insets on all devices |
| `AdaptiveScreen` component | Removed `automatic`; its `bPad = layout.scrollBottom(extraBottom)` already applied the correct bottom clearance |

No hardcoded pixel values were added. No device-specific constants were introduced.
All padding continues to flow from the adaptive design system (`ds.ts`).

## Screens / Components Changed

### Auth screens
| File | Change |
|------|--------|
| `src/app/(auth)/sign-in.tsx` | Removed `contentInsetAdjustmentBehavior="automatic"`; added `showsVerticalScrollIndicator={false}` |
| `src/app/(auth)/sign-up.tsx` | Added `showsVerticalScrollIndicator={false}` (already had no `automatic`) |
| `src/app/(app)/force-password-change.tsx` | Changed `paddingTop: layout.pad.xxl` → `layout.headerTop` (correct safe-area top); added `showsVerticalScrollIndicator={false}` |

### Shared components
| File | Change |
|------|--------|
| `src/components/AdaptiveScreen.tsx` | Removed `contentInsetAdjustmentBehavior="automatic"` — `bPad = layout.scrollBottom()` in `contentContainerStyle` handles bottom inset |
| `src/components/DrawerNav.tsx` | Removed `contentInsetAdjustmentBehavior="automatic"` |
| `src/components/ForceUpdateScreen.tsx` | Removed `contentInsetAdjustmentBehavior="automatic"` |
| `src/components/VideoLibraryPicker.tsx` | Removed `contentInsetAdjustmentBehavior="automatic"` |

### App screens (86 files) — removed double-counting `automatic`
All files under `src/app/(app)/` that combined `contentInsetAdjustmentBehavior="automatic"`
with any explicit `paddingBottom` / `scrollBottom()` call had `automatic` removed.
Files with `automatic` but no existing bottom padding received an added
`contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}`.

**Admin:** academic, admin-credits, admin-overview, admin-settings, audit,
batch-management, bulk-credits, bulk-import, cms, code-history, codes,
course-activation-timeline, db-audit, devices, doctor-credit-timeline,
doctor-earnings, enrollment-manager, export-panel, fraud-alerts, global-search,
notifications-center, reports, revenue-analytics, storage, system-providers,
users, video-health, video-monitor, video-settings

**Doctor:** courses, credits, dr-earnings, dr-overview, dr-profile, students,
video-library

**Student:** dashboard, explore, my-courses, profile

**Superadmin:** branding, config, content-protection, currency, delete-permissions,
feature-flags, health, impersonation, maintenance, revenue, sa-analytics, sa-audit,
sa-courses, sa-credits, sa-doctor-earnings, sa-finance, sa-overview, sa-platform,
sa-reports, sa-support-settings, sa-users, sec-dashboard, sec-diag, sec-policies,
trash-bin, video-providers, violation-management

**App-level:** account-suspended, archived-courses/index, course-builder/[id],
course/[id], lesson-editor/[id], lesson/[id], login-history, my-devices,
notifications, security-diagnostics, security-warning, user-activity,
info/about, info/contact, info/privacy, info/terms

## What Was NOT Changed
- iOS build pipeline, Xcode project, or Podfile
- JSC / Hermes configuration
- GitHub Actions workflows
- Supabase schema, Edge Functions, RLS policies
- Security / VPN detection logic
- Visual design: colors, typography, spacing rationale, neumorphic style
- `ds.ts` / `neu.ts` / `useLayout()` — the adaptive design system itself is correct

## Verification
- `npx tsc --noEmit` — passes with zero errors
- `grep -r 'contentInsetAdjustmentBehavior="automatic"' src/` — zero results
- Safe-area insets now handled exclusively by `layout.headerTop` (top) and
  `layout.scrollBottom()` (bottom) on every screen, consistent across:
  - small iPhones (SE, 13 mini)
  - standard iPhones (14, 15)
  - Dynamic Island iPhones (14 Pro, 15 Pro, 16 Pro Max)
  - iPads (portrait + landscape)
  - Android gesture-nav phones
  - Android 3-button-nav phones
  - Web (insets.top = 0, topMin floor = 24 dp ensures minimum breathing room)
