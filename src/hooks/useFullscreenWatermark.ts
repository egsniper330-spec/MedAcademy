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
 * ── Position grid ─────────────────────────────────────────────────────────────
 *   9 fixed slots as fractions of the viewport. Each slot keeps ≥8% inset from
 *   every edge. The watermark moves to a new slot every 30–60 s (random) using
 *   CSS transition on transform — zero layout recalculation.
 */

import { useEffect, useRef } from 'react';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface WatermarkConfig {
  watermarkId:    string;
  watermarkName?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WM_EL_ID   = 'vdo-wm-fs';
const WM_ST_ID   = 'vdo-wm-fs-style';

/** 9-slot grid — [xFraction, yFraction], inset ~12% from every edge (≥24 px safe margin) */
const GRID: [number, number][] = [
  [0.12, 0.12], [0.42, 0.10], [0.72, 0.12],
  [0.08, 0.45], [0.38, 0.45], [0.68, 0.45],
  [0.12, 0.78], [0.42, 0.76], [0.72, 0.78],
];

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
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const curSlot   = useRef(-1);
  const vwRef     = useRef(0);
  const vhRef     = useRef(0);

  useEffect(() => {
    // Only active on web and when a watermark is required.
    if (process.env.EXPO_OS !== 'web') return;
    if (!enabled || !config?.watermarkId) return;

    const { watermarkId, watermarkName } = config;

    // ── Helpers ────────────────────────────────────────────────────────────

    function rnd(a: number, b: number) { return a + Math.random() * (b - a); }
    function nextSlot(): [number, number] {
      let n: number;
      do { n = Math.floor(Math.random() * GRID.length); } while (n === curSlot.current);
      curSlot.current = n;
      return GRID[n];
    }

    function captureVP(el: HTMLElement) {
      vwRef.current = el.clientWidth  || window.innerWidth  || 320;
      vhRef.current = el.clientHeight || window.innerHeight || 180;
    }

    function mkTransform(slot: [number, number], deg: number): string {
      return (
        `translate3d(${Math.round(slot[0] * vwRef.current)}px,` +
        `${Math.round(slot[1] * vhRef.current)}px,0) rotate(${deg.toFixed(1)}deg)`
      );
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
          'max-width:min(360px,68%);',
          'opacity:0;',
          'transform:translate3d(0,0,0);',
          'line-height:1.4;',
          'font-family:"Inter","Manrope",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
          'transition:transform 0.6s ease,opacity 0.6s ease;',
          'will-change:transform,opacity;',
        '}',
        // Fullscreen variant — switch to fixed so it covers the viewport
        `#${WM_EL_ID}.fs-active{position:fixed;}`,
        // Single-line label span: "NAME • WM-NNNN"
        `#${WM_EL_ID} .wm-label{`,
          'display:block;',
          'font-size:15px;font-weight:500;letter-spacing:0.04em;',
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
          'color:#F2F4F7;',
          'text-shadow:0 1px 5px rgba(0,0,0,0.85),0 0 12px rgba(0,0,0,0.5);',
          '-webkit-font-smoothing:antialiased;',
        '}',
      ].join('');
      (document.head || document.documentElement).appendChild(s);
    }

    // ── Build element ──────────────────────────────────────────────────────

    function buildEl(): HTMLDivElement {
      const d = document.createElement('div');
      d.id = WM_EL_ID;
      // Single-line combined label: "NAME • WM-NNNN" or "WM-NNNN"
      const span = document.createElement('div');
      span.className = 'wm-label';
      span.textContent = watermarkName ? `${watermarkName} \u2022 ${watermarkId}` : watermarkId;
      d.appendChild(span);
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

      // Double rAF — first paints at opacity:0, second triggers transition
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!elRef.current) return;
          const slot = nextSlot();
          const deg  = rnd(-3, 3);
          elRef.current.style.transform = mkTransform(slot, deg);
          elRef.current.style.opacity   = rnd(0.28, 0.35).toFixed(2);
        });
      });
    }

    // ── Periodic move ──────────────────────────────────────────────────────

    function move() {
      const el = elRef.current;
      if (!el) return;
      const slot = nextSlot();
      const deg  = rnd(-3, 3);
      el.style.transform = mkTransform(slot, deg);
      el.style.opacity   = rnd(0.28, 0.35).toFixed(2);
    }

    function scheduleTick() {
      timerRef.current = setTimeout(() => {
        move();
        scheduleTick();
      }, rnd(20_000, 30_000));
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

        // Recapture viewport dimensions from the fullscreen element
        captureVP(fsEl as HTMLElement);
        // Immediately update position so it isn't stuck at 0,0
        const slot = nextSlot();
        const deg  = rnd(-3, 3);
        el.style.transform = mkTransform(slot, deg);
        el.style.opacity   = rnd(0.45, 0.60).toFixed(2);
      } else {
        // ── Exiting fullscreen ───────────────────────────────────────────
        el.classList.remove('fs-active'); // back to position:absolute

        const container = containerRef.current;
        if (container) {
          container.appendChild(el);
          // Recapture for normal-mode dimensions
          captureVP(container);
          const slot = nextSlot();
          const deg  = rnd(-3, 3);
          el.style.transform = mkTransform(slot, deg);
          el.style.opacity   = rnd(0.40, 0.56).toFixed(2);
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
        const slot = nextSlot();
        const deg  = rnd(-3, 3);
        el.style.transform = mkTransform(slot, deg);
      }
    }

    // ── Bootstrap ──────────────────────────────────────────────────────────

    mount();
    scheduleTick();

    document.addEventListener('fullscreenchange',       handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange',    handleFullscreenChange);
    document.addEventListener('MSFullscreenChange',     handleFullscreenChange);
    window.addEventListener('resize',                   handleResize);
    window.addEventListener('orientationchange',        handleResize);

    // ── Cleanup ────────────────────────────────────────────────────────────

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

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
