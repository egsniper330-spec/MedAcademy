/**
 * ResponsiveTabBar — shared bottom tab bar for all roles.
 *
 * ROOT CAUSE this fixes:
 * React Navigation's default BottomTabBar renders ALL registered screens
 * as flex children — even those hidden with `tabBarButton: () => null`.
 * On web, each hidden screen creates an empty <div> that still occupies
 * flex space, compressing the visible tabs into tiny slivers (e.g. 8px each).
 *
 * SOLUTION:
 * This custom tab bar receives the standard React Navigation tab bar props,
 * pre-filters routes to only visible ones, then renders each with `flex: 1`
 * for correct horizontal distribution across any screen size.
 *
 * Used by: Student, Doctor, Admin, Super Admin layouts.
 */
import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/* ── Types (loose to avoid importing @react-navigation/bottom-tabs) ── */
interface Props {
  state: any;
  descriptors: any;
  navigation: any;
  activeTintColor?: string;
  inactiveTintColor?: string;
  labelStyle?: any;
  style?: any;
}

export default function ResponsiveTabBar({
  state,
  descriptors,
  navigation,
  activeTintColor,
  inactiveTintColor,
  style: tabBarStyleProp,
  labelStyle: labelStyleProp,
}: Props) {
  const insets = useSafeAreaInsets();

  const { routes, index: activeIndex } = state;

  // ── Filter visible routes ──────────────────────────────────────────────
  // A route is visible if its tabBarButton callback (if any) would return
  // a non-null element. We detect hidden tabs by checking if the descriptor
  // has `tabBarButton` set to a function — we call it with minimal props
  // and if it returns null/falsy, we skip that route.
  //
  // Additionally, if `href` is explicitly null (Expo Router), the route
  // should also be hidden.
  const visibleRoutes: Array<{
    route: any;
    descriptor: any;
    index: number;
  }> = [];

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const descriptor = descriptors[route.key];
    if (!descriptor) continue;

    const options = descriptor.options;

    // Check if explicitly hidden via Expo Router's href: null
    if (options.href === null) continue;

    // Check if tabBarButton returns null (React Navigation's mechanism)
    // Expo Router sets `tabBarButton: () => null` for screens with href: null.
    // We must NOT call the function with mock props (it may throw).
    // Instead, detect the pattern: a function that returns null.
    // Expo Router's hidden-tab tabBarButton is typically a no-op that returns null.
    // We also check route.href which Expo Router sets on the route object.
    const isHiddenViaTabBarButton = typeof options.tabBarButton === 'function';
    const isHiddenViaHref = options.href === null || (route as any).href === null;
    const isHiddenViaTitle = options.tabBarLabel === undefined && options.tabBarIcon === undefined && !options.title;
    
    if (isHiddenViaTabBarButton || isHiddenViaHref) {
      continue;
    }

    visibleRoutes.push({ route, descriptor, index: i });
  }

  // ── Press handler ──────────────────────────────────────────────────────
  // IMPORTANT: Use route.name for navigation, NOT route.key.
  // On web, Expo Router / React Navigation generates route keys with content
  // hashes (e.g. "sa-users-WQvPVpgVuEyYNeNBOW7"). Passing a hashed key to
  // navigation.navigate() fails because it matches neither the internal route
  // key (which has a navigator prefix) nor the screen name (which has no hash).
  // route.key is still used for emit targets (event routing by key is correct).
  const handlePress = useCallback(
    (routeKey: string, routeIndex: number, routeName: string) => {
      const event = navigation.emit({
        type: 'tabPress',
        target: routeKey,
        canPreventDefault: true,
      });

      if (activeIndex !== routeIndex && !event.defaultPrevented) {
        navigation.navigate(routeName);
      }
    },
    [navigation, activeIndex],
  );

  const handleLongPress = useCallback(
    (routeKey: string) => {
      navigation.emit({ type: 'tabLongPress', target: routeKey });
    },
    [navigation],
  );

  // ── Render ─────────────────────────────────────────────────────────
  // Bottom padding: on devices with a gesture bar / 3-button nav the OS inset
  // governs (bar content sits above the system UI). On inset-less surfaces
  // (web preview, desktop) insets.bottom = 0, so a minimum floor keeps the
  // labels from clipping flush against the screen edge. Math.max guarantees
  // the floor never SHRINKS a real device's inset — it only fills the gap.
  // ── Render ─────────────────────────────────────────────────────────
  // This tab bar is the SINGLE source of truth for all bottom spacing.
  // Screen-level paddingBottom should NOT be added — this component handles
  // the full safe-area + breathing room for all roles.
  //
  // Bottom padding: on devices with a gesture bar / 3-button nav the OS inset
  // governs (bar content sits above the system UI). On inset-less surfaces
  // (web preview, desktop) insets.bottom = 0, so a minimum floor keeps the
  // labels from clipping flush against the screen edge.
  //
  // Top padding: breathing room between screen content and the tab bar.
  const bottomPad = Math.max(insets.bottom, MIN_BOTTOM_PAD);
  return (
    <View style={[styles.tabBar, tabBarStyleProp, { paddingTop: TOP_BREATHING, paddingBottom: bottomPad, minHeight: MIN_BAR_HEIGHT + bottomPad }]}>
      {visibleRoutes.map(({ route, descriptor, index }) => {
        const isFocused = activeIndex === index;
        const options = descriptor.options;
        const label = options.title ?? route.name;
        const icon = options.tabBarIcon;

        return (
          <Pressable
            key={route.key}
            style={styles.tabItem}
            onPress={() => handlePress(route.key, index, route.name)}
            onLongPress={() => handleLongPress(route.key)}
            accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
            accessibilityRole="button"
            accessibilityState={{ selected: isFocused }}
            testID={options.tabBarTestID}
          >
            {icon
              ? icon({
                  focused: isFocused,
                  color: isFocused
                    ? (activeTintColor ?? '#007AFF')
                    : (inactiveTintColor ?? 'rgba(0,0,0,0.3)'),
                  size: 22,
                })
              : null}
            <Text
              style={[
                styles.label,
                labelStyleProp,
                {
                  color: isFocused
                    ? (activeTintColor ?? '#007AFF')
                    : (inactiveTintColor ?? 'rgba(0,0,0,0.3)'),
                },
              ]}
              numberOfLines={1}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ── Layout floors ──────────────────────────────────────────────────
 * MIN_BOTTOM_PAD: comfortable clearance below tab labels on surfaces that
 *   report no safe-area inset (web/desktop). Real device insets (34dp gesture
 *   bar, 48dp 3-button nav) always exceed this and govern instead.
 * MIN_BAR_HEIGHT: tap-target height for the icon+label cluster itself
 *   (Material/HIG minimum ~48dp) before the bottom padding is added.
 * TOP_BREATHING: gap between screen content and top edge of tab bar.
 */
const MIN_BOTTOM_PAD = 12;
const MIN_BAR_HEIGHT = 48;
const TOP_BREATHING = 8;

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 0,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
    paddingTop: 6,
    // Each tab takes equal share of available width via flex: 1
  },
  label: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.2,
    marginTop: 2,
    textAlign: 'center',
    // Prevent label overflow on very narrow screens
    maxWidth: '100%',
  },
});
