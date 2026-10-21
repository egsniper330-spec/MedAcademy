# Plyr centre play/pause fix + YouTube-style double-tap seeking

Scope: the `video_type = 'youtube'` lesson path (Plyr embedded in a WebView, see
`src/components/VideoPlayer.tsx`). The `vdocipher` path is explicitly out of scope —
see [Provider matrix](#provider-matrix).

## 1. Centre play/pause — verified root cause

Two independent defects, both in the WebView document (`src/lib/plyr/playerScript.ts`,
mirrored for web in `public/player/player.js`):

1. **Plyr hides the centre control while playing.** Plyr ships
   `.plyr--playing .plyr__control--overlaid{opacity:0;visibility:hidden}`.
   `visibility:hidden` removes an element from hit-testing, so the moment playback
   started the centre of the player had **no hit target at all**. A tap landed on the
   video surface (or on the cross-origin YouTube iframe composited above it), never on
   the button. Pausing was only possible through the auto-hiding bottom bar.
2. **The glyph was state-blind.** The overlaid `play-large` control is built with a
   single `play` icon and no `iconPressed`, so even when a tap did reach it, the icon
   never changed to `pause` — the control looked broken regardless of state.

A third contributing factor on device: the centre control sits over the cross-origin
YouTube iframe, which the native WebView composites as its own surface. A control with
no layer of its own can lose the paint/hit-test contest at the centre even though it
works in a desktop browser (that is how the bug was originally reproduced as "fine").

### Fix (all inside the embedded player script — no React state simulation)

- `injectControlCSS()` keeps `.plyr--playing .plyr__control--overlaid`
  `visibility:visible; pointer-events:auto` (dimmed to `.35`, full opacity on
  hover/focus), gives it `z-index:4` over the video wrapper (`z-index:0`) and promotes
  it with `transform:translate3d(...)` + `will-change` so it keeps its own composited
  layer above the iframe.
- `setCentreState()` swaps the button's `use` sprite between Plyr's **own**
  `play`/`pause` symbols and updates `aria-label`, driven by the player's real
  `play`/`pause`/`ended` events — never by the tap itself.
- `togglePlayback()` reads the media's *current* state at the moment of the tap
  (`!player.paused && !player.ended`) and issues a real `player.play()` /
  `player.pause()`. Because it never consults a cached flag, N rapid taps always
  alternate and each command is the one the state implied.
- A capture-phase `click` delegate on `[data-plyr]` claims **only** the overlaid
  centre control (`stopImmediatePropagation` so Plyr's own handler cannot produce a
  second toggle) and leaves the bottom-bar play button to Plyr's working handler.
- `clickToPlay` stays `false`: a plain single tap on the video surface still does
  nothing but show the controls.

## 2. Double-tap seeking

Implemented in the same script as a transparent layer `#plyr-gesture-zone` appended to
`.plyr__video-wrapper` (the video surface only):

- Stacking: wrapper/layer `z-index 0/1`, feedback `3`, centre control `4`, control
  bar `5`. The layer therefore never receives a tap that lands on a control, and a
  defensive `inRect()` check for the centre button and the control bar discards such
  taps anyway.
- Classifier `window.__medaSeekTap(now, x, y, w, h)`: two taps in the **same half**
  within `DOUBLE_TAP_MS` (320 ms) and within a proximity radius form a gesture; a
  single tap records state and does nothing. Left half → backward, right half →
  forward. A tap in the other half resets the pairing.
- `seekBy(direction)` → `clampSeekTarget(current, duration, direction)` → sets
  `player.currentTime`, i.e. Plyr's own seek API (for a YouTube provider that is the
  IFrame API's `seekTo`). Step is `config.seekTime` (10 s), clamped to
  `[0, duration - 1]`; an unknown/zero/NaN duration is a **no-op** so a live or
  not-yet-seekable stream is never seeked. The 1 s clearance keeps the seek off
  the exact end frame (which would fire `ended`).

  **Why 1 s and not 0.25 s (verified in a real browser).** The first
  implementation clamped to `duration - 0.25`. Exercising the live YouTube
  IFrame API showed the player *rejects* a seek that close to the end: it
  snapped back to the pre-seek position (and `duration - 0.5` snapped to an
  earlier keyframe), so forward double-taps in the last ~4 s silently did
  nothing. `duration - 1` is accepted cleanly. The unit test pins this exact
  landing point so the regression cannot return unnoticed.
- Repeated double-taps accumulate naturally: each pair re-reads the live
  `currentTime`.
- Feedback: `.plyr-gesture-feedback` (↻/↺ + "10 seconds"), `aria-hidden`, created
  lazily on first seek, one side at a time, hidden after `FEEDBACK_MS` (650 ms) and
  always `pointer-events:none` — it can never leave an invisible touch-blocking element.
- `touch-action:manipulation` on the layer and controls suppresses browser double-tap
  zoom/delayed taps without blocking anything.
- Works identically in portrait and fullscreen: fullscreen reuses the same WebView and
  Plyr instance in place (`YouTubePlayer.tsx`), and the layer is sized from
  `getBoundingClientRect()` on every tap.

## 3. Provider matrix

| Path | Player | Centre play/pause fix | Double-tap seeking |
| --- | --- | --- | --- |
| `youtube` (native WebView) | Plyr in `src/lib/plyr/playerScript.ts` | ✅ applied | ✅ applied |
| `youtube` (web build) | `public/player/player.js` | ✅ mirrored | ✅ mirrored |
| `vdocipher` (native) | `VdoPlayerView` via `VdoCipherPlayerNativeAdapter` | n/a — the native player owns its own controls | ❌ not injected |
| `vdocipher` (WebView fallback / web) | cross-origin `player.vdocipher.com` iframe | n/a | ❌ not injected |
| offline VdoCipher | `OfflineVideoPlayer.native.tsx` → `VdoPlayerView` | n/a | ❌ not injected |

**Documented limitation:** VdoCipher playback is a DRM-protected cross-origin iframe (or
a native `VdoPlayerView`). The parent document cannot script it (same-origin policy), and
injecting our own gesture layer over it would either be dead (the iframe keeps the
touches) or would interfere with the provider's protected player. Per the security
contract, unsupported controls are **not** injected into the protected player; VdoCipher
keeps its existing seek UI and playback behaviour unchanged.

## 4. Security / network-lock interaction

Both new code paths are hard-gated on `window.__medaSecurityStopped` (set by
`WEBVIEW_CONTAINMENT_SCRIPT` in `src/lib/useSecurityWebViewStop.ts` when a lock engages):

- `togglePlayback()` returns before touching the player → a contained player cannot be
  restarted from the centre control.
- the gesture layer returns before the classifier → no seek/resume either.

Containment also detaches iframes and strips media elements, so the gate remains the
authority: controls added here cannot bypass the lock.

## 5. Tests

`tests/plyrControlsAndSeeking.test.cjs` (73 assertions) executes the real generated
player script in a `vm` sandbox with a stub DOM and a fake Plyr, covering: real
play/pause commands, icon/label sync with real events, bridge messages
(`yt:playing/paused/ended`), right/left double-tap ±10 s, single-tap inertness, both
clamps, unknown duration, accumulation, feedback show/hide, control-bar and centre
exclusion, CSS stacking contract, unchanged fullscreen/speed/YouTube config, security
containment, and `public/player/player.js` parity.

Still required: physical-device verification on Android and iOS (see
`docs/DEVICE_VALIDATION_CHECKLIST.md`) — hit-testing over the composited YouTube iframe
and the feel of the 320 ms double-tap window are only provable on hardware.
