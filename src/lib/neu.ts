import { Platform, StyleSheet, useWindowDimensions } from 'react-native';

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
export const neuColors = {
  light: {
    base: '#E8EEF6',
    shadowDark: 'rgba(160,185,215,0.78)',
    shadowLight: 'rgba(255,255,255,0.90)',
    text: '#081A35',
    primary: '#1E90FF',
    accent: '#2DA8FF',
  },
  dark: {
    base: '#071628',
    shadowDark: 'rgba(4,10,22,0.72)',
    shadowLight: 'rgba(30,60,110,0.40)',
    text: '#DDE8F5',
    primary: '#3D9FFF',
    accent: '#2DA8FF',
  },
};

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
      backgroundColor: c.base,
      shadowColor: c.shadowDark,
      shadowOffset: { width: offset * 0.8, height: offset * 0.8 },
      shadowOpacity: opacity,
      shadowRadius: radius,
    },
    android: {
      // NO elevation — avoid Android material tint that causes white-layer bug.
      // Use a subtle border to signal card depth without color distortion.
      backgroundColor: c.base,
      elevation: 0,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(160,185,215,0.55)',
    },
    web: {
      backgroundColor: c.base,
      boxShadow: [
        { offsetX: offset, offsetY: offset, blurRadius: radius, color: c.shadowDark },
        { offsetX: -offset * 0.8, offsetY: -offset * 0.8, blurRadius: radius * 0.8, color: c.shadowLight },
      ],
    },
    default: {
      backgroundColor: c.base,
    },
  });
};

export const neuPressedStyle = (isDark = false) => {
  const c = isDark ? neuColors.dark : neuColors.light;
  return Platform.select({
    ios: {
      backgroundColor: c.base,
      shadowColor: c.shadowDark,
      shadowOffset: { width: 2, height: 2 },
      shadowOpacity: 0.5,
      shadowRadius: 4,
    },
    android: {
      backgroundColor: c.base,
      elevation: 0,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(160,185,215,0.35)',
    },
    web: {
      backgroundColor: c.base,
      boxShadow: [
        { offsetX: 2, offsetY: 2, blurRadius: 5, color: c.shadowDark, inset: true },
        { offsetX: -2, offsetY: -2, blurRadius: 5, color: c.shadowLight, inset: true },
      ],
    },
    default: {
      backgroundColor: c.base,
    },
  });
};

// ── Micro-shadow for small elements (chips, icon badges) ─────────────────────
export const neuMicroStyle = (isDark = false) => {
  const c = isDark ? neuColors.dark : neuColors.light;
  return Platform.select({
    ios: {
      backgroundColor: c.base,
      shadowColor: c.shadowDark,
      shadowOffset: { width: 2, height: 2 },
      shadowOpacity: 0.55,
      shadowRadius: 5,
    },
    android: {
      backgroundColor: c.base,
      elevation: 0,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(160,185,215,0.55)',
    },
    web: {
      backgroundColor: c.base,
      boxShadow: [
        { offsetX: 2, offsetY: 2, blurRadius: 5, color: c.shadowDark },
        { offsetX: -2, offsetY: -2, blurRadius: 4, color: c.shadowLight },
      ],
    },
    default: { backgroundColor: c.base },
  });
};

export const neuStyles = StyleSheet.create({
  screen:     { flex: 1, backgroundColor: '#E8EEF6' },
  screenDark: { flex: 1, backgroundColor: '#071628' },
});
