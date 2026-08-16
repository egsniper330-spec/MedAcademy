/**
 * Credits — unified super-admin credits hub.
 * Two tabs: Credit Management (add/remove) + Credit History (merged ledger + analytics).
 * All backend calls unchanged; UI/navigation only.
 */
import { useCallback, useState, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, FlatList, TextInput, Pressable,
  ActivityIndicator, RefreshControl, useColorScheme,
  KeyboardAvoidingView, Animated,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  CreditCard, TrendingUp, TrendingDown, RefreshCw, Search, Filter,
  X, User, BookOpen, CheckCircle, ChevronRight, ArrowUpCircle,
  ArrowDownCircle, Minus, Download, Award, AlertTriangle,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout } from '@/lib/neu';
import {
  getDoctors, allocateCredits, refundCredits, getCreditTransactions,
  getCreditLedger, getCreditLedgerStats, getCreditDailyStats, getTopDoctorsByCredits,
  getPublicEmail,
} from '@/lib/api';
import { exportCSV, CREDIT_COLUMNS } from '@/lib/exportUtils';
import { validateRequired, friendlyError } from '@/lib/validation';
import { useDebounce } from '@/lib/useDebounce';

// ── Types ──────────────────────────────────────────────────────────────────
type TxRow = {
  id: string; created_at: string; transaction_type: string;
  amount: number; balance_before: number | null; balance_after: number | null;
  reason: string | null; notes: string | null; audit_log_id: string | null;
  doctor_id: string; doctor_name: string | null; doctor_email: string | null;
  performed_by: string; performed_by_name: string | null; performed_by_role: string | null;
  student_id: string | null; student_name: string | null;
  course_id: string | null; course_title: string | null;
};
type Stats = {
  total_tx: number; total_added: number; total_used: number;
  total_removed: number; total_refunded: number;
  today_added: number; today_used: number; today_removed: number;
};

// ── Helpers ────────────────────────────────────────────────────────────────
const TX_TYPES = ['all','grant_admin','grant_super_admin','allocation','consumption','deduction','restoration','expiry','adjustment','transfer'];

function txColor(type: string): string {
  if (['grant_admin','grant_super_admin','allocation','restoration'].includes(type)) return '#16A34A';
  if (['consumption','deduction','expiry'].includes(type)) return '#DC2626';
  return '#D97706';
}

function TxIcon({ type, size = 18 }: { type: string; size?: number }) {
  const color = txColor(type);
  if (['grant_admin','grant_super_admin','allocation'].includes(type)) return <ArrowUpCircle size={size} color={color} />;
  if (['consumption','deduction','expiry'].includes(type)) return <ArrowDownCircle size={size} color={color} />;
  if (type === 'restoration') return <RefreshCw size={size} color={color} />;
  return <Minus size={size} color={color} />;
}

function txLabel(type: string): string {
  const map: Record<string, string> = {
    grant_super_admin: 'Granted (Super Admin)', grant_admin: 'Granted (Admin)',
    allocation: 'Allocated', consumption: 'Consumed', deduction: 'Removed',
    restoration: 'Refunded', expiry: 'Expired', adjustment: 'Adjusted', transfer: 'Transferred',
  };
  return map[type] ?? type;
}

function fmt(d: string) {
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ── Tab pill ───────────────────────────────────────────────────────────────
function TabPill({ label, active, onPress, c }: { label: string; active: boolean; onPress: () => void; c: typeof neuColors.light }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1, paddingVertical: 10, borderRadius: 14, alignItems: 'center',
        backgroundColor: active ? c.primary : c.base,
        shadowColor: active ? c.primary : c.shadowDark,
        shadowOffset: { width: active ? 0 : 3, height: active ? 0 : 3 },
        shadowOpacity: active ? 0.35 : 0.45,
        shadowRadius: active ? 8 : 6,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '700', color: active ? '#fff' : c.text, opacity: active ? 1 : 0.65 }}>
        {label}
      </Text>
    </Pressable>
  );
}

// ── Stat box ───────────────────────────────────────────────────────────────
function StatBox({ label, value, color, c }: { label: string; value: number; color: string; c: typeof neuColors.light }) {
  return (
    <NeuCard style={{ flex: 1, padding: 12, alignItems: 'center', minWidth: 80 }}>
      <Text style={{ fontSize: 20, fontWeight: '800', color }}>{value}</Text>
      <Text style={{ fontSize: 10, color: c.text, opacity: 0.5, textAlign: 'center', marginTop: 2 }}>{label}</Text>
    </NeuCard>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TAB 1 — Credit Management
// ══════════════════════════════════════════════════════════════════════════
function ManagementTab({ c, isDark }: { c: typeof neuColors.light; isDark: boolean }) {
    const layout = useLayout();
const { showToast } = useToast();

  const [doctors, setDoctors]           = useState<any[]>([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [search, setSearch]             = useState('');
  const debouncedSearch                 = useDebounce(search, 300);

  const [allocModal, setAllocModal]     = useState(false);
  const [selectedDoc, setSelectedDoc]   = useState<any>(null);
  const [amount, setAmount]             = useState('');
  const [notes, setNotes]               = useState('');
  const [allocatingType, setAllocatingType] = useState<'allocate' | 'refund' | null>(null);
  const [isDirty, setIsDirty]           = useState(false);

  const [txModal, setTxModal]           = useState(false);
  const [txDoctor, setTxDoctor]         = useState<any>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [txLoading, setTxLoading]       = useState(false);

  const load = useCallback(async () => {
    try { setDoctors(await getDoctors()); } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const openAllocate = (doc: any) => {
    setSelectedDoc(doc); setAmount(''); setNotes(''); setIsDirty(false); setAllocModal(true);
  };

  const handleAllocate = async (type: 'allocate' | 'refund') => {
    const err = validateRequired(amount, 'Amount');
    if (err || isNaN(Number(amount)) || Number(amount) <= 0) {
      showToast({ type: 'error', message: 'Enter a valid positive amount.' }); return;
    }
    setAllocatingType(type);
    try {
      if (type === 'allocate') {
        await allocateCredits(selectedDoc.id, Number(amount), notes.trim() || '');
        showToast({ type: 'success', message: `${amount} credits added to ${selectedDoc.full_name}.` });
      } else {
        await refundCredits(selectedDoc.id, Number(amount), notes.trim() || '');
        showToast({ type: 'success', message: `${amount} credits refunded from ${selectedDoc.full_name}.` });
      }
      setIsDirty(false);
      setAllocModal(false);
      await load();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Operation failed.') });
    }
    setAllocatingType(null);
  };

  const openTransactions = async (doc: any) => {
    setTxDoctor(doc); setTxModal(true); setTxLoading(true);
    try { setTransactions(await getCreditTransactions(doc.id)); } catch (_) { setTransactions([]); }
    setTxLoading(false);
  };

  const filtered = useMemo(() =>
    doctors.filter(d =>
      d.full_name?.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
      d.email?.toLowerCase().includes(debouncedSearch.toLowerCase())
    ), [doctors, debouncedSearch]);

  const inp = {
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.55, shadowRadius: 5,
    fontSize: 14, color: c.text, marginBottom: 14,
  };

  return (
    <>
      <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        >
          <View style={{ padding: layout.screenPx }}>
            {/* Search */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16, minWidth: 0 }}>
              <Search size={15} color={`${c.text}55`}  />
              <TextInput
                value={search} onChangeText={setSearch}
                placeholder="Search doctors..."
                placeholderTextColor={`${c.text}55`}
                style={{ ...inp, flex: 1, minWidth: 0, paddingLeft: 38, marginBottom: 0 }}
              />
            </View>

            {loading && <ActivityIndicator size="large" color={c.primary} style={{ marginTop: 40 }} />}

            {filtered.map(doc => (
              <NeuCard key={doc.id} style={{ marginBottom: 12, padding: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                  <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: '#16A34A18',
                    alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                    <CreditCard size={18} color="#16A34A" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{doc.full_name}</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{getPublicEmail(doc) ?? '—'}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 20, fontWeight: '800', color: '#16A34A' }}>{doc.credits_balance ?? 0}</Text>
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>credits</Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <NeuButton label="Add / Remove" onPress={() => openAllocate(doc)} style={{ flex: 1 }} />
                  <NeuButton label="History" onPress={() => openTransactions(doc)} variant="secondary" style={{ flex: 1 }} />
                </View>
              </NeuCard>
            ))}

            {!loading && filtered.length === 0 && (
              <NeuCard style={{ padding: 40, alignItems: 'center' }}>
                <CreditCard size={36} color={c.primary} opacity={0.25} />
                <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No doctors found</Text>
              </NeuCard>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Allocate / Refund Modal */}
      <ResponsiveModal
        visible={allocModal} onClose={() => { setAllocModal(false); setIsDirty(false); }}
        isDirty={isDirty}
        title={`Credits — ${selectedDoc?.full_name ?? ''}`}
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={() => setAllocModal(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Refund" onPress={() => handleAllocate('refund')}
              loading={allocatingType === 'refund'} disabled={allocatingType !== null}
              variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Add Credits" onPress={() => handleAllocate('allocate')}
              loading={allocatingType === 'allocate'} disabled={allocatingType !== null} style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5,
          marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Amount</Text>
        <TextInput
          value={amount} onChangeText={v => { setAmount(v); setIsDirty(true); }}
          placeholder="e.g. 100" placeholderTextColor={`${c.text}55`}
          keyboardType="numeric" style={{ ...inp, minWidth: 0 }}
        />
        <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5,
          marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Notes (optional)</Text>
        <TextInput
          value={notes} onChangeText={v => { setNotes(v); setIsDirty(true); }}
          placeholder="Reason for allocation..." placeholderTextColor={`${c.text}55`}
          multiline style={{ ...inp, minWidth: 0, minHeight: 80, textAlignVertical: 'top' }}
        />
      </ResponsiveModal>

      {/* Per-doctor History Modal */}
      <ResponsiveModal visible={txModal} onClose={() => setTxModal(false)}
        title={`History — ${txDoctor?.full_name ?? ''}`}>
        {txLoading && <ActivityIndicator size="large" color={c.primary} style={{ marginVertical: 40 }} />}
        {!txLoading && transactions.length === 0 && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <Text style={{ color: c.text, opacity: 0.4 }}>No transactions found</Text>
          </View>
        )}
        {transactions.map((tx, i) => {
          const POSITIVE = ['allocation','grant_admin','grant_super_admin','restoration','adjustment','transfer'];
          const isPos = POSITIVE.includes(tx.transaction_type);
          const color = isPos ? '#16A34A' : '#DC2626';
          const TIcon = isPos ? TrendingUp : TrendingDown;
          return (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center',
              paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}>
              <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: `${color}18`,
                alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                <TIcon size={16} color={color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, textTransform: 'capitalize' }}>
                  {tx.transaction_type}
                </Text>
                {tx.notes && <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{tx.notes}</Text>}
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>
                  {new Date(tx.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}
                </Text>
              </View>
              <Text style={{ fontSize: 16, fontWeight: '800', color }}>{isPos ? '+' : '-'}{tx.amount}</Text>
            </View>
          );
        })}
      </ResponsiveModal>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TAB 2 — Credit History (merged ledger + analytics)
// ══════════════════════════════════════════════════════════════════════════
function HistoryTab({ c, isDark }: { c: typeof neuColors.light; isDark: boolean }) {
    const layout = useLayout();
const router = useRouter();

  const [rows, setRows]             = useState<TxRow[]>([]);
  const [stats, setStats]           = useState<Stats | null>(null);
  const [topDocs, setTopDocs]       = useState<any[]>([]);
  const [dailyStats, setDailyStats] = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch]         = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected]     = useState<TxRow | null>(null);

  const debouncedSearch = useDebounce(search, 300);

  const load = useCallback(async () => {
    try {
      const [data, s, td, ds] = await Promise.all([
        getCreditLedger(),
        getCreditLedgerStats(),
        getTopDoctorsByCredits(5),
        getCreditDailyStats(14),
      ]);
      setRows(data as TxRow[]);
      setStats(s as Stats);
      setTopDocs(td as any[]);
      setDailyStats(ds as any[]);
    } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const filtered = useMemo(() => {
    let r = rows;
    if (typeFilter !== 'all') r = r.filter(t => t.transaction_type === typeFilter);
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      r = r.filter(t =>
        t.doctor_name?.toLowerCase().includes(q) ||
        t.doctor_email?.toLowerCase().includes(q) ||
        t.performed_by_name?.toLowerCase().includes(q) ||
        t.course_title?.toLowerCase().includes(q) ||
        t.notes?.toLowerCase().includes(q) ||
        t.reason?.toLowerCase().includes(q) ||
        t.transaction_type.includes(q)
      );
    }
    return r;
  }, [rows, typeFilter, debouncedSearch]);

  // 14-day chart (added vs used vs removed)
  const chartData = useMemo(() => {
    const addMap: Record<string, number> = {};
    const useMap: Record<string, number> = {};
    const remMap: Record<string, number> = {};
    for (const row of dailyStats) {
      if (['allocation','grant_admin','grant_super_admin','restoration'].includes(row.transaction_type))
        addMap[row.day] = (addMap[row.day] ?? 0) + (row.total_amount ?? 0);
      else if (row.transaction_type === 'consumption')
        useMap[row.day] = (useMap[row.day] ?? 0) + (row.total_amount ?? 0);
      else if (['deduction','expiry'].includes(row.transaction_type))
        remMap[row.day] = (remMap[row.day] ?? 0) + (row.total_amount ?? 0);
    }
    const days = [...new Set([...Object.keys(addMap), ...Object.keys(useMap), ...Object.keys(remMap)])].sort().slice(-14);
    const addV = days.map(d => addMap[d] ?? 0);
    const useV = days.map(d => useMap[d] ?? 0);
    const remV = days.map(d => remMap[d] ?? 0);
    const maxV = Math.max(...addV, ...useV, ...remV, 1);
    return { days, addV, useV, remV, maxV };
  }, [dailyStats]);

  const inp: object = {
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.55, shadowRadius: 5, fontSize: 13, color: c.text,
  };
  const chip = (active: boolean) => ({
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
    backgroundColor: active ? c.primary : c.base,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.4, shadowRadius: 5, marginRight: 8,
  });

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        ListHeaderComponent={
          <View style={{ padding: layout.screenPx, paddingTop: 8 }}>
            {/* Summary stats */}
            {stats && (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 8 }}>
                  LIFETIME TOTALS
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <StatBox label="Total Tx"   value={stats.total_tx}       color={c.primary} c={c} />
                  <StatBox label="Added"      value={stats.total_added}    color="#16A34A"   c={c} />
                  <StatBox label="Used"       value={stats.total_used}     color="#DC2626"   c={c} />
                  <StatBox label="Refunded"   value={stats.total_refunded} color="#2DA8FF"   c={c} />
                </View>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 8, marginTop: 4 }}>
                  TODAY
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                  <StatBox label="Added"   value={stats.today_added}   color="#16A34A" c={c} />
                  <StatBox label="Used"    value={stats.today_used}    color="#DC2626" c={c} />
                  <StatBox label="Removed" value={stats.today_removed} color="#D97706" c={c} />
                </View>
              </>
            )}

            {/* 14-day chart */}
            {chartData.days.length > 0 && (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 8 }}>
                  DAILY ACTIVITY — LAST 14 DAYS
                </Text>
                <NeuCard style={{ padding: 16, marginBottom: 20 }}>
                  <View style={{ flexDirection: 'row', gap: 16, marginBottom: 10 }}>
                    {[{ l: 'Added', col: '#16A34A' }, { l: 'Used', col: '#DC2626' }, { l: 'Removed', col: '#D97706' }].map(x => (
                      <View key={x.l} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: x.col }} />
                        <Text style={{ fontSize: 10, color: c.text, opacity: 0.5 }}>{x.l}</Text>
                      </View>
                    ))}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 80 }}>
                    {chartData.days.map((day, i) => (
                      <View key={day} style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 1 }}>
                        <View style={{ flex: 1, height: Math.max(3, (chartData.addV[i] / chartData.maxV) * 72), backgroundColor: '#16A34A', borderRadius: 2, opacity: 0.8 }} />
                        <View style={{ flex: 1, height: Math.max(3, (chartData.useV[i] / chartData.maxV) * 72), backgroundColor: '#DC2626', borderRadius: 2, opacity: 0.8 }} />
                        <View style={{ flex: 1, height: Math.max(3, (chartData.remV[i] / chartData.maxV) * 72), backgroundColor: '#D97706', borderRadius: 2, opacity: 0.8 }} />
                      </View>
                    ))}
                  </View>
                  <View style={{ flexDirection: 'row', gap: 3, marginTop: 4 }}>
                    {chartData.days.map(d => (
                      <Text key={d} style={{ flex: 1, fontSize: 7, color: c.text, opacity: 0.3, textAlign: 'center' }}>
                        {d.slice(8)}
                      </Text>
                    ))}
                  </View>
                </NeuCard>
              </>
            )}

            {/* Top doctors by balance */}
            {topDocs.length > 0 && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <View style={{ width: 28, height: 28, borderRadius: 9, backgroundColor: '#7C3AED15', alignItems: 'center', justifyContent: 'center' }}>
                    <Award size={14} color="#7C3AED" />
                  </View>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>Top Doctors by Balance</Text>
                </View>
                <View style={{ gap: 8, marginBottom: 20 }}>
                  {topDocs.map((doc, i) => (
                    <NeuCard key={doc.id} style={{ padding: 12 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <View style={{ width: 28, height: 28, borderRadius: 9, backgroundColor: `${c.primary}15`,
                          alignItems: 'center', justifyContent: 'center' }}>
                          <Text style={{ fontSize: 11, fontWeight: '800', color: c.primary }}>#{i + 1}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{doc.full_name}</Text>
                          <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>
                            Received: {doc.total_received} · Used: {doc.total_used}
                          </Text>
                        </View>
                        <Text style={{ fontSize: 17, fontWeight: '900', color: '#16A34A' }}>{doc.current_balance}</Text>
                      </View>
                    </NeuCard>
                  ))}
                </View>
              </>
            )}

            {/* Search + filter toolbar */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                <Search size={14} color={`${c.text}55`}  />
                <TextInput
                  value={search} onChangeText={setSearch}
                  placeholder="Search doctor, course, type..."
                  placeholderTextColor={`${c.text}55`}
                  style={{ ...inp, flex: 1, paddingLeft: 34, marginBottom: 0 } as object}
                />
                {search !== '' && (
                  <Pressable onPress={() => setSearch('')} >
                    <X size={13} color={`${c.text}55`} />
                  </Pressable>
                )}
              </View>
              <Pressable onPress={() => setShowFilters(v => !v)}
                style={{ width: 38, height: 38, borderRadius: 12,
                  backgroundColor: showFilters ? c.primary : c.base,
                  alignItems: 'center', justifyContent: 'center',
                  shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
                  shadowOpacity: 0.5, shadowRadius: 5 }}>
                <Filter size={15} color={showFilters ? '#fff' : c.text} />
              </Pressable>
              <Pressable onPress={() => exportCSV(rows as any, CREDIT_COLUMNS, 'credit-history')}
                style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: c.base,
                  alignItems: 'center', justifyContent: 'center',
                  shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
                  shadowOpacity: 0.5, shadowRadius: 5 }}>
                <Download size={15} color="#16A34A" />
              </Pressable>
            </View>

            {showFilters && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
                {TX_TYPES.map(t => (
                  <Pressable key={t} onPress={() => setTypeFilter(t)} style={chip(typeFilter === t)}>
                    <Text style={{ fontSize: 11, fontWeight: '600', color: typeFilter === t ? '#fff' : c.text }}>
                      {t === 'all' ? 'All Types' : txLabel(t)}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}

            <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 8 }}>
              TRANSACTIONS ({filtered.length})
            </Text>

            {loading && <ActivityIndicator size="large" color={c.primary} style={{ marginTop: 30 }} />}
          </View>
        }
        renderItem={({ item: tx }) => {
          // Determine sign from actual balance change; fall back to type classification
          const delta =
            tx.balance_before != null && tx.balance_after != null
              ? tx.balance_after - tx.balance_before
              : null;
          const isPos = delta != null
            ? delta >= 0
            : ['grant_admin','grant_super_admin','allocation','restoration'].includes(tx.transaction_type);
          const color = txColor(tx.transaction_type);
          const actorName = (tx.performed_by_name ?? '').replace(/super[\s_-]?admin/gi, 'Admin') || null;
          const actorRole = (tx.performed_by_role ?? '').replace(/super[\s_-]?admin/gi, 'Admin') || null;
          return (
            <Pressable onPress={() => setSelected(tx)} style={{ paddingHorizontal: layout.screenPx, marginBottom: 10 }}>
              <NeuCard style={{ padding: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                  <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${color}18`,
                    alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
                    <TxIcon type={tx.transaction_type} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color }}>{txLabel(tx.transaction_type)}</Text>
                      <Text style={{ fontSize: 18, fontWeight: '800', color }}>{isPos ? '+' : '-'}{Math.abs(tx.amount)}</Text>
                    </View>
                    <Text style={{ fontSize: 12, color: c.text, fontWeight: '600' }}>{tx.doctor_name ?? tx.doctor_id}</Text>
                    {actorName && (
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>
                        {`By: ${actorName}${actorRole ? ` (${actorRole})` : ''}`}
                      </Text>
                    )}
                    {tx.course_title && (
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>Course: {tx.course_title}</Text>
                    )}
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{fmt(tx.created_at)}</Text>
                      {tx.balance_before != null && tx.balance_after != null && (
                        <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>
                          {tx.balance_before} → {tx.balance_after}
                        </Text>
                      )}
                    </View>
                  </View>
                  <ChevronRight size={13} color={`${c.text}35`} style={{ marginTop: 3 }} />
                </View>
              </NeuCard>
            </Pressable>
          );
        }}
        ListEmptyComponent={!loading ? (
          <View style={{ padding: 60, alignItems: 'center' }}>
            <CreditCard size={38} color={c.primary} opacity={0.2} />
            <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No transactions found</Text>
          </View>
        ) : null}
      />

      {/* Transaction Detail Modal */}
      <ResponsiveModal visible={!!selected} onClose={() => setSelected(null)} title="Transaction Detail">
        {selected && (() => {
          const color = txColor(selected.transaction_type);
          // Use actual balance delta for correct sign in detail view
          const selDelta =
            selected.balance_before != null && selected.balance_after != null
              ? selected.balance_after - selected.balance_before
              : null;
          const isPos = selDelta != null
            ? selDelta >= 0
            : ['grant_admin','grant_super_admin','allocation','restoration'].includes(selected.transaction_type);
          const selActorName = (selected.performed_by_name ?? '').replace(/super[\s_-]?admin/gi, 'Admin') || null;
          const selActorRole = (selected.performed_by_role ?? '').replace(/super[\s_-]?admin/gi, 'Admin') || null;
          return (
            <View>
              {/* Type + Amount header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${color}18`,
                    alignItems: 'center', justifyContent: 'center' }}>
                    <TxIcon type={selected.transaction_type} size={22} />
                  </View>
                  <View>
                    <Text style={{ fontSize: 15, fontWeight: '800', color }}>{txLabel(selected.transaction_type)}</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{fmt(selected.created_at)}</Text>
                  </View>
                </View>
                <Text style={{ fontSize: 26, fontWeight: '800', color }}>{isPos ? '+' : '-'}{Math.abs(selected.amount)}</Text>
              </View>

              {/* Balance before/after */}
              {selected.balance_before != null && (
                <NeuCard style={{ padding: 14, marginBottom: 14, flexDirection: 'row', justifyContent: 'space-around' }}>
                  <View style={{ alignItems: 'center' }}>
                    <Text style={{ fontSize: 18, fontWeight: '700', color: c.text }}>{selected.balance_before}</Text>
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>Balance Before</Text>
                  </View>
                  <View style={{ alignItems: 'center' }}>
                    <Text style={{ fontSize: 18, fontWeight: '700', color }}>→</Text>
                  </View>
                  <View style={{ alignItems: 'center' }}>
                    <Text style={{ fontSize: 18, fontWeight: '700', color }}>{selected.balance_after}</Text>
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>Balance After</Text>
                  </View>
                </NeuCard>
              )}

              {/* Parties */}
              {[
                { label: 'Doctor', value: selected.doctor_name, sub: selected.doctor_email, icon: <User size={14} color={c.primary} />, onPress: () => { setSelected(null); router.push('/(app)/(superadmin)/sa-users' as RelativePathString); } },
                { label: 'Performed By', value: selActorName, sub: selActorRole, icon: <CheckCircle size={14} color="#16A34A" />, onPress: null },
                { label: 'Student', value: selected.student_name, sub: null, icon: <User size={14} color="#7C3AED" />, onPress: null },
                { label: 'Course', value: selected.course_title, sub: null, icon: <BookOpen size={14} color="#D97706" />, onPress: null },
              ].filter(r => r.value).map(row => (
                <Pressable key={row.label} onPress={row.onPress ?? undefined}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
                    borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}>
                  <View style={{ marginRight: 10 }}>{row.icon}</View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{row.label}</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{row.value}</Text>
                    {row.sub && <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{row.sub}</Text>}
                  </View>
                  {row.onPress && <ChevronRight size={14} color={`${c.text}40`} />}
                </Pressable>
              ))}

              {/* Notes / Reason */}
              {(selected.notes || selected.reason) && (
                <NeuCard style={{ padding: 12, marginTop: 14 }}>
                  {selected.reason && (
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginBottom: 4 }}>
                      Reason: {selected.reason}
                    </Text>
                  )}
                  {selected.notes && <Text style={{ fontSize: 13, color: c.text }}>{selected.notes}</Text>}
                </NeuCard>
              )}

              {/* TX ID */}
              <View style={{ marginTop: 14, gap: 4 }}>
                <Text style={{ fontSize: 10, color: c.text, opacity: 0.3 }}>TX: {selected.id}</Text>
                {selected.audit_log_id && (
                  <Pressable onPress={() => { setSelected(null); router.push('/(app)/(superadmin)/sa-audit' as RelativePathString); }}>
                    <Text style={{ fontSize: 10, color: c.primary, opacity: 0.7 }}>→ View Audit Log</Text>
                  </Pressable>
                )}
              </View>

              <NeuButton label="Close" onPress={() => setSelected(null)} variant="secondary" style={{ marginTop: 20 }} />
            </View>
          );
        })()}
      </ResponsiveModal>
    </View>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ROOT — Credits Hub
// ══════════════════════════════════════════════════════════════════════════
export default function CreditsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [tab, setTab] = useState<'management' | 'history'>('management');

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      {/* Header + tab switcher */}
      <View style={{ paddingHorizontal: layout.screenPx, paddingTop: 16, paddingBottom: 8 }}>
        <PageHeader title="Credits" subtitle="Manage & track all credit activity" accentColor="#7C3AED" />
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
          <TabPill
            label="Credit Management"
            active={tab === 'management'}
            onPress={() => setTab('management')}
            c={c}
          />
          <TabPill
            label="Credit History"
            active={tab === 'history'}
            onPress={() => setTab('history')}
            c={c}
          />
        </View>
      </View>

      {/* Tab content */}
      <View style={{ flex: 1 }}>
        {tab === 'management' ? (
          <ManagementTab c={c} isDark={isDark} />
        ) : (
          <HistoryTab c={c} isDark={isDark} />
        )}
      </View>
    </View>
  );
}
