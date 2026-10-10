import { Platform, StyleSheet, useWindowDimensions } from 'react-native';
import type { TextStyle } from 'react-native';

// Re-export the full design system so callers can import everything from one place.
export {
  spacing, radius, typography, iconSize, iconContainer,
  animation, easing, safeArea, grid, breakpoint,
  elevation, zIndex, opacity, border,
  contentMaxWidth, getDeviceClass,
  type DeviceClass,
  useAdaptive, useDS, useLayout,
  safeTop, safeBottom, safeLeft, safeRight, scalePx,
} from '@/lib/ds';
import { spacing, radius, breakpoint } from '@/lib/ds';

// ─── Neumorphic Design System ────────────────────────────────────────────────
// Light base: #E8EEF6  Dark base: #071628
// All spacing/sizing is responsive — derived from screen width at runtime.

// MedAcademy brand palette
// Light: Soft blue-grey neumorphic base, Royal Blue primary
// Dark:  Deep Navy base (#081A35 range), bright Royal Blue primary
//
// ── SURFACE LADDER (why these keys exist) ───────────────────────────────────
// The neumorphic system originally had ONE background token (`base`). Every
// surface — page, sidebar, card, input, modal — therefore painted the same
// colour, which is fine in Light (soft shadows separate the layers) but reads
// as flat in Dark, where shadows barely register against a deep navy field.
//
// Dark now uses an explicit luminance ladder, each step a controlled ratio of
// the previous one so no two surfaces collapse into the same shade:
//
//   base        #071628   page / app background
//   navSurface  #0B2337   sidebar, drawer, tab bar, headers      (×1.14)
//   surface     #0E2C46   cards, panels, secondary buttons       (×1.27)
//   inputSurface#0A2135   inputs, pressed, recessed containers   (×1.14)
//   elevated    #12344F   modals, menus, popovers, sheets        (×1.24)
//
// `elevated` is tuned so the brighter semantic inks used inside menus still
// clear 4.5:1 against it (see the ladder table verified by
// tests/darkModeTheme.test.cjs). Going lighter than this looks richer but
// pushes mid-tone labels under AA.
//
// In Light every one of these resolves to the original #E8EEF6, so Light Mode
// renders byte-identically to before this change — the ladder is theme-
// conditional, not a restyle. Do NOT "unify" them back to one token: that is
// the flatness bug this ladder exists to fix.
export const neuColors = {
  light: {
    /** Discriminant — lets helpers pick the right treatment from the palette
     *  alone, without threading a separate `isDark` flag through every call
     *  site. Widened to `string` (no `as const`), so both palettes stay
     *  assignable to `typeof neuColors.light` and all existing
     *  `c: typeof neuColors.light` props keep compiling. */
    mode: 'light',
    base: '#E8EEF6',
    // All surfaces collapse to `base` on purpose — Light is the reference
    // design and must not shift. Separation comes from the neumorphic shadows.
    surface: '#E8EEF6',
    navSurface: '#E8EEF6',
    inputSurface: '#E8EEF6',
    elevated: '#E8EEF6',
    shadowDark: 'rgba(160,185,215,0.78)',
    shadowLight: 'rgba(255,255,255,0.90)',
    text: '#081A35',
    // Flattened equivalents of the existing `color: text, opacity: 0.5 / 0.38`
    // idiom, so a caller that adopts the solid tiers still gets today's Light
    // appearance pixel-for-pixel.
    textMuted: '#788496',
    textSubtle: '#939DAD',
    border: 'rgba(160,185,215,0.55)',
    borderSoft: 'rgba(160,185,215,0.35)',
    divider: 'rgba(8,26,53,0.08)',
    overlay: 'rgba(8,26,53,0.45)',
    primary: '#1E90FF',
    accent: '#2DA8FF',
    // Ink that sits ON a primary-filled button. Light keeps white (unchanged).
    onPrimary: '#FFFFFF',
    success: '#16A34A',
    successSoft: 'rgba(22,163,74,0.14)',
    warning: '#B45309',
    warningSoft: 'rgba(180,83,9,0.14)',
    danger: '#DC2626',
    dangerSoft: 'rgba(220,38,38,0.12)',
    info: '#1E90FF',
    infoSoft: 'rgba(30,144,255,0.12)',
  },
  dark: {
    mode: 'dark',
    base: '#071628',
    surface: '#0E2C46',
    navSurface: '#0B2337',
    inputSurface: '#0A2135',
    elevated: '#12344F',
    shadowDark: 'rgba(4,10,22,0.72)',
    shadowLight: 'rgba(30,60,110,0.40)',
    text: '#DDE8F5',
    // Same shape as Light, but these are SOLID readable tiers. On dark, the
    // `opacity` idiom fails twice: it drags text toward the navy floor (low
    // contrast) and it hides behind a nested-parent opacity. Always prefer
    // these tokens over `color: c.text, opacity: <1`.
    textMuted: '#A9BFD6',
    // Tuned so even the faintest tier clears 4.5:1 on the LIGHTEST dark surface
    // (`elevated`, what dialogs/menus use) — #8195AC only reached 4.19:1 there.
    textSubtle: '#8FA3B8',
    border: 'rgba(125,175,225,0.18)',
    borderSoft: 'rgba(125,175,225,0.10)',
    divider: 'rgba(125,175,225,0.14)',
    overlay: 'rgba(2,6,14,0.66)',
    primary: '#3D9FFF',
    accent: '#2DA8FF',
    // Dark's accent is deliberately BRIGHTER than Light's, which drops white
    // label contrast on a primary fill to 2.77:1 — below AA. Deep navy ink on
    // the same fill measures 6.58:1, so dark primary buttons invert their ink.
    onPrimary: '#071628',
    success: '#34D399',
    successSoft: 'rgba(52,211,153,0.16)',
    warning: '#FBBF24',
    warningSoft: 'rgba(251,191,36,0.16)',
    danger: '#F87171',
    dangerSoft: 'rgba(248,113,113,0.16)',
    info: '#60A5FA',
    infoSoft: 'rgba(96,165,250,0.16)',
  },
};

/** Palette shape — identical keys in both themes, so either one is assignable. */
export type NeuPalette = typeof neuColors.light;

/** True when the palette passed is the dark one. Internal to the palette API. */
const isDarkPalette = (c: NeuPalette): boolean => c.mode === 'dark';

/**
 * mutedTextStyle — the drop-in replacement for the `{ color: c.text, opacity:
 * 0.4…0.6 }` idiom that made secondary text barely legible on dark surfaces.
 *
 * Why the idiom fails on dark: `opacity` blends the label toward whatever sits
 * behind it. Against the dark navy ladder that pulls the glyph toward the floor
 * — a 0.5 mix lands at 4.4:1 on the page and 4.0:1 on a card, 0.4 at 3.5:1 —
 * and a parent with its own opacity compounds the loss. Dark therefore uses a
 * SOLID, pre-measured tier colour at full opacity.
 *
 * Light keeps the exact original colour + opacity, so adopting this helper can
 * never alter the reference Light appearance — that invariant is asserted in
 * tests/darkModeTheme.test.cjs.
 *
 * @param opacity the Light opacity being replaced (0.3–0.6 usual). Values at or
 *                below 0.42 map to `textSubtle`, above to `textMuted`.
 */
export function mutedTextStyle(c: NeuPalette, opacity = 0.5): TextStyle {
  return isDarkPalette(c)
    ? { color: opacity <= 0.42 ? c.textSubtle : c.textMuted, opacity: 1 }
    : { color: c.text, opacity };
}


// ── Responsive spacing ───────────────────────────────────────────────────────
// Returns layout constants scaled to the current screen width.
// Aligns with ds.ts breakpoints and spacing scale — useDS() is the preferred
// hook for new code; useNeuSpacing() remains for backward compatibility.
export function useNeuSpacing() {
  const { width, height } = useWindowDimensions();
  const shortSide  = Math.min(width, height);
  const isTablet   = shortSide >= breakpoint.tablet;
  const isLarge    = shortSide >= breakpoint.large;
  const isLandscape = width > height;

  return {
    // Screen-level horizontal padding (from ds.ts spacing scale)
    screenPx:     isTablet ? spacing.xxxl : Math.round(Math.max(spacing.xl, Math.min(spacing.hero, width * 0.05))),
    // Card internal padding
    cardPx:       isTablet ? spacing.xl : spacing.lg,
    cardPy:       isTablet ? spacing.lg : spacing.md,
    // Vertical gap between sections
    sectionGap:   isTablet ? spacing.xxl : spacing.xl,
    // Small gap within a section
    itemGap:      isTablet ? spacing.md : spacing.sm,
    // Header top margin
    headerMt:     isTablet ? spacing.md : spacing.sm,
    // Icon container size
    iconSize:     isTablet ? 44 : 40,
    iconRadius:   isTablet ? radius.lg : radius.md,
    // Card border radius
    cardRadius:   isTablet ? radius.xl : radius.lg,
    // Button border radius
    btnRadius:    isTablet ? radius.lg : radius.md,
    // Tab bar height hint
    tabBarHeight: isTablet ? 68 : 56,
    // Layout helpers
    isTablet,
    isLarge,
    width,
    height,
    isLandscape,
  };
}

// ── Shadow helpers ───────────────────────────────────────────────────────────
// Android NOTE: we do NOT use `elevation` for card shadows.
// Android `elevation` adds a "material elevation overlay" tint that makes
// cards appear brighter/whiter than the neumorphic base color — the exact
// "white square inside a card" bug. Instead we use a hairline border
// (borderWidth + borderColor) to give the card visual depth, identical to
// how it looks on iOS with its soft-shadow treatment.
//
// elevation=1 → resting card  elevation=2 → pressed card (param kept for API compat)
export const neuFlatStyle = (isDark = false, elevation: 1 | 2 = 1) => {
  const c = isDark ? neuColors.dark : neuColors.light;
  const offset = elevation === 1 ? 5 : 3;
  const radius = elevation === 1 ? 12 : 6;
  const opacity = elevation === 1 ? 1 : 0.7;

  return Platform.select({
    ios: {
      backgroundColor: c.surface,
      shadowColor: c.shadowDark,
      shadowOffset: { width: offset * 0.8, height: offset * 0.8 },
      shadowOpacity: opacity,
      shadowRadius: radius,
      // Dark gets a hairline edge: a soft shadow alone cannot separate a card
      // from the page when both are deep navy. Light keeps its shadow-only
      // treatment untouched.
      ...(isDark ? { borderWidth: 1, borderColor: c.border } : null),
    },
    android: {
      // NO elevation — avoid Android material tint that causes white-layer bug.
      // Use a subtle border to signal card depth without color distortion.
      backgroundColor: c.surface,
      elevation: 0,
      borderWidth: 1,
      borderColor: c.border,
    },
    web: {
      backgroundColor: c.surface,
      boxShadow: [
        { offsetX: offset, offsetY: offset, blurRadius: radius, color: c.shadowDark },
        { offsetX: -offset * 0.8, offsetY: -offset * 0.8, blurRadius: radius * 0.8, color: c.shadowLight },
      ],
      ...(isDark ? { borderWidth: 1, borderColor: c.border } : null),
    },
    default: {
      backgroundColor: c.surface,
    },
  });
};

export const neuPressedStyle = (isDark = false) => {
  const c = isDark ? neuColors.dark : neuColors.light;
  return Platform.select({
    ios: {
      // Pressed reads as RECESSED: it steps DOWN to the input surface instead of
      // staying on the resting card tone.
      backgroundColor: c.inputSurface,
      shadowColor: c.shadowDark,
      shadowOffset: { width: 2, height: 2 },
      shadowOpacity: 0.5,
      shadowRadius: 4,
      ...(isDark ? { borderWidth: 1, borderColor: c.borderSoft } : null),
    },
    android: {
      backgroundColor: c.inputSurface,
      elevation: 0,
      borderWidth: 1,
      borderColor: isDark ? c.borderSoft : 'rgba(160,185,215,0.35)',
    },
    web: {
      backgroundColor: c.inputSurface,
      boxShadow: [
        { offsetX: 2, offsetY: 2, blurRadius: 5, color: c.shadowDark, inset: true },
        { offsetX: -2, offsetY: -2, blurRadius: 5, color: c.shadowLight, inset: true },
      ],
      ...(isDark ? { borderWidth: 1, borderColor: c.borderSoft } : null),
    },
    default: {
      backgroundColor: c.inputSurface,
    },
  });
};

// ── Micro-shadow for small elements (chips, icon badges) ─────────────────────
export const neuMicroStyle = (isDark = false) => {
  const c = isDark ? neuColors.dark : neuColors.light;
  return Platform.select({
    ios: {
      // Chips / icon badges sit ON a card, so they take the step below it
      // (inputSurface) — otherwise a chip on a dark card is invisible.
      backgroundColor: c.inputSurface,
      shadowColor: c.shadowDark,
      shadowOffset: { width: 2, height: 2 },
      shadowOpacity: 0.55,
      shadowRadius: 5,
      ...(isDark ? { borderWidth: 1, borderColor: c.borderSoft } : null),
    },
    android: {
      backgroundColor: c.inputSurface,
      elevation: 0,
      borderWidth: 1,
      borderColor: c.border,
    },
    web: {
      backgroundColor: c.inputSurface,
      boxShadow: [
        { offsetX: 2, offsetY: 2, blurRadius: 5, color: c.shadowDark },
        { offsetX: -2, offsetY: -2, blurRadius: 4, color: c.shadowLight },
      ],
      ...(isDark ? { borderWidth: 1, borderColor: c.borderSoft } : null),
    },
    default: { backgroundColor: c.inputSurface },
  });
};

export const neuStyles = StyleSheet.create({
  screen:     { flex: 1, backgroundColor: '#E8EEF6' },
  screenDark: { flex: 1, backgroundColor: '#071628' },
});
