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
// Add useLayout import
import { neuColors, neuFlatStyle, useLayout } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';

export default function AccountBlockedScreen() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const layout = useLayout();

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
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: layout.screenPx,
        paddingTop: layout.pad.xxl,
        paddingBottom: layout.scrollBottom(),
        gap: layout.pad.sm,
      }}
    >
      {/* Hero icon */}
      <View style={{
        width: layout.heroIconSize,
        height: layout.heroIconSize,
        borderRadius: layout.heroIconSize / 2,
        backgroundColor: 'rgba(220,38,38,0.12)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: layout.pad.lg,
      }}>
        <ShieldOff size={Math.round(layout.heroIconSize * 0.5)} color="#DC2626" />
      </View>

      {/* Title */}
      <Text style={{ fontSize: layout.titleSize, fontWeight: '800', color: c.text, textAlign: 'center', marginBottom: layout.pad.xs }}>
        Account Blocked
      </Text>
      <Text style={{
        fontSize: layout.bodySize,
        color: c.text,
        opacity: 0.6,
        textAlign: 'center',
        lineHeight: layout.bodySize * 1.6,
        marginBottom: layout.pad.xl,
      }}>
        Your account has been blocked by an administrator. You cannot access the app at this time.
      </Text>

      {/* Info card — padding/gap/radius from adaptive tokens */}
      <View style={[flat, {
        borderRadius: layout.cardRadius,
        padding: layout.cardPx,
        gap: layout.pad.xl,
        width: '100%',
        marginBottom: layout.pad.lg,
      }]}>
        {[
          { icon: <ShieldOff size={layout.bodySize + 4} color="#DC2626" style={{ marginTop: 2 }} />, title: 'Why am I blocked?', body: "Your account was blocked by an administrator. This may be due to a policy violation or at the admin's discretion." },
          { icon: <AlertTriangle size={layout.bodySize + 4} color={c.primary} style={{ marginTop: 2 }} />, title: 'What can I do?', body: 'Contact support to appeal this decision. Provide your account email and any relevant context.' },
          { icon: <Smartphone size={layout.bodySize + 4} color={c.primary} style={{ marginTop: 2 }} />, title: 'All sessions ended', body: 'All your active sessions on all devices have been ended automatically.' },
        ].map(({ icon, title, body }) => (
          <View key={title} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: layout.pad.md }}>
            {icon}
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text, marginBottom: 2 }}>{title}</Text>
              <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.6, lineHeight: layout.captionSize * 1.6 }}>{body}</Text>
            </View>
          </View>
        ))}
      </View>

      {/* Actions */}
      <View style={{ width: '100%', gap: layout.pad.md }}>
        <NeuButton label="Contact Support" icon={<Phone size={layout.bodySize} color="#fff" />} onPress={handleContactSupport} variant="primary" fullWidth />
        <NeuButton label="Back to Login"   icon={<LogOut size={layout.bodySize} color={c.text} />} onPress={handleLogout} fullWidth />
      </View>
    </ScrollView>
  );
}
