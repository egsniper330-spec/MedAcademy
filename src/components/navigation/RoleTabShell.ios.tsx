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
import { View, useColorScheme, I18nManager } from 'react-native';
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
   * ── ARABIC TAB ORDER ON THE NATIVE BAR ───────────────────────────────────
   * UITabBar/SwiftUI mirrors its items when the app's semantic content
   * direction is RTL, i.e. `I18nManager.isRTL`. That state only exists AFTER
   * the native relaunch that `applyRTL()` schedules, so on the launch where the
   * user switches to Arabic the bar is still LTR. Rather than assume either
   * way, the array is reversed EXACTLY when the app's direction and the native
   * chrome's direction disagree — which is the only case where the system will
   * not produce the required order by itself:
   *
   *   app RTL + platform LTR → reverse  (system draws LTR: Home would be left)
   *   app RTL + platform RTL → as-is    (system already mirrors: Home right)
   *   app LTR + platform LTR → as-is    (English order, correct)
   *   app LTR + platform RTL → reverse  (system would mirror: cancel it)
   *
   * Only the RENDER ORDER changes — screen names, icons, `initialRouteName`,
   * deep links and `backBehavior="history"` all still key off `tab.name`.
   */
  const { isRTL: appRTL } = useTranslation();
  const platformRTL = (() => {
    try {
      return I18nManager.isRTL === true;
    } catch {
      return false;
    }
  })();
  const needsManualMirror = appRTL !== platformRTL;
  const visibleTabs = tabs.filter((tab) => tab.hidden !== true);
  const orderedTabs = needsManualMirror ? [...visibleTabs].reverse() : visibleTabs;

  return (
    <DrawerProvider>
      <View style={{ flex: 1, backgroundColor: c.base }}>
        <NativeBottomTabs
          initialRouteName={initialRouteName}
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
          {orderedTabs
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
