/**
 * playerScript.ts
 *
 * The player initialization script injected into the native WebView.
 * Identical in structure to public/player/player.js (used on web).
 *
 * Runs after Plyr is available on window.Plyr. Reads config from
 * __PLAYER_CONFIG__ injected by the React Native component.
 *
 * __PLAYER_CONFIG__ fields:
 *   videoId        — YouTube video ID (required)
 *   resumeAt       — Resume position in seconds (default 0)
 *   watermarkName  — Watermark student name (optional)
 *   watermarkId    — Watermark student ID, WM-NNNN format (optional)
 *   hideFullscreen — When true, removes the fullscreen button (modal mode)
 *
 * postMessage protocol (player → host):
 *   { type: 'yt:ready' }
 *   { type: 'yt:progress',  currentTime: number, duration: number }
 *   { type: 'yt:playing' }
 *   { type: 'yt:paused' }
 *   { type: 'yt:ended',     currentTime: number, duration: number }
 *   { type: 'yt:error',     message: string }
 *   { type: 'yt:fullscreen', active: boolean }   ← inline player only
 *
 * ── Fullscreen architecture (native WKWebView) ────────────────────────────────
 *   The fullscreen button is a UI trigger ONLY. React Native owns fullscreen.
 *
 *   Old (broken) flow — depended on Plyr successfully entering browser fullscreen:
 *     button click → Plyr.enter() → enterfullscreen event → postMessage → RN Modal
 *     Problem: Plyr.enter() is a no-op inside WKWebView with a YouTube iframe.
 *
 *   New (correct) flow — intercepts the click before Plyr sees it:
 *     button click → [capture listener fires FIRST] → preventDefault +
 *       stopImmediatePropagation → postMessage yt:fullscreen → RN Modal
 *     Plyr.enter() is never called. The Modal IS the fullscreen experience.
 *
 *   Capture vs bubble: DOM event phases are capture → target → bubble.
 *   Plyr registers its controls listeners in the bubble phase (default).
 *   Our listener uses useCapture=true → it fires in the capture phase, before
 *   any bubble-phase handler. stopImmediatePropagation() in the capture phase
 *   prevents ALL subsequent listeners on the same element — including Plyr's
 *   bubble-phase handler — from firing.
 *
 * ── Watermark ─────────────────────────────────────────────────────────────────
 *   When watermarkName / watermarkId are set, a single overlay element is
 *   injected once at player ready and kept alive for the entire session.
 *
 *   Movement strategy (mirrors watermarkInjection.ts for VdoCipher):
 *   • One element, never removed or recreated during normal playback.
 *   • Repositioned every 30–60 s via transform:translate3d() only — no top/left
 *     changes, no reflow, compositor-only update.
 *   • Smooth transition (600 ms ease) applied in the injected <style>.
 *   • MutationObserver watches for removal/tampering; recover() recreates and
 *     restarts the timer only when tampered — never during normal playback.
 */
export const PLAYER_SCRIPT = `
(function () {
  'use strict';

  var cfg            = window.__PLAYER_CONFIG__ || {};
  var videoId        = cfg.videoId        || '';
  var resumeAt       = cfg.resumeAt       || 0;
  var wmName         = cfg.watermarkName  || '';
  var wmId           = cfg.watermarkId    || '';
  var hideFullscreen = !!cfg.hideFullscreen;

  document.getElementById('player').setAttribute('data-plyr-embed-id', videoId);

  // ── Bridge ─────────────────────────────────────────────────────────────────
  function send(obj) {
    var s = JSON.stringify(obj);
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(s);
    } else if (window.parent !== window) {
      window.parent.postMessage(s, '*');
    }
  }

  // ── Watermark — one element, never recreated, moves every 30–60 s ──────────
  //
  //  Architecture mirrors watermarkInjection.ts (VdoCipher WebView):
  //    • Single <div id="plyr-watermark"> appended once inside .plyr__video-wrapper.
  //    • top:0 / left:0 fixed at mount; all positioning via transform:translate3d().
  //    • Move timer writes ONLY el.style.transform + el.style.opacity — no reflow.
  //    • <style> injects a 600 ms ease transition so each move is smooth.
  //    • MutationObserver on the wrapper (childList) catches removal → recover().
  //    • Attribute observer on the element itself catches style/class tampering.
  //    • recover() is NEVER called during normal playback.
  //
  function injectWatermark(name, id) {
    if (!name && !id) return;

    var WM_ID   = 'plyr-watermark';
    var WM_ST_ID = 'plyr-wm-style';

    // ── 9-slot grid [xFrac, yFrac] — 8 % inset from every edge ────────────
    var G = [
      [0.08,0.08],[0.42,0.08],[0.72,0.08],
      [0.04,0.42],[0.35,0.42],[0.68,0.42],
      [0.08,0.74],[0.42,0.74],[0.72,0.74],
    ];
    var cur = -1;

    function rnd(a, b) { return a + Math.random() * (b - a); }
    function nxtSlot() {
      var n;
      do { n = Math.floor(Math.random() * G.length); } while (n === cur);
      cur = n;
      return G[n];
    }

    // Viewport captured once at mount — no layout reads in the timer callback.
    var _vw = 0, _vh = 0;
    function captureVP() {
      var w = document.querySelector('.plyr__video-wrapper') || document.querySelector('.plyr');
      _vw = (w && w.offsetWidth)  || window.innerWidth  || 320;
      _vh = (w && w.offsetHeight) || window.innerHeight || 180;
    }

    function mkTransform(slot, deg) {
      return 'translate3d(' + Math.round(slot[0] * _vw) + 'px,' +
                              Math.round(slot[1] * _vh) + 'px,0) rotate(' + deg + 'deg)';
    }

    // ── Inject transition <style> once ─────────────────────────────────────
    function injectCSS() {
      if (document.getElementById(WM_ST_ID)) return;
      var s = document.createElement('style');
      s.id = WM_ST_ID;
      s.textContent =
        '#' + WM_ID + '{' +
          'transition:transform 0.6s ease,opacity 0.6s ease;' +
          'will-change:transform,opacity;' +
        '}';
      (document.head || document.documentElement).appendChild(s);
    }

    // ── Find parent wrapper ────────────────────────────────────────────────
    function getWrapper() {
      return document.querySelector('.plyr__video-wrapper') ||
             document.querySelector('.plyr') ||
             document.body;
    }

    // ── Live references — stored to avoid querySelectorAll in callbacks ────
    var _el = null, _nEl = null, _iEl = null;

    // ── Build element (called only at first mount or after tamper recovery) ─
    function buildEl() {
      var d = document.createElement('div');
      d.id = WM_ID;
      d.style.cssText = [
        'position:absolute',
        'top:0',
        'left:0',
        'z-index:2147483647',
        'pointer-events:none',
        'user-select:none',
        '-webkit-user-select:none',
        'max-width:min(320px,55%)',
        'opacity:0',
        'transform:translate3d(0,0,0)',
        'line-height:1.4',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif',
      ].join(';');

      // Single-line format: "NAME • WM-NNNN"  (U+2022 bullet separator)
      _iEl = document.createElement('div');
      _iEl.style.cssText = [
        'font-size:13px',
        'font-weight:600',
        'letter-spacing:0.3px',
        'white-space:nowrap',
        'overflow:hidden',
        'text-overflow:ellipsis',
        'color:#fff',
        'text-shadow:0 1px 4px rgba(0,0,0,0.95),0 0 10px rgba(0,0,0,0.7)',
      ].join(';');
      _iEl.textContent = name ? name + ' \u2022 ' + String(id || '') : String(id || '');
      d.appendChild(_iEl);
      return d;
    }

    // ── Mount: append once, set initial position via double-rAF ───────────
    function mount() {
      if (document.getElementById(WM_ID)) return;
      injectCSS();
      captureVP();
      var w = getWrapper();
      if (!w) return;
      if (w.style.position !== 'relative' && w.style.position !== 'absolute') {
        w.style.position = 'relative';
      }
      _el = buildEl();
      w.appendChild(_el);
      // Double rAF: first rAF puts the element in the render tree at opacity:0,
      // second rAF triggers the transition to the initial random position.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (!_el) return;
          var slot = nxtSlot();
          var deg  = rnd(-3, 3).toFixed(1);
          _el.style.transform = mkTransform(slot, deg);
          _el.style.opacity   = rnd(0.40, 0.56).toFixed(2);
        });
      });
    }

    // ── Move: write transform + opacity only — compositor-only, zero reflow ─
    var _tmr = null;
    function move() {
      if (!_el || !_el.parentNode) { recover(); return; }
      var slot = nxtSlot();
      var deg  = rnd(-3, 3).toFixed(1);
      _el.style.transform = mkTransform(slot, deg);
      _el.style.opacity   = rnd(0.38, 0.58).toFixed(2);
    }

    // Self-rescheduling timer — random 30–60 s interval each tick.
    function scheduleTick() {
      _tmr = setTimeout(function () { move(); scheduleTick(); }, rnd(30000, 60000));
    }

    // ── Tamper check — no getComputedStyle, no querySelectorAll ───────────
    function isTampered() {
      if (!_el || !_el.parentNode) return true;
      if (_el.style.display === 'none')      return true;
      if (_el.style.visibility === 'hidden') return true;
      if (name && _nEl && _nEl.textContent !== name) return true;
      if (_iEl && _iEl.textContent !== (name ? name + ' \u2022 ' + String(id || '') : String(id || ''))) return true;
      return false;
    }

    // ── Recovery — only triggered by MutationObserver on tamper ──────────
    function recover() {
      if (_tmr) { clearTimeout(_tmr); _tmr = null; }
      if (_el && _el.parentNode) { try { _el.parentNode.removeChild(_el); } catch (e) {} }
      _el = null; _nEl = null; _iEl = null;
      cur = -1;
      mount();
      watch();     // re-attach observers to the new element
      scheduleTick();
    }

    // ── MutationObserver — minimal scope ──────────────────────────────────
    var _obs1 = null, _obs2 = null;
    function watch() {
      if (!window.MutationObserver) return;
      // Disconnect previous observers if recovering
      if (_obs1) { try { _obs1.disconnect(); } catch(e) {} }
      if (_obs2) { try { _obs2.disconnect(); } catch(e) {} }
      // Observer 1: wrapper direct children — catches node removal
      var w = getWrapper();
      if (w) {
        _obs1 = new MutationObserver(function (ms) {
          for (var i = 0; i < ms.length; i++) {
            var rm = ms[i].removedNodes;
            for (var r = 0; r < rm.length; r++) {
              if (rm[r] === _el) { recover(); return; }
            }
          }
        });
        _obs1.observe(w, { childList: true });
      }
      // Observer 2: watermark element itself — catches style/class tampering
      if (_el) {
        _obs2 = new MutationObserver(function () {
          if (isTampered()) recover();
        });
        _obs2.observe(_el, {
          attributes: true,
          characterData: true,
          subtree: true,
          attributeFilter: ['style', 'class', 'hidden'],
        });
      }
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────
    mount();
    scheduleTick();
    watch();
  }

  // ── CSS: suppress residual YouTube overlays that params cannot remove ────
  //
  //  Even with controls=0 some YouTube clients still paint branding elements
  //  over the iframe surface — notably:
  //    • .ytp-chrome-top        : title bar + channel name + watch-on-YouTube
  //    • .ytp-watermark         : YouTube watermark logo (bottom-right corner)
  //    • .ytp-pause-overlay     : "More videos" panel on pause
  //    • .ytp-endscreen-content : end-screen recommendations after video ends
  //    • .ytp-ce-element        : in-video suggested-video cards
  //    • .ytp-share-button-*    : share button cluster
  //
  //  Because the iframe is cross-origin we cannot inject CSS into it directly.
  //  However, WKWebView on iOS and WebView on Android run the inner iframe JS
  //  in the same process as the outer page, so a <style> injected into the
  //  PARENT document plus pointer-events:none on the iframe ensures that even
  //  if YouTube paints those elements they are invisible and non-interactive.
  //
  //  For the inner iframe content: injecting into document (outer page) only
  //  hides elements at the outer level.  The actual YT iframe DOM is sandboxed.
  //  The real suppression comes from the API params (controls=0, fs=0, rel=0).
  //  The CSS below is a belt-and-suspenders fallback for any outer-level bleed.
  //
  function suppressYouTubeUI() {
    if (document.getElementById('plyr-yt-suppress')) return;
    var s = document.createElement('style');
    s.id = 'plyr-yt-suppress';
    // These selectors target elements YouTube injects into the outer page or
    // into accessible iframe shadow content on some WebView versions.
    s.textContent = [
      // Outer-page YouTube overlays (some WebView builds render these outside
      // the iframe boundary)
      '.ytp-chrome-top,.ytp-chrome-top-buttons,.ytp-title-channel-logo',
      ',.ytp-title,.ytp-title-link,.ytp-title-text',
      ',.ytp-watermark,.ytp-youtube-button',
      ',.ytp-pause-overlay,.ytp-pause-overlay-container',
      ',.ytp-endscreen-content,.ytp-ce-element',
      ',.ytp-share-button,.ytp-share-button-visible',
      ',.ytp-spinner',
      // "Watch on YouTube" hover badge
      ',.ytp-cued-thumbnail-overlay-duration',
      // Info / annotation cards
      ',.ytp-cards-teaser,.iv-branding',
      '{display:none!important;opacity:0!important;pointer-events:none!important}',
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── iOS Safari tap-to-play/pause fix ──────────────────────────────────────
  //
  // Three compounding issues make Plyr's center play/pause unreliable on iOS
  // Safari and WKWebView.  All three must be addressed together:
  //
  //  1. 300 ms tap delay
  //     iOS Safari delays click events ~300 ms for double-tap-to-zoom detection.
  //     Without touch-action:manipulation every tap on the video area stalls
  //     before Plyr sees it, making the button appear to "miss."
  //
  //  2. click events not dispatched to <div> on iOS Safari
  //     iOS Safari only fires click on interactive elements or <div>/<span>
  //     with cursor:pointer.  Plyr's .plyr__video-embed is a plain <div>.
  //     When playing, .plyr__control--overlaid is hidden (visibility:hidden),
  //     so taps fall to .plyr__video-embed — iOS Safari never fires click on it
  //     and Plyr's togglePlay handler is never reached.
  //
  //  3. YouTube <iframe> absorbs unhandled touches
  //     Once issues 1 & 2 block Plyr, the touch reaches the cross-origin iframe.
  //     YouTube handles it through its own state machine, bypassing Plyr entirely.
  //
  // Fix:
  //  A. CSS — touch-action:manipulation eliminates the 300 ms delay; cursor:pointer
  //     on wrapper divs enables click dispatch on iOS Safari.
  //  B. Transparent <button> at z-index:1 inside .plyr__video-wrapper.
  //       • Above the iframe (no z-index) → intercepts taps before they reach it.
  //       • Below .plyr__control--overlaid (~z-index 2) → big play button unchanged.
  //       • Below #plyr-watermark (z-index:9999, pointer-events:none) → unaffected.
  //       • <button> always receives click on iOS Safari — no cursor:pointer needed.
  //       • stopPropagation() prevents Plyr's container handler double-toggling.
  //
  function fixiOSTapToToggle() {
    // Part A — CSS
    var style = document.createElement('style');
    style.textContent = [
      '.plyr,.plyr *{touch-action:manipulation;}',
      '.plyr__video-wrapper,.plyr__video-embed{cursor:pointer;}',
      '.plyr__video-wrapper,.plyr__video-embed,.plyr__control{-webkit-tap-highlight-color:transparent;}',
    ].join('');
    document.head.appendChild(style);

    // Part B — transparent button interceptor
    var wrapper = document.querySelector('.plyr__video-wrapper') ||
                  document.querySelector('.plyr') ||
                  document.body;
    if (window.getComputedStyle(wrapper).position === 'static') {
      wrapper.style.position = 'relative';
    }

    var tapBtn = document.createElement('button');
    tapBtn.id = 'plyr-tap-toggle';
    tapBtn.setAttribute('aria-hidden', 'true');
    tapBtn.setAttribute('tabindex', '-1');
    tapBtn.style.cssText = [
      'position:absolute',
      'top:0', 'left:0', 'right:0', 'bottom:0',
      'width:100%', 'height:100%',
      'background:transparent',
      'border:none',
      'padding:0', 'margin:0',
      'cursor:pointer',
      'z-index:1',
      'outline:none',
      '-webkit-tap-highlight-color:transparent',
      'touch-action:manipulation',
    ].join(';');

    tapBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (player) { player.togglePlay(); }
    });

    wrapper.appendChild(tapBtn);
  }

  // ── Plyr init ──────────────────────────────────────────────────────────────
  //   hideFullscreen=true  → modal mode: no fullscreen button, fullscreen API
  //     disabled entirely — the Modal itself is the fullscreen experience.
  //   hideFullscreen=false → inline mode: fullscreen button present as a UI
  //     trigger; the BUTTON CLICK (not Plyr entering fullscreen) sends the
  //     postMessage. Plyr never actually enters fullscreen on native.
  var controls = [
    'play-large', 'play', 'progress', 'current-time',
    'mute', 'volume', 'captions', 'settings',
  ];
  if (!hideFullscreen) {
    controls.push('fullscreen');
  }

  var player = new Plyr('#player', {
    controls: controls,
    // 'quality' omitted: HTML5-only, no effect on YouTube embeds.
    settings: ['captions', 'speed'],
    speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 4] },
    // fullscreen.enabled=false prevents Plyr from attempting browser fullscreen
    // in both modes. The button is still rendered for the inline player (it is
    // in the controls array above); we just prevent Plyr from calling
    // requestFullscreen() — our capture listener owns that interaction.
    fullscreen: { enabled: false, fallback: false, iosNative: false },
    playsinline: true,
    // ── YouTube iframe API parameters ──────────────────────────────────────
    // NOTE: Plyr 3.7.8 hardcodes controls/disablekb/playsinline from its own
    // logic in playerVars assembly; those keys in this object are merged after
    // Plyr's base so they are effectively redundant — kept for documentation.
    //
    // ── Anti-bot / "Sign in to confirm you're not a bot" ─────────────────
    // youtube-nocookie.com REQUIRES the 'origin' playerVar to be set to the
    // page's own origin.  Without it, youtube-nocookie.com has NO cookies AND
    // no trusted origin — it cannot distinguish a real user from a bot, so it
    // shows the verification screen.  Plyr does not set 'origin' automatically;
    // we must inject it via the config.youtube object so it passes through the
    // _() merge into playerVars.
    //
    // In this native WebView, window.location.href = 'https://medacademy.app'
    // (set by baseUrl in the WebView source prop), so origin is that domain.
    //
    // noCookie — kept false (standard youtube.com):
    //   youtube-nocookie.com was the immediate cause of the anti-bot screen.
    //   Even with origin set, nocookie is more aggressive about bot-detection
    //   in WebView environments where cookies are partitioned.  Standard
    //   youtube.com is the correct choice for a known-domain embed.
    //
    // controls=0       : hide native YT control bar (Plyr sets this itself too).
    // disablekb=1      : Plyr owns keyboard events.
    // fs=0             : disable YouTube's own fullscreen button.
    // iv_load_policy=3 : suppress annotation overlays.
    // modestbranding=1 : DEPRECATED — YouTube ignores since 2023.
    // rel=0            : same-channel end-screen suggestions only.
    // playsinline=1    : inline playback; prevents iOS native fullscreen.
    youtube: {
      controls:        0,
      disablekb:       1,
      fs:              0,
      iv_load_policy:  3,
      modestbranding:  1,
      rel:             0,
      playsinline:     1,
      noCookie:        false,
      origin:          'https://medacademy.app',
    },
  });

  // Expose for external seeks (e.g. inline WebView re-sync after modal closes).
  window.__plyr = player;

  // ── Events ─────────────────────────────────────────────────────────────────

  player.on('ready', function () {
    if (resumeAt > 0) player.currentTime = resumeAt;
    suppressYouTubeUI();
    injectWatermark(wmName, wmId);
    fixiOSTapToToggle();

    send({ type: 'yt:ready' });

    // ── Capture-phase click interceptor on the fullscreen button ──────────────
    //
    //   WHY THIS APPROACH:
    //   Plyr.enter() → requestFullscreen() is unreliable inside WKWebView with a
    //   YouTube iframe (the iframe sandboxes fullscreen). enterfullscreen never
    //   fires. Instead, we intercept the click BEFORE Plyr sees it.
    //
    //   WHY useCapture=true (capture phase):
    //   DOM event flow: capture → target → bubble.
    //   Plyr binds its fullscreen button handler in the BUBBLE phase (default).
    //   A capture-phase listener fires first. Calling stopImmediatePropagation()
    //   in capture phase cancels ALL subsequent listeners — including Plyr's
    //   bubble-phase handler — so Plyr.enter() is never invoked.
    //
    //   WHY gated on rnBridge:
    //   On plain web (no ReactNativeWebView), intercepting the click and calling
    //   stopImmediatePropagation() kills Plyr's own fullscreen handler with no
    //   fallback — fullscreen is completely disabled. Only intercept when the RN
    //   bridge exists; otherwise let Plyr execute browser fullscreen normally.
    //
    //   This is registered inside 'ready' because for YouTube embeds Plyr's
    //   Be.build() (which injects controls HTML) runs in a setTimeout(0), so
    //   the button element does not exist at new Plyr() time.
    if (!hideFullscreen) {
      var fsBtn = document.querySelector('[data-plyr="fullscreen"]');
      if (fsBtn) {
        var rnBridgeAtReady = !!window.ReactNativeWebView;
        fsBtn.addEventListener('click', function (e) {
          if (rnBridgeAtReady) {
            // Native path: cancel Plyr so the RN Modal opens instead.
            e.stopImmediatePropagation();
            e.preventDefault();
            send({ type: 'yt:fullscreen', active: true });
          }
          // Web path: do nothing — let Plyr call requestFullscreen() normally.
        }, true /* useCapture */);
      }
    }
  });

  // ── timeupdate throttled to 1 Hz ──────────────────────────────────────────
  // Plyr fires 'timeupdate' at ~4 Hz (tied to the HTML5 video timeupdate event
  // rate). Every call crosses the RN bridge: JSON.stringify → postMessage →
  // onMessage handler → handleVideoProgress on the JS thread. At 4 Hz this is
  // ~240 bridge crossings per minute — a significant source of jank on mobile.
  // Throttle to 1 s (matching the VdoCipher bridge's 1 s throttle) to reduce
  // bridge traffic by ~75% with no perceptible UX impact.
  var _lastProgressSend = 0;
  player.on('timeupdate', function () {
    var now = Date.now();
    if (now - _lastProgressSend < 1000) return;
    _lastProgressSend = now;
    send({ type: 'yt:progress', currentTime: player.currentTime, duration: player.duration });
  });

  // Play / pause state — used by the host to restore state after modal closes.
  player.on('play', function () {
    send({ type: 'yt:playing' });
  });
  player.on('pause', function () {
    send({ type: 'yt:paused' });
  });

  player.on('ended', function () {
    send({ type: 'yt:ended', currentTime: player.currentTime, duration: player.duration });
  });

  player.on('error', function (event) {
    var msg = (event.detail && event.detail.message) ? event.detail.message : 'Playback error';
    send({ type: 'yt:error', message: msg });
  });

  // NOTE: player.on('enterfullscreen') is intentionally NOT used.
  // Plyr never enters browser fullscreen on native (fullscreen.enabled=false).
  // The fullscreen button click is intercepted above; postMessage is sent directly.

})();
`;
