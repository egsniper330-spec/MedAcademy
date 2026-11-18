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
  PanResponder, I18nManager,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
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

  /* ── ONE AUTHORITATIVE MAPPING (route → rendered slot → bubble) ───────────
   *
   * ROOT CAUSE of the INTERMITTENT missing / wrong-tab bubble (reproduced on
   * the tablet AND on a second phone):
   *
   *   the bubble mirrored RTL by ARITHMETIC — `rowSpan - (i + 1) * tabWidth` —
   *   while the row itself was mirrored by `flexDirection: 'row-reverse'`.
   *   Two independent mirrorings of the same list MUST agree, and they did not
   *   have to: a reversed order change, a late measurement, or a re-render that
   *   read one of them a frame later maps every index onto the OPPOSITE end of
   *   the bar. That is exactly the reported symptom set (Home under Profile,
   *   Explore under My Courses — the two mirrored pairs).
   *
   *   It also explains the invisible phase: an oversized `rowSpan` (the old
   *   max-of-three-candidates fallback could exceed the real row) mirrors to a
   *   NEGATIVE `left`, which the pill's `overflow:'hidden'` clips away — an
   *   invisible bubble whose drag hit-test still worked.
   *
   * The fix removes the second mirroring entirely: the render list is reversed
   * ONCE, explicitly, and the row is a plain left-to-right row. Slot i is then
   * always at `i * tabWidth`, in both directions, so there is no
   * direction-dependent arithmetic left that can disagree with the layout.
   */
  const orderedRoutes = useMemo(
    () => (isRTL ? [...visibleRoutes].reverse() : visibleRoutes),
    [visibleRoutes, isRTL],
  );
  const activeVisible = orderedRoutes.findIndex((entry) => entry.routeIndex === activeIndex);

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
   *     x(i) = isRTL ? rowSpan - (i + 1) * tabWidth : i * tabWidth
   * What measurement is trusted was established on the device: a TAB's width is
   * reported correctly, while the row's own `onLayout` width comes back as 0 in
   * this RTL configuration (deriving from it left the bubble with no width at
   * all) and a tab's `x` can be stale/mirrored. So the LARGEST measured tab
   * width is the one input, and every position is derived from it. The bubble is
   * then placed from the SAME index the icon tint is derived from, so route and
   * position cannot disagree.
   */
  const [layouts, setLayouts] = useState<Record<string, { width: number }>>({});
  /** The pill's own measured width — the geometry source that is known to work. */
  const [pillWidth, setPillWidth] = useState(0);
  /**
   * The TAB ROW's own measured width — the ONE authoritative span.
   *
   * The tabs are `flex: 1` inside this row, so `tabWidth = rowWidth / count` is
   * exact by construction. It is measured on the row itself (not inferred from
   * the window or the pill) and clamped to the pill, so a stale or oversized
   * value can never push the bubble outside the pill's clip.
   */
  const [rowWidth, setRowWidth] = useState(0);
  /**
   * Layout epoch — STALE-CALLBACK GUARD.
   *
   * Every asynchronous measurement and animation settles against the epoch it
   * started in. A measureInWindow callback that returns after a newer layout
   * pass cannot overwrite fresher geometry, which is what left the bubble offset
   * (or outside the pill) after a rotation / split-screen resize.
   */
  const layoutEpoch = useRef(0);
  const onRowLayout = useCallback((width: number) => {
    layoutEpoch.current += 1;
    if (!Number.isFinite(width) || width <= 0) return;
    setRowWidth((prev) => (Math.abs(prev - width) < 0.5 ? prev : width));
  }, []);
  const onTabLayout = useCallback((key: string, width: number) => {
    if (!Number.isFinite(width)) return;
    setLayouts((prev) => {
      const current = prev[key];
      if (current && Math.abs(current.width - width) < 0.5) return prev;
      return { ...prev, [key]: { width } };
    });
  }, []);
  /**
   * Indicator position — applied as a LAYOUT `left`, not a transform.
   *
   * ROOT CAUSE (measured on the tablet, SM-T505N / Android 12, build 230):
   *   the bubble was an absolutely-positioned view carrying `translateX` +
   *   `scaleX` transforms, `zIndex` and `overflow:'hidden'`, inside the pill
   *   (which is itself `overflow:'hidden'` + rounded). Its geometry was proven
   *   CORRECT — the drag hit-test uses the same numbers and dragging the
   *   invisible bubble from the Home tab to the left really did activate
   *   "My Courses" — and its opacity was 1 (width > 0). Yet a full pixel scan
   *   of the bar (1200x2000 screenshot, columns 830-1180) found no bubble at
   *   all: only the icon glyph and the pill's own sheen ramp. So the view was
   *   laid out, hit-testable and alpha-1, but its composited/transformed layer
   *   painted NOTHING.
   *
   *   The fix removes every mechanism that can produce that empty layer: the
   *   bubble is now a PLAIN filled view whose position and width are animated
   *   as layout (left/width, JS driver). No transform, no zIndex, no elevation,
   *   no overflow clip and no child view — the same primitives the glass layers
   *   and the tab row already use, which paint correctly on this device.
   */
  const translateX = useRef(new Animated.Value(0)).current;
  /** 1 → stretched while travelling; multiplies the measured bubble width. */
  const stretch = useRef(new Animated.Value(1)).current;
  /** The bubble's real (measured) width in dp, as an animated layout value. */
  const indicatorBase = useRef(new Animated.Value(0)).current;
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

  /* Tab width: the largest width any tab reported (a zero or partial measurement
   * can never win), with the window width as the pre-layout fallback. */
  const measuredTabWidth = useMemo(() => {
    let max = 0;
    for (const entry of visibleRoutes) {
      const w = layouts[entry.route.key]?.width ?? 0;
      if (Number.isFinite(w) && w > max) max = w;
    }
    return max;
  }, [visibleRoutes, layouts]);

  /* Window width is sanitised at the source. A non-finite (or 0) width here
   * used to poison `Math.max`, every tab x and the bubble's width at once — a
   * single NaN is enough to make the indicator paint NOTHING, however correct
   * the rest of the arithmetic is. Nothing derived is ever allowed to see it. */
  const { width: rawWindowWidth } = useWindowDimensions();
  const windowWidth = Number.isFinite(rawWindowWidth) && rawWindowWidth > 0 ? rawWindowWidth : 0;
  const tabCount = visibleRoutes.length;
  /* The span the tabs occupy. THREE independent candidates, largest wins, and
   * every one of them is finite: the measured tabs' total, the window width, and
   * the pill's own measured width (the one measurement that is known to work —
   * it drives the drag hit-test). A device can fail one of them; it cannot fail
   * all three on a laid-out screen, so the bubble always has a real width. */
  const windowSpan = windowWidth > 0 ? Math.max(windowWidth - SIDE_INSET * 2 - 2, 0) : 0;
  const pillSpan = pillWidth > 0 ? Math.max(pillWidth - 2, 0) : 0;
  const measuredSpan = Number.isFinite(measuredTabWidth) ? measuredTabWidth * tabCount : 0;
  /* Priority: the ROW's own measurement, then the measured tabs' total, then
   * the pill, then the window. Every candidate is finite and the result is
   * bounded by the pill — the bubble can never be laid out outside its clip. */
  const rawSpan = rowWidth > 0
    ? rowWidth
    : (measuredSpan > 0 ? measuredSpan : (pillSpan > 0 ? pillSpan : windowSpan));
  const rowSpan = Number.isFinite(rawSpan) && rawSpan > 0
    ? (pillSpan > 0 ? Math.min(rawSpan, pillSpan) : rawSpan)
    : 0;
  const tabWidth = tabCount > 0 && rowSpan > 0 ? rowSpan / tabCount : 0;
  const indicatorWidth = tabCount > 0 && tabWidth > 0
    ? Math.max(tabWidth - INDICATOR_INSET * 2, 24)
    : 0;

  /* ── RTL EDGE SEMANTICS (measured on the tablet, build 232) ──────────────
   *
   * This is the second half of the intermittent wrong-tab bug, and it can only
   * be seen on a device. React Native swaps the `left` and `right` STYLE props
   * when the UI is RTL (`I18nManager.doLeftAndRightSwapInRTL`, default true).
   * So on an Arabic device `left: 3 * tabWidth` is laid out as `right: 3 *
   * tabWidth`, i.e. at the OPPOSITE end of the bar.
   *
   * PROVEN on the tablet with the plain `left: i * tabWidth` version: the Home
   * tab (slot 3) was selected, its icon and label were tinted correctly, and
   * the bubble sat under slot 0. That is exactly the mirrored position, and it
   * is exactly the "Home appears under Profile" report — which is why the old
   * mirroring arithmetic LOOKED right in code and still failed on device.
   *
   * TWO mirrors therefore exist, and both must be accounted for:
   *   • the ROW is laid out right-to-left (the platform mirrors a `row`), and
   *   • `left`/`right` styles are swapped.
   * The rendered list is already in visual order (orderedRoutes), so when the
   * edge is swapped the slot must be expressed from the RIGHT: right = rowSpan
   * - (i + 1) * tabWidth puts slot i at physical left = i * tabWidth. Where the
   * platform does NOT swap, the plain physical `left` is used instead. Both
   * branches are checked on the device, never assumed.
   */
  const swapEdges = I18nManager.isRTL && I18nManager.doLeftAndRightSwapInRTL !== false;
  const tabX = useCallback(
    (i: number) => {
      if (!(Number.isFinite(tabWidth) && tabWidth > 0) || !(rowSpan > 0)) return 0;
      return swapEdges
        ? Math.max(rowSpan - (i + 1) * tabWidth, 0)
        : i * tabWidth;
    },
    [swapEdges, rowSpan, tabWidth],
  );

  /**
   * Convert a bubble `left`-space value into REAL physical pixels in the pill.
   *
   * The drag hit-test compares the finger's physical position with the bubble,
   * so on a swapped-edge device the animated value must be converted first —
   * without this the grab area was mirrored too (the bubble could be grabbed
   * from the opposite end of the bar).
   */
  const specifiedToPhysical = useCallback(
    (specified: number) => {
      const span = rowWidthRef.current;
      const width = indicatorWidthRef.current;
      if (!swapEdges || !(span > 0)) return specified;
      return Math.max(span - specified - width, 0);
    },
    [swapEdges],
  );
  /* Keep the animated layout width in step with the derived geometry. */
  useEffect(() => {
    indicatorBase.setValue(indicatorWidth);
  }, [indicatorWidth, indicatorBase]);
  /** Animated LAYOUT width: base width × travel stretch. */
  const indicatorWidthAnim = useMemo(
    () => Animated.multiply(indicatorBase, stretch),
    [indicatorBase, stretch],
  );
  /* ── Resting x of EVERY tab, in the same physical (left-anchored) space the
   * animation uses. Used for the grab hit-test and the release snap, so a drag
   * released between two tabs still resolves to the nearer one. */
  const tabTargets = useMemo(
    () => orderedRoutes.map((_, i) => tabX(i) + INDICATOR_INSET),
    [orderedRoutes, tabX],
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
    // A non-finite position would be written straight into the transform and
    // the bubble would silently stop painting. Never let one through.
    if (!Number.isFinite(target)) return;
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

    lastTarget.current = target;

    // Travel + deformation: the bubble stretches along its axis as it moves and
    // relaxes on arrival, so the eye reads one travelling droplet.
    Animated.parallel([
      Animated.spring(translateX, {
        toValue: target,
        damping: 19,
        stiffness: 190,
        mass: 0.85,
        // JS driver: the drag writes this exact value from touch coordinates,
        // and `left`/`width` are layout props that cannot run natively.
        useNativeDriver: false,
      }),
      Animated.sequence([
        Animated.timing(stretch, {
          toValue: 1.08,
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
  useEffect(() => { rowWidthRef.current = rowSpan; }, [rowSpan]);
  useEffect(() => { indicatorWidthRef.current = indicatorWidth; }, [indicatorWidth]);
  useEffect(() => { activeVisibleRef.current = activeVisible; }, [activeVisible]);
  useEffect(() => { pressRef.current = handlePress; }, [handlePress]);
  useEffect(() => {
    // The SAME ordered list the row renders, so a drag's `nearest` index and the
    // route it activates can never refer to different tabs.
    tabsInfoRef.current = orderedRoutes.map((entry) => ({
      key: entry.route.key,
      routeIndex: entry.routeIndex,
      name: entry.route.name,
    }));
  }, [orderedRoutes]);

  const measurePill = useCallback(() => {
    // Page coordinates, so the captured touch point can be converted into the
    // pill's own left-anchored space. Re-measured on every layout: rotation,
    // split screen and font-scale changes all land here.
    const epoch = layoutEpoch.current;
    pillRef.current?.measureInWindow((x, y, width, height) => {
      // A newer layout pass superseded this measurement — drop it instead of
      // overwriting fresher geometry with stale numbers.
      if (epoch !== layoutEpoch.current) return;
      pillRect.current = { x, y, width, height, known: width > 0 && height > 0 };
      // The pill's real width is also a geometry candidate (see rowSpan).
      if (Number.isFinite(width) && width > 0) setPillWidth((prev) => (Math.abs(prev - width) < 0.5 ? prev : width));
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
    const landed = Math.min(Math.max(dragOriginX.current + dx * (swapEdges ? -1 : 1), 0), maxX);

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
  }, [settleAt, swapEdges]);

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

      const touchX = start.x - rect.x; // pill-local, PHYSICAL
      const bubbleStart = specifiedToPhysical(liveX.current);
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
      // On a swapped-edge (RTL) device a finger moving RIGHT decreases the
      // `left`-space value: the drag must follow the finger, not run away from
      // it. Same conversion the hit-test uses.
      const delta = (gesture.dx - dragStartDx.current) * (swapEdges ? -1 : 1);
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
  }), [cancelDrag, finishDrag, specifiedToPhysical, stretch, swapEdges, translateX]);

  const bottomPad = Math.max(insets.bottom, 0) + FLOAT_GAP;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.outer,
        { paddingBottom: bottomPad, transform: [{ translateY: keyboardOffset }] },
      ]}
    >
      {/* Approved Light-Mode refinement: a soft, water-like luminous bloom
          UNDER the pill (rendered first, so it sits behind the surface). */}
      <LinearGradient
        pointerEvents="none"
        colors={
          isDark
            ? (['rgba(61,159,255,0)', 'rgba(61,159,255,0.22)'] as const)
            : (['rgba(30,144,255,0)', 'rgba(30,144,255,0.18)'] as const)
        }
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{
          position: 'absolute',
          left: SIDE_INSET + 10,
          right: SIDE_INSET + 10,
          bottom: bottomPad,
          height: BAR_HEIGHT + 26,
          borderRadius: (BAR_HEIGHT + 26) / 2,
          opacity: 0.85,
        }}
      />

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

        {/* Approved Light-Mode refinement: the liquid sheen INSIDE the glass —
            a diagonal luminous wash that gives the surface depth without
            changing the pill's layout or colour identity. */}
        <LinearGradient
          pointerEvents="none"
          colors={
            isDark
              ? (['rgba(96,165,250,0.16)', 'rgba(96,165,250,0.02)', 'rgba(255,255,255,0.06)'] as const)
              : (['rgba(255,255,255,0.55)', 'rgba(30,144,255,0.10)', 'rgba(255,255,255,0.30)'] as const)
          }
          locations={[0, 0.55, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
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

        {/* ONE shared indicator, behind every tab.

            PAINTED AS A PLAIN FILLED VIEW (see the root-cause note above):
            position and width are ANIMATED LAYOUT values (`left`, `width`),
            there is no transform, no zIndex, no elevation and no overflow
            clip on it, and it has no child view — just a solid rounded
            background. Those are exactly the primitives the glass layers
            behind it and the tab row in front of it already paint with on this
            device, so the bubble cannot end up as an empty composited layer.
            It is declared after the glass and before the row, so document
            order puts it above the glass and below the icons/labels without
            any stacking-context tricks. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.indicator,
            {
              left: translateX,
              width: indicatorWidthAnim,
              backgroundColor: isDark ? 'rgba(96,165,250,0.30)' : 'rgba(30,144,255,0.22)',
              borderColor: isDark ? 'rgba(148,200,255,0.62)' : 'rgba(30,144,255,0.55)',
              // Derived, never animated: the bubble is painted exactly when its
              // geometry exists, so a skipped effect can never leave it at 0.
              opacity: indicatorWidth > 0 ? 1 : 0,
            },
          ]}
        />

        <View
          // ONE direction rule: the list is reversed EXPLICITLY (orderedRoutes)
          // and the row is always left-to-right. `direction: 'ltr'` pins the
          // flex start edge so the platform's own RTL mirroring cannot reverse
          // this row a second time.
          onLayout={(event) => onRowLayout(event.nativeEvent.layout.width)}
          style={[styles.row, { direction: 'ltr' }]}
        >
          {orderedRoutes.map(({ route, descriptor, routeIndex }) => {
            const isFocused = routeIndex === activeIndex;
            const options = descriptor.options ?? {};
            const label = options.title ?? route.name;
            const icon = options.tabBarIcon;

            return (
              <Pressable
                key={route.key}
                style={styles.tab}
                onLayout={(event) => onTabLayout(route.key, event.nativeEvent.layout.width)}
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
    // `left` is PHYSICAL (Yoga), so the same anchor is correct in Arabic and
    // English; the animated value is the tab's measured physical x. No
    // stacking, clipping or transform tricks — see the render note.
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
