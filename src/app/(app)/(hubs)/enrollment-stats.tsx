/**
 * enrollment-stats.tsx — Student enrollment statistics (Admin + Super Admin).
 *
 * TWO NUMBERS, NEVER MIXED
 * ------------------------
 *   • Unique Students   — distinct student ACCOUNTS (one student in 5 courses = 1)
 *   • Total Enrollments — student↔course enrolments (that same student = 5)
 *
 * The selector at the top decides which figure the cards, the table columns and
 * the detail headers show. The other metric stays visible beside it, so an
 * admin never reads one number believing it is the other.
 *
 * EVERYTHING COMES FROM THE SERVER. This screen never counts a client-side list:
 * the backend aggregates over one (student, course) pair set, collapses duplicate
 * rows, excludes suspended/trashed/archived records and returns both metrics on
 * every row. The client only (a) picks a metric, (b) sorts/pages through the
 * server's whitelisted ORDER BY, and (c) checks that a full page of per-course
 * rows sums to the platform total — a reconciliation probe that surfaces a
 * discrepancy instead of hiding it.
 *
 * Reachable from the Admin dashboard quick actions and the Super Admin Analytics
 * hub; both roles read platform-wide analytics elsewhere, so the route adds no
 * new scope.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, TextInput, ActivityIndicator,
  RefreshControl, useColorScheme,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  GraduationCap, Users, BookOpen, Stethoscope, Search, X,
  ChevronDown, ChevronUp, AlertTriangle, RefreshCw,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { StatCard } from '@/components/StatCard';
import { neuColors, useLayout, safeBottom, mutedTextStyle } from '@/lib/neu';
import { useTranslation } from '@/lib/i18n';
import {
  getEnrollmentStats,
  getEnrollmentStatsDoctors,
  getEnrollmentStatsCourses,
  getEnrollmentDoctorStats,
  getEnrollmentCourseStats,
} from '@/lib/api';
import type {
  EnrollmentCountingMode,
  EnrollmentCourseStatRow,
  EnrollmentDoctorStatRow,
  EnrollmentDoctorDetail,
  EnrollmentCourseDetail,
  EnrollmentStatsList,
  EnrollmentStatsSummary,
  EnrollmentStatsSort,
} from '@/lib/api';
import {
  COUNTING_MODES, countingModeLabelKey, countingModeHintKey, metricValue, sumMetric,
  reconciles, nextSort, pageWindow, pageCaption, doctorsQuery, coursesQuery,
  clampPerPage, getCountingMode, setCountingMode, courseStatusKey, doctorLabelKey,
  policyNoteKeys, rowKey, headlineCards,
} from '@/lib/enrollmentStats';

type Tab = 'doctors' | 'courses';
type SortState = { sort: EnrollmentStatsSort; order: 'asc' | 'desc' };

const PER_PAGE = clampPerPage(20);

/**
 * `backTo` is the header back-arrow fallback when there is no history to pop:
 * the admin dashboard for /enrollment-stats, the analytics hub for the Super
 * Admin wrapper. The screen itself is identical for both roles.
 */
export default function EnrollmentStatsScreen({ backTo = '/admin-overview' }: { backTo?: string } = {}) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { t } = useTranslation();

  const [mode, setMode] = useState<EnrollmentCountingMode>(getCountingMode());
  const [tab, setTab] = useState<Tab>('doctors');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [doctorFilter, setDoctorFilter] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [doctorSort, setDoctorSort] = useState<SortState>({ sort: 'unique_students', order: 'desc' });
  const [courseSort, setCourseSort] = useState<SortState>({ sort: 'enrollments', order: 'desc' });

  const [summary, setSummary] = useState<EnrollmentStatsSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [rows, setRows] = useState<(EnrollmentDoctorStatRow | EnrollmentCourseStatRow)[]>([]);
  const [meta, setMeta] = useState<{ page: number; total: number; total_pages: number } | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [doctorDetail, setDoctorDetail] = useState<EnrollmentDoctorDetail | null>(null);
  const [courseDetail, setCourseDetail] = useState<EnrollmentCourseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  /** Monotonic request id — a slow response can never overwrite a newer one. */
  const requestId = useRef(0);

  // ── Search debounce (typing must not fire a request per keystroke) ────────
  useEffect(() => {
    const id = setTimeout(() => {
      setTerm(search.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(id);
  }, [search]);

  // ── Summary (both metrics + the policy echo) ─────────────────────────────
  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      setSummary(await getEnrollmentStats({ include_archived: includeArchived }));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSummaryLoading(false);
    }
  }, [includeArchived]);

  // ── Table rows ───────────────────────────────────────────────────────────
  const loadRows = useCallback(async () => {
    const id = ++requestId.current;
    setListLoading(true);
    try {
      if (tab === 'doctors') {
        const res: EnrollmentStatsList<EnrollmentDoctorStatRow> = await getEnrollmentStatsDoctors(
          doctorsQuery({
            search: term,
            sort: doctorSort.sort,
            order: doctorSort.order,
            page,
            perPage: PER_PAGE,
            includeArchived,
          }),
        );
        if (id !== requestId.current) return;
        setRows(res.rows);
        setMeta({ page: res.page, total: res.total, total_pages: res.total_pages });
      } else {
        const res: EnrollmentStatsList<EnrollmentCourseStatRow> = await getEnrollmentStatsCourses(
          coursesQuery({
            search: term,
            sort: courseSort.sort,
            order: courseSort.order,
            page,
            perPage: PER_PAGE,
            includeArchived,
            doctorId: doctorFilter,
          }),
        );
        if (id !== requestId.current) return;
        setRows(res.rows);
        setMeta({ page: res.page, total: res.total, total_pages: res.total_pages });
      }
      setError(null);
    } catch (e: unknown) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
      setMeta(null);
    } finally {
      if (id === requestId.current) setListLoading(false);
    }
  }, [tab, term, page, doctorSort, courseSort, includeArchived, doctorFilter]);

  useFocusEffect(useCallback(() => {
    let alive = true;
    (async () => {
      if (!alive) return;
      await Promise.all([loadSummary(), loadRows()]);
    })();
    return () => { alive = false; };
  }, [loadSummary, loadRows]));

  useEffect(() => { void loadRows(); }, [loadRows]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadSummary(), loadRows()]);
    setRefreshing(false);
  }, [loadSummary, loadRows]);

  // ── Mode switch keeps the choice for every statistics view ───────────────
  const chooseMode = (next: EnrollmentCountingMode) => {
    setMode(setCountingMode(next));
  };

  const changeTab = (next: Tab) => {
    if (next === tab) return;
    setTab(next);
    setPage(1);
    setExpandedId(null);
    setDoctorDetail(null);
    setCourseDetail(null);
  };

  const toggleSort = (column: EnrollmentStatsSort) => {
    setPage(1);
    if (tab === 'doctors') setDoctorSort(prev => nextSort(prev, column));
    else setCourseSort(prev => nextSort(prev, column));
  };

  // ── Drill-down (doctor → per-course breakdown, course → metrics) ─────────
  const toggleDoctor = async (doctorId: string) => {
    if (expandedId === doctorId) { setExpandedId(null); setDoctorDetail(null); return; }
    setExpandedId(doctorId);
    setCourseDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setDoctorDetail(await getEnrollmentDoctorStats(doctorId, {
        page: 1,
        per_page: clampPerPage(50),
        include_archived: includeArchived,
      }));
    } catch (e: unknown) {
      setDoctorDetail(null);
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  };

  const toggleCourse = async (courseId: string) => {
    if (expandedId === courseId) { setExpandedId(null); setCourseDetail(null); return; }
    setExpandedId(courseId);
    setDoctorDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setCourseDetail(await getEnrollmentCourseStats(courseId));
    } catch (e: unknown) {
      setCourseDetail(null);
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  };

  const cards = headlineCards(summary?.totals, mode);
  const activeSort = tab === 'doctors' ? doctorSort : courseSort;

  /**
   * Reconciliation: with every course row on one page and no filters, the sum of
   * the per-course `enrollments` MUST equal the platform total calculated from
   * the same pair set. If it does not, we say so instead of quietly showing two
   * different truth claims.
   */
  const reconciliation = useMemo(() => {
    if (tab !== 'courses' || term !== '' || doctorFilter !== null) return null;
    if (!summary || meta === null || summaryLoading || listLoading) return null;
    if (meta.total > rows.length) return null; // partial page — not comparable
    const sum = sumMetric(rows as EnrollmentCourseStatRow[], 'enrollments');
    return { sum, total: summary.totals.enrollments, ok: reconciles(sum, summary.totals.enrollments) };
  }, [tab, term, doctorFilter, summary, meta, rows, summaryLoading, listLoading]);

  const pageNumbers = meta ? pageWindow(meta.page, meta.total_pages) : [];
  const policyKeys = policyNoteKeys(summary?.policy);

  const sortLabel = (column: EnrollmentStatsSort): string => {
    switch (column) {
      case 'unique_students': return t('enrollmentStats.mode.uniqueStudents');
      case 'enrollments': return t('enrollmentStats.mode.actualEnrollments');
      case 'courses': return t('enrollmentStats.column.courses');
      case 'doctor': return t('enrollmentStats.column.doctor');
      case 'title': return t('enrollmentStats.column.course');
      default: return t('enrollmentStats.column.name');
    }
  };

  const SortHeader = ({ column, flex, alignRight }: { column: EnrollmentStatsSort; flex: number; alignRight?: boolean }) => {
    const active = activeSort.sort === column;
    return (
      <Pressable onPress={() => toggleSort(column)} style={{ flex, alignItems: alignRight ? 'flex-end' : 'flex-start' }}>
        <Text style={{ fontSize: 10, fontWeight: '800', color: active ? c.primary : `${c.text}70`, textTransform: 'uppercase' }}>
          {sortLabel(column)} {active ? (activeSort.order === 'desc' ? '↓' : '↑') : ''}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
      >
        <PageHeader
          title={t('enrollmentStats.title')}
          subtitle={t('enrollmentStats.subtitle')}
          accentColor={c.primary}
          showBack
          backFallback={backTo}
          rightAction={
            <Pressable
              onPress={() => { void onRefresh(); }}
              disabled={refreshing}
              style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }}
            >
              {refreshing
                ? <ActivityIndicator size="small" color={c.primary} />
                : <RefreshCw size={17} color={c.primary} />}
            </Pressable>
          }
        />

        <View style={{ paddingHorizontal: layout.screenPx }}>

          {/* ── Counting mode selector ─────────────────────────────────── */}
          <Text style={{ fontSize: 11, fontWeight: '800', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase', letterSpacing: 1.1, marginBottom: 8 }}>
            {t('enrollmentStats.mode.label')}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 6 }}>
            {COUNTING_MODES.map(m => {
              const active = m === mode;
              return (
                <Pressable
                  key={m}
                  onPress={() => chooseMode(m)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={{
                    flex: 1, paddingVertical: 11, paddingHorizontal: 10, borderRadius: 13,
                    backgroundColor: active ? `${c.primary}18` : `${c.text}08`,
                    borderWidth: 1.5, borderColor: active ? c.primary : 'transparent',
                  }}
                >
                  <Text style={{ fontSize: 12.5, fontWeight: '800', color: active ? c.primary : c.text, textAlign: 'center' }}>
                    {t(countingModeLabelKey(m))}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5), marginBottom: 16, lineHeight: 17 }}>
            {t(countingModeHintKey(mode))}
          </Text>

          {/* ── Headline cards ────────────────────────────────────────── */}
          {summaryLoading && !summary ? (
            <ActivityIndicator color={c.primary} style={{ marginVertical: 24 }} />
          ) : summary ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 }}>
              <StatCard
                label={t(countingModeLabelKey(mode))}
                value={cards.primary}
                icon={<GraduationCap size={16} color="#fff" />}
                color="#7C3AED"
              />
              <StatCard
                label={t(countingModeLabelKey(cards.secondaryMode))}
                value={cards.secondary}
                icon={<Users size={16} color="#fff" />}
                color="#2DA8FF"
              />
              <StatCard
                label={t('enrollmentStats.card.courses')}
                value={summary.totals.courses_with_enrollments}
                icon={<BookOpen size={16} color="#fff" />}
                color="#16A34A"
              />
              <StatCard
                label={t('enrollmentStats.card.doctors')}
                value={summary.totals.doctors_with_enrollments}
                icon={<Stethoscope size={16} color="#fff" />}
                color="#D97706"
              />
            </View>
          ) : null}

          {/* ── Policy: what is counted, in plain words ────────────────── */}
          {policyKeys.length > 0 && (
            <NeuCard style={{ padding: 12, marginTop: 2, marginBottom: 14 }}>
              <Text style={{ fontSize: 10.5, ...mutedTextStyle(c, 0.55), lineHeight: 16 }}>
                {policyKeys.map(k => t(k)).join(' · ')}
              </Text>
            </NeuCard>
          )}

          {/* ── Error state ───────────────────────────────────────────── */}
          {error && (
            <View style={{ backgroundColor: '#DC262612', borderRadius: 12, padding: 12, marginBottom: 14, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} color="#DC2626" />
              <Text style={{ flex: 1, fontSize: 12, color: '#DC2626', lineHeight: 18 }}>{error}</Text>
              <Pressable onPress={() => { void loadSummary(); void loadRows(); }} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#DC262618' }}>
                <Text style={{ fontSize: 11, fontWeight: '800', color: '#DC2626' }}>{t('enrollmentStats.retry')}</Text>
              </Pressable>
            </View>
          )}

          {/* ── Table switch ──────────────────────────────────────────── */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            {(['doctors', 'courses'] as Tab[]).map(next => {
              const active = tab === next;
              return (
                <Pressable
                  key={next}
                  onPress={() => changeTab(next)}
                  style={{
                    paddingVertical: 9, paddingHorizontal: 14, borderRadius: 11,
                    backgroundColor: active ? c.primary : `${c.text}08`,
                  }}
                >
                  <Text style={{ fontSize: 12.5, fontWeight: '800', color: active ? '#fff' : `${c.text}90` }}>
                    {next === 'doctors' ? t('enrollmentStats.tab.doctors') : t('enrollmentStats.tab.courses')}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* ── Search + filters ──────────────────────────────────────── */}
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.base, borderRadius: 13, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 10 }}>
            <Search size={17} color={c.text} opacity={0.4} style={{ flexShrink: 0 }} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={tab === 'doctors' ? t('enrollmentStats.searchDoctors') : t('enrollmentStats.searchCourses')}
              placeholderTextColor={`${c.text}55`}
              style={{ flex: 1, minWidth: 0, marginLeft: 8, fontSize: 14, color: c.text }}
            />
            {search.length > 0 && (
              <Pressable onPress={() => setSearch('')} hitSlop={8}>
                <X size={16} color={`${c.text}60`} />
              </Pressable>
            )}
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <Pressable
              onPress={() => { setIncludeArchived(v => !v); setPage(1); }}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 9,
                backgroundColor: includeArchived ? `${c.primary}18` : `${c.text}08`,
                borderWidth: 1, borderColor: includeArchived ? c.primary : 'transparent',
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '700', color: includeArchived ? c.primary : `${c.text}80` }}>
                {t('enrollmentStats.includeArchived')}
              </Text>
            </Pressable>
            {tab === 'courses' && doctorFilter && (
              <Pressable
                onPress={() => { setDoctorFilter(null); setPage(1); }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 9, backgroundColor: '#D9770618' }}
              >
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#D97706' }}>
                  {t('enrollmentStats.filteredByDoctor')}
                </Text>
                <X size={12} color="#D97706" />
              </Pressable>
            )}
          </View>

          {/* ── Table ─────────────────────────────────────────────────── */}
          <NeuCard style={{ padding: 12, marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: `${c.text}12` }}>
              <SortHeader column={tab === 'doctors' ? 'name' : 'title'} flex={2.2} />
              {tab === 'courses' && <SortHeader column="doctor" flex={1.6} />}
              <SortHeader column="unique_students" flex={1.1} alignRight />
              <SortHeader column="enrollments" flex={1.1} alignRight />
              {tab === 'doctors' && <SortHeader column="courses" flex={0.9} alignRight />}
            </View>

            {listLoading ? (
              <ActivityIndicator color={c.primary} style={{ paddingVertical: 28 }} />
            ) : rows.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 30 }}>
                <GraduationCap size={44} color={c.primary} opacity={0.16} />
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.45), marginTop: 10, textAlign: 'center' }}>
                  {t('enrollmentStats.empty')}
                </Text>
              </View>
            ) : (
              rows.map(row => {
                const key = rowKey(row);
                const open = expandedId === key;
                const isCourse = tab === 'courses';
                const courseRow = row as EnrollmentCourseStatRow;
                const doctorRow = row as EnrollmentDoctorStatRow;
                const unassigned = isCourse ? doctorLabelKey(courseRow) : null;
                return (
                  <View key={key} style={{ borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
                    <Pressable
                      onPress={() => { void (isCourse ? toggleCourse(key) : toggleDoctor(key)); }}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 11, gap: 4 }}
                    >
                      <View style={{ flex: 2.2, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <Text numberOfLines={2} style={{ flexShrink: 1, fontSize: 12.5, fontWeight: '700', color: c.text }}>
                          {isCourse ? courseRow.title : (doctorRow.full_name || t('enrollmentStats.unnamedDoctor'))}
                        </Text>
                        {open
                          ? <ChevronUp size={13} color={`${c.text}55`} />
                          : <ChevronDown size={13} color={`${c.text}30`} />}
                      </View>
                      {isCourse && (
                        <Text numberOfLines={1} style={{ flex: 1.6, fontSize: 11, color: unassigned ? '#D97706' : `${c.text}80` }}>
                          {unassigned ? t(unassigned) : courseRow.doctor_name}
                        </Text>
                      )}
                      <Text style={{ flex: 1.1, fontSize: 12.5, fontWeight: '800', color: metricValue(row, 'unique_students') > 0 ? c.primary : `${c.text}45`, textAlign: 'right' }}>
                        {metricValue(row, 'unique_students')}
                      </Text>
                      <Text style={{ flex: 1.1, fontSize: 12.5, fontWeight: '800', color: metricValue(row, 'enrollments') > 0 ? c.text : `${c.text}45`, textAlign: 'right' }}>
                        {metricValue(row, 'enrollments')}
                      </Text>
                      {!isCourse && (
                        <Text style={{ flex: 0.9, fontSize: 12, fontWeight: '700', color: `${c.text}70`, textAlign: 'right' }}>
                          {doctorRow.courses_count}
                        </Text>
                      )}
                    </Pressable>

                    {/* Drill-down */}
                    {open && (
                      <View style={{ backgroundColor: `${c.text}05`, borderRadius: 10, padding: 10, marginBottom: 10 }}>
                        {detailLoading ? (
                          <ActivityIndicator color={c.primary} style={{ paddingVertical: 12 }} />
                        ) : detailError ? (
                          <Text style={{ fontSize: 11.5, color: '#DC2626' }}>{detailError}</Text>
                        ) : doctorDetail && !isCourse ? (
                          <DoctorBreakdown detail={doctorDetail} mode={mode} t={t} c={c} />
                        ) : courseDetail && isCourse ? (
                          <CourseBreakdown detail={courseDetail} mode={mode} t={t} c={c} />
                        ) : null}
                      </View>
                    )}
                  </View>
                );
              })
            )}
          </NeuCard>

          {/* ── Reconciliation probe ──────────────────────────────────── */}
          {reconciliation && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <Text style={{ fontSize: 10.5, color: reconciliation.ok ? '#16A34A' : '#DC2626' }}>
                {reconciliation.ok
                  ? t('enrollmentStats.reconcile.ok', { sum: reconciliation.sum, total: reconciliation.total })
                  : t('enrollmentStats.reconcile.mismatch', { sum: reconciliation.sum, total: reconciliation.total })}
              </Text>
            </View>
          )}

          {/* ── Pagination ────────────────────────────────────────────── */}
          {meta && meta.total_pages > 1 && (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
              <Pressable
                disabled={meta.page <= 1}
                onPress={() => { setExpandedId(null); setPage(p => Math.max(1, p - 1)); }}
                style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9, backgroundColor: `${c.text}08`, opacity: meta.page <= 1 ? 0.4 : 1 }}
              >
                <Text style={{ fontSize: 11.5, fontWeight: '700', color: `${c.text}90` }}>{t('enrollmentStats.prev')}</Text>
              </Pressable>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {pageNumbers.map(p => (
                  <Pressable
                    key={p}
                    onPress={() => { setExpandedId(null); setPage(p); }}
                    style={{
                      minWidth: 26, paddingVertical: 5, borderRadius: 7, alignItems: 'center',
                      backgroundColor: p === meta.page ? c.primary : `${c.text}08`,
                    }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: '800', color: p === meta.page ? '#fff' : `${c.text}80` }}>{p}</Text>
                  </Pressable>
                ))}
              </View>

              <Pressable
                disabled={meta.page >= meta.total_pages}
                onPress={() => { setExpandedId(null); setPage(p => Math.min(meta.total_pages, p + 1)); }}
                style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9, backgroundColor: `${c.text}08`, opacity: meta.page >= meta.total_pages ? 0.4 : 1 }}
              >
                <Text style={{ fontSize: 11.5, fontWeight: '700', color: `${c.text}90` }}>{t('enrollmentStats.next')}</Text>
              </Pressable>
            </View>
          )}

          {meta && meta.total_pages > 1 && (
            <Text style={{ fontSize: 10.5, ...mutedTextStyle(c, 0.4), textAlign: 'center', marginBottom: 18 }}>
              {pageCaption(meta.page, meta.total_pages, meta.total)}
            </Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

/* ─────────────────────────── drill-down panels ─────────────────────────── */

function DoctorBreakdown({
  detail, mode, t, c,
}: {
  detail: EnrollmentDoctorDetail;
  mode: EnrollmentCountingMode;
  t: (key: string, params?: Record<string, string | number>) => string;
  c: typeof neuColors.light;
}) {
  const { doctor, courses } = detail;
  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
        <Text style={{ fontSize: 11, fontWeight: '800', color: c.primary }}>
          {t(countingModeLabelKey(mode))}: {metricValue(doctor, mode)}
        </Text>
        <Text style={{ fontSize: 10.5, color: `${c.text}70` }}>
          {t('enrollmentStats.column.courses')}: {doctor.courses_count}
        </Text>
      </View>
      {courses.rows.length === 0 ? (
        <Text style={{ fontSize: 11, color: `${c.text}60` }}>{t('enrollmentStats.detail.noCourses')}</Text>
      ) : (
        courses.rows.map(course => (
          <View key={course.course_id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 5, gap: 6 }}>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 11.5, color: c.text }}>{course.title}</Text>
            <Text style={{ fontSize: 11, fontWeight: '800', color: c.primary, minWidth: 30, textAlign: 'right' }}>
              {metricValue(course, 'unique_students')}
            </Text>
            <Text style={{ fontSize: 11, fontWeight: '800', color: `${c.text}90`, minWidth: 30, textAlign: 'right' }}>
              {metricValue(course, 'enrollments')}
            </Text>
          </View>
        ))
      )}
      {courses.total > courses.rows.length && (
        <Text style={{ fontSize: 10, color: `${c.text}55`, marginTop: 6 }}>
          {t('enrollmentStats.detail.partial', { shown: courses.rows.length, total: courses.total })}
        </Text>
      )}
    </View>
  );
}

function CourseBreakdown({
  detail, mode, t, c,
}: {
  detail: EnrollmentCourseDetail;
  mode: EnrollmentCountingMode;
  t: (key: string, params?: Record<string, string | number>) => string;
  c: typeof neuColors.light;
}) {
  const { course } = detail;
  const rows: [string, string][] = [
    [t('enrollmentStats.mode.uniqueStudents'), String(course.unique_students)],
    [t('enrollmentStats.mode.actualEnrollments'), String(course.enrollments)],
    [t('enrollmentStats.column.doctor'), course.doctor_name ?? t('enrollmentStats.unassignedDoctor')],
    [t('enrollmentStats.column.status'), t(courseStatusKey(course))],
  ];
  return (
    <View>
      {rows.map(([label, value]) => (
        <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
          <Text style={{ fontSize: 11, color: `${c.text}70` }}>{label}</Text>
          <Text style={{ fontSize: 11.5, fontWeight: '800', color: label === t(countingModeLabelKey(mode)) ? c.primary : c.text }}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}
