/**
 * Contact Us — pulls live branding data for email/phone/WhatsApp/website,
 * with tap-to-open actions for each channel.
 */
import { useState, useEffect } from 'react';
import { ScrollView, View, Text, useColorScheme, Pressable, ActivityIndicator, Linking } from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { neuColors } from '@/lib/neu';
import { getBranding } from '@/lib/api';
import {
  Mail, Phone, Globe, MessageCircle, Send,
  HeartHandshake,
} from 'lucide-react-native';

type ContactItem = {
  icon: React.ElementType;
  color: string;
  label: string;
  value: string;
  onPress: () => void;
};

export default function ContactPage() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [branding, setBranding] = useState<any>(null);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const data = await getBranding();
        setBranding(data);
      } catch { /* branding fetch failed — show empty state */ }
      setLoading(false);
    })();
  }, []);

  const contacts: ContactItem[] = [];

  if (branding?.contact_email) {
    contacts.push({
      icon: Mail, color: '#DC2626',
      label: 'Email', value: branding.contact_email,
      onPress: () => Linking.openURL(`mailto:${branding.contact_email}`),
    });
  }
  if (branding?.support_email && branding.support_email !== branding.contact_email) {
    contacts.push({
      icon: Mail, color: '#7C3AED',
      label: 'Support Email', value: branding.support_email,
      onPress: () => Linking.openURL(`mailto:${branding.support_email}`),
    });
  }
  if (branding?.contact_phone) {
    contacts.push({
      icon: Phone, color: '#16A34A',
      label: 'Phone', value: branding.contact_phone,
      onPress: () => Linking.openURL(`tel:${branding.contact_phone}`),
    });
  }
  if (branding?.whatsapp_url) {
    // Accepts full wa.me URL or just a phone number
    const raw = branding.whatsapp_url as string;
    const href = raw.startsWith('http') ? raw : `https://wa.me/${raw.replace(/\D/g, '')}`;
    contacts.push({
      icon: MessageCircle, color: '#16A34A',
      label: 'WhatsApp', value: raw.replace(/^https?:\/\//, ''),
      onPress: () => Linking.openURL(href),
    });
  }
  if (branding?.telegram_url) {
    const raw = branding.telegram_url as string;
    const href = raw.startsWith('http') ? raw : `https://t.me/${raw.replace('@', '')}`;
    contacts.push({
      icon: Send, color: '#2DA8FF',
      label: 'Telegram', value: raw,
      onPress: () => Linking.openURL(href),
    });
  }
  if (branding?.website_url) {
    contacts.push({
      icon: Globe, color: c.primary,
      label: 'Website', value: branding.website_url,
      onPress: () => Linking.openURL(branding.website_url),
    });
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
    >
      <PageHeader title="Contact Us" showBack />

      {/* Hero */}
      <View style={{ alignItems: 'center', marginBottom: 28, marginTop: 4 }}>
        <View style={{
          width: 72, height: 72, borderRadius: 22, backgroundColor: `${c.primary}15`,
          alignItems: 'center', justifyContent: 'center', marginBottom: 14,
          shadowColor: c.shadowDark, shadowOffset: { width: 4, height: 4 },
          shadowOpacity: 0.55, shadowRadius: 10,
        }}>
          <HeartHandshake size={34} color={c.primary} />
        </View>
        <Text style={{ fontSize: 22, fontWeight: '800', color: c.text }}>Get in Touch</Text>
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, textAlign: 'center', marginTop: 6, lineHeight: 20, paddingHorizontal: 20 }}>
          We&apos;re here to help. Reach out through any of the channels below.
        </Text>
      </View>

      {loading ? (
        <ActivityIndicator color={c.primary} style={{ marginVertical: 48 }} />
      ) : contacts.length === 0 ? (
        <NeuCard radius={18} style={{ padding: 28, alignItems: 'center', gap: 10 }}>
          <HeartHandshake size={40} color={c.primary} opacity={0.25} />
          <Text style={{ fontSize: 15, fontWeight: '600', color: c.text, opacity: 0.5, textAlign: 'center' }}>
            Contact details are not yet configured.
          </Text>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.35, textAlign: 'center' }}>
            Please check back soon.
          </Text>
        </NeuCard>
      ) : (
        <View style={{ gap: 12 }}>
          {contacts.map((item, i) => (
            <Pressable key={i} onPress={item.onPress}>
              {({ pressed }) => (
                <NeuCard radius={18} style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 14, opacity: pressed ? 0.7 : 1 }}>
                  <View style={{
                    width: 48, height: 48, borderRadius: 14,
                    backgroundColor: `${item.color}15`,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <item.icon size={22} color={item.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 3 }}>
                      {item.label}
                    </Text>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }} numberOfLines={1}>
                      {item.value}
                    </Text>
                  </View>
                  <View style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, backgroundColor: `${item.color}12` }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: item.color }}>Open</Text>
                  </View>
                </NeuCard>
              )}
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
