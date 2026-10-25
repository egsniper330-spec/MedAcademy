/**
 * RoleTabShell — the shared wrapper around each role's tab navigator.
 *
 * PLATFORM SPLIT (file resolution: `.ios.tsx` wins on iOS, `.tsx` covers
 * Android/web/other) — Android and web behavior is byte-for-byte the
 * previous implementation.
 *
 *  • iOS    → REAL native system tab bar via react-native-bottom-tabs
 *             (SwiftUI TabView / UITabBar under the hood). On iOS 26 Apple
 *             renders this bar as a floating Liquid Glass container and
 *             derives its material from the content scrolling behind it —
 *             this is the genuine system effect, not a BlurView imitation.
 *             We deliberately set NO bar background/blur: forcing one would
 *             defeat the system glass derivation. Tint follows the existing
 *             neu theme. Older iOS versions automatically get the standard
 *             native system tab bar (pod deployment target stays 14.0).
 *  • Others → unchanged JS `Tabs` + ResponsiveTabBar. On web the custom
 *             `tabBar` prop is already a no-op (web renders DrawerNav only).
 *
 * Routes: ONLY the role's visible bar tabs are registered. Drawer-only
 * screens intentionally do NOT participate in the native tab navigator —
 * on iOS 26 the system back affordance walks the native tab history, which
 * previously included those hidden-scene switches (More → Platform →
 * Devices) and produced a duplicate back button landing on the wrong
 * screen. They now live in the (hubs) Stack group (JS-owned history) —
 * see (hubs)/_layout.tsx. DrawerNav remains a sibling of the navigator
 * (outside the tab scenes), exactly as before.
 */
import { t, useTranslation } from '@/lib/i18n';
import { View, useColorScheme } from 'react-native';
import { createNativeBottomTabNavigator } from '@bottom-tabs/react-navigation';
import { withLayoutContext } from 'expo-router';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';
import { neuColors } from '@/lib/neu';
import type { RoleTabDef } from '@/lib/nativeTabRegistry';

/**
 * The raw navigator wrapped with Expo Router's withLayoutContext, giving
 * declarative `.Screen` registration (same convention as Tabs.Screen) while
 * keeping the native SwiftUI/UITabBar rendering of react-native-bottom-tabs.
 */
const NativeBottomTabs = withLayoutContext(createNativeBottomTabNavigator().Navigator);

export interface RoleTabShellProps {
  /** Screen registry — MUST list every route file in the role directory. */
  tabs: RoleTabDef[];
  /** Initial tab (dashboard). Forwarded to the router like JS Tabs. */
  initialRouteName?: string;
}

export default function RoleTabShell({ tabs, initialRouteName }: RoleTabShellProps) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  /**
   * ── ARABIC TAB ORDER ON THE NATIVE BAR (ROOT-CAUSE FIX) ──────────────────
   * The previous implementation REVERSED the `<Screen>` array when the app
   * locale and `I18nManager.isRTL` disagreed. That never worked, and the reason
   * is structural rather than cosmetic: this navigator is wrapped with Expo
   * Router's `withLayoutContext`, and the route list comes from the router's
   * OWN file-system order (`useSortedScreens` → `getSortedChildren`). The JSX
   * children only supply per-screen config and are re-sorted by name, so
   * reversing them changed nothing — the bar stayed LTR and Profile sat at the
   * far right in Arabic (the reported bug), while the test that only checked
   * "we reversed the array" passed.
   *
   * The library exposes the correct mechanism: `layoutDirection`
   * ('ltr' | 'rtl' | 'locale'), applied natively as SwiftUI's
   * `.environment(\.layoutDirection, …)`, which mirrors the real UITabBar.
   * Driving it from the APP locale gives one authoritative mirror that is
   * correct before and after the native RTL relaunch, and it can never
   * double-reverse with the system because the system is being told the value
   * instead of being second-guessed.
   *
   * Routes are untouched: screen names, icons, `initialRouteName`, deep links
   * and `backBehavior="history"` all still key off `tab.name`.
   */
  const { isRTL: appRTL } = useTranslation();
  const visibleTabs = tabs.filter((tab) => tab.hidden !== true);

  return (
    <DrawerProvider>
      <View style={{ flex: 1, backgroundColor: c.base }}>
        <NativeBottomTabs
          initialRouteName={initialRouteName}
          // The ONE mirror for the Arabic bar: Home rightmost, Profile leftmost
          // (English keeps Home leftmost). See the block above.
          layoutDirection={appRTL ? 'rtl' : 'ltr'}
          // Back within the tab navigator follows the ACTUAL visit order of
          // the visible tabs (tab switching never fabricates stack history —
          // duplicates are dropped), so any native back affordance stays in
          // sync with MedAcademy navigation instead of jumping to an
          // arbitrary previously-mounted scene.
          backBehavior="history"
          tabBarActiveTintColor={c.primary}
          // Inactive items: Light keeps the JS bar's translucent text mix. Dark
          // uses the solid `textMuted` tier — a 40%-alpha tint over a deep navy
          // field falls below AA, and the native bar draws it over its own glass.
          tabBarInactiveTintColor={isDark ? c.textMuted : `${c.text}66`}
          // iPad keeps a BOTTOM bar (current behavior) instead of the iOS 18
          // sidebar adaptation; phones are unaffected by this option.
          sidebarAdaptable={false}
          // No bar background/blur is forced — iOS 26 derives Liquid Glass
          // from the content behind the bar. Older iOS gets the native
          // translucent default. No fake glass approximation anywhere.
        >
          {visibleTabs
            // Drawer-only screens are NOT native tab scenes (see file header):
            // registering them lets iOS 26's system back affordance walk
            // tab-scene history (duplicate back button, wrong destination).
            .map((tab) => (
            <NativeBottomTabs.Screen
              key={tab.name}
              name={tab.name}
              options={{
                title: t(tab.titleKey ?? tab.title),
                // Native SF Symbol icon — the system renders
                // selected/unselected states; no duplicated icon layer.
                tabBarIcon: () => ({ sfSymbol: tab.sfSymbol! }),
              }}
            />
          ))}
        </NativeBottomTabs>
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}
