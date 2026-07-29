/**
 * Account Blocked Screen
 * Shown when a user's account has been blocked by an administrator.
 * Also handles legacy "suspended" status (content violation).
 */
import React from 'react';
import { View, Text, ScrollView, Pressable, Linking, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { ShieldOff, AlertTriangle, Smartphone, LogOut, Phone } from 'lucide-react-native';
import { supabase } from '@/client/supabase';
import { neuColors, neuFlatStyle } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';

export default function AccountBlockedScreen() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace('/(auth)/sign-in');
  };

  const handleContactSupport = () => {
    Linking.openURL('mailto:support@medacademy.app?subject=Account%20Blocked%20Appeal');
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 0 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      {/* Icon */}
      <View style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: 'rgba(220,38,38,0.12)', alignItems: 'center', justifyContent: 'center', marginBottom: 24 }}>
        <ShieldOff size={48} color="#DC2626" />
      </View>

      {/* Title */}
      <Text style={{ fontSize: 22, fontWeight: '800', color: c.text, textAlign: 'center', marginBottom: 8 }}>
        Account Blocked
      </Text>
      <Text style={{ fontSize: 14, color: c.text, opacity: 0.6, textAlign: 'center', lineHeight: 22, marginBottom: 28 }}>
        Your account has been blocked by an administrator. You cannot access the app at this time.
      </Text>

      {/* Info card */}
      <View style={[flat, { borderRadius: 20, padding: 20, gap: 18, width: '100%', marginBottom: 24 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <ShieldOff size={20} color="#DC2626" style={{ marginTop: 2 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 2 }}>Why am I blocked?</Text>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, lineHeight: 20 }}>
              {"Your account was blocked by an administrator. This may be due to a policy violation or at the admin's discretion."}
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <AlertTriangle size={20} color={c.primary} style={{ marginTop: 2 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 2 }}>What can I do?</Text>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, lineHeight: 20 }}>
              Contact support to appeal this decision. Provide your account email and any relevant context.
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <Smartphone size={20} color={c.primary} style={{ marginTop: 2 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 2 }}>All sessions ended</Text>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, lineHeight: 20 }}>
              All your active sessions on all devices have been ended automatically.
            </Text>
          </View>
        </View>
      </View>

      {/* Actions */}
      <View style={{ width: '100%', gap: 12 }}>
        <NeuButton
          label="Contact Support"
          icon={<Phone size={18} color="#fff" />}
          onPress={handleContactSupport}
          variant="primary"
          fullWidth
        />
        <NeuButton
          label="Back to Login"
          icon={<LogOut size={18} color={c.text} />}
          onPress={handleLogout}
          fullWidth
        />
      </View>
    </ScrollView>
  );
}
