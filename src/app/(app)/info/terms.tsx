/**
 * Terms & Conditions — static info page
 */
import { ScrollView, View, Text, useColorScheme } from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { FileText } from 'lucide-react-native';

const SECTIONS = [
  {
    heading: '1. Acceptance of Terms',
    body: 'By accessing or using MedAcademy, you agree to be bound by these Terms & Conditions. If you do not agree to these terms, please do not use our platform.',
  },
  {
    heading: '2. Account Responsibilities',
    body: 'You are responsible for maintaining the confidentiality of your account credentials. Your account may only be used on one authorized device at a time. Sharing accounts or credentials is strictly prohibited and may result in suspension.',
  },
  {
    heading: '3. Content Usage',
    body: 'All course content — including videos, PDFs, and materials — is protected by copyright and may not be recorded, distributed, or reproduced in any form. Forensic watermarks are embedded in all streamed content to identify unauthorized sharing.',
  },
  {
    heading: '4. Subscriptions & Access',
    body: 'Course access is granted through activation codes or direct enrollment. Access is personal and non-transferable. Completed or expired subscriptions do not entitle the user to a refund unless explicitly stated.',
  },
  {
    heading: '5. Prohibited Conduct',
    body: 'You agree not to attempt to circumvent security measures, use screen-recording software during content playback, or exploit technical vulnerabilities. Violations may result in immediate account termination.',
  },
  {
    heading: '6. Intellectual Property',
    body: 'All content, trademarks, and branding on MedAcademy are the exclusive property of the platform and its instructors. Unauthorized use constitutes an infringement of intellectual property rights.',
  },
  {
    heading: '7. Disclaimer of Warranties',
    body: 'The platform is provided "as-is" without warranties of any kind. We do not guarantee uninterrupted access, and we are not liable for content accuracy beyond our reasonable editorial standards.',
  },
  {
    heading: '8. Amendments',
    body: 'We reserve the right to update these Terms at any time. Continued use of the platform after changes are posted constitutes acceptance of the updated Terms.',
  },
  {
    heading: '9. Governing Law',
    body: 'These Terms are governed by applicable laws. Any disputes shall be resolved through negotiation, and if necessary, through the competent courts.',
  },
];

export default function TermsPage() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const iconSz  = layout.heroIconSize;
  const iconInner = Math.round(iconSz * 0.5);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: layout.screenPx, paddingBottom: layout.scrollBottom() }}
    >
      <PageHeader title="Terms & Conditions" showBack />

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
        <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.4, textAlign: 'center' }}>
          Last updated: July 2025
        </Text>
      </View>

      {SECTIONS.map((section, i) => (
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
  );
}
