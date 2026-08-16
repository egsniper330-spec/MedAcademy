import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { useColorScheme } from 'react-native';
import { LayoutDashboard, Users, Smartphone, Ticket, Shield, GraduationCap } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';

function AdminTabs() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  return (
    <Tabs
      initialRouteName="admin-overview"
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: c.base,
          borderTopWidth: 0,
          // No paddingTop — React Navigation + SafeAreaProvider handles bottom
          // inset automatically. Fixed paddingTop causes icon/label misalignment
          // across device sizes.
          shadowColor: c.shadowDark,
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.45,
          shadowRadius: 12,
          elevation: 16,
        },
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: `${c.text}44`,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2, marginTop: 2 },
        tabBarIconStyle: { marginBottom: 0 },
      }}
    >
      <Tabs.Screen name="admin-overview"       options={{ title: 'Dashboard', tabBarIcon: ({ color, size }) => <LayoutDashboard size={size} color={color} /> }} />
      <Tabs.Screen name="users"                options={{ title: 'Users',     tabBarIcon: ({ color, size }) => <Users size={size} color={color} /> }} />
      <Tabs.Screen name="devices"              options={{ title: 'Devices',   tabBarIcon: ({ color, size }) => <Smartphone size={size} color={color} /> }} />
      <Tabs.Screen name="codes"                options={{ title: 'Codes',     tabBarIcon: ({ color, size }) => <Ticket size={size} color={color} /> }} />
      <Tabs.Screen name="academic"             options={{ title: 'Academic',  tabBarIcon: ({ color, size }) => <GraduationCap size={size} color={color} /> }} />
      <Tabs.Screen name="audit"                options={{ title: 'Audit',     tabBarIcon: ({ color, size }) => <Shield size={size} color={color} /> }} />
      {/* Drawer-only screens */}
      <Tabs.Screen name="bulk-import"           options={{ href: null, title: 'Bulk Import' }} />
      <Tabs.Screen name="notifications-center" options={{ href: null, title: 'Notifications' }} />
      <Tabs.Screen name="global-search"        options={{ href: null, title: 'Search' }} />
      <Tabs.Screen name="reports"              options={{ href: null, title: 'Reports' }} />
      <Tabs.Screen name="storage"              options={{ href: null, title: 'Storage' }} />
      <Tabs.Screen name="video-monitor"        options={{ href: null, title: 'Video Monitor' }} />
      <Tabs.Screen name="video-health"         options={{ href: null, title: 'Video Health' }} />
      <Tabs.Screen name="video-settings"       options={{ href: null, title: 'Video Settings' }} />
      <Tabs.Screen name="cms"                  options={{ href: null, title: 'CMS Pages' }} />
      <Tabs.Screen name="admin-credits"        options={{ href: null, title: 'Credits' }} />
      <Tabs.Screen name="code-history"         options={{ href: null, title: 'Code History' }} />

      <Tabs.Screen name="bulk-credits"                 options={{ href: null, title: 'Bulk Credits' }} />
      <Tabs.Screen name="revenue-analytics"            options={{ href: null, title: 'Revenue Analytics' }} />
      <Tabs.Screen name="doctor-earnings"             options={{ href: null, title: 'Doctor Earnings' }} />
      <Tabs.Screen name="doctor-credit-timeline"       options={{ href: null, title: 'Doctor Timeline' }} />
      <Tabs.Screen name="course-activation-timeline"   options={{ href: null, title: 'Course Timeline' }} />
      <Tabs.Screen name="admin-settings"               options={{ href: null, title: 'Settings' }} />
      <Tabs.Screen name="system-providers"              options={{ href: null, title: 'System Providers' }} />
      {/* v68: Production Hardening screens */}
      <Tabs.Screen name="export-panel"                  options={{ href: null, title: 'Export Center' }} />
      {/* v149: Admin enrollment management */}
      <Tabs.Screen name="enrollment-manager"            options={{ href: null, title: 'Enrollment Manager' }} />

    </Tabs>
  );
}

export default function AdminTabLayout() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <DrawerProvider>
      <View style={{ flex: 1, backgroundColor: c.base }}>
        <AdminTabs />
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}
