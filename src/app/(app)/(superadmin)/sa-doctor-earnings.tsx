/**
 * SA Doctor Earnings — Super Admin read-only view of a doctor's COMPLETE financial profile.
 *
 * SINGLE SOURCE OF TRUTH — All data comes from the same functions the doctor/admin use:
 *   • getDoctorEarningsDashboard(doctorId)  — revenue, transactions, course breakdown
 *   • getCreditLedger({ doctorId })         — credit allocation/consumption ledger
 *   • getDoctorCreditSummary(doctorId)      — balance snapshot
 *   • getDoctorActivityStats(doctorId)      — credit price, usage stats, login activity
 *
 * READ-ONLY DIFFERENCES vs doctor's own view:
 *   • No earnings enable/disable toggle.
 *   • No pricing settings editor.
 *   • No student actions (Suspend / Resume / Remove).
 *   • "Read-Only" badge in header.
 *   • Student profile modal is view-only.
 */
import { useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  RefreshControl, useColorScheme, Modal, Image,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  TrendingUp, DollarSign, Users, BarChart2,
  Zap, Calendar, ArrowUpRight, ArrowDownRight,
  X, Phone, Mail, Hash, BookOpen,
  Award, ChevronRight, Eye, CreditCard, Clock,
  TrendingDown,
} from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { neuColors } from '@/lib/neu';
import {
  getDoctorEarningsDashboard,
  bucketEarningsTimeSeries,
  getDoctorStudentProfile,
  getCreditLedger,
  getDoctorCreditSummary,
  getDoctorActivityStats,
  type DoctorEarningsDashboard,
  type EarningsTransactionRow,
  type EarningsCourseRow,
  type DoctorStudentProfile,
  type DoctorActivityStats,
} from '@/lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — identical to dr-earnings.tsx
// ─────────────────────────────────────────────────────────────────────────────
function fmtEGP(n: number): string {
  const abs = Math.abs(n);
  const s = `EGP ${abs.toLocaleString('en-EG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  return n < 0 ? `−${s}` : `+${s}`;
}
function fmtEGPPlain(n: number): string {
  return `EGP ${Math.abs(n).toLocaleString('en-EG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const EARNINGS_TX_LABEL: Record<string, string> = {
  purchase:          'Purchase',
  removal:           'Course Removal',
  suspension_refund: 'Refund',
  adjustment:        'Adjustment',
  account_deletion:  'Account Deleted',
};

// Credit ledger tx colours & signs — from doctor-credit-timeline.tsx
const CREDIT_TX_COLORS: Record<string, string> = {
  allocation: '#16A34A', grant_admin: '#16A34A', grant_super_admin: '#16A34A',
  restoration: '#2DA8FF', adjustment: '#7C3AED', transfer: '#7C3AED',
  consumption: '#DC2626', deduction: '#EF4444', expiry: '#D97706',
};
const CREDIT_TX_SIGN: Record<string, string> = {
  allocation: '+', grant_admin: '+', grant_super_admin: '+',
  restoration: '+', adjustment: '±', transfer: '±',
  consumption: '−', deduction: '−', expiry: '−',
};

type CreditRow = {
  id: string; transaction_type: string; amount: number;
  balance_before: number | null; balance_after: number | null;
  reason: string | null; notes: string | null;
  performed_by_name: string | null; created_at: string;
  course_title: string | null; student_name: string | null;
};

function txDisplayName(row: EarningsTransactionRow): string {
  if (row.transaction_type === 'account_deletion') return 'Deleted Account';
  return row.student_name ?? 'Deleted Account';
}

type ChartPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

// ─────────────────────────────────────────────────────────────────────────────
// StatCard
// ─────────────────────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, color, c }: {
  icon: React.ReactNode; label: string; value: string; color: string; c: typeof neuColors.light;
}) {
  return (
    <NeuCard radius={18} style={{ flex: 1, padding: 14, gap: 6, minWidth: 0 }}>
      <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </View>
      <Text style={{ fontSize: 9, color: c.text, opacity: 0.4, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8 }} numberOfLines={1}>{label}</Text>
      <Text style={{ fontSize: 15, fontWeight: '800', color }} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </NeuCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section label
// ─────────────────────────────────────────────────────────────────────────────
function SL({ label, c }: { label: string; c: typeof neuColors.light }) {
  return (
    <Text style={{ fontSize: 9, fontWeight: '800', letterSpacing: 1.3, textTransform: 'uppercase', color: c.text, opacity: 0.3, marginBottom: 10, marginTop: 4 }}>
      {label}
    </Text>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Period toggle
// ─────────────────────────────────────────────────────────────────────────────
const PERIODS: { key: ChartPeriod; label: string }[] = [
  { key: 'daily',   label: 'Daily'   },
  { key: 'weekly',  label: 'Weekly'  },
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly',  label: 'Yearly'  },
];

function PeriodPicker({ value, onChange, c }: { value: ChartPeriod; onChange: (v: ChartPeriod) => void; c: typeof neuColors.light }) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: `${c.text}0A`, borderRadius: 12, padding: 3, marginBottom: 16 }}>
      {PERIODS.map(p => (
        <Pressable key={p.key} onPress={() => onChange(p.key)} style={{
          flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center',
          backgroundColor: value === p.key ? c.base : 'transparent',
          ...(value === p.key ? { shadowColor: c.shadowDark, shadowOffset: { width: 1, height: 1 }, shadowOpacity: 0.35, shadowRadius: 4 } : {}),
        }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: value === p.key ? c.primary : `${c.text}55` }}>{p.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Revenue Time-Series Chart
// ─────────────────────────────────────────────────────────────────────────────
function RevenueChart({ transactions, c }: { transactions: EarningsTransactionRow[]; c: typeof neuColors.light }) {
  const [period, setPeriod] = useState<ChartPeriod>('daily');
  const points = useMemo(() => bucketEarningsTimeSeries(transactions, period), [transactions, period]);
  const maxAbs = Math.max(...points.map(p => Math.abs(p.amount)), 1);

  return (
    <NeuCard radius={18} style={{ padding: 18, marginBottom: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <BarChart2 size={15} color={c.primary} />
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, flex: 1 }}>Revenue Timeline</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: '#16A34A' }} />
            <Text style={{ fontSize: 9, color: c.text, opacity: 0.4 }}>Income</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: '#DC2626' }} />
            <Text style={{ fontSize: 9, color: c.text, opacity: 0.4 }}>Deduction</Text>
          </View>
        </View>
      </View>
      <PeriodPicker value={period} onChange={setPeriod} c={c} />
      {points.length === 0 ? (
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.3, textAlign: 'center', paddingVertical: 24 }}>No data for this period</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 5, height: 110, paddingBottom: 20, minWidth: points.length * 32 }}>
            {points.map((p, i) => {
              const barH  = Math.max(4, (Math.abs(p.amount) / maxAbs) * 80);
              const color = p.isNegative ? '#DC2626' : '#16A34A';
              return (
                <View key={i} style={{ alignItems: 'center', gap: 3, width: 28 }}>
                  <Text style={{ fontSize: 7, color: c.text, opacity: 0.3, fontWeight: '600' }} numberOfLines={1}>
                    {Math.abs(p.amount) > 0 ? String(Math.round(Math.abs(p.amount))) : ''}
                  </Text>
                  <View style={{ width: 20, height: barH, borderRadius: 5, backgroundColor: `${color}CC` }} />
                  <Text style={{ fontSize: 8, color: c.text, opacity: 0.35, fontWeight: '600', textAlign: 'center' }} numberOfLines={1}>{p.label}</Text>
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}
    </NeuCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Balance Trend Chart — migrated from doctor-credit-timeline.tsx
// ─────────────────────────────────────────────────────────────────────────────
function BalanceTrendChart({ txRows, c }: { txRows: CreditRow[]; c: typeof neuColors.light }) {
  const chartData = useMemo(() => {
    const sorted = [...txRows].reverse();
    const last14 = sorted.slice(-14);
    const vals   = last14.map(r => r.balance_after ?? 0);
    const maxV   = Math.max(...vals, 1);
    const labels = last14.map(r => r.created_at.slice(8, 10));
    return { vals, maxV, labels };
  }, [txRows]);

  if (chartData.vals.length <= 1) return null;

  return (
    <>
      <SL label={`Balance Trend (Last ${chartData.vals.length} Transactions)`} c={c} />
      <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
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
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Course Revenue Table
// ─────────────────────────────────────────────────────────────────────────────
function CourseRevenueTable({ rows, total, c }: { rows: EarningsCourseRow[]; total: number; c: typeof neuColors.light }) {
  return (
    <NeuCard radius={18} style={{ overflow: 'hidden', marginBottom: 20 }}>
      <View style={{ flexDirection: 'row', paddingVertical: 10, paddingHorizontal: 14, backgroundColor: `${c.text}06`, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
        <Text style={{ flex: 1, fontSize: 9, fontWeight: '800', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.7 }}>Course</Text>
        <Text style={{ width: 44, textAlign: 'center', fontSize: 9, fontWeight: '800', color: c.text, opacity: 0.4, textTransform: 'uppercase' }}>Students</Text>
        <Text style={{ width: 60, textAlign: 'right', fontSize: 9, fontWeight: '800', color: c.text, opacity: 0.4, textTransform: 'uppercase' }}>Revenue</Text>
        <Text style={{ width: 32, textAlign: 'right', fontSize: 9, fontWeight: '800', color: c.text, opacity: 0.4, textTransform: 'uppercase' }}>%</Text>
      </View>
      {rows.map(r => (
        <View key={r.course_id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: `${c.text}06` }}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: c.text }} numberOfLines={1}>{r.course_title}</Text>
            <View style={{ height: 3, borderRadius: 2, backgroundColor: `${c.text}0D` }}>
              <View style={{ height: 3, borderRadius: 2, width: `${r.pct}%`, backgroundColor: r.revenue_egp >= 0 ? '#16A34A99' : '#DC262699' }} />
            </View>
          </View>
          <Text style={{ width: 44, textAlign: 'center', fontSize: 12, fontWeight: '600', color: `${c.text}77` }}>{r.students}</Text>
          <Text style={{ width: 60, textAlign: 'right', fontSize: 12, fontWeight: '700', color: r.revenue_egp >= 0 ? '#16A34A' : '#DC2626' }} numberOfLines={1}>{fmtEGPPlain(r.revenue_egp)}</Text>
          <Text style={{ width: 32, textAlign: 'right', fontSize: 11, fontWeight: '700', color: c.primary }}>{r.pct}%</Text>
        </View>
      ))}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, backgroundColor: `${c.primary}08`, borderTopWidth: 1.5, borderTopColor: `${c.primary}22` }}>
        <Text style={{ flex: 1, fontSize: 13, fontWeight: '800', color: c.primary }}>Total</Text>
        <Text style={{ width: 44, textAlign: 'center', fontSize: 12, fontWeight: '700', color: c.primary }}>{rows.reduce((s, r) => s + r.students, 0)}</Text>
        <Text style={{ width: 60, textAlign: 'right', fontSize: 13, fontWeight: '800', color: c.primary }} numberOfLines={1}>{fmtEGPPlain(total)}</Text>
        <Text style={{ width: 32, textAlign: 'right', fontSize: 11, fontWeight: '700', color: c.primary }}>100%</Text>
      </View>
    </NeuCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Earnings Transaction Row
// ─────────────────────────────────────────────────────────────────────────────
function EarningsTransactionRowUI({ row, onPress, c }: {
  row: EarningsTransactionRow; onPress: () => void; c: typeof neuColors.light;
}) {
  const isPositive = row.amount >= 0;
  const color = isPositive ? '#16A34A' : '#DC2626';
  const Icon  = isPositive ? ArrowUpRight : ArrowDownRight;

  return (
    <Pressable
      onPress={row.student_id ? onPress : undefined}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: `${c.text}06` }}
    >
      {row.student_avatar ? (
        <Image source={{ uri: row.student_avatar }} style={{ width: 38, height: 38, borderRadius: 12, marginRight: 12 }} />
      ) : (
        <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
          <Icon size={16} color={color} />
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }} numberOfLines={1}>{txDisplayName(row)}</Text>
        <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }} numberOfLines={1}>
          {row.course_title ?? '—'}{'  ·  '}{EARNINGS_TX_LABEL[row.transaction_type] ?? row.transaction_type}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: '800', color }}>{fmtEGP(row.amount)}</Text>
        <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>{fmtDateShort(row.created_at)}</Text>
      </View>
      {row.student_id && <ChevronRight size={14} color={`${c.text}30`} style={{ marginLeft: 4 }} />}
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Credit Ledger Timeline Row — migrated from doctor-credit-timeline.tsx
// ─────────────────────────────────────────────────────────────────────────────
function CreditTimelineRow({ tx, c, isLast }: { tx: CreditRow; c: typeof neuColors.light; isLast: boolean }) {
  const col  = CREDIT_TX_COLORS[tx.transaction_type] ?? '#6B7280';
  const sign = CREDIT_TX_SIGN[tx.transaction_type] ?? '';
  return (
    <View style={{ flexDirection: 'row', gap: 12, marginBottom: 10 }}>
      {/* Timeline dot + line */}
      <View style={{ alignItems: 'center', width: 16 }}>
        <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: col, marginTop: 4 }} />
        {!isLast && <View style={{ flex: 1, width: 2, backgroundColor: `${col}25`, marginTop: 2 }} />}
      </View>
      <NeuCard radius={14} style={{ flex: 1, padding: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, textTransform: 'capitalize' }}>
              {tx.transaction_type.replace(/_/g, ' ')}
            </Text>
            {tx.performed_by_name && (
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>By {tx.performed_by_name}</Text>
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
            {tx.course_title && (
              <Text style={{ fontSize: 10, color: c.text, opacity: 0.35, marginTop: 2 }}>
                Course: {tx.course_title}
              </Text>
            )}
            {tx.student_name && (
              <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>
                Student: {tx.student_name}
              </Text>
            )}
            <Text style={{ fontSize: 10, color: c.text, opacity: 0.3, marginTop: 3 }}>
              {fmtDateTime(tx.created_at)}
            </Text>
          </View>
          <Text style={{ fontSize: 18, fontWeight: '900', color: col, marginLeft: 8 }}>
            {sign}{Math.abs(tx.amount)}
          </Text>
        </View>
      </NeuCard>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// InfoRow helper for student profile modal
// ─────────────────────────────────────────────────────────────────────────────
function InfoRow({ icon, label, value, c }: {
  icon: React.ReactNode; label: string; value: string; c: typeof neuColors.light;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: `${c.primary}12`, alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 10, color: c.text, opacity: 0.4, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</Text>
        <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={2}>{value}</Text>
      </View>
    </View>
  );
}

function SectionLabel({ text, c }: { text: string; c: typeof neuColors.light }) {
  return (
    <Text style={{ fontSize: 10, fontWeight: '800', color: c.text, opacity: 0.35, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
      {text}
    </Text>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Student Profile Modal — read-only
// ─────────────────────────────────────────────────────────────────────────────
const PRICING_LABEL: Record<string, string> = {
  doctor_independent: 'Doctor Pricing',
  global:             'Global Price',
  per_student:        'Student Override',
};

function StudentProfileModal({ tx, doctorId, onClose, c }: {
  tx: EarningsTransactionRow; doctorId: string; onClose: () => void; c: typeof neuColors.light;
}) {
  const [profile,   setProfile]   = useState<DoctorStudentProfile | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [isDeleted, setIsDeleted] = useState(false);

  useMemo(() => {
    (async () => {
      setLoading(true);
      if (!tx.student_id) { setLoading(false); return; }
      try {
        const p = await getDoctorStudentProfile(doctorId, tx.student_id);
        if (p) { setProfile(p); setIsDeleted(p.account_status === 'trashed'); }
        else   { setIsDeleted(true); }
      } catch { setIsDeleted(true); }
      setLoading(false);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const displayName  = profile?.full_name    ?? tx.student_name               ?? '—';
  const displayPhone = profile?.phone        ?? tx.student_phone_snapshot     ?? tx.student_phone  ?? '—';
  const displayEmail = profile?.email        ?? tx.student_email_snapshot     ?? tx.student_email  ?? '—';
  const displayWmk   = profile?.watermark_id ?? tx.student_watermark_snapshot ?? '—';
  const displayJoin  = (!isDeleted && profile?.created_at) ? profile.created_at : null;

  const hasSuspended       = (profile?.enrollments ?? []).some(e => e.status === 'suspended');
  const accountStatus      = isDeleted ? 'Deleted' : hasSuspended ? 'Suspended' : 'Active';
  const accountStatusColor = isDeleted ? '#DC2626' : hasSuspended ? '#D97706' : '#16A34A';
  const pricingLabel       = PRICING_LABEL[tx.pricing_mode] ?? 'Doctor Pricing';
  const enStatusColor      = (s: string) => s === 'active' ? '#16A34A' : s === 'suspended' ? '#D97706' : '#DC2626';

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: c.base, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '92%' }}>
          <View style={{ alignItems: 'center', paddingTop: 12 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: `${c.text}20` }} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 10 }}>
            {profile?.avatar_url && !isDeleted ? (
              <Image source={{ uri: profile.avatar_url }} style={{ width: 48, height: 48, borderRadius: 14, marginRight: 12 }} />
            ) : (
              <View style={{ width: 48, height: 48, borderRadius: 14, marginRight: 12, backgroundColor: isDeleted ? '#DC262614' : `${c.primary}15`, alignItems: 'center', justifyContent: 'center' }}>
                <Users size={22} color={isDeleted ? '#DC2626' : c.primary} />
              </View>
            )}
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={{ fontSize: 17, fontWeight: '800', color: c.text }} numberOfLines={1}>{displayName}</Text>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <View style={{ backgroundColor: `${accountStatusColor}18`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 10, fontWeight: '800', color: accountStatusColor, textTransform: 'uppercase', letterSpacing: 0.6 }}>{accountStatus}</Text>
                </View>
                <View style={{ backgroundColor: `${c.text}08`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Eye size={9} color={`${c.text}50`} />
                  <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Read Only</Text>
                </View>
              </View>
            </View>
            <Pressable onPress={onClose} style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${c.text}0D`, alignItems: 'center', justifyContent: 'center' }}>
              <X size={16} color={c.text} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 48 }}>
            {loading ? (
              <ActivityIndicator color={c.primary} style={{ marginVertical: 48 }} />
            ) : (
              <>
                {isDeleted && (
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#DC262608', borderRadius: 14, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#DC262622' }}>
                    <Users size={15} color="#DC2626" style={{ marginTop: 1 }} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Account Permanently Deleted</Text>
                      <Text style={{ fontSize: 12, color: '#DC2626', opacity: 0.7, lineHeight: 18 }}>
                        This account no longer exists. The data below is the immutable snapshot recorded at transaction time.
                      </Text>
                    </View>
                  </View>
                )}
                <SectionLabel text={isDeleted ? 'Historical Snapshot' : 'Student Profile'} c={c} />
                <NeuCard radius={16} style={{ padding: 16, gap: 14, marginBottom: 16 }}>
                  <InfoRow icon={<Users    size={14} color={c.primary} />} label="Full Name"    value={displayName}  c={c} />
                  <InfoRow icon={<Phone    size={14} color={c.primary} />} label="Phone"        value={displayPhone} c={c} />
                  <InfoRow icon={<Mail     size={14} color={c.primary} />} label="Email"        value={displayEmail} c={c} />
                  <InfoRow icon={<Hash     size={14} color={c.primary} />} label="Watermark ID" value={displayWmk}   c={c} />
                  {displayJoin && <InfoRow icon={<Calendar size={14} color={c.primary} />} label="Joined" value={fmtDate(displayJoin)} c={c} />}
                </NeuCard>

                <SectionLabel text="Transaction Details" c={c} />
                <NeuCard radius={16} style={{ padding: 16, gap: 14, marginBottom: 16 }}>
                  <InfoRow icon={<BookOpen size={14} color={c.primary} />} label="Course" value={tx.course_title ?? '—'} c={c} />
                  <InfoRow icon={<Zap size={14} color={c.primary} />} label="Transaction Type" value={EARNINGS_TX_LABEL[tx.transaction_type] ?? tx.transaction_type} c={c} />
                  <InfoRow icon={<Calendar size={14} color={c.primary} />} label="Date" value={fmtDate(tx.created_at)} c={c} />
                  <InfoRow icon={<DollarSign size={14} color={tx.amount >= 0 ? '#16A34A' : '#DC2626'} />} label="Revenue"
                    value={`${tx.amount >= 0 ? '+' : '−'}EGP ${Math.abs(tx.amount).toLocaleString('en-EG')}`} c={c} />
                  {tx.price_snapshot > 0 && <InfoRow icon={<Award size={14} color={c.primary} />} label="Pricing Source" value={pricingLabel} c={c} />}
                  {tx.notes && <InfoRow icon={<Hash size={14} color={c.primary} />} label="Notes" value={tx.notes} c={c} />}
                </NeuCard>

                {!isDeleted && profile && profile.enrollments.length > 0 && (
                  <>
                    <SectionLabel text="Course Enrollments" c={c} />
                    {profile.enrollments.map(en => (
                      <NeuCard key={en.enrollment_id} radius={16} style={{ padding: 16, marginBottom: 12, gap: 12 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <BookOpen size={15} color={c.primary} />
                          <Text style={{ flex: 1, fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>{en.course_title}</Text>
                          <View style={{ backgroundColor: `${enStatusColor(en.status)}18`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                            <Text style={{ fontSize: 11, fontWeight: '700', color: enStatusColor(en.status), textTransform: 'capitalize' }}>{en.status}</Text>
                          </View>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <View style={{ flex: 1, backgroundColor: `${c.text}06`, borderRadius: 10, padding: 10, alignItems: 'center' }}>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: c.primary }}>{en.progress_percent}%</Text>
                            <Text style={{ fontSize: 9, color: c.text, opacity: 0.4 }}>Progress</Text>
                          </View>
                          <View style={{ flex: 1, backgroundColor: `${c.text}06`, borderRadius: 10, padding: 10, alignItems: 'center' }}>
                            <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.55 }}>{fmtDateShort(en.enrolled_at)}</Text>
                            <Text style={{ fontSize: 9, color: c.text, opacity: 0.4 }}>Enrolled</Text>
                          </View>
                          {en.assigned_price != null && (
                            <View style={{ flex: 1, backgroundColor: '#16A34A08', borderRadius: 10, padding: 10, alignItems: 'center' }}>
                              <Text style={{ fontSize: 13, fontWeight: '800', color: '#16A34A' }}>{fmtEGPPlain(en.assigned_price)}</Text>
                              <Text style={{ fontSize: 9, color: c.text, opacity: 0.4 }}>Revenue</Text>
                            </View>
                          )}
                        </View>
                      </NeuCard>
                    ))}
                  </>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────
export default function SADoctorEarnings() {
  const { doctor_id, doctor_name } = useLocalSearchParams<{ doctor_id: string; doctor_name?: string }>();
  const router = useRouter();
  const scheme = useColorScheme();
  const c      = scheme === 'dark' ? neuColors.dark : neuColors.light;

  // ── State ──────────────────────────────────────────────────────────────────
  const [earnings,   setEarnings]   = useState<DoctorEarningsDashboard | null>(null);
  const [creditRows, setCreditRows] = useState<CreditRow[]>([]);
  const [creditSum,  setCreditSum]  = useState<any>(null);
  const [actStats,   setActStats]   = useState<DoctorActivityStats | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [selectedTx, setSelectedTx] = useState<EarningsTransactionRow | null>(null);
  const [activeTab,  setActiveTab]  = useState<'earnings' | 'credits'>('earnings');

  // ── Revenue generated from credits — same formula as doctor-credit-timeline
  const creditRevenue = useMemo(() => {
    const unitPrice = actStats?.credit_selling_price ?? creditSum?.credit_selling_price ?? 0;
    const addTypes  = ['allocation', 'grant_admin', 'grant_super_admin'];
    return creditRows
      .filter(t => addTypes.includes(t.transaction_type))
      .reduce((s, t) => s + t.amount * unitPrice, 0);
  }, [creditRows, actStats, creditSum]);

  /**
   * Fetches ALL data in one parallel call — same functions used by doctor/admin views.
   * No separate calculations, no duplicated logic.
   */
  const loadData = useCallback(async () => {
    if (!doctor_id) { setLoading(false); return; }
    setError(null);
    try {
      const [earningsData, ledger, summary, stats] = await Promise.all([
        getDoctorEarningsDashboard(doctor_id),
        getCreditLedger({ doctorId: doctor_id, limit: 500 }),
        getDoctorCreditSummary(doctor_id),
        getDoctorActivityStats(doctor_id),
      ]);
      setEarnings(earningsData);
      setCreditRows(ledger as CreditRow[]);
      setCreditSum(summary);
      setActStats(stats);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load earnings data.');
    }
    setLoading(false);
  }, [doctor_id]);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    (async () => { await loadData(); })();
  }, [loadData]));

  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const decodedName = decodeURIComponent(doctor_name ?? 'Doctor');
  const hasData     = !loading && !error && (earnings || actStats || creditRows.length > 0);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      contentContainerStyle={{ paddingBottom: 60 }}
    >
      <View style={{ padding: 20 }}>

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20, marginTop: 12 }}>
          <Pressable onPress={() => router.back()}
            style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${c.text}0D`, alignItems: 'center', justifyContent: 'center' }}>
            <ChevronRight size={18} color={c.text} style={{ transform: [{ rotate: '180deg' }] }} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 }}>
              <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}>
                <TrendingUp size={16} color="#16A34A" />
              </View>
              <Text style={{ fontSize: 20, fontWeight: '800', color: c.text }} numberOfLines={1}>{decodedName}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 40 }}>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.38 }}>Earnings Dashboard</Text>
              <View style={{ backgroundColor: '#7C3AED12', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Eye size={9} color="#7C3AED" />
                <Text style={{ fontSize: 9, fontWeight: '800', color: '#7C3AED', textTransform: 'uppercase', letterSpacing: 0.6 }}>Read Only</Text>
              </View>
            </View>
          </View>
        </View>

        {/* ── Loading ─────────────────────────────────────────────────────── */}
        {loading && (
          <View style={{ alignItems: 'center', paddingVertical: 64 }}>
            <ActivityIndicator size="large" color={c.primary} />
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.35, marginTop: 14 }}>Loading earnings data…</Text>
          </View>
        )}

        {/* ── Error ───────────────────────────────────────────────────────── */}
        {!loading && error && (
          <NeuCard radius={18} style={{ padding: 28, alignItems: 'center', gap: 14 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#DC2626', textAlign: 'center' }}>Failed to load earnings</Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, textAlign: 'center' }}>{error}</Text>
            <Pressable onPress={() => { setLoading(true); loadData(); }}
              style={{ backgroundColor: c.primary, borderRadius: 10, paddingHorizontal: 24, paddingVertical: 11 }}>
              <Text style={{ color: '#fff', fontWeight: '700' }}>Retry</Text>
            </Pressable>
          </NeuCard>
        )}

        {hasData && (
          <>
            {/* ── Segmented Tab Bar ─────────────────────────────────────── */}
            <View style={{
              flexDirection: 'row', backgroundColor: `${c.text}0A`,
              borderRadius: 14, padding: 3, marginBottom: 20,
            }}>
              {([
                { key: 'earnings', label: 'Earnings',        icon: <TrendingUp size={13} color={activeTab === 'earnings' ? c.primary : `${c.text}55`} /> },
                { key: 'credits',  label: 'Credit Activity', icon: <CreditCard size={13} color={activeTab === 'credits'  ? c.primary : `${c.text}55`} /> },
              ] as const).map(tab => (
                <Pressable
                  key={tab.key}
                  onPress={() => setActiveTab(tab.key)}
                  style={{
                    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                    gap: 6, paddingVertical: 10, borderRadius: 11,
                    backgroundColor: activeTab === tab.key ? c.base : 'transparent',
                    ...(activeTab === tab.key ? {
                      shadowColor: c.shadowDark,
                      shadowOffset: { width: 1, height: 1 },
                      shadowOpacity: 0.35,
                      shadowRadius: 4,
                    } : {}),
                  }}
                >
                  {tab.icon}
                  <Text style={{
                    fontSize: 12, fontWeight: '700',
                    color: activeTab === tab.key ? c.primary : `${c.text}55`,
                  }}>
                    {tab.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* ════════════════════════════════════════════════════════════
                TAB 1 — EARNINGS
            ════════════════════════════════════════════════════════════ */}
            {activeTab === 'earnings' && (
              <>
                {earnings ? (
                  <>
                    <SL label="Earnings Overview" c={c} />
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
                      <View style={{ width: '47%' }}>
                        <StatCard icon={<DollarSign size={15} color="#16A34A" />} label="Total Revenue"         value={fmtEGPPlain(earnings.totalRevenue)}       color="#16A34A" c={c} />
                      </View>
                      <View style={{ width: '47%' }}>
                        <StatCard icon={<Calendar   size={15} color={c.primary} />} label="This Month"          value={fmtEGPPlain(earnings.thisMonthRevenue)}   color={c.primary} c={c} />
                      </View>
                      <View style={{ width: '47%' }}>
                        <StatCard icon={<Users      size={15} color="#D97706" />} label="Paid Students"         value={String(earnings.totalPaidStudents)}        color="#D97706" c={c} />
                      </View>
                      <View style={{ width: '47%' }}>
                        <StatCard icon={<Zap        size={15} color="#7C3AED" />} label="Transactions"          value={String(earnings.totalTransactions)}        color="#7C3AED" c={c} />
                      </View>
                      <View style={{ width: '100%' }}>
                        <StatCard icon={<Award      size={15} color="#2DA8FF" />} label="Avg Revenue / Student" value={fmtEGPPlain(earnings.avgRevenuePerStudent)} color="#2DA8FF" c={c} />
                      </View>
                    </View>

                    <SL label="Revenue Timeline" c={c} />
                    <RevenueChart transactions={earnings.transactions} c={c} />

                    <SL label="Revenue by Course" c={c} />
                    <CourseRevenueTable rows={earnings.courseRows} total={earnings.totalRevenue} c={c} />

                    <SL label="Recent Transactions" c={c} />
                    <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
                      {earnings.transactions.length === 0 ? (
                        <Text style={{ fontSize: 13, color: c.text, opacity: 0.3, textAlign: 'center', paddingVertical: 20 }}>No transactions yet</Text>
                      ) : (
                        earnings.transactions.map(row => (
                          <EarningsTransactionRowUI key={row.id} row={row} c={c} onPress={() => setSelectedTx(row)} />
                        ))
                      )}
                    </NeuCard>
                  </>
                ) : (
                  <View style={{ alignItems: 'center', paddingVertical: 48, gap: 12 }}>
                    <NeuCard radius={24} style={{ width: 64, height: 64, alignItems: 'center', justifyContent: 'center' }}>
                      <TrendingUp size={28} color={`${c.text}30`} />
                    </NeuCard>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, opacity: 0.35 }}>No Earnings Yet</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.22, textAlign: 'center', maxWidth: 240, lineHeight: 18 }}>
                      No revenue transactions have been recorded for this doctor.
                    </Text>
                  </View>
                )}
              </>
            )}

            {/* ════════════════════════════════════════════════════════════
                TAB 2 — CREDIT ACTIVITY
            ════════════════════════════════════════════════════════════ */}
            {activeTab === 'credits' && (
              <>
                {/* Credit Activity Stats (getDoctorActivityStats) */}
                {actStats && (
                  <>
                    <SL label="Credit Activity" c={c} />

                    {/* Credit Selling Price */}
                    <NeuCard radius={18} style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 10 }}>
                      <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: '#7C3AED18', alignItems: 'center', justifyContent: 'center' }}>
                        <DollarSign size={22} color="#7C3AED" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Credit Selling Price</Text>
                        <Text style={{ fontSize: 26, fontWeight: '900', color: '#7C3AED' }}>
                          EGP {actStats.credit_selling_price.toLocaleString()}
                        </Text>
                        <Text style={{ fontSize: 11, color: c.text, opacity: 0.35, marginTop: 1 }}>per credit</Text>
                      </View>
                    </NeuCard>

                    {/* Activity KPIs grid */}
                    <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                      {[
                        { label: 'Total Allocated',  value: actStats.total_allocated,   color: c.primary },
                        { label: 'Credits Used',      value: actStats.total_used,        color: '#DC2626' },
                        { label: 'Remaining Credits', value: actStats.remaining_credits, color: '#16A34A' },
                        { label: 'Courses Sold',      value: actStats.courses_sold,      color: '#2DA8FF' },
                        { label: 'Students Enrolled', value: actStats.students_enrolled, color: '#7C3AED' },
                        { label: 'Videos Uploaded',   value: actStats.videos_uploaded,   color: '#D97706' },
                      ].map(kpi => (
                        <NeuCard key={kpi.label} radius={16} style={{ flexBasis: '47%', padding: 14, alignItems: 'center' }}>
                          <Text style={{ fontSize: 24, fontWeight: '900', color: kpi.color }}>{kpi.value}</Text>
                          <Text style={{ fontSize: 10, color: c.text, opacity: 0.45, textAlign: 'center', marginTop: 2 }}>{kpi.label}</Text>
                        </NeuCard>
                      ))}
                    </View>

                    {/* Total Earnings from credits */}
                    <NeuCard radius={18} style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 10 }}>
                      <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}>
                        <TrendingUp size={20} color="#16A34A" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Credit-Based Earnings</Text>
                        <Text style={{ fontSize: 20, fontWeight: '900', color: '#16A34A' }}>
                          EGP {actStats.total_earnings.toLocaleString()}
                        </Text>
                        <Text style={{ fontSize: 11, color: c.text, opacity: 0.35 }}>
                          {actStats.total_used} credits × EGP {actStats.credit_selling_price}
                        </Text>
                      </View>
                    </NeuCard>

                    {/* Last Login / Last Activity */}
                    <NeuCard radius={18} style={{ padding: 14, marginBottom: 20, gap: 8 }}>
                      {[
                        { label: 'Last Login',    value: actStats.last_login  },
                        { label: 'Last Activity', value: actStats.last_active },
                      ].map(row => (
                        <View key={row.label} style={{ flexDirection: 'row', alignItems: 'center' }}>
                          <Clock size={14} color={c.text} opacity={0.4} style={{ marginRight: 8 }} />
                          <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, width: 100 }}>{row.label}</Text>
                          <Text style={{ fontSize: 12, color: c.text, flex: 1 }}>
                            {row.value ? fmtDateTime(row.value) : '—'}
                          </Text>
                        </View>
                      ))}
                    </NeuCard>
                  </>
                )}

                {/* Credit Ledger Summary (getDoctorCreditSummary) */}
                {creditSum && (
                  <>
                    <SL label="Credit Ledger Summary" c={c} />
                    <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                      {[
                        { label: 'Current Balance',   value: creditSum.current_balance ?? 0, color: '#16A34A'  },
                        { label: 'Credits Added',      value: creditSum.total_received  ?? 0, color: c.primary  },
                        { label: 'Credits Used',       value: creditSum.total_used      ?? 0, color: '#DC2626'  },
                        { label: 'Credits Removed',    value: creditSum.total_removed   ?? 0, color: '#D97706'  },
                        {
                          label: 'Courses Activated',
                          value: new Set(creditRows.filter(t => t.transaction_type === 'consumption' && t.course_title).map(t => t.course_title)).size,
                          color: '#7C3AED',
                        },
                        {
                          label: 'Students Activated',
                          value: new Set(creditRows.filter(t => t.transaction_type === 'consumption' && t.student_name).map(t => t.student_name)).size,
                          color: '#2DA8FF',
                        },
                      ].map(kpi => (
                        <NeuCard key={kpi.label} radius={16} style={{ flexBasis: '47%', padding: 14, alignItems: 'center' }}>
                          <Text style={{ fontSize: 24, fontWeight: '900', color: kpi.color }}>{kpi.value}</Text>
                          <Text style={{ fontSize: 10, color: c.text, opacity: 0.45, textAlign: 'center', marginTop: 2 }}>{kpi.label}</Text>
                        </NeuCard>
                      ))}
                    </View>

                    {/* Revenue generated from credit allocations */}
                    <NeuCard radius={18} style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                      <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}>
                        <DollarSign size={20} color="#16A34A" />
                      </View>
                      <View>
                        <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Revenue from Credit Sales</Text>
                        <Text style={{ fontSize: 20, fontWeight: '900', color: '#16A34A' }}>
                          EGP {creditRevenue.toLocaleString()}
                        </Text>
                      </View>
                    </NeuCard>
                  </>
                )}

                {/* Balance Trend Chart */}
                <BalanceTrendChart txRows={creditRows} c={c} />

                {/* Credit Ledger Timeline */}
                {creditRows.length > 0 ? (
                  <>
                    <SL label={`Credit History (${creditRows.length})`} c={c} />
                    {creditRows.map((tx, idx) => (
                      <CreditTimelineRow key={tx.id} tx={tx} c={c} isLast={idx === creditRows.length - 1} />
                    ))}
                  </>
                ) : (
                  !actStats && !creditSum && (
                    <View style={{ alignItems: 'center', paddingVertical: 48, gap: 12 }}>
                      <NeuCard radius={24} style={{ width: 64, height: 64, alignItems: 'center', justifyContent: 'center' }}>
                        <CreditCard size={28} color={`${c.text}30`} />
                      </NeuCard>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, opacity: 0.35 }}>No Credit Activity</Text>
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.22, textAlign: 'center', maxWidth: 240, lineHeight: 18 }}>
                        No credit transactions have been recorded for this doctor.
                      </Text>
                    </View>
                  )
                )}
              </>
            )}

            {/* Data source note — shown on both tabs */}
            <NeuCard radius={14} style={{ padding: 14, marginTop: 8, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
              <Eye size={14} color={`${c.text}40`} style={{ marginTop: 1 }} />
              <Text style={{ flex: 1, fontSize: 11, color: c.text, opacity: 0.4, lineHeight: 17 }}>
                {"All data uses the exact same sources as the doctor's own dashboards — identical queries, calculations, and totals. Super Admin view is read-only."}
              </Text>
            </NeuCard>
          </>
        )}
      </View>

      {/* Student profile modal */}
      {selectedTx && doctor_id && (
        <StudentProfileModal tx={selectedTx} doctorId={doctor_id} c={c} onClose={() => setSelectedTx(null)} />
      )}
    </ScrollView>
  );
}
