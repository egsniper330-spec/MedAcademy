/**
 * Account Blocked Screen
 * Shown when a user's account has been blocked by an administrator.
 * Also handles legacy "suspended" status (content violation).
 */
import React from 'react';
import { View, Text, ScrollView, Pressable, Linking, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { ShieldOff, AlertTriangle, Smartphone, LogOut, Phone } from 'lucide-react-native';
import { backendClient } from '@/client/backendClient';
import { neuColors, neuFlatStyle, mutedTextStyle } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';
import { t } from '@/lib/i18n';

export default function AccountBlockedScreen() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);

  const handleLogout = async () => {
    await backendClient.auth.signOut();
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
        {t('suspended.blockedTitle')}
      </Text>
      <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.6), textAlign: 'center', lineHeight: 22, marginBottom: 28 }}>
        {t('suspended.blockedMessage')}
      </Text>

      {/* Info card */}
      <View style={[flat, { borderRadius: 20, padding: 20, gap: 18, width: '100%', marginBottom: 24 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <ShieldOff size={20} color="#DC2626" style={{ marginTop: 2 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 2 }}>{t('suspended.why')}</Text>
            <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6), lineHeight: 20 }}>
              {t('suspended.whyBody')}
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <AlertTriangle size={20} color={c.primary} style={{ marginTop: 2 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 2 }}>{t('suspended.whatCanIDo')}</Text>
            <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6), lineHeight: 20 }}>
              {t('suspended.whatCanIDoBody')}
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <Smartphone size={20} color={c.primary} style={{ marginTop: 2 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 2 }}>{t('suspended.sessionsEnded')}</Text>
            <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6), lineHeight: 20 }}>
              {t('suspended.sessionsEndedBody')}
            </Text>
          </View>
        </View>
      </View>

      {/* Actions */}
      <View style={{ width: '100%', gap: 12 }}>
        <NeuButton
          label={t('support.title')}
          icon={<Phone size={18} color="#fff" />}
          onPress={handleContactSupport}
          variant="primary"
          fullWidth
        />
        <NeuButton
          label={t('suspended.backToLogin')}
          icon={<LogOut size={18} color={c.text} />}
          onPress={handleLogout}
          fullWidth
        />
      </View>
    </ScrollView>
  );
}
