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
 *   watermarkId    — Watermark identifier from public_user_id, MED-#### format (optional)
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
 *   • CONTINUOUS billiard motion: requestAnimationFrame advances the position
 *     from elapsed time and reflects the velocity off the four edges of the
 *     measured video box, so the whole element stays inside the frame.
 *   • transform:translate3d() only — no top/left, no reflow, no CSS transition.
 *   • Two lines: display name, then the complete MED-#### id underneath.
 *   • Fixed opacity — the mark never fades, blinks or hides, and it is
 *     independent of the control-idle timer, so hiding controls cannot hide it.
 *   • MutationObserver watches for removal/tampering; recover() recreates and
 *     restarts the loop only when tampered — never during normal playback.
 *
 * ── Tap-to-toggle policy (IMPORTANT) ────────────────────────────────────────
 *   clickToPlay is false: a SINGLE tap on the video area never toggles playback.
 *   Play/Pause is controlled by Plyr's Play/Pause controls — including the
 *   centre `play-large` control, which this script keeps usable while playing
 *   (see the Centre-control block below) and drives from the real media state.
 *
 *   Do NOT add a tap-anywhere toggle: an earlier version had one
 *   (fixiOSTapToToggle) and it caused the tap-anywhere-pauses bug plus
 *   YouTube's title/channel HUD appearing on tap.
 *
 *   DOUBLE-TAP SEEKING is a gesture, not a toggle: two taps inside 320 ms in
 *   the same half of the video surface seek ±10 s. It is detected on a
 *   transparent layer over the VIDEO AREA ONLY, stacked BELOW the centre
 *   control (z-index 4) and the control bar (z-index 5), so it can never
 *   swallow a control tap. A single tap stays inert.
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

  // ── Control hit-area / stacking guarantees ─────────────────────────────────
  //   The centre play/pause control is an absolutely positioned 48 px button
  //   painted OVER the cross-origin YouTube iframe. Inside the native WebView
  //   that iframe is composited as its own surface, and an overlay that has no
  //   layer of its own can lose the paint / hit-test contest at the CENTRE of
  //   the player even though it wins in a desktop browser (the desktop browser
  //   is how this was reproduced as working, so the difference is the
  //   compositing path, not the DOM). Promoting the controls that sit over the
  //   video surface into their own composited layers, with an explicit z-index
  //   above the video wrapper, keeps them visible AND tappable.
  //   Purely additive CSS — no markup, no second play/pause mechanism.
  function injectControlCSS() {
    if (document.getElementById('plyr-control-fixes')) return;
    var s = document.createElement('style');
    s.id = 'plyr-control-fixes';
    s.textContent =
      '.plyr__video-wrapper{z-index:0;}' +
      '.plyr__control--overlaid{z-index:4;transform:translate3d(-50%,-50%,0);' +
        'will-change:transform;touch-action:manipulation;}' +
      // ── CENTRE CONTROL — lifecycle is DRIVEN BY SCRIPT, not by CSS ────────
      //
      // WHY (the persistent centre button that two CSS attempts did not fix):
      // the earlier fixes expressed the lifecycle as a CSS predicate on Plyr's
      // state classes — first "always visible while .plyr--playing" (visible
      // forever), then ".plyr--playing:not(.plyr--hide-controls)". Both assume
      // the centre button belongs to the SAME root, in the SAME stylesheet
      // cascade, at the SAME moment the control bar hides. A single stale node
      // — a provider rebuild that leaves a second '.plyr' root behind, or a
      // rebuild that inserts a fresh overlaid button whose root never enters
      // the hidden-controls state — satisfies neither rule and keeps painting a
      // full-opacity blue button over the video while the live bar is gone.
      // No CSS predicate can tell the live button from the stale one.
      //
      // So the stylesheet is now ONLY stacking/compositing. Visibility is
      // applied per frame-state by applyCentreVisibility() below, from the REAL
      // player state ('paused'/'ended' + the live root's own hidden-controls
      // class), as INLINE styles on the ONE surviving overlaid control — the
      // same value Plyr itself uses to paint the bar, read at the same instant
      // through a class MutationObserver. There is no CSS rule left that can
      // keep the button visible, and no rule left that can hide it while paused.
      '.plyr .plyr__control--overlaid{z-index:4;transform:translate3d(-50%,-50%,0);' +
        'will-change:transform;touch-action:manipulation;}' +
      // CSS MIRROR of the script lifecycle (defence in depth, not a workaround):
      // if a provider rebuild inserts a button after the bar hid and no event
      // reaches the script, this rule alone still closes it — the same class
      // that hides the bar hides the centre control. It never forces the
      // button visible, so it cannot resurrect the reported bug.
      '.plyr.plyr--hide-controls .plyr__control--overlaid{' +
        'opacity:0;visibility:hidden;pointer-events:none;}' +
      '.plyr__video .plyr__controls{z-index:5;touch-action:manipulation;}' +
      // ── Double-tap seek layer ────────────────────────────────────────────
      // Transparent, video-surface only, z-index 1: ABOVE the video/iframe
      // (wrapper is 0) and BELOW the centre control (4) and the bar (5), so
      // every control keeps its own hit area. Its own composited layer keeps
      // it hit-testable over a cross-origin iframe in WKWebView/WebView.
      '#plyr-gesture-zone{position:absolute;top:0;right:0;bottom:0;left:0;' +
        'z-index:1;background:transparent;touch-action:manipulation;' +
        '-webkit-tap-highlight-color:transparent;transform:translateZ(0);' +
        'will-change:transform;}' +
      // Seeking feedback: informational only — never a hit target, so it can
      // never leave an invisible touch-blocking element behind.
      '.plyr-gesture-feedback{position:absolute;top:50%;z-index:3;' +
        'transform:translateY(-50%);display:flex;align-items:center;gap:6px;' +
        'padding:10px 16px;border-radius:999px;' +
        'border:2px solid rgba(255,255,255,.75);color:#fff;background:rgba(0,0,0,.55);' +
        'font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
        'opacity:0;visibility:hidden;transition:opacity .18s ease;' +
        'pointer-events:none;}' +
      '.plyr-gesture-feedback[data-side="back"]{left:8%;}' +
      '.plyr-gesture-feedback[data-side="forward"]{right:8%;}' +
      '.plyr-gesture-feedback[data-show="1"]{opacity:1;visibility:visible;}';
    (document.head || document.documentElement).appendChild(s);
  }
  injectControlCSS();

  // ── Bridge ─────────────────────────────────────────────────────────────────
  function send(obj) {
    var s = JSON.stringify(obj);
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(s);
    } else if (window.parent !== window) {
      window.parent.postMessage(s, '*');
    }
  }

  // Diagnostic reply channel (dimensions/state only — never URLs, tokens or
  // credentials). The host asks via injectJavaScript(window.__plyrDiag());
  // used to prove the embedded media element EXISTS and has a live rect
  // inside the WebView when the host-side frame reports healthy but the
  // video area renders black (compositor-surface loss signature).
  window.__plyrDiag = function () {
    try {
      var f = document.querySelector('.plyr__video-embed iframe') || document.querySelector('iframe');
      var v = document.querySelector('video');
      var r = f ? f.getBoundingClientRect() : null;
      var vr = v ? v.getBoundingClientRect() : null;
      send({
        type: 'yt:diag',
        iframe: !!f,
        iframeRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
        video: !!v,
        videoRect: vr ? { x: vr.x, y: vr.y, w: vr.width, h: vr.height } : null,
        wm: !!document.getElementById('plyr-watermark'),
        docW: document.documentElement.clientWidth,
        docH: document.documentElement.clientHeight,
        // Centre-control proof for device runs: which node is live, what the
        // lifecycle decided, and the computed paint state that decision
        // produced — TOGETHER WITH the bar's own state at the same instant.
        // 'hidden' while the bar is up is the fix; 'visible' while the bar is
        // hidden is the reported bug, so both facts must be in one reply to be
        // decisive. State only — never a URL, token or identity.
        centre: (function () {
          var root = (player && player.elements && player.elements.container) ||
                     document.querySelector('.plyr');
          var b = root && root.querySelector
            ? root.querySelector('.plyr__control--overlaid')
            : document.querySelector('.plyr__control--overlaid');
          if (!b) return null;
          var cs = window.getComputedStyle ? window.getComputedStyle(b) : null;
          var bar = root && root.querySelector ? root.querySelector('.plyr__controls') : null;
          var bcs = bar && window.getComputedStyle ? window.getComputedStyle(bar) : null;
          var cls = root && root.classList;
          return {
            count: document.querySelectorAll('.plyr__control--overlaid').length,
            state: b.getAttribute('data-meda-centre'),
            opacity: cs ? cs.opacity : null,
            visibility: cs ? cs.visibility : null,
            hideControls: !!(cls && cls.contains('plyr--hide-controls')),
            playing: !!(cls && cls.contains('plyr--playing')),
            paused: !!(cls && cls.contains('plyr--paused')),
            barOpacity: bcs ? bcs.opacity : null,
            barVisibility: bcs ? bcs.visibility : null,
          };
        })(),
      });
    } catch (e) {
      send({ type: 'yt:diag', error: String(e && e.message || e) });
    }
  };

  // ── Forensic watermark — two lines, continuous billiard motion ─────────────
  //
  //  ADVANCED IN THREE WAYS over the previous 9-slot implementation:
  //
  //  1. CONTINUOUS MOTION. The old code teleported to one of nine fixed slots
  //     every 30–60 s with a 600 ms glide — visually stationary for half a
  //     minute, then a slide to a predictable place. This is a real trajectory:
  //     a requestAnimationFrame loop advances x/y from ELAPSED TIME (so the
  //     path is identical at 30 or 120 Hz), and every edge of the measured
  //     video box reflects the velocity exactly. It never pauses on a wall and
  //     never intentionally disappears.
  //
  //  2. TWO LINES. The recipient's display name on the first line and the
  //     complete public id (MED-####) directly underneath it. One line could
  //     only be made readable by shrinking the type; two lines let the id stay
  //     full-size, and the label no longer carries the "MedAcademy" brand.
  //
  //  3. RESPONSIVE SIZE. Font size is derived from the measured video box
  //     (13 px floor on a small phone player, up to 34 px in fullscreen)
  //     instead of the fixed 15 px that was barely visible when the host Modal
  //     expanded the player. Re-measured on every resize/fullscreen transition.
  //
  //  The mark is NOT a control: nothing here reads Plyr's control-idle timer,
  //  so hiding the controls can never hide it. pointer-events:none keeps every
  //  tap, drag and seek gesture on the player. Opacity is fixed — no fade, no
  //  blink, no hide gap. Only tampering (element removed or text changed)
  //  triggers recover().
  function injectWatermark(name, id) {
    if (!name && !id) return;

    var WM_ID = 'plyr-watermark';
    var WM_ST_ID = 'plyr-wm-style';

    var _el = null, _nEl = null, _iEl = null;
    var _raf = 0, _last = 0, _running = false, _lastTamperCheck = 0;
    var _x = 0, _y = 0, _vx = 0, _vy = 0;
    var _vw = 0, _vh = 0, _ew = 0, _eh = 0;
    var _resizeBound = false;

    // px/second inside the current video box. Slow enough to read, fast enough
    // that the mark is visibly travelling (a 360 px-wide phone player is
    // crossed in roughly 9 s).
    var SPEED_MIN = 26, SPEED_MAX = 44;

    // Largest simulation step. The reflection below FOLDS an overshoot
    // mathematically (a step can never tunnel through an edge), so this cap
    // only bounds how far one frame may travel. It must not be tiny: a
    // throttled/backgrounded frame (rAF drops to ~1 Hz) would otherwise cap
    // dt at a few ms and the mark would crawl instead of keeping its pace.
    var MAX_STEP_S = 1.0;

    function rnd(a, b) { return a + Math.random() * (b - a); }

    function wrapper() {
      return document.querySelector('.plyr__video-wrapper') ||
             document.querySelector('.plyr') ||
             document.body;
    }

    function measure() {
      var w = wrapper();
      _vw = (w && w.offsetWidth) || window.innerWidth || 320;
      _vh = (w && w.offsetHeight) || window.innerHeight || 180;
      if (_el) {
        _ew = _el.offsetWidth || 0;
        _eh = _el.offsetHeight || 0;
      }
    }

    function maxX() { var m = _vw - _ew; return m > 0 ? m : 0; }
    function maxY() { var m = _vh - _eh; return m > 0 ? m : 0; }

    // Responsive type: 6.2 % of the smaller video dimension, clamped.
    function fontSize() {
      var base = Math.min(_vw || 360, _vh || 202);
      var px = Math.round(base * 0.062);
      if (px < 13) px = 13;
      if (px > 34) px = 34;
      return px;
    }

    function applyFont() {
      var px = fontSize();
      if (_nEl) _nEl.style.fontSize = Math.round(px * 0.9) + 'px';
      if (_iEl) _iEl.style.fontSize = px + 'px';
    }

    // ── Style: no transform transition (motion is per-frame), fixed opacity ──
    function injectCSS() {
      if (document.getElementById(WM_ST_ID)) return;
      var s = document.createElement('style');
      s.id = WM_ST_ID;
      s.textContent =
        '#' + WM_ID + '{' +
          'transition:opacity 0.2s ease;' +
          'will-change:transform;' +
          'opacity:0.55;' +
        '}' +
        '#' + WM_ID + ' > div{' +
          'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
          'color:#fff;font-weight:600;letter-spacing:0.3px;white-space:nowrap;' +
          'line-height:1.25;' +
          'text-shadow:0 1px 4px rgba(0,0,0,0.95),0 0 10px rgba(0,0,0,0.7);' +
          '-webkit-font-smoothing:antialiased;' +
        '}';
      (document.head || document.documentElement).appendChild(s);
    }

    // ── Build element (first mount or tamper recovery only) ─────────────────
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
        'max-width:min(78%,420px)',
        'transform:translate3d(0,0,0)',
      ].join(';');

      if (name) {
        _nEl = document.createElement('div');
        _nEl.textContent = name;
        _nEl.style.fontWeight = '600';
        _nEl.style.opacity = '0.92';
        _nEl.style.overflow = 'hidden';
        _nEl.style.textOverflow = 'ellipsis';
        d.appendChild(_nEl);
      }
      _iEl = document.createElement('div');
      _iEl.textContent = String(id || '');
      _iEl.style.fontWeight = '700';
      d.appendChild(_iEl);
      return d;
    }

    function draw() {
      if (!_el) return;
      _el.style.transform = 'translate3d(' + Math.round(_x) + 'px,' + Math.round(_y) + 'px,0)';
    }

    // Exact reflection off both edges of one axis: the overshoot travels back,
    // so speed is preserved and the mark never sticks to a wall.
    function advance(pos, vel, dt, max) {
      var next = pos + vel * dt;
      var v = vel;
      for (var i = 0; i < 4; i++) {
        if (next < 0) { next = -next; v = -v; }
        else if (next > max) { next = 2 * max - next; v = -v; }
        else break;
      }
      if (next < 0) next = 0;
      if (next > max) next = max;
      return { pos: next, vel: v };
    }

    function step(ts) {
      if (!_el || !_el.parentNode) { _raf = 0; _running = false; recover(); return; }
      if (!_last) _last = ts;
      var dt = (ts - _last) / 1000;
      _last = ts;
      if (!isFinite(dt) || dt < 0) dt = 0;
      if (dt > MAX_STEP_S) dt = MAX_STEP_S;

      var ax = advance(_x, _vx, dt, maxX());
      var ay = advance(_y, _vy, dt, maxY());
      _x = ax.pos; _vx = ax.vel;
      _y = ay.pos; _vy = ay.vel;
      draw();
      // TAMPER RE-CHECK at 2 Hz, NOT per frame: this loop writes
      // _el.style.transform on every frame, so observing the element's 'style'
      // attribute would fire a MutationObserver 60×/s for the life of the
      // player. A 500 ms computed-paint check catches a mark hidden by an
      // injected stylesheet (which an inline-style check cannot see) with
      // negligible cost.
      var now = Date.now();
      if (now - _lastTamperCheck > 500) {
        _lastTamperCheck = now;
        if (isTampered()) { recover(); return; }
      }
      _raf = requestAnimationFrame(step);
    }

    function startMotion() {
      if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
      _last = 0;
      measure();
      applyFont();
      measure();

      var mx = maxX(), my = maxY();
      _x = mx * rnd(0.12, 0.88);
      _y = my * rnd(0.12, 0.88);

      // Diagonal start: every direction is visibly travelling on both axes,
      // never sliding along one edge.
      var speed = rnd(SPEED_MIN, SPEED_MAX);
      var share = rnd(0.55, 0.85);
      _vx = speed * share * (Math.random() < 0.5 ? -1 : 1);
      _vy = speed * Math.sqrt(Math.max(0, 1 - share * share)) * (Math.random() < 0.5 ? -1 : 1);

      draw();
      _running = true;
      _raf = requestAnimationFrame(step);
    }

    // Resize / fullscreen / rotation: re-measure, re-scale the type and clamp
    // the position immediately. The trajectory continues (velocity is kept).
    function onResize() {
      if (!_el) return;
      measure();
      applyFont();
      measure();
      if (_x > maxX()) _x = maxX();
      if (_y > maxY()) _y = maxY();
      _el.style.opacity = '0.55';
      draw();
    }

    function mount() {
      if (document.getElementById(WM_ID)) return;
      injectCSS();
      measure();
      var w = wrapper();
      if (!w) return;
      if (w.style.position !== 'relative' && w.style.position !== 'absolute') {
        w.style.position = 'relative';
      }
      _el = buildEl();
      w.appendChild(_el);
      startMotion();
      if (!_resizeBound) { _resizeBound = true; window.addEventListener('resize', onResize); }
      watch();
    }

    function isTampered() {
      if (!_el || !_el.parentNode) return true;
      if (_el.style.display === 'none') return true;
      if (_el.style.visibility === 'hidden') return true;
      // Computed paint — catches a stylesheet/CSSOM rule that hides the mark
      // (inline checks only see whatever this script itself wrote).
      if (window.getComputedStyle) {
        var cs = window.getComputedStyle(_el);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) return true;
      }
      if (name && _nEl && _nEl.textContent !== name) return true;
      if (_iEl && _iEl.textContent !== String(id || '')) return true;
      return false;
    }

    // Tamper only — normal playback never reaches this path.
    function recover() {
      if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
      _running = false;
      if (_el && _el.parentNode) { try { _el.parentNode.removeChild(_el); } catch (e) {} }
      _el = null; _nEl = null; _iEl = null;
      _last = 0;
      mount();
    }

    var _obs1 = null, _obs2 = null;
    function watch() {
      if (!window.MutationObserver) return;
      if (_obs1) { try { _obs1.disconnect(); } catch (e) {} }
      if (_obs2) { try { _obs2.disconnect(); } catch (e) {} }
      var w = getWrapperSafe();
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
      if (_el) {
        _obs2 = new MutationObserver(function () {
          if (isTampered()) recover();
        });
        // 'style' is deliberately NOT observed: the motion loop rewrites
        // style.transform every frame (that would fire this observer 60×/s).
        // Inline hiding is caught by the 2 Hz computed check in step().
        _obs2.observe(_el, {
          attributes: true,
          characterData: true,
          subtree: true,
          attributeFilter: ['class', 'hidden'],
        });
      }
    }

    function getWrapperSafe() {
      return document.querySelector('.plyr__video-wrapper') ||
             document.querySelector('.plyr') ||
             document.body;
    }

    // Bootstrap: double rAF so the element is painted and measurable first.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        mount();
        if (_el) _el.style.opacity = '0.55';
      });
    });
  }


  // ── Video-surface recovery (fullscreen/rotation black-frame fix) ──────────
  //
  // SYMPTOM (real devices, Android + iOS): entering host-controlled
  // fullscreen rotates and keeps audio, but the video IMAGE goes black while
  // the Plyr DOM (controls, watermark) keeps painting. That signature means
  // the media element's compositing surface was dropped during the WebView's
  // resize — the element is alive (audio continues) but its frames never
  // reach the screen. Reloading would restart playback; instead, a 1-frame
  // transform cycle on the <video> forces the compositor to reallocate the
  // surface WITHOUT touching playback state.
  //
  // Arming: auto-runs on every debounced in-page 'resize' (fires exactly when
  // the WebView frame changes — fullscreen enter/exit and rotation) and is
  // callable from the host via injectJavaScript → window.__plyrSurfaceNudge()
  // to cover launches where the resize event raced the surface teardown.
  var _nudgeTimer = null;
  function surfaceNudge() {
    try {
      // TARGET THE COMPOSITED MEDIA ELEMENT. For YouTube embeds that element
      // is the cross-origin IFRAME — the host document contains NO <video>
      // element, so a 'video'-only selector always missed and the nudge was a
      // silent no-op on Plyr (the black-frame bug persisted). The iframe is
      // the host document's own element, so restyling it is allowed; a 1-frame
      // transform cycle re-promotes its compositor layer without any
      // navigation (playback state untouched). 'video' stays as the fallback
      // for HTML5-media players.
      var v = document.querySelector('.plyr__video-embed iframe') ||
              document.querySelector('iframe') ||
              document.querySelector('video');
      if (!v) return;
      v.style.transform = 'translateZ(0)';
      void v.offsetHeight; // force style/layout flush
      requestAnimationFrame(function () { v.style.transform = ''; });
    } catch (e) { /* never break playback for a diagnostic */ }
  }
  window.addEventListener('resize', function () {
    if (_nudgeTimer) clearTimeout(_nudgeTimer);
    _nudgeTimer = setTimeout(surfaceNudge, 250);
  });
  window.__plyrSurfaceNudge = surfaceNudge;

  // ── Tap-to-toggle policy ───────────────────────────────────────────────────
  //
  // REMOVED: the former fixiOSTapToToggle() transparent <button> interceptor.
  // It covered the video area at z-index:1 and called player.togglePlay() on
  // every tap — i.e. a second, tap-anywhere play/pause mechanism ALONGSIDE
  // Plyr's own controls. That violated the one-authoritative-mechanism rule:
  // random video-area taps paused/resumed playback and summoned YouTube's
  // title/channel HUD (its pause/overlay state machine). This fix was written
  // for iOS Safari's legacy 300 ms tap delay and click-on-<div> limitations;
  // inside WKWebView/Android WebView the 300 ms delay does not apply, and
  // clicks on the wrapper reach Plyr's own clickToPlay handler directly.
  //
  // Policy: Play/Pause via Plyr's controls ONLY. clickToPlay:false below makes
  // video-area taps inert by configuration — no interceptors, no overlays, no
  // YouTube-DOM/CSS manipulation.

  // ── Plyr init ──────────────────────────────────────────────────────────────
  //   hideFullscreen=true  → modal mode: no fullscreen button, fullscreen API
  //     disabled entirely — the Modal itself is the fullscreen experience.
  //   hideFullscreen=false → inline mode: fullscreen button present as a UI
  //     trigger; the BUTTON CLICK (not Plyr entering fullscreen) sends the
  //     postMessage. Plyr never actually enters fullscreen on native.
  //   'rewind' / 'fast-forward' are Plyr's OWN supported control types: they
  //   are bound to the media's currentTime through Plyr's seek API and share
  //   the seekTime config below (±10 s). No custom seek UI is added — the
  //   controls are the ones Plyr ships, so their icons/tooltips/a11y already
  //   match the rest of the bar. Ordered around Play, the standard layout.
  var controls = [
    'play-large', 'rewind', 'play', 'fast-forward', 'progress', 'current-time',
    'mute', 'volume', 'captions', 'settings',
  ];
  if (!hideFullscreen) {
    controls.push('fullscreen');
  }

  var player = new Plyr('#player', {
    controls: controls,
    // ±10 s seeking for the rewind / fast-forward controls. Plyr's default is
    // already 10 s — declared explicitly so the step cannot drift silently and
    // so the value is visible next to the controls that consume it.
    seekTime: 10,
    // 'quality' omitted: HTML5-only, no effect on YouTube embeds.
    settings: ['captions', 'speed'],
    speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 4] },
    // fullscreen.enabled + fallback MUST both be true on native:
    // Plyr gates the fullscreen BUTTON with the CSS rule
    //   .plyr--fullscreen-enabled [data-plyr=fullscreen] { display:inline-block }
    // and that class is only applied when enabled && supported — where
    // supported = native Fullscreen API OR config.fullscreen.fallback.
    // With enabled:false the button is permanently display:none in the
    // Android WebView (no Fullscreen API for cross-origin iframes there),
    // which was the "Plyr has no fullscreen" bug.
    //
    // Plyr still never ENTERS browser fullscreen on native: the capture-phase
    // click interceptor below stops the click before Plyr's bubble-phase
    // handler and posts yt:fullscreen to RN — the RN Modal is the fullscreen
    // experience. fallback:true only makes the button VISIBLE and keeps
    // Plyr's state machine happy; enterfullscreen is never reached.
    fullscreen: { enabled: true, fallback: true, iosNative: false },
    playsinline: true,
    // Play/Pause via the Play/Pause control ONLY. Documented Plyr option —
    // true would toggle playback whenever the video container is clicked,
    // which is exactly the "tapping the video pauses/resumes" complaint.
    clickToPlay: false,
    // ── YouTube iframe API parameters (verified against developers.google.com/
    // youtube/player_parameters — current supported set) ────────────────────
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
    // rel=0            : end-screen suggestions limited to same channel — the
    //                    maximum reduction YouTube supports since Sept 2018.
    // playsinline=1    : inline playback; prevents iOS native fullscreen.
    // color='white'    : SUPPORTED param — progress-bar accent white instead of
    //                    YouTube red. Visible wherever YouTube paints its own
    //                    bar (e.g. pre-play title states); Plyr's own bar is
    //                    styled by PLYR_CSS.
    // hl='en'          : SUPPORTED param — deterministic interface language for
    //                    player tooltips/menus instead of locale-dependent.
    //
    // REJECTED as deprecated (verified in official revision history):
    //   modestbranding (deprecated Aug 15 2023, "no effect"), showinfo (2018),
    //   autohide (2015), theme (2015). Sending them is dead weight.
    youtube: {
      controls:        0,
      disablekb:       1,
      fs:              0,
      iv_load_policy:  3,
      rel:             0,
      playsinline:     1,
      color:           'white',
      hl:              'en',
      noCookie:        false,
      origin:          'https://medacademy.app',
    },
  });

  // Expose for external seeks (e.g. inline WebView re-sync after modal closes).
  window.__plyr = player;

  // ── ±10 s seek helper ──────────────────────────────────────────────────────
  //   Clamps the target into the media's valid range and is a deliberate NO-OP
  //   when the duration is unknown or zero (live stream / not yet seekable), so
  //   a forward seek can never push playback past the end of the media.
  //   Shared by the rewind / fast-forward controls AND the double-tap gesture,
  //   so both act through Plyr's own seek API on the same instance.
  function seekStep() {
    var s = player && player.config ? player.config.seekTime : null;
    return (typeof s === 'number' && isFinite(s) && s > 0) ? s : 10;
  }

  function clampSeekTarget(current, duration, direction) {
    if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) return null;
    if (typeof current !== 'number' || !isFinite(current)) current = 0;
    var raw = current + direction * seekStep();
    if (!isFinite(raw)) return null;
    // Never land exactly on the end (that fires 'ended'). The margin was 0.25 s,
    // but verified in a REAL browser against the live YouTube IFrame API: the
    // player REJECTS a seek to duration-0.25 (it snaps back to the pre-seek
    // position), while duration-1 is accepted cleanly. So the clamp must keep a
    // full second of clearance, or forward double-taps near the end silently do
    // nothing. 1 s is the largest margin that is both safe and accepted.
    var max = Math.max(0, duration - 1);
    return Math.max(0, Math.min(raw, max));
  }

  function seekBy(direction) {
    // SECURITY: the lock's containment sets this flag when it stops playback —
    // a seek must never move or restart a contained player.
    if (window.__medaSecurityStopped) return null;
    var target = clampSeekTarget(player.currentTime, player.duration, direction);
    if (target === null) return null;
    player.currentTime = target;
    return target;
  }

  // ── Centre play/pause: real state in, real state out ───────────────────────
  //   ROOT CAUSE (reported): Plyr builds "play-large" as a NON-toggle control —
  //   one icon ("play"), no iconPressed — and its own CSS hides the control
  //   while playing. Tapping the centre could therefore never pause (no hit
  //   target, and the glyph was always "play"). These helpers:
  //     • keep the control visible/tappable (injectControlCSS above);
  //     • swap its glyph between Plyr's OWN play/pause sprite symbols from the
  //       player's real play / pause / ended events;
  //     • toggle against the media's OWN paused/ended state at the moment of
  //       the tap, so rapid taps cannot both resolve to the same command.
  /**
   * The ONE centre button that belongs to the LIVE player — scoped to the live
   * root on purpose.
   *
   *   document.querySelector('.plyr__control--overlaid') returns the FIRST such
   *   node in document order, which after a provider rebuild can be a leftover
   *   button from a detached root. Styling that node is a no-op for the live
   *   player (its own button keeps Plyr's default paint: opacity .9, visible)
   *   while the live bar hides — the exact "button stays while the bar goes"
   *   symptom, and it also makes every write land on the wrong element. So the
   *   lookup is scoped to the live root; strays are neutralised separately in
   *   dedupeCentre().
   */
  function centreButton() {
    var root = playerRoot();
    if (root && root.querySelector) return root.querySelector('.plyr__control--overlaid');
    return document.querySelector('.plyr__control--overlaid');
  }

  /** The ONE element Plyr is actually driving right now. */
  function playerRoot() {
    if (player && player.elements && player.elements.container) return player.elements.container;
    return document.querySelector('.plyr');
  }

  /**
   * SHOULD THE CENTRE CONTROL BE PAINTED RIGHT NOW?
   *
   *   EXACTLY the control bar's lifecycle and nothing else: painted while the
   *   bar is up, gone the instant the bar goes. The single predicate is Plyr's
   *   own 'plyr--hide-controls' class on the LIVE root — the very class whose
   *   CSS rule hides the bar — so the centre control cannot drift from it by a
   *   frame, an event, or a provider rebuild.
   *
   *   Paused-state UX is preserved WITHOUT a second predicate: Plyr's own
   *   toggleControls() treats 'paused' as a show condition, so the bar (and
   *   therefore the centre control) stays up whenever playback is paused. The
   *   previous version read player.paused/player.ended itself; for a YouTube
   *   embed those are proxies on the embed wrapper div (this.media.paused),
   *   re-assigned by the provider on play/pause — i.e. state that can disagree
   *   with the class Plyr paints from. That disagreement is what could keep the
   *   button up while the bar was hidden.
   */
  function centreShouldShow() {
    var root = playerRoot();
    if (!root || !root.classList) return true;
    return !root.classList.contains('plyr--hide-controls');
  }

  /**
   * APPLY the lifecycle to the button, as INLINE style.
   *
   * Inline wins over every stylesheet rule (Plyr's own ".plyr--playing
   * .plyr__control--overlaid{opacity:0;visibility:hidden}" included), so the
   * state below is authoritative regardless of cascade order, injected style
   * ordering, or a rules rewrite by a provider script. 'style.opacity = '''
   * hands the paused state back to Plyr's own default (0.9) — we never hard-code
   * the paused look ourselves.
   */
  function applyCentreVisibility() {
    var root = playerRoot();
    var playing = !!(root && root.classList && root.classList.contains('plyr--playing'));
    var show = centreShouldShow();
    var btn = centreButton();
    if (btn && btn.style) {
      if (show) {
        btn.style.visibility = 'visible';
        btn.style.pointerEvents = 'auto';
        // Dimmed while playing-with-controls; full strength while paused, where
        // Plyr's own stylesheet value is already what the design wants.
        btn.style.opacity = playing ? '0.7' : '';
        btn.removeAttribute('aria-hidden');
      } else {
        // display:none (not just opacity) so a hidden button can never be a
        // hit target and can never be caught mid-transition over the video.
        btn.style.opacity = '0';
        btn.style.visibility = 'hidden';
        btn.style.pointerEvents = 'none';
        btn.setAttribute('aria-hidden', 'true');
      }
      btn.setAttribute('data-meda-centre', show ? 'visible' : 'hidden');
    }
    // Any overlaid button that is NOT inside the live root can never receive a
    // lifecycle update from us (Plyr stopped painting its root long ago), so it
    // is closed here rather than left dressing the video with a dead button.
    hideStrayCentre();
  }

  function hideStrayCentre() {
    var root = playerRoot();
    if (!root) return;
    var all = document.querySelectorAll('.plyr__control--overlaid');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (root.contains && root.contains(n)) continue;
      if (!n.style) continue;
      n.style.opacity = '0';
      n.style.visibility = 'hidden';
      n.style.pointerEvents = 'none';
      n.setAttribute('data-meda-centre', 'stray');
      n.setAttribute('aria-hidden', 'true');
    }
  }

  function setCentreState(playing) {
    var btn = centreButton();
    if (!btn || !btn.setAttribute) return;
    var state = playing ? 'playing' : 'paused';
    if (btn.getAttribute('data-meda-state') === state) return;
    btn.setAttribute('data-meda-state', state);
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    var use = btn.querySelector ? btn.querySelector('use') : null;
    if (!use || !use.getAttribute) return;
    var href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
    if (!href) return;
    var next = href.replace(/(play|pause)$/, playing ? 'pause' : 'play');
    if (next === href) return;
    if (use.getAttribute('href') !== null) use.setAttribute('href', next);
    if (use.getAttribute('xlink:href') !== null) {
      if (use.setAttributeNS) {
        use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', next);
      } else {
        use.setAttribute('xlink:href', next);
      }
    }
  }

  /** Real playback state, read from the class Plyr paints (not a proxy). */
  function realPlaying() {
    var root = playerRoot();
    return !!(root && root.classList && root.classList.contains('plyr--playing'));
  }

  // Exactly ONE centre control — and it must be the LIVE one.
  //
  // Plyr rebuilds its control bar when the provider finishes loading; a rebuild
  // can leave the previous overlaid node (or a whole previous root) behind. A
  // leftover node is the worst case for a class-based CSS rule: its own root
  // never enters the hidden-controls state, so a stylesheet predicate on
  // '.plyr--hide-controls' can never hide it, and it keeps painting a blue
  // button over the video after the live bar has gone. Resolution order:
  //   1. an overlaid button INSIDE the live root is the one to keep;
  //   2. any other overlaid node in the document is removed (stale root or
  //      provider duplicate).
  function dedupeCentre() {
    var all = document.querySelectorAll('.plyr__control--overlaid');
    if (!all || all.length < 2) return;
    var root = playerRoot();
    var keep = null;
    for (var i = 0; i < all.length; i++) {
      if (root && root.contains && root.contains(all[i])) { keep = all[i]; break; }
    }
    if (!keep) keep = all[0];
    for (var j = 0; j < all.length; j++) {
      var n = all[j];
      if (n !== keep && n.parentNode) n.parentNode.removeChild(n);
    }
  }

  function syncCentreState() {
    dedupeCentre();
    setCentreState(realPlaying());
    applyCentreVisibility();
    observeCentre();
  }

  // ── Centre-control lifecycle wiring ────────────────────────────────────────
  // Three independent triggers, so no single missed event can leave the button
  // in the wrong state:
  //  1. CLASS OBSERVER on the live root — fires at the exact instant Plyr adds
  //     or removes 'plyr--hide-controls', i.e. the same moment the bar changes.
  //     This is the primary path and it does not depend on any provider event.
  //  2. Plyr's OWN control visibility events ('controlsshown'/'controlshidden')
  //     plus play/pause/ended/state events, for providers whose bar state and
  //     event order differ.
  //  3. A 1 Hz safety re-sync on the already-throttled progress path (below),
  //     which costs one classList read when nothing changed.
  var _centreObserver = null;
  function observeCentre() {
    if (!window.MutationObserver) return;
    var root = playerRoot();
    if (!root || root === (_centreObserver && _centreObserver.__medaRoot)) return;
    if (_centreObserver) { try { _centreObserver.disconnect(); } catch (e) {} }
    // dedupe first: a provider rebuild can insert its button in the same
    // mutation batch that adds/removes the bar class, and the lifecycle must
    // land on the live node.
    var obs = new MutationObserver(function () { dedupeCentre(); applyCentreVisibility(); });
    // class → the bar's idle lifecycle; childList → a provider rebuild that
    // inserts a fresh overlaid button after the bar already hid.
    obs.observe(root, { attributes: true, attributeFilter: ['class'], childList: true });
    obs.__medaRoot = root;
    _centreObserver = obs;
  }

  ['controlsshown', 'controlshidden', 'play', 'playing', 'pause', 'ended',
   'ready', 'seeking', 'seeked', 'waiting', 'canplay', 'canplaythrough',
   'loadeddata', 'loadstart', 'emptied'].forEach(function (evt) {
    player.on(evt, syncCentreState);
  });

  function togglePlayback() {
    // SECURITY: never restart a player the lock has contained.
    if (window.__medaSecurityStopped) return;
    // Authoritative toggle — read the media's own state now, not a cached flag.
    // The glyph flips on the tap (optimistic) because a YouTube play()/pause()
    // round-trips through the iframe, and waiting for it is what made the
    // centre tap feel slow; syncCentreState() reconciles with the real state.
    var wasPlaying = realPlaying();
    setCentreState(!wasPlaying);
    if (wasPlaying) player.pause();
    else player.play();
    syncCentreState();
    // Provider commands are asynchronous: re-read on the next frame so the
    // glyph and the visibility follow what actually happened — a centre tap
    // must not be able to leave the button up after playback resumes.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(syncCentreState);
  }

  // ── Double-tap seeking (YouTube-style) ────────────────────────────────────
  //   Layer over the VIDEO SURFACE only (never the controls), single tap inert,
  //   two taps within DOUBLE_TAP_MS in the same half seek ±seekStep().
  var DOUBLE_TAP_MS = 320;
  var FEEDBACK_MS = 650;
  var _lastTap = { t: 0, x: 0, y: 0, zone: null };

  /** Pure tap classifier (also a test/diagnostic seam — dimensions only). */
  window.__medaSeekTap = function (now, x, y, w, h) {
    if (!(w > 0) || !(h > 0)) return null;
    var zone = x < w / 2 ? 'back' : 'forward';
    var near = Math.abs(x - _lastTap.x) <= Math.max(48, w * 0.12) &&
               Math.abs(y - _lastTap.y) <= Math.max(48, h * 0.25);
    var isDouble = _lastTap.zone === zone && near && (now - _lastTap.t) <= DOUBLE_TAP_MS;
    if (isDouble) {
      _lastTap = { t: 0, x: 0, y: 0, zone: null }; // a second double-tap starts over
      return zone;
    }
    _lastTap = { t: now, x: x, y: y, zone: zone };
    return null;
  };

  function inRect(el, clientX, clientY, pad) {
    if (!el || !el.getBoundingClientRect || typeof clientX !== 'number') return false;
    var r = el.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return false;
    return clientX >= r.left - pad && clientX <= r.right + pad &&
           clientY >= r.top - pad && clientY <= r.bottom + pad;
  }

  function showSeekFeedback(zone, target) {
    var wrapper = document.querySelector('.plyr__video-wrapper');
    if (!wrapper || !wrapper.appendChild) return;
    var side = zone === 'back' ? 'back' : 'forward';
    var el = document.getElementById('plyr-seek-' + side);
    if (!el) {
      el = document.createElement('div');
      el.id = 'plyr-seek-' + side;
      el.className = 'plyr-gesture-feedback';
      el.setAttribute('data-side', side);
      el.setAttribute('data-show', '0');
      el.setAttribute('aria-hidden', 'true');
      var arrow = document.createElement('span');
      arrow.className = 'plyr-seek-arrow';
      arrow.textContent = side === 'back' ? '\u21ba' : '\u21bb';
      var label = document.createElement('span');
      label.className = 'plyr-seek-label';
      label.textContent = seekStep() + ' seconds';
      el.appendChild(arrow);
      el.appendChild(label);
      wrapper.appendChild(el);
    }
    // Only one side is ever shown.
    var other = document.getElementById('plyr-seek-' + (side === 'back' ? 'forward' : 'back'));
    if (other && other.setAttribute) other.setAttribute('data-show', '0');
    var lbl = el.querySelector ? el.querySelector('.plyr-seek-label') : null;
    if (lbl) lbl.textContent = seekStep() + ' seconds';
    el.setAttribute('data-show', '1');
    if (el.__medaFeedbackTimer) clearTimeout(el.__medaFeedbackTimer);
    el.__medaFeedbackTimer = setTimeout(function () {
      el.setAttribute('data-show', '0');
      el.__medaFeedbackTimer = null;
    }, FEEDBACK_MS);
  }

  function installSeekGestures() {
    if (document.getElementById('plyr-gesture-zone')) return;
    var wrapper = document.querySelector('.plyr__video-wrapper');
    if (!wrapper || !wrapper.appendChild) return;
    var layer = document.createElement('div');
    layer.id = 'plyr-gesture-zone';
    layer.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(layer);

    layer.addEventListener('click', function (e) {
      // SECURITY: contained players are frozen — no seeking either.
      if (window.__medaSecurityStopped) return;
      var rect = layer.getBoundingClientRect ? layer.getBoundingClientRect() : null;
      var w = (rect && rect.width) || layer.offsetWidth || 0;
      var h = (rect && rect.height) || layer.offsetHeight || 0;
      if (!(w > 0) || !(h > 0)) return;
      var left = (rect && rect.left) || 0;
      var top = (rect && rect.top) || 0;
      var clientX = typeof e.clientX === 'number' ? e.clientX : left;
      var clientY = typeof e.clientY === 'number' ? e.clientY : top;
      // Defensive only: the stacking order already puts the centre control and
      // the control bar above this layer, so their taps never arrive here.
      if (inRect(centreButton(), clientX, clientY, 8)) return;
      if (inRect(document.querySelector('.plyr__controls'), clientX, clientY, 0)) return;
      var zone = window.__medaSeekTap(Date.now(), clientX - left, clientY - top, w, h);
      if (!zone) return; // first tap: nothing happens (single taps stay inert)
      if (e.stopPropagation) e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      var target = seekBy(zone === 'back' ? -1 : 1);
      if (target === null) return; // unknown duration: no misleading feedback
      showSeekFeedback(zone, target);
    }, false);
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  player.on('ready', function () {
    if (resumeAt > 0) player.currentTime = resumeAt;
    injectWatermark(wmName, wmId);

    // Centre control glyph + idle lifecycle + double-tap seek layer. All three
    // are idempotent, and 'ready' is late enough for the embed's controls (Plyr
    // injects them in a deferred build) while still before the first user
    // interaction. observeCentre() rebinds to the live root, so a provider
    // rebuild that replaces it cannot leave the observer on a stale element.
    syncCentreState();
    observeCentre();
    installSeekGestures();

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

    // ── Centre (play-large) play/pause + ±10 s seek controls ─────────────────
    //   WHY A DELEGATED CAPTURE LISTENER (and not a per-element bind):
    //   Plyr binds control handlers with bind() while it builds the controls.
    //   For a YouTube EMBED the control bar is injected asynchronously (the
    //   provider build is deferred), which is exactly the window in which a
    //   control can end up painted but without a working handler — the reported
    //   symptom was "the large centre play/pause button does nothing while the
    //   bottom-bar play/pause works". A capture-phase listener on the document
    //   is immune to that ordering: it is installed once, always runs before
    //   any target listener, and resolves the control from the event target, so
    //   it also survives a control-bar rebuild or a provider re-init.
    //   stopImmediatePropagation() guarantees the action runs EXACTLY ONCE even
    //   when Plyr's own handler is present (no double toggle, no 20 s seek).
    //
    //   SCOPE: only the CENTRE button and the two seek buttons. The bottom-bar
    //   play/pause keeps Plyr's own (working) handler, and no listener is added
    //   over the video surface — the one-mechanism tap-to-toggle policy at the
    //   top of this file still holds.
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var el = t.closest('[data-plyr]');
      if (!el) return;
      var kind = el.getAttribute('data-plyr');
      var isCentre = kind === 'play' &&
        !!(el.classList && el.classList.contains('plyr__control--overlaid'));
      if (isCentre) {
        e.stopImmediatePropagation();
        e.preventDefault();
        // toggles the REAL player (play/pause), never a visual simulation
        togglePlayback();
        return;
      }
      if (kind === 'rewind' || kind === 'fast-forward') {
        e.stopImmediatePropagation();
        e.preventDefault();
        seekBy(kind === 'rewind' ? -1 : 1);
      }
    }, true /* useCapture */);
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
    // SAFETY RE-SYNC (1 Hz, deliberately BEFORE the bridge throttle): one
    // classList read when nothing changed, and an authoritative re-apply of the
    // centre-control lifecycle when something did. Covers a provider that never
    // emits a state event and a rebuild that swapped the root under the
    // observer — the two ways the button could otherwise stay stale.
    applyCentreVisibility();
    var now = Date.now();
    if (now - _lastProgressSend < 1000) return;
    _lastProgressSend = now;
    send({ type: 'yt:progress', currentTime: player.currentTime, duration: player.duration });
  });

  // Play / pause state — used by the host to restore state after modal closes.
  player.on('play', function () {
    syncCentreState();
    send({ type: 'yt:playing' });
  });
  player.on('pause', function () {
    syncCentreState();
    send({ type: 'yt:paused' });
  });

  player.on('ended', function () {
    syncCentreState();
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
