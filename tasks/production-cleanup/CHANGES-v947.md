# Metro Bundle Fix — v947

**Date:** 2026-07-13  
**Type:** Build fix — Metro bundling failure on iOS

---

## Problem

iOS build failed at the "Bundle React Native code and images" Xcode phase:

```
iOS Bundling failed
Unable to resolve module @/lib/diagnostics
```

Metro reported the import from `src/app/(app)/_layout_app.tsx`. The canonical
`src/app/(app)/_layout.tsx` was already cleaned in v946, but Metro's file
crawler walks the **entire project root**, including `tasks/` working directories
from previous fix sessions. Several of those stale copies still contained:

```ts
import { diag, diagError } from '@/lib/diagnostics';
```

…which resolves through the `withAtAliasResolver` in `metro.config.js` to
`src/lib/diagnostics.ts` — a file deleted in v946.

---

## Root Cause

`metro.config.js` adds `node_modules/.pnpm` to `watchFolders` but does not
exclude `tasks/`. Metro crawls all directories under the project root by
default, so every `.tsx` file in `tasks/` is a potential bundle entry point.

The `withAtAliasResolver` in `metro.config.js` maps `@/` → `<root>/src/`,
so `@/lib/diagnostics` in any `tasks/**/*.tsx` correctly resolves to
`src/lib/diagnostics.ts` — and correctly fails when that file doesn't exist.

---

## Files Containing Stale Diagnostic Imports (all in `tasks/`)

| File | Action |
|------|--------|
| `tasks/full-crash-audit/_layout_app.tsx` | Removed import + 5 diag/diagError calls |
| `tasks/fix-pad-xxl-crash/_layout_app.tsx` | Removed import + 5 diag/diagError calls |
| `tasks/full-crash-audit-v2/src/app/(app)/_layout.tsx` | Removed import + 5 diag/diagError calls |
| `tasks/diag-instrumentation/**` | Blocked via Metro `blockList` (archive — not modified) |

---

## Fix

### 1. Stale task file cleanup
Removed `import { diag, diagError } from '@/lib/diagnostics'` and all
`diag()`/`diagError()` call sites from the three stale layout copies listed above.
The call-site replacements preserve the actual screen-capture logic:
- `allowScreenCaptureAsync().catch(() => {})` (was chained with `.then(diag...)`)
- `preventScreenCaptureAsync().catch(() => {})` (same)

### 2. Metro `blockList` for `tasks/` (permanent fix)
Added `withTasksBlockList()` to `metro.config.js`. This adds a regex matching
`<projectRoot>/tasks/.*` to Metro's `resolver.blockList`, preventing Metro from
ever resolving any module from the `tasks/` directory tree.

```js
function withTasksBlockList(config) {
  const TASKS_RE = new RegExp(
    path.join(__dirname, 'tasks').replace(/\\/g, '\\\\') + '.*'
  );
  // ...merges with existing blockList entries
}
```

Applied in the assembler as `config = withTasksBlockList(config)` between
`withWasmSupport` and `withAtAliasResolver`.

This ensures:
- `tasks/diag-instrumentation/` (full diagnostic archive) never enters the bundle graph
- Any future working files placed in `tasks/` are automatically excluded
- No `tasks/` file can ever cause a Metro resolution failure again

---

## Validation

### TypeScript
```
npx tsc --noEmit → 0 errors
```

### metro.config.js syntax
```
node -e "require('./metro.config.js')" → exit 0
```

### blockList regex verification
```
/\/workspace\/app-czyg340mpc75\/tasks.*/
blocks tasks/diag-instrumentation/...diagnostics.ts  → true ✓
allows src/lib/store.ts                              → false ✓
```

### Metro iOS bundle
```
npx expo export:embed --platform ios ... → bundle generated, 0 diagnostics errors
```

---

## Files Modified

| File | Change |
|------|--------|
| `metro.config.js` | Added `withTasksBlockList()` function + wired into assembler |
| `tasks/full-crash-audit/_layout_app.tsx` | Removed diag import + 5 call sites |
| `tasks/fix-pad-xxl-crash/_layout_app.tsx` | Removed diag import + 5 call sites |
| `tasks/full-crash-audit-v2/src/app/(app)/_layout.tsx` | Removed diag import + 5 call sites |

---

## Files NOT Modified

- `src/app/(app)/_layout.tsx` — already clean from v946
- `src/lib/diagnostics.ts` — correctly deleted in v946, not restored
- All other `src/` files — already clean from v946
- `ios/` — not touched (user requirement)
- CocoaPods / Xcode config — not touched (user requirement)
- Auth / networking — not touched (user requirement)
