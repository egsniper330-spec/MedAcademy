/**
 * Archived Courses — Doctor / Admin / Super Admin
 * Lists all archived courses with restore + permanent-delete actions.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  TextInput, useColorScheme, RefreshControl, Modal,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Archive, BookOpen, Clock, RefreshCw, Search,
  Trash2, Users, RotateCcw, AlertTriangle,
} from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import {
  getArchivedCourses, restoreCourse, permanentlyDeleteCourse,
  type ArchivedCourse,
} from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, neuFlatStyle, neuPressedStyle, safeBottom } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';

export default function ArchivedCoursesScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const { profile } = useProfileStore();
  const { showToast } = useToast();

  const [courses, setCourses] = useState<ArchivedCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');

  // Restore state
  const [restoring, setRestoring] = useState<string | null>(null);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState<ArchivedCourse | null>(null);

  // Delete state (Super Admin only)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<ArchivedCourse | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const isSuperAdmin = profile?.role === 'super_admin';
  const canAccess = ['doctor', 'admin', 'super_admin'].includes(profile?.role ?? '');

  const loadData = useCallback(async () => {
    if (!profile || !canAccess) return;
    try {
      const data = await getArchivedCourses(profile.id, profile.role);
      setCourses(data);
    } catch (_) {}
    setLoading(false);
  }, [profile, canAccess]);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    loadData();
  }, [loadData]));

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const handleRestore = async (course: ArchivedCourse) => {
    if (!profile) return;
    setRestoring(course.id);
    try {
      await restoreCourse(course.id, profile.id, profile.role);
      setCourses(prev => prev.filter(c => c.id !== course.id));
      showToast({ type: 'success', message: `"${course.title}" restored to catalog.` });
    } catch (e) {
      showToast({ type: 'error', message: 'Restore failed. Please try again.' });
    }
    setRestoring(null);
    setShowRestoreConfirm(null);
  };

  const handlePermanentDelete = async (course: ArchivedCourse) => {
    if (!profile || !isSuperAdmin) return;
    setDeleting(course.id);
    try {
      await permanentlyDeleteCourse(course.id, profile.id);
      setCourses(prev => prev.filter(c => c.id !== course.id));
      showToast({ type: 'success', message: `"${course.title}" permanently deleted.` });
    } catch (e) {
      showToast({ type: 'error', message: 'Delete failed. Please try again.' });
    }
    setDeleting(null);
    setShowDeleteConfirm(null);
  };

  const filtered = courses.filter(course =>
    !query || course.title.toLowerCase().includes(query.toLowerCase()) ||
    (course.doctor_name ?? '').toLowerCase().includes(query.toLowerCase())
  );

  if (!canAccess) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.base }}>
        <Text style={{ color: c.text, opacity: 0.4 }}>Access denied</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>

        {/* Header */}
        <View style={{ paddingTop: 0, paddingHorizontal: 20, paddingBottom: 8 }}>
          <PageHeader
            title="Archived Courses"
            subtitle={`${courses.length} archived · visible only to staff`}
            showBack
          />
        </View>

        {/* Info banner */}
        <View style={{ marginHorizontal: 20, marginBottom: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 10,
          paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: '#D9770610',
          borderWidth: 1, borderColor: '#D9770625' }}>
          <Archive size={14} color="#D97706" style={{ marginTop: 1 }} />
          <Text style={{ flex: 1, fontSize: 12, color: '#D97706', lineHeight: 18 }}>
            Archived courses are hidden from public catalog and new subscriptions.
            Enrolled students retain full access to all content and progress.
          </Text>
        </View>

        {/* Search */}
        <View style={{ paddingHorizontal: 20, marginBottom: 16 }}>
          <View style={[neuPressedStyle(isDark), { borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 }]}>
            <Search size={15} color={c.text} opacity={0.4} />
            <TextInput
              value={query} onChangeText={setQuery}
              placeholder="Search archived courses…"
              placeholderTextColor={`${c.text}55`}
              style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 11 }}
            />
          </View>
        </View>

        <View style={{ paddingHorizontal: 20, gap: 14, paddingBottom: layout.scrollBottom() }}>
          {loading ? (
            <View style={{ paddingVertical: 60, alignItems: 'center' }}>
              <ActivityIndicator color={c.primary} />
            </View>
          ) : filtered.length === 0 ? (
            <View style={{ paddingVertical: 60, alignItems: 'center', gap: 12 }}>
              <Archive size={52} color={c.primary} opacity={0.15} />
              <Text style={{ fontSize: 16, color: c.text, opacity: 0.4 }}>
                {query ? 'No matching archived courses' : 'No archived courses'}
              </Text>
            </View>
          ) : (
            filtered.map(course => (
              <NeuCard key={course.id} style={{ gap: 12 }}>
                {/* Title row */}
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <View style={{ width: 40, height: 40, borderRadius: 12,
                    backgroundColor: '#D9770618', alignItems: 'center', justifyContent: 'center' }}>
                    <Archive size={18} color="#D97706" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }} numberOfLines={2}>
                      {course.title}
                    </Text>
                    {course.doctor_name && (
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>
                        Dr. {course.doctor_name}
                      </Text>
                    )}
                  </View>
                </View>

                {/* Meta grid */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                  <MetaItem icon={Clock} label={`Archived ${new Date(course.archived_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`} c={c} />
                  {course.archived_by_name && (
                    <MetaItem icon={Archive} label={`By ${course.archived_by_name}`} c={c} />
                  )}
                  <MetaItem icon={Users} label={`${course.students_count} student${course.students_count !== 1 ? 's' : ''}`} c={c} />
                  <MetaItem icon={BookOpen} label={`${course.lessons_count} lesson${course.lessons_count !== 1 ? 's' : ''}`} c={c} />
                </View>

                {/* Reason */}
                {course.archive_reason ? (
                  <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: `${c.text}06` }}>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, fontStyle: 'italic' }}>
                      {`"${course.archive_reason}"`}
                    </Text>
                  </View>
                ) : null}

                {/* Actions */}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 2 }}>
                  <Pressable
                    onPress={() => setShowRestoreConfirm(course)}
                    disabled={restoring === course.id}
                    style={[neuFlatStyle(isDark), {
                      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                      paddingVertical: 10, borderRadius: 12, gap: 6,
                    }]}>
                    {restoring === course.id
                      ? <ActivityIndicator size="small" color="#16A34A" />
                      : <RotateCcw size={14} color="#16A34A" />}
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>Restore</Text>
                  </Pressable>

                  {isSuperAdmin && (
                    <Pressable
                      onPress={() => setShowDeleteConfirm(course)}
                      disabled={deleting === course.id}
                      style={[neuFlatStyle(isDark), {
                        flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                        paddingVertical: 10, borderRadius: 12, gap: 6,
                      }]}>
                      {deleting === course.id
                        ? <ActivityIndicator size="small" color="#DC2626" />
                        : <Trash2 size={14} color="#DC2626" />}
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Delete Forever</Text>
                    </Pressable>
                  )}
                </View>
              </NeuCard>
            ))
          )}
        </View>
      </ScrollView>

      {/* ── Restore Confirmation ── */}
      <Modal visible={!!showRestoreConfirm} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <NeuCard style={{ width: '100%', maxWidth: 400 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}>
                <RotateCcw size={20} color="#16A34A" />
              </View>
              <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, flex: 1 }}>Restore Course</Text>
            </View>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.55, lineHeight: 20, marginBottom: 6 }}>
              <Text style={{ fontWeight: '700', color: c.text }}>{showRestoreConfirm?.title}</Text>
              {'\n\n'}The course will immediately return to the public catalog, search results, and new subscriptions. All lessons, videos, student progress, analytics, and activation codes are preserved.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <Pressable onPress={() => setShowRestoreConfirm(null)}
                style={[neuFlatStyle(isDark), { flex: 1, padding: 12, borderRadius: 12, alignItems: 'center' }]}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, opacity: 0.5 }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => showRestoreConfirm && handleRestore(showRestoreConfirm)}
                style={{ flex: 1, padding: 12, borderRadius: 12, alignItems: 'center', backgroundColor: '#16A34A' }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>Restore</Text>
              </Pressable>
            </View>
          </NeuCard>
        </View>
      </Modal>

      {/* ── Permanent Delete Confirmation (Super Admin only) ── */}
      <Modal visible={!!showDeleteConfirm} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <NeuCard style={{ width: '100%', maxWidth: 420 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                <AlertTriangle size={22} color="#DC2626" />
              </View>
              <Text style={{ fontSize: 17, fontWeight: '800', color: '#DC2626', flex: 1 }}>Permanent Delete</Text>
            </View>

            {showDeleteConfirm && (
              <View style={{ gap: 8, marginBottom: 16 }}>
                <View style={{ padding: 14, borderRadius: 12, backgroundColor: `${c.text}06`, gap: 6 }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>{showDeleteConfirm.title}</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Dr. {showDeleteConfirm.doctor_name}</Text>
                  <View style={{ flexDirection: 'row', gap: 16, marginTop: 4 }}>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.55 }}>
                      👥 {showDeleteConfirm.students_count} students
                    </Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.55 }}>
                      📖 {showDeleteConfirm.lessons_count} lessons
                    </Text>
                  </View>
                </View>

                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12,
                  borderRadius: 12, backgroundColor: '#DC262610', borderWidth: 1, borderColor: '#DC262625' }}>
                  <AlertTriangle size={14} color="#DC2626" style={{ marginTop: 1 }} />
                  <Text style={{ flex: 1, fontSize: 12, color: '#DC2626', lineHeight: 18, fontWeight: '600' }}>
                    This action is irreversible. All lessons, videos, student progress, analytics, activation codes, and history will be permanently destroyed and cannot be recovered.
                  </Text>
                </View>
              </View>
            )}

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable onPress={() => setShowDeleteConfirm(null)}
                style={[neuFlatStyle(isDark), { flex: 1, padding: 12, borderRadius: 12, alignItems: 'center' }]}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, opacity: 0.55 }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => showDeleteConfirm && handlePermanentDelete(showDeleteConfirm)}
                style={{ flex: 1.2, padding: 12, borderRadius: 12, alignItems: 'center', backgroundColor: '#DC2626' }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: '#fff' }}>Delete Forever</Text>
              </Pressable>
            </View>
          </NeuCard>
        </View>
      </Modal>
    </View>
  );
}

function MetaItem({ icon: Icon, label, c }: { icon: any; label: string; c: any }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <Icon size={12} color={c.text} opacity={0.4} />
      <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{label}</Text>
    </View>
  );
}
