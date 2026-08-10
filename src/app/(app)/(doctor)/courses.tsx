import { useCallback, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, Pressable, RefreshControl, TextInput, ActivityIndicator, Modal } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { Plus, BookOpen, Search, Archive, Clock, Users, ChevronRight, GraduationCap, MoreVertical, Trash2, Pencil, AlertTriangle } from 'lucide-react-native';
import { DashboardHeader } from '@/components/DashboardHeader';
import { useProfileStore } from '@/lib/store';
import { getCoursesWithArchived, createCourse, deleteCourseWithCleanup, getCourseDeleteStats } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { useDebounce } from '@/lib/useDebounce';
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
  const insets = layout.insets;
  const { profile } = useProfileStore();
  const router = useRouter();

  const [courses, setCourses] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 300);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const { showToast } = useToast();

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
      const data = await getCoursesWithArchived({ doctorId: profile.id, includeArchived });
      setCourses(data);
    } catch {}
    setLoading(false);
  }, [profile, includeArchived]);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
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
      // Surface the real DB/RPC error so issues are immediately visible
      const msg = e?.message ?? e?.error_description ?? String(e);
      const code = e?.code ? ` [${e.code}]` : '';
      console.error('[courses] createCourse failed:', e);
      showToast({ type: 'error', message: `Course creation failed${code}: ${msg}` });
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
      setDeleteStats({ title: target.title, enrolled_count: '?', lesson_count: '?', video_count: '?', attachment_count: '?', code_count: '?' });
    }
    setStatsLoading(false);
  };

  // Execute deletion
  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const result = await deleteCourseWithCleanup(deleteTarget.id);
      showToast({ type: 'success', message: `"${deleteTarget.title}" deleted. ${result.students_removed} student${result.students_removed !== 1 ? 's' : ''} removed.` });
      setDeleteTarget(null);
      setDeleteStats(null);
      await loadData();
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to delete course.' });
    }
    setDeleteLoading(false);
  };

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: c.base }}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {/* Header — uses DashboardHeader for consistent safe-area + hamburger alignment */}
        <DashboardHeader
          greeting="My Courses"
          roleLabel={`${courses.length} course${courses.length !== 1 ? 's' : ''}`}
          rightActions={
            <Pressable onPress={handleNewCourse} disabled={creating}
              style={{ backgroundColor: c.primary, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {creating
              ? <ActivityIndicator size="small" color="#fff" />
              : <Plus size={18} color="#fff" />}
              <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>New</Text>
            </Pressable>
          }
        />

        {/* Search + Archive toggle */}
        <View style={{ paddingHorizontal: layout.screenPx, marginBottom: 16, gap: 10 }}>
          <View style={[{ borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10, minWidth: 0 },
            { backgroundColor: c.base, shadowColor: c.shadowDark, shadowOffset: { width: 3, height: 3 }, shadowOpacity: 0.6, shadowRadius: 8, elevation: 3 }]}>
            <Search size={16} color={c.text} opacity={0.4} style={{ flexShrink: 0 }} />
            <TextInput value={query} onChangeText={setQuery} placeholder="Search courses…"
              placeholderTextColor={`${c.text}55`}
              style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text, paddingVertical: 12 }} />
          </View>
          <Pressable onPress={() => setIncludeArchived(v => !v)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
              paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10,
              backgroundColor: includeArchived ? '#D9770618' : `${c.text}08` }}>
            <Archive size={13} color={includeArchived ? '#D97706' : c.text} opacity={includeArchived ? 1 : 0.4} />
            <Text style={{ fontSize: 12, fontWeight: '700', color: includeArchived ? '#D97706' : c.text, opacity: includeArchived ? 1 : 0.45 }}>
              Include Archived
            </Text>
          </Pressable>
        </View>

        {/* Course list */}
        <View style={{ paddingHorizontal: layout.screenPx, gap: 14, paddingBottom: layout.scrollBottom() }}>
          {loading ? (
            <View style={{ paddingVertical: 60, alignItems: 'center' }}>
              <ActivityIndicator color={c.primary} />
            </View>
          ) : filtered.length === 0 ? (
            <View style={{ paddingVertical: 60, alignItems: 'center', gap: 12 }}>
              <BookOpen size={48} color={c.primary} opacity={0.2} />
              <Text style={{ fontSize: 16, color: c.text, opacity: 0.4 }}>
                {query ? 'No matching courses' : 'No courses yet'}
              </Text>
              {!query && (
                <NeuButton label="Create First Course" onPress={handleNewCourse} loading={creating} />
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
                          <Text style={{ fontSize: 11, fontWeight: '700', color: STATUS_COLORS[course.status] ?? '#6B7280', textTransform: 'capitalize' }}>
                            {course.status}
                          </Text>
                        </View>
                        {/* ⋮ options menu */}
                        <Pressable onPress={() => openMenu(course)}
                          style={{ padding: 4, borderRadius: 8, backgroundColor: `${c.text}08` }}>
                          <MoreVertical size={16} color={c.text} opacity={0.5} />
                        </Pressable>
                      </View>
                      {course.archived_at && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4,
                          paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: '#D9770618' }}>
                          <Archive size={9} color="#D97706" />
                          <Text style={{ fontSize: 10, fontWeight: '700', color: '#D97706' }}>Archived</Text>
                        </View>
                      )}
                    </View>
                  </View>

                  {/* Short description */}
                  {course.short_description ? (
                    <Text style={{ fontSize: 13, color: c.text, opacity: 0.55, lineHeight: 18 }} numberOfLines={2}>
                      {course.short_description}
                    </Text>
                  ) : null}

                  {/* Meta row */}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                    {course.difficulty && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <View style={{ width: 8, height: 8, borderRadius: 4,
                          backgroundColor: DIFFICULTY_COLORS[course.difficulty] ?? c.primary }} />
                        <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, textTransform: 'capitalize' }}>
                          {course.difficulty.replace('_', ' ')}
                        </Text>
                      </View>
                    )}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <BookOpen size={12} color={c.primary} />
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.55 }}>
                        {course.total_lessons ?? 0} lessons
                      </Text>
                    </View>
                    {course.total_sections > 0 && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Users size={12} color={c.primary} />
                        <Text style={{ fontSize: 12, color: c.text, opacity: 0.55 }}>
                          {course.total_sections} sections
                        </Text>
                      </View>
                    )}
                    {course.estimated_duration_hours && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Clock size={12} color={c.primary} />
                        <Text style={{ fontSize: 12, color: c.text, opacity: 0.55 }}>
                          {course.estimated_duration_hours}h
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
                    <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary, marginRight: 4 }}>Edit Course</Text>
                    <ChevronRight size={14} color={c.primary} />
                  </Pressable>
                </View>
              </NeuCard>
            ))
          )}
        </View>
      </ScrollView>

      {/* ── Options menu modal ──────────────────────────────────────────────────── */}
      <Modal visible={menuVisible} transparent animationType="fade" onRequestClose={closeMenu}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={closeMenu}>
          <View style={{ position: 'absolute', bottom: 32, left: 20, right: 20,
            backgroundColor: c.base, borderRadius: 20, overflow: 'hidden',
            shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 24, elevation: 12 }}>
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
              <Text style={{ fontSize: 15, fontWeight: '600', color: c.text }}>Edit Course</Text>
            </Pressable>
            {/* Delete */}
            <Pressable onPress={handleOpenDelete}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18 }}>
              <Trash2 size={18} color="#DC2626" />
              <Text style={{ fontSize: 15, fontWeight: '600', color: '#DC2626' }}>Delete Course</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* ── Delete confirmation modal ───────────────────────────────────────────── */}
      <Modal visible={!!deleteTarget} transparent animationType="slide" onRequestClose={() => { if (!deleteLoading) { setDeleteTarget(null); setDeleteStats(null); } }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: c.base, borderTopLeftRadius: 24, borderTopRightRadius: 24,
            padding: 24, paddingBottom: layout.scrollBottom(), gap: 20,
            shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.15, shadowRadius: 20, elevation: 16 }}>

            {/* Warning header */}
            <View style={{ alignItems: 'center', gap: 10 }}>
              <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: '#DC262618',
                alignItems: 'center', justifyContent: 'center' }}>
                <AlertTriangle size={26} color="#DC2626" />
              </View>
              <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, textAlign: 'center' }}>
                Delete Course?
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
                  ['Course',           deleteStats.title],
                  ['Doctor',           deleteStats.doctor_name],
                  ['Created',          deleteStats.created_at ? new Date(deleteStats.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'],
                  ['Last updated',     deleteStats.updated_at ? new Date(deleteStats.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'],
                  ['Students enrolled',deleteStats.enrolled_count],
                  ['Sections',         deleteStats.section_count],
                  ['Lessons',          deleteStats.lesson_count],
                  ['Videos',           deleteStats.video_count],
                  ['PDFs',             deleteStats.pdf_count],
                  ['Attachments',      deleteStats.attachment_count],
                  ['Activation codes', deleteStats.code_count],
                ] as [string, string | number][]).map(([label, value]) => (
                  <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <Text style={{ fontSize: 13, color: c.text, opacity: 0.55 }}>{label}</Text>
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
                This action permanently deletes this course and all associated lessons, videos, attachments, activation codes and subscriptions. This cannot be undone.
              </Text>
            </View>

            {/* Action buttons */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable onPress={() => { if (!deleteLoading) { setDeleteTarget(null); setDeleteStats(null); } }}
                disabled={deleteLoading}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 14, alignItems: 'center',
                  backgroundColor: `${c.text}0E` }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>Cancel</Text>
              </Pressable>
              <Pressable onPress={handleConfirmDelete} disabled={deleteLoading || statsLoading}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 14, alignItems: 'center',
                  backgroundColor: deleteLoading ? '#DC262640' : '#DC2626', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
                {deleteLoading
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Trash2 size={15} color="#fff" />}
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                  {deleteLoading ? 'Deleting…' : 'Delete'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

