/**
 * Terms & Conditions — static info page
 *
 * CONTENT SOURCE
 *   • Built-in copy: this page's numbered sections, now held in the shared
 *     translation dictionaries (`terms.s1h` … `terms.s9b`) so the page follows
 *     the in-app language instead of always rendering English.
 *   • Server-managed copy (Super Admin → Platform → CMS Pages) still wins when
 *     a body has been written — the CMS text is single-language (as stored) and
 *     is rendered verbatim. Clearing the CMS body falls back to these translated
 *     sections, which also means switching language re-renders the fallback.
 *
 * LEGAL NOTE: the Arabic copy is a faithful translation of the English source —
 * no clause was added, removed or weakened.
 */
import { ScrollView, View, Text, useColorScheme } from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { useCmsSections } from '@/lib/cmsContent';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, mutedTextStyle } from '@/lib/neu';
import { FileText } from 'lucide-react-native';
import { useTranslation } from '@/lib/i18n';

/** Section numbers — the copy itself lives in the dictionaries. */
const SECTION_NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export default function TermsPage() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { t } = useTranslation();
  const layout = useLayout();

  // Server-managed content first; the translated built-in copy is the fallback.
  // Passing [] (not the copy) keeps the fallback reactive to locale changes.
  const cmsSections = useCmsSections('terms_conditions', []);
  const sections = cmsSections.length > 0
    ? cmsSections
    : SECTION_NUMBERS.map((n) => ({
        heading: t(`terms.s${n}h`),
        body: t(`terms.s${n}b`),
      }));

  const iconSz  = layout.heroIconSize;
  const iconInner = Math.round(iconSz * 0.5);

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title={t('studentProfile.terms')} showBack />
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
          <FileText size={iconInner} color={c.primary} />
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
