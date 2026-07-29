/**
 * ForensicWatermarkOverlay.tsx
 *
 * Web-only React Native overlay above the VdoCipher <iframe>.
 * Native (Android/iOS) uses DOM injection inside the WebView instead —
 * see buildWatermarkInjection() in src/lib/watermarkInjection.ts.
 *
 * Strategy:
 *   - 15 safe positions distributed across the video, ≥16% margin from edges.
 *   - Shuffled randomly at mount; reshuffled every full cycle (no repeats).
 *   - Every 20–30 s: fade + translateY micro-slide to next position.
 *   - Opacity target: 0.28–0.35 (premium forensic, unobtrusive).
 *   - Security pulse: every 3–5 min, snap to center for 3–5 s.
 *   - All animation runs on the Reanimated UI thread (zero React re-renders).
 *   - pointerEvents="none" — never intercepts touch/click on the player.
 *   - Timer cleaned up on unmount (no leaks).
 *
 * Rules of Hooks compliance:
 *   - ALL hooks are called unconditionally at the top of the component.
 *   - No hook appears after a conditional return.
 *
 * Watermark format: "NAME • WM-NNNN" on a single line.
 */

import { useEffect, useRef, useCallback } from 'react';
import { View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSequence,
  Easing,
} from 'react-native-reanimated';

// ─── Position grid ─────────────────────────────────────────────────────────────
// Values are fractions of container dimensions (0.0–1.0).
// All positions keep ≥16% clearance from every edge.
// The horizontal right/center grid maps 'col' to the LEFT anchor of the element;
// left-anchored and right-anchored positions use the same coordinate space
// (left = fraction from left edge) — no special-casing needed.

interface WMPosition {
  top:  number; // fraction of containerHeight
  left: number; // fraction of containerWidth
}

const POSITIONS: WMPosition[] = [
  // Left column — all top values ≤ 0.75 to stay above bottom control bar (≥15% clearance)
  { top: 0.16, left: 0.16 },  //  0 Top-Left
  { top: 0.26, left: 0.22 },  //  1 Upper-Left Quarter
  { top: 0.33, left: 0.16 },  //  2 Left-Third
  { top: 0.43, left: 0.16 },  //  3 Center-Left
  { top: 0.57, left: 0.22 },  //  4 Lower-Left Quarter
  { top: 0.72, left: 0.16 },  //  5 Bottom-Left  (was 0.75 — raised to avoid controls)
  // Center column
  { top: 0.16, left: 0.40 },  //  6 Top-Center
  { top: 0.43, left: 0.40 },  //  7 Center
  { top: 0.72, left: 0.40 },  //  8 Bottom-Center (was 0.75 — raised to avoid controls)
  // Right column (leaves ≥28% for text + right margin)
  { top: 0.16, left: 0.60 },  //  9 Top-Right
  { top: 0.26, left: 0.56 },  // 10 Upper-Right Quarter
  { top: 0.33, left: 0.60 },  // 11 Right-Third
  { top: 0.43, left: 0.60 },  // 12 Center-Right
  { top: 0.57, left: 0.56 },  // 13 Lower-Right Quarter
  { top: 0.72, left: 0.60 },  // 14 Bottom-Right (was 0.75 — raised to avoid controls)
];

const CENTER_POS: WMPosition = { top: 0.43, left: 0.40 };
const N_POSITIONS = POSITIONS.length;

function rand(min: number, max: number)    { return min + Math.random() * (max - min); }
function randInt(min: number, max: number) { return Math.floor(rand(min, max + 1)); }

function fisherYates(arr: WMPosition[]): WMPosition[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface ForensicWatermarkOverlayProps {
  watermarkId:     string;
  watermarkName?:  string;
  containerWidth:  number;
  containerHeight: number;
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function ForensicWatermarkOverlay({
  watermarkId,
  watermarkName,
  containerWidth,
  containerHeight,
}: ForensicWatermarkOverlayProps) {
  // ── ALL hooks declared unconditionally ────────────────────────────────────────
  const posTop   = useSharedValue(POSITIONS[0].top  * Math.max(containerHeight, 1));
  const posLeft  = useSharedValue(POSITIONS[0].left * Math.max(containerWidth,  1));
  const opacity  = useSharedValue(0);
  // translateY drives the micro-slide entrance/exit animation
  const slideY   = useSharedValue(7);

  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const secTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shuffledRef = useRef<WMPosition[]>(fisherYates(POSITIONS));
  const idxRef      = useRef(0);
  const inSecRef    = useRef(false);

  // ── Named animated styles ─────────────────────────────────────────────────────
  const containerStyle = useAnimatedStyle(() => ({
    position: 'absolute',
    top:      posTop.value,
    left:     posLeft.value,
    opacity:  opacity.value,
    transform: [{ translateY: slideY.value }],
  }));

  // ── Animation helper ──────────────────────────────────────────────────────────
  const moveTo = useCallback((pos: WMPosition, targetOpacity: number, totalMs: number) => {
    const exitMs  = Math.round(totalMs * 0.45);
    const enterMs = totalMs - exitMs;
    const exitCfg  = { duration: exitMs,  easing: Easing.out(Easing.quad) };
    const enterCfg = { duration: enterMs, easing: Easing.out(Easing.cubic) };

    // Phase 1: fade-out + slide-up
    opacity.value = withTiming(0, exitCfg);
    slideY.value  = withTiming(-7, exitCfg);

    // Phase 2 & 3: after exit completes, teleport + slide-down + fade-in
    setTimeout(() => {
      posTop.value  = pos.top  * containerHeight;
      posLeft.value = pos.left * containerWidth;
      slideY.value  = 7;                         // instant reset (no transition)
      opacity.value = withSequence(
        withTiming(0,             { duration: 0 }),
        withTiming(targetOpacity, { duration: enterMs, easing: Easing.out(Easing.cubic) }),
      );
      slideY.value = withTiming(0, { duration: enterMs, easing: Easing.bezier(0.22, 1, 0.36, 1) });
    }, exitMs + 16);
  }, [containerWidth, containerHeight, posTop, posLeft, opacity, slideY]);

  // ── Next-position picker ───────────────────────────────────────────────────────
  const nextPos = useCallback((): WMPosition => {
    idxRef.current++;
    if (idxRef.current >= N_POSITIONS) {
      shuffledRef.current = fisherYates(POSITIONS);
      idxRef.current = 0;
    }
    return shuffledRef.current[idxRef.current];
  }, []);

  // ── Movement scheduler ────────────────────────────────────────────────────────
  const scheduleMove = useCallback(() => {
    timerRef.current = setTimeout(() => {
      if (!inSecRef.current) {
        moveTo(nextPos(), rand(0.28, 0.35), randInt(400, 700));
      }
      scheduleMove();
    }, randInt(20_000, 30_000));
  }, [moveTo, nextPos]);

  // ── Security pulse ─────────────────────────────────────────────────────────────
  // Every 3–5 min: watermark moves to center for 3–5 s.
  const scheduleSecurityPulse = useCallback(() => {
    secTimerRef.current = setTimeout(() => {
      inSecRef.current = true;
      const moveDur = randInt(400, 600);
      moveTo(CENTER_POS, 0.38, moveDur);

      const holdMs = randInt(3_000, 5_000);
      setTimeout(() => {
        moveTo(nextPos(), rand(0.28, 0.35), randInt(400, 600));
        inSecRef.current = false;
        scheduleSecurityPulse();
      }, holdMs + moveDur + 32);
    }, randInt(3 * 60_000, 5 * 60_000));
  }, [moveTo, nextPos]);

  // ── Effect: start / restart when dimensions change ───────────────────────────
  useEffect(() => {
    if (containerWidth <= 0 || containerHeight <= 0) return;

    // Reset shuffle
    shuffledRef.current = fisherYates(POSITIONS);
    idxRef.current = 0;

    const initPos = shuffledRef.current[0];
    posTop.value  = initPos.top  * containerHeight;
    posLeft.value = initPos.left * containerWidth;
    slideY.value  = 7;

    // Initial fade-in after short delay
    const initTimer = setTimeout(() => {
      const initDur = randInt(400, 600);
      opacity.value = withTiming(rand(0.28, 0.35), {
        duration: initDur,
        easing: Easing.out(Easing.cubic),
      });
      slideY.value = withTiming(0, {
        duration: initDur,
        easing: Easing.bezier(0.22, 1, 0.36, 1),
      });
    }, 250);

    scheduleMove();
    scheduleSecurityPulse();

    return () => {
      clearTimeout(initTimer);
      if (timerRef.current    !== null) clearTimeout(timerRef.current);
      if (secTimerRef.current !== null) clearTimeout(secTimerRef.current);
      timerRef.current    = null;
      secTimerRef.current = null;
    };
  }, [containerWidth, containerHeight]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Conditional render AFTER all hooks ───────────────────────────────────────
  if (process.env.EXPO_OS !== 'web') return null;
  if (containerWidth <= 0 || containerHeight <= 0) return null;

  // Build single-line label: "NAME • WM-NNNN" or just "WM-NNNN"
  const label = watermarkName ? `${watermarkName} • ${watermarkId}` : watermarkId;

  return (
    <View
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 }}
      pointerEvents="none"
    >
      <Animated.View style={[containerStyle, { maxWidth: Math.min(340, containerWidth * 0.70) }]}>
        <Animated.Text style={wmTextStyle} numberOfLines={1}>
          {label}
        </Animated.Text>
      </Animated.View>
    </View>
  );
}

// ─── Static text styles ──────────────────────────────────────────────────────────
// Single-line forensic watermark: "NAME • WM-NNNN"
// Soft off-white (#F2F4F7) with strong text-shadow for readability on any scene.
// Medium weight + slight letter-spacing — premium streaming platform feel.

const wmTextStyle = {
  color:         '#F2F4F7',
  fontSize:       15,
  fontWeight:    '500' as const,
  letterSpacing:  0.6,
  textShadowColor:  'rgba(0,0,0,0.85)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 5,
} as const;
