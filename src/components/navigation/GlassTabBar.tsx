/**
 * GlassTabBar — the floating "liquid glass" bottom navigation.
 *
 * Platform scope: mounted on ANDROID and on WEB (see RoleTabShell.android.tsx
 * and RoleTabShell.tsx). Web Preview renders THIS component — same constants,
 * same geometry, same PanResponder, same shared indicator — so the pill can be
 * reviewed and refined without a native build. iOS keeps its native SwiftUI tab
 * bar / system Liquid Glass (RoleTabShell.ios.tsx) — untouched.
 *
 * BLUR: native uses expo-blur’s Android method (`dimezisBlurViewSdk31Plus`,
 * real blur on API 31+). On web there is no native blur view, so the very same
 * BlurView is used with its browser implementation — `backdrop-filter:
 * saturate(180%) blur(Npx)` — which is the browser-native equivalent of the
 * Android frosted surface. Nothing is mocked and no opaque flat background
 * replaces the glass.
 *
 * DESIGN
 *   • Floating pill inset from both edges and sitting above the system
 *     navigation area by exactly `insets.bottom` (gesture bar and 3-button nav
 *     both report through the safe-area provider — neither is guessed).
 *   • Frosted glass: expo-blur `BlurView` behind a translucent tint layer, a
 *     hairline highlight border and a soft shadow. Android blur is requested
 *     with `dimezisBlurViewSdk31Plus`, i.e. real blur only where the OS can do
 *     it reliably (API 31+); older devices keep the tint + highlight, which is
 *     still a convincing glass surface — never a fully transparent bar.
 *   • ONE shared indicator: a single bubble behind the tabs that travels to the
 *     selected tab. No per-tab pill. It stretches along its axis while moving
 *     and relaxes on arrival.
 *
 * ANIMATION TECH
 *   React Native's built-in `Animated` + `PanResponder` — no extra dependency.
 *   `translateX`/`scaleX` are JS-driven on purpose: the finger writes the real
 *   number into them during a drag, and a value cannot be handed to the native
 *   driver and also be written from JS. Everything that is purely decorative
 *   (indicator opacity, keyboard drop, per-icon lift) stays on
 *   `useNativeDriver: true`. Width is measured, not animated: equally-flexed
 *   tabs share one width, so a tab change only ever moves the bubble.
 *
 * DIRECT MANIPULATION
 *   The bubble is grabbable. Press it, drag horizontally, release: it follows
 *   the finger continuously across the whole bar and snaps to the nearest tab,
 *   which is then activated. Taps, long-presses and scrolling are untouched —
 *   see the gesture rules at the PanResponder below.
 *
 * STATE SOURCE OF TRUTH
 *   No local navigation state. The active tab is `state.index` from React
 *   Navigation — the same value Expo Router updates for taps, back, deep links
  *     and programmatic navigation. Positions come from the ROW's measured width
 *   and the tab count (the tabs are `flex: 1`), so RTL, tablets, split screen
 *   and orientation changes are derived exactly rather than assumed, any tab
 *   count works, and a single mis-measured tab cannot displace the bubble.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Platform, Keyboard, useColorScheme, Animated, useWindowDimensions,
  PanResponder,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { markEntryIntent } from '@/lib/navigation/navIntent';
import { useTranslation } from '@/lib/i18n';
import { neuColors } from '@/lib/neu';

const BAR_HEIGHT = 62;
const FLOAT_GAP = 10;
const SIDE_INSET = 14;
const INDICATOR_INSET = 6;
const INDICATOR_HEIGHT = 46;
const ICON_SIZE = 21;
// Horizontal travel (px) before a touch on the bubble turns from a press into a
// drag. Small enough to feel immediate, large enough that a tap never slides.
const DRAG_THRESHOLD = 4;
// Forgiveness (px) around the bubble's measured rect when grabbing it — a
// finger is not a pixel. Nothing outside the rect is ever claimed.
const GRAB_SLOP = 10;

interface Props {
  state: any;
  descriptors: any;
  navigation: any;
  activeTintColor?: string;
  inactiveTintColor?: string;
  labelStyle?: any;
  /** Signature parity with ResponsiveTabBar; the glass bar owns its surface. */
  style?: any;
}

export default function GlassTabBar({
  state,
  descriptors,
  navigation,
  activeTintColor,
  inactiveTintColor,
  labelStyle,
}: Props) {
  const insets = useSafeAreaInsets();
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { isRTL } = useTranslation();

  const activeTint = activeTintColor ?? c.primary;
  const inactiveTint = inactiveTintColor ?? (isDark ? c.textMuted : `${c.text}44`);

  const { routes, index: activeIndex } = state;

  /* ── Visible routes — same rule as ResponsiveTabBar: drawer-only screens are
   * hidden through `href: null` / a `tabBarButton` that renders nothing, and
   * must not take space or skew the indicator arithmetic. */
  const visibleRoutes = useMemo(() => {
    const out: Array<{ route: any; descriptor: any; routeIndex: number }> = [];
    routes.forEach((route: any, routeIndex: number) => {
      const descriptor = descriptors[route.key];
      if (!descriptor) return;
      const options = descriptor.options ?? {};
      if (options.href === null || (route as any).href === null) return;
      if (typeof options.tabBarButton === 'function') return;
      out.push({ route, descriptor, routeIndex });
    });
    return out;
  }, [routes, descriptors]);

  const activeVisible = visibleRoutes.findIndex((entry) => entry.routeIndex === activeIndex);

  /* ── Indicator geometry — DERIVED, never measured per tab ────────────────
   *
   * ROOT CAUSE (proven on the tablet, Samsung SM-T505N / Android 12):
   *   • the tab ICONS and LABELS followed the route correctly, while the bubble
   *     was ABSENT on Home, Explore and My Materials and sat under Home while
   *     Profile was open. Correct route + wrong/absent bubble splits the two
   *     inputs apart: the route was fine, the bubble's OWN geometry was not;
   *   • that geometry came from each tab's `onLayout` (x/width) plus an animated
   *     opacity (`fade`). In this RTL row a tab can report width 0 (or a
   *     mirrored x) during the first layout pass, and the value was then kept:
   *     a 0-width bubble paints nothing, and a stale x parks it on the previous
   *     tab. Because visibility lived in an Animated value that only an effect
   *     could raise, a skipped run left it at 0 — invisible while still there.
   *
   * The tabs are `flex: 1` on one row, so their geometry is EXACT arithmetic:
   *     tabWidth = rowWidth / tabCount
   *     x(i)     = isRTL ? rowWidth - (i + 1) * tabWidth : i * tabWidth
   * `rowWidth` is ONE measurement of the row itself (window width as the
   * pre-layout fallback), so a per-tab measurement can never be zero, stale or
   * mirrored — and the bubble is placed from the SAME index the icon tint is
   * derived from, so route and position cannot disagree.
   */
  const translateX = useRef(new Animated.Value(0)).current;
  const stretch = useRef(new Animated.Value(1)).current;
  /** The x the bubble last landed on (animation bookkeeping only). */
  const lastTarget = useRef<number | null>(null);

  /* ── Drag state. Refs, never state: a finger moving across the bar must not
   * re-render the component on every frame. */
  const liveX = useRef(0);                 // JS mirror of translateX (hit-testing)
  const dragging = useRef(false);          // true between gesture grant and release
  const dragOriginX = useRef(0);           // indicator x when the finger took it
  const dragStartDx = useRef(0);           // gestureState.dx at grant (removes the threshold jump)
  const touchStart = useRef({ x: 0, y: 0, known: false }); // where the finger landed (page coords)
  const pillRef = useRef<View>(null);      // measured in window → page coordinates
  const pillRect = useRef({ x: 0, y: 0, width: 0, height: 0, known: false });
  const targetsRef = useRef<number[]>([]);         // resting x of every visible tab
  const rowWidthRef = useRef(0);
  const indicatorWidthRef = useRef(0);
  const tabsInfoRef = useRef<Array<{ key: string; routeIndex: number; name: string }>>([]);
  const activeVisibleRef = useRef(0);
  const pressRef = useRef<(key: string, routeIndex: number, name: string) => void>(() => {});

  // Mirror the indicator position into a ref for hit-testing. This never sets
  // state, so it costs nothing per frame.
  useEffect(() => {
    const id = translateX.addListener(({ value }) => { liveX.current = value; });
    return () => translateX.removeListener(id);
  }, [translateX]);

  /* Row width: ONE measurement of the row itself, mirrored for RTL, with the
   * window width as the pre-layout fallback. The tabs are `flex: 1`, so the
   * tab width derived from it is exact — no per-tab measurement is needed. */
  const [rowWidth, setRowWidth] = useState(0);
  const { width: windowWidth } = useWindowDimensions();
  const derivedRowWidth = Math.max(windowWidth - SIDE_INSET * 2 - 2, 0);
  const effectiveRowWidth = rowWidth > 0 ? rowWidth : derivedRowWidth;
  const tabCount = visibleRoutes.length;
  const tabWidth = tabCount > 0 ? effectiveRowWidth / tabCount : 0;
  const indicatorWidth = Math.max(tabWidth - INDICATOR_INSET * 2, 0);

  /** Physical (left-anchored) x of visible tab `i`. RTL mirrors the order. */
  const tabX = useCallback(
    (i: number) => (isRTL ? effectiveRowWidth - (i + 1) * tabWidth : i * tabWidth),
    [isRTL, effectiveRowWidth, tabWidth],
  );
  /* ── Resting x of EVERY tab, in the same physical (left-anchored) space the
   * animation uses. Used for the grab hit-test and the release snap, so a drag
   * released between two tabs still resolves to the nearer one. */
  const tabTargets = useMemo(
    () => visibleRoutes.map((_, i) => tabX(i) + INDICATOR_INSET),
    [visibleRoutes, tabX],
  );

  /* ── ONE DRIVER PER VIEW (Android crash guard) ──────────────────────────
   * `translateX` and `stretch` are both applied to the SAME Animated.View (the
   * shared indicator pill) and both stay JS-driven, because the finger writes
   * `translateX` straight from touch coordinates during a drag.
   *
   * React Native marks EVERY animated value attached to a view as "native" as
   * soon as ONE animation on that view runs with `useNativeDriver: true`
   * (AnimatedProps.__makeNative → node.__makeNative for each style node), and a
   * JS-driven animation on such a value then throws — fatal on Android:
   *
   *   Error: Attempting to run JS driven animation on animated node that has
   *   been moved to "native" earlier by starting an animation with
   *   `useNativeDriver: true`
   *
   * That crashed the app on launch once. The bubble's opacity is therefore NOT
   * an animated value any more: it is derived from the geometry (see the
   * render), which also removes the failure mode where a skipped effect left
   * the bubble invisible at opacity 0.
   */
  /* ── Route → bubble placement (route identity is the ONLY input) ──────── */
  useEffect(() => {
    // A finger owns the position while dragging; the route-driven animation
    // must not pull the bubble out from under it (re-render, layout change…).
    if (dragging.current) return;
    // Pre-layout: no width yet (first frame, or a zero-width row). Keep the
    // current placement instead of hiding — a measurement is never a reason to
    // remove the navigation affordance.
    if (indicatorWidth <= 0) return;
    // The active route is not one of the visible tabs (a drawer/hub screen
    // rendered inside this navigator): keep the bubble where it is.
    if (activeVisible < 0) return;

    const target = tabX(activeVisible) + INDICATOR_INSET;
    const previous = lastTarget.current;
    // Keep the JS mirror authoritative. It is written HERE (and in settleAt /
    // onPanResponderMove) rather than only by the Animated value listener:
    // on RN Web that listener is not guaranteed to fire for every driven value,
    // and a stale 0 makes a drag start from the left edge.
    liveX.current = target;

    if (previous === null || Math.abs(previous - target) < 0.5) {
      // First placement (or pure geometry change: rotation, RTL flip, split
      // screen, font scale): land exactly instead of sliding from nowhere.
      translateX.setValue(target);
      lastTarget.current = target;
      return;
    }

    const movingRight = target > previous;
    lastTarget.current = target;

    // Travel + deformation: the bubble stretches along its axis as it moves and
    // relaxes on arrival, so the eye reads one travelling droplet.
    Animated.parallel([
      Animated.spring(translateX, {
        toValue: target,
        damping: 19,
        stiffness: 190,
        mass: 0.85,
        // JS driver: the drag writes this exact value from touch coordinates.
        useNativeDriver: false,
      }),
      Animated.sequence([
        Animated.timing(stretch, {
          toValue: movingRight ? 1.1 : -1.1,
          duration: 130,
          useNativeDriver: false,
        }),
        Animated.spring(stretch, { toValue: 1, damping: 14, stiffness: 170, useNativeDriver: false }),
      ]),
    ]).start(() => {
      // Convergence guarantee: whatever the frames did (an interrupted spring, a
      // re-render that snapped it, a dropped frame), end EXACTLY on the tab.
      translateX.setValue(target);
      stretch.setValue(1);
    });
  }, [activeVisible, indicatorWidth, tabX, translateX, stretch]);

  /* ── Keyboard: the pill drops out of the way, then returns. Two listeners,
   * no polling, no render loop. */
  const keyboardOffset = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      Animated.timing(keyboardOffset, {
        toValue: BAR_HEIGHT + FLOAT_GAP + insets.bottom,
        duration: 180,
        useNativeDriver: true,
      }).start();
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      Animated.timing(keyboardOffset, { toValue: 0, duration: 180, useNativeDriver: true }).start();
    });
    return () => { show.remove(); hide.remove(); };
  }, [keyboardOffset, insets.bottom]);

  /* ── Navigation — identical contract to ResponsiveTabBar: emit tabPress (a
   * guarded screen can prevent it), mark the entry intent, navigate by route
   * NAME. No local selection state is written. */
  const handlePress = useCallback(
    (routeKey: string, routeIndex: number, routeName: string) => {
      const event = navigation.emit({ type: 'tabPress', target: routeKey, canPreventDefault: true });
      if (activeIndex !== routeIndex && !event.defaultPrevented) {
        markEntryIntent('/' + routeName, 'main');
        navigation.navigate(routeName);
      }
    },
    [navigation, activeIndex],
  );

  /* ── DIRECT MANIPULATION ────────────────────────────────────────────────
   *
   * The bubble itself is grabbable: press it, drag horizontally, release, and
   * the nearest tab activates. Every frame writes the finger's real coordinate
   * into `translateX` — this is direct manipulation, not a replay of button
   * presses.
   *
   * Conflict rules (drag vs tap vs scroll):
   *   • Never claim on touch-down (the capture phase only records the start
   *     point), so a plain tap goes to the Pressable underneath as before.
   *   • Claim only after DRAG_THRESHOLD px of mostly-HORIZONTAL travel, and only
   *     if the touch began on the bubble (hit-tested against the measured pill
   *     rect, in page coordinates). Vertical gestures and touches anywhere else
   *     on the bar are never claimed → scrolling and the Android edge gesture
   *     keep working.
   *   • Claiming terminates the pending press, so a drag cannot also fire the
   *     button it started on.
   *   • Navigation happens ONLY on release, to the nearest tab, and never for
   *     the tab that is already active.
   *   • A cancelled gesture snaps back without navigating.
   */
  useEffect(() => { targetsRef.current = tabTargets; }, [tabTargets]);
  useEffect(() => { rowWidthRef.current = effectiveRowWidth; }, [effectiveRowWidth]);
  useEffect(() => { indicatorWidthRef.current = indicatorWidth; }, [indicatorWidth]);
  useEffect(() => { activeVisibleRef.current = activeVisible; }, [activeVisible]);
  useEffect(() => { pressRef.current = handlePress; }, [handlePress]);
  useEffect(() => {
    tabsInfoRef.current = visibleRoutes.map((entry) => ({
      key: entry.route.key,
      routeIndex: entry.routeIndex,
      name: entry.route.name,
    }));
  }, [visibleRoutes]);

  const measurePill = useCallback(() => {
    // Page coordinates, so the captured touch point can be converted into the
    // pill's own left-anchored space. Re-measured on every layout: rotation,
    // split screen and font-scale changes all land here.
    pillRef.current?.measureInWindow((x, y, width, height) => {
      pillRect.current = { x, y, width, height, known: width > 0 && height > 0 };
    });
  }, []);

  /** Animate to a resting position and remember it as the settled target. */
  const settleAt = useCallback((toX: number) => {
    lastTarget.current = toX;
    liveX.current = toX;
    Animated.parallel([
      Animated.spring(translateX, {
        toValue: toX, damping: 19, stiffness: 190, mass: 0.85, useNativeDriver: false,
      }),
      Animated.spring(stretch, { toValue: 1, damping: 14, stiffness: 170, useNativeDriver: false }),
    ]).start();
  }, [translateX, stretch]);

  /** Release: snap to the nearest valid tab and activate it. */
  const finishDrag = useCallback((dx: number) => {
    dragging.current = false;
    const targets = targetsRef.current;
    const maxX = Math.max(rowWidthRef.current - indicatorWidthRef.current, 0);
    const landed = Math.min(Math.max(dragOriginX.current + dx, 0), maxX);

    if (targets.length === 0) {
      // No tabs to bind to (layout not ready) — settle where it was dropped.
      settleAt(landed);
      return;
    }

    // Nearest tab by final position. Released outside the valid area (past
    // either end) the clamp above already makes the nearest end win.
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    targets.forEach((tabX, i) => {
      const distance = Math.abs(tabX - landed);
      if (distance < best) {
        best = distance;
        nearest = i;
      }
    });

    settleAt(targets[nearest]);

    // Dropped on the tab that is already active → nothing to navigate to (and
    // no tabPress, which could scroll a list the user did not ask to touch).
    if (nearest === activeVisibleRef.current) return;

    const info = tabsInfoRef.current[nearest];
    if (info) pressRef.current(info.key, info.routeIndex, info.name);
  }, [settleAt]);

  /** Gesture cancelled by the system: return to the active tab, do not navigate. */
  const cancelDrag = useCallback(() => {
    dragging.current = false;
    const target = targetsRef.current[activeVisibleRef.current];
    settleAt(typeof target === 'number' ? target : liveX.current);
  }, [settleAt]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    // Capture phase only RECORDS where the touch landed, then declines — so the
    // bubble can be hit-tested precisely, and a press still reaches the button.
    // `gestureState.x0` is not used: it is 0 on some platforms/surfaces.
    onStartShouldSetPanResponderCapture: (event) => {
      const { pageX, pageY } = event.nativeEvent;
      const known = Number.isFinite(pageX) && Number.isFinite(pageY);
      touchStart.current = { x: known ? pageX : 0, y: known ? pageY : 0, known };
      return false;
    },
    onMoveShouldSetPanResponderCapture: () => false,

    onMoveShouldSetPanResponder: (_event, gesture) => {
      if (targetsRef.current.length === 0) return false;
      if (Math.abs(gesture.dx) < DRAG_THRESHOLD) return false;
      // Mostly horizontal, or it is a scroll / system gesture — let it go.
      if (Math.abs(gesture.dx) <= Math.abs(gesture.dy) * 1.2) return false;

      const rect = pillRect.current;
      const start = touchStart.current;
      // Geometry not measured yet (first frame) → stay usable rather than dead.
      if (!rect.known || !start.known) return true;

      const touchX = start.x - rect.x; // pill-local, physical, RTL-agnostic
      const bubbleStart = liveX.current;
      const bubbleEnd = bubbleStart + indicatorWidthRef.current;
      return touchX >= bubbleStart - GRAB_SLOP && touchX <= bubbleEnd + GRAB_SLOP;
    },

    onPanResponderGrant: (_event, gesture) => {
      dragging.current = true;
      dragStartDx.current = gesture.dx;
      dragOriginX.current = liveX.current;
      // Nothing may fight the finger: stop an in-flight snap first.
      translateX.stopAnimation((value) => {
        // Two independent readings of the same number — the JS mirror updated
        // by the value listener, and whatever the animation reports. On RN Web
        // `stopAnimation` can report 0 when no animation is in flight, and a 0
        // here makes the bubble jump to the left edge on the first move (or
        // when the value was positioned by `setValue`). Taking the larger of
        // the two can only agree with the real position: both readings are the
        // same position unless one of them failed.
        const reported = Number.isFinite(value) ? Number(value) : 0;
        const current = Math.max(reported, liveX.current, lastTarget.current ?? 0);
        dragOriginX.current = current;
        liveX.current = current;
      });
      stretch.stopAnimation();
    },

    onPanResponderMove: (_event, gesture) => {
      const maxX = Math.max(rowWidthRef.current - indicatorWidthRef.current, 0);
      const delta = gesture.dx - dragStartDx.current;
      const next = Math.min(Math.max(dragOriginX.current + delta, 0), maxX);
      // The finger's actual position, written straight into the indicator.
      translateX.setValue(next);
      liveX.current = next;
      // Subtle velocity stretch, same visual language as the automatic travel.
      stretch.setValue(1 + Math.min(Math.abs(gesture.vx) * 0.006, 0.12));
    },

    onPanResponderRelease: (_event, gesture) => finishDrag(gesture.dx - dragStartDx.current),
    onPanResponderTerminate: () => cancelDrag(),
    // Once grabbed, the drag owns the touch; a scroll view cannot take it back.
    onPanResponderTerminationRequest: () => false,
  }), [cancelDrag, finishDrag, stretch, translateX]);

  const bottomPad = Math.max(insets.bottom, 0) + FLOAT_GAP;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.outer,
        { paddingBottom: bottomPad, transform: [{ translateY: keyboardOffset }] },
      ]}
    >
      <View
        ref={pillRef}
        // Needed on Android so `measureInWindow` reports real bounds.
        collapsable={false}
        {...panResponder.panHandlers}
        onLayout={measurePill}
        style={[
          styles.pill,
          {
            borderColor: isDark ? 'rgba(125,175,225,0.20)' : 'rgba(255,255,255,0.75)',
            backgroundColor: isDark ? 'rgba(11,35,55,0.62)' : 'rgba(232,238,246,0.62)',
            shadowColor: c.shadowDark,
            elevation: isDark ? 16 : 10,
          },
        ]}
      >
        {/* THE glass layer. Native: the platform's real blur view (Android
            method above). Web: expo-blur's web implementation, which applies
            `backdrop-filter: saturate(180%) blur(Npx)` to this element — the
            browser-supported frosted glass, not a mock-up. `blurMethod` is an
            Android-only prop, so it is not passed on web. */}
        <BlurView
          intensity={Platform.OS === 'web' ? (isDark ? 45 : 55) : (isDark ? 55 : 70)}
          tint={isDark ? 'dark' : 'light'}
          {...(Platform.OS === 'web' ? {} : { blurMethod: 'dimezisBlurViewSdk31Plus' as const })}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />

        {/* Tint wash + top highlight: gives the surface a glass body even on
            devices where the OS declines to blur. */}
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: isDark ? 'rgba(9,28,45,0.50)' : 'rgba(255,255,255,0.50)',
              borderTopWidth: 1,
              borderTopColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.9)',
            },
          ]}
        />

        {/* ONE shared indicator, behind every tab. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.indicator,
            {
              width: indicatorWidth,
              backgroundColor: isDark ? 'rgba(125,175,225,0.20)' : `${activeTint}1F`,
              borderColor: isDark ? 'rgba(125,175,225,0.38)' : `${activeTint}40`,
              // Derived, never animated: the bubble is painted exactly when its
              // geometry exists, so a skipped effect can never leave it at 0.
              opacity: indicatorWidth > 0 ? 1 : 0,
              transform: [{ translateX }, { scaleX: stretch }],
            },
          ]}
        />

        <View
          style={[styles.row, { flexDirection: isRTL ? 'row-reverse' : 'row', direction: 'ltr' }]}
          onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
        >
          {visibleRoutes.map(({ route, descriptor, routeIndex }) => {
            const isFocused = routeIndex === activeIndex;
            const options = descriptor.options ?? {};
            const label = options.title ?? route.name;
            const icon = options.tabBarIcon;

            return (
              <Pressable
                key={route.key}
                style={styles.tab}
                onPress={() => handlePress(route.key, routeIndex, route.name)}
                onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
                accessibilityRole="button"
                accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
                accessibilityState={{ selected: isFocused }}
                android_ripple={{ color: `${activeTint}22`, borderless: false, radius: 34 }}
              >
                <TabGlyph focused={isFocused}>
                  {icon ? icon({ focused: isFocused, color: isFocused ? activeTint : inactiveTint, size: ICON_SIZE }) : null}
                </TabGlyph>
                <Text
                  numberOfLines={1}
                  style={[
                    styles.label,
                    labelStyle,
                    { color: isFocused ? activeTint : inactiveTint, fontWeight: isFocused ? '800' : '700' },
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </Animated.View>
  );
}

/** Per-tab icon transition: the new tab lifts, the old one relaxes back. */
function TabGlyph({ focused, children }: { focused: boolean; children: React.ReactNode }) {
  const scale = useRef(new Animated.Value(focused ? 1.08 : 1)).current;
  const opacity = useRef(new Animated.Value(focused ? 1 : 0.82)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: focused ? 1.08 : 1, damping: 15, stiffness: 210, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: focused ? 1 : 0.82, duration: 160, useNativeDriver: true }),
    ]).start();
  }, [focused, scale, opacity]);

  return (
    <Animated.View style={[styles.glyph, { opacity, transform: [{ scale }] }]} pointerEvents="none">
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outer: {
    // TRUE OVERLAY. The bar used to sit in the navigator's layout flow, so the
    // region it occupied was painted by the screen's background — that dark
    // band around and below the pill was never content, it was reserved space.
    // Absolute positioning removes the reserved band: the scene fills the whole
    // height, its content scrolls behind and around the pill, and the strip
    // under the pill shows the app content instead of a flat colour.
    //
    // Only the pill takes touches (`box-none` here), so the content left and
    // right of it stays interactive, and the pill itself never covers the
    // Android system navigation area — its bottom inset is `insets.bottom`.
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: SIDE_INSET,
    backgroundColor: 'transparent',
    justifyContent: 'flex-end',
  },
  pill: {
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    borderWidth: 1,
    overflow: 'hidden',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
  },
  indicator: {
    position: 'absolute',
    // Explicit PHYSICAL anchor. Without `left: 0` an absolutely positioned
    // child has no resolved inset and falls back to its static position — which
    // in RTL is the RIGHT edge, putting the bubble off-screen. `left`/`top` are
    // physical in CSS and Yoga, so this anchor is identical in Arabic and
    // English; `translateX` then comes straight from the measured tab x.
    left: 0,
    top: (BAR_HEIGHT - INDICATOR_HEIGHT) / 2,
    height: INDICATOR_HEIGHT,
    borderRadius: INDICATOR_HEIGHT / 2,
    borderWidth: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: BAR_HEIGHT,
  },
  tab: {
    flex: 1,
    minWidth: 0,
    height: BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  glyph: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 9.5,
    letterSpacing: 0.2,
    textAlign: 'center',
    maxWidth: '100%',
  },
});
