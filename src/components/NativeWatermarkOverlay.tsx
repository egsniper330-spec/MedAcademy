/**
 * NativeWatermarkOverlay.tsx
 *
 * Application-level forensic watermark for BOTH native VdoCipher players
 * (online adapter + offline player) — a behavioral replica of the Plyr/YouTube
 * player's in-HTML watermark (src/lib/plyr/playerScript.ts, `injectWatermark`),
 * whose constants are published in src/lib/nativeWatermarkConfig.ts.
 *
 * ── Why a replica (not a shared component) ─────────────────────────────────
 *   The Plyr watermark lives inside the player's WebView DOM; the native
 *   VdoPlayerView is a native TextureView with no injectable DOM, so the same
 *   behavior must be rendered as a React Native sibling view. The overlay is
 *   positioned via Reanimated shared values driven by the SAME slot table,
 *   timing, opacity band, rotation jitter and clamp as Plyr — verified
 *   value-for-value in nativeWatermarkConfig.ts. Do NOT tune values here:
 *   change nativeWatermarkConfig.ts (and mirror only where the platform
 *   forces it, e.g. web uses CSS transitions natively).
 *
 * ── Behavior (Plyr-parity, stable by construction) ──────────────────────────
 *   • One overlay instance per player; identity resolved ONCE upstream and
 *     keyed by id — cannot flip or re-resolve mid-session.
 *   • Visible immediately at a random slot (opacity 0.40–0.56), then moves
 *     every 30–60 s with a smooth 600 ms ease glide to a random no-repeat
 *     slot, rotation ±3°, opacity re-drawn from 0.38–0.58 — while REMAINING
 *     VISIBLE. No fade-out/teleport/hide gap (the old "watermark disappears"
 *     behaviors are structurally impossible: opacity never leaves the
 *     Plyr band).
 *   • Whole-element clamp (Plyr mkTransform): the pill can never clip at the
 *     right/bottom edge — fixes "parts of the watermark are missing".
 *   • Timers are self-rescheduling and cleaned up on unmount/resize; a
 *     container resize (rotation/fullscreen) re-clamps to the new bounds on
 *     the next move, and the first move after resize happens quickly.
 *   • pointerEvents="none" — never intercepts touch on the player controls.
 *
 * ── Fullscreen ──────────────────────────────────────────────────────────────
 *   The fullscreen Modal renders its own instance of this overlay, so the
 *   watermark stays visible in fullscreen exactly as in normal playback
 *   (same identity, same behavior).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, LayoutChangeEvent } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import {
  WATERMARK_SLOTS,
  WATERMARK_GLIDE_MS,
  WATERMARK_MAX_WIDTH_CAP,
  WATERMARK_MAX_WIDTH_FRAC,
  WATERMARK_FONT_PX,
  wmNextSlotIndex,
  wmRandomRotation,
  wmRandomOpacity,
  wmInitialOpacity,
  wmNextMoveDelayMs,
  wmClampPosition,
} from '@/lib/nativeWatermarkConfig';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface NativeWatermarkOverlayProps {
  watermarkId: string;
  watermarkName?: string;
  /** DEV diagnostics: fired whenever the overlay container lays out (geometry
   *  evidence chain — dimensions/state only). Optional; app code never needs it. */
  onContainerLayout?: (e: LayoutChangeEvent) => void;
  /** DEV-ONLY DEBUG PROOF: when true, the pill self-reports its absolute
   *  window rectangle + opacity every 2s via measureInWindow. This is the
   *  REAL view's native geometry — physical proof the watermark is on-screen
   *  and visible without screenshots (which DRM secure surfaces block).
   *  Dimensions/state only — no secrets.
   *
   *  NEVER runs in production: the effect below additionally requires __DEV__,
   *  so a release build schedules no interval and does no measureInWindow work
   *  regardless of what a caller passes. */
  debugProve?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NativeWatermarkOverlay({
  watermarkId,
  watermarkName,
  onContainerLayout,
  debugProve = false,
}: NativeWatermarkOverlayProps) {
  // Reanimated shared values — position is the top-left corner of the pill
  // (Plyr anchors top-left via translate3d from top:0/left:0).
  const posX     = useSharedValue(-200);
  const posY     = useSharedValue(-200);
  const opacity  = useSharedValue(0);
  const rotation = useSharedValue(0);

  // Mutable refs — updated by layout callbacks, read inside timer callbacks.
  const containerWRef = useRef(0);
  const containerHRef = useRef(0);
  const pillWRef      = useRef(0);
  const pillHRef      = useRef(0);
  const slotRef       = useRef(-1);
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef    = useRef(false);

  // Responsive pill cap — Plyr: max-width min(320px, 55%).
  const [maxPillWidth, setMaxPillWidth] = useState(WATERMARK_MAX_WIDTH_CAP);

  // Trigger to start the timers once container dimensions are known.
  const [containerReady, setContainerReady] = useState(false);

  // ── Named animated style — never inline inside JSX ───────────────────────
  const containerStyle = useAnimatedStyle(() => ({
    position: 'absolute' as const,
    left:     posX.value,
    top:      posY.value,
    opacity:  opacity.value,
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  // ── Layout callbacks ──────────────────────────────────────────────────────

  const handleContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width === 0 || height === 0) return;
    const changed =
      Math.abs(width - containerWRef.current) > 1 ||
      Math.abs(height - containerHRef.current) > 1;
    containerWRef.current = width;
    containerHRef.current = height;
    // Responsive pill cap — Plyr max-width formula.
    setMaxPillWidth(Math.min(width * WATERMARK_MAX_WIDTH_FRAC, WATERMARK_MAX_WIDTH_CAP));
    if (!containerReady) setContainerReady(true);
    else if (changed) scheduleMoveRef.current?.(0); // resize → re-clamp quickly
  }, [containerReady]);

  const handlePillLayout = useCallback((e: LayoutChangeEvent) => {
    pillWRef.current = e.nativeEvent.layout.width;
    pillHRef.current = e.nativeEvent.layout.height;
  }, []);

  // ── Move — Plyr `move()`: glide to the next slot, stay visible ────────────
  const move = useCallback((delayMs = 0) => {
    const cW = containerWRef.current;
    const cH = containerHRef.current;
    if (cW <= 0 || cH <= 0) return;

    slotRef.current = wmNextSlotIndex(slotRef.current);
    const slot = WATERMARK_SLOTS[slotRef.current];
    const clamped = wmClampPosition(slot, cW, cH, Math.max(pillWRef.current, 1), Math.max(pillHRef.current, 1));

    const start = () => {
      posX.value = withTiming(clamped.x, { duration: WATERMARK_GLIDE_MS, easing: Easing.ease });
      posY.value = withTiming(clamped.y, { duration: WATERMARK_GLIDE_MS, easing: Easing.ease });
      rotation.value = withTiming(wmRandomRotation(), { duration: WATERMARK_GLIDE_MS, easing: Easing.ease });
      opacity.value = withTiming(wmRandomOpacity(), { duration: WATERMARK_GLIDE_MS, easing: Easing.ease });
    };
    if (delayMs > 0) timerRef.current = setTimeout(start, delayMs);
    else start();
  }, [posX, posY, opacity, rotation]);

  // Late-bound ref so the layout callback can trigger a fast move after resize.
  const scheduleMoveRef = useRef<((delayMs?: number) => void) | null>(null);

  // Ref to the pill itself for the visibility self-proof (real host view).
  const pillRef = useRef<Animated.View | null>(null);

  // ── DEV-ONLY DEBUG PROOF — self-reporting visibility (no screenshots) ─────
  // Every 2s the pill measures itself in WINDOW coordinates and reports its
  // real on-screen rect + current opacity. A 'vis=yes' line is direct native
  // evidence: the watermark view exists in the window at a non-zero rect
  // within the Plyr opacity band — i.e. it is physically visible on screen.
  //
  // PRODUCTION GUARD: __DEV__ is statically false in release bundles, so this
  // effect bails before creating the interval — no timer, no measureInWindow,
  // no overhead — even if a caller passes debugProve={true}.
  useEffect(() => {
    if (!debugProve || !__DEV__) return;
    const id = setInterval(() => {
      const o = opacity.value;
      const pill = pillRef.current;
      const measure = (pill as unknown as { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null)?.measureInWindow;
      if (typeof measure !== 'function') {
        console.log('[VDO_WM_PROVE] vis=NO reason=measure-unavailable');
        return;
      }
      measure.call(pill, (x: number, y: number, w: number, h: number) => {
        const visible = w > 0 && h > 0 && o >= 0.3; // Plyr band floor ~0.38
        console.log(`[VDO_WM_PROVE] vis=${visible ? 'yes' : 'NO'} px=${Math.round(x)},${Math.round(y)} pw=${Math.round(w)}x${Math.round(h)} opacity=${o.toFixed(2)}`);
      });
    }, 2000);
    return () => clearInterval(id);
  }, [debugProve, opacity]);

  // ── Timer effect (Plyr scheduleTick) ──────────────────────────────────────
  useEffect(() => {
    if (!containerReady) return;
    if (containerWRef.current <= 0 || containerHRef.current <= 0) return;
    if (mountedRef.current) return; // schedule exactly once per mount
    mountedRef.current = true;

    // Initial position: random slot, clamped, then fade IN to the Plyr band
    // (Plyr mounts at opacity:0 and transitions to 0.40–0.56 on the first rAF).
    slotRef.current = wmNextSlotIndex(-1);
    const slot = WATERMARK_SLOTS[slotRef.current];
    const clamped = wmClampPosition(slot, containerWRef.current, containerHRef.current, Math.max(pillWRef.current, 1), Math.max(pillHRef.current, 1));
    posX.value = clamped.x;
    posY.value = clamped.y;
    rotation.value = wmRandomRotation();
    opacity.value = withTiming(wmInitialOpacity(), { duration: WATERMARK_GLIDE_MS, easing: Easing.ease });

    const tick = () => {
      timerRef.current = setTimeout(() => {
        move();
        tick();
      }, wmNextMoveDelayMs());
    };
    tick();

    return () => {
      if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
      mountedRef.current = false;
    };
  }, [containerReady, move, posX, posY, opacity, rotation]);

  scheduleMoveRef.current = move;

  // ── Render ────────────────────────────────────────────────────────────────
  // Single-line watermark: "NAME • ID" or "ID" — Plyr's U+2022 format.
  const label = watermarkName ? `${watermarkName} • ${watermarkId}` : watermarkId;

  return (
    <View
      style={styles.overlay}
      pointerEvents="none"
      onLayout={(e) => {
        handleContainerLayout(e);
        onContainerLayout?.(e);
      }}
    >
      <Animated.View
        ref={pillRef}
        style={[containerStyle, { maxWidth: maxPillWidth }]}
        onLayout={handlePillLayout}
      >
        <Text style={styles.wmText} numberOfLines={1} ellipsizeMode="tail">
          {label}
        </Text>
      </Animated.View>
    </View>
  );
}

// ─── Static styles — Plyr typography (playerScript.ts buildEl) ────────────────
//   color #fff · WATERMARK_FONT_PX (15px) · weight 600 · letterSpacing 0.3 ·
//   single line ellipsis · two-layer text shadow · no background (text floats
//   over video). Size comes from nativeWatermarkConfig — the canonical source.

const styles = {
  overlay: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 10,
  },
  wmText: {
    color:           '#fff',
    // Canonical size from nativeWatermarkConfig (Plyr 13px → 15px for
    // readability). Do NOT hardcode here — the config is the single source.
    fontSize:        WATERMARK_FONT_PX,
    fontWeight:     '600' as const,
    letterSpacing:   0.3,
    textShadowColor:  'rgba(0,0,0,0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius:  4,
  },
} as const;
