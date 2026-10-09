/**
 * useFullscreenWindowDims — explicit pixel sizing for fullscreen containers.
 *
 * ── WHY THIS EXISTS (fullscreen black-frame / vanished-overlay root cause) ──
 * Fullscreen previously used absolute-fill chains (position:absolute +
 * top/left/right/bottom 0 + flex:1). Such a chain resolves against EVERY
 * ancestor: if any ancestor transiently (or persistently) lays out at
 * height 0 during the enter-fullscreen + orientation-change churn, the
 * whole chain collapses to 0 height. Measured on device: the WebView
 * document reported 1331x0 in fullscreen (width updated, height 0) — Plyr
 * rendered black; the VdoCipher RN watermark overlay vanished while the
 * native SurfaceView kept drawing independently of collapsed bounds.
 *
 * Explicit pixel dimensions break that dependency: an absolutely-positioned
 * box with concrete width/height lays out at its own size regardless of
 * ancestor height. Dimensions are re-read on every Dimensions change
 * (rotation, foldables, split-screen).
 *
 * ── FULL-DISPLAY SIZING (white band under the video — fixed this round) ─────
 * 'window' is the INSET-ADJUSTED app area. Hiding the navigation bar removes
 * the bar from the screen but does NOT remove its *stable* inset from
 * Dimensions.get('window'): measured on the physical tablet (SM-T505N,
 * landscape fullscreen, Android 12) the window stayed 2000x1128 while the
 * display was 2000x1200 — so the fullscreen container was 1128 tall and the
 * final 72px stayed unpainted by the player, appearing as a flat band of app
 * background under the video (pixel probe: bottom 40px, 1 distinct colour at
 * 100% share; no nav-button glyphs, i.e. the bar really was hidden).
 *
 * 'screen' is the DISPLAY size, which is what an immersive fullscreen surface
 * must cover. We use it whenever it is at least as large as the window, and
 * fall back to 'window' otherwise (defensive: platforms/OEMs where 'screen' is
 * reported smaller or not at all).
 */
import { useEffect, useState } from 'react';
import { Dimensions } from 'react-native';

type Dims = { width: number; height: number };

/** The display size when it is usable, else the inset-adjusted window size. */
function readFullscreenDims(): Dims {
  const win = Dimensions.get('window');
  let scr: Dims | null = null;
  try {
    scr = Dimensions.get('screen');
  } catch {
    scr = null;
  }
  if (scr && scr.width >= win.width && scr.height >= win.height) {
    return { width: scr.width, height: scr.height };
  }
  return { width: win.width, height: win.height };
}

export function useFullscreenWindowDims(enabled: boolean) {
  const [dims, setDims] = useState<Dims>(() => readFullscreenDims());

  useEffect(() => {
    if (!enabled) return;
    setDims(readFullscreenDims());
    const sub = Dimensions.addEventListener('change', () => {
      setDims(readFullscreenDims());
    });
    return () => sub.remove();
  }, [enabled]);

  return dims;
}
