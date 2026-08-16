# CHANGES — iOS Black Screen Fix: TextEncoder ReferenceError on JSC

## Root-Cause Report

### 1. Exact file/package calling `TextEncoder`

**Package:** `exceljs@4.4.0`  
**File:** `node_modules/exceljs/dist/exceljs.bare.js`  
(the browserify browser-bundle; Metro picks this via exceljs's `"browser"` package.json field)

**Line (in the bare source):**
```js
// node_modules/exceljs/lib/utils/browser-buffer-encode.js  (embedded as module #17)
const textEncoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder('utf-8');
```
This executes **at module-evaluation time** — not inside a function — the instant
`require('exceljs')` is called.

---

### 2. Import chain that reaches it at startup

```
expo-router/entry-classic
  └── expo-router/build/qualified-entry.js
        └── require('expo-router/_ctx')          ← require.context() over ALL src/app/**
              └── getRoutesCore.js getDirectoryTree()
                    └── contextModule(filePath)   ← EAGERLY require()s EVERY route file
                          ├── src/app/(app)/(admin)/codes.tsx
                          ├── src/app/(app)/(admin)/code-history.tsx
                          ├── src/app/(app)/(admin)/video-health.tsx
                          ├── src/app/(app)/(superadmin)/sa-credits.tsx
                          ├── src/app/(app)/(superadmin)/trash-bin.tsx
                          └── src/app/(app)/(admin)/bulk-import.tsx
                                └── src/lib/exportUtils.ts  (static `import ExcelJS from 'exceljs'`)
                                      └── exceljs/dist/exceljs.bare.js
                                            └── module #17: new TextEncoder('utf-8')  ← CRASH
```

**Why all route files are required at startup:** `expo-router/build/getRoutesCore.js`
`getDirectoryTree()` iterates `contextModule.keys()` and calls `contextModule(filePath)`
(which is `require()`) **synchronously** for every route during `ContextNavigator`
initialization — before any screen is rendered. There is no code-splitting in React
Native's Metro bundler; the entire module graph is a single bundle.

---

### 3. Why it fails on iOS/JSC

| Runtime | `TextEncoder` available? | Why |
|---------|-------------------------|-----|
| **Hermes (Android)** | ✅ Yes — built-in | Hermes ships TextEncoder natively since RN 0.70 |
| **Browser (Web)** | ✅ Yes — built-in | All modern browsers have it |
| **JSC (iOS, this project)** | ❌ No | `@react-native-community/javascriptcore` is a bare JSC engine; it does not include WHATWG Encoding API |

React Native's startup polyfill chain (`setUpXHR.js`) installs `XMLHttpRequest`,
`fetch`, `Blob`, `URL`, `URLSearchParams`, `AbortController` — but **never**
`TextEncoder` or `TextDecoder`.

Under JSC's New Architecture / Bridgeless JSI mode, accessing an undeclared
global identifier at the module-evaluation stage (before the JS→native bridge is
fully initialised) throws:

```
[runtime not ready]: ReferenceError: Can't find variable: TextEncoder
```

The `typeof TextEncoder === 'undefined'` guard that exceljs uses *is* safe in
fully-initialized JS environments (including old-arch JSC), but fires as a
`ReferenceError` in JSC's Bridgeless bootstrap phase. The crash is synchronous,
happens before React renders a single pixel, and produces a permanent black screen.

---

### 4. Why Android and Web do not reproduce it

- **Android** uses Hermes by default → `TextEncoder` is a native built-in →
  `typeof TextEncoder` returns `'function'` → `new TextEncoder('utf-8')` succeeds.
- **Web** runs in a browser → `TextEncoder` is a browser built-in → same result.
- Neither platform ever hits the missing-global path.

---

## Fix

### Approach: Metro `serializer.polyfillModuleNames`

Inject a polyfill as a **prepended script** via Metro's
`config.serializer.polyfillModuleNames`. Prepended scripts run *before*
`InitializeCore`, before the app entry point, and before any route module is
required — guaranteeing `TextEncoder`/`TextDecoder` are present on `global` when
exceljs's module-level code executes.

This is the smallest safe application-level change:
- Zero changes to `ios/`, `Podfile`, native code, or build workflows.
- Zero changes to JSC/Hermes configuration.
- No changes to any existing screen or library code.
- The polyfill is a pure-JS no-op on Hermes and web (uses `||` guard:
  `scope.TextEncoder = scope.TextEncoder || v`).

### Package used: `fast-text-encoding@1.0.6`

Pure-JS implementation. No native modules, no peer dependencies. The bundle
checks `typeof window` / `typeof global` and installs on the correct scope —
on JSC, `window` is undefined and `global` is the JSC global object.

---

## Files changed

| File | Change |
|------|--------|
| `src/polyfills/text-encoding.js` | **NEW** — side-effect shim that `require('fast-text-encoding')` |
| `metro.config.js` | Added `serializer.polyfillModuleNames` block (16 lines) |
| `package.json` | `fast-text-encoding@^1.0.6` added to `dependencies` |

**No other files were modified.**

---

## Verification

```
npx tsc --noEmit   → 0 errors
npm run lint       → 0 errors / warnings related to this change
```

The polyfill has no TypeScript surface (it's a `.js` side-effect file loaded by
Metro, not imported by any TypeScript source), so no type declarations are needed.

---

## How to confirm the fix works on device

1. Rebuild the IPA with this change (the polyfill is baked into the JS bundle at
   build time by Metro).
2. Install on the iOS device.
3. Launch the app — it should reach the normal login/home screen instead of
   showing a black screen.
4. Optional: if the Diagnostic v3 instrumentation (`src/lib/diagnostics.ts`) is
   still present, open `medacademy:///diag` — you should see the full startup
   sequence logged through to `ROOT_SC_KEY preventScreenCaptureAsync RESOLVED`
   with no `[ERR]` or `[GLOBAL]` crash entries.

---

## Removal / clean-up (after confirming fix)

No clean-up required. `fast-text-encoding` is a tiny (~3 KB minified) pure-JS
package with zero side effects on platforms that already have `TextEncoder`. It
is safe to leave in production indefinitely.

If you later upgrade to Hermes on iOS (removing
`@react-native-community/javascriptcore`), the polyfill becomes a no-op and can
be removed at that point.
