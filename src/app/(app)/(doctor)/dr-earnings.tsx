/**
 * DoctorEarnings — standalone route kept for back-compat.
 * The earnings dashboard is now embedded inside dr-profile.tsx (Earnings tab).
 * This file is intentionally minimal — it no longer contains business logic.
 *
 * Revenue source : doctor_earnings_events.earnings_amount
 * Pricing        : doctor_global_price (global) → course publish price (fallback)
 * Platform price : NEVER used — completely independent financial system
 */
import { useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  RefreshControl, TextInput, Switch, Modal, useColorScheme,
} from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import {
  TrendingUp, DollarSign, Users, BarChart2,
  Zap, Calendar, ArrowUpRight, ArrowDownRight,
  X, Phone, Mail, Hash, BookOpen, AlertTriangle,
  RotateCcw, UserMinus, Settings, ChevronRight,
  Check, Edit3, Trash2,
} from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import {
  getDoctorEarningsDashboard, updateProfile,
  bucketEarningsTimeSeries,
  getDoctorStudentProfile,
  getDoctorPricingSettings,
  setDoctorGlobalPrice,
  suspendStudentCourseAccess,
  restoreStudentCourseAccess,
  removeStudentFromCourseWithRefund,
  recalculateDoctorEarnings,
  resetDoctorEarnings,
  type DoctorEarningsDashboard,
  type EarningsTransactionRow,
  type EarningsCourseRow,
  type DoctorStudentProfile,
  type DoctorPricingSettings,
} from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { useToast } from '@/components/Toast';
import { neuColors } from '@/lib/neu';
import HamburgerButton from '@/components/HamburgerButton';


// ─────────────────────────────────────────────────────────────────────────────
// Helpers
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

const TX_LABEL: Record<string, string> = {
  purchase:          'Purchase',
  removal:           'Course Removal',
  suspension_refund: 'Refund',
  adjustment:        'Adjustment',
  account_deletion:  'Account Deleted',
};

// For account_deletion rows the student name is stored as the name at deletion time;
// display as 'Deleted Account' regardless since the account no longer exists.
function txDisplayName(row: EarningsTransactionRow): string {
  if (row.transaction_type === 'account_deletion') return 'Deleted Account';
  return row.student_name ?? 'Deleted Account';
}

type ChartPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

// ─────────────────────────────────────────────────────────────────────────────
// EarningsToggleCard
// ─────────────────────────────────────────────────────────────────────────────
function EarningsToggleCard({
  enabled, toggling, onToggle, c,
}: { enabled: boolean; toggling: boolean; onToggle: (v: boolean) => void; c: typeof neuColors.light }) {
  return (
    <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: enabled ? '#16A34A18' : `${c.text}0D`, alignItems: 'center', justifyContent: 'center' }}>
          <TrendingUp size={20} color={enabled ? '#16A34A' : `${c.text}44`} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>Earnings System</Text>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 2 }}>
            {enabled ? 'Active — tracking revenue independently' : 'Disabled — enable to track revenue'}
          </Text>
        </View>
        {toggling
          ? <ActivityIndicator size="small" color={c.primary} />
          : <Switch value={enabled} onValueChange={onToggle} trackColor={{ false: `${c.text}20`, true: '#16A34A55' }} thumbColor={enabled ? '#16A34A' : `${c.text}55`} />}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: `${c.text}08` }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: enabled ? '#16A34A' : `${c.text}33` }} />
        <Text style={{ fontSize: 11, fontWeight: '600', color: enabled ? '#16A34A' : `${c.text}44` }}>
          {enabled ? 'Earnings system is ON' : 'Earnings system is OFF'}
        </Text>
      </View>
    </NeuCard>
  );
}

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
  const maxAbs  = Math.max(...points.map(p => Math.abs(p.amount)), 1);

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
// Transaction Row — shows avatar, full name, course, amount (green/red)
// ─────────────────────────────────────────────────────────────────────────────
function TransactionRow({ row, onPress, c }: {
  row: EarningsTransactionRow; onPress: () => void; c: typeof neuColors.light;
}) {
  const isPositive = row.amount >= 0;
  const color      = isPositive ? '#16A34A' : '#DC2626';
  const Icon       = isPositive ? ArrowUpRight : ArrowDownRight;
  const isLegacy   = false; // snapshots now guarantee all rows have display data

  return (
    <Pressable
      onPress={!isLegacy ? onPress : undefined}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
               borderBottomWidth: 1, borderBottomColor: `${c.text}06` }}
    >
      {/* Avatar or icon */}
      {row.student_avatar ? (
        <Image
          source={{ uri: row.student_avatar }}
          style={{ width: 38, height: 38, borderRadius: 12, marginRight: 12 }}
        />
      ) : (
        <View style={{ width: 38, height: 38, borderRadius: 12,
                       backgroundColor: `${color}18`, alignItems: 'center',
                       justifyContent: 'center', marginRight: 12 }}>
          <Icon size={16} color={color} />
        </View>
      )}

      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }} numberOfLines={1}>
          {txDisplayName(row)}
        </Text>
        <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }} numberOfLines={1}>
          {row.course_title ?? '—'}{'  ·  '}{TX_LABEL[row.transaction_type] ?? row.transaction_type}
        </Text>
      </View>

      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: '800', color }}>{fmtEGP(row.amount)}</Text>
        <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>{fmtDateShort(row.created_at)}</Text>
      </View>

      {!isLegacy && <ChevronRight size={14} color={`${c.text}30`} style={{ marginLeft: 4 }} />}
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Student Profile Modal  (action-only — no per-student price override)
// ─────────────────────────────────────────────────────────────────────────────
const PRICING_LABEL: Record<string, string> = {
  doctor_independent: 'Doctor Pricing',
  global:             'Global Price',
  per_student:        'Student Override',
};

function InfoRow({ icon, label, value, c }: {
  icon: React.ReactNode; label: string; value: string; c: typeof neuColors.light;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: `${c.primary}12`,
                     alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 10, color: c.text, opacity: 0.4, fontWeight: '700',
                       textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</Text>
        <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={2}>{value}</Text>
      </View>
    </View>
  );
}

function SectionLabel({ text, c }: { text: string; c: typeof neuColors.light }) {
  return (
    <Text style={{ fontSize: 10, fontWeight: '800', color: c.text, opacity: 0.35,
                   textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
      {text}
    </Text>
  );
}

function StudentProfileModal({ tx, doctorId, onClose, onAction, c }: {
  tx: EarningsTransactionRow; doctorId: string;
  onClose: () => void; onAction: () => void; c: typeof neuColors.light;
}) {
  const [profile,       setProfile]       = useState<DoctorStudentProfile | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [isDeleted,     setIsDeleted]     = useState(false);
  const [acting,        setActing]        = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ enrollmentId: string; courseTitle: string } | null>(null);
  const { showToast } = useToast();

  const loadProfile = useCallback(async () => {
    setLoading(true);
    if (!tx.student_id) { setLoading(false); return; }
    try {
      const p = await getDoctorStudentProfile(doctorId, tx.student_id);
      if (p) {
        setProfile(p);
        // account_status === 'trashed' means the account is soft-deleted
        setIsDeleted(p.account_status === 'trashed');
      } else {
        // Hard-deleted row — extremely rare, treat as deleted
        setIsDeleted(true);
      }
    } catch { setIsDeleted(true); }
    setLoading(false);
  }, [tx.student_id, doctorId]);

  useMemo(() => { (async () => loadProfile())(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const handleAction = async (
    action: 'suspend' | 'restore' | 'remove',
    enrollmentId: string, courseId: string, courseTitle: string,
  ) => {
    setActing(`${action}-${enrollmentId}`);
    try {
      if (action === 'suspend') {
        await suspendStudentCourseAccess(enrollmentId);
        showToast({ type: 'success', message: 'Access suspended. Revenue preserved.' });
        await loadProfile();
      } else if (action === 'restore') {
        await restoreStudentCourseAccess(enrollmentId);
        showToast({ type: 'success', message: 'Access restored.' });
        await loadProfile();
      } else {
        await removeStudentFromCourseWithRefund({
          doctorId, enrollmentId,
          studentNameSnapshot: tx.student_name ?? '',
          courseNameSnapshot:  courseTitle,
        });
        showToast({ type: 'success', message: 'Student removed. Revenue deducted.' });
        onClose(); onAction(); return;
      }
    } catch (e: any) { showToast({ type: 'error', message: e?.message ?? 'Action failed.' }); }
    setActing(null);
  };

  const enStatusColor = (s: string) =>
    s === 'active' ? '#16A34A' : s === 'suspended' ? '#D97706' : '#DC2626';

  const displayName  = profile?.full_name    ?? tx.student_name               ?? '—';
  const displayPhone = profile?.phone        ?? tx.student_phone_snapshot     ?? tx.student_phone  ?? '—';
  const displayEmail = profile?.email        ?? tx.student_email_snapshot     ?? tx.student_email  ?? '—';
  const displayWmk   = profile?.watermark_id ?? tx.student_watermark_snapshot ?? '—';
  const displayJoin  = (!isDeleted && profile?.created_at) ? profile.created_at : null;

  const hasSuspended       = (profile?.enrollments ?? []).some(e => e.status === 'suspended');
  const accountStatus      = isDeleted ? 'Deleted' : hasSuspended ? 'Suspended' : 'Active';
  const accountStatusColor = isDeleted ? '#DC2626' : hasSuspended ? '#D97706' : '#16A34A';
  const pricingLabel       = PRICING_LABEL[tx.pricing_mode] ?? 'Doctor Pricing';

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: c.base, borderTopLeftRadius: 28,
                       borderTopRightRadius: 28, maxHeight: '92%' }}>
          <View style={{ alignItems: 'center', paddingTop: 12 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: `${c.text}20` }} />
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center',
                         paddingHorizontal: 20, paddingTop: 14, paddingBottom: 10 }}>
            <View style={{ width: 48, height: 48, borderRadius: 14, marginRight: 12,
                           backgroundColor: isDeleted ? '#DC262614' : `${c.primary}15`,
                           alignItems: 'center', justifyContent: 'center' }}>
              {isDeleted ? <Trash2 size={22} color="#DC2626" /> : <Users size={22} color={c.primary} />}
            </View>
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={{ fontSize: 17, fontWeight: '800', color: c.text }} numberOfLines={1}>
                {displayName}
              </Text>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <View style={{ backgroundColor: `${accountStatusColor}18`, borderRadius: 8,
                               paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 10, fontWeight: '800', color: accountStatusColor,
                                 textTransform: 'uppercase', letterSpacing: 0.6 }}>{accountStatus}</Text>
                </View>
                <View style={{ backgroundColor: `${c.text}0A`, borderRadius: 8,
                               paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.5,
                                 textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {TX_LABEL[tx.transaction_type] ?? tx.transaction_type}
                  </Text>
                </View>
              </View>
            </View>
            <Pressable onPress={onClose}
              style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${c.text}0D`,
                       alignItems: 'center', justifyContent: 'center' }}>
              <X size={16} color={c.text} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 48 }}>
            {loading ? (
              <ActivityIndicator color={c.primary} style={{ marginVertical: 48 }} />
            ) : (
              <>
                {isDeleted && (
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10,
                                 backgroundColor: '#DC262608', borderRadius: 14, padding: 14,
                                 marginBottom: 16, borderWidth: 1, borderColor: '#DC262622' }}>
                    <Trash2 size={15} color="#DC2626" style={{ marginTop: 1 }} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>
                        Account Permanently Deleted
                      </Text>
                      <Text style={{ fontSize: 12, color: '#DC2626', opacity: 0.7, lineHeight: 18 }}>
                        Immutable snapshot recorded at transaction time.
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
                  {displayJoin && (
                    <InfoRow icon={<Calendar size={14} color={c.primary} />} label="Joined" value={fmtDate(displayJoin)} c={c} />
                  )}
                </NeuCard>

                <SectionLabel text="Transaction Details" c={c} />
                <NeuCard radius={16} style={{ padding: 16, gap: 14, marginBottom: 16 }}>
                  <InfoRow icon={<BookOpen size={14} color={c.primary} />}
                    label="Course" value={tx.course_title ?? '—'} c={c} />
                  <InfoRow icon={<Zap size={14} color={c.primary} />}
                    label="Transaction Type" value={TX_LABEL[tx.transaction_type] ?? tx.transaction_type} c={c} />
                  <InfoRow icon={<Calendar size={14} color={c.primary} />}
                    label="Date" value={fmtDate(tx.created_at)} c={c} />
                  <InfoRow
                    icon={<DollarSign size={14} color={tx.amount >= 0 ? '#16A34A' : '#DC2626'} />}
                    label="Revenue"
                    value={`${tx.amount >= 0 ? '+' : '−'}EGP ${Math.abs(tx.amount).toLocaleString('en-EG')}`}
                    c={c} />
                  {tx.price_snapshot > 0 && (
                    <InfoRow icon={<Settings size={14} color={c.primary} />}
                      label="Pricing Source" value={pricingLabel} c={c} />
                  )}
                  {tx.notes && (
                    <InfoRow icon={<Hash size={14} color={c.primary} />} label="Notes" value={tx.notes} c={c} />
                  )}
                </NeuCard>

                {!isDeleted && profile && (
                  <>
                    <SectionLabel text="Course Enrollments" c={c} />
                    {profile.enrollments.length === 0 ? (
                      <NeuCard radius={16} style={{ padding: 20, alignItems: 'center', gap: 8, marginBottom: 16 }}>
                        <BookOpen size={22} color={`${c.text}30`} />
                        <Text style={{ fontSize: 13, color: c.text, opacity: 0.3, textAlign: 'center' }}>
                          No enrollments on your courses.
                        </Text>
                      </NeuCard>
                    ) : profile.enrollments.map(en => (
                      <NeuCard key={en.enrollment_id} radius={16} style={{ padding: 16, marginBottom: 12, gap: 12 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <BookOpen size={15} color={c.primary} />
                          <Text style={{ flex: 1, fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>
                            {en.course_title}
                          </Text>
                          <View style={{ backgroundColor: `${enStatusColor(en.status)}18`,
                                         borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                            <Text style={{ fontSize: 11, fontWeight: '700',
                                           color: enStatusColor(en.status), textTransform: 'capitalize' }}>
                              {en.status}
                            </Text>
                          </View>
                        </View>

                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <View style={{ flex: 1, backgroundColor: `${c.text}06`, borderRadius: 10,
                                         padding: 10, alignItems: 'center' }}>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: c.primary }}>
                              {en.progress_percent}%
                            </Text>
                            <Text style={{ fontSize: 9, color: c.text, opacity: 0.4 }}>Progress</Text>
                          </View>
                          <View style={{ flex: 1, backgroundColor: `${c.text}06`, borderRadius: 10,
                                         padding: 10, alignItems: 'center' }}>
                            <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.55 }}>
                              {fmtDateShort(en.enrolled_at)}
                            </Text>
                            <Text style={{ fontSize: 9, color: c.text, opacity: 0.4 }}>Enrolled</Text>
                          </View>
                        </View>

                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          {en.status === 'active' && (
                            <Pressable
                              onPress={() => handleAction('suspend', en.enrollment_id, en.course_id, en.course_title)}
                              disabled={!!acting}
                              style={{ flex: 1, flexDirection: 'row', alignItems: 'center',
                                       justifyContent: 'center', gap: 6,
                                       backgroundColor: '#D9770618', borderRadius: 10, paddingVertical: 10 }}>
                              {acting === `suspend-${en.enrollment_id}`
                                ? <ActivityIndicator size="small" color="#D97706" />
                                : <AlertTriangle size={13} color="#D97706" />}
                              <Text style={{ fontSize: 12, fontWeight: '700', color: '#D97706' }}>Suspend</Text>
                            </Pressable>
                          )}
                          {en.status === 'suspended' && (
                            <Pressable
                              onPress={() => handleAction('restore', en.enrollment_id, en.course_id, en.course_title)}
                              disabled={!!acting}
                              style={{ flex: 1, flexDirection: 'row', alignItems: 'center',
                                       justifyContent: 'center', gap: 6,
                                       backgroundColor: '#16A34A18', borderRadius: 10, paddingVertical: 10 }}>
                              {acting === `restore-${en.enrollment_id}`
                                ? <ActivityIndicator size="small" color="#16A34A" />
                                : <RotateCcw size={13} color="#16A34A" />}
                              <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>Resume</Text>
                            </Pressable>
                          )}
                          <Pressable
                            onPress={() => setConfirmRemove({ enrollmentId: en.enrollment_id, courseTitle: en.course_title })}
                            disabled={!!acting}
                            style={{ flex: 1, flexDirection: 'row', alignItems: 'center',
                                     justifyContent: 'center', gap: 6,
                                     backgroundColor: '#DC262618', borderRadius: 10, paddingVertical: 10 }}>
                            {acting === `remove-${en.enrollment_id}`
                              ? <ActivityIndicator size="small" color="#DC2626" />
                              : <UserMinus size={13} color="#DC2626" />}
                            <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>Remove</Text>
                          </Pressable>
                        </View>

                        {confirmRemove?.enrollmentId === en.enrollment_id && (
                          <View style={{ backgroundColor: '#DC262610', borderRadius: 12, padding: 14,
                                         borderWidth: 1, borderColor: '#DC262625', gap: 10 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                              <AlertTriangle size={15} color="#DC2626" style={{ marginTop: 1 }} />
                              <Text style={{ flex: 1, fontSize: 12, color: '#DC2626', lineHeight: 18 }}>
                                Remove {displayName} from {en.course_title}?{'\n'}
                                A negative earnings entry will be created. This cannot be undone.
                              </Text>
                            </View>
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                              <Pressable onPress={() => setConfirmRemove(null)}
                                style={{ flex: 1, alignItems: 'center', justifyContent: 'center',
                                         backgroundColor: `${c.text}0D`, borderRadius: 10, paddingVertical: 9 }}>
                                <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.6 }}>Cancel</Text>
                              </Pressable>
                              <Pressable
                                onPress={() => { setConfirmRemove(null); handleAction('remove', en.enrollment_id, en.course_id, en.course_title); }}
                                disabled={!!acting}
                                style={{ flex: 2, flexDirection: 'row', alignItems: 'center',
                                         justifyContent: 'center', gap: 6,
                                         backgroundColor: '#DC2626', borderRadius: 10, paddingVertical: 9 }}>
                                {acting === `remove-${en.enrollment_id}`
                                  ? <ActivityIndicator size="small" color="#fff" />
                                  : <UserMinus size={13} color="#fff" />}
                                <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>Confirm Remove</Text>
                              </Pressable>
                            </View>
                          </View>
                        )}
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
// Global Price + Admin Tools card
// ─────────────────────────────────────────────────────────────────────────────
function PricingSettingsSection({
  doctorId, c, onRecalculate,
}: {
  doctorId: string; c: typeof neuColors.light;
  onRecalculate?: () => void;
}) {
  const [settings,         setSettings]         = useState<DoctorPricingSettings | null>(null);
  const [loading,          setLoading]           = useState(true);
  const [saving,           setSaving]            = useState<string | null>(null);
  const [expanded,         setExpanded]          = useState(false);
  const [globalRaw,        setGlobalRaw]         = useState('');
  const [editingGlobal,    setEditingGlobal]     = useState(false);
  const [showResetConfirm, setShowResetConfirm]  = useState(false);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    try {
      const s = await getDoctorPricingSettings(doctorId);
      setSettings(s);
    } catch { /* silent */ }
    setLoading(false);
  }, [doctorId]);

  useMemo(() => { (async () => load())(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveGlobal = async () => {
    if (!settings) return;
    const p = globalRaw.trim() === '' ? 0 : Number(globalRaw);
    if (isNaN(p)) return;
    setSaving('global');
    try {
      await setDoctorGlobalPrice(doctorId, p);
      setSettings({ ...settings, doctor_global_price: p });
      setEditingGlobal(false);
      showToast({ type: 'success', message: p === 0 ? 'Global price cleared — course price will be used as fallback.' : 'Global earnings price updated.' });
    } catch (e: any) { showToast({ type: 'error', message: e?.message ?? 'Failed.' }); }
    setSaving(null);
  };

  const handleRecalculate = async () => {
    setSaving('recalculate');
    try {
      const { corrections } = await recalculateDoctorEarnings(doctorId);
      showToast({
        type: 'success',
        message: corrections > 0
          ? `Earnings recalculated. ${corrections} correction${corrections !== 1 ? 's' : ''} applied.`
          : 'Earnings verified. No corrections needed.',
      });
      onRecalculate?.();
    } catch (e: any) { showToast({ type: 'error', message: e?.message ?? 'Recalculate failed.' }); }
    setSaving(null);
  };

  const handleReset = async () => {
    setShowResetConfirm(false);
    setSaving('reset');
    try {
      const { rebuilt } = await resetDoctorEarnings(doctorId);
      showToast({
        type: 'success',
        message: `Earnings reset. ${rebuilt} active student${rebuilt !== 1 ? 's' : ''} rebuilt from scratch.`,
      });
      onRecalculate?.();
    } catch (e: any) { showToast({ type: 'error', message: e?.message ?? 'Reset failed.' }); }
    setSaving(null);
  };

  return (
    <NeuCard radius={18} style={{ marginBottom: 20, overflow: 'hidden' }}>
      <Pressable onPress={() => setExpanded(v => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 }}>
        <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${c.primary}15`,
                       alignItems: 'center', justifyContent: 'center' }}>
          <Settings size={18} color={c.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>Pricing & Admin Tools</Text>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, marginTop: 2 }}>
            {settings
              ? settings.doctor_global_price > 0
                ? `Global: ${fmtEGPPlain(settings.doctor_global_price)} per enrollment`
                : 'Fallback: course publish price'
              : 'Tap to configure your earnings price'}
          </Text>
        </View>
        <ChevronRight size={16} color={`${c.text}40`}
          style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }} />
      </Pressable>

      {expanded && (
        <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 16,
                       borderTopWidth: 1, borderTopColor: `${c.text}08`, paddingTop: 16 }}>
          {loading ? <ActivityIndicator color={c.primary} /> : !settings ? null : (
            <>
              {/* ── Global earnings price ───────────────────────────── */}
              <View style={{ gap: 8 }}>
                <Text style={{ fontSize: 10, fontWeight: '800', color: c.text, opacity: 0.4,
                               textTransform: 'uppercase', letterSpacing: 0.8 }}>
                  Global Earnings Price
                </Text>
                {editingGlobal ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <TextInput
                      value={globalRaw} onChangeText={setGlobalRaw} keyboardType="numeric"
                      autoFocus returnKeyType="done" onSubmitEditing={saveGlobal}
                      placeholder="0"
                      style={{ flex: 1, minWidth: 0, backgroundColor: `${c.text}08`, borderRadius: 10,
                               paddingHorizontal: 12, paddingVertical: 8, fontSize: 14,
                               fontWeight: '700', color: c.text, borderWidth: 1.5, borderColor: c.primary }}
                    />
                    <Pressable onPress={saveGlobal} disabled={saving === 'global'}
                      style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: '#16A34A',
                               alignItems: 'center', justifyContent: 'center' }}>
                      {saving === 'global' ? <ActivityIndicator size="small" color="#fff" /> : <Check size={15} color="#fff" />}
                    </Pressable>
                    <Pressable onPress={() => setEditingGlobal(false)}
                      style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${c.text}0D`,
                               alignItems: 'center', justifyContent: 'center' }}>
                      <X size={15} color={c.text} />
                    </Pressable>
                  </View>
                ) : (
                  <Pressable
                    onPress={() => { setGlobalRaw(settings.doctor_global_price > 0 ? String(settings.doctor_global_price) : ''); setEditingGlobal(true); }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
                             backgroundColor: `${c.text}06`, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 }}>
                    <DollarSign size={13} color={c.primary} />
                    <Text style={{ flex: 1, fontSize: 14, fontWeight: '700',
                                   color: settings.doctor_global_price > 0 ? '#16A34A' : `${c.text}44` }}>
                      {settings.doctor_global_price > 0
                        ? fmtEGPPlain(settings.doctor_global_price)
                        : 'Not set — using course publish price'}
                    </Text>
                    <Edit3 size={12} color={`${c.text}33`} />
                  </Pressable>
                )}
                <View style={{ backgroundColor: `${c.primary}08`, borderRadius: 10, padding: 12, gap: 4 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>
                    Pricing Fallback Logic
                  </Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, lineHeight: 17 }}>
                    {'1. Global Earnings Price (if set)'}
                    {'\n'}
                    {'2. Course Publish Price (automatic fallback)'}
                    {'\n'}
                    {'Platform credit price is never used.'}
                  </Text>
                </View>
              </View>

              {/* ── Admin Tools ───────────────────────────────────────── */}
              <View style={{ borderTopWidth: 1, borderTopColor: `${c.text}08`, paddingTop: 16, gap: 10 }}>
                <Text style={{ fontSize: 10, fontWeight: '800', color: c.text, opacity: 0.4,
                               textTransform: 'uppercase', letterSpacing: 0.8 }}>
                  Admin Tools
                </Text>
                <Pressable onPress={saving === 'recalculate' ? undefined : handleRecalculate}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
                           backgroundColor: `${c.primary}0D`, borderRadius: 12, padding: 13,
                           opacity: saving === 'recalculate' ? 0.6 : 1 }}>
                  <View style={{ width: 32, height: 32, borderRadius: 10,
                                 backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                    {saving === 'recalculate'
                      ? <ActivityIndicator size="small" color={c.primary} />
                      : <RotateCcw size={15} color={c.primary} />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>Recalculate Earnings</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 2 }}>
                      Fix inconsistencies without clearing history
                    </Text>
                  </View>
                </Pressable>

                <Pressable onPress={saving === 'reset' ? undefined : () => setShowResetConfirm(true)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
                           backgroundColor: '#DC262608', borderRadius: 12, padding: 13,
                           opacity: saving === 'reset' ? 0.6 : 1,
                           borderWidth: 1, borderColor: '#DC262618' }}>
                  <View style={{ width: 32, height: 32, borderRadius: 10,
                                 backgroundColor: '#DC262615', alignItems: 'center', justifyContent: 'center' }}>
                    {saving === 'reset'
                      ? <ActivityIndicator size="small" color="#DC2626" />
                      : <AlertTriangle size={15} color="#DC2626" />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Reset Earnings</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 2 }}>
                      Clear all history and rebuild from active students
                    </Text>
                  </View>
                </Pressable>
              </View>

              <Modal visible={showResetConfirm} transparent animationType="fade"
                     onRequestClose={() => setShowResetConfirm(false)}>
                <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
                               alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                  <View style={{ backgroundColor: c.base, borderRadius: 20, padding: 24,
                                 width: '100%', maxWidth: 360, gap: 16 }}>
                    <View style={{ alignItems: 'center' }}>
                      <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: '#DC262615',
                                     alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
                        <AlertTriangle size={24} color="#DC2626" />
                      </View>
                      <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, textAlign: 'center' }}>
                        Reset Earnings?
                      </Text>
                    </View>
                    <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, lineHeight: 20, textAlign: 'center' }}>
                      This will permanently clear all earnings transactions and rebuild the dashboard from currently active enrolled students only.{'\n\n'}This action cannot be undone.
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <Pressable onPress={() => setShowResetConfirm(false)}
                        style={{ flex: 1, paddingVertical: 13, borderRadius: 12,
                                 backgroundColor: `${c.text}0D`, alignItems: 'center' }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>Cancel</Text>
                      </Pressable>
                      <Pressable onPress={handleReset}
                        style={{ flex: 1, paddingVertical: 13, borderRadius: 12,
                                 backgroundColor: '#DC2626', alignItems: 'center' }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>Reset</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              </Modal>
            </>
          )}
        </View>
      )}
    </NeuCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────
export default function DoctorEarnings() {
  const scheme = useColorScheme();
  const c      = scheme === 'dark' ? neuColors.dark : neuColors.light;
  const { profile, setProfile } = useProfileStore();
  const { showToast } = useToast();

  // ── Toggle ────────────────────────────────────────────────────────────────
  const [earningsEnabled, setEarningsEnabled] = useState<boolean>(!!profile?.earnings_enabled);
  const [toggling,        setToggling]        = useState(false);

  const handleToggle = async (value: boolean) => {
    if (!profile?.id || toggling) return;
    setEarningsEnabled(value);
    setProfile({ ...profile, earnings_enabled: value });
    setToggling(true);
    try {
      await updateProfile(profile.id, { earnings_enabled: value });
      showToast({ type: 'success', message: value ? 'Earnings system enabled.' : 'Earnings system disabled. History preserved.' });
    } catch (e: any) {
      setEarningsEnabled(!value);
      setProfile({ ...profile, earnings_enabled: !value });
      showToast({ type: 'error', message: e?.message ?? 'Failed to update setting.' });
    }
    setToggling(false);
  };

  const profileEarnings = !!profile?.earnings_enabled;
  if (!toggling && earningsEnabled !== profileEarnings) setEarningsEnabled(profileEarnings);

  // ── Data ──────────────────────────────────────────────────────────────────
  const [data,       setData]       = useState<DoctorEarningsDashboard | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTx, setSelectedTx] = useState<EarningsTransactionRow | null>(null);

  const loadData = useCallback(async () => {
    if (!profile?.id) { setLoading(false); return; }
    try {
      setData(await getDoctorEarningsDashboard(profile.id));
    } catch (e: any) {
      console.error('[DoctorEarnings]', e?.message);
    }
    setLoading(false);
  }, [profile?.id]);

  useFocusEffect(useCallback(() => { setLoading(true); (async () => { await loadData(); })(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      contentContainerStyle={{ paddingBottom: 60 }}
    >
      <View style={{ padding: 20 }}>

        {/* Header */}
        <View style={{ marginBottom: 20, marginTop: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <HamburgerButton />
            <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
              <TrendingUp size={19} color={c.primary} />
            </View>
            <Text style={{ fontSize: 22, fontWeight: '800', color: c.text }}>Earnings</Text>
          </View>
          <Text style={{ fontSize: 13, color: c.text, opacity: 0.38, marginLeft: 48 }}>Doctor revenue · independent pricing · EGP</Text>
        </View>

        {/* Toggle */}
        <EarningsToggleCard enabled={earningsEnabled} toggling={toggling} onToggle={handleToggle} c={c} />

        {/* Pricing Settings + Admin Tools */}
        {earningsEnabled && (
          <PricingSettingsSection
            doctorId={profile?.id ?? ''}
            c={c}
            onRecalculate={loadData}
          />
        )}

        {/* ── Disabled state ───────────────────────────────────────────── */}
        {!earningsEnabled ? (
          <View style={{ alignItems: 'center', paddingVertical: 52, gap: 16 }}>
            <NeuCard radius={24} style={{ width: 72, height: 72, alignItems: 'center', justifyContent: 'center' }}>
              <DollarSign size={32} color={`${c.text}30`} />
            </NeuCard>
            <View style={{ alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, opacity: 0.4 }}>Earnings System is Disabled</Text>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.25, textAlign: 'center', maxWidth: 260, lineHeight: 20 }}>
                Enable the Earnings System to start tracking course sales, revenue, and analytics.
              </Text>
            </View>
            <Pressable onPress={() => handleToggle(true)} style={{
              backgroundColor: '#16A34A', borderRadius: 14, paddingHorizontal: 24, paddingVertical: 13,
              shadowColor: '#16A34A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10,
            }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>Enable Earnings System</Text>
            </Pressable>
          </View>

        ) : loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 48 }} />

        ) : !data || data.totalTransactions === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 48, gap: 12 }}>
            <View style={{ width: 60, height: 60, borderRadius: 18, backgroundColor: `${c.primary}10`, alignItems: 'center', justifyContent: 'center' }}>
              <TrendingUp size={26} color={`${c.primary}55`} />
            </View>
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, opacity: 0.35 }}>No earnings yet.</Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.22, textAlign: 'center', maxWidth: 240, lineHeight: 18 }}>
              Earnings appear here once students enroll. Set your revenue price in the Pricing Settings card above.
            </Text>
          </View>

        ) : (
          <>
            {/* ── Stat Cards ─────────────────────────────────────────────── */}
            <SL label="Overview" c={c} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
              <View style={{ width: '47%' }}>
                <StatCard icon={<DollarSign size={15} color="#16A34A" />} label="Total Revenue"        value={fmtEGPPlain(data.totalRevenue)}         color="#16A34A" c={c} />
              </View>
              <View style={{ width: '47%' }}>
                <StatCard icon={<Calendar   size={15} color={c.primary} />} label="This Month"         value={fmtEGPPlain(data.thisMonthRevenue)}      color={c.primary} c={c} />
              </View>
              <View style={{ width: '47%' }}>
                <StatCard icon={<Users      size={15} color="#D97706"  />} label="Paid Students"       value={String(data.totalPaidStudents)}          color="#D97706" c={c} />
              </View>
              <View style={{ width: '47%' }}>
                <StatCard icon={<Zap        size={15} color="#7C3AED"  />} label="Transactions"        value={String(data.totalTransactions)}          color="#7C3AED" c={c} />
              </View>
              <View style={{ width: '100%' }}>
                <StatCard icon={<Zap        size={15} color="#2DA8FF"  />} label="Avg Revenue / Student" value={fmtEGPPlain(data.avgRevenuePerStudent)} color="#2DA8FF" c={c} />
              </View>
            </View>

            {/* ── Revenue Timeline Chart ──────────────────────────────────── */}
            <SL label="Revenue Timeline" c={c} />
            <RevenueChart transactions={data.transactions} c={c} />

            {/* ── Revenue by Course ───────────────────────────────────────── */}
            <SL label="Revenue by Course" c={c} />
            <CourseRevenueTable rows={data.courseRows} total={data.totalRevenue} c={c} />

            {/* ── Recent Transactions ─────────────────────────────────────── */}
            <SL label="Recent Transactions" c={c} />
            <NeuCard radius={18} style={{ padding: 16, marginBottom: 4 }}>
              {data.transactions.length === 0 ? (
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.3, textAlign: 'center', paddingVertical: 20 }}>No transactions yet</Text>
              ) : (
                data.transactions.map(row => (
                  <TransactionRow
                    key={row.id} row={row} c={c}
                    onPress={() => row.student_id ? setSelectedTx(row) : undefined}
                  />
                ))
              )}
            </NeuCard>
          </>
        )}
      </View>

      {/* ── Student Profile Modal ─────────────────────────────────────────── */}
      {selectedTx && profile?.id && (
        <StudentProfileModal
          tx={selectedTx}
          doctorId={profile.id}
          c={c}
          onClose={() => setSelectedTx(null)}
          onAction={loadData}
        />
      )}
    </ScrollView>
  );
}

