/**
 * useFullscreenWatermark.ts
 *
 * Web-only hook that injects a forensic watermark <div> into the VdoCipher
 * player container and keeps it visible during every fullscreen state:
 *   • Normal mode       — overlay is a child of the player container
 *   • Browser fullscreen — overlay is re-parented into document.fullscreenElement
 *     so it stays inside the promoted fullscreen layer
 *   • Exit fullscreen   — overlay is restored to the original container
 *
 * ── Why the Reanimated overlay alone is not enough ────────────────────────────
 *
 *   ForensicWatermarkOverlay renders as a React Native Animated.View — on web
 *   this becomes a CSS-positioned <div> inside the player wrapper.
 *
 *   When browser fullscreen is triggered (any browser), the UA:
 *     1. Promotes the fullscreen ELEMENT (the VdoCipher iframe, or a wrapper
 *        VdoCipher itself requests) to a new top-level rendering layer that
 *        paints over the entire viewport.
 *     2. The overlay <div> stays in the original DOM tree — it is NOT a
 *        descendant of the fullscreen element, so it is hidden by the UA.
 *
 *   Additionally, the player container has overflow:'hidden' which clips any
 *   child that tries to escape its bounds — including overlays that attempt to
 *   cover the fullscreen viewport.
 *
 * ── Fix ───────────────────────────────────────────────────────────────────────
 *
 *   This hook creates and owns a single <div id="vdo-wm-fs"> element that is:
 *     • In normal mode: absolutely positioned inside the player container
 *     • On fullscreenchange enter: moved (appendChild) into the
 *       document.fullscreenElement (or webkitFullscreenElement for Safari)
 *       with position:fixed so it covers the fullscreen viewport
 *     • On fullscreenchange exit: moved back into the player container
 *       with position:absolute and original dimensions
 *
 *   The move is a DOM re-parent (no clone, no recreation) so the element ID,
 *   styles, and content are unchanged throughout the transition.
 *
 * ── Safari iPhone ─────────────────────────────────────────────────────────────
 *
 *   Safari on iOS uses a NATIVE video player when the user taps the fullscreen
 *   button — this is the system AVPlayerViewController and it runs in a separate
 *   process. The VdoCipher iframe and the entire web DOM are inaccessible while
 *   the native player is active; no DOM overlay can be shown during that period.
 *
 *   Mitigation (applied in VdoCipherPlayerWebView):
 *     • The iframe receives webkit-playsinline + playsinline attributes, which
 *       keep the video playing inside the web page on iOS Safari (inline mode).
 *     • The VdoCipher player itself passes playsinline:1 in its iframe embed
 *       parameters — this prevents the native fullscreen takeover for most cases.
 *     • When Safari does enter its pseudo-fullscreen via the native controls bar
 *       (not the DOM Fullscreen API), this hook's fullscreenchange listener does
 *       NOT fire (Safari uses a non-standard mechanism). The VdoCipher server-
 *       side `annotate` (rtext) watermark is baked into the video DRM stream and
 *       remains visible inside the VdoCipher player regardless of fullscreen
 *       mode — it is the primary watermark guarantee for Safari iPhone.
 *     • See: https://developer.apple.com/documentation/webkit/delivering_video_content_for_safari
 *
 * ── Browsers tested ───────────────────────────────────────────────────────────
 *   Chrome (Windows/Android): document.fullscreenElement — supported
 *   Firefox:                  document.fullscreenElement — supported
 *   Edge:                     document.fullscreenElement — supported
 *   Safari (macOS):           document.webkitFullscreenElement — supported
 *   Safari (iPhone):          No Document Fullscreen API — native player used;
 *                             VdoCipher annotate (server-side rtext) is primary
 *
 * ── Movement ─────────────────────────────────────────────────────────────────
 *   Continuous billiard motion, identical to the Plyr mark and the WebView
 *   injection: position advances from elapsed time every animation frame and
 *   reflects exactly off the four edges of the measured box (the mark's own
 *   size is subtracted, so it never clips). Fixed opacity — the mark never
 *   fades or blinks — and pointer-events:none, so it never eats a tap.
 *   Fullscreen entry/exit, resize and orientation change re-measure and
 *   restart the loop in the new box with the type scaled to it.
 */

import { useEffect, useRef } from 'react';
import { WATERMARK_FONT_PX } from '@/lib/nativeWatermarkConfig';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface WatermarkConfig {
  watermarkId:    string;
  watermarkName?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WM_EL_ID   = 'vdo-wm-fs';
const WM_ST_ID   = 'vdo-wm-fs-style';

// ─── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Mounts a DOM-level forensic watermark overlay that survives browser fullscreen
 * transitions by re-parenting itself into the active fullscreen element.
 *
 * @param containerRef   ref to the player's root <div> wrapper (the React Native View)
 * @param config         watermarkId (required) + optional watermarkName
 * @param enabled        skip overlay entirely when false (non-student roles)
 */
export function useFullscreenWatermark(
  containerRef: React.RefObject<HTMLDivElement | null>,
  config: WatermarkConfig | null,
  enabled: boolean,
): void {
  // All state is managed in refs — no React re-renders needed.
  const elRef     = useRef<HTMLDivElement | null>(null);
  const vwRef     = useRef(0);
  const vhRef     = useRef(0);

  useEffect(() => {
    // Only active on web and when a watermark is required.
    if (process.env.EXPO_OS !== 'web') return;
    if (!enabled || !config?.watermarkId) return;

    const { watermarkId, watermarkName } = config;

    // ── Helpers ────────────────────────────────────────────────────────────

    function rnd(a: number, b: number) { return a + Math.random() * (b - a); }

    // ── Continuous billiard motion ─────────────────────────────────────────
    // Same model as the Plyr watermark and the WebView injection: the position
    // advances from ELAPSED TIME, velocity reflects exactly off the four edges
    // of the measured box, and the element's own size is subtracted so the whole
    // mark stays inside. No opacity animation, no hide gap, no slot teleport.
    const mot = { x: 0, y: 0, vx: 0, vy: 0 };
    let raf = 0;
    let last = 0;
    let ew = 0;
    let eh = 0;
    const SPEED_MIN = 26, SPEED_MAX = 44, MAX_STEP_S = 0.05;

    function captureVP(el: HTMLElement) {
      vwRef.current = el.clientWidth  || window.innerWidth  || 320;
      vhRef.current = el.clientHeight || window.innerHeight || 180;
      const node = elRef.current;
      if (node) { ew = node.offsetWidth || 0; eh = node.offsetHeight || 0; }
    }
    const maxX = () => Math.max(0, vwRef.current - ew);
    const maxY = () => Math.max(0, vhRef.current - eh);

    // Responsive type: 6.2 % of the smaller box, clamped 13–34 px.
    function fontSize(): number {
      const base = Math.min(vwRef.current || 360, vhRef.current || 202);
      return Math.round(Math.min(34, Math.max(13, base * 0.062)));
    }
    function applyFont() {
      const el = elRef.current;
      if (!el) return;
      const px = fontSize();
      el.querySelectorAll('[data-wm-line]').forEach((n) => {
        const node = n as HTMLElement;
        node.style.fontSize = (node.dataset.wmLine === 'name' ? Math.round(px * 0.9) : px) + 'px';
      });
    }

    function advance(pos: number, vel: number, dt: number, max: number) {
      let next = pos + vel * dt;
      let v = vel;
      for (let i = 0; i < 4; i++) {
        if (next < 0) { next = -next; v = -v; }
        else if (next > max) { next = 2 * max - next; v = -v; }
        else break;
      }
      return { pos: Math.max(0, Math.min(max, next)), vel: v };
    }

    function draw() {
      const el = elRef.current;
      if (!el) return;
      el.style.transform = `translate3d(${Math.round(mot.x)}px,${Math.round(mot.y)}px,0)`;
    }

    function step(ts: number) {
      const el = elRef.current;
      if (!el) { raf = 0; return; }
      if (!last) last = ts;
      let dt = (ts - last) / 1000;
      last = ts;
      if (!isFinite(dt) || dt < 0) dt = 0;
      if (dt > MAX_STEP_S) dt = MAX_STEP_S;
      const ax = advance(mot.x, mot.vx, dt, maxX());
      const ay = advance(mot.y, mot.vy, dt, maxY());
      mot.x = ax.pos; mot.vx = ax.vel;
      mot.y = ay.pos; mot.vy = ay.vel;
      draw();
      raf = requestAnimationFrame(step);
    }

    function startMotion() {
      const el = elRef.current;
      if (!el) return;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      last = 0;
      applyFont();
      ew = el.offsetWidth || 0;
      eh = el.offsetHeight || 0;
      mot.x = maxX() * rnd(0.12, 0.88);
      mot.y = maxY() * rnd(0.12, 0.88);
      const speed = rnd(SPEED_MIN, SPEED_MAX);
      const share = rnd(0.55, 0.85);
      mot.vx = speed * share * (Math.random() < 0.5 ? -1 : 1);
      mot.vy = speed * Math.sqrt(Math.max(0, 1 - share * share)) * (Math.random() < 0.5 ? -1 : 1);
      el.style.opacity = '0.55';
      draw();
      raf = requestAnimationFrame(step);
    }

    // ── Inject <style> ─────────────────────────────────────────────────────

    function injectCSS() {
      if (document.getElementById(WM_ST_ID)) return;
      const s = document.createElement('style');
      s.id = WM_ST_ID;
      s.textContent = [
        `#${WM_EL_ID}{`,
          'position:absolute;',
          'top:0;left:0;',
          'z-index:2147483647;',
          'pointer-events:none;',
          'user-select:none;',
          '-webkit-user-select:none;',
          'max-width:78%;',
          'opacity:0.55;',
          'transform:translate3d(0,0,0);',
          'line-height:1.25;',
          'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
          'will-change:transform;',
        '}',
        // Fullscreen variant — switch to fixed so it covers the viewport
        `#${WM_EL_ID}.fs-active{position:fixed;}`,
        // Two lines: name, then the id underneath. Font size is written by
        // applyFont() from the measured box; the CSS value is the floor.
        `#${WM_EL_ID} [data-wm-line]{`,
          'display:block;',
          'font-size:' + WATERMARK_FONT_PX + 'px;font-weight:600;letter-spacing:0.3px;',
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
          'color:#fff;',
          'text-shadow:0 1px 4px rgba(0,0,0,0.95),0 0 10px rgba(0,0,0,0.7);',
          '-webkit-font-smoothing:antialiased;',
        '}',
        `#${WM_EL_ID} [data-wm-line="id"]{font-weight:700;}`,
      ].join('');
      (document.head || document.documentElement).appendChild(s);
    }

    // ── Build element ──────────────────────────────────────────────────────

    function buildEl(): HTMLDivElement {
      const d = document.createElement('div');
      d.id = WM_EL_ID;
      // Two lines: display name first, the complete public id underneath.
      if (watermarkName) {
        const nameEl = document.createElement('div');
        nameEl.dataset.wmLine = 'name';
        nameEl.textContent = watermarkName;
        d.appendChild(nameEl);
      }
      const idEl = document.createElement('div');
      idEl.dataset.wmLine = 'id';
      idEl.textContent = watermarkId;
      d.appendChild(idEl);
      return d;
    }

    // ── Mount into container ───────────────────────────────────────────────

    function mount() {
      if (document.getElementById(WM_EL_ID)) return;
      injectCSS();
      const container = containerRef.current;
      if (!container) return;

      // Ensure container is a positioned ancestor (absolute needs it)
      const cs = window.getComputedStyle(container);
      if (cs.position === 'static') container.style.position = 'relative';

      captureVP(container);
      const el = buildEl();
      elRef.current = el;
      container.appendChild(el);

      // Paint first, then start the loop — the element must be measurable
      // before the bounds can subtract its own size.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { startMotion(); });
      });
    }

    // ── Fullscreen transition ──────────────────────────────────────────────
    //
    // When the browser enters fullscreen it promotes ONE element to the
    // fullscreen rendering layer. Only descendants of that element are visible.
    //
    // We re-parent the watermark div INTO that element so it is always visible.
    //
    // position:fixed inside a fullscreen element behaves like position:fixed
    // relative to the fullscreen viewport (not the document viewport) — this
    // is exactly what we want: the watermark covers the entire fullscreen area.
    //
    // On exit: the fullscreen element collapses back, and we re-parent the
    // watermark into the original player container.

    function handleFullscreenChange() {
      const el = elRef.current;
      if (!el) return;

      // Cross-browser fullscreen element getter
      const fsEl: Element | null =
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement    ||
        (document as any).msFullscreenElement     ||
        null;

      if (fsEl) {
        // ── Entering fullscreen ──────────────────────────────────────────
        // Re-parent into the fullscreen element
        fsEl.appendChild(el);
        el.classList.add('fs-active');   // switch to position:fixed

        // Recapture viewport dimensions from the fullscreen element and
        // restart the loop in the new, larger box (the type grows with it).
        captureVP(fsEl as HTMLElement);
        startMotion();
      } else {
        // ── Exiting fullscreen ───────────────────────────────────────────
        el.classList.remove('fs-active'); // back to position:absolute

        const container = containerRef.current;
        if (container) {
          container.appendChild(el);
          // Recapture for normal-mode dimensions and continue in that box.
          captureVP(container);
          startMotion();
        }
      }
    }

    // ── Resize / orientation change ────────────────────────────────────────
    // Recaptures viewport and moves watermark to prevent it going off-screen.

    function handleResize() {
      const el = elRef.current;
      if (!el) return;

      const fsEl: Element | null =
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        null;

      const measureEl = (fsEl ?? containerRef.current) as HTMLElement | null;
      if (measureEl) {
        captureVP(measureEl);
        applyFont();
        captureVP(measureEl);
        if (mot.x > maxX()) mot.x = maxX();
        if (mot.y > maxY()) mot.y = maxY();
        draw();
      }
    }

    // ── Bootstrap ──────────────────────────────────────────────────────────

    mount();

    document.addEventListener('fullscreenchange',       handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange',    handleFullscreenChange);
    document.addEventListener('MSFullscreenChange',     handleFullscreenChange);
    window.addEventListener('resize',                   handleResize);
    window.addEventListener('orientationchange',        handleResize);

    // ── Cleanup ────────────────────────────────────────────────────────────

    return () => {
      // Cancel the animation frame — no loop may outlive the player.
      if (raf) { cancelAnimationFrame(raf); raf = 0; }

      document.removeEventListener('fullscreenchange',       handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange',    handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange',     handleFullscreenChange);
      window.removeEventListener('resize',                   handleResize);
      window.removeEventListener('orientationchange',        handleResize);

      const el = elRef.current;
      if (el && el.parentNode) {
        try { el.parentNode.removeChild(el); } catch (_) {}
      }
      elRef.current = null;

      // Remove style tag only if no other instance will use it
      const st = document.getElementById(WM_ST_ID);
      if (st && st.parentNode) {
        try { st.parentNode.removeChild(st); } catch (_) {}
      }
    };
  }, [enabled, config?.watermarkId, config?.watermarkName]); // eslint-disable-line react-hooks/exhaustive-deps
}
