'use strict';
/**
 * Plyr control regression tests — centre play/pause + ±10 s seeking.
 *
 * These tests do NOT grep for strings alone: the REAL generated player script
 * (src/lib/plyr/playerScript.ts) is executed in a VM sandbox with a stub DOM and
 * a stub Plyr instance, then driven with synthetic clicks. That covers the two
 * reported defects directly:
 *
 *   1. "The large centre play/pause button does nothing while the bottom-bar
 *      play/pause works." The centre button is Plyr's `play-large` control
 *      (data-plyr="play" + class plyr__control--overlaid). It is handled here by
 *      a capture-phase delegate so the action runs exactly once even when Plyr's
 *      own binding is missing (the deferred YouTube-embed build is the window in
 *      which a control can be painted without a working handler).
 *
 *   2. ±10 s seeking. The rewind / fast-forward controls are Plyr's own control
 *      types bound to seekTime = 10, clamped into the media range and a no-op for
 *      media with no known duration (live / unseekable).
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

function makeEl(tag, attrs) {
  const a = Object.assign({}, attrs);
  const set = new Set();
  return {
    tagName: String(tag).toUpperCase(),
    id: a.id || '',
    width: 0, height: 0, offsetWidth: 0, offsetHeight: 0,
    style: {}, children: [], textContent: '',
    setAttribute(k, v) { a[k] = String(v); },
    getAttribute(k) { return k in a ? a[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    classList: {
      add(c) { set.add(c); },
      contains(c) { return set.has(c); },
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    __attrs: a,
  };
}

function runPlayerScript() {
  const script = extractPlayerScript();
  if (!script) return { error: 'script not found' };

  const docListeners = {};
  const injectedStyles = [];
  const createdElements = [];
  const playerEl = makeEl('div', { id: 'player' });

  const document = {
    head: makeEl('head', {}),
    documentElement: makeEl('html', {}),
    getElementById(id) { return id === 'player' ? playerEl : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) {
      const e = makeEl(tag, {});
      createdElements.push(e);
      if (tag === 'style') { injectedStyles.push(e); }
      return e;
    },
    addEventListener(type, fn, capture) {
      (docListeners[type] = docListeners[type] || []).push({ fn, capture });
    },
    removeEventListener() {},
  };

  const win = {
    __PLAYER_CONFIG__: { videoId: 'aqz-KE-bpKQ' },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 375, innerHeight: 667,
    location: { href: 'https://medacademy.app' },
  };
  win.parent = win;

  let built = null;
  function FakePlyr(selector, config) {
    this.selector = selector;
    this.config = config;
    this.duration = 100;
    this.currentTime = 0;
    this.playing = false;
    this.handlers = {};
    this.toggleCount = 0;
    built = this;
  }
  FakePlyr.prototype.on = function (evt, fn) {
    (this.handlers[evt] = this.handlers[evt] || []).push(fn);
    return this;
  };
  FakePlyr.prototype.togglePlay = function () { this.toggleCount++; };

  const sandbox = {
    window: win, document, console,
    Plyr: FakePlyr,
    setTimeout: () => 0, clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    Math, Date, JSON, isFinite, Object, Array, String, Number,
  };
  sandbox.globalThis = sandbox;
  win.Plyr = FakePlyr;

  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'playerScript.generated.js' });

  return { docListeners, injectedStyles, built, win };
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

/* ─────────────────────── 2. control plan (source of truth) ──────────────── */

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
    'the centre play-large control is present (the SDK/Plyr centre button, not a custom one)');

  /* ──────────────── 3. centre play/pause toggles exactly once ───────────── */

  const fire = (type, event) => (env.docListeners[type] || []).forEach(l => l.fn(event));

  // Plyr's own ready hooks (controls are built before this fires on embeds).
  const readyHooks = env.built.handlers.ready || [];
  ok(readyHooks.length > 0, 'a ready handler is registered (controls wiring point)');
  readyHooks.forEach(fn => fn());

  const clickListeners = (env.docListeners.click || []).filter(l => l.capture === true);
  ok(clickListeners.length > 0, 'a capture-phase click delegate is installed for the controls');

  function clickControl(kind, overlaid) {
    const el = makeEl('button', { 'data-plyr': kind });
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

  const centreEvt = clickControl('play', true);
  ok(env.built.toggleCount === 1,
    'tapping the CENTRE (play-large/overlaid) control toggles play/pause exactly once');
  ok(centreEvt.stopped === 1 && centreEvt.prevented === 1,
    'the centre handler stops propagation (no double toggle alongside Plyr\'s own handler)');

  // The bottom-bar play button keeps Plyr's own handler — the delegate must not
  // claim it (two handlers acting on one tap is what causes double toggles).
  const barEvt = clickControl('play', false);
  ok(env.built.toggleCount === 1 && barEvt.stopped === 0,
    'the bottom-bar play control is left to Plyr\'s own (working) handler');

  /* ─────────────────────── 4. ±10 s clamped seeking ───────────────────── */

  env.built.duration = 100;
  env.built.currentTime = 25;
  clickControl('rewind', false);
  ok(env.built.currentTime === 15,
    'rewind moves exactly 10 s back from the current position (25 → 15)');

  env.built.currentTime = 95;
  clickControl('fast-forward', false);
  ok(env.built.currentTime <= 100 && env.built.currentTime > 95,
    'fast-forward is clamped so it can never seek past the end (95 → ' + env.built.currentTime + ')');

  env.built.duration = 8;
  env.built.currentTime = 3;
  clickControl('rewind', false);
  ok(env.built.currentTime === 0,
    'rewind is clamped at 0 (never a negative position)');

  env.built.duration = 0;                       // live / not yet seekable
  env.built.currentTime = 3;
  const before = env.built.currentTime;
  clickControl('fast-forward', false);
  clickControl('rewind', false);
  ok(env.built.currentTime === before,
    'seeking is a no-op when the media has no known duration (live / unseekable)');

  env.built.duration = NaN;
  clickControl('fast-forward', false);
  ok(env.built.currentTime === before,
    'seeking is a no-op when the duration is not a finite number');

  /* ───────────────── 5. control stacking / hit-area CSS ────────────────── */

  const css = env.injectedStyles.map(s => s.textContent).join('\n');
  ok(/\.plyr__control--overlaid\{[^}]*z-index:4/.test(css),
    'centre control CSS raises it above the video wrapper (z-index 4)');
  ok(/\.plyr__control--overlaid\{[^}]*translate3d\(-50%,-50%,0\)/.test(css),
    'centre control CSS keeps it centred while promoting it to its own layer');
  ok(/\.plyr__video \.plyr__controls\{[^}]*z-index:5/.test(css),
    'bottom control bar stays above the video wrapper (z-index 5)');
  ok(!/pointer-events:\s*none/.test(css),
    'no control is made pointer-transparent (controls must stay tappable)');

  /* ───────── 6. no re-introduced tap-anywhere toggle mechanism ─────────── */

  // (The name survives in prose explaining its removal; what must not come back
  //  is the interceptor itself — a transparent element over the video surface.)
  ok(!/function\s+fixiOSTapToToggle/.test(script),
    'the removed tap-anywhere interceptor is not re-introduced');
  ok(!/createElement\(\s*['"]button['"]\s*\)/.test(script),
    'no transparent button is created over the video surface');
  ok(/clickToPlay:\s*false/.test(script),
    'clickToPlay stays false — video-surface taps remain inert');
}

/* ─────────────── 7. the web copy stays in functional parity ────────────── */

const web = read('public/player/player.js');
ok(/seekTime:\s*10/.test(web), 'web player.js: seekTime = 10 present');
ok(/'rewind',\s*'play',\s*'fast-forward'/.test(web),
  'web player.js: rewind / fast-forward surround play in the control list');
ok(/plyr__control--overlaid/.test(web) && /togglePlay\(\)/.test(web),
  'web player.js: the centre control has its own toggle handler');
ok(/plyr-control-fixes/.test(web),
  'web player.js: the control stacking/hit-area CSS is injected');

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
