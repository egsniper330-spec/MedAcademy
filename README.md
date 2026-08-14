# MedAcademy — Black/White Screen Fix

## Root Cause
Node 24.16.0's native TypeScript-stripping loader refuses to process `.ts` files
inside `node_modules`. When Metro called `getConfig()`, it loaded
`expo-screen-capture` which had no `app.plugin.js`, so `@expo/config` fell back
to its `main` field (`build/ScreenCapture.js`), which imported
`expo-modules-core` whose `main` is `src/index.ts` — causing an
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` hard crash on every bundle request.

## Files in This Archive

### Source files (copy to your project root, preserving paths)
| File | What changed |
|---|---|
| `src/app/_layout.tsx` | Restored real layout (binary isolation test removed) |
| `src/app/(app)/_layout.tsx` | Added `if (!ScreenCapture) return` null-guard in useEffect |
| `src/lib/useScreenCapture.ts` | Added null guards at both useEffect entry points |
| `metro-stubs/netinfo-stub.js` | NEW — safe no-op stub for @react-native-community/netinfo on web |
| `metro.config.js` | Added netinfo stub to withPlatformStubs resolver |
| `patches/expo-screen-capture+55.0.16.patch` | NEW — patch-package patch, creates app.plugin.js |
| `.watchmanconfig` | Added "node_modules" to ignore_dirs (prevents inotify exhaustion) |

### The critical node_modules fix
| File | How to apply |
|---|---|
| `node_modules/expo-screen-capture/app.plugin.js` | **Option A (recommended):** The `patches/expo-screen-capture+55.0.16.patch` file applies this automatically via `patch-package` on every `pnpm install` / `npm install`. Your `postinstall` script already runs `patch-package`. |
| | **Option B (manual fallback):** Copy `node_modules/expo-screen-capture/app.plugin.js` from this archive into your project's `node_modules/expo-screen-capture/` directory. Must be re-applied after each install. |

## How to Apply
1. Copy all files from this archive into your project root (preserving the directory structure).
2. Run `pnpm install` — the postinstall hook will apply the patch automatically.
3. The devkit preview will restart and serve the bundle correctly.

## Verification
After applying, run:
```
node -e "
  process.chdir('.')
  require('@expo/config').getConfig('.', { skipSDKVersionRequirement: true })
  console.log('✅ getConfig OK — no crash')
"
```
