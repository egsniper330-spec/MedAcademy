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
        _nEl.style.cssText = 'font-size:15px;font-weight:600;letter-spacing:0.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,0.95),0 0 10px rgba(0,0,0,0.7);';
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
      '.plyr__control--overlaid{z-index:4;transform:translate3d(-50%,-50%,0);' +
        'will-change:transform;touch-action:manipulation;}' +
      '.plyr--playing .plyr__control--overlaid{opacity:.35;visibility:visible;' +
        'pointer-events:auto;}' +
      '.plyr--playing .plyr__control--overlaid:hover,' +
      '.plyr--playing .plyr__control--overlaid:focus{opacity:1;}' +
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
    function centreButton() {
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

    function realPlaying() {
      return !!(player && !player.paused && !player.ended);
    }

    function syncCentreState() {
      setCentreState(realPlaying());
    }

    function togglePlayback() {
      if (window.__medaSecurityStopped) return; // never restart a contained player
      if (realPlaying()) player.pause();
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
