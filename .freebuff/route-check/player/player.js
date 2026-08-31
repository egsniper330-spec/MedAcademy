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

    var _vw = 0, _vh = 0;
    function captureVP() {
      var w = document.querySelector('.plyr__video-wrapper') || document.querySelector('.plyr');
      _vw = (w && w.offsetWidth)  || window.innerWidth  || 320;
      _vh = (w && w.offsetHeight) || window.innerHeight || 180;
    }
    function mkTransform(slot, deg) {
      return 'translate3d(' + Math.round(slot[0]*_vw) + 'px,' + Math.round(slot[1]*_vh) + 'px,0) rotate(' + deg + 'deg)';
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
          var slot = nxtSlot(), deg = rnd(-3,3).toFixed(1);
          _el.style.transform = mkTransform(slot, deg);
          _el.style.opacity   = rnd(0.40,0.56).toFixed(2);
        });
      });
    }

    var _tmr = null;
    function move() {
      if (!_el || !_el.parentNode) { recover(); return; }
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

  // ── CSS: suppress residual YouTube overlays ──────────────────────────────────
  function suppressYouTubeUI() {
    if (document.getElementById('plyr-yt-suppress')) return;
    var s = document.createElement('style');
    s.id = 'plyr-yt-suppress';
    s.textContent = [
      '.ytp-chrome-top,.ytp-chrome-top-buttons,.ytp-title-channel-logo',
      ',.ytp-title,.ytp-title-link,.ytp-title-text',
      ',.ytp-watermark,.ytp-youtube-button',
      ',.ytp-pause-overlay,.ytp-pause-overlay-container',
      ',.ytp-endscreen-content,.ytp-ce-element',
      ',.ytp-share-button,.ytp-share-button-visible',
      ',.ytp-spinner',
      ',.ytp-cued-thumbnail-overlay-duration',
      ',.ytp-cards-teaser,.iv-branding',
      '{display:none!important;opacity:0!important;pointer-events:none!important}',
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── iOS Safari tap-to-play/pause fix ─────────────────────────────────────────
  //
  // Three compounding issues make Plyr's center play/pause unreliable on iOS
  // Safari and WKWebView.  All three must be addressed together:
  //
  //  1. 300 ms tap delay
  //     iOS Safari delays all click events by ~300 ms while it determines
  //     whether the user intends a double-tap-to-zoom.  Without
  //     touch-action:manipulation (or a legacy user-scalable=no viewport),
  //     every tap on the video area stalls for 300 ms before Plyr sees it.
  //     The player appears to "miss" taps; a second tap fires 300 ms later
  //     and either double-toggles or collides with YouTube's own state machine.
  //
  //  2. click events not dispatched to <div> on iOS Safari
  //     iOS Safari only dispatches click events to interactive elements
  //     (a, button, input, etc.) or <div>/<span> elements that carry
  //     cursor:pointer CSS.  Plyr's .plyr__video-embed container is a plain
  //     <div>.  When the video is PLAYING, .plyr__control--overlaid is hidden
  //     (visibility:hidden), so taps in the video area fall through to
  //     .plyr__video-embed — but iOS Safari does not fire click on that div.
  //     Plyr's wrapper-level togglePlay handler is therefore never reached.
  //
  //  3. YouTube <iframe> absorbs unhandled touches
  //     Once issues 1 & 2 prevent Plyr from receiving the event, the touch
  //     propagates into the cross-origin YouTube iframe.  YouTube processes it
  //     through its own event system (showing its HUD, pausing/resuming via its
  //     internal state machine), bypassing Plyr entirely.  The result is
  //     unpredictable: sometimes the video pauses, sometimes it doesn't, and
  //     Plyr's event listeners are not notified.
  //
  // Fix: two-part
  //
  //  A. CSS — inject touch-action:manipulation on the Plyr container hierarchy.
  //     This eliminates the 300 ms delay (issue 1) and, combined with
  //     cursor:pointer on the wrapper divs, ensures iOS Safari dispatches click
  //     events to those elements (issue 2).
  //
  //  B. Transparent <button> tap interceptor — a full-size, invisible <button>
  //     is placed INSIDE .plyr__video-wrapper at z-index:1.
  //       • Above the YouTube <iframe> (default stacking order / no explicit
  //         z-index) → absorbs all taps before they reach the iframe (issue 3).
  //       • Below .plyr__control--overlaid (~z-index 2 in Plyr CSS) → the big
  //         play button is never obscured; it still handles its own clicks.
  //       • Below #plyr-watermark (z-index:9999, pointer-events:none) → the
  //         watermark is unaffected.
  //       • <button> elements ALWAYS receive click events on iOS Safari without
  //         needing cursor:pointer (issue 2 bypass).
  //       • stopPropagation() prevents Plyr's container-level click handler
  //         from double-toggling after our handler already called togglePlay().
  //
  function fixiOSTapToToggle() {
    // Part A — CSS
    var style = document.createElement('style');
    style.textContent = [
      // Eliminate 300 ms double-tap detection delay on the entire player tree
      '.plyr,.plyr *{touch-action:manipulation;}',
      // Enable click dispatch on wrapper <div> elements on iOS Safari
      '.plyr__video-wrapper,.plyr__video-embed{cursor:pointer;}',
      // Suppress iOS blue tap-flash on interactive Plyr elements
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
    tapBtn.setAttribute('tabindex', '-1');   // excluded from keyboard tab order
    tapBtn.style.cssText = [
      'position:absolute',
      'top:0', 'left:0', 'right:0', 'bottom:0',
      'width:100%', 'height:100%',
      'background:transparent',
      'border:none',
      'padding:0', 'margin:0',
      'cursor:pointer',
      'z-index:1',            // above iframe, below .plyr__control--overlaid (~2)
      'outline:none',
      '-webkit-tap-highlight-color:transparent',
      'touch-action:manipulation',
    ].join(';');

    tapBtn.addEventListener('click', function (e) {
      // Stop bubbling so Plyr's container-level click handler does not fire
      // a second togglePlay() and cancel the one we are about to call.
      e.stopPropagation();
      if (player) { player.togglePlay(); }
    });

    wrapper.appendChild(tapBtn);
  }

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
    // ── YouTube iframe API parameters ──────────────────────────────────────────
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
    // modestbranding=1 : DEPRECATED — YouTube ignores since 2023.
    // rel=0            : same-channel end-screen suggestions only.
    // playsinline=1    : inline playback, prevents iOS native fullscreen.
    youtube: {
      controls:       0,
      disablekb:      1,
      fs:             0,
      iv_load_policy: 3,
      modestbranding: 1,
      rel:            0,
      playsinline:    1,
      noCookie:       false,
      origin:         window.location.origin || 'https://medacademy.app',
    },
  });

  // Expose for host-injected seeks.
  window.__plyr = player;

  // ── Events ───────────────────────────────────────────────────────────────────

  player.on('ready', function () {
    if (resumeAt > 0) player.currentTime = resumeAt;
    suppressYouTubeUI();
    injectWatermark(wmName, wmId);
    fixiOSTapToToggle();
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
