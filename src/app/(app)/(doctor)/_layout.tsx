import { Platform, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useColorScheme } from 'react-native';
import { LayoutDashboard, BookOpen, Users, TrendingUp, UserCircle } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';

/**
 * Doctor tab layout.
 *
 * ARCHITECTURE CONTRACT — read before modifying
 * ──────────────────────────────────────────────
 * The `profile` tab MUST remain visible (no `href: null`).
 * Its backing file is (doctor)/profile.tsx.
 *
 * Do NOT add `href: null` to the profile screen or remove its Tabs.Screen
 * entry when adding future features — doing so will break the tab again.
 */
function DoctorTabs() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  return (
    <Tabs
      initialRouteName="dr-overview"
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
      {/* ── Visible tabs ── */}
      <Tabs.Screen name="dr-overview" options={{ title: 'Dashboard', tabBarIcon: ({ color, size }) => <LayoutDashboard size={size - 2} color={color} /> }} />
      <Tabs.Screen name="courses"     options={{ title: 'Courses',   tabBarIcon: ({ color, size }) => <BookOpen size={size - 2} color={color} /> }} />
      <Tabs.Screen name="students"    options={{ title: 'Students',  tabBarIcon: ({ color, size }) => <Users size={size - 2} color={color} /> }} />
      <Tabs.Screen name="dr-earnings" options={{ title: 'Earnings',  tabBarIcon: ({ color, size }) => <TrendingUp size={size - 2} color={color} /> }} />
      {/* PERMANENT — do NOT add href: null here */}
      <Tabs.Screen name="dr-profile"  options={{ title: 'Profile',   tabBarIcon: ({ color, size }) => <UserCircle size={size - 2} color={color} /> }} />

      {/* ── Hidden utility screens (not shown in tab bar) ── */}
      <Tabs.Screen name="credits"               options={{ title: 'My Credits',    href: null }} />
      <Tabs.Screen name="create-student"        options={{ title: 'Create Student', href: null }} />
      <Tabs.Screen name="student-credentials"   options={{ title: 'Credentials',    href: null }} />
      <Tabs.Screen name="bulk-import-students"  options={{ title: 'Bulk Import',    href: null }} />
      <Tabs.Screen name="video-library"         options={{ title: 'Video Library',  href: null }} />
    </Tabs>
  );
}

export default function DoctorTabLayout() {
  return (
    <DrawerProvider>
      <View style={{ flex: 1 }}>
        <DoctorTabs />
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}
