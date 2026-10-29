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
import { neuColors, mutedTextStyle } from '@/lib/neu';
import { NeuInputRow } from '@/components/NeuInputRow';
import { t } from '@/lib/i18n';


/**
 * Map a password-change failure to localized copy.
 *
 * The endpoint may return free-form text; we NEVER render it verbatim. Known
 * causes map to specific messages, everything else falls back to a generic
 * localized error while the original detail is kept for developer logs only.
 */
function passwordChangeError(message: string | undefined): string {
  const m = (message ?? '').toLowerCase();
  if (process.env.NODE_ENV !== 'production' && message) {
    console.warn('[SecurityCenter] password change failed:', message);
  }
  if (m.includes('at least') || m.includes('too short') || m.includes('minimum')) return t('securityCenter.errLength');
  if (m.includes('match') || m.includes('confirm')) return t('securityCenter.errMatch');
  if (m.includes('same') || m.includes('current password')) return t('securityCenter.errSame');
  if (m.includes('network') || m.includes('connect') || m.includes('timeout') || m.includes('fetch')) {
    return t('securityCenter.errNetwork');
  }
  return t('securityCenter.changeFailed');
}

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
    if (newPassword.length < 8) { setError(t('securityCenter.errLength')); return; }
    if (newPassword !== confirmPassword) { setError(t('securityCenter.errMatch')); return; }
    setSaving(true);
    setError('');
    try {
      // Routes through change-password Edge Function — logs to audit, no email required
      await changePassword(newPassword);
      setSuccess(true);
      setNewPassword('');
      setConfirmPassword('');
    } catch (e: any) {
      setError(passwordChangeError(e?.message));
    }
    setSaving(false);
  };



  return (
    <KeyboardAvoidingView behavior={undefined} /* keyboard: native inset only */ style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} contentContainerStyle={{ flexGrow: 1, paddingTop: 0 }} keyboardShouldPersistTaps="handled">
        <PageHeader title={t('securityCenter.title')} subtitle={t('securityCenter.subtitle')} />

      <View style={{ paddingHorizontal: 24 }}>

        {/* Account Security Info */}
        <NeuCard style={{ marginBottom: 20, padding: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center', marginEnd: 12 }}>
              <Shield size={22} color={c.primary} />
            </View>
            <View>
              <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>{t('securityCenter.accountSecurity')}</Text>
              <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5) }}>{getContactDisplay(profile)}</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#16A34A12', borderRadius: 10, padding: 10 }}>
            <CheckCircle size={16} color="#16A34A" style={{ marginEnd: 8 }} />
            <Text style={{ fontSize: 13, color: '#16A34A', fontWeight: '600' }}>{t('securityCenter.securedWith')}</Text>
          </View>
        </NeuCard>

        {/* Watermark ID — the CANONICAL public identity (MED-####), the exact
            same source the real video/PDF watermark renders (see
            watermarkIdentity.ts). NEVER the internal DB id or the legacy
            watermark token column (which held opaque values like "16"). */}
        <NeuCard style={{ marginBottom: 20, padding: 18 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 6 }}>{t('securityCenter.watermarkId')}</Text>
          <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.55), marginBottom: 10, lineHeight: 18 }}>
            {t('securityCenter.watermarkDesc')}
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
                accessibilityLabel={t('securityCenter.copyWatermark')}
                style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: `${c.primary}1A` }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>
                  {wmCopied ? t('securityCenter.copied') : t('securityCenter.copy')}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ backgroundColor: `${c.text}0A`, borderRadius: 10, padding: 12 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', ...mutedTextStyle(c, 0.6) }}>
                {profile?.role === 'super_admin' ? t('securityCenter.notApplicable') : t('securityCenter.notAssigned')}
              </Text>
            </View>
          )}
          <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.4), marginTop: 8 }}>
            {t('securityCenter.readOnly')}
          </Text>
        </NeuCard>

        {/* Change Password */}
        <NeuCard radius={22} style={{ padding: 22 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            <Lock size={20} color={c.primary} style={{ marginEnd: 10 }} />
            <Text style={{ fontSize: 17, fontWeight: '800', color: c.text }}>{t('securityCenter.changePassword')}</Text>
          </View>

          <Text style={{ fontSize: 12, fontWeight: '600', ...mutedTextStyle(c, 0.55), marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>{t('securityCenter.newPassword')}</Text>
          <NeuInputRow
            c={c}
            value={newPassword}
            onChangeText={setNewPassword}
            placeholder={t('signUp.passwordPlaceholder')}
            secureTextEntry={!showPwd}
            leftIcon={<Lock size={18} color={c.text} opacity={0.4} />}
            rightElement={
              <Pressable onPress={() => setShowPwd(!showPwd)}>
                {showPwd ? <EyeOff size={18} color={c.text} opacity={0.4} /> : <Eye size={18} color={c.text} opacity={0.4} />}
              </Pressable>
            }
          />

          <Text style={{ fontSize: 12, fontWeight: '600', ...mutedTextStyle(c, 0.55), marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>{t('securityCenter.confirmPassword')}</Text>
          <NeuInputRow
            c={c}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder={t('securityCenter.reenterPassword')}
            secureTextEntry={!showPwd}
            leftIcon={<Lock size={18} color={c.text} opacity={0.4} />}
          />

          {error ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <AlertCircle size={14} color="#DC2626" style={{ marginEnd: 6 }} />
              <Text style={{ color: '#DC2626', fontSize: 13 }}>{error}</Text>
            </View>
          ) : null}
          {success ? <Text style={{ color: '#16A34A', fontSize: 13, marginBottom: 12 }}>{t('securityCenter.passwordUpdated')}</Text> : null}

          <NeuButton label={t('securityCenter.updatePassword')} onPress={handleChangePassword} loading={saving} fullWidth />
        </NeuCard>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
