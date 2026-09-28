/**
 * HUBS STACK GROUP — drawer-only ("hidden") screens live here, NOT inside the
 * role tab navigators.
 *
 * WHY THIS GROUP EXISTS (iOS 26 Liquid Glass back-button fix):
 *
 * These screens used to be registered as `tabBarItemHidden` scenes inside each
 * role's NATIVE tab navigator (react-native-bottom-tabs). On iOS 26 the system
 * tab bar adds its own back affordance whose destination is the NATIVE tab
 * history — which contained exactly these scene switches (e.g. sa-platform →
 * sa-devices reached "through" the Platform tab). Tapping the system back
 * therefore landed on More → Platform → Devices instead of the previous
 * MedAcademy screen, and it appeared ALONGSIDE the app's own PageHeader back
 * button (duplicate back UI, two different histories).
 *
 * Neither react-native-bottom-tabs 1.4.0 nor iOS 26 UIKit exposes a supported
 * way to hide that system back affordance while keeping the native (Liquid
 * Glass) bar, nor to re-point it at the JS/Expo history. The correct
 * architecture is therefore to keep these screens OUT of the tab navigators
 * entirely: they are plain Stack screens here, so
 *
 *   • the (app) root Stack owns their push/pop (the JS/Expo history),
 *   • the MedAcademy PageHeader back button is the ONLY back control on them,
 *   • the native tab navigator only ever contains real, visible bar tabs, so
 *     iOS has no tab-history entry to offer a system back button for,
 *   • the Liquid Glass bottom bar stays untouched on every role tab screen.
 *
 * SHELL CONTRACT: identical to the role tab groups — DrawerProvider wraps the
 * content so PageHeader's hamburger works, and DrawerNav overlays the group
 * (screen-level page content keeps the header; navigation behavior is
 * unchanged for every existing route: all paths keep their exact URLs).
 *
 * Android/web are unaffected: RoleTabShell.tsx renders the same JS Tabs as
 * before (its hidden registry entries are filtered there too, and the (hubs)
 * Stack resolves identically on every platform).
 */
import { View, useColorScheme } from 'react-native';
import { Stack } from 'expo-router';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';
import { neuColors } from '@/lib/neu';

export default function HubsLayout() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  return (
    <DrawerProvider>
      <View style={{ flex: 1, backgroundColor: c.base }}>
        {/* headerShown:false — every hub screen renders its own PageHeader
            (title + hamburger/back + safe area), same as the tab screens.
            The native-stack swipe-back gesture remains available. */}
        <Stack screenOptions={{ headerShown: false }} />
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}

// route-identity-note-v2
