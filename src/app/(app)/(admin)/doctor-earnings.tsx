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
import { neuColors } from '@/lib/neu';
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

const fmt = (n: number) =>
  `EGP ${n.toLocaleString('en-EG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
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
  const { showToast } = useToast();

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
      showToast({ type: 'error', message: e?.message ?? 'Failed to load earnings' });
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
      showToast({ type: 'success', message: 'Earnings settings updated.' });
      setSettingsModal(false);
      await load();
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to update settings.' });
    }
    setSettingsSaving(false);
  };

  const saveCreditPrice = async () => {
    const val = parseFloat(creditInput);
    if (isNaN(val) || val < 0) {
      showToast({ type: 'error', message: 'Enter a valid price ≥ 0.' });
      return;
    }
    setCreditSaving(true);
    try {
      await setDoctorCreditPrice(doctor_id!, val);
      showToast({ type: 'success', message: `Credit price set to EGP ${val}.` });
      setCreditModal(false);
      await load();
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to update price.' });
    }
    setCreditSaving(false);
  };

  const saveCoursePrice = async () => {
    if (!editCourse) return;
    const val = parseFloat(courseInput);
    if (isNaN(val) || val < 0) {
      showToast({ type: 'error', message: 'Enter a valid price ≥ 0.' });
      return;
    }
    setCourseSaving(true);
    try {
      await setDoctorCoursePrice(editCourse.course_id, val);
      showToast({ type: 'success', message: `${editCourse.course_title} price updated.` });
      setCourseModal(false);
      await load();
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to update course price.' });
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
    if (name === 'custom_pricing_enabled') return 'Custom Pricing';
    if (name === 'earnings_mode')           return 'Earnings Mode';
    if (name === 'credit_selling_price')    return 'Credit Price';
    if (name.startsWith('course_price:'))   return 'Course Price';
    return name;
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      >
        <View style={{ padding: 20, gap: 16 }}>

          {/* ── Header ── */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Pressable onPress={() => router.back()}
              style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${c.text}0D`,
                alignItems: 'center', justifyContent: 'center' }}>
              <ArrowLeft size={18} color={c.text} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <PageHeader
                title="Earnings"
                subtitle={decodeURIComponent(doctor_name ?? 'Doctor')}
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
                    EARNINGS SETTINGS
                  </Text>
                  <Pressable onPress={openSettings}
                    style={{ backgroundColor: `${c.primary}15`, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>Edit</Text>
                  </Pressable>
                </View>

                {/* Custom pricing toggle */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  {dashboard.custom_pricing_enabled
                    ? <ToggleRight size={28} color="#16A34A" />
                    : <ToggleLeft size={28} color={`${c.text}40`} />}
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>Custom Pricing</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>
                      {dashboard.custom_pricing_enabled
                        ? 'Doctor manages pricing independently'
                        : 'Using platform pricing (Super Admin controls)'}
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
                      {dashboard.custom_pricing_enabled ? 'ON' : 'OFF'}
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
                            {mode === 'credit' ? 'Credit-Based' : 'Course-Based'}
                          </Text>
                          <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>
                            {mode === 'credit' ? 'Credits × Price' : 'Per-course price'}
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
                        <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Credit Price</Text>
                        <Text style={{ fontSize: 20, fontWeight: '900', color: '#7C3AED' }}>
                          EGP {dashboard.credit_selling_price}
                        </Text>
                      </View>
                    </View>
                    <Pressable onPress={() => { setCreditInput(String(dashboard.credit_selling_price)); setCreditModal(true); }}
                      style={{ backgroundColor: '#7C3AED18', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#7C3AED' }}>Change</Text>
                    </Pressable>
                  </View>
                )}
              </NeuCard>

              {/* ── Earnings KPIs ── */}
              <Text style={{ fontSize: 11, fontWeight: '800', color: c.text, opacity: 0.4, letterSpacing: 0.5 }}>
                EARNINGS OVERVIEW
              </Text>

              {/* Big total */}
              <NeuCard style={{ padding: 20, alignItems: 'center', gap: 6 }}>
                <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: '#16A34A18',
                  alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                  <TrendingUp size={26} color="#16A34A" />
                </View>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Total Earnings</Text>
                <Text style={{ fontSize: 36, fontWeight: '900', color: '#16A34A' }}>
                  {fmt(dashboard.total_earnings)}
                </Text>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.3 }}>
                  {dashboard.custom_pricing_enabled
                    ? (dashboard.earnings_mode === 'credit' ? 'Credit-based pricing' : 'Course-based pricing')
                    : 'Platform pricing'}
                </Text>
              </NeuCard>

              {/* Monthly / Today */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <NeuCard style={{ flex: 1, padding: 16, alignItems: 'center', gap: 4 }}>
                  <Calendar size={18} color={c.primary} />
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>This Month</Text>
                  <Text style={{ fontSize: 20, fontWeight: '800', color: c.primary }}>
                    {fmt(dashboard.monthly_earnings)}
                  </Text>
                </NeuCard>
                <NeuCard style={{ flex: 1, padding: 16, alignItems: 'center', gap: 4 }}>
                  <BarChart3 size={18} color="#D97706" />
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Today</Text>
                  <Text style={{ fontSize: 20, fontWeight: '800', color: '#D97706' }}>
                    {fmt(dashboard.today_earnings)}
                  </Text>
                </NeuCard>
              </View>

              {/* Other KPIs */}
              <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                {[
                  { label: 'Total Enrollments', value: dashboard.total_enrollments, color: '#2DA8FF', icon: Users },
                  { label: 'Paid Courses',       value: dashboard.paid_courses_count, color: '#7C3AED', icon: BookOpen },
                  { label: 'Avg Course Price',   value: `EGP ${Math.round(dashboard.avg_course_price)}`, color: '#16A34A', icon: Tag },
                ].map(k => {
                  const Icon = k.icon;
                  return (
                    <NeuCard key={k.label} style={{ flexBasis: '47%', padding: 14, gap: 6 }}>
                      <Icon size={16} color={k.color} />
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>{k.label}</Text>
                      <Text style={{ fontSize: 20, fontWeight: '900', color: k.color }}>{k.value}</Text>
                    </NeuCard>
                  );
                })}
              </View>

              {/* ── Per-Course Breakdown ── */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: '800', color: c.text, opacity: 0.4, letterSpacing: 0.5 }}>
                  PER COURSE EARNINGS ({dashboard.per_course.length})
                </Text>
              </View>

              {dashboard.per_course.length === 0 ? (
                <NeuCard style={{ padding: 40, alignItems: 'center', gap: 10 }}>
                  <BookOpen size={36} color={c.text} opacity={0.15} />
                  <Text style={{ color: c.text, opacity: 0.4, fontSize: 14 }}>No courses yet</Text>
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
                          <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 2 }}>
                            Price: EGP {course.current_price}
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
                          <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>Set Price</Text>
                        </Pressable>
                      )}
                    </View>

                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {[
                        { label: 'Students', value: String(course.enrollment_count), color: '#2DA8FF' },
                        { label: 'Revenue',  value: fmt(course.course_revenue),       color: '#16A34A' },
                        { label: 'Avg Price',value: `EGP ${Math.round(course.avg_price_at_sale)}`, color: '#D97706' },
                      ].map(s => (
                        <View key={s.label} style={{
                          flex: 1, backgroundColor: `${s.color}10`,
                          borderRadius: 10, padding: 10, alignItems: 'center',
                        }}>
                          <Text style={{ fontSize: 15, fontWeight: '800', color: s.color }}>{s.value}</Text>
                          <Text style={{ fontSize: 10, color: c.text, opacity: 0.4, marginTop: 2 }}>{s.label}</Text>
                        </View>
                      ))}
                    </View>
                  </NeuCard>
                ))
              )}

              {/* ── Grand Totals ── */}
              <Text style={{ fontSize: 11, fontWeight: '800', color: c.text, opacity: 0.4, letterSpacing: 0.5 }}>
                GRAND TOTAL
              </Text>
              <NeuCard style={{ padding: 18, gap: 14 }}>
                {[
                  { label: 'Total Students', value: String(totalStudents), color: '#2DA8FF',  icon: Users     },
                  { label: 'Total Courses',  value: String(dashboard.per_course.length), color: '#7C3AED', icon: BookOpen  },
                  { label: 'Total Revenue',  value: fmt(totalRevenue),     color: '#16A34A', icon: TrendingUp },
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
                    <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>Pricing Change History</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.4 }}>{history.length} records</Text>
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
        title="Earnings Settings"
        subtitle={decodeURIComponent(doctor_name ?? 'Doctor')}
        footer={
          <View style={{ gap: 10 }}>
            <NeuButton label={settingsSaving ? 'Saving…' : 'Save Settings'} loading={settingsSaving} fullWidth onPress={saveSettings} />
            <NeuButton label="Cancel" variant="secondary" fullWidth onPress={() => setSettingsModal(false)} />
          </View>
        }
      >
        <View style={{ gap: 16 }}>
          {/* Toggle */}
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Custom Pricing</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[
                { val: false, label: 'OFF — Platform Price' },
                { val: true,  label: 'ON — Custom Price'    },
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
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Earnings Mode</Text>
              {[
                { val: 'credit' as const, label: 'Credit-Based', desc: 'Credits Used × Credit Price' },
                { val: 'course' as const, label: 'Course-Based', desc: 'Each course has its own price' },
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
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{opt.desc}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}

          {!draftEnabled && (
            <View style={{ backgroundColor: `${c.text}08`, borderRadius: 12, padding: 14 }}>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, lineHeight: 18 }}>
                {"When OFF, earnings are calculated using the Super Admin's platform credit price. The doctor cannot change their own pricing."}
              </Text>
            </View>
          )}
        </View>
      </ResponsiveModal>

      {/* ── Credit Price Modal ── */}
      <ResponsiveModal
        visible={creditModal}
        onClose={() => setCreditModal(false)}
        title="Credit Selling Price"
        subtitle={decodeURIComponent(doctor_name ?? 'Doctor')}
        footer={
          <View style={{ gap: 10 }}>
            <NeuButton label={creditSaving ? 'Saving…' : 'Save Price'} loading={creditSaving} fullWidth onPress={saveCreditPrice} />
            <NeuButton label="Cancel" variant="secondary" fullWidth onPress={() => setCreditModal(false)} />
          </View>
        }
      >
        <View style={{ gap: 14 }}>
          <View style={{ backgroundColor: '#7C3AED0D', borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Current</Text>
            <Text style={{ fontSize: 24, fontWeight: '900', color: '#7C3AED' }}>
              EGP {dashboard?.credit_selling_price ?? 0}
            </Text>
          </View>
          <View>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginBottom: 8 }}>New Price (EGP)</Text>
            <TextInput
              value={creditInput}
              onChangeText={setCreditInput}
              placeholder="e.g. 120"
              placeholderTextColor={`${c.text}50`}
              keyboardType="decimal-pad"
              style={[inp, { minWidth: 0 }]}
            />
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.3, marginTop: 8, lineHeight: 16 }}>
              Earnings = Credits Used × this price.{'\n'}
              Previous earnings are NOT recalculated.
            </Text>
          </View>
        </View>
      </ResponsiveModal>

      {/* ── Course Price Modal ── */}
      <ResponsiveModal
        visible={courseModal}
        onClose={() => setCourseModal(false)}
        title="Course Price"
        subtitle={editCourse?.course_title ?? ''}
        footer={
          <View style={{ gap: 10 }}>
            <NeuButton label={courseSaving ? 'Saving…' : 'Save Price'} loading={courseSaving} fullWidth onPress={saveCoursePrice} />
            <NeuButton label="Cancel" variant="secondary" fullWidth onPress={() => setCourseModal(false)} />
          </View>
        }
      >
        <View style={{ gap: 14 }}>
          <View style={{ backgroundColor: `${c.primary}0D`, borderRadius: 14, padding: 14 }}>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Current Price</Text>
            <Text style={{ fontSize: 24, fontWeight: '900', color: c.primary }}>
              EGP {editCourse?.current_price ?? 0}
            </Text>
          </View>
          <View>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginBottom: 8 }}>New Price (EGP)</Text>
            <TextInput
              value={courseInput}
              onChangeText={setCourseInput}
              placeholder="e.g. 300"
              placeholderTextColor={`${c.text}50`}
              keyboardType="decimal-pad"
              style={[inp, { minWidth: 0 }]}
            />
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.3, marginTop: 8, lineHeight: 16 }}>
              Previous enrollments keep their original price.{'\n'}
              Only future enrollments use the new price.
            </Text>
          </View>
        </View>
      </ResponsiveModal>

      {/* ── Pricing History Modal ── */}
      <ResponsiveModal
        visible={historyModal}
        onClose={() => setHistoryModal(false)}
        title="Pricing Change History"
        subtitle={decodeURIComponent(doctor_name ?? 'Doctor')}
      >
        <ScrollView style={{ maxHeight: 480 }} showsVerticalScrollIndicator={false}>
          {history.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <History size={36} color={c.text} opacity={0.15} />
              <Text style={{ color: c.text, opacity: 0.4, marginTop: 12 }}>No changes recorded yet</Text>
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              {history.map(row => (
                <NeuCard key={row.id} style={{ padding: 14, gap: 6 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>
                      {fieldLabel(row.field_name)}
                    </Text>
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>
                      {fmtDate(row.created_at)}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ flex: 1, backgroundColor: '#DC262610', borderRadius: 8, padding: 8 }}>
                      <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>Old</Text>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>
                        {row.old_value ?? '—'}
                      </Text>
                    </View>
                    <ChevronRight size={14} color={`${c.text}30`} />
                    <View style={{ flex: 1, backgroundColor: '#16A34A10', borderRadius: 8, padding: 8 }}>
                      <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>New</Text>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>
                        {row.new_value ?? '—'}
                      </Text>
                    </View>
                  </View>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.35 }}>
                    Changed by: {row.changer_name ?? 'Unknown'}
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
