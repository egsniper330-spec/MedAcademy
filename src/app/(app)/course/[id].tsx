import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, Pressable, ActivityIndicator, RefreshControl, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft, BookOpen, Calendar, ChevronDown, ChevronRight, Clock, GraduationCap,
  Globe, Tag, Play, Lock, MessageCircle, CheckCircle, Paperclip, Archive,
} from 'lucide-react-native';
import { getCourseById, getCourseProgress, getLessonProgress, getMySubscriptions, calcCourseDuration, calcRemainingTime, calcCompletedTime, formatStudyTime } from '@/lib/api';
import { useProfileStore } from '@/lib/store';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { CourseProgressBar } from '@/components/CourseProgressBar';
import { ContactSheet } from '@/components/ContactSheet';
import { neuColors, useLayout, safeTop, safeLeft, safeBottom } from '@/lib/neu';
import type { RelativePathString } from 'expo-router';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ── Session-scoped expanded-section state ─────────────────────────────────────
// Survives navigation within the same app session (lesson open → back → course).
// Persists until the app is closed/restarted; never written to the database.
const _sectionStateCache = new Map<string, Set<string>>();

const DIFFICULTY_COLORS: Record<string, string> = {
  beginner: '#16A34A', intermediate: '#D97706', advanced: '#DC2626', all_levels: '#2563EB',
};

function formatRemaining(secs: number): string {
  if (!secs || secs <= 0) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m remaining`;
  return `${m}m remaining`;
}

export default function CourseDetail() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const layout = useLayout();
  const insets = layout.insets;
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useProfileStore();

  const [course, setCourse] = useState<any>(null);
  const [progress, setProgress] = useState<any[]>([]);
  const [courseProgress, setCourseProgress] = useState<any>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Initialise from session cache so state survives lesson → back navigation
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => id ? (_sectionStateCache.get(id) ?? new Set<string>()) : new Set<string>()
  );
  const [showContact, setShowContact] = useState(false);

  const loadData = useCallback(async () => {
    if (!id) return;
    try {
      const isStudent = profile?.role === 'student';
      const [courseData, prog] = await Promise.all([
        getCourseById(id),
        profile ? getLessonProgress(profile.id, id) : Promise.resolve([]),
      ]);
      setCourse(courseData);
      setProgress(prog);
      if (courseData?.sections?.length) {
        // Restore from session cache; only reset if no prior state exists for this course
        if (!_sectionStateCache.has(id!)) {
          setExpandedSections(new Set());
        }
        // else: leave existing expanded state untouched — user may have expanded sections
      }
      if (isStudent && profile) {
        const [subs, cp] = await Promise.all([
          getMySubscriptions(profile.id),
          getCourseProgress(profile.id, id).catch(() => null),
        ]);
        setIsSubscribed(subs.some((s: any) => s.course_id === id || s.course?.id === id));
        setCourseProgress(cp);
      }
    } catch {}
    setLoading(false);
  }, [id, profile]);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  // Persist expanded state to session cache whenever it changes
  useEffect(() => {
    if (id) _sectionStateCache.set(id, expandedSections);
  }, [id, expandedSections]);

  // Accordion toggle — persists to session cache via the useEffect above
  const toggleSection = (sectionId: string) => {
    LayoutAnimation.configureNext({
      duration: 250,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);   // manual collapse — honour it
      } else {
        next.add(sectionId);      // expand; allow multiple open at once
      }
      return next;
    });
  };

  const isStudent = profile?.role === 'student';

  const completedIds = new Set(progress.filter((p: any) => p.completed).map((p: any) => p.lesson_id));
  // Defense-in-depth: strip draft lessons from every student-facing derived value.
  // The primary gate is RLS (DB never returns drafts to students); this is the
  // client-side safety net in case a cached response or future RLS change leaks one.
  const allLessons = (course?.sections ?? []).flatMap((s: any) =>
    (s.lessons ?? []).filter((l: any) => !isStudent || l.status === 'published')
  );
  const completedCount = allLessons.filter((l: any) => completedIds.has(l.id)).length;
  const progressPct = allLessons.length > 0 ? Math.round((completedCount / allLessons.length) * 100) : 0;

  // Derived study-time stats from estimated_minutes
  const totalStudyMin = calcCourseDuration(course?.sections ?? []);
  const remainingMin = calcRemainingTime(course?.sections ?? [], completedIds);
  const completedMin = calcCompletedTime(course?.sections ?? [], completedIds);

  // For sequential learning: lesson is locked if a previous lesson is not completed
  const isLessonLocked = (lesson: any, lessonIdx: number, section: any) => {
    if (!course?.sequential_learning) return false;
    if (!isSubscribed) return !lesson.is_preview;
    if (lessonIdx === 0) return false;
    const prev = (section.lessons ?? [])[lessonIdx - 1];
    return prev && !completedIds.has(prev.id);
  };

  if (loading) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.base }}>
      <ActivityIndicator color={c.primary} size="large" />
    </View>
  );
  if (!course) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.base }}>
      <Text style={{ color: c.text, opacity: 0.5 }}>Course not found</Text>
    </View>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>

      {/* Cover image — aspect ratio stays correct on landscape/tablet */}
      {(course.image_url || course.cover_url || course.thumbnail_url) ? (
        <Image
          source={{ uri: course.image_url ?? course.cover_url ?? course.thumbnail_url }}
          style={{ width: '100%', aspectRatio: 16/9 }}
          contentFit="cover"
        />
      ) : (
        <View style={{ width: '100%', aspectRatio: 16/9, backgroundColor: `${c.primary}12`, alignItems: 'center', justifyContent: 'center' }}>
          <GraduationCap size={52} color={c.primary} opacity={0.2} />
        </View>
      )}

      {/* Back button overlay — position from safe-area insets via headerTokens */}
      <View style={{ position: 'absolute', top: layout.headerTop, left: layout.headerLeft }}>
        <Pressable onPress={() => router.back()}
          hitSlop={8}
          accessibilityLabel="Go back"
          accessibilityRole="button"
          style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${c.base}ee`, alignItems: 'center', justifyContent: 'center' }}>
          <ArrowLeft size={22} color={c.text} opacity={0.75} />
        </Pressable>
      </View>

      <View style={{ padding: layout.screenPx, gap: 16 }}>
        {/* Archived banner */}
        {course.archived_at && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14,
            backgroundColor: '#D9770618', borderWidth: 1, borderColor: '#D9770630' }}>
            <Archive size={15} color="#D97706" />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#D97706' }}>Course Archived</Text>
              <Text style={{ fontSize: 11, color: '#D97706', opacity: 0.75 }}>
                {`Archived ${new Date(course.archived_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${course.archive_reason ? ` · ${course.archive_reason}` : ''}`}
              </Text>
            </View>
          </View>
        )}

        {/* Title + difficulty */}
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <Text style={{ flex: 1, fontSize: 22, fontWeight: '800', color: c.text }}>{course.title}</Text>
            {course.difficulty && (
              <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20,
                backgroundColor: `${DIFFICULTY_COLORS[course.difficulty] ?? c.primary}18` }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: DIFFICULTY_COLORS[course.difficulty] ?? c.primary, textTransform: 'capitalize' }}>
                  {course.difficulty.replace('_', ' ')}
                </Text>
              </View>
            )}
          </View>

          {/* Meta row */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
            {course.instructor_name && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <GraduationCap size={13} color={c.primary} />
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.6 }}>{course.instructor_name}</Text>
              </View>
            )}
            {course.language && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Globe size={13} color={c.primary} />
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.6 }}>{course.language}</Text>
              </View>
            )}
            {course.estimated_duration_hours && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Clock size={13} color={c.primary} />
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.6 }}>
                  {totalStudyMin > 0 ? formatStudyTime(totalStudyMin) : `${course.estimated_duration_hours}h`}
                </Text>
              </View>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <BookOpen size={13} color={c.primary} />
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.6 }}>{allLessons.length} lessons</Text>
            </View>
          </View>

          {/* Tags */}
          {course.tags?.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {course.tags.map((tag: string) => (
                <View key={tag} style={{ flexDirection: 'row', alignItems: 'center', gap: 4,
                  paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: `${c.primary}12` }}>
                  <Tag size={10} color={c.primary} />
                  <Text style={{ fontSize: 11, color: c.primary, fontWeight: '600' }}>{tag}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Price badge */}
          {!isSubscribed && (
            <View style={{ alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 7,
              borderRadius: 12,
              backgroundColor: (!course.price_egp || course.price_egp === 0) ? '#16A34A18' : `${c.primary}15` }}>
              <Text style={{ fontSize: 16, fontWeight: '800',
                color: (!course.price_egp || course.price_egp === 0) ? '#16A34A' : c.primary }}>
                {(!course.price_egp || Number(course.price_egp) === 0)
                  ? 'Free'
                  : `EGP ${Number(course.price_egp).toFixed(0)}`}
              </Text>
            </View>
          )}
        </View>

        {/* ── Course Progress (enrolled students) */}
        {isSubscribed && allLessons.length > 0 && (
          <CourseProgressBar
            totalLessons={courseProgress?.total_lessons ?? allLessons.length}
            completedLessons={courseProgress?.completed_lessons ?? completedCount}
            progressPct={courseProgress?.progress_pct ?? progressPct}
            remainingSeconds={courseProgress?.remaining_seconds ?? 0}
          />
        )}

        {/* ── Study Time Stats (enrolled students, if estimated_minutes are set) */}
        {isSubscribed && totalStudyMin > 0 && (
          <NeuCard style={{ gap: 0, padding: 0, overflow: 'hidden' }}>
            <View style={{ flexDirection: 'row' }}>
              {[
                { label: 'Total', value: formatStudyTime(totalStudyMin), color: c.primary },
                { label: 'Completed', value: formatStudyTime(completedMin), color: '#16A34A' },
                { label: 'Remaining', value: formatStudyTime(remainingMin), color: '#D97706' },
              ].map((stat, i) => (
                <View key={stat.label} style={{ flex: 1, alignItems: 'center', paddingVertical: 14,
                  borderRightWidth: i < 2 ? 1 : 0, borderColor: `${c.text}10` }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: stat.color }}>{stat.value}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 2 }}>{stat.label}</Text>
                </View>
              ))}
            </View>
            {totalStudyMin > 0 && (
              <View style={{ height: 4, backgroundColor: `${c.text}08` }}>
                <View style={{ height: 4, width: `${progressPct}%`, backgroundColor: '#16A34A', borderRadius: 2 }} />
              </View>
            )}
          </NeuCard>
        )}

        {/* Short description */}
        {course.short_description && (
          <Text style={{ fontSize: 14, color: c.text, opacity: 0.65, lineHeight: 22 }}>
            {course.short_description}
          </Text>
        )}

        {/* Full description */}
        {course.full_description && course.full_description !== course.short_description && (
          <NeuCard>
            <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 8 }}>About This Course</Text>
            <Text style={{ fontSize: 14, color: c.text, opacity: 0.65, lineHeight: 22 }}>
              {course.full_description}
            </Text>
          </NeuCard>
        )}

        {/* Course features */}
        <NeuCard style={{ gap: 10 }}>
          {course.certificate_enabled && <FeatureRow icon={CheckCircle} color="#16A34A" label="Certificate on completion" />}
          {course.free_preview && <FeatureRow icon={Play} color="#2563EB" label="Free preview available" />}
          {course.sequential_learning && <FeatureRow icon={BookOpen} color="#7C3AED" label="Sequential learning path" />}
        </NeuCard>

        {/* Sections & Lessons */}
        <Text style={{ fontSize: 18, fontWeight: '800', color: c.text }}>Course Content</Text>
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.45, marginTop: -12 }}>
          {`${(course.sections ?? []).length} sections \u00b7 ${allLessons.length} lessons${
            totalStudyMin > 0
              ? ` \u00b7 ${formatStudyTime(totalStudyMin)} total`
              : courseProgress?.remaining_seconds > 0
                ? ` \u00b7 ${formatRemaining(courseProgress.remaining_seconds)}`
                : ''
          }`}
        </Text>

        {(course.sections ?? []).map((section: any, sIdx: number) => {
          // Filter out draft lessons for students at render time (matches allLessons filter above)
          const sectionLessons = (section.lessons ?? []).filter(
            (l: any) => !isStudent || l.status === 'published'
          );
          const sectionCompleted = sectionLessons.filter((l: any) => completedIds.has(l.id)).length;
          const isOpen = expandedSections.has(section.id);
          const progressPct = sectionLessons.length > 0
            ? Math.round((sectionCompleted / sectionLessons.length) * 100)
            : 0;

          return (
            <NeuCard key={section.id} style={{ padding: 0, overflow: 'hidden' }}>
              {/* ── Section Header (always visible) ── */}
              <Pressable
                onPress={() => toggleSection(section.id)}
                accessibilityLabel={`${isOpen ? 'Collapse' : 'Expand'} section: ${section.title}`}
                accessibilityRole="button"
                style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 }}
              >
                {/* Section number bubble */}
                <View style={{
                  width: 30, height: 30, borderRadius: 15,
                  backgroundColor: isOpen ? c.primary : `${c.primary}18`,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <Text style={{ fontSize: 12, fontWeight: '800', color: isOpen ? '#fff' : c.primary }}>
                    {sIdx + 1}
                  </Text>
                </View>

                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }} numberOfLines={2}>
                    {section.title}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>
                      {sectionLessons.length} lesson{sectionLessons.length !== 1 ? 's' : ''}
                    </Text>
                    {sectionCompleted > 0 && (
                      <Text style={{ fontSize: 11, color: '#16A34A', fontWeight: '600' }}>
                        {sectionCompleted}/{sectionLessons.length} done
                      </Text>
                    )}
                  </View>
                  {/* Thin progress strip */}
                  {sectionLessons.length > 0 && (
                    <View style={{ height: 3, borderRadius: 2, backgroundColor: `${c.text}10`, overflow: 'hidden', marginTop: 2 }}>
                      <View style={{
                        height: 3, borderRadius: 2,
                        width: `${progressPct}%` as `${number}%`,
                        backgroundColor: progressPct === 100 ? '#16A34A' : c.primary,
                      }} />
                    </View>
                  )}
                </View>

                {/* Chevron: ▶ collapsed, ▼ expanded */}
                {isOpen
                  ? <ChevronDown size={18} color={c.primary} />
                  : <ChevronRight size={18} color={c.text} opacity={0.35} />}
              </Pressable>

              {/* ── Lesson list — only rendered when open ── */}
              {isOpen && (
                <View style={{ borderTopWidth: 1, borderColor: `${c.text}10` }}>
                  {sectionLessons.map((lesson: any, lIdx: number) => {
                    const isCompleted = completedIds.has(lesson.id);
                    const isScheduled = lesson.status === 'scheduled';
                    const locked = isLessonLocked(lesson, lIdx, section) || (!isSubscribed && !lesson.is_preview);
                    const canAccess = !locked && !isScheduled;
                    const scheduledDate = isScheduled && lesson.scheduled_at
                      ? new Date(lesson.scheduled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                      : null;

                    return (
                      <Pressable
                        key={lesson.id}
                        onPress={() => canAccess && router.push(`/(app)/lesson/${lesson.id}` as RelativePathString)}
                        accessibilityLabel={`${canAccess ? 'Open' : 'Locked:'} ${lIdx + 1}. ${lesson.title}`}
                        accessibilityRole="button"
                        style={{
                          flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12,
                          borderBottomWidth: lIdx < sectionLessons.length - 1 ? 1 : 0,
                          borderColor: `${c.text}08`, opacity: canAccess ? 1 : 0.6,
                        }}>
                        {/* Icon bubble */}
                        <View style={{
                          width: 36, height: 36, borderRadius: 10,
                          backgroundColor: isCompleted ? '#16A34A18' : isScheduled ? '#3B82F618' : locked ? `${c.text}08` : `${c.primary}12`,
                          alignItems: 'center', justifyContent: 'center',
                        }}>
                          {isCompleted
                            ? <CheckCircle size={18} color="#16A34A" />
                            : isScheduled
                              ? <Calendar size={16} color="#3B82F6" />
                              : locked
                                ? <Lock size={16} color={c.text} opacity={0.35} />
                                : <Play size={16} color={c.primary} />}
                        </View>

                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }} numberOfLines={1}>
                            {`${lIdx + 1}. ${lesson.title}`}
                          </Text>
                          <View style={{ flexDirection: 'row', gap: 10, marginTop: 2, flexWrap: 'wrap' }}>
                            {lesson.estimated_minutes > 0 ? (
                              <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>
                                {formatStudyTime(lesson.estimated_minutes)}
                              </Text>
                            ) : lesson.duration_seconds > 0 ? (
                              <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>
                                {Math.round(lesson.duration_seconds / 60)}m
                              </Text>
                            ) : null}
                            {lesson.is_preview && !isSubscribed && (
                              <Text style={{ fontSize: 11, color: '#16A34A', fontWeight: '600' }}>Free Preview</Text>
                            )}
                            {isScheduled && scheduledDate && (
                              <Text style={{ fontSize: 11, color: '#3B82F6', fontWeight: '600' }}>
                                Available {scheduledDate}
                              </Text>
                            )}
                          </View>
                        </View>

                        {/* Attachment count */}
                        {(lesson.lesson_materials?.length ?? 0) > 0 && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                            <Paperclip size={11} color={c.text} opacity={0.3} />
                            <Text style={{ fontSize: 11, color: c.text, opacity: 0.35 }}>
                              {lesson.lesson_materials.length}
                            </Text>
                          </View>
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </NeuCard>
          );
        })}

        {/* Subscribe — shows contact sheet with doctor's configured methods */}
        {!isSubscribed && (course.whatsapp || course.telegram || course.phone) && (
          <NeuButton label="Subscribe" variant="primary"
            icon={<MessageCircle size={16} color="#fff" />}
            onPress={() => setShowContact(true)} fullWidth />
        )}
      </View>

      <ContactSheet
        visible={showContact}
        onClose={() => setShowContact(false)}
        courseTitle={course.title}
        contact={{ whatsapp: course.whatsapp, telegram: course.telegram, phone: course.phone }}
      />
    </ScrollView>
  );
}

function FeatureRow({ icon: Icon, color, label }: { icon: any; color: string; label: string }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Icon size={16} color={color} />
      <Text style={{ fontSize: 13, color: c.text, opacity: 0.65 }}>{label}</Text>
    </View>
  );
}

