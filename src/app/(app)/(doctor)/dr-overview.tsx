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
  const { t, tCount, locale } = useTranslation();

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

        {/* 7-tile KPI Grid */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: layout.sectionGap }}>
          <StatCard label={t('drOverview.totalStudents')}      value={totalStudents}       icon={<Users size={layout.captionSize + 2} color="#fff" />}        color="#7C3AED" />
          <StatCard label={t('status.active')}                 value={activeStudents}      icon={<GraduationCap size={layout.captionSize + 2} color="#fff" />} color="#16A34A" />
          <StatCard label={t('status.suspended')}              value={suspendedStudents}   icon={<Ban size={layout.captionSize + 2} color="#fff" />}          color="#D97706" />
          {/* `nav.myCourses` is the TAB label ("My Courses" / "دوراتي") and read
              as a navigation item rather than a statistic, while the card after
              it said only "Published" — which is a STATUS, not a count of the
              instructor's courses. This card now states the statistic plainly:
              how many courses this instructor owns. */}
          <StatCard label={t('drOverview.courses')}            value={totalCourses}        icon={<BookOpen size={layout.captionSize + 2} color="#fff" />}     color={c.primary} />
          <StatCard label={t('nav.credits')}                   value={creditsRemaining}    icon={<CreditCard size={layout.captionSize + 2} color="#fff" />}   color="#2DA8FF" />
          <StatCard label={t('drOverview.todayActivations')}   value={todayActivations}    icon={<Zap size={layout.captionSize + 2} color="#fff" />}         color="#F59E0B" />
          {/* Still the PUBLISHED-ONLY subset — its scope is unchanged, but the
              label now says so ("Published Courses"/"دورات منشورة") so it can
              never be read as the total course count next to the real one. */}
          <StatCard label={t('drOverview.publishedCourses')}    value={courses.filter(cr => cr.status === 'published').length} icon={<TrendingUp size={layout.captionSize + 2} color="#fff" />} color="#6366F1" />
        </View>

        {/* Quick Actions — shared tile component (fixed-square icon box; the
            previous flexGrow wrap-row variant stretched into tall rectangles
            on Android). */}
        <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '800', color: c.text, marginBottom: layout.pad.md }}>{t('drOverview.quickActions')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: layout.sectionGap }}>
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
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: layout.pad.md }}>
                    <View style={{
                      width: layout.touchTarget, height: layout.touchTarget, borderRadius: layout.cardRadius,
                      backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      <Text style={{ fontSize: layout.bodySize, fontWeight: '800', color: c.primary }}>
                        {studentName ? String(studentName).trim().charAt(0).toUpperCase() : '?'}
                      </Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                      {studentName ? (
                        <Text style={{ fontSize: layout.bodySize, fontWeight: '600', color: c.text }} numberOfLines={2}>
                          {studentName}
                        </Text>
                      ) : null}
                      {courseTitle ? (
                        <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.55) }} numberOfLines={2}>
                          {courseTitle}
                        </Text>
                      ) : null}
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
                        <Calendar size={11} color={c.text} opacity={0.35} />
                        <Text style={{ flexShrink: 1, fontSize: layout.captionSize - 1, ...mutedTextStyle(c, 0.4) }} numberOfLines={1}>
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
            style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.md, padding: layout.cardPx, marginBottom: layout.itemGap }}
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
              <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text }} numberOfLines={1}>{course.title}</Text>
              <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.45), marginTop: 2 }}>{course.category?.name ?? t('drOverview.generalCategory')}</Text>
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
