/**
 * RoleTabShellBase — the ONE shared shell behind every non-iOS role tab layout.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The Android shell and the web shell used to be two copies of the same ~200
 * lines (provider tree, chrome context, Tabs, hidden-tab filtering, icon map,
 * tab mapping, drawer shell). Copies drift: a fix applied to one of them silently
 * misses the other, and tests then have to be duplicated per platform.
 *
 * This module owns that shared logic exactly once. It deliberately does NOT
 * import any tab bar:
 *
 *     android → RoleTabShell.android.tsx  → GlassTabBar ┐
 *     web     → RoleTabShell.tsx          → GlassTabBar ┴→ RoleTabShellBase
 *     ios     → RoleTabShell.ios.tsx      (native, untouched)
 *
 * Android and Web mount the SAME pill component (Web Preview is the design
 * review surface); only iOS differs. The bar arrives as a PROP
 * (`renderTabBar`), so the platform wrapper is the only module that names a bar
 * implementation — the shared base names none. No runtime `Platform.OS` branch
 * exists anywhere in this chain: resolution stays a pure bundler concern,
 * deterministic in dev and in production exports.
 *
 * BAR IDENTITY
 *   Wrappers build `renderTabBar` with `useCallback` over primitive theme values,
 *   so a shell re-render (profile store, security verdict, locale) re-RENDERS the
 *   bar instead of remounting it. A remount would reset the indicator animation
 *   and the drag state.
 *
 * The wrapper also supplies `screenOptions`. Both glass platforms use the one
 * shared `GLASS_TAB_BAR_SCREEN_OPTIONS` value, so the transparent-wrapper rule
 * cannot differ between Android and Web. They are module-scope constants:
 * stable identity, no object churn per render.
 */
import { t } from '@/lib/i18n';
import React from 'react';
import { View, useColorScheme } from 'react-native';
import { Tabs } from 'expo-router';
import {
  LayoutDashboard,
  Compass,
  BookOpen,
  UserCircle,
  Users,
  Smartphone,
  GraduationCap,
  Shield,
  DollarSign,
  BarChart2,
  Settings2,
  TrendingUp,
  Video,
  FileSearch,
  Circle,
} from 'lucide-react-native';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';
import { RoleTabChromeContext } from '@/lib/roleTabChrome';
import { neuColors } from '@/lib/neu';
import type { RoleTabDef } from '@/lib/nativeTabRegistry';

export interface RoleTabShellProps {
  tabs: RoleTabDef[];
  initialRouteName?: string;
  /** Student/doctor rendered visible JS-bar icons at size − 2 (original per-role convention). */
  jsIconShrink?: boolean;
}

export interface RoleTabShellBaseProps extends RoleTabShellProps {
  /**
   * The platform's bar renderer. Typed loosely on purpose: React Navigation's
   * bar props (state/descriptors/navigation/insets) are its own shape, and both
   * bar components already accept it.
   */
  renderTabBar: (props: any) => React.ReactElement;
  /** Navigator options supplied by the platform wrapper (stable object). */
  screenOptions: Record<string, any>;
}

type IconComponent = React.ComponentType<{ size?: number; color?: string }>;

/** Registry icon names → lucide components (names validated by tests). */
const ICONS: Record<string, IconComponent> = {
  LayoutDashboard,
  Compass,
  BookOpen,
  UserCircle,
  Users,
  Smartphone,
  GraduationCap,
  Shield,
  DollarSign,
  BarChart2,
  Settings2,
  TrendingUp,
  Video,
  FileSearch,
};

const lucideIcon = (name: string | undefined): IconComponent =>
  (name && ICONS[name]) || Circle;

export default function RoleTabShellBase({
  tabs,
  initialRouteName,
  jsIconShrink,
  renderTabBar,
  screenOptions,
}: RoleTabShellBaseProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  return (
    <DrawerProvider>
      <View style={{ flex: 1, backgroundColor: c.base }}>
        {/* Marks every screen inside this tab navigator as sitting under the
            floating bar, so only these reserve its height (see
            tabBarClearance.ts). Drawer/hub screens are outside this provider and
            keep their previous bottom spacing. */}
        <RoleTabChromeContext.Provider value>
        <Tabs
          initialRouteName={initialRouteName}
          // The single bar this shell renders. Supplied by the platform wrapper:
          // this module never names an implementation.
          tabBar={renderTabBar}
          screenOptions={screenOptions}
        >
          {tabs
            // Drawer-only screens are NOT tab scenes on any platform: they
            // live in the (hubs) Stack group (JS-owned history, MedAcademy
            // back button). Parity with RoleTabShell.ios.tsx — registering
            // them here would put their switches into the tab navigator's
            // history (visible via `backBehavior`) instead of the app stack.
            .filter((tab) => tab.hidden !== true)
            .map((tab) => (
            <Tabs.Screen
              key={tab.name}
              name={tab.name}
              options={{
                title: t(tab.titleKey ?? tab.title),
                tabBarIcon: ({ color, size }: { color: string; size: number }) => {
                      const Icon = lucideIcon(tab.icon);
                      return <Icon size={jsIconShrink ? size - 2 : size} color={color} />;
                    },
              }}
            />
          ))}
        </Tabs>
        </RoleTabChromeContext.Provider>
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}
