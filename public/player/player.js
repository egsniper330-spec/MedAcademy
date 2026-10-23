/* eslint-disable */
/* oxlint-disable */
/**
 * player.js — MedAcademy YouTube player initialization (web / iframe path).
 *
 * Loaded after plyr.js inside public/player/index.html.
 * Reads config from URL search params, initializes Plyr, and forwards
 * player events to the parent frame via postMessage.
 *
 * URL params:
 *   v     — YouTube video ID (required)
 *   t     — Resume position in seconds (optional, default 0)
 *   wname — Watermark student name (optional)
 *   wid   — Watermark student / forensic ID (optional)
 *
 * postMessage protocol (player → parent):
 *   { type: 'yt:ready' }
 *   { type: 'yt:progress',   currentTime, duration }
 *   { type: 'yt:playing' }
 *   { type: 'yt:paused' }
 *   { type: 'yt:ended',      currentTime, duration }
 *   { type: 'yt:error',      message }
 *   { type: 'yt:fullscreen', active: true|false }
 */
(function () {
  'use strict';

  // ── Config from URL ──────────────────────────────────────────────────────────
  var params   = new URLSearchParams(window.location.search);
  var videoId  = params.get('v')     || '';
  var resumeAt = parseFloat(params.get('t') || '0');
  var wmName   = params.get('wname') || '';
  var wmId     = params.get('wid')   || '';

  document.getElementById('player').setAttribute('data-plyr-embed-id', videoId);

  // ── Bridge ───────────────────────────────────────────────────────────────────
  function send(obj) {
    var s = JSON.stringify(obj);
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(s);
    } else if (window.parent !== window) {
      window.parent.postMessage(s, '*');
    }
  }

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
      // _el.style.transform every frame, so observing the element's 'style'
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


  // ── Tap-to-toggle policy ─────────────────────────────────────────────────────
  //
  // REMOVED: the former fixiOSTapToToggle() transparent <button> interceptor.
  // It covered the video area at z-index:1 and called player.togglePlay() on
  // every tap — a second, tap-anywhere play/pause mechanism ALONGSIDE Plyr's
  // own controls. That violated the one-authoritative-mechanism rule: random
  // video-area taps paused/resumed playback and summoned YouTube's
  // title/channel HUD (its pause/overlay state machine). The fix targeted iOS
  // Safari's legacy 300 ms tap delay and click-on-<div> limitations; inside a
  // modern WebView those constraints don't apply, and clicks on the wrapper
  // reach Plyr's own clickToPlay handler directly.
  //
  // Policy: Play/Pause via Plyr's controls ONLY. clickToPlay:false below makes
  // video-area taps inert by configuration — no interceptors, no overlays, no
  // YouTube-DOM/CSS manipulation.

  // ── Initialize Plyr ──────────────────────────────────────────────────────────
  var player = new Plyr('#player', {
    // ── Control layout — matches official Plyr demo exactly ──────────────────
    // 'captions' : shows closed-caption toggle (auto-hidden when none available)
    // 'pip'      : Picture-in-Picture button (auto-hidden when browser lacks support)
    // 'airplay'  : AirPlay button (auto-hidden on non-Safari)
    // These three are rendered by Plyr only when the browser supports them;
    // they are never visible on unsupported platforms — no harm in including them.
    // 'rewind' / 'fast-forward' are Plyr's own control types, bound to the
    // media's currentTime through Plyr's seek API and sharing seekTime (±10 s).
    controls: [
      'play-large', 'rewind', 'play', 'fast-forward', 'progress', 'current-time',
      'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen',
    ],
    // ±10 s seek step for rewind / fast-forward (Plyr's default, made explicit).
    seekTime: 10,
    // 'quality' omitted: quality selection is HTML5-only (requires <source size="">);
    // it has no effect on YouTube embeds and does not appear in the settings menu.
    settings: ['captions', 'speed'],
    // Speed options — Plyr default includes 4× which the official demo exposes.
    speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 4] },
    fullscreen: { enabled: true, fallback: true, iosNative: false },
    // Play/Pause via the Play/Pause control ONLY. Documented Plyr option —
    // true would toggle playback whenever the video container is clicked,
    // which is exactly the "tapping the video pauses/resumes" complaint.
    clickToPlay: false,
    // ── YouTube iframe API parameters (verified against developers.google.com/
    // youtube/player_parameters — current supported set) ────────────────────────
    // NOTE: Plyr 3.7.8 hardcodes controls/disablekb/playsinline from its own
    // logic; those keys here are redundant but kept for documentation clarity.
    //
    // ── Anti-bot / "Sign in to confirm you're not a bot" ──────────────────────
    // origin MUST be set to the serving domain.  Without it, YouTube cannot
    // distinguish a real user from a bot and shows the verification screen.
    // Plyr does not set origin automatically — we inject it here so it passes
    // through the _() merge into playerVars.
    //
    // noCookie kept false: youtube-nocookie.com is the direct cause of the
    // anti-bot screen in environments without persistent cookies (WebViews,
    // sandboxed iframes).  Standard youtube.com + correct origin is correct.
    //
    // controls=0       : hide native YT control bar (Plyr sets this itself too).
    // disablekb=1      : Plyr owns keyboard events.
    // fs=0             : disable YouTube's own fullscreen button.
    // iv_load_policy=3 : suppress annotation overlays.
    // rel=0            : end-screen suggestions limited to same channel — the
    //                    maximum reduction YouTube supports since Sept 2018.
    // playsinline=1    : inline playback, prevents iOS native fullscreen.
    // color='white'    : SUPPORTED param — white progress-bar accent instead of
    //                    YouTube red wherever YouTube paints its own bar.
    // hl='en'          : SUPPORTED param — deterministic interface language.
    //
    // REJECTED as deprecated (verified in official revision history):
    //   modestbranding (deprecated Aug 15 2023, "no effect"), showinfo (2018),
    //   autohide (2015), theme (2015). Sending them is dead weight.
    youtube: {
      controls:       0,
      disablekb:      1,
      fs:             0,
      iv_load_policy: 3,
      rel:            0,
      playsinline:    1,
      color:          'white',
      hl:             'en',
      noCookie:       false,
      origin:         window.location.origin || 'https://medacademy.app',
    },
  });

  // Expose for host-injected seeks.
  window.__plyr = player;

  // ── Control hit-area / stacking, centre control, double-tap seek ────────────
  //   The centre play/pause control is painted over the cross-origin YouTube
  //   iframe; giving the controls their own composited layers with an explicit
  //   z-index keeps them visible and tappable wherever the iframe is rendered as
  //   a separate surface. The centre button and the two seek buttons run through
  //   one capture-phase delegate so the action executes exactly once, including
  //   when Plyr's own binding is missing (deferred embed build).
  //
  //   CENTRE CONTROL: Plyr hides `.plyr__control--overlaid` while playing
  //   (opacity:0; visibility:hidden), which removes the only centre hit target
  //   exactly when the user needs to pause, and it builds `play-large` as a
  //   non-toggle control (one `play` icon, no iconPressed). The CSS below keeps
  //   it present and tappable while playing; syncCentreState() swaps its glyph
  //   between Plyr's OWN sprite symbols from the player's real state.
  //
  //   DOUBLE-TAP SEEK: a transparent layer over the VIDEO SURFACE only, stacked
  //   below the centre control (4) and the bar (5). A single tap is inert
  //   (clickToPlay stays false); two taps inside 320 ms in the same half seek
  //   ±seekTime. Mirrors src/lib/plyr/playerScript.ts (native WebView).
  (function () {
    var s = document.createElement('style');
    s.id = 'plyr-control-fixes';
    s.textContent =
      '.plyr__video-wrapper{z-index:0;}' +
      // STACKING ONLY. The centre-control lifecycle is applied as INLINE style
      // by applyCentreVisibility() from the live player state; a stylesheet
      // predicate on Plyr's classes could not distinguish the live button from
      // a stale one left by a provider rebuild (see the note in
      // src/lib/plyr/playerScript.ts).
      '.plyr .plyr__control--overlaid{z-index:4;transform:translate3d(-50%,-50%,0);' +
        'will-change:transform;touch-action:manipulation;}' +
      // CSS MIRROR of the script lifecycle: if a provider rebuild inserts a
      // button after the bar hid and no event reaches the script, this rule
      // alone still closes it — the same class that hides the bar hides the
      // centre control. It never forces the button visible, so it cannot
      // resurrect the persistent-button bug.
      '.plyr.plyr--hide-controls .plyr__control--overlaid{' +
        'opacity:0;visibility:hidden;pointer-events:none;}' +
      '.plyr__video .plyr__controls{z-index:5;touch-action:manipulation;}' +
      '#plyr-gesture-zone{position:absolute;top:0;right:0;bottom:0;left:0;' +
        'z-index:1;background:transparent;touch-action:manipulation;' +
        '-webkit-tap-highlight-color:transparent;transform:translateZ(0);' +
        'will-change:transform;}' +
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

    // ── Shared seek math (controls + gesture) ─────────────────────────────────
    function seekStep() {
      var st = player && player.config ? player.config.seekTime : null;
      return (typeof st === 'number' && isFinite(st) && st > 0) ? st : 10;
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
      if (window.__medaSecurityStopped) return null; // containment froze playback
      var target = clampSeekTarget(player.currentTime, player.duration, direction);
      if (target === null) return null;              // live / unseekable → no-op
      player.currentTime = target;
      return target;
    }

    // ── Centre control: real state in, real state out ─────────────────────────
    //   Scoped to the LIVE root on purpose: document.querySelector returns the
    //   first overlaid node in document order, which after a provider rebuild
    //   can be a leftover button from a detached root. Styling that node is a
    //   no-op for the live player (its own button keeps Plyr's default paint)
    //   while the live bar hides — the reported "button stays while the bar
    //   goes" symptom.
    function centreButton() {
      var root = playerRoot();
      if (root && root.querySelector) return root.querySelector('.plyr__control--overlaid');
      return document.querySelector('.plyr__control--overlaid');
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
        if (use.setAttributeNS) use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', next);
        else use.setAttribute('xlink:href', next);
      }
    }

    /** Real playback state, read from the class Plyr paints (not a proxy). */
    function realPlaying() {
      var root = playerRoot();
      return !!(root && root.classList && root.classList.contains('plyr--playing'));
    }

    /** The ONE element Plyr is actually driving right now. */
    function playerRoot() {
      if (player && player.elements && player.elements.container) return player.elements.container;
      return document.querySelector('.plyr');
    }

    /** EXACTLY the control bar's lifecycle: painted while the bar is up, gone
     *  the instant the bar goes. The single predicate is Plyr's own
     *  `plyr--hide-controls` class on the LIVE root — the very class whose CSS
     *  hides the bar — so the centre control cannot drift from it.
     *
     *  Paused UX needs no second predicate: Plyr's toggleControls() treats
     *  'paused' as a show condition, so the bar (and the centre control) stays
     *  up while paused. Reading player.paused/player.ended instead was the bug:
     *  for an embed those are proxies on the wrapper div (`media.paused`),
     *  re-assigned by the provider, and can disagree with the class Plyr paints
     *  from — which is how the button could stay up after the bar hid. */
    function centreShouldShow() {
      var root = playerRoot();
      if (!root || !root.classList) return true;
      return !root.classList.contains('plyr--hide-controls');
    }

    /** Apply the lifecycle as INLINE style so no stylesheet rule can override
     *  it (Plyr's own `.plyr--playing .plyr__control--overlaid` included) and
     *  no stale rule can keep the button painted after the bar is gone. */
    function applyCentreVisibility() {
      var root = playerRoot();
      var playing = !!(root && root.classList && root.classList.contains('plyr--playing'));
      var show = centreShouldShow();
      var btn = centreButton();
      if (btn && btn.style) {
        if (show) {
          btn.style.visibility = 'visible';
          btn.style.pointerEvents = 'auto';
          btn.style.opacity = playing ? '0.7' : '';
          btn.removeAttribute('aria-hidden');
        } else {
          btn.style.opacity = '0';
          btn.style.visibility = 'hidden';
          btn.style.pointerEvents = 'none';
          btn.setAttribute('aria-hidden', 'true');
        }
        btn.setAttribute('data-meda-centre', show ? 'visible' : 'hidden');
      }
      hideStrayCentre();
    }

    /** An overlaid button outside the live root can never receive a lifecycle
     *  update (Plyr stopped painting its root), so it is closed rather than
     *  left dressing the video with a dead button. */
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

    // Exactly ONE centre control — and it must be the LIVE one. A leftover
    // overlaid node from a provider rebuild lives in a stale root that never
    // enters the hidden-controls state, so it would stay visible forever.
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

    var _centreObserver = null;
    function observeCentre() {
      if (!window.MutationObserver) return;
      var root = playerRoot();
      if (!root || root === (_centreObserver && _centreObserver.__medaRoot)) return;
      if (_centreObserver) { try { _centreObserver.disconnect(); } catch (e) {} }
      // class → the bar's idle lifecycle; childList → a provider rebuild that
      // inserts a fresh overlaid button after the bar already hid.
      var obs = new MutationObserver(function () { dedupeCentre(); applyCentreVisibility(); });
      obs.observe(root, { attributes: true, attributeFilter: ['class'], childList: true });
      obs.__medaRoot = root;
      _centreObserver = obs;
    }

    function syncCentreState() {
      dedupeCentre();
      setCentreState(realPlaying());
      applyCentreVisibility();
      observeCentre();
    }

    // Every state event + Plyr's own control-visibility events re-apply the
    // lifecycle, so provider event ordering can never leave it stale.
    ['controlsshown', 'controlshidden', 'play', 'playing', 'pause', 'ended',
     'ready', 'seeking', 'seeked', 'waiting', 'canplay', 'canplaythrough',
     'loadeddata', 'loadstart', 'emptied'].forEach(function (evt) {
      player.on(evt, syncCentreState);
    });

    function togglePlayback() {
      if (window.__medaSecurityStopped) return; // never restart a contained player
      // Optimistic glyph: flip it on the tap, then reconcile with the media's
      // real state. The provider's play()/pause() round-trip is asynchronous
      // (YouTube iframe postMessage), and waiting for it is what made the
      // centre tap feel slow.
      var wasPlaying = realPlaying();
      setCentreState(!wasPlaying);
      if (wasPlaying) player.pause();
      else player.play();
      syncCentreState();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(syncCentreState);
    }

    // ── Double-tap seek detection ────────────────────────────────────────────
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
        _lastTap = { t: 0, x: 0, y: 0, zone: null };
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

    function showSeekFeedback(zone) {
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
        if (window.__medaSecurityStopped) return; // contained players are frozen
        var rect = layer.getBoundingClientRect ? layer.getBoundingClientRect() : null;
        var w = (rect && rect.width) || layer.offsetWidth || 0;
        var h = (rect && rect.height) || layer.offsetHeight || 0;
        if (!(w > 0) || !(h > 0)) return;
        var left = (rect && rect.left) || 0;
        var top = (rect && rect.top) || 0;
        var clientX = typeof e.clientX === 'number' ? e.clientX : left;
        var clientY = typeof e.clientY === 'number' ? e.clientY : top;
        // Defensive only — the stacking order keeps controls out of this layer.
        if (inRect(centreButton(), clientX, clientY, 8)) return;
        if (inRect(document.querySelector('.plyr__controls'), clientX, clientY, 0)) return;
        var zone = window.__medaSeekTap(Date.now(), clientX - left, clientY - top, w, h);
        if (!zone) return; // first tap: nothing happens
        if (e.stopPropagation) e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
        var target = seekBy(zone === 'back' ? -1 : 1);
        if (target === null) return; // unknown duration: no misleading feedback
        showSeekFeedback(zone);
      }, false);
    }

    window.__medaSyncCentre = syncCentreState;
    window.__medaApplyCentre = applyCentreVisibility;
    window.__medaInstallSeekGestures = installSeekGestures;

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
        togglePlayback(); // real play/pause against the media's own state
        return;
      }
      if (kind === 'rewind' || kind === 'fast-forward') {
        e.stopImmediatePropagation();
        e.preventDefault();
        seekBy(kind === 'rewind' ? -1 : 1);
      }
    }, true);
  })();

  // ── Events ───────────────────────────────────────────────────────────────────

  player.on('ready', function () {
    if (resumeAt > 0) player.currentTime = resumeAt;
    injectWatermark(wmName, wmId);
    // Centre glyph + double-tap seek layer (idempotent; needs the built controls).
    window.__medaSyncCentre && window.__medaSyncCentre();
    window.__medaInstallSeekGestures && window.__medaInstallSeekGestures();
    send({ type: 'yt:ready' });

    player.on('enterfullscreen', function () {
      send({ type: 'yt:fullscreen', active: true });
    });
    player.on('exitfullscreen', function () {
      send({ type: 'yt:fullscreen', active: false });
    });
  });

  player.on('timeupdate', function () {
    // Safety re-sync of the centre-control lifecycle (one classList read when
    // nothing changed) — covers a provider that emits no state event and a
    // rebuild that swapped the root under the class observer.
    window.__medaApplyCentre && window.__medaApplyCentre();
    send({ type: 'yt:progress', currentTime: player.currentTime, duration: player.duration });
  });

  player.on('play', function () {
    window.__medaSyncCentre && window.__medaSyncCentre();
    send({ type: 'yt:playing' });
  });
  player.on('pause', function () {
    window.__medaSyncCentre && window.__medaSyncCentre();
    send({ type: 'yt:paused' });
  });

  player.on('ended', function () {
    window.__medaSyncCentre && window.__medaSyncCentre();
    send({ type: 'yt:ended', currentTime: player.currentTime, duration: player.duration });
  });

  player.on('error', function (event) {
    var msg = (event.detail && event.detail.message) ? event.detail.message : 'Playback error';
    send({ type: 'yt:error', message: msg });
  });

})();
