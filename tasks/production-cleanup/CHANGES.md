# Production Release Cleanup — MedAcademy

**Version:** v946  
**Date:** 2026-07-13  
**Type:** Production cleanup — temporary diagnostics removed

---

## Summary

Removed all temporary debugging/diagnostic infrastructure added during the
iOS black-screen and auth network-failure investigation (v944–v945). The
actual fixes that resolved those issues are preserved in full.

---

## Temporary Diagnostic Features Removed

The following were added solely for diagnosing the black-screen / auth
network failure issues and serve no production purpose:

### HTTP beacon system
- `EXPO_PUBLIC_DIAG_ENDPOINT` environment variable — no longer read anywhere
- `_sendBeacon()` function — POST log text to external paste endpoint
- Debounced beacon timer on every `diag()` event

### AsyncStorage diagnostic persistence
- `__medacademy_startup_diag__` key — startup event ring buffer written on
  every event, read by `/diag` screen
- `__medacademy_diag_export__` key — written by `DiagScreen.tsx` EXPORT button

### Diagnostic ring buffer / module
- `src/lib/diagnostics.ts` — entire file deleted:
  - `DiagEntry` type
  - `diag()` / `diagError()` — event logger
  - `getDiagEntries()` / `buildLogText()` / `getDiagSessionId()` / `clearDiag()`
  - `loadPersistedDiag()` — previous-session log reader
  - `_emitConsoleSnapshot()` — periodic `[DIAG SNAPSHOT …]` console dumps
  - Global `ErrorUtils.setGlobalHandler` diagnostic catcher (temporary)
  - Global `unhandledrejection` diagnostic catcher (temporary)
  - Auto-firing `diag('JS', 'bundle eval …')` at module evaluation

### `/diag` deep-link screen
- `src/app/diag.tsx` — entire file deleted:
  - Full-screen log viewer accessible via `medacademy:///diag`
  - Current/Prev session tabs, SHARE / POST Beacon buttons
- `Stack.Screen name="diag"` registration removed from `src/app/_layout.tsx`

### Floating diagnostic overlay
- `src/components/DiagScreen.tsx` — entire file deleted:
  - `DiagScreen` component (zIndex 99999 floating overlay)
  - `DIAG_EXPORT_KEY` constant
  - 250 ms polling loop, PREV/EXPORT buttons

### Diagnostic console.log instrumentation (all sources)

| File | Tags removed |
|------|-------------|
| `src/app/_layout.tsx` | `[DIAG +…ms]`, `LAYOUT` diag calls |
| `src/ctx.tsx` | `SESSION` diag calls |
| `src/app/(app)/_layout.tsx` | `APP_SC` diag calls |
| `src/lib/useScreenCapture.ts` | `USE_SC` diag calls |
| `src/app/_layout.tsx` | `SC` diag calls (RootScreenCapture) |

### Temporary AUTH / CONFIG / NETTEST block in sign-in.tsx
- `_t0` / `_ts()` timing helpers
- `_authTag` / `_authErr` variables and all `console.log(_authTag, …)` /
  `console.log(_authErr, …)` / `console.log('[CONFIG]', …)` /
  `console.log('[NETTEST]', …)` / `console.log('[NETTEST_ERROR]', …)` calls
- `_supabaseUrl` / `_anonKey` / `_urlValid` / `_urlHost` env-var inspection block
- `_isPhone` / `_loginMethod` / `_platform` log-only variables
- NETTEST pre-flight connectivity probe (`globalThis.fetch` to
  `/rest/v1/?apikey=…`) — was log-only after v945; now removed entirely since
  the actual auth call surfaces network errors with the same user-facing message

---

## Files Deleted

| File | Reason |
|------|--------|
| `src/lib/diagnostics.ts` | Entire diagnostic infrastructure — temporary |
| `src/app/diag.tsx` | `/diag` deep-link screen — temporary |
| `src/components/DiagScreen.tsx` | Floating overlay — temporary |

---

## Files Modified

| File | Changes |
|------|---------|
| `src/app/_layout.tsx` | Removed: `import { diag, diagError }`, module-level `diag()` call, `diag()` calls inside `RootScreenCapture` and `RootLayout`, `<Stack.Screen name="diag">` registration, dead "DIAGNOSTIC OVERLAY REMOVED" comment block |
| `src/ctx.tsx` | Removed: `import { diag, diagError }`, module-level `diag()` call, all `diag()` / `diagError()` calls inside `SessionProvider` — `authLog()` (existing `__DEV__`-gated logger) preserved |
| `src/app/(app)/_layout.tsx` | Removed: `import { diag, diagError }`, all `APP_SC` diag calls wrapping `allowScreenCaptureAsync` / `preventScreenCaptureAsync` |
| `src/lib/useScreenCapture.ts` | Removed: `import { diag, diagError }`, all `USE_SC` diag calls wrapping screen-capture API calls |
| `src/app/(auth)/sign-in.tsx` | Removed: entire `_t0` / `_ts` / `_authTag` / `_authErr` / `_urlValid` / NETTEST block; all `console.log([AUTH]…)` / `[AUTH_ERROR]` / `[CONFIG]` / `[NETTEST]` / `[NETTEST_ERROR]` calls |

---

## Real Fixes Preserved

These changes solved actual application problems and must not be reverted:

| Fix | Location | Preserved |
|-----|----------|-----------|
| iOS black-screen: `isLoading` gate on `preventScreenCaptureAsync` | `_layout.tsx` `RootScreenCapture` | ✅ |
| iOS black-screen: `setTimeout(0)` defer in `RootScreenCapture` AppState handler | `_layout.tsx` | ✅ |
| iOS black-screen: `setTimeout(0)` defer in `(app)/_layout.tsx` screen-capture effect | `(app)/_layout.tsx` | ✅ |
| iOS black-screen: `setTimeout(0)` defer in `useScreenCapture.ts` | `useScreenCapture.ts` | ✅ |
| expo-screen-capture: import JS wrapper module directly (not `requireOptionalNativeModule`) | all SC files | ✅ |
| Auth regression fix: removed hard-block on missing env vars in dev builds | `sign-in.tsx` | ✅ |
| Network error UX: clear messages for timeout / unreachable server | `sign-in.tsx` | ✅ |
| `medo-guard`: blocks retired backend URL at fetch level | `_layout.tsx` | ✅ |
| `authLog()` `__DEV__`-gated auth timeline logger | `ctx.tsx` | ✅ |
| Security revocation / device binding / realtime session management | `ctx.tsx` | ✅ |
| TextEncoder polyfill, JSC configuration, VPN/security checks | various | ✅ |
| `security-diagnostics.tsx` — superadmin native module inspector | `(app)/security-diagnostics.tsx` | ✅ (kept) |
| `sec-diag.tsx` — superadmin security audit screen | `(app)/(superadmin)/sec-diag.tsx` | ✅ (kept) |

---

## Environment Variables

### Required for production build
```
EXPO_PUBLIC_SUPABASE_URL        # Supabase project URL
EXPO_PUBLIC_SUPABASE_ANON_KEY   # Supabase anon (public) key
```

### No longer used / must not be set
```
EXPO_PUBLIC_DIAG_ENDPOINT       # REMOVED — not referenced anywhere
```

---

## Validation Results

### TypeScript
```
npx tsc --noEmit → 0 errors
```

### Diagnostic identifier grep audit (`src/` tree)
All of the following return **zero matches**:

| Identifier | Result |
|-----------|--------|
| `from '@/lib/diagnostics'` | 0 |
| `DIAG_EXPORT_KEY` | 0 |
| `__medacademy_startup_diag__` | 0 |
| `EXPO_PUBLIC_DIAG_ENDPOINT` | 0 |
| `DiagScreen` (component) | 0 |
| `buildLogText` / `getDiagEntries` / `loadPersistedDiag` | 0 |
| `[DIAG` / `DIAG SNAPSHOT` | 0 |
| `_sendBeacon` | 0 |
| `diag(` (as function call) | 0 |
| `diagError` | 0 |
| `[AUTH]` / `[AUTH_ERROR]` / `[CONFIG]` / `[NETTEST]` | 0 |
| `Stack.Screen name="diag"` | 0 |

### eas.json / app.json
- `EXPO_PUBLIC_DIAG_ENDPOINT` not referenced in either file ✅
- No `diag` route registered in `app.json` ✅

---

## Production Checklist

- [x] `/diag` route does not exist in the route table
- [x] No diagnostic screen accessible via deep link
- [x] No floating diagnostic overlay
- [x] No `PREV` / `EXPORT` diagnostic UI
- [x] No HTTP log beacon
- [x] `EXPO_PUBLIC_DIAG_ENDPOINT` not required
- [x] No `__medacademy_startup_diag__` AsyncStorage writes
- [x] No `__medacademy_diag_export__` AsyncStorage writes
- [x] No `[DIAG]` / `[DIAG SNAPSHOT]` console spam
- [x] No `[AUTH]` / `[CONFIG]` / `[NETTEST]` temporary console logs
- [x] No global `ErrorUtils` diagnostic handler
- [x] No global `unhandledrejection` diagnostic handler
- [x] No debug route or test button
- [x] No authentication bypass
- [x] No security bypass
- [x] iOS black-screen fix intact
- [x] Auth network error handling intact
- [x] TypeScript: 0 errors
