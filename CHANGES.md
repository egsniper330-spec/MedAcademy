# CHANGES.md — iOS Startup Diagnostic Instrumentation

**Purpose:** Capture the exact iOS startup sequence at runtime (Release build) to
determine the last successful operation before the black screen occurs.

**Constraint:** No application behaviour changed. No build configuration changed.
No `ios/`, `app.json`, `.github/workflows/`, or JSC/Hermes settings touched.

---

## New Files

### `src/lib/diagnostics.ts`
Release-safe diagnostic event store.

- Works in **both Debug and Release** builds — no `__DEV__` guard.
- Maintains an **in-memory ring buffer** (max 120 entries) updated synchronously on every `diag()` call.
- Batches writes to **AsyncStorage** every 400 ms so the log persists across a crash or black screen.
- First entry recorded at **module evaluation time** — proves the JS bundle started executing.
- API:
  - `diag(tag, msg, extra?)` — append an entry (fire-and-forget, never throws)
  - `diagError(tag, label, err)` — append an error entry with message + first stack line
  - `getDiagEntries()` — synchronous read of current ring (used by overlay)
  - `loadPersistedDiag()` — async read of previous session's persisted log
  - `clearDiag()` — wipe ring + AsyncStorage
  - `getDiagSessionId()` — unique ID per JS process start

### `src/components/DiagScreen.tsx`
Always-visible floating diagnostic overlay.

- Rendered **outside** `SessionProvider`/`SecurityProvider` at `zIndex 99999` so it
  is visible even when the entire app UI is black.
- Polls the in-memory ring every **250 ms** and displays up to 60 entries.
- Shows: `+Nms` elapsed, wall-clock `HH:MM:SS.mmm`, colour-coded tag, message, extra.
- **PREV button** — loads and shows the **previous session's persisted log**, so you
  can read what happened in a black-screen run after restarting the app.
- **EXPORT button** — writes the full log to `AsyncStorage` key `__medacademy_diag_export__`
  AND prints it to `console.log` (appears in Xcode device console).
- Tap `▼ DIAG` pill to collapse to a single header bar.
- `pointerEvents="box-none"` on the container — touch passes through to the app beneath.

---

## Modified Files

### `src/ctx.tsx`
Added `diag` calls for every auth milestone. All fire in Release builds.

| Tag | Event |
|-----|-------|
| `SESSION` | `ctx.tsx module evaluated` — proves bundle loaded this module |
| `SESSION` | `SessionProvider render/mount` — component body executing |
| `SESSION` | `SessionProvider useEffect mounting` — effect registered |
| `SESSION` | `getSession START` — supabase.auth.getSession() called |
| `SESSION` | `getSession DONE` — resolved; includes `user=` and `session=` |
| `ERR`     | `getSession UNEXPECTED ERROR` — if getSession throws (should never happen) |
| `SESSION` | `setIsLoading FALSE` — isLoading gate released; includes `session=` |
| `SESSION` | `onAuthStateChange <EVENT>` — every auth state change with event name |

### `src/app/_layout.tsx`
Added `diag` calls for module eval, layout mount, and all screen-capture operations.
`DiagScreen` wired in as always-on overlay (outside all providers).

| Tag | Event |
|-----|-------|
| `LAYOUT` | `_layout.tsx module evaluated` — first line after assertMeDoBlocked() |
| `LAYOUT` | `RootLayout component executing` — React has bootstrapped |
| `LAYOUT` | `RootLayout mount useEffect fired` |
| `SC` | `RootScreenCapture render` — every render with `isLoading=` / `isSuperAdmin=` |
| `SC` | `ROOT_SC_KEY effect — isLoading=true SKIPPED` — gate active, SC deferred |
| `SC` | `ROOT_SC_KEY effect FIRING` — gate passed, SC call imminent |
| `SC` | `ROOT_SC_KEY preventScreenCaptureAsync RESOLVED` / `FAILED` |
| `SC` | `ROOT_SC_KEY allowScreenCaptureAsync RESOLVED` / `FAILED` |
| `SC` | `ROOT_SC_KEY AppState active — scheduling setTimeout(0)` |
| `SC` | `ROOT_SC_KEY AppState setTimeout(0) FIRED` |
| `SC` | `ROOT_SC_KEY AppState prevent/allow RESOLVED` / `FAILED` |

### `src/app/(app)/_layout.tsx`
Added `diag` calls for the APP_SC_KEY screen-capture effect.

| Tag | Event |
|-----|-------|
| `APP_SC` | `APP_SC_KEY effect SCHEDULED setTimeout(0)` — effect body entered |
| `APP_SC` | `APP_SC_KEY setTimeout(0) FIRED` — deferred callback executing |
| `APP_SC` | `APP_SC_KEY preventScreenCaptureAsync RESOLVED` / `FAILED` |
| `APP_SC` | `APP_SC_KEY allowScreenCaptureAsync RESOLVED` / `FAILED` |

### `src/lib/useScreenCapture.ts`
Added `diag` calls for the SC_KEY screen-capture effect (used on the lesson screen).

| Tag | Event |
|-----|-------|
| `USE_SC` | `SC_KEY allow (immediate)` — release path (blockCapture=false or isSuperAdmin) |
| `USE_SC` | `SC_KEY allowScreenCaptureAsync RESOLVED` / `FAILED` |
| `USE_SC` | `SC_KEY prevent SCHEDULED setTimeout(0)` |
| `USE_SC` | `SC_KEY setTimeout(0) FIRED — calling preventScreenCaptureAsync` |
| `USE_SC` | `SC_KEY preventScreenCaptureAsync RESOLVED` / `FAILED` |

---

## How to Use on Device

### Reading the overlay
1. Build and install this IPA on the iOS device.
2. Launch the app.
3. Even if the screen is black, the `▼ DIAG [N]` pill will be visible at the **bottom** of the screen.
4. Tap the pill to expand the log.
5. If the screen is completely black (no UI at all), the DiagScreen is also black — this means the
   React render tree itself never produced any output (JS crash before first render, or a native
   crash). In that case use **Step B** below.

### Reading the persisted log (PREV button)
1. If the app black-screened on the previous launch, restart the app.
2. Even if the new launch also black-screens, tap `▶ DIAG` → tap `PREV`.
3. This shows the persisted log written during the black-screen session, including the
   last event reached before the screen went black.

### Reading via Xcode device console
1. Connect iPhone to Mac, open **Xcode → Window → Devices and Simulators**.
2. Select the device, click the triangle console button.
3. Tap **EXPORT** in the overlay (or wait — the log is also printed to console on every EXPORT tap).
4. Search for `[DIAG EXPORT]` in the console output.
5. All entries are printed as: `[+Nms] [HH:MM:SS.mmm] [TAG] message | extra`

### Reading via AsyncStorage (RN Debugger / Flipper)
- Key: `__medacademy_startup_diag__` — live log, updated every 400 ms
- Key: `__medacademy_diag_export__` — last EXPORT snapshot

---

## What Each Tag Tells You

| Tag | What it proves |
|-----|---------------|
| `JS` | JS bundle was evaluated — runtime is alive, bundle loaded |
| `SESSION` | `ctx.tsx module evaluated → SessionProvider mounted → getSession START/DONE → setIsLoading(false)` |
| `LAYOUT` | `_layout.tsx module evaluated → RootLayout executing → useEffect fired` |
| `SC` | ROOT_SC_KEY screen-capture calls with exact timing |
| `APP_SC` | APP_SC_KEY calls (only fires after isLoading=false + (app) mounted) |
| `USE_SC` | SC_KEY calls (only fires when lesson screen mounts) |
| `ERR` | Any caught error anywhere in the instrumented paths |

**Expected happy-path sequence on a clean install (no session):**
```
[JS]      bundle eval — diagnostics module loaded
[SESSION] ctx.tsx module evaluated
[LAYOUT]  _layout.tsx module evaluated — JS runtime is alive
[LAYOUT]  RootLayout component executing
[SESSION] SessionProvider render/mount
[SESSION] SessionProvider useEffect mounting
[SESSION] getSession START
[LAYOUT]  RootLayout mount useEffect fired
[SC]      RootScreenCapture render   isLoading=true isSuperAdmin=false
[SC]      ROOT_SC_KEY effect — isLoading=true SKIPPED
[SESSION] getSession DONE             user=none session=false
[SESSION] setIsLoading FALSE
[SC]      RootScreenCapture render   isLoading=false isSuperAdmin=false
[SC]      ROOT_SC_KEY effect FIRING  isSuperAdmin=false
[SC]      ROOT_SC_KEY preventScreenCaptureAsync RESOLVED
```

**If the log stops at `getSession START` with no `DONE` entry:** getSession is hanging
(network issue, Supabase URL wrong, or storage deadlock).

**If the log shows `ROOT_SC_KEY effect FIRING` but no `RESOLVED`:** the native
`preventScreenCaptureAsync` call threw synchronously before the Promise resolved.

**If no `JS` entry appears at all:** the JS bundle did not start (native crash, missing
bundle, wrong JSC/Hermes linkage).

---

## Removal Instructions

Once diagnosis is complete, revert these changes:
1. Delete `src/lib/diagnostics.ts`
2. Delete `src/components/DiagScreen.tsx`
3. In `src/ctx.tsx`: remove `import { diag, diagError }` and all `diag()`/`diagError()` calls
4. In `src/app/_layout.tsx`: remove `import { diag, diagError }`, `import { DiagScreen }`,
   all `diag()` calls, and the `<DiagScreen />` element
5. In `src/app/(app)/_layout.tsx`: remove `import { diag, diagError }` and all `diag()` calls
6. In `src/lib/useScreenCapture.ts`: remove `import { diag, diagError }` and all `diag()` calls
