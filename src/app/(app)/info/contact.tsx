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
function ContactCard({ item }: { item: ContactItem; index: number }) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const press = usePressAnim();
  const iconSz   = layout.touchTarget + 8;
  const iconInner = Math.round(iconSz * 0.46);

  return (
    <Animated.View style={press.style}>
      <Pressable
        onPress={item.onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={item.label}
      >
        <NeuCard radius={layout.cardRadius} style={{ flexDirection: 'row', alignItems: 'center', padding: layout.cardPx, gap: layout.pad.md }}>

          {/* Icon badge */}
          <View style={{
            width: iconSz, height: iconSz,
            borderRadius: layout.heroIconRadius / 1.5,
            backgroundColor: `${item.color}15`,
            alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <item.icon size={iconInner} color={item.color} />
          </View>

          {/* Label + description */}
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={{
              fontSize: layout.bodySize + 1, fontWeight: '800',
              color: c.text, lineHeight: (layout.bodySize + 1) * 1.3,
            }}>
              {item.label}
            </Text>
            <Text style={{
              fontSize: layout.captionSize, fontWeight: '500',
              color: c.text, opacity: 0.45, lineHeight: layout.captionSize * 1.4,
            }} numberOfLines={2}>
              {item.description}
            </Text>
          </View>

          {/* Open chevron pill */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 2,
            paddingHorizontal: layout.pad.sm + 2, paddingVertical: layout.pad.xs + 2,
            borderRadius: layout.cardRadius / 1.5,
            backgroundColor: `${item.color}14`,
            flexShrink: 0,
          }}>
            <Text style={{ fontSize: layout.captionSize, fontWeight: '700', color: item.color }}>Open</Text>
            <ChevronRight size={layout.captionSize + 1} color={item.color} strokeWidth={2.5} />
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

  const heroIconSz  = layout.heroIconSize * 1.1;
  const heroInnerSz = Math.round(heroIconSz * 0.48);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentContainerStyle={{
        padding: layout.screenPx,
        paddingBottom: layout.scrollBottom(),
      }}
    >
      <PageHeader title="Contact Us" showBack />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <Animated.View style={{
        alignItems: 'center',
        marginBottom: layout.sectionGap,
        marginTop: layout.pad.xs,
        ...heroEntrance.style,
      }}>
        {/* Neumorphic circular icon */}
        <View style={{
          width: heroIconSz, height: heroIconSz,
          borderRadius: heroIconSz / 2,
          alignItems: 'center', justifyContent: 'center',
          marginBottom: layout.pad.lg,
          ...neuMicroStyle(isDark),
        }}>
          <HeartHandshake size={heroInnerSz} color={c.primary} />
        </View>

        <Text style={{ fontSize: layout.titleSize * 0.85, fontWeight: '800', color: c.text, marginBottom: layout.pad.sm }}>
          Contact Us
        </Text>

        {/* Accent divider */}
        <View style={{
          width: layout.pad.xxl, height: 3, borderRadius: 2,
          backgroundColor: c.primary, opacity: 0.55,
          marginBottom: layout.pad.md,
        }} />

        <Text style={{
          fontSize: layout.captionSize + 1, color: c.text, opacity: 0.5,
          textAlign: 'center', lineHeight: (layout.captionSize + 1) * 1.55,
          paddingHorizontal: layout.screenPx,
        }}>
          Need help? Choose one of the contact methods below{'\n'}and we'll be happy to assist you.
        </Text>
      </Animated.View>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      {loading ? (
        <ActivityIndicator color={c.primary} style={{ marginVertical: layout.sectionGap * 2 }} />
      ) : contacts.length === 0 ? (
        <NeuCard radius={layout.cardRadius} style={{ padding: layout.cardPx * 2, alignItems: 'center', gap: layout.pad.md }}>
          <HeartHandshake size={layout.heroIconSize} color={c.primary} opacity={0.22} />
          <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '700', color: c.text, opacity: 0.5, textAlign: 'center' }}>
            Contact details are not yet configured.
          </Text>
          <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.35, textAlign: 'center' }}>
            Please check back soon.
          </Text>
        </NeuCard>
      ) : (
        <View style={{ gap: layout.itemGap }}>
          {contacts.map((item, i) => (
            <ContactCard key={i} item={item} index={i} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}
