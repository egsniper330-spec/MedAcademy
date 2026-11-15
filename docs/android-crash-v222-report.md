# Android launch crash — build 222 (`com.medacademy.app`)

Diagnosed from the physical tablet over ADB. **This crash is not tablet-specific**: it is a
deterministic launch crash in the app's own security module.

## 1. Device / build under investigation

| | |
|---|---|
| Device | Samsung `SM-T505N` (Galaxy Tab A7 LTE, `gta4l`), serial `R95R6025L5H` |
| Android | 12 (SDK 31), build `T505NDXS7CXG1`, ABI `arm64-v8a` |
| RAM | 2.7 GB total |
| Package | `com.medacademy.app`, versionName `1.0.0`, versionCode **222**, minSdk 24, targetSdk 36 |
| Installed | first install 2026-11-15 23:03, last update 2026-11-16 00:58 |
| Build type | release (R8 minified), React Native 0.83.10 bridgeless/New Architecture, Expo 55, Hermes |

The installed APK was pulled and inspected: it contains `getRootDiagnostics`, `getSecurityFlags`
and `enableWindowModeMonitoring`, so build 222 **does** correspond to the current source line
(including the recent root-detection work).

## 2. Reproduction (deterministic — 10/10 attempts)

```bash
adb devices -l                                   # R95R6025L5H  device
adb -s R95R6025L5H logcat -b all -c              # clear
adb -s R95R6025L5H logcat -b all -v threadtime > crash.log &
adb -s R95R6025L5H shell am force-stop com.medacademy.app
adb -s R95R6025L5H shell monkey -p com.medacademy.app \
    -c android.intent.category.LAUNCHER 1
# app dies ~0.5 s after the JS bundle starts; splash never resolves
adb -s R95R6025L5H shell dumpsys dropbox --print data_app_crash
```

Timing on every run: `ReactNativeJS: Running "main"` → `libreanimated.so` loaded →
`FATAL EXCEPTION: main` 150–520 ms later. DropBox holds **9 prior records, all identical**.

## 3. The fatal exception

```
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: Process: com.medacademy.app, PID: 28015
E AndroidRuntime: java.lang.NullPointerException: Attempt to invoke interface method
  'void android.view.View$OnLayoutChangeListener.onLayoutChange(android.view.View, int, int,
   int, int, int, int, int, int)' on a null object reference
E AndroidRuntime: 	at android.view.View.layout(View.java:24479)
E AndroidRuntime: 	at android.view.ViewGroup.layout(ViewGroup.java:7412)
E AndroidRuntime: 	at android.view.ViewRootImpl.performLayout(ViewRootImpl.java:4609)
E AndroidRuntime: 	at android.view.ViewRootImpl.performTraversals(ViewRootImpl.java:4031)
E AndroidRuntime: 	at android.view.ViewRootImpl.doTraversal(ViewRootImpl.java:2919)
E AndroidRuntime: 	at android.view.ViewRootImpl$TraversalRunnable.run(ViewRootImpl.java:10491)
E AndroidRuntime: 	at android.view.Choreographer$CallbackRecord.run(Choreographer.java:1108)
...
I am_crash: [28015,0,com.medacademy.app,552123972,java.lang.NullPointerException,...,View.java,24479]
W ActivityTaskManager:   Force finishing activity com.medacademy.app/.MainActivity
I ActivityManager: Process com.medacademy.app (pid 28015) has died: fg  TOP
```

There is exactly one fatal error. Everything after it (window teardown, surface destruction,
`signal 9`, task removal) is the shutdown sequence, not a second defect.

Ruled out by the logs: no `ReactNativeJS` exception, no Expo module init error, no native crash
/ tombstone, no `OutOfMemoryError`, no low-memory kill, no ANR, no network error in the fatal
path, no missing-native-module error.

## 4. Root cause

`View.layout()` iterates `mListenerInfo.mOnLayoutChangeListeners`. The framework list may only
ever contain real listeners, so a `null` element means **someone added a null listener**.
Verified on this device's own `framework.jar` (Samsung Android 12):

```
View.addOnLayoutChangeListener(OnLayoutChangeListener):
    listeners = getListenerInfo().getOnLayoutChangeListeners()   // create if null
    if (!listeners.contains(l)) listeners.add(l)                 // NO null guard
View.removeOnLayoutChangeListener(...):
    listeners.remove(l)                                          // leaves no nulls
```

Only one view is laid out by `ViewRootImpl.performLayout` — the window's **DecorView**. The app's
only code that puts a listener on the decor view is `SecurityModule` (confirmed against the APK
dex: `SecurityModule.attachLayoutWatcher` is the sole decor-view `addOnLayoutChangeListener`
call site; no library in the build targets a decor view).

The null comes from **constructor ordering** in the Kotlin module template:

* `SecurityModule.init` (generated `SecurityModule.kt:171`) did
  `Handler(Looper.getMainLooper()).post { installWindowModeMonitoring() }`.
* `windowModeLayoutListener` is a `val` declared ~2 000 lines **below** `init`
  (generated `SecurityModule.kt:1902`).
* Kotlin assigns properties in declaration order, and `Handler.post` hands the task to the UI
  thread immediately — the UI thread does **not** wait for the constructor to finish. The module
  is constructed on the native-modules thread, so the posted task can run while construction has
  not yet reached the listener declaration.
* `hostActivity` is a getter (`get() = reactContext.currentActivity`), so it already resolves,
  and the task therefore ran
  `decorView.addOnLayoutChangeListener(windowModeLayoutListener)` with
  `windowModeLayoutListener == null`.
* That null is stored permanently in the decor view's listener list, and the **next layout pass**
  dies exactly as logged above. It is deterministic (large constructor window), occurs on every
  device, needs no JS input, and started with the build that introduced the constructor-time
  install.

## 5. Relation to the recent Root Detection work

**Not the cause.** The crash path contains no `SecurityModule`, `rootDiagnostics`, Magisk/root or
Xposed frame; no JS exception is thrown; `getRootDiagnostics()` exists in the installed APK so no
missing-method error is possible; the crash happens before any root verdict is consumed and does
not involve JSON parsing, bridge conversion or event handling. The crash *is* in the same native
module — in its multi-window/window-mode section — which is why it looked security-related.

## 6. Fix (narrow, no protection removed)

`plugins/withSecurityModule.js` (the source of the native module):

1. `init` no longer starts window-mode monitoring (comment documents the crash and the ordering
   rule).
2. New `override fun initialize()` — RN's lifecycle hook that runs **after** construction — and a
   new idempotent, UI-thread-posted `ensureWindowModeMonitoringInstalled()`.
3. `getWindowMode()` installs monitoring itself (post-construction, UI thread) before reading, and
   `getSecurityFlags()` calls `ensureWindowModeMonitoringInstalled()`, so the "launched directly
   into split-screen before any JS effect" case is still measured.
4. `detachLayoutWatcher()` now marshals the decor-view listener removal to the UI thread
   (`onCatalystInstanceDestroy` runs on the native-modules thread; the framework list is plain
   unsynchronized state).

Nothing was disabled: root/Magisk/Xposed/Frida/Zygisk detection, the overlay and VPN gates, split
screen enforcement, weights and events are unchanged. No catch-all or silent fallback was added.

`tests/multiWindowGate.test.cjs` gained six checks (4n updated, 4z1–4z5) that lock the ordering
rule: the constructor must never start monitoring, the installer must be reachable only from
post-construction entry points, and the removal must be UI-thread marshalled.

## 7. Verification performed

| Check | Result |
|---|---|
| `node tests/multiWindowGate.test.cjs` | **131 passed, 0 failed** |
| `node tests/overlayLifecycleWiring.test.cjs` | 86 passed, 0 failed |
| `node tests/vpnMandatoryBlock.test.cjs` | 94 passed, 0 failed |
| `node tests/securityGateState.test.cjs` | 48 passed, 0 failed |
| `node tests/rootFalsePositive.test.cjs` | 91 passed, 0 failed |
| `node tests/rootDetectionSecondPass.test.cjs` | 77 passed, 0 failed |
| `node tests/rootArtifactDenyList.test.cjs` | 44 passed, 0 failed |
| `node tests/nativeFlagsCoalescing.test.cjs` | 17 passed, 0 failed |
| `node scripts/validate-kotlin-template.js` | **PASSED** (1 pre-existing empty-catch warning) |

No TypeScript file was changed (so no typecheck was needed).

## 8. Not verified — requires a new APK

The crash was **not** verified fixed on the tablet. The installed build 222 still contains the
constructor-time install, and the generated `android/app/src/main/java/com/medacademy/security/
SecurityModule.kt` is prebuild output that still has it (`:171`). Verifying needs, with
authorization:

```bash
npx expo prebuild -p android --clean     # regenerates android/ from the plugin (the fix)
# then a normal release build + install on R95R6025L5H
```

(The project's `npm run android` = `expo run:android`, which builds the existing `android/`
folder; without a prebuild it would rebuild the unfixed Kotlin.)
