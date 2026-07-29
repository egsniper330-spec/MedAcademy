import { View, Text, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import { ShieldPlus } from 'lucide-react-native';
import { NeuButton } from '@/components/NeuButton';
import { neuColors } from '@/lib/neu';

export default function LandingScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <View style={{ alignItems: 'center', marginBottom: 48 }}>
        <View style={{ width: 88, height: 88, borderRadius: 28, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
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
