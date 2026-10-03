/**
 * useFullscreenWindowDims — explicit pixel sizing for fullscreen containers.
 *
 * ── WHY THIS EXISTS (fullscreen black-frame / vanished-overlay root cause) ──
 * Fullscreen previously used absolute-fill chains (position:absolute +
 * top/left/right/bottom 0 + flex:1). Such a chain resolves against EVERY
 * ancestor: if any ancestor transiently (or persistently) lays out at
 * height 0 during the enter-fullscreen + orientation-change churn, the
 * whole chain collapses to 0 height. Measured on device: the WebView
 * document reported 1331x0 in fullscreen (width updated, height 0) —
 * Plyr rendered black; the VdoCipher RN watermark overlay vanished while
 * the native SurfaceView kept drawing independently of collapsed bounds.
 *
 * Explicit pixel dimensions break that dependency: an absolutely-positioned
 * box with concrete width/height lays out at its own size regardless of
 * ancestor height. Dimensions are taken from the real window and re-read
 * on every Dimensions change (rotation, foldables, split-screen).
 */
import { useEffect, useState } from 'react';
import { Dimensions } from 'react-native';

export function useFullscreenWindowDims(enabled: boolean) {
  const [dims, setDims] = useState(() => Dimensions.get('window'));

  useEffect(() => {
    if (!enabled) return;
    setDims(Dimensions.get('window'));
    const sub = Dimensions.addEventListener('change', ({ window }) => {
      setDims(window);
    });
    return () => sub.remove();
  }, [enabled]);

  return dims;
}
