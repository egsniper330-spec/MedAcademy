import { useCallback, useState, useMemo } from 'react';
import {
  View, Text, ScrollView, FlatList, useColorScheme, RefreshControl,
  ActivityIndicator, TextInput, Pressable, Image, StyleSheet, useWindowDimensions,
} from 'react-native';
import { useFocusEffect, useRouter, RelativePathString } from 'expo-router';
import {
  Users, Search, UserPlus, BookOpen, Ban, Play, Trash2, Eye, CreditCard, X,
  Clock, GraduationCap, ChevronRight, CheckCircle, PlusCircle, Copy,
  Check, ListChecks,
} from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { useProfileStore } from '@/lib/store';
import { PageHeader } from '@/components/PageHeader';
import {
  getCourses, getDoctorStudentEnrollments,
  suspendCourseSubscription, resumeCourseSubscription,
  removeStudentFromCourseWithRefund, searchUsers, processStudentOperation,
  bulkStudentAction, type BulkStudentActionResult,
} from '@/lib/api';
import { getCreditBalance, invalidateCreditCache } from '@/lib/creditService';
import { useCreditBalance } from '@/lib/useCreditBalance';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, safeBottom, mutedTextStyle } from '@/lib/neu';
import { displayPhoneNational } from '@/lib/phone';
import { getContactDisplay, getPublicEmail } from '@/lib/api';
import { friendlyError } from '@/lib/validation';
import { useTranslation } from '@/lib/i18n';
import { statusLabel } from '@/lib/i18n/labels';

type EnrollMethod = 'credits' | null;
type ActionType   = 'suspend' | 'resume' | 'remove' | 'profile' | null;
type TabKey       = 'all' | 'by_course' | 'active' | 'suspended' | 'recent';
type BulkAction   = 'suspend' | 'resume' | 'remove';

const STATUS_COLOR: Record<string, string> = {
  active: '#16A34A', suspended: '#D97706', pending: '#6B7280', expired: '#DC2626',
};

const TABS: { key: TabKey; labelKey: string; icon: React.ElementType }[] = [
  { key: 'all',        labelKey: 'drStudents.tabAll',      icon: Users },
  { key: 'by_course',  labelKey: 'drStudents.tabByCourse', icon: BookOpen },
  { key: 'active',     labelKey: 'status.active',          icon: CheckCircle },
  { key: 'suspended',  labelKey: 'status.suspended',       icon: Ban },
  { key: 'recent',     labelKey: 'drStudents.tabRecent',   icon: Clock },
];

/**
 * Student avatar — the REAL uploaded profile photo.
 *
 * The doctor's student list previously drew an initials circle only. The
 * backend already returns `student.avatar_url` (public object URL from the
 * `user-avatars` bucket, set by the student from their profile screen), so the
 * photo was fetched but never displayed. This renders it with:
 *   • initials as the fallback for students WITHOUT a photo (no broken icon);
 *   • an onError fallback so a stale/deleted object degrades to initials;
 *   • no extra network/auth: avatar_url is a public URL, like the doctor's own
 *     avatar on dr-profile, and only authorized enrollment data reaches this
 *     screen in the first place (server-side visibility filter).
 */
function StudentAvatar({ student, size, radius, colors }: {
  student: any; size: number; radius: number; colors: any;
}) {
  const [failed, setFailed] = useState(false);
  const url = typeof student?.avatar_url === 'string' ? student.avatar_url.trim() : '';
  const initial = String(student?.full_name ?? '?').trim().charAt(0).toUpperCase() || '?';

  if (url !== '' && !failed) {
    return (
      <Image
        source={{ uri: url }}
        style={{ width: size, height: size, borderRadius: radius, backgroundColor: `${colors.primary}18` }}
        onError={() => setFailed(true)}
        resizeMode="cover"
        accessibilityLabel={student?.full_name ? String(student.full_name) : undefined}
      />
    );
  }
  return (
    <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: `${colors.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: size * 0.36, fontWeight: '800', color: colors.primary }}>{initial}</Text>
    </View>
  );
}

export default function DoctorStudents() {
  // Responsive: two columns from tablet width up, one on phones. The card
  // itself used to be a single full-width row at every size.
  const { width: viewportWidth } = useWindowDimensions();
  const twoColumn = viewportWidth >= 700;
  const gridStyle = twoColumn
    ? { flexDirection: 'row' as const, flexWrap: 'wrap' as const, justifyContent: 'space-between' as const }
    : undefined;

  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  // One bordered, divider-separated panel — not a stack of elevated cards.
  const listPanel = {
    backgroundColor: c.base, borderRadius: 14, overflow: 'hidden' as const,
    borderWidth: StyleSheet.hairlineWidth, borderColor: `${c.text}14`,
  };
  const { profile } = useProfileStore();
  const { showToast } = useToast();
  const router = useRouter();
  const { t, tCount, locale } = useTranslation();

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

  // ── Bulk selection mode (backend-authoritative actions; see bulkStudentAction) ─
  const [selectMode,    setSelectMode]    = useState(false);
  const [selected,      setSelected]      = useState<Set<string>>(new Set());
  const [bulkMenu,      setBulkMenu]      = useState(false);
  const [bulkConfirm,   setBulkConfirm]   = useState<BulkAction | null>(null);
  const [bulkResult,    setBulkResult]    = useState<BulkStudentActionResult | null>(null);
  const [bulkExecuting, setBulkExecuting] = useState(false);
  //  COURSE SCOPE: when the selection was created from a specific course
  //  ("Select all in this course"), the scope is remembered and sent to the
  //  backend with the action. The server independently validates that every id
  //  belongs to that course, so a stale/edited client can never action a
  //  student from another course.
  const [selectionCourse, setSelectionCourse] = useState<{ id: string; title: string } | null>(null);

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
      || s.public_user_id?.toLowerCase().includes(q);
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

  // ── Enroll via Credits ────────────────────────────────────────────────────────
  const handleSearchStudent = async () => {
    if (!creditEmail.trim()) return;
    setCreditSearching(true); setCreditError('');
    try {
      const results = await searchUsers(creditEmail.trim());
      const students = results.filter((u: any) => u.role === 'student');
      if (students.length === 0) { setCreditError(t('drStudents.noStudentFound')); setCreditSearchResults([]); }
      else setCreditSearchResults(students);
    } catch (e) { setCreditError(friendlyError(e, t('drStudents.searchFailed'))); }
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
      showToast({ type: 'success', message: t('drStudents.enrolled', { name: creditStudent.full_name }) });
      resetAddModal();
    } catch (e) { setCreditError(friendlyError(e, t('drStudents.enrollFailed'))); }
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
        showToast({ type: 'success', message: t('drStudents.subscriptionSuspended') });
      } else if (actionType === 'resume') {
        await resumeCourseSubscription(actionTarget.id);
        setEnrollments(prev => prev.map(e => e.id === actionTarget.id ? { ...e, status: 'active' } : e));
        showToast({ type: 'success', message: t('drStudents.subscriptionResumed') });
      } else if (actionType === 'remove') {
        await removeStudentFromCourseWithRefund({
          doctorId:            profile!.id,
          enrollmentId:        actionTarget.id,
          studentNameSnapshot: actionTarget.student?.full_name ?? '',
          courseNameSnapshot:  actionTarget.course?.title ?? '',
        });
        setEnrollments(prev => prev.filter(e => e.id !== actionTarget.id));
        showToast({ type: 'success', message: t('drStudents.studentRemoved') });
        invalidateCreditCache();
        loadData();
      }
      setActionTarget(null); setActionType(null);
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('drStudents.actionFailed')) }); }
    setActionLoading(false);
  };

  const openAction = (enrollment: any, type: ActionType) => { setActionTarget(enrollment); setActionType(type); };

  // ── Bulk selection helpers ────────────────────────────────────────────────────
  // "All visible" means the CURRENT tab's rendered list — never the whole
  // database (this screen has no server-side pagination; the tab content IS
  // the page, so visible == matching students and no false claim is made).
  const visibleEnrollments = useMemo(() => {
    switch (activeTab) {
      case 'all':       return allFiltered;
      case 'active':    return activeEnrollments;
      case 'suspended': return suspendedEnrollments;
      case 'recent':    return recentEnrollments.slice(0, 30);
      case 'by_course': return courseGroups.flatMap(g => g.items);
      default:          return [];
    }
  }, [activeTab, allFiltered, activeEnrollments, suspendedEnrollments, recentEnrollments, courseGroups]);

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);
  const selectAllVisible = useCallback(() => {
    setSelectionCourse(null);
    setSelected(new Set(visibleEnrollments.map(e => e.id)));
  }, [visibleEnrollments]);

  /** Select every student of ONE course (never the platform, never other courses). */
  const selectCourseGroup = useCallback((course: { id: string; title: string }, items: any[]) => {
    setSelectMode(true);
    setBulkMenu(false);
    setSelectionCourse({ id: course.id, title: course.title });
    setSelected(new Set(items.map(e => e.id)));
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false); setSelected(new Set()); setBulkMenu(false);
    setBulkConfirm(null); setBulkResult(null); setBulkExecuting(false);
    setSelectionCourse(null);
  }, []);

  // Authorization-derived menu state (mirrors the per-card buttons: Suspend
  // only applies to active rows, Resume only to suspended rows — same rules
  // the individual buttons use; the backend independently re-checks each row).
  const selectedActiveCount    = useMemo(() => enrollments.filter(e => selected.has(e.id) && e.status === 'active').length, [enrollments, selected]);
  const selectedSuspendedCount = useMemo(() => enrollments.filter(e => selected.has(e.id) && e.status === 'suspended').length, [enrollments, selected]);

  const executeBulk = useCallback(async (action: BulkAction) => {
    if (!action || bulkExecuting || selected.size === 0) return;
    setBulkExecuting(true);
    setBulkConfirm(null);
    try {
      // One backend call — the server authorizes every id against the real
      // scope and returns exact per-row results. Never per-student fan-out.
      const res = await bulkStudentAction({
        enrollmentIds: [...selected],
        action,
        courseId: selectionCourse?.id,
      });
      setBulkResult(res);
      if (res.succeeded > 0) {
        if (action === 'remove') invalidateCreditCache();
        await loadData();
      }
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('drStudents.bulkFailed')) });
      setBulkResult(null);
    }
    setBulkExecuting(false);
  }, [bulkExecuting, selected, selectionCourse, loadData, showToast]);

  const resetAddModal = () => {
    setAddModal(false); setEnrollMethod(null);
    setCreditEmail(''); setCreditStudent(null); setCreditCourse('');
    setCreditSearchResults([]); setCreditError(''); setCreditStep(1);
  };

  // ── Student row (compact) ────────────────────────────────────────────────────
  // Redesign: one information-dense row instead of a full card. A 34 px photo,
  // the name, the public id, the course and the status stay scannable at a
  // glance; the three authorized actions are 30 px icon buttons (44 px touch
  // target via hitSlop) instead of a button bar per student. Row height is
  // 9 + 9 padding around 34 px content ≈ 52–56 px, so a phone shows ~9–11
  // students where the old cards showed 3.
  const iconBtn = {
    width: 30, height: 30, borderRadius: 8,
    alignItems: 'center' as const, justifyContent: 'center' as const,
  };

  const renderStudentRow = (enrollment: any, showCourse = true, withDate = false) => {
    const s = enrollment.student;
    const statusColor = STATUS_COLOR[enrollment.status] ?? '#6B7280';
    const isSelected = selected.has(enrollment.id);

    // Secondary facts, most useful first, on ONE muted line. Long values
    // ellipsize; the action column has a fixed width so nothing collides.
    const meta: string[] = [];
    // "Recently added" is ordered by enrollment date, so show it there.
    if (withDate && enrollment.enrolled_at) {
      meta.push(new Date(enrollment.enrolled_at).toLocaleDateString(
        locale === 'ar' ? 'ar-EG' : 'en-US', { month: 'short', day: 'numeric' },
      ));
    }
    if (showCourse && enrollment.course?.title) meta.push(String(enrollment.course.title));
    if (typeof enrollment.progress_percent === 'number') meta.push(`${Math.round(enrollment.progress_percent)}%`);
    if (!showCourse && s?.university?.name) meta.push(String(s.university.name));

    // The copy affordance sits inside the pressable row; stop propagation so
    // copying never also opens the details sheet (RN Web bubbles the click).
    const copyId = (e?: any) => {
      e?.stopPropagation?.();
      void Clipboard.setStringAsync(String(s.public_user_id));
      showToast({ type: 'success', message: t('drStudents.idCopied') });
    };

    return (
      <Pressable
        key={enrollment.id}
        onPress={() => (selectMode ? toggleSelect(enrollment.id) : openAction(enrollment, 'profile'))}
        // NOT `button` outside select mode: react-native-web renders a
        // role="button" Pressable as a real <button>, and this row contains its
        // own copy + action buttons — a <button> inside a <button> is invalid
        // DOM (React logs a nesting error). The row stays a tappable surface,
        // and every action in it is still a labelled, focusable button (the
        // Profile one does exactly what the row tap does).
        accessibilityRole={selectMode ? 'checkbox' : undefined}
        accessibilityState={selectMode ? { checked: isSelected } : undefined}
        accessibilityLabel={
          selectMode
            ? t('drStudents.selectA11y', { name: s?.full_name ?? t('drStudents.student') })
            : t('drStudents.profileTitle')
        }
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 9,
          paddingHorizontal: 10, paddingVertical: 9,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: `${c.text}16`,
          backgroundColor: selectMode && isSelected ? `${c.primary}10` : 'transparent',
          ...(twoColumn ? { width: '49%' } : {}),
        }}
      >
        {selectMode && (
          <View style={{
            width: 18, height: 18, borderRadius: 6, flexShrink: 0,
            borderWidth: 1.5,
            borderColor: isSelected ? c.primary : `${c.text}30`,
            backgroundColor: isSelected ? c.primary : 'transparent',
            alignItems: 'center', justifyContent: 'center',
          }}>
            {isSelected && <Check size={12} color="#fff" strokeWidth={3} />}
          </View>
        )}

        {/* Avatar — real uploaded photo, initials when absent or broken */}
        <StudentAvatar student={s} size={34} radius={17} colors={c} />

        <View style={{ flex: 1, minWidth: 0 }}>
          {/* Name gets the full row width: it is the primary text, so the
              status pill lives on the meta line instead of competing with it. */}
          <Text style={{ fontSize: 13.5, fontWeight: '700', color: c.text }} numberOfLines={1}>
            {s?.full_name ?? '—'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2, minWidth: 0 }}>
            <View style={{ flexShrink: 0, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, backgroundColor: `${statusColor}18` }}>
              <Text style={{ fontSize: 9, fontWeight: '800', color: statusColor, letterSpacing: 0.2 }}>
                {statusLabel(enrollment.status, t)}
              </Text>
            </View>
            {/* ID — tap to copy, exactly as before */}
            {Boolean(s?.public_user_id) && (
              <Pressable onPress={copyId} hitSlop={6} accessibilityRole="button"
                accessibilityLabel={t('drStudents.idCopied')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                <Text style={{ fontSize: 10.5, fontWeight: '700', color: c.primary, opacity: 0.85,
                  letterSpacing: 0.4, fontVariant: ['tabular-nums'] }}>
                  {s.public_user_id}
                </Text>
                <Copy size={9} color={c.primary} opacity={0.45} />
              </Pressable>
            )}
            {meta.length > 0 && (
              <Text style={{ flexShrink: 1, fontSize: 10.5, ...mutedTextStyle(c, 0.5) }} numberOfLines={1}>
                {`· ${meta.join(' · ')}`}
              </Text>
            )}
          </View>
        </View>

        {/* Actions — icon buttons, hidden in Select mode (bulk bar takes over) */}
        {!selectMode && (
          <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0 }}>
            <Pressable onPress={() => openAction(enrollment, 'profile')} hitSlop={8}
              accessibilityRole="button" accessibilityLabel={t('common.profile')} style={iconBtn}>
              <Eye size={15} color={c.primary} />
            </Pressable>
            {enrollment.status === 'active' ? (
              <Pressable onPress={() => openAction(enrollment, 'suspend')} hitSlop={8}
                accessibilityRole="button" accessibilityLabel={t('drStudents.suspend')} style={iconBtn}>
                <Ban size={15} color="#D97706" />
              </Pressable>
            ) : (
              <Pressable onPress={() => openAction(enrollment, 'resume')} hitSlop={8}
                accessibilityRole="button" accessibilityLabel={t('drStudents.resume')} style={iconBtn}>
                <Play size={15} color="#16A34A" />
              </Pressable>
            )}
            <Pressable onPress={() => openAction(enrollment, 'remove')} hitSlop={8}
              accessibilityRole="button" accessibilityLabel={t('drStudents.removeFromCourse')} style={iconBtn}>
              <Trash2 size={15} color="#DC2626" />
            </Pressable>
          </View>
        )}
      </Pressable>
    );
  };

  // ── Tab content ───────────────────────────────────────────────────────────────
  const renderTabContent = () => {
    if (loading) return <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />;

    // ALL STUDENTS
    if (activeTab === 'all') {
      return allFiltered.length === 0
        ? <EmptyState label={t('drStudents.noStudents')} />
        : <View style={[listPanel, gridStyle]}>{allFiltered.map(e => renderStudentRow(e))}</View>;
    }

    // BY COURSE
    if (activeTab === 'by_course') {
      if (courseGroups.length === 0) return <EmptyState label={t('drStudents.noCoursesWithStudents')} />;

      return courseGroups.map(({ course, items }) => {
        const open = expandCourse === course.id;
        return (
          <View key={course.id} style={{ marginBottom: 10 }}>
            <Pressable onPress={() => {
              if (selectMode && selectionCourse && selectionCourse.id !== course.id) exitSelectMode();
              setExpandCourse(open ? null : course.id);
            }}>
              <NeuCard style={{ flexDirection: 'row', alignItems: 'center', padding: 10, gap: 10 }}>
                <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                  <BookOpen size={15} color={c.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>{course.title}</Text>
                  <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5) }}>{tCount('drStudents.studentCount', items.length)}</Text>
                </View>
                <ChevronRight size={16} color={c.text} opacity={0.3}
                  style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />
              </NeuCard>
            </Pressable>
            {open && (
              <View style={{ paddingTop: 4 }}>
                {/*  COURSE-SCOPED SELECT ALL — selects only this course's
                    students (the group's own rows), never the whole platform
                    and never another course's list. */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Pressable
                    onPress={() => selectCourseGroup(course, items)}
                    accessibilityRole="button"
                    accessibilityLabel={t('bulk.selectAllCourseA11y', { course: course.title })}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10,
                      paddingVertical: 7, borderRadius: 10, backgroundColor: `${c.primary}12`, flexShrink: 1 }}
                  >
                    <CheckCircle size={13} color={c.primary} />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }} numberOfLines={1}>
                      {t('bulk.selectAllInCourse')}
                    </Text>
                  </Pressable>
                  {selectionCourse?.id === course.id && (
                    <Text style={{ fontSize: 11.5, fontWeight: '700', ...mutedTextStyle(c, 0.55) }} numberOfLines={1}>
                      {t('bulk.selectedInCourse', { count: selected.size })}
                    </Text>
                  )}
                </View>
                <View style={[listPanel, gridStyle]}>{items.map(e => renderStudentRow(e, false))}</View>
              </View>
            )}
          </View>
        );
      });
    }

    // ACTIVE
    if (activeTab === 'active') {
      return activeEnrollments.length === 0
        ? <EmptyState label={t('drStudents.noActive')} />
        : <View style={[listPanel, gridStyle]}>{activeEnrollments.map(e => renderStudentRow(e))}</View>;
    }

    // SUSPENDED
    if (activeTab === 'suspended') {
      return suspendedEnrollments.length === 0
        ? <EmptyState label={t('drStudents.noSuspended')} />
        : <View style={[listPanel, gridStyle]}>{suspendedEnrollments.map(e => renderStudentRow(e))}</View>;
    }

    // RECENTLY ADDED — the same compact row, newest first (max 30).
    if (recentEnrollments.length === 0) return <EmptyState label={t('drStudents.noRecent')} />;
    return <View style={[listPanel, gridStyle]}>{recentEnrollments.slice(0, 30).map(e => renderStudentRow(e, true, true))}</View>;
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
      <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
      >
          <PageHeader
            title={t('nav.students')}
            subtitle={t('drStudents.subtitle', { total: enrollments.length, credits: credits?.remaining ?? 0 })}
            accentColor={c.primary}
          />

        <View style={{ paddingHorizontal: layout.screenPx }}>

          {/* Action buttons row */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            <Pressable onPress={openAddModal} style={{ flex: 1 }}>
              <NeuCard style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 9, borderRadius: 12 }}>
                <UserPlus size={18} color={c.primary} />
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary }}>{t('drStudents.addStudent')}</Text>
              </NeuCard>
            </Pressable>
            {/*  ROUTE FIX: the full-flow creator lives in the (hubs) stack, not
                in (doctor). Group-qualified hrefs (`/(app)/(doctor)/create-student`)
                select a route INSIDE that group, where no such screen exists —
                which is what produced the Expo Router "Unmatched Route" screen.
                Every other navigation in the app uses the group-free URL
                (DrawerNav: `/students`, `/video-library`), so follow that. */}
            <Pressable
              onPress={() => router.push('/create-student' as RelativePathString)}
              style={{ flex: 1 }}
              accessibilityRole="button"
              accessibilityLabel={t('drStudents.createStudent')}
            >
              <NeuCard style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 9, borderRadius: 12 }}>
                <PlusCircle size={18} color="#22C55E" />
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#22C55E' }}>{t('drStudents.createStudent')}</Text>
              </NeuCard>
            </Pressable>
            {/* The icon-only bulk-import shortcut that used to sit here was
                removed: it had no visible label (its only name was an a11y
                string), it pointed at the same broken group-qualified route,
                and it duplicated Create Student's slot on this row. Bulk import
                stays reachable from the drawer (nav.bulkImport). */}
          </View>

          {/* Select mode toggle — compact, native to the row above */}
          {!selectMode ? (
            <Pressable
              onPress={() => setSelectMode(true)}
              accessibilityRole="button"
              accessibilityLabel={t('drStudents.selectModeA11y')}
              style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6,
                paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10,
                backgroundColor: `${c.primary}12`, marginBottom: 8 }}>
              <ListChecks size={14} color={c.primary} />
              <Text style={{ fontSize: 12.5, fontWeight: '700', color: c.primary }}>{t('drStudents.select')}</Text>
            </Pressable>
          ) : (
            /* Selection action bar — appears only when at least one is selected */
            <View style={{ marginBottom: 8, gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Pressable
                  onPress={selectAllVisible}
                  accessibilityRole="button"
                  accessibilityLabel={t('drStudents.selectAllA11y')}
                  accessibilityHint={t('bulk.scopeAll')}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7,
                    borderRadius: 10, backgroundColor: `${c.primary}12` }}>
                  <CheckCircle size={13} color={c.primary} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>{t('drStudents.allVisible')}</Text>
                </Pressable>
                <Pressable
                  onPress={() => setSelected(new Set())}
                  accessibilityRole="button"
                  accessibilityLabel={t('drStudents.clearSelectionA11y')}
                  style={{ paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: `${c.text}0d` }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', ...mutedTextStyle(c, 0.6) }}>{t('drStudents.clear')}</Text>
                </Pressable>
                <Text style={{ fontSize: 12.5, fontWeight: '700', color: c.text, flex: 1 }}>
                  {t('bulk.selected', { count: selected.size })}
                </Text>
                <Pressable
                  onPress={exitSelectMode}
                  accessibilityRole="button"
                  accessibilityLabel={t('drStudents.exitSelectA11y')}
                  style={{ paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: `${c.text}0d` }}>
                  <X size={14} color={c.text} opacity={0.6} />
                </Pressable>
              </View>
              {/*  SCOPE LINE — makes the selection's reach explicit: everything in
                  the current tab, or exactly one course. */}
              <Text style={{ fontSize: 11.5, fontWeight: '600', ...mutedTextStyle(c, 0.55) }} numberOfLines={2}>
                {selectionCourse
                  ? t('bulk.courseScopeLabel', { course: selectionCourse.title })
                  : t('bulk.scopeAll')}
              </Text>
              {/* Bulk Actions — only when ≥1 selected. Options mirror the
                  individual-card authorization (Suspend for active rows,
                  Resume for suspended rows, Remove always offered individually). */}
              {selected.size > 0 && (
                <View>
                  <Pressable
                    onPress={() => setBulkMenu(v => !v)}
                    accessibilityRole="button"
                    accessibilityLabel={t('drStudents.openBulkA11y')}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                      paddingVertical: 12, borderRadius: 12, backgroundColor: c.primary }}>
                    <ListChecks size={16} color="#fff" />
                    <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>
                      {t('drStudents.bulkActions', { count: selected.size })}
                    </Text>
                  </Pressable>
                  {bulkMenu && (
                    <View style={{ gap: 8, marginTop: 8 }}>
                      {selectedActiveCount > 0 && (
                        <Pressable onPress={() => setBulkConfirm('suspend')}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 11, paddingHorizontal: 14,
                            borderRadius: 12, backgroundColor: '#D9770618' }}>
                          <Ban size={15} color="#D97706" />
                          <Text style={{ fontSize: 13, fontWeight: '700', color: '#D97706' }}>
                            {selectedActiveCount < selected.size
                              ? t('drStudents.suspendActive', { count: selectedActiveCount })
                              : t('drStudents.suspend')}
                          </Text>
                        </Pressable>
                      )}
                      {selectedSuspendedCount > 0 && (
                        <Pressable onPress={() => setBulkConfirm('resume')}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 11, paddingHorizontal: 14,
                            borderRadius: 12, backgroundColor: '#16A34A18' }}>
                          <Play size={15} color="#16A34A" />
                          <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>
                            {selectedSuspendedCount < selected.size
                              ? t('drStudents.resumeSuspended', { count: selectedSuspendedCount })
                              : t('drStudents.resume')}
                          </Text>
                        </Pressable>
                      )}
                      <Pressable onPress={() => setBulkConfirm('remove')}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 11, paddingHorizontal: 14,
                          borderRadius: 12, backgroundColor: '#DC262618' }}>
                        <Trash2 size={15} color="#DC2626" />
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>{t('drStudents.removeFromCourse')}</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              )}
            </View>
          )}

          {/* Search bar */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10,
            backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9,
            minWidth: 0,
            shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 6 }}>
            <Search size={16} color={c.text} opacity={0.4} style={{ flexShrink: 0 }} />
            <TextInput
              placeholder={t('drStudents.searchPlaceholder')}
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
          <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {TABS.map(tab => {
                const Icon = tab.icon;
                const active = activeTab === tab.key;
                return (
                  <Pressable key={tab.key} onPress={() => {
                    // A selection belongs to the tab/course it was made in —
                    // switching lists must never carry it into another course.
                    if (tab.key !== activeTab) { if (selectMode) exitSelectMode(); setActiveTab(tab.key); }
                  }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
                      paddingHorizontal: 11, paddingVertical: 7, borderRadius: 10,
                      backgroundColor: active ? c.primary : c.base,
                      shadowColor: active ? c.primary : c.shadowDark,
                      shadowOffset: { width: active ? 0 : 2, height: active ? 0 : 2 },
                      shadowOpacity: active ? 0 : 0.4, shadowRadius: active ? 0 : 5 }}>
                    <Icon size={13} color={active ? '#fff' : `${c.text}70`} />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : `${c.text}70` }}>
                      {t(tab.labelKey)}
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
      <ResponsiveModal visible={addModal} onClose={resetAddModal} title={t('drStudents.addStudent')}>
        {enrollMethod === null && (
          <View style={{ gap: 12 }}>
            <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.6), textAlign: 'center', marginBottom: 8 }}>
              {t('drStudents.chooseMethod')}
            </Text>
            <Pressable onPress={() => setEnrollMethod('credits')}>
              <NeuCard style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18 }}>
                <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}>
                  <CreditCard size={20} color="#16A34A" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{t('drStudents.addViaCredits')}</Text>
                  <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5), marginTop: 2 }}>{t('drStudents.addViaCreditsHint')}</Text>
                </View>
              </NeuCard>
            </Pressable>
          </View>
        )}

        {/* ── Enroll via Credits ── */}
        {enrollMethod === 'credits' && (
          <View style={{ gap: 14 }}>
            <Pressable onPress={() => { setEnrollMethod(null); setCreditStep(1); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <X size={14} color={c.text} opacity={0.4} />
              <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5) }}>{t('common.back')}</Text>
            </Pressable>

            {/* Step 1: Find student */}
            {creditStep === 1 && (
              <>
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6) }}>{t('drStudents.searchByEmailOrPhone')}</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput
                    placeholder={t('drStudents.studentSearchPlaceholder')}
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
                        <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5) }}>{getContactDisplay(s)}</Text>
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
                  <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5) }}>{t('drStudents.student')}</Text>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{creditStudent.full_name}</Text>
                  <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5) }}>{getContactDisplay(creditStudent)}</Text>
                </NeuCard>
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6) }}>{t('drStudents.selectCourse')}</Text>
                {modalCoursesLoading
                  ? <ActivityIndicator color={c.primary} style={{ marginVertical: 12 }} />
                  : modalCourses.length === 0
                    ? <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5) }}>{t('drStudents.noPublishedCourses')}</Text>
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
                    { label: t('drStudents.student'),         value: creditStudent.full_name },
                    { label: t('drStudents.course'),          value: modalCourses.find(mc => mc.id === creditCourse)?.title ?? '' },
                    { label: t('drStudents.cost'),            value: tCount('drStudents.creditCount', 1) },
                    { label: t('drStudents.currentBalance'),  value: tCount('drStudents.creditCount', credits?.remaining ?? 0) },
                  ].map(row => (
                    <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
                      <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5) }}>{row.label}</Text>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{row.value}</Text>
                    </View>
                  ))}
                </NeuCard>
                {creditError ? <Text style={{ fontSize: 12, color: '#DC2626' }}>{creditError}</Text> : null}
                <NeuButton label={creditEnrolling ? t('drStudents.enrolling') : t('drStudents.addStudent')} onPress={handleEnrollCredits}
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
        title={actionType === 'suspend' ? t('drStudents.suspendTitle') : actionType === 'resume' ? t('drStudents.resumeTitle') : t('drStudents.removeTitle')}
      >
        {actionTarget && actionType !== 'profile' && (
          <View style={{ gap: 16 }}>
            <Text style={{ fontSize: 14, color: c.text, opacity: 0.7, textAlign: 'center' }}>
              {actionType === 'suspend'
                ? t('drStudents.suspendPrompt', { name: actionTarget.student?.full_name, course: actionTarget.course?.title })
                : actionType === 'resume'
                ? t('drStudents.resumePrompt', { name: actionTarget.student?.full_name, course: actionTarget.course?.title })
                : t('drStudents.removePrompt', { name: actionTarget.student?.full_name, course: actionTarget.course?.title })}
            </Text>
            <NeuButton
              label={actionLoading ? t('common.processing') : actionType === 'suspend' ? t('drStudents.suspend') : actionType === 'resume' ? t('drStudents.resume') : t('common.remove')}
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
          title={t('drStudents.profileTitle')}
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
          const accountStatus = s?.status ? statusLabel(s.status as string, t) : null;

          // Registration date
          const registeredDate = s?.created_at
            ? new Date(s.created_at).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : null;

          // Always-shown student info rows (Phone and ID always present even if "Not Available")
          const infoRows: { label: string; value: string; highlight?: boolean; mono?: boolean; copyable?: boolean }[] = [
            { label: t('drStudents.fullName'),      value: s?.full_name ?? '—' },
            { label: t('common.email'),             value: getPublicEmail(s) ?? '—' },
            { label: t('drStudents.phoneNumber'),   value: phoneDisplay ?? t('drStudents.notAvailable'), highlight: !phoneDisplay },
            { label: t('drStudents.id'),            value: s?.public_user_id ?? t('drStudents.notAvailable'), highlight: !s?.public_user_id, mono: true, copyable: !!s?.public_user_id },
            { label: t('drStudents.accountStatus'), value: accountStatus ?? '—' },
            { label: t('drStudents.registered'),    value: registeredDate ?? '—' },
          ];

          // Optional enrollment-context rows
          const contextRows: { label: string; value: string | undefined }[] = [
            { label: t('drStudents.university'),       value: s?.university?.name },
            { label: t('drStudents.faculty'),          value: s?.faculty?.name },
            { label: t('drStudents.academicLevel'),    value: s?.academic_level?.name },
            { label: t('drStudents.course'),           value: actionTarget.course?.title },
            { label: t('drStudents.enrolledOn'),       value: new Date(actionTarget.enrolled_at).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
            { label: t('drStudents.enrollmentStatus'), value: statusLabel(actionTarget.status, t) },
            { label: t('drStudents.method'),           value: actionTarget.activation_method === 'credits' ? t('drStudents.credits') : actionTarget.activation_method },
          ].filter(r => !!r.value) as { label: string; value: string }[];

          return (
            <View style={{ gap: 0 }}>
              {/* ── Identity header with the student's REAL photo ──
                  The doctor could previously only see text rows here, so an
                  uploaded profile picture was invisible even though the API
                  had already returned it. */}
              <View style={{ alignItems: 'center', gap: 6, paddingBottom: 14, marginBottom: 12, borderBottomWidth: 1, borderBottomColor: `${c.text}12` }}>
                <StudentAvatar student={s} size={76} radius={26} colors={c} />
                <Text style={{ fontSize: 16, fontWeight: '800', color: c.text, textAlign: 'center' }}>{s?.full_name ?? '—'}</Text>
                {Boolean(s?.public_user_id) && (
                  <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.9, color: c.primary, opacity: 0.8 }}>{s.public_user_id}</Text>
                )}
              </View>

              {/* ── Student Information section ── */}
              <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', ...mutedTextStyle(c, 0.4), marginBottom: 6 }}>
                {t('drStudents.studentInformation')}
              </Text>
              {infoRows.map(row => (
                <Pressable
                  key={row.label}
                  onPress={row.copyable ? () => { void Clipboard.setStringAsync(row.value); showToast({ type: 'success', message: t('drStudents.copied', { label: row.label }) }); } : undefined}
                  style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}
                >
                  <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5), flexShrink: 0 }}>{row.label}</Text>
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
                  <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', ...mutedTextStyle(c, 0.4), marginBottom: 6, marginTop: 16 }}>
                    {t('drStudents.enrollmentDetails')}
                  </Text>
                  {contextRows.map(row => (
                    <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
                      <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5) }}>{row.label}</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, maxWidth: '60%', textAlign: 'right' }} numberOfLines={1}>{row.value}</Text>
                    </View>
                  ))}
                </>
              )}
            </View>
          );
        })()}
      </ResponsiveModal>

      {/* ── Bulk confirmation modal — destructive actions never single-tap ──── */}
      <ResponsiveModal
        visible={bulkConfirm !== null && bulkResult === null}
        onClose={() => setBulkConfirm(null)}
        title={bulkConfirm === 'suspend' ? t('drStudents.bulkSuspendTitle') : bulkConfirm === 'resume' ? t('drStudents.bulkResumeTitle') : t('drStudents.bulkRemoveTitle')}
      >
        {bulkConfirm !== null && (
          <View style={{ gap: 16 }}>
            {/* Scope line in the confirmation itself: a destructive bulk action
                must name the course it was scoped to, not just a count. */}
            {selectionCourse && (
              <Text style={{ fontSize: 12.5, fontWeight: '700', ...mutedTextStyle(c, 0.6), textAlign: 'center' }} numberOfLines={2}>
                {t('bulk.courseScopeLabel', { course: selectionCourse.title })}
              </Text>
            )}
            <Text style={{ fontSize: 14, color: c.text, opacity: 0.7, textAlign: 'center' }}>
              {bulkConfirm === 'suspend'
                ? t('drStudents.bulkSuspendPrompt', { active: selectedActiveCount, total: selected.size })
                : bulkConfirm === 'resume'
                ? t('drStudents.bulkResumePrompt', { suspended: selectedSuspendedCount, total: selected.size })
                : tCount('drStudents.bulkRemovePrompt', selected.size)}
            </Text>
            <View style={{ gap: 8 }}>
              <NeuButton
                label={bulkExecuting
                  ? t('common.processing')
                  : bulkConfirm === 'suspend'
                  ? t('drStudents.suspendCount', { count: selectedActiveCount || selected.size })
                  : bulkConfirm === 'resume'
                  ? t('drStudents.resumeCount', { count: selectedSuspendedCount || selected.size })
                  : t('drStudents.removeCount', { count: selected.size })}
                onPress={() => void executeBulk(bulkConfirm)}
                loading={bulkExecuting}
                disabled={bulkExecuting}
                style={{ backgroundColor: bulkConfirm === 'remove' ? '#DC2626' : bulkConfirm === 'suspend' ? '#D97706' : '#16A34A' }}
              />
              <Pressable onPress={() => setBulkConfirm(null)} disabled={bulkExecuting}
                style={{ paddingVertical: 10, alignItems: 'center' }}>
                <Text style={{ fontSize: 13, fontWeight: '600', ...mutedTextStyle(c, 0.55) }}>{t('common.cancel')}</Text>
              </Pressable>
            </View>
          </View>
        )}
      </ResponsiveModal>

      {/* ── Bulk result modal — accurate per-row outcome, never a false total ── */}
      <ResponsiveModal
        visible={bulkResult !== null}
        onClose={() => { setBulkResult(null); setBulkConfirm(null); }}
        title={t('drStudents.bulkResultTitle')}
      >
        {bulkResult && (
          <View style={{ gap: 14 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, textAlign: 'center' }}>
              {t('drStudents.resultSummary', {
                succeeded: bulkResult.succeeded,
                failed: bulkResult.failed,
                skipped: bulkResult.skipped,
              })}
            </Text>
            {bulkResult.failed > 0 && (
              <View style={{ gap: 6 }}>
                {bulkResult.results.filter(r => r.status === 'failed').map(r => {
                  const enrollment = enrollments.find(e => e.id === r.id);
                  const name = enrollment?.student?.full_name ?? r.id.slice(0, 8);
                  return (
                    <View key={r.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
                      <Text style={{ fontSize: 13, color: c.text }} numberOfLines={1}>{name}</Text>
                      <Text style={{ fontSize: 12, color: '#DC2626', fontWeight: '600' }}>
                        {r.reason === 'not_authorized'
                          ? t('drStudents.notAuthorized')
                          : r.reason === 'not_found'
                          ? t('drStudents.notFound')
                          : r.reason === 'not_in_course'
                          ? t('drStudents.notInCourse')
                          : t('common.failed')}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}
            <NeuButton label={t('common.done')} onPress={() => { setBulkResult(null); setBulkConfirm(null); }} />
          </View>
        )}
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
      <Text style={{ ...mutedTextStyle(c, 0.4), fontSize: 14, fontWeight: '600', marginTop: 12 }}>{label}</Text>
    </View>
  );
}
