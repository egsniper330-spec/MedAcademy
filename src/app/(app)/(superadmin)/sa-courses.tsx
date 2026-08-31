/**
 * sa-courses.tsx — Super Admin Courses Management
 *
 * Full platform-wide course overview for the Super Admin:
 *   • View all courses across all doctors
 *   • Search by title / doctor name
 *   • Filter by status (All · Published · Draft · Hidden · Archived)
 *   • Publish / Unpublish any course
 *   • Delete course with full cleanup (cascade + storage)
 *   • Open Course Builder for any course
 *   • View enrolled students count inline
 *   • Pull-to-refresh
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  TextInput, ActivityIndicator, RefreshControl, FlatList,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  BookOpen, Search, X, ChevronRight, Eye, EyeOff,
  Trash2, Filter, CheckCircle, AlertCircle, Users, GraduationCap,
  Globe, Archive,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors, neuFlatStyle, useLayout, zIndex } from '@/lib/neu'
import { useDebounce } from '@/lib/useDebounce';
import {
  getCoursesWithArchived,
  publishCourse,
  unpublishCourse,
  deleteCourseWithCleanup,
  getCourseDeleteStats,
} from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'published' | 'draft' | 'hidden' | 'archived';

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all',       label: 'All'       },
  { key: 'published', label: 'Published' },
  { key: 'draft',     label: 'Draft'     },
  { key: 'hidden',    label: 'Hidden'    },
  { key: 'archived',  label: 'Archived'  },
];

const STATUS_COLOR: Record<string, string> = {
  published: '#16A34A',
  draft:     '#D97706',
  hidden:    '#6B7280',
  archived:  '#9CA3AF',
};

const STATUS_ICON: Record<string, React.ElementType> = {
  published: Globe,
  draft:     BookOpen,
  hidden:    EyeOff,
  archived:  Archive,
};

// ─── Course Card ──────────────────────────────────────────────────────────────

function CourseCard({
  course,
  c,
  isDark,
  onPublish,
  onUnpublish,
  onDelete,
  onOpen,
}: {
  course: any;
  c: typeof neuColors.light;
  isDark: boolean;
  onPublish: (id: string) => void;
  onUnpublish: (id: string) => void;
  onDelete: (course: any) => void;
  onOpen: (id: string) => void;
}) {
  const status: string = course.archived_at ? 'archived' : (course.status ?? 'draft');
  const StatusIcon = STATUS_ICON[status] ?? BookOpen;
  const statusColor = STATUS_COLOR[status] ?? '#6B7280';
  const isPublished = status === 'published';
  const isArchived = status === 'archived';

  return (
    <NeuCard style={{ marginBottom: 12 }}>
      <Pressable onPress={() => onOpen(course.id)} style={{ padding: 16 }}>
        {/* Header row */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          {/* Status icon badge */}
          <View style={{
            width: 44, height: 44, borderRadius: 14,
            backgroundColor: `${statusColor}18`,
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <StatusIcon size={20} color={statusColor} />
          </View>

          {/* Title + doctor */}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 2 }}
              numberOfLines={2}
            >
              {course.title}
            </Text>
            <Text style={{ fontSize: 12, color: `${c.text}66` }} numberOfLines={1}>
              {course.doctor?.full_name ?? 'Unknown Instructor'}
            </Text>
          </View>

          {/* Status pill */}
          <View style={{
            backgroundColor: `${statusColor}18`,
            borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3,
            alignSelf: 'flex-start',
          }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: statusColor, textTransform: 'uppercase' }}>
              {status}
            </Text>
          </View>
        </View>

        {/* Stats row */}
        <View style={{ flexDirection: 'row', gap: 16, marginTop: 12, marginLeft: 56 }}>
          {course.category?.name && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <GraduationCap size={13} color={`${c.text}55`} />
              <Text style={{ fontSize: 12, color: `${c.text}55` }}>{course.category.name}</Text>
            </View>
          )}
          {typeof course.price_egp === 'number' && (
            <Text style={{ fontSize: 12, color: c.primary, fontWeight: '600' }}>
              {course.price_egp === 0 ? 'Free' : `${course.price_egp} EGP`}
            </Text>
          )}
        </View>

        {/* Actions row */}
        {!isArchived && (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            {isPublished ? (
              <Pressable
                onPress={() => onUnpublish(course.id)}
                style={[
                  neuFlatStyle(isDark),
                  { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 12, paddingVertical: 9, gap: 6 },
                ]}
              >
                <EyeOff size={15} color={`${c.text}88`} />
                <Text style={{ fontSize: 13, fontWeight: '600', color: `${c.text}88` }}>Unpublish</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => onPublish(course.id)}
                style={{
                  flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  borderRadius: 12, paddingVertical: 9, gap: 6,
                  backgroundColor: `${STATUS_COLOR.published}18`,
                }}
              >
                <Eye size={15} color={STATUS_COLOR.published} />
                <Text style={{ fontSize: 13, fontWeight: '600', color: STATUS_COLOR.published }}>Publish</Text>
              </Pressable>
            )}

            <Pressable
              onPress={() => onDelete(course)}
              style={[
                neuFlatStyle(isDark),
                { width: 40, alignItems: 'center', justifyContent: 'center',
                  borderRadius: 12, paddingVertical: 9 },
              ]}
            >
              <Trash2 size={16} color="#DC2626" />
            </Pressable>

            <Pressable
              onPress={() => onOpen(course.id)}
              style={[
                neuFlatStyle(isDark),
                { width: 40, alignItems: 'center', justifyContent: 'center',
                  borderRadius: 12, paddingVertical: 9 },
              ]}
            >
              <ChevronRight size={16} color={c.primary} />
            </Pressable>
          </View>
        )}
      </Pressable>
    </NeuCard>
  );
}

// ─── Delete Confirmation Modal ────────────────────────────────────────────────

function DeleteModal({
  course,
  stats,
  statsLoading,
  deleting,
  onConfirm,
  onCancel,
  c,
  isDark,
}: {
  course: any;
  stats: any;
  statsLoading: boolean;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  c: typeof neuColors.light;
  isDark: boolean;
}) {
  return (
    <View style={{
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.45)',
      alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: zIndex.modal,
    }}>
      <NeuCard style={{ width: '100%', maxWidth: 420, padding: 24 }}>
        <View style={{ alignItems: 'center', marginBottom: 16 }}>
          <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: '#DC262618',
            alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
            <AlertCircle size={28} color="#DC2626" />
          </View>
          <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, textAlign: 'center' }}>
            Delete Course?
          </Text>
          <Text style={{ fontSize: 13, color: `${c.text}66`, textAlign: 'center', marginTop: 4 }} numberOfLines={2}>
            {course?.title}
          </Text>
        </View>

        {statsLoading ? (
          <ActivityIndicator color={c.primary} style={{ marginVertical: 12 }} />
        ) : stats ? (
          <View style={{ backgroundColor: `${c.shadowDark}08`, borderRadius: 14, padding: 14, marginBottom: 16, gap: 6 }}>
            {[
              ['Enrolled Students', stats.enrolled_count],
              ['Sections',          stats.section_count],
              ['Lessons',           stats.lesson_count],
              ['Videos',            stats.video_count],
              ['Attachments',       stats.attachment_count],
              ['Activation Codes',  stats.code_count],
            ].map(([label, val]) => (
              <View key={label as string} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 13, color: `${c.text}77` }}>{label}</Text>
                <Text style={{ fontSize: 13, fontWeight: '700',
                  color: (val as number) > 0 ? '#DC2626' : `${c.text}55` }}>
                  {val as number}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <Text style={{ fontSize: 12, color: '#DC262699', textAlign: 'center', marginBottom: 20 }}>
          This action is permanent and cannot be undone.
        </Text>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pressable
            onPress={onCancel}
            style={[neuFlatStyle(isDark), { flex: 1, alignItems: 'center', borderRadius: 14, paddingVertical: 13 }]}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', color: `${c.text}88` }}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={onConfirm}
            disabled={deleting}
            style={{
              flex: 1, alignItems: 'center', justifyContent: 'center',
              borderRadius: 14, paddingVertical: 13,
              backgroundColor: '#DC2626',
              opacity: deleting ? 0.6 : 1,
            }}
          >
            {deleting
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>Delete</Text>
            }
          </Pressable>
        </View>
      </NeuCard>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function SACourses() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const router = useRouter();
  const { showToast } = useToast();

  // ── Data ──────────────────────────────────────────────────────────────────
  const [courses, setCourses]     = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // ── Filters ───────────────────────────────────────────────────────────────
  const [query, setQuery]               = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const debouncedQuery                  = useDebounce(query, 300);

  // ── Action states ─────────────────────────────────────────────────────────
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  // ── Delete flow ───────────────────────────────────────────────────────────
  const [deleteTarget,  setDeleteTarget]  = useState<any>(null);
  const [deleteStats,   setDeleteStats]   = useState<any>(null);
  const [statsLoading,  setStatsLoading]  = useState(false);
  const [deleting,      setDeleting]      = useState(false);

  // ── Load ──────────────────────────────────────────────────────────────────
  const loadCourses = useCallback(async () => {
    try {
      const data = await getCoursesWithArchived({ includeArchived: true });
      setCourses(data);
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to load courses' });
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    loadCourses();
  }, [loadCourses]));

  const onRefresh = async () => {
    setRefreshing(true);
    await loadCourses();
    setRefreshing(false);
  };

  // ── Filtered list ─────────────────────────────────────────────────────────
  const filtered = courses.filter(course => {
    const status: string = course.archived_at ? 'archived' : (course.status ?? 'draft');

    if (statusFilter !== 'all' && status !== statusFilter) return false;

    if (debouncedQuery.trim()) {
      const q = debouncedQuery.toLowerCase();
      const titleMatch  = course.title?.toLowerCase().includes(q);
      const doctorMatch = course.doctor?.full_name?.toLowerCase().includes(q);
      if (!titleMatch && !doctorMatch) return false;
    }

    return true;
  });

  // ── Publish ───────────────────────────────────────────────────────────────
  const handlePublish = async (courseId: string) => {
    setActionLoading(prev => ({ ...prev, [courseId]: true }));
    try {
      await publishCourse(courseId);
      setCourses(prev => prev.map(c => c.id === courseId ? { ...c, status: 'published' } : c));
      showToast({ type: 'success', message: 'Course published.' });
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to publish course.' });
    } finally {
      setActionLoading(prev => ({ ...prev, [courseId]: false }));
    }
  };

  // ── Unpublish ─────────────────────────────────────────────────────────────
  const handleUnpublish = async (courseId: string) => {
    setActionLoading(prev => ({ ...prev, [courseId]: true }));
    try {
      await unpublishCourse(courseId);
      setCourses(prev => prev.map(c => c.id === courseId ? { ...c, status: 'draft' } : c));
      showToast({ type: 'success', message: 'Course unpublished.' });
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to unpublish course.' });
    } finally {
      setActionLoading(prev => ({ ...prev, [courseId]: false }));
    }
  };

  // ── Delete flow ───────────────────────────────────────────────────────────
  const handleDeletePress = async (course: any) => {
    setDeleteTarget(course);
    setDeleteStats(null);
    setStatsLoading(true);
    try {
      const stats = await getCourseDeleteStats(course.id);
      setDeleteStats(stats);
    } catch {
      setDeleteStats(null);
    } finally {
      setStatsLoading(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteCourseWithCleanup(deleteTarget.id);
      setCourses(prev => prev.filter(c => c.id !== deleteTarget.id));
      showToast({ type: 'success', message: 'Course deleted.' });
      setDeleteTarget(null);
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to delete course.' });
    } finally {
      setDeleting(false);
    }
  };

  // ── Open course builder ───────────────────────────────────────────────────
  const handleOpen = (courseId: string) => {
    router.push(`/(app)/course-builder/${courseId}` as RelativePathString);
  };

  // ── Status counts ─────────────────────────────────────────────────────────
  const counts = courses.reduce<Record<StatusFilter, number>>(
    (acc, course) => {
      const st: string = course.archived_at ? 'archived' : (course.status ?? 'draft');
      acc.all++;
      if (st in acc) (acc as any)[st]++;
      return acc;
    },
    { all: 0, published: 0, draft: 0, hidden: 0, archived: 0 },
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        style={{ flex: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      >
          {/* PageHeader sits OUTSIDE the inner padding view so it can own its own horizontal padding */}
          <PageHeader
            title="Courses"
            subtitle={`${counts.all} total · ${counts.published} published`}
            accentColor={c.primary}
          />

        <View style={{ paddingHorizontal: layout.screenPx }}>

          {/* ── Search bar ──────────────────────────────────────────────── */}
          <View style={[
            neuFlatStyle(isDark),
            { flexDirection: 'row', alignItems: 'center', borderRadius: 16,
              paddingHorizontal: 14, paddingVertical: 12, marginBottom: 16, gap: 10, minWidth: 0 },
          ]}>
            <Search size={17} color={`${c.text}55`} style={{ flexShrink: 0 }} />
            <TextInput
              style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }}
              placeholder="Search by title or instructor…"
              placeholderTextColor={`${c.text}44`}
              value={query}
              onChangeText={setQuery}
              returnKeyType="search"
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')} style={{ flexShrink: 0 }}>
                <X size={16} color={`${c.text}55`} />
              </Pressable>
            )}
          </View>

          {/* ── Status filter tabs ───────────────────────────────────────── */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginBottom: 20 }}
            contentContainerStyle={{ gap: 8, paddingRight: 4 }}
          >
            {STATUS_FILTERS.map(({ key, label }) => {
              const active = statusFilter === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => setStatusFilter(key)}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 6,
                    paddingHorizontal: 14, paddingVertical: 8,
                    borderRadius: 12,
                    backgroundColor: active ? `${c.primary}18` : c.base,
                    shadowColor: active ? c.primary : c.shadowDark,
                    shadowOffset: { width: active ? 0 : 2, height: active ? 0 : 2 },
                    shadowOpacity: active ? 0 : 0.35,
                    shadowRadius: active ? 0 : 4,
                  }}
                >
                  <Filter size={12} color={active ? c.primary : `${c.text}66`} />
                  <Text style={{ fontSize: 13, fontWeight: active ? '700' : '500',
                    color: active ? c.primary : `${c.text}77` }}>
                    {label}
                  </Text>
                  <View style={{
                    backgroundColor: active ? c.primary : `${c.text}18`,
                    borderRadius: 6, minWidth: 20, paddingHorizontal: 5, paddingVertical: 1,
                    alignItems: 'center',
                  }}>
                    <Text style={{ fontSize: 10, fontWeight: '700',
                      color: active ? '#fff' : `${c.text}88` }}>
                      {counts[key]}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          {/* ── Course list ─────────────────────────────────────────────── */}
          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginVertical: 40 }} />
          ) : filtered.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 60, gap: 12 }}>
              <View style={{ width: 64, height: 64, borderRadius: 22, backgroundColor: `${c.primary}12`,
                alignItems: 'center', justifyContent: 'center' }}>
                <BookOpen size={30} color={`${c.primary}88`} />
              </View>
              <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>
                {query || statusFilter !== 'all' ? 'No matching courses' : 'No courses yet'}
              </Text>
              <Text style={{ fontSize: 13, color: `${c.text}55`, textAlign: 'center', maxWidth: 260 }}>
                {query || statusFilter !== 'all'
                  ? 'Try adjusting the search or filter.'
                  : 'Courses created by instructors will appear here.'}
              </Text>
            </View>
          ) : (
            <>
              <Text style={{ fontSize: 12, color: `${c.text}55`, marginBottom: 12,
                textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: '600' }}>
                {filtered.length} Course{filtered.length !== 1 ? 's' : ''}
              </Text>
              {filtered.map(course => (
                <CourseCard
                  key={course.id}
                  course={course}
                  c={c}
                  isDark={isDark}
                  onPublish={handlePublish}
                  onUnpublish={handleUnpublish}
                  onDelete={handleDeletePress}
                  onOpen={handleOpen}
                />
              ))}
            </>
          )}
        </View>
      </ScrollView>

      {/* ── Delete confirmation overlay ──────────────────────────────────── */}
      {deleteTarget && (
        <DeleteModal
          course={deleteTarget}
          stats={deleteStats}
          statsLoading={statsLoading}
          deleting={deleting}
          onConfirm={handleDeleteConfirm}
          onCancel={() => { setDeleteTarget(null); setDeleteStats(null); }}
          c={c}
          isDark={isDark}
        />
      )}
    </View>
  );
}
