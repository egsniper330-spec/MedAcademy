import { useState } from 'react';
import { View, Text, ScrollView, useColorScheme, Pressable, KeyboardAvoidingView, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft, Lock, Shield, Eye, EyeOff, CheckCircle, AlertCircle } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { PageHeader } from '@/components/PageHeader';
import { useProfileStore } from '@/lib/store';
import { changePassword } from '@/lib/api';
import { getContactDisplay } from '@/lib/api';
import { resolveWatermarkIdentity, isPublicWatermarkToken } from '@/lib/watermarkIdentity';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors } from '@/lib/neu';
import { NeuInputRow } from '@/components/NeuInputRow';

export default function SecurityCenter() {
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const { profile } = useProfileStore();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  // CANONICAL public watermark identity (MED-####) — the exact source the
  // video/PDF watermark renderers use. Never the DB id, never the legacy
  // watermark token column (which held opaque values like "16").
  const resolved = resolveWatermarkIdentity(profile);
  // Display-only strictness: a bare numeric legacy token is indistinguishable
  // from an internal id, so the Security Center shows the not-applicable/
  // unassigned state instead of echoing it back.
  const wmIdentity = resolved && isPublicWatermarkToken(resolved.id) ? resolved : null;
  const [wmCopied, setWmCopied] = useState(false);

  const handleChangePassword = async () => {
    if (newPassword.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    setSaving(true);
    setError('');
    try {
      // Routes through change-password Edge Function — logs to audit, no email required
      await changePassword(newPassword);
      setSuccess(true);
      setNewPassword('');
      setConfirmPassword('');
    } catch (e: any) {
      setError(e?.message ?? 'Password change failed.');
    }
    setSaving(false);
  };



  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingTop: 0 }} keyboardShouldPersistTaps="handled">
        <PageHeader title="Security Center" subtitle="Password & account security" showBack />

      <View style={{ paddingHorizontal: 24 }}>

        {/* Account Security Info */}
        <NeuCard style={{ marginBottom: 20, padding: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Shield size={22} color={c.primary} />
            </View>
            <View>
              <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>Account Security</Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{getContactDisplay(profile)}</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#16A34A12', borderRadius: 10, padding: 10 }}>
            <CheckCircle size={16} color="#16A34A" style={{ marginRight: 8 }} />
            <Text style={{ fontSize: 13, color: '#16A34A', fontWeight: '600' }}>Account is secured with email/password authentication</Text>
          </View>
        </NeuCard>

        {/* Watermark ID — the CANONICAL public identity (MED-####), the exact
            same source the real video/PDF watermark renders (see
            watermarkIdentity.ts). NEVER the internal DB id or the legacy
            watermark token column (which held opaque values like "16"). */}
        <NeuCard style={{ marginBottom: 20, padding: 18 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 6 }}>Your Watermark ID</Text>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, marginBottom: 10, lineHeight: 18 }}>
            This ID is used to identify your account in protected video and PDF content.
          </Text>
          {wmIdentity ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: `${c.primary}12`, borderRadius: 10, padding: 12, gap: 10 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary, fontFamily: 'monospace', letterSpacing: 1, flexShrink: 1 }} numberOfLines={1}>
                {wmIdentity.id}
              </Text>
              <Pressable
                onPress={async () => {
                  await Clipboard.setStringAsync(wmIdentity.id);
                  setWmCopied(true);
                  setTimeout(() => setWmCopied(false), 1500);
                }}
                accessibilityRole="button"
                accessibilityLabel="Copy watermark ID"
                style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: `${c.primary}1A` }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>
                  {wmCopied ? 'Copied ✓' : 'Copy'}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ backgroundColor: `${c.text}0A`, borderRadius: 10, padding: 12 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, opacity: 0.6 }}>
                {profile?.role === 'super_admin' ? 'Not applicable — administrator accounts do not participate in content watermarking.' : 'Watermark identity not yet assigned.'}
              </Text>
            </View>
          )}
          <Text style={{ fontSize: 10, color: c.text, opacity: 0.4, marginTop: 8 }}>
            Read-only — assigned by the system, shown identically inside watermarked content.
          </Text>
        </NeuCard>

        {/* Change Password */}
        <NeuCard radius={22} style={{ padding: 22 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            <Lock size={20} color={c.primary} style={{ marginRight: 10 }} />
            <Text style={{ fontSize: 17, fontWeight: '800', color: c.text }}>Change Password</Text>
          </View>

          <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, opacity: 0.55, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>New Password</Text>
          <NeuInputRow
            c={c}
            value={newPassword}
            onChangeText={setNewPassword}
            placeholder="Min. 8 characters"
            secureTextEntry={!showPwd}
            leftIcon={<Lock size={18} color={c.text} opacity={0.4} />}
            rightElement={
              <Pressable onPress={() => setShowPwd(!showPwd)}>
                {showPwd ? <EyeOff size={18} color={c.text} opacity={0.4} /> : <Eye size={18} color={c.text} opacity={0.4} />}
              </Pressable>
            }
          />

          <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, opacity: 0.55, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Confirm Password</Text>
          <NeuInputRow
            c={c}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder="Re-enter password"
            secureTextEntry={!showPwd}
            leftIcon={<Lock size={18} color={c.text} opacity={0.4} />}
          />

          {error ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <AlertCircle size={14} color="#DC2626" style={{ marginRight: 6 }} />
              <Text style={{ color: '#DC2626', fontSize: 13 }}>{error}</Text>
            </View>
          ) : null}
          {success ? <Text style={{ color: '#16A34A', fontSize: 13, marginBottom: 12 }}>✓ Password updated successfully!</Text> : null}

          <NeuButton label="Update Password" onPress={handleChangePassword} loading={saving} fullWidth />
        </NeuCard>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
