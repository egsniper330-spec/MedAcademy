/**
 * ds.ts — MedAcademy Adaptive Design System v4
 * ─────────────────────────────────────────────
 * Production-grade adaptive layout engine used by Netflix, WhatsApp, Google.
 *
 * Four scale axes:
 *   1. dp-scale    → screen logical width / 390 reference
 *   2. density     → PixelRatio.get()  — hairlines on hi-DPI
 *   3. fontScale   → PixelRatio.getFontScale() — system large-text
 *   4. fluid lerp  → lerp(min, max, t) — continuous interpolation (no breakpoints)
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
 *   lerp(a, b, t)  → continuous linear interpolation (Netflix / Apple Music pattern)
 *   fluidSpace(w)  → fluid spacing that interpolates between screen sizes
 *   fluidFont(w)   → fluid font size that interpolates between screen sizes
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
 *   • Never write `padding: 24` — write `layout.screenPx` or `spacing.xxl`
 *   • Fluid values (lerp) preferred over step-function breakpoints
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

// ─── 7d. Fluid interpolation helpers ────────────────────────────────────────
/**
 * lerp — linear interpolation (the Netflix / Apple Music "continuous scaling" pattern).
 *
 * Replaces if/else breakpoint ladders. A value is calculated continuously
 * between `a` (at t=0) and `b` (at t=1) as `t` changes.
 *
 * Usage:
 *   // Pad that grows from 14dp (320dp screen) to 24dp (768dp screen):
 *   const pad = lerp(14, 24, normalize(shortSide, 320, 768));
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

/**
 * normalize — maps `value` from [min, max] → [0, 1] for use with lerp().
 *
 * Usage:
 *   const t = normalize(shortSide, 320, 768);  // 0 at 320dp, 1 at 768dp
 */
export function normalize(value: number, min: number, max: number): number {
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * fluidSpace — continuously scales a spacing value between compact and expanded.
 *
 * Unlike `if isTablet then 32 else 16`, this produces values like 17, 18, 19…
 * giving a smooth visual rhythm on every screen size.
 *
 * @param base     dp value at 390dp reference (most phones)
 * @param w        current screen shortSide in dp
 * @param minScale clamp floor (default 0.82 — small phones get 82% of base)
 * @param maxScale clamp ceiling (default 1.45 — large tablets get 145% of base)
 */
export function fluidSpace(base: number, w: number, minScale = 0.82, maxScale = 1.45): number {
  const t = normalize(w, 320, 1024);
  const scale = lerp(minScale, maxScale, t);
  return Math.round(base * scale);
}

/**
 * fluidFont — continuously scales font sizes.
 *
 * Produces smooth type scaling across all screen widths.
 * Respects the system fontScale multiplier (accessibility large text).
 *
 * @param base       base font size in dp at 390dp reference
 * @param w          screen shortSide in dp
 * @param fontScale  PixelRatio.getFontScale()
 * @param minPt      minimum dp clamp (prevent unreadable tiny text)
 * @param maxPt      maximum dp clamp (prevent oversized text on large displays)
 */
export function fluidFont(
  base: number,
  w: number,
  fontScale: number,
  minPt: number,
  maxPt: number,
): number {
  // Screen-width factor: linear from 0.88 (320dp) to 1.12 (768dp)
  const widthFactor = lerp(0.88, 1.12, normalize(w, 320, 768));
  // Apply system font scale, capped at 1.3× to prevent extreme large-text layouts
  const scaled = base * widthFactor * Math.min(fontScale, 1.3);
  return Math.round(Math.min(maxPt, Math.max(minPt, scaled)));
}

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

  // Horizontal content padding — inset from screen edge for cards/lists.
  //
  // Uses fluidSpace() for continuous interpolation instead of step-function breakpoints.
  // This is what Netflix, Apple Music, and Instagram do on every screen size:
  // the padding grows smoothly as the screen widens — no sudden jumps.
  //
  //   320dp (iPhone SE 1st): ~13dp
  //   390dp (iPhone 14):      16dp  ← baseline
  //   430dp (iPhone 15 Pro Max): 18dp
  //   600dp (foldable inner): 22dp
  //   768dp (iPad):           28dp
  //   1024dp (iPad Pro):      38dp
  const screenPx = useMemo(
    () => Math.round(fluidSpace(spacing.lg, short, 0.82, 2.4)),
    [short],
  );

  // Landscape: reduce vertical padding to preserve content space
  const screenPy = isLandscape
    ? spacing.sm
    : isTablet ? spacing.xxl : spacing.xl;

  // Responsive font sizes — fluid (not breakpoint-step), fontScale-aware, clamped.
  //
  // Uses fluidFont() which continuously scales between minPt and maxPt as the
  // screen width grows. This matches how Apple Music, Netflix, Instagram rhythm:
  //   compact phone (320dp): smaller text
  //   Pro Max / Ultra (430dp): slightly larger
  //   Tablet (768dp): properly larger
  //   No sudden jumps between sizes.
  const clampFont = useMemo(() => (base: number, min: number, max: number) => {
    return fluidFont(base, short, fontScale, min, max);
  }, [short, fontScale]);

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
    // Item gap: large phones get a touch more breathing room (WhatsApp / Apple Music pattern)
    itemGap: isTablet ? spacing.md : isLarge ? spacing.sm + 2 : spacing.sm,
    cardRadius: isTablet ? radius.xl : radius.lg,
    gridCols,
    // Touch targets: 48pt on large phones/tablets (Apple HIG recommends ≥44pt, 48pt on large)
    headerBtnSize: (isTablet || isLarge) ? iconContainer.lg.width : iconContainer.md.width,

    // ── Adaptive touch target — fluid between 44pt (small) and 52pt (tablet) ─
    // HIG min: 44pt. MD3 recommended: 48pt. We use 44–52 range continuously.
    touchTarget: Math.round(fluidSpace(44, short, 1.0, 1.18)),

    // ── Tab bar height — fluid (compact → tablet: 52 → 68) ──────────────
    // Nav bar must provide enough vertical space for icon + label + home indicator.
    tabBarHeight: Math.round(fluidSpace(56, short, 0.93, 1.21)),

    // ── Modal / dialog widths ────────────────────────────────────────────
    // On phones: full-width sheet (use '100%' via `undefined`).
    // On tablets/foldables: constrained modal so it doesn't span full screen.
    // Matches iOS sheet, Android bottom-sheet, Google Docs dialog patterns.
    modalWidth: isTablet
      ? Math.min(520, width * 0.85)
      : isExpanded
        ? Math.min(460, width * 0.90)
        : undefined,                         // phones → full width
    dialogWidth: isTablet
      ? Math.min(460, width * 0.75)
      : isExpanded
        ? Math.min(400, width * 0.85)
        : width * 0.92,                      // phones → 92% width

    // ── Card image height — fluid (never hardcode 200 in a screen file) ──
    // Aspect-ratio driven: ~16:9 image at the current screen width.
    // cardImageHeight = (width - 2*screenPx) * (9/16), clamped to a sane range.
    cardImageHeight: Math.round(
      Math.min(320, Math.max(140, (width - screenPx * 2) * (9 / 16)))
    ),

    // ── Hero icon container (for landing / empty state / auth screens) ───
    // Fluid from 72dp (compact) to 104dp (tablet).
    heroIconSize: Math.round(fluidSpace(88, short, 0.82, 1.18)),
    heroIconRadius: Math.round(fluidSpace(28, short, 0.82, 1.18)),

    // ── Typography ─────────────────────────────────────────────────────────
    // Fluid font sizes — continuously scale with screen width using fluidFont().
    // No device-class step-function — same algorithm Netflix / Apple Music use.
    titleSize:   clampFont(isTablet ? typography.h1.fontSize : typography.h2.fontSize, 17, 34),
    headingSize: clampFont(typography.h3.fontSize, 14, 24),
    bodySize:    clampFont(typography.body.fontSize, 12, 19),
    captionSize: clampFont(typography.caption.fontSize, 10, 15),
    tabLabelSize: clampFont(typography.tabLabel.fontSize, 9, 13),

    // ── Fluid spacing helpers — use in screens instead of hardcoded numbers ──
    // These replace `paddingHorizontal: 24` with `layout.pad.lg` etc.
    // All values scale continuously with screen width.
    pad: {
      /** ~4–6dp across devices */
      xs:   Math.round(fluidSpace(spacing.xs,   short, 0.85, 1.15)),
      /** ~7–10dp */
      sm:   Math.round(fluidSpace(spacing.sm,   short, 0.85, 1.20)),
      /** ~10–15dp */
      md:   Math.round(fluidSpace(spacing.md,   short, 0.85, 1.20)),
      /** ~14–22dp — standard list/card padding */
      lg:   Math.round(fluidSpace(spacing.lg,   short, 0.86, 1.25)),
      /** ~17–28dp — section internal padding */
      xl:   Math.round(fluidSpace(spacing.xl,   short, 0.86, 1.30)),
      /** ~20–34dp — section gaps, modal padding */
      xxl:  Math.round(fluidSpace(spacing.xxl,  short, 0.86, 1.35)),
      /** ~28–44dp — large section gap */
      xxxl: Math.round(fluidSpace(spacing.xxxl, short, 0.86, 1.40)),
    },
  }), [
    deviceClass, isCompact, isStandard, isLarge, isExpanded,
    isTablet, isDesktop, isLandscape, isSmall,
    width, height, short, dpScale, fontScale, density,
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
  const headerLeft   = safeLeft(insets.left  ?? 0, adapt?.isTablet ?? false);
  const headerRight  = safeRight(insets.right ?? 0);
  const pageBottom   = safeBottom(insets.bottom, 0);
  const scrollBottom = useMemo(
    () => (extra = 0) => safeBottom(insets.bottom, extra),
    [insets.bottom],
  );

  return useMemo(() => {
    // Defensive guard: adapt should always be defined (useAdaptive returns a useMemo),
    // but during the React concurrent-mode unmount pass a screen can re-render with
    // a stale/empty adapt object. Ensure pad always exists so layout.pad.xxl never
    // throws "undefined is not an object" on native (JSC / Hermes).
    const safePad = adapt?.pad ?? {
      xs: spacing.xs, sm: spacing.sm, md: spacing.md,
      lg: spacing.lg, xl: spacing.xl, xxl: spacing.xxl, xxxl: spacing.xxxl,
    };
    const safeAdapt = adapt ?? {} as ReturnType<typeof useAdaptive>;

    return {
      ...safeAdapt,
      pad: safePad,
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
        paddingHorizontal: (adapt?.screenPx ?? spacing.lg),
      } as const,
    };
  }, [adapt, insets, headerTop, headerLeft, headerRight, pageBottom, scrollBottom]);
}
