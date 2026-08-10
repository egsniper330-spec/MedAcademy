import { useCallback, useState, useMemo } from 'react';
import {
  View, Text, ScrollView, FlatList, useColorScheme, RefreshControl,
  ActivityIndicator, TextInput, Pressable,
} from 'react-native';
import { useFocusEffect, useRouter, RelativePathString } from 'expo-router';
import {
  Users, Search, UserPlus, BookOpen, Ban, Play, Trash2, Eye, Key, CreditCard, X,
  Clock, GraduationCap, ChevronRight, CheckCircle, PlusCircle, Upload, Fingerprint, Copy,
} from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { useProfileStore } from '@/lib/store';
import { PageHeader } from '@/components/PageHeader';
import {
  getCourses, getDoctorStudentEnrollments,
  enrollStudentViaCode, suspendCourseSubscription, resumeCourseSubscription,
  removeStudentFromCourseWithRefund, searchUsers, processStudentOperation,
} from '@/lib/api';
import { getCreditBalance, invalidateCreditCache } from '@/lib/creditService';
import { useCreditBalance } from '@/lib/useCreditBalance';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout } from '@/lib/neu';
import { displayPhoneNational } from '@/lib/phone';
import { getContactDisplay, getPublicEmail } from '@/lib/api';
import { friendlyError } from '@/lib/validation';

type EnrollMethod = 'code' | 'credits' | null;
type ActionType   = 'suspend' | 'resume' | 'remove' | 'profile' | null;
type TabKey       = 'all' | 'by_course' | 'active' | 'suspended' | 'recent';

const STATUS_COLOR: Record<string, string> = {
  active: '#16A34A', suspended: '#D97706', pending: '#6B7280', expired: '#DC2626',
};

const TABS: { key: TabKey; label: string; icon: React.ElementType }[] = [
  { key: 'all',        label: 'All Students',       icon: Users },
  { key: 'by_course',  label: 'By Course',           icon: BookOpen },
  { key: 'active',     label: 'Active',              icon: CheckCircle },
  { key: 'suspended',  label: 'Suspended',           icon: Ban },
  { key: 'recent',     label: 'Recently Added',      icon: Clock },
];

export default function DoctorStudents() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { profile } = useProfileStore();
  const { showToast } = useToast();
  const router = useRouter();

  // ── Data ──────────────────────────────────────────────────────────────────────
  const [enrollments, setEnrollments] = useState<any[]>([]);
  const [courses,     setCourses]     = useState<any[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);

  // ── Single source of truth for credits ───────────────────────────────────────
  const { balance: credits, refresh: refreshCredits } = useCreditBalance();

  // ── Tab & Search ─────────────────────────────────────────────────────────────
  const [activeTab,     setActiveTab]     = useState<TabKey>('all');
  const [query,         setQuery]         = useState('');
  const [expandCourse,  setExpandCourse]  = useState<string | null>(null);

  // ── Add Student modal ────────────────────────────────────────────────────────
  const [addModal,        setAddModal]        = useState(false);
  const [enrollMethod,    setEnrollMethod]    = useState<EnrollMethod>(null);
  const [modalCourses,    setModalCourses]    = useState<any[]>([]);
  const [modalCoursesLoading, setModalCoursesLoading] = useState(false);

  // Enroll via Code
  const [codeInput,   setCodeInput]   = useState('');
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeError,   setCodeError]   = useState('');

  // Enroll via Credits
  const [creditEmail,         setCreditEmail]         = useState('');
  const [creditSearchResults, setCreditSearchResults] = useState<any[]>([]);
  const [creditStudent,       setCreditStudent]       = useState<any>(null);
  const [creditCourse,        setCreditCourse]        = useState('');
  const [creditSearching,     setCreditSearching]     = useState(false);
  const [creditEnrolling,     setCreditEnrolling]     = useState(false);
  const [creditError,         setCreditError]         = useState('');
  const [creditStep,          setCreditStep]          = useState<1 | 2 | 3>(1);

  // ── Action modal ─────────────────────────────────────────────────────────────
  const [actionTarget,  setActionTarget]  = useState<any>(null);
  const [actionType,    setActionType]    = useState<ActionType>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // ── Load ──────────────────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!profile) return;
    try {
      const [enr, myCourses] = await Promise.all([
        getDoctorStudentEnrollments(profile.id),
        getCourses({ doctorId: profile.id, status: 'published' }),
      ]);
      setEnrollments(enr);
      setCourses(myCourses);
    } catch (_) {}
    setLoading(false);
  }, [profile]);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await Promise.all([loadData(), refreshCredits()]); setRefreshing(false); };

  // ── Tab data derivations ──────────────────────────────────────────────────────
  const q = query.toLowerCase();

  const allFiltered = useMemo(() => enrollments.filter(e => {
    const s = e.student;
    if (!s) return false;
    return !q || s.full_name?.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q)
      || s.phone?.includes(q) || e.course?.title?.toLowerCase().includes(q)
      || s.university?.name?.toLowerCase().includes(q) || s.faculty?.name?.toLowerCase().includes(q)
      || s.watermark_id?.toLowerCase().includes(q);
  }), [enrollments, q]);

  const activeEnrollments    = useMemo(() => allFiltered.filter(e => e.status === 'active'),    [allFiltered]);
  const suspendedEnrollments = useMemo(() => allFiltered.filter(e => e.status === 'suspended'), [allFiltered]);
  const recentEnrollments    = useMemo(() =>
    [...allFiltered].sort((a, b) => new Date(b.enrolled_at).getTime() - new Date(a.enrolled_at).getTime()),
    [allFiltered]);

  // By-course grouping
  const courseGroups = useMemo(() => {
    const grouped: Record<string, { course: any; items: any[] }> = {};
    enrollments.forEach(e => {
      if (!e.course) return;
      const id = e.course.id;
      if (!grouped[id]) grouped[id] = { course: e.course, items: [] };
      grouped[id].items.push(e);
    });
    return Object.values(grouped);
  }, [enrollments]);

  // ── Open Add Modal — loads a fresh course list every time ────────────────────
  const openAddModal = useCallback(async () => {
    setAddModal(true);
    if (!profile) return;
    setModalCoursesLoading(true);
    try {
      const fresh = await getCourses({ doctorId: profile.id, status: 'published' });
      setModalCourses(fresh);
    } catch (_) {
      setModalCourses([]);
    }
    setModalCoursesLoading(false);
  }, [profile]);

  // ── Enroll via Code ───────────────────────────────────────────────────────────
  const handleEnrollCode = async () => {
    if (!codeInput.trim()) return;
    setCodeLoading(true); setCodeError('');
    try {
      await enrollStudentViaCode(codeInput);
      showToast({ type: 'success', message: 'Student enrolled via activation code.' });
      resetAddModal();
      await loadData();
    } catch (e) { setCodeError(friendlyError(e, 'Invalid or already used code.')); }
    setCodeLoading(false);
  };

  // ── Enroll via Credits ────────────────────────────────────────────────────────
  const handleSearchStudent = async () => {
    if (!creditEmail.trim()) return;
    setCreditSearching(true); setCreditError('');
    try {
      const results = await searchUsers(creditEmail.trim());
      const students = results.filter((u: any) => u.role === 'student');
      if (students.length === 0) { setCreditError('No student found.'); setCreditSearchResults([]); }
      else setCreditSearchResults(students);
    } catch (e) { setCreditError(friendlyError(e, 'Search failed.')); }
    setCreditSearching(false);
  };

  const handleEnrollCredits = async () => {
    if (!creditStudent || !creditCourse) return;
    setCreditEnrolling(true); setCreditError('');
    try {
      // Single atomic EF call: lock credits → verify ≥1 → enroll → deduct → ledger → audit
      // Never shows success unless ALL backend steps completed. Raises on any failure.
      await processStudentOperation({
        mode:       'enroll_existing_credits',
        student_id: creditStudent.id,
        course_id:  creditCourse,
      });
      // EF already committed; invalidate cache so balance refreshes everywhere
      invalidateCreditCache();
      await Promise.all([refreshCredits(), loadData()]);
      showToast({ type: 'success', message: `${creditStudent.full_name} enrolled. 1 credit deducted.` });
      resetAddModal();
    } catch (e) { setCreditError(friendlyError(e, 'Enrollment failed. Check your credit balance.')); }
    setCreditEnrolling(false);
  };

  // ── Subscription actions ──────────────────────────────────────────────────────
  const handleAction = async () => {
    if (!actionTarget || !actionType) return;
    setActionLoading(true);
    try {
      if (actionType === 'suspend') {
        await suspendCourseSubscription(actionTarget.id);
        setEnrollments(prev => prev.map(e => e.id === actionTarget.id ? { ...e, status: 'suspended' } : e));
        showToast({ type: 'success', message: 'Subscription suspended.' });
      } else if (actionType === 'resume') {
        await resumeCourseSubscription(actionTarget.id);
        setEnrollments(prev => prev.map(e => e.id === actionTarget.id ? { ...e, status: 'active' } : e));
        showToast({ type: 'success', message: 'Subscription resumed.' });
      } else if (actionType === 'remove') {
        await removeStudentFromCourseWithRefund({
          doctorId:            profile!.id,
          enrollmentId:        actionTarget.id,
          studentNameSnapshot: actionTarget.student?.full_name ?? '',
          courseNameSnapshot:  actionTarget.course?.title ?? '',
        });
        setEnrollments(prev => prev.filter(e => e.id !== actionTarget.id));
        showToast({ type: 'success', message: 'Student removed. Revenue deducted.' });
        invalidateCreditCache();
        loadData();
      }
      setActionTarget(null); setActionType(null);
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Action failed.') }); }
    setActionLoading(false);
  };

  const openAction = (enrollment: any, type: ActionType) => { setActionTarget(enrollment); setActionType(type); };

  const resetAddModal = () => {
    setAddModal(false); setEnrollMethod(null);
    setCodeInput(''); setCodeError('');
    setCreditEmail(''); setCreditStudent(null); setCreditCourse('');
    setCreditSearchResults([]); setCreditError(''); setCreditStep(1);
  };

  // ── Enrollment card ───────────────────────────────────────────────────────────
  const renderEnrollmentCard = (enrollment: any, showCourse = true) => {
    const s = enrollment.student;
    const statusColor = STATUS_COLOR[enrollment.status] ?? '#6B7280';
    return (
      <NeuCard key={enrollment.id} style={{ marginBottom: 10, padding: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          {/* Avatar */}
          <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 15, fontWeight: '800', color: c.primary }}>{s?.full_name?.[0]?.toUpperCase() ?? '?'}</Text>
          </View>

          {/* Info */}
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>{s?.full_name}</Text>
              <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: `${statusColor}18` }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: statusColor, textTransform: 'uppercase' }}>{enrollment.status}</Text>
              </View>
            </View>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }} numberOfLines={1}>{getContactDisplay(s)}</Text>
            {/* ID — visible to doctor for enrolled students only */}
            {s?.watermark_id && (
              <Pressable
                onPress={() => { void Clipboard.setStringAsync(s.watermark_id); showToast({ type: 'success', message: 'ID copied.' }); }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 }}
              >
                <Fingerprint size={11} color={c.primary} opacity={0.7} />
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary, opacity: 0.8, letterSpacing: 0.8, fontVariant: ['tabular-nums'] }}>{s.watermark_id}</Text>
                <Copy size={10} color={c.primary} opacity={0.5} />
              </Pressable>
            )}
            {showCourse && enrollment.course?.title && (
              <Text style={{ fontSize: 11, color: c.primary, opacity: 0.8, marginTop: 2 }} numberOfLines={1}>{enrollment.course.title}</Text>
            )}
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 6 }}>
              {s?.university?.name && (
                <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }} numberOfLines={1}>{s.university.name}</Text>
              )}
              <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>
                {new Date(enrollment.enrolled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
              {enrollment.activation_method && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  {enrollment.activation_method === 'code'
                    ? <Key size={9} color={c.text} opacity={0.3} />
                    : <CreditCard size={9} color={c.text} opacity={0.3} />}
                  <Text style={{ fontSize: 10, color: c.text, opacity: 0.3 }}>{enrollment.activation_method}</Text>
                </View>
              )}
            </View>
          </View>
        </View>

        {/* Actions row */}
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 12 }}>
          <Pressable onPress={() => openAction(enrollment, 'profile')}
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 7, borderRadius: 10, backgroundColor: `${c.primary}12` }}>
            <Eye size={13} color={c.primary} /><Text style={{ fontSize: 11, fontWeight: '600', color: c.primary }}>Profile</Text>
          </Pressable>
          {enrollment.status === 'active' ? (
            <Pressable onPress={() => openAction(enrollment, 'suspend')}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 7, borderRadius: 10, backgroundColor: '#D9770618' }}>
              <Ban size={13} color="#D97706" /><Text style={{ fontSize: 11, fontWeight: '600', color: '#D97706' }}>Suspend</Text>
            </Pressable>
          ) : (
            <Pressable onPress={() => openAction(enrollment, 'resume')}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 7, borderRadius: 10, backgroundColor: '#16A34A18' }}>
              <Play size={13} color="#16A34A" /><Text style={{ fontSize: 11, fontWeight: '600', color: '#16A34A' }}>Resume</Text>
            </Pressable>
          )}
          <Pressable onPress={() => openAction(enrollment, 'remove')}
            style={{ width: 34, alignItems: 'center', justifyContent: 'center', paddingVertical: 7, borderRadius: 10, backgroundColor: '#DC262618' }}>
            <Trash2 size={13} color="#DC2626" />
          </Pressable>
        </View>
      </NeuCard>
    );
  };

  // ── Tab content ───────────────────────────────────────────────────────────────
  const renderTabContent = () => {
    if (loading) return <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />;

    // ALL STUDENTS
    if (activeTab === 'all') {
      return allFiltered.length === 0
        ? <EmptyState label="No students found" />
        : allFiltered.map(e => renderEnrollmentCard(e));
    }

    // BY COURSE
    if (activeTab === 'by_course') {
      if (courseGroups.length === 0) return <EmptyState label="No courses with students" />;
      return courseGroups.map(({ course, items }) => {
        const open = expandCourse === course.id;
        return (
          <View key={course.id} style={{ marginBottom: 12 }}>
            <Pressable onPress={() => setExpandCourse(open ? null : course.id)}>
              <NeuCard style={{ flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 }}>
                <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                  <BookOpen size={18} color={c.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>{course.title}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{items.length} student{items.length !== 1 ? 's' : ''}</Text>
                </View>
                <ChevronRight size={16} color={c.text} opacity={0.3}
                  style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />
              </NeuCard>
            </Pressable>
            {open && (
              <View style={{ paddingTop: 6, paddingLeft: 8 }}>
                {items.map(e => renderEnrollmentCard(e, false))}
              </View>
            )}
          </View>
        );
      });
    }

    // ACTIVE
    if (activeTab === 'active') {
      return activeEnrollments.length === 0
        ? <EmptyState label="No active subscriptions" />
        : activeEnrollments.map(e => renderEnrollmentCard(e));
    }

    // SUSPENDED
    if (activeTab === 'suspended') {
      return suspendedEnrollments.length === 0
        ? <EmptyState label="No suspended subscriptions" />
        : suspendedEnrollments.map(e => renderEnrollmentCard(e));
    }

    // RECENTLY ADDED
    if (activeTab === 'recent') {
      if (recentEnrollments.length === 0) return <EmptyState label="No recent enrollments" />;
      return recentEnrollments.slice(0, 30).map(e => {
        const s = e.student;
        return (
          <NeuCard key={e.id} style={{ marginBottom: 8, padding: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: c.primary }}>{s?.full_name?.[0]?.toUpperCase() ?? '?'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={1}>{s?.full_name}</Text>
                <Text style={{ fontSize: 11, color: c.primary, opacity: 0.8 }} numberOfLines={1}>{e.course?.title}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
                  <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>
                    Added {new Date(e.enrolled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </Text>
                  {e.activation_method && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                      {e.activation_method === 'code'
                        ? <Key size={9} color={c.text} opacity={0.3} />
                        : <CreditCard size={9} color={c.text} opacity={0.3} />}
                      <Text style={{ fontSize: 10, color: c.text, opacity: 0.3 }}>{e.activation_method}</Text>
                    </View>
                  )}
                </View>
              </View>
              <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: `${STATUS_COLOR[e.status] ?? '#6B7280'}18` }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: STATUS_COLOR[e.status] ?? '#6B7280', textTransform: 'uppercase' }}>{e.status}</Text>
              </View>
            </View>
          </NeuCard>
        );
      });
    }

    return null;
  };

  // ── Tab badge counts ──────────────────────────────────────────────────────────
  const tabCount: Record<TabKey, number> = {
    all:       enrollments.length,
    by_course: courseGroups.length,
    active:    activeEnrollments.length,
    suspended: suspendedEnrollments.length,
    recent:    Math.min(enrollments.length, 30),
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      >
        <View style={{ padding: layout.screenPx }}>
          <PageHeader
            title="Students"
            subtitle={`${enrollments.length} total · ${credits?.remaining ?? 0} credits remaining`}
            accentColor={c.primary}
          />

          {/* Action buttons row */}
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
            <Pressable onPress={openAddModal} style={{ flex: 1 }}>
              <NeuCard style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14 }}>
                <UserPlus size={18} color={c.primary} />
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary }}>Add Student</Text>
              </NeuCard>
            </Pressable>
            <Pressable onPress={() => router.push('/(app)/(doctor)/create-student' as RelativePathString)} style={{ flex: 1 }}>
              <NeuCard style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14 }}>
                <PlusCircle size={18} color="#22C55E" />
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#22C55E' }}>Create Student</Text>
              </NeuCard>
            </Pressable>
            <Pressable onPress={() => router.push('/(app)/(doctor)/bulk-import-students' as RelativePathString)}>
              <NeuCard style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 14 }}>
                <Upload size={18} color="#F59E0B" />
              </NeuCard>
            </Pressable>
          </View>

          {/* Search bar */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16,
            backgroundColor: c.base, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
            minWidth: 0,
            shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 6 }}>
            <Search size={16} color={c.text} opacity={0.4} style={{ flexShrink: 0 }} />
            <TextInput
              placeholder="Search students, courses…"
              placeholderTextColor={`${c.text}50`}
              value={query}
              onChangeText={setQuery}
              style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text, paddingVertical: 0 }}
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')} style={{ flexShrink: 0 }}>
                <X size={14} color={c.text} opacity={0.4} />
              </Pressable>
            )}
          </View>

          {/* Tab strip */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {TABS.map(tab => {
                const Icon = tab.icon;
                const active = activeTab === tab.key;
                return (
                  <Pressable key={tab.key} onPress={() => setActiveTab(tab.key)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
                      paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12,
                      backgroundColor: active ? c.primary : c.base,
                      shadowColor: active ? c.primary : c.shadowDark,
                      shadowOffset: { width: active ? 0 : 2, height: active ? 0 : 2 },
                      shadowOpacity: active ? 0 : 0.4, shadowRadius: active ? 0 : 5 }}>
                    <Icon size={13} color={active ? '#fff' : `${c.text}70`} />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : `${c.text}70` }}>
                      {tab.label}
                    </Text>
                    <View style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6,
                      backgroundColor: active ? 'rgba(255,255,255,0.25)' : `${c.text}12` }}>
                      <Text style={{ fontSize: 10, fontWeight: '800', color: active ? '#fff' : `${c.text}60` }}>
                        {tabCount[tab.key]}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>

          {/* Tab content */}
          {renderTabContent()}
        </View>
      </ScrollView>

      {/* ── Add Student Modal ───────────────────────────────────────────────────── */}
      <ResponsiveModal visible={addModal} onClose={resetAddModal} title="Add Student">
        {enrollMethod === null && (
          <View style={{ gap: 12 }}>
            <Text style={{ fontSize: 14, color: c.text, opacity: 0.6, textAlign: 'center', marginBottom: 8 }}>
              Choose enrollment method
            </Text>
            <Pressable onPress={() => setEnrollMethod('code')}>
              <NeuCard style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18 }}>
                <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                  <Key size={20} color={c.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>Add via Activation Code</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>Student gets enrolled using a one-time code</Text>
                </View>
              </NeuCard>
            </Pressable>
            <Pressable onPress={() => setEnrollMethod('credits')}>
              <NeuCard style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18 }}>
                <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}>
                  <CreditCard size={20} color="#16A34A" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>Add via Credits</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>Deduct 1 credit to enroll a student directly</Text>
                </View>
              </NeuCard>
            </Pressable>
          </View>
        )}

        {/* ── Enroll via Code ── */}
        {enrollMethod === 'code' && (
          <View style={{ gap: 14 }}>
            <Pressable onPress={() => setEnrollMethod(null)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <X size={14} color={c.text} opacity={0.4} />
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Back</Text>
            </Pressable>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.6 }}>Enter the activation code to enroll a student:</Text>
            <TextInput
              placeholder="Activation Code"
              placeholderTextColor={`${c.text}50`}
              value={codeInput}
              onChangeText={setCodeInput}
              autoCapitalize="characters"
              style={{ backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, color: c.text, fontWeight: '700', letterSpacing: 2,
                minWidth: 0,
                shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 5 }}
            />
            {codeError ? <Text style={{ fontSize: 12, color: '#DC2626' }}>{codeError}</Text> : null}
            <NeuButton label={codeLoading ? 'Enrolling…' : 'Enroll Student'} onPress={handleEnrollCode}
              loading={codeLoading} disabled={!codeInput.trim()} />
          </View>
        )}

        {/* ── Enroll via Credits ── */}
        {enrollMethod === 'credits' && (
          <View style={{ gap: 14 }}>
            <Pressable onPress={() => { setEnrollMethod(null); setCreditStep(1); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <X size={14} color={c.text} opacity={0.4} />
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Back</Text>
            </Pressable>

            {/* Step 1: Find student */}
            {creditStep === 1 && (
              <>
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.6 }}>Search by email or phone:</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput
                    placeholder="student@email.com or phone"
                    placeholderTextColor={`${c.text}50`}
                    value={creditEmail}
                    onChangeText={setCreditEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    style={{ flex: 1, backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: c.text,
                      shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 5 }}
                  />
                  <Pressable onPress={handleSearchStudent} disabled={creditSearching}
                    style={{ width: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: c.primary }}>
                    {creditSearching ? <ActivityIndicator color="#fff" size="small" /> : <Search size={18} color="#fff" />}
                  </Pressable>
                </View>
                {creditError ? <Text style={{ fontSize: 12, color: '#DC2626' }}>{creditError}</Text> : null}
                {creditSearchResults.map(s => (
                  <Pressable key={s.id} onPress={() => { setCreditStudent(s); setCreditSearchResults([]); setCreditStep(2); }}>
                    <NeuCard style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 }}>
                      <GraduationCap size={18} color={c.primary} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{s.full_name}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{getContactDisplay(s)}</Text>
                      </View>
                    </NeuCard>
                  </Pressable>
                ))}
              </>
            )}

            {/* Step 2: Select course */}
            {creditStep === 2 && creditStudent && (
              <>
                <NeuCard style={{ padding: 12, marginBottom: 4 }}>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Student</Text>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{creditStudent.full_name}</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{getContactDisplay(creditStudent)}</Text>
                </NeuCard>
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.6 }}>Select course:</Text>
                {modalCoursesLoading
                  ? <ActivityIndicator color={c.primary} style={{ marginVertical: 12 }} />
                  : modalCourses.length === 0
                    ? <Text style={{ fontSize: 13, color: c.text, opacity: 0.5 }}>{"You don't have any published courses yet."}</Text>
                    : modalCourses.map(course => (
                        <Pressable key={course.id} onPress={() => { setCreditCourse(course.id); setCreditStep(3); }}>
                          <NeuCard style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12,
                            borderWidth: creditCourse === course.id ? 1.5 : 0, borderColor: c.primary }}>
                            <BookOpen size={16} color={c.primary} />
                            <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={1}>{course.title}</Text>
                          </NeuCard>
                        </Pressable>
                      ))
                }
              </>
            )}

            {/* Step 3: Confirm */}
            {creditStep === 3 && creditStudent && creditCourse && (
              <>
                <NeuCard style={{ padding: 16, gap: 8 }}>
                  {[
                    { label: 'Student',          value: creditStudent.full_name },
                    { label: 'Course',           value: modalCourses.find(mc => mc.id === creditCourse)?.title ?? '' },
                    { label: 'Cost',             value: '1 Credit' },
                    { label: 'Current Balance',  value: `${credits?.remaining ?? 0} Credits` },
                  ].map(row => (
                    <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
                      <Text style={{ fontSize: 13, color: c.text, opacity: 0.5 }}>{row.label}</Text>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{row.value}</Text>
                    </View>
                  ))}
                </NeuCard>
                {creditError ? <Text style={{ fontSize: 12, color: '#DC2626' }}>{creditError}</Text> : null}
                <NeuButton label={creditEnrolling ? 'Enrolling…' : 'Add Student'} onPress={handleEnrollCredits}
                  loading={creditEnrolling} disabled={creditEnrolling} />
              </>
            )}
          </View>
        )}
      </ResponsiveModal>

      {/* ── Action confirmation modal ─────────────────────────────────────────── */}
      <ResponsiveModal
        visible={!!actionTarget && actionType !== 'profile'}
        onClose={() => { setActionTarget(null); setActionType(null); }}
        title={actionType === 'suspend' ? 'Suspend Subscription' : actionType === 'resume' ? 'Resume Subscription' : 'Remove Student'}
      >
        {actionTarget && actionType !== 'profile' && (
          <View style={{ gap: 16 }}>
            <Text style={{ fontSize: 14, color: c.text, opacity: 0.7, textAlign: 'center' }}>
              {actionType === 'suspend'
                ? `Suspend ${actionTarget.student?.full_name}'s access to ${actionTarget.course?.title}?`
                : actionType === 'resume'
                ? `Resume ${actionTarget.student?.full_name}'s access to ${actionTarget.course?.title}?`
                : `Permanently remove ${actionTarget.student?.full_name} from ${actionTarget.course?.title}?`}
            </Text>
            <NeuButton
              label={actionLoading ? 'Processing…' : actionType === 'suspend' ? 'Suspend' : actionType === 'resume' ? 'Resume' : 'Remove'}
              onPress={handleAction} loading={actionLoading}
              style={{ backgroundColor: actionType === 'remove' ? '#DC2626' : actionType === 'suspend' ? '#D97706' : '#16A34A' }}
            />
          </View>
        )}
      </ResponsiveModal>

      {/* ── Student profile modal ─────────────────────────────────────────────── */}
      <ResponsiveModal
        visible={!!actionTarget && actionType === 'profile'}
        onClose={() => { setActionTarget(null); setActionType(null); }}
        title="Student Profile"
      >
        {actionTarget && actionType === 'profile' && (() => {
          const s = actionTarget.student;
          // Phone: prefer formatted national → e164 → legacy phone column
          const phoneDisplay = s?.phone_national
            ? displayPhoneNational(s.phone_e164 ?? s.phone_national)
            : s?.phone_e164
            ? displayPhoneNational(s.phone_e164)
            : s?.phone
            ? displayPhoneNational(s.phone)
            : null;

          // Account status — use account-level status, not enrollment status
          const accountStatus = s?.status
            ? (s.status as string).charAt(0).toUpperCase() + (s.status as string).slice(1)
            : null;

          // Registration date
          const registeredDate = s?.created_at
            ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : null;

          // Always-shown student info rows (Phone and ID always present even if "Not Available")
          const infoRows: { label: string; value: string; highlight?: boolean; mono?: boolean; copyable?: boolean }[] = [
            { label: 'Full Name',      value: s?.full_name ?? '—' },
            { label: 'Email',          value: getPublicEmail(s) ?? '—' },
            { label: 'Phone Number',   value: phoneDisplay ?? 'Not Available', highlight: !phoneDisplay },
            { label: 'ID',             value: s?.watermark_id ?? 'Not Available', highlight: !s?.watermark_id, mono: true, copyable: !!s?.watermark_id },
            { label: 'Account Status', value: accountStatus ?? '—' },
            { label: 'Registered',     value: registeredDate ?? '—' },
          ];

          // Optional enrollment-context rows
          const contextRows: { label: string; value: string | undefined }[] = [
            { label: 'University',     value: s?.university?.name },
            { label: 'Faculty',        value: s?.faculty?.name },
            { label: 'Academic Level', value: s?.academic_level?.name },
            { label: 'Course',         value: actionTarget.course?.title },
            { label: 'Enrolled',       value: new Date(actionTarget.enrolled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
            { label: 'Enrollment Status', value: actionTarget.status },
            { label: 'Method',         value: actionTarget.activation_method },
          ].filter(r => !!r.value) as { label: string; value: string }[];

          return (
            <View style={{ gap: 0 }}>
              {/* ── Student Information section ── */}
              <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: c.text, opacity: 0.4, marginBottom: 6 }}>
                Student Information
              </Text>
              {infoRows.map(row => (
                <Pressable
                  key={row.label}
                  onPress={row.copyable ? () => { void Clipboard.setStringAsync(row.value); showToast({ type: 'success', message: `${row.label} copied.` }); } : undefined}
                  style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}
                >
                  <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, flexShrink: 0 }}>{row.label}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 }}>
                    {row.copyable && <Copy size={11} color={c.primary} opacity={0.5} />}
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: row.highlight ? '500' : '600',
                        color: row.highlight ? `${c.text}55` : row.mono ? c.primary : c.text,
                        fontStyle: row.highlight ? 'italic' : 'normal',
                        fontVariant: row.mono ? ['tabular-nums'] : undefined,
                        textAlign: 'right',
                        maxWidth: 200,
                      }}
                      numberOfLines={1}
                    >
                      {row.value}
                    </Text>
                  </View>
                </Pressable>
              ))}

              {/* ── Enrollment context section ── */}
              {contextRows.length > 0 && (
                <>
                  <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: c.text, opacity: 0.4, marginBottom: 6, marginTop: 16 }}>
                    Enrollment Details
                  </Text>
                  {contextRows.map(row => (
                    <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
                      <Text style={{ fontSize: 13, color: c.text, opacity: 0.5 }}>{row.label}</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, maxWidth: '60%', textAlign: 'right' }} numberOfLines={1}>{row.value}</Text>
                    </View>
                  ))}
                </>
              )}
            </View>
          );
        })()}
      </ResponsiveModal>
    </View>
  );
}

function EmptyState({ label }: { label: string }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <View style={{ alignItems: 'center', paddingVertical: 48 }}>
      <Users size={40} color={c.text} opacity={0.15} />
      <Text style={{ color: c.text, opacity: 0.4, fontSize: 14, fontWeight: '600', marginTop: 12 }}>{label}</Text>
    </View>
  );
}
