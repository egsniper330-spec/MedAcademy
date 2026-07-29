/**
 * EditUserDialog — full-featured edit modal for admin/doctor/user profiles.
 * Supports: full name, email, phone, university/faculty/level, status, role, password.
 * Works for all roles. Field visibility controlled by `allowedFields` prop.
 */
import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, ScrollView, Pressable,
  useColorScheme, ActivityIndicator,
} from 'react-native';
import { Eye, EyeOff, ChevronDown, Save } from 'lucide-react-native';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { NeuButton } from '@/components/NeuButton';
import { NeuCard } from '@/components/NeuCard';
import { neuColors } from '@/lib/neu';
import {
  validateRequired, validateEmail, validatePasswordSimple, validateMatch,
} from '@/lib/validation';
import {
  updateProfile, changePassword, updateUserEmail,
  getUniversities, getFaculties, getAcademicLevels,
} from '@/lib/api';
import { parseError } from '@/lib/parseError';

export interface EditUserData {
  id: string;
  full_name?: string;
  email?: string;
  phone?: string;
  university_id?: string;
  faculty_id?: string;
  academic_level_id?: string;
  status?: string;
  role?: string;
}

interface EditUserDialogProps {
  visible: boolean;
  onClose: () => void;
  user: EditUserData | null;
  /** Which fields to expose. Defaults to all profile fields (no password). */
  allowedFields?: ('full_name' | 'email' | 'phone' | 'university' | 'password' | 'status')[];
  onSaved?: (updated: EditUserData) => void;
  /** When true the email field becomes editable and is saved via the admin-update-email Edge Function. */
  isSuperAdmin?: boolean;
}

const ALL_FIELDS: EditUserDialogProps['allowedFields'] = [
  'full_name', 'email', 'phone', 'university', 'password', 'status',
];

// Use shared enum constants — never hardcode status strings
import { UserStatus } from '@/lib/enums';
const STATUS_OPTIONS = [UserStatus.ACTIVE, UserStatus.BLOCKED] as const;

export function EditUserDialog({
  visible, onClose, user,
  allowedFields = ALL_FIELDS,
  onSaved,
  isSuperAdmin = false,
}: EditUserDialogProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [full_name, setFullName]     = useState('');
  const [email, setEmail]           = useState('');
  const [phone, setPhone]           = useState('');
  const [status, setStatus]         = useState('active');
  const [university_id, setUniId]   = useState('');
  const [faculty_id, setFacId]      = useState('');
  const [level_id, setLevelId]      = useState('');
  const [password, setPassword]     = useState('');
  const [confirm, setConfirm]       = useState('');
  const [showPwd, setShowPwd]       = useState(false);
  const [showCfm, setShowCfm]       = useState(false);

  const [universities, setUniversities] = useState<any[]>([]);
  const [faculties, setFaculties]       = useState<any[]>([]);
  const [levels, setLevels]             = useState<any[]>([]);
  const [uniOpen, setUniOpen]           = useState(false);
  const [facOpen, setFacOpen]           = useState(false);
  const [lvlOpen, setLvlOpen]           = useState(false);

  const [saving, setSaving]         = useState(false);
  const [errors, setErrors]         = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState('');
  const [isDirty, setIsDirty]       = useState(false);

  const has = (f: string) => allowedFields?.includes(f as any) ?? true;

  // Populate form when user changes
  useEffect(() => {
    if (!user || !visible) return;
    setFullName(user.full_name ?? '');
    setEmail(user.email ?? '');
    setPhone(user.phone ?? '');
    setStatus(user.status ?? 'active');
    setUniId(user.university_id ?? '');
    setFacId(user.faculty_id ?? '');
    setLevelId(user.academic_level_id ?? '');
    setPassword('');
    setConfirm('');
    setErrors({});
    setGlobalError('');
    setIsDirty(false);

    if (has('university')) {
      getUniversities().then(setUniversities).catch(() => {});
      if (user.university_id) {
        getFaculties(user.university_id).then(setFaculties).catch(() => {});
        if (user.faculty_id) {
          getAcademicLevels(user.faculty_id).then(setLevels).catch(() => {});
        }
      }
    }
  }, [user, visible]);

  const mark = (f: string, v: string) => {
    setErrors(p => ({ ...p, [f]: '' }));
    setIsDirty(true);
    switch (f) {
      case 'full_name': setFullName(v); break;
      case 'email':     setEmail(v);    break;
      case 'phone':     setPhone(v);    break;
      case 'password':  setPassword(v); break;
      case 'confirm':   setConfirm(v);  break;
    }
  };

  const onUniSelect = async (id: string) => {
    setUniId(id); setFacId(''); setLevelId(''); setUniOpen(false); setIsDirty(true);
    try { setFaculties(await getFaculties(id)); setLevels([]); } catch (_) {}
  };
  const onFacSelect = async (id: string) => {
    setFacId(id); setLevelId(''); setFacOpen(false); setIsDirty(true);
    try { setLevels(await getAcademicLevels(id)); } catch (_) {}
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (has('full_name')) { const err = validateRequired(full_name, 'Full name'); if (err) e.full_name = err; }
    if (has('email') && isSuperAdmin) {
      const err = validateEmail(email);
      if (err) e.email = err;
    }
    if (password) {
      const pe = validatePasswordSimple(password); if (pe) e.password = pe;
      const me = validateMatch(password, confirm);  if (me) e.confirm = me;
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async () => {
    if (!user || !validate()) return;
    setSaving(true); setGlobalError('');
    try {
      // 1. Profile fields
      await updateProfile(user.id, {
        ...(has('full_name') ? { full_name: full_name.trim() } : {}),
        ...(has('phone')     ? { phone: phone.trim() || undefined } : {}),
        ...(has('university') ? {
          university_id: university_id || undefined,
          faculty_id:    faculty_id    || undefined,
          academic_level_id: level_id  || undefined,
        } : {}),
      });

      // 2. Email — super_admin only, via secure Edge Function
      const trimmedEmail = email.trim().toLowerCase();
      const originalEmail = (user.email ?? '').trim().toLowerCase();
      if (isSuperAdmin && has('email') && trimmedEmail && trimmedEmail !== originalEmail) {
        await updateUserEmail(user.id, trimmedEmail);
      }

      // 3. Password (separate call via Edge Function)
      if (password) {
        await changePassword(password, user.id);
      }

      onSaved?.({
        ...user,
        full_name, email: trimmedEmail || user.email, phone,
        university_id, faculty_id, academic_level_id: level_id,
        status,
      });
      onClose();
    } catch (e) {
      setGlobalError(parseError(e, 'Failed to save changes.'));
    }
    setSaving(false);
  };

  const inp = {
    backgroundColor: c.base,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minWidth: 0,
    shadowColor: c.shadowDark,
    shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.45,
    shadowRadius: 5,
    fontSize: 15,
    color: c.text,
    marginBottom: 14,
  } as const;

  const lbl = (t: string) => (
    <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.7 }}>{t}</Text>
  );

  const dropBtn = (text: string, open: boolean, onPress: () => void) => (
    <Pressable onPress={onPress} style={{ ...inp, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={{ fontSize: 15, color: text ? c.text : `${c.text}55`, flex: 1 }} numberOfLines={1}>{text || 'Select…'}</Text>
      <ChevronDown size={16} color={c.text} style={{ opacity: 0.4 }} />
    </Pressable>
  );

  const dropList = (items: any[], selected: string, onSelect: (id: string) => void) => (
    <View style={{ backgroundColor: c.base, borderRadius: 12, marginBottom: 14, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.45, shadowRadius: 5, maxHeight: 160, overflow: 'hidden' }}>
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {items.map(item => (
          <Pressable key={item.id} onPress={() => { onSelect(item.id); setIsDirty(true); }}
            style={{ paddingHorizontal: 14, paddingVertical: 11, backgroundColor: selected === item.id ? `${c.primary}18` : 'transparent', borderBottomWidth: 0.5, borderBottomColor: `${c.text}12` }}>
            <Text style={{ fontSize: 14, color: selected === item.id ? c.primary : c.text, fontWeight: selected === item.id ? '700' : '400' }}>{item.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );

  return (
    <ResponsiveModal
      visible={visible}
      onClose={onClose}
      isDirty={isDirty}
      title="Edit Profile"
      subtitle={user?.email}
      footer={
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <NeuButton label="Cancel" onPress={onClose} variant="secondary" style={{ flex: 1 }} />
          <NeuButton
            label="Save Changes"
            icon={<Save size={15} color="#fff" />}
            onPress={handleSave}
            loading={saving}
            style={{ flex: 1 }}
          />
        </View>
      }
    >
      {/* Full Name */}
      {has('full_name') && (
        <>
          {lbl('Full Name *')}
          <TextInput value={full_name} onChangeText={v => mark('full_name', v)} placeholder="Full name" placeholderTextColor={`${c.text}55`}
            style={{ ...inp, marginBottom: errors.full_name ? 4 : 14, paddingVertical: 12 }} />
          {!!errors.full_name && <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10 }}>{errors.full_name}</Text>}
        </>
      )}

      {/* Email — editable for super_admin, read-only for everyone else */}
      {has('email') && (
        <>
          {lbl('Email')}
          {isSuperAdmin ? (
            <>
              <TextInput
                value={email}
                onChangeText={v => mark('email', v)}
                placeholder="user@example.com"
                placeholderTextColor={`${c.text}55`}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                style={{ ...inp, marginBottom: errors.email ? 4 : 14, paddingVertical: 12 }}
              />
              {!!errors.email && <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10 }}>{errors.email}</Text>}
            </>
          ) : (
            <NeuCard style={{ padding: 12, marginBottom: 14 }}>
              <Text style={{ fontSize: 14, color: c.text }}>{email || '—'}</Text>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: 3 }}>Email changes require user verification. Use the Supabase dashboard for force-change.</Text>
            </NeuCard>
          )}
        </>
      )}

      {/* Phone */}
      {has('phone') && (
        <>
          {lbl('Phone Number')}
          <TextInput value={phone} onChangeText={v => mark('phone', v)} placeholder="01xxxxxxxxx"
            placeholderTextColor={`${c.text}55`} keyboardType="phone-pad" style={{ ...inp, paddingVertical: 12 }} />
        </>
      )}

      {/* University / Faculty / Level */}
      {has('university') && (
        <>
          {lbl('University')}
          {dropBtn(universities.find(u => u.id === university_id)?.name ?? '', uniOpen, () => setUniOpen(o => !o))}
          {uniOpen && dropList(universities, university_id, onUniSelect)}

          {lbl('Faculty')}
          {dropBtn(faculties.find(f => f.id === faculty_id)?.name ?? '', facOpen, () => setFacOpen(o => !o))}
          {facOpen && faculties.length > 0 && dropList(faculties, faculty_id, onFacSelect)}

          {lbl('Academic Level')}
          {dropBtn(levels.find(l => l.id === level_id)?.name ?? '', lvlOpen, () => setLvlOpen(o => !o))}
          {lvlOpen && levels.length > 0 && dropList(levels, level_id, id => { setLevelId(id); setLvlOpen(false); setIsDirty(true); })}
        </>
      )}

      {/* Status toggle */}
      {has('status') && (
        <>
          {lbl('Status')}
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
            {STATUS_OPTIONS.map(s => (
              <Pressable key={s} onPress={() => { setStatus(s); setIsDirty(true); }}
                style={{ flex: 1, paddingVertical: 11, borderRadius: 12, alignItems: 'center',
                  backgroundColor: status === s ? `${s === 'active' ? '#16A34A' : '#DC2626'}22` : c.base,
                  shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
                  shadowOpacity: status === s ? 0 : 0.45, shadowRadius: 5,
                  borderWidth: status === s ? 1.5 : 0,
                  borderColor: status === s ? (s === 'active' ? '#16A34A' : '#DC2626') : 'transparent',
                }}>
                <Text style={{ fontSize: 13, fontWeight: '700', textTransform: 'capitalize',
                  color: status === s ? (s === 'active' ? '#16A34A' : '#DC2626') : c.text }}>
                  {s}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {/* New Password */}
      {has('password') && (
        <>
          {lbl('New Password (leave blank to keep current)')}
          <View style={{ ...inp, flexDirection: 'row', alignItems: 'center', marginBottom: errors.password ? 4 : 14 }}>
            <TextInput value={password} onChangeText={v => mark('password', v)} placeholder="New password (optional)"
              placeholderTextColor={`${c.text}55`} secureTextEntry={!showPwd}
              style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text, paddingVertical: 0 }} />
            <Pressable onPress={() => setShowPwd(p => !p)} hitSlop={8}>
              {showPwd ? <EyeOff size={18} color={c.text} style={{ opacity: 0.4 }} /> : <Eye size={18} color={c.text} style={{ opacity: 0.4 }} />}
            </Pressable>
          </View>
          {!!errors.password && <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10 }}>{errors.password}</Text>}

          {password.length > 0 && (
            <>
              {lbl('Confirm New Password')}
              <View style={{ ...inp, flexDirection: 'row', alignItems: 'center', marginBottom: errors.confirm ? 4 : 14 }}>
                <TextInput value={confirm} onChangeText={v => mark('confirm', v)} placeholder="Confirm new password"
                  placeholderTextColor={`${c.text}55`} secureTextEntry={!showCfm}
                  style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text, paddingVertical: 0 }} />
                <Pressable onPress={() => setShowCfm(p => !p)} hitSlop={8}>
                  {showCfm ? <EyeOff size={18} color={c.text} style={{ opacity: 0.4 }} /> : <Eye size={18} color={c.text} style={{ opacity: 0.4 }} />}
                </Pressable>
              </View>
              {!!errors.confirm && <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10 }}>{errors.confirm}</Text>}
            </>
          )}
        </>
      )}

      {/* Global error */}
      {!!globalError && (
        <View style={{ backgroundColor: '#DC262610', borderRadius: 12, padding: 12, marginTop: 4 }}>
          <Text style={{ color: '#DC2626', fontSize: 13, fontWeight: '600' }}>{globalError}</Text>
        </View>
      )}
    </ResponsiveModal>
  );
}
