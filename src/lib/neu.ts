import { Platform, StyleSheet, useWindowDimensions } from 'react-native';

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
// Phones (~375-430): compact values. Tablets/iPads (>=768): generous values.
export function useNeuSpacing() {
  const { width, height } = useWindowDimensions();
  // In landscape the shorter dimension is height; use the smaller of the two
  // to drive padding decisions so a phone rotated sideways doesn't suddenly get
  // tablet-sized gutters.
  const shortSide = Math.min(width, height);
  const isTablet  = shortSide >= 768;
  const isLarge   = shortSide >= 1024;

  // Horizontal content padding — clamped so content never hugs the edge in
  // landscape (where width can be 844 on iPhone 14) and stays comfortable on
  // a true tablet.  Formula: max(20, min(48, width * 0.05))
  const screenPxRaw = Math.round(Math.max(20, Math.min(48, width * 0.05)));

  return {
    // Screen-level horizontal padding
    screenPx:    isTablet ? 32 : isLarge ? 48 : screenPxRaw,
    // Card internal padding
    cardPx:      isTablet ? 20 : 16,
    cardPy:      isTablet ? 18 : 14,
    // Vertical gap between sections
    sectionGap:  isTablet ? 28 : 20,
    // Small gap within a section
    itemGap:     isTablet ? 12 : 10,
    // Header top margin (below safe-area — header also has SafeArea inset)
    headerMt:    isTablet ? 12 : 8,
    // Icon container size
    iconSize:    isTablet ? 44 : 38,
    iconRadius:  isTablet ? 14 : 12,
    // Card border radius
    cardRadius:  isTablet ? 22 : 18,
    // Button border radius
    btnRadius:   isTablet ? 16 : 14,
    // Tab bar height hint
    tabBarHeight: isTablet ? 68 : 60,
    // Whether this is a tablet layout
    isTablet,
    isLarge,
    width,
    height,
    isLandscape: width > height,
  };
}

// ── Shadow helpers ───────────────────────────────────────────────────────────
// elevation=1 → resting card  elevation=2 → pressed card
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
      backgroundColor: c.base,
      elevation: elevation === 1 ? 4 : 2,
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
      elevation: 1,
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
    android: { backgroundColor: c.base, elevation: 2 },
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
