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

- `injectControlCSS()` gives the centre control `z-index:4` over the video wrapper
  (`z-index:0`) and promotes it with `transform:translate3d(...)` + `will-change` so it
  keeps its own composited layer above the iframe. It contains **no visibility rule** —
  visibility is decided per frame-state (see below).
- `setCentreState()` swaps the button's `use` sprite between Plyr's **own**
  `play`/`pause` symbols and updates `aria-label`, driven by the player's real
  `play`/`pause`/`ended` events — never by the tap itself.

### Idle lifecycle — the persistent centre button (second report)

Reported after the first fix: *the large blue centre button stays painted over the
video after the progress bar, title and all other transient controls have gone*.

**Root cause.** `centreShouldShow()` had a second predicate ahead of the bar's own
state:

```js
if (player.paused || player.ended) return true;   // ← the bug
return !root.classList.contains('plyr--hide-controls');
```

For a YouTube embed Plyr does **not** read the media element for `paused`; it proxies
`this.media.paused` where `media` is the embed wrapper `div` and the provider assigns
that property itself on play/pause (`Plyr`'s embed `play`/`pause` wrappers). It can
therefore disagree with the class Plyr actually paints from — and `player.ended` is a
proxy of the same kind. When it said "paused" while the painted state was *playing +
idle*, the first branch won and the script wrote `visibility:visible; opacity:.7` as
**inline style**, which outranks Plyr's own `.plyr--playing .plyr__control--overlaid`
hiding rule. The bar kept hiding (its class was correct); only the centre stayed up.
A second, independent path produced the same symptom: `centreButton()` used
`document.querySelector('.plyr__control--overlaid')`, i.e. the **first** such node in
document order. After a provider rebuild that can be a leftover button from a detached
root; every lifecycle write then landed on the wrong element while the live button kept
Plyr's default paint.

**Fix (single source of truth + live-root scoping).**

- `centreShouldShow()` is now `!root.classList.contains('plyr--hide-controls')` on the
  **live** root — the very class whose CSS hides the bar. No `player.paused`, no
  `player.ended`, no timer copy. The centre can no longer drift from the bar by a frame,
  an event or a provider rebuild.
- Paused UX is preserved without a second predicate: Plyr's `toggleControls()` treats
  `paused` as a show condition, so the bar (and therefore the centre Play control) stays
  up whenever playback is paused.
- `centreButton()` is scoped to `playerRoot()`; `hideStrayCentre()` closes (and
  `dedupeCentre()` removes) any overlaid button that is not inside the live root, so a
  stale node can never be left dressing the video.
- The `MutationObserver` on the live root watches `class` **and** `childList` (a rebuild
  that inserts a fresh button after the bar already hid), and still runs
  `dedupeCentre() + applyCentreVisibility()` together.
- One CSS mirror rule remains, keyed on the same class:
  `.plyr.plyr--hide-controls .plyr__control--overlaid{opacity:0;visibility:hidden;pointer-events:none}`.
  It never forces the button visible, so it cannot resurrect the bug, and it closes the
  case where a new button is inserted and no event reaches the script.

**Runtime verification** (real Chromium, the real generated document —
`.freebuff/player-harness/native.html`, built from `PLAYER_SCRIPT` + `PLYR_JS`/`PLYR_CSS`,
served over HTTP; and the web copy `public/player/index.html`):

| Step | Result |
| --- | --- |
| paused / initial load | centre visible (0.9), glyph `play` |
| play, controls still up | centre visible (0.7), glyph `pause` |
| idle > Plyr timeout | bar `plyr--hide-controls`, centre `hidden`, opacity 0 |
| 107 s of uninterrupted playback | centre stayed hidden in all 427 samples |
| tap the surface | bar + centre reappear together |
| idle again | both hide again |
| pause | bar up, centre visible, glyph `play`, full-strength opacity |
| centre tap | toggles exactly once (play → pause), glyph + `aria-label` follow |
| landscape resize (900×420) | lifecycle unchanged, watermark re-measured |
| duplicate/stale button injected | removed/closed; exactly one functional control |
| console | no errors |

### Confirming it on the reporter's device (debug builds only)

Debug builds render a small `DIAG` pill at the top-right of the YouTube player
(`src/components/YouTubePlayer.tsx`, gated on `__DEV__ && Platform.OS !== 'web'`). One tap
injects `window.__plyrDiag()` into the player document and shows the answer on screen:

```
centre: hidden (count 1)
button paint: opacity 0 / visibility hidden
bar: hidden-controls true / opacity 0 / visibility visible
state: playing true / paused false

PASS — the centre button is hidden together with the bar.
```

The diagnostic asks for the button's paint **and** the bar's own state in the same reply,
because "centre hidden" alone cannot tell the fix from the bug. A failing device reads
`FAIL — the bar is hidden but the centre button is still painted`; a tap taken while the
controls are still up says so instead of reporting a false pass. The reply is matched to
that tap (4 s window), so the automatic fullscreen diagnostic is only logged, never
popped up. The payload is state/dimensions only — no URL, token or recipient identity — so
a screenshot of it is safe to send. Release builds render no pill and schedule nothing.
- `togglePlayback()` reads the *current* state at the moment of the tap
  (`realPlaying()` → the live root's `plyr--playing` class, the same state Plyr paints)
  and issues a real `player.play()` / `player.pause()`. Because it never consults a
  cached flag, N rapid taps always alternate and each command is the one the state
  implied.
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
