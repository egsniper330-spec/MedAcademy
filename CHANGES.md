# CHANGES — Metro watchFolders: Conditional .pnpm Path

## Problem

GitHub Actions iOS build fails during the **"Bundle React Native code and images"**
Xcode phase with:

```
Error "ENOENT" reading contents of ".../node_modules/.pnpm", skipping.
Failed to construct transformer: Error: ENOENT: no such file or directory,
  stat '.../node_modules/.pnpm'
  errno: -2, code: 'ENOENT', path: '.../node_modules/.pnpm'
```

Metro aborts immediately, the JS bundle is never written, and Xcode fails the
build.

## Root Cause

`metro.config.js` unconditionally added `node_modules/.pnpm` to
`config.watchFolders`:

```js
const pnpmStore = path.join(__dirname, 'node_modules/.pnpm');
config = {
  ...config,
  watchFolders: [...(config.watchFolders || []), pnpmStore],   // ← always added
  ...
};
```

`node_modules/.pnpm` is **pnpm-specific** — it only exists when the project is
installed with pnpm (e.g. local development). The GitHub Actions workflow uses
`npm ci`, which creates a flat `node_modules/` layout with no `.pnpm`
subdirectory.

When Metro initialises its file system, it calls `fs.stat()` on every path in
`watchFolders`. On a non-existent path this throws `ENOENT`, which propagates as
a fatal error during transformer construction — before a single module is
resolved.

## Fix

Only add `node_modules/.pnpm` to `watchFolders` when the directory actually
exists on disk:

```js
const pnpmStore = path.join(__dirname, 'node_modules/.pnpm');
const extraWatchFolders = fs.existsSync(pnpmStore) ? [pnpmStore] : [];
config = {
  ...config,
  watchFolders: [...(config.watchFolders || []), ...extraWatchFolders],
  resolver: { ...config.resolver, useWatchman: true },
};
```

`fs` is already imported at the top of the file (`const fs = require('fs')`).
`useWatchman: true` is kept unconditionally — it has no downside on npm and
still prevents inotify exhaustion in pnpm environments.

## Verification

```
# npm env (CI): .pnpm does not exist
node -e "fs.existsSync('node_modules/.pnpm')"  →  false
extraWatchFolders = []   →  Metro never stats .pnpm  →  no ENOENT  ✓

# pnpm env (local dev): .pnpm exists
node -e "fs.existsSync('node_modules/.pnpm')"  →  true
extraWatchFolders = ['node_modules/.pnpm']  →  Metro crawls pnpm store  ✓
```

## Files Changed

| File | Change |
|------|--------|
| `metro.config.js` | Lines 277–302: `watchFolders` now uses `fs.existsSync` guard before including `node_modules/.pnpm` |

**No other files modified.** All previous fixes preserved:
- TextEncoder polyfill (`serializer.polyfillModuleNames`)
- JSC/Hermes configuration — unchanged
- All resolver stubs (cssInterop, platformStubs, lucide, @/ alias, wasm)
