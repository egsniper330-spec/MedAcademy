/**
 * DoctorProfile — permanent profile tab for the doctor role.
 *
 * Contains two in-page tabs:
 *   Profile  — identity, account info, contact info, business settings
 *   Settings — edit profile, change password, sign out
 *
 * Earnings is a standalone bottom-nav tab (dr-earnings.tsx).
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  ActivityIndicator, RefreshControl, TextInput, Switch, Modal,
  useWindowDimensions,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import type { RelativePathString } from 'expo-router';
import {
  User, Mail, Phone, Lock, LogOut, ChevronRight,
  BookOpen, Users, CreditCard, Fingerprint, Copy, CheckCircle,
  Pencil, MessageCircle, Send, TrendingUp, DollarSign,
  BarChart2, Calendar, Zap, ArrowUpRight, ArrowDownRight,
  X, Hash, AlertTriangle, RotateCcw,
  Settings, Check, Edit3, Trash2, UserMinus, RotateCw,
  Eye, EyeOff, AlertCircle, FileText, Shield, HeartHandshake, Info, Camera,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { validateRequired, friendlyError } from '@/lib/validation';
import { isInternalEmail, changePassword } from '@/lib/api';
import { backendClient } from '@/client/backendClient';
import { useProfileStore } from '@/lib/store';
import { isFeatureEnabled } from '@/lib/featureFlags';
import { ProfilePhotoActions } from '@/components/ProfilePhotoActions';
import { resolveImageMime, extFromMime, buildAvatarStoragePath, avatarFileName } from '@/lib/uploadPart';
import {
  getProfile, getCourses, getDoctorStudentEnrollments, getPublicEmail, updateProfile, removeProfileAvatar,
  getDoctorEarningsDashboard, bucketEarningsTimeSeries,
  getDoctorStudentProfile, getDoctorPricingSettings, setDoctorGlobalPrice,
  suspendStudentCourseAccess, restoreStudentCourseAccess,
  removeStudentFromCourseWithRefund, recalculateDoctorEarnings, resetDoctorEarnings,
  type DoctorEarningsDashboard, type EarningsTransactionRow, type EarningsCourseRow,
  type DoctorStudentProfile, type DoctorPricingSettings,
} from '@/lib/api';
import { useCreditBalance } from '@/lib/useCreditBalance';
import { getFirstName } from '@/lib/utils';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { NeuInputRow } from '@/components/NeuInputRow';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, safeBottom, useLayout, mutedTextStyle } from '@/lib/neu';
import { usePermission } from '@/hooks/usePermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';
import { useTranslation } from '@/lib/i18n';
import { LanguageSetting } from '@/components/LanguageSetting';

// ─────────────────────────────────────────────────────────────────────────────
// Earnings helpers (shared with embedded Earnings tab)
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

const TX_LABEL_KEY: Record<string, string> = {
  purchase:          'drProfile.tx.purchase',
  removal:           'drProfile.tx.removal',
  suspension_refund: 'drProfile.tx.suspension_refund',
  adjustment:        'drProfile.tx.adjustment',
  account_deletion:  'drProfile.tx.account_deletion',
};

function txDisplayName(row: EarningsTransactionRow, t: Translate): string {
  if (row.transaction_type === 'account_deletion') return t('drProfile.deletedAccount');
  return row.student_name ?? t('drProfile.deletedAccount');
}

/** Translator signature (resolved at render, never at module load). */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Transaction type → localized label. Unknown types fall through verbatim. */
function txTypeLabel(type: string, t: Translate): string {
  const key = TX_LABEL_KEY[type];
  return key ? t(key) : type;
}

type ChartPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';
const PERIODS: { key: ChartPeriod; labelKey: string }[] = [
  { key: 'daily', labelKey: 'period.daily' }, { key: 'weekly', labelKey: 'period.weekly' },
  { key: 'monthly', labelKey: 'period.monthly' }, { key: 'yearly', labelKey: 'period.yearly' },
];

// ── Profile tabs ──────────────────────────────────────────────────────────────
type ProfileTab = 'profile' | 'settings';
const PROFILE_TABS: { key: ProfileTab; labelKey: string }[] = [
  { key: 'profile',  labelKey: 'common.profile'  },
  { key: 'settings', labelKey: 'common.settings' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function SectionLabel({ label, color }: { label: string; color: string }) {
  return (
    <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase',
                   color, opacity: 0.5, marginBottom: 10, marginTop: 4 }}>
      {label}
    </Text>
  );
}

function EarnSL({ label, c }: { label: string; c: typeof neuColors.light }) {
  return (
    <Text style={{ fontSize: 9, fontWeight: '800', letterSpacing: 1.3, textTransform: 'uppercase',
                   ...mutedTextStyle(c, 0.3), marginBottom: 10, marginTop: 4 }}>
      {label}
    </Text>
  );
}

function InfoRow({ icon, label, value, c }: { icon: React.ReactNode; label: string; value: string; c: typeof neuColors.light }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
                   borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
      <View style={{ width: 32, alignItems: 'center' }}>{icon}</View>
      <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5), minWidth: 90, flexShrink: 0, marginLeft: 8 }}>{label}</Text>
      <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: c.text, textAlign: 'right' }} numberOfLines={1}>
        {value || '—'}
      </Text>
    </View>
  );
}

function StatCard({ icon, label, value, color, c }: {
  icon: React.ReactNode; label: string; value: string; color: string; c: typeof neuColors.light;
}) {
  return (
    <NeuCard radius={18} style={{ flex: 1, padding: 14, gap: 6, minWidth: 0 }}>
      <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: `${color}18`,
                     alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </View>
      <Text style={{ fontSize: 9, ...mutedTextStyle(c, 0.4), fontWeight: '800',
                     textTransform: 'uppercase', letterSpacing: 0.8 }} numberOfLines={1}>{label}</Text>
      <Text style={{ fontSize: 15, fontWeight: '800', color }} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </NeuCard>
  );
}

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

function RevenueChart({ transactions, c }: { transactions: EarningsTransactionRow[]; c: typeof neuColors.light }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<ChartPeriod>('daily');
  const points = useMemo(() => bucketEarningsTimeSeries(transactions, period), [transactions, period]);
  const maxAbs = Math.max(...points.map(p => Math.abs(p.amount)), 1);

  return (
    <NeuCard radius={18} style={{ padding: 18, marginBottom: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <BarChart2 size={15} color={c.primary} />
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, flex: 1 }}>{t('drProfile.earnings.timeline')}</Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {[{ color: '#16A34A', label: t('drProfile.earnings.income') }, { color: '#DC2626', label: t('drProfile.earnings.deduct') }].map(l => (
            <View key={l.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: l.color }} />
              <Text style={{ fontSize: 9, ...mutedTextStyle(c, 0.4) }}>{l.label}</Text>
            </View>
          ))}
        </View>
      </View>
      <PeriodPicker value={period} onChange={setPeriod} c={c} />
      {points.length === 0 ? (
        <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.3), textAlign: 'center', paddingVertical: 24 }}>{t('drProfile.earnings.noDataPeriod')}</Text>
      ) : (
        <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 5, height: 110, paddingBottom: 20, minWidth: points.length * 32 }}>
            {points.map((p, i) => {
              const barH = Math.max(4, (Math.abs(p.amount) / maxAbs) * 80);
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

function CourseRevenueTable({ rows, c }: { rows: EarningsCourseRow[]; c: typeof neuColors.light }) {
    const layout = useLayout();
    const { t } = useTranslation();
return (
    <NeuCard radius={18} style={{ overflow: 'hidden', marginBottom: 20 }}>
      <View style={{ flexDirection: 'row', paddingVertical: 10, paddingHorizontal: 14,
                     backgroundColor: `${c.text}06`, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
        <Text style={{ flex: 1, fontSize: 9, fontWeight: '800', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase', letterSpacing: 0.7 }}>{t('drProfile.earnings.colCourse')}</Text>
        <Text style={{ width: 44, textAlign: 'center', fontSize: 9, fontWeight: '800', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase' }}>{t('drProfile.earnings.colStudents')}</Text>
        <Text style={{ width: 70, textAlign: 'right', fontSize: 9, fontWeight: '800', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase' }}>{t('drProfile.earnings.colRevenue')}</Text>
        <Text style={{ width: 28, textAlign: 'right', fontSize: 9, fontWeight: '800', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase' }}>%</Text>
      </View>
      {rows.length === 0 ? (
        <View style={{ padding: layout.screenPx, alignItems: 'center' }}>
          <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.3) }}>{t('drProfile.earnings.noCourseData')}</Text>
        </View>
      ) : rows.map(r => (
        <View key={r.course_id} style={{ flexDirection: 'row', alignItems: 'center',
                                          paddingVertical: 11, paddingHorizontal: 14,
                                          borderBottomWidth: 1, borderBottomColor: `${c.text}06` }}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: c.text }} numberOfLines={1}>{r.course_title}</Text>
            <View style={{ height: 3, borderRadius: 2, backgroundColor: `${c.text}0D` }}>
              <View style={{ height: 3, borderRadius: 2, width: `${r.pct}%`,
                             backgroundColor: r.revenue_egp >= 0 ? '#16A34A99' : '#DC262699' }} />
            </View>
          </View>
          <Text style={{ width: 44, textAlign: 'center', fontSize: 12, fontWeight: '600', color: `${c.text}77` }}>{r.students}</Text>
          <Text style={{ width: 70, textAlign: 'right', fontSize: 12, fontWeight: '700',
                         color: r.revenue_egp >= 0 ? '#16A34A' : '#DC2626' }} numberOfLines={1}>{fmtEGPPlain(r.revenue_egp)}</Text>
          <Text style={{ width: 28, textAlign: 'right', fontSize: 11, fontWeight: '700', color: c.primary }}>
            {r.pct.toFixed(0)}%
          </Text>
        </View>
      ))}
    </NeuCard>
  );
}

function TxRow({ row, onPress, c }: { row: EarningsTransactionRow; onPress: () => void; c: typeof neuColors.light }) {
  const { t } = useTranslation();
  const isPositive = row.amount >= 0;
  const color      = isPositive ? '#16A34A' : '#DC2626';
  const Icon       = isPositive ? ArrowUpRight : ArrowDownRight;
  return (
    <Pressable onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
               borderBottomWidth: 1, borderBottomColor: `${c.text}06` }}>
      {row.student_avatar ? (
        <Image source={{ uri: row.student_avatar }} style={{ width: 38, height: 38, borderRadius: 12, marginRight: 12 }} />
      ) : (
        <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${color}18`,
                       alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
          <Icon size={16} color={color} />
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }} numberOfLines={1}>{txDisplayName(row, t)}</Text>
        <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4) }} numberOfLines={1}>
          {row.course_title ?? '—'}{'  ·  '}{txTypeLabel(row.transaction_type, t)}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: '800', color }}>{fmtEGP(row.amount)}</Text>
        <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.35) }}>{fmtDateShort(row.created_at)}</Text>
      </View>
      <ChevronRight size={14} color={`${c.text}30`} style={{ marginLeft: 4 }} />
    </Pressable>
  );
}

// ── Inline price editor (used for global price only) ─────────────────────────
function InlinePriceEditor({ value, onSave, saving, label, c }: {
  value: number | null; onSave: (v: number | null) => void;
  saving: boolean; label: string; c: typeof neuColors.light;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw]         = useState(value != null ? String(value) : '');
  const commit = () => {
    const n = raw.trim() === '' ? null : Number(raw);
    onSave(isNaN(n as number) ? value : n);
    setEditing(false);
  };
  if (!editing) {
    return (
      <Pressable onPress={() => { setRaw(value != null ? String(value) : ''); setEditing(true); }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
                 backgroundColor: `${c.text}06`, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }}>
        <DollarSign size={12} color={c.primary} />
        <Text style={{ fontSize: 13, fontWeight: '700', color: value != null && value > 0 ? '#16A34A' : `${c.text}44` }}>
          {value != null && value > 0 ? fmtEGPPlain(value) : label}
        </Text>
        <Edit3 size={11} color={`${c.text}33`} />
      </Pressable>
    );
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <TextInput
        value={raw} onChangeText={setRaw} keyboardType="numeric"
        autoFocus returnKeyType="done" onSubmitEditing={commit}
        placeholder="0"
        style={{ flex: 1, backgroundColor: `${c.text}08`, borderRadius: 10,
                 paddingHorizontal: 12, paddingVertical: 8, fontSize: 14,
                 fontWeight: '700', color: c.text, borderWidth: 1.5, borderColor: c.primary }}
      />
      <Pressable onPress={commit} disabled={saving}
        style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: '#16A34A',
                 alignItems: 'center', justifyContent: 'center' }}>
        {saving ? <ActivityIndicator size="small" color="#fff" /> : <Check size={15} color="#fff" />}
      </Pressable>
      <Pressable onPress={() => setEditing(false)}
        style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${c.text}0D`,
                 alignItems: 'center', justifyContent: 'center' }}>
        <X size={15} color={c.text} />
      </Pressable>
    </View>
  );
}

// ── Pricing / Admin tools card ────────────────────────────────────────────────
function GlobalPriceCard({ doctorId, c, onRecalculate }: {
  doctorId: string; c: typeof neuColors.light; onRecalculate: () => void;
}) {
  const [settings,         setSettings]         = useState<DoctorPricingSettings | null>(null);
  const [loading,          setLoading]          = useState(true);
  const [saving,           setSaving]           = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const { showToast } = useToast();
  const { t } = useTranslation();

  const load = useCallback(async () => {
    try {
      const s = await getDoctorPricingSettings(doctorId);
      setSettings(s);
    } catch { /* silent */ }
    setLoading(false);
  }, [doctorId]);

  // useEffect (not useMemo) — side effects must not run during the render pass
  useEffect(() => { (async () => load())(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveGlobal = async (price: number | null) => {
    if (!settings) return;
    setSaving('global');
    try {
      const p = price ?? 0;
      await setDoctorGlobalPrice(doctorId, p);
      setSettings({ ...settings, doctor_global_price: p });
      showToast({ type: 'success', message: t('drProfile.earnings.globalSaved') });
    } catch (e: any) { showToast({ type: 'error', message: e?.message ?? t('drProfile.saveFailed') }); }
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
      onRecalculate();
    } catch (e: any) { showToast({ type: 'error', message: e?.message ?? t('drProfile.earnings.recalculateFailed') }); }
    setSaving(null);
  };

  const handleReset = async () => {
    setShowResetConfirm(false);
    setSaving('reset');
    try {
      const { rebuilt } = await resetDoctorEarnings(doctorId);
      showToast({ type: 'success', message: t('drProfile.earnings.resetDone', { count: rebuilt }) });
      onRecalculate();
    } catch (e: any) { showToast({ type: 'error', message: e?.message ?? t('drProfile.earnings.resetFailed') }); }
    setSaving(null);
  };

  return (
    <NeuCard radius={18} style={{ padding: 18, marginBottom: 20, gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: `${c.primary}15`,
                       alignItems: 'center', justifyContent: 'center' }}>
          <Settings size={18} color={c.primary} />
        </View>
        <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{t('drProfile.earnings.price')}</Text>
      </View>

      {loading ? <ActivityIndicator color={c.primary} /> : !settings ? null : (
        <>
          {/* Global price */}
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 10, fontWeight: '800', ...mutedTextStyle(c, 0.4),
                           textTransform: 'uppercase', letterSpacing: 0.8 }}>
              {t('drProfile.earnings.globalPrice')}
            </Text>
            <InlinePriceEditor
              value={settings.doctor_global_price || null}
              label={t('drProfile.earnings.setGlobalPrice')}
              saving={saving === 'global'}
              onSave={saveGlobal}
              c={c}
            />
            <View style={{ backgroundColor: `${c.primary}08`, borderRadius: 10, padding: 12, gap: 4 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>{t('drProfile.earnings.fallbackLogic')}</Text>
              <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5), lineHeight: 17 }}>
                {t('drProfile.earnings.fallbackBody')}
              </Text>
            </View>
          </View>

          {/* ── Admin Tools ─────────────────────────────────────────────── */}
          <View style={{ borderTopWidth: 1, borderTopColor: `${c.text}08`, paddingTop: 14, gap: 10 }}>
            <Text style={{ fontSize: 10, fontWeight: '800', ...mutedTextStyle(c, 0.4),
                           textTransform: 'uppercase', letterSpacing: 0.8 }}>
              {t('drProfile.earnings.adminTools')}
            </Text>
            <Pressable
              onPress={saving === 'recalculate' ? undefined : handleRecalculate}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
                       backgroundColor: `${c.primary}0D`, borderRadius: 12,
                       padding: 13, opacity: saving === 'recalculate' ? 0.6 : 1 }}>
              {saving === 'recalculate'
                ? <ActivityIndicator size="small" color={c.primary} />
                : <RotateCw size={15} color={c.primary} />}
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{t('drProfile.earnings.recalculate')}</Text>
                <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4), lineHeight: 16 }}>
                  {t('drProfile.earnings.recalculateHint')}
                </Text>
              </View>
            </Pressable>
            <Pressable
              onPress={saving === 'reset' ? undefined : () => setShowResetConfirm(true)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
                       backgroundColor: '#DC262608', borderRadius: 12,
                       padding: 13, opacity: saving === 'reset' ? 0.6 : 1 }}>
              {saving === 'reset'
                ? <ActivityIndicator size="small" color="#DC2626" />
                : <AlertTriangle size={15} color="#DC2626" />}
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>{t('drProfile.earnings.resetAll')}</Text>
                <Text style={{ fontSize: 11, color: '#DC2626', opacity: 0.6, lineHeight: 16 }}>
                  {t('drProfile.earnings.resetHint')}
                </Text>
              </View>
            </Pressable>
          </View>
        </>
      )}

      {/* Reset confirmation modal */}
      {/*
        Fix: added statusBarTranslucent so scrim covers the Android status bar.
        Fix: card uses marginHorizontal instead of width:'100%' + padding:20 so it
        respects landscape iPad safe-area insets and never overflows tiny phones.
      */}
      <Modal visible={showResetConfirm} transparent animationType="fade" statusBarTranslucent>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 }}>
          <NeuCard radius={24} style={{ padding: 24, gap: 16, width: '100%', maxWidth: 400, alignSelf: 'center' }}>
            <View style={{ alignItems: 'center', gap: 10 }}>
              <View style={{ width: 54, height: 54, borderRadius: 16, backgroundColor: '#DC262614',
                             alignItems: 'center', justifyContent: 'center' }}>
                <AlertTriangle size={24} color="#DC2626" />
              </View>
              <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, textAlign: 'center' }}>{t('drProfile.earnings.resetTitle')}</Text>
            </View>
            <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6), lineHeight: 20, textAlign: 'center' }}>
              {t('drProfile.earnings.resetBody')}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable onPress={() => setShowResetConfirm(false)}
                style={{ flex: 1, minWidth: 100, paddingVertical: 13, borderRadius: 12,
                         backgroundColor: `${c.text}0D`, alignItems: 'center' }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable onPress={handleReset}
                style={{ flex: 1, minWidth: 100, paddingVertical: 13, borderRadius: 12,
                         backgroundColor: '#DC2626', alignItems: 'center' }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }} numberOfLines={1}>{t('drProfile.earnings.reset')}</Text>
              </Pressable>
            </View>
          </NeuCard>
        </View>
      </Modal>
    </NeuCard>
  );
}

// ── Student profile modal (inside Earnings tab) ───────────────────────────────


function StudentProfileModal({ tx, doctorId, onClose, onAction, c }: {
  tx: EarningsTransactionRow; doctorId: string;
  onClose: () => void; onAction: () => void; c: typeof neuColors.light;
}) {
  const layout = useLayout();
  const insets = layout.insets;
  const [studentProfile, setStudentProfile] = useState<DoctorStudentProfile | null>(null);
  const [loading,        setLoading]        = useState(true);
  const [isDeleted,      setIsDeleted]      = useState(false);
  const [acting,         setActing]         = useState<string | null>(null);
  const [confirmRemove,  setConfirmRemove]  = useState<{ enrollmentId: string; courseTitle: string } | null>(null);
  const { showToast } = useToast();
  const { t } = useTranslation();

  const loadProfile = useCallback(async () => {
    setLoading(true);
    if (!tx.student_id) { setLoading(false); return; }
    try {
      const p = await getDoctorStudentProfile(doctorId, tx.student_id);
      if (p) { setStudentProfile(p); setIsDeleted(p.account_status === 'trashed'); }
      else    setIsDeleted(true);
    } catch { setIsDeleted(true); }
    setLoading(false);
  }, [tx.student_id, doctorId]);

  // useEffect (not useMemo) — side effects must not run during the render pass
  useEffect(() => { (async () => loadProfile())(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAction = async (
    action: 'suspend' | 'restore' | 'remove',
    enrollmentId: string, courseId: string, courseTitle: string,
  ) => {
    setActing(`${action}-${enrollmentId}`);
    try {
      if (action === 'suspend') {
        await suspendStudentCourseAccess(enrollmentId);
        showToast({ type: 'success', message: t('drProfile.student.accessSuspended') });
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

  const displayName  = studentProfile?.full_name    ?? tx.student_name               ?? '—';
  const displayPhone = studentProfile?.phone        ?? tx.student_phone_snapshot     ?? tx.student_phone  ?? '—';
  const displayEmail = studentProfile?.email        ?? tx.student_email_snapshot     ?? tx.student_email  ?? '—';
  // Public User ID (MED-####) is the user-facing identifier; the legacy
  // watermark snapshot is only a fallback for historical transaction records.
  const displayWmk   = studentProfile?.public_user_id ?? tx.student_watermark_snapshot ?? '—';
  const displayJoin  = (!isDeleted && studentProfile?.created_at) ? studentProfile.created_at : null;

  const hasSuspended       = (studentProfile?.enrollments ?? []).some(e => e.status === 'suspended');
  const accountStatus      = isDeleted ? t('drProfile.status.deleted')
    : hasSuspended ? t('drProfile.status.suspended') : t('drProfile.status.active');
  const accountStatusColor = isDeleted ? '#DC2626' : hasSuspended ? '#D97706' : '#16A34A';

  return (
    <Modal visible animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: c.base,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          // Fix: was '92%' (of full screen height, ignoring safe-area insets).
          // Now calculated as (screenH - insets.top) * 0.92 so it is always
          // within the visible viewport — critical on landscape and small phones.
          maxHeight: layout.insets ? (layout.height - layout.insets.top) * 0.92 : '92%',
          width: '100%',
        }}>
          <View style={{ alignItems: 'center', paddingTop: 12 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: `${c.text}20` }} />
          </View>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center',
                         paddingHorizontal: layout.screenPx, paddingTop: 14, paddingBottom: 10 }}>
            {studentProfile?.avatar_url && !isDeleted ? (
              <Image source={{ uri: studentProfile.avatar_url }}
                style={{ width: 48, height: 48, borderRadius: 14, marginRight: 12 }} />
            ) : (
              <View style={{ width: 48, height: 48, borderRadius: 14, marginRight: 12,
                             backgroundColor: isDeleted ? '#DC262614' : `${c.primary}15`,
                             alignItems: 'center', justifyContent: 'center' }}>
                {isDeleted ? <Trash2 size={22} color="#DC2626" /> : <Users size={22} color={c.primary} />}
              </View>
            )}
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={{ fontSize: 17, fontWeight: '800', color: c.text }} numberOfLines={1}>{displayName}</Text>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <View style={{ backgroundColor: `${accountStatusColor}18`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 10, fontWeight: '800', color: accountStatusColor,
                                 textTransform: 'uppercase', letterSpacing: 0.6 }}>{accountStatus}</Text>
                </View>
                <View style={{ backgroundColor: `${c.text}0A`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
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
            {loading ? <ActivityIndicator color={c.primary} style={{ marginVertical: 48 }} /> : (
              <>
                {isDeleted && (
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10,
                                 backgroundColor: '#DC262608', borderRadius: 14, padding: 14,
                                 marginBottom: 16, borderWidth: 1, borderColor: '#DC262622' }}>
                    <Trash2 size={15} color="#DC2626" style={{ marginTop: 1 }} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>{t('drProfile.student.deletedTitle')}</Text>
                      <Text style={{ fontSize: 12, color: '#DC2626', opacity: 0.7, lineHeight: 18 }}>
                        {t('drProfile.student.deletedHint')}
                      </Text>
                    </View>
                  </View>
                )}

                {/* Identity */}
                <Text style={{ fontSize: 10, fontWeight: '800', ...mutedTextStyle(c, 0.35),
                               textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
                  {isDeleted ? t('drProfile.student.historical') : t('drProfile.student.profile')}
                </Text>
                <NeuCard radius={16} style={{ padding: 16, gap: 14, marginBottom: 16 }}>
                  {[
                    { icon: <Users size={14} color={c.primary} />,    label: t('profile.fullName'),     value: displayName  },
                    { icon: <Phone size={14} color={c.primary} />,    label: t('profile.phone'),        value: displayPhone },
                    { icon: <Mail size={14} color={c.primary} />,     label: t('profile.email'),        value: displayEmail },
                    { icon: <Hash size={14} color={c.primary} />,     label: t('drProfile.userId'),     value: displayWmk   },
                  ].map(r => (
                    <View key={r.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: `${c.primary}12`,
                                     alignItems: 'center', justifyContent: 'center' }}>{r.icon}</View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.4), fontWeight: '700',
                                       textTransform: 'uppercase', letterSpacing: 0.5 }}>{r.label}</Text>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={2}>{r.value}</Text>
                      </View>
                    </View>
                  ))}
                  {displayJoin && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: `${c.primary}12`,
                                     alignItems: 'center', justifyContent: 'center' }}>
                        <Calendar size={14} color={c.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.4), fontWeight: '700',
                                       textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('drProfile.student.joined')}</Text>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{fmtDate(displayJoin)}</Text>
                      </View>
                    </View>
                  )}
                </NeuCard>

                {/* Transaction details */}
                <Text style={{ fontSize: 10, fontWeight: '800', ...mutedTextStyle(c, 0.35),
                               textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
                  {t('drProfile.student.txDetails')}
                </Text>
                <NeuCard radius={16} style={{ padding: 16, gap: 14, marginBottom: 16 }}>
                  {[
                    { icon: <BookOpen size={14} color={c.primary} />, label: t('drProfile.earnings.colCourse'), value: tx.course_title ?? '—' },
                    { icon: <Zap size={14} color={c.primary} />, label: t('drProfile.student.type'), value: txTypeLabel(tx.transaction_type, t) },
                    { icon: <Calendar size={14} color={c.primary} />, label: t('common.date'), value: fmtDate(tx.created_at) },
                    { icon: <DollarSign size={14} color={tx.amount >= 0 ? '#16A34A' : '#DC2626'} />,
                      label: t('drProfile.earnings.colRevenue'), value: `${tx.amount >= 0 ? '+' : '−'}EGP ${Math.abs(tx.amount).toLocaleString('en-US')}` },
                  ].map(r => (
                    <View key={r.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: `${c.primary}12`,
                                     alignItems: 'center', justifyContent: 'center' }}>{r.icon}</View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.4), fontWeight: '700',
                                       textTransform: 'uppercase', letterSpacing: 0.5 }}>{r.label}</Text>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={2}>{r.value}</Text>
                      </View>
                    </View>
                  ))}
                </NeuCard>

                {/* Enrollments + actions — live accounts only */}
                {!isDeleted && studentProfile && studentProfile.enrollments.length > 0 && (
                  <>
                    <Text style={{ fontSize: 10, fontWeight: '800', ...mutedTextStyle(c, 0.35),
                                   textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
                      {t('drProfile.student.enrollments')}
                    </Text>
                    {studentProfile.enrollments.map(en => (
                      <NeuCard key={en.enrollment_id} radius={16} style={{ padding: 16, marginBottom: 12, gap: 12 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <BookOpen size={15} color={c.primary} />
                          <Text style={{ flex: 1, fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>
                            {en.course_title}
                          </Text>
                          <View style={{ backgroundColor: `${enStatusColor(en.status)}18`, borderRadius: 8,
                                         paddingHorizontal: 8, paddingVertical: 3 }}>
                            <Text style={{ fontSize: 11, fontWeight: '700',
                                           color: enStatusColor(en.status), textTransform: 'capitalize' }}>
                              {en.status}
                            </Text>
                          </View>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <View style={{ flex: 1, backgroundColor: `${c.text}06`, borderRadius: 10,
                                         padding: 10, alignItems: 'center' }}>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: c.primary }}>{en.progress_percent}%</Text>
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
                            <Pressable onPress={() => handleAction('suspend', en.enrollment_id, en.course_id, en.course_title)}
                              disabled={!!acting}
                              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                                       gap: 6, backgroundColor: '#D9770618', borderRadius: 10, paddingVertical: 10 }}>
                              {acting === `suspend-${en.enrollment_id}`
                                ? <ActivityIndicator size="small" color="#D97706" />
                                : <AlertTriangle size={13} color="#D97706" />}
                              <Text style={{ fontSize: 12, fontWeight: '700', color: '#D97706' }}>{t('drProfile.student.suspend')}</Text>
                            </Pressable>
                          )}
                          {en.status === 'suspended' && (
                            <Pressable onPress={() => handleAction('restore', en.enrollment_id, en.course_id, en.course_title)}
                              disabled={!!acting}
                              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                                       gap: 6, backgroundColor: '#16A34A18', borderRadius: 10, paddingVertical: 10 }}>
                              {acting === `restore-${en.enrollment_id}`
                                ? <ActivityIndicator size="small" color="#16A34A" />
                                : <RotateCcw size={13} color="#16A34A" />}
                              <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>{t('drProfile.student.resume')}</Text>
                            </Pressable>
                          )}
                          <Pressable onPress={() => setConfirmRemove({ enrollmentId: en.enrollment_id, courseTitle: en.course_title })}
                            disabled={!!acting}
                            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                                     gap: 6, backgroundColor: '#DC262618', borderRadius: 10, paddingVertical: 10 }}>
                            {acting === `remove-${en.enrollment_id}`
                              ? <ActivityIndicator size="small" color="#DC2626" />
                              : <UserMinus size={13} color="#DC2626" />}
                            <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>{t('common.remove')}</Text>
                          </Pressable>
                        </View>
                        {confirmRemove?.enrollmentId === en.enrollment_id && (
                          <View style={{ backgroundColor: '#DC262610', borderRadius: 12, padding: 14,
                                         borderWidth: 1, borderColor: '#DC262625', gap: 10 }}>
                            <Text style={{ fontSize: 12, color: '#DC2626', lineHeight: 18 }}>
                              {t('drProfile.student.removeConfirm', { name: displayName, course: en.course_title })}
                            </Text>
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                              <Pressable onPress={() => setConfirmRemove(null)}
                                style={{ flex: 1, alignItems: 'center', backgroundColor: `${c.text}0D`,
                                         borderRadius: 10, paddingVertical: 9 }}>
                                <Text style={{ fontSize: 12, fontWeight: '700', ...mutedTextStyle(c, 0.6) }}>{t('common.cancel')}</Text>
                              </Pressable>
                              <Pressable onPress={() => { setConfirmRemove(null); handleAction('remove', en.enrollment_id, en.course_id, en.course_title); }}
                                disabled={!!acting}
                                style={{ flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                                         gap: 6, backgroundColor: '#DC2626', borderRadius: 10, paddingVertical: 9 }}>
                                <UserMinus size={13} color="#fff" />
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
// Contact edit hook (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function useContactEdit(profile: any, setProfile: (p: any) => void) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { showToast } = useToast();
  const { t } = useTranslation();

  const [showEdit, setShowEdit]       = useState(false);
  const [whatsapp, setWhatsapp]       = useState('');
  const [telegram, setTelegram]       = useState('');
  const [phone, setPhone]             = useState('');
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');

  const openEdit = () => {
    setWhatsapp((profile as any)?.contact_whatsapp ?? '');
    setTelegram((profile as any)?.contact_telegram ?? '');
    setPhone((profile as any)?.contact_phone ?? '');
    setError('');
    setShowEdit(true);
  };

  const handleSave = async () => {
    if (!profile?.id) return;
    setSaving(true); setError('');
    try {
      const updated = await updateProfile(profile.id, {
        contact_whatsapp: whatsapp.trim() || null,
        contact_telegram: telegram.trim() || null,
        contact_phone:    phone.trim()    || null,
      });
      setProfile({ ...profile, ...(updated as any) });
      showToast({ type: 'success', message: t('drProfile.contactSaved') });
      setShowEdit(false);
    } catch (e: any) {
      setError(e?.message ?? t('drProfile.saveFailed'));
    }
    setSaving(false);
  };

  // inputStyle removed — use NeuInputRow instead

  const modal = (
    <ResponsiveModal
      visible={showEdit}
      onClose={() => setShowEdit(false)}
      title={t('drProfile.section.contact')}
      footer={
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <NeuButton label={t('common.cancel')} onPress={() => setShowEdit(false)} variant="secondary" style={{ flex: 1 }} />
          <NeuButton label={t('common.save')} onPress={handleSave} loading={saving} style={{ flex: 1 }} />
        </View>
      }
    >
      
        <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5), marginBottom: 16, lineHeight: 19 }}>
          {t('drProfile.contactIntro')}
        </Text>

        {/* WhatsApp */}
        <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
          {t('drProfile.whatsappNumber')}
        </Text>
        <NeuInputRow
          c={c}
          value={whatsapp}
          onChangeText={setWhatsapp}
          placeholder="+201234567890"
          keyboardType="phone-pad"
          leftIcon={<MessageCircle size={16} color="#25D366" />}
          rightElement={whatsapp.trim() ? <CheckCircle size={14} color="#25D366" /> : undefined}
        />

        {/* Telegram */}
        <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
          {t('drProfile.telegram')}
        </Text>
        <NeuInputRow
          c={c}
          value={telegram}
          onChangeText={setTelegram}
          placeholder={t('drProfile.telegramPlaceholder')}
          autoCapitalize="none"
          leftIcon={<Send size={16} color="#229ED9" />}
          rightElement={telegram.trim() ? <CheckCircle size={14} color="#229ED9" /> : undefined}
        />

        {/* Phone */}
        <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
          {t('drProfile.phoneNumber')}
        </Text>
        <NeuInputRow
          c={c}
          containerStyle={{ marginBottom: 4 }}
          value={phone}
          onChangeText={setPhone}
          placeholder="+201234567890"
          keyboardType="phone-pad"
          leftIcon={<Phone size={16} color={c.primary} />}
          rightElement={phone.trim() ? <CheckCircle size={14} color={c.primary} /> : undefined}
        />

        {error ? (
          <Text style={{ fontSize: 13, color: '#DC2626', marginTop: 8 }}>{error}</Text>
        ) : null}
      
    </ResponsiveModal>
  );

  return { openEdit, modal };
}

// ─── Public User ID card ───────────────────────────────────────────────────
// Displays the PUBLIC USER ID (MED-####) — the canonical user-facing identifier.
// The internal legacy watermark_id must never be shown here.
function WatermarkCard({ publicUserId, c }: { publicUserId: string | null; c: typeof neuColors.light }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!publicUserId && __DEV__) {
    console.warn('[DrProfile] public_user_id missing from profile payload — check backend PUBLIC_COLS/profile select.');
  }
  const handleCopy = () => {
    if (!publicUserId) return;
    void Clipboard.setStringAsync(publicUserId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <NeuCard radius={18} style={{ padding: 18, marginBottom: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: `${c.primary}15`, alignItems: 'center', justifyContent: 'center' }}>
          <Fingerprint size={18} color={c.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase', letterSpacing: 0.9 }}>
            {t('drProfile.userId')}
          </Text>
          <Text style={{ fontSize: 18, fontWeight: '800', color: c.primary, letterSpacing: 1.5, marginTop: 2, fontVariant: ['tabular-nums'] }}>
            {publicUserId ?? '—'}
          </Text>
        </View>
        <Pressable
          onPress={handleCopy}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 5,
            paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
            backgroundColor: copied ? '#16A34A18' : `${c.primary}12`,
          }}
        >
          {copied ? <CheckCircle size={15} color="#16A34A" /> : <Copy size={15} color={c.primary} />}
          <Text style={{ fontSize: 12, fontWeight: '700', color: copied ? '#16A34A' : c.primary }}>
            {copied ? t('profile.copied') : t('drProfile.copy')}
          </Text>
        </Pressable>
      </View>
      <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.4), lineHeight: 17 }}>
        {t('drProfile.watermarkNote')}
      </Text>
    </NeuCard>
  );
}

// ─── Earnings tab content ─────────────────────────────────────────────────────
function EarningsTab({ doctorId, earningsEnabled, c }: { // eslint-disable-line @typescript-eslint/no-unused-vars
  doctorId: string; earningsEnabled: boolean; c: typeof neuColors.light;
}) {
  const [dashboard, setDashboard]   = useState<DoctorEarningsDashboard | null>(null);
  const [loading,   setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTx, setSelectedTx] = useState<EarningsTransactionRow | null>(null);
  const { showToast } = useToast();
  const { t } = useTranslation();
  const layout = useLayout();
  const insets = layout.insets;

  const load = useCallback(async () => {
    try {
      const d = await getDoctorEarningsDashboard(doctorId);
      setDashboard(d);
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? t('drProfile.earnings.loadFailed') });
    }
    setLoading(false);
  }, [doctorId]); // eslint-disable-line react-hooks/exhaustive-deps

  // useEffect (not useMemo) — side effects must not run during the render pass
  useEffect(() => { (async () => load())(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (!earningsEnabled) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 14 }}>
        <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: `${c.text}0A`,
                       alignItems: 'center', justifyContent: 'center' }}>
          <TrendingUp size={28} color={`${c.text}33`} />
        </View>
        <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, textAlign: 'center' }}>
          {t('drProfile.earnings.systemOff')}
        </Text>
        <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.45), textAlign: 'center', lineHeight: 20 }}>
          {t('drProfile.earnings.systemOffHint')}
        </Text>
      </View>
    );
  }

  if (loading) {
    return <ActivityIndicator color={c.primary} style={{ marginTop: 60 }} />;
  }

  const d = dashboard;
  const totalRevenue  = d?.totalRevenue        ?? 0;
  const monthRevenue  = d?.thisMonthRevenue    ?? 0;
  const paidStudents  = d?.totalPaidStudents   ?? 0;
  const txCount       = d?.totalTransactions   ?? 0;
  const avgPerStudent = d?.avgRevenuePerStudent ?? 0;
  const transactions  = d?.transactions        ?? [];
  const courseRows    = d?.courseRows          ?? [];

  return (
    <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      contentContainerStyle={{ padding: layout.screenPx }}
    >
      {/* ── Stat cards ───────────────────────────────────────────────── */}
      <EarnSL label={t('common.overview')} c={c} />
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
        <StatCard icon={<TrendingUp size={16} color="#16A34A" />} label={t('drProfile.earnings.totalRevenue')}
          value={fmtEGPPlain(totalRevenue)} color="#16A34A" c={c} />
        <StatCard icon={<Calendar size={16} color={c.primary} />} label={t('drProfile.earnings.thisMonth')}
          value={fmtEGPPlain(monthRevenue)} color={c.primary} c={c} />
      </View>
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
        <StatCard icon={<Users size={16} color="#D97706" />} label={t('drProfile.earnings.paidStudents')}
          value={String(paidStudents)} color="#D97706" c={c} />
        <StatCard icon={<Zap size={16} color="#7C3AED" />} label={t('drProfile.earnings.transactions')}
          value={String(txCount)} color="#7C3AED" c={c} />
        <StatCard icon={<DollarSign size={16} color="#2DA8FF" />} label={t('drProfile.earnings.avgPerStudent')}
          value={fmtEGPPlain(avgPerStudent)} color="#2DA8FF" c={c} />
      </View>

      {/* ── Chart ────────────────────────────────────────────────────── */}
      <EarnSL label={t('drProfile.earnings.timeline')} c={c} />
      <RevenueChart transactions={transactions} c={c} />

      {/* ── Course revenue ───────────────────────────────────────────── */}
      <EarnSL label={t('drProfile.earnings.byCourse')} c={c} />
      <CourseRevenueTable rows={courseRows} c={c} />

      {/* ── Earnings Price + Admin Tools ─────────────────────────────── */}
      <EarnSL label={t('drProfile.earnings.pricingTools')} c={c} />
      <GlobalPriceCard doctorId={doctorId} c={c} onRecalculate={() => { (async () => load())(); }} />

      {/* ── Recent transactions ──────────────────────────────────────── */}
      {transactions.length > 0 && (
        <>
          <EarnSL label={t('drProfile.earnings.recent')} c={c} />
          <NeuCard radius={18} style={{ paddingHorizontal: 16, marginBottom: 20 }}>
            {transactions.slice(0, 30).map(tx => (
              <TxRow key={tx.id} row={tx} onPress={() => setSelectedTx(tx)} c={c} />
            ))}
          </NeuCard>
        </>
      )}

      {transactions.length === 0 && (
        <NeuCard radius={18} style={{ padding: 32, alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <TrendingUp size={32} color={`${c.text}25`} />
          <Text style={{ fontSize: 14, fontWeight: '700', ...mutedTextStyle(c, 0.4), textAlign: 'center' }}>
            {t('drProfile.earnings.none')}
          </Text>
          <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.3), textAlign: 'center', lineHeight: 18 }}>
            {t('drProfile.earnings.noneHint')}
          </Text>
        </NeuCard>
      )}

      {/* ── Student profile modal ─────────────────────────────────────── */}
      {selectedTx && (
        <StudentProfileModal
          tx={selectedTx}
          doctorId={doctorId}
          onClose={() => setSelectedTx(null)}
          onAction={() => { setSelectedTx(null); (async () => load())(); }}
          c={c}
        />
      )}
    </ScrollView>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function DoctorProfile() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const layout = useLayout();
  const insets = layout.insets;
  const { profile, setProfile } = useProfileStore();
  const { t } = useTranslation();

  const [activeTab,    setActiveTab]    = useState<ProfileTab>('profile');
  const [courseCount,  setCourseCount]  = useState<number | null>(null);
  const [studentCount, setStudentCount] = useState<number | null>(null);
  const [refreshing,   setRefreshing]   = useState(false);
  const [dataLoading,  setDataLoading]  = useState(true);
  const [showLogout,   setShowLogout]   = useState(false);

  // ── Edit personal info (name / email) ─────────────────────────────────────
  const [showPersonalEdit, setShowPersonalEdit] = useState(false);
  const [editName, setEditName]     = useState('');
  const [editEmail, setEditEmail]   = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError]   = useState('');

  const openPersonalEdit = () => {
    setEditName(profile?.full_name ?? '');
    setEditEmail(getPublicEmail(profile) ?? '');
    setEditError('');
    setShowPersonalEdit(true);
  };

  const handleSavePersonal = async () => {
    const nameErr = validateRequired(editName, t('profile.fullName'));
    if (nameErr) { setEditError(nameErr); return; }
    if (editEmail.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(editEmail.trim())) {
      setEditError(t('drProfile.invalidEmail')); return;
    }
    if (isInternalEmail(editEmail.trim())) {
      setEditError(t('drProfile.invalidEmail')); return;
    }
    if (!profile?.id) return;
    setEditSaving(true); setEditError('');
    try {
      const updated = await updateProfile(profile.id, {
        full_name:     editName.trim(),
        profile_email: editEmail.trim() || null,
      });
      setProfile({ ...profile, ...(updated as any) });
      showToast({ type: 'success', message: t('drProfile.profileSaved') });
      setShowPersonalEdit(false);
    } catch (e: any) {
      setEditError(friendlyError(e, t('drProfile.saveFailed')));
    }
    setEditSaving(false);
  };

  // ── Change password ───────────────────────────────────────────────────────
  const [showPwdEdit, setShowPwdEdit]   = useState(false);
  const [newPwd, setNewPwd]             = useState('');
  const [confirmPwd, setConfirmPwd]     = useState('');
  const [showPwd, setShowPwd]           = useState(false);
  const [pwdSaving, setPwdSaving]       = useState(false);
  const [pwdError, setPwdError]         = useState('');
  const [pwdSuccess, setPwdSuccess]     = useState(false);

  const openPwdEdit = () => {
    setNewPwd(''); setConfirmPwd(''); setPwdError(''); setPwdSuccess(false); setShowPwd(false);
    setShowPwdEdit(true);
  };

  const handleChangePassword = async () => {
    if (newPwd.length < 8) { setPwdError(t('drProfile.passwordMin')); return; }
    if (newPwd !== confirmPwd) { setPwdError(t('drProfile.passwordMismatch')); return; }
    setPwdSaving(true); setPwdError('');
    try {
      await changePassword(newPwd);
      setPwdSuccess(true);
      setNewPwd(''); setConfirmPwd('');
      setTimeout(() => { setPwdSuccess(false); setShowPwdEdit(false); }, 2000);
    } catch (e: any) {
      setPwdError(e?.message ?? t('drProfile.passwordFailed'));
    }
    setPwdSaving(false);
  };

  // ── Avatar upload ─────────────────────────────────────────────────────────
  const [avatarUploading, setAvatarUploading] = useState(false);
  const {
    ensurePermission: ensurePhotoPermission,
    showRationale: showPhotoRationale,
    setShowRationale: setShowPhotoRationale,
    isBlocked: photoBlocked,
    confirmRequest: confirmPhotoRequest,
  } = usePermission('mediaLibrary');

  const handlePickAvatar = async () => {
    const granted = await ensurePhotoPermission();
    if (!granted) return; // rationale modal will appear
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets[0]?.uri) return;
    if (!profile?.id) return;
    setAvatarUploading(true);
    try {
      const asset = result.assets[0];
      const mime  = resolveImageMime(asset.mimeType, asset.uri);
      const ext   = extFromMime(mime);
      // Unique path per upload (fresh URL → no stale CDN/browser cache) and
      // scoped under the user id, which the backend requires for avatars.
      const path  = buildAvatarStoragePath(profile.id, ext, Date.now());
      // Upload the local file URI directly — RN streams it from disk.
      // Never load the image into JS memory (no arrayBuffer/Blob needed).
      const { error: upErr } = await backendClient.storage
        .from('user-avatars')
        .upload(path, { uri: asset.uri, mimeType: mime, name: avatarFileName(ext) }, {
          upsert: true, contentType: mime,
        });
      if (upErr) throw upErr;
      const { data: { publicUrl } } = backendClient.storage.from('user-avatars').getPublicUrl(path);
      const updated = await updateProfile(profile.id, { avatar_url: publicUrl });
      setProfile({ ...profile, ...(updated as any) });
      showToast({ type: 'success', message: t('drProfile.avatarUpdated') });
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? t('drProfile.avatarUploadFailed') });
    }
    setAvatarUploading(false);
  };

  // ── Avatar removal ────────────────────────────────────────────────────────
  // Same contract as the student profile: clear profiles.avatar_url first
  // (authoritative and persistent), then best-effort delete the storage
  // object. A failure rethrows so the existing photo stays visible with a
  // real error rather than silently blanking the avatar.
  const [avatarRemoving, setAvatarRemoving] = useState(false);
  const handleRemoveAvatar = async () => {
    if (!profile?.id) return;
    setAvatarRemoving(true);
    try {
      const current = profile.avatar_url;
      await removeProfileAvatar(profile.id, current);
      setProfile({ ...profile, avatar_url: null } as any);
      showToast({ type: 'success', message: t('drProfile.photoRemoved') });
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? t('drProfile.photoRemoveFailed') });
    }
    setAvatarRemoving(false);
  };

  // Earnings toggle
  const [earningsEnabled,  setEarningsEnabled]  = useState<boolean>(!!(profile as any)?.earnings_enabled);
  const [earningsToggling, setEarningsToggling] = useState(false);

  // Platform capability (server-authoritative Super Admin flag). When the
  // platform has doctor_earnings switched OFF the earnings system must not be
  // operable from the profile either: the toggle is frozen and the dashboard
  // link is withheld, mirroring the refusal the backend returns on every
  // doctor-facing earnings call (403 feature_disabled).
  const platformEarningsOn = isFeatureEnabled('doctor_earnings');

  const { showToast } = useToast();
  const { balance: credits, loading: credLoading, refresh: refreshCredits } = useCreditBalance();
  const { openEdit: openContactEdit, modal: contactModal } = useContactEdit(profile, setProfile);

  const handleEarningsToggle = async (value: boolean) => {
    if (!profile?.id || earningsToggling || !platformEarningsOn) return;
    setEarningsEnabled(value);
    setProfile({ ...profile, earnings_enabled: value } as any);
    setEarningsToggling(true);
    try {
      await updateProfile(profile.id, { earnings_enabled: value });
      showToast({
        type: 'success',
        message: value
          ? t('drProfile.earningsEnabledToast')
          : t('drProfile.earningsDisabledToast'),
      });
    } catch (e: any) {
      setEarningsEnabled(!value);
      setProfile({ ...profile, earnings_enabled: !value } as any);
      showToast({ type: 'error', message: e?.message ?? t('drProfile.earningsUpdateFailed') });
    }
    setEarningsToggling(false);
  };

  const loadData = useCallback(async () => {
    if (!profile?.id) { setDataLoading(false); return; }
    setDataLoading(true);
    try {
      const { data: { user } } = await backendClient.auth.getUser();
      if (user) {
        const freshProfile = await getProfile(user.id);
        if (freshProfile) setProfile(freshProfile as any);
      }
      const [courses, enrollments] = await Promise.allSettled([
        getCourses({ doctorId: profile.id }),
        getDoctorStudentEnrollments(profile.id),
      ]);
      if (courses.status === 'fulfilled')     setCourseCount(courses.value?.length ?? 0);
      if (enrollments.status === 'fulfilled') setStudentCount(enrollments.value?.length ?? 0);
    } catch (e: any) {
      console.error('[DoctorProfile] loadData error:', e?.message ?? e);
    }
    setDataLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  // Sync toggle with fresh DB value
  const profileEarnings = !!(profile as any)?.earnings_enabled;
  if (!earningsToggling && earningsEnabled !== profileEarnings) {
    setEarningsEnabled(profileEarnings);
  }

  useFocusEffect(useCallback(() => { (async () => { await loadData(); })(); }, [loadData]));

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadData(), refreshCredits()]);
    setRefreshing(false);
  };

  const handleLogout = async () => {
    setShowLogout(false);
    // Eagerly wipe the profile store so no stale role data remains visible
    // while backendClient.auth.signOut() completes and the new session initialises.
    const { clearProfile } = useProfileStore.getState();
    clearProfile();
    await backendClient.auth.signOut();
  };

  const statusColor = profile?.status === 'active' ? '#16A34A'
    : profile?.status === 'suspended' ? '#DC2626' : '#D97706';
  const firstName   = getFirstName(profile?.full_name);
  const isLoading   = dataLoading || credLoading;

  // ── Tab: Profile ───────────────────────────────────────────────────────────
  const renderProfileTab = () => (
    <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      // BOTTOM clearance: layout.scrollBottom() = safeBottom(insets.bottom,
      // tabBarClearance). The raw safeBottom(insets.bottom) reserved only the
      // home indicator, so on iOS the floating NATIVE tab bar (drawn by UIKit
      // outside the RN hierarchy) covered the tail of this scrolling tab.
      // Android/web resolve a 0 clearance — byte-for-byte unchanged there.
      contentContainerStyle={{ paddingHorizontal: layout.screenPx, paddingTop: layout.screenPx, paddingBottom: layout.scrollBottom() }}
    >
      {/* Stats row */}
      <SectionLabel label={t('common.overview')} color={c.text} />
      {isLoading ? (
        <ActivityIndicator color={c.primary} style={{ marginVertical: 20 }} />
      ) : (
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 20 }}>
          {[
            { label: t('drProfile.stats.courses'),  value: courseCount  ?? 0, color: c.primary, icon: <BookOpen  size={20} color={c.primary} /> },
            { label: t('drProfile.stats.students'), value: studentCount ?? 0, color: '#D97706', icon: <Users     size={20} color="#D97706" /> },
            { label: t('drProfile.stats.credits'),  value: credits?.remaining ?? 0, color: '#16A34A', icon: <CreditCard size={20} color="#16A34A" /> },
          ].map(stat => (
            <NeuCard key={stat.label} radius={16} style={{ flex: 1, alignItems: 'center', padding: 14, gap: 6 }}>
              {stat.icon}
              <Text style={{ fontSize: 26, fontWeight: '800', color: stat.color }}>{stat.value}</Text>
              <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5) }}>{stat.label}</Text>
            </NeuCard>
          ))}
        </View>
      )}

      {/* Watermark */}
      <SectionLabel label={t('drProfile.section.watermark')} color={c.text} />
      <WatermarkCard publicUserId={(profile as any)?.public_user_id ?? null} c={c} />

      {/* Account info */}
      <SectionLabel label={t('drProfile.section.account')} color={c.text} />
      <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
        <InfoRow icon={<Mail size={16} color={c.primary} />}  label={t('profile.email')} value={getPublicEmail(profile) ?? t('profile.notSet')} c={c} />
        <InfoRow icon={<Phone size={16} color={c.primary} />} label={t('profile.phone')} value={profile?.phone ?? ''} c={c} />
        <InfoRow icon={<Lock size={16} color={c.text} />}     label={t('profile.role')}  value={t('role.doctor')} c={c} />
      </NeuCard>

      {/* Contact info */}
      <SectionLabel label={t('drProfile.section.contact')} color={c.text} />
      <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
        <InfoRow icon={<MessageCircle size={16} color="#25D366" />} label={t('drProfile.whatsApp')}
          value={(profile as any)?.contact_whatsapp ?? ''} c={c} />
        <InfoRow icon={<Send size={16} color="#229ED9" />}          label={t('drProfile.telegram')}
          value={(profile as any)?.contact_telegram ?? ''} c={c} />
        <InfoRow icon={<Phone size={16} color={c.primary} />}       label={t('profile.phone')}
          value={(profile as any)?.contact_phone ?? ''} c={c} />
        <Pressable onPress={openContactEdit}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                   marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: `${c.text}08` }}>
          <Pencil size={15} color={c.primary} />
          <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary, marginLeft: 7 }}>
            {t('drProfile.editContact')}
          </Text>
        </Pressable>
      </NeuCard>

      {/* Earnings toggle */}
      <SectionLabel label={t('drProfile.section.earnings')} color={c.text} />
      <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4 }}>
          <View style={{ width: 38, height: 38, borderRadius: 12,
                         backgroundColor: earningsEnabled ? '#16A34A18' : `${c.text}0D`,
                         alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
            <TrendingUp size={18} color={earningsEnabled ? '#16A34A' : `${c.text}55`} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{t('drProfile.enableEarnings')}</Text>
            <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45), lineHeight: 16 }}>
              {earningsEnabled
                ? t('drProfile.enableEarningsOn')
                : t('drProfile.enableEarningsOff')}
            </Text>
          </View>
          <Switch
            value={earningsEnabled} onValueChange={handleEarningsToggle}
            disabled={earningsToggling || !platformEarningsOn}
            trackColor={{ false: `${c.text}20`, true: '#16A34A55' }}
            thumbColor={earningsEnabled ? '#16A34A' : `${c.text}66`}
          />
        </View>
        <View style={{ marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: `${c.text}08`,
                       flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4,
                         backgroundColor: earningsEnabled ? '#16A34A' : `${c.text}33` }} />
          <Text style={{ fontSize: 12, color: earningsEnabled ? '#16A34A' : `${c.text}55`, fontWeight: '600' }}>
            {earningsEnabled ? t('drProfile.earningsOn') : t('drProfile.earningsOff')}
          </Text>
          {earningsToggling && <ActivityIndicator size="small" color={c.primary} style={{ marginLeft: 4 }} />}
        </View>
        {!platformEarningsOn && (
          <Text style={{ fontSize: 12, color: `${c.text}77`, marginTop: 10, lineHeight: 17 }}>
            {t('drProfile.featureUnavailable')}
          </Text>
        )}
        {earningsEnabled && platformEarningsOn && (
          <Pressable onPress={() => router.push('/(app)/(doctor)/dr-earnings' as RelativePathString)}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                     marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: `${c.text}08`, gap: 8 }}>
            <TrendingUp size={15} color={c.primary} />
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary }}>{t('drProfile.viewEarnings')}</Text>
            <ChevronRight size={14} color={c.primary} />
          </Pressable>
        )}
      </NeuCard>
    </ScrollView>
  );

  // ── Tab: Settings ──────────────────────────────────────────────────────────
  const renderSettingsTab = () => {
    const INFO_LINKS = [
      { label: t('drProfile.terms'),     icon: FileText,       path: '/(app)/info/terms'   as RelativePathString },
      { label: t('drProfile.privacy'),   icon: Shield,         path: '/(app)/info/privacy' as RelativePathString },
      { label: t('drProfile.about'),     icon: Info,           path: '/(app)/info/about'   as RelativePathString },
      { label: t('drProfile.contactUs'), icon: HeartHandshake, path: '/(app)/info/contact' as RelativePathString },
    ];
    return (
      <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
        style={{ flex: 1, backgroundColor: c.base }}
        // See renderProfileTab: same iOS native-tab-bar clearance.
        contentContainerStyle={{ paddingHorizontal: layout.screenPx, paddingTop: layout.screenPx, paddingBottom: layout.scrollBottom() }}
      >
        {/* ── Edit Profile ───────────────────────────────────────────── */}
        <SectionLabel label={t('common.profile')} color={c.text} />
        <NeuCard radius={18} style={{ padding: 16, marginBottom: 20 }}>
          <InfoRow icon={<Mail size={16} color={c.primary} />}  label={t('profile.email')} value={getPublicEmail(profile) ?? t('profile.notSet')} c={c} />
          <InfoRow icon={<Phone size={16} color={c.primary} />} label={t('profile.phone')} value={profile?.phone ?? ''} c={c} />
          <Pressable
            onPress={openPersonalEdit}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                     marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: `${c.text}08` }}
          >
            <Pencil size={15} color={c.primary} />
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary, marginLeft: 7 }}>{t('drProfile.editNameEmail')}</Text>
          </Pressable>
        </NeuCard>

        {/* ── Security ───────────────────────────────────────────────── */}
        <SectionLabel label={t('profile.security')} color={c.text} />
        <NeuCard radius={18} style={{ paddingHorizontal: 16, marginBottom: 20 }}>
          <Pressable onPress={openPwdEdit}
            style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14,
                     borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
            <Lock size={18} color={c.primary} />
            <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: c.text, marginLeft: 10 }}>{t('drProfile.changePassword')}</Text>
            <ChevronRight size={16} color={c.text} opacity={0.3} />
          </Pressable>
          <Pressable onPress={() => setShowLogout(true)}
            style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14 }}>
            <LogOut size={18} color="#DC2626" />
            <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: '#DC2626', marginLeft: 10 }}>{t('common.signOut')}</Text>
          </Pressable>
        </NeuCard>

        {/* ── Information Links ───────────────────────────────────────── */}
        <SectionLabel label={t('drProfile.section.information')} color={c.text} />
        <NeuCard radius={18} style={{ paddingHorizontal: 16, marginBottom: 20 }}>
          {INFO_LINKS.map((item, idx) => (
            <Pressable
              key={item.path}
              onPress={() => router.push(item.path)}
              style={{
                flexDirection: 'row', alignItems: 'center', paddingVertical: 14,
                borderBottomWidth: idx < INFO_LINKS.length - 1 ? 1 : 0,
                borderBottomColor: `${c.text}08`,
              }}
            >
              <item.icon size={18} color={c.primary} />
              <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: c.text, marginLeft: 10 }}>{item.label}</Text>
              <ChevronRight size={16} color={c.text} opacity={0.3} />
            </Pressable>
          ))}
        </NeuCard>

        {/* ── App Language — in-app selector, follows the device by default ── */}
        <LanguageSetting />

        {/* ── Edit Personal Info Modal ───────────────────────────────── */}
        <ResponsiveModal
          visible={showPersonalEdit}
          onClose={() => setShowPersonalEdit(false)}
          title={t('profile.editProfile')}
          footer={
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <NeuButton label={t('common.cancel')} onPress={() => setShowPersonalEdit(false)} variant="secondary" style={{ flex: 1 }} />
              <NeuButton label={t('common.save')} onPress={handleSavePersonal} loading={editSaving} style={{ flex: 1 }} />
            </View>
          }
        >
          
            <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{t('profile.fullName')}</Text>
            <NeuInputRow
              c={c}
              value={editName}
              onChangeText={setEditName}
              placeholder={t('drProfile.fullNamePlaceholder')}
              leftIcon={<User size={16} color={c.text} opacity={0.4} />}
            />
            <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{t('profile.email')}</Text>
            <NeuInputRow
              c={c}
              value={editEmail}
              onChangeText={setEditEmail}
              placeholder={t('profile.notSet')}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              leftIcon={<Mail size={16} color={c.text} opacity={0.4} />}
            />
            <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4), marginBottom: 12, marginTop: -10, lineHeight: 16 }}>
              {t('drProfile.loginMethodUnchanged')}
            </Text>
            {editError ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <AlertCircle size={14} color="#DC2626" />
                <Text style={{ color: '#DC2626', fontSize: 13, marginLeft: 6, flex: 1 }}>{editError}</Text>
              </View>
            ) : null}
          
        </ResponsiveModal>

        {/* ── Change Password Modal ──────────────────────────────────── */}
        <ResponsiveModal
          visible={showPwdEdit}
          onClose={() => setShowPwdEdit(false)}
          title={t('drProfile.changePassword')}
          footer={
            !pwdSuccess ? (
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <NeuButton label={t('common.cancel')} onPress={() => setShowPwdEdit(false)} variant="secondary" style={{ flex: 1 }} />
                <NeuButton label={t('drProfile.update')} onPress={handleChangePassword} loading={pwdSaving} style={{ flex: 1 }} />
              </View>
            ) : undefined
          }
        >
          
            {pwdSuccess ? (
              <View style={{ alignItems: 'center', paddingVertical: 12, gap: 10 }}>
                <CheckCircle size={44} color="#16A34A" />
                <Text style={{ fontSize: 16, fontWeight: '700', color: '#16A34A' }}>{t('drProfile.passwordUpdated')}</Text>
              </View>
            ) : (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{t('drProfile.newPassword')}</Text>
                <NeuInputRow
                  c={c}
                  value={newPwd}
                  onChangeText={setNewPwd}
                  placeholder={t('drProfile.minEightChars')}
                  secureTextEntry={!showPwd}
                  leftIcon={<Lock size={16} color={c.text} opacity={0.4} />}
                  rightElement={
                    <Pressable onPress={() => setShowPwd(p => !p)}>
                      {showPwd ? <EyeOff size={16} color={c.text} opacity={0.4} /> : <Eye size={16} color={c.text} opacity={0.4} />}
                    </Pressable>
                  }
                />
                <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{t('drProfile.confirmPassword')}</Text>
                <NeuInputRow
                  c={c}
                  containerStyle={{ marginBottom: 4 }}
                  value={confirmPwd}
                  onChangeText={setConfirmPwd}
                  placeholder={t('drProfile.reenterPassword')}
                  secureTextEntry={!showPwd}
                  leftIcon={<Lock size={16} color={c.text} opacity={0.4} />}
                />
                {pwdError ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                    <AlertCircle size={14} color="#DC2626" />
                    <Text style={{ color: '#DC2626', fontSize: 13, marginLeft: 6, flex: 1 }}>{pwdError}</Text>
                  </View>
                ) : null}
              </>
            )}
          
        </ResponsiveModal>
      </ScrollView>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PermissionRationaleModal
        type="mediaLibrary"
        visible={showPhotoRationale}
        isBlocked={photoBlocked}
        onConfirm={confirmPhotoRequest}
        onDismiss={() => setShowPhotoRationale(false)}
      />
      {/* ── Avatar + name header ─────────────────────────────────────────── */}
      {/* This header is a SIBLING of the scroll container (it does not scroll),
          so it must own the status-bar / Dynamic-Island clearance itself. It
          used a hardcoded paddingTop: 20 — on notched iPhones (insets.top ≈
          47–62) the avatar row started UNDER the status bar / Dynamic Island
          and was clipped. `layout.headerTop` is the same shared primitive
          PageHeader uses (max(insets.top + breathing, floor)), so the profile
          now sits on the app-wide header grid like every other screen. */}
      <View style={{ paddingTop: layout.headerTop, paddingHorizontal: layout.screenPx, paddingBottom: 0,
                     backgroundColor: c.base }}>
        <View style={{ alignItems: 'center', marginBottom: 20 }}>
          <ProfilePhotoActions
            avatarUrl={profile?.avatar_url}
            c={c}
            size={88}
            marginBottom={12}
            uploading={avatarUploading}
            removing={avatarRemoving}
            onPick={handlePickAvatar}
            onRemove={handleRemoveAvatar}
          />
          <Text style={{ fontSize: 20, fontWeight: '800', color: c.text }}>{profile?.full_name || '—'}</Text>
          <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.45), marginTop: 3 }}>
            {firstName ? t('drProfile.doctorPrefix', { name: firstName }) : t('role.doctor')}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <View style={{ backgroundColor: `${statusColor}18`, borderRadius: 20,
                           paddingHorizontal: 12, paddingVertical: 4 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: statusColor, textTransform: 'capitalize' }}>
                {profile?.status ?? 'active'}
              </Text>
            </View>
            <View style={{ backgroundColor: `${c.primary}12`, borderRadius: 20,
                           paddingHorizontal: 12, paddingVertical: 4 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>{t('role.doctor')}</Text>
            </View>
          </View>
        </View>

        {/* ── Tab bar ─────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', backgroundColor: `${c.text}0A`,
                       borderRadius: 14, padding: 4, marginBottom: 4 }}>
          {PROFILE_TABS.map(tab => {
            const active = activeTab === tab.key;
            return (
              <Pressable key={tab.key} onPress={() => setActiveTab(tab.key)}
                style={{ flex: 1, paddingVertical: 9, borderRadius: 11, alignItems: 'center',
                         backgroundColor: active ? c.base : 'transparent',
                         ...(active ? {
                           shadowColor: c.shadowDark, shadowOffset: { width: 1, height: 2 },
                           shadowOpacity: 0.35, shadowRadius: 5,
                         } : {}) }}>
                <Text style={{ fontSize: 13, fontWeight: '700',
                               color: active ? c.primary : `${c.text}55` }}>
                  {t(tab.labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* ── Tab content ─────────────────────────────────────────────────── */}
      {activeTab === 'profile'  && renderProfileTab()}
      {activeTab === 'settings' && renderSettingsTab()}

      {/* ── Logout confirmation ──────────────────────────────────────────── */}
      <ResponsiveModal
        visible={showLogout}
        onClose={() => setShowLogout(false)}
        title={t('drProfile.signOutTitle')}
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label={t('common.cancel')} onPress={() => setShowLogout(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label={t('common.signOut')} onPress={handleLogout} style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.6), lineHeight: 22 }}>
          {t('drProfile.signOutBody')}
        </Text>
      </ResponsiveModal>

      {contactModal}
    </View>
  );
}
