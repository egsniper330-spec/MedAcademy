# MedAcademy — Full Crash & Runtime Stability Audit

Audit date: 2026-07-13
Scope: entire source tree (296 .ts/.tsx files)

---

## Summary of Issues Found and Fixed

| # | Severity | File(s) | Issue | Status |
|---|----------|---------|-------|--------|
| 1 | 🔴 CRITICAL | `(app)/_layout.tsx`, `(auth)/force-password-change.tsx` | Wrong route group — navigating to (auth) screen while session active (guard=false) | Fixed |
| 2 | 🔴 CRITICAL | `(app)/_layout.tsx`, `(auth)/security-warning.tsx` | Same wrong-group bug: security-warning in (auth) navigated from (app) | Fixed |
| 3 | 🔴 CRITICAL | `(app)/_layout.tsx`, `(auth)/account-suspended.tsx` | Same wrong-group bug: account-suspended in (auth) registered for (app) navigation | Fixed |
| 4 | 🟠 HIGH | `src/lib/ds.ts` — `useLayout()` | `adapt.isTablet` accessed before null-guard; stale adapt during unmount → crash | Fixed |
| 5 | 🟠 HIGH | `src/lib/ds.ts` — `useLayout()` | `...adapt` spread with no null-guard → `layout.pad` undefined → `layout.pad.xxl` crash | Fixed |
| 6 | 🟠 HIGH | `(doctor)/dr-profile.tsx` (×3) | `useMemo` used as side-effect hook — fires async during render pass (Fabric/JSC) | Fixed |
| 7 | 🟠 HIGH | `(doctor)/dr-earnings.tsx` (×2) | Same `useMemo`-as-`useEffect` misuse | Fixed |

---

## Issue Details

---

### Issue 1 — `force-password-change` in wrong guard group (PRIMARY CRASH)

**Root cause:**
`AppLayoutNav` inside `src/app/(app)/_layout.tsx` called:
```ts
router.replace('/(auth)/force-password-change')
```
But `force-password-change.tsx` lived under `src/app/(auth)/`, guarded by:
```tsx
<Stack.Protected guard={!session && !isLoading}>
```
When `AppLayoutNav` fires this redirect, the user **has a valid session** (`session` is
truthy), so `guard = false` — the entire `(auth)` group is **removed from the route table**.
`router.replace` targets a route that does not exist. expo-router cannot perform the navigation.
During the resulting broken re-render, `force-password-change.tsx` mounts with a partially
initialised React context tree. The `useMemo` inside `useLayout()` returns an object where
`...adapt` is stale/empty — `layout.pad` is `undefined` — and `layout.pad.xxl` throws the
fatal JSC error: `TypeError: undefined is not an object (evaluating 'f.pad.xxl')`.

**Why iOS/Android only, not Web:** expo-router on Web uses browser history; an invalid
`replace` silently fails or shows a 404. On native the navigation inconsistency triggers a
synchronous React re-render in unexpected context → hard JS crash.

**Fix:**
- Moved `force-password-change.tsx` from `src/app/(auth)/` → `src/app/(app)/`
- Updated `router.replace` path: `/(auth)/force-password-change` → `/(app)/force-password-change`
- Added `<Stack.Screen name="force-password-change" />` in `(app)/_layout.tsx`

---

### Issue 2 — `security-warning` in wrong guard group (SAME CRASH CLASS)

**Root cause:**
`AppLayoutNav` navigated to `/(auth)/security-warning` from two `useEffect` hooks:
1. On `AppState` change (foreground resume): `router.replace('/(auth)/security-warning')`
2. On `onNewBlockingThreat` callback: `router.replace('/(auth)/security-warning')`

Both fire **while the user has an active session** (`(auth)` guard is `false`). Same mechanism
as Issue 1: route not in table → broken render → context undefined → crash on `layout.pad.xxl`
or any other layout property access in `security-warning.tsx`.

**Fix:**
- Moved `security-warning.tsx` from `src/app/(auth)/` → `src/app/(app)/`
- Updated both `router.replace` paths to `/(app)/security-warning`
- Added `<Stack.Screen name="security-warning" />` in `(app)/_layout.tsx`

**Note:** `security-warning.tsx` calls `router.replace(redirect ?? '/(app)/(student)/dashboard')`
after dismissing — `redirect` defaults to a valid `(app)` route, and the explicit
`router.replace('/(auth)/sign-in')` path after sign-out is **correct**: sign-out clears the
session, the `(auth)` guard immediately becomes `true`, and `sign-in` is in the table.

---

### Issue 3 — `account-suspended` in wrong guard group (SAME CRASH CLASS)

**Root cause:**
`account-suspended.tsx` was registered as `<Stack.Screen name="account-suspended" />` in
`(app)/_layout.tsx` but the file lived in `src/app/(auth)/`. If any code path navigated to
`/(app)/account-suspended` the file would be resolved from the (auth) route table instead,
creating the same broken-context render risk. More critically, its `layout.pad.xxl` access
(line 38) would crash on first render in the broken context.

**Fix:**
- Moved `account-suspended.tsx` from `src/app/(auth)/` → `src/app/(app)/`
- `<Stack.Screen name="account-suspended" />` already present in `(app)/_layout.tsx`
- The `router.replace('/(auth)/sign-in')` after `supabase.auth.signOut()` is **correct**
  (same reasoning as security-warning: signOut clears session → guard flips → sign-in reachable)

---

### Issue 4 — `adapt.isTablet` accessed before null-guard in `useLayout()`

**Root cause:**
```ts
const headerLeft = safeLeft(insets.left ?? 0, adapt.isTablet);
```
This line executes **before** the `useMemo` null-guard block. If `adapt` is undefined/stale
during a concurrent-mode unmount pass, `adapt.isTablet` throws immediately — before the
`safePad`/`safeAdapt` guard even runs.

**Fix:**
```ts
const headerLeft = safeLeft(insets.left ?? 0, adapt?.isTablet ?? false);
```

---

### Issue 5 — `useLayout()` `...adapt` spread with no null-guard (BELT-AND-SUSPENDERS)

**Root cause:**
The `useMemo` in `useLayout()` spread `...adapt` directly. During the concurrent-mode
unmount pass triggered by Issues 1–3, `adapt` could be stale/undefined, causing the spread
to produce an object without a `pad` key. Any access of `layout.pad.*` then threw.

**Fix** (already applied in previous session — preserved here):
```ts
const safePad = adapt?.pad ?? {
  xs: spacing.xs, sm: spacing.sm, md: spacing.md,
  lg: spacing.lg, xl: spacing.xl, xxl: spacing.xxl, xxxl: spacing.xxxl,
};
const safeAdapt = adapt ?? {} as ReturnType<typeof useAdaptive>;
return { ...safeAdapt, pad: safePad, ... };
```

---

### Issue 6 — `useMemo` used as `useEffect` in `dr-profile.tsx` (×3)

**Root cause:**
```ts
useMemo(() => { (async () => load())(); }, []);
```
`useMemo` is called **during the render pass** to compute a memoised value. React may call
it multiple times in concurrent mode (e.g. during deferred rendering, suspense, or StrictMode
double-invocation). Using it to launch async side effects (network calls, state mutations)
means those effects fire **during rendering**, which:
1. Violates React's render-purity contract (renders must be pure / idempotent).
2. Causes multiple redundant network calls in concurrent mode.
3. On Fabric (React Native New Architecture), where renders are truly concurrent, this can
   trigger state updates during the render phase → `Warning: Cannot update during an existing
   state transition` → in production builds: silent data corruption or crash.

Affected component sections: `PricingSettingsSection` (line 347),
`EnrollmentCard`/student-profile loader (line 522), `EarningsDashboard` (line 976).

**Fix:** Replaced all three with `useEffect`:
```ts
useEffect(() => { (async () => load())(); }, []);
```
Added `useEffect` to the React import line (was missing from the import).

---

### Issue 7 — `useMemo` used as `useEffect` in `dr-earnings.tsx` (×2)

**Root cause:** Same pattern as Issue 6.
Affected: `EnrollmentCard` student-profile loader (line 373), `PricingSettingsSection` (line 664).

**Fix:** Same as Issue 6 — replaced with `useEffect`, added to import.

---

## Files Changed

| File | Change |
|------|--------|
| `src/app/(app)/force-password-change.tsx` | **New** — moved from `(auth)/` |
| `src/app/(auth)/force-password-change.tsx` | **Deleted** |
| `src/app/(app)/security-warning.tsx` | **New** — moved from `(auth)/` |
| `src/app/(auth)/security-warning.tsx` | **Deleted** |
| `src/app/(app)/account-suspended.tsx` | **New** — moved from `(auth)/` |
| `src/app/(auth)/account-suspended.tsx` | **Deleted** |
| `src/app/(app)/_layout.tsx` | Route paths × 2 + Stack.Screen registrations × 2 |
| `src/lib/ds.ts` | `adapt?.isTablet ?? false` + full null-guard in `useLayout()` |
| `src/app/(app)/(doctor)/dr-profile.tsx` | 3× `useMemo` → `useEffect`; add `useEffect` to import |
| `src/app/(app)/(doctor)/dr-earnings.tsx` | 2× `useMemo` → `useEffect`; add `useEffect` to import |

---

## Audit — Issues NOT Fixed (by design)

| Area | Finding | Rationale |
|------|---------|-----------|
| `exportUtils.ts` — ExcelJS on native | `exportXLSX` is already guarded: `if (typeof document !== 'undefined')` skips the download on native; ExcelJS itself runs in JS thread and doesn't call native APIs | No crash risk — correctly no-ops on native |
| `installationId.ts`, `security.ts`, `securityConfigService.ts` — `SecureStore` | All call sites already guarded with `if (process.env.EXPO_OS === 'web')` localStorage fallback | No crash risk |
| `nativeSecurity.ts` — native modules | Documented to return safe defaults on Web/Expo Go; all NativeModules access is optional-chained | No crash risk |
| `useMemo` in `dr-earnings.tsx` line 175, `dr-profile.tsx` line 168 | These are **correct** memoised computations (`bucketEarningsTimeSeries`) — not side effects | Not a bug |
| 35 `eslint-disable react-hooks/exhaustive-deps` suppressions | Suppression of missing deps — each was reviewed; all are intentional one-time-mount loads with stable `useCallback` deps | No immediate crash risk; not in scope of this fix |

---

## Verification

- `npm run tsc -- --noEmit` → exit 0, zero errors ✓
- `(auth)/` now only contains: `_layout.tsx`, `sign-in.tsx`, `sign-up.tsx` ✓
- `(app)/` Stack registers: `force-password-change`, `security-warning`, `account-suspended` ✓
- No changes to `ios/`, build config, JSC/Hermes, Metro, TextEncoder polyfill,
  or `.github/workflows/ios-build.yml` ✓
