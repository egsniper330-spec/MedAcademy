/**
 * Privacy Policy — static info page
 *
 * CONTENT SOURCE
 *   • Built-in copy: the numbered sections live in the shared translation
 *     dictionaries (`privacy.s1h` … `privacy.s9b`) and follow the in-app
 *     language. Previously the whole policy was hardcoded English.
 *   • Server-managed copy (Super Admin → Platform → CMS Pages) still wins when
 *     a body has been written; it is single-language as stored and rendered
 *     verbatim. An empty body falls back to the translated sections.
 *
 * LEGAL NOTE: the Arabic copy is a faithful translation of the English source —
 * no clause was added, removed or weakened.
 */
import { ScrollView, View, Text, useColorScheme } from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { useCmsSections } from '@/lib/cmsContent';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, mutedTextStyle } from '@/lib/neu';
import { Shield } from 'lucide-react-native';
import { useTranslation } from '@/lib/i18n';

/** Section numbers — the copy itself lives in the dictionaries. */
const SECTION_NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export default function PrivacyPage() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { t } = useTranslation();
  const layout = useLayout();

  // Server-managed content first; the translated built-in copy is the fallback.
  const cmsSections = useCmsSections('privacy_policy', []);
  const sections = cmsSections.length > 0
    ? cmsSections
    : SECTION_NUMBERS.map((n) => ({
        heading: t(`privacy.s${n}h`),
        body: t(`privacy.s${n}b`),
      }));

  const iconSz  = layout.heroIconSize;
  const iconInner = Math.round(iconSz * 0.5);

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title={t('studentProfile.privacy')} showBack />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: layout.screenPx }}
      >

      {/* Icon header */}
      <View style={{ alignItems: 'center', marginBottom: layout.sectionGap, marginTop: layout.pad.xs }}>
        <View style={{
          width: iconSz, height: iconSz,
          borderRadius: layout.heroIconRadius,
          backgroundColor: `${c.primary}15`,
          alignItems: 'center', justifyContent: 'center',
          marginBottom: layout.pad.md,
          shadowColor: c.shadowDark,
          shadowOffset: { width: 4, height: 4 },
          shadowOpacity: 0.55, shadowRadius: 10,
        }}>
          <Shield size={iconInner} color={c.primary} />
        </View>
        <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.4), textAlign: 'center' }}>
          {t('legal.lastUpdated')}
        </Text>
      </View>

      {sections.map((section, i) => (
        <NeuCard key={i} radius={layout.cardRadius} style={{ padding: layout.cardPx, marginBottom: layout.itemGap }}>
          <Text style={{
            fontSize: layout.captionSize + 1, fontWeight: '800', color: c.primary,
            marginBottom: layout.pad.sm, letterSpacing: 0.2,
          }}>
            {section.heading}
          </Text>
          <Text style={{ fontSize: layout.bodySize, color: c.text, opacity: 0.7, lineHeight: layout.bodySize * 1.6 }}>
            {section.body}
          </Text>
        </NeuCard>
      ))}
    </ScrollView>
    </View>
  );
}
