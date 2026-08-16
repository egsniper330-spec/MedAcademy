/**
 * Doctor Credit Timeline — standalone screen showing a doctor's full credit history,
 * balance chart, usage stats, and revenue. Linked from doctor-mgmt via doctor_id param.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, RefreshControl,
  useColorScheme, Pressable,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  CreditCard, TrendingUp, TrendingDown, RefreshCw,
  DollarSign, Clock, User, ArrowLeft, ShieldOff,
} from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { PageHeader } from '@/components/PageHeader';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout } from '@/lib/neu';
import { getCreditLedger, getDoctorCreditSummary, getDoctorActivityStats, getProfile } from '@/lib/api';
import type { DoctorActivityStats } from '@/lib/api';
import { useProfileStore } from '@/lib/store';

type TxRow = {
  id: string; transaction_type: string; amount: number;
  balance_before: number | null; balance_after: number | null;
  reason: string | null; notes: string | null;
  performed_by_name: string | null; created_at: string;
  course_title: string | null; student_name: string | null;
};

const TX_COLORS: Record<string, string> = {
  allocation: '#16A34A', grant_admin: '#16A34A', grant_super_admin: '#16A34A',
  restoration: '#2DA8FF', adjustment: '#7C3AED', transfer: '#7C3AED',
  consumption: '#DC2626', deduction: '#EF4444', expiry: '#D97706',
};
const TX_SIGN: Record<string, string> = {
  allocation: '+', grant_admin: '+', grant_super_admin: '+',
  restoration: '+', adjustment: '±', transfer: '±',
  consumption: '−', deduction: '−', expiry: '−',
};

// Normalise actor/role labels — never expose "super_admin" to end users
function formatActorName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.replace(/super[\s_-]?admin/gi, 'Admin');
}
function formatActorRole(role: string | null | undefined): string | null {
  if (!role) return null;
  return role.replace(/super[\s_-]?admin/gi, 'Admin');
}

function fmt(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function DoctorCreditTimelineScreen() {
  const { doctor_id, doctor_name } = useLocalSearchParams<{ doctor_id: string; doctor_name?: string }>();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const router = useRouter();
  const { profile: currentUser } = useProfileStore();
  // Super Admins get routed to the dedicated SA earnings page (identical data, read-only UI).
  // Admins continue to the admin earnings page (which also has settings editing).
  const earningsPath = currentUser?.role === 'super_admin'
    ? `/(app)/(superadmin)/sa-doctor-earnings?doctor_id=${doctor_id}&doctor_name=${encodeURIComponent(doctor_name ?? '')}`
    : `/(app)/(admin)/doctor-earnings?doctor_id=${doctor_id}&doctor_name=${encodeURIComponent(doctor_name ?? '')}`;

  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [txRows, setTxRows]             = useState<TxRow[]>([]);
  const [summary, setSummary]           = useState<any>(null);
  const [actStats, setActStats]         = useState<DoctorActivityStats | null>(null);
  const [loadError, setLoadError]       = useState<string | null>(null);
  // Route guard: null = checking, true = allowed, false = blocked
  const [roleAllowed, setRoleAllowed]   = useState<boolean | null>(null);

  const load = useCallback(async () => {
    if (!doctor_id) { setLoading(false); setRoleAllowed(false); return; }

    // ── Route guard: verify current role from DB before loading any data ──────
    try {
      const profile = await getProfile(doctor_id);
      if (!profile || profile.role !== 'doctor') {
        setRoleAllowed(false);
        setLoading(false);
        return;
      }
      setRoleAllowed(true);
    } catch (_) {
      setRoleAllowed(false);
      setLoading(false);
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    try {
      const [rows, sum, stats] = await Promise.all([
        getCreditLedger({ doctorId: doctor_id, limit: 500 }),
        getDoctorCreditSummary(doctor_id),
        getDoctorActivityStats(doctor_id),
      ]);
      setTxRows(rows as TxRow[]);
      setSummary(sum);
      setActStats(stats);
    } catch (e: any) {
      console.error('[DoctorTimeline] load error:', e?.message ?? e);
      setLoadError(e?.message ?? 'Failed to load timeline data.');
    }
    setLoading(false);
  }, [doctor_id]);

  useFocusEffect(useCallback(() => { setLoading(true); setRoleAllowed(null); setLoadError(null); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Build 14-day balance chart from balance_after values
  const chartData = (() => {
    const sorted = [...txRows].reverse();
    const last14 = sorted.slice(-14);
    const vals = last14.map(r => r.balance_after ?? 0);
    const maxV  = Math.max(...vals, 1);
    const labels = last14.map(r => r.created_at.slice(8, 10));
    return { vals, maxV, labels };
  })();

  // Compute revenue generated using doctor's own credit price
  const revenue = (() => {
    const unitPrice = actStats?.credit_selling_price ?? summary?.credit_selling_price ?? 0;
    const addTypes = ['allocation', 'grant_admin', 'grant_super_admin'];
    return txRows
      .filter(t => addTypes.includes(t.transaction_type))
      .reduce((s, t) => s + t.amount * unitPrice, 0);
  })();

  const balance = summary?.current_balance ?? 0;

  // ── Checking role (initial load) ──────────────────────────────────────────
  if (loading && roleAllowed === null) {
    return (
      <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={c.primary} />
      </View>
    );
  }

  // ── Route guard: non-doctor blocked ───────────────────────────────────────
  if (roleAllowed === false) {
    return (
      <View style={{ flex: 1, backgroundColor: c.base }}>
        <View style={{ padding: layout.screenPx, paddingTop: 60, alignItems: 'center', justifyContent: 'center', flex: 1, gap: 20 }}>
          <View style={{
            width: 72, height: 72, borderRadius: 24,
            backgroundColor: `${c.shadowDark}18`,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <ShieldOff size={32} color={c.text} opacity={0.4} />
          </View>
          <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, textAlign: 'center' }}>
            No Activity Timeline
          </Text>
          <Text style={{ fontSize: 14, color: c.text, opacity: 0.5, textAlign: 'center', lineHeight: 22, maxWidth: 280 }}>
            This account does not have an Activity Timeline.{'\n'}Only Doctor accounts have a credit and activity timeline.
          </Text>
          <Pressable
            onPress={() => router.back()}
            style={{ marginTop: 8, backgroundColor: c.primary, borderRadius: 14, paddingHorizontal: 28, paddingVertical: 13 }}
          >
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>Go Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <View style={{ padding: layout.screenPx }}>
        <PageHeader title={doctor_name ?? 'Doctor Timeline'} subtitle={`Credit history · ${txRows.length} transactions`} accentColor={c.primary} />

        {loading && <ActivityIndicator size="large" color={c.primary} style={{ marginVertical: 40 }} />}

        {!loading && loadError && (
          <NeuCard style={{ padding: 24, alignItems: 'center', gap: 12 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#DC2626', textAlign: 'center' }}>Failed to load data</Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, textAlign: 'center' }}>{loadError}</Text>
            <Pressable onPress={() => { setLoading(true); setLoadError(null); load(); }}
              style={{ backgroundColor: c.primary, borderRadius: 10, paddingHorizontal: layout.screenPx, paddingVertical: 10, marginTop: 4 }}>
              <Text style={{ color: '#fff', fontWeight: '700' }}>Retry</Text>
            </Pressable>
          </NeuCard>
        )}

        {!loading && !loadError && (
          <>
            {/* ── Earnings Dashboard shortcut ── */}
            <Pressable
              onPress={() => router.push(earningsPath as any)}
              style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                backgroundColor: '#16A34A12', borderRadius: 14,
                paddingHorizontal: 16, paddingVertical: 12, marginBottom: 12,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <TrendingUp size={18} color="#16A34A" />
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>Open Earnings Dashboard</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {actStats && (
                  <View style={{
                    backgroundColor: actStats.credit_selling_price > 0 ? '#16A34A20' : `${'#000'}10`,
                    borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3,
                  }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#16A34A' }}>
                      {actStats.credit_selling_price > 0 ? `EGP ${actStats.credit_selling_price}/cr` : 'Platform price'}
                    </Text>
                  </View>
                )}
              </View>
            </Pressable>

            {/* ── Activity Stats ── */}
            {actStats && (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 10 }}>
                  ACTIVITY OVERVIEW
                </Text>

                {/* Credit Selling Price highlight */}
                <NeuCard style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 10 }}>
                  <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: '#7C3AED18', alignItems: 'center', justifyContent: 'center' }}>
                    <DollarSign size={22} color="#7C3AED" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Credit Selling Price</Text>
                    <Text style={{ fontSize: 26, fontWeight: '900', color: '#7C3AED' }}>
                      EGP {actStats.credit_selling_price.toLocaleString('en-US')}
                    </Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.35, marginTop: 1 }}>per credit</Text>
                  </View>
                </NeuCard>

                {/* Stats grid */}
                <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                  {[
                    { label: 'Total Allocated',    value: actStats.total_allocated,    color: c.primary    },
                    { label: 'Credits Used',        value: actStats.total_used,         color: '#DC2626'    },
                    { label: 'Remaining Credits',   value: actStats.remaining_credits,  color: '#16A34A'    },
                    { label: 'Courses Sold',        value: actStats.courses_sold,       color: '#2DA8FF'    },
                    { label: 'Students Enrolled',   value: actStats.students_enrolled,  color: '#7C3AED'    },
                    { label: 'Videos Uploaded',     value: actStats.videos_uploaded,    color: '#D97706'    },
                  ].map(kpi => (
                    <NeuCard key={kpi.label} style={{ flexBasis: '47%', padding: 14, alignItems: 'center' }}>
                      <Text style={{ fontSize: 24, fontWeight: '900', color: kpi.color }}>{kpi.value}</Text>
                      <Text style={{ fontSize: 10, color: c.text, opacity: 0.45, textAlign: 'center', marginTop: 2 }}>{kpi.label}</Text>
                    </NeuCard>
                  ))}
                </View>

                {/* Total Earnings */}
                <NeuCard style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 10 }}>
                  <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}>
                    <TrendingUp size={20} color="#16A34A" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Total Earnings</Text>
                    <Text style={{ fontSize: 20, fontWeight: '900', color: '#16A34A' }}>
                      EGP {actStats.total_earnings.toLocaleString('en-US')}
                    </Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.35 }}>
                      {actStats.total_used} credits × EGP {actStats.credit_selling_price}
                    </Text>
                  </View>
                </NeuCard>

                {/* Last login / last active */}
                <NeuCard style={{ padding: 14, marginBottom: 20, gap: 8 }}>
                  {[
                    { label: 'Last Login',    value: actStats.last_login },
                    { label: 'Last Activity', value: actStats.last_active },
                  ].map(row => (
                    <View key={row.label} style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Clock size={14} color={c.text} opacity={0.4} style={{ marginRight: 8 }} />
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, minWidth: 80, flexShrink: 0 }}>{row.label}</Text>
                      <Text style={{ fontSize: 12, color: c.text, flex: 1 }}>
                        {row.value
                          ? new Date(row.value).toLocaleString('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
                          : '—'}
                      </Text>
                    </View>
                  ))}
                </NeuCard>
              </>
            )}

            {/* Summary KPIs */}
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              {[
                { label: 'Current Balance',     value: summary?.current_balance ?? 0,  color: '#16A34A' },
                { label: 'Credits Added',        value: summary?.total_received  ?? 0,  color: c.primary },
                { label: 'Credits Used',         value: summary?.total_used      ?? 0,  color: '#DC2626' },
                { label: 'Credits Removed',      value: summary?.total_removed   ?? 0,  color: '#D97706' },
                { label: 'Credits Remaining',    value: summary?.current_balance ?? 0,  color: '#2DA8FF' },
                { label: 'Courses Activated',    value: new Set(txRows.filter(t => t.transaction_type === 'consumption' && t.course_title).map(t => t.course_title)).size, color: '#7C3AED' },
                { label: 'Students Activated',   value: new Set(txRows.filter(t => t.transaction_type === 'consumption' && t.student_name).map(t => t.student_name)).size, color: '#16A34A' },
              ].map(kpi => (
                <NeuCard key={kpi.label} style={{ flexBasis: '47%', padding: 14, alignItems: 'center' }}>
                  <Text style={{ fontSize: 24, fontWeight: '900', color: kpi.color }}>{kpi.value}</Text>
                  <Text style={{ fontSize: 10, color: c.text, opacity: 0.45, textAlign: 'center', marginTop: 2 }}>{kpi.label}</Text>
                </NeuCard>
              ))}
            </View>

            {/* Revenue */}
            <NeuCard style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 20 }}>
              <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: '#16A34A18',
                alignItems: 'center', justifyContent: 'center' }}>
                <DollarSign size={20} color="#16A34A" />
              </View>
              <View>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Revenue Generated</Text>
                <Text style={{ fontSize: 20, fontWeight: '900', color: '#16A34A' }}>
                  {'EGP'} {revenue.toLocaleString('en-US')}
                </Text>
              </View>
            </NeuCard>

            {/* Balance Chart */}
            {chartData.vals.length > 1 && (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 10 }}>
                  BALANCE TREND (LAST {chartData.vals.length} TRANSACTIONS)
                </Text>
                <NeuCard style={{ padding: 16, marginBottom: 20 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 80 }}>
                    {chartData.vals.map((v, i) => (
                      <View key={i} style={{ flex: 1, alignItems: 'center' }}>
                        <View style={{
                          width: '80%',
                          height: Math.max(4, (v / chartData.maxV) * 72),
                          backgroundColor: v > (chartData.vals[i - 1] ?? v) ? '#16A34A' : '#DC2626',
                          borderRadius: 3, opacity: 0.8,
                        }} />
                      </View>
                    ))}
                  </View>
                  <View style={{ flexDirection: 'row', gap: 4, marginTop: 4 }}>
                    {chartData.labels.map((l, i) => (
                      <Text key={i} style={{ flex: 1, fontSize: 8, color: c.text, opacity: 0.3, textAlign: 'center' }}>{l}</Text>
                    ))}
                  </View>
                </NeuCard>
              </>
            )}

            {/* Transaction Timeline */}
            <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 12 }}>
              TRANSACTION HISTORY ({txRows.length})
            </Text>
            {txRows.length === 0 ? (
              <NeuCard style={{ padding: 40, alignItems: 'center' }}>
                <CreditCard size={32} color={c.primary} opacity={0.2} />
                <Text style={{ color: c.text, opacity: 0.4, marginTop: 12 }}>No transactions yet</Text>
              </NeuCard>
            ) : (
              txRows.map(tx => {
                // Determine sign from actual balance change; fall back to TX_SIGN table
                const delta =
                  tx.balance_before != null && tx.balance_after != null
                    ? tx.balance_after - tx.balance_before
                    : null;
                const col  = delta != null
                  ? (delta >= 0 ? '#16A34A' : '#DC2626')
                  : (TX_COLORS[tx.transaction_type] ?? '#6B7280');
                const sign = delta != null
                  ? (delta >= 0 ? '+' : '−')
                  : (TX_SIGN[tx.transaction_type] ?? '');
                const actorName = formatActorName(tx.performed_by_name);
                return (
                  <View key={tx.id} style={{ flexDirection: 'row', gap: 12, marginBottom: 10 }}>
                    {/* Timeline dot + line */}
                    <View style={{ alignItems: 'center', width: 16 }}>
                      <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: col, marginTop: 4 }} />
                      <View style={{ flex: 1, width: 2, backgroundColor: `${col}25`, marginTop: 2 }} />
                    </View>
                    <NeuCard style={{ flex: 1, padding: 12, marginBottom: 0 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, textTransform: 'capitalize' }}>
                            {tx.transaction_type.replace(/_/g, ' ')}
                          </Text>
                          {actorName && (
                            <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>By {actorName}</Text>
                          )}
                          {(tx.reason || tx.notes) && (
                            <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: 2 }}>
                              {tx.reason ?? tx.notes}
                            </Text>
                          )}
                          {tx.balance_before != null && tx.balance_after != null && (
                            <Text style={{ fontSize: 10, color: c.text, opacity: 0.35, marginTop: 2 }}>
                              Balance: {tx.balance_before} → {tx.balance_after}
                            </Text>
                          )}
                          <Text style={{ fontSize: 10, color: c.text, opacity: 0.3, marginTop: 3 }}>
                            {fmt(tx.created_at)}
                          </Text>
                        </View>
                        <Text style={{ fontSize: 18, fontWeight: '900', color: col }}>
                          {sign}{Math.abs(tx.amount)}
                        </Text>
                      </View>
                    </NeuCard>
                  </View>
                );
              })
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}
