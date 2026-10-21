/**
 * DoctorEarnings — standalone route kept for back-compat.
 * The earnings dashboard is now embedded inside dr-profile.tsx (Earnings tab).
 * This file is intentionally minimal — it no longer contains business logic.
 *
 * Revenue source : doctor_earnings_events.earnings_amount
 * Pricing        : doctor_global_price (global) → course publish price (fallback)
 * Platform price : NEVER used — completely independent financial system
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
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
  Briefcase,
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
import { useTranslation } from '@/lib/i18n';
import { neuColors, useLayout, safeTop, safeLeft, safeRight, safeBottom, mutedTextStyle } from '@/lib/neu';
import { DashboardHeader } from '@/components/DashboardHeader';
import HamburgerButton from '@/components/HamburgerButton';
import { FeatureUnavailableState } from '@/components/ScreenState';
import {
  isFeatureEnabled,
  useFeatureFlags,
  isFeatureDisabledError,
} from '@/lib/featureFlags';


// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function fmtEGP(n: number): string {
  const abs = Math.abs(n);
  const s = `EGP ${abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  return n < 0 ? `−${s}` : `+${s}`;
}
function fmtEGPPlain(n: number): string {
  return `EGP ${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Transaction types are machine values from the backend; the label is resolved
// through the dictionary at RENDER time (never at module load), so switching
// language repaints without a remount.
const TX_LABEL_KEY: Record<string, string> = {
  purchase:          'drProfile.tx.purchase',
  removal:           'drProfile.tx.removal',
  suspension_refund: 'drProfile.tx.suspension_refund',
  adjustment:        'drProfile.tx.adjustment',
  account_deletion:  'drProfile.tx.account_deletion',
};

/** Translator signature — resolved per render, never cached in a module const. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Unknown transaction types fall through verbatim (they are API values). */
function txTypeLabel(type: string, t: Translate): string {
  const key = TX_LABEL_KEY[type];
  return key ? t(key) : type;
}

// For account_deletion rows the student name is stored as the name at deletion time;
// display as the localized 'Deleted Account' regardless since the account no longer exists.
function txDisplayName(row: EarningsTransactionRow, t: Translate): string {
  if (row.transaction_type === 'account_deletion') return t('drProfile.deletedAccount');
  return row.student_name ?? t('drProfile.deletedAccount');
}

type ChartPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

// ─────────────────────────────────────────────────────────────────────────────
// EarningsToggleCard
// ─────────────────────────────────────────────────────────────────────────────
function EarningsToggleCard({
  enabled, toggling, onToggle, c, disabled,
}: { enabled: boolean; toggling: boolean; onToggle: (v: boolean) => void; c: typeof neuColors.light; disabled?: boolean }) {
  const { t } = useTranslation();
  const frozen = disabled && !enabled;
  return (
    <NeuCard radius={18} style={{ padding: 16, marginBottom: 20, opacity: frozen ? 0.55 : 1, pointerEvents: frozen ? 'none' : 'auto' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: enabled ? '#16A34A18' : `${c.text}0D`, alignItems: 'center', justifyContent: 'center' }}>
          <TrendingUp size={20} color={enabled ? '#16A34A' : `${c.text}44`} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{t('drProfile.section.earnings')}</Text>
          <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.4), marginTop: 2 }}>
            {frozen ? t('drProfile.earnings.toggleFrozen') :
             enabled ? t('drProfile.earnings.toggleActive') : t('drProfile.earnings.toggleInactive')}
          </Text>
        </View>
        {frozen
          ? <View style={{ width: 18, height: 18, borderRadius: 4, backgroundColor: c.text }} />
          : toggling
            ? <ActivityIndicator size="small" color={c.primary} />
            : <Switch value={enabled} onValueChange={onToggle} trackColor={{ false: `${c.text}20`, true: '#16A34A55' }} thumbColor={enabled ? '#16A34A' : `${c.text}55`} />
        }
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: `${c.text}08` }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: enabled ? '#16A34A' : `${c.text}33` }} />
        <Text style={{ fontSize: 11, fontWeight: '600', color: enabled ? '#16A34A' : `${c.text}44` }}>
          {enabled ? t('drProfile.earningsOn') : t('drProfile.earningsOff')}
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
      <Text style={{ fontSize: 9, ...mutedTextStyle(c, 0.4), fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8 }} numberOfLines={1}>{label}</Text>
      <Text style={{ fontSize: 15, fontWeight: '800', color }} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </NeuCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section label
// ─────────────────────────────────────────────────────────────────────────────
function SL({ label, c }: { label: string; c: typeof neuColors.light }) {
  return (
    <Text style={{ fontSize: 9, fontWeight: '800', letterSpacing: 1.3, textTransform: 'uppercase', ...mutedTextStyle(c, 0.3), marginBottom: 10, marginTop: 4 }}>
      {label}
    </Text>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Period toggle
// ─────────────────────────────────────────────────────────────────────────────
const PERIODS: { key: ChartPeriod; labelKey: string }[] = [
  { key: 'daily',   labelKey: 'period.daily'   },
  { key: 'weekly',  labelKey: 'period.weekly'  },
  { key: 'monthly', labelKey: 'period.monthly' },
  { key: 'yearly',  labelKey: 'period.yearly'  },
];

function PeriodPicker({ value, onChange, c }: { value: ChartPeriod; onChange: (v: ChartPeriod) => void; c: typeof neuColors.light }) {
  const { t } = useTranslation();
  return (
    <View style={{ flexDirection: 'row', backgroundColor: `${c.text}0A`, borderRadius: 12, padding: 3, marginBottom: 16 }}>
      {PERIODS.map(p => (
        <Pressable key={p.key} onPress={() => onChange(p.key)} style={{
          flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center',
          backgroundColor: value === p.key ? c.base : 'transparent',
          ...(value === p.key ? { shadowColor: c.shadowDark, shadowOffset: { width: 1, height: 1 }, shadowOpacity: 0.35, shadowRadius: 4 } : {}),
        }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: value === p.key ? c.primary : `${c.text}55` }}>{t(p.labelKey)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Revenue Time-Series Chart
// ─────────────────────────────────────────────────────────────────────────────
function RevenueChart({ transactions, c }: { transactions: EarningsTransactionRow[]; c: typeof neuColors.light }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<ChartPeriod>('daily');

  const points = useMemo(() => bucketEarningsTimeSeries(transactions, period), [transactions, period]);
  const maxAbs  = Math.max(...points.map(p => Math.abs(p.amount)), 1);

  return (
    <NeuCard radius={18} style={{ padding: 18, marginBottom: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <BarChart2 size={15} color={c.primary} />
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, flex: 1 }}>{t('drProfile.earnings.timeline')}</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: '#16A34A' }} />
            <Text style={{ fontSize: 9, ...mutedTextStyle(c, 0.4) }}>{t('drProfile.earnings.income')}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: '#DC2626' }} />
            <Text style={{ fontSize: 9, ...mutedTextStyle(c, 0.4) }}>{t('drProfile.earnings.deduction')}</Text>
          </View>
        </View>
      </View>

      <PeriodPicker value={period} onChange={setPeriod} c={c} />

      {points.length === 0 ? (
        <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.3), textAlign: 'center', paddingVertical: 24 }}>{t('drProfile.earnings.noDataPeriod')}</Text>
      ) : (
        <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 5, height: 110, paddingBottom: 20, minWidth: points.length * 32 }}>
            {points.map((p, i) => {
              const barH  = Math.max(4, (Math.abs(p.amount) / maxAbs) * 80);
              const color = p.isNegative ? '#DC2626' : '#16A34A';
              return (
                <View key={i} style={{ alignItems: 'center', gap: 3, width: 28 }}>
                  <Text style={{ fontSize: 7, ...mutedTextStyle(c, 0.3), fontWeight: '600' }} numberOfLines={1}>
                    {Math.abs(p.amount) > 0 ? String(Math.round(Math.abs(p.amount))) : ''}
                  </Text>
                  <View style={{ width: 20, height: barH, borderRadius: 5, backgroundColor: `${color}CC` }} />
                  <Text style={{ fontSize: 8, ...mutedTextStyle(c, 0.35), fontWeight: '600', textAlign: 'center' }} numberOfLines={1}>{p.label}</Text>
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
  const { t, isRTL } = useTranslation();
  // Numeric columns hug the trailing edge: right in LTR, left in RTL. Physical
  // textAlign is used (not 'auto') because these are right-aligned NUMBERS,
  // and RN does not mirror textAlign for us.
  const numAlign = isRTL ? 'left' : 'right';
  return (
    <NeuCard radius={18} style={{ overflow: 'hidden', marginBottom: 20 }}>
      <View style={{ flexDirection: 'row', paddingVertical: 10, paddingHorizontal: 14, backgroundColor: `${c.text}06`, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
        <Text style={{ flex: 1, fontSize: 9, fontWeight: '800', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase', letterSpacing: 0.7 }}>{t('drProfile.earnings.colCourse')}</Text>
        <Text style={{ width: 44, textAlign: 'center', fontSize: 9, fontWeight: '800', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase' }}>{t('drProfile.stats.students')}</Text>
        <Text style={{ width: 60, textAlign: numAlign, fontSize: 9, fontWeight: '800', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase' }}>{t('drProfile.earnings.colRevenue')}</Text>
        <Text style={{ width: 32, textAlign: numAlign, fontSize: 9, fontWeight: '800', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase' }}>%</Text>
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
          <Text style={{ width: 60, textAlign: numAlign, fontSize: 12, fontWeight: '700', color: r.revenue_egp >= 0 ? '#16A34A' : '#DC2626' }} numberOfLines={1}>{fmtEGPPlain(r.revenue_egp)}</Text>
          <Text style={{ width: 32, textAlign: numAlign, fontSize: 11, fontWeight: '700', color: c.primary }}>{r.pct}%</Text>
        </View>
      ))}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, backgroundColor: `${c.primary}08`, borderTopWidth: 1.5, borderTopColor: `${c.primary}22` }}>
        <Text style={{ flex: 1, fontSize: 13, fontWeight: '800', color: c.primary }}>{t('common.total')}</Text>
        <Text style={{ width: 44, textAlign: 'center', fontSize: 12, fontWeight: '700', color: c.primary }}>{rows.reduce((s, r) => s + r.students, 0)}</Text>
        <Text style={{ width: 60, textAlign: numAlign, fontSize: 13, fontWeight: '800', color: c.primary }} numberOfLines={1}>{fmtEGPPlain(total)}</Text>
        <Text style={{ width: 32, textAlign: numAlign, fontSize: 11, fontWeight: '700', color: c.primary }}>100%</Text>
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
  const { t, isRTL } = useTranslation();
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
          style={{ width: 38, height: 38, borderRadius: 12, marginEnd: 12 }}
        />
      ) : (
        <View style={{ width: 38, height: 38, borderRadius: 12,
                       backgroundColor: `${color}18`, alignItems: 'center',
                       justifyContent: 'center', marginEnd: 12 }}>
          <Icon size={16} color={color} />
        </View>
      )}

      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }} numberOfLines={1}>
          {txDisplayName(row, t)}
        </Text>
        <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4) }} numberOfLines={1}>
          {row.course_title ?? '—'}{'  ·  '}{txTypeLabel(row.transaction_type, t)}
        </Text>
      </View>

      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: '800', color }}>{fmtEGP(row.amount)}</Text>
        <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.35) }}>{fmtDateShort(row.created_at)}</Text>
      </View>

      {!isLegacy && (
        <ChevronRight
          size={14}
          color={`${c.text}30`}
          style={{ marginStart: 4, transform: [{ rotate: isRTL ? '180deg' : '0deg' }] }}
        />
      )}
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Student Profile Modal  (action-only — no per-student price override)
// ─────────────────────────────────────────────────────────────────────────────
const PRICING_KEY: Record<string, string> = {
  doctor_independent: 'drProfile.earnings.pricing.doctor',
  global:             'drProfile.earnings.pricing.global',
  per_student:        'drProfile.earnings.pricing.perStudent',
};

/** Pricing source → localized label. Unknown modes fall back to doctor pricing. */
function pricingSourceLabel(mode: string, t: Translate): string {
  const key = PRICING_KEY[mode];
  return key ? t(key) : t('drProfile.earnings.pricing.doctor');
}

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
        <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.4), fontWeight: '700',
                       textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</Text>
        <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={2}>{value}</Text>
      </View>
    </View>
  );
}

function SectionLabel({ text, c }: { text: string; c: typeof neuColors.light }) {
  return (
    <Text style={{ fontSize: 10, fontWeight: '800', ...mutedTextStyle(c, 0.35),
                   textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
      {text}
    </Text>
  );
}

function StudentProfileModal({ tx, doctorId, onClose, onAction, c }: {
  tx: EarningsTransactionRow; doctorId: string;
  onClose: () => void; onAction: () => void; c: typeof neuColors.light;
}) {
  const layout = useLayout();
  const insets = layout.insets;
  const [profile,       setProfile]       = useState<DoctorStudentProfile | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [isDeleted,     setIsDeleted]     = useState(false);
  const [acting,        setActing]        = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ enrollmentId: string; courseTitle: string } | null>(null);
  const { showToast } = useToast();
  const { t } = useTranslation();

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

  // useEffect (not useMemo) — side effects must not run during the render pass
  useEffect(() => { (async () => loadProfile())(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const handleAction = async (
    action: 'suspend' | 'restore' | 'remove',
    enrollmentId: string, courseId: string, courseTitle: string,
  ) => {
    setActing(`${action}-${enrollmentId}`);
    try {
      if (action === 'suspend') {
        await suspendStudentCourseAccess(enrollmentId);
        showToast({ type: 'success', message: t('drProfile.student.accessSuspendedPreserved') });
        await loadProfile();
      } else if (action === 'restore') {
        await restoreStudentCourseAccess(enrollmentId);
        showToast({ type: 'success', message: t('drProfile.student.accessRestored') });
        await loadProfile();
      } else {
        await removeStudentFromCourseWithRefund({
          doctorId, enrollmentId,
          studentNameSnapshot: tx.student_name ?? '',
          courseNameSnapshot:  courseTitle,
        });
        showToast({ type: 'success', message: t('drProfile.student.removed') });
        onClose(); onAction(); return;
      }
    } catch (e: any) { showToast({ type: 'error', message: e?.message ?? t('drProfile.student.actionFailed') }); }
    setActing(null);
  };

  const enStatusColor = (s: string) =>
    s === 'active' ? '#16A34A' : s === 'suspended' ? '#D97706' : '#DC2626';
  // Enrollment statuses are backend enum values; only the known ones are
  // localized, anything new falls through verbatim.
  const enStatusLabel = (s: string) =>
    s === 'active' ? t('drProfile.status.active')
      : s === 'suspended' ? t('drProfile.status.suspended') : s;

  const displayName  = profile?.full_name    ?? tx.student_name               ?? '—';
  const displayPhone = profile?.phone        ?? tx.student_phone_snapshot     ?? tx.student_phone  ?? '—';
  const displayEmail = profile?.email        ?? tx.student_email_snapshot     ?? tx.student_email  ?? '—';
  const displayWmk   = profile?.watermark_id ?? tx.student_watermark_snapshot ?? '—';
  const displayJoin  = (!isDeleted && profile?.created_at) ? profile.created_at : null;

  const hasSuspended       = (profile?.enrollments ?? []).some(e => e.status === 'suspended');
  const accountStatus      = isDeleted ? t('drProfile.status.deleted')
                                     : hasSuspended ? t('drProfile.status.suspended')
                                                    : t('drProfile.status.active');
  const accountStatusColor = isDeleted ? '#DC2626' : hasSuspended ? '#D97706' : '#16A34A';
  const pricingSourceValue = pricingSourceLabel(tx.pricing_mode, t);

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: c.base, borderTopLeftRadius: 28,
                       borderTopRightRadius: 28, maxHeight: '92%' }}>
          <View style={{ alignItems: 'center', paddingTop: 12 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: `${c.text}20` }} />
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center',
                         paddingHorizontal: layout.screenPx, paddingTop: 14, paddingBottom: 10 }}>
            <View style={{ width: 48, height: 48, borderRadius: 14, marginEnd: 12,
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
                  <Text style={{ fontSize: 10, fontWeight: '700', ...mutedTextStyle(c, 0.5),
                                 textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {txTypeLabel(tx.transaction_type, t)}
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

          <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} contentContainerStyle={{ paddingHorizontal: layout.screenPx }}>
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
                        {t('drProfile.student.deletedTitle')}
                      </Text>
                      <Text style={{ fontSize: 12, color: '#DC2626', opacity: 0.7, lineHeight: 18 }}>
                        {t('drProfile.student.deletedHint')}
                      </Text>
                    </View>
                  </View>
                )}

                <SectionLabel text={isDeleted ? t('drProfile.student.historical') : t('drProfile.student.profile')} c={c} />
                <NeuCard radius={16} style={{ padding: 16, gap: 14, marginBottom: 16 }}>
                  <InfoRow icon={<Users    size={14} color={c.primary} />} label={t('profile.fullName')}     value={displayName}  c={c} />
                  <InfoRow icon={<Phone    size={14} color={c.primary} />} label={t('common.phone')}        value={displayPhone} c={c} />
                  <InfoRow icon={<Mail     size={14} color={c.primary} />} label={t('common.email')}        value={displayEmail} c={c} />
                  <InfoRow icon={<Hash     size={14} color={c.primary} />} label={t('drProfile.earnings.watermarkId')} value={displayWmk} c={c} />
                  {displayJoin && (
                    <InfoRow icon={<Calendar size={14} color={c.primary} />} label={t('drProfile.student.joined')} value={fmtDate(displayJoin)} c={c} />
                  )}
                </NeuCard>

                <SectionLabel text={t('drProfile.student.txDetails')} c={c} />
                <NeuCard radius={16} style={{ padding: 16, gap: 14, marginBottom: 16 }}>
                  <InfoRow icon={<BookOpen size={14} color={c.primary} />}
                    label={t('drProfile.earnings.colCourse')} value={tx.course_title ?? '—'} c={c} />
                  <InfoRow icon={<Zap size={14} color={c.primary} />}
                    label={t('drProfile.earnings.transactionType')} value={txTypeLabel(tx.transaction_type, t)} c={c} />
                  <InfoRow icon={<Calendar size={14} color={c.primary} />}
                    label={t('common.date')} value={fmtDate(tx.created_at)} c={c} />
                  <InfoRow
                    icon={<DollarSign size={14} color={tx.amount >= 0 ? '#16A34A' : '#DC2626'} />}
                    label={t('drProfile.earnings.colRevenue')}
                    value={`${tx.amount >= 0 ? '+' : '−'}EGP ${Math.abs(tx.amount).toLocaleString('en-US')}`}
                    c={c} />
                  {tx.price_snapshot > 0 && (
                    <InfoRow icon={<Settings size={14} color={c.primary} />}
                      label={t('drProfile.earnings.pricingSource')} value={pricingSourceValue} c={c} />
                  )}
                  {tx.notes && (
                    <InfoRow icon={<Hash size={14} color={c.primary} />} label={t('drProfile.earnings.notes')} value={tx.notes} c={c} />
                  )}
                </NeuCard>

                {!isDeleted && profile && (
                  <>
                    <SectionLabel text={t('drProfile.student.enrollments')} c={c} />
                    {profile.enrollments.length === 0 ? (
                      <NeuCard radius={16} style={{ padding: layout.screenPx, alignItems: 'center', gap: 8, marginBottom: 16 }}>
                        <BookOpen size={22} color={`${c.text}30`} />
                        <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.3), textAlign: 'center' }}>
                          {t('drProfile.student.noEnrollments')}
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
                              {enStatusLabel(en.status)}
                            </Text>
                          </View>
                        </View>

                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <View style={{ flex: 1, backgroundColor: `${c.text}06`, borderRadius: 10,
                                         padding: 10, alignItems: 'center' }}>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: c.primary }}>
                              {en.progress_percent}%
                            </Text>
                            <Text style={{ fontSize: 9, ...mutedTextStyle(c, 0.4) }}>{t('drProfile.student.progress')}</Text>
                          </View>
                          <View style={{ flex: 1, backgroundColor: `${c.text}06`, borderRadius: 10,
                                         padding: 10, alignItems: 'center' }}>
                            <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.55) }}>
                              {fmtDateShort(en.enrolled_at)}
                            </Text>
                            <Text style={{ fontSize: 9, ...mutedTextStyle(c, 0.4) }}>{t('drProfile.student.enrolled')}</Text>
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
                              <Text style={{ fontSize: 12, fontWeight: '700', color: '#D97706' }}>{t('drProfile.student.suspend')}</Text>
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
                              <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>{t('drProfile.student.resume')}</Text>
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
                            <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>{t('common.remove')}</Text>
                          </Pressable>
                        </View>

                        {confirmRemove?.enrollmentId === en.enrollment_id && (
                          <View style={{ backgroundColor: '#DC262610', borderRadius: 12, padding: 14,
                                         borderWidth: 1, borderColor: '#DC262625', gap: 10 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                              <AlertTriangle size={15} color="#DC2626" style={{ marginTop: 1 }} />
                              <Text style={{ flex: 1, fontSize: 12, color: '#DC2626', lineHeight: 18 }}>
                                {t('drProfile.student.removeConfirm', { name: displayName, course: en.course_title })}
                              </Text>
                            </View>
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                              <Pressable onPress={() => setConfirmRemove(null)}
                                style={{ flex: 1, alignItems: 'center', justifyContent: 'center',
                                         backgroundColor: `${c.text}0D`, borderRadius: 10, paddingVertical: 9 }}>
                                <Text style={{ fontSize: 12, fontWeight: '700', ...mutedTextStyle(c, 0.6) }}>{t('common.cancel')}</Text>
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
                                <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>{t('drProfile.student.confirmRemove')}</Text>
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
  const { t, isRTL } = useTranslation();

  const load = useCallback(async () => {
    try {
      const s = await getDoctorPricingSettings(doctorId);
      setSettings(s);
    } catch { /* silent */ }
    setLoading(false);
  }, [doctorId]);

  // useEffect (not useMemo) — side effects must not run during the render pass
  useEffect(() => { (async () => load())(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveGlobal = async () => {
    if (!settings) return;
    const p = globalRaw.trim() === '' ? 0 : Number(globalRaw);
    if (isNaN(p)) return;
    setSaving('global');
    try {
      await setDoctorGlobalPrice(doctorId, p);
      setSettings({ ...settings, doctor_global_price: p });
      setEditingGlobal(false);
      showToast({
        type: 'success',
        message: p === 0 ? t('drProfile.earnings.globalCleared') : t('drProfile.earnings.globalSaved'),
      });
    } catch (e: any) { showToast({ type: 'error', message: e?.message ?? t('drProfile.earnings.genericFailure') }); }
    setSaving(null);
  };

  const handleRecalculate = async () => {
    setSaving('recalculate');
    try {
      const { corrections } = await recalculateDoctorEarnings(doctorId);
      showToast({
        type: 'success',
        message: corrections > 0
          ? t('drProfile.earnings.recalculated', { count: corrections })
          : t('drProfile.earnings.verified'),
      });
      onRecalculate?.();
    } catch (e: any) { showToast({ type: 'error', message: e?.message ?? t('drProfile.earnings.recalculateFailed') }); }
    setSaving(null);
  };

  const handleReset = async () => {
    setShowResetConfirm(false);
    setSaving('reset');
    try {
      const { rebuilt } = await resetDoctorEarnings(doctorId);
      showToast({
        type: 'success',
        message: t('drProfile.earnings.resetDone', { count: rebuilt }),
      });
      onRecalculate?.();
    } catch (e: any) { showToast({ type: 'error', message: e?.message ?? t('drProfile.earnings.resetFailed') }); }
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
          <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{t('drProfile.earnings.pricingTools')}</Text>
          <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.4), marginTop: 2 }}>
            {settings
              ? settings.doctor_global_price > 0
                ? t('drProfile.earnings.globalPerEnrollment', { amount: fmtEGPPlain(settings.doctor_global_price) })
                : t('drProfile.earnings.fallbackCoursePrice')
              : t('drProfile.earnings.configureHint')}
          </Text>
        </View>
        {/* Disclosure chevron follows the reading direction: it opens downward
            along the inline axis, so the rotation is mirrored in RTL. */}
        <ChevronRight size={16} color={`${c.text}40`}
          style={{
            transform: [{
              rotate: expanded ? (isRTL ? '-90deg' : '90deg') : (isRTL ? '180deg' : '0deg'),
            }],
          }} />
      </Pressable>

      {expanded && (
        <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 16,
                       borderTopWidth: 1, borderTopColor: `${c.text}08`, paddingTop: 16 }}>
          {loading ? <ActivityIndicator color={c.primary} /> : !settings ? null : (
            <>
              {/* ── Global earnings price ───────────────────────────── */}
              <View style={{ gap: 8 }}>
                <Text style={{ fontSize: 10, fontWeight: '800', ...mutedTextStyle(c, 0.4),
                               textTransform: 'uppercase', letterSpacing: 0.8 }}>
                  {t('drProfile.earnings.globalPrice')}
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
                        : t('drProfile.earnings.notSetFallback')}
                    </Text>
                    <Edit3 size={12} color={`${c.text}33`} />
                  </Pressable>
                )}
                <View style={{ backgroundColor: `${c.primary}08`, borderRadius: 10, padding: 12, gap: 4 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>
                    {t('drProfile.earnings.fallbackLogic')}
                  </Text>
                  <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5), lineHeight: 17 }}>
                    {t('drProfile.earnings.pricingBodyNoCredits')}
                  </Text>
                </View>
              </View>

              {/* ── Admin Tools ───────────────────────────────────────── */}
              <View style={{ borderTopWidth: 1, borderTopColor: `${c.text}08`, paddingTop: 16, gap: 10 }}>
                <Text style={{ fontSize: 10, fontWeight: '800', ...mutedTextStyle(c, 0.4),
                               textTransform: 'uppercase', letterSpacing: 0.8 }}>
                  {t('drProfile.earnings.adminTools')}
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
                    <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>{t('drProfile.earnings.recalculate')}</Text>
                    <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45), marginTop: 2 }}>
                      {t('drProfile.earnings.recalculateHintShort')}
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
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>{t('drProfile.earnings.resetAll')}</Text>
                    <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45), marginTop: 2 }}>
                      {t('drProfile.earnings.resetHint')}
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
                        {t('drProfile.earnings.resetTitle')}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6), lineHeight: 20, textAlign: 'center' }}>
                      {t('drProfile.earnings.resetBody')}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <Pressable onPress={() => setShowResetConfirm(false)}
                        style={{ flex: 1, paddingVertical: 13, borderRadius: 12,
                                 backgroundColor: `${c.text}0D`, alignItems: 'center' }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{t('common.cancel')}</Text>
                      </Pressable>
                      <Pressable onPress={handleReset}
                        style={{ flex: 1, paddingVertical: 13, borderRadius: 12,
                                 backgroundColor: '#DC2626', alignItems: 'center' }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>{t('drProfile.earnings.reset')}</Text>
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
  const layout = useLayout();
  const insets = layout.insets;
  const c      = scheme === 'dark' ? neuColors.dark : neuColors.light;
  const { profile, setProfile } = useProfileStore();
  const { showToast } = useToast();
  const { t } = useTranslation();

  // Server-authoritative flag state, refreshed on mount + on foreground.
  // UI-only reflection — the BACKEND refuses the RPC (403 feature_disabled)
  // and the Data API read of doctor_earnings_events (FeatureFlagService).
  // Takes precedence over the personal toggle: if the platform disables
  // earnings, the screen shows the unavailable state regardless of the local
  // toggle, and re-enabling the flag restores everything without a restart.
  const { isEnabled: flagEnabled, refresh: refreshFlags } = useFeatureFlags();

  // Backend-refusal state (403 feature_disabled). Declared BEFORE the derived
  // values below so the JSX never reads a block-scoped binding early.
  // The refused feature key is logged for diagnostics only — both refusal
  // paths show the same localized explanation, so it is no longer rendered.
  const [flagBlocked, setFlagBlocked] = useState(false);

  const platformEarningsOn = flagEnabled('doctor_earnings') && !flagBlocked;

  // ── Toggle (local preference only; disabled by platform tombstone) ────────
  const [earningsEnabled, setEarningsEnabled] = useState<boolean>(!!profile?.earnings_enabled);
  const [toggling,        setToggling]        = useState(false);

  const platformDisabled = flagBlocked || !platformEarningsOn;
  const canToggle = !toggling && !platformDisabled;

  const handleToggle = async (value: boolean) => {
    if (!profile?.id || toggling || platformDisabled) return;
    setEarningsEnabled(value);
    setProfile({ ...profile, earnings_enabled: value });
    setToggling(true);
    try {
      await updateProfile(profile.id, { earnings_enabled: value });
      showToast({
        type: 'success',
        message: value ? t('drProfile.earningsEnabledToast') : t('drProfile.earningsDisabledToast'),
      });
    } catch (e: any) {
      const disabled = isFeatureDisabledError(e);
      if (disabled) {
        setEarningsEnabled(!value);
        setProfile({ ...profile, earnings_enabled: !value });
        setFlagBlocked(true);
        console.info('[DoctorEarnings] toggle refused, feature disabled:', disabled);
      }
      showToast({ type: 'error', message: e?.message ?? t('drProfile.earningsUpdateFailed') });
    }
    setToggling(false);
  };

  const profileEarnings = !!profile?.earnings_enabled;
  if (!toggling && earningsEnabled !== profileEarnings) setEarningsEnabled(profileEarnings);

  // ── Data ──────────────────────────────────────────────────────────────────
  const [data,          setData]          = useState<DoctorEarningsDashboard | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const [selectedTx,    setSelectedTx]    = useState<EarningsTransactionRow | null>(null);

  // Use the live hook value (the shell refreshes it on foreground; this
  // screen additionally refreshes loadData on focus so a toggle while the
  // Doctor is on the tab is reflected without leaving the screen).

  const loadData = useCallback(async () => {
    if (!profile?.id) { setLoading(false); return; }
    try {
      const dashboard = await getDoctorEarningsDashboard(profile.id);
      if (dashboard && (data === null || (refreshing))) setData(dashboard);
      setFlagBlocked(false);
    } catch (e: any) {
      const disabled = isFeatureDisabledError(e);
      if (disabled) {
        // Backend refused because the Super Admin disabled this feature.
        // Show the clear "unavailable" state instead of stale/empty data.
        setFlagBlocked(true);
        console.info('[DoctorEarnings] read refused, feature disabled:', disabled);
        setData(null);
      } else {
        // Network/read error — keep showing last known data, don't
        // catastrophize into a silent blank screen.
        console.error('[DoctorEarnings]', e?.message ?? e);
      }
    }
    setLoading(false);
  }, [profile?.id, data, refreshing]);

  useFocusEffect(useCallback(() => { setLoading(true); (async () => { await loadData(); })(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  // ── Platform-disabled: a DEDICATED, centred unavailable screen ────────────
  //  The normal Earnings header — the "Doctor revenue · independent pricing ·
  //  EGP" overline, the "Earnings" title and the trend/action icon — belongs
  //  to the page that no longer exists while the feature is off, so it is not
  //  rendered at all. Only the drawer affordance is kept, so the user can
  //  still navigate away. The state is centred in the FULL available height,
  //  inset-aware at the top and clearing the bottom tab bar, instead of
  //  sitting against the top of an otherwise empty page.
  if (platformDisabled) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: c.base,
          paddingTop: safeTop(layout.insets.top),
          paddingLeft: safeLeft(layout.insets.left || 0),
          paddingRight: safeRight(layout.insets.right || 0),
          paddingBottom: safeBottom(layout.insets.bottom),
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingBottom: 8 }}>
          <HamburgerButton plain />
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: layout.screenPx }}>
          <FeatureUnavailableState
            icon={<DollarSign size={26} color="#B45309" />}
            title={t('drProfile.featureUnavailable')}
            description={t('drProfile.earnings.unavailableBody')}
          />
        </View>
      </View>
    );
  }

  return (
    <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <DashboardHeader
        roleLabel={t('drProfile.earnings.headerRole')}
        greeting={t('nav.earnings')}
        rightActions={
          <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
            <TrendingUp size={19} color={c.primary} />
          </View>
        }
      />
      <View style={{ padding: layout.screenPx, paddingTop: 0 }}>

        {/* Platform flag: doctor_earnings (Super Admin control). Server-authoritative:
            the backend refuses the RPC (403 feature_disabled) and the Data API read
            of doctor_earnings_events (FeatureFlagService). The screen shows the
            unavailable state if:
              • the platform flag is OFF (platformEarningsOn is false), OR
              • the backend returned 403 feature_disabled (flagBlocked is true).
            Re-enabling the flag restores this screen instantly — no app restart,
            no reinstall. Local toggle is frozen while the platform has disabled it. */}
        {platformDisabled ? (
          <View style={{ alignItems: 'center', paddingVertical: 52, gap: 16 }}>
            <NeuCard radius={24} style={{ width: 72, height: 72, alignItems: 'center', justifyContent: 'center' }}>
              <DollarSign size={32} color={`${c.text}30`} />
            </NeuCard>
            <View style={{ alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, textAlign: 'center' }}>{t('drProfile.featureUnavailable')}</Text>
              <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.4), textAlign: 'center', maxWidth: 260, lineHeight: 20 }}>
                {t('drProfile.earnings.unavailableBody')}
              </Text>
            </View>
          </View>
        ) : (<>
          {/* Toggle (disabled while platform has disabled earnings) */}
          <EarningsToggleCard enabled={earningsEnabled} toggling={toggling} onToggle={handleToggle} c={c} disabled={platformDisabled} />

        {/* Pricing Settings + Admin Tools — only when the platform allows earnings */}
        {platformEarningsOn && earningsEnabled && (
          <PricingSettingsSection
            doctorId={profile?.id ?? ''}
            c={c}
            onRecalculate={loadData}
          />
        )}

        {!earningsEnabled ? (
          <View style={{ alignItems: 'center', paddingVertical: 52, gap: 16 }}>
            <NeuCard radius={24} style={{ width: 72, height: 72, alignItems: 'center', justifyContent: 'center' }}>
              <DollarSign size={32} color={`${c.text}30`} />
            </NeuCard>
            <View style={{ alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 17, fontWeight: '800', ...mutedTextStyle(c, 0.4), textAlign: 'center' }}>{t('drProfile.earnings.disabledTitle')}</Text>
              <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.25), textAlign: 'center', maxWidth: 260, lineHeight: 20 }}>
                {t('drProfile.earnings.disabledHint')}
              </Text>
            </View>
            <Pressable onPress={() => handleToggle(true)} style={{
              backgroundColor: '#16A34A', borderRadius: 14, paddingHorizontal: 24, paddingVertical: 13,
              shadowColor: '#16A34A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10,
            }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>{t('drProfile.enableEarnings')}</Text>
            </Pressable>
          </View>

        ) : loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 48 }} />

        ) : !data || data.totalTransactions === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 48, gap: 12 }}>
            <View style={{ width: 60, height: 60, borderRadius: 18, backgroundColor: `${c.primary}10`, alignItems: 'center', justifyContent: 'center' }}>
              <TrendingUp size={26} color={`${c.primary}55`} />
            </View>
            <Text style={{ fontSize: 16, fontWeight: '700', ...mutedTextStyle(c, 0.35), textAlign: 'center' }}>{t('drProfile.earnings.emptyTitle')}</Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.22, textAlign: 'center', maxWidth: 240, lineHeight: 18 }}>
              {t('drProfile.earnings.emptyHint')}
            </Text>
          </View>

        ) : (
          <>
            {/* ── Stat Cards ─────────────────────────────────────────────── */}
            <SL label={t('common.overview')} c={c} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
              <View style={{ width: '47%' }}>
                <StatCard icon={<DollarSign size={15} color="#16A34A" />} label={t('drProfile.earnings.totalRevenue')} value={fmtEGPPlain(data.totalRevenue)}         color="#16A34A" c={c} />
              </View>
              <View style={{ width: '47%' }}>
                <StatCard icon={<Calendar   size={15} color={c.primary} />} label={t('drProfile.earnings.thisMonth')}    value={fmtEGPPlain(data.thisMonthRevenue)}      color={c.primary} c={c} />
              </View>
              <View style={{ width: '47%' }}>
                <StatCard icon={<Users      size={15} color="#D97706"  />} label={t('drProfile.earnings.paidStudents')}  value={String(data.totalPaidStudents)}          color="#D97706" c={c} />
              </View>
              <View style={{ width: '47%' }}>
                <StatCard icon={<Zap        size={15} color="#7C3AED"  />} label={t('drProfile.earnings.transactions')}  value={String(data.totalTransactions)}          color="#7C3AED" c={c} />
              </View>
              <View style={{ width: '100%' }}>
                <StatCard icon={<Zap size={15} color="#2DA8FF" />} label={t('drProfile.earnings.avgRevenuePerStudent')} value={fmtEGPPlain(data.avgRevenuePerStudent)} color="#2DA8FF" c={c} />
              </View>
            </View>

            {/* ── Revenue Timeline Chart ──────────────────────────────────── */}
            <SL label={t('drProfile.earnings.timeline')} c={c} />
            <RevenueChart transactions={data.transactions} c={c} />

            {/* ── Revenue by Course ───────────────────────────────────────── */}
            <SL label={t('drProfile.earnings.byCourse')} c={c} />
            <CourseRevenueTable rows={data.courseRows} total={data.totalRevenue} c={c} />

            {/* ── Recent Transactions ─────────────────────────────────────── */}
            <SL label={t('drProfile.earnings.recent')} c={c} />
            <NeuCard radius={18} style={{ padding: 16, marginBottom: 4 }}>
              {data.transactions.length === 0 ? (
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.3), textAlign: 'center', paddingVertical: 20 }}>{t('drProfile.earnings.none')}</Text>
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
        </>
      )}
      </View>
    </ScrollView>
  );
}
