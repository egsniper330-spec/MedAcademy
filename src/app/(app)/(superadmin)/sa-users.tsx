/**
 * sa-users.tsx — Super Admin unified Users page
 * Merges: Users (students), Doctor Management, Admin Management
 * Filter tabs: All · Students · Doctors · Admins
 * Every existing action is preserved.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, TextInput,
  ActivityIndicator, RefreshControl, useColorScheme,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  Search, Users, MoreVertical, Mail, Phone,
  GraduationCap, Stethoscope, UserCog, CheckCircle, UserPlus,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ActionMenu, type ActionKey } from '@/components/ActionMenu';
import { EditUserDialog } from '@/components/EditUserDialog';
import { DeviceManagerSheet } from '@/components/DeviceManagerSheet';
import { BulkSelectBar, type BulkAction } from '@/components/BulkSelectBar';
import { DeleteAccountModal } from '@/components/DeleteAccountModal';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { useToast } from '@/components/Toast';
import { CreateUserModal } from '@/components/CreateUserModal';
import { neuColors, neuFlatStyle } from '@/lib/neu';
import { displayPhoneNational } from '@/lib/phone';
import { getPublicEmail, getAllUsers, updateUserStatus, blockUser, unblockUser, promoteToDoctor, promoteToAdmin,
  demoteDoctor, demoteAdminToStudent, trashUser, undoTrash, bulkUserOps,
  enableUnlimitedDevices, disableUnlimitedDevices, getLoginHistory,
} from '@/lib/api';
import { supabase } from '@/client/supabase';
import { useDebounce } from '@/lib/useDebounce';
import { useActionLoading } from '@/lib/useActionLoading';
import { logAndParse, parseError } from '@/lib/parseError';
import { ResponsiveModal } from '@/components/ResponsiveModal';

// ── Types ──────────────────────────────────────────────────────────────────

type RoleTab = 'all' | 'student' | 'doctor' | 'admin';

const ROLE_TABS: { key: RoleTab; label: string; color: string }[] = [
  { key: 'all',     label: 'All Users', color: '#6B7280' },
  { key: 'student', label: 'Students',  color: '#7C3AED' },
  { key: 'doctor',  label: 'Doctors',   color: '#16A34A' },
  { key: 'admin',   label: 'Admins',    color: '#EF4444' },
];

const ROLE_COLORS: Record<string, string> = {
  student: '#7C3AED',
  doctor:  '#16A34A',
  admin:   '#EF4444',
};

function actionsForUser(user: any): ActionKey[] {
  const role = user?.role ?? 'student';
  const isUnlimited = user?.max_devices === null;
  const deviceAction: ActionKey = isUnlimited ? 'limited_devices' : 'unlimited_devices';
  // change_password replaces reset_password email flow
  const base: ActionKey[] = ['edit', 'change_password', deviceAction, 'devices', 'login_history', 'audit'];
  if (role === 'doctor') base.push('earnings');
  if (user?.status === 'blocked') base.splice(1, 0, 'unblock');
  else                            base.splice(1, 0, 'block');
  if (role === 'student') { base.push('promote_doctor', 'promote_admin'); }
  if (role === 'doctor')  { base.push('promote_admin', 'demote_student'); }
  if (role === 'admin')   { base.push('demote_doctor', 'demote_student'); }
  base.push('delete');
  return base;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function SAUsers() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { showToast } = useToast();
  const router = useRouter();
  const { isLoading, run } = useActionLoading();

  const [activeTab, setActiveTab] = useState<RoleTab>('all');
  const [users, setUsers] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 400);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Modals
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [menuVisible, setMenuVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [devicesVisible, setDevicesVisible] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [changePwVisible, setChangePwVisible] = useState(false);
  const [loginHistoryModal, setLoginHistoryModal] = useState(false);
  const [loginHistory, setLoginHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Bulk select
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [undoInfo, setUndoInfo] = useState<{ id: string; name: string } | null>(null);

  // Create user
  const [createVisible, setCreateVisible] = useState(false);

  // ── Pagination ─────────────────────────────────────────────────────────
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(0);

  const toggleBulk = (id: string) => setBulkSelected(prev => {
    const s = new Set(prev);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });
  const clearBulk = () => { setBulkSelected(new Set()); setBulkMode(false); };

  const showUndo = (id: string, name: string) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoInfo({ id, name });
    undoTimer.current = setTimeout(() => setUndoInfo(null), 10000);
  };

  const handleUndo = async () => {
    if (!undoInfo) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoInfo(null);
    try { await undoTrash(undoInfo.id); await loadData(); showToast({ type: 'success', message: `${undoInfo.name} restored.` }); }
    catch (e) { showToast({ type: 'error', message: logAndParse(e, 'undo') }); }
  };

  // ── Data loading ───────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const role = activeTab === 'all' ? undefined : activeTab;
      const data = await getAllUsers(role as any);
      setUsers(data);
    } catch (_) {}
    setLoading(false);
  }, [activeTab]);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    setPage(0);
    loadData();
  }, [loadData]));

  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const handleSearch = useCallback(async () => {
    const trimmed = debouncedQuery.trim();
    if (!trimmed) { loadData(); return; }
    setSearching(true);
    try {
      const { data } = await supabase.rpc('lookup_user_by_identifier', { p_identifier: trimmed });
      const role = activeTab === 'all' ? undefined : activeTab;
      setUsers(role ? (data ?? []).filter((u: any) => u.role === role) : (data ?? []));
    } catch (_) {}
    setSearching(false);
    setLoading(false);
  }, [debouncedQuery, loadData, activeTab]);

  // Trigger search whenever debounced query changes
  useEffect(() => { handleSearch(); }, [handleSearch]);

  const handleBulkAction = async (action: BulkAction) => {
    if (!bulkSelected.size) return;
    setBulkLoading(true);
    const ids = [...bulkSelected];
    try {
      if (action === 'trash') {
        await bulkUserOps('trash', ids, 'Bulk delete by super admin');
        setUsers(prev => prev.filter(u => !ids.includes(u.id)));
      } else {
        const res = await bulkUserOps(action as any, ids);
        if (action === 'block' || action === 'unblock') {
          const status = action === 'block' ? 'blocked' : 'active';
          setUsers(prev => prev.map(u => ids.includes(u.id) ? { ...u, status } : u));
        }
        showToast({ type: 'success', message: `${res.succeeded} user(s) updated.` });
      }
      clearBulk();
    } catch (e) { showToast({ type: 'error', message: logAndParse(e, `bulk.${action}`) }); }
    finally { setBulkLoading(false); }
  };

  // ── Action handler ─────────────────────────────────────────────────────

  const openMenu = (user: any) => { setSelectedUser(user); setMenuVisible(true); };

  const handleAction = async (key: ActionKey) => {
    if (!selectedUser) return;
    const id = selectedUser.id;

    if (key === 'change_password') { setMenuVisible(false); setChangePwVisible(true); return; }
    if (key === 'edit')    { setMenuVisible(false); setEditVisible(true); return; }
    if (key === 'devices') { setMenuVisible(false); setDevicesVisible(true); return; }
    if (key === 'delete') {
      setMenuVisible(false);
      const name = selectedUser?.full_name ?? 'User';
      try {
        await trashUser(id, 'Deleted by super admin');
        setUsers(p => p.filter(u => u.id !== id));
        showUndo(id, name);
      } catch (e) { showToast({ type: 'error', message: logAndParse(e, 'trash') }); }
      return;
    }
    if (key === 'login_history') {
      setMenuVisible(false);
      setHistoryLoading(true);
      setLoginHistoryModal(true);
      try { const res = await getLoginHistory(id); setLoginHistory((res as any)?.history ?? []); }
      catch (e) { showToast({ type: 'error', message: parseError(e, 'Failed to load login history.') }); }
      setHistoryLoading(false);
      return;
    }
    if (key === 'earnings') { setMenuVisible(false); router.push(`/(app)/(superadmin)/sa-doctor-earnings?doctor_id=${id}&doctor_name=${encodeURIComponent(selectedUser?.full_name ?? '')}` as RelativePathString); return; }
    if (key === 'audit')    { setMenuVisible(false); router.push(`/(app)/user-activity?user_id=${id}&user_name=${encodeURIComponent(selectedUser?.full_name ?? 'User')}` as RelativePathString); return; }

    const actionMap: Partial<Record<ActionKey, () => Promise<void>>> = {
      block:              async () => { await blockUser(id); setUsers(p => p.map(u => u.id === id ? { ...u, status: 'blocked' } : u)); showToast({ type: 'success', message: 'User blocked.' }); },
      unblock:            async () => { await unblockUser(id); setUsers(p => p.map(u => u.id === id ? { ...u, status: 'active' } : u)); showToast({ type: 'success', message: 'User unblocked.' }); },
      promote_doctor:     async () => { await promoteToDoctor(id); setUsers(p => p.filter(u => u.id !== id)); showToast({ type: 'success', message: 'Promoted to Doctor.' }); setMenuVisible(false); },
      promote_admin:      async () => { await promoteToAdmin(id);  setUsers(p => p.filter(u => u.id !== id)); showToast({ type: 'success', message: 'Promoted to Admin.' });  setMenuVisible(false); },
      demote_doctor:      async () => { await promoteToDoctor(id); setUsers(p => p.filter(u => u.id !== id)); showToast({ type: 'success', message: 'Demoted to Doctor.' }); setMenuVisible(false); },
      demote_student:     async () => { await demoteDoctor(id);    setUsers(p => p.filter(u => u.id !== id)); showToast({ type: 'success', message: 'Demoted to Student.' }); setMenuVisible(false); },
      unlimited_devices:  async () => { await enableUnlimitedDevices(id);     showToast({ type: 'success', message: 'Unlimited devices enabled.' }); },
      limited_devices:    async () => { await disableUnlimitedDevices(id, 1); showToast({ type: 'success', message: 'Device limit set to 1.' }); },
    };
    const fn = actionMap[key];
    if (!fn) return;
    const ok = await run(key, async () => {
      try { await fn(); return true; }
      catch (e) { showToast({ type: 'error', message: logAndParse(e, key) }); return false; }
    });
    if (ok) setMenuVisible(false);
  };

  const handleDeleted = (deletedId: string) => {
    setUsers(p => p.filter(u => u.id !== deletedId));
    showToast({ type: 'success', message: 'Account permanently deleted.' });
    setDeleteConfirm(false);
    setSelectedUser(null);
  };

  // ── Filter + paginate ──────────────────────────────────────────────────

  const filtered = debouncedQuery.trim()
    ? users.filter(u => {
        const q = debouncedQuery.trim().toLowerCase();
        const raw = debouncedQuery.trim();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
          return u.id === raw;
        }
        return (
          u.full_name?.toLowerCase().includes(q)     ||
          u.profile_email?.toLowerCase().includes(q) ||
          u.email?.toLowerCase().includes(q)          ||
          u.watermark_id?.toLowerCase().includes(q)   ||
          u.phone?.includes(raw)                       ||
          u.phone_e164?.includes(raw)                 ||
          u.phone_national?.includes(raw)
        );
      })
    : users;

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const loadingKeys = new Set<ActionKey>(
    isLoading('block')   ? ['block']   :
    isLoading('unblock') ? ['unblock'] :
    isLoading('promote_doctor') ? ['promote_doctor'] :
    isLoading('promote_admin') ? ['promote_admin'] :
    isLoading('demote_doctor') ? ['demote_doctor'] :
    isLoading('demote_student') ? ['demote_student'] :
    isLoading('unlimited_devices') ? ['unlimited_devices'] :
    isLoading('limited_devices') ? ['limited_devices'] :
    isLoading('reset_password') ? ['reset_password'] : []
  );

  const roleColor = (role: string) => ROLE_COLORS[role] ?? '#6B7280';

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      >
        <View style={{ padding: 20 }}>
          {/* Header */}
          <View style={{ marginBottom: 20, marginTop: 8 }}>
            <PageHeader
              title="Users"
              subtitle="All platform members"
              accentColor={c.primary}
              rightAction={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Pressable
                    onPress={() => setBulkMode(m => !m)}
                    style={[neuFlatStyle(isDark), { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 }]}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: bulkMode ? c.primary : c.text }}>
                      {bulkMode ? 'Done' : 'Select'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setCreateVisible(true)}
                    style={[neuFlatStyle(isDark), {
                      width: 36, height: 36, borderRadius: 10,
                      alignItems: 'center', justifyContent: 'center',
                    }]}
                  >
                    <UserPlus size={18} color={c.primary} />
                  </Pressable>
                </View>
              }
            />
          </View>

          {/* Undo toast */}
          {undoInfo && (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1F2937', borderRadius: 12, padding: 14, marginBottom: 12 }}>
              <Text style={{ color: '#fff', fontSize: 13 }}>{undoInfo.name} moved to trash</Text>
              <Pressable onPress={handleUndo} style={{ backgroundColor: c.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Undo (10s)</Text>
              </Pressable>
            </View>
          )}

          {/* Role filter tabs */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', gap: 8, paddingRight: 8 }}>
              {ROLE_TABS.map(tab => {
                const active = activeTab === tab.key;
                return (
                  <Pressable
                    key={tab.key}
                    onPress={() => { setActiveTab(tab.key); setPage(0); setQuery(''); }}
                    style={[
                      neuFlatStyle(isDark),
                      {
                        paddingHorizontal: 16, paddingVertical: 9, borderRadius: 22,
                        backgroundColor: active ? tab.color : undefined,
                        borderWidth: active ? 0 : 1,
                        borderColor: `${tab.color}30`,
                      },
                    ]}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '700', color: active ? '#fff' : tab.color }}>
                      {tab.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>

          {/* Search bar */}
          <View style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 16, gap: 10, minWidth: 0 }]}>
            <Search size={18} color={c.text} style={{ opacity: 0.4, flexShrink: 0 } as any} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search name, email, phone or ID…"
              placeholderTextColor={`${c.text}55`}
              autoCapitalize="none"
              returnKeyType="search"
              onSubmitEditing={handleSearch}
              style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text }}
            />
            {searching && <ActivityIndicator size="small" color={c.primary} />}
          </View>

          {/* User count */}
          {!loading && (
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginBottom: 12, marginLeft: 2 }}>
              {filtered.length} {activeTab === 'all' ? 'users' : activeTab + 's'} total
            </Text>
          )}

          {/* User list */}
          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
          ) : paginated.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <Users size={48} color={c.primary} style={{ opacity: 0.2 } as any} />
              <Text style={{ color: c.text, opacity: 0.4, fontSize: 16, marginTop: 12 }}>No users found</Text>
            </View>
          ) : (
            paginated.map(user => (
              <NeuCard key={user.id} style={{ marginBottom: 10, padding: 14, flexDirection: 'row', alignItems: 'center' }}>
                {/* Avatar */}
                <View style={{
                  width: 44, height: 44, borderRadius: 14,
                  backgroundColor: `${roleColor(user.role)}20`,
                  alignItems: 'center', justifyContent: 'center', marginRight: 12,
                }}>
                  <Text style={{ fontSize: 17, fontWeight: '800', color: roleColor(user.role) }}>
                    {user.full_name?.[0]?.toUpperCase() ?? '?'}
                  </Text>
                </View>

                {/* Info */}
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{user.full_name}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 1 }}>
                    <Mail size={11} color={c.text} style={{ opacity: 0.4 } as any} />
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginLeft: 3 }} numberOfLines={1}>
                      {getPublicEmail(user) ?? displayPhoneNational(user.phone_e164 ?? user.phone) ?? '—'}
                    </Text>
                  </View>
                  {(user.phone_e164 ?? user.phone) && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 1 }}>
                      <Phone size={11} color={c.text} style={{ opacity: 0.4 } as any} />
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginLeft: 3 }}>
                        {displayPhoneNational(user.phone_e164 ?? user.phone)}
                      </Text>
                    </View>
                  )}
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 6 }}>
                    <View style={{ backgroundColor: `${roleColor(user.role)}20`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: roleColor(user.role), textTransform: 'uppercase' }}>
                        {user.role}
                      </Text>
                    </View>
                    <View style={{ backgroundColor: user.status === 'active' ? '#16A34A20' : '#DC262620', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: user.status === 'active' ? '#16A34A' : '#DC2626', textTransform: 'uppercase' }}>
                        {user.status === 'blocked' ? 'BLOCKED' : user.status}
                      </Text>
                    </View>
                  </View>

                  {/* Doctor credit summary — only for doctors */}
                  {user.role === 'doctor' && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 7, gap: 0 }}>
                      {[
                        { label: 'Allocated', value: user.credits_allocated ?? 0, color: c.primary },
                        { label: 'Consumed',  value: user.credits_consumed  ?? 0, color: '#DC2626' },
                        { label: 'Remaining', value: user.credits_balance   ?? 0, color: '#16A34A' },
                      ].map((item, idx) => (
                        <View key={item.label} style={{
                          flex: 1, alignItems: 'center',
                          borderLeftWidth: idx > 0 ? 1 : 0,
                          borderLeftColor: `${c.text}12`,
                          paddingVertical: 3,
                        }}>
                          <Text style={{ fontSize: 13, fontWeight: '800', color: item.color, lineHeight: 16 }}>
                            {item.value}
                          </Text>
                          <Text style={{ fontSize: 9, color: c.text, opacity: 0.38, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                            {item.label}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>

                {/* Action / select */}
                <Pressable
                  onPress={() => bulkMode ? toggleBulk(user.id) : openMenu(user)}
                  style={{
                    width: 36, height: 36, borderRadius: 10,
                    backgroundColor: bulkMode
                      ? (bulkSelected.has(user.id) ? `${c.primary}30` : `${c.text}10`)
                      : `${c.text}10`,
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {bulkMode
                    ? <CheckCircle size={18} color={bulkSelected.has(user.id) ? c.primary : `${c.text}40`} />
                    : <MoreVertical size={18} color={c.text} style={{ opacity: 0.5 } as any} />}
                </Pressable>
              </NeuCard>
            ))
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 16, marginBottom: 8 }}>
              <NeuButton
                label="← Prev"
                onPress={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                variant="secondary"
                style={{ paddingHorizontal: 16 }}
              />
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.6 }}>
                {page + 1} / {totalPages}
              </Text>
              <NeuButton
                label="Next →"
                onPress={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                variant="secondary"
                style={{ paddingHorizontal: 16 }}
              />
            </View>
          )}
        </View>
      </ScrollView>

      {/* Bulk select bar */}
      {bulkMode && bulkSelected.size > 0 && (
        <BulkSelectBar
          count={bulkSelected.size}
          role={activeTab === 'all' ? 'student' : activeTab}
          loading={bulkLoading}
          onAction={handleBulkAction}
          onClear={clearBulk}
        />
      )}

      {/* Action menu */}
      <ActionMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        title={selectedUser?.full_name ?? ''}
        subtitle={selectedUser ? (getPublicEmail(selectedUser) ?? displayPhoneNational(selectedUser.phone_e164 ?? selectedUser.phone) ?? '—') : undefined}
        badge={
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <View style={{ backgroundColor: `${roleColor(selectedUser?.role ?? 'student')}20`, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: roleColor(selectedUser?.role ?? 'student'), textTransform: 'uppercase' }}>
                {selectedUser?.role ?? ''}
              </Text>
            </View>
            <View style={{ backgroundColor: selectedUser?.status === 'active' ? '#16A34A20' : '#DC262620', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: selectedUser?.status === 'active' ? '#16A34A' : '#DC2626', textTransform: 'uppercase' }}>
                {selectedUser?.status === 'blocked' ? 'BLOCKED' : (selectedUser?.status ?? '')}
              </Text>
            </View>
          </View>
        }
        actions={actionsForUser(selectedUser)}
        onAction={handleAction}
        loadingKeys={loadingKeys}
      />

      {/* Edit dialog */}
      <EditUserDialog
        visible={editVisible}
        onClose={() => setEditVisible(false)}
        user={selectedUser}
        allowedFields={['full_name', 'email', 'phone', 'university', 'password', 'status']}
        isSuperAdmin
        onSaved={updated => {
          setUsers(p => p.map(u => u.id === updated.id ? { ...u, ...updated } : u));
          showToast({ type: 'success', message: 'User updated.' });
        }}
      />

      {/* Device manager */}
      <DeviceManagerSheet
        visible={devicesVisible}
        onClose={() => setDevicesVisible(false)}
        userId={selectedUser?.id ?? ''}
        userName={selectedUser?.full_name}
      />

      {/* Change password */}
      <ChangePasswordModal
        visible={changePwVisible}
        onClose={() => setChangePwVisible(false)}
        targetUserId={selectedUser?.id ?? ''}
        targetName={selectedUser?.full_name ?? 'User'}
        targetRole={selectedUser?.role}
      />

      {/* Delete account */}
      <DeleteAccountModal
        userId={selectedUser?.id ?? null}
        visible={deleteConfirm}
        onClose={() => setDeleteConfirm(false)}
        onDeleted={handleDeleted}
      />

      {/* Login history */}
      <ResponsiveModal
        visible={loginHistoryModal}
        onClose={() => setLoginHistoryModal(false)}
        title="Login History"
        subtitle={selectedUser?.full_name}
      >
        {historyLoading ? <ActivityIndicator color={c.primary} style={{ marginVertical: 30 }} /> : (
          <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
            {loginHistory.length === 0
              ? <Text style={{ color: c.text, opacity: 0.4, textAlign: 'center', padding: 30 }}>No login history found.</Text>
              : loginHistory.map((h, i) => (
                <NeuCard key={h.id ?? i} style={{ marginBottom: 8, padding: 12 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: h.success ? '#16A34A' : '#DC2626' }}>
                        {h.success ? '✓ Success' : '✗ Failed'}
                      </Text>
                      {h.device_name && <Text style={{ fontSize: 12, color: c.text, opacity: 0.6 }}>{h.device_name} · {h.platform}</Text>}
                      {h.ip_address && <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{h.ip_address}</Text>}
                    </View>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>
                      {h.created_at ? new Date(h.created_at).toLocaleDateString() : ''}
                    </Text>
                  </View>
                </NeuCard>
              ))
            }
          </ScrollView>
        )}
      </ResponsiveModal>

      {/* Create User modal */}
      <CreateUserModal
        visible={createVisible}
        onClose={() => setCreateVisible(false)}
        onCreated={newUser => {
          // Prepend the new user to the list and highlight it
          setUsers(prev => [{ ...newUser, status: 'active', credits_allocated: 0, credits_consumed: 0, credits_balance: 0 }, ...prev]);
          showToast({ type: 'success', message: `${newUser.full_name} created successfully.` });
          setPage(0);
        }}
      />
    </View>
  );
}
