/**
 * Activation Code History — immutable ledger of all codes.
 * Admin + Super Admin only. Supports search, status filters, batch view, detail modal.
 */
import { useCallback, useState, useMemo } from 'react';
import {
  View, Text, FlatList, TextInput, Pressable,
  ActivityIndicator, RefreshControl, useColorScheme, ScrollView,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { PageHeader } from '@/components/PageHeader';
import type { RelativePathString } from 'expo-router';
import {
  Ticket, CheckCircle, Clock, XCircle, AlertCircle, Search,
  ChevronRight, X, Filter, User, BookOpen, Smartphone, Calendar,
  Hash, Shield, Download,
} from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { neuColors, useLayout } from '@/lib/neu';
import { getActivationLedger, getActivationLedgerStats } from '@/lib/api';
import { exportCSV, CODE_COLUMNS } from '@/lib/exportUtils';
import { useDebounce } from '@/lib/useDebounce';

type CodeRow = {
  id: string; code: string; status: string; created_at: string;
  expires_at: string | null; used_at: string | null; notes: string | null;
  identifier: string | null; device_info: string | null;
  batch_id: string | null; batch_label: string | null; disabled_at: string | null;
  course_id: string; course_title: string | null;
  created_by: string; created_by_name: string | null; created_by_role: string | null;
  used_by: string | null; used_by_name: string | null; used_by_email: string | null;
  disabled_by: string | null; disabled_by_name: string | null;
};

type CodeStats = {
  total: number; used: number; active: number;
  expired: number; disabled: number; today_generated: number; today_used: number;
};

import { ActivationCodeStatus } from '@/lib/enums';
const STATUSES: string[] = ['all', ...Object.values(ActivationCodeStatus)];

function statusColor(s: string): string {
  if (s === 'used')     return '#16A34A';
  if (s === 'active')   return '#2DA8FF';
  if (s === 'expired')  return '#D97706';
  if (s === 'disabled') return '#DC2626';
  if (s === 'deleted')  return '#6B7280';
  if (s === 'reserved') return '#7C3AED';
  return '#6B7280';
}

function StatusIcon({ status, size = 16 }: { status: string; size?: number }) {
  const color = statusColor(status);
  if (status === 'used')     return <CheckCircle size={size} color={color} />;
  if (status === 'active')   return <Clock size={size} color={color} />;
  if (status === 'expired')  return <AlertCircle size={size} color={color} />;
  if (status === 'disabled') return <XCircle size={size} color={color} />;
  return <Ticket size={size} color={color} />;
}

function fmt(d: string) {
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function CodeHistoryScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const router = useRouter();

  const [rows, setRows]   = useState<CodeRow[]>([]);
  const [stats, setStats] = useState<CodeStats | null>(null);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch]         = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showFilters, setShowFilters]   = useState(false);
  const [selected, setSelected]     = useState<CodeRow | null>(null);

  const debouncedSearch = useDebounce(search, 300);

  const load = useCallback(async () => {
    try {
      const [data, s] = await Promise.all([getActivationLedger(), getActivationLedgerStats()]);
      setRows(data as CodeRow[]);
      setStats(s as CodeStats);
    } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const filtered = useMemo(() => {
    let r = rows;
    if (statusFilter !== 'all') r = r.filter(t => t.status === statusFilter);
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      r = r.filter(t =>
        t.code.toLowerCase().includes(q) ||
        t.course_title?.toLowerCase().includes(q) ||
        t.created_by_name?.toLowerCase().includes(q) ||
        t.used_by_name?.toLowerCase().includes(q) ||
        t.used_by_email?.toLowerCase().includes(q) ||
        t.batch_label?.toLowerCase().includes(q) ||
        t.identifier?.toLowerCase().includes(q) ||
        t.notes?.toLowerCase().includes(q)
      );
    }
    return r;
  }, [rows, statusFilter, debouncedSearch]);

  const inp: object = {
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.55, shadowRadius: 5, fontSize: 13, color: c.text,
  };
  const chip = (active: boolean, color: string) => ({
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
    backgroundColor: active ? color : c.base,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.4, shadowRadius: 4, marginRight: 8,
  });

  const StatBox = ({ label, value, color }: { label: string; value: number; color: string }) => (
    <NeuCard style={{ flex: 1, padding: 12, alignItems: 'center', minWidth: 70 }}>
      <Text style={{ fontSize: 20, fontWeight: '800', color }}>{value}</Text>
      <Text style={{ fontSize: 10, color: c.text, opacity: 0.5, textAlign: 'center', marginTop: 2 }}>{label}</Text>
    </NeuCard>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        ListHeaderComponent={
          <View style={{ padding: layout.screenPx, paddingTop: 8 }}>
            {/* Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <View style={{ flex: 1 }}>
                <PageHeader title="Code Ledger" subtitle={`Immutable — ${rows.length} codes`} accentColor="#D97706" />
              </View>
              <Pressable onPress={() => setShowFilters(v => !v)}
                style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: showFilters ? c.primary : c.base, alignItems: 'center', justifyContent: 'center',
                  shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 5 }}>
                <Filter size={16} color={showFilters ? '#fff' : c.text} />
              </Pressable>
              <Pressable onPress={() => exportCSV(rows as any, CODE_COLUMNS, 'code-ledger')}
                style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center',
                  shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 5 }}>
                <Download size={16} color="#D97706" />
              </Pressable>
            </View>

            {/* Stats row 1 */}
            {stats && (
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <StatBox label="Total"    value={stats.total}    color={c.primary} />
                <StatBox label="Used"     value={stats.used}     color="#16A34A" />
                <StatBox label="Active"   value={stats.active}   color="#2DA8FF" />
                <StatBox label="Expired"  value={stats.expired}  color="#D97706" />
                <StatBox label="Disabled" value={stats.disabled} color="#DC2626" />
              </View>
            )}
            {stats && (
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                <StatBox label="Generated Today" value={stats.today_generated} color="#7C3AED" />
                <StatBox label="Used Today"      value={stats.today_used}      color="#16A34A" />
              </View>
            )}

            {/* Search */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12, minWidth: 0 }}>
              <Search size={15} color={`${c.text}55`}  />
              <TextInput value={search} onChangeText={setSearch}
                placeholder="Search code, course, student..."
                placeholderTextColor={`${c.text}55`}
                style={{ ...inp, flex: 1, minWidth: 0, paddingLeft: 36 }} />
              {search !== '' && (
                <Pressable onPress={() => setSearch('')} >
                  <X size={14} color={`${c.text}55`} />
                </Pressable>
              )}
            </View>

            {/* Status filter chips */}
            {showFilters && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
                {STATUSES.map(s => (
                  <Pressable key={s} onPress={() => setStatusFilter(s)}
                    style={chip(statusFilter === s, s === 'all' ? c.primary : statusColor(s))}>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: statusFilter === s ? '#fff' : c.text, textTransform: 'capitalize' }}>
                      {s === 'all' ? 'All' : s}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}

            {loading && <ActivityIndicator size="large" color={c.primary} style={{ marginTop: 40 }} />}
          </View>
        }
        renderItem={({ item: row }) => {
          const color = statusColor(row.status);
          return (
            <Pressable onPress={() => setSelected(row)} style={{ paddingHorizontal: layout.screenPx, marginBottom: 10 }}>
              <NeuCard style={{ padding: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                  <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
                    <StatusIcon status={row.status} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: c.text, fontFamily: 'monospace', letterSpacing: 1 }}>{row.code}</Text>
                      <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: `${color}22` }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color, textTransform: 'capitalize' }}>{row.status}</Text>
                      </View>
                    </View>
                    {row.course_title && (
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, marginTop: 2 }}>{row.course_title}</Text>
                    )}
                    {row.used_by_name && (
                      <Text style={{ fontSize: 11, color: '#16A34A', marginTop: 1 }}>Redeemed by: {row.used_by_name}</Text>
                    )}
                    {row.batch_label && (
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>Batch: {row.batch_label}</Text>
                    )}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{fmtDate(row.created_at)}</Text>
                      {row.expires_at && (
                        <Text style={{ fontSize: 11, color: row.status === 'expired' ? '#D97706' : `${c.text}40` }}>
                          Exp: {fmtDate(row.expires_at)}
                        </Text>
                      )}
                    </View>
                  </View>
                  <ChevronRight size={14} color={`${c.text}40`} />
                </View>
              </NeuCard>
            </Pressable>
          );
        }}
        ListEmptyComponent={!loading ? (
          <View style={{ padding: 60, alignItems: 'center' }}>
            <Ticket size={40} color={c.primary} opacity={0.2} />
            <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No codes found</Text>
          </View>
        ) : null}
      />

      {/* Detail Modal */}
      <ResponsiveModal visible={!!selected} onClose={() => setSelected(null)} title="Code Detail">
        {selected && (() => {
          const color = statusColor(selected.status);
          return (
            <View>
              {/* Code + Status */}
              <NeuCard style={{ padding: 16, marginBottom: 16, alignItems: 'center' }}>
                <Text style={{ fontSize: 26, fontWeight: '900', color: c.text, letterSpacing: 3, fontFamily: 'monospace' }}>{selected.code}</Text>
                <View style={{ paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, backgroundColor: `${color}22`, marginTop: 8 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color, textTransform: 'capitalize' }}>{selected.status}</Text>
                </View>
              </NeuCard>

              {/* Course */}
              {selected.course_title && (
                <Pressable onPress={() => { setSelected(null); router.push('/(app)/(admin)/academic' as RelativePathString); }}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}>
                  <BookOpen size={14} color="#D97706" style={{ marginRight: 10 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>Course</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{selected.course_title}</Text>
                  </View>
                  <ChevronRight size={14} color={`${c.text}40`} />
                </Pressable>
              )}

              {/* Created By */}
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}>
                <Shield size={14} color={c.primary} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>Created By</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{selected.created_by_name ?? '—'}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{selected.created_by_role} · {fmt(selected.created_at)}</Text>
                </View>
              </View>

              {/* Redeemed By */}
              {selected.used_by_name && (
                <Pressable onPress={() => { setSelected(null); router.push('/(app)/(admin)/users' as RelativePathString); }}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}>
                  <User size={14} color="#16A34A" style={{ marginRight: 10 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>Redeemed By</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{selected.used_by_name}</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{selected.used_by_email}</Text>
                    {selected.used_at && <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{fmt(selected.used_at)}</Text>}
                  </View>
                  <ChevronRight size={14} color={`${c.text}40`} />
                </Pressable>
              )}

              {/* Disabled By */}
              {selected.disabled_by_name && (
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}>
                  <XCircle size={14} color="#DC2626" style={{ marginRight: 10 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>Disabled By</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: '#DC2626' }}>{selected.disabled_by_name}</Text>
                    {selected.disabled_at && <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{fmt(selected.disabled_at)}</Text>}
                  </View>
                </View>
              )}

              {/* Expiry */}
              {selected.expires_at && (
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}>
                  <Calendar size={14} color="#D97706" style={{ marginRight: 10 }} />
                  <View>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>Expiry</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: selected.status === 'expired' ? '#D97706' : c.text }}>{fmt(selected.expires_at)}</Text>
                  </View>
                </View>
              )}

              {/* Batch */}
              {selected.batch_id && (
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}>
                  <Hash size={14} color="#7C3AED" style={{ marginRight: 10 }} />
                  <View>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>Batch</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{selected.batch_label ?? selected.batch_id}</Text>
                  </View>
                </View>
              )}

              {/* Device */}
              {selected.device_info && (
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}>
                  <Smartphone size={14} color="#2DA8FF" style={{ marginRight: 10 }} />
                  <View>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>Device</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{selected.device_info}</Text>
                  </View>
                </View>
              )}

              {/* Notes */}
              {selected.notes && (
                <NeuCard style={{ padding: 12, marginTop: 14 }}>
                  <Text style={{ fontSize: 13, color: c.text }}>{selected.notes}</Text>
                </NeuCard>
              )}

              {/* Code ID */}
              <Text style={{ fontSize: 10, color: c.text, opacity: 0.3, fontFamily: 'monospace', marginTop: 14 }}>ID: {selected.id}</Text>

              <NeuButton label="Close" onPress={() => setSelected(null)} variant="secondary" style={{ marginTop: 20 }} />
            </View>
          );
        })()}
      </ResponsiveModal>
    </View>
  );
}
