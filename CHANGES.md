# CHANGES — TextEncoder Polyfill: Inline IIFE (Script-Context Safe)

## Crash Being Fixed

```
[runtime not ready]: ReferenceError: Can't find variable: require
Stack: global code@15:118
RCTFatalException: NSException: Unhandled JS Exception
```

iOS device crashes immediately after launch during React Native JS startup.

## Root Cause

`src/polyfills/text-encoding.js` (registered via `serializer.polyfillModuleNames`)
contained:

```js
require('fast-text-encoding');   // ← CRASHED at runtime
```

### Why `require` is unavailable in polyfillModuleNames

Metro transforms every entry in `polyfillModuleNames` with **`type: "script"`**
(`getPrependedScripts.js` line 54):

```js
const transformOptions = { ...options, type: "script" };
```

`wrapModule()` (`helpers/js.js` line 44) checks:

```js
if (output.type.startsWith("js/script")) {
  return output.data.code;   // RAW code — no __d() wrapper, no require()
}
```

Script outputs are emitted as **raw, unwrapped code**. The `require()` /
`__d()` / `module` / `exports` globals are only available inside Metro's
`__d()` CJS wrapper, which `polyfillModuleNames` scripts never receive.
`require` literally does not exist when the polyfill executes — hence:

```
ReferenceError: Can't find variable: require   at global code@15:118
```

Line 15:118 maps exactly to the previous `require('fast-text-encoding')` call.

## Fix

Replace `require('fast-text-encoding')` with the **inlined IIFE** from
`fast-text-encoding/text.min.js` (Apache-2.0). The library was already
designed for raw script environments (browser `<script>` tags) — it is a
completely self-contained IIFE with **zero `require()` calls**.

```js
// BEFORE — crashes in script context (require not defined):
require('fast-text-encoding');

// AFTER — self-contained IIFE, zero require(), safe as raw prepended script:
(function(scope) { 'use strict';
  // ... TextEncoder + TextDecoder implementations ...
  scope.TextEncoder = scope.TextEncoder || v;
  scope.TextDecoder = scope.TextDecoder || g;
}(typeof window !== 'undefined' ? window :
  typeof global !== 'undefined' ? global : this));
```

### Scope selection (why this works on every engine)

| Engine | window | global | Result |
|--------|--------|--------|--------|
| JSC (iOS, no built-in TextEncoder) | undefined | `<globalObject>` | installs polyfill ✓ |
| Hermes (Android, TextEncoder native) | undefined | `<globalObject>` | OR-guard no-ops ✓ |
| Browser (TextEncoder native) | defined | — | OR-guard no-ops ✓ |

## Verification Results

| Check | Result |
|-------|--------|
| No `require()`/`import`/`export` in executable code | ✓ PASS |
| `global.TextEncoder === function` after raw eval | ✓ PASS |
| `globalThis.TextEncoder === function` after raw eval | ✓ PASS |
| `global.TextDecoder === function` after raw eval | ✓ PASS |
| `new TextEncoder().encode('hello')` → `[104,101,108,108,111]` | ✓ PASS |
| exceljs `typeof TextEncoder` guard does not throw | ✓ PASS |
| `metro.config.js` polyfillModuleNames still wired to file | ✓ PASS |
| `require.resolve()` resolves to correct on-disk path | ✓ PASS |

## Files Changed

| File | Change |
|------|--------|
| `src/polyfills/text-encoding.js` | Replaced `require('fast-text-encoding')` with inlined `fast-text-encoding@1.0.6` IIFE — zero `require()` calls, safe as Metro prepended script |

**All other files unchanged:**
- `metro.config.js` — `serializer.polyfillModuleNames` still points to this file (untouched)
- `metro.config.js` — `.pnpm` `watchFolders` guard still in place (untouched)
- JSC/Hermes settings — untouched
- `ios/` — untouched
- `app.json` — untouched
- `.github/workflows/` — untouched

## Install Instructions

Copy `src/polyfills/text-encoding.js` from this ZIP to the same path in
your project. No other files need to change. Rebuild the IPA normally.
