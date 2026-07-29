/**
 * watermarkInjection.ts
 *
 * Builds the self-contained JavaScript string injected into the VdoCipher
 * WebView via injectedJavaScriptBeforeContentLoaded on Android and iOS.
 *
 * This module has NO React Native dependency — it is a pure TypeScript
 * utility that produces a plain string.  React Native only supplies the
 * student name and watermark ID; everything else executes inside the player
 * page's own JavaScript engine.
 *
 * The generated IIFE:
 *   1. Bridges VdoCipher postMessage events → ReactNativeWebView.postMessage
 *      (event bridge runs immediately — safe before DOM is ready because it
 *      only touches window.addEventListener).
 *   2. Injects a <style> tag with:
 *        • @keyframes __fwmPulse for CSS-driven opacity + rotation animation
 *          (zero JS per frame — entirely on the compositor thread).
 *   3. Appends the watermark <div> ONCE to document.body (or waits for
 *      DOMContentLoaded if body is not yet available).
 *   4. Positions the overlay using transform:translate3d(x,y,0) only — this
 *      is compositor-layer movement with zero layout recalculation.
 *      top/left are set to 0 once at mount and never modified again.
 *   5. Moves the overlay to a new random position every 30–60 seconds by
 *      writing only el.style.transform — the only JS timer needed.
 *   6. Watches document.body for childList changes (direct children only)
 *      to detect node removal.  The attribute observer is scoped to the
 *      watermark element itself — not the full subtree.
 *      In normal playback the observer does essentially zero work.
 *   7. Guards against duplicate initialisation (idempotent — safe to inject
 *      multiple times if WebView reloads without unmounting).
 *
 * Performance strategy:
 *   • All per-frame animation → pure CSS @keyframes (__fwmPulse).
 *   • __fwmSize (font-size keyframes) removed — font-size changes trigger
 *     layout recalculation on every frame.
 *   • Position changes → transform:translate3d only (compositor-only, zero reflow).
 *   • JS timer fires every 30–60 s and writes one style property (transform).
 *   • No getComputedStyle, no querySelectorAll in any hot path.
 *   • Child span references stored at build time — no DOM queries in observer.
 *
 * Fullscreen safety:
 *   • position:fixed anchors the overlay to the viewport.
 *   • HTML5 fullscreen preserves the document context, so position:fixed
 *     stays relative to the fullscreen viewport on both Android and iOS.
 *
 * DRM safety:
 *   • No WebView layer type is changed — Widevine content protection is intact.
 */

// ─── String escaping ──────────────────────────────────────────────────────────

/**
 * Escape a plain text string so it can be safely embedded inside a JS string
 * literal delimited by single quotes.  Handles backslash, quotes, angle
 * brackets, and line terminators.
 */
function escapeForJsLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/</g, '\\x3C')
    .replace(/>/g, '\\x3E')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the complete IIFE string to pass to
 * `injectedJavaScriptBeforeContentLoaded` on the native WebView.
 *
 * When `watermarkId` is omitted the output contains only the event bridge
 * (no watermark overlay is created).
 *
 * @param watermarkId   Student's WM-NNNN identifier (sequential numeric format).
 * @param watermarkName Student display name (optional — omit for ID-only mode).
 */
export function buildWatermarkInjection(
  watermarkId?: string,
  watermarkName?: string,
): string {
  const safeId   = watermarkId   ? escapeForJsLiteral(watermarkId)   : '';
  const safeName = watermarkName ? escapeForJsLiteral(watermarkName) : '';

  // ── Part 1: event bridge ───────────────────────────────────────────────────
  // Runs immediately — window.addEventListener is safe before DOM parsing.
  // Throttles progress messages to 1 event / second to avoid bridge saturation.
  const eventBridge = `
(function(){
  var _lp=0;
  window.addEventListener('message',function(e){
    try{
      var r=typeof e.data==='string'?JSON.parse(e.data):e.data;
      if(!r||!window.ReactNativeWebView)return;
      var t=r.event;
      if(t==='ready'||t==='ended'){
        window.ReactNativeWebView.postMessage(JSON.stringify({type:'vdo:'+t}));
      }
      if(t==='progress'){
        var now=Date.now();
        if(now-_lp>1000){
          _lp=now;
          var d=r.data||{};
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type:'vdo:progress',
            currentTime:d.currentTime||0,
            duration:d.duration||0
          }));
        }
      }
      if(t==='error'){
        var msg=(r.data&&r.data.message)?r.data.message:'Playback error';
        window.ReactNativeWebView.postMessage(JSON.stringify({type:'vdo:error',message:msg}));
      }
    }catch(x){}
  });
})();`;

  // No watermark requested (non-student role) — return event bridge only.
  if (!watermarkId) {
    return eventBridge + '\ntrue;';
  }

  // ── Part 2: forensic watermark IIFE ───────────────────────────────────────
  //
  // Grid: 9 fixed slots as [xFraction, yFraction] of viewport size.
  // Inset from each edge so text is never cut off on any screen ratio.
  //
  // Movement strategy:
  //   • translate3d(x,y,0) only — compositor-layer, zero layout recalculation.
  //   • top:0 left:0 fixed at mount; transform does all positioning.
  //   • Timer fires every 30–60 s and writes one style property.
  //
  // CSS animation (__fwmPulse):
  //   • Opacity fade (0.22–0.46) + rotation (−3°…+3°) — pure CSS keyframes.
  //   • Zero JS per frame — entirely on the compositor thread.
  //   • __fwmSize REMOVED — font-size animation triggers layout every frame.
  //
  // MutationObserver:
  //   • Observer 1: body childList only (direct children) — catches removal.
  //   • Observer 2: watermark element itself for attribute/text tampering.
  //   • NOT watching the full subtree for attributes — avoids flooding.
  //   • Child span references stored at build time (no querySelectorAll in
  //     observer callbacks).
  //
  const watermarkIIFE = `
(function(){
  /* ── Guard against double-initialisation on WebView reload ── */
  if(window.__fwmInit)return;
  window.__fwmInit=true;

  var EL_ID='__fwm__';
  var ST_ID='__fwm_style__';
  var WM_ID='${safeId}';
  var WM_NAME='${safeName}';

  /* 9-slot grid [xFrac, yFrac] — inset ~12% from every edge (≥24 px safe margin) */
  var G=[
    [0.12,0.12],[0.42,0.10],[0.72,0.12],
    [0.08,0.45],[0.38,0.45],[0.68,0.45],
    [0.12,0.78],[0.42,0.76],[0.72,0.78]
  ];
  var cur=-1;

  function rnd(a,b){return a+Math.random()*(b-a);}
  function nxtSlot(){
    var n;do{n=Math.floor(Math.random()*G.length);}while(n===cur);
    cur=n;return G[n];
  }

  /* Viewport dimensions — read once at mount, reused on every move.
     No layout reads in the timer callback. */
  var _vw=0,_vh=0;
  function captureViewport(){
    _vw=window.innerWidth||320;
    _vh=window.innerHeight||180;
  }

  function slotTransform(slot,deg){
    return 'translate3d('+Math.round(slot[0]*_vw)+'px,'+Math.round(slot[1]*_vh)+'px,0) rotate('+deg+'deg)';
  }

  /* ── Inject <style> — appended to <head> or <html> if head absent ── */
  function injectCSS(){
    if(document.getElementById(ST_ID))return;
    var s=document.createElement('style');
    s.id=ST_ID;
    s.textContent=[
      '#'+EL_ID+'{',
        'position:fixed;',
        'top:0;',
        'left:0;',
        'z-index:2147483647;',
        'pointer-events:none;',
        'user-select:none;',
        '-webkit-user-select:none;',
        'line-height:1.4;',
        'max-width:min(360px,68vw);',
        'overflow:visible;',
        /* Compositor-only transition — zero layout cost */
        'transition:transform 1.3s cubic-bezier(.34,1.56,.64,1),opacity 0.8s ease;',
        'will-change:transform,opacity;',
        /* CSS animation handles opacity variation — zero JS per frame */
        'animation:__fwmPulse 12s ease-in-out infinite;',
        'opacity:0;',
        'transform:translate3d(0,0,0);',
      '}',
      '#'+EL_ID+' span{',
        'display:block;',
        'color:#F2F4F7;',
        /* System sans-serif stack — Inter/Manrope/SF Pro/Roboto as available */
        'font-family:"Inter","Manrope",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
        'font-size:15px;',
        'font-weight:500;',
        'letter-spacing:0.04em;',
        'white-space:nowrap;',
        'text-shadow:0 1px 5px rgba(0,0,0,.85),0 0 12px rgba(0,0,0,.5);',
        '-webkit-font-smoothing:antialiased;',
      '}',
      /* Single-line combined label — no .fwm-n / .fwm-i split */
      /* Opacity + subtle pulse — pure CSS compositor animation */
      '@keyframes __fwmPulse{',
        '0%  {opacity:.28;}',
        '20% {opacity:.34;}',
        '45% {opacity:.30;}',
        '65% {opacity:.35;}',
        '85% {opacity:.29;}',
        '100%{opacity:.28;}',
      '}'
    ].join('');
    (document.head||document.documentElement).appendChild(s);
  }

  /* ── Build the watermark element — called ONCE ── */
  /* Store span references to avoid querySelectorAll in observer callbacks */
  var _el=null,_nSpan=null,_iSpan=null;
  function buildEl(){
    var d=document.createElement('div');
    d.id=EL_ID;
    /* Single-line: "NAME • WM-NNNN" or "WM-NNNN" */
    _iSpan=document.createElement('span');
    _iSpan.className='fwm-i';
    _iSpan.textContent=WM_NAME ? WM_NAME+' \u2022 '+WM_ID : WM_ID;
    d.appendChild(_iSpan);
    return d;
  }

  /* ── Mount: inject style + create element, set initial transform ── */
  function mount(){
    if(document.getElementById(EL_ID))return;
    injectCSS();
    captureViewport();
    _el=buildEl();
    (document.body||document.documentElement).appendChild(_el);
    /* Double rAF to ensure element is painted before transition starts */
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        if(!_el)return;
        var slot=nxtSlot();
        var deg=rnd(-3,3).toFixed(1);
        _el.style.transform='translate3d('+Math.round(slot[0]*_vw)+'px,'+Math.round(slot[1]*_vh)+'px,0)';
        _el.style.opacity=rnd(0.28,0.35).toFixed(2);
      });
    });
  }

  /* ── Move: write transform + opacity only — compositor-only, zero reflow ── */
  var _tmr=null;
  function move(){
    if(!_el||!_el.parentNode){recover();return;}
    var slot=nxtSlot();
    _el.style.transform=slotTransform(slot,'0');
    _el.style.opacity=rnd(0.28,0.35).toFixed(2);
  }

  /* ── Self-rescheduling move timer (20–30 s) ── */
  function scheduleTick(){
    _tmr=setTimeout(function(){move();scheduleTick();},rnd(20000,30000));
  }

  /* ── Lightweight tamper check — no getComputedStyle, no querySelectorAll ── */
  function isTampered(){
    if(!_el||!_el.parentNode)return true;
    if(_el.style.display==='none')return true;
    if(_el.style.visibility==='hidden')return true;
    /* Single-line span: check combined label */
    var expected=WM_NAME?WM_NAME+' \u2022 '+WM_ID:WM_ID;
    if(_iSpan&&_iSpan.textContent!==expected)return true;
    return false;
  }

  /* ── Tamper recovery — NEVER called during normal playback ── */
  function recover(){
    if(_tmr){clearTimeout(_tmr);_tmr=null;}
    if(_el&&_el.parentNode){try{_el.parentNode.removeChild(_el);}catch(e){}}
    _el=null;_nSpan=null;_iSpan=null;
    mount();
    scheduleTick();
  }

  /* ── MutationObserver — minimal scope ── */
  function watch(){
    if(!window.MutationObserver)return;
    /* Observer 1: body direct children only — catches node removal */
    var body=document.body||document.documentElement;
    new MutationObserver(function(ms){
      for(var i=0;i<ms.length;i++){
        var rm=ms[i].removedNodes;
        for(var r=0;r<rm.length;r++){
          if(rm[r]===_el){recover();return;}
        }
      }
    }).observe(body,{childList:true});
    /* Observer 2: watermark element itself for attribute/text tampering */
    if(_el){
      new MutationObserver(function(){
        if(isTampered())recover();
      }).observe(_el,{
        attributes:true,
        characterData:true,
        subtree:true,
        attributeFilter:['style','class','hidden']
      });
    }
  }

  /* ── Bootstrap: wait for document.body if not yet available ── */
  function start(){
    mount();
    scheduleTick();
    watch();
  }

  if(document.body){
    start();
  }else{
    document.addEventListener('DOMContentLoaded',start,{once:true});
  }
})();`;

  return eventBridge + '\n' + watermarkIIFE + '\ntrue;';
}
