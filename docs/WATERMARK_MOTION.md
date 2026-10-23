# Watermark motion — continuous bouncing vs periodic relocation

Goal: the recipient's name + public id must **move continuously** (a bouncing-ball
trajectory that reflects off the visible video edges) and must never teleport, blink,
or park at a boundary. This document records what each playback surface actually does,
what was verified at runtime, and where the provider's own watermark imposes a limit.

## Surfaces

| Surface | Renderer | Motion | Verified |
| --- | --- | --- | --- |
| Plyr / YouTube (web + native WebView document) | `#plyr-watermark`, `requestAnimationFrame` loop in `src/lib/plyr/playerScript.ts` (native) and `public/player/player.js` (web) | continuous, reflects off the measured `.plyr__video-wrapper` box | **yes — real Chromium, 107 s of playback, every 250 ms sample a new position, 0 out-of-bounds** |
| VdoCipher WebView / iframe player | `buildWatermarkInjection()` (`src/lib/watermarkInjection.ts`) — in-document overlay with a `requestAnimationFrame` loop | continuous | source-level only (needs a live VdoCipher OTP; not run here) |
| VdoCipher Android native SDK | `NativeWatermarkOverlay` + `src/lib/watermarkMotion.ts`, Reanimated `useFrameCallback` (UI thread) | continuous, reflects off the measured container with the measured pill size | pure physics covered by `tests/watermarkMotion.test.cjs`; **not device-verified in this change** |
| VdoCipher iOS native SDK | provider burned-in `rtext` annotation (no app overlay) | **provider-controlled: relocates per `interval`, not continuous** | limitation, see below |

## Web / Plyr implementation notes

- Position advances from **elapsed time** (`dt` in seconds, velocity in px/s), so the
  path is identical at 30 / 60 / 120 Hz.
- Each axis reflects the overshoot (`next = 2*max - next`), so the mark bounces and never
  sticks to a wall or loses speed.
- Bounds are `[0, w - markW] × [0, h - markH]` measured from the real video wrapper; on
  `resize` (fullscreen, rotation) the mark is re-measured, re-typed and clamped, and the
  trajectory continues with its velocity.
- `dt` is capped at 1 s. The cap bounds one frame's travel (a step can never tunnel
  through an edge because the reflection folds the overshoot); it must not be tiny, or a
  throttled/backgrounded frame would slow the mark to a crawl instead of keeping its
  pace. (The previous 0.05 s cap did exactly that at ~1 fps.)
- The mark is **not** a control and reads nothing from the player's control-idle timer,
  so hiding the progress bar can never hide the watermark. `pointer-events:none`.
- Opacity is fixed (`0.55`) — no fade, no blink, no hide gap.
- Tamper checks no longer observe the element's `style` attribute (the motion loop
  rewrites `style.transform` every frame, which fired a `MutationObserver` 60×/s). A
  2 Hz computed-paint check (`display`/`visibility`/`opacity`) catches a mark hidden by
  an injected stylesheet instead, and text/removal tampering is still observed
  immediately.

## iOS native + VdoCipher WebView — the exact limitation

Those sessions render the **provider's** burned-in `rtext` annotation, which VdoCipher
draws server-side into the protected stream. It relocates once per `interval`
(8 s) rather than bouncing, and neither its position, speed, size, nor per-frame alpha is
ours to animate.

The app-owned overlay (`NativeWatermarkOverlay` / the injected page overlay) *is* drawn
above the protected surface and *does* bounce continuously — but `resolveWatermarkLayers`
suppresses it on those platforms because of two hard constraints:

1. **One visible watermark.** The provider mark still renders there; enabling the app
   overlay at the same time produces two visibly overlapping marks.
2. **Do not disable provider security.** The only way to have a single continuous mark
   on those platforms would be to stop attaching the provider `annotate`, which removes a
   tamper-resistant layer (it is burned into the stream) in favour of a client-rendered
   view that a modified client can hide. That trade is not taken.

**Strongest secure alternative currently in force:** keep the provider's burned-in mark
(the layer that survives client tampering) on iOS native and on the VdoCipher WebView,
and accept its provider-defined relocation cadence. Android native — where the SDK does
not draw the annotation — uses the app overlay, which is the continuous implementation.
If product policy ever prefers motion over tamper-resistance on a platform, that is a
one-line change (`ANDROID_NATIVE_RENDERS_PROVIDER_ANNOTATE` is the existing example of
such a switch) plus disabling `annotate` on the backend for that platform; it must be an
explicit decision, not a silent default.

## Dev-only switch

`.freebuff/player-harness/` builds `native.html` from the real `PLAYER_SCRIPT` +
`PLYR_JS`/`PLYR_CSS` and `server.cjs` serves it, so the centre-control lifecycle and the
watermark trajectory can be driven in a real browser instead of inferred from source.
