import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, useColorScheme, Pressable, RefreshControl, TextInput, ActivityIndicator, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { Plus, BookOpen, Search, Archive, CheckCircle, Clock, GraduationCap, MoreVertical, Trash2, Pencil, AlertTriangle, FileText, Globe, Eye, LayoutGrid, Layers, X } from 'lucide-react-native';
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
import { filterCoursesByStatus } from '@/lib/courseStatus';
import type { RelativePathString } from 'expo-router';

const DIFFICULTY_COLORS: Record<string, string> = {
  beginner: '#16A34A', intermediate: '#D97706', advanced: '#DC2626', all_levels: '#2563EB',
};
const STATUS_COLORS: Record<string, string> = {
  published: '#16A34A', draft: '#D97706', hidden: '#6B7280', archived: '#9CA3AF',
};

/**
 * The approved compact course card (one row instead of the previous
 * thumbnail + description + meta + tags + CTA stack).
 *
 * Everything the old card showed is still here, just packed: thumbnail,
 * title (2 lines), status pill, lessons, sections, duration, difficulty and
 * the first two tags. The actions that used to live in a modal now expand
 * inline from the ⋮ button — same three actions (Edit, Preview as student,
 * Delete), one tap away, with nothing dropped.
 */
function DoctorCourseCard({
  course, c, layout, wide, onEdit, onPreview, onDelete,
}: {
  course: any;
  c: typeof neuColors.light;
  layout: ReturnType<typeof useLayout>;
  wide: boolean;
  onEdit: () => void;
  onPreview: () => void;
  onDelete: () => void;
}) {
  const { t, tCount, isRTL } = useTranslation();
  const [open, setOpen] = useState(false);
  const statusColor = STATUS_COLORS[course.status] ?? '#6B7280';
  const isArchived = !!course.archived_at;
  const image = course.image_url ?? course.cover_url ?? course.thumbnail_url;
  const lessons = course.total_lessons ?? 0;
  const sections = course.total_sections ?? 0;
  const hours = course.estimated_duration_hours;
  const tags: string[] = Array.isArray(course.tags) ? course.tags : [];

  const actions = [
    { key: 'edit', Icon: Pencil, label: t('drCourses.edit'), color: c.primary, onPress: onEdit },
    { key: 'preview', Icon: Eye, label: t('drCourses.previewAsStudent'), color: '#7C3AED', onPress: onPreview },
    { key: 'delete', Icon: Trash2, label: t('drCourses.delete'), color: '#DC2626', onPress: onDelete },
  ];

  return (
    <NeuCard
      style={{
        padding: layout.pad.sm + 2,
        opacity: isArchived ? 0.72 : 1,
        ...(isArchived ? { borderWidth: 1, borderColor: '#9CA3AF33' } : {}),
      }}
    >
      <View style={{ direction: 'ltr', flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'flex-start', gap: layout.pad.md }}>
        {/* Thumbnail — 56×56, falling back to a glyph instead of an empty box */}
        <Pressable
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel={course.title}
          style={{
            width: wide ? 64 : 56, height: wide ? 64 : 56, borderRadius: 12, overflow: 'hidden',
            backgroundColor: `${c.primary}14`, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}
        >
          {image ? (
            <Image source={{ uri: image }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
          ) : (
            <GraduationCap size={wide ? 26 : 22} color={c.primary} opacity={0.4} />
          )}
        </Pressable>

        {/* Identity + metadata */}
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ direction: 'ltr', flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'center', gap: 6 }}>
            <Pressable style={{ flex: 1, minWidth: 0 }} onPress={onEdit} accessibilityRole="button">
              <Text style={{ fontSize: 14.5, fontWeight: '700', color: c.text, textAlign: isRTL ? 'right' : 'left' }} numberOfLines={2}>
                {course.title}
              </Text>
            </Pressable>
            <View
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0,
                paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20,
                backgroundColor: `${statusColor}18`,
              }}
            >
              {course.status === 'published'
                ? <CheckCircle size={10} color={statusColor} />
                : isArchived ? <Archive size={10} color={statusColor} /> : null}
              <Text style={{ fontSize: 10, fontWeight: '800', color: statusColor }}>
                {courseStatusLabel(course.status, t)}
              </Text>
            </View>
            {isArchived && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0,
                paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20, backgroundColor: '#D9770618' }}>
                <Archive size={9} color="#D97706" />
                <Text style={{ fontSize: 10, fontWeight: '700', color: '#D97706' }}>{t('courseStatus.archived')}</Text>
              </View>
            )}
          </View>

          {/* One wrapped meta line: lessons · sections · duration · difficulty · tags */}
          <View style={{ direction: 'ltr', flexDirection: isRTL ? 'row-reverse' : 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, rowGap: 3, justifyContent: isRTL ? 'flex-end' : 'flex-start' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <BookOpen size={10} color={c.primary} />
              <Text style={{ fontSize: 10.5, ...mutedTextStyle(c, 0.6) }}>
                {tCount('drCourses.lessonCount', lessons)}
              </Text>
            </View>
            {sections > 0 && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Layers size={10} color={c.primary} opacity={0.75} />
                <Text style={{ fontSize: 10.5, ...mutedTextStyle(c, 0.6) }}>
                  {tCount('drCourses.sectionCount', sections)}
                </Text>
              </View>
            )}
            {hours ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Clock size={10} color={c.primary} opacity={0.75} />
                <Text style={{ fontSize: 10.5, ...mutedTextStyle(c, 0.6) }}>
                  {t('drCourses.duration', { hours })}
                </Text>
              </View>
            ) : null}
            {course.difficulty ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <View style={{ width: 6, height: 6, borderRadius: 3,
                  backgroundColor: DIFFICULTY_COLORS[course.difficulty] ?? c.primary }} />
                <Text style={{ fontSize: 10.5, ...mutedTextStyle(c, 0.5) }}>
                  {difficultyLabel(course.difficulty, t)}
                </Text>
              </View>
            ) : null}
            {tags.slice(0, 2).map((tag) => (
              <View key={tag} style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 20, backgroundColor: `${c.primary}12` }}>
                <Text style={{ fontSize: 9.5, fontWeight: '700', color: c.primary }}>{tag}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* ⋮ — expands the same actions the old modal offered */}
        <Pressable
          onPress={() => setOpen(v => !v)}
          accessibilityRole="button"
          accessibilityLabel={t('drCourses.optionsA11y', { title: course.title })}
          hitSlop={6}
          style={{
            width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
            backgroundColor: open ? `${c.primary}18` : 'transparent', flexShrink: 0,
          }}
        >
          {open ? <X size={16} color={c.primary} /> : <MoreVertical size={16} color={c.text} opacity={0.45} />}
        </Pressable>
      </View>

      {open && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: layout.pad.sm }}>
          {actions.map(action => (
            <Pressable
              key={action.key}
              onPress={() => { setOpen(false); action.onPress(); }}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 5,
                paddingHorizontal: 9, paddingVertical: 6, borderRadius: 9,
                backgroundColor: `${action.color}14`,
              }}
            >
              <action.Icon size={12} color={action.color} />
              <Text style={{ fontSize: 11, fontWeight: '700', color: action.color }}>{action.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </NeuCard>
  );
}

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

  // A response that lands after the screen unmounts must not call setState.
  const cancelledRef = useRef(false);
  useEffect(() => () => { cancelledRef.current = true; }, []);

  //  COURSE CREATION FEATURE FLAG — the server refuses course creation while the
  //  flag is off (403 feature_disabled) on every entry point (RPC, /courses,
  //  /api/courses, duplicate). The UI reflects that state so a doctor never
  //  meets a confusing "creation failed" error for a deliberate admin setting.
  const { isEnabled } = useFeatureFlags();
  const canCreate = isEnabled('course_creation');
  //  Set when the server refuses a create; shows the shared unavailable state.
  const [createBlocked, setCreateBlocked] = useState(false);

  // ── Delete confirmation ───────────────────────────────────────────────────────
  const [deleteTarget,  setDeleteTarget]  = useState<any>(null);
  const [deleteStats,   setDeleteStats]   = useState<any>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [statsLoading,  setStatsLoading]  = useState(false);

  const loadData = useCallback(async () => {
    if (!profile) return;
    try {
      // ONE fetch for every tab — archived excluded by the server by default.
      //
      // WHY NOT `status: statusFilter`: the tab is a pure client-side view of
      // the same doctor-scoped list. Asking the server for one status at a time
      // (a) re-introduced a network round-trip on every tab press, (b) left the
      // previously fetched rows on screen when a request was in flight or
      // failed, and (c) depended on `/courses` honouring `?status=`, which it
      // did not — so Drafts displayed published rows. The list is capped at 200
      // rows for a single doctor, so filtering locally is both cheaper and the
      // only representation the user can actually verify.
      const data = await getCoursesWithArchived({ doctorId: profile.id });
      if (cancelledRef.current) return;
      setCourses(data);
    } catch {}
    if (!cancelledRef.current) setLoading(false);
  }, [profile]);

  // Stale-while-revalidate: the course list stays on screen and refreshes in
  // the background on focus instead of collapsing to a full-screen spinner.
  // hasContent() keeps the spinner for a genuinely empty first load.
  useStaleWhileRevalidateFocus(loadData, {
    setLoading,
    hasContent: () => courses.length > 0,
  });
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  // Tab semantics applied to the rows we hold (normalization lives in
  // lib/courseStatus so drafts/published/archived can never drift again).
  const statusScoped = filterCoursesByStatus(courses, statusFilter);
  const filtered = statusScoped
    .filter(course =>
      !debouncedQuery || String(course.title ?? '').toLowerCase().includes(debouncedQuery.toLowerCase())
    )
    // All / Published-first, then most recently updated within a group.
    .sort((a: any, b: any) => {
      const sa = a.status === 'published' ? 0 : 1;
      const sb = b.status === 'published' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const ta = a.updated_at ?? a.created_at ?? '';
      const tb = b.updated_at ?? b.created_at ?? '';
      return String(tb).localeCompare(String(ta));
    });

  // Create a blank course and navigate into the builder
  const handleNewCourse = async () => {
    if (!profile) return;
    setCreating(true);
    try {
      const course = await createCourse({
        title: t('drCourses.newCourseDefault'),
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

  // Navigate to course builder (edit)
  const handleEdit = (course: any) => {
    router.push(`/(app)/course-builder/${course.id}` as RelativePathString);
  };

  // "Preview as Student" — see exactly what an enrolled student sees for this
  // course. Uses the student-facing course screen with student fetch semantics;
  // the doctor's role/JWT is untouched. Only one preview session at a time.
  const handlePreviewAsStudent = (course: any) => {
    stopPreviewAsStudent();
    startPreviewAsStudent(course.id);
    router.push(`/(app)/course/${course.id}` as RelativePathString);
  };

  // Open delete confirmation: fetch stats first
  const handleOpenDelete = async (target: any) => {
    if (!target) return;
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
          roleLabelPosition="below"
          rightActions={
            <>
              {canCreate ? (
                <Pressable onPress={handleNewCourse} disabled={creating}
                  style={{ backgroundColor: c.primary, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  {creating
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Plus size={18} color="#fff" />}
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>{t('common.new')}</Text>
                </Pressable>
              ) : null}
            </>
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
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
              {filtered.map(course => (
                <View key={course.id} style={{ width: screenW >= 700 ? '48.8%' : '100%', minWidth: 0 }}>
                  <DoctorCourseCard
                    course={course}
                    c={c}
                    layout={layout}
                    wide={screenW >= 700}
                    onEdit={() => handleEdit(course)}
                    onPreview={() => handlePreviewAsStudent(course)}
                    onDelete={() => handleOpenDelete(course)}
                  />
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

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

