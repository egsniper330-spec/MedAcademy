import { useEffect } from 'react';
import { View, Text, ActivityIndicator, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import { ShieldPlus } from 'lucide-react-native';
import { NeuButton } from '@/components/NeuButton';
import { neuColors } from '@/lib/neu';
import { useSession } from '@/ctx';

export default function LandingScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const { session, isLoading } = useSession();

  // Once session resolves, redirect away from landing:
  // - logged-in users go straight into the app shell
  // - logged-out users stay here (the landing page IS the unauthenticated home)
  useEffect(() => {
    if (isLoading) return;
    if (session) {
      // Enter the authenticated shell without assuming a student route.
      // AppLayout resolves the backend-verified role and redirects once the profile loads.
      router.replace('/sa-overview' as any);
    }
    // No session → remain on this screen (Sign In / Create Account buttons shown below)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, session]);

  // Show spinner while session hydrates
  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#1E90FF" />
      </View>
    );
  }

  // Logged-in users are redirected above; only render landing UI for unauthenticated users
  if (session) {
    // Still redirecting — show blank spinner to avoid flash
    return (
      <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#1E90FF" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <View style={{ alignItems: 'center', marginBottom: 48 }}>
        <View style={{
          width: 88, height: 88, borderRadius: 28,
          backgroundColor: c.primary, alignItems: 'center',
          justifyContent: 'center', marginBottom: 20,
        }}>
          <ShieldPlus size={44} color="#fff" />
        </View>
        <Text style={{ fontSize: 34, fontWeight: '800', color: c.text, letterSpacing: -0.5 }}>MedAcademy</Text>
        <Text style={{ fontSize: 16, color: c.text, opacity: 0.55, marginTop: 6, textAlign: 'center' }}>
          Best Educational Platform
        </Text>
      </View>
      <NeuButton label="Sign In" onPress={() => router.push('/(auth)/sign-in')} fullWidth style={{ marginBottom: 14 }} />
      <NeuButton label="Create Account" onPress={() => router.push('/(auth)/sign-up')} variant="secondary" fullWidth />
    </View>
  );
}
