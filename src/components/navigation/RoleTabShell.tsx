/**
 * RoleTabShell — Android / Web / other platforms.
 *
 * UNCHANGED from the previous implementation: JS `Tabs` with ResponsiveTabBar
 * and the neu-themed bar style, plus DrawerNav inside the same wrapper. On web
 * the custom `tabBar` prop is already a no-op (web renders DrawerNav only);
 * on Android this is the existing Material-ish neu bar — untouched by the
 * iOS Liquid Glass work.
 *
 * Icons: the registry carries lucide export NAMES; this shell owns the
 * name→component map via explicit named imports (the project's babel lucide
 * plugin only supports named identifier imports — namespace imports break
 * the web bundle).
 */
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
  Circle,
} from 'lucide-react-native';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';
import ResponsiveTabBar from '@/components/ResponsiveTabBar';
import { neuColors } from '@/lib/neu';
import type { RoleTabDef } from '@/lib/nativeTabRegistry';

export interface RoleTabShellProps {
  tabs: RoleTabDef[];
  initialRouteName?: string;
  /** Student/doctor rendered visible JS-bar icons at size − 2 (original per-role convention). */
  jsIconShrink?: boolean;
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
};

const lucideIcon = (name: string | undefined): IconComponent =>
  (name && ICONS[name]) || Circle;

export default function RoleTabShell({ tabs, initialRouteName, jsIconShrink }: RoleTabShellProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  return (
    <DrawerProvider>
      <View style={{ flex: 1, backgroundColor: c.base }}>
        <Tabs
          initialRouteName={initialRouteName}
          tabBar={(props) => (
            <ResponsiveTabBar
              {...props}
              activeTintColor={c.primary}
              inactiveTintColor={`${c.text}44`}
              labelStyle={{ fontSize: 10, fontWeight: '700', letterSpacing: 0.2, marginTop: 2 }}
              style={{
                backgroundColor: c.base,
                borderTopWidth: 0,
                shadowColor: c.shadowDark,
                shadowOffset: { width: 0, height: -4 },
                shadowOpacity: 0.45,
                shadowRadius: 12,
                elevation: 16,
              }}
            />
          )}
          screenOptions={{ headerShown: false }}
        >
          {tabs.map((tab) => (
            <Tabs.Screen
              key={tab.name}
              name={tab.name}
              options={{
                title: tab.title,
                href: tab.hidden ? null : undefined,
                tabBarIcon: tab.hidden
                  ? undefined
                  : ({ color, size }: { color: string; size: number }) => {
                      const Icon = lucideIcon(tab.icon);
                      return <Icon size={jsIconShrink ? size - 2 : size} color={color} />;
                    },
              }}
            />
          ))}
        </Tabs>
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}
