# iOS Black Screen Fix

## Root Cause
`expo-screen-capture`'s iOS native module implements `preventScreenCapture()` using
the UITextField secure-CALayer trick: it reparents `keyWindow.layer` into a private
`UITextField` sublayer to prevent the OS from capturing the framebuffer.

On iOS 17+ with New Architecture (Fabric/JSI), `UITextField` allocates its private
CALayer sublayers **immediately on object creation** — before the text field is added
to any view hierarchy. This means the `if let sublayer = textField.layer.sublayers?.first`
guard fires eagerly.

On iOS with New Architecture, `useEffect` callbacks are dispatched to the main thread
in the **same run-loop cycle** as the initial `CATransaction.flush()`. When
`preventScreenCaptureAsync()` ran at `RootScreenCapture` mount (before `isLoading=false`):

1. `keyWindow.layer.removeFromSuperlayer()` — detaches the window layer from the screen
   **before** the iOS display compositor has registered it for the first frame.
2. `sublayer.addSublayer(keyWindow.layer)` — reparents it into the UITextField's
   private off-screen CALayer (backed by no UIWindow or UIScreen).

Result: the entire app renders into an off-screen buffer → **black screen**.

## Fix
**File changed:** `src/app/_layout.tsx` — `RootScreenCapture` component only.

Added `const { isLoading } = useSession()` and `if (isLoading) return` guard to the
`useEffect` that calls `preventScreenCaptureAsync`. The effect now only fires after
`SessionProvider.getSession()` resolves (`isLoading=false`), at which point:
- At least one async round-trip has completed.
- The main run-loop has iterated past the initial `CATransaction.flush()`.
- The window's CALayer is fully registered with the iOS display compositor.
- Reparenting the layer works correctly — content remains visible.

## Security Impact
None. The loading phase shows only an `ActivityIndicator` (no sensitive content).
Screen-capture protection activates before any auth screen or user content renders.
The `app-shell` lock in `(app)/_layout.tsx` and the `lesson` lock in the lesson
screen remain unchanged.

## Files Changed
| File | Change |
|------|--------|
| `src/app/_layout.tsx` | Added `isLoading` guard to `RootScreenCapture.useEffect` |

## Files NOT Changed
- `app.json` — unchanged (plugins list intact, build config intact)
- `patches/expo-screen-capture+55.0.16.patch` — intact (Node 24 fix)
- `.github/workflows/ios-build.yml` — NOT touched
- `ios/` — NOT touched
- All other source files — NOT touched
