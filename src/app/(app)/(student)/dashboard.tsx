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
    // The guard lives INSIDE try so `setLoading(false)` always runs: if the
    // profile store is empty (e.g. the profile fetch failed non-fatally), the
    // screen must still exit the loading state and render the empty states
    // instead of spinning forever.
    try {
      if (!profile) { setLoading(false); return; }
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
  const chipStyle = (active: boolean) => ({
    paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.xs + 2, borderRadius: 20,
    backgroundColor: active ? c.primary : c.base,
    shadowColor: active ? 'transparent' : c.shadowDark,
    shadowOffset: { width: 2, height: 2 },
    shadowOpacity: active ? 0 : 0.45,
    shadowRadius: 4,
    marginRight: layout.pad.sm,
  });
  const chipText = (active: boolean) => ({
    fontSize: layout.captionSize, fontWeight: '600' as const,
    color: active ? '#fff' : c.text,
    opacity: active ? 1 : 0.65,
  });

  // Fluid thumbnail size: 72–96dp based on layout.touchTarget
  const thumbSize = Math.round(layout.touchTarget * 1.75);

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
    const iconSz = Math.round(thumbSize * 0.36);
    return (
      <Pressable
        key={sub.id}
        onPress={() => router.push(`/(app)/course/${course.id}` as RelativePathString)}
        style={{ marginBottom: layout.itemGap }}
      >
        <NeuCard style={{ padding: 0, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', alignItems: 'stretch' }}>
            {course.image_url ? (
              <Image
                source={{ uri: course.image_url }}
                style={{ width: thumbSize, height: thumbSize, flexShrink: 0 }}
                contentFit="cover"
              />
            ) : (
              <View style={{ width: thumbSize, height: thumbSize, backgroundColor: `${c.primary}12`,
                alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <BookOpen size={iconSz} color={c.primary} opacity={0.25} />
              </View>
            )}
            <View style={{ flex: 1, paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.sm, justifyContent: 'space-between' }}>
              <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text, lineHeight: layout.bodySize * 1.35 }} numberOfLines={2}>
                {course.title}
              </Text>
              <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.45, marginTop: 2 }} numberOfLines={1}>
                {`Dr. ${course.doctor?.full_name ?? '—'}${course.category?.name ? ` · ${course.category.name}` : ''}`}
              </Text>
              <View style={{ marginTop: 4, flexDirection: 'row', justifyContent: 'flex-end' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4,
                  backgroundColor: `${c.primary}15`, borderRadius: layout.cardRadius / 2,
                  paddingHorizontal: layout.pad.sm, paddingVertical: layout.pad.xs }}>
                  <Play size={layout.captionSize - 2} color={c.primary} />
                  <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '700', color: c.primary }}>Continue</Text>
                </View>
              </View>
            </View>
          </View>
        </NeuCard>
      </Pressable>
    );
  };

  const renderExploreCourseCard = (course: any) => {
    const iconSz = Math.round(thumbSize * 0.34);
    return (
      <Pressable
        key={course.id}
        onPress={() => router.push(`/(app)/course/${course.id}` as RelativePathString)}
        style={{ marginBottom: layout.itemGap }}
      >
        <NeuCard style={{ padding: 0, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row' }}>
            {course.image_url ? (
              <Image
                source={{ uri: course.image_url }}
                style={{ width: thumbSize, height: thumbSize, flexShrink: 0 }}
                contentFit="cover"
              />
            ) : (
              <View style={{ width: thumbSize, height: thumbSize, backgroundColor: `${c.primary}12`,
                alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <BookOpen size={iconSz} color={c.primary} opacity={0.25} />
              </View>
            )}
            <View style={{ flex: 1, paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.sm, justifyContent: 'space-between' }}>
              <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text, lineHeight: layout.bodySize * 1.35 }} numberOfLines={2}>
                {course.title}
              </Text>
              <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.45, marginTop: 2 }} numberOfLines={1}>
                Dr. {course.doctor?.full_name ?? '—'}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: layout.pad.sm }}>
                <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '800',
                  color: isFree(course) ? '#16A34A' : c.primary }}>
                  {formatPrice(course)}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3,
                  backgroundColor: `${c.primary}15`, borderRadius: layout.cardRadius / 2,
                  paddingHorizontal: layout.pad.sm, paddingVertical: layout.pad.xs }}>
                  <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '700', color: c.primary }}>View</Text>
                  <ChevronRight size={layout.captionSize - 1} color={c.primary} />
                </View>
              </View>
            </View>
          </View>
        </NeuCard>
      </Pressable>
    );
  };

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
              style={[{ width: layout.touchTarget + 2, height: layout.touchTarget + 2, borderRadius: layout.cardRadius, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
            >
              <Key size={Math.round((layout.touchTarget + 2) * 0.4)} color={c.accent} />
            </Pressable>
            <Pressable
              onPress={() => router.push('/(app)/notifications' as RelativePathString)}
              accessibilityLabel={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
              accessibilityRole="button"
              style={[{ width: layout.touchTarget + 2, height: layout.touchTarget + 2, borderRadius: layout.cardRadius, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
            >
              <Bell size={Math.round((layout.touchTarget + 2) * 0.43)} color={c.primary} />
              {unreadCount > 0 && (
                <View style={{ position: 'absolute', top: layout.pad.sm, right: layout.pad.sm, width: layout.pad.sm, height: layout.pad.sm, borderRadius: layout.pad.xs, backgroundColor: '#EF4444' }} />
              )}
            </Pressable>
          </>
        }
      />
      <View style={{ paddingHorizontal: layout.screenPx }}>

        {/* ── Search bar ────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.sm, marginBottom: layout.pad.sm }}>
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
            style={[{ width: layout.touchTarget + 2, height: layout.touchTarget + 2, borderRadius: layout.cardRadius, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
          >
            <SlidersHorizontal size={layout.bodySize + 2} color={hasActiveFilters ? c.primary : c.text} opacity={hasActiveFilters ? 1 : 0.55} />
            {activeFilterCount > 0 && (
              <View style={{ position: 'absolute', top: layout.pad.xs, right: layout.pad.xs, width: 14, height: 14, borderRadius: 7, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: layout.captionSize - 3, fontWeight: '800', color: '#fff' }}>{activeFilterCount}</Text>
              </View>
            )}
          </Pressable>
        </View>

        {/* ── Filter panel ──────────────────────────────────────────────── */}
        {showFilters && (
          <NeuCard style={{ marginBottom: layout.pad.md, padding: layout.cardPx }}>
            <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '800', color: c.text, opacity: 0.45, marginBottom: layout.pad.sm, textTransform: 'uppercase', letterSpacing: 0.8 }}>Category</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: layout.pad.md }}>
              <Pressable onPress={() => setFilters(f => ({ ...f, category: null }))} style={chipStyle(!filters.category)}>
                <Text style={chipText(!filters.category)}>All</Text>
              </Pressable>
              {categories.map(cat => (
                <Pressable key={cat.id} onPress={() => setFilters(f => ({ ...f, category: f.category === cat.id ? null : cat.id }))} style={chipStyle(filters.category === cat.id)}>
                  <Text style={chipText(filters.category === cat.id)}>{cat.name}</Text>
                </Pressable>
              ))}
            </ScrollView>

            {teachers.length > 0 && (
              <>
                <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '800', color: c.text, opacity: 0.45, marginBottom: layout.pad.sm, textTransform: 'uppercase', letterSpacing: 0.8 }}>Teacher</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: layout.pad.md }}>
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

            <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '800', color: c.text, opacity: 0.45, marginBottom: layout.pad.sm, textTransform: 'uppercase', letterSpacing: 0.8 }}>Price</Text>
            <View style={{ flexDirection: 'row', gap: layout.pad.sm }}>
              {(['all', 'free', 'paid'] as const).map(pt => (
                <Pressable key={pt} onPress={() => setFilters(f => ({ ...f, priceType: pt }))} style={chipStyle(filters.priceType === pt)}>
                  <Text style={chipText(filters.priceType === pt)}>{pt.charAt(0).toUpperCase() + pt.slice(1)}</Text>
                </Pressable>
              ))}
            </View>

            {hasActiveFilters && (
              <Pressable
                onPress={() => setFilters({ category: null, teacher: null, priceType: 'all' })}
                style={{ marginTop: layout.pad.md, alignItems: 'center' }}
              >
                <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '700', color: '#DC2626' }}>Clear All Filters</Text>
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
        <View style={{ paddingHorizontal: layout.screenPx, paddingTop: layout.pad.md, paddingBottom: layout.scrollBottom() }}>

          {/* ── My Courses ───────────────────────────────────────────────── */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: layout.pad.md }}>
            <Text style={{ fontSize: layout.bodySize + 2, fontWeight: '800', color: c.text }}>My Courses</Text>
            {subscriptions.length > 3 && (
              <Pressable onPress={() => router.push('/(app)/(student)/my-courses' as RelativePathString)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.xs }}>
                <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '700', color: c.primary }}>See All</Text>
                <ChevronRight size={layout.captionSize + 1} color={c.primary} />
              </Pressable>
            )}
          </View>

          {filteredMyCourses.length === 0 ? (
            <NeuCard style={{ alignItems: 'center', padding: layout.cardPx * 1.5, marginBottom: layout.sectionGap }}>
              <BookOpen size={Math.round(layout.touchTarget * 0.85)} color={c.primary} opacity={0.25} style={{ marginBottom: layout.pad.sm }} />
              <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: layout.pad.xs }}>
                {searchQuery ? 'No matching courses' : "You haven't enrolled in any courses yet."}
              </Text>
              {!searchQuery && (
                <Pressable
                  onPress={() => { setSearchQuery(''); setShowFilters(false); }}
                  style={{ marginTop: layout.pad.sm, backgroundColor: c.primary, borderRadius: layout.cardRadius, paddingHorizontal: layout.pad.lg, paddingVertical: layout.pad.sm }}
                >
                  <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: '#fff' }}>Browse Courses ↓</Text>
                </Pressable>
              )}
            </NeuCard>
          ) : (
            <>
              {filteredMyCourses.slice(0, 3).map(renderMyCourseCard)}
              {filteredMyCourses.length > 3 && (
                <Pressable
                  onPress={() => router.push('/(app)/(student)/my-courses' as RelativePathString)}
                  style={{ alignItems: 'center', marginBottom: layout.sectionGap }}
                >
                  <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.primary }}>
                    View all {filteredMyCourses.length} courses →
                  </Text>
                </Pressable>
              )}
            </>
          )}

          {/* ── Explore / Available Courses ───────────────────────────── */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: layout.pad.md, marginTop: layout.pad.sm }}>
            <View>
              <Text style={{ fontSize: layout.bodySize + 2, fontWeight: '800', color: c.text }}>Explore Courses</Text>
              {filteredExplore.length > 0 && (
                <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.4, marginTop: 2 }}>
                  {filteredExplore.length} available
                </Text>
              )}
            </View>
          </View>

          {filteredExplore.length === 0 ? (
            <NeuCard style={{ alignItems: 'center', padding: layout.cardPx * 1.5, marginBottom: layout.sectionGap }}>
              <Search size={Math.round(layout.touchTarget * 0.85)} color={c.primary} opacity={0.25} style={{ marginBottom: layout.pad.sm }} />
              <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text, opacity: 0.5, textAlign: 'center' }}>
                {searchQuery || hasActiveFilters ? 'No courses match your search' : 'No new courses available'}
              </Text>
              {(searchQuery || hasActiveFilters) && (
                <Pressable
                  onPress={() => { setSearchQuery(''); setFilters({ category: null, teacher: null, priceType: 'all' }); }}
                  style={{ marginTop: layout.pad.sm }}
                >
                  <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.primary }}>Clear search & filters</Text>
                </Pressable>
              )}
            </NeuCard>
          ) : (
            filteredExplore.map(renderExploreCourseCard)
          )}

        </View>
      )}
    </ScrollView>
    </View>
  );
}
