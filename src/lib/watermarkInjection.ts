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
 *   5. Animates the overlay CONTINUOUSLY with requestAnimationFrame: the
 *      position advances from elapsed time and reflects off the four edges of
 *      the measured viewport (billiard motion), so the mark is always moving,
 *      always inside the frame, and never fades or hides.
 *   6. Watches document.body for childList changes (direct children only)
 *      to detect node removal.  The attribute observer is scoped to the
 *      watermark element itself — not the full subtree.
 *      In normal playback the observer does essentially zero work.
 *   7. Guards against duplicate initialisation (idempotent — safe to inject
 *      multiple times if WebView reloads without unmounting).
 *
 * Performance strategy:
 *   • One frame loop, one element: transform-only writes inside the loop, so
 *     the compositor does the work and no layout is recalculated.
 *   • No CSS keyframes for opacity — the mark never fades, blinks or hides.
 *   • Position changes → transform:translate3d only (compositor-only, zero reflow).
 *   • Single element reference and two span references stored at build time —
 *     no getComputedStyle, no querySelectorAll in any hot path.
 *   • Loop cancelled and listeners removed on tamper recovery.
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

  /* ── CONTINUOUS BILLIARD MOTION — same model as the Plyr watermark ────────
     The previous implementation teleported to one of nine fixed slots every
     30–60 s (a glide, not motion) and re-drew opacity on each move. This is a
     real trajectory: position advances from ELAPSED TIME in requestAnimationFrame,
     velocity reflects EXACTLY off the four edges of the measured viewport, and
     the element's own box is subtracted so the whole mark (name line + id line)
     stays inside at all times.

     • No opacity animation at all — the mark never fades, blinks or hides.
     • No CSS transition on transform — the frame loop owns the position, so
       there is no easing lag between frames.
     • pointer-events:none — taps, drags and seeks always reach the player. */
  var _el=null,_nEl=null,_iEl=null;
  var _raf=0,_last=0;
  var _x=0,_y=0,_vx=0,_vy=0;
  var _vw=0,_vh=0,_ew=0,_eh=0;
  var _resizeBound=false;
  var SPEED_MIN=26,SPEED_MAX=44,MAX_STEP_S=0.05;

  function rnd(a,b){return a+Math.random()*(b-a);}

  function captureViewport(){
    _vw=window.innerWidth||320;
    _vh=window.innerHeight||180;
    if(_el){_ew=_el.offsetWidth||0;_eh=_el.offsetHeight||0;}
  }
  function maxX(){var m=_vw-_ew;return m>0?m:0;}
  function maxY(){var m=_vh-_eh;return m>0?m:0;}

  /* Responsive type: 6.2 % of the smaller viewport dimension, clamped 13–34 px,
     so the mark is readable on a phone and clearly larger in fullscreen. */
  function fontSize(){
    var base=Math.min(_vw||360,_vh||202);
    var px=Math.round(base*0.062);
    if(px<13)px=13;
    if(px>34)px=34;
    return px;
  }
  function applyFont(){
    var px=fontSize();
    if(_nEl)_nEl.style.fontSize=Math.round(px*0.9)+'px';
    if(_iEl)_iEl.style.fontSize=px+'px';
  }

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
        'max-width:78%;',
        'opacity:0.55;',
        'will-change:transform;',
        'transform:translate3d(0,0,0);',
      '}',
      '#'+EL_ID+' > div{',
        'display:block;',
        'color:#fff;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
        'font-weight:600;',
        'letter-spacing:0.3px;',
        'white-space:nowrap;',
        'line-height:1.25;',
        'text-shadow:0 1px 4px rgba(0,0,0,0.95),0 0 10px rgba(0,0,0,0.7);',
        '-webkit-font-smoothing:antialiased;',
      '}',
    ].join('');
    (document.head||document.documentElement).appendChild(s);
  }

  /* Two lines: the recipient's display name, then the complete public id
     directly underneath it. The "ID:" prefix is gone — the id is a line, not
     a sentence — and the name line can never push the id out of view because
     it is a separate block with its own ellipsis. */
  function buildEl(){
    var d=document.createElement('div');
    d.id=EL_ID;
    if(WM_NAME){
      _nEl=document.createElement('div');
      _nEl.textContent=WM_NAME;
      _nEl.style.fontWeight='600';
      _nEl.style.opacity='0.92';
      _nEl.style.overflow='hidden';
      _nEl.style.textOverflow='ellipsis';
      d.appendChild(_nEl);
    }
    _iEl=document.createElement('div');
    _iEl.textContent=WM_ID;
    _iEl.style.fontWeight='700';
    d.appendChild(_iEl);
    return d;
  }

  function draw(){
    if(!_el)return;
    _el.style.transform='translate3d('+Math.round(_x)+'px,'+Math.round(_y)+'px,0)';
  }

  /* Exact reflection: the overshoot travels back, so speed is preserved and
     the mark never sticks to a wall. */
  function advance(pos,vel,dt,max){
    var next=pos+vel*dt, v=vel, i;
    for(i=0;i<4;i++){
      if(next<0){next=-next;v=-v;}
      else if(next>max){next=2*max-next;v=-v;}
      else break;
    }
    if(next<0)next=0;
    if(next>max)next=max;
    return {pos:next,vel:v};
  }

  function step(ts){
    if(!_el||!_el.parentNode){_raf=0;recover();return;}
    if(!_last)_last=ts;
    var dt=(ts-_last)/1000;
    _last=ts;
    if(!isFinite(dt)||dt<0)dt=0;
    if(dt>MAX_STEP_S)dt=MAX_STEP_S;
    var ax=advance(_x,_vx,dt,maxX());
    var ay=advance(_y,_vy,dt,maxY());
    _x=ax.pos;_vx=ax.vel;
    _y=ay.pos;_vy=ay.vel;
    draw();
    _raf=requestAnimationFrame(step);
  }

  function startMotion(){
    if(_raf){cancelAnimationFrame(_raf);_raf=0;}
    _last=0;
    captureViewport();
    applyFont();
    captureViewport();
    _x=maxX()*rnd(0.12,0.88);
    _y=maxY()*rnd(0.12,0.88);
    var speed=rnd(SPEED_MIN,SPEED_MAX);
    var share=rnd(0.55,0.85);
    _vx=speed*share*(Math.random()<0.5?-1:1);
    _vy=speed*Math.sqrt(Math.max(0,1-share*share))*(Math.random()<0.5?-1:1);
    draw();
    _raf=requestAnimationFrame(step);
  }

  /* Resize / orientation / fullscreen: re-measure, re-scale the type and clamp
     the position immediately. Velocity is kept, so the trajectory continues. */
  function onResize(){
    if(!_el)return;
    captureViewport();
    applyFont();
    captureViewport();
    if(_x>maxX())_x=maxX();
    if(_y>maxY())_y=maxY();
    draw();
  }

  function mount(){
    if(document.getElementById(EL_ID))return;
    injectCSS();
    captureViewport();
    _el=buildEl();
    (document.body||document.documentElement).appendChild(_el);
    startMotion();
    if(!_resizeBound){_resizeBound=true;window.addEventListener('resize',onResize);}
  }

  function isTampered(){
    if(!_el||!_el.parentNode)return true;
    if(_el.style.display==='none')return true;
    if(_el.style.visibility==='hidden')return true;
    if(_nEl&&_nEl.textContent!==WM_NAME)return true;
    if(_iEl&&_iEl.textContent!==WM_ID)return true;
    return false;
  }

  function recover(){
    if(_raf){cancelAnimationFrame(_raf);_raf=0;}
    if(_el&&_el.parentNode){try{_el.parentNode.removeChild(_el);}catch(e){}}
    _el=null;_nEl=null;_iEl=null;_last=0;
    mount();
  }

  var _obs1=null,_obs2=null;
  function watch(){
    if(!window.MutationObserver)return;
    if(_obs1){try{_obs1.disconnect();}catch(e){}}
    if(_obs2){try{_obs2.disconnect();}catch(e){}}
    var body=document.body||document.documentElement;
    _obs1=new MutationObserver(function(ms){
      for(var i=0;i<ms.length;i++){
        var rm=ms[i].removedNodes;
        for(var r=0;r<rm.length;r++){if(rm[r]===_el){recover();return;}}
      }
    });
    _obs1.observe(body,{childList:true});
    if(_el){
      _obs2=new MutationObserver(function(){if(isTampered())recover();});
      _obs2.observe(_el,{
        attributes:true,
        characterData:true,
        subtree:true,
        attributeFilter:['style','class','hidden']
      });
    }
  }

  function start(){
    mount();
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
