import { useCallback, useRef, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  View, Text, ScrollView, useColorScheme, Pressable, RefreshControl,
  TextInput, ActivityIndicator, Modal, FlatList,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Search, Users, MoreVertical, Phone, Mail, UserPlus, Eye, EyeOff, ChevronDown, CheckCircle, CheckSquare, AlertTriangle } from 'lucide-react-native';
import { displayPhoneNational } from '@/lib/phone';
import { normalizePhoneE164 } from '@/lib/identifier';
import {
  getAllUsers, updateUserStatus, blockUser, unblockUser, setUserRole, deleteUser, createManagedUser,
  getUniversities, getFaculties, getAcademicLevels,
  getLoginHistory, enableUnlimitedDevices, disableUnlimitedDevices,
  trashUser, undoTrash, bulkUserOps,
} from '@/lib/api';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { ActionMenu, type ActionKey } from '@/components/ActionMenu';
import { EditUserDialog } from '@/components/EditUserDialog';
import { DeviceManagerSheet } from '@/components/DeviceManagerSheet';
import { BulkSelectBar, type BulkAction } from '@/components/BulkSelectBar';
import { useToast } from '@/components/Toast';
import { neuColors, neuFlatStyle } from '@/lib/neu';
import { validateEmail, validateRequired, validatePasswordSimple, validateMatch } from '@/lib/validation';
import { parseError, logAndParse } from '@/lib/parseError';
import { useActionLoading } from '@/lib/useActionLoading';
import { useDebounce } from '@/lib/useDebounce';
import { DeleteAccountModal } from '@/components/DeleteAccountModal';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { getPublicEmail } from '@/lib/api';
import { UserRole, UserStatus } from '@/lib/enums';
import { COUNTRIES, DEFAULT_COUNTRY, buildE164, validateNationalNumber, type Country } from '@/lib/phone';
// Role filter options — sourced from shared enum constants
const ROLE_FILTERS = ['', UserRole.STUDENT, UserRole.DOCTOR, UserRole.ADMIN];
const STATUS_FILTERS = ['', UserStatus.ACTIVE, UserStatus.SUSPENDED];

// ── Inline country-code picker for the Create User modal ─────────────────────
function AdminCountryPicker({ value, onChange, c }: { value: Country; onChange: (c: Country) => void; c: typeof neuColors.light }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const filtered = search.trim()
    ? COUNTRIES.filter(ct =>
        ct.name.toLowerCase().includes(search.toLowerCase()) ||
        ct.callingCode.includes(search) ||
        ct.iso.toLowerCase().includes(search.toLowerCase())
      )
    : COUNTRIES;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 13, marginRight: 8, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 5, minWidth: 90 }}
      >
        <Text style={{ fontSize: 20, marginRight: 4 }}>{value.flag}</Text>
        <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginRight: 2 }}>{value.callingCode}</Text>
        <ChevronDown size={12} color={c.text} style={{ opacity: 0.4 }} />
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={() => setOpen(false)}>
          <Pressable style={{ backgroundColor: c.base, borderTopLeftRadius: 24, borderTopRightRadius: 24, width: '100%', maxHeight: '72%', padding: 20 }} onPress={e => e.stopPropagation()}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: `${c.text}20`, alignSelf: 'center', marginBottom: 14 }} />
            <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, marginBottom: 12, textAlign: 'center' }}>Select Country</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.base, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12, shadowColor: c.shadowDark, shadowOffset: { width: 1, height: 1 }, shadowOpacity: 0.4, shadowRadius: 3 }}>
              <Search size={14} color={c.text} style={{ opacity: 0.4, marginRight: 8, flexShrink: 0 }} />
              <TextInput value={search} onChangeText={setSearch} placeholder="Search…" placeholderTextColor={`${c.text}55`} autoCapitalize="none" style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text, paddingVertical: 0 }} />
            </View>
            <FlatList
              data={filtered}
              keyExtractor={item => item.iso}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => { onChange(item); setOpen(false); setSearch(''); }}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: `${c.text}08`, backgroundColor: item.iso === value.iso ? `${c.primary}10` : 'transparent', borderRadius: 8 }}
                >
                  <Text style={{ fontSize: 22, marginRight: 12 }}>{item.flag}</Text>
                  <Text style={{ flex: 1, fontSize: 14, color: c.text, fontWeight: item.iso === value.iso ? '700' : '400' }} numberOfLines={1}>{item.name}</Text>
                  <Text style={{ fontSize: 13, color: c.primary, fontWeight: '600' }}>{item.callingCode}</Text>
                </Pressable>
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

  // Actions per role — change_password replaces reset_password email flow
function actionsForRole(user: any): ActionKey[] {
  const role = user?.role ?? 'student';
  const isUnlimited = user?.max_devices === null;
  const deviceAction: ActionKey = isUnlimited ? 'limited_devices' : 'unlimited_devices';
  const base: ActionKey[] = ['edit', 'change_password', deviceAction, 'devices', 'login_history', 'audit'];
  if (role === 'doctor') base.push('timeline');
  if (user?.status === 'blocked') base.splice(1, 0, 'unblock');
  else                            base.splice(1, 0, 'block');
  if (role === 'student')        base.push('promote_doctor', 'promote_admin');
  if (role === 'doctor')         base.push('promote_admin', 'demote_student');
  if (role === 'admin')          base.push('demote_doctor', 'demote_student');
  base.push('delete');
  return base;
}

export default function AdminUsers() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { showToast } = useToast();
  const router = useRouter();
  const { isLoading, run } = useActionLoading();

  const [users, setUsers] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 400);
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [menuVisible, setMenuVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [devicesVisible, setDevicesVisible] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [changePwVisible, setChangePwVisible] = useState(false);
  const [loginHistoryModal, setLoginHistoryModal] = useState(false);
  const [loginHistory, setLoginHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ── Bulk select ────────────────────────────────────────────────────────────
  const [bulkMode,     setBulkMode]     = useState(false);
  const [selected,     setSelected]     = useState<Set<string>>(new Set());
  const [bulkLoading,  setBulkLoading]  = useState(false);
  // Undo-trash: store last trashed id + name for 10-second window
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [undoInfo,     setUndoInfo]     = useState<{ id: string; name: string } | null>(null);

  const flat = neuFlatStyle(isDark);

  const toggleSelect = (id: string) => {
    setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  };
  const clearBulk = () => { setSelected(new Set()); setBulkMode(false); };

  const showUndoToast = (id: string, name: string) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoInfo({ id, name });
    undoTimer.current = setTimeout(() => setUndoInfo(null), 10000);
  };

  const handleUndoTrash = async () => {
    if (!undoInfo) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoInfo(null);
    try {
      await undoTrash(undoInfo.id);
      setUsers(prev => prev.filter(u => u.id !== undoInfo.id)); // was already removed; add back
      await loadData(); // reload to get restored user
      showToast({ type: 'success', message: `${undoInfo.name} restored.` });
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, 'undo.trash') });
    }
  };

  const handleBulkAction = async (action: BulkAction) => {
    if (!selected.size) return;
    setBulkLoading(true);
    const ids = [...selected];
    try {
      if (action === 'trash') {
        const res = await bulkUserOps('trash', ids, 'Bulk delete by admin');
        setUsers(prev => prev.filter(u => !ids.includes(u.id)));
        clearBulk();
        showToast({ type: 'success', message: `${res.succeeded} account(s) moved to trash.` });
      } else {
        const res = await bulkUserOps(action as any, ids);
        if (action === 'block' || action === 'unblock') {
          const newStatus = action === 'block' ? 'blocked' : 'active';
          setUsers(prev => prev.map(u => ids.includes(u.id) ? { ...u, status: newStatus } : u));
        }
        clearBulk();
        showToast({ type: 'success', message: `${res.succeeded} account(s) updated.` });
      }
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, `bulk.${action}`) });
    } finally {
      setBulkLoading(false);
    }
  };

  // ── Create User form ───────────────────────────────────────────────────────
  const EMPTY_FORM = { full_name: '', email: '', nationalPhone: '', password: '', confirm: '', university_id: '', faculty_id: '', academic_level_id: '' };
  const [createModal, setCreateModal] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [createCountry, setCreateCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [isDirty, setIsDirty] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [universities, setUniversities] = useState<any[]>([]);
  const [faculties, setFaculties] = useState<any[]>([]);
  const [levels, setLevels] = useState<any[]>([]);
  const [uniOpen, setUniOpen] = useState(false);
  const [facOpen, setFacOpen] = useState(false);
  const [lvlOpen, setLvlOpen] = useState(false);

  const openCreateModal = async () => {
    setForm({ ...EMPTY_FORM }); setCreateCountry(DEFAULT_COUNTRY);
    setCreateError(''); setFieldErrors({}); setIsDirty(false);
    try { setUniversities(await getUniversities()); setFaculties([]); setLevels([]); } catch (_) {}
    setCreateModal(true);
  };

  const closeCreateModal = () => { setCreateModal(false); setIsDirty(false); setFieldErrors({}); };

  const setField = (k: string, v: string) => {
    setForm(prev => ({ ...prev, [k]: v })); setIsDirty(true);
    setFieldErrors(prev => ({ ...prev, [k]: '' }));
  };

  const onUniSelect = async (id: string) => {
    setField('university_id', id); setField('faculty_id', ''); setField('academic_level_id', '');
    setUniOpen(false);
    try { setFaculties(await getFaculties(id)); } catch (_) {}
    setLevels([]);
  };

  const onFacSelect = async (id: string) => {
    setField('faculty_id', id); setField('academic_level_id', ''); setFacOpen(false);
    try { setLevels(await getAcademicLevels(id)); } catch (_) {}
  };

  const handleCreate = async () => {
    setCreateError('');
    const errs: Record<string, string> = {};
    const nameErr = validateRequired(form.full_name, 'Full name');
    const emailErr = validateEmail(form.email);
    // Phone is required for admin-created accounts
    const phoneErr = validateNationalNumber(createCountry, form.nationalPhone.trim());
    const pwdErr = validatePasswordSimple(form.password);
    const matchErr = validateMatch(form.password, form.confirm);
    if (nameErr)  errs.full_name     = nameErr;
    if (emailErr) errs.email         = emailErr;
    if (phoneErr) errs.nationalPhone = phoneErr;
    if (pwdErr)   errs.password      = pwdErr;
    if (matchErr) errs.confirm       = matchErr;
    if (Object.keys(errs).length > 0) { setFieldErrors(errs); return; }

    const e164 = buildE164(createCountry, form.nationalPhone.trim());
    if (!e164) {
      setFieldErrors(prev => ({ ...prev, nationalPhone: 'Invalid phone number — check and retry.' }));
      return;
    }

    // Check phone uniqueness before hitting the EF
    const { data: existingPhone } = await supabase
      .from('profiles').select('id').eq('phone_e164', e164).maybeSingle();
    if (existingPhone) {
      setFieldErrors(prev => ({ ...prev, nationalPhone: 'This phone number is already registered.' }));
      return;
    }

    setCreateLoading(true);
    try {
      await createManagedUser({
        action: 'create_user',
        full_name: form.full_name.trim(),
        email: form.email.trim().toLowerCase(),
        phone: e164,
        phone_country_code: createCountry.callingCode,
        phone_national: form.nationalPhone.replace(/\D/g, ''),
        password: form.password,
        university_id: form.university_id || undefined,
        faculty_id: form.faculty_id || undefined,
        academic_level_id: form.academic_level_id || undefined,
        status: 'active',
      });
      setIsDirty(false); closeCreateModal();
      showToast({ type: 'success', message: 'User created successfully.' });
      await loadData();
    } catch (e: any) {
      setCreateError(e?.message || 'Failed to create user. Please try again.');
    }
    setCreateLoading(false);
  };

  const loadData = useCallback(async () => {
    try { setUsers(await getAllUsers(roleFilter || undefined, statusFilter || undefined)); } catch (_) {}
    setLoading(false);
  }, [roleFilter, statusFilter]);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const handleSearch = useCallback(async () => {
    const trimmed = debouncedQuery.trim();
    if (!trimmed) { loadData(); return; }
    setSearching(true);
    try {
      const { data } = await supabase.rpc('lookup_user_by_identifier', { p_identifier: trimmed });
      let results: any[] = data ?? [];
      if (roleFilter) results = results.filter(u => u.role === roleFilter);
      if (statusFilter) results = results.filter(u => u.status === statusFilter);
      setUsers(results);
    } catch (_) {}
    setSearching(false); setLoading(false);
  }, [debouncedQuery, roleFilter, statusFilter, loadData]);

  const openMenu = (user: any) => { setSelectedUser(user); setMenuVisible(true); };

  const handleAction = async (key: ActionKey) => {
    if (!selectedUser) return;
    const id = selectedUser.id;

    if (key === 'change_password') { setMenuVisible(false); setChangePwVisible(true); return; }
    if (key === 'edit')    { setMenuVisible(false); setEditVisible(true);   return; }
    if (key === 'devices') { setMenuVisible(false); setDevicesVisible(true); return; }
    if (key === 'delete')  {
      // Soft-delete: move to trash + show 10-second undo
      setMenuVisible(false);
      const name = selectedUser?.full_name ?? 'User';
      try {
        await trashUser(id, 'Deleted by admin');
        setUsers(p => p.filter(u => u.id !== id));
        setSelectedUser(null);
        showUndoToast(id, name);
      } catch (e) {
        showToast({ type: 'error', message: logAndParse(e, 'user.trash') });
      }
      return;
    }
    if (key === 'login_history') {
      setMenuVisible(false); setHistoryLoading(true); setLoginHistoryModal(true);
      try { const r = await getLoginHistory(id); setLoginHistory((r as any)?.history ?? []); }
      catch (e) { showToast({ type: 'error', message: parseError(e, 'Failed to load history.') }); }
      setHistoryLoading(false); return;
    }
    if (key === 'timeline') {
      setMenuVisible(false);
      router.push(`/(app)/(admin)/doctor-credit-timeline?doctor_id=${id}` as any);
      return;
    }
    if (key === 'audit') {
      setMenuVisible(false);
      router.push(`/(app)/user-activity?user_id=${id}&user_name=${encodeURIComponent(selectedUser?.full_name ?? 'User')}` as any);
      return;
    }

    const actionMap: Partial<Record<ActionKey, () => Promise<void>>> = {
      block:          async () => { await blockUser(id);   setUsers(p => p.map(u => u.id === id ? { ...u, status: 'blocked' } : u)); setSelectedUser((p: any) => p ? { ...p, status: 'blocked' } : null); showToast({ type: 'success', message: 'User blocked.' }); },
      unblock:        async () => { await unblockUser(id); setUsers(p => p.map(u => u.id === id ? { ...u, status: 'active'  } : u)); setSelectedUser((p: any) => p ? { ...p, status: 'active'  } : null); showToast({ type: 'success', message: 'User unblocked.' }); },
      promote_doctor: async () => { await setUserRole(id, 'doctor');  setUsers(p => p.map(u => u.id === id ? { ...u, role: 'doctor' }  : u)); setSelectedUser((p: any) => p ? { ...p, role: 'doctor' }  : null); showToast({ type: 'success', message: 'Promoted to Doctor.' }); },
      promote_admin:  async () => { await setUserRole(id, 'admin');   setUsers(p => p.map(u => u.id === id ? { ...u, role: 'admin' }   : u)); setSelectedUser((p: any) => p ? { ...p, role: 'admin' }   : null); showToast({ type: 'success', message: 'Promoted to Admin.' }); },
      demote_student: async () => { await setUserRole(id, 'student'); setUsers(p => p.map(u => u.id === id ? { ...u, role: 'student' } : u)); setSelectedUser((p: any) => p ? { ...p, role: 'student' } : null); showToast({ type: 'success', message: 'Demoted to Student.' }); },
      demote_doctor:  async () => { await setUserRole(id, 'doctor');  setUsers(p => p.map(u => u.id === id ? { ...u, role: 'doctor' }  : u)); setSelectedUser((p: any) => p ? { ...p, role: 'doctor' }  : null); showToast({ type: 'success', message: 'Demoted to Doctor.' }); },
      unlimited_devices: async () => {
        await enableUnlimitedDevices(id);
        // Reflect new state: max_devices = null (unlimited)
        setUsers(p => p.map(u => u.id === id ? { ...u, max_devices: null } : u));
        setSelectedUser((p: any) => p ? { ...p, max_devices: null } : null);
        showToast({ type: 'success', message: 'Unlimited devices enabled.' });
      },
      limited_devices: async () => {
        await disableUnlimitedDevices(id, 1);
        // Reflect new state: max_devices = 1 (limited)
        setUsers(p => p.map(u => u.id === id ? { ...u, max_devices: 1 } : u));
        setSelectedUser((p: any) => p ? { ...p, max_devices: 1 } : null);
        showToast({ type: 'success', message: 'Unlimited devices disabled (limit: 1).' });
      },
    };

    const fn = actionMap[key];
    if (!fn) return;
    await run(key, async () => {
      try { await fn(); } catch (e) { showToast({ type: 'error', message: logAndParse(e, `user.${key}`) }); }
    });
  };


  const handleDeleted = (deletedId: string) => {
    setUsers(p => p.filter(u => u.id !== deletedId));
    showToast({ type: 'success', message: 'User account permanently deleted.' });
    setDeleteConfirm(false);
    setSelectedUser(null);
  };
  const loadingKeys = new Set<string>(
    ['block','unblock','reset_password','promote_doctor','promote_admin','demote_student','demote_doctor','unlimited_devices','limited_devices']
      .filter(k => isLoading(k))
  );

  const filtered = query.trim()
    ? users.filter(u => {
        const q = query.trim().toLowerCase();
        const raw = query.trim();
        // UUID exact match
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
          return u.id === raw;
        }
        const normalizedQ = normalizePhoneE164(raw);
        return (
          u.full_name?.toLowerCase().includes(q)             ||
          u.profile_email?.toLowerCase().includes(q)        ||
          u.email?.toLowerCase().includes(q)                ||
          u.watermark_id?.toLowerCase().includes(q)         ||
          u.phone?.includes(raw)                             ||
          u.phone_e164?.includes(raw)                       ||
          u.phone_national?.includes(raw)                   ||
          (normalizedQ ? u.phone_e164 === normalizedQ : false)
        );
      })
    : users;

  const inp = { backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 5, fontSize: 15, color: c.text };
  const lbl = (t: string) => <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.7 }}>{t}</Text>;
  const dropBtn = (text: string, open: boolean, onPress: () => void) => (
    <Pressable onPress={onPress} style={{ ...inp, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <Text style={{ fontSize: 15, color: text ? c.text : `${c.text}55`, flex: 1 }} numberOfLines={1}>{text || 'Select…'}</Text>
      <ChevronDown size={16} color={c.text} style={{ opacity: 0.4 }} />
    </Pressable>
  );
  const dropList = (items: any[], selected: string, onSelect: (id: string) => void) => (
    <View style={{ backgroundColor: c.base, borderRadius: 12, marginBottom: 14, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 5, maxHeight: 180, overflow: 'hidden' }}>
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {items.map(item => (
          <Pressable key={item.id} onPress={() => onSelect(item.id)} style={{ paddingHorizontal: 14, paddingVertical: 11, backgroundColor: selected === item.id ? `${c.primary}18` : 'transparent', borderBottomWidth: 0.5, borderBottomColor: `${c.text}12` }}>
            <Text style={{ fontSize: 14, color: selected === item.id ? c.primary : c.text, fontWeight: selected === item.id ? '700' : '400' }}>{item.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
        <View style={{ padding: 20 }}>
          {/* Header + Add User + Bulk toggle */}
          <View style={{ marginBottom: 16, marginTop: 8 }}>
            <PageHeader
              title="User Management"
              subtitle="All platform users"
              rightAction={
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    onPress={() => { setBulkMode(b => !b); setSelected(new Set()); }}
                    style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: bulkMode ? `${c.primary}25` : `${c.text}10`, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <CheckSquare size={18} color={bulkMode ? c.primary : `${c.text}70`} />
                  </Pressable>
                  <NeuButton label="Add User" icon={<UserPlus size={15} color="#fff" />} onPress={openCreateModal} style={{ paddingHorizontal: 14 }} />
                </View>
              }
            />
          </View>

          {/* Undo-trash banner */}
          {undoInfo && (
            <View style={{ backgroundColor: '#1C1C1E', borderRadius: 12, flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 12, gap: 10 }}>
              <CheckCircle size={16} color="#4ADE80" />
              <Text style={{ flex: 1, color: '#fff', fontSize: 13 }}>{undoInfo.name} moved to Trash</Text>
              <Pressable onPress={handleUndoTrash} style={{ backgroundColor: c.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Undo (10s)</Text>
              </Pressable>
            </View>
          )}

          {/* Universal Search */}
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.base, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.6, shadowRadius: 6 }}>
            <Search size={18} color={c.text} style={{ opacity: 0.4 }} />
            <TextInput value={query} onChangeText={setQuery} placeholder="Name, email, phone or user ID…" placeholderTextColor={`${c.text}55`} autoCapitalize="none" returnKeyType="search" onSubmitEditing={handleSearch} style={{ flex: 1, marginLeft: 10, fontSize: 15, color: c.text }} />
            {searching && <ActivityIndicator size="small" color={c.primary} />}
          </View>
          <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginBottom: 12, marginLeft: 2 }}>Search by name, email, +20 phone, or user ID — then tap Enter</Text>

          {/* Role Filters */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {ROLE_FILTERS.map(r => (
                <Pressable key={r || 'all'} onPress={() => setRoleFilter(r)}
                  style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: roleFilter === r ? c.primary : `${c.text}12` }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: roleFilter === r ? '#fff' : c.text, textTransform: 'capitalize' }}>{r || 'All Roles'}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>

          {/* Status Filters */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {STATUS_FILTERS.map(s => (
                <Pressable key={s || 'all-status'} onPress={() => setStatusFilter(s)}
                  style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: statusFilter === s ? '#16A34A' : `${c.text}12` }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: statusFilter === s ? '#fff' : c.text, textTransform: 'capitalize' }}>{s || 'All Status'}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>

          {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} /> : (
            filtered.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                <Users size={48} color={c.primary} style={{ opacity: 0.2 } as any} />
                <Text style={{ color: c.text, opacity: 0.4, fontSize: 15, marginTop: 12 }}>No users found</Text>
              </View>
            ) : filtered.map(user => (
              <NeuCard key={user.id} style={{ marginBottom: 10, padding: 14, flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${roleColor(user.role)}20`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                  <Text style={{ fontSize: 16, fontWeight: '800', color: roleColor(user.role) }}>{user.full_name?.[0]?.toUpperCase() ?? '?'}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{user.full_name}</Text>
                  {/* Phone — primary identity field, always shown prominently */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                    <Phone size={11} color={c.primary} style={{ opacity: 0.7 }} />
                    {(user.phone_e164 ?? user.phone) ? (
                      <Text style={{ fontSize: 12, color: c.primary, marginLeft: 3, fontWeight: '600' }} numberOfLines={1}>
                        {displayPhoneNational(user.phone_e164 ?? user.phone)}
                      </Text>
                    ) : (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <AlertTriangle size={10} color="#DC2626" />
                        <Text style={{ fontSize: 12, color: '#DC2626', marginLeft: 3, fontWeight: '600' }}>No phone</Text>
                      </View>
                    )}
                  </View>
                  {/* Email — secondary */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 1 }}>
                    <Mail size={11} color={c.text} style={{ opacity: 0.4 }} />
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginLeft: 3 }} numberOfLines={1}>{getPublicEmail(user) ?? '—'}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 6 }}>
                    <View style={{ backgroundColor: roleColor(user.role) + '20', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: roleColor(user.role), textTransform: 'uppercase' }}>{user.role}</Text>
                    </View>
                    <View style={{ backgroundColor: user.status === 'active' ? '#16A34A20' : '#DC262620', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: user.status === 'active' ? '#16A34A' : '#DC2626', textTransform: 'uppercase' }}>
                        {user.status === 'blocked' ? 'BLOCKED' : user.status}
                      </Text>
                    </View>
                  </View>
                </View>
                <Pressable onPress={() => bulkMode ? toggleSelect(user.id) : openMenu(user)} style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: bulkMode ? (selected.has(user.id) ? `${c.primary}30` : `${c.text}10`) : `${c.text}10`, alignItems: 'center', justifyContent: 'center' }}>
                  {bulkMode
                    ? <CheckCircle size={18} color={selected.has(user.id) ? c.primary : `${c.text}40`} />
                    : <MoreVertical size={18} color={c.text} style={{ opacity: 0.5 }} />
                  }
                </Pressable>
              </NeuCard>
            ))
          )}
        </View>
      </ScrollView>

      {/* ── Bulk Select Bar ── */}
      {bulkMode && selected.size > 0 && (
        <BulkSelectBar
          count={selected.size}
          loading={bulkLoading}
          onAction={handleBulkAction}
          onClear={clearBulk}
        />
      )}

      {/* ── Action Menu ── */}
      <ActionMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        title={selectedUser?.full_name ?? ''}
        subtitle={selectedUser ? (getPublicEmail(selectedUser) ?? '—') : undefined}
        badge={
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <View style={{ backgroundColor: roleColor(selectedUser?.role) + '20', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: roleColor(selectedUser?.role), textTransform: 'uppercase' }}>{selectedUser?.role ?? ''}</Text>
            </View>
            <View style={{ backgroundColor: selectedUser?.status === 'active' ? '#16A34A20' : '#DC262620', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: selectedUser?.status === 'active' ? '#16A34A' : '#DC2626', textTransform: 'uppercase' }}>
                {selectedUser?.status === 'blocked' ? 'BLOCKED' : (selectedUser?.status ?? '')}
              </Text>
            </View>
          </View>
        }
        actions={actionsForRole(selectedUser)}
        onAction={handleAction}
        loadingKeys={loadingKeys}
      />

      {/* ── Edit Dialog ── */}
      <EditUserDialog
        visible={editVisible}
        onClose={() => setEditVisible(false)}
        user={selectedUser}
        allowedFields={['full_name', 'email', 'phone', 'university', 'password', 'status']}
        isSuperAdmin={false}
        onSaved={updated => {
          setUsers(p => p.map(u => u.id === updated.id ? { ...u, ...updated } : u));
          showToast({ type: 'success', message: 'User profile updated.' });
        }}
      />

      {/* ── Devices ── */}
      <DeviceManagerSheet
        visible={devicesVisible}
        onClose={() => setDevicesVisible(false)}
        userId={selectedUser?.id ?? ''}
        userName={selectedUser?.full_name}
      />

      {/* ── Change Password ── */}
      <ChangePasswordModal
        visible={changePwVisible}
        onClose={() => setChangePwVisible(false)}
        targetUserId={selectedUser?.id ?? ''}
        targetName={selectedUser?.full_name ?? 'User'}
        targetRole={selectedUser?.role}
      />

      {/* ── Delete Account ── */}
      <DeleteAccountModal
        userId={selectedUser?.id ?? null}
        visible={deleteConfirm}
        onClose={() => setDeleteConfirm(false)}
        onDeleted={handleDeleted}
      />

      {/* ── Login History ── */}
      <ResponsiveModal visible={loginHistoryModal} onClose={() => setLoginHistoryModal(false)} title="Login History" subtitle={selectedUser?.full_name}>
        {historyLoading ? <ActivityIndicator color={c.primary} style={{ marginVertical: 30 }} /> : (
          <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
            {loginHistory.length === 0 ? (
              <Text style={{ color: c.text, opacity: 0.4, textAlign: 'center', padding: 30 }}>No login history found.</Text>
            ) : loginHistory.map((h, i) => (
              <NeuCard key={h.id ?? i} style={{ marginBottom: 8, padding: 12 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: h.success ? '#16A34A' : '#DC2626' }}>{h.success ? '✓ Success' : '✗ Failed'}</Text>
                    {h.device_name && <Text style={{ fontSize: 12, color: c.text, opacity: 0.6 }}>{h.device_name} · {h.platform}</Text>}
                    {h.ip_address && <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{h.ip_address}</Text>}
                    {!h.success && h.failure_reason && <Text style={{ fontSize: 11, color: '#DC2626', opacity: 0.8 }}>{h.failure_reason}</Text>}
                  </View>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{h.created_at ? new Date(h.created_at).toLocaleDateString() : ''}</Text>
                </View>
              </NeuCard>
            ))}
          </ScrollView>
        )}
      </ResponsiveModal>

      {/* ── Create User Modal ── */}
      <ResponsiveModal
        visible={createModal}
        onClose={() => setCreateModal(false)}
        title="Create User"
        isDirty={isDirty}
        icon={<View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}><UserPlus size={20} color={c.primary} /></View>}
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={() => setCreateModal(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Create User" icon={<UserPlus size={15} color="#fff" />} onPress={handleCreate} loading={createLoading} style={{ flex: 1 }} />
          </View>
        }
      >
        {lbl('Full Name *')}
        <TextInput value={form.full_name} onChangeText={v => setField('full_name', v)} placeholder="Ahmed Mohamed" placeholderTextColor={`${c.text}55`} style={{ ...inp, marginBottom: fieldErrors.full_name ? 4 : 14 }} />
        {!!fieldErrors.full_name && <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10 }}>{fieldErrors.full_name}</Text>}

        {lbl('Email *')}
        <TextInput value={form.email} onChangeText={v => setField('email', v)} placeholder="user@example.com" placeholderTextColor={`${c.text}55`} autoCapitalize="none" keyboardType="email-address" style={{ ...inp, marginBottom: fieldErrors.email ? 4 : 14 }} />
        {!!fieldErrors.email && <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10 }}>{fieldErrors.email}</Text>}

        {lbl('Phone Number *')}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: fieldErrors.nationalPhone ? 4 : 14 }}>
          <AdminCountryPicker value={createCountry} onChange={(ct) => { setCreateCountry(ct); setField('nationalPhone', ''); }} c={c} />
          <View style={{ flex: 1, ...inp, flexDirection: 'row', alignItems: 'center', marginBottom: 0 }}>
            <Phone size={15} color={c.text} style={{ opacity: 0.4 }} />
            <TextInput
              value={form.nationalPhone}
              onChangeText={v => setField('nationalPhone', v)}
              placeholder={createCountry.hasLeadingZero ? '01020xxxxxx' : '501234567'}
              placeholderTextColor={`${c.text}55`}
              keyboardType="phone-pad"
              style={{ flex: 1, marginLeft: 8, fontSize: 15, color: c.text }}
            />
          </View>
        </View>
        {!!fieldErrors.nationalPhone
          ? <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10 }}>{fieldErrors.nationalPhone}</Text>
          : form.nationalPhone.trim()
            ? <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: -10, marginBottom: 12 }}>
                Stored as {buildE164(createCountry, form.nationalPhone) ?? `${createCountry.callingCode}…`}
              </Text>
            : null
        }

        {lbl('Password *')}
        <View style={{ ...inp, flexDirection: 'row', alignItems: 'center', marginBottom: fieldErrors.password ? 4 : 14 }}>
          <TextInput value={form.password} onChangeText={v => setField('password', v)} placeholder="Min 6 characters" placeholderTextColor={`${c.text}55`} secureTextEntry={!showPwd} style={{ flex: 1, fontSize: 15, color: c.text }} />
          <Pressable onPress={() => setShowPwd(p => !p)} hitSlop={8}>{showPwd ? <EyeOff size={18} color={c.text} style={{ opacity: 0.4 }} /> : <Eye size={18} color={c.text} style={{ opacity: 0.4 }} />}</Pressable>
        </View>
        {!!fieldErrors.password && <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10 }}>{fieldErrors.password}</Text>}

        {lbl('Confirm Password *')}
        <View style={{ ...inp, flexDirection: 'row', alignItems: 'center', marginBottom: fieldErrors.confirm ? 4 : 14 }}>
          <TextInput value={form.confirm} onChangeText={v => setField('confirm', v)} placeholder="Repeat password" placeholderTextColor={`${c.text}55`} secureTextEntry={!showConfirm} style={{ flex: 1, fontSize: 15, color: c.text }} />
          <Pressable onPress={() => setShowConfirm(p => !p)} hitSlop={8}>{showConfirm ? <EyeOff size={18} color={c.text} style={{ opacity: 0.4 }} /> : <Eye size={18} color={c.text} style={{ opacity: 0.4 }} />}</Pressable>
        </View>
        {!!fieldErrors.confirm && <Text style={{ color: '#DC2626', fontSize: 12, marginBottom: 10 }}>{fieldErrors.confirm}</Text>}

        {lbl('University')}
        {dropBtn(universities.find(u => u.id === form.university_id)?.name ?? '', uniOpen, () => setUniOpen(o => !o))}
        {uniOpen && dropList(universities, form.university_id, onUniSelect)}

        {lbl('Faculty')}
        {dropBtn(faculties.find(f => f.id === form.faculty_id)?.name ?? '', facOpen, () => setFacOpen(o => !o))}
        {facOpen && faculties.length > 0 && dropList(faculties, form.faculty_id, onFacSelect)}

        {lbl('Academic Level')}
        {dropBtn(levels.find(l => l.id === form.academic_level_id)?.name ?? '', lvlOpen, () => setLvlOpen(o => !o))}
        {lvlOpen && levels.length > 0 && dropList(levels, form.academic_level_id, id => { setField('academic_level_id', id); setLvlOpen(false); })}

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4, marginBottom: 8, alignItems: 'center' }}>
          <View style={{ backgroundColor: `${roleColor('student')}20`, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: roleColor('student') }}>STUDENT</Text>
          </View>
          <View style={{ backgroundColor: '#16A34A20', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>ACTIVE</Text>
          </View>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.45 }}>Default role & status</Text>
        </View>

        {!!createError && (
          <Text style={{ marginTop: 8, color: '#DC2626', fontSize: 13 }}>{createError}</Text>
        )}
      </ResponsiveModal>
    </View>
  );
}

function roleColor(r: string) {
  const m: Record<string, string> = { student: '#3B82F6', doctor: '#7C3AED', admin: '#EF4444', super_admin: '#DC2626' };
  return m[r] ?? '#6B7280';
}
