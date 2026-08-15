# CHANGES.md — iOS Startup Diagnostic Instrumentation (v2 — React-UI-independent)

**Root change:** `diagnostics.ts` completely rewritten. Every `diag()` call now
**immediately writes to `console.log`** — no React rendering required.
The DiagScreen overlay was invisible because the React tree produced no output
(the entire screen was black). All evidence is now recoverable from the
**Xcode device console** without any on-screen UI.

**Constraint:** No application behaviour changed. No build configuration changed.
No `ios/`, `app.json`, `.github/workflows/`, or JSC/Hermes settings touched.
Only `src/lib/diagnostics.ts` was modified. All other instrumented files
(`ctx.tsx`, `_layout.tsx`, `(app)/_layout.tsx`, `useScreenCapture.ts`) are
unchanged — their `diag()` calls automatically gain the new behaviour.

---

## Changed File: `src/lib/diagnostics.ts`

### What changed vs v1

| Feature | v1 | v2 |
|---------|----|----|
| Console output | None (ring-buffer only) | **Immediate `console.log` on every `diag()` call** |
| Console snapshots | None | Full ordered snapshot every 10 events AND on every AsyncStorage flush |
| Global error capture | None | **`ErrorUtils.setGlobalHandler` + `unhandledrejection` installed at module-eval time** |
| AsyncStorage flush debounce | 400 ms, no reset on new events | 800 ms, **reset on every new event** (ensures flush happens even if startup is very fast) |
| Dependency on React | DiagScreen React component required | **Zero React dependency** — works before any component mounts |

### Three independent retrieval paths (all React-UI-free)

#### Path A — Xcode device console (PRIMARY, always works with black screen)
Every `diag()` call prints immediately:
```
[DIAG +Nms] [TAG] message | extra
```
Every 10 events AND on every AsyncStorage flush, a full ordered snapshot prints:
```
[DIAG SNAPSHOT sid=XXXXXX reason=flush count=14]
[+0ms][01:23:45.678][JS] bundle eval — diagnostics module loaded | sid=...
[+12ms][01:23:45.690][SESSION] ctx.tsx module evaluated
...
```
Filter the Xcode console by `[DIAG` to isolate all diagnostic output.

#### Path B — AsyncStorage persistence (survives process death)
Key: `__medacademy_startup_diag__`  
Updated every 800 ms. Readable via React Native Debugger storage panel,
Flipper, or the DiagScreen PREV button on the next launch.

#### Path C — Global error catchers (installed before any component mounts)
Two catchers installed at module-evaluation time:
1. **`ErrorUtils.setGlobalHandler`** — RN's lowest-level uncaught error surface.
   Fires for any synchronous JS error not caught by try/catch anywhere.
   Chains to RN's existing handler after logging.
2. **`globalThis.addEventListener('unhandledrejection')`** — Promise rejections
   that escape all `.catch()` handlers.
Both catchers force an immediate AsyncStorage flush on error.

### Console line format
```
[DIAG +Nms] [TAG] message | extra
```
- `+Nms` — milliseconds since diagnostics module was first evaluated
- `TAG` — JS | SESSION | LAYOUT | SC | APP_SC | USE_SC | ERR | GLOBAL
- `extra` — optional extra context (user ID, boolean flags, error stack line)

---

## Unchanged Files (instrumentation carried forward from v1)

All caller files are unchanged. Their `diag()` / `diagError()` calls are
identical — the new immediate-console behaviour is provided transparently
by `diagnostics.ts`.

### `src/ctx.tsx`
| Tag | Event |
|-----|-------|
| `SESSION` | `ctx.tsx module evaluated` |
| `SESSION` | `SessionProvider render/mount` |
| `SESSION` | `SessionProvider useEffect mounting` |
| `SESSION` | `getSession START` |
| `SESSION` | `getSession DONE` — includes `user=` and `session=` |
| `ERR`     | `getSession UNEXPECTED ERROR` |
| `SESSION` | `setIsLoading FALSE` — includes `session=` |
| `SESSION` | `onAuthStateChange <EVENT>` |

### `src/app/_layout.tsx`
| Tag | Event |
|-----|-------|
| `LAYOUT` | `_layout.tsx module evaluated — JS runtime is alive` |
| `LAYOUT` | `RootLayout component executing` |
| `LAYOUT` | `RootLayout mount useEffect fired` |
| `SC` | `RootScreenCapture render` — `isLoading=` / `isSuperAdmin=` |
| `SC` | `ROOT_SC_KEY effect — isLoading=true SKIPPED` |
| `SC` | `ROOT_SC_KEY effect FIRING` |
| `SC` | `ROOT_SC_KEY preventScreenCaptureAsync RESOLVED / FAILED` |
| `SC` | `ROOT_SC_KEY AppState active — scheduling setTimeout(0)` |
| `SC` | `ROOT_SC_KEY AppState setTimeout(0) FIRED` |

### `src/app/(app)/_layout.tsx`
| Tag | Event |
|-----|-------|
| `APP_SC` | `APP_SC_KEY effect SCHEDULED setTimeout(0)` |
| `APP_SC` | `APP_SC_KEY setTimeout(0) FIRED` |
| `APP_SC` | `APP_SC_KEY preventScreenCaptureAsync RESOLVED / FAILED` |

### `src/lib/useScreenCapture.ts`
| Tag | Event |
|-----|-------|
| `USE_SC` | `SC_KEY allow (immediate)` |
| `USE_SC` | `SC_KEY prevent SCHEDULED setTimeout(0)` |
| `USE_SC` | `SC_KEY setTimeout(0) FIRED — calling preventScreenCaptureAsync` |
| `USE_SC` | `SC_KEY preventScreenCaptureAsync RESOLVED / FAILED` |

---

## How to Retrieve Logs from the iPhone

### Step-by-step: Xcode device console

1. Connect iPhone to Mac via USB (or use wireless pairing if already set up).
2. Open Xcode.
3. **Window → Devices and Simulators** (⇧⌘2).
4. Select your device in the left panel.
5. Click the **"Open Console"** button (bottom-left of the device panel),
   OR use the triangle ▶ icon in the device detail area.
   This opens the **Console.app** stream for the device.
   Alternatively: open **Console.app** directly from `/Applications/Utilities/`,
   select the device in the left sidebar under "Devices".
6. In the search bar, type `[DIAG` and press Enter to filter.
7. Launch the app on the device.
8. All `[DIAG +Nms]` lines appear in real time.
9. After ~1 second (or after the black screen appears), look for:
   - `[DIAG SNAPSHOT sid=... reason=flush ...]` — the complete ordered log
   - Any `[GLOBAL]` tagged lines — unhandled errors or rejected promises
   - The **last `[DIAG` line before silence** — that is the last JS operation reached

### What each scenario means

| Last log line seen | Meaning |
|--------------------|---------|
| No `[DIAG` lines at all | JS bundle never executed — native crash before JS started, wrong engine linkage, or bundle not found |
| `[JS] bundle eval` only | diagnostics.ts loaded but nothing else — a synchronous throw during module loading of another import |
| `[SESSION] ctx.tsx module evaluated` then nothing | A module imported by `_layout.tsx` (between the two module evals) threw synchronously |
| `[LAYOUT] _layout.tsx module evaluated` then nothing | React failed to call `RootLayout` — possible renderer crash |
| `[SESSION] getSession START` — no `DONE` | `supabase.auth.getSession()` is hanging (AsyncStorage deadlock, SecureStore hang, or network) |
| `[SC] ROOT_SC_KEY effect FIRING` — no `RESOLVED` | `preventScreenCaptureAsync` threw before its Promise resolved — this IS the black screen cause |
| `[SC] ROOT_SC_KEY effect — isLoading=true SKIPPED` then later `[SC] ROOT_SC_KEY effect FIRING` | isLoading gate working; SC fired after session load |
| `[GLOBAL] ErrorUtils global handler isFatal=true: ...` | A fatal JS error occurred — message and stack identify the source |

### Expected happy-path (fresh install, no prior session)
```
[DIAG +0ms]    [JS]      bundle eval — diagnostics module loaded | sid=...
[DIAG +2ms]    [GLOBAL]  ErrorUtils.setGlobalHandler installed
[DIAG +3ms]    [GLOBAL]  globalThis.addEventListener ... OR not available
[DIAG +5ms]    [SESSION] ctx.tsx module evaluated
[DIAG +8ms]    [LAYOUT]  _layout.tsx module evaluated — JS runtime is alive
[DIAG +15ms]   [LAYOUT]  RootLayout component executing
[DIAG +16ms]   [SESSION] SessionProvider render/mount
[DIAG +18ms]   [SESSION] SessionProvider useEffect mounting
[DIAG +19ms]   [SESSION] getSession START
[DIAG +20ms]   [LAYOUT]  RootLayout mount useEffect fired
[DIAG +21ms]   [SC]      RootScreenCapture render | isLoading=true isSuperAdmin=false
[DIAG +21ms]   [SC]      ROOT_SC_KEY effect — isLoading=true SKIPPED
[DIAG +22ms]   [DIAG SNAPSHOT sid=... reason=periodic count=10]  ← full log emitted
[DIAG +35ms]   [SESSION] getSession DONE | user=none session=false
[DIAG +36ms]   [SESSION] setIsLoading FALSE | session=false
[DIAG +37ms]   [SC]      RootScreenCapture render | isLoading=false isSuperAdmin=false
[DIAG +37ms]   [SC]      ROOT_SC_KEY effect FIRING | isSuperAdmin=false
[DIAG +45ms]   [SC]      ROOT_SC_KEY preventScreenCaptureAsync RESOLVED
[DIAG SNAPSHOT sid=... reason=flush count=16]   ← complete log at 800ms mark
```

---

## Removal Instructions

Once diagnosis is complete:
1. Delete `src/lib/diagnostics.ts`
2. Delete `src/components/DiagScreen.tsx`
3. In `src/ctx.tsx`: remove `import { diag, diagError }` and all `diag()`/`diagError()` calls
4. In `src/app/_layout.tsx`: remove `import { diag, diagError }`, `import { DiagScreen }`,
   all `diag()` calls, and the `<DiagScreen />` JSX element
5. In `src/app/(app)/_layout.tsx`: remove `import { diag, diagError }` and all `diag()` calls
6. In `src/lib/useScreenCapture.ts`: remove `import { diag, diagError }` and all `diag()` calls
