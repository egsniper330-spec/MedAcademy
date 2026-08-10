/**
 * ds.ts — MedAcademy Adaptive Design System v3
 * ─────────────────────────────────────────────
 * Production-grade adaptive layout engine used by Netflix, WhatsApp, Google.
 *
 * Three scale axes:
 *   1. dp-scale   → screen logical width / 390 reference
 *   2. density    → PixelRatio.get()  — hairlines on hi-DPI
 *   3. fontScale  → PixelRatio.getFontScale() — system large-text
 *
 * Device class system (replaces per-screen width checks):
 *   compact   < 360dp  — small phones (SE, legacy Android)
 *   standard  < 412dp  — regular phones
 *   large     < 600dp  — large phones (Pro Max, Ultra)
 *   expanded  < 768dp  — foldables inner / phablets
 *   tablet    < 1024dp — tablets, iPads
 *   desktop  >= 1024dp — large tablets, web
 *
 * Key exports:
 *   useAdaptive()  → device class + all adaptive tokens (use this in all screens)
 *   useLayout()    → useAdaptive() + live safe-area insets (THE one hook per screen)
 *   ContentContainer → max-width centering component for tablet/desktop
 *   AdaptiveScreen   → drop-in screen wrapper with keyboard + safe-area
 *
 * Rules:
 *   • Never use raw numbers for spacing/font/radius in screen files
 *   • Never call useSafeAreaInsets() in screen files — use useLayout()
 *   • Never check `width > 768` in screen files — use layout.deviceClass
 *   • Never hardcode KeyboardAvoidingView — use AdaptiveScreen
 */

import { useWindowDimensions, PixelRatio, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMemo } from 'react';

// ─── 1. Spacing scale ────────────────────────────────────────────────────────
// 4-dp base grid — every spacing value is a multiple of 4.
// Names map to t-shirt sizes for quick intuitive use.
export const spacing = {
  /** 2 dp — hairline gap, badge offsets */
  xxs:  2,
  /** 4 dp — tight internal gaps */
  xs:   4,
  /** 8 dp — icon padding, list item gap */
  sm:   8,
  /** 12 dp — card internal gap, row gap */
  md:   12,
  /** 16 dp — standard list padding, card px */
  lg:   16,
  /** 20 dp — section internal padding */
  xl:   20,
  /** 24 dp — section gaps, modal padding */
  xxl:  24,
  /** 32 dp — large section gap */
  xxxl: 32,
  /** 48 dp — hero vertical space */
  hero: 48,
} as const;

// ─── 2. Border radius ────────────────────────────────────────────────────────
export const radius = {
  /** 4 dp — subtle rounding, small chips */
  xs:     4,
  /** 8 dp — tags, badges, small buttons */
  sm:     8,
  /** 12 dp — standard button, icon containers */
  md:     12,
  /** 16 dp — cards, modals */
  lg:     16,
  /** 20 dp — featured cards, bottom sheets */
  xl:     20,
  /** 28 dp — hero cards, full-width modals */
  xxl:    28,
  /** 9999 — pill shape */
  pill:   9999,
  /** 9999 — circular avatar */
  full:   9999,
} as const;

// ─── 3. Typography scale ─────────────────────────────────────────────────────
// Static base values — useDS() provides responsive overrides for large screens.
export const typography = {
  // Display
  displayLg: { fontSize: 34, lineHeight: 40, fontWeight: '800' as const },
  display:   { fontSize: 28, lineHeight: 34, fontWeight: '800' as const },

  // Headings
  h1:  { fontSize: 24, lineHeight: 30, fontWeight: '800' as const },
  h2:  { fontSize: 20, lineHeight: 26, fontWeight: '700' as const },
  h3:  { fontSize: 17, lineHeight: 22, fontWeight: '700' as const },
  h4:  { fontSize: 15, lineHeight: 20, fontWeight: '700' as const },

  // Body
  bodyLg:  { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  body:    { fontSize: 14, lineHeight: 21, fontWeight: '400' as const },
  bodySm:  { fontSize: 13, lineHeight: 19, fontWeight: '400' as const },

  // UI
  label:   { fontSize: 15, lineHeight: 20, fontWeight: '600' as const },
  labelSm: { fontSize: 13, lineHeight: 18, fontWeight: '600' as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' as const },
  micro:   { fontSize: 10, lineHeight: 14, fontWeight: '500' as const },

  // Special
  tabLabel: { fontSize: 10, lineHeight: 13, fontWeight: '700' as const, letterSpacing: 0.2 },
  overline: { fontSize: 11, lineHeight: 14, fontWeight: '600' as const, letterSpacing: 0.6, textTransform: 'uppercase' as const },
  mono:     { fontSize: 13, lineHeight: 19, fontWeight: '500' as const, fontFamily: 'monospace' as const },
} as const;

// ─── 4. Icon sizes ───────────────────────────────────────────────────────────
export const iconSize = {
  /** 14 dp — micro badge icons */
  xs:   14,
  /** 16 dp — inline text icons */
  sm:   16,
  /** 20 dp — standard UI icons (nav, header) */
  md:   20,
  /** 22 dp — emphasized icons */
  lg:   22,
  /** 24 dp — standard action icons */
  xl:   24,
  /** 28 dp — section icons */
  xxl:  28,
  /** 36 dp — feature icons */
  xxxl: 36,
  /** 48 dp — empty state, hero icons */
  hero: 48,
} as const;

// ─── 5. Icon container sizes ─────────────────────────────────────────────────
export const iconContainer = {
  /** 28×28 — stat badge */
  xs:  { width: 28,  height: 28,  borderRadius: radius.sm  },
  /** 32×32 — list badge */
  sm:  { width: 32,  height: 32,  borderRadius: radius.md  },
  /** 40×40 — header button (HIG minimum touch = 44, hitSlop adds the rest) */
  md:  { width: 40,  height: 40,  borderRadius: radius.md  },
  /** 44×44 — prominent action */
  lg:  { width: 44,  height: 44,  borderRadius: radius.md  },
  /** 52×52 — feature icon container */
  xl:  { width: 52,  height: 52,  borderRadius: radius.lg  },
  /** 64×64 — avatar, hero */
  xxl: { width: 64,  height: 64,  borderRadius: radius.pill},
} as const;

// ─── 6. Animation durations ──────────────────────────────────────────────────
export const animation = {
  /** 80 ms — hairline ripple, checkbox tick */
  instant: 80,
  /** 120 ms — micro interactions (press, toggle) */
  micro:   120,
  /** 200 ms — standard element transitions */
  fast:    200,
  /** 300 ms — modal appear, sheet, page push */
  base:    300,
  /** 400 ms — complex entrance (staggered list) */
  medium:  400,
  /** 500 ms — hero image, drawer slide */
  slow:    500,

  /** Spring — snappy (buttons, cards, chips) */
  springSnappy: { tension: 120, friction: 14, useNativeDriver: true } as const,
  /** Spring — gentle (drawers, bottom sheets) */
  springGentle: { tension: 60,  friction: 12, useNativeDriver: true } as const,
  /** Spring — bouncy (success states, likes) */
  springBouncy: { tension: 180, friction: 10, useNativeDriver: true } as const,
} as const;

// ─── 6a. Easing curves ───────────────────────────────────────────────────────
// Matches Material Design 3 motion tokens and Apple HIG curve recommendations.
// Import from here — never raw Easing.* in screen files.

export const easing = {
  /** Standard — most transitions (enter + exit) */
  standard:    Easing.bezier(0.2, 0, 0, 1),
  /** Emphasized — hero elements, page entry */
  emphasized:  Easing.bezier(0.05, 0.7, 0.1, 1),
  /** Decelerate — element entering from off-screen */
  decelerate:  Easing.bezier(0, 0, 0.2, 1),
  /** Accelerate — element leaving to off-screen */
  accelerate:  Easing.bezier(0.4, 0, 1, 1),
  /** Linear — progress bars, continuous motion */
  linear:      Easing.linear,
  /** Bounce — micro success feedback */
  bounce:      Easing.bounce,
} as const;

// ─── 7. Elevation levels ─────────────────────────────────────────────────────
export const elevation = {
  /** 0 — flat, no shadow (neumorphic base) */
  none:    0,
  /** 1 — recessed / inset element */
  inset:   1,
  /** 2 — card surface */
  card:    2,
  /** 3 — pressed card, active element */
  pressed: 3,
  /** 4 — floating header, sticky bar */
  header:  4,
  /** 6 — dropdown, tooltip */
  overlay: 6,
  /** 8 — modal, bottom sheet */
  modal:   8,
  /** 12 — global overlay (full-screen modal) */
  dialog:  12,
} as const;

// ─── 7a. Z-index stack ───────────────────────────────────────────────────────
// Never use raw z-index numbers in screens. Always import from here.
export const zIndex = {
  /** 0 — content layer */
  base:      0,
  /** 1 — raised card */
  card:      1,
  /** 10 — sticky header */
  header:    10,
  /** 20 — floating action button */
  fab:       20,
  /** 30 — dropdown menus, tooltips */
  dropdown:  30,
  /** 40 — bottom sheets */
  sheet:     40,
  /** 50 — toasts, snackbars */
  toast:     50,
  /** 60 — modals, dialogs */
  modal:     60,
  /** 70 — full-screen overlays */
  overlay:   70,
  /** 999 — global loading spinner */
  loader:    999,
} as const;

// ─── 7b. Opacity scale ───────────────────────────────────────────────────────
// Semantic opacity values used for hierarchy, disabled states, overlays.
export const opacity = {
  /** 0.04 — barely visible tint (hover bg) */
  ghost:     0.04,
  /** 0.08 — subtle tint (pressed bg) */
  tint:      0.08,
  /** 0.12 — light divider, background accent */
  subtle:    0.12,
  /** 0.24 — icon badge, placeholder */
  muted:     0.24,
  /** 0.40 — secondary text, captions */
  secondary: 0.40,
  /** 0.55 — tertiary text, icons */
  tertiary:  0.55,
  /** 0.70 — inactive tab icons */
  inactive:  0.70,
  /** 0.85 — slightly faded */
  dim:       0.85,
  /** 1.0 — fully opaque */
  full:      1.0,

  // Interactive states
  /** Pressed button / card */
  pressed:   0.75,
  /** Disabled element */
  disabled:  0.38,
  /** Overlay scrim (modal backdrop) */
  scrim:     0.50,
} as const;

// ─── 7c. Border widths ───────────────────────────────────────────────────────
export const border = {
  /** 0 — no border */
  none:  0,
  /** StyleSheet.hairlineWidth — 1 physical px (retina-correct divider) */
  hair:  1 / (typeof PixelRatio !== 'undefined' ? PixelRatio.get() : 1),
  /** 1 dp — standard border */
  thin:  1,
  /** 1.5 dp — emphasized border */
  base:  1.5,
  /** 2 dp — focus ring, selected state */
  thick: 2,
  /** 3 dp — feature callout */
  heavy: 3,
} as const;

// ─── 8. Breakpoints — Material Design 3 / adaptive window classes ────────────
// Mirrors Google's adaptive layout breakpoints used in Gmail, Drive, Maps.
// Use deviceClass from useAdaptive() — never check raw width in screen files.
export const breakpoint = {
  /** Smallest phones (iPhone SE 1st gen, legacy Android) — < 360dp */
  xs:       320,
  /** Standard compact phones — < 412dp */
  sm:       360,
  /** Modern phones (Pixel, Galaxy standard) */
  md:       393,
  /** Large phones (Pro Max, Ultra, Note) */
  lg:       412,
  /** Foldable inner / phablets — compact→expanded transition */
  xl:       600,
  /** Tablets / iPads — medium window class */
  tablet:   768,
  /** Large tablets / iPad Pro — expanded window class */
  large:   1024,
} as const;

/**
 * DeviceClass — the single source of truth for layout decisions.
 *
 * Map:
 *   compact   → phones < 360dp  (SE, legacy)
 *   standard  → phones 360–412dp (most Android, iPhone 14/15)
 *   large     → phones > 412dp  (Pro Max, Galaxy Ultra)
 *   expanded  → foldables / phablets 600–768dp
 *   tablet    → tablets 768–1024dp (iPad, Tab S)
 *   desktop   → large tablets / web ≥ 1024dp
 */
export type DeviceClass = 'compact' | 'standard' | 'large' | 'expanded' | 'tablet' | 'desktop';

export function getDeviceClass(shortSide: number): DeviceClass {
  if (shortSide < breakpoint.sm)     return 'compact';
  if (shortSide < breakpoint.lg)     return 'standard';
  if (shortSide < breakpoint.xl)     return 'large';
  if (shortSide < breakpoint.tablet) return 'expanded';
  if (shortSide < breakpoint.large)  return 'tablet';
  return 'desktop';
}

// ─── Content max-widths per device class ────────────────────────────────────
// Used by ContentContainer to prevent content stretching on wide screens.
// Values match Netflix, Google, Facebook centering behaviour.
export const contentMaxWidth: Record<DeviceClass, number | undefined> = {
  compact:  undefined,  // full width
  standard: undefined,  // full width
  large:    undefined,  // full width
  expanded: 560,        // foldable inner — centre narrow forms
  tablet:   680,        // tablet — centred single-column
  desktop:  760,        // large tablet — capped column
};

// ─── 9. Grid system ──────────────────────────────────────────────────────────
// Column counts for different screen sizes.
// Used by ResponsiveGrid component.
export const grid = {
  /** Phone portrait: 2 columns */
  phoneCols:  2,
  /** Landscape / phablet: 3 columns */
  phabletCols: 3,
  /** Tablet: 3-4 columns */
  tabletCols:  4,
  /** Min card width before layout switches columns */
  minCardWidth: 140,
  /** Gap between grid cells */
  gap: spacing.md,
} as const;

// ─── 10. Safe area breathing room ────────────────────────────────────────────
export const safeArea = {
  /**
   * Breathing room between OS status bar bottom and first content pixel.
   * Added ON TOP of insets.top — never replace insets.top with this.
   */
  topBreathing: 8,
  /**
   * Minimum top padding floor for simulators/web (insets.top = 0).
   * Math.max(insets.top + safeArea.topBreathing, safeArea.topMin)
   */
  topMin: 24,
  /**
   * Breathing room added to insets.bottom (above home indicator / gesture bar).
   */
  bottomBreathing: 8,
  /**
   * Minimum bottom inset floor.
   */
  bottomMin: 16,
  /**
   * Page-level horizontal edge padding (button to screen edge).
   * This is the edge distance for interactive controls.
   */
  hEdge: 4,
  /**
   * Minimum horizontal edge pad (floor for landscape insets=0).
   */
  hEdgeMin: 8,
} as const;

// ─── 11. Pure safe-area helpers (no hooks — pass insets from useSafeAreaInsets)
/**
 * safeTop — final paddingTop for any header/screen.
 *
 * On Android with gesture nav, insets.top is the status-bar height and is
 * always positive. We add breathing room so content never clips the bar.
 * The topMin floor covers simulators and web where insets.top = 0.
 */
export function safeTop(insetsTop: number): number {
  return Math.max(insetsTop + safeArea.topBreathing, safeArea.topMin);
}

/**
 * safeBottom — final paddingBottom for scroll containers.
 *
 * On Android:
 *   • Gesture nav  → insets.bottom = ~34 dp (home indicator area)
 *   • 3-button nav → insets.bottom = nav-bar height (~48 dp on most devices)
 * React Navigation reads the same insets and already applies them to the tab
 * bar itself via SafeAreaProviderCompat. For ScrollView/FlatList content we
 * add our own breathing room so the last card never hides under the nav bar.
 *
 * Never hardcode numbers like "paddingBottom: 30" — use safeBottom(insets.bottom).
 */
export function safeBottom(insetsBottom: number, extra = 0): number {
  return Math.max(insetsBottom + safeArea.bottomBreathing, safeArea.bottomMin) + extra;
}

/**
 * safeLeft — header left padding (icon flush to edge, never clipped by camera cutout).
 */
export function safeLeft(insetsLeft: number, isTablet = false): number {
  return isTablet
    ? Math.max(insetsLeft + spacing.lg, spacing.lg)
    : Math.max(insetsLeft + safeArea.hEdge, safeArea.hEdgeMin);
}

/**
 * safeRight — header right padding.
 */
export function safeRight(insetsRight: number): number {
  return Math.max(insetsRight + spacing.md, spacing.md);
}

/**
 * scalePx — scale a dp value proportionally to screen width (390dp base).
 * Use sparingly — prefer flex over scaled fixed sizes.
 */
export function scalePx(value: number, screenWidth: number): number {
  const factor = Math.min(1.2, Math.max(0.85, screenWidth / 390));
  return Math.round(value * factor);
}

// ─── 12. Responsive hook: useDS() ────────────────────────────────────────────
/**
 * useDS() — backward-compat alias for useAdaptive().
 * Prefer useAdaptive() in new code. useDS() is kept so existing call-sites
 * compile without changes.
 */
export function useDS() { return useAdaptive(); }

// ─── 12a. useAdaptive() — the canonical adaptive layout hook ─────────────────
/**
 * useAdaptive() — production-grade adaptive layout hook.
 *
 * Replaces manual width checks in every screen. Returns device class +
 * all adaptive tokens so components never need to know the raw pixel width.
 *
 * Usage:
 *   const layout = useAdaptive();
 *
 *   // Device-class branch (never check raw width)
 *   if (layout.isTablet) <TwoColumnLayout />
 *   else <SingleColumnLayout />
 *
 *   // Typography (respects system large-text)
 *   <Text style={{ fontSize: layout.bodySize }}>…</Text>
 *
 *   // Adaptive content max-width (ContentContainer uses this)
 *   <View style={{ maxWidth: layout.maxContentWidth, alignSelf: 'center', width: '100%' }}>
 */
export function useAdaptive() {
  const { width, height } = useWindowDimensions();
  // shortSide drives device class — stable across orientation changes
  const short      = Math.min(width, height);
  const deviceClass = useMemo(() => getDeviceClass(short), [short]);

  const isCompact  = deviceClass === 'compact';
  const isStandard = deviceClass === 'standard';
  const isLarge    = deviceClass === 'large' || deviceClass === 'expanded';
  const isExpanded = deviceClass === 'expanded';
  const isTablet   = deviceClass === 'tablet' || deviceClass === 'desktop';
  const isDesktop  = deviceClass === 'desktop';
  const isLandscape = width > height;
  const isSmall    = short < breakpoint.sm;

  // dp-scale: 1.0 at 390dp reference, clamped 0.88–1.18
  const dpScale   = useMemo(() => Math.min(1.18, Math.max(0.88, short / 390)), [short]);
  const fontScale = useMemo(() => PixelRatio.getFontScale(), []);
  const density   = useMemo(() => PixelRatio.get(), []);

  // Horizontal content padding — inset from screen edge for cards/lists
  const screenPx = useMemo(() => isTablet
    ? spacing.xxxl
    : isLarge
      ? spacing.hero
      : Math.round(spacing.xl * dpScale),
  [isTablet, isLarge, dpScale]);

  // Landscape: reduce vertical padding to preserve content space
  const screenPy = isLandscape
    ? spacing.sm
    : isTablet ? spacing.xxl : spacing.xl;

  // Responsive font sizes — fontScale-aware, clamped
  const clampFont = useMemo(() => (base: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(
      base * (isSmall ? 0.95 : isTablet ? 1.05 : 1) * Math.min(fontScale, 1.25)
    ))), [isSmall, isTablet, fontScale]);

  // Max content width — prevents full-stretch on tablets (Netflix / Google pattern)
  const maxContentWidth = useMemo(() => contentMaxWidth[deviceClass], [deviceClass]);

  // Column count for grids — auto-adapts to landscape + device class
  const gridCols = useMemo(() => isTablet
    ? (isLandscape ? 4 : grid.tabletCols)
    : isExpanded
      ? 3
      : isLandscape
        ? grid.phabletCols
        : isLarge
          ? grid.phabletCols
          : grid.phoneCols,
  [isTablet, isExpanded, isLandscape, isLarge]);

  return useMemo(() => ({
    // ── Static token pass-throughs ───────────────────────────────────────
    spacing, radius, typography, iconSize, iconContainer,
    animation, easing, safeArea, grid, breakpoint,
    elevation, zIndex, opacity, border,

    // ── Device class ─────────────────────────────────────────────────────
    deviceClass,
    isCompact, isStandard, isLarge, isExpanded, isTablet, isDesktop,
    isLandscape, isSmall, width, height,

    // ── Scale axes ───────────────────────────────────────────────────────
    dpScale, fontScale, density,

    // ── Layout ───────────────────────────────────────────────────────────
    screenPx, screenPy, maxContentWidth,
    cardPx: isTablet ? spacing.xl : spacing.lg,
    cardPy: isTablet ? spacing.lg : spacing.md,
    sectionGap: isTablet ? spacing.xxl : isLandscape ? spacing.md : spacing.xl,
    itemGap: isTablet ? spacing.md : spacing.sm,
    cardRadius: isTablet ? radius.xl : radius.lg,
    gridCols,
    headerBtnSize: isTablet ? iconContainer.lg.width : iconContainer.md.width,

    // ── Typography ───────────────────────────────────────────────────────
    titleSize:   clampFont(isTablet ? typography.h1.fontSize : typography.h2.fontSize, 17, 32),
    headingSize: clampFont(typography.h3.fontSize, 14, 22),
    bodySize:    clampFont(typography.body.fontSize, 12, 18),
    captionSize: clampFont(typography.caption.fontSize, 10, 14),
    tabLabelSize: clampFont(typography.tabLabel.fontSize, 9, 12),
  }), [
    deviceClass, isCompact, isStandard, isLarge, isExpanded,
    isTablet, isDesktop, isLandscape, isSmall,
    width, height, dpScale, fontScale, density,
    screenPx, screenPy, maxContentWidth, gridCols, clampFont,
  ]);
}

// ─── 13. useLayout() — adaptive hook + live safe-area insets ─────────────────
/**
 * useLayout() — THE single hook every screen uses.
 *
 * Combines useAdaptive() with live safe-area insets. Provides ready-to-use
 * padding values that handle:
 *   • Status bar (all Android versions, all iOS notch types)
 *   • Dynamic Island (iPhone 14 Pro+)
 *   • Gesture nav home indicator (~34dp)
 *   • 3-button nav bar (~48dp on most Android devices)
 *   • Camera cutout / punch-hole in landscape
 *   • Foldable outer/inner screen dimensions
 *   • Split-screen / multi-window dynamic resizing
 *
 * Usage:
 *   const layout = useLayout();
 *
 *   // Header — always correct on every device
 *   <View style={layout.headerPadding}>
 *
 *   // FlatList content — clears gesture/3-button nav bar
 *   <FlatList contentContainerStyle={{ paddingBottom: layout.scrollBottom() }} />
 *
 *   // Device-class branch — never check raw width
 *   {layout.isTablet && <SidebarColumn />}
 */
export function useLayout() {
  const insets = useSafeAreaInsets();
  const adapt  = useAdaptive();

  const headerTop    = safeTop(insets.top);
  const headerLeft   = safeLeft(insets.left  ?? 0, adapt.isTablet);
  const headerRight  = safeRight(insets.right ?? 0);
  const pageBottom   = safeBottom(insets.bottom, 0);
  const scrollBottom = useMemo(
    () => (extra = 0) => safeBottom(insets.bottom, extra),
    [insets.bottom],
  );

  return useMemo(() => ({
    ...adapt,
    insets,

    // ── Header padding ────────────────────────────────────────────────────
    headerTop,
    headerLeft,
    headerRight,
    headerBottom: spacing.md,
    headerPadding: {
      paddingTop:    headerTop,
      paddingBottom: spacing.md,
      paddingLeft:   headerLeft,
      paddingRight:  headerRight,
    } as const,

    // ── Scroll / page bottom ──────────────────────────────────────────────
    pageBottom,
    scrollBottom,

    // ── Content padding shorthand ─────────────────────────────────────────
    contentPadding: {
      paddingHorizontal: adapt.screenPx,
    } as const,
  }), [adapt, insets, headerTop, headerLeft, headerRight, pageBottom, scrollBottom]);
}
