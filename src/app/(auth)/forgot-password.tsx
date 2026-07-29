// =============================================================================
// DISABLED_FEATURE: email-password-reset
// This screen is temporarily disabled for this release.
// - Email verification, forgot-password, and reset-password flows are removed.
// - Password changes are handled from the authenticated Profile page (in-app).
// To re-enable: add the "Forgot Password?" link back in sign-in.tsx
//               and remove this comment block.
// =============================================================================

import { useState } from 'react';
import {
  View, Text, TextInput, KeyboardAvoidingView, ScrollView, useColorScheme,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Mail } from 'lucide-react-native';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { BrandLogo } from '@/components/BrandLogo';
import { neuColors } from '@/lib/neu';

export default function ForgotPassword() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleReset = async () => {
    if (!email.trim()) { setError('Please enter your email.'); return; }
    setLoading(true);
    setError('');
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase());
    if (resetError) { setError(resetError.message); setLoading(false); return; }
    setSent(true);
    setLoading(false);
  };

  const inputStyle = {
    flexDirection: 'row' as const, alignItems: 'center' as const,
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13,
    marginBottom: 14,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.6, shadowRadius: 5,
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          padding: 24,
          paddingTop: Math.max(insets.top + 16, 40),
          paddingBottom: Math.max(insets.bottom + 16, 32),
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Logo */}
        <View style={{ alignItems: 'center', marginBottom: 28 }}>
          <BrandLogo variant="auto" size={52} />
        </View>
        <Text style={{ fontSize: 28, fontWeight: '800', color: c.text, marginBottom: 8 }}>Reset Password</Text>
        <Text style={{ fontSize: 14, color: c.text, opacity: 0.55, marginBottom: 32 }}>
          {"Enter your email and we'll send you a reset link."}
        </Text>

        {sent ? (
          <NeuCard radius={20} style={{ padding: 24, alignItems: 'center' }}>
            <Mail size={48} color={c.primary} style={{ marginBottom: 16 }} />
            <Text style={{ fontSize: 18, fontWeight: '700', color: c.text, textAlign: 'center', marginBottom: 8 }}>Check Your Email</Text>
            <Text style={{ fontSize: 14, color: c.text, opacity: 0.6, textAlign: 'center', marginBottom: 24 }}>
              {"We've sent a password reset link to "}{email}
            </Text>
            <NeuButton label="Back to Sign In" onPress={() => router.replace('/(auth)/sign-in')} fullWidth />
          </NeuCard>
        ) : (
          <View>
            <NeuCard radius={22} style={{ padding: 22, marginBottom: 16 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, opacity: 0.55, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Email Address</Text>
              <View style={inputStyle}>
                <Mail size={18} color={c.text} opacity={0.4} />
                <TextInput
                  value={email} onChangeText={setEmail}
                  placeholder="user@gmail.com" placeholderTextColor={`${c.text}55`}
                  keyboardType="email-address" autoCapitalize="none"
                  style={{ flex: 1, marginLeft: 10, fontSize: 15, color: c.text }}
                />
              </View>
              {error ? <Text style={{ color: '#DC2626', fontSize: 13, marginBottom: 12 }}>{error}</Text> : null}
              <NeuButton label="Send Reset Link" onPress={handleReset} loading={loading} fullWidth />
            </NeuCard>

            {/*
              SECURITY NOTE (hidden from UI per design decision):
              Resetting the password via resetPasswordForEmail only changes the auth credential.
              It does NOT affect: trusted device, device binding, login history, credits,
              activation codes, course enrollments, or video progress.
            */}

            <NeuButton
              label="Back to Sign In"
              onPress={() => router.replace('/(auth)/sign-in')}
              variant="secondary"
              fullWidth
            />
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
