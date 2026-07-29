import { Platform, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useColorScheme } from 'react-native';
import { LayoutDashboard, Users, DollarSign, BarChart2, Settings2 } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';

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
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: c.base,
          borderTopWidth: 0,
          height: Platform.OS === 'ios' ? 82 : 64,
          paddingTop: 6,
          paddingBottom: Platform.OS === 'ios' ? 24 : 8,
          ...Platform.select({
            ios: { shadowColor: c.shadowDark, shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.55, shadowRadius: 14 },
            android: { elevation: 16 },
          }),
        },
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: `${c.text}44`,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2, marginTop: 2 },
        tabBarIconStyle: { marginBottom: 0 },
      }}
    >
      {/* ── Visible tab bar items (5 max) ── */}
      <Tabs.Screen name="sa-overview"  options={{ title: 'Dashboard', tabBarIcon: ({ color, size }) => <LayoutDashboard size={size} color={color} /> }} />
      <Tabs.Screen name="sa-users"     options={{ title: 'Users',     tabBarIcon: ({ color, size }) => <Users size={size} color={color} /> }} />
      <Tabs.Screen name="sa-finance"   options={{ title: 'Finance',   tabBarIcon: ({ color, size }) => <DollarSign size={size} color={color} /> }} />
      <Tabs.Screen name="sa-analytics" options={{ title: 'Analytics', tabBarIcon: ({ color, size }) => <BarChart2 size={size} color={color} /> }} />
      <Tabs.Screen name="sa-platform"  options={{ title: 'Platform',  tabBarIcon: ({ color, size }) => <Settings2 size={size} color={color} /> }} />

      {/* ── Drawer-only screens — hidden from tab bar ── */}
      {/* SA-native */}
      <Tabs.Screen name="sa-reports"             options={{ href: null, title: 'Reports & Logs' }} />
      <Tabs.Screen name="sa-audit"               options={{ href: null, title: 'Audit Trail' }} />

      <Tabs.Screen name="health"                 options={{ href: null, title: 'System Health' }} />
      <Tabs.Screen name="config"                 options={{ href: null, title: 'System Config' }} />
      <Tabs.Screen name="sec-dashboard"          options={{ href: null, title: 'Security Dashboard' }} />
      <Tabs.Screen name="feature-flags"          options={{ href: null, title: 'Feature Flags' }} />
      <Tabs.Screen name="maintenance"            options={{ href: null, title: 'Maintenance' }} />
      <Tabs.Screen name="branding"               options={{ href: null, title: 'Branding' }} />
      <Tabs.Screen name="revenue"                options={{ href: null, title: 'Revenue' }} />
      <Tabs.Screen name="currency"               options={{ href: null, title: 'Currency' }} />
      <Tabs.Screen name="impersonation"          options={{ href: null, title: 'Impersonation' }} />
      <Tabs.Screen name="sec-diag"               options={{ href: null, title: 'Security Logs' }} />
      <Tabs.Screen name="sec-policies"           options={{ href: null, title: 'Security Policies' }} />
      <Tabs.Screen name="content-protection"     options={{ href: null, title: 'Content Protection' }} />
      <Tabs.Screen name="violation-management"   options={{ href: null, title: 'Violation Management' }} />
      <Tabs.Screen name="trash-bin"              options={{ href: null, title: 'Trash Bin' }} />
      <Tabs.Screen name="delete-permissions"     options={{ href: null, title: 'Delete Permissions' }} />
      <Tabs.Screen name="video-providers"        options={{ href: null, title: 'Video Providers' }} />
      <Tabs.Screen name="sa-doctor-earnings"     options={{ href: null, title: 'Doctor Earnings' }} />
      {/* Admin-shell pages re-hosted inside SA shell (wrappers in this dir) */}
      <Tabs.Screen name="sa-academic"               options={{ href: null, title: 'Academic Structure' }} />
      <Tabs.Screen name="sa-credits"               options={{ href: null, title: 'Credits' }} />
      <Tabs.Screen name="sa-bulk-credits"           options={{ href: null, title: 'Bulk Credits' }} />
      <Tabs.Screen name="sa-bulk-import"            options={{ href: null, title: 'Bulk Import' }} />
      <Tabs.Screen name="sa-cms"                    options={{ href: null, title: 'CMS Pages' }} />
      <Tabs.Screen name="sa-code-history"           options={{ href: null, title: 'Code History' }} />
      <Tabs.Screen name="sa-codes"                  options={{ href: null, title: 'Activation Codes' }} />
      <Tabs.Screen name="sa-course-activation-timeline" options={{ href: null, title: 'Course Activation' }} />
      <Tabs.Screen name="sa-db-audit"               options={{ href: null, title: 'DB Audit' }} />
      <Tabs.Screen name="sa-devices"                options={{ href: null, title: 'Device Management' }} />
      <Tabs.Screen name="sa-doctor-credit-timeline" options={{ href: null, title: 'Doctor Credit Timeline' }} />
      <Tabs.Screen name="sa-enrollment-manager"     options={{ href: null, title: 'Enrollment Manager' }} />
      <Tabs.Screen name="sa-export-panel"           options={{ href: null, title: 'Export Center' }} />
      <Tabs.Screen name="sa-fraud-alerts"           options={{ href: null, title: 'Fraud Alerts' }} />
      <Tabs.Screen name="sa-courses"                options={{ href: null, title: 'Courses' }} />
      <Tabs.Screen name="sa-global-search"          options={{ href: null, title: 'Global Search' }} />
      <Tabs.Screen name="sa-notifications-center"   options={{ href: null, title: 'Notifications' }} />
      <Tabs.Screen name="sa-revenue-analytics"      options={{ href: null, title: 'Revenue Analytics' }} />
      <Tabs.Screen name="sa-storage"                options={{ href: null, title: 'Storage' }} />
      <Tabs.Screen name="sa-system-providers"       options={{ href: null, title: 'System Providers' }} />
      <Tabs.Screen name="sa-video-health"           options={{ href: null, title: 'Video Health' }} />
      <Tabs.Screen name="sa-video-monitor"          options={{ href: null, title: 'Video Monitor' }} />
      <Tabs.Screen name="sa-video-settings"         options={{ href: null, title: 'Video Settings' }} />
      {/* Doctor-shell pages re-hosted inside SA shell */}
      <Tabs.Screen name="sa-video-library"          options={{ href: null, title: 'Video Library' }} />
    </Tabs>
  );
}

export default function SuperAdminTabLayout() {
  return (
    <DrawerProvider>
      <View style={{ flex: 1 }}>
        <SuperAdminTabs />
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}
