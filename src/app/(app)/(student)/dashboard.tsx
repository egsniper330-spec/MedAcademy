import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  BookOpen, Award, Bell, Key, TrendingUp,
  Search, SlidersHorizontal, ChevronRight, Play, X,
} from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import {
  getMySubscriptions, getUnreadNotificationCount,
  getPublishedCourses, getCategories,
} from '@/lib/api';
import { getFirstName } from '@/lib/utils';
import { NeuCard } from '@/components/NeuCard';
import { NeuSearchBar } from '@/components/NeuInputRow';
import { StatCardCarousel } from '@/components/StatCard';
import type { StatCardItem } from '@/components/StatCard';
import { neuColors, neuMicroStyle, useLayout, safeBottom } from '@/lib/neu';
import { DashboardHeader } from '@/components/DashboardHeader';
import { useNotificationPermission } from '@/hooks/useNotificationPermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';

// ── Types ──────────────────────────────────────────────────────────────────────
interface FilterState {
  category: string | null;
  teacher: string | null;
  priceType: 'all' | 'free' | 'paid';
}

export default function StudentDashboard() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const { profile } = useProfileStore();
  const router = useRouter();

  // ── Data state ────────────────────────────────────────────────────────────
  const [subscriptions, setSubscriptions] = useState<any[]>([]);
  const [allCourses, setAllCourses] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // ── Search & Filter state ─────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<FilterState>({ category: null, teacher: null, priceType: 'all' });

  const loadData = useCallback(async () => {
    if (!profile) return;
    try {
      const [subs, count, courses, cats] = await Promise.all([
        getMySubscriptions(profile.id),
        getUnreadNotificationCount(profile.id),
        getPublishedCourses(),
        getCategories(),
      ]);
      setSubscriptions(subs);
      setUnreadCount(count);
      setAllCourses(courses);
      setCategories(cats);
    } catch {}
    setLoading(false);
  }, [profile]);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

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

  // ── Derived data ──────────────────────────────────────────────────────────
  const enrolledCourseIds = useMemo(
    () => new Set(subscriptions.map(s => s.course_id ?? s.course?.id)),
    [subscriptions],
  );

  // enrollments.status is a text column; treat 'completed' as done, otherwise in-progress
  const completedCount = subscriptions.filter(e => e.status === 'completed').length;
  const inProgressCount = subscriptions.length - completedCount;
  const firstName = getFirstName(profile?.full_name);

  // Explore courses = published + not enrolled
  const exploreCourses = useMemo(
    () => allCourses.filter(c => !enrolledCourseIds.has(c.id)),
    [allCourses, enrolledCourseIds],
  );

  // Unique teachers from explore list
  const teachers = useMemo(() => {
    const map = new Map<string, string>();
    exploreCourses.forEach(c => {
      if (c.doctor?.id) map.set(c.doctor.id, c.doctor.full_name);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [exploreCourses]);

  // Search + filter applied to explore courses
  const filteredExplore = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return exploreCourses.filter(course => {
      // Text search
      if (q) {
        const titleMatch = course.title?.toLowerCase().includes(q);
        const teacherMatch = course.doctor?.full_name?.toLowerCase().includes(q);
        const catMatch = course.category?.name?.toLowerCase().includes(q);
        if (!titleMatch && !teacherMatch && !catMatch) return false;
      }
      // Category filter
      if (filters.category && course.category?.id !== filters.category) return false;
      // Teacher filter
      if (filters.teacher && course.doctor?.id !== filters.teacher) return false;
      // Price filter
      if (filters.priceType === 'free' && (course.price ?? 0) > 0) return false;
      if (filters.priceType === 'paid' && (course.price ?? 0) === 0) return false;
      return true;
    });
  }, [exploreCourses, searchQuery, filters]);

  // Search also applies to my courses
  const filteredMyCourses = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return subscriptions;
    return subscriptions.filter(sub => {
      const titleMatch = sub.course?.title?.toLowerCase().includes(q);
      const teacherMatch = sub.course?.doctor?.full_name?.toLowerCase().includes(q);
      const catMatch = sub.course?.category?.name?.toLowerCase().includes(q);
      return titleMatch || teacherMatch || catMatch;
    });
  }, [subscriptions, searchQuery]);

  const hasActiveFilters = filters.category || filters.teacher || filters.priceType !== 'all';
  const activeFilterCount = [filters.category, filters.teacher, filters.priceType !== 'all' ? 1 : null].filter(Boolean).length;

  const statCards: StatCardItem[] = [
    { id: 'subscribed', label: 'My Courses',    value: subscriptions.length, icon: <BookOpen size={18} color="#fff" />, color: c.primary },
    { id: 'progress',   label: 'In Progress',   value: inProgressCount,      icon: <TrendingUp size={18} color="#fff" />, color: '#D97706' },
    { id: 'completed',  label: 'Completed',      value: completedCount,        icon: <Award size={18} color="#fff" />,     color: '#16A34A' },
    { id: 'notifs',     label: 'Notifications',  value: unreadCount,          icon: <Bell size={18} color="#fff" />,      color: '#1E90FF' },
  ];

  // ── Helpers ───────────────────────────────────────────────────────────────
  const neuInset = {
    backgroundColor: c.base,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    shadowColor: c.shadowDark,
    shadowOffset: { width: -2, height: -2 },
    shadowOpacity: 0.5,
    shadowRadius: 5,
  };

  const chipStyle = (active: boolean) => ({
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
    backgroundColor: active ? c.primary : c.base,
    shadowColor: active ? 'transparent' : c.shadowDark,
    shadowOffset: { width: 2, height: 2 },
    shadowOpacity: active ? 0 : 0.45,
    shadowRadius: 4,
    marginRight: 8,
  });
  const chipText = (active: boolean) => ({
    fontSize: 12, fontWeight: '600' as const,
    color: active ? '#fff' : c.text,
    opacity: active ? 1 : 0.65,
  });

  // Price display: price_egp column (0 = free)
  const formatPrice = (course: any) => {
    const p = course.price_egp ?? 0;
    if (!p || p === 0) return 'Free';
    return `EGP ${Number(p).toFixed(0)}`;
  };

  const isFree = (course: any) => !course.price_egp || Number(course.price_egp) === 0;

  // ── Render helpers ────────────────────────────────────────────────────────
  const renderMyCourseCard = (sub: any) => {
    const course = sub.course;
    if (!course) return null;
    return (
      <Pressable
        key={sub.id}
        onPress={() => router.push(`/(app)/course/${course.id}` as RelativePathString)}
        style={{ marginBottom: 8 }}
      >
        <NeuCard style={{ padding: 0, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', alignItems: 'stretch' }}>
            {/* Thumbnail — 80×80 */}
            {course.image_url ? (
              <Image
                source={{ uri: course.image_url }}
                style={{ width: 80, height: 80, flexShrink: 0 }}
                contentFit="cover"
              />
            ) : (
              <View style={{ width: 80, height: 80, backgroundColor: `${c.primary}12`,
                alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <BookOpen size={28} color={c.primary} opacity={0.25} />
              </View>
            )}
            {/* Content */}
            <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8, justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, lineHeight: 17 }} numberOfLines={2}>
                {course.title}
              </Text>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 2 }} numberOfLines={1}>
                {`Dr. ${course.doctor?.full_name ?? '—'}${course.category?.name ? ` · ${course.category.name}` : ''}`}
              </Text>
              {/* Continue button only — no progress bar (progress requires a separate RPC) */}
              <View style={{ marginTop: 4, flexDirection: 'row', justifyContent: 'flex-end' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4,
                  backgroundColor: `${c.primary}15`, borderRadius: 7,
                  paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Play size={9} color={c.primary} />
                  <Text style={{ fontSize: 10, fontWeight: '700', color: c.primary }}>Continue</Text>
                </View>
              </View>
            </View>
          </View>
        </NeuCard>
      </Pressable>
    );
  };

  const renderExploreCourseCard = (course: any) => (
    <Pressable
      key={course.id}
      onPress={() => router.push(`/(app)/course/${course.id}` as RelativePathString)}
      style={{ marginBottom: 8 }}
    >
      <NeuCard style={{ padding: 0, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row' }}>
          {course.image_url ? (
            <Image
              source={{ uri: course.image_url }}
              style={{ width: 80, height: 80, flexShrink: 0 }}
              contentFit="cover"
            />
          ) : (
            <View style={{ width: 80, height: 80, backgroundColor: `${c.primary}12`,
              alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <BookOpen size={26} color={c.primary} opacity={0.25} />
            </View>
          )}
          <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8, justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, lineHeight: 17 }} numberOfLines={2}>
              {course.title}
            </Text>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 2 }} numberOfLines={1}>
              Dr. {course.doctor?.full_name ?? '—'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
              <Text style={{ fontSize: 12, fontWeight: '800',
                color: isFree(course) ? '#16A34A' : c.primary }}>
                {formatPrice(course)}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3,
                backgroundColor: `${c.primary}15`, borderRadius: 7,
                paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: c.primary }}>View</Text>
                <ChevronRight size={9} color={c.primary} />
              </View>
            </View>
          </View>
        </View>
      </NeuCard>
    </Pressable>
  );

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
      {/* DashboardHeader owns its safe-area top padding — no paddingTop on outer View */}
      <DashboardHeader
        roleLabel="Welcome back,"
        greeting={firstName ? `${firstName} 👋` : '👋'}
        rightActions={
          <>
            <Pressable
              onPress={() => router.push('/(app)/(student)/activate' as RelativePathString)}
              accessibilityLabel="Activate course code"
              accessibilityRole="button"
              style={[{ width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
            >
              <Key size={17} color={c.accent} />
            </Pressable>
            <Pressable
              onPress={() => router.push('/(app)/notifications' as RelativePathString)}
              accessibilityLabel={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
              accessibilityRole="button"
              style={[{ width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
            >
              <Bell size={18} color={c.primary} />
              {unreadCount > 0 && (
                <View style={{ position: 'absolute', top: 8, right: 8, width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#EF4444' }} />
              )}
            </Pressable>
          </>
        }
      />
      <View style={{ paddingHorizontal: layout.screenPx }}>

        {/* ── Search bar ────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <NeuSearchBar
            c={c}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onClear={() => setSearchQuery('')}
            placeholder="Search courses..."
            returnKeyType="search"
          />
          <Pressable
            onPress={() => setShowFilters(v => !v)}
            style={[{ width: 46, height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
          >
            <SlidersHorizontal size={18} color={hasActiveFilters ? c.primary : c.text} opacity={hasActiveFilters ? 1 : 0.55} />
            {activeFilterCount > 0 && (
              <View style={{ position: 'absolute', top: 7, right: 7, width: 13, height: 13, borderRadius: 6.5, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 8, fontWeight: '800', color: '#fff' }}>{activeFilterCount}</Text>
              </View>
            )}
          </Pressable>
        </View>

        {/* ── Filter panel ──────────────────────────────────────────────── */}
        {showFilters && (
          <NeuCard style={{ marginBottom: 14, padding: 14 }}>
            {/* Category */}
            <Text style={{ fontSize: 10, fontWeight: '800', color: c.text, opacity: 0.45, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>Category</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              <Pressable onPress={() => setFilters(f => ({ ...f, category: null }))} style={chipStyle(!filters.category)}>
                <Text style={chipText(!filters.category)}>All</Text>
              </Pressable>
              {categories.map(cat => (
                <Pressable key={cat.id} onPress={() => setFilters(f => ({ ...f, category: f.category === cat.id ? null : cat.id }))} style={chipStyle(filters.category === cat.id)}>
                  <Text style={chipText(filters.category === cat.id)}>{cat.name}</Text>
                </Pressable>
              ))}
            </ScrollView>

            {/* Teacher */}
            {teachers.length > 0 && (
              <>
                <Text style={{ fontSize: 10, fontWeight: '800', color: c.text, opacity: 0.45, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>Teacher</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                  <Pressable onPress={() => setFilters(f => ({ ...f, teacher: null }))} style={chipStyle(!filters.teacher)}>
                    <Text style={chipText(!filters.teacher)}>All</Text>
                  </Pressable>
                  {teachers.map(t => (
                    <Pressable key={t.id} onPress={() => setFilters(f => ({ ...f, teacher: f.teacher === t.id ? null : t.id }))} style={chipStyle(filters.teacher === t.id)}>
                      <Text style={chipText(filters.teacher === t.id)}>Dr. {t.name}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </>
            )}

            {/* Price */}
            <Text style={{ fontSize: 10, fontWeight: '800', color: c.text, opacity: 0.45, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>Price</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['all', 'free', 'paid'] as const).map(pt => (
                <Pressable key={pt} onPress={() => setFilters(f => ({ ...f, priceType: pt }))} style={chipStyle(filters.priceType === pt)}>
                  <Text style={chipText(filters.priceType === pt)}>{pt.charAt(0).toUpperCase() + pt.slice(1)}</Text>
                </Pressable>
              ))}
            </View>

            {hasActiveFilters && (
              <Pressable
                onPress={() => setFilters({ category: null, teacher: null, priceType: 'all' })}
                style={{ marginTop: 12, alignItems: 'center' }}
              >
                <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>Clear All Filters</Text>
              </Pressable>
            )}
          </NeuCard>
        )}
      </View>

      {/* Stat card carousel */}
      <StatCardCarousel cards={statCards} />

      {loading ? (
        <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
      ) : (
        <View style={{ paddingHorizontal: layout.screenPx, paddingTop: 12, paddingBottom: layout.scrollBottom() }}>

          {/* ── My Courses ───────────────────────────────────────────────── */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }}>My Courses</Text>
            {subscriptions.length > 3 && (
              <Pressable onPress={() => router.push('/(app)/(student)/my-courses' as RelativePathString)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>See All</Text>
                <ChevronRight size={13} color={c.primary} />
              </Pressable>
            )}
          </View>

          {filteredMyCourses.length === 0 ? (
            <NeuCard style={{ alignItems: 'center', padding: 28, marginBottom: 20 }}>
              <BookOpen size={38} color={c.primary} opacity={0.25} style={{ marginBottom: 10 }} />
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 4 }}>
                {searchQuery ? 'No matching courses' : "You haven't enrolled in any courses yet."}
              </Text>
              {!searchQuery && (
                <Pressable
                  onPress={() => { setSearchQuery(''); setShowFilters(false); }}
                  style={{ marginTop: 10, backgroundColor: c.primary, borderRadius: 11, paddingHorizontal: 18, paddingVertical: 9 }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Browse Courses ↓</Text>
                </Pressable>
              )}
            </NeuCard>
          ) : (
            <>
              {filteredMyCourses.slice(0, 3).map(renderMyCourseCard)}
              {filteredMyCourses.length > 3 && (
                <Pressable
                  onPress={() => router.push('/(app)/(student)/my-courses' as RelativePathString)}
                  style={{ alignItems: 'center', marginBottom: 20 }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>
                    View all {filteredMyCourses.length} courses →
                  </Text>
                </Pressable>
              )}
            </>
          )}

          {/* ── Explore / Available Courses ───────────────────────────── */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, marginTop: 8 }}>
            <View>
              <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }}>Explore Courses</Text>
              {filteredExplore.length > 0 && (
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: 2 }}>
                  {filteredExplore.length} available
                </Text>
              )}
            </View>
          </View>

          {filteredExplore.length === 0 ? (
            <NeuCard style={{ alignItems: 'center', padding: 28, marginBottom: 20 }}>
              <Search size={38} color={c.primary} opacity={0.25} style={{ marginBottom: 10 }} />
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, opacity: 0.5, textAlign: 'center' }}>
                {searchQuery || hasActiveFilters ? 'No courses match your search' : 'No new courses available'}
              </Text>
              {(searchQuery || hasActiveFilters) && (
                <Pressable
                  onPress={() => { setSearchQuery(''); setFilters({ category: null, teacher: null, priceType: 'all' }); }}
                  style={{ marginTop: 10 }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>Clear search & filters</Text>
                </Pressable>
              )}
            </NeuCard>
          ) : (
            filteredExplore.map(renderExploreCourseCard)
          )}

        </View>
      )}
    </ScrollView>
    </>
  );
}
