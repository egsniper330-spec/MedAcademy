import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { useColorScheme } from 'react-native';
import { LayoutDashboard, Users, DollarSign, BarChart2, Settings2 } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';
import ResponsiveTabBar from '@/components/ResponsiveTabBar';

/**
 * Super Admin tab bar — 5 core shortcuts.
 * All other sections are accessible from the DrawerNav (☰ hamburger).
 */
function SuperAdminTabs() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  return (
    <Tabs
      initialRouteName="sa-overview"
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
      screenOptions={{
        headerShown: false,
      }}
    >
      {/* ── Visible tab bar items (5 max) ── */}
      <Tabs.Screen name="sa-overview"  options={{ title: 'Dashboard', tabBarIcon: ({ color, size }) => <LayoutDashboard size={size} color={color} /> }} />
      <Tabs.Screen name="sa-users"     options={{ title: 'Users',     tabBarIcon: ({ color, size }) => <Users size={size} color={color} /> }} />
      <Tabs.Screen name="sa-finance"   options={{ title: 'Finance',   tabBarIcon: ({ color, size }) => <DollarSign size={size} color={color} /> }} />
      <Tabs.Screen name="sa-analytics" options={{ title: 'Analytics', tabBarIcon: ({ color, size }) => <BarChart2 size={size} color={color} /> }} />
      <Tabs.Screen name="sa-platform"  options={{ title: 'Platform',  tabBarIcon: ({ color, size }) => <Settings2 size={size} color={color} /> }} />
      {/* All secondary screens remain registered but hidden from the tab bar. */}

      {/* ── Drawer-only screens — hidden from tab bar ── */}
      {/* SA-native */}
      <Tabs.Screen name="sa-reports"             options={{ tabBarButton: () => null, title: 'Reports & Logs' }} />
      <Tabs.Screen name="sa-audit"               options={{ tabBarButton: () => null, title: 'Audit Trail' }} />

      <Tabs.Screen name="health"                 options={{ tabBarButton: () => null, title: 'System Health' }} />
      <Tabs.Screen name="config"                 options={{ tabBarButton: () => null, title: 'System Config' }} />
      <Tabs.Screen name="sec-dashboard"          options={{ tabBarButton: () => null, title: 'Security Dashboard' }} />
      <Tabs.Screen name="feature-flags"          options={{ tabBarButton: () => null, title: 'Feature Flags' }} />
      <Tabs.Screen name="maintenance"            options={{ tabBarButton: () => null, title: 'Maintenance' }} />
      <Tabs.Screen name="branding"               options={{ tabBarButton: () => null, title: 'Branding' }} />
      <Tabs.Screen name="revenue"                options={{ tabBarButton: () => null, title: 'Revenue' }} />
      <Tabs.Screen name="currency"               options={{ tabBarButton: () => null, title: 'Currency' }} />
      <Tabs.Screen name="impersonation"          options={{ tabBarButton: () => null, title: 'Impersonation' }} />
      <Tabs.Screen name="sec-diag"               options={{ tabBarButton: () => null, title: 'Security Logs' }} />
      <Tabs.Screen name="sec-policies"           options={{ tabBarButton: () => null, title: 'Security Policies' }} />
      <Tabs.Screen name="content-protection"     options={{ tabBarButton: () => null, title: 'Content Protection' }} />
      <Tabs.Screen name="violation-management"   options={{ tabBarButton: () => null, title: 'Violation Management' }} />
      <Tabs.Screen name="trash-bin"              options={{ tabBarButton: () => null, title: 'Trash Bin' }} />
      <Tabs.Screen name="delete-permissions"     options={{ tabBarButton: () => null, title: 'Delete Permissions' }} />
      <Tabs.Screen name="video-providers"        options={{ tabBarButton: () => null, title: 'Video Providers' }} />
      <Tabs.Screen name="sa-doctor-earnings"     options={{ tabBarButton: () => null, title: 'Doctor Earnings' }} />
      {/* Admin-shell pages re-hosted inside SA shell (wrappers in this dir) */}
      <Tabs.Screen name="sa-academic"               options={{ tabBarButton: () => null, title: 'Academic Structure' }} />
      <Tabs.Screen name="sa-credits"               options={{ tabBarButton: () => null, title: 'Credits' }} />
      <Tabs.Screen name="sa-bulk-credits"           options={{ tabBarButton: () => null, title: 'Bulk Credits' }} />
      <Tabs.Screen name="sa-bulk-import"            options={{ tabBarButton: () => null, title: 'Bulk Import' }} />
      <Tabs.Screen name="sa-cms"                    options={{ tabBarButton: () => null, title: 'CMS Pages' }} />
      <Tabs.Screen name="sa-code-history"           options={{ tabBarButton: () => null, title: 'Code History' }} />
      <Tabs.Screen name="sa-codes"                  options={{ tabBarButton: () => null, title: 'Activation Codes' }} />
      <Tabs.Screen name="sa-course-activation-timeline" options={{ tabBarButton: () => null, title: 'Course Activation' }} />
      <Tabs.Screen name="sa-db-audit"               options={{ tabBarButton: () => null, title: 'DB Audit' }} />
      <Tabs.Screen name="sa-devices"                options={{ tabBarButton: () => null, title: 'Device Management' }} />
      <Tabs.Screen name="sa-doctor-credit-timeline" options={{ tabBarButton: () => null, title: 'Doctor Credit Timeline' }} />
      <Tabs.Screen name="sa-enrollment-manager"     options={{ tabBarButton: () => null, title: 'Enrollment Manager' }} />
      <Tabs.Screen name="sa-export-panel"           options={{ tabBarButton: () => null, title: 'Export Center' }} />
      <Tabs.Screen name="sa-fraud-alerts"           options={{ tabBarButton: () => null, title: 'Fraud Alerts' }} />
      <Tabs.Screen name="sa-courses"                options={{ tabBarButton: () => null, title: 'Courses' }} />
      <Tabs.Screen name="sa-global-search"          options={{ tabBarButton: () => null, title: 'Global Search' }} />
      <Tabs.Screen name="sa-notifications-center"   options={{ tabBarButton: () => null, title: 'Notifications' }} />
      <Tabs.Screen name="sa-revenue-analytics"      options={{ tabBarButton: () => null, title: 'Revenue Analytics' }} />
      <Tabs.Screen name="sa-storage"                options={{ tabBarButton: () => null, title: 'Storage' }} />
      <Tabs.Screen name="sa-system-providers"       options={{ tabBarButton: () => null, title: 'System Providers' }} />
      <Tabs.Screen name="sa-video-health"           options={{ tabBarButton: () => null, title: 'Video Health' }} />
      <Tabs.Screen name="sa-video-monitor"          options={{ tabBarButton: () => null, title: 'Video Monitor' }} />
      <Tabs.Screen name="sa-video-settings"         options={{ tabBarButton: () => null, title: 'Video Settings' }} />
      {/* Doctor-shell pages re-hosted inside SA shell */}
      <Tabs.Screen name="sa-video-library"          options={{ tabBarButton: () => null, title: 'Video Library' }} />
      {/* Wrapper re-exports from admin shell — hidden from tab bar */}
      <Tabs.Screen name="sa-admin-credits"          options={{ tabBarButton: () => null, title: 'Admin Credits' }} />
      <Tabs.Screen name="sa-batch-management"       options={{ tabBarButton: () => null, title: 'Batch Management' }} />
      <Tabs.Screen name="sa-support-settings"       options={{ tabBarButton: () => null, title: 'Support Settings' }} />
    </Tabs>
  );
}

export default function SuperAdminTabLayout() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <DrawerProvider>
      <View style={{ flex: 1, backgroundColor: c.base }}>
        <SuperAdminTabs />
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}
