# Split-screen / multi-window blocking (mandatory full-screen usage)

MedAcademy may only be used **full-screen**. When Android reports that the app
itself is in split-screen (or any other multi-window mode, including our own
picture-in-picture), the app presents a non-dismissible blocking screen, stops
playback, refuses protected requests, and restores access **only** after the
platform reports the app back in full screen *and* a fresh security evaluation
passes.

This document is the honest scope statement: §2 lists what is genuinely
detected, §3 what is **not** detectable on Android, §4 the exact implementation
and enforcement path, §5 every file, §6 what has been verified, §7 what still
needs a real device.

---

## 1. Why a window-state block, not a new risk event

Split-screen is a **window state of this app**, not evidence that the device is
compromised: it is not a policy finding, it carries no risk weight, and it is
enforced entirely on-device (like the overlay/tapjacking signal and the
background→resume hold). Consequently:

* **no** new security event type, weight, bucket or backend policy was added —
  `src/lib/security.ts` (detectors, `WEIGHTS`, `DETECTION_TO_EVENT`,
  `DEFAULT_POLICIES`) is untouched, and `tests/multiWindowGate.test.cjs` asserts
  it;
* **no** backend file was created or modified, so there is nothing to upload or
  deploy for this change;
* the block is still **hard** in the existing containment model: protected
  playback unmounts, in-flight protected requests abort, and the transport
  refuses new ones while the lock is held.

## 2. What IS detected (and how)

| Condition | API | Reliability |
|---|---|---|
| App in **split-screen** | `Activity.isInMultiWindowMode()` (API 24+) | Reliable. Reported live by the activity callback and re-read on every window resize and foreground return. |
| App in **another Android multi-window presentation** (freeform / desktop windowing on large screens) | `Activity.isInMultiWindowMode()` | Reliable — Android documents desktop/freeform windows as multi-window. |
| App **launched directly into split-screen** | `isInMultiWindowMode()` read at module init, on monitoring install, and on host resume | Reliable. The initial state is **read**, never inferred from a callback (the callback's ordering at first creation is not documented). |
| App in **picture-in-picture** (our own floating window) | `Activity.isInPictureInPictureMode()` (API 24+) | Reliable, and reported as its **own** mode — PiP is a special case of multi-window, so it is classified first and worded separately from a split screen. |
| Live **transitions** in and out of any of the above | `Activity.onMultiWindowModeChanged` / `onPictureInPictureModeChanged` (both overloads), relayed from `MainActivity` as described in §4 | Reliable; combined with the layout and resume triggers below it also survives a lost callback. |
| Transitions the callback cannot see (e.g. no callback delivered) | decor-view **layout pass** (entering/leaving split-screen resizes our window) + **host resume** re-read | Defensive triggers, event-driven — see §4. |

## 3. What is NOT detected — stated plainly, never as a finding

Android gives a normal app **no API to enumerate another app's windows**. So:

* **"Another app is in split-screen / picture-in-picture next to us"** — not
  observable at all. Nothing in this feature claims it, and no finding is ever
  raised for it.
* **"Another app is floating over / drawn on top of us"** — the *overlay*
  question. It is a **different measurement** with its own honest limits
  (`OVERLAY_DETECTION_LIMITS`, `docs/DEVICE_VALIDATION_CHECKLIST.md` §1): the
  framework's obscured-touch flags (`FLAG_WINDOW_IS_OBSCURED` /
  `FLAG_WINDOW_IS_PARTIALLY_OBSCURED`, set from API 29, and only when the user
  actually touches the screen) plus prevention via `setHideOverlayWindows(true)`
  (API 31+). A prohibited window mode is never presented as an overlay, and the
  overlay evidence is never presented as a split screen.
* **OEM floating-window features** (MIUI, One UI, EMUI and similar) are vendor UI
  layered over the documented APIs, with no public API of their own. When such a
  feature puts **MedAcademy itself** in a resizable/floating window the
  documented multi-window state reports it; when it only affects other apps,
  nothing is claimed.
* **Accessibility-based observation** (`AccessibilityService.getWindows()`) is
  deliberately **not** used. It would mean asking for a broad, sensitive
  permission — a privacy and Play-policy change for a learning product — purely
  to approximate a signal that can never be complete anyway. No permission is
  requested for this feature at all: `isInMultiWindowMode()` /
  `isInPictureInPictureMode()` are permission-free.
* **iOS / web**: the documented window model above is Android's. On other
  platforms the reading is the honest `'unknown'`, measured:false (never
  "full-screen confirmed"), and no iOS native code was added.

An **unmeasurable** signal (`'unknown'`, e.g. no activity yet, or a failed read)
is never a finding, never a clearance, and never overwrites a real measurement.
The published limits are exported as `MULTI_WINDOW_DETECTION_LIMITS` in
`src/lib/securityStateModel.ts` and are asserted by the test suite.

## 4. Implementation and enforcement path

### Native (Android) — `plugins/withSecurityModule.js`

* `SecurityModule.kt` (the Kotlin template **is** the shipped module) adds a
  small closed window-mode vocabulary — `fullscreen` / `multi_window` /
  `picture_in_picture` / `unknown` — and:
  * `getWindowMode()` — one authoritative measurement (resolves
    `{ mode, inMultiWindow, inPictureInPicture, measured, signalTimeMs }`).
  * `enableWindowModeMonitoring()` — installs the triggers, re-reads at once,
    idempotent, safe on every session start and foreground return.
  * `windowModeChanged` events — emitted **only on a real change** (the module
    deduplicates repeated reports), so there is no event storm.
  * evidence fields in `getSecurityFlags()`: `windowMode`,
    `windowModeMeasured`, `inMultiWindowMode`, `inPictureInPictureMode`.
  * three independent, event-driven triggers (no timer, no polling loop):
    1. the **activity callback** relayed through the process-wide
       `WindowModeBridge` object (it retains the last reported value, so a module
       created after the app was already split-screen still learns the mode);
    2. a decor-view **layout watcher** (entering/leaving split-screen resizes our
       window) — also the fallback if the activity forwarder is ever absent;
    3. a React Native **host-resume** hook.
  * every read is posted to the UI thread, is fail-safe to `'unknown'`, and the
    layout watcher/lifecycle listener/bridge subscription are all released in
    `onCatalystInstanceDestroy()`.
* The `withMainActivity` mod injects the multi-window and PiP forwarders into the
  generated `MainActivity.kt`, **both** `onMultiWindowModeChanged` overloads
  (`(boolean)` for API 24–25, `(boolean, Configuration)` for API 26+) plus
  `onPictureInPictureModeChanged`. The patch is marker-guarded (idempotent),
  refuses anything that is not the generated Kotlin activity, and is
  all-or-nothing (a source that cannot be patched completely is left untouched)
  — so a future template change degrades to "the layout watcher and the resume
  hook are the triggers" instead of half-patching the activity. The pure patcher
  is exported on the plugin (`patchMainActivityForWindowMode`) and exercised by
  the tests against the real generated file.

### JavaScript

* `src/lib/nativeSecurity.ts` — `getNativeWindowMode()`,
  `enableNativeWindowModeMonitoring()`, `onNativeWindowModeChanged()`; all
  degrade to `'unknown'`/no-op off Android, and an absent module or a thrown call
  is **unmeasured**, never "full-screen".
* `src/lib/securityStateModel.ts` — the new `BLOCKED_MULTI_WINDOW` gate state
  (precedence: `BLOCKED_OVERLAY` → **`BLOCKED_MULTI_WINDOW`** →
  `BLOCKED_BACKGROUND_RESUME` → `BLOCKED_VPN` → `BLOCKED_SECURITY_VIOLATION` →
  `CHECKING` → `ALLOWED`), `isProhibitedWindowMode()`, the split-screen and PiP
  copy (`windowModeBlockCopy` / `windowModeBlockSteps`), the release rule
  `canClearMultiWindowBlock({ modeRestored, hasFreshVerdict })` and the
  documented limits. `BLOCKED_MULTI_WINDOW` is **not** recheckable
  (`isGateRecheckable`), by design.
* `src/lib/SecurityContext.tsx` — a dedicated lock source
  (`LOCK_SRC_WINDOW_MODE`): a prohibited mode engages a **hard** lock and records
  the verdict serial; the lock releases only when the platform reports
  `fullscreen` **and** a newer completed verdict exists, at which point a fresh
  evaluation is requested automatically. The reading is taken at session start
  (this is what catches a launch **directly** into split-screen), on every
  foreground return, on demand in `verifySecurity()`, and on every native
  transition event. `unknown` is never applied as a state, and the belief resets
  to `unknown` on sign-out (session-scoped, so one identity cannot inherit
  another's reading).
* `src/app/(app)/security-gate.tsx` — renders `BLOCKED_MULTI_WINDOW` as a
  full-screen page: mode-specific copy, numbered recovery steps
  ("HOW TO RETURN TO FULL SCREEN"), no findings list (it is not a policy
  finding), no risk-score pill, no recheck/Verify control, hardware back
  consumed, `FLAG_SECURE` held. The gate already sits **above** the whole
  authenticated stack as inline content, so there is no route, deep link or
  navigation state that can bypass it.

### Enforcement summary

```
platform window mode ──▶ SecurityModule (Kotlin) ──▶ windowModeChanged / getWindowMode()
        │
        ▼
SecurityContext ──▶ LOCK_SRC_WINDOW_MODE (hard) ──▶ containment
        │                                          ├─ protected requests abort/refused
        │                                          ├─ playback stoppers invoked / player unmounted
        │                                          └─ resolveSecurityGateState → BLOCKED_MULTI_WINDOW
        ▼
security-gate.tsx full-screen page (no bypass) ──▶ cleared only by
        platform "fullscreen" + a fresh authoritative verdict
```

`src/app/(app)/security-diagnostics.tsx` additionally lists the new signal with
the exact APIs used, the enforcement it drives, and the "another app's windows
are not observable" limit.

## 5. Files

| File | Change |
|---|---|
| `plugins/withSecurityModule.js` | Kotlin: window-mode vocabulary, `getWindowMode`, `enableWindowModeMonitoring`, `WindowModeBridge`, layout watcher, resume hook, event emit, flags evidence, teardown. Mod: withMainActivity window-mode forwarders + the exported pure patcher. |
| `src/lib/nativeSecurity.ts` | Three JS bindings + window-mode fields and fail-safe defaults in `NativeSecurityFlags`. |
| `src/lib/securityStateModel.ts` | `BLOCKED_MULTI_WINDOW`, precedence, `isProhibitedWindowMode`, copy + steps, `canClearMultiWindowBlock`, `MULTI_WINDOW_DETECTION_LIMITS`. |
| `src/lib/SecurityContext.tsx` | Lock source, engage/release wiring, session-start/resume/verify reads, context fields. |
| `src/app/(app)/security-gate.tsx` | The blocking page for the new state. |
| `src/app/(app)/security-diagnostics.tsx` | Detector row for the new signal (APIs, enforcement, limit). |
| `tests/multiWindowGate.test.cjs` | **New** suite (120 assertions): pure model, native template, the real MainActivity patcher, JS bindings, wiring, gate presentation, existing-controls-unchanged. |
| `tests/securityGateState.test.cjs` | Vocabulary (7 states) + multi-window precedence and non-recheckability. |
| `tests/overlayLifecycleWiring.test.cjs` | Findings-suppression assertion updated for the third window-state cause; header state list. |
| `docs/MULTI_WINDOW_BLOCKING.md`, `docs/DEVICE_VALIDATION_CHECKLIST.md` | This document; §16 manual device procedure. |

**Backend: no file created or modified. Nothing to deploy.**

## 6. Verified (source-level)

* `tests/multiWindowGate.test.cjs` — 120 passed, 0 failed.
* `tests/securityGateState.test.cjs` (43), `tests/overlayLifecycleWiring.test.cjs` (83),
  `tests/vpnMandatoryBlock.test.cjs`, `tests/vpnRuntimeDetection.test.cjs`,
  `tests/securityStartupFlash.test.cjs` (26), `tests/debugModeFindingDiagnostics.test.cjs` (63) — all passing.
* `npx tsc --noEmit` — exit 0.
* `npm run validate` (Kotlin template, Swift sources, native build, security
  param-authority guard) and `npm run lint:security-params`.
* Full `npm test`.

## 7. Still requires a real Android device

Nothing below can be proven by `tsc`, the validators or the test suites:

1. **Split-screen entry/exit** on the target OEM skins (Samsung/One UI, Xiaomi/MIUI,
   Pixel): page appears on entry, clears automatically on return to full screen.
2. **Launch directly into split-screen** (open from a paired split view).
3. **Picture-in-picture** entry/exit and the distinct PiP wording.
4. **Freeform / desktop windowing** on a tablet or a desktop-mode device.
5. **Multi-window + other blocks together** (e.g. VPN active): the page shown must
   match the highest-precedence cause, and the auto-clear must still work.
6. **Playback containment**: a video that is playing when split-screen is entered
   must stop and unmount (hard lock), not merely be covered.
7. **OEM floating-window features**: confirm the app behaves correctly when a
   vendor feature windows another app (no false split-screen page), and record
   honestly whether the vendor feature also windows MedAcademy itself.
8. **No permission prompt** is triggered by this feature.

Procedure: `docs/DEVICE_VALIDATION_CHECKLIST.md` §16.
