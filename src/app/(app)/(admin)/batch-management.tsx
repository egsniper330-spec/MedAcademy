/**
 * Batch Management — list all activation code batches, view codes per batch,
 * disable/enable/clone/soft-delete batch operations.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, FlatList, Pressable, ActivityIndicator,
  RefreshControl, useColorScheme, ScrollView,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { PageHeader } from '@/components/PageHeader';
import {
  Ticket, CheckCircle, XCircle, Clock, Copy, Trash2,
  ChevronRight, ChevronDown, AlertCircle, Hash, BookOpen,
  Shield, ToggleLeft, ToggleRight,
} from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors } from '@/lib/neu';
import { getCodeBatches, getActivationLedger, invokeEdgeFunction } from '@/lib/api';

type Batch = {
  id: string; label: string | null; course_id: string; created_by: string;
  total_count: number; used_count: number; expired_count: number; disabled_count: number;
  expires_at: string | null; notes: string | null; created_at: string;
  course?: { title: string };
  creator?: { full_name: string; role: string };
};
type CodeRow = {
  id: string; code: string; status: string; created_at: string;
  used_by_name: string | null; used_at: string | null; expires_at: string | null;
  notes: string | null;
};

function statusColor(s: string) {
  if (s === 'used')     return '#16A34A';
  if (s === 'active')   return '#2DA8FF';
  if (s === 'expired')  return '#D97706';
  if (s === 'disabled') return '#DC2626';
  return '#6B7280';
}

function fmt(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function BatchManagementScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { showToast } = useToast();

  const [batches, setBatches]     = useState<Batch[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [batchCodes, setBatchCodes] = useState<Record<string, CodeRow[]>>({});
  const [loadingCodes, setLoadingCodes] = useState<string | null>(null);

  const [confirmModal, setConfirmModal] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: string; batchId: string; label: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try { setBatches(await getCodeBatches() as Batch[]); } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const toggleExpand = async (batchId: string) => {
    if (expandedId === batchId) { setExpandedId(null); return; }
    setExpandedId(batchId);
    if (!batchCodes[batchId]) {
      setLoadingCodes(batchId);
      try {
        const codes = await getActivationLedger({ batchId, limit: 200 });
        setBatchCodes(prev => ({ ...prev, [batchId]: codes as CodeRow[] }));
      } catch (_) {}
      setLoadingCodes(null);
    }
  };

  const doAction = async () => {
    if (!confirmAction) return;
    setSubmitting(true);
    try {
      const { type, batchId } = confirmAction;
      const actionMap: Record<string, string> = {
        disable: 'disable_batch', enable: 'enable_batch',
        delete: 'soft_delete_batch', clone: 'clone_batch',
      };
      await invokeEdgeFunction('activation-codes', { action: actionMap[type], batch_id: batchId });
      showToast({ type: 'success', message: `Batch ${type}d successfully` });
      setConfirmModal(false);
      setExpandedId(null);
      await load();
    } catch (e: any) {
      showToast({ type: 'error', message: e.message ?? 'Operation failed' });
    }
    setSubmitting(false);
  };

  const openConfirm = (type: string, batchId: string, label: string) => {
    setConfirmAction({ type, batchId, label });
    setConfirmModal(true);
  };

  const unused = (b: Batch) => Math.max(0, b.total_count - b.used_count - b.disabled_count - b.expired_count);
  const usedPct = (b: Batch) => b.total_count > 0 ? Math.round((b.used_count / b.total_count) * 100) : 0;

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <FlatList
        data={batches}
        keyExtractor={item => item.id}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        ListHeaderComponent={
          <View style={{ padding: 20, paddingTop: 8 }}>
            <PageHeader title="Batch Manager" subtitle={`${batches.length} batches`} accentColor="#D97706" />
            {loading && <ActivityIndicator size="large" color={c.primary} style={{ marginTop: 40 }} />}
          </View>
        }
        renderItem={({ item: batch }) => {
          const isExpanded = expandedId === batch.id;
          const codes = batchCodes[batch.id] ?? [];
          const pct = usedPct(batch);

          return (
            <View style={{ paddingHorizontal: 20, marginBottom: 12 }}>
              <Pressable onPress={() => toggleExpand(batch.id)}>
                <NeuCard style={{ padding: 16 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                    <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: '#D97706' + '18',
                      alignItems: 'center', justifyContent: 'center' }}>
                      <Ticket size={20} color="#D97706" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>
                        {batch.label ?? `Batch ${batch.id.slice(0, 8)}`}
                      </Text>
                      {batch.course?.title && (
                        <Text style={{ fontSize: 12, color: c.text, opacity: 0.55 }}>{batch.course.title}</Text>
                      )}
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: 2 }}>
                        By {batch.creator?.full_name ?? '—'} · {fmt(batch.created_at)}
                      </Text>
                      {/* Progress bar */}
                      <View style={{ marginTop: 8 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                          <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>
                            {batch.used_count}/{batch.total_count} used · {unused(batch)} unused
                          </Text>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: '#16A34A' }}>{pct}%</Text>
                        </View>
                        <View style={{ height: 6, borderRadius: 3, backgroundColor: `${c.text}10`, overflow: 'hidden' }}>
                          <View style={{ height: '100%', width: `${pct}%`, backgroundColor: '#16A34A', borderRadius: 3 }} />
                        </View>
                      </View>
                      {/* Stats row */}
                      <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                        <Text style={{ fontSize: 11, color: '#16A34A' }}>✓ {batch.used_count} used</Text>
                        <Text style={{ fontSize: 11, color: '#2DA8FF' }}>◦ {unused(batch)} active</Text>
                        <Text style={{ fontSize: 11, color: '#D97706' }}>⏱ {batch.expired_count} exp.</Text>
                        <Text style={{ fontSize: 11, color: '#DC2626' }}>✕ {batch.disabled_count} dis.</Text>
                      </View>
                    </View>
                    {isExpanded ? <ChevronDown size={16} color={`${c.text}40`} /> : <ChevronRight size={16} color={`${c.text}40`} />}
                  </View>
                </NeuCard>
              </Pressable>

              {/* Expanded: actions + codes */}
              {isExpanded && (
                <NeuCard style={{ marginTop: 4, padding: 14 }}>
                  {/* Batch Operations */}
                  <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.45, marginBottom: 10 }}>BATCH OPERATIONS</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
                    {[
                      { label: 'Disable All', type: 'disable', color: '#DC2626', icon: <XCircle size={13} color="#DC2626" /> },
                      { label: 'Enable All',  type: 'enable',  color: '#16A34A', icon: <CheckCircle size={13} color="#16A34A" /> },
                      { label: 'Clone',       type: 'clone',   color: '#7C3AED', icon: <Copy size={13} color="#7C3AED" /> },
                      { label: 'Soft Delete', type: 'delete',  color: '#6B7280', icon: <Trash2 size={13} color="#6B7280" /> },
                    ].map(op => (
                      <Pressable key={op.type} onPress={() => openConfirm(op.type, batch.id, batch.label ?? batch.id)}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8,
                          borderRadius: 10, backgroundColor: `${op.color}12`, marginRight: 8 }}>
                        {op.icon}
                        <Text style={{ fontSize: 12, fontWeight: '700', color: op.color }}>{op.label}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>

                  {/* Codes list */}
                  <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.45, marginBottom: 10 }}>
                    CODES ({codes.length})
                  </Text>
                  {loadingCodes === batch.id ? (
                    <ActivityIndicator size="small" color={c.primary} />
                  ) : codes.length === 0 ? (
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.4 }}>No codes loaded yet</Text>
                  ) : (
                    codes.slice(0, 50).map(code => {
                      const col = statusColor(code.status);
                      return (
                        <View key={code.id} style={{ flexDirection: 'row', alignItems: 'center',
                          paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: `${c.text}08`, gap: 10 }}>
                          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: col }} />
                          <Text style={{ flex: 1, fontSize: 12, fontWeight: '700', color: c.text,
                            fontFamily: 'monospace', letterSpacing: 0.5 }}>{code.code}</Text>
                          <View style={{ alignItems: 'flex-end' }}>
                            <Text style={{ fontSize: 11, fontWeight: '600', color: col, textTransform: 'capitalize' }}>
                              {code.status}
                            </Text>
                            {code.used_by_name && (
                              <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>{code.used_by_name}</Text>
                            )}
                          </View>
                        </View>
                      );
                    })
                  )}
                  {codes.length > 50 && (
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: 8 }}>
                      + {codes.length - 50} more codes — view in Code Ledger
                    </Text>
                  )}
                </NeuCard>
              )}
            </View>
          );
        }}
        ListEmptyComponent={!loading ? (
          <View style={{ padding: 60, alignItems: 'center' }}>
            <Ticket size={40} color={c.primary} opacity={0.2} />
            <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No batches found</Text>
          </View>
        ) : null}
      />

      {/* Confirm Modal */}
      <ResponsiveModal visible={confirmModal} onClose={() => setConfirmModal(false)} title="Confirm Operation">
        {confirmAction && (
          <View>
            <NeuCard style={{ padding: 16, marginBottom: 20, alignItems: 'center' }}>
              <AlertCircle size={28} color="#D97706" />
              <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginTop: 12, textAlign: 'center' }}>
                {confirmAction.type === 'disable' && 'Disable all active codes in this batch?'}
                {confirmAction.type === 'enable'  && 'Re-enable all disabled codes in this batch?'}
                {confirmAction.type === 'delete'  && 'Soft-delete this batch? Codes will be marked deleted.'}
                {confirmAction.type === 'clone'   && 'Clone this batch? New codes will be generated.'}
              </Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 6 }}>{confirmAction.label}</Text>
            </NeuCard>
            <NeuButton
              label={submitting ? 'Processing...' : `Confirm ${confirmAction.type}`}
              onPress={doAction}
              disabled={submitting}
              style={{ backgroundColor: confirmAction.type === 'delete' ? '#6B7280' : confirmAction.type === 'disable' ? '#DC2626' : '#16A34A' }}
            />
            <NeuButton label="Cancel" onPress={() => setConfirmModal(false)} variant="secondary" style={{ marginTop: 8 }} />
          </View>
        )}
      </ResponsiveModal>
    </View>
  );
}
