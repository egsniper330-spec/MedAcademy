/**
 * NativeWatermarkOverlay.tsx
 *
 * Application-level forensic watermark for BOTH native VdoCipher players
 * (online adapter + offline player).
 *
 * ── THE MOTION ───────────────────────────────────────────────────────────────
 * Continuous BILLIARD-STYLE motion: the pill travels along a real trajectory
 * and reflects off all four boundaries of the actual video viewport, keeping
 * its whole box inside at all times. The physics live in
 * src/lib/watermarkMotion.ts (pure + tested); this file only owns the frame
 * loop and the DOM/measure plumbing.
 *
 * It REPLACES the previous 9-slot / 30–60 s glide (a "teleport with a glide",
 * not motion). Two concrete defects of that implementation are gone:
 *
 *   1. CLIPPING. The old `wmClampPosition` ran on a timer that could fire
 *      before the pill had reported its layout, so it clamped a ~200 px pill
 *      as if it were 1×1 — a right/bottom slot then landed hundreds of pixels
 *      past the right edge, where the container's `overflow: hidden` cut it
 *      off ("watermark partially outside the frame / clipped / text missing").
 *      Now: placement does not start until BOTH the container and the pill have
 *      measured, and every frame is clamped with the measured size.
 *   2. DISAPPEARING. Position was only ever assigned at move time, so a
 *      container resize (rotation/fullscreen) or a transient 0×0 layout left
 *      the pill outside the visible area until the next tick. Now: a bounds
 *      change re-projects the position synchronously in onLayout, and opacity
 *      is drawn ONCE and never leaves the Plyr band — there is no hide gap.
 *
 * ── WHO OWNS WHICH LAYER ─────────────────────────────────────────────────────
 * This component is the APP layer. Whether it renders at all for a session is
 * decided by resolveWatermarkLayers (src/lib/watermarkLayers.ts) — this
 * component is always rendered by its caller when the caller decided the app
 * layer is the one the viewer should see. See that module for the security
 * implications of an app-rendered mark vs VdoCipher's burned-in provider mark.
 *
 * ── Performance / lifecycle ──────────────────────────────────────────────────
 * • Frame loop runs on the UI thread via Reanimated `useFrameCallback` — no JS
 *   thread work, no re-render per frame, no timers to leak.
 * • The loop is armed only once container AND pill have real dimensions, and
 *   stopped on unmount (Reanimated deactivates the callback with the hook), so
 *   no animation survives a player that has closed.
 * • pointerEvents="none" — never intercepts a touch on the player controls.
 * • `useAnimatedStyle` reads the shared values, so the JS thread is idle.
 *
 * A11y: reduced-motion is honoured for app CHROME elsewhere; this mark is a
 * forensic anti-capture control, so it keeps moving deliberately.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, LayoutChangeEvent } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useFrameCallback,
} from 'react-native-reanimated';
import {
  WATERMARK_MAX_WIDTH_CAP,
  WATERMARK_MAX_WIDTH_FRAC,
  WATERMARK_FONT_PX,
  WATERMARK_FONT_FRAC,
  WATERMARK_FONT_MIN_PX,
  WATERMARK_FONT_MAX_PX,
  WATERMARK_NAME_FONT_RATIO,
  wmRandomOpacity,
  wmRandomRotation,
} from '@/lib/nativeWatermarkConfig';
import {
  createWatermarkMotion,
  stepWatermarkMotion,
  resolveWatermarkMotionBounds,
  clampWatermarkMotion,
  isWatermarkMotionInBounds,
  WM_MOTION_MAX_STEP_S,
  type MotionBounds,
  type MotionSize,
  type WatermarkMotionState,
} from '@/lib/watermarkMotion';

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
   *  Dimensions/state only — no secrets, and NEVER a token/OTP/identity.
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
  // Position of the pill's top-left corner, in container px — written on the
  // UI thread by the frame callback, read by the animated style.
  const posX = useSharedValue(0);
  const posY = useSharedValue(0);
  const opacity = useSharedValue(0);
  const rotation = useSharedValue(0);

  // Motion state (x, y, vx, vy) — shared so the UI-thread frame loop owns it.
  const motionSV = useSharedValue<WatermarkMotionState | null>(null);

  // Measured geometry. Kept in refs (read by the loop) and mirrored in state
  // only where React must re-render (the responsive pill cap).
  const containerWRef = useRef(0);
  const containerHRef = useRef(0);
  const pillWRef = useRef(0);
  const pillHRef = useRef(0);
  const prevBoundsRef = useRef<MotionBounds>({ width: 0, height: 0 });

  const [maxPillWidth, setMaxPillWidth] = useState(WATERMARK_MAX_WIDTH_CAP);

  // Responsive type, derived from the measured video box: 6.2 % of its smaller
  // dimension, clamped 13–34 px. A phone player therefore reads at ~15–18 px
  // and a fullscreen/full-bleed player grows to 30 px+, instead of the fixed
  // 15 px that stayed tiny when the player expanded.
  const [fontPx, setFontPx] = useState(WATERMARK_FONT_PX);

  const size = (): MotionSize => ({
    width: pillWRef.current > 0 ? pillWRef.current : 1,
    height: pillHRef.current > 0 ? pillHRef.current : 1,
  });

  // ── Start / (re)project the motion ─────────────────────────────────────────
  // Called from layout callbacks, NOT from a timer. It is idempotent: it
  // creates the motion on first measurement and re-projects it on any change.
  const syncMotion = useCallback(() => {
    const cW = containerWRef.current;
    const cH = containerHRef.current;
    // Nothing drawable until the container has real size — never place with a
    // 0×0 container (that is how the mark ends up lost off-screen).
    if (cW <= 0 || cH <= 0) return;
    if (pillWRef.current <= 0 || pillHRef.current <= 0) return;

    const bounds: MotionBounds = { width: cW, height: cH };
    const sz = size();
    const current = motionSV.value;

    if (current === null) {
      const next = createWatermarkMotion(bounds, sz);
      motionSV.value = next;
      posX.value = next.x;
      posY.value = next.y;
      // Plyr parity: one opacity draw and one small static tilt, both set once
      // at placement. There is no fade cycle and no hide gap, so the mark can
      // never "disappear" mid-playback.
      if (opacity.value === 0) opacity.value = wmRandomOpacity();
      rotation.value = wmRandomRotation();
      prevBoundsRef.current = bounds;
      return;
    }

    const resized =
      Math.abs(prevBoundsRef.current.width - cW) > 0.5 ||
      Math.abs(prevBoundsRef.current.height - cH) > 0.5;
    const next = resized
      ? resolveWatermarkMotionBounds(current, prevBoundsRef.current, bounds, sz)
      : clampWatermarkMotion(current, bounds, sz);
    motionSV.value = next;
    posX.value = next.x;
    posY.value = next.y;
    prevBoundsRef.current = bounds;
  }, [motionSV, opacity, posX, posY, rotation]);

  // ── Layout callbacks ──────────────────────────────────────────────────────
  const handleContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width === 0 || height === 0) return; // transient collapse — keep last known
    const prev = prevBoundsRef.current;
    if (Math.abs(width - prev.width) > 0.5 || Math.abs(height - prev.height) > 0.5) {
      setMaxPillWidth(Math.min(width * WATERMARK_MAX_WIDTH_FRAC, WATERMARK_MAX_WIDTH_CAP));
    }
    const nextFont = Math.round(
      Math.max(
        WATERMARK_FONT_MIN_PX,
        Math.min(WATERMARK_FONT_MAX_PX, Math.min(width, height) * WATERMARK_FONT_FRAC),
      ),
    );
    setFontPx((v) => (v === nextFont ? v : nextFont));
    containerWRef.current = width;
    containerHRef.current = height;
    syncMotion();
    onContainerLayout?.(e);
  }, [onContainerLayout, syncMotion]);

  const handlePillLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0) pillWRef.current = width;
    if (height > 0) pillHRef.current = height;
    syncMotion();
  }, [syncMotion]);

  // ── Frame loop (UI thread) ────────────────────────────────────────────────
  // Armed only while there is a real motion state to advance. Reanimated
  // deactivates the callback when the component unmounts, so no loop survives
  // the player closing.
  const frameCallback = useFrameCallback((info) => {
    'worklet';
    const dtMs = info.timeSincePreviousFrame;
    if (dtMs == null || dtMs <= 0) return;
    const m = motionSV.value;
    if (m === null) return;
    const w = containerWRef.current;
    const h = containerHRef.current;
    if (w <= 0 || h <= 0) return;
    const pw = pillWRef.current;
    const ph = pillHRef.current;
    if (pw <= 0 || ph <= 0) return;

    const dt = Math.min(dtMs / 1000, WM_MOTION_MAX_STEP_S);
    const next = stepWatermarkMotion(
      m,
      dt,
      { width: w, height: h },
      { width: pw, height: ph },
    );
    motionSV.value = next;
    posX.value = next.x;
    posY.value = next.y;
  }, false);

  // Activate on mount; Reanimated deactivates with the hook on unmount.
  // The callback itself returns early until both container and pill have real
  // measurements, so "armed" is a guard INSIDE the worklet — no need to
  // re-run an effect to arm it (reading a shared value during render would
  // not re-render the component anyway).
  useEffect(() => {
    frameCallback.setActive(true);
    return () => frameCallback.setActive(false);
  }, [frameCallback]);

  // ── Geometry self-check (DEV only) ────────────────────────────────────────
  // Cheap assertions that the mark is inside the viewport — dimensions only.
  useEffect(() => {
    if (!__DEV__) return;
    const id = setInterval(() => {
      const m = motionSV.value;
      if (!m) return;
      const w = containerWRef.current;
      const h = containerHRef.current;
      if (w <= 0 || h <= 0) return;
      const inBounds = isWatermarkMotionInBounds(m, { width: w, height: h }, size());
      if (!inBounds) {
        // Signals a real bug — surfaced without any identity/token data.
        console.warn(
          `[VDO_WM_GEOMETRY] out-of-bounds x=${Math.round(m.x)} y=${Math.round(m.y)} box=${w.toFixed(0)}x${h.toFixed(0)} pill=${pillWRef.current.toFixed(0)}x${pillHRef.current.toFixed(0)}`
        );
      }
    }, 2000);
    return () => clearInterval(id);
  }, [motionSV]);

  // ── DEV-ONLY visibility self-proof ────────────────────────────────────────
  useEffect(() => {
    if (!debugProve || !__DEV__) return;
    const id = setInterval(() => {
      const pill = pillRef.current;
      const measure = (pill as unknown as { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null)?.measureInWindow;
      if (typeof measure !== 'function') {
        console.log('[VDO_WM_PROVE] vis=NO reason=measure-unavailable');
        return;
      }
      measure.call(pill, (x: number, y: number, w: number, h: number) => {
        const visible = w > 0 && h > 0 && opacity.value >= 0.3;
        console.log(`[VDO_WM_PROVE] vis=${visible ? 'yes' : 'NO'} px=${Math.round(x)},${Math.round(y)} pw=${Math.round(w)}x${Math.round(h)} opacity=${opacity.value.toFixed(2)}`);
      });
    }, 2000);
    return () => clearInterval(id);
  }, [debugProve, opacity]);

  const pillRef = useRef<Animated.View | null>(null);

  const containerStyle = useAnimatedStyle(() => ({
    position: 'absolute' as const,
    left: posX.value,
    top: posY.value,
    opacity: opacity.value,
    transform: [{ rotate: `${rotation.value}deg` }],
  }));


  return (
    <View
      style={styles.overlay}
      pointerEvents="none"
      onLayout={handleContainerLayout}
    >
      <Animated.View
        ref={pillRef}
        style={[containerStyle, { maxWidth: maxPillWidth }]}
        onLayout={handlePillLayout}
      >
        {/* Two lines: display name, then the complete public id underneath.
            The name is its own block with ellipsis, so a very long name can
            never push the id out of view (the old single line truncated the
            id — the "id arrives cut" defect). */}
        {watermarkName ? (
          <Text
            style={[styles.wmText, { fontSize: Math.round(fontPx * WATERMARK_NAME_FONT_RATIO) }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {watermarkName}
          </Text>
        ) : null}
        <Text style={[styles.wmText, styles.wmId, { fontSize: fontPx }]} numberOfLines={1}>
          {watermarkId}
        </Text>
      </Animated.View>
    </View>
  );
}

// ─── Static styles — Plyr typography (playerScript.ts buildEl) ────────────────
//   color #fff · WATERMARK_FONT_PX · weight 600 · letterSpacing 0.3 ·
//   single line ellipsis · two-layer text shadow · no background.
//   Size comes from nativeWatermarkConfig — the canonical source.

const styles = {
  overlay: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 10,
  },
  wmText: {
    color:           '#fff',
    fontSize:        WATERMARK_FONT_PX,
    fontWeight:      '600' as const,
    letterSpacing:   0.3,
    textShadowColor:  'rgba(0,0,0,0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius:  4,
  },
  wmId: {
    fontWeight: '700' as const,
    opacity: 0.95,
  },
} as const;
