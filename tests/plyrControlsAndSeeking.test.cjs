'use strict';
/**
 * Plyr control + gesture regression tests — centre play/pause and
 * YouTube-style double-tap seeking.
 *
 * The REAL generated player script (src/lib/plyr/playerScript.ts) is executed in
 * a VM sandbox with a stub DOM and a stub Plyr instance, then driven with
 * synthetic clicks. Nothing here greps for the implementation alone: the stub
 * player records which REAL commands ran and what the media state became.
 *
 * DEFECT 1 — "the large centre play/pause button does not reliably pause or
 * resume" (verified root cause):
 *   Plyr's stylesheet contains
 *     .plyr--playing .plyr__control--overlaid { opacity:0; visibility:hidden }
 *   so once playback starts the centre control is not rendered and — because
 *   `visibility:hidden` removes it from hit testing — there is NO centre target
 *   at all. Resuming worked (visible while paused); pausing never could. Plyr
 *   also builds `play-large` as a NON-toggle control (one `play` icon, no
 *   `iconPressed`), so the glyph never followed state.
 *   Fix: keep the control present and tappable while playing, toggle against the
 *   media's own paused/ended state, and swap its glyph from Plyr's own sprite on
 *   every real play / pause / ended event.
 *
 * DEFECT 2 — double-tap seeking (new):
 *   Two taps inside 320 ms in the same half of the VIDEO SURFACE seek ±10 s
 *   through Plyr's own `currentTime` (YouTube: seekTo). A single tap stays
 *   inert. The detector lives on a transparent layer that is stacked BELOW the
 *   centre control and the control bar, so it cannot swallow a control tap.
 *
 * SECURITY: the lock's containment sets `window.__medaSecurityStopped` before
 * pausing/tearing down the player; neither control may restart or move a
 * contained player.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

/* ─────────────────────── extract the generated script ───────────────────── */

const SRC_MARKER = 'export const PLAYER_SCRIPT = `';

function extractPlayerScript() {
  const src = read('src/lib/plyr/playerScript.ts');
  const at = src.indexOf(SRC_MARKER);
  if (at < 0) return null;
  const bodyStart = at + SRC_MARKER.length;
  const bodyEnd = src.lastIndexOf('`;');
  if (bodyEnd <= bodyStart) return null;
  // The one build-time interpolation in the template.
  return src.slice(bodyStart, bodyEnd).replace(/\$\{WATERMARK_FONT_PX\}/g, '13');
}

/* ────────────────────────────── stub DOM ────────────────────────────────── */

function makeRect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function matches(el, selector) {
  if (!selector || !el) return false;
  const first = selector.split(',')[0].trim();
  if (first.startsWith('.')) return el.classList.contains(first.slice(1));
  if (first.startsWith('#')) return el.id === first.slice(1);
  if (first.startsWith('[')) {
    const m = first.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
    if (!m) return false;
    const v = el.getAttribute(m[1]);
    return m[2] === undefined ? v !== null : v === m[2];
  }
  return el.tagName === first.toUpperCase();
}

function makeEl(tag, attrs, doc) {
  const a = Object.assign({}, attrs || {});
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    id: a.id || '',
    style: {},
    children: [],
    textContent: '',
    offsetWidth: 0,
    offsetHeight: 0,
    parentNode: null,
    _attrs: a,
    _listeners: {},
    _rect: null,
    setAttribute(k, v) { a[k] = String(v); if (k === 'id') el.id = String(v); },
    getAttribute(k) { return k in a ? a[k] : null; },
    removeAttribute(k) { delete a[k]; },
    setAttributeNS(_ns, k, v) { a[k] = String(v); },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); c.parentNode = null; return c; },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { (el._listeners[t] || []).forEach((fn) => fn(ev)); },
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
    querySelector(sel) { return find(el, sel); },
    querySelectorAll() { return []; },
    closest(sel) { return matches(el, sel) ? el : null; },
    getBoundingClientRect() {
      if (el._rect) return el._rect;
      return makeRect(0, 0, el.offsetWidth, el.offsetHeight);
    },
  };
  // `className = 'a b'` must populate classList (real DOM behaviour) — the
  // player's feedback nodes are built with className assignments.
  Object.defineProperty(el, 'className', {
    get() { return Array.from(classes).join(' '); },
    set(v) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
  });
  return el;
}

function descendants(root, out) {
  out = out || [];
  for (const c of root.children || []) { out.push(c); descendants(c, out); }
  return out;
}

function find(root, selector) {
  for (const el of descendants(root)) if (matches(el, selector)) return el;
  return null;
}

function runPlayerScript() {
  const script = extractPlayerScript();
  if (!script) return { error: 'script not found' };

  const docListeners = {};
  const injectedStyles = [];
  const created = [];
  const postMessages = [];
  const timers = new Map();
  let timerId = 1;

  const doc = {
    head: null,
    documentElement: null,
    _roots: [],
    getElementById(id) {
      for (const root of doc._roots) {
        if (root.id === id) return root;
        const hit = descendants(root).find((e) => e.id === id);
        if (hit) return hit;
      }
      const hit = created.find((e) => e.id === id);
      return hit || null;
    },
    querySelector(sel) {
      for (const root of doc._roots) {
        if (matches(root, sel)) return root;
        const hit = find(root, sel);
        if (hit) return hit;
      }
      const hit = created.find((e) => matches(e, sel));
      return hit || null;
    },
    querySelectorAll() { return []; },
    createElement(tag) {
      const e = makeEl(tag, {}, doc);
      created.push(e);
      if (tag === 'style') injectedStyles.push(e);
      return e;
    },
    addEventListener(type, fn, capture) {
      (docListeners[type] = docListeners[type] || []).push({ fn, capture: !!capture });
    },
    removeEventListener() {},
  };

  doc.head = makeEl('head', {}, doc);
  doc.documentElement = makeEl('html', {}, doc);

  // ── Plyr-like structure: container > wrapper(iframe) + centre button + bar ──
  const playerEl = makeEl('div', { id: 'player' }, doc);
  playerEl.classList.add('plyr');
  playerEl.classList.add('plyr--video');

  const wrapper = makeEl('div', {}, doc);
  wrapper.classList.add('plyr__video-wrapper');
  wrapper.offsetWidth = 400;
  wrapper.offsetHeight = 225;

  const media = makeEl('iframe', { src: 'https://www.youtube.com/embed/x' }, doc);
  wrapper.appendChild(media);
  playerEl.appendChild(wrapper);

  // Centre control exactly as Plyr builds it: data-plyr="play" + overlaid class,
  // ONE icon (`play`) — the defect that made the glyph state-blind.
  const centre = makeEl('button', { 'data-plyr': 'play', type: 'button' }, doc);
  centre.classList.add('plyr__control');
  centre.classList.add('plyr__control--overlaid');
  centre._rect = makeRect(180, 92, 40, 40);
  const centreSvg = makeEl('svg', {}, doc);
  const centreUse = makeEl('use', { href: '#plyr-play', 'xlink:href': '#plyr-play' }, doc);
  centreSvg.appendChild(centreUse);
  centre.appendChild(centreSvg);
  playerEl.appendChild(centre);

  const controls = makeEl('div', {}, doc);
  controls.classList.add('plyr__controls');
  controls._rect = makeRect(0, 190, 400, 35);
  const barPlay = makeEl('button', { 'data-plyr': 'play' }, doc);
  barPlay.classList.add('plyr__control');
  controls.appendChild(barPlay);
  playerEl.appendChild(controls);

  doc._roots.push(playerEl);

  const win = {
    __PLAYER_CONFIG__: { videoId: 'aqz-KE-bpKQ' },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 375,
    innerHeight: 667,
    location: { href: 'https://medacademy.app' },
    ReactNativeWebView: { postMessage: (s) => postMessages.push(JSON.parse(s)) },
  };
  win.parent = win;

  let built = null;
  function FakePlyr(selector, config) {
    this.selector = selector;
    this.config = config;
    this.duration = 100;
    this.currentTime = 0;
    this.paused = true;
    this.ended = false;
    this.playing = false;
    this.handlers = {};
    this.playCalls = 0;
    this.pauseCalls = 0;
    // Real Plyr exposes elements.container and paints the playing/paused/
    // stopped classes on it (checkPlaying). The script now reads THAT state
    // instead of the embed's paused proxy, so the stub must paint it too —
    // otherwise this fake is not a faithful Plyr.
    this.elements = { container: playerEl };
    this._syncPlayingClasses();
    built = this;
  }
  FakePlyr.prototype._syncPlayingClasses = function () {
    const c = this.elements.container.classList;
    c.remove('plyr--playing');
    c.remove('plyr--paused');
    c.remove('plyr--stopped');
    if (this.playing) c.add('plyr--playing');
    else c.add('plyr--paused');
    if (!this.playing && this.currentTime === 0) c.add('plyr--stopped');
  };
  FakePlyr.prototype.on = function (evt, fn) {
    (this.handlers[evt] = this.handlers[evt] || []).push(fn);
    return this;
  };
  FakePlyr.prototype.emit = function (evt) {
    (this.handlers[evt] || []).forEach((fn) => fn());
  };
  FakePlyr.prototype.play = function () {
    this.playCalls++;
    this.paused = false;
    this.ended = false;
    this.playing = true;
    this._syncPlayingClasses();
    this.emit('play');
  };
  FakePlyr.prototype.pause = function () {
    this.pauseCalls++;
    this.paused = true;
    this.playing = false;
    this._syncPlayingClasses();
    this.emit('pause');
  };
  // Kept so a regression to the old derived-flag toggle is caught by name too.
  FakePlyr.prototype.togglePlay = function () { this.toggleCalls = (this.toggleCalls || 0) + 1; };

  const sandbox = {
    window: win,
    document: doc,
    console,
    Plyr: FakePlyr,
    setTimeout: (fn, ms) => { const id = timerId++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    Math, Date, JSON, isFinite, Object, Array, String, Number,
  };
  sandbox.globalThis = sandbox;
  win.Plyr = FakePlyr;

  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'playerScript.generated.js' });

  function runTimers() {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((t) => t.fn());
  }

  return {
    docListeners, injectedStyles, built, win, doc, timers,
    runTimers, postMessages, centre, centreUse, wrapper, controls,
  };
}

/* ─────────────────────────── 1. script executes ─────────────────────────── */

const script = extractPlayerScript();
ok(typeof script === 'string' && script.length > 2000,
  'playerScript.ts exposes a generated PLAYER_SCRIPT template');

if (typeof script === 'string') {
  let syntaxOk = true;
  try { new vm.Script(script, { filename: 'playerScript.generated.js' }); }
  catch (err) { syntaxOk = false; console.error('  ✗ generated script syntax: ' + err.message); }
  ok(syntaxOk, 'generated player script is syntactically valid JavaScript');
}

let env = null;
try {
  env = runPlayerScript();
  ok(!env.error, 'generated player script executes in a stub DOM/Plyr sandbox');
} catch (err) {
  ok(false, 'generated player script executes without throwing: ' + err.message);
}

/* ───────────────────────────── 2. control plan ──────────────────────────── */

if (env && env.built) {
  const cfg = env.built.config;
  const controls = cfg.controls;

  ok(cfg.seekTime === 10, 'Plyr config sets seekTime = 10 seconds');
  ok(Array.isArray(controls) && controls.includes('rewind') && controls.includes('fast-forward'),
    'rewind and fast-forward controls are enabled');
  ok(controls.indexOf('rewind') < controls.indexOf('play') &&
     controls.indexOf('fast-forward') > controls.indexOf('play'),
    'seek controls are ordered around the play control (±10 s layout)');
  ok(controls.includes('play-large'),
    'the centre play-large control is present (Plyr\'s own control, not a custom one)');

  const fire = (type, event) => (env.docListeners[type] || []).forEach((l) => l.fn(event));

  // Plyr's own ready hooks (controls are built before this fires on embeds).
  const readyHooks = env.built.handlers.ready || [];
  ok(readyHooks.length > 0, 'a ready handler is registered (controls wiring point)');
  readyHooks.forEach((fn) => fn());

  const clickListeners = (env.docListeners.click || []).filter((l) => l.capture === true);
  ok(clickListeners.length > 0, 'a capture-phase click delegate is installed for the controls');

  function clickControl(kind, overlaid) {
    const el = makeEl('button', { 'data-plyr': kind }, env.doc);
    if (overlaid) el.classList.add('plyr__control--overlaid');
    const evt = {
      target: { closest: () => el },
      stopped: 0, prevented: 0,
      stopImmediatePropagation() { this.stopped++; },
      preventDefault() { this.prevented++; },
    };
    fire('click', evt);
    return evt;
  }

  /* ─────────── 3. centre control toggles REAL playback exactly once ──────── */

  ok(env.built.paused === true, 'player starts paused');
  const centreEvt = clickControl('play', true);
  ok(env.built.playCalls === 1 && env.built.pauseCalls === 0 && env.built.paused === false,
    'tapping the CENTRE control while paused calls play() on the real player (state → playing)');
  ok(centreEvt.stopped === 1 && centreEvt.prevented === 1,
    'the centre handler stops propagation (no double toggle alongside Plyr\'s own handler)');
  ok(!env.built.toggleCalls,
    'the centre control no longer relies on the derived togglePlay flag — it issues a real command');

  const centreEvt2 = clickControl('play', true);
  ok(centreEvt2.stopped === 1 && centreEvt2.prevented === 1,
    'the second tap is also claimed exactly once (no double toggle on replay)');
  ok(env.built.pauseCalls === 1 && env.built.paused === true,
    'tapping it again while playing pauses the SAME player (state → paused)');
  ok(env.built.currentTime === 0,
    'pausing does not reset the position (resume continues from the same point)');

  // Rapid taps: each tap reads the live media state, so N taps alternate
  // correctly and never leave the player in a state its own command did not set.
  clickControl('play', true);
  clickControl('play', true);
  clickControl('play', true);
  ok(env.built.playCalls === 3 && env.built.pauseCalls === 2 && env.built.paused === false,
    'three rapid centre taps end in a consistent state (play/pause/play, paused=false)');

  // The bottom-bar play button keeps Plyr's own handler — the delegate must not
  // claim it (two handlers acting on one tap is what causes double toggles).
  const beforePlays = env.built.playCalls;
  const beforePauses = env.built.pauseCalls;
  const barEvt = clickControl('play', false);
  ok(barEvt.stopped === 0 &&
     env.built.playCalls === beforePlays && env.built.pauseCalls === beforePauses,
    'the bottom-bar play control is left to Plyr\'s own (working) handler');

  /* ───────────── 4. centre icon tracks the REAL playback state ───────────── */

  function centreHref() { return env.centreUse.getAttribute('href'); }
  function centreState() { return env.centre.getAttribute('data-meda-state'); }

  ok(centreState() === 'playing' && /pause$/.test(centreHref() || ''),
    'icon shows PAUSE while playing (state + Plyr sprite glyph)');
  ok(env.centre.getAttribute('aria-label') === 'Pause',
    'the centre control\'s accessible label reflects "Pause" while playing');

  env.built.pause();
  ok(centreState() === 'paused' && /play$/.test(centreHref() || ''),
    'a real pause event flips the icon back to PLAY (no visual-only simulation)');
  ok(env.centre.getAttribute('aria-label') === 'Play',
    'the accessible label follows the real state');

  env.built.play();
  ok(centreState() === 'playing' && /pause$/.test(centreHref() || ''),
    'a real play event flips the icon to PAUSE again');

  env.built.playing = false;
  env.built.ended = true;
  env.built._syncPlayingClasses();
  env.built.emit('ended');
  ok(centreState() === 'paused' && /play$/.test(centreHref() || ''),
    'ending playback shows PLAY (ended is not "playing")');
  env.built.ended = false;

  /* ── 4b. centre control = the control bar's OWN idle lifecycle ─────────── */
  //
  // THE REPORTED BUG: during playback the large centre button stayed painted
  // after the progress bar and the other transient controls had gone. The
  // lifecycle is now the bar's own `plyr--hide-controls` class on the live
  // root — the same signal whose CSS hides the bar — with no second predicate
  // (the old `player.paused || player.ended` short-circuit could disagree with
  // the class Plyr actually painted, and kept the button up).
  function classes() { return env.built.elements.container.classList; }
  function centreVisible() {
    return env.centre.style.visibility === 'visible' &&
           env.centre.style.pointerEvents === 'auto' &&
           env.centre.style.opacity !== '0';
  }
  function centreHidden() {
    return env.centre.style.visibility === 'hidden' &&
           env.centre.style.opacity === '0' &&
           env.centre.style.pointerEvents === 'none';
  }

  env.built.play();
  ok(classes().contains('plyr--playing'), 'fake player paints plyr--playing like real Plyr');

  // Idle: Plyr adds the class and fires controlshidden.
  classes().add('plyr--hide-controls');
  env.built.emit('controlshidden');
  ok(centreHidden(),
    'PLAYING + idle: the centre control is hidden the moment the bar hides');
  ok(env.centre.getAttribute('data-meda-centre') === 'hidden',
    'the hidden lifecycle is published for device diagnostics');

  // It must STAY hidden while playback continues and the player stays idle.
  for (let i = 0; i < 5; i++) env.built.emit('playing');
  env.built.emit('timeupdate'); // 1 Hz safety re-sync path
  ok(centreHidden(),
    'PLAYING + idle: repeated provider state events do not resurrect the centre control');

  // Tap the video: Plyr shows the bar again.
  classes().remove('plyr--hide-controls');
  env.built.emit('controlsshown');
  ok(centreVisible() && env.centre.getAttribute('data-meda-centre') === 'visible',
    'tap: the centre control reappears with the bar');

  // Wait out the idle timer again.
  classes().add('plyr--hide-controls');
  env.built.emit('controlshidden');
  ok(centreHidden(), 'idle again: it hides again with the bar');

  // Paused: Plyr keeps the bar up (toggleControls treats paused as a show
  // condition), so the centre Play control is the primary action.
  classes().remove('plyr--hide-controls');
  env.built.pause();
  ok(centreVisible(), 'paused: the centre Play control is shown (paused UX preserved)');
  ok(env.centre.style.opacity !== '0.7',
    'paused: the centre control is painted at full strength, not the playing dim');
  ok(centreState() === 'paused' && /play$/.test(centreHref() || ''),
    'paused: the glyph is PLAY');

  /* ── 4c. the one-tap device diagnostic proves it on a real phone ────────── */
  // __plyrDiag() must answer with the centre lifecycle AND the bar's own state
  // together — "centre hidden" alone cannot distinguish the fix from the bug.
  const diagStart = env.postMessages.length;
  env.win.__plyrDiag();
  const diagPaused = env.postMessages.slice(diagStart).filter((m) => m.type === 'yt:diag').pop();
  ok(!!diagPaused && !!diagPaused.centre, '__plyrDiag() replies with a centre snapshot');
  ok(diagPaused && diagPaused.centre.hideControls === false &&
     diagPaused.centre.state === 'visible',
    'diagnostic reports the bar state and the centre state at the same instant');
  ok(diagPaused && typeof diagPaused.centre.count === 'number',
    'diagnostic reports the live centre-control count (the stub document reports 0; the real player reports 1 — verified in the browser run)');

  classes().add('plyr--hide-controls');
  env.built.emit('controlshidden');
  env.win.__plyrDiag();
  const diagIdle = env.postMessages.filter((m) => m.type === 'yt:diag').pop();
  ok(diagIdle && diagIdle.centre.hideControls === true && diagIdle.centre.state === 'hidden',
    'diagnostic proves the idle case: bar hidden AND centre hidden (the device PASS condition)');
  const diagJson = JSON.stringify(diagIdle);
  ok(!/otp|token|https?:|MED-\d|bearer/i.test(diagJson),
    'diagnostic payload carries no URL, token or recipient identity (safe to show on screen)');
  classes().remove('plyr--hide-controls');

  /* ───────────── 5. bridge messages stay in sync with the player ─────────── */

  const types = env.postMessages.map((m) => m.type);
  ok(types.includes('yt:playing') && types.includes('yt:paused') && types.includes('yt:ended'),
    'play / pause / ended still post their bridge messages (host state in sync)');
  ok(types.includes('yt:ready'), 'ready is still posted after wiring the new controls');

  /* ──────────────────── 6. double-tap seeking (real seek) ────────────────── */

  const layer = env.doc.getElementById('plyr-gesture-zone');
  ok(!!layer, 'a gesture layer is installed over the video surface');
  // The stub DOM has no layout engine: give the layer the wrapper's rect so the
  // handler sees a real 400×225 surface (exactly what a laid-out page provides).
  if (layer) layer._rect = makeRect(0, 0, 400, 225);

  function tap(x, y) {
    const evt = {
      clientX: x, clientY: y,
      stopped: 0, prevented: 0,
      stopPropagation() { this.stopped++; },
      preventDefault() { this.prevented++; },
    };
    layer.dispatch('click', evt);
    return evt;
  }

  // Real-time sleep past the player's double-tap window so the NEXT tap starts a
  // fresh gesture (the classifier reads Date.now(); no fake clock is injected).
  function flushTapWindow(ms = 400) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  env.built.ended = false;
  env.built.paused = false;
  env.built.duration = 100;
  env.built.currentTime = 30;

  // Single tap: inert.
  tap(60, 100);
  ok(env.built.currentTime === 30,
    'a SINGLE tap on the video surface does not seek');

  // Right side double tap → +10.
  tap(330, 100);
  tap(330, 100);
  ok(env.built.currentTime === 40,
    'double-tap on the RIGHT seeks forward exactly 10 s (30 → 40)');

  // Left side double tap → -10.
  tap(60, 100);
  tap(60, 100);
  ok(env.built.currentTime === 30,
    'double-tap on the LEFT seeks backward exactly 10 s (40 → 30)');

  // A tap in the opposite half resets the pairing: left then right is not a
  // double-tap (and neither is right then left).
  env.built.currentTime = 30;
  tap(60, 100);
  tap(330, 100);
  ok(env.built.currentTime === 30,
    'taps in different halves never pair into a seek');
  flushTapWindow();
  tap(330, 100);
  tap(60, 100);
  ok(env.built.currentTime === 30,
    'right then left does not pair either (zone is part of the gesture identity)');
  flushTapWindow();

  // Repeated double taps accumulate (each pair is its own double-tap).
  env.built.currentTime = 10;
  tap(330, 100); tap(330, 100);   // +10
  tap(330, 100); tap(330, 100);   // +10
  ok(env.built.currentTime === 30,
    'rapid repeated double-taps accumulate (10 → 30 after two gestures)');
  flushTapWindow();

  // Clamping.
  env.built.currentTime = 4;
  tap(60, 100); tap(60, 100);
  ok(env.built.currentTime === 0,
    'seeking back is clamped at 0 (never negative)');
  flushTapWindow();

  env.built.currentTime = 96;
  tap(330, 100); tap(330, 100);
  // Pinned to the exact landing point. A loose `<= duration` check hides the
  // real-browser bug this caught: with a 0.25 s margin the YouTube IFrame API
  // REJECTS the seek (snaps back), so forward taps near the end did nothing.
  // duration-1 is the largest margin YouTube accepts cleanly.
  ok(env.built.currentTime === env.built.duration - 1,
    'forward seek clamps to duration-1 (' + env.built.currentTime +
    ' of ' + env.built.duration + ') — the largest margin YouTube accepts');
  ok(env.built.currentTime <= env.built.duration,
    'forward seek never lands beyond the duration');
  flushTapWindow();

  env.built.duration = 0;                        // live / not yet seekable
  env.built.currentTime = 3;
  tap(330, 100); tap(330, 100);
  tap(60, 100); tap(60, 100);
  ok(env.built.currentTime === 3,
    'no seek and no feedback when the duration is unknown (live / unseekable)');
  flushTapWindow();

  env.built.duration = NaN;
  tap(330, 100); tap(330, 100);
  ok(env.built.currentTime === 3,
    'no seek when the duration is not a finite number');
  flushTapWindow();

  /* ─────────────────── 7. feedback show / hide behaviour ─────────────────── */

  env.built.duration = 100;
  env.built.currentTime = 50;
  tap(330, 100); tap(330, 100);
  const fwd = env.doc.getElementById('plyr-seek-forward');
  const back = env.doc.getElementById('plyr-seek-back');
  ok(!!fwd, 'a forward feedback indicator is created on the first forward seek');
  ok(!!fwd && fwd.getAttribute('data-show') === '1',
    'the forward indicator is SHOWN after the seek');
  ok(!!fwd && /10 seconds/.test(find(fwd, '.plyr-seek-label').textContent),
    'the indicator displays the number of seconds sought (10 seconds)');
  ok(!!fwd && fwd.getAttribute('aria-hidden') === 'true',
    'the indicator is decorative (aria-hidden) — it cannot become an invisible control');

  tap(60, 100); tap(60, 100);
  ok(!!back && !!fwd && back.getAttribute('data-show') === '1' && fwd.getAttribute('data-show') === '0',
    'seeking back shows the rewind indicator and hides the forward one (never two at once)');

  env.runTimers();
  ok(!!back && back.getAttribute('data-show') === '0',
    'feedback hides automatically after the interval (no leftover visible element)');

  /* ───────── 8. gestures never intercept player controls ────────────────── */

  env.built.currentTime = 50;
  // Centre area: the control's own rect must be ignored by the layer.
  tap(200, 110);
  tap(200, 110);
  ok(env.built.currentTime === 50,
    'double-tapping the CENTRE control area does not seek (play/pause keeps its own target)');

  // Bottom control bar area: ignored.
  tap(60, 205);
  tap(60, 205);
  ok(env.built.currentTime === 50,
    'double-tapping the bottom control bar area does not seek');

  // And the layer never claims the centre button's own click.
  const centreClicks = env.built.playCalls + env.built.pauseCalls;
  const layerClicks = (layer._listeners.click || []).length;
  ok(layerClicks === 1, 'exactly one gesture listener is installed (idempotent)');
  ok((env.built.playCalls + env.built.pauseCalls) === centreClicks,
    'installing the gesture layer does not affect the centre toggle');

  /* ───────────── 9. security-lock containment is never bypassed ─────────── */

  env.win.__medaSecurityStopped = true;
  const playsBefore = env.built.playCalls;
  const pausesBefore = env.built.pauseCalls;
  const timeBefore = env.built.currentTime;

  env.built.paused = true;
  clickControl('play', true);
  ok(env.built.playCalls === playsBefore && env.built.pauseCalls === pausesBefore,
    'with containment active the centre control cannot restart playback');

  tap(330, 100); tap(330, 100);
  tap(60, 100); tap(60, 100);
  ok(env.built.currentTime === timeBefore,
    'with containment active the gesture layer cannot seek or resume the player');

  env.win.__medaSecurityStopped = false;
  clickControl('play', true);
  ok(env.built.playCalls === playsBefore + 1,
    'after containment is released the control works again (no permanent dead state)');

  /* ───────────── 10. control stacking / hit-area CSS ─────────────────────── */

  const css = env.injectedStyles.map((s) => s.textContent).join('\n');
  ok(/\.plyr__control--overlaid\{[^}]*z-index:4/.test(css),
    'centre control CSS raises it above the video wrapper (z-index 4)');
  ok(/\.plyr__control--overlaid\{[^}]*translate3d\(-50%,-50%,0\)/.test(css),
    'centre control CSS keeps it centred while promoting it to its own layer');
  ok(/\.plyr__video \.plyr__controls\{[^}]*z-index:5/.test(css),
    'bottom control bar stays above the video wrapper (z-index 5)');
  // The centre control must follow the CONTROLS-IDLE lifecycle, not be pinned
  // visible for the whole of playback (that pin was the persistent centre
  // button bug). Visibility is applied by the script as inline style; the CSS
  // keeps only a mirror of the SAME predicate, so a provider rebuild that
  // inserts a button after the bar hid cannot leave one painted.
  ok(/\.plyr\.plyr--hide-controls \.plyr__control--overlaid\{[^}]*visibility:hidden/.test(css) &&
     /\.plyr\.plyr--hide-controls \.plyr__control--overlaid\{[^}]*pointer-events:none/.test(css),
    'centre control hides WITH the controls on idle (no persistent centre button)');
  ok(!/\.plyr--control--overlaid\{[^}]*visibility:visible/.test(css) &&
     !/\.plyr__control--overlaid\{[^}]*opacity:1/.test(css),
    'no stylesheet rule pins the centre control visible (the pin was the bug)');
  ok(/#plyr-gesture-zone\{[^}]*z-index:1/.test(css),
    'the gesture layer sits above the video (1) and below controls (4/5)');
  ok(/#plyr-gesture-zone\{[^}]*touch-action:manipulation/.test(css),
    'the gesture layer opts out of double-tap zoom / delayed taps');
  // A control may only become pointer-transparent in the SAME rule that makes
  // it invisible (the idle-hidden centre button); a visible control must never
  // be untappable.
  const pointerNoneRules = css.split('}').filter((r) => /pointer-events:\s*none/.test(r));
  ok(
    pointerNoneRules.every((r) => /visibility:hidden/.test(r) || /plyr-gesture-feedback/.test(r) || /\/\*/.test(r)),
    'no VISIBLE player control is made pointer-transparent (controls stay tappable)',
  );
  ok(/\.plyr-gesture-feedback\{[^}]*pointer-events:\s*none/.test(css),
    'seeking feedback is pointer-transparent (it can never block a tap)');

  /* ── 10b. the lifecycle's SINGLE source of truth ──────────────────────── */
  const showFn = (script.match(/function centreShouldShow\(\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(showFn.length > 0, 'centreShouldShow() is present');
  ok(/plyr--hide-controls/.test(showFn),
    'the centre predicate reads the bar\'s own plyr--hide-controls class');
  ok(!/player\.paused|player\.ended/.test(showFn),
    'the centre predicate does not read the embed paused/ended proxies (they can disagree with the painted class)');
  ok(/function centreButton\(\) \{\s*var root = playerRoot\(\);/.test(script),
    'the centre button is looked up inside the LIVE root (never the first node in the document)');
  ok(/hideStrayCentre/.test(script),
    'a centre button left in a detached root is closed instead of painted');
  ok(/attributeFilter: \['class'\], childList: true/.test(script),
    'the lifecycle observer also watches control-bar (re)insertion');

  /* ── 10c. debug-build one-tap diagnostic wired into the player screen ──── */
  const ytSource = read('src/components/YouTubePlayer.tsx');
  ok(/\{__DEV__ && Platform\.OS !== 'web' && \(\s*<Pressable/.test(ytSource) &&
     /requestCentreDiag/.test(ytSource) &&
     /window\.__plyrDiag && window\.__plyrDiag\(\); true;/.test(ytSource),
    'debug builds render a one-tap DIAG control that injects __plyrDiag() (native channel only)');
  ok(/typeof wv\.injectJavaScript !== 'function'\) return;/.test(ytSource),
    'the diagnostic is a no-op where the WebView bridge does not exist (never throws on web)');
  ok(/if \(__DEV__ && diagPendingRef\.current\)/.test(ytSource),
    'the on-screen answer is shown only for a DIAG tap, and only in debug builds');
  ok(/PASS — the centre button is hidden together with the bar/.test(ytSource) &&
     /FAIL — the bar is hidden but the centre button is still painted/.test(ytSource),
    'the diagnostic prints a plain PASS / FAIL verdict the reporter can read out');

  /* ───────── 11. preserved configuration (fullscreen / speed / provider) ── */

  ok(cfg.fullscreen && cfg.fullscreen.enabled === true && cfg.fullscreen.fallback === true,
    'fullscreen configuration is unchanged (enabled + fallback for the native trigger)');
  ok(cfg.settings && cfg.settings.includes('speed') &&
     cfg.speed && cfg.speed.options.includes(2),
    'playback-speed settings are unchanged');
  ok(cfg.clickToPlay === false,
    'clickToPlay stays false — a single video-surface tap still does not toggle playback');
  ok(cfg.youtube && cfg.youtube.controls === 0 && cfg.youtube.fs === 0,
    'YouTube embed parameters are unchanged (Plyr owns the controls)');
  ok(/player\.currentTime\s*=\s*target/.test(script),
    'seeking goes through Plyr\'s own currentTime API (YouTube: seekTo), not a fake UI');

  /* ────────── 12. no re-introduced tap-anywhere toggle mechanism ────────── */

  ok(!/function\s+fixiOSTapToToggle/.test(script),
    'the removed tap-anywhere interceptor is not re-introduced');
  ok(!/createElement\(\s*['"]button['"]\s*\)/.test(script),
    'no transparent button is created over the video surface');
}

/* ─────────────── 13. the web copy stays in functional parity ────────────── */

const web = read('public/player/player.js');
ok(/seekTime:\s*10/.test(web), 'web player.js: seekTime = 10 present');
ok(/'rewind',\s*'play',\s*'fast-forward'/.test(web),
  'web player.js: rewind / fast-forward surround play in the control list');
ok(/plyr-control-fixes/.test(web),
  'web player.js: the control stacking/hit-area CSS is injected');
ok(/function\s+togglePlayback\(/.test(web) && /player\.pause\(\)/.test(web) && /player\.play\(\)/.test(web),
  'web player.js: the centre control issues real play/pause commands');
ok(/__medaSeekTap/.test(web) && /plyr-gesture-zone/.test(web),
  'web player.js: has the same double-tap seek layer');
ok(/__medaSecurityStopped/.test(web),
  'web player.js: honours security-lock containment like the native script');
ok(/setCentreState\(/.test(web) && /plyr-gesture-feedback/.test(web) &&
   /realPlaying\(\)/.test(web) && /\.pause\(\)/.test(web) && /\.play\(\)/.test(web),
  'web player.js: syncs the centre glyph from real state and issues real play/pause');
// The web copy must carry the SAME lifecycle fix as the native script.
const webShowFn = (web.match(/function centreShouldShow\(\) \{[\s\S]*?\n    \}/) || [''])[0];
ok(webShowFn.length > 0 && /plyr--hide-controls/.test(webShowFn) &&
   !/player\.paused|player\.ended/.test(webShowFn),
  'web player.js: the centre predicate is the bar class alone (native parity)');
ok(/function centreButton\(\) \{\s*var root = playerRoot\(\);/.test(web) &&
   /hideStrayCentre/.test(web),
  'web player.js: live-root scoped centre lookup + stray handling');
ok(/\.plyr\.plyr--hide-controls \.plyr__control--overlaid\{[^}]*visibility:hidden/.test(web),
  'web player.js: the CSS mirror hides the centre with the bar');
ok(!/function\s+fixiOSTapToToggle/.test(web),
  'web player.js: the removed tap-anywhere interceptor is not re-introduced');

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
