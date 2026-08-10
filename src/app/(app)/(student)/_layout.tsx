import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { useColorScheme } from 'react-native';
import { LayoutDashboard, Compass, BookOpen, UserCircle } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';

function StudentTabs() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  return (
    <Tabs
      initialRouteName="dashboard"
      screenOptions={{
        headerShown: false,
        // DO NOT set height or paddingBottom manually — React Navigation + SafeAreaProvider
        // handles the bottom inset automatically via the native window insets API.
        // Setting height/paddingBottom manually breaks Android 3-button nav and gesture nav.
        tabBarStyle: {
          backgroundColor: c.base,
          borderTopWidth: 0,
          paddingTop: 8,
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
      <Tabs.Screen name="dashboard"  options={{ title: 'Home',       tabBarIcon: ({ color, size }) => <LayoutDashboard size={size - 2} color={color} /> }} />
      <Tabs.Screen name="explore"    options={{ title: 'Explore',    tabBarIcon: ({ color, size }) => <Compass size={size - 2} color={color} /> }} />
      <Tabs.Screen name="my-courses" options={{ title: 'My Courses', tabBarIcon: ({ color, size }) => <BookOpen size={size - 2} color={color} /> }} />
      <Tabs.Screen name="profile"    options={{ title: 'Profile',    tabBarIcon: ({ color, size }) => <UserCircle size={size - 2} color={color} /> }} />
      <Tabs.Screen name="activate"   options={{ href: null, title: 'Activate' }} />
    </Tabs>
  );
}

export default function StudentTabLayout() {
  return (
    <DrawerProvider>
      <View style={{ flex: 1 }}>
        <StudentTabs />
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}
