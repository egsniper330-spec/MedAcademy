/**
 * CourseBuilder — Full enterprise LMS course creation/editing screen.
 * Route: /course-builder/[id]   (id = "new" for creation)
 *
 * Tabs: Info | Structure | Settings
 * Auto-saves every 1.5 s after any change.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  ActivityIndicator, Animated, FlatList, KeyboardAvoidingView, Modal, Pressable,
  ScrollView, Text, TextInput, useColorScheme, useWindowDimensions, View,
} from 'react-native';
import { useFadeAnim } from '@/lib/motion';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft, ArrowRight, ChevronLeft, ArrowDown, ArrowUp, Archive, BookOpen, Check, CheckCircle, ChevronDown,
  ChevronRight, Clock, Copy, GripVertical, Layers, MoreHorizontal, Pencil, Phone, Plus, RefreshCw, Save, Settings,
  Trash2, Upload, Bookmark, X, FileUp, MessageCircle, Send, Video, FileText,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

import { NeuButton } from '@/components/NeuButton';
import { NeuCard } from '@/components/NeuCard';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, neuFlatStyle, neuPressedStyle, safeTop, safeLeft, safeRight, safeBottom, mutedTextStyle } from '@/lib/neu';
import { useProfileStore } from '@/lib/store';
import { friendlyError } from '@/lib/validation';
import {
  archiveCourse,
  calcCourseDuration, calcSectionDuration, formatStudyTime,
  createCourse, createLesson, createSection,
  deleteLesson, deleteSection,
  duplicateCourse, duplicateLesson, getCourseById,
  getCourseTemplates, saveCourseAsTemplate, createCourseFromTemplate,
  getFaculties, getUniversities,
  reorderLessons, reorderSections,
  updateCourse, updateLesson, updateSection,
  publishCourse, unpublishCourse,
  bulkCreateLessonsFromFiles,
  uploadCourseCover, removeCourseCover,
  type CourseBuilderPayload,
} from '@/lib/api';
import { getCoursePublishBlockers } from '@/lib/videoUploadEngine';
import { useUploadQueueStore } from '@/lib/uploadQueueStore';
import type { RelativePathString } from 'expo-router';
import { usePermission } from '@/hooks/usePermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';
import { useFeatureFlags } from '@/lib/featureFlags';
import { FeatureUnavailableState } from '@/components/ScreenState';
import { isFeatureEnabled } from '@/lib/featureFlags';
import { sectionDeleteErrorKey } from '@/lib/sectionDelete';
import { useTranslation } from '@/lib/i18n';

// ── Types ─────────────────────────────────────────────────────────────────────
type Tab = 'info' | 'structure' | 'settings';
type CourseStartMode = 'blank' | 'template';

const LANGUAGES = ['Arabic', 'English', 'French', 'German', 'Spanish', 'Turkish', 'Urdu'];

// ── Helpers ────────────────────────────────────────────────────────────────────


/** Translator signature (resolved at render, never at module load). */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Maps internal video_type values to localized display labels. */
function lessonTypeLabel(videoType: string | undefined, t: Translate): string {
  switch (videoType) {
    case 'vdocipher':
    case 'youtube':      return t('cb.lessonType.video');
    case 'pdf':          return t('cb.lessonType.pdf');
    case 'coming_soon':  return t('cb.lessonType.comingSoon');
    case 'text':         return t('cb.lessonType.text');
    default:             return t('cb.lessonType.lesson');
  }
}

/** Maps internal status values to localized display labels. */
function lessonStatusLabel(status: string | undefined, t: Translate): string {
  switch (status) {
    case 'published':  return t('courseStatus.published');
    case 'scheduled':  return t('courseStatus.scheduled');
    case 'draft':
    default:           return t('courseStatus.draft');
  }
}

/** Icon component for a lesson type. */
function LessonTypeIcon({ videoType, size, color }: { videoType?: string; size: number; color: string }) {
  if (videoType === 'pdf') return <FileText size={size} color={color} />;
  return <Video size={size} color={color} />;
}

// ── Auto-save hook ─────────────────────────────────────────────────────────────
function useAutoSave(courseId: string | null, fields: Partial<CourseBuilderPayload>, enabled: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  // savedVisible drives a 2-second transient "✓ Saved" indicator
  const [savedVisible, setSavedVisible] = useState(false);
  const savedFade = useFadeAnim(savedVisible, { duration: 500 });

  const showSavedFlash = useCallback(() => {
    setSavedVisible(true);
    setTimeout(() => setSavedVisible(false), 1700);
  }, []);

  useEffect(() => {
    if (!courseId || !enabled) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await updateCourse(courseId, fields);
        setLastSaved(new Date());
        showSavedFlash();
      } catch (_) {}
      setSaving(false);
    }, 1500);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [JSON.stringify(fields), courseId, enabled]);

  return { saving, lastSaved, savedVisible, savedFade };
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function CourseBuilder() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useProfileStore();
  const { showToast } = useToast();
  const { width: screenWidth } = useWindowDimensions();
  const layout = useLayout();
  const insets = layout.insets;
  const isNarrow = screenWidth < 480;
  const { t, tCount, isRTL } = useTranslation();
  const BackIcon = isRTL ? ArrowRight : ArrowLeft;
  const ChevronForward = isRTL ? ChevronLeft : ChevronRight;

  const isNew = id === 'new';

  //  Course-creation feature flag — the server gate is authoritative; this
  //  only mirrors it so the creation route shows an honest unavailable state.
  const { isEnabled } = useFeatureFlags();

  // ── UI state
  const [tab, setTab] = useState<Tab>('info');
  const [loading, setLoading] = useState(!isNew);
  const [publishing, setPublishing] = useState(false);
  const [showPublishCheck, setShowPublishCheck] = useState(false);
  const [videoBlockers, setVideoBlockers] = useState<{ lessonTitle: string; reason: string }[]>([]);
  const [courseId, setCourseId] = useState<string | null>(isNew ? null : id);

  // ── Overflow toolbar menu (mobile)
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);

  // ── Structure "more" menus
  const [sectionMoreId, setSectionMoreId] = useState<string | null>(null);
  const [lessonMoreId, setLessonMoreId] = useState<string | null>(null);

  // ── Template picker (shown when creating a new course)
  const [showStartModal, setShowStartModal] = useState(isNew);
  const [templates, setTemplates] = useState<any[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateTitle, setTemplateTitle] = useState('');
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);

  // ── Duplication state
  const [duplicating, setDuplicating] = useState(false);

  // ── Archive state
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [archiving, setArchiving] = useState(false);
  const [isArchived, setIsArchived] = useState(false);

  // ── Section deletion: confirmation target + in-flight guard (no double submit)
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<any>(null);
  const [deletingSection, setDeletingSection] = useState(false);

  // ── Dropdown options
  const [universities, setUniversities] = useState<any[]>([]);
  const [faculties, setFaculties] = useState<any[]>([]);

  // ── Structure state
  const [sections, setSections] = useState<any[]>([]);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [renamingSection, setRenamingSection] = useState<string | null>(null);
  const [renamingLesson, setRenamingLesson] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [structureSearch, setStructureSearch] = useState('');

  // ── Cover image upload state
  const [coverImageUrl, setCoverImageUrl] = useState('');
  const [uploadingCover, setUploadingCover] = useState(false);
  const {
    ensurePermission: ensureCoverPhotoPermission,
    showRationale: showCoverPhotoRationale,
    setShowRationale: setShowCoverPhotoRationale,
    isBlocked: coverPhotoBlocked,
    confirmRequest: confirmCoverPhotoRequest,
  } = usePermission('mediaLibrary');

  // ── Course info fields
  const [title, setTitle] = useState('');
  const [shortDesc, setShortDesc] = useState('');
  const [fullDesc, setFullDesc] = useState('');
  const [universityId, setUniversityId] = useState('');
  const [facultyId, setFacultyId] = useState('');
  const [language, setLanguage] = useState('Arabic');
  const [status, setStatus] = useState<'draft' | 'published'>('draft');

  // ── Price field (EGP)
  const [priceEgp, setPriceEgp] = useState('0');

  // ── Contact fields (at least one required when use_default_contact = false)
  const [useDefaultContact, setUseDefaultContact] = useState(true);
  const [contactWhatsapp, setContactWhatsapp] = useState('');
  const [contactTelegram, setContactTelegram] = useState('');
  const [contactPhone, setContactPhone] = useState('');

  // ── Settings fields
  const [sequential, setSequential] = useState(false);
  const [freePreview, setFreePreview] = useState(false);
  const [certificate, setCertificate] = useState(false);
  const [subscriptionRequired, setSubscriptionRequired] = useState(true);

  // ── Auto-save payload (contacts included; cover image is saved immediately, not auto-saved)
  const autoSaveFields: Partial<CourseBuilderPayload> & { use_default_contact?: boolean; whatsapp?: string; telegram?: string; phone?: string } = {
    title, description: fullDesc, short_description: shortDesc, full_description: fullDesc,
    university_id: universityId || undefined,
    faculty_id: facultyId || undefined, language,
    sequential_learning: sequential, free_preview: freePreview,
    certificate_enabled: certificate, subscription_required: subscriptionRequired,
    price_egp: parseFloat(priceEgp) || 0,
    use_default_contact: useDefaultContact,
    // Only persist course-specific contact when not using default
    whatsapp: !useDefaultContact ? (contactWhatsapp || undefined) : undefined,
    telegram: !useDefaultContact ? (contactTelegram || undefined) : undefined,
    phone:    !useDefaultContact ? (contactPhone    || undefined) : undefined,
  };

  const { saving, lastSaved, savedVisible, savedFade } = useAutoSave(courseId, autoSaveFields, !!courseId && !!title.trim());

  // ── Load data
  useEffect(() => {
    (async () => {
      const univs = await getUniversities().catch(() => []);
      setUniversities(univs);
    })();
  }, []);

  // Load templates when start modal opens
  useEffect(() => {
    if (!showStartModal || !profile) return;
    setLoadingTemplates(true);
    getCourseTemplates(profile.id)
      .then(setTemplates)
      .catch(() => {})
      .finally(() => setLoadingTemplates(false));
  }, [showStartModal, profile]);

  useEffect(() => {
    if (!universityId) { setFaculties([]); return; }
    getFaculties(universityId).then(setFaculties).catch(() => {});
  }, [universityId]);

  const loadCourse = useCallback(async () => {
    if (!courseId) return;
    try {
      const data = await getCourseById(courseId);
      setTitle(data.title ?? '');
      setShortDesc(data.short_description ?? '');
      setFullDesc(data.full_description ?? data.description ?? '');
      // Single cover image: prefer image_url, fall back to legacy thumbnail/cover fields
      setCoverImageUrl(data.image_url ?? data.thumbnail_url ?? data.cover_url ?? '');
      setUniversityId(data.university_id ?? '');
      setFacultyId(data.faculty_id ?? '');
      setLanguage(data.language ?? 'Arabic');
      setStatus(data.status === 'published' ? 'published' : 'draft');
      setIsArchived(!!data.archived_at);
      setSequential(data.sequential_learning ?? false);
      setFreePreview(data.free_preview ?? false);
      setCertificate(data.certificate_enabled ?? false);
      setSubscriptionRequired(data.subscription_required ?? true);
      setPriceEgp(String(data.price_egp ?? 0));
      setContactWhatsapp(data.whatsapp ?? '');
      setContactTelegram(data.telegram ?? '');
      setContactPhone(data.phone ?? '');
      setUseDefaultContact(data.use_default_contact !== false);
      setSections(data.sections ?? []);
      if (data.sections?.length) setExpandedSections(new Set([data.sections[0].id]));
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('cb.toast.loadFailed')) });
    }
    setLoading(false);
  }, [courseId]);

  // useFocusEffect ensures the course + lesson data is always fresh when the
  // doctor navigates back from lesson editor — critical for publish validation
  // to see the latest video_type and youtube_video_id saved in the lesson editor.
  useFocusEffect(useCallback(() => { loadCourse(); }, [loadCourse]));

  // ── Auto-refresh when any upload for this course reaches 'ready' ────────────
  const { tasks } = useUploadQueueStore();
  const prevCourseTasksRef = useRef<typeof tasks>([]);
  useEffect(() => {
    const prev = prevCourseTasksRef.current;
    prevCourseTasksRef.current = tasks;
    if (!courseId) return;
    const courseTasks = tasks.filter(t => t.courseId === courseId);
    const prevCourse  = prev.filter(t => t.courseId === courseId);
    const justReady   = courseTasks.some(
      t => t.status === 'ready' && !prevCourse.find(p => p.id === t.id && p.status === 'ready'),
    );
    if (justReady) loadCourse();
  }, [tasks, courseId, loadCourse]);

  // ── Create course on first interaction if new
  const ensureCourse = async (): Promise<string> => {
    if (courseId) return courseId;
    if (!title.trim()) throw new Error(t('cb.issue.titleFirst'));
    const course = await createCourse({
      title: title.trim(),
      description: fullDesc,
      short_description: shortDesc,
      full_description: fullDesc,
      language,
      doctor_id: profile!.id,
      status: 'draft',
      price_egp: parseFloat(priceEgp) || 0,
    });
    setCourseId(course.id);
    return course.id;
  };

  // ── Cover image upload / replace / remove
  const handleUploadCover = async () => {
    const granted = await ensureCoverPhotoPermission();
    if (!granted) return; // rationale modal will appear
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      quality: 0.85,
      allowsEditing: true,
      aspect: [16, 9],
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];

    // Ensure the course record exists before uploading
    let cid: string;
    try {
      cid = await ensureCourse();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('cb.toast.saveFirst')) });
      return;
    }

    setUploadingCover(true);
    try {
      const mimeType = asset.mimeType ?? 'image/jpeg';
      const publicUrl = await uploadCourseCover(cid, asset.uri, mimeType, coverImageUrl || undefined);
      setCoverImageUrl(publicUrl);
      showToast({ type: 'success', message: t('cb.toast.coverUpdated') });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('cb.toast.coverUploadFailed')) });
    }
    setUploadingCover(false);
  };

  const handleRemoveCover = async () => {
    if (!courseId || !coverImageUrl) return;
    setUploadingCover(true);
    try {
      await removeCourseCover(courseId, coverImageUrl);
      setCoverImageUrl('');
      showToast({ type: 'success', message: t('cb.toast.coverRemoved') });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('cb.toast.removeCoverFailed')) });
    }
    setUploadingCover(false);
  };

  // ── Archive course
  const handleArchive = async () => {
    if (!courseId || !profile) return;
    setArchiving(true);
    try {
      await archiveCourse(courseId, profile.id, profile.role, archiveReason.trim() || undefined);
      setIsArchived(true);
      setShowArchiveModal(false);
      showToast({ type: 'success', message: t('cb.toast.archived') });
      router.back();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('cb.toast.archiveFailed')) });
    }
    setArchiving(false);
  };

  // ── Section operations
  const handleAddSection = async () => {
    try {
      const cid = await ensureCourse();
      const s = await createSection(cid, t('cb.newSectionName'), sections.length);
      setSections(prev => [...prev, { ...s, lessons: [] }]);
      setExpandedSections(prev => new Set([...prev, s.id]));
      setRenamingSection(s.id);
      setRenameValue(t('cb.newSectionName'));
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.addSectionFailed')) }); }
  };

  const handleRenameSection = async (sectionId: string) => {
    if (!renameValue.trim()) return;
    try {
      await updateSection(sectionId, { title: renameValue.trim() });
      setSections(prev => prev.map(s => s.id === sectionId ? { ...s, title: renameValue.trim() } : s));
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.renameFailed')) }); }
    setRenamingSection(null);
  };

  /** Open the confirmation dialog. Deleting is NEVER immediate: a section can
   *  carry lessons (and their materials/progress), so the doctor always sees
   *  exactly what will be removed first. */
  const requestDeleteSection = (section: any) => {
    if (deletingSection) return;
    setSectionMoreId(null);
    setDeleteSectionTarget(section);
  };

  const handleDeleteSection = async () => {
    const target = deleteSectionTarget;
    if (!target || deletingSection) return;
    if (!courseId) {
      showToast({ type: 'error', message: t('cb.toast.saveFirst') });
      return;
    }
    setDeletingSection(true);
    try {
      // /courses/{id}/sections/{section_id}/delete — one transaction, authorized
      // server-side, dependency-aware. The UI is updated ONLY on success.
      const result = await deleteSection(target.id, courseId);
      setSections(prev => prev.filter(s => s.id !== target.id));
      setExpandedSections(prev => {
        const next = new Set(prev);
        next.delete(target.id);
        return next;
      });
      setDeleteSectionTarget(null);
      showToast({
        type: 'success',
        message: result?.removed_lessons
          ? t('cb.toast.deleteSectionSuccessWithLessons', {
              title: target.title,
              lessons: tCount('drCourses.lessonCount', result.removed_lessons),
            })
          : t('cb.toast.deleteSectionSuccess', { title: target.title }),
      });
      // Re-read the course so counts/order come from the server, never a
      // locally-guessed structure (a failed delete leaves everything as-is).
      await loadCourse();
    } catch (e: any) {
      const key = sectionDeleteErrorKey(e?.httpStatus);
      showToast({
        type: 'error',
        message: key ? t(key) : friendlyError(e, t('cb.toast.deleteSectionFailed')),
      });
    } finally {
      setDeletingSection(false);
    }
  };

  const moveSectionUp = async (idx: number) => {
    if (idx === 0) return;
    const reordered = [...sections];
    [reordered[idx - 1], reordered[idx]] = [reordered[idx], reordered[idx - 1]];
    setSections(reordered);
    if (courseId) await reorderSections(courseId, reordered.map(s => s.id));
  };

  const moveSectionDown = async (idx: number) => {
    if (idx === sections.length - 1) return;
    const reordered = [...sections];
    [reordered[idx], reordered[idx + 1]] = [reordered[idx + 1], reordered[idx]];
    setSections(reordered);
    if (courseId) await reorderSections(courseId, reordered.map(s => s.id));
  };

  // ── Lesson operations
  const handleAddLesson = async (sectionId: string) => {
    try {
      const cid = await ensureCourse();
      const section = sections.find(s => s.id === sectionId);
      const orderIndex = section?.lessons?.length ?? 0;
      const lesson = await createLesson({
        section_id: sectionId, course_id: cid,
        title: t('cb.newLessonName'), order_index: orderIndex,
        video_type: 'vdocipher', status: 'draft',
      });
      setSections(prev => prev.map(s =>
        s.id === sectionId ? { ...s, lessons: [...(s.lessons ?? []), lesson] } : s
      ));
      setRenamingLesson(lesson.id);
      setRenameValue(t('cb.newLessonName'));
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.addLessonFailed')) }); }
  };

  const handleRenameLesson = async (lessonId: string, sectionId: string) => {
    if (!renameValue.trim()) return;
    try {
      await updateLesson(lessonId, { title: renameValue.trim() });
      setSections(prev => prev.map(s =>
        s.id === sectionId
          ? { ...s, lessons: s.lessons.map((l: any) => l.id === lessonId ? { ...l, title: renameValue.trim() } : l) }
          : s
      ));
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.renameFailed')) }); }
    setRenamingLesson(null);
  };

  const handleDeleteLesson = async (lessonId: string, sectionId: string) => {
    try {
      await deleteLesson(lessonId);
      setSections(prev => prev.map(s =>
        s.id === sectionId ? { ...s, lessons: s.lessons.filter((l: any) => l.id !== lessonId) } : s
      ));
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.deleteLessonFailed')) }); }
  };

  const handleDuplicateLesson = async (lessonId: string, sectionId: string) => {
    try {
      const section = sections.find(s => s.id === sectionId);
      const lesson = await duplicateLesson(lessonId, section?.lessons?.length ?? 0);
      setSections(prev => prev.map(s =>
        s.id === sectionId ? { ...s, lessons: [...(s.lessons ?? []), lesson] } : s
      ));
      showToast({ type: 'success', message: t('cb.toast.lessonDuplicated') });
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.duplicateFailed')) }); }
  };

  const moveLessonUp = async (lessonIdx: number, sectionId: string) => {
    if (lessonIdx === 0) return;
    setSections(prev => prev.map(s => {
      if (s.id !== sectionId) return s;
      const ls = [...s.lessons];
      [ls[lessonIdx - 1], ls[lessonIdx]] = [ls[lessonIdx], ls[lessonIdx - 1]];
      reorderLessons(sectionId, ls.map((l: any) => l.id));
      return { ...s, lessons: ls };
    }));
  };

  const moveLessonDown = async (lessonIdx: number, sectionId: string) => {
    setSections(prev => prev.map(s => {
      if (s.id !== sectionId) return s;
      const ls = [...s.lessons];
      if (lessonIdx >= ls.length - 1) return s;
      [ls[lessonIdx], ls[lessonIdx + 1]] = [ls[lessonIdx + 1], ls[lessonIdx]];
      reorderLessons(sectionId, ls.map((l: any) => l.id));
      return { ...s, lessons: ls };
    }));
  };

  // ── Publish validation
  const getPublishIssues = () => {
    const issues: string[] = [];
    if (!title.trim()) issues.push(t('cb.issue.titleRequired'));
    // Contact: when using default, the doctor's profile contact is used — no per-course check needed here.
    // When using custom, at least one custom field must be set.
    if (!useDefaultContact && !contactWhatsapp.trim() && !contactTelegram.trim() && !contactPhone.trim()) {
      issues.push(t('cb.issue.contactRequired'));
    }
    if (sections.length === 0) issues.push(t('cb.issue.sectionRequired'));
    sections.forEach(s => {
      if ((s.lessons ?? []).length === 0) issues.push(t('cb.issue.sectionNoLessons', { title: s.title }));
    });
    const allLessons = sections.flatMap(s => s.lessons ?? []);
    allLessons.forEach(l => {
      const vt = l.video_type ?? 'vdocipher';
      let hasVideo = false;
      if (vt === 'coming_soon') {
        hasVideo = true;
      } else if (vt === 'youtube') {
        hasVideo = !!(l.youtube_video_id?.trim());
      } else {
        hasVideo = !!l.video_id || l.video_status === 'ready' || !!l.video_upload_id;
      }
      if (!hasVideo) {
        issues.push(t('cb.issue.lessonNoVideo', { title: l.title }));
      }
    });
    return issues;
  };

  const handlePublish = async () => {
    // Feature flag: doctor_course_publishing. UI reflection only — the server
    // refuses the publish itself (403 feature_disabled) when the flag is off.
    if (!isFeatureEnabled('doctor_course_publishing')) {
      showToast({ type: 'error', message: t('cb.toast.publishingUnavailable') });
      return;
    }
    const freshData = courseId ? await getCourseById(courseId).catch(() => null) : null;
    const freshSections: any[] = freshData?.sections ?? sections;
    const freshUseDefault = freshData ? (freshData.use_default_contact !== false) : useDefaultContact;
    const freshWhatsapp   = freshData?.whatsapp   ?? contactWhatsapp;
    const freshTelegram   = freshData?.telegram   ?? contactTelegram;
    const freshPhone      = freshData?.phone      ?? contactPhone;

    const getIssues = (sects: any[]) => {
      const issues: string[] = [];
      if (!title.trim()) issues.push(t('cb.issue.titleRequired'));
      if (!freshUseDefault && !freshWhatsapp.trim() && !freshTelegram.trim() && !freshPhone.trim()) {
        issues.push(t('cb.issue.contactRequired'));
      }
      if (sects.length === 0) issues.push(t('cb.issue.sectionRequired'));
      sects.forEach(s => {
        if ((s.lessons ?? []).length === 0) issues.push(t('cb.issue.sectionNoLessons', { title: s.title }));
      });
      sects.flatMap(s => s.lessons ?? []).forEach(l => {
        const vt = l.video_type ?? 'vdocipher';
        let hasVideo = false;
        if (vt === 'coming_soon') {
          hasVideo = true;
        } else if (vt === 'youtube') {
          hasVideo = !!(l.youtube_video_id?.trim());
        } else {
          hasVideo = !!l.video_id || l.video_status === 'ready' || !!l.video_upload_id;
        }
        if (!hasVideo) issues.push(t('cb.issue.lessonNoVideo', { title: l.title }));
      });
      return issues;
    };

    const issues = getIssues(freshSections);
    // Sync state so the rest of the UI reflects the fresh data
    if (freshData?.sections) setSections(freshSections);
    // Also check video upload statuses from DB
    const cid = courseId;
    if (cid) {
      const blockers = await getCoursePublishBlockers(cid);
      setVideoBlockers(blockers);
      if (issues.length > 0 || blockers.length > 0) { setShowPublishCheck(true); return; }
    } else if (issues.length > 0) {
      setVideoBlockers([]);
      setShowPublishCheck(true);
      return;
    }
    setPublishing(true);
    try {
      const resolvedId = await ensureCourse();
      const result = await publishCourse(resolvedId);
      setStatus('published');
      const message = result.action === 'already_published'
        ? t('cb.toast.publishAlready')
        : result.action === 'updated'
          ? t('cb.toast.publishUpdated')
          : t('cb.toast.publishSuccess');
      showToast({ type: 'success', message });
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.publishFailed')) }); }
    setPublishing(false);
  };

  const handleSaveAndExit = async () => {
    try {
      const cid = await ensureCourse();
      await updateCourse(cid, autoSaveFields);
      showToast({ type: 'success', message: t('cb.toast.courseSaved') });
      router.back();
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.saveFailed')) }); }
  };

  // ── Duplicate course
  const handleDuplicateCourse = async () => {
    if (!courseId || !profile) return;
    setDuplicating(true);
    try {
      const newId = await duplicateCourse(courseId, profile.id);
      showToast({ type: 'success', message: t('cb.toast.duplicated') });
      router.replace(`/(app)/course-builder/${newId}` as RelativePathString);
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.duplicateFailed')) }); }
    setDuplicating(false);
  };

  // ── Save as template
  const handleSaveTemplate = async () => {
    if (!courseId || !profile || !templateTitle.trim()) return;
    setSavingTemplate(true);
    try {
      await saveCourseAsTemplate(courseId, profile.id, templateTitle.trim());
      showToast({ type: 'success', message: t('cb.toast.savedTemplate') });
      setShowSaveTemplate(false);
      setTemplateTitle('');
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.templateFailed')) }); }
    setSavingTemplate(false);
  };

  // ── Create from template
  const handleStartFromTemplate = async (templateId: string) => {
    if (!profile) return;
    try {
      const newCourseId = await createCourseFromTemplate(templateId, profile.id);
      setCourseId(newCourseId);
      setShowStartModal(false);
      await loadCourse();
      showToast({ type: 'success', message: t('cb.toast.fromTemplate') });
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.templateStartFailed')) }); }
  };

  // ── Bulk import lessons from files
  const handleBulkImport = async (sectionId: string) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true });
      if (result.canceled || !result.assets?.length) return;
      const cid = await ensureCourse();
      const section = sections.find(s => s.id === sectionId);
      const startIdx = section?.lessons?.length ?? 0;
      const files = result.assets.map(a => ({
        name: a.name,
        uri: a.uri,
        mimeType: a.mimeType ?? 'application/octet-stream',
        size: a.size ?? 0,
      }));
      const newLessons = await bulkCreateLessonsFromFiles(sectionId, cid, files, startIdx);
      setSections(prev => prev.map(s =>
        s.id === sectionId ? { ...s, lessons: [...(s.lessons ?? []), ...newLessons] } : s
      ));
      showToast({ type: 'success', message: t('cb.toast.lessonsCreated', { count: newLessons.length }) });
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, t('cb.toast.bulkImportFailed')) }); }
  };

  // ── Filter structure
  const filteredSections = structureSearch.trim()
    ? sections.map(s => ({
        ...s,
        lessons: (s.lessons ?? []).filter((l: any) =>
          l.title.toLowerCase().includes(structureSearch.toLowerCase())
        ),
      })).filter(s =>
        s.title.toLowerCase().includes(structureSearch.toLowerCase()) || s.lessons.length > 0
      )
    : sections;

  if (loading) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.base }}>
      <ActivityIndicator color={c.primary} size="large" />
    </View>
  );

  //  COURSE CREATION FEATURE FLAG — a NEW course cannot be created while the
  //  flag is off (the server refuses every create entry point with
  //  403 feature_disabled). Guard the creation route so a direct deep link to
  //  /course-builder/new shows an honest unavailable state instead of a form
  //  that would fail on first save. EDITING an existing course is unaffected.
  if (isNew && !isEnabled('course_creation')) {
    return (
        <View style={{ flex: 1, backgroundColor: c.base, direction: isRTL ? 'rtl' : 'ltr' }}>
        <View style={{
          paddingTop: layout.headerTop, paddingStart: isRTL ? layout.headerRight : layout.headerLeft,
          paddingEnd: isRTL ? layout.headerLeft : layout.headerRight, paddingBottom: 12,
          flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 10,
        }}>
          <Pressable onPress={() => router.back()} hitSlop={8}
            style={[neuFlatStyle(isDark), { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }]}>
            <BackIcon size={20} color={c.text} opacity={0.6} />
          </Pressable>
          <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }}>{t('cb.newCourse')}</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: layout.screenPx }}>
          <FeatureUnavailableState
            title={t('cb.unavailableTitle')}
            description={t('cb.unavailableDesc')}
          />
        </View>
      </View>
    );
  }

  return (
    <>
      <PermissionRationaleModal
        type="mediaLibrary"
        visible={showCoverPhotoRationale}
        isBlocked={coverPhotoBlocked}
        onConfirm={confirmCoverPhotoRequest}
        onDismiss={() => setShowCoverPhotoRationale(false)}
      />
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.base, direction: isRTL ? 'rtl' : 'ltr' }} behavior={undefined} /* keyboard: native inset only */>
      {/* ── Header — spacing from headerTokens (EDGE_PAD=4, BREATHING=8) ── */}
      <View style={{ paddingTop: layout.headerTop, paddingStart: isRTL ? layout.headerRight : layout.headerLeft, paddingEnd: isRTL ? layout.headerLeft : layout.headerRight, paddingBottom: 12, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 10 }}>
        {/* Back */}
        <Pressable onPress={() => router.back()}
          hitSlop={8}
          style={[neuFlatStyle(isDark), { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }]}>
          <BackIcon size={20} color={c.text} opacity={0.6} />
        </Pressable>

        {/* Title + saved flash */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }} numberOfLines={1}>
            {title.trim() || t('cb.newCourse')}
          </Text>
          {savedVisible && (
            <Animated.View style={{ position: 'absolute', bottom: -16, start: 0, ...savedFade.style, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <Check size={10} color="#16A34A" />
              <Text style={{ fontSize: 10, color: '#16A34A', fontWeight: '600' }}>{t('cb.saved')}</Text>
            </Animated.View>
          )}
        </View>

        {/* ── Archived badge ── */}
        {isArchived && (
          <View style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, backgroundColor: '#D9770620', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: '#D97706' }}>{t('courseStatus.archived')}</Text>
          </View>
        )}

        {/* ── WIDE layout: show all action buttons inline ── */}
        {!isNarrow && (              <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 8, flexShrink: 0 }}>

            {courseId && !isArchived && (
              <Pressable onPress={() => setShowArchiveModal(true)}
                style={[neuFlatStyle(isDark), { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }]}>
                <Archive size={17} color="#D97706" opacity={0.8} />
              </Pressable>
            )}
            {courseId && (
              <Pressable onPress={handleDuplicateCourse} disabled={duplicating}
                style={[neuFlatStyle(isDark), { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }]}>
                {duplicating ? <ActivityIndicator size="small" color={c.primary} /> : <Copy size={17} color={c.text} opacity={0.55} />}
              </Pressable>
            )}
            {courseId && (
              <Pressable onPress={() => { setTemplateTitle(title); setShowSaveTemplate(true); }}
                style={[neuFlatStyle(isDark), { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }]}>
                <Bookmark size={17} color={c.text} opacity={0.55} />
              </Pressable>
            )}
            <Pressable onPress={handleSaveAndExit}
              style={[neuFlatStyle(isDark), { paddingHorizontal: 14, paddingVertical: 11, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 6, height: 44 }]}>
              <Save size={15} color={c.primary} />
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>{t('common.save')}</Text>
            </Pressable>
            <Pressable onPress={handlePublish} disabled={publishing || !isFeatureEnabled('doctor_course_publishing')}
              style={{ paddingHorizontal: 14, paddingVertical: 11, borderRadius: 12, height: 44, opacity: isFeatureEnabled('doctor_course_publishing') ? 1 : 0.5,
                backgroundColor: status === 'published' ? '#16A34A' : c.primary,
                flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6 }}>
              {publishing ? <ActivityIndicator size="small" color="#fff" /> : <Check size={15} color="#fff" />}
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>
                {status === 'published' ? t('courseStatus.published') : t('cb.publish')}
              </Text>
            </Pressable>
          </View>
        )}

        {/* ── NARROW layout: Save + Publish + overflow "⋯" ── */}
        {isNarrow && (              <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 8, flexShrink: 0 }}>

            <Pressable onPress={handleSaveAndExit}
              style={[neuFlatStyle(isDark), { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }]}>
              <Save size={17} color={c.primary} />
            </Pressable>
            <Pressable onPress={handlePublish} disabled={publishing || !isFeatureEnabled('doctor_course_publishing')}
              style={{ paddingHorizontal: 12, paddingVertical: 11, borderRadius: 12, height: 44, opacity: isFeatureEnabled('doctor_course_publishing') ? 1 : 0.5,
                backgroundColor: status === 'published' ? '#16A34A' : c.primary,
                flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              {publishing
                ? <ActivityIndicator size="small" color="#fff" />
                : <Check size={14} color="#fff" />}
              <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>
                {status === 'published' ? t('courseStatus.published') : t('cb.publish')}
              </Text>
            </Pressable>
            {/* Overflow "⋯" — only shown when there are extra actions */}
            {courseId && !isArchived && (
              <Pressable onPress={() => setShowOverflowMenu(true)}
                style={[neuFlatStyle(isDark), { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }]}>
                <MoreHorizontal size={20} color={c.text} opacity={0.6} />
              </Pressable>
            )}
          </View>
        )}
      </View>

      {/* ── Overflow Menu Modal (narrow toolbar) ── */}
      <Modal visible={showOverflowMenu} transparent animationType="fade" onRequestClose={() => setShowOverflowMenu(false)}>
        <Pressable style={{ flex: 1, backgroundColor: '#0006', justifyContent: 'flex-end' }}
          onPress={() => setShowOverflowMenu(false)}>
          <Pressable onPress={e => e.stopPropagation()}>
            <View style={[neuFlatStyle(isDark), {
              marginHorizontal: 16, marginBottom: 32, borderRadius: 20, padding: 8, gap: 2, width: screenWidth - 32,
            }]}>
              <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.4),
                paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                {t('cb.moreActions')}
              </Text>
              {/* Duplicate */}
              <Pressable onPress={() => { setShowOverflowMenu(false); handleDuplicateCourse(); }}
                disabled={duplicating}
                style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 14 }}>
                <Copy size={20} color={c.text} opacity={0.65} />
                <Text style={{ fontSize: 15, fontWeight: '600', color: c.text, flex: 1 }} numberOfLines={1}>{t('cb.duplicateCourse')}</Text>
              </Pressable>
              {/* Save as Template */}
              <Pressable onPress={() => { setShowOverflowMenu(false); setTemplateTitle(title); setShowSaveTemplate(true); }}
                style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 14 }}>
                <Bookmark size={20} color={c.text} opacity={0.65} />
                <Text style={{ fontSize: 15, fontWeight: '600', color: c.text, flex: 1 }} numberOfLines={1}>{t('cb.saveAsTemplate')}</Text>
              </Pressable>
              {/* Archive */}
              <Pressable onPress={() => { setShowOverflowMenu(false); setShowArchiveModal(true); }}
                style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 14 }}>
                <Archive size={20} color="#D97706" opacity={0.9} />
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#D97706', flex: 1 }} numberOfLines={1}>{t('cb.archiveCourse')}</Text>
              </Pressable>
              {/* Dismiss */}
              <Pressable onPress={() => setShowOverflowMenu(false)}
                style={{ alignItems: 'center', paddingVertical: 14, marginTop: 4, borderTopWidth: 1, borderColor: `${c.text}12` }}>
                <Text style={{ fontSize: 14, fontWeight: '600', ...mutedTextStyle(c, 0.45) }}>{t('common.cancel')}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Tab Bar ── */}
      <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', paddingHorizontal: layout.screenPx, gap: 8, marginBottom: 4 }}>

        {([
          { key: 'info', label: t('cb.tab.info'), icon: BookOpen },
          { key: 'structure', label: t('cb.tab.structure'), icon: Layers },
          { key: 'settings', label: t('cb.tab.settings'), icon: Settings },
        ] as { key: Tab; label: string; icon: any }[]).map(({ key, label, icon: Icon }) => (
          <Pressable key={key} onPress={() => setTab(key)}
            style={[
              tab === key ? neuPressedStyle(isDark) : neuFlatStyle(isDark),                  { flex: 1, paddingVertical: 10, borderRadius: 14, alignItems: 'center', flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', justifyContent: 'center', gap: 6 },

            ]}>
            <Icon size={15} color={tab === key ? c.primary : c.text} opacity={tab === key ? 1 : 0.45} />
            <Text style={{ fontSize: 13, fontWeight: '700', color: tab === key ? c.primary : c.text, opacity: tab === key ? 1 : 0.55 }}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: INFO
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'info' && (
        <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: layout.screenPx, gap: 16 }}>

          {/* ── PUBLICATION STATE — leads the form ────────────────────────
              This control used to sit at the VERY BOTTOM of the Info tab, where
              doctors routinely overlooked it. It is the decision that gates
              student visibility, so it now appears first. Same two values and
              the same save payload — placement only. */}
          <Field label={t('cb.field.courseStatus')} c={c}>
            <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 10 }}>
              {(['draft', 'published'] as const).map(s => (
                <Pressable key={s} onPress={() => setStatus(s)}
                  style={[
                    status === s ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                    { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
                  ]}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: status === s ? c.primary : c.text, opacity: status === s ? 1 : 0.5 }}>
                    {s === 'published' ? t('courseStatus.published') : t('courseStatus.draft')}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45), marginTop: 6 }}>
              {t('cb.statusHelp')}
            </Text>
          </Field>

          {/* Title */}
          <Field label={t('cb.field.title')} c={c}>
            <NeuInput value={title} onChangeText={setTitle} placeholder={t('cb.field.titlePlaceholder')} isDark={isDark} c={c} />
          </Field>

          {/* Short description */}
          <Field label={t('cb.field.shortDesc')} c={c}>
            <NeuInput value={shortDesc} onChangeText={setShortDesc} placeholder={t('cb.field.shortDescPlaceholder')} isDark={isDark} c={c} multiline />
          </Field>

          {/* Full description */}
          <Field label={t('cb.field.fullDesc')} c={c}>
            <NeuInput value={fullDesc} onChangeText={setFullDesc} placeholder={t('cb.field.fullDescPlaceholder')}
              isDark={isDark} c={c} multiline style={{ minHeight: 100 }} />
          </Field>

          {/* Course Cover — single optional image */}
          <Field label={t('cb.field.cover')} c={c}>
            <CourseCoverSection
              uri={coverImageUrl}
              uploading={uploadingCover}
              onUpload={handleUploadCover}
              onRemove={handleRemoveCover}
              isDark={isDark}
              c={c}
            />
          </Field>

          {/* University */}
          <Field label={t('cb.field.university')} c={c}>
            <PickerRow
              value={universityId} options={universities.map(u => ({ value: u.id, label: u.name }))}
              placeholder={t('cb.selectUniversity')} onChange={v => { setUniversityId(v); setFacultyId(''); }} isDark={isDark} c={c}
            />
          </Field>

          {/* Faculty */}
          {faculties.length > 0 && (
            <Field label={t('cb.field.faculty')} c={c}>
              <PickerRow
                value={facultyId} options={faculties.map(f => ({ value: f.id, label: f.name }))}
                placeholder={t('cb.selectFaculty')} onChange={setFacultyId} isDark={isDark} c={c}
              />
            </Field>
          )}

          {/* Language */}
          <Field label={t('cb.field.language')} c={c}>
            <PickerRow value={language}
              options={LANGUAGES.map(l => ({ value: l, label: l }))}
              placeholder={t('cb.field.language')} onChange={setLanguage} isDark={isDark} c={c} />
          </Field>

          {/* Price (EGP) */}
          <Field label={t('cb.field.price')} c={c}>
            <View style={[neuPressedStyle(isDark), { borderRadius: 12, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', paddingHorizontal: 14 }]}>
              {/* marginEnd keeps the currency code paired with its value in both directions. */}
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary, marginEnd: 8 }}>EGP</Text>
              <TextInput
                value={priceEgp}
                onChangeText={v => setPriceEgp(v.replace(/[^0-9.]/g, ''))}
                placeholder="0"
                placeholderTextColor={inputPlaceholderColor(c)}
                selectionColor={c.primary}
                keyboardType="decimal-pad"
                style={{ flex: 1, fontSize: 16, color: c.text, paddingVertical: 14, fontWeight: '600', textAlign: 'left', writingDirection: 'ltr' }}
              />
              {parseFloat(priceEgp) === 0 || !priceEgp ? (
                <View style={{ backgroundColor: '#16A34A22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>{t('cb.free')}</Text>
                </View>
              ) : (
                <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45) }}>EGP {parseFloat(priceEgp).toFixed(2)}</Text>
              )}
            </View>
            <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4), marginTop: 4 }}>
              {t('cb.priceHelp')}
            </Text>
          </Field>

          {/* ── Contact Methods ─────────────────────────────────────── */}
          <View style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <MessageCircle size={14} color={c.primary} />
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.text, opacity: 0.75 }}>
                {t('cb.contact.title')}
              </Text>
            </View>
            <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45), marginBottom: 10 }}>
              {t('cb.contact.help')}
            </Text>

            {/* Radio: use default vs custom */}
            {[
              { value: true,  label: t('cb.contact.useDefault') },
              { value: false, label: t('cb.contact.useCustom') },
            ].map(opt => (
              <Pressable
                key={String(opt.value)}
                onPress={() => setUseDefaultContact(opt.value)}
                style={{
                  flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 10,
                  paddingVertical: 11, paddingHorizontal: 14,
                  borderRadius: 12, marginBottom: 8,
                  backgroundColor: useDefaultContact === opt.value ? `${c.primary}12` : c.base,
                  borderWidth: 1.5,
                  borderColor: useDefaultContact === opt.value ? c.primary : `${c.text}14`,
                }}
              >
                {/* Radio circle */}
                <View style={{
                  width: 20, height: 20, borderRadius: 10,
                  borderWidth: 2,
                  borderColor: useDefaultContact === opt.value ? c.primary : `${c.text}30`,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {useDefaultContact === opt.value && (
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.primary }} />
                  )}
                </View>
                <Text style={{
                  flex: 1, fontSize: 13, fontWeight: useDefaultContact === opt.value ? '700' : '500',
                  color: useDefaultContact === opt.value ? c.primary : c.text,
                  textAlign: isRTL ? 'right' : 'left', writingDirection: isRTL ? 'rtl' : 'ltr',
                }}>
                  {opt.label}
                </Text>
              </Pressable>
            ))}

            {/* Custom contact fields — only shown when custom is selected */}
            {!useDefaultContact && (
              <View style={{ marginTop: 4, gap: 8 }}>
                <View style={[neuFlatStyle(isDark), { borderRadius: 14, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', paddingHorizontal: 14, gap: 10 }]}>
                  <Text style={{ fontSize: 18 }}>💬</Text>
                  <TextInput
                    value={contactWhatsapp}
                    onChangeText={setContactWhatsapp}
                    placeholder={t('cb.contact.whatsapp')}
                    placeholderTextColor={inputPlaceholderColor(c)}
                    keyboardType="phone-pad"
                    style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 12, textAlign: 'left', writingDirection: 'ltr' }}
                  />
                  {contactWhatsapp.trim() ? <Check size={14} color="#25D366" /> : null}
                </View>
                <View style={[neuFlatStyle(isDark), { borderRadius: 14, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', paddingHorizontal: 14, gap: 10 }]}>
                  <Send size={16} color="#229ED9" />
                  <TextInput
                    value={contactTelegram}
                    onChangeText={setContactTelegram}
                    placeholder={t('cb.contact.telegram')}
                    placeholderTextColor={inputPlaceholderColor(c)}
                    autoCapitalize="none"
                    style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 12, textAlign: 'left', writingDirection: 'ltr' }}
                  />
                  {contactTelegram.trim() ? <Check size={14} color="#229ED9" /> : null}
                </View>
                <View style={[neuFlatStyle(isDark), { borderRadius: 14, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', paddingHorizontal: 14, gap: 10 }]}>
                  <Phone size={15} color="#16A34A" />
                  <TextInput
                    value={contactPhone}
                    onChangeText={setContactPhone}
                    placeholder={t('cb.contact.phone')}
                    placeholderTextColor={inputPlaceholderColor(c)}
                    keyboardType="phone-pad"
                    style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 12, textAlign: 'left', writingDirection: 'ltr' }}
                  />
                  {contactPhone.trim() ? <Check size={14} color="#16A34A" /> : null}
                </View>
                {!contactWhatsapp.trim() && !contactTelegram.trim() && !contactPhone.trim() && (
                  <Text style={{ fontSize: 12, color: '#DC2626', opacity: 0.8, marginTop: 2 }}>
                    {t('cb.contact.required')}
                  </Text>
                )}
              </View>
            )}
          </View>

        </ScrollView>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: STRUCTURE
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'structure' && (
        <View style={{ flex: 1 }}>
          {/* Search + Add Section */}
          <View style={{ paddingHorizontal: layout.screenPx, paddingVertical: 8, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 10 }}>
            <View style={[neuPressedStyle(isDark), { flex: 1, borderRadius: 12, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', paddingHorizontal: 12, gap: 8 }]}>
              <RefreshCw size={14} color={c.text} opacity={0.4} />
              <TextInput
                value={structureSearch} onChangeText={setStructureSearch}
                placeholder={t('cb.searchStructure')}
                placeholderTextColor={inputPlaceholderColor(c)}
                selectionColor={c.primary}
                style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 10,
                  writingDirection: isRTL ? 'rtl' : 'ltr', textAlign: isRTL ? 'right' : 'left' }}
              />
            </View>
            <Pressable onPress={handleAddSection}
              style={{ backgroundColor: c.primary, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Plus size={16} color="#fff" />
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{t('cb.section')}</Text>
            </Pressable>
          </View>

          {/* Course duration summary */}
          {sections.length > 0 && (() => {
            const totalMin = calcCourseDuration(sections);
            const totalLessons = sections.reduce((t: number, s: any) => t + (s.lessons?.length ?? 0), 0);
            return totalMin > 0 ? (
              <View style={{ marginHorizontal: 20, marginBottom: 4, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 8,
                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, backgroundColor: `${c.primary}10` }}>
                <Clock size={13} color={c.primary} />
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>
                  {t('cb.durationTotal', { time: formatStudyTime(totalMin) })}
                </Text>
                <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45) }}>·</Text>
                <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.55) }}>
                  {t('cb.structureSummary', { lessons: totalLessons, sections: sections.length })}
                </Text>
              </View>
            ) : null;
          })()}

          <FlatList
            data={filteredSections}
            keyExtractor={s => s.id}
            contentContainerStyle={{ padding: layout.screenPx, paddingTop: 4, gap: 12 }}
            ListEmptyComponent={
              <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                <Layers size={44} color={c.primary} opacity={0.2} />
                <Text style={{ ...mutedTextStyle(c, 0.4), marginTop: 12, fontSize: 15 }}>{t('cb.noSections')}</Text>
                <Text style={{ ...mutedTextStyle(c, 0.3), fontSize: 13, marginTop: 4 }}>{t('cb.noSectionsHint')}</Text>
              </View>
            }
            renderItem={({ item: section, index: sIdx }) => (
              <NeuCard style={{ padding: 0, overflow: 'hidden' }}>

                {/* ── Section header ── */}
                <Pressable
                  onPress={() => setExpandedSections(prev => {
                    const next = new Set(prev);
                    if (next.has(section.id)) next.delete(section.id); else next.add(section.id);
                    return next;
                  })}
                  style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', padding: 14, gap: 10, minHeight: 56 }}>
                  <GripVertical size={16} color={c.text} opacity={0.3} />
                  {/* Auto-number badge */}
                  <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: `${c.primary}22`,
                    alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: c.primary }}>{sIdx + 1}</Text>
                  </View>

                  {renamingSection === section.id ? (
            <TextInput
              value={renameValue} onChangeText={setRenameValue}
              autoFocus onBlur={() => handleRenameSection(section.id)}
              onSubmitEditing={() => handleRenameSection(section.id)}
              placeholderTextColor={inputPlaceholderColor(c)}
              selectionColor={c.primary}
              style={{ flex: 1, fontSize: 15, fontWeight: '700', color: c.text,
                writingDirection: isRTL ? 'rtl' : 'ltr', textAlign: isRTL ? 'right' : 'left',
                borderBottomWidth: 1, borderColor: c.primary, paddingVertical: 2 }}
            />
                  ) : (
                    <Text style={{ flex: 1, fontSize: 15, fontWeight: '700', color: c.text }} numberOfLines={1}>
                      {section.title}
                    </Text>
                  )}

                  {/* Lesson count badge */}
                  <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
                    backgroundColor: `${c.text}10`, flexShrink: 0 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5) }}>
                      {(section.lessons ?? []).length}
                    </Text>
                  </View>

                  {/* ── WIDE: show all section actions inline ── */}
                  {!isNarrow && (
                    <>
                      <Pressable onPress={() => handleBulkImport(section.id)}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }} hitSlop={4}>
                        <FileUp size={14} color={c.primary} opacity={0.7} />
                      </Pressable>
                      <Pressable onPress={() => moveSectionUp(sIdx)}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }} hitSlop={4}>
                        <ArrowUp size={14} color={c.text} opacity={sIdx === 0 ? 0.15 : 0.5} />
                      </Pressable>
                      <Pressable onPress={() => moveSectionDown(sIdx)}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }} hitSlop={4}>
                        <ArrowDown size={14} color={c.text} opacity={sIdx === sections.length - 1 ? 0.15 : 0.5} />
                      </Pressable>
                      <Pressable onPress={() => { setRenamingSection(section.id); setRenameValue(section.title); }}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }} hitSlop={4}>
                        <Pencil size={14} color={c.primary} opacity={0.7} />
                      </Pressable>
                      <Pressable onPress={() => requestDeleteSection(section)}
                        disabled={deletingSection}
                        accessibilityLabel={t('cb.deleteSection')}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', opacity: deletingSection ? 0.4 : 1 }} hitSlop={4}>
                        <Trash2 size={14} color="#DC2626" opacity={0.7} />
                      </Pressable>
                    </>
                  )}

                  {/* ── NARROW: collapse section actions into ⋯ ── */}
                  {isNarrow && (
                    <Pressable onPress={() => setSectionMoreId(sectionMoreId === section.id ? null : section.id)}
                      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <MoreHorizontal size={18} color={c.text} opacity={0.5} />
                    </Pressable>
                  )}

                  {expandedSections.has(section.id)
                    ? <ChevronDown size={16} color={c.text} opacity={0.4} />
                    : <ChevronForward size={16} color={c.text} opacity={0.4} />}
                </Pressable>

                {/* ── Section "more" drawer (mobile) ── */}
                {isNarrow && sectionMoreId === section.id && (
                  <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', flexWrap: 'wrap', paddingHorizontal: 14, paddingBottom: 10,

                    paddingTop: 2, gap: 8, borderTopWidth: 1, borderColor: `${c.text}10` }}>
                    <Pressable onPress={() => { setRenamingSection(section.id); setRenameValue(section.title); setSectionMoreId(null); }}
                      style={[neuFlatStyle(isDark), { flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6,
                        paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44 }]}>
                      <Pencil size={14} color={c.primary} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.primary }}>{t('cb.rename')}</Text>
                    </Pressable>
                    <Pressable onPress={() => { moveSectionUp(sIdx); setSectionMoreId(null); }}
                      style={[neuFlatStyle(isDark), { flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6,
                        paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                        opacity: sIdx === 0 ? 0.3 : 1 }]}>
                      <ArrowUp size={14} color={c.text} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{t('cb.moveUp')}</Text>
                    </Pressable>
                    <Pressable onPress={() => { moveSectionDown(sIdx); setSectionMoreId(null); }}
                      style={[neuFlatStyle(isDark), { flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6,
                        paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                        opacity: sIdx === sections.length - 1 ? 0.3 : 1 }]}>
                      <ArrowDown size={14} color={c.text} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{t('cb.moveDown')}</Text>
                    </Pressable>
                    <Pressable onPress={() => { handleBulkImport(section.id); setSectionMoreId(null); }}
                      style={[neuFlatStyle(isDark), { flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6,
                        paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44 }]}>
                      <FileUp size={14} color={c.text} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{t('cb.bulkImport')}</Text>
                    </Pressable>
                    <Pressable onPress={() => requestDeleteSection(section)} disabled={deletingSection}
                      style={[neuFlatStyle(isDark), { flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6,
                        paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                        backgroundColor: '#DC262618' }]}>
                      <Trash2 size={14} color="#DC2626" />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: '#DC2626' }}>{t('common.delete')}</Text>
                    </Pressable>
                  </View>
                )}

                {/* ── Lessons ── */}
                {expandedSections.has(section.id) && (
                  <View style={{ borderTopWidth: 1, borderColor: `${c.text}10` }}>
                    {(section.lessons ?? []).map((lesson: any, lIdx: number) => (
                      <View key={lesson.id} style={{ borderBottomWidth: 1, borderColor: `${c.text}08` }}>

                        {/* Main lesson row */}
                        <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center',
                          paddingHorizontal: 14, paddingVertical: 10, gap: 10, minHeight: 56 }}>
                          <GripVertical size={13} color={c.text} opacity={0.2} />
                          {/* Number */}
                          <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.4), minWidth: 18, flexShrink: 0 }}>
                            {lIdx + 1}.
                          </Text>
                          {/* Status dot */}
                          <View style={{ width: 7, height: 7, borderRadius: 3.5, flexShrink: 0,
                            backgroundColor: lesson.status === 'published' ? '#16A34A' : lesson.status === 'scheduled' ? '#3B82F6' : '#D97706' }} />

                          {/* Title + meta */}
                          {renamingLesson === lesson.id ? (
                            <TextInput
                              value={renameValue} onChangeText={setRenameValue}
                              autoFocus
                              onBlur={() => handleRenameLesson(lesson.id, section.id)}
                              onSubmitEditing={() => handleRenameLesson(lesson.id, section.id)}
                              placeholderTextColor={inputPlaceholderColor(c)}
                              selectionColor={c.primary}
                              style={{ flex: 1, fontSize: 13, color: c.text,
                                writingDirection: isRTL ? 'rtl' : 'ltr', textAlign: isRTL ? 'right' : 'left',
                                borderBottomWidth: 1, borderColor: c.primary, paddingVertical: 1 }}
                            />
                          ) : (
                            <Pressable style={{ flex: 1, minWidth: 0 }}
                              onPress={() => router.push(`/(app)/lesson-editor/${lesson.id}` as RelativePathString)}>
                              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={1}>
                                {lesson.title}
                              </Text>
                              <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 6, marginTop: 2, alignItems: 'center' }}>

                                {/* Friendly type label */}
                                <LessonTypeIcon videoType={lesson.video_type} size={9} color={c.primary} />
                                <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45) }}>
                                  {lessonTypeLabel(lesson.video_type, t)}
                                </Text>
                                <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.3) }}>·</Text>
                                {/* Friendly status label */}
                                <Text style={{ fontSize: 11, fontWeight: '600',
                                  color: lesson.status === 'published' ? '#16A34A' : lesson.status === 'scheduled' ? '#3B82F6' : '#D97706',
                                  opacity: 0.85 }}>
                                  {lessonStatusLabel(lesson.status, t)}
                                </Text>
                                {(lesson.estimated_minutes ?? 0) > 0 && (
                                  <>
                                    <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.3) }}>·</Text>
                                    <Clock size={9} color={c.primary} opacity={0.7} />
                                    <Text style={{ fontSize: 11, color: c.primary, opacity: 0.7, fontWeight: '600' }}>
                                      {formatStudyTime(lesson.estimated_minutes)}
                                    </Text>
                                  </>
                                )}
                              </View>
                            </Pressable>
                          )}

                          {/* ── WIDE: inline lesson actions ── */}
                          {!isNarrow && (
                            <>
                              <Pressable onPress={() => moveLessonUp(lIdx, section.id)}
                                style={{ width: 36, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                                <ArrowUp size={13} color={c.text} opacity={lIdx === 0 ? 0.15 : 0.5} />
                              </Pressable>
                              <Pressable onPress={() => moveLessonDown(lIdx, section.id)}
                                style={{ width: 36, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                                <ArrowDown size={13} color={c.text} opacity={lIdx === (section.lessons?.length ?? 0) - 1 ? 0.15 : 0.5} />
                              </Pressable>
                              <Pressable onPress={() => { setRenamingLesson(lesson.id); setRenameValue(lesson.title); }}
                                style={{ width: 36, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                                <Pencil size={13} color={c.primary} opacity={0.7} />
                              </Pressable>
                              <Pressable onPress={() => handleDuplicateLesson(lesson.id, section.id)}
                                style={{ width: 36, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                                <RefreshCw size={13} color={c.text} opacity={0.45} />
                              </Pressable>
                              <Pressable onPress={() => handleDeleteLesson(lesson.id, section.id)}
                                style={{ width: 36, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                                <Trash2 size={13} color="#DC2626" opacity={0.6} />
                              </Pressable>
                            </>
                          )}

                          {/* ── NARROW: lesson ⋯ menu + edit arrow ── */}
                          {isNarrow && (
                            <Pressable onPress={() => setLessonMoreId(lessonMoreId === lesson.id ? null : lesson.id)}
                              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              <MoreHorizontal size={16} color={c.text} opacity={0.45} />
                            </Pressable>
                          )}

                          {/* Open lesson editor */}
                          <Pressable onPress={() => router.push(`/(app)/lesson-editor/${lesson.id}` as RelativePathString)}
                            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <ChevronForward size={15} color={c.primary} opacity={0.6} />
                          </Pressable>
                        </View>

                        {/* ── Lesson "more" drawer (mobile) ── */}
                        {isNarrow && lessonMoreId === lesson.id && (
                          <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', flexWrap: 'wrap', paddingHorizontal: 14,
                            paddingBottom: 10, paddingTop: 2, gap: 8, backgroundColor: `${c.text}05` }}>
                            <Pressable onPress={() => { setRenamingLesson(lesson.id); setRenameValue(lesson.title); setLessonMoreId(null); }}
                              style={[neuFlatStyle(isDark), { flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6,
                                paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44 }]}>
                              <Pencil size={13} color={c.primary} />
                              <Text style={{ fontSize: 13, fontWeight: '600', color: c.primary }}>{t('cb.rename')}</Text>
                            </Pressable>
                            <Pressable onPress={() => { moveLessonUp(lIdx, section.id); setLessonMoreId(null); }}
                              style={[neuFlatStyle(isDark), { flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6,
                                paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                                opacity: lIdx === 0 ? 0.3 : 1 }]}>
                              <ArrowUp size={13} color={c.text} />
                              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{t('cb.moveUp')}</Text>
                            </Pressable>
                            <Pressable onPress={() => { moveLessonDown(lIdx, section.id); setLessonMoreId(null); }}
                              style={[neuFlatStyle(isDark), { flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6,
                                paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                                opacity: lIdx === (section.lessons?.length ?? 0) - 1 ? 0.3 : 1 }]}>
                              <ArrowDown size={13} color={c.text} />
                              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{t('cb.moveDown')}</Text>
                            </Pressable>
                            <Pressable onPress={() => { handleDuplicateLesson(lesson.id, section.id); setLessonMoreId(null); }}
                              style={[neuFlatStyle(isDark), { flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6,
                                paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44 }]}>
                              <RefreshCw size={13} color={c.text} />
                              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{t('cb.duplicate')}</Text>
                            </Pressable>
                            <Pressable onPress={() => { handleDeleteLesson(lesson.id, section.id); setLessonMoreId(null); }}
                              style={[neuFlatStyle(isDark), { flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 6,
                                paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                                backgroundColor: '#DC262618' }]}>
                              <Trash2 size={13} color="#DC2626" />
                              <Text style={{ fontSize: 13, fontWeight: '600', color: '#DC2626' }}>{t('common.delete')}</Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    ))}

                    {/* Add Lesson + Bulk Import footer */}
                    <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', borderTopWidth: 1, borderColor: `${c.text}08` }}>
                      <Pressable onPress={() => handleAddLesson(section.id)}
                        style={{ flex: 1, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', padding: 12, gap: 8, minHeight: 44, opacity: 0.65 }}>
                        <Plus size={14} color={c.primary} />
                        <Text style={{ fontSize: 13, color: c.primary, fontWeight: '600' }}>{t('cb.addLesson')}</Text>
                      </Pressable>
                      <Pressable onPress={() => handleBulkImport(section.id)}
                        style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', padding: 12, gap: 6, minHeight: 44, opacity: 0.65 }}>
                        <FileUp size={14} color={c.text} opacity={0.6} />
                        <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6), fontWeight: '600' }}>{t('cb.bulkImport')}</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </NeuCard>
            )}
          />
        </View>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: SETTINGS
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'settings' && (
        <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: layout.screenPx, gap: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }}>{t('cb.learningAccess')}</Text>

          <ToggleRow label={t('cb.sequential')} sub={t('cb.sequentialSub')}
            value={sequential} onChange={setSequential} isDark={isDark} c={c} />
          <ToggleRow label={t('cb.freePreview')} sub={t('cb.freePreviewSub')}
            value={freePreview} onChange={setFreePreview} isDark={isDark} c={c} />
          <ToggleRow label={t('cb.certificate')} sub={t('cb.certificateSub')}
            value={certificate} onChange={setCertificate} isDark={isDark} c={c} />
          <ToggleRow label={t('cb.subscriptionRequired')} sub={t('cb.subscriptionRequiredSub')}
            value={subscriptionRequired} onChange={setSubscriptionRequired} isDark={isDark} c={c} />

          {/* Platform info — credit cost is always 1, not configurable */}
          <NeuCard style={[neuPressedStyle(isDark), { padding: 14, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 12 }]}>
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 18 }}>🎓</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{t('cb.enrollmentCost')}</Text>
              <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45), marginTop: 2 }}>
                {t('cb.enrollmentCostSub')}
              </Text>
            </View>
          </NeuCard>

          <NeuButton label={t('cb.saveSettings')} onPress={handleSaveAndExit} fullWidth />
        </ScrollView>
      )}

      {/* ── Publish Checklist Modal ── */}
      {showPublishCheck && (
        <View style={{ position: 'absolute', inset: 0, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <NeuCard style={{ width: '100%', maxWidth: 420 }}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, marginBottom: 4 }}>{t('cb.publishChecklist')}</Text>
            <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5), marginBottom: 16 }}>{t('cb.publishChecklistIntro')}</Text>
            {getPublishIssues().map((issue, i) => (
              <View key={`issue-${i}`} style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
                <Text style={{ fontSize: 16, color: '#DC2626' }}>✗</Text>
                <Text style={{ fontSize: 13, color: c.text, flex: 1 }}>{issue}</Text>
              </View>
            ))}
            {videoBlockers.length > 0 && (
              <>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#D97706', marginTop: 8, marginBottom: 6 }}>
                  {t('cb.videoIncomplete')}
                </Text>
                {videoBlockers.map((b, i) => (
                  <View key={`vb-${i}`} style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 8, marginBottom: 6, alignItems: 'flex-start',
                    backgroundColor: '#D9770612', borderRadius: 8, padding: 8 }}>
                    <Text style={{ fontSize: 12, color: '#D97706' }}>•</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{b.lessonTitle}</Text>
                      <Text style={{ fontSize: 11, color: '#D97706' }}>{b.reason}</Text>
                    </View>
                  </View>
                ))}
              </>
            )}
            <View style={{ marginTop: 16 }}>
              <NeuButton label={t('cb.goBackFix')} onPress={() => setShowPublishCheck(false)} fullWidth />
            </View>
          </NeuCard>
        </View>
      )}

      {/* ── Start Modal (Blank or Template) ── */}
      <Modal visible={showStartModal} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Pressable onPress={e => e.stopPropagation()}>
            <NeuCard style={{ width: Math.min(screenWidth - 40, 440) }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 4 }}>{t('cb.startNewCourse')}</Text>
              <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5), marginBottom: 20 }}>{t('cb.startNewCourseHelp')}</Text>
              {/* Blank */}
              <Pressable onPress={() => setShowStartModal(false)}
                style={[neuFlatStyle(isDark), { borderRadius: 14, padding: 16, marginBottom: 10, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 14 }]}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: `${c.primary}22`, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <BookOpen size={20} color={c.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }} numberOfLines={1}>{t('cb.startBlank')}</Text>
                  <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45) }} numberOfLines={1}>{t('cb.startBlankSub')}</Text>
                </View>
              </Pressable>
              {/* Templates */}
              {loadingTemplates ? (
                <ActivityIndicator color={c.primary} style={{ marginVertical: 16 }} />
              ) : templates.length > 0 ? (
                <>
                  <Text style={{ fontSize: 12, fontWeight: '700', ...mutedTextStyle(c, 0.45), marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                    {t('cb.savedTemplates')}
                  </Text>
                  {templates.map(t => (
                    <Pressable key={t.id} onPress={() => handleStartFromTemplate(t.id)}
                      style={[neuFlatStyle(isDark), { borderRadius: 14, padding: 14, marginBottom: 8, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 12 }]}>
                      <Bookmark size={18} color={c.primary} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>{t.title}</Text>
                        {t.description ? <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45) }} numberOfLines={1}>{t.description}</Text> : null}
                      </View>
                      <ChevronForward size={16} color={c.text} opacity={0.35} />
                    </Pressable>
                  ))}
                </>
              ) : null}
              <Pressable onPress={() => setShowStartModal(false)} style={{ alignItems: 'center', marginTop: 8, padding: 8 }}>
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.4) }}>{t('cb.dismiss')}</Text>
              </Pressable>
            </NeuCard>
          </Pressable>
        </View>
      </Modal>

      {/* ── Archive Confirmation Modal ── */}
      <Modal visible={showArchiveModal} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Pressable onPress={e => e.stopPropagation()}>
            <NeuCard style={{ width: Math.min(screenWidth - 40, 420) }}>
              <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#D9770618', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Archive size={20} color="#D97706" />
                </View>
                <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, flex: 1 }} numberOfLines={1}>{t('cb.archiveCourse')}</Text>
              </View>
              <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.55), marginBottom: 16, lineHeight: 20 }}>
                {t('cb.archiveHelp')}
              </Text>
              <View style={{ gap: 6, marginBottom: 16 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', ...mutedTextStyle(c, 0.5) }}>{t('cb.reasonOptional')}</Text>
                <TextInput
                  value={archiveReason}
                  onChangeText={setArchiveReason}
                  placeholder={t('cb.reasonPlaceholder')}
                  placeholderTextColor={inputPlaceholderColor(c)}
                  multiline
                  style={{ borderRadius: 12, padding: 12, fontSize: 13, color: c.text, minHeight: 80,
                    textAlignVertical: 'top', backgroundColor: c.base,
                    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
                    shadowOpacity: 0.5, shadowRadius: 6 }}
                />
              </View>
              <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 10 }}>
                <Pressable onPress={() => setShowArchiveModal(false)} style={[neuFlatStyle(isDark), { flex: 1, minWidth: 100, padding: 12, borderRadius: 12, alignItems: 'center' }]}>
                  <Text style={{ fontSize: 14, fontWeight: '700', ...mutedTextStyle(c, 0.55) }} numberOfLines={1}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable onPress={handleArchive} disabled={archiving}
                  style={{ flex: 1, minWidth: 100, padding: 12, borderRadius: 12, alignItems: 'center', backgroundColor: '#D97706', opacity: archiving ? 0.6 : 1 }}>
                  {archiving
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }} numberOfLines={1}>{t('cb.archive')}</Text>}
                </Pressable>
              </View>
            </NeuCard>
          </Pressable>
        </View>
      </Modal>

      {/* ── Delete Section Confirmation ── */}
      <Modal visible={!!deleteSectionTarget} transparent animationType="fade"
        onRequestClose={() => { if (!deletingSection) setDeleteSectionTarget(null); }}>
        <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Pressable onPress={e => e.stopPropagation()}>
            <NeuCard style={{ width: Math.min(screenWidth - 40, 420) }}>
              <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Trash2 size={20} color="#DC2626" />
                </View>
                <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, flex: 1 }} numberOfLines={1}>
                  {t('cb.deleteSection')}
                </Text>
              </View>

              <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6), marginBottom: 12, lineHeight: 20 }}>
                {t('cb.deleteSectionConfirmBody')}
              </Text>

              <View style={{ borderRadius: 12, padding: 12, marginBottom: 14, backgroundColor: `${c.text}08` }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={2}>
                  {deleteSectionTarget?.title}
                </Text>
              </View>

              {(deleteSectionTarget?.lessons?.length ?? 0) > 0 ? (
                <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 10, borderRadius: 12, padding: 12, marginBottom: 16, backgroundColor: '#DC262610' }}>
                  <Trash2 size={15} color="#DC2626" style={{ marginTop: 1, flexShrink: 0 }} />
                  <Text style={{ flex: 1, fontSize: 12, lineHeight: 18, color: '#DC2626', fontWeight: '500' }}>
                    {t('cb.deleteSectionLessonsWarning', {
                      lessons: tCount('drCourses.lessonCount', deleteSectionTarget?.lessons?.length ?? 0),
                    })}
                  </Text>
                </View>
              ) : (
                <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5), marginBottom: 16, lineHeight: 18 }}>
                  {t('cb.deleteSectionEmptyHint')}
                </Text>
              )}

              <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 10 }}>
                <Pressable onPress={() => setDeleteSectionTarget(null)} disabled={deletingSection}
                  style={[neuFlatStyle(isDark), { flex: 1, minWidth: 100, padding: 12, borderRadius: 12, alignItems: 'center' }]}>
                  <Text style={{ fontSize: 14, fontWeight: '700', ...mutedTextStyle(c, 0.55) }} numberOfLines={1}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable onPress={handleDeleteSection} disabled={deletingSection}
                  style={{ flex: 1, minWidth: 100, padding: 12, borderRadius: 12, alignItems: 'center',
                    backgroundColor: '#DC2626', opacity: deletingSection ? 0.6 : 1 }}>
                  {deletingSection
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }} numberOfLines={1}>{t('common.delete')}</Text>}
                </Pressable>
              </View>
            </NeuCard>
          </Pressable>
        </View>
      </Modal>

      {/* ── Save as Template Modal ── */}
      <Modal visible={showSaveTemplate} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Pressable onPress={e => e.stopPropagation()}>
            <NeuCard style={{ width: Math.min(screenWidth - 40, 400) }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: c.text, marginBottom: 12 }}>{t('cb.saveAsTemplate')}</Text>
              <NeuInput value={templateTitle} onChangeText={setTemplateTitle}
                placeholder={t('cb.templateName')} isDark={isDark} c={c} style={{ marginBottom: 14 }} />
              <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 10 }}>
                <Pressable onPress={() => setShowSaveTemplate(false)}
                  style={[neuFlatStyle(isDark), { flex: 1, minWidth: 100, padding: 12, borderRadius: 12, alignItems: 'center' }]}>
                  <Text style={{ fontSize: 14, fontWeight: '700', ...mutedTextStyle(c, 0.55) }} numberOfLines={1}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable onPress={handleSaveTemplate} disabled={savingTemplate || !templateTitle.trim()}
                  style={{ flex: 1, minWidth: 100, padding: 12, borderRadius: 12, alignItems: 'center', backgroundColor: c.primary, opacity: templateTitle.trim() ? 1 : 0.45 }}>
                  {savingTemplate ? <ActivityIndicator size="small" color="#fff" /> :
                    <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }} numberOfLines={1}>{t('common.save')}</Text>}
                </Pressable>
              </View>
            </NeuCard>
          </Pressable>
        </View>
      </Modal>
    </KeyboardAvoidingView>
    </>
  );
}

// ── Shared sub-components ──────────────────────────────────────────────────────

function Field({ label, children, c }: { label: string; children: React.ReactNode; c?: typeof neuColors.light }) {
  const { isRTL } = useTranslation();
  const scheme = useColorScheme();
  const palette = c ?? (scheme === 'dark' ? neuColors.dark : neuColors.light);
  return (
    <View style={{ gap: 6 }}>
      <Text style={[{ fontSize: 13, fontWeight: '700', textAlign: isRTL ? 'right' : 'left' }, mutedTextStyle(palette, 0.6)]}>{label}</Text>
      {children}
    </View>
  );
}

function NeuInput({ isDark, c, style, ...props }: any) {
  const { isRTL } = useTranslation();
  return (
    <TextInput
      placeholderTextColor={inputPlaceholderColor(c)}
      selectionColor={c.primary}
      style={[{
        ...neuPressedStyle(isDark),
        borderRadius: 12,
        padding: 14,
        fontSize: 14,
        color: c.text,
        writingDirection: isRTL ? 'rtl' : 'ltr',
        textAlign: isRTL ? 'right' : 'left',
        textAlignVertical: 'top',
      }, style]}
      {...props}
    />
  );
}

/**
 * Course cover upload / replace / remove widget.
 *
 * Empty state  → single "Upload Cover" button only (no placeholder box).
 * Cover exists → 16:9 preview + "Replace Cover" + "Remove Cover" buttons.
 *
 * The two states are fully distinct so there is never an ambiguous
 * "empty image container with action buttons" situation.
 */
function CourseCoverSection({
  uri, uploading, onUpload, onRemove, isDark, c,
}: {
  uri: string;
  uploading: boolean;
  onUpload: () => void;
  onRemove: () => void;
  isDark: boolean;
  c: any;
}) {
  const hasCover = !!uri;
  const { t } = useTranslation();

  // ── Empty state: one clear upload button ──────────────────────────────────
  if (!hasCover) {
    return (
      <Pressable
        onPress={!uploading ? onUpload : undefined}
        style={[
          neuFlatStyle(isDark),
          { flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            gap: 8, paddingVertical: 14, borderRadius: 14 },
        ]}
      >
        {uploading
          ? <ActivityIndicator size="small" color={c.primary} />
          : <Upload size={16} color={c.primary} />}
        <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary }}>
          {uploading ? t('cb.cover.uploading') : t('cb.cover.upload')}
        </Text>
      </Pressable>
    );
  }

  // ── Cover exists: preview + Replace / Remove ──────────────────────────────
  return (
    <View style={{ gap: 10 }}>
      {/* 16:9 preview */}
      <View style={[neuFlatStyle(isDark), { borderRadius: 16, overflow: 'hidden', aspectRatio: 16 / 9 }]}>
        <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
        {/* Upload-in-progress overlay */}
        {uploading && (
          <View style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: '#000a', alignItems: 'center', justifyContent: 'center',
          }}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
        )}
      </View>

      {/* Action row */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pressable
          onPress={!uploading ? onUpload : undefined}
          style={[
            neuFlatStyle(isDark),
            { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              gap: 7, paddingVertical: 11, borderRadius: 12 },
          ]}
        >
          <RefreshCw size={15} color={c.primary} />
          <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>{t('cb.cover.replace')}</Text>
        </Pressable>
        <Pressable
          onPress={!uploading ? onRemove : undefined}
          style={[
            neuFlatStyle(isDark),
            { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              gap: 7, paddingVertical: 11, borderRadius: 12 },
          ]}
        >
          <Trash2 size={15} color="#DC2626" />
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>{t('cb.cover.remove')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function PickerRow({ value, options, placeholder, onChange, isDark, c }: {
  value: string;
  options: { value: string; label: string }[];
  placeholder: string;
  onChange: (v: string) => void;
  isDark: boolean;
  c: any;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(o => o.value === value);
  const { isRTL } = useTranslation();
  return (
    <View>
      <Pressable onPress={() => setOpen(o => !o)}
        style={[neuPressedStyle(isDark), { borderRadius: 12, padding: 14, flexDirection: 'row', alignItems: 'center' }]}>
        <Text style={{ flex: 1, fontSize: 14, color: selected ? c.text : inputPlaceholderColor(c), textAlign: isRTL ? 'right' : 'left' }}>
          {selected?.label ?? placeholder}
        </Text>
        <ChevronDown size={16} color={c.text} opacity={0.4} />
      </Pressable>
      {open && (
        <NeuCard style={{ marginTop: 4, padding: 4, maxHeight: 200, overflow: 'hidden' }}>
          <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {options.map(opt => (
              <Pressable key={opt.value} onPress={() => { onChange(opt.value); setOpen(false); }}
                style={{ padding: 12, borderRadius: 10, backgroundColor: value === opt.value ? `${c.primary}18` : 'transparent' }}>
                <Text style={{ fontSize: 14, color: c.text, fontWeight: value === opt.value ? '700' : '400', textAlign: isRTL ? 'right' : 'left' }}>
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </NeuCard>
      )}
    </View>
  );
}

function inputPlaceholderColor(c: typeof neuColors.light): string {
  return c.mode === 'dark' ? c.textMuted : '#56657A';
}

function ToggleRow({ label, sub, value, onChange, isDark, c }: {
  label: string; sub: string; value: boolean;
  onChange: (v: boolean) => void; isDark: boolean; c: any;
}) {
  const { isRTL } = useTranslation();
  return (
    <Pressable onPress={() => onChange(!value)}
      style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 14 }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, textAlign: isRTL ? 'right' : 'left' }}>{label}</Text>
        <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.55), marginTop: 2, textAlign: isRTL ? 'right' : 'left' }}>{sub}</Text>
      </View>
      <View style={[
        value ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
        { width: 48, height: 28, borderRadius: 14, justifyContent: 'center', paddingHorizontal: 3 },
        { backgroundColor: value ? c.primary : undefined },
      ]}>
        <View style={{
          width: 22, height: 22, borderRadius: 11, backgroundColor: value ? '#fff' : `${c.text}40`,
          alignSelf: value ? 'flex-end' : 'flex-start',
        }} />
      </View>
    </Pressable>
  );
}
