# CHANGES.md — iOS Startup Diagnostic v3 (Windows-compatible retrieval)

## Summary of changes

| File | Change |
|------|--------|
| `src/lib/diagnostics.ts` | Rewritten: immediate AsyncStorage write on every event, HTTP POST beacon, `buildLogText()` export, `STORAGE_KEY` export |
| `src/app/diag.tsx` | **NEW** — standalone expo-router route `/diag`, zero provider dependencies, reads AsyncStorage directly |
| `src/app/_layout.tsx` | Added `Stack.Screen name="diag"` outside all guards; removed `DiagScreen` overlay import |
| `src/components/DiagScreen.tsx` | Fixed `loadPersistedDiag` call (return type changed to `{sessionId,entries}|null`) |

**No changes to:** `ios/`, `app.json`, `.github/workflows/`, `ctx.tsx`, `(app)/_layout.tsx`, `useScreenCapture.ts`, JSC/Hermes config, ScreenCapture logic, SessionProvider.

---

## Why v2 failed (and what v3 fixes)

v2 added a `DiagScreen` React overlay at `zIndex 99999`. The overlay was still invisible
because it is a **React component** — when the entire React render tree produces no output
(black screen), the overlay is also black. There is no such thing as a React component that
renders "above" a non-rendering React tree.

v3 removes the overlay entirely and replaces it with two React-UI-independent mechanisms:

1. **`/diag` expo-router route** — a plain `default export` page registered **outside all
   `Stack.Protected` guards and outside `SessionProvider`/`SecurityProvider`**. It is
   navigable via deep link (`medacademy:///diag`) even when the normal app UI is black,
   because expo-router's deep-link handler fires before `index.tsx` renders.

2. **Immediate AsyncStorage write on every `diag()` call** — no debounce. The log is
   persisted within milliseconds of the first JS event, before any React component mounts.
   If the app crashes or black-screens before the `/diag` route can be reached, the log
   is still readable on the next launch via the `/diag` "Prev session" tab.

---

## Detailed file changes

### `src/lib/diagnostics.ts` (rewritten)

**Key changes vs v2:**

| Feature | v2 | v3 |
|---------|----|----|
| AsyncStorage write | Debounced 800 ms | **Immediate on every `diag()` call** |
| HTTP beacon | None | **POST to `EXPO_PUBLIC_DIAG_ENDPOINT` (debounced 1 500 ms)** |
| `loadPersistedDiag` return type | `DiagEntry[]` | `{ sessionId: string; entries: DiagEntry[] } \| null` |
| `buildLogText()` | Not exported | **Exported** — used by `/diag` Share button and beacon |
| `STORAGE_KEY` | Not exported | **Exported** — used by `/diag` direct AsyncStorage read |

**`EXPO_PUBLIC_DIAG_ENDPOINT`** — optional env var baked into the bundle at build time.
Set to any URL that accepts `POST text/plain` and returns a paste URL in the response body.
Recommended: `https://paste.rs` (returns the paste URL as the response body).
Leave unset to disable HTTP beaconing (storage-only mode).

### `src/app/diag.tsx` (new file)

Standalone diagnostic screen with NO imports from:
- `@/ctx` (SessionProvider)
- `@/lib/SecurityContext`
- `@/lib/store`
- `@/client/supabase`

It reads AsyncStorage **directly** using the exported `STORAGE_KEY` constant.

Features:
- **Current tab** — log from current session (reads AsyncStorage directly)
- **Prev tab** — log from previous session (different `sessionId`)
- **↻ Reload** — re-reads AsyncStorage
- **⬆ Share / Copy** — iOS native Share sheet (AirDrop, Mail, copy to clipboard)
- **📡 POST Beacon** — manually trigger HTTP POST to `EXPO_PUBLIC_DIAG_ENDPOINT`

### `src/app/_layout.tsx` (modified)

Added inside `RootLayoutNav()`:
```tsx
<Stack.Screen name="diag" options={{ title: 'Diagnostics', headerShown: true }} />
```
Placed **before** both `Stack.Protected` blocks so it is always reachable.

Removed `DiagScreen` import and `<DiagScreen />` JSX (replaced by comment).

---

## HOW TO RETRIEVE THE LOG ON WINDOWS

### Method 1 — Deep link to `/diag` (PRIMARY — no tools needed)

This works even if the app normally shows a black screen.

**Step 1 — Open the app once** (even if it goes black immediately, the log is written
to AsyncStorage within ~50 ms of the first JS event).

**Step 2 — Navigate to the `/diag` screen using one of these techniques:**

#### Option A: iPhone Contacts trick (no extra app needed)
1. Open the built-in **Contacts** app on the iPhone.
2. Tap **+** to create a new contact (name: "Diag").
3. Tap **add URL** → type or paste: `medacademy:///diag`
4. Tap **Done** to save.
5. Tap the URL in the contact card → the app opens at `/diag`.

#### Option B: iPhone Safari address bar
1. Open **Safari** on the iPhone.
2. Tap the address bar → type: `medacademy:///diag` → tap **Go**.
3. Safari will prompt "Open in MedAcademy?" → tap **Open**.

#### Option C: QR code (generate on Windows, scan on iPhone)
1. On your Windows PC, go to https://qr.io or https://www.qr-code-generator.com.
2. Enter the URL: `medacademy:///diag`
3. Download the QR code image.
4. On the iPhone, open the **Camera** app and scan the QR code.
5. Tap the notification banner → the app opens at `/diag`.

**Step 3 — Read the log on the `/diag` screen.**

The screen shows all events colour-coded by tag. Scroll up to see the earliest events.
If the current session shows no events, tap **Prev** to see the previous session's log.

**Step 4 — Export the log (send it to yourself).**

Tap **⬆ Share / Copy** → the iOS Share sheet appears. Options:
- **AirDrop** to another Apple device on the same WiFi (then email/upload from there).
- **Mail** — email yourself the log text.
- **Copy** — copies to clipboard; paste into Notes or a text editor.
- **Files** — save to iCloud Drive; accessible from Windows via iCloud for Windows or
  iCloud.com.
- **WhatsApp / Telegram / Messages** — paste into any messaging app.

### Method 2 — HTTP POST beacon (AUTOMATIC — fires without touching the phone)

This fires **automatically** ~1.5 seconds after the last diagnostic event, even if the
app is black, as long as the phone has internet access.

**Setup (one-time, at build time):**

1. Add to your `.env` / GitHub Actions secret / EAS secret:
   ```
   EXPO_PUBLIC_DIAG_ENDPOINT=https://paste.rs
   ```
2. Rebuild the IPA with this env var set.

**How to read it:**
1. Install the app and launch it (even if black).
2. Wait ~3 seconds.
3. The app POSTs the full log to `https://paste.rs`.
4. The response body is the paste URL (e.g. `https://paste.rs/AbCdEf`).
5. That URL is logged as a `[BEACON]` event in the diagnostic log AND printed to console.
6. On your Windows PC, open the paste URL in any browser.

**Alternative paste endpoints:**
- `https://paste.rs` — returns URL in body, no auth needed, free
- `https://hastebin.com/documents` — returns JSON `{"key":"..."}`, base URL is `https://hastebin.com/`
- Any webhook endpoint (e.g. a free Pipedream / webhook.site URL)

### Method 3 — idevicesyslog on Windows (console.log capture)

If you want raw console.log output on Windows without Xcode:

1. Install **iTunes** (from Apple website — NOT the Microsoft Store version).
2. Download **libimobiledevice** Windows build from:
   https://github.com/libimobiledevice-win32/imobiledevice-net/releases
   Extract to `C:\imd\`.
3. Connect iPhone via USB. Run in PowerShell:
   ```powershell
   C:\imd\idevicesyslog.exe | Select-String "\[DIAG"
   ```
4. Launch the app. All `[DIAG +Nms]` lines appear in the PowerShell window.

### Method 4 — 3uTools (GUI app for Windows)

1. Download **3uTools** from https://www.3u.com (free, Windows).
2. Connect iPhone via USB, trust the PC.
3. In 3uTools: **Toolbox → Real-time Log**.
4. Filter by `DIAG`.
5. Launch the app. All diagnostic events appear.

---

## What each tag tells you

| Tag | Meaning |
|-----|---------|
| `JS` | JS bundle evaluated — proves JSC is running and the bundle loaded |
| `GLOBAL` | Global error catcher status + any uncaught errors |
| `SESSION` | `ctx.tsx` eval → `SessionProvider` mount → `getSession` START/DONE → `setIsLoading(false)` |
| `LAYOUT` | `_layout.tsx` eval → `RootLayout` executing → mount `useEffect` |
| `SC` | ROOT_SC_KEY screen-capture: isLoading gate skip/fire, resolve/fail |
| `APP_SC` | APP_SC_KEY: setTimeout(0) scheduled/fired, resolve/fail |
| `USE_SC` | SC_KEY (lesson screen): allow/prevent, resolve/fail |
| `ERR` | Any caught error with message + stack line |
| `BEACON` | HTTP POST result (status + paste URL if endpoint is configured) |

## Expected happy-path (fresh install, no prior session)

```
[JS]      bundle eval — diagnostics v3 loaded
[GLOBAL]  ErrorUtils.setGlobalHandler installed
[GLOBAL]  unhandledrejection listener installed
[SESSION] ctx.tsx module evaluated
[LAYOUT]  _layout.tsx module evaluated — JS runtime is alive
[LAYOUT]  RootLayout component executing
[SESSION] SessionProvider render/mount
[SESSION] SessionProvider useEffect mounting
[SESSION] getSession START
[LAYOUT]  RootLayout mount useEffect fired
[SC]      RootScreenCapture render   isLoading=true
[SC]      ROOT_SC_KEY effect — isLoading=true SKIPPED
[SESSION] getSession DONE            user=none session=false
[SESSION] setIsLoading FALSE
[SC]      RootScreenCapture render   isLoading=false
[SC]      ROOT_SC_KEY effect FIRING
[SC]      ROOT_SC_KEY preventScreenCaptureAsync RESOLVED
[BEACON]  HTTP 200 → https://paste.rs/AbCdEf   (if endpoint configured)
```

## Removal instructions

Once diagnosis is complete:
1. Delete `src/app/diag.tsx`
2. Delete `src/lib/diagnostics.ts`
3. Delete `src/components/DiagScreen.tsx`
4. In `src/app/_layout.tsx`: remove the `diag` import line, the `Stack.Screen name="diag"` element, and the comment block
5. In `src/ctx.tsx`, `src/app/(app)/_layout.tsx`, `src/lib/useScreenCapture.ts`: remove `import { diag, diagError }` and all `diag()`/`diagError()` calls
6. Remove `EXPO_PUBLIC_DIAG_ENDPOINT` from your env / secrets if set

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
