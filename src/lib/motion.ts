/**
 * motion.ts — MedAcademy Universal Motion System
 * ────────────────────────────────────────────────
 * Single source of truth for ALL animations in the app.
 * Matches Material Design 3 motion spec + Apple HIG guidelines.
 *
 * Usage:
 *   import { useEntranceAnim, usePressAnim, usePageTransition } from '@/lib/motion';
 *
 *   // Fade+slide entrance on mount
 *   const { style } = useEntranceAnim();
 *   <Animated.View style={style}>...</Animated.View>
 *
 *   // Press scale feedback
 *   const press = usePressAnim();
 *   <Animated.View style={press.style}>
 *     <Pressable onPressIn={press.onPressIn} onPressOut={press.onPressOut}>...</Pressable>
 *   </Animated.View>
 *
 *   // Staggered list entrance
 *   const stagger = useStaggerAnim(items.length);
 *   items.map((item, i) => (
 *     <Animated.View style={stagger.itemStyle(i)}>...</Animated.View>
 *   ))
 *
 * All timing and spring values come from ds.ts animation/easing tokens.
 * Never write raw Animated.timing({ duration: 300 }) in screen files.
 */

import { useRef, useEffect, useMemo } from 'react';
import { Animated } from 'react-native';
import { animation, easing } from '@/lib/ds';

// ─── 1. Entrance animation — fade + slide up ─────────────────────────────────
/**
 * useEntranceAnim — standard screen/card entrance.
 * Element fades in and slides up from `offsetY` dp.
 * Delay: optional ms to stagger multiple elements.
 *
 * @example
 *   const { style } = useEntranceAnim();
 *   <Animated.View style={[cardStyle, style]} />
 */
export function useEntranceAnim(opts?: { delay?: number; offsetY?: number; duration?: number }) {
  const { delay = 0, offsetY = 14, duration = animation.base } = opts ?? {};
  const opacity   = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(offsetY)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration,
        delay,
        easing: easing.decelerate,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: duration + 60,
        delay,
        easing: easing.emphasized,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return {
    style: { opacity, transform: [{ translateY }] },
    opacity,
    translateY,
  };
}

// ─── 2. Staggered list entrance ───────────────────────────────────────────────
/**
 * useStaggerAnim — staggered entrance for list items.
 * Each item enters with a 40ms delay offset after the previous.
 *
 * @example
 *   const stagger = useStaggerAnim(courses.length);
 *   courses.map((c, i) => (
 *     <Animated.View style={stagger.itemStyle(i)}>...</Animated.View>
 *   ))
 */
export function useStaggerAnim(count: number, opts?: { baseDelay?: number; staggerMs?: number; offsetY?: number }) {
  const { baseDelay = 60, staggerMs = 40, offsetY = 12 } = opts ?? {};

  const anims = useRef(
    Array.from({ length: Math.min(count, 20) }, () => ({
      opacity:    new Animated.Value(0),
      translateY: new Animated.Value(offsetY),
    }))
  ).current;

  useEffect(() => {
    if (count === 0) return;
    const animations = anims.slice(0, count).flatMap(({ opacity, translateY }, i) => {
      const delay = baseDelay + i * staggerMs;
      return [
        Animated.timing(opacity, {
          toValue: 1, duration: animation.fast, delay,
          easing: easing.decelerate, useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0, duration: animation.base, delay,
          easing: easing.emphasized, useNativeDriver: true,
        }),
      ];
    });
    Animated.parallel(animations).start();
  }, [count]);

  return {
    itemStyle: (index: number) => {
      const a = anims[index];
      if (!a) return {};
      return { opacity: a.opacity, transform: [{ translateY: a.translateY }] };
    },
  };
}

// ─── 3. Press / scale feedback ───────────────────────────────────────────────
/**
 * usePressAnim — scale feedback on press. Use for cards, buttons, pills.
 * Prefer this over raw Pressable opacity — gives physical neumorphic feel.
 *
 * @example
 *   const press = usePressAnim();
 *   <Animated.View style={[cardStyle, press.style]}>
 *     <Pressable onPressIn={press.onPressIn} onPressOut={press.onPressOut} />
 *   </Animated.View>
 */
export function usePressAnim(opts?: { scaleDown?: number; duration?: number }) {
  const { scaleDown = 0.97, duration = animation.micro } = opts ?? {};
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = () =>
    Animated.spring(scale, {
      toValue: scaleDown,
      ...animation.springSnappy,
    }).start();

  const onPressOut = () =>
    Animated.spring(scale, {
      toValue: 1,
      ...animation.springSnappy,
    }).start();

  return {
    style:      { transform: [{ scale }] },
    onPressIn,
    onPressOut,
    scale,
  };
}

// ─── 4. Fade toggle (show/hide) ───────────────────────────────────────────────
/**
 * useFadeAnim — animate opacity between visible/hidden.
 * Use for toasts, badges, conditional content.
 *
 * @example
 *   const fade = useFadeAnim(isVisible);
 *   <Animated.View style={{ opacity: fade.opacity, ...(fade.hidden && { pointerEvents: 'none' }) }}>
 */
export function useFadeAnim(visible: boolean, opts?: { duration?: number; delay?: number }) {
  const { duration = animation.fast, delay = 0 } = opts ?? {};
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration,
      delay,
      easing: visible ? easing.decelerate : easing.accelerate,
      useNativeDriver: true,
    }).start();
  }, [visible]);

  return { opacity, style: { opacity } };
}

// ─── 5. Slide in from bottom (sheet / modal) ──────────────────────────────────
/**
 * useSlideUpAnim — slide element in from below (bottom sheet, modal, drawer).
 *
 * @example
 *   const slide = useSlideUpAnim(isOpen, 400); // 400 = element height
 *   <Animated.View style={[sheetStyle, slide.style]}>
 */
export function useSlideUpAnim(visible: boolean, height = 300) {
  const translateY = useRef(new Animated.Value(height)).current;
  const opacity    = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          ...animation.springGentle,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: animation.fast,
          easing: easing.decelerate,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: height,
          duration: animation.fast,
          easing: easing.accelerate,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: animation.micro,
          easing: easing.accelerate,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  return {
    style: { opacity, transform: [{ translateY }] },
    opacity,
    translateY,
  };
}

// ─── 6. Loading pulse ─────────────────────────────────────────────────────────
/**
 * usePulseAnim — repeating opacity pulse for skeleton/loading states.
 *
 * @example
 *   const pulse = usePulseAnim();
 *   <Animated.View style={[skeletonStyle, { opacity: pulse.opacity }]} />
 */
export function usePulseAnim(opts?: { minOpacity?: number; maxOpacity?: number; duration?: number }) {
  const { minOpacity = 0.35, maxOpacity = 0.75, duration = animation.slow } = opts ?? {};
  const opacity = useRef(new Animated.Value(maxOpacity)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: minOpacity,
          duration,
          easing: easing.standard,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: maxOpacity,
          duration,
          easing: easing.standard,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return { opacity, style: { opacity } };
}

// ─── 7. Page transition (used in _layout Stack config) ────────────────────────
/**
 * PAGE_TRANSITION_CONFIG — pass to Stack.Screen animation prop.
 * Provides a smooth slide + fade consistent with Material Design 3 push.
 *
 * Usage in _layout.tsx:
 *   <Stack screenOptions={PAGE_TRANSITION_CONFIG} />
 */
export const PAGE_TRANSITION_CONFIG = {
  animation: 'slide_from_right' as const,
  animationDuration: animation.base,
  gestureEnabled: true,
  gestureDirection: 'horizontal' as const,
} as const;

// ─── 8. Success / bounce ─────────────────────────────────────────────────────
/**
 * useSuccessAnim — bouncy scale-up for success checkmarks, badges, counters.
 * Trigger by calling `trigger()`.
 *
 * @example
 *   const success = useSuccessAnim();
 *   useEffect(() => { if (saved) success.trigger(); }, [saved]);
 *   <Animated.View style={success.style}><CheckCircle /></Animated.View>
 */
export function useSuccessAnim() {
  const scale = useRef(new Animated.Value(1)).current;

  const trigger = () => {
    scale.setValue(0.6);
    Animated.spring(scale, {
      toValue: 1,
      ...animation.springBouncy,
    }).start();
  };

  return { style: { transform: [{ scale }] }, trigger, scale };
}

// ─── 9. Number counter ────────────────────────────────────────────────────────
/**
 * useCounterAnim — smoothly animate between two numeric values.
 * Use for stats, badge counts, progress numbers.
 *
 * @example
 *   const counter = useCounterAnim(totalStudents);
 *   // counter.value is an Animated.Value — use interpolation or a listener
 */
export function useCounterAnim(target: number, duration = animation.medium) {
  const value = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(value, {
      toValue: target,
      duration,
      easing: easing.decelerate,
      useNativeDriver: false, // layout prop
    }).start();
  }, [target]);

  return { value };
}

// ─── 10. Scrim overlay ───────────────────────────────────────────────────────
/**
 * useScrimAnim — fade a full-screen overlay in/out for modals and drawers.
 *
 * @example
 *   const scrim = useScrimAnim(drawerOpen);
 *   <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'black', opacity: scrim.opacity }]} />
 */
export function useScrimAnim(visible: boolean) {
  return useFadeAnim(visible, { duration: animation.fast });
}
