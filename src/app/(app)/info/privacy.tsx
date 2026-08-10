/**
 * Privacy Policy — static info page
 */
import { ScrollView, View, Text, useColorScheme } from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { Shield } from 'lucide-react-native';

const SECTIONS = [
  {
    heading: '1. Information We Collect',
    body: 'We collect information you provide when registering (name, email, phone), academic information (university, faculty, level), and device information for security enforcement. We also collect content-interaction data such as watch progress and lesson completion.',
  },
  {
    heading: '2. How We Use Your Information',
    body: 'Your information is used to provide and personalize the learning experience, enforce single-device policies, embed forensic watermarks in streamed content, communicate important account updates, and improve our platform.',
  },
  {
    heading: '3. Forensic Watermarking',
    body: 'A unique Watermark ID is assigned to your account and invisibly embedded in all video content you view. This allows us to identify the source of any unauthorized recordings or distributions. This process is transparent and required for platform integrity.',
  },
  {
    heading: '4. Device Data',
    body: 'We collect your device installation ID, model, and OS version to enforce our single-device login policy. No microphone, camera, or location data is ever collected without explicit user permission.',
  },
  {
    heading: '5. Data Sharing',
    body: 'We do not sell or rent your personal data to third parties. We may share data with instructors to the extent required to administer your enrollment. Service providers acting on our behalf are contractually bound to protect your data.',
  },
  {
    heading: '6. Data Retention',
    body: 'Account data is retained while your account is active and for a reasonable period afterward for audit and legal compliance purposes. You may request deletion of your account by contacting our support team.',
  },
  {
    heading: '7. Security',
    body: 'We use industry-standard encryption, secure authentication, and access controls to protect your data. Password changes invalidate all prior sessions immediately.',
  },
  {
    heading: '8. Your Rights',
    body: 'You have the right to access, correct, or request deletion of your personal data. To exercise these rights, please contact us through the Contact Us page.',
  },
  {
    heading: '9. Changes to This Policy',
    body: 'We may update this Privacy Policy periodically. We will notify you of significant changes through the app. Continued use after notification constitutes acceptance.',
  },
];

export default function PrivacyPage() {
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
      <PageHeader title="Privacy Policy" showBack />

      {/* Icon header */}
      <View style={{ alignItems: 'center', marginBottom: 28, marginTop: 4 }}>
        <View style={{
          width: 72, height: 72, borderRadius: 22, backgroundColor: `${c.primary}15`,
          alignItems: 'center', justifyContent: 'center', marginBottom: 14,
          shadowColor: c.shadowDark, shadowOffset: { width: 4, height: 4 },
          shadowOpacity: 0.55, shadowRadius: 10,
        }}>
          <Shield size={34} color={c.primary} />
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
