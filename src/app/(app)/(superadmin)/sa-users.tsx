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
  Square, CheckSquare, X,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ActionMenu, type ActionKey } from '@/components/ActionMenu';
import { EditUserDialog } from '@/components/EditUserDialog';
import { DeviceManagerSheet } from '@/components/DeviceManagerSheet';
import { BulkUserMenu, type BulkUserAction } from '@/components/BulkUserMenu';
import { DeleteAccountModal } from '@/components/DeleteAccountModal';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { useToast } from '@/components/Toast';
import { CreateUserModal } from '@/components/CreateUserModal';
import { neuColors, neuFlatStyle, useLayout, safeBottom, mutedTextStyle } from '@/lib/neu';
import { displayPhoneNational } from '@/lib/phone';
import { getPublicEmail, getAllUsers, updateUserStatus, promoteToDoctor, promoteToAdmin,
  demoteDoctor, demoteAdminToStudent, trashUser, undoTrash, bulkUserOps,
  enableUnlimitedDevices, disableUnlimitedDevices, getLoginHistory,
} from '@/lib/api';
import { backendClient } from '@/client/backendClient';
import { useDebounce } from '@/lib/useDebounce';
import { useActionLoading } from '@/lib/useActionLoading';
import { logAndParse, parseError } from '@/lib/parseError';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { ConfirmDialog, type ConfirmDialogRequest } from '@/components/ConfirmDialog';

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
  // EARNINGS: retired from the product — no per-doctor earnings action exists.
  // Status action mirrors the SERVER-authoritative account status:
  //   blocked   → Unblock (legacy blocked flow)
  //   suspended → Unsuspend (manual OR security-violation suspension — the
  //               security system writes status='suspended', so ONE action
  //               covers both; re-violation re-suspends via policy)
  //   otherwise → Suspend
  // Exactly one of the pair is ever shown.
  if (user?.status === 'blocked')        base.splice(1, 0, 'unblock');
  else if (user?.status === 'suspended') base.splice(1, 0, 'unsuspend');
  else                                   base.splice(1, 0, 'suspend');
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
  const layout = useLayout();
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

  // Bulk select — count, overflow menu, running batch, per-user result.
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState<BulkUserAction | null>(null);
  const [bulkMenuVisible, setBulkMenuVisible] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ succeeded: number; failed: number; message: string } | null>(null);
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
  const clearBulk = () => {
    setBulkSelected(new Set());
    setBulkMode(false);
    setBulkMenuVisible(false);
  };

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
      const { data } = await backendClient.rpc('lookup_user_by_identifier', { p_identifier: trimmed });
      const role = activeTab === 'all' ? undefined : activeTab;
      setUsers(role ? (data ?? []).filter((u: any) => u.role === role) : (data ?? []));
    } catch (_) {}
    setSearching(false);
    setLoading(false);
  }, [debouncedQuery, loadData, activeTab]);

  // Trigger search whenever debounced query changes
  useEffect(() => { handleSearch(); }, [handleSearch]);

  /**
   * Run one bulk operation over `ids` and reconcile the UI with the server's
   * per-user result.
   *
   * The backend answers with { succeeded, failed, errors[] } (see
   * AdminController::bulkUserOps). This function:
   *   • updates only the users the server actually changed (never a blanket
   *     optimistic rewrite of the whole list),
   *   • keeps the FAILED users selected so the admin can retry them,
   *   • reports partial success instead of one "N updated" that hides refusals,
   *   • lists the failures by name in a result sheet (no silent skipping).
   */
  const runBulk = async (action: BulkUserAction, ids: string[]) => {
    if (!ids.length) return;
    setBulkRunning(action);
    try {
      // The endpoint accepts at most 200 ids per call (AdminController enforces
      // it). "Select all N matching" can exceed that on a large directory, so
      // the batch is sent in 200-id chunks and the per-user results are merged —
      // the alternative would be a 422 on a perfectly valid selection.
      const CHUNK = 200;
      const reason = action === 'trash' ? 'Bulk delete by super admin' : 'Bulk action by super admin';
      const errors: { user_id: string; message: string }[] = [];
      let succeeded = 0;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const part = await bulkUserOps(action, ids.slice(i, i + CHUNK), reason);
        succeeded += part?.succeeded ?? 0;
        if (Array.isArray(part?.errors)) errors.push(...part.errors);
      }
      const res = { succeeded, failed: errors.length, errors };
      const failedIds = new Set(errors.map(e => e.user_id));
      const okIds = ids.filter(id => !failedIds.has(id));

      if (action === 'trash') {
        setUsers(prev => prev.filter(u => !okIds.includes(u.id)));
      } else if (action === 'suspend' || action === 'unsuspend') {
        const status = action === 'suspend' ? 'suspended' : 'active';
        setUsers(prev => prev.map(u => okIds.includes(u.id) ? { ...u, status } : u));
      }

      const total = ids.length;
      const summary = res.failed > 0
        ? `${res.succeeded} of ${total} updated · ${res.failed} failed`
        : `${res.succeeded} user(s) updated.`;
      showToast({ type: res.failed > 0 ? 'error' : 'success', message: summary });

      if (res.failed > 0) {
        const nameOf = (id: string) => users.find(u => u.id === id)?.full_name ?? id.slice(0, 8);
        setBulkResult({
          succeeded: res.succeeded,
          failed: res.failed,
          message: (res.errors ?? []).map(e => `${nameOf(e.user_id)}: ${e.message}`).join('\n')
            || 'Some users could not be updated.',
        });
        // Retryable set = only what failed.
        setBulkSelected(new Set(failedIds));
      } else {
        clearBulk();
      }
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, `bulk.${action}`) });
    } finally {
      setBulkRunning(null);
    }
  };

  /**
   * Entry point from the overflow menu. Destructive / security-sensitive
   * operations are confirmed first, with the exact count and consequence.
   */
  const handleBulkAction = (action: BulkUserAction) => {
    const ids = [...bulkSelected];
    if (!ids.length) return;
    setBulkMenuVisible(false);

    const copy: Record<BulkUserAction, { title: string; message: string; label: string; danger?: boolean }> = {
      suspend: {
        title: `Suspend ${ids.length} user(s)?`,
        message: 'They will be signed out of every device and will not be able to sign in until unsuspended. Super admin accounts are refused by the server.',
        label: 'Suspend', danger: true,
      },
      unsuspend: {
        title: `Unsuspend ${ids.length} user(s)?`,
        message: 'Sign-in is restored. Existing security policies remain enforced.',
        label: 'Unsuspend',
      },
      reset_devices: {
        title: `Reset devices for ${ids.length} user(s)?`,
        message: 'Every registered device and live session is revoked. They must sign in again.',
        label: 'Reset devices', danger: true,
      },
      reset_password: {
        title: `Send reset links to ${ids.length} user(s)?`,
        message: 'Each user receives their own single-use link by email (valid 30 minutes). No password is set or shared, and accounts with no email address are reported as failed.',
        label: 'Send links',
      },
      trash: {
        title: `Move ${ids.length} user(s) to trash?`,
        message: 'They lose access immediately and are restorable for 30 days.',
        label: 'Move to trash', danger: true,
      },
    };
    const c0 = copy[action];
    setConfirm({
      title: c0.title,
      message: c0.message,
      confirmLabel: c0.label,
      destructive: c0.danger,
      onConfirm: async () => {
        setConfirm(null);
        await runBulk(action, ids);
      },
    });
  };

  // ── Action handler ─────────────────────────────────────────────────────

  const openMenu = (user: any) => { setSelectedUser(user); setMenuVisible(true); };

  // Cross-platform confirm (ConfirmDialog works on iOS/Android/Web —
  // Alert.alert is a silent no-op on web). Suspend family only; other
  // actions keep their existing flows.
  const [confirm, setConfirm] = useState<ConfirmDialogRequest | null>(null);

  const handleAction = async (key: ActionKey) => {
    if (!selectedUser) return;
    const id = selectedUser.id;

    if (key === 'unsuspend' || key === 'unblock') {
      setMenuVisible(false);
      const name = selectedUser?.full_name ?? 'User';
      setConfirm({
        title: key === 'unsuspend' ? 'Unsuspend user?' : 'Unblock user?',
        message: `${name} will be restored to active status and can sign in again. Existing security policies stay fully enforced.`,
        confirmLabel: key === 'unsuspend' ? 'Unsuspend' : 'Unblock',
        onConfirm: async () => {
          const ok = await run(key, async () => {
            try {
              // Server-authoritative: send status='active' (the same RPC the
              // backend audits); update local state ONLY on success.
              await updateUserStatus(id, 'active');
              setUsers(p => p.map(u => u.id === id ? { ...u, status: 'active' } : u));
              setSelectedUser((p: any) => p ? { ...p, status: 'active' } : null);
              showToast({ type: 'success', message: key === 'unsuspend' ? 'User unsuspended.' : 'User unblocked.' });
              return true;
            } catch (e) {
              // Failure → user stays suspended in the UI (no optimistic flip).
              showToast({ type: 'error', message: logAndParse(e, key) });
              return false;
            }
          });
          setConfirm(null);
          if (ok) setMenuVisible(false);
        },
      });
      return;
    }
    if (key === 'suspend' || key === 'block') {
      setMenuVisible(false);
      const name = selectedUser?.full_name ?? 'User';
      setConfirm({
        title: key === 'suspend' ? 'Suspend user?' : 'Block user?',
        message: `${name} will be ${key === 'suspend' ? 'suspended' : 'blocked'} immediately and signed out of all devices.`,
        confirmLabel: key === 'suspend' ? 'Suspend' : 'Block',
        destructive: true,
        onConfirm: async () => {
          const ok = await run(key, async () => {
            try {
              await updateUserStatus(id, 'suspended');
              setUsers(p => p.map(u => u.id === id ? { ...u, status: 'suspended' } : u));
              setSelectedUser((p: any) => p ? { ...p, status: 'suspended' } : null);
              showToast({ type: 'success', message: key === 'suspend' ? 'User suspended.' : 'User blocked.' });
              return true;
            } catch (e) {
              showToast({ type: 'error', message: logAndParse(e, key) });
              return false;
            }
          });
          setConfirm(null);
          if (ok) setMenuVisible(false);
        },
      });
      return;
    }

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
    if (key === 'audit')    { setMenuVisible(false); router.push(`/(app)/user-activity?user_id=${id}&user_name=${encodeURIComponent(selectedUser?.full_name ?? 'User')}` as RelativePathString); return; }

    const actionMap: Partial<Record<ActionKey, () => Promise<void>>> = {
      // Suspend family — the optimistic local update uses the SAME status the
      // backend actually persisted (updateUserStatus → set_user_status →
      // POST /admin/users/{id}/status), so UI and server can never drift.
      // blockUser()/unblockUser() send 'suspended'/'active' but their names
      // historically mislabel the local state as 'blocked' — that mismatch is
      // what made suspended users show "Block" again after refresh.
      suspend:            async () => { await updateUserStatus(id, 'suspended'); setUsers(p => p.map(u => u.id === id ? { ...u, status: 'suspended' } : u)); showToast({ type: 'success', message: 'User suspended.' }); },
      unsuspend:          async () => { await updateUserStatus(id, 'active');    setUsers(p => p.map(u => u.id === id ? { ...u, status: 'active' } : u)); showToast({ type: 'success', message: 'User unsuspended.' }); },
      block:              async () => { await updateUserStatus(id, 'suspended'); setUsers(p => p.map(u => u.id === id ? { ...u, status: 'suspended' } : u)); showToast({ type: 'success', message: 'User blocked.' }); },
      unblock:            async () => { await updateUserStatus(id, 'active');    setUsers(p => p.map(u => u.id === id ? { ...u, status: 'active' } : u)); showToast({ type: 'success', message: 'User unblocked.' }); },
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

  // ── Selection scope ──────────────────────────────────────────────────────
  // The list is fetched once and filtered/paginated in memory, so the two
  // honest scopes are: the rows on THIS page, and the whole current RESULT SET
  // (role tab + search applied). Both are labelled with their count — nothing
  // claims to span server pages that are not loaded.
  const pageIds = paginated.map(u => u.id);
  const pageAllSelected = pageIds.length > 0 && pageIds.every(id => bulkSelected.has(id));
  const resultAllSelected = filtered.length > 0 && filtered.every(u => bulkSelected.has(u.id));

  const togglePageSelection = () => {
    setBulkSelected(prev => {
      const s = new Set(prev);
      if (pageAllSelected) pageIds.forEach(id => s.delete(id));
      else pageIds.forEach(id => s.add(id));
      return s;
    });
  };

  // Adds/removes ONLY the ids in the current result set. A blanket reset would
  // silently drop users selected under another role tab or search.
  const toggleResultSelection = () => {
    setBulkSelected(prev => {
      const s = new Set(prev);
      if (resultAllSelected) filtered.forEach(u => s.delete(u.id));
      else filtered.forEach(u => s.add(u.id));
      return s;
    });
  };

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
      <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
      >
          {/* PageHeader sits OUTSIDE the inner padding view so it can own its own horizontal padding */}
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

        <View style={{ paddingHorizontal: layout.screenPx }}>

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
          <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
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
            <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45), marginBottom: 12, marginLeft: 2 }}>
              {filtered.length} {activeTab === 'all' ? 'users' : activeTab + 's'} total
            </Text>
          )}

          {/* Selection controls — scope is explicit, count is visible */}
          {bulkMode && !loading && (
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
              <Pressable
                onPress={togglePageSelection}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: pageAllSelected }}
                accessibilityLabel={pageAllSelected ? 'Deselect this page' : `Select all ${pageIds.length} users on this page`}
                style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 }]}
              >
                {pageAllSelected
                  ? <CheckSquare size={16} color={c.primary} />
                  : <Square size={16} color={`${c.text}70`} />}
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }}>
                  {pageAllSelected ? 'Page selected' : `Select page (${pageIds.length})`}
                </Text>
              </Pressable>
              {filtered.length > pageIds.length && (
                <Pressable
                  onPress={toggleResultSelection}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: resultAllSelected }}
                  accessibilityLabel={resultAllSelected ? 'Clear selection' : `Select all ${filtered.length} matching users`}
                  style={{ paddingHorizontal: 10, paddingVertical: 8 }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>
                    {resultAllSelected ? 'Clear all' : `Select all ${filtered.length} matching`}
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {/* User list */}
          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
          ) : paginated.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <Users size={48} color={c.primary} style={{ opacity: 0.2 } as any} />
              <Text style={{ ...mutedTextStyle(c, 0.4), fontSize: 16, marginTop: 12 }}>No users found</Text>
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
                    <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5), marginLeft: 3 }} numberOfLines={1}>
                      {getPublicEmail(user) ?? displayPhoneNational(user.phone_e164 ?? user.phone) ?? '—'}
                    </Text>
                  </View>
                  {(user.phone_e164 ?? user.phone) && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 1 }}>
                      <Phone size={11} color={c.text} style={{ opacity: 0.4 } as any} />
                      <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5), marginLeft: 3 }}>
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
                          <Text style={{ fontSize: 9, ...mutedTextStyle(c, 0.38), fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}>
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
                  accessibilityRole={bulkMode ? 'checkbox' : 'button'}
                  accessibilityState={bulkMode ? { checked: bulkSelected.has(user.id) } : undefined}
                  accessibilityLabel={bulkMode
                    ? `${bulkSelected.has(user.id) ? 'Deselect' : 'Select'} ${user.full_name}`
                    : `Actions for ${user.full_name}`}
                  hitSlop={6}
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
              <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6) }}>
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

      {/* Bulk selection bar — count + overflow menu (one menu, every action) */}
      {bulkMode && (
        <View style={{
          backgroundColor: c.base,
          borderTopWidth: 1,
          borderTopColor: `${c.text}12`,
          shadowColor: c.shadowDark,
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.5,
          shadowRadius: 12,
          elevation: 10,
          paddingHorizontal: 16,
          paddingVertical: 10,
          paddingBottom: safeBottom(layout.insets.bottom) + 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
            <View style={{ backgroundColor: `${c.primary}20`, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.primary }}>
                {bulkSelected.size} selected
              </Text>
            </View>
            {bulkRunning && <ActivityIndicator size="small" color={c.primary} />}
          </View>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => bulkSelected.size > 0 && !bulkRunning && setBulkMenuVisible(true)}
            disabled={!bulkSelected.size || !!bulkRunning}
            accessibilityRole="button"
            accessibilityLabel="Bulk actions"
            accessibilityHint="Open the list of actions for the selected users"
            accessibilityState={{ disabled: !bulkSelected.size || !!bulkRunning }}
            hitSlop={8}
            style={{
              width: 38, height: 38, borderRadius: 10,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: `${c.primary}${bulkSelected.size ? '1F' : '0A'}`,
              opacity: bulkSelected.size ? 1 : 0.5,
            }}
          >
            <MoreVertical size={19} color={c.primary} />
          </Pressable>
          <Pressable
            onPress={clearBulk}
            accessibilityRole="button"
            accessibilityLabel="Exit selection"
            hitSlop={8}
            style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: `${c.text}0F` }}
          >
            <X size={17} color={`${c.text}90`} />
          </Pressable>
        </View>
      )}

      <BulkUserMenu
        visible={bulkMenuVisible}
        onClose={() => setBulkMenuVisible(false)}
        count={bulkSelected.size}
        running={bulkRunning}
        onAction={handleBulkAction}
      />

      {/* Partial-success report — every refused user is named, never skipped */}
      <ResponsiveModal
        visible={!!bulkResult}
        onClose={() => setBulkResult(null)}
        title={bulkResult && bulkResult.failed > 0 ? 'Bulk action finished with errors' : 'Bulk action finished'}
        subtitle={bulkResult ? `${bulkResult.succeeded} succeeded · ${bulkResult.failed} failed` : undefined}
      >
        <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
          <Text style={{ fontSize: 13, color: `${c.text}CC`, lineHeight: 20 }}>
            {bulkResult?.message}
          </Text>
          <Text style={{ fontSize: 12, color: `${c.text}77`, marginTop: 12 }}>
            The failed users remain selected so you can retry them.
          </Text>
        </ScrollView>
      </ResponsiveModal>

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

      {/* Suspend / Unsuspend confirmation (cross-platform) */}
      <ConfirmDialog
        visible={!!confirm}
        request={confirm}
        onClose={() => setConfirm(null)}
      />

      {/* Login history */}
      <ResponsiveModal
        visible={loginHistoryModal}
        onClose={() => setLoginHistoryModal(false)}
        title="Login History"
        subtitle={selectedUser?.full_name}
      >
        {historyLoading ? <ActivityIndicator color={c.primary} style={{ marginVertical: 30 }} /> : (
          <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
            {loginHistory.length === 0
              ? <Text style={{ ...mutedTextStyle(c, 0.4), textAlign: 'center', padding: 30 }}>No login history found.</Text>
              : loginHistory.map((h, i) => (
                <NeuCard key={h.id ?? i} style={{ marginBottom: 8, padding: 12 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: h.success ? '#16A34A' : '#DC2626' }}>
                        {h.success ? '✓ Success' : '✗ Failed'}
                      </Text>
                      {h.device_name && <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.6) }}>{h.device_name} · {h.platform}</Text>}
                      {h.ip_address && <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4) }}>{h.ip_address}</Text>}
                    </View>
                    <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4) }}>
                      {h.created_at ? new Date(h.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
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
