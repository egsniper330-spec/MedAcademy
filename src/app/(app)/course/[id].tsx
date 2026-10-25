import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, Pressable, ActivityIndicator, RefreshControl, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Image } from 'expo-image';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft, BookOpen, Calendar, ChevronDown, ChevronRight, Clock, GraduationCap,
  Globe, Tag, Play, Lock, MessageCircle, CheckCircle, Paperclip, Archive,
  Eye, X,
} from 'lucide-react-native';
import { getCourseById, getCourseProgress, getLessonProgress, getMySubscriptions, calcCourseDuration, calcRemainingTime, calcCompletedTime, formatStudyTime } from '@/lib/api';
import { prefetchCourseImages, courseImageUrlsFrom } from '@/lib/imagePrefetch';
import { useProfileStore } from '@/lib/store';
import { useStaleWhileRevalidateFocus } from '@/lib/useStaleWhileRevalidateFocus';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { CourseProgressBar } from '@/components/CourseProgressBar';
import { SubscribeSheet } from '@/components/SubscribeSheet';
import { resolveCourseContact } from '@/lib/subscribeContact';
import { neuColors, useLayout, safeTop, safeLeft, safeBottom, mutedTextStyle } from '@/lib/neu';
import { isPreviewingCourse, stopPreviewAsStudent } from '@/lib/previewAsStudent';
import {
  classifyCourseLoadError,
  nextRetryDelayMs,
  sanitizeLoadError,
  shouldAutoRetry,
  type CourseLoadError,
} from '@/lib/courseLoadError';
import { useTranslation } from '@/lib/i18n';
import { formatLocalizedDate } from '@/lib/i18n/date';
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

/**
 * Difficulty is a controlled enum on `courses.difficulty`, so the badge can be
 * localized. Unknown values (a future enum member) fall back to the raw value
 * rather than showing a missing-key marker.
 */
const DIFFICULTY_KEYS: Record<string, string> = {
  beginner: 'difficulty.beginner',
  intermediate: 'difficulty.intermediate',
  advanced: 'difficulty.advanced',
  all_levels: 'difficulty.allLevels',
};

/**
 * The builder stores the course language as one of a FIXED list of English
 * names (LANGUAGES in course-builder/[id].tsx). Those known names are UI
 * vocabulary, so they are translated; anything else is data and is shown
 * verbatim.
 */
function languageKey(value: string): string | null {
  const key = `languageName.${String(value).trim().toLowerCase()}`;
  return ['arabic', 'english', 'french', 'german', 'spanish', 'turkish', 'urdu']
    .some((n) => key === `languageName.${n}`) ? key : null;
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
  const { t, tCount, locale, isRTL } = useTranslation();
  // Direction-aware alignment for every label on this screen. Course titles,
  // section/lesson titles and descriptions are DATA: they keep RTL/LTR
  // auto-detection (no writingDirection override) but follow the app's edge.
  const txtAlign = isRTL ? 'right' as const : 'left' as const;

  const [course, setCourse] = useState<any>(null);
  const [progress, setProgress] = useState<any[]>([]);
  const [courseProgress, setCourseProgress] = useState<any>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Distinguishes "this course does not exist" from "this load failed".
  const [loadError, setLoadError] = useState<CourseLoadError | null>(null);
  // Generation guard: a resume/refocus can start a load while a previous one is
  // still in flight (queued behind the security lock). Only the newest load may
  // commit state, so a stale error can never replace fresh content — and a
  // stale success can never resurrect a course the user already left.
  const loadGenRef = useRef(0);
  // Bounded auto-retry bookkeeping (transient failures only, never while
  // content is on screen).
  const autoRetryRef = useRef(0);
  // Initialise from session cache so state survives lesson → back navigation
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => id ? (_sectionStateCache.get(id) ?? new Set<string>()) : new Set<string>()
  );
  const [showContact, setShowContact] = useState(false);

  // "Preview as Student" — session-scoped flag; true only for the course the
  // doctor explicitly started previewing from My Courses.
  const previewMode = isPreviewingCourse(id);

  const loadData = useCallback(async () => {
    if (!id) {
      setLoading(false);
      return;
    }
    const gen = ++loadGenRef.current;
    const startedAt = Date.now();
    try {
      const isStudent = profile?.role === 'student' || isPreviewingCourse(id);
      const wantsEnrollment = isStudent && !!profile;

      // Fire the enrollment reads NOW rather than after the course payload
      // returns. They depend only on `id` + `profile`, both already known, so
      // running them as a second sequential Promise.all was pure
      // serialization — this is the most-tapped screen in the app and the
      // extra round trip directly delayed content appearing.
      //
      // The early no-op catch only prevents a transient unhandled-rejection
      // warning while phase 1 is still in flight. An enrollment failure is
      // NON-FATAL for the course itself: it costs the progress extras, never
      // the course page (previously it aborted the whole load and produced the
      // bogus "Course not found").
      const subsP = wantsEnrollment ? getMySubscriptions(profile!.id) : null;
      const cpP = wantsEnrollment
        ? getCourseProgress(profile!.id, id).catch(() => null)
        : null;
      subsP?.catch(() => {});

      const [courseData, prog] = await Promise.all([
        getCourseById(id),
        // Progress is a secondary read: a failure here must not blank the page.
        profile ? getLessonProgress(profile.id, id).catch(() => []) : Promise.resolve([]),
      ]);
      if (gen !== loadGenRef.current) return; // superseded by a newer load

      if (!courseData) {
        // A REAL not-found: `.single()` resolves with `data: null` and no error
        // when the row does not exist (the adapter does not synthesise 404).
        setCourse(null);
        setLoadError({ kind: 'notFound' });
        return;
      }

      setCourse(courseData);
      setProgress(prog);
      setLoadError(null);
      autoRetryRef.current = 0;
      if (__DEV__) {
        console.log('[CourseDetail] loaded', `duration=${Date.now() - startedAt}ms`, `sections=${courseData?.sections?.length ?? 0}`);
      }
      prefetchCourseImages(courseImageUrlsFrom([courseData]));
      if (courseData?.sections?.length) {
        // Restore from session cache; only reset if no prior state exists for this course
        if (!_sectionStateCache.has(id!)) {
          setExpandedSections(new Set());
        }
        // else: leave existing expanded state untouched — user may have expanded sections
      }
      if (subsP && cpP) {
        try {
          const [subs, cp] = await Promise.all([subsP, cpP]);
          if (gen !== loadGenRef.current) return;
          setIsSubscribed(subs.some((s: any) => s.course_id === id || s.course?.id === id));
          setCourseProgress(cp);
        } catch (enrollErr) {
          // Non-fatal by design: the course and its lessons are already shown;
          // the subscribe button simply stays in its safe (not-subscribed) state.
          if (__DEV__) console.warn('[CourseDetail] enrollment extras unavailable', sanitizeLoadError(enrollErr));
        }
      }
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      const classified = classifyCourseLoadError(err);
      // Diagnosable without any secret: status, code, duration, classification.
      console.warn('[CourseDetail] load FAILED', {
        durationMs: Date.now() - startedAt,
        ...sanitizeLoadError(err),
        classifiedAs: classified.kind,
        retryable: classified.kind === 'transient' ? classified.retryable : false,
      });
      setLoadError(classified);
    } finally {
      // ALWAYS end the spinner for the newest load — a hung/queued request can
      // never leave the screen spinning forever.
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, [id, profile]); // isPreviewingCourse read live — preview toggles re-render via previewMode state below

  // Stale-while-revalidate: the FIRST entry shows the full-screen spinner, but
  // returning to this course (from a lesson, the tab bar, or a pushed screen)
  // refreshes in the BACKGROUND with the content still mounted. Previously
  // every focus called setLoading(true) + a full refetch, so the most-tapped
  // screen in the app blanked to a spinner every single time it regained
  // focus — the "navigation keeps reloading" complaint. Identical requests,
  // identical error semantics: only the spinner sequencing changed.
  //
  // `course.id === id` guards a reused route instance: navigating to a
  // DIFFERENT course must never show the previous course's content while its
  // own payload is in flight.
  const hasCourseContent = useCallback(
    () => !!course && (!id || course.id === id),
    [course, id],
  );
  useStaleWhileRevalidateFocus(loadData, { setLoading, hasContent: hasCourseContent });

  // Preview-as-Student is toggled from My Courses and lands here via replace,
  // so the listening screen must re-derive its gates even if the focus event
  // is coalesced. No spinner: the content on screen is still this course.
  const previewModeRef = useRef(previewMode);
  useEffect(() => {
    if (previewModeRef.current === previewMode) return;
    previewModeRef.current = previewMode;
    void loadData();
  }, [previewMode, loadData]);
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  /** Manual retry from the failure state — resets the auto-retry budget. */
  const retryLoad = useCallback(() => {
    autoRetryRef.current = 0;
    setLoadError(null);
    setLoading(true);
    void loadData();
  }, [loadData]);

  /**
   * BOUNDED AUTO-RETRY (transient only).
   *
   * A resume that coincides with device verification can make the first read
   * fail for a reason that clears itself within a second or two (the request is
   * queued behind the lock and the bound expires, or the connection is still
   * re-attaching). Two attempts with 0.8 s → 1.6 s backoff recover that case
   * without the user tapping anything.
   *
   * It deliberately does NOT retry when:
   *   • content is already on screen (the stale-while-revalidate path owns it),
   *   • the failure is authoritative (401/403/suspended — a policy decision),
   *   • the course is genuinely missing (not-found is not a transient state),
   *   • the budget is spent. There is no timer chain and no polling.
   */
  useEffect(() => {
    if (!shouldAutoRetry(loadError, { hasContent: !!course, attempt: autoRetryRef.current })) return;
    const timer = setTimeout(() => {
      autoRetryRef.current += 1;
      void loadData();
    }, nextRetryDelayMs(autoRetryRef.current));
    return () => clearTimeout(timer);
  }, [course, loadError, loadData]);

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

  const isStudent = profile?.role === 'student' || previewMode;

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
  const isLessonLocked = (lesson: any, lessonIdx: number, section: any, contentUnlocked: boolean) => {
    // Subscription gate first: a non-subscribed visitor (student, not preview)
    // only ever gets free-preview lessons. Content owners (doctor/admin) and
    // "Preview as Student" sessions are always unlocked — the doctor must be
    // able to open their own lessons even though the student-only subscription
    // lookup reports "not subscribed" (the exact bug that left a doctor's own
    // course page permanently locked).
    if (!contentUnlocked) return !lesson.is_preview;
    if (!course?.sequential_learning) return false;
    if (lessonIdx === 0) return false;
    const prev = (section.lessons ?? [])[lessonIdx - 1];
    return prev && !completedIds.has(prev.id);
  };

  // Full-screen spinner ONLY while there is genuinely nothing to show. A
  // background refresh keeps the course mounted (stale-while-revalidate).
  if (loading && !course) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.base }}>
      <ActivityIndicator color={c.primary} size="large" />
    </View>
  );
  if (!course) {
    // "Not found" is reserved for a real missing row. A failed load says so,
    // reassures the student that access is unchanged, and offers a retry — the
    // previous code rendered "Course not found" for every failure, including a
    // timeout during post-resume device verification.
    const isNotFound = loadError?.kind === 'notFound';
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12, backgroundColor: c.base }}>
        <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, textAlign: 'center' }}>
          {isNotFound ? t('course.notFound') : t('course.loadFailedTitle')}
        </Text>
        {!isNotFound && (
          <Text style={{ ...mutedTextStyle(c, 0.5), fontSize: 13, textAlign: 'center', lineHeight: 19 }}>
            {t('course.loadFailedBody')}
          </Text>
        )}
        {!isNotFound && (
          <NeuButton label={t('common.tryAgain')} variant="primary" onPress={retryLoad} />
        )}
      </View>
    );
  }

  const renderTree = (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
      contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
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
          accessibilityLabel={t('common.back')}
          accessibilityRole="button"
          style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${c.base}ee`, alignItems: 'center', justifyContent: 'center' }}>
          <ArrowLeft size={22} color={c.text} opacity={0.75} />
        </Pressable>
      </View>

      <View style={{ padding: layout.screenPx, gap: 16 }}>
        {/* Archived banner */}
        {course.archived_at ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14,
            backgroundColor: '#D9770618', borderWidth: 1, borderColor: '#D9770630' }}>
            <Archive size={15} color="#D97706" />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#D97706' }}>
                {t('course.archivedTitle')}
              </Text>
              <Text style={{ fontSize: 11, color: '#D97706', opacity: 0.75 }}>
                {/* Date follows the app language; the reason is admin data. */}
                {`${t('course.archivedOn', { date: formatLocalizedDate(course.archived_at, locale) })}${course.archive_reason ? ` · ${course.archive_reason}` : ''}`}
              </Text>
            </View>
          </View>
        ) : null}

        {/* ── Preview-as-Student banner (doctors previewing their own course) ── */}
        {previewMode && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14,
            backgroundColor: '#7C3AED18', borderWidth: 1, borderColor: '#7C3AED30' }}>
            <Eye size={15} color="#7C3AED" />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#7C3AED' }}>
                {t('course.previewTitle')}
              </Text>
              <Text style={{ fontSize: 11, color: '#7C3AED', opacity: 0.75, textAlign: txtAlign }}>
                {t('course.previewBody')}
              </Text>
            </View>
            <Pressable onPress={() => { stopPreviewAsStudent(); router.replace(`/(app)/course/${id}` as RelativePathString); }}
              hitSlop={8} accessibilityRole="button" accessibilityLabel={t('course.previewExit')}
              style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: '#7C3AED22', alignItems: 'center', justifyContent: 'center' }}>
              <X size={15} color="#7C3AED" />
            </Pressable>
          </View>
        )}

        {/* Title + difficulty */}
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <Text style={{ flex: 1, fontSize: 22, fontWeight: '800', color: c.text, textAlign: txtAlign }}>{course.title}</Text>
            {course.difficulty ? (
              <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20,
                backgroundColor: `${DIFFICULTY_COLORS[course.difficulty] ?? c.primary}18` }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: DIFFICULTY_COLORS[course.difficulty] ?? c.primary,
                  textTransform: DIFFICULTY_KEYS[course.difficulty] ? 'none' : 'capitalize' }}>
                  {DIFFICULTY_KEYS[course.difficulty]
                    ? t(DIFFICULTY_KEYS[course.difficulty])
                    : String(course.difficulty).replace('_', ' ')}
                </Text>
              </View>
            ) : null}
          </View>

          {/* Meta row */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
            {(course.doctor?.full_name ?? course.instructor_name) ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <GraduationCap size={13} color={c.primary} />
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6) }}>{course.doctor?.full_name ?? course.instructor_name}</Text>
              </View>
            ) : null}
            {course.language ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Globe size={13} color={c.primary} />
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6) }}>
                  {languageKey(course.language) ? t(languageKey(course.language)!) : course.language}
                </Text>
              </View>
            ) : null}
            {course.estimated_duration_hours ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Clock size={13} color={c.primary} />
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6) }}>
                  {totalStudyMin > 0 ? formatStudyTime(totalStudyMin) : `${course.estimated_duration_hours}h`}
                </Text>
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <BookOpen size={13} color={c.primary} />
              <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6) }}>
                {tCount('home.lessonsCount', allLessons.length)}
              </Text>
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
                  ? t('home.free')
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
                { label: t('common.total'), value: formatStudyTime(totalStudyMin), color: c.primary },
                { label: t('course.statCompleted'), value: formatStudyTime(completedMin), color: '#16A34A' },
                { label: t('course.statRemaining'), value: formatStudyTime(remainingMin), color: '#D97706' },
              ].map((stat, i) => (
                <View key={stat.label} style={{ flex: 1, alignItems: 'center', paddingVertical: 14,
                  borderRightWidth: i < 2 ? 1 : 0, borderColor: `${c.text}10` }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: stat.color }}>{stat.value}</Text>
                  <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45), marginTop: 2 }}>{stat.label}</Text>
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
        {course.short_description ? (
          <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.65), lineHeight: 22, textAlign: txtAlign }}>
            {course.short_description}
          </Text>
        ) : null}

        {/* Full description */}
        {course.full_description && course.full_description !== course.short_description ? (
          <NeuCard>
            <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 8, textAlign: txtAlign }}>
              {t('course.about')}
            </Text>
            <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.65), lineHeight: 22, textAlign: txtAlign }}>
              {course.full_description}
            </Text>
          </NeuCard>
        ) : null}

        {/* Course features */}
        <NeuCard style={{ gap: 10 }}>
          {course.certificate_enabled && <FeatureRow icon={CheckCircle} color="#16A34A" label={t('course.featureCertificate')} />}
          {course.free_preview && <FeatureRow icon={Play} color="#2563EB" label={t('course.featureFreePreview')} />}
          {course.sequential_learning && <FeatureRow icon={BookOpen} color="#7C3AED" label={t('course.featureSequential')} />}
        </NeuCard>

        {/* Sections & Lessons */}
        <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, textAlign: txtAlign }}>
          {t('course.content')}
        </Text>
        <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.45), marginTop: -12, textAlign: txtAlign }}>
          {[
            // Plural-aware in BOTH languages: Arabic needs its own dual/plural
            // forms, which a hand-built `n === 1 ? 'section' : 'sections'`
            // ternary produced in English only.
            tCount('course.sectionCount', (course.sections ?? []).length),
            tCount('home.lessonsCount', allLessons.length),
            totalStudyMin > 0
              ? t('course.totalTime', { time: formatStudyTime(totalStudyMin) })
              : courseProgress?.remaining_seconds > 0
                ? t('course.timeRemaining', {
                    time: tCount('home.minutes', Math.max(1, Math.round(courseProgress.remaining_seconds / 60))),
                  })
                : null,
          ].filter(Boolean).join(' \u00b7 ')}
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
                accessibilityLabel={t(isOpen ? 'course.collapseSection' : 'course.expandSection', { title: section.title })}
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
                    <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45) }}>
                      {tCount('home.lessonsCount', sectionLessons.length)}
                    </Text>
                    {sectionCompleted > 0 && (
                      <Text style={{ fontSize: 11, color: '#16A34A', fontWeight: '600' }}>
                        {t('course.doneOfTotal', { done: sectionCompleted, total: sectionLessons.length })}
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
                    // Content unlocked for: subscribed students, non-student roles
                    // (doctor/admin/SA own or manage content), and Preview-as-Student.
                    // NOTE: deliberately NOT `isStudent` — a non-subscribed real
                    // student must stay locked to free-preview lessons (Subscribe funnel).
                    const contentUnlocked = isSubscribed || previewMode || (!!profile && profile.role !== 'student');
                    const locked = isLessonLocked(lesson, lIdx, section, contentUnlocked) || (!contentUnlocked && !lesson.is_preview);
                    const canAccess = !locked && !isScheduled;
                    const scheduledDate = isScheduled && lesson.scheduled_at
                      ? formatLocalizedDate(lesson.scheduled_at, locale)
                      : null;

                    return (
                      <Pressable
                        key={lesson.id}
                        onPress={() => canAccess && router.push(`/(app)/lesson/${lesson.id}` as RelativePathString)}
                        accessibilityLabel={t(canAccess ? 'course.openLesson' : 'course.lockedLesson', {
                          position: lIdx + 1,
                          title: lesson.title,
                        })}
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
                              <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45) }}>
                                {formatStudyTime(lesson.estimated_minutes)}
                              </Text>
                            ) : lesson.duration_seconds > 0 ? (
                              <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4) }}>
                                {Math.round(lesson.duration_seconds / 60)}m
                              </Text>
                            ) : null}
                            {lesson.is_preview && !isSubscribed && (
                              <Text style={{ fontSize: 11, color: '#16A34A', fontWeight: '600' }}>{t('lesson.freePreview')}</Text>
                            )}
                            {isScheduled && scheduledDate && (
                              <Text style={{ fontSize: 11, color: '#3B82F6', fontWeight: '600' }}>
                                {t('course.availableOn', { date: scheduledDate })}
                              </Text>
                            )}
                          </View>
                        </View>

                        {/* Attachment count */}
                        {(lesson.lesson_materials?.length ?? 0) > 0 && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                            <Paperclip size={11} color={c.text} opacity={0.3} />
                            <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.35) }}>
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

        {/* Subscribe — the SAME shared sheet, fed by the SAME shared contact
            resolver, as the Explore course list. Previously this screen used the
            legacy ContactSheet with the raw course-level whatsapp/telegram/phone
            columns, ignoring use_default_contact (and getCourseById did not even
            select the doctor's contacts), which is why this flow showed a stale
            number while Explore showed the configured options.
            Shown whenever the viewer is not a subscriber — the sheet itself
            reports the not-configured state.
            Hidden during "Preview as Student": the doctor is not actually a
            subscriber and must not be offered the student purchase flow. */}
        {!previewMode && !isSubscribed ? (
          <NeuButton label={t('course.subscribe')} variant="primary"
            icon={<MessageCircle size={16} color="#fff" />}
            onPress={() => setShowContact(true)} fullWidth />
        ) : null}
      </View>

      <SubscribeSheet
        visible={showContact}
        onClose={() => setShowContact(false)}
        courseTitle={course.title}
        contact={resolveCourseContact(course)}
      />
    </ScrollView>
  );

  return renderTree;
}

function FeatureRow({ icon: Icon, color, label }: { icon: any; color: string; label: string }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Icon size={16} color={color} />
      <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.65) }}>{label}</Text>
    </View>
  );
}

