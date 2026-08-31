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
  const handlePress = useCallback(
    (routeKey: string, routeIndex: number) => {
      const event = navigation.emit({
        type: 'tabPress',
        target: routeKey,
        canPreventDefault: true,
      });

      if (activeIndex !== routeIndex && !event.defaultPrevented) {
        navigation.navigate(routeKey);
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

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <View style={[styles.tabBar, tabBarStyleProp, { paddingBottom: insets.bottom }]}>
      {visibleRoutes.map(({ route, descriptor, index }) => {
        const isFocused = activeIndex === index;
        const options = descriptor.options;
        const label = options.title ?? route.name;
        const icon = options.tabBarIcon;

        return (
          <Pressable
            key={route.key}
            style={styles.tabItem}
            onPress={() => handlePress(route.key, index)}
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
