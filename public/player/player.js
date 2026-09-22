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

// ── Static forensic watermark — created once, moves every 30–60 s ──────────
  //
  //  One element, never removed during normal playback.
  //  All positioning via transform:translate3d() — no top/left changes, no reflow.
  //  MutationObserver self-heals on tamper only.
  //
  function injectWatermark(name, id) {
    if (!name && !id) return;

    var WM_ID    = 'plyr-watermark';
    var WM_ST_ID = 'plyr-wm-style';

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
      cur = n; return G[n];
    }

    // Viewport + element sizes captured per move (transform/opacity writes
    // never invalidate layout, so these offsetWidth/Height reads are cheap and
    // always clean — and re-reading each move keeps the watermark correct if
    // the player resizes, e.g. web pseudo-fullscreen).
    var _vw = 0, _vh = 0, _ew = 0, _eh = 0;
    function captureVP() {
      var w = document.querySelector('.plyr__video-wrapper') || document.querySelector('.plyr');
      _vw = (w && w.offsetWidth)  || window.innerWidth  || 320;
      _vh = (w && w.offsetHeight) || window.innerHeight || 180;
      if (_el) {
        _ew = _el.offsetWidth  || 0;
        _eh = _el.offsetHeight || 0;
      }
    }
    // Position the element's top-left corner so the WHOLE element stays inside
    // the wrapper (≥6 % inset). Raw slot fractions can exceed the wrapper on
    // narrow players (0.72 * vw + text width > vw) — that clipped the
    // watermark at right/bottom slots.
    function mkTransform(slot, deg) {
      var inset = Math.round(Math.min(_vw, _vh) * 0.06);
      var x = Math.min(
        Math.round(slot[0] * _vw),
        Math.max(inset, _vw - _ew - inset),
      );
      var y = Math.min(
        Math.round(slot[1] * _vh),
        Math.max(inset, _vh - _eh - inset),
      );
      return 'translate3d(' + x + 'px,' + y + 'px,0) rotate(' + deg + 'deg)';
    }

    function injectCSS() {
      if (document.getElementById(WM_ST_ID)) return;
      var s = document.createElement('style');
      s.id = WM_ST_ID;
      s.textContent = '#' + WM_ID + '{transition:transform 0.6s ease,opacity 0.6s ease;will-change:transform,opacity;}';
      (document.head || document.documentElement).appendChild(s);
    }

    function getWrapper() {
      return document.querySelector('.plyr__video-wrapper') || document.querySelector('.plyr') || document.body;
    }

    var _el = null, _nEl = null, _iEl = null;

    function buildEl() {
      var d = document.createElement('div');
      d.id = WM_ID;
      d.style.cssText = [
        'position:absolute','top:0','left:0',
        'z-index:2147483647','pointer-events:none',
        'user-select:none','-webkit-user-select:none',
        'max-width:min(320px,55%)','opacity:0',
        'transform:translate3d(0,0,0)','line-height:1.4',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif',
      ].join(';');
      if (name) {
        _nEl = document.createElement('div');
        _nEl.style.cssText = 'font-size:13px;font-weight:600;letter-spacing:0.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,0.95),0 0 10px rgba(0,0,0,0.7);';
        _nEl.textContent = name;
        d.appendChild(_nEl);
      }
      _iEl = document.createElement('div');
      _iEl.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:0.8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,0.95),0 0 10px rgba(0,0,0,0.7);';
      _iEl.textContent = String(id || '');
      d.appendChild(_iEl);
      return d;
    }

    function mount() {
      if (document.getElementById(WM_ID)) return;
      injectCSS(); captureVP();
      var w = getWrapper();
      if (!w) return;
      if (window.getComputedStyle(w).position === 'static') w.style.position = 'relative';
      _el = buildEl();
      w.appendChild(_el);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (!_el) return;
          captureVP(); // element now exists — measure it for clamped positioning
          var slot = nxtSlot(), deg = rnd(-3,3).toFixed(1);
          _el.style.transform = mkTransform(slot, deg);
          _el.style.opacity   = rnd(0.40,0.56).toFixed(2);
        });
      });
    }

    var _tmr = null;
    function move() {
      if (!_el || !_el.parentNode) { recover(); return; }
      captureVP(); // re-measure wrapper + element (resize-safe, layout-clean)
      var slot = nxtSlot(), deg = rnd(-3,3).toFixed(1);
      _el.style.transform = mkTransform(slot, deg);
      _el.style.opacity   = rnd(0.38,0.58).toFixed(2);
    }
    function scheduleTick() {
      _tmr = setTimeout(function () { move(); scheduleTick(); }, rnd(30000,60000));
    }

    function isTampered() {
      if (!_el || !_el.parentNode) return true;
      if (_el.style.display === 'none' || _el.style.visibility === 'hidden') return true;
      if (name && _nEl && _nEl.textContent !== name) return true;
      if (_iEl && _iEl.textContent !== String(id||'')) return true;
      return false;
    }

    var _obs1 = null, _obs2 = null;
    function watch() {
      if (!window.MutationObserver) return;
      if (_obs1) { try { _obs1.disconnect(); } catch(e){} }
      if (_obs2) { try { _obs2.disconnect(); } catch(e){} }
      var w = getWrapper();
      if (w) {
        _obs1 = new MutationObserver(function (ms) {
          for (var i=0;i<ms.length;i++) {
            var rm=ms[i].removedNodes;
            for (var r=0;r<rm.length;r++) { if (rm[r]===_el){recover();return;} }
          }
        });
        _obs1.observe(w, {childList:true});
      }
      if (_el) {
        _obs2 = new MutationObserver(function(){if(isTampered())recover();});
        _obs2.observe(_el,{attributes:true,characterData:true,subtree:true,attributeFilter:['style','class','hidden']});
      }
    }

    function recover() {
      if (_tmr){clearTimeout(_tmr);_tmr=null;}
      if (_el&&_el.parentNode){try{_el.parentNode.removeChild(_el);}catch(e){}}
      _el=null;_nEl=null;_iEl=null;cur=-1;
      mount(); watch(); scheduleTick();
    }

    mount(); scheduleTick(); watch();
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
    controls: [
      'play-large', 'play', 'progress', 'current-time',
      'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen',
    ],
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

  // ── Events ───────────────────────────────────────────────────────────────────

  player.on('ready', function () {
    if (resumeAt > 0) player.currentTime = resumeAt;
    injectWatermark(wmName, wmId);
    send({ type: 'yt:ready' });

    player.on('enterfullscreen', function () {
      send({ type: 'yt:fullscreen', active: true });
    });
    player.on('exitfullscreen', function () {
      send({ type: 'yt:fullscreen', active: false });
    });
  });

  player.on('timeupdate', function () {
    send({ type: 'yt:progress', currentTime: player.currentTime, duration: player.duration });
  });

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

})();
