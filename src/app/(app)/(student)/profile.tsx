/**
 * StudentProfile — unified profile page with inline edit, change password, and info links.
 * Replaces the separate Edit Profile + Security pages for students.
 */
import { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  ActivityIndicator, RefreshControl, Modal, TextInput, KeyboardAvoidingView,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// Alias for use inside the PickerRow sub-component (avoids name collision with
// the layout.insets already used by the main component via useLayout)
const usePickerInsets = useSafeAreaInsets;
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import {
  User, Mail, Phone, BookOpen, Lock, LogOut, ChevronRight,
  CheckCircle, AlertCircle, GraduationCap, Building2, Pencil, X, Copy, Fingerprint,
  Eye, EyeOff, FileText, Shield, HeartHandshake, Info, Camera,
} from 'lucide-react-native';
import type { RelativePathString } from 'expo-router';
import { backendClient } from '@/client/backendClient';
import { useProfileStore } from '@/lib/store';
import {
  getProfile, getMySubscriptions, updateProfile,
  getUniversities, getFaculties, getAcademicLevels,
  changePassword, getPublicEmail, isInternalEmail,
} from '@/lib/api';
import { getFirstName } from '@/lib/utils';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { NeuInputRow } from '@/components/NeuInputRow';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { validateRequired, friendlyError } from '@/lib/validation';
import { useToast } from '@/components/Toast';
import * as ImagePicker from 'expo-image-picker';
import { usePermission } from '@/hooks/usePermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';

// ─── ID card ─────────────────────────────────────────────────────────────────
function WatermarkCard({ watermarkId, c }: { watermarkId: string | null; c: typeof neuColors.light }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    if (!watermarkId) return;
    void Clipboard.setStringAsync(watermarkId);
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
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.9 }}>
            ID
          </Text>
          <Text style={{ fontSize: 18, fontWeight: '800', color: c.primary, letterSpacing: 1.5, marginTop: 2, fontVariant: ['tabular-nums'] }}>
            {watermarkId ?? '—'}
          </Text>
        </View>
        <Pressable
          onPress={handleCopy}
          accessibilityLabel={copied ? 'Watermark ID copied' : 'Copy watermark ID'}
          accessibilityRole="button"
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 5,
            paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
            backgroundColor: copied ? '#16A34A18' : `${c.primary}12`,
          }}
        >
          {copied
            ? <CheckCircle size={15} color="#16A34A" />
            : <Copy size={15} color={c.primary} />}
          <Text style={{ fontSize: 12, fontWeight: '700', color: copied ? '#16A34A' : c.primary }}>
            {copied ? 'Copied!' : 'Copy'}
          </Text>
        </Pressable>
      </View>
      <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, lineHeight: 17 }}>
        This ID is permanently assigned to your account and appears as a watermark in every video you watch.
      </Text>
    </NeuCard>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function SectionLabel({ label, color }: { label: string; color: string }) {
  return (
    <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', color, opacity: 0.5, marginBottom: 10, marginTop: 4 }}>
      {label}
    </Text>
  );
}

function InfoRow({ icon, label, value, c }: { icon: React.ReactNode; label: string; value: string; c: typeof neuColors.light }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
      <View style={{ width: 32, alignItems: 'center' }}>{icon}</View>
      <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, minWidth: 90, flexShrink: 0, marginLeft: 8 }}>{label}</Text>
      <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: c.text, textAlign: 'right' }} numberOfLines={1}>
        {value || '—'}
      </Text>
    </View>
  );
}

// PickerRow — inline bottom-sheet picker for university / faculty / level.
// Fixes:
//   • statusBarTranslucent so the scrim covers the Android status bar
//   • useWindowDimensions + useSafeAreaInsets replaces the percent-based
//     maxHeight:'72%' which used full-screen height and ignored safe areas
//   • insets.bottom added to sheet so list rows are never behind the nav-bar
function PickerRow({
  label, value, items, onSelect, c,
}: {
  label: string;
  value: string | null;
  items: { id: string; name: string }[];
  onSelect: (id: string, name: string) => void;
  c: typeof neuColors.light;
}) {
  const [open, setOpen] = useState(false);
  const selectedName = items.find(i => i.id === value)?.name ?? '— Select —';
  const { height: screenH } = useWindowDimensions();
  const insets = usePickerInsets();

  // Available height = screen minus status-bar (top inset).
  // Cap at 72 % of that so the backdrop remains visible above the sheet.
  const sheetMaxH = (screenH - insets.top) * 0.72;

  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: 11, fontWeight: '600', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>
        {label}
      </Text>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityLabel={`Select ${label}: ${selectedName}`}
        accessibilityRole="button"
        style={{
          flexDirection: 'row', alignItems: 'center',
          backgroundColor: c.base, borderRadius: 12,
          paddingHorizontal: 14, paddingVertical: 13,
          shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
          shadowOpacity: 0.6, shadowRadius: 5,
        }}
      >
        <Text style={{ flex: 1, fontSize: 15, color: value ? c.text : `${c.text}55` }}>{selectedName}</Text>
        <ChevronRight size={16} color={c.text} opacity={0.3} />
      </Pressable>

      {/* statusBarTranslucent: scrim covers the Android status bar correctly */}
      <Modal
        visible={open}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        {/* Backdrop — flex:1 fills remaining space above sheet; tap to dismiss */}
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }}
          onPress={() => setOpen(false)}
          accessibilityLabel="Close picker"
          accessibilityRole="button"
        />

        {/* Sheet — sits after backdrop, anchored to bottom, no flex */}
        <Pressable onPress={e => e.stopPropagation()}>
          <View style={{
            backgroundColor: c.base,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            padding: 20,
            // Safe-area-aware height cap: never overflows in landscape or on SE
            maxHeight: sheetMaxH,
            width: '100%',
            // Home-indicator / Android gesture-nav bar padding
            paddingBottom: Math.max(insets.bottom + 8, 20),
          }}>
            {/* Drag handle */}
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: `${c.text}20`, alignSelf: 'center', marginBottom: 16 }} />
            {/* Header row */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
              <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: c.text }} numberOfLines={1}>{label}</Text>
              <Pressable
                onPress={() => setOpen(false)}
                accessibilityLabel="Close"
                accessibilityRole="button"
                style={{ padding: 4 }}
              >
                <X size={20} color={c.text} opacity={0.4} />
              </Pressable>
            </View>
            {/* Item list — scrollable; flex:1 fills inside the capped sheet */}
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {items.map(item => (
                <Pressable
                  key={item.id}
                  onPress={() => { onSelect(item.id, item.name); setOpen(false); }}
                  accessibilityLabel={item.name}
                  accessibilityRole="button"
                  style={{
                    flexDirection: 'row', alignItems: 'center',
                    paddingVertical: 14, paddingHorizontal: 4,
                    borderBottomWidth: 1, borderBottomColor: `${c.text}08`,
                  }}
                >
                  <Text style={{ flex: 1, fontSize: 15, color: c.text }} numberOfLines={2}>{item.name}</Text>
                  {item.id === value && <CheckCircle size={18} color={c.primary} />}
                </Pressable>
              ))}
              {items.length === 0 && (
                <Text style={{ fontSize: 14, color: c.text, opacity: 0.4, textAlign: 'center', paddingVertical: 24 }}>
                  No options available
                </Text>
              )}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function StudentProfile() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const router = useRouter();
  const { profile, setProfile } = useProfileStore();
  const { showToast } = useToast();

  const [subscriptions, setSubscriptions] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);

  // ── Edit academic info ────────────────────────────────────────────────────
  const [showAcademicEdit, setShowAcademicEdit] = useState(false);
  const [universities, setUniversities]       = useState<any[]>([]);
  const [faculties, setFaculties]             = useState<any[]>([]);
  const [levels, setLevels]                   = useState<any[]>([]);
  const [selUnivId, setSelUnivId]             = useState<string | null>(null);
  const [selFacId, setSelFacId]               = useState<string | null>(null);
  const [selLevelId, setSelLevelId]           = useState<string | null>(null);
  const [acadLoading, setAcadLoading]         = useState(false);
  const [acadError, setAcadError]             = useState('');
  const [acadSuccess, setAcadSuccess]         = useState(false);

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
    const nameErr = validateRequired(editName, 'Full name');
    if (nameErr) { setEditError(nameErr); return; }
    if (editEmail.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(editEmail.trim())) {
      setEditError('Enter a valid email address.'); return;
    }
    if (isInternalEmail(editEmail.trim())) {
      setEditError('Enter a valid email address.'); return;
    }
    if (!profile?.id) return;
    setEditSaving(true); setEditError('');
    try {
      const updated = await updateProfile(profile.id, {
        full_name:     editName.trim(),
        profile_email: editEmail.trim() || null,
      });
      setProfile({ ...profile, ...(updated as any) });
      showToast({ type: 'success', message: 'Profile updated successfully.' });
      setShowPersonalEdit(false);
    } catch (e: any) {
      setEditError(friendlyError(e, 'Failed to save. Please try again.'));
    }
    setEditSaving(false);
  };

  // ── Change password ───────────────────────────────────────────────────────
  const [showPwdEdit, setShowPwdEdit]     = useState(false);
  const [newPwd, setNewPwd]               = useState('');
  const [confirmPwd, setConfirmPwd]       = useState('');
  const [showPwd, setShowPwd]             = useState(false);
  const [pwdSaving, setPwdSaving]         = useState(false);
  const [pwdError, setPwdError]           = useState('');
  const [pwdSuccess, setPwdSuccess]       = useState(false);

  const openPwdEdit = () => {
    setNewPwd(''); setConfirmPwd(''); setPwdError(''); setPwdSuccess(false);
    setShowPwdEdit(true);
  };

  const handleChangePassword = async () => {
    if (newPwd.length < 8) { setPwdError('Password must be at least 8 characters.'); return; }
    if (newPwd !== confirmPwd) { setPwdError('Passwords do not match.'); return; }
    setPwdSaving(true); setPwdError('');
    try {
      await changePassword(newPwd);
      setPwdSuccess(true);
      setNewPwd(''); setConfirmPwd('');
      setTimeout(() => { setPwdSuccess(false); setShowPwdEdit(false); }, 2000);
    } catch (e: any) {
      setPwdError(e?.message ?? 'Password change failed.');
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
      const uri   = asset.uri;
      const ext   = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
      const path  = `avatars/${profile.id}.${ext}`;
      // Use expo/fetch (supports arrayBuffer on Android content:// URIs)
      const { fetch: expoFetch } = await import('expo/fetch');
      const response = await expoFetch(uri);
      const buffer   = await response.arrayBuffer();
      const { error: upErr } = await backendClient.storage
        .from('user-avatars')
        .upload(path, buffer, { upsert: true, contentType: asset.mimeType ?? `image/${ext}` });
      if (upErr) throw upErr;
      const { data: { publicUrl } } = backendClient.storage.from('user-avatars').getPublicUrl(path);
      const updated = await updateProfile(profile.id, { avatar_url: publicUrl });
      setProfile({ ...profile, ...(updated as any) });
      showToast({ type: 'success', message: 'Avatar updated!' });
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to upload avatar.' });
    }
    setAvatarUploading(false);
  };

  // ── Logout confirm ────────────────────────────────────────────────────────
  const [showLogout, setShowLogout] = useState(false);

  const loadData = useCallback(async () => {
    if (!profile?.id) { setDataLoading(false); return; }
    setDataLoading(true);
    try {
      const { data: { user } } = await backendClient.auth.getUser();
      if (user) {
        const freshProfile = await getProfile(user.id);
        if (freshProfile) setProfile(freshProfile as any);
      }
      const subs = await getMySubscriptions(profile.id);
      setSubscriptions(subs ?? []);
    } catch (e: any) {
      console.error('[Profile] loadData error:', e?.message ?? e);
    }
    setDataLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  useFocusEffect(useCallback(() => { (async () => { await loadData(); })(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  // Load universities when edit panel opens
  const openAcademicEdit = async () => {
    setSelUnivId((profile as any)?.university_id ?? null);
    setSelFacId((profile as any)?.faculty_id ?? null);
    setSelLevelId((profile as any)?.academic_level_id ?? null);
    setAcadError(''); setAcadSuccess(false);
    try {
      const univs = await getUniversities();
      setUniversities(univs);
      const univId = (profile as any)?.university_id;
      if (univId) {
        const facs = await getFaculties(univId);
        setFaculties(facs);
        const facId = (profile as any)?.faculty_id;
        if (facId) {
          const lvls = await getAcademicLevels(facId);
          setLevels(lvls);
        }
      }
    } catch (e: any) { console.error('[Profile] load dropdowns:', e?.message); }
    setShowAcademicEdit(true);
  };

  const handleUniversityChange = async (id: string) => {
    setSelUnivId(id); setSelFacId(null); setSelLevelId(null);
    setFaculties([]); setLevels([]);
    try {
      const facs = await getFaculties(id);
      setFaculties(facs);
    } catch {}
  };

  const handleFacultyChange = async (id: string) => {
    setSelFacId(id); setSelLevelId(null); setLevels([]);
    try {
      const lvls = await getAcademicLevels(id);
      setLevels(lvls);
    } catch {}
  };

  const handleSaveAcademic = async () => {
    if (!selUnivId || !selFacId || !selLevelId) {
      setAcadError('Please select University, Faculty, and Academic Level.');
      return;
    }
    if (!profile?.id) return;
    setAcadLoading(true); setAcadError('');
    try {
      const updated = await updateProfile(profile.id, {
        university_id:      selUnivId,
        faculty_id:         selFacId,
        academic_level_id:  selLevelId,
      });
      setProfile(updated as any);
      setAcadSuccess(true);
      setTimeout(() => { setAcadSuccess(false); setShowAcademicEdit(false); }, 1800);
    } catch (e: any) {
      setAcadError(e?.message ?? 'Failed to save. Please try again.');
    }
    setAcadLoading(false);
  };

  const handleLogout = async () => {
    setShowLogout(false);
    // Eagerly wipe the profile store so no stale role data remains visible
    // while backendClient.auth.signOut() completes and the new session initialises.
    const { clearProfile } = useProfileStore.getState();
    clearProfile();
    await backendClient.auth.signOut();
  };

  const completedCount = subscriptions.filter(s => s.completed_at).length;
  const activeCount    = subscriptions.length - completedCount;
  const statusColor    = profile?.status === 'active' ? '#16A34A' : profile?.status === 'suspended' ? '#DC2626' : '#D97706';
  const firstName      = getFirstName(profile?.full_name);

  // inputStyle removed — use NeuInputRow instead

  const INFO_LINKS = [
    { label: 'Terms & Conditions', icon: FileText,      path: '/(app)/info/terms'   as RelativePathString },
    { label: 'Privacy Policy',     icon: Shield,        path: '/(app)/info/privacy' as RelativePathString },
    { label: 'About Us',           icon: Info,          path: '/(app)/info/about'   as RelativePathString },
    { label: 'Contact Us',         icon: HeartHandshake,path: '/(app)/info/contact' as RelativePathString },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
    >
      <View style={{ padding: layout.screenPx }}>
        <PermissionRationaleModal
          type="mediaLibrary"
          visible={showPhotoRationale}
          isBlocked={photoBlocked}
          onConfirm={confirmPhotoRequest}
          onDismiss={() => setShowPhotoRationale(false)}
        />
        {/* ── Avatar + name ──────────────────────────────────────────── */}
        <View style={{ alignItems: 'center', marginTop: 12, marginBottom: 28 }}>
          <Pressable onPress={handlePickAvatar} accessibilityLabel="Change profile photo" accessibilityRole="button" style={{ marginBottom: 14 }}>
            <View style={{
              width: 96, height: 96, borderRadius: 48,
              backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center',
              shadowColor: c.shadowDark, shadowOffset: { width: 4, height: 4 }, shadowOpacity: 0.6, shadowRadius: 10,
            }}>
              {avatarUploading ? (
                <ActivityIndicator color={c.primary} />
              ) : profile?.avatar_url ? (
                <Image source={{ uri: profile.avatar_url }} style={{ width: 96, height: 96, borderRadius: 48 }} contentFit="cover" />
              ) : (
                <User size={44} color={c.primary} />
              )}
            </View>
            <View style={{
              position: 'absolute', bottom: 0, right: 0,
              width: 28, height: 28, borderRadius: 14,
              backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
              shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.4, shadowRadius: 4,
            }}>
              <Camera size={14} color="#fff" />
            </View>
          </Pressable>
          <Text style={{ fontSize: 22, fontWeight: '800', color: c.text }}>{profile?.full_name || '—'}</Text>
          <Text style={{ fontSize: 13, color: c.text, opacity: 0.45, marginTop: 4 }}>
            {firstName ? `Welcome back, ${firstName} 👋` : 'Welcome back 👋'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 }}>
            <View style={{ backgroundColor: `${statusColor}18`, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: statusColor, textTransform: 'capitalize' }}>
                {profile?.status ?? 'active'}
              </Text>
            </View>
            <View style={{ backgroundColor: `${c.primary}12`, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>Student</Text>
            </View>
          </View>
        </View>

        {/* ── ID ───────────────────────────────────────────────────── */}
        <SectionLabel label="ID" color={c.text} />
        <WatermarkCard watermarkId={(profile as any)?.watermark_id ?? null} c={c} />

        {/* ── Account info ─────────────────────────────────────────── */}
        <SectionLabel label="Account Information" color={c.text} />
        <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
          <InfoRow icon={<Mail size={16} color={c.primary} />}  label="Email" value={getPublicEmail(profile) ?? 'Not set'} c={c} />
          <InfoRow icon={<Phone size={16} color={c.primary} />} label="Phone" value={profile?.phone ?? ''}   c={c} />
          <InfoRow icon={<Lock  size={16} color={c.text}    />} label="Role"  value="Student"               c={c} />
          <Pressable
            onPress={openPersonalEdit}
            accessibilityLabel="Edit name and email"
            accessibilityRole="button"
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                     marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: `${c.text}08` }}
          >
            <Pencil size={15} color={c.primary} />
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary, marginLeft: 7 }}>Edit Name & Email</Text>
          </Pressable>
        </NeuCard>

        {/* ── Academic Info + Edit ─────────────────────────────────── */}
        <SectionLabel label="Academic Information" color={c.text} />
        <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
          <InfoRow icon={<Building2    size={16} color={c.primary} />} label="University"     value={(profile as any)?.university?.name ?? ''} c={c} />
          <InfoRow icon={<GraduationCap size={16} color={c.primary} />} label="Faculty"        value={(profile as any)?.faculty?.name ?? ''}    c={c} />
          <InfoRow icon={<GraduationCap size={16} color={c.primary} />} label="Academic Level" value={(profile as any)?.academic_level?.name ?? ''} c={c} />
          <Pressable
            onPress={openAcademicEdit}
            accessibilityLabel="Edit academic information"
            accessibilityRole="button"
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                     marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: `${c.text}08` }}
          >
            <Pencil size={15} color={c.primary} />
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary, marginLeft: 7 }}>Edit Academic Info</Text>
          </Pressable>
        </NeuCard>

        {/* ── Subscription stats ───────────────────────────────────── */}
        <SectionLabel label="My Subscriptions" color={c.text} />
        {dataLoading ? (
          <ActivityIndicator color={c.primary} style={{ marginVertical: 20 }} />
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
              {[
                { label: 'Total',  value: subscriptions.length, color: c.primary },
                { label: 'Active', value: activeCount,           color: '#D97706' },
                { label: 'Done',   value: completedCount,        color: '#16A34A' },
              ].map(stat => (
                <NeuCard key={stat.label} radius={16} style={{ flex: 1, alignItems: 'center', padding: 14 }}>
                  <Text style={{ fontSize: 26, fontWeight: '800', color: stat.color }}>{stat.value}</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>{stat.label}</Text>
                </NeuCard>
              ))}
            </View>
            {subscriptions.length > 0 ? (
              <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
                {subscriptions.slice(0, 5).map((sub, idx) => (
                  <Pressable key={sub.id}
                    onPress={() => router.push(`/(app)/course/${sub.course?.id}` as RelativePathString)}
                    accessibilityLabel={`Open course: ${sub.course?.title ?? 'course'}`}
                    accessibilityRole="button"
                    style={{
                      flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
                      borderBottomWidth: idx < Math.min(subscriptions.length, 5) - 1 ? 1 : 0,
                      borderBottomColor: `${c.text}08`,
                    }}>
                    <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${c.primary}15`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                      <BookOpen size={16} color={c.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }} numberOfLines={1}>{sub.course?.title}</Text>
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 1 }}>Dr. {sub.course?.doctor?.full_name ?? '—'}</Text>
                    </View>
                    <View style={{ backgroundColor: sub.completed_at ? '#16A34A18' : `${c.primary}15`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: sub.completed_at ? '#16A34A' : c.primary }}>
                        {sub.completed_at ? 'Done' : 'Active'}
                      </Text>
                    </View>
                  </Pressable>
                ))}
                {subscriptions.length > 5 && (
                  <Pressable onPress={() => router.push('/(app)/(student)/my-courses' as RelativePathString)} style={{ paddingTop: 12, alignItems: 'center' }}>
                    <Text style={{ fontSize: 13, color: c.primary, fontWeight: '700' }}>View all {subscriptions.length} courses →</Text>
                  </Pressable>
                )}
              </NeuCard>
            ) : (
              <NeuCard radius={18} style={{ alignItems: 'center', padding: 28, marginBottom: 20 }}>
                <BookOpen size={40} color={c.primary} opacity={0.25} style={{ marginBottom: 10 }} />
                <Text style={{ fontSize: 15, fontWeight: '600', color: c.text, opacity: 0.4 }}>No subscribed courses yet</Text>
              </NeuCard>
            )}
          </>
        )}

        {/* ── Security: Change Password ────────────────────────────── */}
        <SectionLabel label="Security" color={c.text} />
        <NeuCard radius={18} style={{ paddingHorizontal: 16, marginBottom: 20 }}>
          <Pressable onPress={openPwdEdit}
            style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14,
                     borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
            <Lock size={18} color={c.primary} />
            <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: c.text, marginLeft: 10 }}>Change Password</Text>
            <ChevronRight size={16} color={c.text} opacity={0.3} />
          </Pressable>
          <Pressable onPress={() => setShowLogout(true)}
            style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14 }}>
            <LogOut size={18} color="#DC2626" />
            <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: '#DC2626', marginLeft: 10 }}>Sign Out</Text>
          </Pressable>
        </NeuCard>

        {/* ── Information Links ────────────────────────────────────── */}
        <SectionLabel label="Information" color={c.text} />
        <NeuCard radius={18} style={{ paddingHorizontal: 16, marginBottom: 20 }}>
          {INFO_LINKS.map((item, idx) => (
            <Pressable
              key={item.path}
              onPress={() => router.push(item.path)}
              style={{
                flexDirection: 'row', alignItems: 'center', paddingVertical: 14,
                borderBottomWidth: idx < INFO_LINKS.length - 1 ? 1 : 0,
                borderBottomColor: `${c.text}08`,
              }}
            >
              <item.icon size={18} color={c.primary} />
              <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: c.text, marginLeft: 10 }}>{item.label}</Text>
              <ChevronRight size={16} color={c.text} opacity={0.3} />
            </Pressable>
          ))}
        </NeuCard>

      </View>

      {/* ── Edit Personal Info Modal ──────────────────────────────── */}
      <ResponsiveModal
        visible={showPersonalEdit}
        onClose={() => setShowPersonalEdit(false)}
        title="Edit Profile"
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={() => setShowPersonalEdit(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Save" onPress={handleSavePersonal} loading={editSaving} style={{ flex: 1 }} />
          </View>
        }
      >
        <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>Full Name</Text>
          <NeuInputRow
            c={c}
            value={editName}
            onChangeText={setEditName}
            placeholder="Your full name"
            leftIcon={<User size={16} color={c.text} opacity={0.4} />}
          />
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>Email</Text>
          <NeuInputRow
            c={c}
            value={editEmail}
            onChangeText={setEditEmail}
            placeholder="Not set"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            leftIcon={<Mail size={16} color={c.text} opacity={0.4} />}
          />
          <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginBottom: 12, marginTop: -10, lineHeight: 16 }}>
            Your login method stays unchanged.
          </Text>
          {editError ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <AlertCircle size={14} color="#DC2626" />
              <Text style={{ color: '#DC2626', fontSize: 13, marginLeft: 6, flex: 1 }}>{editError}</Text>
            </View>
          ) : null}
        </KeyboardAvoidingView>
      </ResponsiveModal>

      {/* ── Change Password Modal ─────────────────────────────────── */}
      <ResponsiveModal
        visible={showPwdEdit}
        onClose={() => setShowPwdEdit(false)}
        title="Change Password"
        footer={
          !pwdSuccess ? (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <NeuButton label="Cancel" onPress={() => setShowPwdEdit(false)} variant="secondary" style={{ flex: 1 }} />
              <NeuButton label="Update" onPress={handleChangePassword} loading={pwdSaving} style={{ flex: 1 }} />
            </View>
          ) : undefined
        }
      >
        <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'}>
          {pwdSuccess ? (
            <View style={{ alignItems: 'center', paddingVertical: 12, gap: 10 }}>
              <CheckCircle size={44} color="#16A34A" />
              <Text style={{ fontSize: 16, fontWeight: '700', color: '#16A34A' }}>Password Updated!</Text>
            </View>
          ) : (
            <>
              <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>New Password</Text>
              <NeuInputRow
                c={c}
                value={newPwd}
                onChangeText={setNewPwd}
                placeholder="Min. 8 characters"
                secureTextEntry={!showPwd}
                leftIcon={<Lock size={16} color={c.text} opacity={0.4} />}
                rightElement={
                  <Pressable onPress={() => setShowPwd(p => !p)}>
                    {showPwd ? <EyeOff size={16} color={c.text} opacity={0.4} /> : <Eye size={16} color={c.text} opacity={0.4} />}
                  </Pressable>
                }
              />
              <NeuInputRow
                c={c}
                containerStyle={{ marginBottom: 4 }}
                value={confirmPwd}
                onChangeText={setConfirmPwd}
                placeholder="Re-enter password"
                secureTextEntry={!showPwd}
                leftIcon={<Lock size={16} color={c.text} opacity={0.4} />}
              />
              {pwdError ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                  <AlertCircle size={14} color="#DC2626" />
                  <Text style={{ color: '#DC2626', fontSize: 13, marginLeft: 6, flex: 1 }}>{pwdError}</Text>
                </View>
              ) : null}
            </>
          )}
        </KeyboardAvoidingView>
      </ResponsiveModal>

      {/* ── Academic Edit Bottom Sheet ────────────────────────────── */}
      <ResponsiveModal
        visible={showAcademicEdit}
        onClose={() => setShowAcademicEdit(false)}
        title="Edit Academic Info"
        footer={
          <NeuButton
            label={acadLoading ? 'Saving…' : 'Save Changes'}
            onPress={handleSaveAcademic}
            loading={acadLoading}
            fullWidth
          />
        }
      >
        <PickerRow label="University"     value={selUnivId}   items={universities} onSelect={(id) => handleUniversityChange(id)} c={c} />
        <PickerRow label="Faculty"        value={selFacId}    items={faculties}    onSelect={(id) => handleFacultyChange(id)}    c={c} />
        <PickerRow label="Academic Level" value={selLevelId}  items={levels}       onSelect={(id) => setSelLevelId(id)}           c={c} />
        {acadError ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <AlertCircle size={15} color="#DC2626" />
            <Text style={{ color: '#DC2626', fontSize: 13, marginLeft: 7, flex: 1 }}>{acadError}</Text>
          </View>
        ) : null}
        {acadSuccess ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
            <CheckCircle size={15} color="#16A34A" />
            <Text style={{ color: '#16A34A', fontSize: 13, marginLeft: 7 }}>Saved!</Text>
          </View>
        ) : null}
      </ResponsiveModal>

      {/* ── Logout confirmation ──────────────────────────────────────── */}
      <ResponsiveModal
        visible={showLogout}
        onClose={() => setShowLogout(false)}
        title="Sign Out?"
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={() => setShowLogout(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Sign Out" onPress={handleLogout} style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 14, color: c.text, opacity: 0.6, lineHeight: 22 }}>Your progress and data are safely saved.</Text>
      </ResponsiveModal>
    </ScrollView>
  );
}