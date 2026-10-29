/**
 * DoctorProfile — permanent profile tab for the doctor role.
 *
 * Contains two in-page tabs:
 *   Profile  — identity, account info, contact info, business settings
 *   Settings — edit profile, change password, sign out
 *
 * The earnings feature has been retired: no earnings tab, toggle, dashboard or
 * pricing tools remain anywhere in the app.
 */

import { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable, I18nManager,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  User, Mail, Phone, Lock, LogOut,
  BookOpen, Users, CreditCard, Fingerprint, Copy, CheckCircle,
  Pencil, MessageCircle, Send,
  Eye, EyeOff, AlertCircle, FileText, Shield, HeartHandshake, Info,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { validateRequired, friendlyError } from '@/lib/validation';
import {
  isInternalEmail, changePassword,
  getProfile, getCourses, getDoctorStudentEnrollments, getPublicEmail, updateProfile, removeProfileAvatar,
} from '@/lib/api';
import { backendClient } from '@/client/backendClient';
import { useProfileStore } from '@/lib/store';
import { ProfilePhotoActions } from '@/components/ProfilePhotoActions';
import { resolveImageMime, extFromMime, buildAvatarStoragePath, avatarFileName } from '@/lib/uploadPart';
import { useCreditBalance } from '@/lib/useCreditBalance';
import { getFirstName } from '@/lib/utils';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { NeuInputRow } from '@/components/NeuInputRow';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, mutedTextStyle } from '@/lib/neu';
import { usePermission } from '@/hooks/usePermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';
import { useTranslation } from '@/lib/i18n';
import { LanguageSetting } from '@/components/LanguageSetting';
import { SettingsRow } from '@/components/SettingsRow';


// ── Profile tabs ──────────────────────────────────────────────────────────────
type ProfileTab = 'profile' | 'settings';
const PROFILE_TABS: { key: ProfileTab; labelKey: string }[] = [
  { key: 'profile',  labelKey: 'common.profile'  },
  { key: 'settings', labelKey: 'common.settings' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function SectionLabel({ label, color }: { label: string; color: string }) {
  return (
    <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase',
                   color, opacity: 0.5, marginBottom: 10, marginTop: 4 }}>
      {label}
    </Text>
  );
}


function InfoRow({ icon, label, value, c }: { icon: React.ReactNode; label: string; value: string; c: typeof neuColors.light }) {
  // Same RTL-safe contract as the shared SettingsRow: gap-based spacing, no
  // physical margins, direction-aware alignment, wrapping labels.
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12,
                   borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
      <View style={{ width: 26, alignItems: 'center', flexShrink: 0 }}>{icon}</View>
      <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5), maxWidth: '45%' }} numberOfLines={2}>{label}</Text>
      <Text style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: '600', color: c.text, textAlign: I18nManager.isRTL ? 'left' : 'right' }} numberOfLines={2}>
        {value || '—'}
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact edit hook (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function useContactEdit(profile: any, setProfile: (p: any) => void) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { showToast } = useToast();
  const { t } = useTranslation();

  const [showEdit, setShowEdit]       = useState(false);
  const [whatsapp, setWhatsapp]       = useState('');
  const [telegram, setTelegram]       = useState('');
  const [phone, setPhone]             = useState('');
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');

  const openEdit = () => {
    setWhatsapp((profile as any)?.contact_whatsapp ?? '');
    setTelegram((profile as any)?.contact_telegram ?? '');
    setPhone((profile as any)?.contact_phone ?? '');
    setError('');
    setShowEdit(true);
  };

  const handleSave = async () => {
    if (!profile?.id) return;
    setSaving(true); setError('');
    try {
      const updated = await updateProfile(profile.id, {
        contact_whatsapp: whatsapp.trim() || null,
        contact_telegram: telegram.trim() || null,
        contact_phone:    phone.trim()    || null,
      });
      setProfile({ ...profile, ...(updated as any) });
      showToast({ type: 'success', message: t('drProfile.contactSaved') });
      setShowEdit(false);
    } catch (e: any) {
      setError(e?.message ?? t('drProfile.saveFailed'));
    }
    setSaving(false);
  };

  // inputStyle removed — use NeuInputRow instead

  const modal = (
    <ResponsiveModal
      visible={showEdit}
      onClose={() => setShowEdit(false)}
      title={t('drProfile.section.contact')}
      footer={
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <NeuButton label={t('common.cancel')} onPress={() => setShowEdit(false)} variant="secondary" style={{ flex: 1 }} />
          <NeuButton label={t('common.save')} onPress={handleSave} loading={saving} style={{ flex: 1 }} />
        </View>
      }
    >
      
        <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5), marginBottom: 16, lineHeight: 19 }}>
          {t('drProfile.contactIntro')}
        </Text>

        {/* WhatsApp */}
        <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
          {t('drProfile.whatsappNumber')}
        </Text>
        <NeuInputRow
          c={c}
          value={whatsapp}
          onChangeText={setWhatsapp}
          placeholder="+201234567890"
          keyboardType="phone-pad"
          leftIcon={<MessageCircle size={16} color="#25D366" />}
          rightElement={whatsapp.trim() ? <CheckCircle size={14} color="#25D366" /> : undefined}
        />

        {/* Telegram */}
        <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
          {t('drProfile.telegram')}
        </Text>
        <NeuInputRow
          c={c}
          value={telegram}
          onChangeText={setTelegram}
          placeholder={t('drProfile.telegramPlaceholder')}
          autoCapitalize="none"
          leftIcon={<Send size={16} color="#229ED9" />}
          rightElement={telegram.trim() ? <CheckCircle size={14} color="#229ED9" /> : undefined}
        />

        {/* Phone */}
        <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
          {t('drProfile.phoneNumber')}
        </Text>
        <NeuInputRow
          c={c}
          containerStyle={{ marginBottom: 4 }}
          value={phone}
          onChangeText={setPhone}
          placeholder="+201234567890"
          keyboardType="phone-pad"
          leftIcon={<Phone size={16} color={c.primary} />}
          rightElement={phone.trim() ? <CheckCircle size={14} color={c.primary} /> : undefined}
        />

        {error ? (
          <Text style={{ fontSize: 13, color: '#DC2626', marginTop: 8 }}>{error}</Text>
        ) : null}
      
    </ResponsiveModal>
  );

  return { openEdit, modal };
}

// ─── Public User ID card ───────────────────────────────────────────────────
// Displays the PUBLIC USER ID (MED-####) — the canonical user-facing identifier.
// The internal legacy watermark_id must never be shown here.
function WatermarkCard({ publicUserId, c }: { publicUserId: string | null; c: typeof neuColors.light }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!publicUserId && __DEV__) {
    console.warn('[DrProfile] public_user_id missing from profile payload — check backend PUBLIC_COLS/profile select.');
  }
  const handleCopy = () => {
    if (!publicUserId) return;
    void Clipboard.setStringAsync(publicUserId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <NeuCard radius={18} style={{ padding: 18, marginBottom: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: `${c.primary}15`, alignItems: 'center', justifyContent: 'center' }}>
          <Fingerprint size={18} color={c.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase', letterSpacing: 0.9 }}>
            {t('drProfile.userId')}
          </Text>
          <Text style={{ fontSize: 18, fontWeight: '800', color: c.primary, letterSpacing: 1.5, marginTop: 2, fontVariant: ['tabular-nums'] }}>
            {publicUserId ?? '—'}
          </Text>
        </View>
        <Pressable
          onPress={handleCopy}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 5,
            paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
            backgroundColor: copied ? '#16A34A18' : `${c.primary}12`,
          }}
        >
          {copied ? <CheckCircle size={15} color="#16A34A" /> : <Copy size={15} color={c.primary} />}
          <Text style={{ fontSize: 12, fontWeight: '700', color: copied ? '#16A34A' : c.primary }}>
            {copied ? t('profile.copied') : t('drProfile.copy')}
          </Text>
        </Pressable>
      </View>
      <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.4), lineHeight: 17 }}>
        {t('drProfile.watermarkNote')}
      </Text>
    </NeuCard>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function DoctorProfile() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const layout = useLayout();
  const { profile, setProfile } = useProfileStore();
  const { t } = useTranslation();

  const [activeTab,    setActiveTab]    = useState<ProfileTab>('profile');
  const [courseCount,  setCourseCount]  = useState<number | null>(null);
  const [studentCount, setStudentCount] = useState<number | null>(null);
  const [refreshing,   setRefreshing]   = useState(false);
  const [dataLoading,  setDataLoading]  = useState(true);
  const [showLogout,   setShowLogout]   = useState(false);

  // ── Edit personal info (name / email) ─────────────────────────────────────
  const [showPersonalEdit, setShowPersonalEdit] = useState(false);
  const [editName, setEditName]     = useState('');
  const [editEmail, setEditEmail]   = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError]   = useState('');

  const openPersonalEdit = () => {
    setEditName(profile?.full_name ?? '');
    setEditEmail(getPublicEmail(profile) ?? '');
    setEditError('');
    setShowPersonalEdit(true);
  };

  const handleSavePersonal = async () => {
    const nameErr = validateRequired(editName, t('profile.fullName'));
    if (nameErr) { setEditError(nameErr); return; }
    if (editEmail.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(editEmail.trim())) {
      setEditError(t('drProfile.invalidEmail')); return;
    }
    if (isInternalEmail(editEmail.trim())) {
      setEditError(t('drProfile.invalidEmail')); return;
    }
    if (!profile?.id) return;
    setEditSaving(true); setEditError('');
    try {
      const updated = await updateProfile(profile.id, {
        full_name:     editName.trim(),
        profile_email: editEmail.trim() || null,
      });
      setProfile({ ...profile, ...(updated as any) });
      showToast({ type: 'success', message: t('drProfile.profileSaved') });
      setShowPersonalEdit(false);
    } catch (e: any) {
      setEditError(friendlyError(e, t('drProfile.saveFailed')));
    }
    setEditSaving(false);
  };

  // ── Change password ───────────────────────────────────────────────────────
  const [showPwdEdit, setShowPwdEdit]   = useState(false);
  const [newPwd, setNewPwd]             = useState('');
  const [confirmPwd, setConfirmPwd]     = useState('');
  const [showPwd, setShowPwd]           = useState(false);
  const [pwdSaving, setPwdSaving]       = useState(false);
  const [pwdError, setPwdError]         = useState('');
  const [pwdSuccess, setPwdSuccess]     = useState(false);

  const openPwdEdit = () => {
    setNewPwd(''); setConfirmPwd(''); setPwdError(''); setPwdSuccess(false); setShowPwd(false);
    setShowPwdEdit(true);
  };

  const handleChangePassword = async () => {
    if (newPwd.length < 8) { setPwdError(t('drProfile.passwordMin')); return; }
    if (newPwd !== confirmPwd) { setPwdError(t('drProfile.passwordMismatch')); return; }
    setPwdSaving(true); setPwdError('');
    try {
      await changePassword(newPwd);
      setPwdSuccess(true);
      setNewPwd(''); setConfirmPwd('');
      setTimeout(() => { setPwdSuccess(false); setShowPwdEdit(false); }, 2000);
    } catch (e: any) {
      setPwdError(e?.message ?? t('drProfile.passwordFailed'));
    }
    setPwdSaving(false);
  };

  // ── Avatar upload ─────────────────────────────────────────────────────────
  const [avatarUploading, setAvatarUploading] = useState(false);
  const {
    ensurePermission: ensurePhotoPermission,
    showRationale: showPhotoRationale,
    setShowRationale: setShowPhotoRationale,
    isBlocked: photoBlocked,
    confirmRequest: confirmPhotoRequest,
  } = usePermission('mediaLibrary');

  const handlePickAvatar = async () => {
    const granted = await ensurePhotoPermission();
    if (!granted) return; // rationale modal will appear
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets[0]?.uri) return;
    if (!profile?.id) return;
    setAvatarUploading(true);
    try {
      const asset = result.assets[0];
      const mime  = resolveImageMime(asset.mimeType, asset.uri);
      const ext   = extFromMime(mime);
      // Unique path per upload (fresh URL → no stale CDN/browser cache) and
      // scoped under the user id, which the backend requires for avatars.
      const path  = buildAvatarStoragePath(profile.id, ext, Date.now());
      // Upload the local file URI directly — RN streams it from disk.
      // Never load the image into JS memory (no arrayBuffer/Blob needed).
      const { error: upErr } = await backendClient.storage
        .from('user-avatars')
        .upload(path, { uri: asset.uri, mimeType: mime, name: avatarFileName(ext) }, {
          upsert: true, contentType: mime,
        });
      if (upErr) throw upErr;
      const { data: { publicUrl } } = backendClient.storage.from('user-avatars').getPublicUrl(path);
      const updated = await updateProfile(profile.id, { avatar_url: publicUrl });
      setProfile({ ...profile, ...(updated as any) });
      showToast({ type: 'success', message: t('drProfile.avatarUpdated') });
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? t('drProfile.avatarUploadFailed') });
    }
    setAvatarUploading(false);
  };

  // ── Avatar removal ────────────────────────────────────────────────────────
  // Same contract as the student profile: clear profiles.avatar_url first
  // (authoritative and persistent), then best-effort delete the storage
  // object. A failure rethrows so the existing photo stays visible with a
  // real error rather than silently blanking the avatar.
  const [avatarRemoving, setAvatarRemoving] = useState(false);
  const handleRemoveAvatar = async () => {
    if (!profile?.id) return;
    setAvatarRemoving(true);
    try {
      const current = profile.avatar_url;
      await removeProfileAvatar(profile.id, current);
      setProfile({ ...profile, avatar_url: null } as any);
      showToast({ type: 'success', message: t('drProfile.photoRemoved') });
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? t('drProfile.photoRemoveFailed') });
    }
    setAvatarRemoving(false);
  };

  const { showToast } = useToast();
  const { balance: credits, loading: credLoading, refresh: refreshCredits } = useCreditBalance();
  const { openEdit: openContactEdit, modal: contactModal } = useContactEdit(profile, setProfile);

  const loadData = useCallback(async () => {
    if (!profile?.id) { setDataLoading(false); return; }
    setDataLoading(true);
    try {
      const { data: { user } } = await backendClient.auth.getUser();
      if (user) {
        const freshProfile = await getProfile(user.id);
        if (freshProfile) setProfile(freshProfile as any);
      }
      const [courses, enrollments] = await Promise.allSettled([
        getCourses({ doctorId: profile.id }),
        getDoctorStudentEnrollments(profile.id),
      ]);
      if (courses.status === 'fulfilled')     setCourseCount(courses.value?.length ?? 0);
      if (enrollments.status === 'fulfilled') setStudentCount(enrollments.value?.length ?? 0);
    } catch (e: any) {
      console.error('[DoctorProfile] loadData error:', e?.message ?? e);
    }
    setDataLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  useFocusEffect(useCallback(() => { (async () => { await loadData(); })(); }, [loadData]));

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadData(), refreshCredits()]);
    setRefreshing(false);
  };

  const handleLogout = async () => {
    setShowLogout(false);
    // Eagerly wipe the profile store so no stale role data remains visible
    // while backendClient.auth.signOut() completes and the new session initialises.
    const { clearProfile } = useProfileStore.getState();
    clearProfile();
    await backendClient.auth.signOut();
  };

  const statusColor = profile?.status === 'active' ? '#16A34A'
    : profile?.status === 'suspended' ? '#DC2626' : '#D97706';
  const firstName   = getFirstName(profile?.full_name);
  const isLoading   = dataLoading || credLoading;

  // ── Tab: Profile ───────────────────────────────────────────────────────────
  const renderProfileTab = () => (
    <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      // BOTTOM clearance: layout.scrollBottom() = safeBottom(insets.bottom,
      // tabBarClearance). The raw safeBottom(insets.bottom) reserved only the
      // home indicator, so on iOS the floating NATIVE tab bar (drawn by UIKit
      // outside the RN hierarchy) covered the tail of this scrolling tab.
      // Android/web resolve a 0 clearance — byte-for-byte unchanged there.
      contentContainerStyle={{ paddingHorizontal: layout.screenPx, paddingTop: layout.screenPx, paddingBottom: layout.scrollBottom() }}
    >
      {/* Stats row */}
      <SectionLabel label={t('common.overview')} color={c.text} />
      {isLoading ? (
        <ActivityIndicator color={c.primary} style={{ marginVertical: 20 }} />
      ) : (
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 20 }}>
          {[
            { label: t('drProfile.stats.courses'),  value: courseCount  ?? 0, color: c.primary, icon: <BookOpen  size={20} color={c.primary} /> },
            { label: t('drProfile.stats.students'), value: studentCount ?? 0, color: '#D97706', icon: <Users     size={20} color="#D97706" /> },
            { label: t('drProfile.stats.credits'),  value: credits?.remaining ?? 0, color: '#16A34A', icon: <CreditCard size={20} color="#16A34A" /> },
          ].map(stat => (
            <NeuCard key={stat.label} radius={16} style={{ flex: 1, alignItems: 'center', padding: 14, gap: 6 }}>
              {stat.icon}
              <Text style={{ fontSize: 26, fontWeight: '800', color: stat.color }}>{stat.value}</Text>
              <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5) }}>{stat.label}</Text>
            </NeuCard>
          ))}
        </View>
      )}

      {/* Watermark */}
      <SectionLabel label={t('drProfile.section.watermark')} color={c.text} />
      <WatermarkCard publicUserId={(profile as any)?.public_user_id ?? null} c={c} />

      {/* Account info */}
      <SectionLabel label={t('drProfile.section.account')} color={c.text} />
      <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
        <InfoRow icon={<Mail size={16} color={c.primary} />}  label={t('profile.email')} value={getPublicEmail(profile) ?? t('profile.notSet')} c={c} />
        <InfoRow icon={<Phone size={16} color={c.primary} />} label={t('profile.phone')} value={profile?.phone ?? ''} c={c} />
        <InfoRow icon={<Lock size={16} color={c.text} />}     label={t('profile.role')}  value={t('role.doctor')} c={c} />
      </NeuCard>

      {/* Contact info */}
      <SectionLabel label={t('drProfile.section.contact')} color={c.text} />
      <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
        <InfoRow icon={<MessageCircle size={16} color="#25D366" />} label={t('drProfile.whatsApp')}
          value={(profile as any)?.contact_whatsapp ?? ''} c={c} />
        <InfoRow icon={<Send size={16} color="#229ED9" />}          label={t('drProfile.telegram')}
          value={(profile as any)?.contact_telegram ?? ''} c={c} />
        <InfoRow icon={<Phone size={16} color={c.primary} />}       label={t('profile.phone')}
          value={(profile as any)?.contact_phone ?? ''} c={c} />
        <Pressable onPress={openContactEdit}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                   marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: `${c.text}08` }}>
          <Pencil size={15} color={c.primary} />
          {/* `marginStart`: the gap belongs on the trailing side of the icon, which
              is the LEFT in Arabic — a physical marginLeft put it between the
              icon and the screen edge instead of between icon and label. */}
          <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary, marginStart: 7 }}>
            {t('drProfile.editContact')}
          </Text>
        </Pressable>
      </NeuCard>
    </ScrollView>
  );

  // ── Tab: Settings ──────────────────────────────────────────────────────────
  const renderSettingsTab = () => {
    const INFO_LINKS = [
      { label: t('drProfile.terms'),     icon: FileText,       path: '/(app)/info/terms'   as RelativePathString },
      { label: t('drProfile.privacy'),   icon: Shield,         path: '/(app)/info/privacy' as RelativePathString },
      { label: t('drProfile.about'),     icon: Info,           path: '/(app)/info/about'   as RelativePathString },
      { label: t('drProfile.contactUs'), icon: HeartHandshake, path: '/(app)/info/contact' as RelativePathString },
    ];
    return (
      <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
        style={{ flex: 1, backgroundColor: c.base }}
        // See renderProfileTab: same iOS native-tab-bar clearance.
        contentContainerStyle={{ paddingHorizontal: layout.screenPx, paddingTop: layout.screenPx, paddingBottom: layout.scrollBottom() }}
      >
        {/* ── Edit Profile ───────────────────────────────────────────── */}
        <SectionLabel label={t('common.profile')} color={c.text} />
        <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
          <InfoRow icon={<Mail size={16} color={c.primary} />}  label={t('profile.email')} value={getPublicEmail(profile) ?? t('profile.notSet')} c={c} />
          <InfoRow icon={<Phone size={16} color={c.primary} />} label={t('profile.phone')} value={profile?.phone ?? ''} c={c} />
          <Pressable
            onPress={openPersonalEdit}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                     marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: `${c.text}08` }}
          >
            <Pencil size={15} color={c.primary} />
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary, marginStart: 7 }}>{t('drProfile.editNameEmail')}</Text>
          </Pressable>
        </NeuCard>

        {/* ── Security ───────────────────────────────────────────────── */}
        <SectionLabel label={t('profile.security')} color={c.text} />
        {/* Shared SettingsRow: gap-based icon/text spacing (physical margins
            were landing on the wrong side in Arabic and crowding the icon). */}
        <NeuCard radius={18} style={{ paddingHorizontal: 16, marginBottom: 20 }}>
          <SettingsRow
            c={c}
            icon={<Lock size={18} color={c.primary} />}
            label={t('drProfile.changePassword')}
            onPress={openPwdEdit}
          />
          <SettingsRow
            c={c}
            last
            destructive
            icon={<LogOut size={18} color="#DC2626" />}
            label={t('common.signOut')}
            onPress={() => setShowLogout(true)}
          />
        </NeuCard>

        {/* ── Information Links ───────────────────────────────────────── */}
        <SectionLabel label={t('drProfile.section.information')} color={c.text} />
        <NeuCard radius={18} style={{ paddingHorizontal: 16, marginBottom: 20 }}>
          {INFO_LINKS.map((item, idx) => (
            <SettingsRow
              key={item.path}
              c={c}
              icon={<item.icon size={18} color={c.primary} />}
              label={item.label}
              last={idx === INFO_LINKS.length - 1}
              onPress={() => router.push(item.path)}
            />
          ))}
        </NeuCard>

        {/* ── App Language — in-app selector, follows the device by default ── */}
        <LanguageSetting />

        {/* ── Edit Personal Info Modal ───────────────────────────────── */}
        <ResponsiveModal
          visible={showPersonalEdit}
          onClose={() => setShowPersonalEdit(false)}
          title={t('profile.editProfile')}
          footer={
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <NeuButton label={t('common.cancel')} onPress={() => setShowPersonalEdit(false)} variant="secondary" style={{ flex: 1 }} />
              <NeuButton label={t('common.save')} onPress={handleSavePersonal} loading={editSaving} style={{ flex: 1 }} />
            </View>
          }
        >
          
            <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{t('profile.fullName')}</Text>
            <NeuInputRow
              c={c}
              value={editName}
              onChangeText={setEditName}
              placeholder={t('drProfile.fullNamePlaceholder')}
              leftIcon={<User size={16} color={c.text} opacity={0.4} />}
            />
            <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{t('profile.email')}</Text>
            <NeuInputRow
              c={c}
              value={editEmail}
              onChangeText={setEditEmail}
              placeholder={t('profile.notSet')}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              leftIcon={<Mail size={16} color={c.text} opacity={0.4} />}
            />
            <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4), marginBottom: 12, marginTop: -10, lineHeight: 16 }}>
              {t('drProfile.loginMethodUnchanged')}
            </Text>
            {editError ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <AlertCircle size={14} color="#DC2626" />
                <Text style={{ color: '#DC2626', fontSize: 13, marginStart: 6, flex: 1 }}>{editError}</Text>
              </View>
            ) : null}
          
        </ResponsiveModal>

        {/* ── Change Password Modal ──────────────────────────────────── */}
        <ResponsiveModal
          visible={showPwdEdit}
          onClose={() => setShowPwdEdit(false)}
          title={t('drProfile.changePassword')}
          footer={
            !pwdSuccess ? (
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <NeuButton label={t('common.cancel')} onPress={() => setShowPwdEdit(false)} variant="secondary" style={{ flex: 1 }} />
                <NeuButton label={t('drProfile.update')} onPress={handleChangePassword} loading={pwdSaving} style={{ flex: 1 }} />
              </View>
            ) : undefined
          }
        >
          
            {pwdSuccess ? (
              <View style={{ alignItems: 'center', paddingVertical: 12, gap: 10 }}>
                <CheckCircle size={44} color="#16A34A" />
                <Text style={{ fontSize: 16, fontWeight: '700', color: '#16A34A' }}>{t('drProfile.passwordUpdated')}</Text>
              </View>
            ) : (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{t('drProfile.newPassword')}</Text>
                <NeuInputRow
                  c={c}
                  value={newPwd}
                  onChangeText={setNewPwd}
                  placeholder={t('drProfile.minEightChars')}
                  secureTextEntry={!showPwd}
                  leftIcon={<Lock size={16} color={c.text} opacity={0.4} />}
                  rightElement={
                    <Pressable onPress={() => setShowPwd(p => !p)}>
                      {showPwd ? <EyeOff size={16} color={c.text} opacity={0.4} /> : <Eye size={16} color={c.text} opacity={0.4} />}
                    </Pressable>
                  }
                />
                <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{t('drProfile.confirmPassword')}</Text>
                <NeuInputRow
                  c={c}
                  containerStyle={{ marginBottom: 4 }}
                  value={confirmPwd}
                  onChangeText={setConfirmPwd}
                  placeholder={t('drProfile.reenterPassword')}
                  secureTextEntry={!showPwd}
                  leftIcon={<Lock size={16} color={c.text} opacity={0.4} />}
                />
                {pwdError ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                    <AlertCircle size={14} color="#DC2626" />
                    <Text style={{ color: '#DC2626', fontSize: 13, marginStart: 6, flex: 1 }}>{pwdError}</Text>
                  </View>
                ) : null}
              </>
            )}
          
        </ResponsiveModal>
      </ScrollView>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PermissionRationaleModal
        type="mediaLibrary"
        visible={showPhotoRationale}
        isBlocked={photoBlocked}
        onConfirm={confirmPhotoRequest}
        onDismiss={() => setShowPhotoRationale(false)}
      />
      {/* ── Avatar + name header ─────────────────────────────────────────── */}
      {/* This header is a SIBLING of the scroll container (it does not scroll),
          so it must own the status-bar / Dynamic-Island clearance itself. It
          used a hardcoded paddingTop: 20 — on notched iPhones (insets.top ≈
          47–62) the avatar row started UNDER the status bar / Dynamic Island
          and was clipped. `layout.headerTop` is the same shared primitive
          PageHeader uses (max(insets.top + breathing, floor)), so the profile
          now sits on the app-wide header grid like every other screen. */}
      <View style={{ paddingTop: layout.headerTop, paddingHorizontal: layout.screenPx, paddingBottom: 0,
                     backgroundColor: c.base }}>
        <View style={{ alignItems: 'center', marginBottom: 20 }}>
          <ProfilePhotoActions
            avatarUrl={profile?.avatar_url}
            c={c}
            size={88}
            marginBottom={12}
            uploading={avatarUploading}
            removing={avatarRemoving}
            onPick={handlePickAvatar}
            onRemove={handleRemoveAvatar}
          />
          <Text style={{ fontSize: 20, fontWeight: '800', color: c.text }}>{profile?.full_name || '—'}</Text>
          <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.45), marginTop: 3 }}>
            {firstName ? t('drProfile.doctorPrefix', { name: firstName }) : t('role.doctor')}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <View style={{ backgroundColor: `${statusColor}18`, borderRadius: 20,
                           paddingHorizontal: 12, paddingVertical: 4 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: statusColor, textTransform: 'capitalize' }}>
                {profile?.status ?? 'active'}
              </Text>
            </View>
            <View style={{ backgroundColor: `${c.primary}12`, borderRadius: 20,
                           paddingHorizontal: 12, paddingVertical: 4 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>{t('role.doctor')}</Text>
            </View>
          </View>
        </View>

        {/* ── Tab bar ─────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', backgroundColor: `${c.text}0A`,
                       borderRadius: 14, padding: 4, marginBottom: 4 }}>
          {PROFILE_TABS.map(tab => {
            const active = activeTab === tab.key;
            return (
              <Pressable key={tab.key} onPress={() => setActiveTab(tab.key)}
                style={{ flex: 1, paddingVertical: 9, borderRadius: 11, alignItems: 'center',
                         backgroundColor: active ? c.base : 'transparent',
                         ...(active ? {
                           shadowColor: c.shadowDark, shadowOffset: { width: 1, height: 2 },
                           shadowOpacity: 0.35, shadowRadius: 5,
                         } : {}) }}>
                <Text style={{ fontSize: 13, fontWeight: '700',
                               color: active ? c.primary : `${c.text}55` }}>
                  {t(tab.labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* ── Tab content ─────────────────────────────────────────────────── */}
      {activeTab === 'profile'  && renderProfileTab()}
      {activeTab === 'settings' && renderSettingsTab()}

      {/* ── Logout confirmation ──────────────────────────────────────────── */}
      <ResponsiveModal
        visible={showLogout}
        onClose={() => setShowLogout(false)}
        title={t('drProfile.signOutTitle')}
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label={t('common.cancel')} onPress={() => setShowLogout(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label={t('common.signOut')} onPress={handleLogout} style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.6), lineHeight: 22 }}>
          {t('drProfile.signOutBody')}
        </Text>
      </ResponsiveModal>

      {contactModal}
    </View>
  );
}
