import { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, useColorScheme, Pressable, RefreshControl, TextInput, ActivityIndicator, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { Plus, BookOpen, Search, Archive, Clock, Users, ChevronRight, GraduationCap, MoreVertical, Trash2, Pencil, AlertTriangle, FileText, Globe, Eye, LayoutGrid } from 'lucide-react-native';
import { PortalOverlay } from '@/components/PortalOverlay';
import { DashboardHeader } from '@/components/DashboardHeader';
import { useProfileStore } from '@/lib/store';
import { getCoursesWithArchived, createCourse, deleteCourseWithCleanup, getCourseDeleteStats } from '@/lib/api';
import { startPreviewAsStudent, stopPreviewAsStudent } from '@/lib/previewAsStudent';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, safeBottom, mutedTextStyle } from '@/lib/neu';
import { useDebounce } from '@/lib/useDebounce';
import { useStaleWhileRevalidateFocus } from '@/lib/useStaleWhileRevalidateFocus';
import { useFeatureFlags, isFeatureDisabledError } from '@/lib/featureFlags';
import { FeatureUnavailableState } from '@/components/ScreenState';
import { useTranslation } from '@/lib/i18n';
import { courseStatusLabel, difficultyLabel } from '@/lib/i18n/labels';
import type { RelativePathString } from 'expo-router';

const DIFFICULTY_COLORS: Record<string, string> = {
  beginner: '#16A34A', intermediate: '#D97706', advanced: '#DC2626', all_levels: '#2563EB',
};
const STATUS_COLORS: Record<string, string> = {
  published: '#16A34A', draft: '#D97706', hidden: '#6B7280', archived: '#9CA3AF',
};

export default function DoctorCourses() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { width: screenW } = useWindowDimensions();
  const insets = layout.insets;
  const { profile } = useProfileStore();
  const router = useRouter();
  const { t, tCount, locale } = useTranslation();

  const [courses, setCourses] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 300);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'published'>('all');
  const { showToast } = useToast();

  //  COURSE CREATION FEATURE FLAG — the server refuses course creation while the
  //  flag is off (403 feature_disabled) on every entry point (RPC, /courses,
  //  /api/courses, duplicate). The UI reflects that state so a doctor never
  //  meets a confusing "creation failed" error for a deliberate admin setting.
  const { isEnabled } = useFeatureFlags();
  const canCreate = isEnabled('course_creation');
  //  Set when the server refuses a create; shows the shared unavailable state.
  const [createBlocked, setCreateBlocked] = useState(false);

  // ── Options menu ─────────────────────────────────────────────────────────────
  const [menuCourse,    setMenuCourse]    = useState<any>(null);
  const [menuVisible,   setMenuVisible]   = useState(false);

  // ── Delete confirmation ───────────────────────────────────────────────────────
  const [deleteTarget,  setDeleteTarget]  = useState<any>(null);
  const [deleteStats,   setDeleteStats]   = useState<any>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [statsLoading,  setStatsLoading]  = useState(false);

  const loadData = useCallback(async () => {
    if (!profile) return;
    try {
      // Server-side status filter (draft / published) + archived excluded by default.
      // 'all' fetches everything and sorts published-first client-side (the API's
      // single-column ORDER BY can't express status-grouped ordering).
      const data = await getCoursesWithArchived({ doctorId: profile.id, status: statusFilter === 'all' ? undefined : statusFilter });
      const sorted = statusFilter === 'all'
        ? [...data].sort((a: any, b: any) => {
            if (a.status === b.status) {
              // Within a group: most recently updated/created first
              const ta = a.updated_at ?? a.created_at ?? '';
              const tb = b.updated_at ?? b.created_at ?? '';
              return tb.localeCompare(ta);
            }
            return a.status === 'published' ? -1 : 1; // published before drafts
          })
        : data;
      setCourses(sorted);
    } catch {}
    setLoading(false);
  }, [profile, statusFilter]);

  // Stale-while-revalidate: the course list stays on screen and refreshes in
  // the background on focus instead of collapsing to a full-screen spinner.
  // hasContent() keeps the spinner for a genuinely empty first load.
  useStaleWhileRevalidateFocus(loadData, {
    setLoading,
    hasContent: () => courses.length > 0,
  });
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const filtered = courses.filter(course =>
    !debouncedQuery || course.title.toLowerCase().includes(debouncedQuery.toLowerCase())
  );

  // Create a blank course and navigate into the builder
  const handleNewCourse = async () => {
    if (!profile) return;
    setCreating(true);
    try {
      const course = await createCourse({
        title: 'Untitled Course',
        description: '',
        doctor_id: profile.id,
        status: 'draft',
      });
      router.push(`/(app)/course-builder/${course.id}` as RelativePathString);
    } catch (e: any) {
      // A DISABLED FEATURE is not a failure — render the shared unavailable
      // state instead of an alarming "Course creation failed" toast.
      if (isFeatureDisabledError(e)) {
        setCreateBlocked(true);
        showToast({ type: 'info', message: t('drCourses.creationDisabled') });
      } else {
        // Surface the real DB/RPC error so issues are immediately visible
        const msg = e?.message ?? e?.error_description ?? String(e);
        const code = e?.code ? ` [${e.code}]` : '';
        console.error('[courses] createCourse failed:', e);
        showToast({ type: 'error', message: t('drCourses.createFailed', { code, message: msg }) });
      }
    }
    setCreating(false);
  };

  // Open the "⋮" options menu for a course
  const openMenu = (course: any) => {
    setMenuCourse(course);
    setMenuVisible(true);
  };
  const closeMenu = () => { setMenuVisible(false); setMenuCourse(null); };

  // Navigate to course builder (edit)
  const handleEdit = () => {
    if (!menuCourse) return;
    closeMenu();
    router.push(`/(app)/course-builder/${menuCourse.id}` as RelativePathString);
  };

  // "Preview as Student" — see exactly what an enrolled student sees for this
  // course. Uses the student-facing course screen with student fetch semantics;
  // the doctor's role/JWT is untouched. Only one preview session at a time.
  const handlePreviewAsStudent = () => {
    if (!menuCourse) return;
    stopPreviewAsStudent();
    startPreviewAsStudent(menuCourse.id);
    closeMenu();
    router.push(`/(app)/course/${menuCourse.id}` as RelativePathString);
  };

  // Open delete confirmation: fetch stats first
  const handleOpenDelete = async () => {
    if (!menuCourse) return;
    const target = menuCourse;
    closeMenu();
    setDeleteTarget(target);
    setDeleteStats(null);
    setStatsLoading(true);
    try {
      const stats = await getCourseDeleteStats(target.id);
      setDeleteStats(stats);
    } catch {
      setDeleteStats({ title: target.title, enrolled_count: '?', lesson_count: '?', video_count: '?', attachment_count: '?' });
    }
    setStatsLoading(false);
  };

  // Execute deletion
  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const result = await deleteCourseWithCleanup(deleteTarget.id);
      showToast({
        type: 'success',
        message: `${t('drCourses.deletedTitle', { title: deleteTarget.title })} ${tCount('drCourses.studentsRemoved', result.students_removed)}`,
      });
      setDeleteTarget(null);
      setDeleteStats(null);
      await loadData();
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? t('drCourses.deleteFailed') });
    }
    setDeleteLoading(false);
  };

  return (
    <>
      <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} style={{ flex: 1, backgroundColor: c.base }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {/* Header — uses DashboardHeader for consistent safe-area + hamburger alignment */}
        <DashboardHeader
          greeting={t('nav.myCourses')}
          roleLabel={tCount('drCourses.count', courses.length)}
          rightActions={
            canCreate ? (
              <Pressable onPress={handleNewCourse} disabled={creating}
                style={{ backgroundColor: c.primary, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {creating
                ? <ActivityIndicator size="small" color="#fff" />
                : <Plus size={18} color="#fff" />}
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>{t('common.new')}</Text>
              </Pressable>
            ) : undefined
          }
        />

        {/* Course creation disabled — a deliberate configuration, not a failure.
            Existing courses stay fully viewable/editable (see the list below). */}
        {(!canCreate || createBlocked) && (
          <View style={{ marginHorizontal: layout.screenPx, marginBottom: 8 }}>
            <FeatureUnavailableState
              compact
              title={t('drCourses.creationUnavailableTitle')}
              description={t('drCourses.creationUnavailableDescription')}
            />
          </View>
        )}

        {/* Search + status filter tabs */}
        <View style={{ paddingHorizontal: layout.screenPx, marginBottom: 16, gap: 10 }}>
          <View style={[{ borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10, minWidth: 0 },
            { backgroundColor: c.base, shadowColor: c.shadowDark, shadowOffset: { width: 3, height: 3 }, shadowOpacity: 0.6, shadowRadius: 8, elevation: 3 }]}>
            <Search size={16} color={c.text} opacity={0.4} style={{ flexShrink: 0 }} />
            <TextInput value={query} onChangeText={setQuery} placeholder={t('course.searchPlaceholder')}
              placeholderTextColor={`${c.text}55`}
              style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text, paddingVertical: 12 }} />
          </View>

          {/* Segmented status filter — All (published first) / Drafts / Published */}
          <View style={{ flexDirection: 'row', backgroundColor: `${c.text}08`, borderRadius: 12, padding: 3, gap: 3 }}>
            {(['all', 'draft', 'published'] as const).map(status => {
              const active = statusFilter === status;
              const activeColor = status === 'draft' ? '#D97706' : status === 'published' ? '#16A34A' : c.primary;
              const Icon = status === 'draft' ? FileText : status === 'published' ? Globe : LayoutGrid;
              return (
                <Pressable key={status} onPress={() => setStatusFilter(status)}
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                    paddingVertical: 9, borderRadius: 9,
                    backgroundColor: active ? activeColor : 'transparent' }}>
                  <Icon size={13} color={active ? '#fff' : c.text} opacity={active ? 1 : 0.45} />
                  <Text style={{ fontSize: 13, fontWeight: '700', color: active ? '#fff' : c.text, opacity: active ? 1 : 0.55 }}>
                    {status === 'all' ? t('common.all') : status === 'draft' ? t('drCourses.drafts') : t('courseStatus.published')}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Course list */}
        <View style={{ paddingHorizontal: layout.screenPx, gap: 14 }}>
          {loading ? (
            <View style={{ paddingVertical: 60, alignItems: 'center' }}>
              <ActivityIndicator color={c.primary} />
            </View>
          ) : filtered.length === 0 ? (
            <View style={{ paddingVertical: 60, alignItems: 'center', gap: 12 }}>
              <BookOpen size={48} color={c.primary} opacity={0.2} />
              <Text style={{ fontSize: 16, ...mutedTextStyle(c, 0.4) }}>
                {query
                  ? t('drCourses.noMatches')
                  : statusFilter === 'draft' ? t('drCourses.noDrafts') : statusFilter === 'published' ? t('drCourses.noPublished') : t('drCourses.none')}
              </Text>
              {!query && (statusFilter === 'draft' || statusFilter === 'all') && canCreate && !createBlocked && (
                <NeuButton label={t('drCourses.createFirst')} onPress={handleNewCourse} loading={creating} />
              )}
            </View>
          ) : (
            filtered.map(course => (
              <NeuCard key={course.id} style={{ padding: 0, overflow: 'hidden' }}>
                {/* Thumbnail — tapping the image navigates to editor */}
                <Pressable onPress={() => router.push(`/(app)/course-builder/${course.id}` as RelativePathString)}>
                  {(course.image_url || course.cover_url || course.thumbnail_url) ? (
                    <Image
                      source={{ uri: course.image_url ?? course.cover_url ?? course.thumbnail_url }}
                      style={{ width: '100%', height: 140 }}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={{ width: '100%', height: 100, backgroundColor: `${c.primary}12`, alignItems: 'center', justifyContent: 'center' }}>
                      <GraduationCap size={36} color={c.primary} opacity={0.25} />
                    </View>
                  )}
                </Pressable>

                <View style={{ padding: 16, gap: 10 }}>
                  {/* Title + Status + Options menu button */}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                    <Pressable style={{ flex: 1 }}
                      onPress={() => router.push(`/(app)/course-builder/${course.id}` as RelativePathString)}>
                      <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }} numberOfLines={2}>
                        {course.title}
                      </Text>
                    </Pressable>
                    <View style={{ alignItems: 'flex-end', gap: 4 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20,
                          backgroundColor: `${STATUS_COLORS[course.status] ?? '#6B7280'}18` }}>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: STATUS_COLORS[course.status] ?? '#6B7280' }}>
                            {courseStatusLabel(course.status, t)}
                          </Text>
                        </View>
                        {/* ⋮ options menu */}
                        <Pressable onPress={() => openMenu(course)}
                          accessibilityRole="button"
                          accessibilityLabel={t('drCourses.optionsA11y', { title: course.title })}
                          style={{ padding: 4, borderRadius: 8, backgroundColor: `${c.text}08` }}>
                          <MoreVertical size={16} color={c.text} opacity={0.5} />
                        </Pressable>
                      </View>
                      {course.archived_at && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4,
                          paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: '#D9770618' }}>
                          <Archive size={9} color="#D97706" />
                          <Text style={{ fontSize: 10, fontWeight: '700', color: '#D97706' }}>{t('courseStatus.archived')}</Text>
                        </View>
                      )}
                    </View>
                  </View>

                  {/* Short description */}
                  {course.short_description ? (
                    <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.55), lineHeight: 18 }} numberOfLines={2}>
                      {course.short_description}
                    </Text>
                  ) : null}

                  {/* Meta row */}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                    {course.difficulty && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <View style={{ width: 8, height: 8, borderRadius: 4,
                          backgroundColor: DIFFICULTY_COLORS[course.difficulty] ?? c.primary }} />
                        <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.55) }}>
                          {difficultyLabel(course.difficulty, t)}
                        </Text>
                      </View>
                    )}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <BookOpen size={12} color={c.primary} />
                      <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.55) }}>
                        {tCount('drCourses.lessonCount', course.total_lessons ?? 0)}
                      </Text>
                    </View>
                    {course.total_sections > 0 && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Users size={12} color={c.primary} />
                        <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.55) }}>
                          {tCount('drCourses.sectionCount', course.total_sections)}
                        </Text>
                      </View>
                    )}
                    {course.estimated_duration_hours && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Clock size={12} color={c.primary} />
                        <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.55) }}>
                          {t('drCourses.duration', { hours: course.estimated_duration_hours })}
                        </Text>
                      </View>
                    )}
                  </View>

                  {/* Tags */}
                  {course.tags?.length > 0 && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {course.tags.slice(0, 3).map((tag: string) => (
                        <View key={tag} style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20,
                          backgroundColor: `${c.primary}15` }}>
                          <Text style={{ fontSize: 11, color: c.primary, fontWeight: '600' }}>{tag}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* Edit CTA */}
                  <Pressable style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 2 }}
                    onPress={() => router.push(`/(app)/course-builder/${course.id}` as RelativePathString)}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary, marginRight: 4 }}>{t('drCourses.edit')}</Text>
                    <ChevronRight size={14} color={c.primary} />
                  </Pressable>
                </View>
              </NeuCard>
            ))
          )}
        </View>
      </ScrollView>

      {/* ── Options menu modal ──────────────────────────────────────────────────── */}
      {/*
        Fix: was `position:'absolute', bottom:32` — hardcoded 32dp ignored the
        Android navigation-bar inset. With gesture-nav the bar can be 40+ dp,
        hiding the bottom button behind system UI.
        Fix: use `justifyContent:'flex-end'` on the scrim so the sheet naturally
        sits at the bottom, then apply `paddingBottom: Math.max(insets.bottom, 16)`
        on the sheet itself to clear the nav-bar on every device.
        Fix: added statusBarTranslucent so the scrim covers the Android status bar.
      */}
      <PortalOverlay visible={menuVisible} variant="dialog" backdropColor="rgba(0,0,0,0.35)" onRequestClose={closeMenu}>
        <View
          style={{
            ...StyleSheet.absoluteFillObject,
            alignItems: 'center',
            justifyContent: 'center',
            paddingTop: insets.top + 8,
            paddingBottom: insets.bottom + 8,
          }}
          pointerEvents="box-none"
        >
        <View style={{
          backgroundColor: c.base,
          borderRadius: 20,
          overflow: 'hidden',
          width: Math.min(screenW * 0.92, 360),
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.14,
          shadowRadius: 20,
          elevation: 12,
        }}>
              {/* Course name header */}
              <View style={{ padding: 18, borderBottomWidth: 1, borderBottomColor: `${c.text}10` }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>
                  {menuCourse?.title}
                </Text>
              </View>
              {/* Edit */}
              <Pressable onPress={handleEdit}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18,
                  borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
                <Pencil size={18} color={c.primary} />
                <Text style={{ fontSize: 15, fontWeight: '600', color: c.text }}>{t('drCourses.edit')}</Text>
              </Pressable>
              {/* Preview as Student — opens the student-facing course screen */}
              <Pressable onPress={handlePreviewAsStudent}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18,
                  borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
                <Eye size={18} color="#7C3AED" />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: c.text }}>{t('drCourses.previewAsStudent')}</Text>
                  <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5) }}>
                    {t('drCourses.previewHint')}
                  </Text>
                </View>
              </Pressable>
              {/* Delete */}
              <Pressable onPress={handleOpenDelete}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18 }}>
                <Trash2 size={18} color="#DC2626" />
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#DC2626' }}>{t('drCourses.delete')}</Text>
              </Pressable>
        </View>
        </View>
      </PortalOverlay>

      {/* ── Delete confirmation modal ───────────────────────────────────────────── */}
      {/* Fix: added statusBarTranslucent so scrim covers the Android status bar */}
      <PortalOverlay visible={!!deleteTarget} variant="dialog" backdropColor="rgba(0,0,0,0.45)" onRequestClose={() => { if (!deleteLoading) { setDeleteTarget(null); setDeleteStats(null); } }}>
          <View style={{ ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center',
            paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }}
            pointerEvents="box-none">
          <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} style={{ width: Math.min(screenW * 0.92, 480), maxHeight: '100%', flexGrow: 0, flexShrink: 1 }}>
          <View style={{ backgroundColor: c.base, borderRadius: 24,
            padding: 24, gap: 20,
            shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 20, elevation: 16 }}>

            {/* Warning header */}
            <View style={{ alignItems: 'center', gap: 10 }}>
              <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: '#DC262618',
                alignItems: 'center', justifyContent: 'center' }}>
                <AlertTriangle size={26} color="#DC2626" />
              </View>
              <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, textAlign: 'center' }}>
                {t('drCourses.deleteTitle')}
              </Text>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary, textAlign: 'center' }} numberOfLines={2}>
                {deleteStats?.title ?? deleteTarget?.title}
              </Text>
            </View>

            {/* Stats */}
            {statsLoading ? (
              <ActivityIndicator color={c.primary} />
            ) : deleteStats ? (
              <View style={{ backgroundColor: `${c.text}06`, borderRadius: 14, padding: 16, gap: 8 }}>
                {([
                  ['drCourses.fact.course',    deleteStats.title],
                  ['drCourses.fact.doctor',    deleteStats.doctor_name],
                  ['drCourses.fact.created',   deleteStats.created_at ? new Date(deleteStats.created_at).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'],
                  ['drCourses.fact.updated',   deleteStats.updated_at ? new Date(deleteStats.updated_at).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'],
                  ['drCourses.fact.students',  deleteStats.enrolled_count],
                  ['drCourses.fact.sections',  deleteStats.section_count],
                  ['drCourses.fact.lessons',   deleteStats.lesson_count],
                  ['drCourses.fact.videos',    deleteStats.video_count],
                  ['drCourses.fact.pdfs',      deleteStats.pdf_count],
                  ['drCourses.fact.attachments', deleteStats.attachment_count],
                ] as [string, string | number][]).map(([labelKey, value]) => (
                  <View key={labelKey} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.55) }}>{t(labelKey)}</Text>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: typeof value === 'number' && value > 0 ? '#DC2626' : c.text, flexShrink: 1, textAlign: 'right' }} numberOfLines={1}>
                      {value ?? '—'}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {/* Warning text */}
            <View style={{ backgroundColor: '#DC262610', borderRadius: 12, padding: 14, flexDirection: 'row', gap: 10 }}>
              <AlertTriangle size={15} color="#DC2626" style={{ marginTop: 1 }} />
              <Text style={{ flex: 1, fontSize: 12, lineHeight: 18, color: '#DC2626', fontWeight: '500' }}>
                {t('drCourses.deleteWarning')}
              </Text>
            </View>

            {/* Action buttons */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable onPress={() => { if (!deleteLoading) { setDeleteTarget(null); setDeleteStats(null); } }}
                disabled={deleteLoading}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 14, alignItems: 'center',
                  backgroundColor: `${c.text}0E` }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable onPress={handleConfirmDelete} disabled={deleteLoading || statsLoading}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 14, alignItems: 'center',
                  backgroundColor: deleteLoading ? '#DC262640' : '#DC2626', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
                {deleteLoading
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Trash2 size={15} color="#fff" />}
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                  {deleteLoading ? t('common.deleting') : t('common.delete')}
                </Text>
              </Pressable>
            </View>
          </View>
          </ScrollView>
          </View>
      </PortalOverlay>
    </>
  );
}

