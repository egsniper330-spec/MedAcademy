import { useCallback, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, Pressable, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { BookOpen, Users, TrendingUp, Bell, Archive, GraduationCap, Ban, Zap, CreditCard, Plus } from 'lucide-react-native';
import { DashboardHeader } from '@/components/DashboardHeader';
import { useProfileStore } from '@/lib/store';
import { getCourses, getDoctorStudentEnrollments } from '@/lib/api';
import { useCreditBalance } from '@/lib/useCreditBalance';
import { getFirstName } from '@/lib/utils';
import { NeuCard } from '@/components/NeuCard';
import { StatCard } from '@/components/StatCard';
import { neuColors, useLayout, neuMicroStyle, safeBottom } from '@/lib/neu';
import { CourseThumbnail } from '@/components/CourseThumbnail';
import type { RelativePathString } from 'expo-router';
import { useNotificationPermission } from '@/hooks/useNotificationPermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';

export default function DoctorDashboard() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const { profile } = useProfileStore();
  const router = useRouter();

  // ── Single source of truth for credits ──────────────────────────────────────
  const { balance: credits, loading: creditsLoading, refresh: refreshCredits } = useCreditBalance();

  const [courses, setCourses] = useState<any[]>([]);
  const [enrollments, setEnrollments] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!profile) return;
    try {
      const [myCourses, enr] = await Promise.all([
        getCourses({ doctorId: profile.id }),
        getDoctorStudentEnrollments(profile.id),
      ]);
      setCourses(myCourses);
      setEnrollments(enr);
    } catch {}
    setLoading(false);
  }, [profile]);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
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
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      {/* DashboardHeader sits OUTSIDE the inner padding view so it can own its own horizontal padding */}
      <DashboardHeader
        roleLabel="Doctor Panel"
        greeting={firstName ? `${firstName} 👋` : '👋'}
        rightActions={
          <Pressable
            onPress={() => router.push('/(app)/notifications' as RelativePathString)}
            accessibilityLabel="Notifications"
            accessibilityRole="button"
            style={[{ width: layout.touchTarget, height: layout.touchTarget, borderRadius: layout.cardRadius, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
          >
            <Bell size={Math.round(layout.touchTarget * 0.44)} color={c.primary} />
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: layout.screenPx, paddingBottom: layout.scrollBottom() }}>

        {/* 7-tile KPI Grid */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: layout.sectionGap }}>
          <StatCard label="Total Students"      value={totalStudents}       icon={<Users size={layout.captionSize + 2} color="#fff" />}        color="#7C3AED" />
          <StatCard label="Active"              value={activeStudents}      icon={<GraduationCap size={layout.captionSize + 2} color="#fff" />} color="#16A34A" />
          <StatCard label="Suspended"           value={suspendedStudents}   icon={<Ban size={layout.captionSize + 2} color="#fff" />}          color="#D97706" />
          <StatCard label="My Courses"          value={totalCourses}        icon={<BookOpen size={layout.captionSize + 2} color="#fff" />}     color={c.primary} />
          <StatCard label="Credits"             value={creditsRemaining}    icon={<CreditCard size={layout.captionSize + 2} color="#fff" />}   color="#2DA8FF" />
          <StatCard label="Today's Activations" value={todayActivations}    icon={<Zap size={layout.captionSize + 2} color="#fff" />}         color="#F59E0B" />
          <StatCard label="Published"           value={courses.filter(cr => cr.status === 'published').length} icon={<TrendingUp size={layout.captionSize + 2} color="#fff" />} color="#6366F1" />
        </View>

        {/* Quick Actions */}
        <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '800', color: c.text, marginBottom: layout.pad.md }}>Quick Actions</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: layout.itemGap, marginBottom: layout.sectionGap }}>
          {[
            { label: 'My Courses', icon: <BookOpen size={Math.round(layout.touchTarget * 0.5)} color={c.primary} />, color: c.primary, route: '/(app)/(doctor)/courses' },
            { label: 'Students',   icon: <Users size={Math.round(layout.touchTarget * 0.5)} color="#7C3AED" />,       color: '#7C3AED', route: '/(app)/(doctor)/students' },
            { label: 'Archived',   icon: <Archive size={Math.round(layout.touchTarget * 0.5)} color="#D97706" />,     color: '#D97706', route: '/(app)/archived-courses' },
            { label: 'Alerts',     icon: <Bell size={Math.round(layout.touchTarget * 0.5)} color="#2DA8FF" />,         color: '#2DA8FF', route: '/(app)/notifications' },
          ].map(({ label, icon, color, route }) => (
            <NeuCard
              key={label}
              pressable
              onPress={() => router.push(route as RelativePathString)}
              style={{ alignItems: 'center', paddingVertical: layout.pad.md, paddingHorizontal: layout.pad.sm, width: '22%', flexGrow: 1 }}
            >
              <View style={{ width: layout.touchTarget, height: layout.touchTarget, borderRadius: layout.cardRadius, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center', marginBottom: layout.pad.sm }}>
                {icon}
              </View>
              <Text numberOfLines={2} style={{ fontSize: layout.captionSize, fontWeight: '600', color: c.text, textAlign: 'center', lineHeight: layout.captionSize * 1.4 }}>
                {label}
              </Text>
            </NeuCard>
          ))}
        </View>

        {/* Recent Enrollments */}
        {recentEnrollments.length > 0 && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: layout.pad.md }}>
              <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '800', color: c.text }}>Recent Enrollments</Text>
              <Pressable onPress={() => router.push('/(app)/(doctor)/students' as RelativePathString)}>
                <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '700', color: c.primary }}>See All</Text>
              </Pressable>
            </View>
            {recentEnrollments.map(e => (
              <NeuCard key={e.id} style={{ marginBottom: layout.itemGap, padding: layout.cardPx }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ width: layout.touchTarget, height: layout.touchTarget, borderRadius: layout.cardRadius, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center', marginRight: layout.pad.md }}>
                    <Text style={{ fontSize: layout.bodySize, fontWeight: '800', color: c.primary }}>{e.student?.full_name?.[0]?.toUpperCase() ?? '?'}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: layout.bodySize, fontWeight: '600', color: c.text }} numberOfLines={1}>{e.student?.full_name}</Text>
                    <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.5 }} numberOfLines={1}>{e.course?.title}</Text>
                  </View>
                  <Text style={{ fontSize: layout.captionSize - 1, color: c.text, opacity: 0.35 }}>{new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
                </View>
              </NeuCard>
            ))}
          </>
        )}

        {/* Recent Courses */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: layout.pad.md, marginTop: layout.pad.sm }}>
          <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '800', color: c.text }}>Recent Courses</Text>
          <Pressable onPress={() => router.push('/(app)/(doctor)/courses' as RelativePathString)}>
            <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '700', color: c.primary }}>See All</Text>
          </Pressable>
        </View>
        {courses.slice(0, 3).map((course) => (
          <NeuCard
            key={course.id}
            pressable
            onPress={() => router.push(`/(app)/course/${course.id}` as RelativePathString)}
            style={{ flexDirection: 'row', alignItems: 'center', padding: layout.cardPx, marginBottom: layout.itemGap }}
          >
            <CourseThumbnail
              imageUrl={course.image_url ?? course.thumbnail_url ?? course.cover_url}
              width={layout.touchTarget}
              height={layout.touchTarget}
              borderRadius={layout.cardRadius}
            />
            <View style={{ flex: 1, marginLeft: layout.pad.md }}>
              <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text }} numberOfLines={1}>{course.title}</Text>
              <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.45, marginTop: 2 }}>{course.category?.name ?? 'General'}</Text>
            </View>
            <View style={{ backgroundColor: statusColor(course.status) + '20', borderRadius: layout.cardRadius / 2, paddingHorizontal: layout.pad.sm, paddingVertical: layout.pad.xs }}>
              <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '700', color: statusColor(course.status), textTransform: 'capitalize' }}>{course.status}</Text>
            </View>
          </NeuCard>
        ))}
        {courses.length === 0 && (
          <NeuCard style={{ alignItems: 'center', padding: layout.cardPx * 2 }}>
            <Plus size={Math.round(layout.touchTarget * 0.72)} color={c.primary} opacity={0.3} style={{ marginBottom: layout.pad.sm }} />
            <Text style={{ color: c.text, opacity: 0.45, fontSize: layout.bodySize }}>No courses yet. Create your first course!</Text>
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
