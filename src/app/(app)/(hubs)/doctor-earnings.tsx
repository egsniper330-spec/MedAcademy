/**
 * Doctor Earnings — Admin view
 * Full earnings dashboard with:
 *  - Custom pricing toggle (platform vs doctor-controlled)
 *  - Earnings mode selector (credit-based vs course-based)
 *  - Per-doctor KPI cards (total, monthly, today, enrollments, courses, avg price)
 *  - Per-course revenue breakdown
 *  - Grand totals
 *  - Pricing change history
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, Pressable,
  TextInput, useColorScheme, RefreshControl,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  TrendingUp, DollarSign, BookOpen, Users, Calendar,
  BarChart3, ChevronRight, Check, History, Tag, CreditCard,
  ArrowLeft, ToggleLeft, ToggleRight,
} from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { PageHeader } from '@/components/PageHeader';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { neuColors, useLayout, safeBottom, mutedTextStyle } from '@/lib/neu';
import { useToast } from '@/components/Toast';
import {
  getAdminDoctorEarningsDashboard,
  setDoctorEarningsSettings,
  setDoctorCreditPrice,
  setDoctorCoursePrice,
  getDoctorPricingHistory,
} from '@/lib/api';
import type {
  AdminDoctorEarningsDashboard,
  DoctorEarningsCourse,
  DoctorPricingHistoryRow,
} from '@/lib/api';
import { useTranslation } from '@/lib/i18n';

/** Money is LTR content: the currency code and Latin digits never mirror. */
const fmt = (n: number, locale: string) =>
  `EGP ${n.toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-US', {
    numberingSystem: 'latn',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;

const fmtDate = (iso: string, locale: string) =>
  new Date(iso).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-US', {
    numberingSystem: 'latn',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

export default function DoctorEarningsScreen() {
  const router = useRouter();
  const { doctor_id, doctor_name } = useLocalSearchParams<{
    doctor_id: string;
    doctor_name?: string;
  }>();
  const scheme  = useColorScheme();
  const isDark  = scheme === 'dark';
  const c       = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { showToast } = useToast();
  const { t, tCount, locale } = useTranslation();
  const money = (n: number) => fmt(n, locale);

  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dashboard,  setDashboard]  = useState<AdminDoctorEarningsDashboard | null>(null);
  const [history,    setHistory]    = useState<DoctorPricingHistoryRow[]>([]);

  // Settings editing
  const [settingsModal, setSettingsModal] = useState(false);
  const [draftEnabled,  setDraftEnabled]  = useState(false);
  const [draftMode,     setDraftMode]     = useState<'credit' | 'course'>('credit');
  const [settingsSaving, setSettingsSaving] = useState(false);

  // Credit price editing
  const [creditModal,  setCreditModal]  = useState(false);
  const [creditInput,  setCreditInput]  = useState('');
  const [creditSaving, setCreditSaving] = useState(false);

  // Course price editing
  const [courseModal,  setCourseModal]  = useState(false);
  const [editCourse,   setEditCourse]   = useState<DoctorEarningsCourse | null>(null);
  const [courseInput,  setCourseInput]  = useState('');
  const [courseSaving, setCourseSaving] = useState(false);

  // History modal
  const [historyModal, setHistoryModal] = useState(false);

  const load = useCallback(async () => {
    if (!doctor_id) { setLoading(false); return; }
    try {
      const [dash, hist] = await Promise.all([
        getAdminDoctorEarningsDashboard(doctor_id),
        getDoctorPricingHistory(doctor_id, 50),
      ]);
      setDashboard(dash);
      setHistory(hist);
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? t('doctorEarnings.loadFailed') });
    }
    setLoading(false);
  }, [doctor_id]);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const openSettings = () => {
    if (!dashboard) return;
    setDraftEnabled(dashboard.custom_pricing_enabled);
    setDraftMode(dashboard.earnings_mode);
    setSettingsModal(true);
  };

  const saveSettings = async () => {
    setSettingsSaving(true);
    try {
      await setDoctorEarningsSettings(doctor_id!, draftEnabled, draftMode);
      showToast({ type: 'success', message: t('doctorEarnings.settingsUpdated') });
      setSettingsModal(false);
      await load();
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? t('doctorEarnings.settingsUpdateFailed') });
    }
    setSettingsSaving(false);
  };

  const saveCreditPrice = async () => {
    const val = parseFloat(creditInput);
    if (isNaN(val) || val < 0) {
      showToast({ type: 'error', message: t('doctorEarnings.invalidPrice') });
      return;
    }
    setCreditSaving(true);
    try {
      await setDoctorCreditPrice(doctor_id!, val);
      showToast({ type: 'success', message: t('doctorEarnings.creditPriceSet', { price: val }) });
      setCreditModal(false);
      await load();
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? t('doctorEarnings.priceUpdateFailed') });
    }
    setCreditSaving(false);
  };

  const saveCoursePrice = async () => {
    if (!editCourse) return;
    const val = parseFloat(courseInput);
    if (isNaN(val) || val < 0) {
      showToast({ type: 'error', message: t('doctorEarnings.invalidPrice') });
      return;
    }
    setCourseSaving(true);
    try {
      await setDoctorCoursePrice(editCourse.course_id, val);
      showToast({ type: 'success', message: t('doctorEarnings.coursePriceUpdated', { course: editCourse.course_title }) });
      setCourseModal(false);
      await load();
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? t('doctorEarnings.coursePriceFailed') });
    }
    setCourseSaving(false);
  };

  const inp = {
    backgroundColor: c.base, borderRadius: 14,
    paddingHorizontal: 16, paddingVertical: 13,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.45, shadowRadius: 6,
    fontSize: 16, fontWeight: '700', color: c.text,
  } as any;

  const totalRevenue  = (dashboard?.per_course ?? []).reduce((s, x) => s + x.course_revenue, 0);
  const totalStudents = (dashboard?.per_course ?? []).reduce((s, x) => s + x.enrollment_count, 0);

  const fieldLabel = (name: string) => {
    if (name === 'custom_pricing_enabled') return t('doctorEarnings.customPricing');
    if (name === 'earnings_mode')           return t('doctorEarnings.earningsMode');
    if (name === 'credit_selling_price')    return t('doctorEarnings.creditPrice');
    if (name.startsWith('course_price:'))   return t('doctorEarnings.coursePriceTitle');
    return name;
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
      >
        <View style={{ padding: layout.screenPx, gap: 16 }}>

          {/* ── Header ── */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Pressable onPress={() => router.back()}
              style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${c.text}0D`,
                alignItems: 'center', justifyContent: 'center' }}>
              <ArrowLeft size={18} color={c.text} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <PageHeader
                title={t('nav.earnings')}
                subtitle={decodeURIComponent(doctor_name ?? t('doctorEarnings.doctorFallback'))}
                accentColor="#16A34A"
              />
            </View>
          </View>

          {loading && <ActivityIndicator size="large" color={c.primary} style={{ marginVertical: 40 }} />}

          {!loading && dashboard && (
            <>
              {/* ── Earnings Settings Card ── */}
              <NeuCard style={{ padding: 18, gap: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: c.text, opacity: 0.7, letterSpacing: 0.5 }}>
                    {t('doctorEarnings.settingsSection')}
                  </Text>
                  <Pressable onPress={openSettings}
                    style={{ backgroundColor: `${c.primary}15`, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>{t('common.edit')}</Text>
                  </Pressable>
                </View>

                {/* Custom pricing toggle */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  {dashboard.custom_pricing_enabled
                    ? <ToggleRight size={28} color="#16A34A" />
                    : <ToggleLeft size={28} color={`${c.text}40`} />}
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{t('doctorEarnings.customPricing')}</Text>
                    <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5) }}>
                      {dashboard.custom_pricing_enabled
                        ? t('doctorEarnings.customPricingOnHint')
                        : t('doctorEarnings.customPricingOffHint')}
                    </Text>
                  </View>
                  <View style={{
                    backgroundColor: dashboard.custom_pricing_enabled ? '#16A34A18' : `${c.text}10`,
                    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
                  }}>
                    <Text style={{
                      fontSize: 11, fontWeight: '700',
                      color: dashboard.custom_pricing_enabled ? '#16A34A' : `${c.text}60`,
                    }}>
                      {dashboard.custom_pricing_enabled ? t('doctorEarnings.on') : t('doctorEarnings.off')}
                    </Text>
                  </View>
                </View>

                {/* Pricing mode (only relevant if custom ON) */}
                {dashboard.custom_pricing_enabled && (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {(['credit', 'course'] as const).map(mode => (
                      <View key={mode} style={{
                        flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
                        backgroundColor: dashboard.earnings_mode === mode ? `${c.primary}15` : `${c.text}08`,
                        borderRadius: 12, padding: 12,
                        borderWidth: 1.5,
                        borderColor: dashboard.earnings_mode === mode ? c.primary : 'transparent',
                      }}>
                        {dashboard.earnings_mode === mode
                          ? <Check size={14} color={c.primary} />
                          : <View style={{ width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: `${c.text}30` }} />}
                        <View>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: dashboard.earnings_mode === mode ? c.primary : `${c.text}70` }}>
                            {mode === 'credit' ? t('doctorEarnings.creditBased') : t('doctorEarnings.courseBased')}
                          </Text>
                          <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.4) }}>
                            {mode === 'credit' ? t('doctorEarnings.creditsTimesPrice') : t('doctorEarnings.perCoursePrice')}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                {/* Credit price (if credit mode) */}
                {dashboard.custom_pricing_enabled && dashboard.earnings_mode === 'credit' && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                    backgroundColor: '#7C3AED0D', borderRadius: 12, padding: 14 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <DollarSign size={18} color="#7C3AED" />
                      <View>
                        <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45) }}>{t('doctorEarnings.creditPrice')}</Text>
                        <Text style={{ fontSize: 20, fontWeight: '900', color: '#7C3AED' }}>
                          {money(dashboard.credit_selling_price)}
                        </Text>
                      </View>
                    </View>
                    <Pressable onPress={() => { setCreditInput(String(dashboard.credit_selling_price)); setCreditModal(true); }}
                      style={{ backgroundColor: '#7C3AED18', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#7C3AED' }}>{t('doctorEarnings.change')}</Text>
                    </Pressable>
                  </View>
                )}
              </NeuCard>

              {/* ── Earnings KPIs ── */}
              <Text style={{ fontSize: 11, fontWeight: '800', ...mutedTextStyle(c, 0.4), letterSpacing: 0.5 }}>
                {t('doctorEarnings.overview')}
              </Text>

              {/* Big total */}
              <NeuCard style={{ padding: layout.screenPx, alignItems: 'center', gap: 6 }}>
                <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: '#16A34A18',
                  alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                  <TrendingUp size={26} color="#16A34A" />
                </View>
                <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45) }}>{t('doctorEarnings.totalEarnings')}</Text>
                <Text style={{ fontSize: 36, fontWeight: '900', color: '#16A34A' }}>
                  {money(dashboard.total_earnings)}
                </Text>
                <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.3) }}>
                  {dashboard.custom_pricing_enabled
                    ? (dashboard.earnings_mode === 'credit' ? t('doctorEarnings.creditBasedPricing') : t('doctorEarnings.courseBasedPricing'))
                    : t('doctorEarnings.platformPricing')}
                </Text>
              </NeuCard>

              {/* Monthly / Today */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <NeuCard style={{ flex: 1, padding: 16, alignItems: 'center', gap: 4 }}>
                  <Calendar size={18} color={c.primary} />
                  <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45) }}>{t('doctorEarnings.thisMonth')}</Text>
                  <Text style={{ fontSize: 20, fontWeight: '800', color: c.primary }}>
                    {money(dashboard.monthly_earnings)}
                  </Text>
                </NeuCard>
                <NeuCard style={{ flex: 1, padding: 16, alignItems: 'center', gap: 4 }}>
                  <BarChart3 size={18} color="#D97706" />
                  <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45) }}>{t('doctorEarnings.today')}</Text>
                  <Text style={{ fontSize: 20, fontWeight: '800', color: '#D97706' }}>
                    {money(dashboard.today_earnings)}
                  </Text>
                </NeuCard>
              </View>

              {/* Other KPIs */}
              <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                {[
                  { label: t('doctorEarnings.totalEnrollments'), value: dashboard.total_enrollments, color: '#2DA8FF', icon: Users },
                  { label: t('doctorEarnings.paidCourses'),       value: dashboard.paid_courses_count, color: '#7C3AED', icon: BookOpen },
                  { label: t('doctorEarnings.avgCoursePrice'),   value: money(Math.round(dashboard.avg_course_price)), color: '#16A34A', icon: Tag },
                ].map(k => {
                  const Icon = k.icon;
                  return (
                    <NeuCard key={k.label} style={{ flexBasis: '47%', padding: 14, gap: 6 }}>
                      <Icon size={16} color={k.color} />
                      <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45) }}>{k.label}</Text>
                      <Text style={{ fontSize: 20, fontWeight: '900', color: k.color }}>{k.value}</Text>
                    </NeuCard>
                  );
                })}
              </View>

              {/* ── Per-Course Breakdown ── */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: '800', ...mutedTextStyle(c, 0.4), letterSpacing: 0.5 }}>
                  {t('doctorEarnings.perCourse', { count: dashboard.per_course.length })}
                </Text>
              </View>

              {dashboard.per_course.length === 0 ? (
                <NeuCard style={{ padding: 40, alignItems: 'center', gap: 10 }}>
                  <BookOpen size={36} color={c.text} opacity={0.15} />
                  <Text style={{ ...mutedTextStyle(c, 0.4), fontSize: 14 }}>{t('doctorEarnings.noCourses')}</Text>
                </NeuCard>
              ) : (
                dashboard.per_course.map((course: DoctorEarningsCourse, idx: number) => (
                  <NeuCard key={course.course_id} style={{ padding: 16, gap: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                      <View style={{ flex: 1, paddingRight: 10 }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>
                          {course.course_title}
                        </Text>
                        {dashboard.custom_pricing_enabled && dashboard.earnings_mode === 'course' && (
                          <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45), marginTop: 2 }}>
                            {t('doctorEarnings.priceLabel', { price: course.current_price })}
                          </Text>
                        )}
                      </View>
                      {dashboard.custom_pricing_enabled && dashboard.earnings_mode === 'course' && (
                        <Pressable
                          onPress={() => {
                            setEditCourse(course);
                            setCourseInput(String(course.current_price));
                            setCourseModal(true);
                          }}
                          style={{ backgroundColor: `${c.primary}12`, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 5 }}>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>{t('doctorEarnings.setPrice')}</Text>
                        </Pressable>
                      )}
                    </View>

                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {[
                        { label: t('doctorEarnings.students'), value: String(course.enrollment_count), color: '#2DA8FF' },
                        { label: t('doctorEarnings.revenue'),  value: money(course.course_revenue),       color: '#16A34A' },
                        { label: t('doctorEarnings.avgPrice'), value: money(Math.round(course.avg_price_at_sale)), color: '#D97706' },
                      ].map(s => (
                        <View key={s.label} style={{
                          flex: 1, backgroundColor: `${s.color}10`,
                          borderRadius: 10, padding: 10, alignItems: 'center',
                        }}>
                          <Text style={{ fontSize: 15, fontWeight: '800', color: s.color }}>{s.value}</Text>
                          <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.4), marginTop: 2 }}>{s.label}</Text>
                        </View>
                      ))}
                    </View>
                  </NeuCard>
                ))
              )}

              {/* ── Grand Totals ── */}
              <Text style={{ fontSize: 11, fontWeight: '800', ...mutedTextStyle(c, 0.4), letterSpacing: 0.5 }}>
                {t('doctorEarnings.grandTotal')}
              </Text>
              <NeuCard style={{ padding: 18, gap: 14 }}>
                {[
                  { label: t('doctorEarnings.totalStudents'), value: String(totalStudents), color: '#2DA8FF',  icon: Users     },
                  { label: t('doctorEarnings.totalCourses'),  value: String(dashboard.per_course.length), color: '#7C3AED', icon: BookOpen  },
                  { label: t('doctorEarnings.totalRevenue'),  value: money(totalRevenue),     color: '#16A34A', icon: TrendingUp },
                ].map(row => {
                  const Icon = row.icon;
                  return (
                    <View key={row.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${row.color}15`,
                        alignItems: 'center', justifyContent: 'center' }}>
                        <Icon size={18} color={row.color} />
                      </View>
                      <Text style={{ flex: 1, fontSize: 14, color: c.text, opacity: 0.7 }}>{row.label}</Text>
                      <Text style={{ fontSize: 18, fontWeight: '900', color: row.color }}>{row.value}</Text>
                    </View>
                  );
                })}
              </NeuCard>

              {/* ── Pricing History ── */}
              <Pressable onPress={() => setHistoryModal(true)}
                style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  backgroundColor: `${c.text}06`, borderRadius: 14, padding: 16,
                }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <History size={18} color={c.text} opacity={0.5} />
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{t('doctorEarnings.pricingHistory')}</Text>
                    <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.4) }}>{tCount('doctorEarnings.records', history.length)}</Text>
                  </View>
                </View>
                <ChevronRight size={16} color={`${c.text}40`} />
              </Pressable>

            </>
          )}
        </View>
      </ScrollView>

      {/* ── Settings Modal ── */}
      <ResponsiveModal
        visible={settingsModal}
        onClose={() => setSettingsModal(false)}
        title={t('doctorEarnings.settingsTitle')}
        subtitle={decodeURIComponent(doctor_name ?? t('doctorEarnings.doctorFallback'))}
        footer={
          <View style={{ gap: 10 }}>
            <NeuButton label={settingsSaving ? t('common.saving') : t('doctorEarnings.saveSettings')} loading={settingsSaving} fullWidth onPress={saveSettings} />
            <NeuButton label={t('common.cancel')} variant="secondary" fullWidth onPress={() => setSettingsModal(false)} />
          </View>
        }
      >
        <View style={{ gap: 16 }}>
          {/* Toggle */}
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5) }}>{t('doctorEarnings.customPricing')}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[
                { val: false, label: t('doctorEarnings.offPlatformPrice') },
                { val: true,  label: t('doctorEarnings.onCustomPrice')    },
              ].map(opt => (
                <Pressable key={String(opt.val)} onPress={() => setDraftEnabled(opt.val)}
                  style={{
                    flex: 1, padding: 14, borderRadius: 14, alignItems: 'center',
                    backgroundColor: draftEnabled === opt.val ? `${c.primary}18` : `${c.text}0A`,
                    borderWidth: 1.5,
                    borderColor: draftEnabled === opt.val ? c.primary : 'transparent',
                  }}>
                  {draftEnabled === opt.val
                    ? <Check size={16} color={c.primary} style={{ marginBottom: 4 }} />
                    : <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 1.5,
                        borderColor: `${c.text}30`, marginBottom: 4 }} />}
                  <Text style={{ fontSize: 12, fontWeight: '700', textAlign: 'center',
                    color: draftEnabled === opt.val ? c.primary : `${c.text}60` }}>
                    {opt.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Mode (only if custom ON) */}
          {draftEnabled && (
            <View style={{ gap: 8 }}>
              <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5) }}>{t('doctorEarnings.earningsMode')}</Text>
              {[
                { val: 'credit' as const, label: t('doctorEarnings.creditBased'), desc: t('doctorEarnings.creditModeDesc') },
                { val: 'course' as const, label: t('doctorEarnings.courseBased'), desc: t('doctorEarnings.courseModeDesc') },
              ].map(opt => (
                <Pressable key={opt.val} onPress={() => setDraftMode(opt.val)}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 14,
                    padding: 14, borderRadius: 14,
                    backgroundColor: draftMode === opt.val ? `${c.primary}15` : `${c.text}0A`,
                    borderWidth: 1.5,
                    borderColor: draftMode === opt.val ? c.primary : 'transparent',
                  }}>
                  <View style={{
                    width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: draftMode === opt.val ? c.primary : 'transparent',
                    borderWidth: 1.5, borderColor: draftMode === opt.val ? c.primary : `${c.text}30`,
                  }}>
                    {draftMode === opt.val && <Check size={12} color="#fff" />}
                  </View>
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: draftMode === opt.val ? c.primary : c.text }}>
                      {opt.label}
                    </Text>
                    <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4) }}>{opt.desc}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}

          {!draftEnabled && (
            <View style={{ backgroundColor: `${c.text}08`, borderRadius: 12, padding: 14 }}>
              <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5), lineHeight: 18 }}>
                {t('doctorEarnings.offExplanation')}
              </Text>
            </View>
          )}
        </View>
      </ResponsiveModal>

      {/* ── Credit Price Modal ── */}
      <ResponsiveModal
        visible={creditModal}
        onClose={() => setCreditModal(false)}
        title={t('doctorEarnings.creditPriceTitle')}
        subtitle={decodeURIComponent(doctor_name ?? t('doctorEarnings.doctorFallback'))}
        footer={
          <View style={{ gap: 10 }}>
            <NeuButton label={creditSaving ? t('common.saving') : t('doctorEarnings.savePrice')} loading={creditSaving} fullWidth onPress={saveCreditPrice} />
            <NeuButton label={t('common.cancel')} variant="secondary" fullWidth onPress={() => setCreditModal(false)} />
          </View>
        }
      >
        <View style={{ gap: 14 }}>
          <View style={{ backgroundColor: '#7C3AED0D', borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45) }}>{t('doctorEarnings.current')}</Text>
            <Text style={{ fontSize: 24, fontWeight: '900', color: '#7C3AED' }}>
              {money(dashboard?.credit_selling_price ?? 0)}
            </Text>
          </View>
          <View>
            <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5), marginBottom: 8 }}>{t('doctorEarnings.newPriceEgp')}</Text>
            <TextInput
              value={creditInput}
              onChangeText={setCreditInput}
              placeholder={t('doctorEarnings.placeholder120')}
              placeholderTextColor={`${c.text}50`}
              keyboardType="decimal-pad"
              style={[inp, { minWidth: 0 }]}
            />
            <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.3), marginTop: 8, lineHeight: 16 }}>
              {t('doctorEarnings.creditHint')}
              {'\n'}
              {t('doctorEarnings.creditHintKeep')}
            </Text>
          </View>
        </View>
      </ResponsiveModal>

      {/* ── Course Price Modal ── */}
      <ResponsiveModal
        visible={courseModal}
        onClose={() => setCourseModal(false)}
        title={t('doctorEarnings.coursePriceTitle')}
        subtitle={editCourse?.course_title ?? ''}
        footer={
          <View style={{ gap: 10 }}>
            <NeuButton label={courseSaving ? t('common.saving') : t('doctorEarnings.savePrice')} loading={courseSaving} fullWidth onPress={saveCoursePrice} />
            <NeuButton label={t('common.cancel')} variant="secondary" fullWidth onPress={() => setCourseModal(false)} />
          </View>
        }
      >
        <View style={{ gap: 14 }}>
          <View style={{ backgroundColor: `${c.primary}0D`, borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45) }}>{t('doctorEarnings.currentPrice')}</Text>
            <Text style={{ fontSize: 24, fontWeight: '900', color: c.primary }}>
              {money(editCourse?.current_price ?? 0)}
            </Text>
          </View>
          <View>
            <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5), marginBottom: 8 }}>{t('doctorEarnings.newPriceEgp')}</Text>
            <TextInput
              value={courseInput}
              onChangeText={setCourseInput}
              placeholder={t('doctorEarnings.placeholder300')}
              placeholderTextColor={`${c.text}50`}
              keyboardType="decimal-pad"
              style={[inp, { minWidth: 0 }]}
            />
            <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.3), marginTop: 8, lineHeight: 16 }}>
              {t('doctorEarnings.courseHint')}
              {'\n'}
              {t('doctorEarnings.courseHintKeep')}
            </Text>
          </View>
        </View>
      </ResponsiveModal>

      {/* ── Pricing History Modal ── */}
      <ResponsiveModal
        visible={historyModal}
        onClose={() => setHistoryModal(false)}
        title={t('doctorEarnings.pricingHistory')}
        subtitle={decodeURIComponent(doctor_name ?? t('doctorEarnings.doctorFallback'))}
      >
        <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} style={{ maxHeight: 480 }} showsVerticalScrollIndicator={false}>
          {history.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <History size={36} color={c.text} opacity={0.15} />
              <Text style={{ ...mutedTextStyle(c, 0.4), marginTop: 12 }}>{t('doctorEarnings.noChanges')}</Text>
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              {history.map(row => (
                <NeuCard key={row.id} style={{ padding: 14, gap: 6 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>
                      {fieldLabel(row.field_name)}
                    </Text>
                    <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.35) }}>
                      {fmtDate(row.created_at, locale)}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ flex: 1, backgroundColor: '#DC262610', borderRadius: 8, padding: 8 }}>
                      <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.4) }}>{t('doctorEarnings.old')}</Text>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>
                        {row.old_value ?? '—'}
                      </Text>
                    </View>
                    <ChevronRight size={14} color={`${c.text}30`} />
                    <View style={{ flex: 1, backgroundColor: '#16A34A10', borderRadius: 8, padding: 8 }}>
                      <Text style={{ fontSize: 10, ...mutedTextStyle(c, 0.4) }}>{t('doctorEarnings.new')}</Text>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>
                        {row.new_value ?? '—'}
                      </Text>
                    </View>
                  </View>
                  <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.35) }}>
                    {t('doctorEarnings.changedBy', { name: row.changer_name ?? t('doctorEarnings.unknown') })}
                  </Text>
                </NeuCard>
              ))}
            </View>
          )}
        </ScrollView>
      </ResponsiveModal>
    </View>
  );
}
