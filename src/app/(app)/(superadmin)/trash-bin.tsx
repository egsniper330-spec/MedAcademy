/**
 * Trash Bin — Super Admin
 * Soft-deleted accounts with restore, permanent delete, retention config, and CSV export.
 */
import { useCallback, useState, useRef, useMemo, memo } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  RefreshControl, ActivityIndicator, TextInput, FlatList,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Trash2, RotateCcw, X, Search, Settings,
  Clock, Users, ChevronDown, AlertTriangle, Download,
  Stethoscope, UserCog, GraduationCap, ShieldAlert, Zap,
  CheckCircle, XCircle, Filter,
} from 'lucide-react-native';
import {
  getTrashList, getTrashStats, getTrashConfig, saveTrashConfig,
  restoreUser, runTrashCleanup, bulkUserOps,
  type TrashItem, type TrashStats, type TrashConfig,
} from '@/lib/api';
import { backendClient } from '@/client/backendClient';
import { DeleteAccountModal } from '@/components/DeleteAccountModal';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, neuFlatStyle, safeBottom } from '@/lib/neu';
import { logAndParse } from '@/lib/parseError';
import { exportCSV } from '@/lib/exportUtils';

const PAGE_SIZE = 20;

const ROLE_FILTERS = [
  { label: 'All',         value: '',            icon: Users },
  { label: 'Students',    value: 'student',     icon: GraduationCap },
  { label: 'Doctors',     value: 'doctor',      icon: Stethoscope },
  { label: 'Admins',      value: 'admin',       icon: UserCog },
  { label: 'Super Admin', value: 'super_admin', icon: ShieldAlert },
];

const RETENTION_OPTIONS = [
  { label: '7 Days',  value: 7 },
  { label: '15 Days', value: 15 },
  { label: '30 Days', value: 30 },
  { label: '60 Days', value: 60 },
  { label: '90 Days', value: 90 },
];

const ROLE_COLOR: Record<string, string> = {
  student: '#6366F1', doctor: '#0EA5E9', admin: '#F59E0B', super_admin: '#EF4444',
};

function daysLabel(days: number) {
  if (days <= 0) return 'Expired';
  if (days === 1) return '1 day left';
  return `${days} days left`;
}

// ─── Memoized row component ───────────────────────────────────────────────────
type RowProps = {
  item: TrashItem;
  isDark: boolean;
  isChecked: boolean;
  isRestoring: boolean;
  onToggle: (id: string) => void;
  onRestore: (id: string, name: string) => void;
  onDelete: (id: string) => void;
};

const TrashItemRow = memo(function TrashItemRow({
  item, isDark, isChecked, isRestoring, onToggle, onRestore, onDelete,
}: RowProps) {
  const c    = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const rc   = ROLE_COLOR[item.role] ?? c.primary;
  const isExpired      = item.days_remaining <= 0;
  const isExpiringSoon = item.days_remaining <= 3 && !isExpired;

  return (
    <Pressable onPress={() => onToggle(item.id)}>
      <NeuCard style={{ marginBottom: 10, padding: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {/* Checkbox */}
          <Pressable
            onPress={() => onToggle(item.id)}
            style={[flat, { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center' }]}
          >
            {isChecked
              ? <CheckCircle size={18} color={c.primary} />
              : <View style={{ width: 14, height: 14, borderRadius: 3, borderWidth: 2, borderColor: `${c.text}30` }} />
            }
          </Pressable>

          {/* Avatar initial */}
          <View style={[flat, { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={{ fontSize: 15, fontWeight: '800', color: rc }}>
              {item.full_name?.[0]?.toUpperCase() ?? '?'}
            </Text>
          </View>

          {/* Info */}
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{item.full_name}</Text>
              <View style={{ backgroundColor: `${rc}20`, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: rc, textTransform: 'capitalize' }}>{item.role}</Text>
              </View>
            </View>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 1 }}>{item.email}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <Clock size={11} color={isExpired ? '#EF4444' : isExpiringSoon ? '#D97706' : c.text} />
              <Text style={{ fontSize: 11, color: isExpired ? '#EF4444' : isExpiringSoon ? '#D97706' : c.text, opacity: isExpired || isExpiringSoon ? 1 : 0.45 }}>
                {daysLabel(item.days_remaining)}
              </Text>
              {item.trash_reason ? (
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.35 }} numberOfLines={1}>· {item.trash_reason}</Text>
              ) : null}
            </View>
          </View>

          {/* Actions */}
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <Pressable
              onPress={() => onRestore(item.id, item.full_name)}
              disabled={isRestoring}
              style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}
            >
              {isRestoring
                ? <ActivityIndicator size="small" color="#16A34A" />
                : <RotateCcw size={16} color="#16A34A" />
              }
            </Pressable>
            <Pressable
              onPress={() => onDelete(item.id)}
              style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: '#EF444418', alignItems: 'center', justifyContent: 'center' }}
            >
              <X size={16} color="#EF4444" />
            </Pressable>
          </View>
        </View>
      </NeuCard>
    </Pressable>
  );
});

export default function TrashBin() {
  const scheme = useColorScheme();
  const layout = useLayout();
  const insets = layout.insets;
  const isDark = scheme === 'dark';
  const c    = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const { showToast } = useToast();

  const [items,           setItems]           = useState<TrashItem[]>([]);
  const [stats,           setStats]           = useState<TrashStats | null>(null);
  const [config,          setConfig]          = useState<TrashConfig | null>(null);
  const [total,           setTotal]           = useState(0);
  const [loading,         setLoading]         = useState(true);
  const [loadError,       setLoadError]       = useState<string | null>(null);
  const [refreshing,      setRefreshing]      = useState(false);
  const [loadingMore,     setLoadingMore]     = useState(false);
  const [hasMore,         setHasMore]         = useState(true);
  const [roleFilter,      setRoleFilter]      = useState('');
  const [query,           setQuery]           = useState('');
  const [configOpen,      setConfigOpen]      = useState(false);
  const [selectedRetention, setSelectedRetention] = useState(30);
  const [savingConfig,    setSavingConfig]    = useState(false);
  const [cleanupLoading,  setCleanupLoading]  = useState(false);
  const [selected,           setSelected]           = useState<Set<string>>(new Set());
  const [bulkRestoreLoading, setBulkRestoreLoading] = useState(false);
  const [bulkDeleteLoading,  setBulkDeleteLoading]  = useState(false);
  const [deleteTarget,    setDeleteTarget]    = useState<string | null>(null);
  const [restoringId,     setRestoringId]     = useState<string | null>(null);
  const [currentActorId,  setCurrentActorId]  = useState<string>('');

  // Guards against concurrent pagination requests
  const fetchingMore = useRef(false);
  // Track offset separately from items.length so filtering + search don't affect pagination
  const offsetRef = useRef(0);

  // ── Initial / refresh load ─────────────────────────────────────────────────
  const loadFirst = useCallback(async (role: string) => {
    offsetRef.current = 0;
    setLoadError(null);
    try {
      const [list, s, cfg, { data: { user } }] = await Promise.all([
        getTrashList({ role: role || undefined, limit: PAGE_SIZE, offset: 0 }),
        getTrashStats().catch((e: any) => { console.warn('trashStats failed:', e); return null; }),
        getTrashConfig().catch((e: any) => { console.warn('trashConfig failed:', e); return null; }),
        backendClient.auth.getUser().catch(() => ({ data: { user: null } })),
      ]);
      const fetched = list.items ?? [];
      setItems(fetched);
      setTotal(list.total ?? 0);
      setHasMore(fetched.length === PAGE_SIZE);
      offsetRef.current = fetched.length;
      setStats(s);
      setConfig(cfg);
      if (cfg) setSelectedRetention(cfg.custom_days ?? cfg.retention_days);
      if (user) setCurrentActorId(user.id);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.error('Trash Bin load failed:', msg);
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    setItems([]);
    setHasMore(true);
    loadFirst(roleFilter);
  }, [loadFirst, roleFilter]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setItems([]);
    setHasMore(true);
    await loadFirst(roleFilter);
    setRefreshing(false);
  }, [loadFirst, roleFilter]);

  // ── Pagination: load next page ─────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (fetchingMore.current || !hasMore || loadingMore) return;
    fetchingMore.current = true;
    setLoadingMore(true);
    try {
      const list = await getTrashList({
        role: roleFilter || undefined,
        limit: PAGE_SIZE,
        offset: offsetRef.current,
      });
      const fetched = list.items ?? [];
      if (fetched.length === 0) {
        setHasMore(false);
      } else {
        setItems(prev => {
          // Deduplicate by id to guard against any duplicate-key issues
          const existingIds = new Set(prev.map(i => i.id));
          const fresh = fetched.filter(i => !existingIds.has(i.id));
          return [...prev, ...fresh];
        });
        offsetRef.current += fetched.length;
        setHasMore(fetched.length === PAGE_SIZE);
      }
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, 'trash.loadMore') });
    } finally {
      fetchingMore.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, roleFilter, showToast]);

  // ── Role filter change → reset + reload ───────────────────────────────────
  const handleRoleFilter = useCallback((role: string) => {
    setRoleFilter(role);
    setSelected(new Set());
    // useFocusEffect dependency on roleFilter will trigger reload
  }, []);

  // ── Client-side search filter (memoized) ──────────────────────────────────
  const filtered = useMemo(() => {
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter(i =>
      i.full_name?.toLowerCase().includes(q) || i.email?.toLowerCase().includes(q)
    );
  }, [items, query]);

  // ── Selection handlers ────────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(i => i.id)));
  }, [filtered]);

  // ── Action handlers ───────────────────────────────────────────────────────
  const handleRestore = useCallback(async (id: string, name: string) => {
    setRestoringId(id);
    try {
      await restoreUser(id);
      setItems(prev => prev.filter(i => i.id !== id));
      setTotal(p => p - 1);
      showToast({ type: 'success', message: `${name} restored successfully.` });
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, 'trash.restore') });
    } finally {
      setRestoringId(null);
    }
  }, [showToast]);

  const handleDeleteTarget = useCallback((id: string) => setDeleteTarget(id), []);

  const handleBulkRestore = useCallback(async () => {
    if (!selected.size || bulkRestoreLoading) return;
    setBulkRestoreLoading(true);
    try {
      const res = await bulkUserOps('restore', [...selected]);
      setItems(prev => prev.filter(i => !selected.has(i.id)));
      setTotal(p => p - res.succeeded);
      setSelected(new Set());
      showToast({ type: 'success', message: `Restored ${res.succeeded} account(s).` });
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, 'trash.bulk_restore') });
    } finally {
      setBulkRestoreLoading(false);
    }
  }, [selected, bulkRestoreLoading, showToast]);

  const handleBulkPermanentDelete = useCallback(async () => {
    if (!selected.size || bulkDeleteLoading) return;
    setBulkDeleteLoading(true);
    try {
      const res = await bulkUserOps('permanent_delete', [...selected]);
      // Only remove items that were actually deleted
      if (res.succeeded > 0) {
        const succeededIds = new Set(
          res.errors.length > 0
            ? [...selected].filter(id => !res.errors.some(e => e.user_id === id))
            : [...selected]
        );
        setItems(prev => prev.filter(i => !succeededIds.has(i.id)));
        setTotal(p => p - res.succeeded);
        setSelected(new Set());
      }
      if (res.failed > 0) {
        const firstErr = res.errors[0]?.message ?? 'Some deletions failed';
        showToast({ type: 'error', message: `${res.failed} failed: ${firstErr}` });
      }
      if (res.succeeded > 0) {
        showToast({ type: 'success', message: `Permanently deleted ${res.succeeded} account(s).` });
      }
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, 'trash.bulk_delete') });
    } finally {
      setBulkDeleteLoading(false);
    }
  }, [selected, bulkDeleteLoading, showToast]);

  const handleCleanup = useCallback(async () => {
    setCleanupLoading(true);
    try {
      const res = await runTrashCleanup();
      showToast({ type: 'success', message: `Cleanup complete: ${res.deleted} deleted, ${res.failed} failed.` });
      setItems([]);
      setHasMore(true);
      await loadFirst(roleFilter);
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, 'trash.cleanup') });
    } finally {
      setCleanupLoading(false);
    }
  }, [loadFirst, roleFilter, showToast]);

  const handleSaveConfig = useCallback(async () => {
    setSavingConfig(true);
    try {
      const isCustom = !RETENTION_OPTIONS.some(o => o.value === selectedRetention);
      await saveTrashConfig(
        isCustom ? 30 : selectedRetention,
        isCustom ? selectedRetention : undefined,
      );
      showToast({ type: 'success', message: 'Retention period updated.' });
      setConfigOpen(false);
      await loadFirst(roleFilter);
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, 'trash.config') });
    } finally {
      setSavingConfig(false);
    }
  }, [loadFirst, roleFilter, selectedRetention, showToast]);

  const handleExport = useCallback(() => {
    const rows = filtered.map(i => ({
      name:       i.full_name,
      email:      i.email,
      role:       i.role,
      trashed_at: i.trashed_at ? new Date(i.trashed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
      expires_at: i.trash_expires_at ? new Date(i.trash_expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
      reason:     i.trash_reason ?? '',
      trashed_by: i.trashed_by_name ?? '',
    }));
    exportCSV(rows, ['name','email','role','trashed_at','expires_at','reason','trashed_by'], 'trash-bin-export');
    showToast({ type: 'success', message: `Exported ${filtered.length} records to CSV.` });
  }, [filtered, showToast]);

  // ── Stable renderItem (memoized, deps: isDark only — row re-render gated by React.memo + extraData) ─
  const renderItem = useCallback(({ item }: { item: TrashItem }) => (
    <TrashItemRow
      item={item}
      isDark={isDark}
      isChecked={selected.has(item.id)}
      isRestoring={restoringId === item.id}
      onToggle={toggleSelect}
      onRestore={handleRestore}
      onDelete={handleDeleteTarget}
    />
  ), [isDark, selected, restoringId, toggleSelect, handleRestore, handleDeleteTarget]);

  // extraData: FlatList re-renders rows only when this changes
  const extraData = useMemo(() => ({ selected, restoringId }), [selected, restoringId]);

  // ── ListHeaderComponent (all UI above the list) ───────────────────────────
  const ListHeader = useMemo(() => (
    <View style={{ padding: layout.screenPx, paddingBottom: 0 }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4, marginTop: 8, gap: 10 }}>
        <Trash2 size={22} color="#EF4444" />
        <Text style={{ fontSize: 24, fontWeight: '800', color: c.text, flex: 1 }}>Trash Bin</Text>
        <Pressable onPress={() => setConfigOpen(o => !o)} style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${c.primary}15`, alignItems: 'center', justifyContent: 'center' }}>
          <Settings size={18} color={c.primary} />
        </Pressable>
      </View>
      <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginBottom: 20 }}>
        Accounts pending permanent deletion — retention: {config?.custom_days ?? config?.retention_days ?? 30} days
      </Text>

      {/* Retention Config Panel */}
      {configOpen && (
        <NeuCard style={{ padding: 18, marginBottom: 16 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 12 }}>Retention Period</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            {RETENTION_OPTIONS.map(opt => (
              <Pressable key={opt.value} onPress={() => setSelectedRetention(opt.value)}
                style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
                  backgroundColor: selectedRetention === opt.value ? `${c.primary}22` : `${c.text}0A`,
                  borderWidth: 1.5, borderColor: selectedRetention === opt.value ? c.primary : 'transparent' }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: selectedRetention === opt.value ? c.primary : c.text }}>{opt.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <NeuButton label="Save" onPress={handleSaveConfig} loading={savingConfig} style={{ flex: 1 }} />
            <NeuButton label="Cancel" onPress={() => setConfigOpen(false)} variant="secondary" style={{ flex: 1 }} />
          </View>
        </NeuCard>
      )}

      {/* Stats tiles */}
      {stats && (
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'In Trash',      value: stats.total_trashed,  color: '#EF4444' },
            { label: 'Expiring Soon', value: stats.expiring_soon,  color: '#D97706' },
            { label: 'Expired',       value: stats.expired,        color: '#6B7280' },
          ].map(s => (
            <NeuCard key={s.label} style={{ flex: 1, alignItems: 'center', padding: 14 }}>
              <Text style={{ fontSize: 24, fontWeight: '900', color: s.color }}>{s.value}</Text>
              <Text style={{ fontSize: 10, color: c.text, opacity: 0.5, textAlign: 'center', marginTop: 4 }}>{s.label}</Text>
            </NeuCard>
          ))}
        </View>
      )}

      {/* Role filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {ROLE_FILTERS.map(f => {
            const active = roleFilter === f.value;
            const Icon = f.icon;
            return (
              <Pressable key={f.value} onPress={() => handleRoleFilter(f.value)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10,
                  backgroundColor: active ? `${c.primary}20` : `${c.text}0A`,
                  borderWidth: 1.5, borderColor: active ? c.primary : 'transparent' }}>
                <Icon size={13} color={active ? c.primary : `${c.text}70`} />
                <Text style={{ fontSize: 12, fontWeight: '600', color: active ? c.primary : `${c.text}80` }}>{f.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      {/* Search bar */}
      <NeuCard style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, marginBottom: 14, minWidth: 0 }}>
        <Search size={16} color={`${c.text}60`} style={{ flexShrink: 0 }} />
        <TextInput
          value={query} onChangeText={setQuery}
          placeholder="Search name or email…"
          placeholderTextColor={`${c.text}50`}
          style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }}
        />
        {query ? <Pressable onPress={() => setQuery('')}><X size={14} color={`${c.text}50`} /></Pressable> : null}
      </NeuCard>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <NeuCard style={{ padding: 14, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text style={{ flex: 1, fontSize: 13, fontWeight: '700', color: c.text }}>{selected.size} selected</Text>
          <NeuButton
            label="Restore"
            onPress={handleBulkRestore}
            loading={bulkRestoreLoading}
            disabled={bulkRestoreLoading || bulkDeleteLoading}
            variant="secondary"
            style={{ paddingHorizontal: 12 }}
          />
          <NeuButton
            label="Delete Forever"
            onPress={handleBulkPermanentDelete}
            loading={bulkDeleteLoading}
            disabled={bulkDeleteLoading || bulkRestoreLoading}
            variant="danger"
            style={{ paddingHorizontal: 12 }}
          />
          <Pressable onPress={() => setSelected(new Set())}
            hitSlop={6} style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: `${c.text}10`, alignItems: 'center', justifyContent: 'center' }}>
            <X size={14} color={c.text} />
          </Pressable>
        </NeuCard>
      )}

      {/* Select all + count */}
      {filtered.length > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <Pressable onPress={toggleSelectAll} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={[flat, { width: 20, height: 20, borderRadius: 5, alignItems: 'center', justifyContent: 'center' }]}>
              {selected.size === filtered.length && filtered.length > 0
                ? <CheckCircle size={16} color={c.primary} />
                : <View style={{ width: 12, height: 12, borderRadius: 3, borderWidth: 2, borderColor: `${c.text}30` }} />
              }
            </View>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Select All</Text>
          </Pressable>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.4 }}>{filtered.length} of {total}</Text>
        </View>
      )}
    </View>
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [c, flat, config, configOpen, selectedRetention, savingConfig, stats, roleFilter, query, selected, filtered.length, total, bulkRestoreLoading, bulkDeleteLoading, handleSaveConfig, handleRoleFilter, handleBulkRestore, handleBulkPermanentDelete, toggleSelectAll]);

  // ── ListFooterComponent ───────────────────────────────────────────────────
  const ListFooter = useMemo(() => (
    <View style={{ paddingHorizontal: layout.screenPx, paddingBottom: 20 }}>
      {loadingMore && (
        <View style={{ paddingVertical: 16, alignItems: 'center' }}>
          <ActivityIndicator color={c.primary} />
        </View>
      )}
      {!hasMore && items.length > 0 && (
        <View style={{ paddingVertical: 14, alignItems: 'center' }}>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.35 }}>No more deleted accounts.</Text>
        </View>
      )}
      {/* Footer actions */}
      <View style={{ gap: 10, marginTop: 16 }}>
        <NeuButton
          label={cleanupLoading ? 'Running Cleanup…' : 'Run Cleanup Now'}
          onPress={handleCleanup}
          loading={cleanupLoading}
          variant="secondary"
          fullWidth
          icon={<Zap size={15} color={c.primary} />}
        />
        <NeuButton
          label={`Export CSV (${filtered.length})`}
          onPress={handleExport}
          variant="secondary"
          fullWidth
          icon={<Download size={15} color={c.primary} />}
        />
      </View>
    </View>
  ), [c, loadingMore, hasMore, items.length, cleanupLoading, filtered.length, handleCleanup, handleExport]);

  // ── Error state ────────────────────────────────────────────────────────────
  const ListError = useMemo(() => (
    loadError ? (
      <View style={{ paddingHorizontal: layout.screenPx }}>
        <NeuCard style={{ padding: 32, alignItems: 'center' }}>
          <AlertTriangle size={32} color="#EF4444" />
          <Text style={{ fontSize: 14, color: '#EF4444', marginTop: 12, fontWeight: '600' }}>Failed to load Trash Bin</Text>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 6, textAlign: 'center' }}>{loadError}</Text>
        </NeuCard>
      </View>
    ) : null
  ), [loadError, c, layout.screenPx]);

  // ── Empty state ───────────────────────────────────────────────────────────
  const ListEmpty = useMemo(() => (
    loading || loadError ? null : (
      <View style={{ paddingHorizontal: layout.screenPx }}>
        <NeuCard style={{ padding: 32, alignItems: 'center' }}>
          <Trash2 size={32} color={`${c.text}30`} />
          <Text style={{ fontSize: 14, color: c.text, opacity: 0.4, marginTop: 12 }}>Trash bin is empty</Text>
        </NeuCard>
      </View>
    )
  ), [loading, loadError, c, layout.screenPx]);

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color={c.primary} size="large" />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={i => i.id}
          renderItem={renderItem}
          extraData={extraData}
          contentContainerStyle={{ paddingHorizontal: layout.screenPx, paddingBottom: layout.scrollBottom() }}
          // Pagination
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          // Header + Footer + Empty
          ListHeaderComponent={ListHeader}
          ListFooterComponent={ListFooter}
          ListEmptyComponent={loadError ? ListError : ListEmpty}
          // Pull-to-refresh
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />
          }
          // Performance
          removeClippedSubviews
          windowSize={10}
          maxToRenderPerBatch={10}
          initialNumToRender={10}
          updateCellsBatchingPeriod={30}
        />
      )}

      {/* Permanent delete modal */}
      <DeleteAccountModal
        userId={deleteTarget}
        visible={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(id) => {
          setItems(prev => prev.filter(i => i.id !== id));
          setTotal(p => p - 1);
          setDeleteTarget(null);
          showToast({ type: 'success', message: 'Account permanently deleted.' });
        }}
      />
    </View>
  );
}

