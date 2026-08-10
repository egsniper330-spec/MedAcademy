/**
 * Contact Us — pulls live branding data for email/phone/WhatsApp/website,
 * with tap-to-open actions for each channel.
 *
 * PRIVACY CONTRACT: raw contact details (phone numbers, email addresses,
 * URLs) are intentionally NEVER rendered in the UI. Each channel shows only
 * a friendly label + description. All real values are kept in code only.
 */
import { useState, useEffect, useRef } from 'react';
import {
  ScrollView, View, Text, useColorScheme, Pressable,
  ActivityIndicator, Linking, Animated,
} from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, neuMicroStyle, safeBottom } from '@/lib/neu';
import { usePressAnim, useEntranceAnim } from '@/lib/motion';
import { getBranding } from '@/lib/api';
import {
  Mail, Phone, Globe, MessageCircle, Send,
  HeartHandshake, ChevronRight,
} from 'lucide-react-native';

// ── Contact channel definition ────────────────────────────────────────────────
type ContactItem = {
  icon: React.ElementType;
  color: string;
  label: string;
  /** Friendly one-liner shown in place of the raw value. Never the actual URL/number. */
  description: string;
  onPress: () => void;
};

// ── Animated contact card ─────────────────────────────────────────────────────
function ContactCard({ item, index }: { item: ContactItem; index: number }) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const press = usePressAnim();

  return (
    <Animated.View style={press.style}>
      <Pressable
        onPress={item.onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={item.label}
      >
        <NeuCard radius={18} style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 14 }}>

          {/* Icon badge */}
          <View style={{
            width: 52, height: 52, borderRadius: 16,
            backgroundColor: `${item.color}15`,
            alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <item.icon size={24} color={item.color} />
          </View>

          {/* Label + description */}
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={{
              fontSize: 15, fontWeight: '800',
              color: c.text, lineHeight: 19,
            }}>
              {item.label}
            </Text>
            <Text style={{
              fontSize: 12, fontWeight: '500',
              color: c.text, opacity: 0.45, lineHeight: 17,
            }} numberOfLines={2}>
              {item.description}
            </Text>
          </View>

          {/* Open chevron pill */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 2,
            paddingHorizontal: 10, paddingVertical: 6,
            borderRadius: 12,
            backgroundColor: `${item.color}14`,
            flexShrink: 0,
          }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: item.color }}>Open</Text>
            <ChevronRight size={13} color={item.color} strokeWidth={2.5} />
          </View>

        </NeuCard>
      </Pressable>
    </Animated.View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────
export default function ContactPage() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;

  const [branding, setBranding] = useState<any>(null);
  const [loading, setLoading]   = useState(true);

  // Hero icon fade-in
  const heroEntrance = useEntranceAnim({ offsetY: 12, duration: 460 });


  // Build channels — real values live here, descriptions shown in UI instead.
  const contacts: ContactItem[] = [];

  if (branding?.contact_email) {
    contacts.push({
      icon: Mail, color: '#DC2626',
      label: 'Email',
      description: 'Send us an email and we\'ll reply shortly.',
      onPress: () => Linking.openURL(`mailto:${branding.contact_email}`),
    });
  }
  if (branding?.support_email && branding.support_email !== branding.contact_email) {
    contacts.push({
      icon: Mail, color: '#7C3AED',
      label: 'Support Email',
      description: 'Reach our technical support team.',
      onPress: () => Linking.openURL(`mailto:${branding.support_email}`),
    });
  }
  if (branding?.contact_phone) {
    contacts.push({
      icon: Phone, color: '#16A34A',
      label: 'Phone',
      description: 'Call our support line directly.',
      onPress: () => Linking.openURL(`tel:${branding.contact_phone}`),
    });
  }
  if (branding?.whatsapp_url) {
    const raw  = branding.whatsapp_url as string;
    const href = raw.startsWith('http') ? raw : `https://wa.me/${raw.replace(/\D/g, '')}`;
    contacts.push({
      icon: MessageCircle, color: '#16A34A',
      label: 'WhatsApp',
      description: 'Chat with us on WhatsApp.',
      onPress: () => Linking.openURL(href),
    });
  }
  if (branding?.telegram_url) {
    const raw  = branding.telegram_url as string;
    const href = raw.startsWith('http') ? raw : `https://t.me/${raw.replace('@', '')}`;
    contacts.push({
      icon: Send, color: '#2DA8FF',
      label: 'Telegram',
      description: 'Join our Telegram channel for updates.',
      onPress: () => Linking.openURL(href),
    });
  }
  if (branding?.website_url) {
    contacts.push({
      icon: Globe, color: c.primary,
      label: 'Website',
      description: 'Visit our official website.',
      onPress: () => Linking.openURL(branding.website_url),
    });
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        padding: 20,
        paddingBottom: layout.scrollBottom(),
      }}
    >
      <PageHeader title="Contact Us" showBack />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <Animated.View style={{
        alignItems: 'center',
        marginBottom: 28,
        marginTop: 4,
        ...heroEntrance.style,
      }}>
        {/* Neumorphic circular icon */}
        <View style={{
          width: 88, height: 88, borderRadius: 44,
          alignItems: 'center', justifyContent: 'center',
          marginBottom: 18,
          ...neuMicroStyle(isDark),
        }}>
          <HeartHandshake size={38} color={c.primary} />
        </View>

        <Text style={{ fontSize: 22, fontWeight: '800', color: c.text, marginBottom: 8 }}>
          Contact Us
        </Text>

        {/* Accent divider */}
        <View style={{
          width: 36, height: 3, borderRadius: 2,
          backgroundColor: c.primary, opacity: 0.55,
          marginBottom: 12,
        }} />

        <Text style={{
          fontSize: 13, color: c.text, opacity: 0.5,
          textAlign: 'center', lineHeight: 20,
          paddingHorizontal: 16,
        }}>
          Need help? Choose one of the contact methods below{'\n'}and we'll be happy to assist you.
        </Text>
      </Animated.View>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      {loading ? (
        <ActivityIndicator color={c.primary} style={{ marginVertical: 48 }} />
      ) : contacts.length === 0 ? (
        <NeuCard radius={18} style={{ padding: 32, alignItems: 'center', gap: 12 }}>
          <HeartHandshake size={44} color={c.primary} opacity={0.22} />
          <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, opacity: 0.5, textAlign: 'center' }}>
            Contact details are not yet configured.
          </Text>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.35, textAlign: 'center' }}>
            Please check back soon.
          </Text>
        </NeuCard>
      ) : (
        <View style={{ gap: 12 }}>
          {contacts.map((item, i) => (
            <ContactCard key={i} item={item} index={i} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}
