/**
 * Enrollment Manager — Admin & Super Admin only
 * v151: visibility_level enum (all | admin_only | super_admin_only)
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  TextInput, ActivityIndicator, KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import {
  UserPlus, BookOpen, Search, X, ChevronDown, Check,
  Trash2, AlertCircle, CheckCircle, Users, Eye, EyeOff, ShieldOff,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors } from '@/lib/neu';
import { useProfileStore } from '@/lib/store';
import { useDebounce } from '@/lib/useDebounce';
import {
  searchUsersForEnrollment,
  getAdminAllCourses,
  adminEnrollUser,
  adminRemoveEnrollment,
  adminSetEnrollmentVisibility,
  getAdminCourseEnrollments,
  ENROLLMENT_VISIBILITY_OPTIONS,
  type AdminUserSearchResult,
  type AdminCourse,
  type AdminEnrollmentRow,
  type EnrollmentVisibility,
} from '@/lib/api';

type Tab = 'enroll' | 'view';

// ─── Visibility meta ──────────────────────────────────────────────────────────
const VIS_META: Record<EnrollmentVisibility, { label: string; color: string; icon: React.ElementType }> = {
  all:              { label: 'Visible to all',           color: '#16A34A', icon: Eye      },
  admin_only:       { label: 'Hidden from instructors',  color: '#D97706', icon: EyeOff   },
  super_admin_only: { label: 'Hidden from admins & instructors', color: '#DC2626', icon: ShieldOff },
};

// ─── Shared input style helper ────────────────────────────────────────────────
function inputStyle(c: typeof neuColors.light) {
  return {
    backgroundColor: c.base,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    shadowColor: c.shadowDark,
    shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 5,
    color: c.text,
    fontSize: 15,
  } as const;
}

// ─── Visibility badge (compact) ───────────────────────────────────────────────
function VisibilityBadge({ level, c }: { level: EnrollmentVisibility; c: typeof neuColors.light }) {
  const meta = VIS_META[level];
  const Icon = meta.icon;
  if (level === 'all') return null;
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 3,
      paddingHorizontal: 6, paddingVertical: 2,
      backgroundColor: `${meta.color}18`, borderRadius: 6,
    }}>
      <Icon size={10} color={meta.color} />
      <Text style={{ fontSize: 10, fontWeight: '600', color: meta.color }}>
        {level === 'admin_only' ? 'Admin only' : 'SA only'}
      </Text>
    </View>
  );
}

// ─── 3-option visibility radio (for enrollment row inline picker) ─────────────
function VisibilityRadioRow({
  current, onChange, loading, c,
}: {
  current: EnrollmentVisibility;
  onChange: (v: EnrollmentVisibility) => void;
  loading: boolean;
  c: typeof neuColors.light;
}) {
  return (
    <View style={{ gap: 4, marginTop: 8 }}>
      {ENROLLMENT_VISIBILITY_OPTIONS.map(opt => {
        const active = current === opt.value;
        const meta = VIS_META[opt.value];
        const Icon = meta.icon;
        return (
          <Pressable
            key={opt.value}
            onPress={() => !loading && onChange(opt.value)}
            disabled={loading}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 10,
              padding: 10, borderRadius: 11,
              backgroundColor: active ? `${meta.color}12` : 'transparent',
              borderWidth: active ? 1.5 : 1,
              borderColor: active ? `${meta.color}55` : `${c.text}18`,
              opacity: loading ? 0.6 : 1,
            }}
          >
            <View style={{
              width: 18, height: 18, borderRadius: 9,
              borderWidth: 2,
              borderColor: active ? meta.color : `${c.text}44`,
              backgroundColor: active ? meta.color : 'transparent',
              alignItems: 'center', justifyContent: 'center',
            }}>
              {active && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' }} />}
            </View>
            <Icon size={14} color={active ? meta.color : `${c.text}77`} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: active ? '600' : '400', color: active ? meta.color : c.text }}>
                {opt.label}
              </Text>
              {opt.description !== 'Default' && (
                <Text style={{ fontSize: 11, color: `${c.text}66` }}>{opt.description}</Text>
              )}
            </View>
            {active && loading && <ActivityIndicator size="small" color={meta.color} />}
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── User result row ──────────────────────────────────────────────────────────
function UserRow({ user, selected, onPress, c }: {
  user: AdminUserSearchResult; selected: boolean; onPress: () => void; c: typeof neuColors.light;
}) {
  const displayEmail = user.profile_email || user.email;
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingVertical: 10, paddingHorizontal: 14,
        backgroundColor: selected ? `${c.primary}18` : c.base,
        borderRadius: 12,
        borderWidth: selected ? 1.5 : 0, borderColor: selected ? c.primary : 'transparent',
        marginBottom: 6,
        shadowColor: c.shadowDark, shadowOffset: { width: 1, height: 2 }, shadowOpacity: 0.35, shadowRadius: 4,
      }}
    >
      <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: `${c.primary}22`, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: c.primary }}>{(user.full_name || '?').charAt(0).toUpperCase()}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }} numberOfLines={1}>{user.full_name || '(No name)'}</Text>
        <Text style={{ fontSize: 12, color: `${c.text}88` }} numberOfLines={1}>{displayEmail}</Text>
        {user.watermark_id && <Text style={{ fontSize: 11, color: `${c.text}66` }}>{user.watermark_id}</Text>}
      </View>
      <View style={{ paddingHorizontal: 8, paddingVertical: 3, backgroundColor: `${c.primary}18`, borderRadius: 8 }}>
        <Text style={{ fontSize: 11, color: c.primary, fontWeight: '600' }}>{user.role}</Text>
      </View>
      {selected && <Check size={18} color={c.primary} />}
    </Pressable>
  );
}

// ─── Course picker row ────────────────────────────────────────────────────────
function CourseRow({ course, selected, onPress, c }: {
  course: AdminCourse; selected: boolean; onPress: () => void; c: typeof neuColors.light;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingVertical: 10, paddingHorizontal: 14,
        backgroundColor: selected ? `${c.primary}18` : c.base,
        borderRadius: 12,
        borderWidth: selected ? 1.5 : 0, borderColor: selected ? c.primary : 'transparent',
        marginBottom: 6,
        shadowColor: c.shadowDark, shadowOffset: { width: 1, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4,
      }}
    >
      <BookOpen size={18} color={selected ? c.primary : `${c.text}99`} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }} numberOfLines={2}>{course.title}</Text>
        {course.doctor && <Text style={{ fontSize: 12, color: `${c.text}77` }} numberOfLines={1}>{course.doctor.full_name}</Text>}
      </View>
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, backgroundColor: course.status === 'published' ? '#16A34A18' : '#D9770618', borderRadius: 8 }}>
        <Text style={{ fontSize: 10, fontWeight: '700', color: course.status === 'published' ? '#16A34A' : '#D97706', textTransform: 'uppercase' }}>{course.status}</Text>
      </View>
      {selected && <Check size={18} color={c.primary} />}
    </Pressable>
  );
}

// ─── Enrollment row ───────────────────────────────────────────────────────────
function EnrollmentRow({ row, isSuperAdmin, onRemove, onVisibilityChange, changingVisibility, c }: {
  row: AdminEnrollmentRow;
  isSuperAdmin: boolean;
  onRemove: () => void;
  onVisibilityChange: (v: EnrollmentVisibility) => void;
  changingVisibility: boolean;
  c: typeof neuColors.light;
}) {
  const [expanded, setExpanded] = useState(false);
  const displayName = row.student?.full_name || '(Unknown)';
  const displayEmail = row.student?.profile_email || row.student?.email || '';
  const date = new Date(row.enrolled_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const visLevel: EnrollmentVisibility = row.visibility_level ?? 'all';
  const isRestricted = visLevel !== 'all';
  const meta = VIS_META[visLevel];

  return (
    <View style={{
      backgroundColor: isRestricted ? `${meta.color}0a` : c.base,
      borderRadius: 12, marginBottom: 6,
      borderWidth: isRestricted ? 1 : 0, borderColor: isRestricted ? `${meta.color}33` : 'transparent',
      shadowColor: c.shadowDark, shadowOffset: { width: 1, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4,
      overflow: 'hidden',
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 14 }}>
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: isRestricted ? `${meta.color}18` : `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: isRestricted ? meta.color : c.primary }}>{displayName.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: isRestricted ? `${c.text}99` : c.text }} numberOfLines={1}>{displayName}</Text>
            <VisibilityBadge level={visLevel} c={c} />
          </View>
          <Text style={{ fontSize: 12, color: `${c.text}77` }} numberOfLines={1}>{displayEmail}</Text>
          <Text style={{ fontSize: 11, color: `${c.text}55` }}>{date} · {row.enrollment_method ?? 'direct'}</Text>
        </View>
        {/* Super Admin: tap to expand visibility picker */}
        {isSuperAdmin && (
          <Pressable
            onPress={() => setExpanded(v => !v)}
            style={{ padding: 7, borderRadius: 9, backgroundColor: `${meta.color}15` }}
          >
            {expanded ? <ChevronDown size={15} color={meta.color} /> : <meta.icon size={15} color={meta.color} />}
          </Pressable>
        )}
        <Pressable onPress={onRemove} style={{ padding: 8, borderRadius: 10, backgroundColor: '#DC262618' }}>
          <Trash2 size={16} color="#DC2626" />
        </Pressable>
      </View>
      {/* Expanded visibility picker (super_admin only) */}
      {isSuperAdmin && expanded && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
          <Text style={{ fontSize: 11, fontWeight: '600', color: `${c.text}66`, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 }}>Visibility</Text>
          <VisibilityRadioRow current={visLevel} onChange={v => { onVisibilityChange(v); setExpanded(false); }} loading={changingVisibility} c={c} />
        </View>
      )}
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function EnrollmentManager() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const { profile } = useProfileStore();
  const isSuperAdmin = profile?.role === 'super_admin';

  const [activeTab, setActiveTab] = useState<Tab>('enroll');

  // ── Enroll tab ────────────────────────────────────────────────────────────
  const [userQuery, setUserQuery] = useState('');
  const debouncedUserQuery = useDebounce(userQuery, 350);
  const [searchResults, setSearchResults] = useState<AdminUserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedUser, setSelectedUser] = useState<AdminUserSearchResult | null>(null);
  const [courses, setCourses] = useState<AdminCourse[]>([]);
  const [coursesLoading, setCoursesLoading] = useState(false);
  const [showCoursePicker, setShowCoursePicker] = useState(false);
  const [courseSearch, setCourseSearch] = useState('');
  const [selectedCourse, setSelectedCourse] = useState<AdminCourse | null>(null);
  const [visibilityLevel, setVisibilityLevel] = useState<EnrollmentVisibility>('all');
  const [enrolling, setEnrolling] = useState(false);
  const [enrollFeedback, setEnrollFeedback] = useState<{ type: 'success' | 'warning' | 'error'; text: string } | null>(null);

  // ── View tab ──────────────────────────────────────────────────────────────
  const [viewCourse, setViewCourse] = useState<AdminCourse | null>(null);
  const [showViewCoursePicker, setShowViewCoursePicker] = useState(false);
  const [viewCourseSearch, setViewCourseSearch] = useState('');
  const [enrollments, setEnrollments] = useState<AdminEnrollmentRow[]>([]);
  const [enrollmentsLoading, setEnrollmentsLoading] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<AdminEnrollmentRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [changingVisibilityId, setChangingVisibilityId] = useState<string | null>(null);

  // ── Data loading ──────────────────────────────────────────────────────────
  useFocusEffect(useCallback(() => {
    (async () => {
      setCoursesLoading(true);
      try { setCourses(await getAdminAllCourses()); }
      catch { showToast({ type: 'error', message: 'Failed to load courses' }); }
      finally { setCoursesLoading(false); }
    })();
  }, []));

  useFocusEffect(useCallback(() => {
    if (!debouncedUserQuery.trim()) { setSearchResults([]); return; }
    let active = true;
    (async () => {
      setSearching(true);
      try { const u = await searchUsersForEnrollment(debouncedUserQuery.trim()); if (active) setSearchResults(u); }
      catch { if (active) setSearchResults([]); }
      finally { if (active) setSearching(false); }
    })();
    return () => { active = false; };
  }, [debouncedUserQuery]));

  useFocusEffect(useCallback(() => {
    if (!viewCourse) return;
    let active = true;
    (async () => {
      setEnrollmentsLoading(true);
      try { const d = await getAdminCourseEnrollments(viewCourse.id); if (active) setEnrollments(d); }
      catch (e: any) { if (active) showToast({ type: 'error', message: e?.message ?? 'Failed to load enrollments' }); }
      finally { if (active) setEnrollmentsLoading(false); }
    })();
    return () => { active = false; };
  }, [viewCourse?.id]));

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleEnroll = async () => {
    if (!selectedUser || !selectedCourse) return;
    setEnrolling(true);
    setEnrollFeedback(null);
    try {
      const result = await adminEnrollUser(
        selectedUser.id, selectedCourse.id,
        isSuperAdmin ? visibilityLevel : 'all',
      );
      if (result.already_enrolled) {
        setEnrollFeedback({ type: 'warning', text: 'This user is already enrolled in this course.' });
      } else {
        const vis = result.visibility_level ?? 'all';
        const visLabel = VIS_META[vis as EnrollmentVisibility]?.label ?? vis;
        const note = vis !== 'all' ? ` (${visLabel})` : '';
        setEnrollFeedback({ type: 'success', text: `User enrolled successfully.${note}` });
        showToast({ type: 'success', message: `Enrolled successfully.${note}` });
      }
    } catch (e: any) {
      const msg: string = e?.message ?? '';
      setEnrollFeedback({
        type: 'error',
        text: msg.includes('FORBIDDEN') || msg.includes('403')
          ? 'You do not have permission to perform this action.'
          : msg || 'Enrollment failed. Please try again.',
      });
    } finally { setEnrolling(false); }
  };

  const handleVisibilityChange = async (row: AdminEnrollmentRow, newLevel: EnrollmentVisibility) => {
    setChangingVisibilityId(row.id);
    try {
      await adminSetEnrollmentVisibility(row.id, newLevel);
      setEnrollments(prev => prev.map(e => e.id === row.id ? { ...e, visibility_level: newLevel } : e));
      showToast({ type: 'success', message: `Visibility set to: ${VIS_META[newLevel].label}` });
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message || 'Failed to update visibility' });
    } finally { setChangingVisibilityId(null); }
  };

  const handleRemoveConfirm = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await adminRemoveEnrollment(removeTarget.id);
      setEnrollments(prev => prev.filter(e => e.id !== removeTarget.id));
      showToast({ type: 'success', message: 'Enrollment removed.' });
      setRemoveTarget(null);
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message || 'Remove failed' });
    } finally { setRemoving(false); }
  };

  const clearEnrollForm = () => {
    setSelectedUser(null); setUserQuery(''); setSearchResults([]);
    setSelectedCourse(null); setVisibilityLevel('all'); setEnrollFeedback(null);
  };

  // ── Filtered lists ────────────────────────────────────────────────────────
  const filteredCourses = courses.filter(x => !courseSearch || x.title.toLowerCase().includes(courseSearch.toLowerCase()));
  const filteredViewCourses = courses.filter(x => !viewCourseSearch || x.title.toLowerCase().includes(viewCourseSearch.toLowerCase()));

  // ── Styles ────────────────────────────────────────────────────────────────
  const neuSurface = {
    backgroundColor: c.base, borderRadius: 18, padding: 16,
    shadowColor: c.shadowDark, shadowOffset: { width: 4, height: 4 }, shadowOpacity: 0.55, shadowRadius: 10,
  } as const;

  const feedbackColor = enrollFeedback?.type === 'success' ? '#16A34A' : enrollFeedback?.type === 'warning' ? '#D97706' : '#DC2626';

  return (
    <KeyboardAvoidingView
      behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: c.base }}
    >
      <PageHeader title="Enrollment Manager" />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: Math.max(insets.bottom, 30) + 30 }}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
      >
        {/* Tab bar */}
        <View style={{
          flexDirection: 'row', backgroundColor: c.base, borderRadius: 14,
          padding: 4, marginBottom: 20, gap: 4,
          shadowColor: c.shadowDark, shadowOffset: { width: 3, height: 3 }, shadowOpacity: 0.45, shadowRadius: 8,
        }}>
          {([{ key: 'enroll', icon: UserPlus, label: 'Enroll User' }, { key: 'view', icon: Users, label: 'View Enrollments' }] as const).map(({ key, icon: Icon, label }) => {
            const active = activeTab === key;
            return (
              <Pressable key={key} onPress={() => setActiveTab(key)} style={{
                flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                paddingVertical: 10, borderRadius: 11,
                backgroundColor: active ? c.primary : 'transparent',
              }}>
                <Icon size={16} color={active ? '#fff' : `${c.text}99`} />
                <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#fff' : `${c.text}99` }}>{label}</Text>
              </Pressable>
            );
          })}
        </View>

        {/* ── ENROLL TAB ─────────────────────────────────────────────────── */}
        {activeTab === 'enroll' && (
          <View style={{ gap: 16 }}>
            {/* Step 1: Select student */}
            <NeuCard>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: `${c.primary}22`, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontWeight: '700', color: c.primary, fontSize: 13 }}>1</Text>
                </View>
                <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>Select Student</Text>
              </View>
              {selectedUser ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: `${c.primary}14`, borderRadius: 12, padding: 12, borderWidth: 1.5, borderColor: `${c.primary}55` }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>{selectedUser.full_name.charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{selectedUser.full_name}</Text>
                    <Text style={{ fontSize: 12, color: `${c.text}88` }}>{selectedUser.profile_email || selectedUser.email}</Text>
                  </View>
                  <Pressable onPress={() => { setSelectedUser(null); setUserQuery(''); setEnrollFeedback(null); }} style={{ padding: 6, borderRadius: 8, backgroundColor: '#DC262618' }}>
                    <X size={15} color="#DC2626" />
                  </Pressable>
                </View>
              ) : (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, ...inputStyle(c), paddingVertical: 0 }}>
                    <Search size={16} color={`${c.text}66`} style={{ flexShrink: 0 }} />
                    <TextInput
                      value={userQuery}
                      onChangeText={t => { setUserQuery(t); setEnrollFeedback(null); }}
                      placeholder="Search by name, email, watermark ID, or user ID"
                      placeholderTextColor={`${c.text}55`}
                      style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text, paddingVertical: 12 }}
                      autoCapitalize="none" autoCorrect={false}
                    />
                    {searching && <ActivityIndicator size="small" color={c.primary} />}
                    {userQuery.length > 0 && !searching && (
                      <Pressable onPress={() => { setUserQuery(''); setSearchResults([]); }}><X size={15} color={`${c.text}77`} /></Pressable>
                    )}
                  </View>
                  {searchResults.length > 0 && (
                    <View style={{ marginTop: 10 }}>
                      {searchResults.map(u => (
                        <UserRow key={u.id} user={u} selected={false} onPress={() => { setSelectedUser(u); setUserQuery(''); setSearchResults([]); setEnrollFeedback(null); }} c={c} />
                      ))}
                    </View>
                  )}
                  {debouncedUserQuery.trim().length > 0 && !searching && searchResults.length === 0 && (
                    <Text style={{ marginTop: 10, fontSize: 13, color: `${c.text}77`, textAlign: 'center' }}>No users found</Text>
                  )}
                </>
              )}
            </NeuCard>

            {/* Step 2: Select course */}
            <NeuCard>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: `${c.primary}22`, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontWeight: '700', color: c.primary, fontSize: 13 }}>2</Text>
                </View>
                <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>Select Course</Text>
              </View>
              <Pressable
                onPress={() => { setShowCoursePicker(true); setEnrollFeedback(null); }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, ...neuSurface, padding: 13, borderRadius: 13, borderWidth: selectedCourse ? 1.5 : 0, borderColor: selectedCourse ? `${c.primary}55` : 'transparent', backgroundColor: selectedCourse ? `${c.primary}0e` : c.base }}
              >
                <BookOpen size={18} color={selectedCourse ? c.primary : `${c.text}77`} />
                <Text style={{ flex: 1, fontSize: 14, color: selectedCourse ? c.text : `${c.text}77`, fontWeight: selectedCourse ? '600' : '400' }} numberOfLines={2}>
                  {selectedCourse ? selectedCourse.title : 'Tap to choose a course…'}
                </Text>
                {selectedCourse
                  ? <Pressable onPress={() => { setSelectedCourse(null); setEnrollFeedback(null); }}><X size={16} color={`${c.text}77`} /></Pressable>
                  : <ChevronDown size={16} color={`${c.text}66`} />}
              </Pressable>
            </NeuCard>

            {/* Step 3: Visibility (Super Admin only) */}
            {isSuperAdmin && (
              <NeuCard>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
                  <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: `${c.primary}22`, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontWeight: '700', color: c.primary, fontSize: 13 }}>3</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>Visibility</Text>
                    <Text style={{ fontSize: 11, color: `${c.text}66`, marginTop: 2 }}>Super Admin only</Text>
                  </View>
                </View>
                <VisibilityRadioRow current={visibilityLevel} onChange={v => { setVisibilityLevel(v); setEnrollFeedback(null); }} loading={false} c={c} />
              </NeuCard>
            )}

            {/* Feedback */}
            {enrollFeedback && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: `${feedbackColor}14`, borderRadius: 12, padding: 14, borderLeftWidth: 3, borderLeftColor: feedbackColor }}>
                {enrollFeedback.type === 'success' ? <CheckCircle size={18} color={feedbackColor} /> : <AlertCircle size={18} color={feedbackColor} />}
                <Text style={{ flex: 1, fontSize: 14, color: feedbackColor, fontWeight: '500' }}>{enrollFeedback.text}</Text>
              </View>
            )}

            <NeuButton label="Enroll" icon={<UserPlus size={18} color="#fff" />} onPress={handleEnroll} loading={enrolling} disabled={!selectedUser || !selectedCourse} style={{ marginTop: 4 }} />

            {(selectedUser || selectedCourse) && (
              <Pressable onPress={clearEnrollForm} style={{ alignItems: 'center', paddingTop: 4 }}>
                <Text style={{ fontSize: 13, color: `${c.text}77` }}>Clear selection</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* ── VIEW ENROLLMENTS TAB ────────────────────────────────────────── */}
        {activeTab === 'view' && (
          <View style={{ gap: 16 }}>
            <NeuCard>
              <Text style={{ fontSize: 12, fontWeight: '700', color: `${c.text}77`, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>Course</Text>
              <Pressable
                onPress={() => setShowViewCoursePicker(true)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, ...neuSurface, padding: 13, borderRadius: 13, borderWidth: viewCourse ? 1.5 : 0, borderColor: viewCourse ? `${c.primary}55` : 'transparent', backgroundColor: viewCourse ? `${c.primary}0e` : c.base }}
              >
                <BookOpen size={18} color={viewCourse ? c.primary : `${c.text}77`} />
                <Text style={{ flex: 1, fontSize: 14, color: viewCourse ? c.text : `${c.text}77`, fontWeight: viewCourse ? '600' : '400' }} numberOfLines={2}>
                  {viewCourse ? viewCourse.title : 'Select a course to view enrollments…'}
                </Text>
                <ChevronDown size={16} color={`${c.text}66`} />
              </Pressable>
            </NeuCard>

            {viewCourse && (
              enrollmentsLoading ? (
                <View style={{ alignItems: 'center', paddingVertical: 32 }}><ActivityIndicator size="large" color={c.primary} /></View>
              ) : enrollments.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 32, gap: 8 }}>
                  <Users size={36} color={`${c.text}44`} />
                  <Text style={{ fontSize: 14, color: `${c.text}77` }}>No enrollments for this course</Text>
                </View>
              ) : (
                <NeuCard>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: `${c.text}77`, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 }}>
                    {enrollments.length} Enrolled Student{enrollments.length !== 1 ? 's' : ''}
                  </Text>
                  {enrollments.map(row => (
                    <EnrollmentRow
                      key={row.id}
                      row={row}
                      isSuperAdmin={isSuperAdmin}
                      onRemove={() => setRemoveTarget(row)}
                      onVisibilityChange={v => handleVisibilityChange(row, v)}
                      changingVisibility={changingVisibilityId === row.id}
                      c={c}
                    />
                  ))}
                </NeuCard>
              )
            )}
          </View>
        )}
      </ScrollView>

      {/* Course picker modal (enroll tab) */}
      <ResponsiveModal visible={showCoursePicker} onClose={() => { setShowCoursePicker(false); setCourseSearch(''); }} title="Select Course">
        <View style={{ marginBottom: 12, ...inputStyle(c), flexDirection: 'row', alignItems: 'center', gap: 8, padding: 0, paddingHorizontal: 12 }}>
          <Search size={15} color={`${c.text}66`} />
          <TextInput value={courseSearch} onChangeText={setCourseSearch} placeholder="Filter courses…" placeholderTextColor={`${c.text}55`} style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 11 }} />
        </View>
        <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
          {coursesLoading ? <ActivityIndicator style={{ padding: 24 }} color={c.primary} /> :
           filteredCourses.length === 0 ? <Text style={{ textAlign: 'center', color: `${c.text}77`, padding: 24 }}>No courses found</Text> :
           filteredCourses.map(course => (
             <CourseRow key={course.id} course={course} selected={selectedCourse?.id === course.id}
               onPress={() => { setSelectedCourse(course); setShowCoursePicker(false); setCourseSearch(''); setEnrollFeedback(null); }} c={c} />
           ))}
        </ScrollView>
      </ResponsiveModal>

      {/* Course picker modal (view tab) */}
      <ResponsiveModal visible={showViewCoursePicker} onClose={() => { setShowViewCoursePicker(false); setViewCourseSearch(''); }} title="Select Course">
        <View style={{ marginBottom: 12, ...inputStyle(c), flexDirection: 'row', alignItems: 'center', gap: 8, padding: 0, paddingHorizontal: 12 }}>
          <Search size={15} color={`${c.text}66`} />
          <TextInput value={viewCourseSearch} onChangeText={setViewCourseSearch} placeholder="Filter courses…" placeholderTextColor={`${c.text}55`} style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 11 }} />
        </View>
        <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
          {coursesLoading ? <ActivityIndicator style={{ padding: 24 }} color={c.primary} /> :
           filteredViewCourses.length === 0 ? <Text style={{ textAlign: 'center', color: `${c.text}77`, padding: 24 }}>No courses found</Text> :
           filteredViewCourses.map(course => (
             <CourseRow key={course.id} course={course} selected={viewCourse?.id === course.id}
               onPress={() => { setViewCourse(course); setShowViewCoursePicker(false); setViewCourseSearch(''); setEnrollments([]); }} c={c} />
           ))}
        </ScrollView>
      </ResponsiveModal>

      {/* Remove confirmation */}
      <ResponsiveModal
        visible={!!removeTarget} onClose={() => setRemoveTarget(null)} title="Remove Enrollment"
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={() => setRemoveTarget(null)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Remove" onPress={handleRemoveConfirm} loading={removing} style={{ flex: 1, backgroundColor: '#DC262618' }} />
          </View>
        }
      >
        <View style={{ alignItems: 'center', gap: 12, paddingVertical: 8 }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
            <Trash2 size={26} color="#DC2626" />
          </View>
          <Text style={{ fontSize: 15, color: c.text, textAlign: 'center', fontWeight: '500' }}>Remove this user from the course?</Text>
          {removeTarget && <Text style={{ fontSize: 13, color: `${c.text}88`, textAlign: 'center' }}>{removeTarget.student?.full_name ?? 'Unknown user'}</Text>}
        </View>
      </ResponsiveModal>
    </KeyboardAvoidingView>
  );
}

// ─── Shared input style helper ────────────────────────────────────────────────
