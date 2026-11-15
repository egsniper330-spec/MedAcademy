import { useCallback, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, Pressable, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { BookOpen, Users, TrendingUp, Bell, Archive, GraduationCap, Ban, Zap, CreditCard, Plus, Calendar } from 'lucide-react-native';
import { DashboardHeader } from '@/components/DashboardHeader';
import { useProfileStore } from '@/lib/store';
import { getCourses, getDoctorStudentEnrollments, getUnreadNotificationCount } from '@/lib/api';
import { useCreditBalance } from '@/lib/useCreditBalance';
import { getFirstName } from '@/lib/utils';
import { NeuCard } from '@/components/NeuCard';
import { StatCard } from '@/components/StatCard';
import { QuickActionBtn } from '@/components/QuickActionBtn';
import { neuColors, useLayout, neuMicroStyle, safeBottom, mutedTextStyle } from '@/lib/neu';
import { CourseThumbnail } from '@/components/CourseThumbnail';
import { StudentAvatar } from '@/components/StudentAvatar';
import { useStaleWhileRevalidateFocus } from '@/lib/useStaleWhileRevalidateFocus';
import type { RelativePathString } from 'expo-router';
import { useNotificationPermission } from '@/hooks/useNotificationPermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';
import { useTranslation } from '@/lib/i18n';
import { markEntryIntent } from '@/lib/navigation/navIntent';
import { courseStatusLabel } from '@/lib/i18n/labels';
import { formatLocalizedDate } from '@/lib/i18n/date';
import { markPerf, logPerfTimeline } from '@/lib/perfTimeline';

export default function DoctorDashboard() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const { profile } = useProfileStore();
  const router = useRouter();
  const { t, tCount, locale, isRTL } = useTranslation();

  // ── Single source of truth for credits ──────────────────────────────────────
  const { balance: credits, loading: creditsLoading, refresh: refreshCredits } = useCreditBalance();

  const [courses, setCourses] = useState<any[]>([]);
  const [enrollments, setEnrollments] = useState<any[]>([]);
  // Unread notifications drive the bell's dot + accessibility label, exactly
  // like the student dashboard (the header used to show a bare bell here).
  const [unreadCount, setUnreadCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!profile) return;
    try {
      const [myCourses, enr, unread] = await Promise.all([
        getCourses({ doctorId: profile.id }),
        getDoctorStudentEnrollments(profile.id),
        getUnreadNotificationCount(profile.id),
      ]);
      setCourses(myCourses);
      setEnrollments(enr);
      setUnreadCount(unread);
    } catch {}
    setLoading(false);
    // DEV timing only: the doctor landing screen's first data has landed.
    markPerf('screen-data');
    logPerfTimeline();
  }, [profile]);

  // Stale-while-revalidate: first visit shows the spinner; every return to
  // this dashboard refreshes in the background with the existing cards still
  // mounted instead of blanking the screen back to a spinner.
  useStaleWhileRevalidateFocus(loadData, {
    setLoading,
    hasContent: () => courses.length > 0 || enrollments.length > 0,
  });
  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadData(), refreshCredits()]);
    setRefreshing(false);
  };

  // ── Notification permission — once after first login ──────────────────────
  const {
    triggerNotificationPermission,
    showRationale: showNotifRationale,
    setShowRationale: setShowNotifRationale,
    isBlocked: notifBlocked,
    confirmRequest: confirmNotifRequest,
  } = useNotificationPermission();

  useFocusEffect(useCallback(() => {
    (async () => { await triggerNotificationPermission(); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []));

  const firstName = getFirstName(profile?.full_name);
  // Greeting pattern shared with the student dashboard: a localized "Welcome"
  // overline + the signed-in account's own name as the headline. The name is
  // the AUTHENTICATED profile value (never the literal word "Doctor" sprayed
  // into the layout); the role word is only a last-resort fallback for a
  // profile that failed to load.
  const doctorName = String(profile?.full_name ?? '').trim() || firstName || t('role.doctor');

  // Derived KPIs
  const totalStudents     = enrollments.length;
  const activeStudents    = enrollments.filter(e => e.status === 'active').length;
  const suspendedStudents = enrollments.filter(e => e.status === 'suspended').length;
  const totalCourses      = courses.length;
  const creditsRemaining  = credits.remaining;

  // Dashboard shortcuts: open the matching doctor list with its filter applied.
  const openStudents = (tab: 'all' | 'active' | 'suspended') => {
    markEntryIntent('/(app)/(doctor)/students', 'nested');
    router.push((tab === 'all' ? '/(app)/(doctor)/students' : `/(app)/(doctor)/students?tab=${tab}`) as RelativePathString);
  };
  const openCourses = (status?: 'published') => {
    markEntryIntent('/(app)/(doctor)/courses', 'nested');
    router.push((status ? `/(app)/(doctor)/courses?status=${status}` : '/(app)/(doctor)/courses') as RelativePathString);
  };
  /** Balance → the existing credits/balance screen (same route the drawer uses). */
  const openCredits = () => {
    markEntryIntent('/(app)/(hubs)/credits', 'nested');
    router.push('/(app)/(hubs)/credits' as RelativePathString);
  };
  const today             = new Date().toDateString();
  const todayActivations  = enrollments.filter(e => new Date(e.created_at).toDateString() === today).length;
  const recentEnrollments = enrollments.slice(0, 5);

  if (loading || creditsLoading) return <ActivityIndicator style={{ flex: 1 }} color={c.primary} />;

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PermissionRationaleModal
        type="notifications"
        visible={showNotifRationale}
        isBlocked={notifBlocked}
        onConfirm={confirmNotifRequest}
        onDismiss={() => setShowNotifRationale(false)}
      />
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      // Trailing clearance for the floating glass bar (this screen ends with a
      // list, and the bar overlays content). The helper resolves to the plain
      // safe-area bottom everywhere the bar is not floating over the content.
      contentContainerStyle={{ paddingBottom: layout.roleTabsBottom() }}
    >
      {/* DashboardHeader sits OUTSIDE the inner padding view so it can own its own horizontal padding */}
      <DashboardHeader
        roleLabel={t('home.welcome')}
        greeting={doctorName}
        rightActions={
          // Identical control box, icon ratio, unread dot and label to the
          // student dashboard, so the two headers read as one design system.
          <Pressable
            onPress={() => {
              // Opened from the dashboard (not the drawer) → destination shows Back.
              markEntryIntent('/(app)/notifications', 'nested');
              router.push('/(app)/notifications' as RelativePathString);
            }}
            accessibilityLabel={unreadCount > 0 ? `${t('nav.notifications')}, ${tCount('common.unreadCount', unreadCount)}` : t('nav.notifications')}
            accessibilityRole="button"
            style={[{ width: layout.touchTarget + 2, height: layout.touchTarget + 2, borderRadius: layout.cardRadius, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
          >
            <Bell size={Math.round((layout.touchTarget + 2) * 0.43)} color={c.primary} />
            {unreadCount > 0 && (
              <View style={{ position: 'absolute', top: layout.pad.sm, right: layout.pad.sm, width: layout.pad.sm, height: layout.pad.sm, borderRadius: layout.pad.xs, backgroundColor: '#EF4444' }} />
            )}
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: layout.screenPx }}>

        {/*
          KPI grid — TWO cards per row; an odd final card spans the full row.

          The cards are declared once in reading order and chunked in pairs, so
          the pairing follows the CARD COUNT instead of being hand-positioned:
          adding or removing a KPI re-flows the rows automatically and the last
          card full-spans only when the count is odd (no empty half-row).

          Each row is a plain `flexDirection:'row'` and every card keeps
          `flex: 1` (see StatCard), which makes the two cards in a row exactly
          equal; a row holding one card gives that card the whole content width.
          No fixed/device widths, no absolute positioning, no breakpoints — the
          parent width decides, in RTL and LTR alike.
        */}
        <View style={{ marginBottom: layout.sectionGap }}>
          {(() => {
            const kpis = [
              { key: 'totalStudents', card: <StatCard label={t('drOverview.totalStudents')}      value={totalStudents}       icon={<Users size={layout.captionSize + 2} color="#fff" />}        color="#7C3AED" onPress={() => openStudents('all')} /> },
              { key: 'activeStudents', card: <StatCard label={t('status.active')}                 value={activeStudents}      icon={<GraduationCap size={layout.captionSize + 2} color="#fff" />} color="#16A34A" onPress={() => openStudents('active')} /> },
              { key: 'suspendedStudents', card: <StatCard label={t('status.suspended')}              value={suspendedStudents}   icon={<Ban size={layout.captionSize + 2} color="#fff" />}          color="#D97706" onPress={() => openStudents('suspended')} /> },
              // `nav.myCourses` is the TAB label ("My Courses" / "دوراتي") and read
              // as a navigation item rather than a statistic, while the card after
              // it said only "Published" — which is a STATUS, not a count of the
              // instructor's courses. This card states the statistic plainly:
              // how many courses this instructor owns.
              { key: 'courses', card: <StatCard label={t('drOverview.courses')}            value={totalCourses}        icon={<BookOpen size={layout.captionSize + 2} color="#fff" />}     color={c.primary} onPress={() => openCourses()} /> },
              // Balance was decorative; it now opens the EXISTING credits screen
              // (same destination as the drawer entry). Sizing is identical to the
              // other cards — the grid decides its width, not a special case.
              { key: 'credits', card: <StatCard label={t('nav.credits')}                   value={creditsRemaining}    icon={<CreditCard size={layout.captionSize + 2} color="#fff" />}   color="#2DA8FF" onPress={openCredits} /> },
              { key: 'todayActivations', card: <StatCard label={t('drOverview.todayActivations')}   value={todayActivations}    icon={<Zap size={layout.captionSize + 2} color="#fff" />}         color="#F59E0B" /> },
              // Still the PUBLISHED-ONLY subset — its scope is unchanged, but the
              // label says so ("Published Courses"/"دورات منشورة") so it can never
              // be read as the total course count next to the real one.
              { key: 'publishedCourses', card: <StatCard label={t('drOverview.publishedCourses')}    value={courses.filter(cr => cr.status === 'published').length} icon={<TrendingUp size={layout.captionSize + 2} color="#fff" />} color="#6366F1" onPress={() => openCourses('published')} /> },
            ];
            const rows: (typeof kpis)[] = [];
            for (let i = 0; i < kpis.length; i += 2) rows.push(kpis.slice(i, i + 2));
            return rows.map((row, rowIndex) => (
              <View key={`kpi-row-${rowIndex}`} style={{ flexDirection: 'row', alignItems: 'stretch' }}>
                {row.map((entry) => (
                  <View key={entry.key} style={{ flex: 1 }}>{entry.card}</View>
                ))}
              </View>
            ));
          })()}
        </View>

        {/* Quick Actions — shared tile component (fixed-square icon box; the
            previous flexGrow wrap-row variant stretched into tall rectangles
            on Android). */}
        <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '800', color: c.text, marginBottom: layout.pad.md }}>{t('drOverview.quickActions')}</Text>
        {/* Quick actions — four equal tiles, one geometry at every width.
            Root cause of the reported inconsistency: the tile carried `width:'22%'`
            AND `maxWidth: touchTarget*1.6`. On a phone the cap never engaged; on a
            tablet / the 768dp Preview panel 22% was much wider than the cap, so each
            tile shrank to ~70dp while `space-between` still spread them over the whole
            row — uneven gaps and icons that looked undersized beside their labels. The
            cap is gone and the tile tracks its parent, so all four are identical. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: layout.pad.md, marginBottom: layout.sectionGap }}>
          {[
            { labelKey: 'nav.myCourses', icon: BookOpen,  color: c.primary, route: '/(app)/(doctor)/courses' },
            { labelKey: 'nav.students',  icon: Users,     color: '#7C3AED', route: '/(app)/(doctor)/students' },
            { labelKey: 'nav.archived',  icon: Archive,   color: '#D97706', route: '/(app)/archived-courses' },
            { labelKey: 'nav.alerts',    icon: Bell,      color: '#2DA8FF', route: '/(app)/notifications' },
          ].map(({ labelKey, icon, color, route }) => (
            <QuickActionBtn
              key={labelKey}
              icon={icon}
              label={t(labelKey)}
              color={color}
              path={route}
              c={c}
              isDark={isDark}
            />
          ))}
        </View>

        {/* Recent Enrollments */}
        {recentEnrollments.length > 0 && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: layout.pad.md }}>
              <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '800', color: c.text }}>{t('drOverview.recentEnrollments')}</Text>
              <Pressable onPress={() => {
                markEntryIntent('/(app)/(doctor)/students', 'nested');
                router.push('/(app)/(doctor)/students' as RelativePathString);
              }}>
                <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '700', color: c.primary }}>{t('common.seeAll')}</Text>
              </Pressable>
            </View>
            {recentEnrollments.map(enrollment => {
              // ── Recent Enrollments — one row, three distinct blocks ───────────
              // The timestamp used to sit BESIDE the name/course as a third
              // shrinking column with a physical (marginRight/marginLeft) gap
              // and `numberOfLines={1}` on both texts. In Arabic that column
              // collapsed onto the names, and long Arabic course titles were
              // clipped. Now: avatar (fixed) + one flexible column whose lines
              // stack name → course → date. No fixed widths, no physical
              // margins (RTL-safe), every line truncates independently, and the
              // whole card exposes the full text to screen readers.
              const studentName = enrollment.student?.full_name ?? '';
              const courseTitle = enrollment.course?.title ?? '';
              const dateLabel = formatLocalizedDate(enrollment.created_at, locale);
              return (
                <NeuCard
                  key={enrollment.id}
                  style={{ marginBottom: layout.itemGap, padding: layout.cardPx }}
                  accessibilityLabel={[studentName, courseTitle, dateLabel].filter(Boolean).join(' — ')}
                >
                  {/* Pinned LTR so row-reverse is one physical mirror (see PageHeader):
                      Arabic puts the avatar on the right, name block to its left. */}
                  <View style={{ direction: 'ltr', flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'flex-start', gap: layout.pad.md }}>
                    <StudentAvatar
                      student={enrollment.student}
                      size={layout.touchTarget}
                      radius={layout.cardRadius}
                      colors={c}
                    />
                    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                      {studentName ? (
                        <Text style={{ fontSize: layout.bodySize, fontWeight: '600', color: c.text, textAlign: isRTL ? 'right' : 'left' }} numberOfLines={2}>
                          {studentName}
                        </Text>
                      ) : null}
                      {courseTitle ? (
                        <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.55), textAlign: isRTL ? 'right' : 'left' }} numberOfLines={2}>
                          {courseTitle}
                        </Text>
                      ) : null}
                      <View style={{ flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
                        <Calendar size={11} color={c.text} opacity={0.35} />
                        <Text style={{ flexShrink: 1, fontSize: layout.captionSize - 1, textAlign: isRTL ? 'right' : 'left', ...mutedTextStyle(c, 0.4) }} numberOfLines={1}>
                          {dateLabel}
                        </Text>
                      </View>
                    </View>
                  </View>
                </NeuCard>
              );
            })}
          </>
        )}

        {/* Recent Courses */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: layout.pad.md, marginTop: layout.pad.sm }}>
          <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '800', color: c.text }}>{t('drOverview.recentCourses')}</Text>
          <Pressable onPress={() => {
            markEntryIntent('/(app)/(doctor)/courses', 'nested');
            router.push('/(app)/(doctor)/courses' as RelativePathString);
          }}>
            <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '700', color: c.primary }}>{t('common.seeAll')}</Text>
          </Pressable>
        </View>
        {courses.slice(0, 3).map((course) => (
          <NeuCard
            key={course.id}
            pressable
            onPress={() => {
              markEntryIntent(`/(app)/course/${course.id}`, 'nested');
              router.push(`/(app)/course/${course.id}` as RelativePathString);
            }}
            style={{ direction: 'ltr', flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'center', gap: layout.pad.md, padding: layout.cardPx, marginBottom: layout.itemGap }}
          >
            <CourseThumbnail
              imageUrl={course.image_url ?? course.thumbnail_url ?? course.cover_url}
              width={layout.touchTarget}
              height={layout.touchTarget}
              borderRadius={layout.cardRadius}
            />
            {/* Gap instead of marginLeft: physical margins land on the wrong
                side once I18nManager mirrors `row` for Arabic. */}
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text, textAlign: isRTL ? 'right' : 'left' }} numberOfLines={1}>{course.title}</Text>
              <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.45), marginTop: 2, textAlign: isRTL ? 'right' : 'left' }}>{course.category?.name ?? t('drOverview.generalCategory')}</Text>
            </View>
            <View style={{ backgroundColor: statusColor(course.status) + '20', borderRadius: layout.cardRadius / 2, paddingHorizontal: layout.pad.sm, paddingVertical: layout.pad.xs }}>
              <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '700', color: statusColor(course.status) }}>{courseStatusLabel(course.status, t)}</Text>
            </View>
          </NeuCard>
        ))}
        {courses.length === 0 && (
          <NeuCard style={{ alignItems: 'center', padding: layout.cardPx * 2 }}>
            <Plus size={Math.round(layout.touchTarget * 0.72)} color={c.primary} opacity={0.3} style={{ marginBottom: layout.pad.sm }} />
            <Text style={{ ...mutedTextStyle(c, 0.45), fontSize: layout.bodySize }}>{t('drOverview.noCourses')}</Text>
          </NeuCard>
        )}
      </View>
    </ScrollView>
    </View>
  );
}

function statusColor(s: string) {
  if (s === 'published') return '#16A34A';
  if (s === 'hidden') return '#D97706';
  return '#6B7280';
}
