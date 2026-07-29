/**
 * NativeWatermarkOverlay.tsx
 *
 * Phase 2 — Application-level forensic watermark for VdoPlayerView.
 *
 * ── Why a separate component from ForensicWatermarkOverlay ──────────────────
 *
 *   ForensicWatermarkOverlay  →  Web only (iframe sibling, CSS z-index works)
 *   NativeWatermarkOverlay    →  Native SDK path (VdoPlayerView sibling View)
 *
 *   With the old WebView player on Android, the Chromium GPU compositor painted
 *   over every sibling RN View regardless of z-index, requiring DOM injection.
 *   VdoPlayerView uses the VdoCipher Android SDK which renders via TextureView
 *   (hardware-accelerated but composited normally), so a standard React Native
 *   View placed after it in the tree renders on top without special treatment.
 *
 * ── VdoCipher server-side watermark ────────────────────────────────────────
 *   This overlay is an ADDITIONAL application-level watermark.
 *   It does not replace VdoCipher's own server-side watermark feature.
 *   enableAutoResume and VdoCipher DRM remain fully intact.
 *
 * ── Fullscreen behaviour ────────────────────────────────────────────────────
 *   When the user taps fullscreen in the native control bar, VdoPlayerView
 *   expands to fill the screen via an Android system window.  The RN overlay
 *   (which lives in the in-app layout) is NOT visible during this system
 *   fullscreen mode — this is a platform constraint.  The overlay reappears
 *   automatically when the user exits fullscreen and the player returns to
 *   the in-app layout.
 *
 * ── Animation strategy ─────────────────────────────────────────────────────
 *   Position (left, top) → Reanimated useSharedValue + withTiming(500 ms)
 *   Runs entirely on the UI thread — zero React re-renders per animation frame.
 *   Timer scheduling and slot selection are pure JS (no render impact).
 *
 * ── Safe area ──────────────────────────────────────────────────────────────
 *   useSafeAreaInsets provides notch / status-bar / home-indicator insets.
 *   All pill positions are clamped so the pill never enters those regions.
 *
 * ── Dimensions ─────────────────────────────────────────────────────────────
 *   Container: measured via onLayout (fills player via position:absolute).
 *   Pill:      measured via onLayout after first render.
 *   Container width is also held in state (maxPillWidth) so the pill's
 *   maxWidth can be expressed as a React style — this is the only extra
 *   re-render and it only fires once after the first layout.
 *
 * ── Overflow strategy ───────────────────────────────────────────────────────
 *   Pill maxWidth: min(containerWidth × 0.7, 320 px).
 *   Name row:      numberOfLines={1} ellipsizeMode="tail" — truncates long names.
 *   ID row:        always rendered in full; shrinking is prevented by the pill
 *                  being wide enough to display the WM-NNNN token.
 *   Both guarantees hold because the ID is shorter than the name in practice.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, LayoutChangeEvent } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ─── Grid ─────────────────────────────────────────────────────────────────────
// 9-slot grid expressed as fractions of container dimensions.
// Each entry is [fracX, fracY] representing the center of the slot.

const GRID: [number, number][] = [
  [0.10, 0.10], // 0  Top-Left
  [0.50, 0.10], // 1  Top-Center
  [0.90, 0.10], // 2  Top-Right
  [0.10, 0.50], // 3  Center-Left
  [0.50, 0.50], // 4  Center
  [0.90, 0.50], // 5  Center-Right
  [0.10, 0.90], // 6  Bottom-Left
  [0.50, 0.90], // 7  Bottom-Center
  [0.90, 0.90], // 8  Bottom-Right
];

const N_SLOTS    = GRID.length;
const MOVE_MS    = 500;
// Increased from 8 → 20 px so the pill never overlaps the NeuCard's
// borderRadius:18 rounded corners, which would clip the text when the
// player container has overflow:'hidden' applied (required for correct
// absolute-child containment in normal / non-fullscreen mode).
const MARGIN_PX  = 20;
const OFFSET_PX  = 12; // ±12 px anti-cropping random offset per move (reduced from 20 to stay within safe zone)

// Reserve the bottom 15% of the player for native controls (VdoCipher control bar).
// The watermark will never enter this zone.
const CONTROLS_RESERVE_FRACTION = 0.15;

// Safe-margin in px from all edges (≥24 px).
const SAFE_MARGIN_PX = 28;

function randomSlot(exclude: number): number {
  let idx: number;
  do { idx = Math.floor(Math.random() * N_SLOTS); } while (idx === exclude);
  return idx;
}

function randomOffset(): number {
  return (Math.random() - 0.5) * OFFSET_PX * 2; // –20 … +20
}

// Cycle: 20–30 s visible (randomised) → 2 s hidden → move to next slot → repeat.
// DWELL_MS is the minimum; actual dwell adds up to +10 000 ms randomly.
const DWELL_MS     = 20_000; // minimum visible duration per position
const DWELL_JITTER = 10_000; // adds 0–10 000 ms randomly per cycle
const HIDE_MS      =  2_000; // hidden duration before reappearing at new slot

// ─── Props ────────────────────────────────────────────────────────────────────

export interface NativeWatermarkOverlayProps {
  watermarkId: string;
  watermarkName?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NativeWatermarkOverlay({
  watermarkId,
  watermarkName,
}: NativeWatermarkOverlayProps) {
  // ── All hooks unconditional (Rules of Hooks) ───────────────────────────────
  const insets = useSafeAreaInsets();

  // Reanimated shared values — position is the top-left corner of the pill.
  // Initial off-screen position; updated after first layout.
  const pillLeft    = useSharedValue(-200);
  const pillTop     = useSharedValue(-200);
  // Opacity drives the hide phase: fade out over FADE_MS, hold dark,
  // teleport to next slot, then fade in. Starts at 0; set to 1 after
  // first moveToSlot() call so the pill appears with a gentle entrance.
  const pillOpacity = useSharedValue(0);

  // Mutable refs — updated by layout callbacks, read inside timer callbacks.
  // Using refs (not state) avoids extra re-renders.
  const containerWRef = useRef(0);
  const containerHRef = useRef(0);
  const pillWRef      = useRef(0);
  const pillHRef      = useRef(0);
  const currentSlot   = useRef(-1);
  const insetsRef     = useRef(insets);
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync insets ref every render (safe area rarely changes but correct by default).
  insetsRef.current = insets;

  // Font size state — single re-render after first container layout.
  const [fontSize, setFontSize] = useState(12);

  // maxPillWidth: responsive cap so the pill never spans too much of the screen.
  // Start at 320 (generous) so the full WM-ID is visible before first layout.
  const [maxPillWidth, setMaxPillWidth] = useState(320);

  // Trigger to start the timer once container dimensions are known.
  const [containerReady, setContainerReady] = useState(false);

  // ── Named animated style — never inline inside JSX ───────────────────────
  const animatedPillStyle = useAnimatedStyle(() => ({
    position: 'absolute' as const,
    left:     pillLeft.value,
    top:      pillTop.value,
    opacity:  pillOpacity.value,
  }));

  // ── Layout callbacks ──────────────────────────────────────────────────────

  const handleContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width === 0 || height === 0) return;
    containerWRef.current = width;
    containerHRef.current = height;
    // Adaptive font size: ~5.5% of container width, clamped 13–16 px.
    setFontSize(Math.max(13, Math.min(16, Math.round(width * 0.055))));
    // Responsive pill cap: 70% of container width, never exceeding 340 px.
    setMaxPillWidth(Math.min(width * 0.7, 340));
    if (!containerReady) setContainerReady(true);
  }, [containerReady]);

  const handlePillLayout = useCallback((e: LayoutChangeEvent) => {
    pillWRef.current = e.nativeEvent.layout.width;
    pillHRef.current = e.nativeEvent.layout.height;
  }, []);

  // ── Movement ──────────────────────────────────────────────────────────────

  // Instantly reposition the pill to a grid slot and fade it in.
  // Called both for the initial placement and after the hide phase completes.
  const moveToSlot = useCallback((slotIdx: number) => {
    const [fracX, fracY] = GRID[slotIdx];
    const cW   = containerWRef.current;
    const cH   = containerHRef.current;
    const pW   = pillWRef.current;
    const pH   = pillHRef.current;
    const ins  = insetsRef.current;

    // Anchor at grid fraction, offset pill by its own half-size to center it,
    // then add a ±12 px random jitter.
    const rawLeft = fracX * cW - pW / 2 + randomOffset();
    const rawTop  = fracY * cH - pH / 2 + randomOffset();

    // Clamp: keep pill fully inside safe area + SAFE_MARGIN_PX (28 px),
    // AND exclude the bottom control-bar zone (bottom 15% of container height).
    const maxBottom = cH * (1 - CONTROLS_RESERVE_FRACTION) - pH - SAFE_MARGIN_PX;
    const clampedLeft = Math.max(
      ins.left + SAFE_MARGIN_PX,
      Math.min(cW - pW - ins.right - SAFE_MARGIN_PX, rawLeft),
    );
    const clampedTop = Math.max(
      ins.top + SAFE_MARGIN_PX,
      Math.min(maxBottom, rawTop),
    );

    // Teleport position instantly (no slide — position change is invisible
    // because the pill is already faded out at this point).
    pillLeft.value = clampedLeft;
    pillTop.value  = clampedTop;

    // Fade in smoothly over MOVE_MS.
    pillOpacity.value = withTiming(0.32, { duration: MOVE_MS, easing: Easing.out(Easing.cubic) });
  }, [pillLeft, pillTop, pillOpacity]);

  // ── Timer effect ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerReady) return;

    // Place overlay at a random initial slot and fade it in immediately.
    const initSlot = Math.floor(Math.random() * N_SLOTS);
    currentSlot.current = initSlot;
    moveToSlot(initSlot);

    // Cycle: wait DWELL_MS + 0–DWELL_JITTER → fade out over MOVE_MS
    //        → wait remaining HIDE_MS → teleport + fade in → repeat.
    const scheduleNext = () => {
      const dwell = DWELL_MS + Math.random() * DWELL_JITTER;
      timerRef.current = setTimeout(() => {
        // Fade out the pill.
        pillOpacity.value = withTiming(0, { duration: MOVE_MS, easing: Easing.in(Easing.cubic) });

        // After fade-out + remaining hide gap, teleport and fade back in.
        const hideTimer = setTimeout(() => {
          const next = randomSlot(currentSlot.current);
          currentSlot.current = next;
          moveToSlot(next);
          scheduleNext();
        }, HIDE_MS);

        timerRef.current = hideTimer;
      }, dwell);
    };
    scheduleNext();

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [containerReady, moveToSlot, pillOpacity]);

  // ── Render ────────────────────────────────────────────────────────────────
  // Single-line watermark: "NAME • WM-NNNN" or "WM-NNNN"
  // Pill opacity is driven by Reanimated (pillOpacity shared value).
  // The pill itself has no background — text-only, no box artefacts.
  const label = watermarkName ? `${watermarkName} • ${watermarkId}` : watermarkId;

  return (
    <View
      style={styles.overlay}
      pointerEvents="none"
      onLayout={handleContainerLayout}
    >
      <Animated.View
        style={[styles.pill, animatedPillStyle, { maxWidth: maxPillWidth }]}
        onLayout={handlePillLayout}
      >
        <Text
          style={[styles.wmText, { fontSize }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {label}
        </Text>
      </Animated.View>
    </View>
  );
}

// ─── Static styles ────────────────────────────────────────────────────────────
//
// Single-line forensic watermark: "NAME • WM-NNNN"
//
// Design decisions:
//   • font: system-ui (iOS: SF Pro, Android: Roboto) — clean modern sans-serif
//   • color: #F2F4F7 — soft off-white, less harsh than pure white
//   • fontWeight '500' (medium) — visible but not aggressive
//   • letterSpacing 0.6 — slight tracking, improves legibility at small sizes
//   • Strong text-shadow: ensures readability on both bright and dark video
//   • Pill: no background — text floats naturally over video content
//   • Opacity 0.32 driven by Reanimated (set in moveToSlot)

const styles = {
  overlay: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 10,
  },
  pill: {
    // No background — pure text watermark, no box artefacts
    paddingHorizontal: 0,
    paddingVertical:   0,
    alignItems: 'flex-start' as const,
  },
  wmText: {
    color:         '#F2F4F7',
    fontWeight:    '500' as const,
    letterSpacing:  0.6,
    textShadowColor:  'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius:  5,
    flexShrink: 0,
  },
} as const;
