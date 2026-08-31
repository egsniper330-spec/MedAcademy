import { useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { View, Text, TextInput, ScrollView, KeyboardAvoidingView, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Key, CheckCircle } from 'lucide-react-native';
import { redeemActivationCode } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors } from '@/lib/neu';
import { useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';

export default function ActivateCode() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const insets = useSafeAreaInsets();
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();

  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleRedeem = async () => {
    if (!code.trim()) { setError('Please enter an activation code.'); return; }
    setLoading(true);
    setError('');
    try {
      await redeemActivationCode(code.trim().toUpperCase());
      setSuccess(true);
    } catch (e: any) {
      setError(e?.message ?? 'Invalid or expired code.');
    }
    setLoading(false);
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingBottom: Math.max(insets.bottom + 16, 32),
        }}
        keyboardShouldPersistTaps="handled"
      >
        <PageHeader title="Activation Code" subtitle="Enter your code to unlock a course" />

      <View style={{ paddingHorizontal: 24, paddingTop: Math.max(insets.top + 16, 40) - 20 }}>

        {success ? (
          <NeuCard radius={22} style={{ alignItems: 'center', padding: 36 }}>
            <CheckCircle size={56} color="#16A34A" style={{ marginBottom: 16 }} />
            <Text style={{ fontSize: 20, fontWeight: '700', color: c.text, marginBottom: 8 }}>Course Unlocked!</Text>
            <Text style={{ fontSize: 14, color: c.text, opacity: 0.6, textAlign: 'center', marginBottom: 24 }}>
              You now have access to the course. Start learning!
            </Text>
            <NeuButton label="Go to My Courses" onPress={() => router.push('/(app)/(student)/my-courses' as RelativePathString)} fullWidth />
          </NeuCard>
        ) : (
          <NeuCard radius={22} style={{ padding: 24 }}>
            <View style={{ alignItems: 'center', marginBottom: 28 }}>
              <View style={{ width: 72, height: 72, borderRadius: 22, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                <Key size={36} color={c.primary} />
              </View>
            </View>

            <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, opacity: 0.55, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>
              Enter Code
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, marginBottom: 8, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.6, shadowRadius: 5 }}>
              <Key size={18} color={c.text} opacity={0.4} />
              <TextInput
                value={code}
                onChangeText={setCode}
                placeholder="XXXX-XXXX-XXXX"
                placeholderTextColor={`${c.text}55`}
                autoCapitalize="characters"
                autoCorrect={false}
                style={{ flex: 1, marginLeft: 10, fontSize: 18, color: c.text, letterSpacing: 2, fontWeight: '700' }}
              />
            </View>

            {error ? <Text style={{ color: '#DC2626', fontSize: 13, marginBottom: 12 }}>{error}</Text> : <View style={{ height: 20 }} />}

            <NeuButton label="Activate" onPress={handleRedeem} loading={loading} fullWidth />
          </NeuCard>
        )}
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
