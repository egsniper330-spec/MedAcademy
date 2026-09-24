/**
 * Contact Us — pulls live branding data for email/phone/WhatsApp/website,
 * with tap-to-open actions for each channel.
 *
 * PRIVACY CONTRACT: raw contact details (phone numbers, email addresses,
 * URLs) are intentionally NEVER rendered in the UI. Each channel shows only
 * a friendly label + description. All real values are kept in code only.
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  ScrollView, View, Text, useColorScheme, Pressable,
  ActivityIndicator, Linking, Animated,
} from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, neuMicroStyle, safeBottom } from '@/lib/neu';
import { usePressAnim, useEntranceAnim } from '@/lib/motion';
import { getBranding } from '@/lib/api';
import { useCmsSections } from '@/lib/cmsContent';
import {
  Mail, Phone, Globe, MessageCircle, Send,
  HeartHandshake, ChevronRight, Camera, Hash, Users, Link2,
} from 'lucide-react-native';
import { parseContactLinks, contactLinkHref } from '@/lib/branding';

/**
 * Presentation for each admin-configured link platform (CMS → Contact Us).
 * Users only ever see the friendly label + this description; the destination
 * stays in code (privacy contract at the top of this file).
 */
const LINK_META: Record<string, { icon: React.ElementType; color: string; description: string }> = {
  whatsapp:  { icon: MessageCircle, color: '#16A34A', description: 'Chat with us on WhatsApp.' },
  telegram:  { icon: Send,          color: '#2DA8FF', description: 'Message us on Telegram.' },
  facebook:  { icon: Users,         color: '#1877F2', description: 'Visit our Facebook page.' },
  instagram: { icon: Camera,        color: '#E1306C', description: 'Follow us on Instagram.' },
  twitter:   { icon: Hash,          color: '#0F172A', description: 'Follow us on X.' },
  website:   { icon: Globe,         color: '#6B7280', description: 'Visit our official website.' },
  email:     { icon: Mail,          color: '#DC2626', description: 'Send us an email.' },
  phone:     { icon: Phone,         color: '#0EA5E9', description: 'Call this number.' },
};

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
  // Server-managed intro text (Super Admin → Platform → CMS Pages → Contact
  // Us). Falls back to the bundled copy while loading / when unset.
  const intro = useCmsSections('contact_us', [
    { heading: '', body: 'Need help? Choose one of the contact methods below and we\'ll be happy to assist you.' },
  ]);
  const [loading, setLoading]   = useState(true);

  // Hero icon fade-in
  const heroEntrance = useEntranceAnim({ offsetY: 12, duration: 460 });


  // Build channels — real values live here, descriptions shown in UI instead.
  const contacts: ContactItem[] = [];

  // ── Admin-configured links (Super Admin → CMS Pages → Contact Us) ──────────
  // Pushed FIRST so the operator's chosen order is exactly what users see.
  // A disabled link stays saved on the server but is never rendered here, and
  // a bad destination degrades to a harmless no-op instead of crashing the tap.
  const customLinks = parseContactLinks((branding as any)?.contact_links).filter(l => l.enabled);
  for (const link of customLinks) {
    const meta = LINK_META[link.platform] ?? { icon: Link2, color: c.primary, description: 'Tap to open.' };
    const href = contactLinkHref(link);
    contacts.push({
      icon: meta.icon,
      color: meta.color,
      label: link.label,
      description: meta.description,
      onPress: () => { void Linking.openURL(href).catch(() => {}); },
    });
  }
  // Platforms already covered by a configured link — the legacy fixed channels
  // below must not duplicate them.
  const configured = new Set(customLinks.map(l => l.platform));

  if (branding?.contact_email && !configured.has('email')) {
    contacts.push({
      icon: Mail, color: '#DC2626',
      label: 'Email',
      description: 'Send us an email and we\'ll reply shortly.',
      onPress: () => Linking.openURL(`mailto:${branding.contact_email}`),
    });
  }
  if (branding?.support_email && branding.support_email !== branding.contact_email && !configured.has('email')) {
    contacts.push({
      icon: Mail, color: '#7C3AED',
      label: 'Support Email',
      description: 'Reach our technical support team.',
      onPress: () => Linking.openURL(`mailto:${branding.support_email}`),
    });
  }
  if (branding?.contact_phone && !configured.has('phone')) {
    contacts.push({
      icon: Phone, color: '#16A34A',
      label: 'Phone',
      description: 'Call our support line directly.',
      onPress: () => Linking.openURL(`tel:${branding.contact_phone}`),
    });
  }
  if (branding?.whatsapp_url && !configured.has('whatsapp')) {
    const raw  = branding.whatsapp_url as string;
    const href = raw.startsWith('http') ? raw : `https://wa.me/${raw.replace(/\D/g, '')}`;
    contacts.push({
      icon: MessageCircle, color: '#16A34A',
      label: 'WhatsApp',
      description: 'Chat with us on WhatsApp.',
      onPress: () => Linking.openURL(href),
    });
  }
  if (branding?.telegram_url && !configured.has('telegram')) {
    const raw  = branding.telegram_url as string;
    const href = raw.startsWith('http') ? raw : `https://t.me/${raw.replace('@', '')}`;
    contacts.push({
      icon: Send, color: '#2DA8FF',
      label: 'Telegram',
      description: 'Join our Telegram channel for updates.',
      onPress: () => Linking.openURL(href),
    });
  }
  if (branding?.website_url && !configured.has('website')) {
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
          {intro
            .map((section, i) => (section.heading !== '' ? `${section.heading}: ${section.body}` : section.body).trim())
            .filter((part) => part !== '')
            .join('\n')}
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
