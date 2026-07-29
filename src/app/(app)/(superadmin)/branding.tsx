/**
 * Branding — Super Admin only
 * Logo, app name, colors, contact info, social links.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, ActivityIndicator,
  RefreshControl, useColorScheme,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Star, Palette, Link, Mail, Phone } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { getBranding, updateBranding } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors } from '@/lib/neu';

export default function BrandingScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [brand, setBrand] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [success, setSuccess] = useState(false);

  const load = useCallback(async () => {
    try { setBrand(await getBranding()); } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const set = (key: string, value: string) => setBrand((prev: any) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    if (!brand) return;
    setSaving(true);
    try {
      const updated = await updateBranding({
        app_name: brand.app_name, primary_color: brand.primary_color,
        secondary_color: brand.secondary_color, contact_email: brand.contact_email,
        contact_phone: brand.contact_phone, support_email: brand.support_email,
        facebook_url: brand.facebook_url, instagram_url: brand.instagram_url,
        youtube_url: brand.youtube_url, telegram_url: brand.telegram_url,
        whatsapp_url: brand.whatsapp_url, website_url: brand.website_url,
      });
      setBrand(updated);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2500);
    } catch (_) {}
    setSaving(false);
  };

  const inp = {
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.55, shadowRadius: 5,
    fontSize: 14, color: c.text,
  };

  const label = (text: string) => (
    <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>{text}</Text>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: 20 }}>
        <PageHeader title="Branding" subtitle="Customize platform appearance" accentColor="#7C3AED" />

        {success && (
          <NeuCard style={{ marginBottom: 16, padding: 14, backgroundColor: '#16A34A18' }}>
            <Text style={{ color: '#16A34A', fontWeight: '700', textAlign: 'center' }}>✅ Branding updated successfully</Text>
          </NeuCard>
        )}

        {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} /> : brand && (
          <>
            {/* App Identity */}
            <NeuCard style={{ marginBottom: 16, padding: 18 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <Palette size={18} color={c.primary} />
                <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>App Identity</Text>
              </View>
              {label('App Name')}
              <TextInput value={brand.app_name ?? ''} onChangeText={v => set('app_name', v)} style={{ ...inp, minWidth: 0, marginBottom: 14 }} />
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  {label('Primary Color')}
                  <View style={{ flexDirection: 'row', alignItems: 'center', ...inp, paddingVertical: 8, minWidth: 0 }}>
                    <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: brand.primary_color ?? '#1E90FF', marginRight: 10, flexShrink: 0 }} />
                    <TextInput value={brand.primary_color ?? ''} onChangeText={v => set('primary_color', v)} style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }} placeholder="#1E90FF" placeholderTextColor={`${c.text}55`} />
                  </View>
                </View>
                <View style={{ flex: 1 }}>
                  {label('Secondary Color')}
                  <View style={{ flexDirection: 'row', alignItems: 'center', ...inp, paddingVertical: 8, minWidth: 0 }}>
                    <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: brand.secondary_color ?? '#0D47A1', marginRight: 10, flexShrink: 0 }} />
                    <TextInput value={brand.secondary_color ?? ''} onChangeText={v => set('secondary_color', v)} style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }} placeholder="#0D47A1" placeholderTextColor={`${c.text}55`} />
                  </View>
                </View>
              </View>
            </NeuCard>

            {/* Contact Information */}
            <NeuCard style={{ marginBottom: 16, padding: 18 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <Mail size={18} color={c.primary} />
                <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>Contact Information</Text>
              </View>
              {label('Contact Email')}
              <TextInput value={brand.contact_email ?? ''} onChangeText={v => set('contact_email', v)} style={{ ...inp, minWidth: 0, marginBottom: 12 }} keyboardType="email-address" autoCapitalize="none" />
              {label('Support Email')}
              <TextInput value={brand.support_email ?? ''} onChangeText={v => set('support_email', v)} style={{ ...inp, minWidth: 0, marginBottom: 12 }} keyboardType="email-address" autoCapitalize="none" />
              {label('Contact Phone')}
              <TextInput value={brand.contact_phone ?? ''} onChangeText={v => set('contact_phone', v)} style={{ ...inp, minWidth: 0 }} keyboardType="phone-pad" />
            </NeuCard>

            {/* Social Links */}
            <NeuCard style={{ marginBottom: 20, padding: 18 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <Link size={18} color={c.primary} />
                <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>Social Links</Text>
              </View>
              {[
                { key: 'facebook_url',  label: 'Facebook URL' },
                { key: 'instagram_url', label: 'Instagram URL' },
                { key: 'youtube_url',   label: 'YouTube URL' },
                { key: 'telegram_url',  label: 'Telegram URL' },
                { key: 'whatsapp_url',  label: 'WhatsApp URL' },
                { key: 'website_url',   label: 'Website URL' },
              ].map(({ key, label: lbl }) => (
                <View key={key} style={{ marginBottom: 12 }}>
                  {label(lbl)}
                  <TextInput value={brand[key] ?? ''} onChangeText={v => set(key, v)} style={{ ...inp }} autoCapitalize="none" placeholder="https://" placeholderTextColor={`${c.text}55`} />
                </View>
              ))}
            </NeuCard>

            <NeuButton label="Save Branding" onPress={handleSave} loading={saving} fullWidth />
          </>
        )}
      </View>
    </ScrollView>
  );
}
