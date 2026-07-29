import { useCallback, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, Pressable, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { BookOpen, Users, TrendingUp, Bell, Archive, GraduationCap, Ban, Zap, CreditCard, Plus } from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import { getCourses, getDoctorStudentEnrollments } from '@/lib/api';
import { useCreditBalance } from '@/lib/useCreditBalance';
import { getFirstName } from '@/lib/utils';
import { NeuCard } from '@/components/NeuCard';
import { StatCard } from '@/components/StatCard';
import { neuColors, neuMicroStyle } from '@/lib/neu';
import HamburgerButton from '@/components/HamburgerButton';
import { CourseThumbnail } from '@/components/CourseThumbnail';
import type { RelativePathString } from 'expo-router';
import { useNotificationPermission } from '@/hooks/useNotificationPermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';

export default function DoctorDashboard() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
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
    <>
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
      <View style={{ paddingHorizontal: 20, paddingBottom: 32 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, marginTop: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <HamburgerButton />
            <View>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 }}>Doctor Panel</Text>
              <Text style={{ fontSize: 21, fontWeight: '800', color: c.text, lineHeight: 26 }}>
                {firstName ? `${firstName} 👋` : '👋'}
              </Text>
            </View>
          </View>
          <Pressable
            onPress={() => router.push('/(app)/notifications' as RelativePathString)}
            accessibilityLabel="Notifications"
            accessibilityRole="button"
            style={[{ width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
          >
            <Bell size={19} color={c.primary} />
          </Pressable>
        </View>

        {/* 7-tile KPI Grid */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 20, gap: 0 }}>
          <StatCard label="Total Students"      value={totalStudents}       icon={<Users size={14} color="#fff" />}        color="#7C3AED" />
          <StatCard label="Active"              value={activeStudents}      icon={<GraduationCap size={14} color="#fff" />} color="#16A34A" />
          <StatCard label="Suspended"           value={suspendedStudents}   icon={<Ban size={14} color="#fff" />}          color="#D97706" />
          <StatCard label="My Courses"          value={totalCourses}        icon={<BookOpen size={14} color="#fff" />}     color={c.primary} />
          <StatCard label="Credits"             value={creditsRemaining}    icon={<CreditCard size={14} color="#fff" />}   color="#2DA8FF" />
          <StatCard label="Today's Activations" value={todayActivations}    icon={<Zap size={14} color="#fff" />}         color="#F59E0B" />
          <StatCard label="Published"           value={courses.filter(cr => cr.status === 'published').length} icon={<TrendingUp size={14} color="#fff" />} color="#6366F1" />
        </View>

        {/* Quick Actions */}
        <Text style={{ fontSize: 15, fontWeight: '800', color: c.text, marginBottom: 12 }}>Quick Actions</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 24 }}>
          {[
            { label: 'My Courses', icon: <BookOpen size={22} color={c.primary} />, color: c.primary, route: '/(app)/(doctor)/courses' },
            { label: 'Students',   icon: <Users size={22} color="#7C3AED" />,       color: '#7C3AED', route: '/(app)/(doctor)/students' },
            { label: 'Archived',   icon: <Archive size={22} color="#D97706" />,     color: '#D97706', route: '/(app)/archived-courses' },
            { label: 'Alerts',     icon: <Bell size={22} color="#2DA8FF" />,         color: '#2DA8FF', route: '/(app)/notifications' },
          ].map(({ label, icon, color, route }) => (
            <NeuCard
              key={label}
              pressable
              onPress={() => router.push(route as RelativePathString)}
              style={{ alignItems: 'center', paddingVertical: 12, paddingHorizontal: 10, width: '22%', flexGrow: 1, minWidth: 72 }}
            >
              <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
                {icon}
              </View>
              <Text numberOfLines={2} style={{ fontSize: 11, fontWeight: '600', color: c.text, textAlign: 'center', lineHeight: 14 }}>
                {label}
              </Text>
            </NeuCard>
          ))}
        </View>

        {/* Recent Enrollments */}
        {recentEnrollments.length > 0 && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>Recent Enrollments</Text>
              <Pressable onPress={() => router.push('/(app)/(doctor)/students' as RelativePathString)}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>See All</Text>
              </Pressable>
            </View>
            {recentEnrollments.map(e => (
              <NeuCard key={e.id} style={{ marginBottom: 8, padding: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                    <Text style={{ fontSize: 13, fontWeight: '800', color: c.primary }}>{e.student?.full_name?.[0]?.toUpperCase() ?? '?'}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={1}>{e.student?.full_name}</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }} numberOfLines={1}>{e.course?.title}</Text>
                  </View>
                  <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>{new Date(e.created_at).toLocaleDateString()}</Text>
                </View>
              </NeuCard>
            ))}
          </>
        )}

        {/* Recent Courses */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, marginTop: 8 }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>Recent Courses</Text>
          <Pressable onPress={() => router.push('/(app)/(doctor)/courses' as RelativePathString)}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>See All</Text>
          </Pressable>
        </View>
        {courses.slice(0, 3).map((course) => (
          <NeuCard
            key={course.id}
            pressable
            onPress={() => router.push(`/(app)/course/${course.id}` as RelativePathString)}
            style={{ flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 8 }}
          >
            <CourseThumbnail
              imageUrl={course.image_url ?? course.thumbnail_url ?? course.cover_url}
              width={42}
              height={42}
              borderRadius={11}
            />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }} numberOfLines={1}>{course.title}</Text>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 2 }}>{course.category?.name ?? 'General'}</Text>
            </View>
            <View style={{ backgroundColor: statusColor(course.status) + '20', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: statusColor(course.status), textTransform: 'capitalize' }}>{course.status}</Text>
            </View>
          </NeuCard>
        ))}
        {courses.length === 0 && (
          <NeuCard style={{ alignItems: 'center', padding: 28 }}>
            <Plus size={32} color={c.primary} opacity={0.3} style={{ marginBottom: 8 }} />
            <Text style={{ color: c.text, opacity: 0.45, fontSize: 13 }}>No courses yet. Create your first course!</Text>
          </NeuCard>
        )}
      </View>
    </ScrollView>
    </>
  );
}

function statusColor(s: string) {
  if (s === 'published') return '#16A34A';
  if (s === 'hidden') return '#D97706';
  return '#6B7280';
}
