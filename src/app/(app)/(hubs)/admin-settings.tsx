/**
 * Admin Settings — settings hub for the Admin and Super Admin roles.
 *
 * WHY THIS SCREEN EXISTS (and what it replaced)
 * ---------------------------------------------
 * It used to be a placeholder ("Settings panel coming soon"), which meant the
 * two administrative roles had NO way to change the application language:
 * LanguageSetting was mounted only on the Student and Doctor profile screens.
 * Language is an account-level preference that must be available to every role,
 * so this screen now exposes it (see the "App Language" card) and the drawer
 * entries for both roles point here.
 *
 * The screen intentionally stays small: it is a *hub* for settings that live in
 * their own dedicated screens (security, maintenance, branding…). Links are
 * grouped by concern and every label is translated.
 */
import { View, Text, ScrollView, Pressable, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import { ChevronRight, Languages, Shield, Wrench, Flag } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { LanguageSetting } from '@/components/LanguageSetting';
import { neuColors, useLayout, safeBottom, mutedTextStyle } from '@/lib/neu';
import { useTranslation } from '@/lib/i18n';

export default function AdminSettingsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { t, isRTL } = useTranslation();
  const router = useRouter();

  const links = [
    { icon: Shield, label: t('adminSettings.link.security'), description: t('adminSettings.link.securityDesc'), path: '/security' },
    { icon: Wrench, label: t('adminSettings.link.maintenance'), description: t('adminSettings.link.maintenanceDesc'), path: '/maintenance' },
    { icon: Flag, label: t('adminSettings.link.featureFlags'), description: t('adminSettings.link.featureFlagsDesc'), path: '/feature-flags' },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
    >
      <PageHeader
        title={t('adminSettings.title')}
        subtitle={t('adminSettings.subtitle')}
        backFallback="/admin-overview"
      />

      <View style={{ paddingHorizontal: layout.screenPx }}>
        {/* ── Language ─────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: layout.pad.sm }}>
          <Languages size={16} color={c.primary} />
          <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '800', color: c.text }}>
            {t('adminSettings.languageHeading')}
          </Text>
        </View>
        <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.5), marginTop: 4, marginBottom: layout.pad.md, lineHeight: 18 }}>
          {t('adminSettings.languageBody')}
        </Text>
        <LanguageSetting />

        {/* ── Related settings ─────────────────────────────────────────── */}
        <Text style={{ fontSize: layout.captionSize, fontWeight: '800', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase', letterSpacing: 1.1, marginTop: layout.pad.lg, marginBottom: layout.pad.sm }}>
          {t('adminSettings.relatedHeading')}
        </Text>
        {links.map(({ icon: Icon, label, description, path }) => (
          <Pressable
            key={label}
            onPress={() => router.push(path as RelativePathString)}
            accessibilityRole="button"
            accessibilityLabel={label}
          >
            <NeuCard style={{ marginBottom: 10, padding: 14, flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center', marginEnd: 12 }}>
                <Icon size={17} color={c.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{label}</Text>
                <Text style={{ fontSize: 11.5, ...mutedTextStyle(c, 0.5), marginTop: 2 }}>{description}</Text>
              </View>
              <ChevronRight size={16} color={`${c.text}40`} style={{ transform: [{ scaleX: isRTL ? -1 : 1 }] }} />
            </NeuCard>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
