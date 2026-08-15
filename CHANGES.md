# iOS Black-Screen Audit — v922
## Full Startup Path Audit + Two Additional Fixes

---

## Summary

After applying the v921 fix (`setTimeout(0)` on the `APP_SC_KEY` effect in `(app)/_layout.tsx`),
a complete startup-path audit was performed to ensure no other independent iOS black-screen
causes remained. Two additional call sites with the identical timing race were found and fixed.

---

## Root Cause Recap (all three issues share the same mechanism)

`expo-screen-capture`'s iOS native `preventScreenshots()` works by reparenting
`keyWindow.layer` into a `UITextField`'s off-screen `CALayer` hierarchy. This takes
the window layer **out of the display compositor tree**.

On iOS with New Architecture / Fabric / JSI, `useEffect` callbacks and AppState event
handlers execute on the main thread in the **same run-loop iteration** as the React or
UIKit event that triggered them. If `preventScreenCapture()` is called in that iteration,
the window layer is removed from the compositor **before the pending `CATransaction` has
been flushed to the display**, producing a **permanent black screen**.

`setTimeout(0)` defers the call to the **next run-loop iteration**, by which point the
`CATransaction` has already been committed and the window is visible. The native API then
reparents an already-presented layer, which works correctly.

`allowScreenCaptureAsync` (the release path) is always immediate — it re-inserts the layer
and never causes a black-screen condition regardless of timing.

---

## Issue Inventory

### Issue 1 — `(app)/_layout.tsx` APP_SC_KEY initial mount effect [FIXED IN v921]

| Property | Value |
|---|---|
| File | `src/app/(app)/_layout.tsx` |
| Trigger | `(app)/` group mounts when `isLoading` transitions from `true` → `false` |
| Risk | Startup black screen — fires before first frame |
| Status | **Fixed in v921** — wrapped in `setTimeout(0)` with `cancelled` flag |

---

### Issue 2 — `_layout.tsx` RootScreenCapture AppState `'active'` handler [FIXED IN v922]

| Property | Value |
|---|---|
| File | `src/app/_layout.tsx` |
| Trigger | Device background → foreground resume (even during auth loading) |
| Risk | Black screen on FIRST foreground resume during the `~100–500 ms` `getSession()` window |

**Evidence**: The AppState `'active'` event fires **independently of `isLoading`**. If the
user briefly backgrounds and restores the app during the auth-loading phase, iOS delivers
the `'active'` event on the same run-loop iteration as the UIKit window re-presentation.
The previous code called `preventScreenCaptureAsync` with no deferral in that callback.

**Fix applied** (`src/app/_layout.tsx`):

```ts
// BEFORE
const sub = AppState.addEventListener('change', (nextState) => {
  if (nextState === 'active') {
    if (isSuperAdminRef.current) {
      ScreenCaptureLib.allowScreenCaptureAsync(ROOT_SC_KEY).catch(() => {});
    } else {
      ScreenCaptureLib.preventScreenCaptureAsync(ROOT_SC_KEY).catch(() => {});
    }
  }
});

// AFTER
let timer: ReturnType<typeof setTimeout> | null = null;
const sub = AppState.addEventListener('change', (nextState) => {
  if (nextState === 'active') {
    if (timer !== null) clearTimeout(timer);       // cancel racing timer
    timer = setTimeout(() => {
      timer = null;
      if (isSuperAdminRef.current) {
        ScreenCaptureLib.allowScreenCaptureAsync(ROOT_SC_KEY).catch(() => {});
      } else {
        ScreenCaptureLib.preventScreenCaptureAsync(ROOT_SC_KEY).catch(() => {});
      }
    }, 0);
  }
});
return () => {
  if (timer !== null) clearTimeout(timer);
  sub.remove();
};
```

**Android / Web**: Unaffected. FLAG_SECURE never reparents the window layer; the timer adds
negligible latency (< 1 ms). Web is guarded by `EXPO_OS === 'web'`.

---

### Issue 3 — `useScreenCapture.ts` SC_KEY initial mount effect [FIXED IN v922]

| Property | Value |
|---|---|
| File | `src/lib/useScreenCapture.ts` |
| Trigger | Lesson screen (`lesson/[id].tsx`) mounts after navigation push |
| Risk | Black screen when navigating into any lesson |

**Evidence**: `useScreenCapture({ blockCapture: true })` is called unconditionally at the
top of `lesson/[id].tsx`. Its internal `useEffect` called `preventScreenCaptureAsync`
synchronously with no deferral. On iOS NA, a Stack navigation push triggers a React commit
→ `useEffect` fires in the same run-loop iteration as the push's `CATransaction` → same
UITextField layer reparent race → lesson screen appears black.

This is an **independent black screen cause** from Issue 1: startup and lesson navigation
are separate React commit cycles. A device that never triggers the startup race (e.g.,
because `getSession()` resolves before first frame) would still hit the lesson race on
every lesson entry.

**Fix applied** (`src/lib/useScreenCapture.ts`):

```ts
// BEFORE
useEffect(() => {
  if (process.env.EXPO_OS === 'web') return;
  if (!blockCapture || isSuperAdmin) {
    ScreenCaptureLib.allowScreenCaptureAsync(SC_KEY).catch(() => {});
    return;
  }
  ScreenCaptureLib.preventScreenCaptureAsync(SC_KEY).catch(() => {}); // ← synchronous, no defer
  return () => {
    ScreenCaptureLib.allowScreenCaptureAsync(SC_KEY).catch(() => {});
  };
}, [blockCapture, isSuperAdmin]);

// AFTER
useEffect(() => {
  if (process.env.EXPO_OS === 'web') return;
  let cancelled = false;
  if (!blockCapture || isSuperAdmin) {
    ScreenCaptureLib.allowScreenCaptureAsync(SC_KEY).catch(() => {}); // immediate is safe
    return;
  }
  const timer = setTimeout(() => {
    if (cancelled) return;
    ScreenCaptureLib.preventScreenCaptureAsync(SC_KEY).catch(() => {});
  }, 0);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    ScreenCaptureLib.allowScreenCaptureAsync(SC_KEY).catch(() => {});
  };
}, [blockCapture, isSuperAdmin]);
```

**Android / Web**: Unaffected. Android FLAG_SECURE path unchanged; Web guarded by
`EXPO_OS === 'web'`.

---

## Other Call Sites — Confirmed Safe (No Change Needed)

| Call site | Why safe |
|---|---|
| `RootScreenCapture` main isLoading effect (`_layout.tsx` ~line 170) | Already gated: `if (isLoading) return` prevents call until auth resolves. By that point, first frame has always been committed. |
| `(app)/_layout.tsx` APP_SC_KEY effect | Fixed in v921 — `setTimeout(0)` already in place. |
| `useContentProtection.ts` `'lesson'` key | `if (process.env.EXPO_OS !== 'android') return` — never executes on iOS. |
| `SecureAppOverlay.tsx` AppState handler | Manages an overlay `<View>` blur, makes NO `preventScreenCapture` calls. |

---

## Files Changed

| File | Change |
|---|---|
| `src/app/_layout.tsx` | `RootScreenCapture` AppState `'active'` handler wrapped in `setTimeout(0)` with `cancelled`-style timer ref |
| `src/lib/useScreenCapture.ts` | `preventScreenCaptureAsync` call deferred with `setTimeout(0)` + `cancelled` flag |

**Files intentionally NOT changed**: `(app)/_layout.tsx` (Issue 1 fix already in v921),
`ios/`, `app.json`, `.github/workflows/ios-build.yml`, `babel.config.js`, `metro.config.js`,
`package.json`, `Podfile`, any Xcode project file.

---

## Validation

- `npx tsc --noEmit --skipLibCheck` → **exits 0** (no TypeScript errors)
- `git diff --name-only .github/workflows/ ios/ app.json babel.config.js metro.config.js package.json` → **no changes** (build pipeline untouched)
- Android: FLAG_SECURE behaviour unchanged — `allowScreenCaptureAsync` remains immediate,
  `preventScreenCaptureAsync` deferred by ≤ 1 ms (one event loop tick), functionally identical
- Web: all three issues were already guarded by `EXPO_OS === 'web'` checks; no Web code path changed

---

## Security Guarantee Preserved

All three fixes defer only the **activate** path. The **release** path (`allowScreenCaptureAsync`)
is always immediate. This means:

1. During the brief `setTimeout(0)` window (< 1 ms), the previous protection key is still
   active from the prior screen/state.
2. The loading screen shows only an `ActivityIndicator` — no sensitive content is visible
   without protection in any of the three scenarios.
3. Super Admin bypass is unaffected — SA sessions take the immediate `allow` path which
   has no timing risk.
