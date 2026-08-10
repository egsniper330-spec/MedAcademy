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
  const insets = layout.insets;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: layout.screenPx, paddingBottom: layout.scrollBottom() }}
    >
      <PageHeader title="Terms & Conditions" showBack />

      {/* Icon header */}
      <View style={{ alignItems: 'center', marginBottom: 28, marginTop: 4 }}>
        <View style={{
          width: 72, height: 72, borderRadius: 22, backgroundColor: `${c.primary}15`,
          alignItems: 'center', justifyContent: 'center', marginBottom: 14,
          shadowColor: c.shadowDark, shadowOffset: { width: 4, height: 4 },
          shadowOpacity: 0.55, shadowRadius: 10,
        }}>
          <FileText size={34} color={c.primary} />
        </View>
        <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, textAlign: 'center' }}>
          Last updated: July 2025
        </Text>
      </View>

      {SECTIONS.map((section, i) => (
        <NeuCard key={i} radius={18} style={{ padding: 18, marginBottom: 12 }}>
          <Text style={{
            fontSize: 13, fontWeight: '800', color: c.primary,
            marginBottom: 8, letterSpacing: 0.2,
          }}>
            {section.heading}
          </Text>
          <Text style={{ fontSize: 14, color: c.text, opacity: 0.7, lineHeight: 22 }}>
            {section.body}
          </Text>
        </NeuCard>
      ))}
    </ScrollView>
  );
}
