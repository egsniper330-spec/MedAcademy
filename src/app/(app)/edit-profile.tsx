import { useState } from 'react';
import { View, Text, ScrollView, useColorScheme, TextInput, Pressable, KeyboardAvoidingView } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { User, Phone, Mail, Lock, Fingerprint, Copy, CheckCircle } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { Image } from 'expo-image';
import { useProfileStore } from '@/lib/store';
import { updateProfile, getPublicEmail, isInternalEmail } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors } from '@/lib/neu';
import { normalizePhoneE164 } from '@/lib/identifier';
import { validateRequired, friendlyError } from '@/lib/validation';
import { NeuInputRow } from '@/components/NeuInputRow';

export default function EditProfile() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const { profile, setProfile } = useProfileStore();
  const { showToast } = useToast();

  const canEditContact = profile?.role === 'admin' || profile?.role === 'super_admin';

  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [profileEmail, setProfileEmail] = useState(getPublicEmail(profile) ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [wmCopied, setWmCopied] = useState(false);

  const handleCopyWatermark = () => {
    const wm = profile?.watermark_id;
    if (!wm) return;
    void Clipboard.setStringAsync(wm);
    setWmCopied(true);
    setTimeout(() => setWmCopied(false), 2000);
  };

  const handleSave = async () => {
    const nameErr = validateRequired(fullName, 'Full name');
    if (nameErr) { setError(nameErr); return; }

    if (canEditContact && phone.trim()) {
      const normalized = normalizePhoneE164(phone.trim());
      if (!normalized) { setError('Enter a valid phone number (e.g. +20 100 000 0000 or 01001234567).'); return; }
    }

    // Validate real email if provided
    if (profileEmail.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(profileEmail.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    // Prevent saving an internal placeholder as the real email
    if (isInternalEmail(profileEmail.trim())) {
      setError('Enter a valid email address.');
      return;
    }

    setSaving(true); setError('');
    try {
      const updates: Record<string, string | null> = { full_name: fullName.trim() };
      if (canEditContact && phone.trim()) {
        updates.phone = normalizePhoneE164(phone.trim()) ?? phone.trim();
      }
      // profile_email: set to trimmed value or null if cleared
      updates.profile_email = profileEmail.trim() || null;
      const updated = await updateProfile(profile!.id, updates);
      setProfile({ ...profile!, ...(updated as any) });
      showToast({ type: 'success', message: 'Profile updated successfully.' });
      setTimeout(() => router.back(), 800);
    } catch (e: any) {
      const msg = friendlyError(e, 'Failed to update profile.');
      setError(msg);
      showToast({ type: 'error', message: msg });
    }
    setSaving(false);
  };



  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 24, paddingTop: 0 }} keyboardShouldPersistTaps="handled">
        <PageHeader title="Edit Profile" showBack />

        {/* Avatar */}
        <View style={{ alignItems: 'center', marginBottom: 28 }}>
          <View style={{ width: 88, height: 88, borderRadius: 44, backgroundColor: `${c.primary}20`, alignItems: 'center', justifyContent: 'center' }}>
            {profile?.avatar_url ? (
              <Image source={{ uri: profile.avatar_url }} style={{ width: 88, height: 88, borderRadius: 44 }} contentFit="cover" />
            ) : (
              <User size={40} color={c.primary} />
            )}
          </View>
        </View>

        <NeuCard radius={22} style={{ padding: 22 }}>
          {/* Full Name — always editable */}
          <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, opacity: 0.55, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Full Name</Text>
          <NeuInputRow
            c={c}
            value={fullName}
            onChangeText={setFullName}
            placeholder="Your full name"
            leftIcon={<User size={18} color={c.text} opacity={0.4} />}
          />

          {/* Phone — editable only for admin/super_admin */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 6 }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, opacity: 0.55, textTransform: 'uppercase', letterSpacing: 0.8 }}>Phone Number</Text>
            {!canEditContact && <Lock size={12} color={c.text} opacity={0.35} />}
          </View>
          <NeuInputRow
            c={c}
            containerStyle={{ opacity: canEditContact ? 1 : 0.55 }}
            value={canEditContact ? phone : (profile?.phone ?? '')}
            onChangeText={canEditContact ? setPhone : undefined}
            editable={canEditContact}
            placeholder="+20 100 000 0000"
            keyboardType="phone-pad"
            leftIcon={<Phone size={18} color={c.text} opacity={0.4} />}
          />
          {!canEditContact && (
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginBottom: 12, marginTop: -10 }}>
              Phone number can only be changed by an admin.
            </Text>
          )}

          {/* Email — editable for all users (updates profile_email only, never auth email) */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 6 }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, opacity: 0.55, textTransform: 'uppercase', letterSpacing: 0.8 }}>Email</Text>
          </View>
          <NeuInputRow
            c={c}
            value={profileEmail}
            onChangeText={setProfileEmail}
            placeholder="Not set"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            leftIcon={<Mail size={18} color={c.text} opacity={0.4} />}
          />
          <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginBottom: 12, marginTop: -10 }}>
            Add or update your email address. Your login method stays unchanged.
          </Text>

          {error ? <Text style={{ color: '#DC2626', fontSize: 13, marginBottom: 12 }}>{error}</Text> : null}
          <NeuButton label="Save Changes" onPress={handleSave} loading={saving} fullWidth />
        </NeuCard>

        {/* ── ID (read-only) ── */}
        <NeuCard radius={22} style={{ padding: 20, marginTop: 18 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: `${c.primary}15`, alignItems: 'center', justifyContent: 'center' }}>
              <Fingerprint size={17} color={c.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.9 }}>ID</Text>
              <Text style={{ fontSize: 17, fontWeight: '800', color: c.primary, letterSpacing: 1.4, marginTop: 1, fontVariant: ['tabular-nums'] }}>
                {profile?.watermark_id ?? '—'}
              </Text>
            </View>
            <Pressable
              onPress={handleCopyWatermark}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 9, backgroundColor: wmCopied ? '#16A34A18' : `${c.primary}12` }}
            >
              {wmCopied ? <CheckCircle size={14} color="#16A34A" /> : <Copy size={14} color={c.primary} />}
              <Text style={{ fontSize: 11, fontWeight: '700', color: wmCopied ? '#16A34A' : c.primary }}>{wmCopied ? 'Copied!' : 'Copy'}</Text>
            </Pressable>
          </View>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, lineHeight: 17 }}>
            Permanently embedded as a forensic watermark in every video you watch. Cannot be changed.
          </Text>
        </NeuCard>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
