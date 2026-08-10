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
  ArrowLeft, ArrowDown, ArrowUp, Archive, BookOpen, Check, CheckCircle, ChevronDown,
  ChevronRight, Clock, Copy, GripVertical, Layers, MoreHorizontal, Pencil, Phone, Plus, RefreshCw, Save, Settings,
  Trash2, Upload, Bookmark, X, FileUp, MessageCircle, Send, Video, FileText,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

import { NeuButton } from '@/components/NeuButton';
import { NeuCard } from '@/components/NeuCard';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, neuFlatStyle, neuPressedStyle, safeTop, safeLeft, safeRight, safeBottom } from '@/lib/neu';
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

// ── Types ─────────────────────────────────────────────────────────────────────
type Tab = 'info' | 'structure' | 'settings';
type CourseStartMode = 'blank' | 'template';

const LANGUAGES = ['Arabic', 'English', 'French', 'German', 'Spanish', 'Turkish', 'Urdu'];

// ── Helpers ────────────────────────────────────────────────────────────────────
/** Human-readable "Saved X min ago" label — kept for internal use only. */
function savedLabel(date: Date): string {
  const diffMs  = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)  return '✓ Saved just now';
  if (diffMin === 1) return '✓ Saved 1 min ago';
  if (diffMin < 60) return `✓ Saved ${diffMin} min ago`;
  return `✓ Last saved: ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`;
}

/** Maps internal video_type values to user-friendly display labels. */
function lessonTypeLabel(videoType: string | undefined): string {
  switch (videoType) {
    case 'vdocipher':    return 'Video Lesson';
    case 'youtube':      return 'Video Lesson';
    case 'pdf':          return 'PDF Lesson';
    case 'coming_soon':  return 'Coming Soon';
    case 'text':         return 'Text Lesson';
    default:             return 'Lesson';
  }
}

/** Maps internal status values to user-friendly display labels. */
function lessonStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'draft':      return 'Draft';
    case 'published':  return 'Published';
    case 'scheduled':  return 'Scheduled';
    default:           return status
      ? status.charAt(0).toUpperCase() + status.slice(1)
      : 'Draft';
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

  const isNew = id === 'new';

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
  const [instructorName, setInstructorName] = useState('');
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
    instructor_name: instructorName,
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
      setInstructorName(data.instructor_name ?? '');
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
      showToast({ type: 'error', message: friendlyError(e, 'Failed to load course.') });
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
    if (!title.trim()) throw new Error('Enter a course title first.');
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
      showToast({ type: 'error', message: friendlyError(e, 'Save course first.') });
      return;
    }

    setUploadingCover(true);
    try {
      const mimeType = asset.mimeType ?? 'image/jpeg';
      const publicUrl = await uploadCourseCover(cid, asset.uri, mimeType, coverImageUrl || undefined);
      setCoverImageUrl(publicUrl);
      showToast({ type: 'success', message: 'Cover image updated.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Cover upload failed.') });
    }
    setUploadingCover(false);
  };

  const handleRemoveCover = async () => {
    if (!courseId || !coverImageUrl) return;
    setUploadingCover(true);
    try {
      await removeCourseCover(courseId, coverImageUrl);
      setCoverImageUrl('');
      showToast({ type: 'success', message: 'Cover image removed.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Remove cover failed.') });
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
      showToast({ type: 'success', message: 'Course archived.' });
      router.back();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Archive failed.') });
    }
    setArchiving(false);
  };

  // ── Section operations
  const handleAddSection = async () => {
    try {
      const cid = await ensureCourse();
      const s = await createSection(cid, 'New Section', sections.length);
      setSections(prev => [...prev, { ...s, lessons: [] }]);
      setExpandedSections(prev => new Set([...prev, s.id]));
      setRenamingSection(s.id);
      setRenameValue('New Section');
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed to add section.') }); }
  };

  const handleRenameSection = async (sectionId: string) => {
    if (!renameValue.trim()) return;
    try {
      await updateSection(sectionId, { title: renameValue.trim() });
      setSections(prev => prev.map(s => s.id === sectionId ? { ...s, title: renameValue.trim() } : s));
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed to rename.') }); }
    setRenamingSection(null);
  };

  const handleDeleteSection = async (sectionId: string) => {
    try {
      await deleteSection(sectionId);
      setSections(prev => prev.filter(s => s.id !== sectionId));
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed to delete section.') }); }
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
        title: 'New Lesson', order_index: orderIndex,
        video_type: 'vdocipher', status: 'draft',
      });
      setSections(prev => prev.map(s =>
        s.id === sectionId ? { ...s, lessons: [...(s.lessons ?? []), lesson] } : s
      ));
      setRenamingLesson(lesson.id);
      setRenameValue('New Lesson');
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed to add lesson.') }); }
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
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed to rename.') }); }
    setRenamingLesson(null);
  };

  const handleDeleteLesson = async (lessonId: string, sectionId: string) => {
    try {
      await deleteLesson(lessonId);
      setSections(prev => prev.map(s =>
        s.id === sectionId ? { ...s, lessons: s.lessons.filter((l: any) => l.id !== lessonId) } : s
      ));
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed to delete lesson.') }); }
  };

  const handleDuplicateLesson = async (lessonId: string, sectionId: string) => {
    try {
      const section = sections.find(s => s.id === sectionId);
      const lesson = await duplicateLesson(lessonId, section?.lessons?.length ?? 0);
      setSections(prev => prev.map(s =>
        s.id === sectionId ? { ...s, lessons: [...(s.lessons ?? []), lesson] } : s
      ));
      showToast({ type: 'success', message: 'Lesson duplicated.' });
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed to duplicate.') }); }
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
    if (!title.trim()) issues.push('Course title is required.');
    // Contact: when using default, the doctor's profile contact is used — no per-course check needed here.
    // When using custom, at least one custom field must be set.
    if (!useDefaultContact && !contactWhatsapp.trim() && !contactTelegram.trim() && !contactPhone.trim()) {
      issues.push('At least one contact method (WhatsApp, Telegram, or Phone) is required.');
    }
    if (sections.length === 0) issues.push('At least one section is required.');
    sections.forEach(s => {
      if ((s.lessons ?? []).length === 0) issues.push(`Section "${s.title}" has no lessons.`);
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
        issues.push(`Lesson "${l.title}" has no video.`);
      }
    });
    return issues;
  };

  const handlePublish = async () => {
    const freshData = courseId ? await getCourseById(courseId).catch(() => null) : null;
    const freshSections: any[] = freshData?.sections ?? sections;
    const freshUseDefault = freshData ? (freshData.use_default_contact !== false) : useDefaultContact;
    const freshWhatsapp   = freshData?.whatsapp   ?? contactWhatsapp;
    const freshTelegram   = freshData?.telegram   ?? contactTelegram;
    const freshPhone      = freshData?.phone      ?? contactPhone;

    const getIssues = (sects: any[]) => {
      const issues: string[] = [];
      if (!title.trim()) issues.push('Course title is required.');
      if (!freshUseDefault && !freshWhatsapp.trim() && !freshTelegram.trim() && !freshPhone.trim()) {
        issues.push('At least one contact method (WhatsApp, Telegram, or Phone) is required.');
      }
      if (sects.length === 0) issues.push('At least one section is required.');
      sects.forEach(s => {
        if ((s.lessons ?? []).length === 0) issues.push(`Section "${s.title}" has no lessons.`);
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
        if (!hasVideo) issues.push(`Lesson "${l.title}" has no video.`);
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
      await publishCourse(resolvedId);
      setStatus('published');
      showToast({ type: 'success', message: 'Course published!' });
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Publish failed.') }); }
    setPublishing(false);
  };

  const handleSaveAndExit = async () => {
    try {
      const cid = await ensureCourse();
      await updateCourse(cid, autoSaveFields);
      showToast({ type: 'success', message: 'Course saved.' });
      router.back();
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Save failed.') }); }
  };

  // ── Duplicate course
  const handleDuplicateCourse = async () => {
    if (!courseId || !profile) return;
    setDuplicating(true);
    try {
      const newId = await duplicateCourse(courseId, profile.id);
      showToast({ type: 'success', message: 'Course duplicated! Opening copy…' });
      router.replace(`/(app)/course-builder/${newId}` as RelativePathString);
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Duplication failed.') }); }
    setDuplicating(false);
  };

  // ── Save as template
  const handleSaveTemplate = async () => {
    if (!courseId || !profile || !templateTitle.trim()) return;
    setSavingTemplate(true);
    try {
      await saveCourseAsTemplate(courseId, profile.id, templateTitle.trim());
      showToast({ type: 'success', message: 'Saved as template!' });
      setShowSaveTemplate(false);
      setTemplateTitle('');
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Save template failed.') }); }
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
      showToast({ type: 'success', message: 'Course created from template.' });
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Failed to start from template.') }); }
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
      showToast({ type: 'success', message: `${newLessons.length} lessons created.` });
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Bulk import failed.') }); }
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

  return (
    <>
      <PermissionRationaleModal
        type="mediaLibrary"
        visible={showCoverPhotoRationale}
        isBlocked={coverPhotoBlocked}
        onConfirm={confirmCoverPhotoRequest}
        onDismiss={() => setShowCoverPhotoRationale(false)}
      />
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.base }} behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'}>
      {/* ── Header — spacing from headerTokens (EDGE_PAD=4, BREATHING=8) ── */}
      <View style={{ paddingTop: layout.headerTop, paddingLeft: layout.headerLeft, paddingRight: layout.headerRight, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {/* Back */}
        <Pressable onPress={() => router.back()}
          hitSlop={8}
          style={[neuFlatStyle(isDark), { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }]}>
          <ArrowLeft size={20} color={c.text} opacity={0.6} />
        </Pressable>

        {/* Title + saved flash */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }} numberOfLines={1}>
            {title.trim() || 'New Course'}
          </Text>
          {savedVisible && (
            <Animated.View style={{ position: 'absolute', bottom: -16, left: 0, ...savedFade.style, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <Check size={10} color="#16A34A" />
              <Text style={{ fontSize: 10, color: '#16A34A', fontWeight: '600' }}>Saved</Text>
            </Animated.View>
          )}
        </View>

        {/* ── Archived badge ── */}
        {isArchived && (
          <View style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, backgroundColor: '#D9770620', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: '#D97706' }}>ARCHIVED</Text>
          </View>
        )}

        {/* ── WIDE layout: show all action buttons inline ── */}
        {!isNarrow && (
          <View style={{ flexDirection: 'row', gap: 8, flexShrink: 0 }}>
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
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>Save</Text>
            </Pressable>
            <Pressable onPress={handlePublish} disabled={publishing}
              style={{ paddingHorizontal: 14, paddingVertical: 11, borderRadius: 12, height: 44,
                backgroundColor: status === 'published' ? '#16A34A' : c.primary,
                flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {publishing ? <ActivityIndicator size="small" color="#fff" /> : <Check size={15} color="#fff" />}
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>
                {status === 'published' ? 'Published' : 'Publish'}
              </Text>
            </Pressable>
          </View>
        )}

        {/* ── NARROW layout: Save + Publish + overflow "⋯" ── */}
        {isNarrow && (
          <View style={{ flexDirection: 'row', gap: 8, flexShrink: 0 }}>
            <Pressable onPress={handleSaveAndExit}
              style={[neuFlatStyle(isDark), { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }]}>
              <Save size={17} color={c.primary} />
            </Pressable>
            <Pressable onPress={handlePublish} disabled={publishing}
              style={{ paddingHorizontal: 12, paddingVertical: 11, borderRadius: 12, height: 44,
                backgroundColor: status === 'published' ? '#16A34A' : c.primary,
                flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              {publishing
                ? <ActivityIndicator size="small" color="#fff" />
                : <Check size={14} color="#fff" />}
              <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>
                {status === 'published' ? 'Published' : 'Publish'}
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
              <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4,
                paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                More Actions
              </Text>
              {/* Duplicate */}
              <Pressable onPress={() => { setShowOverflowMenu(false); handleDuplicateCourse(); }}
                disabled={duplicating}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 14 }}>
                <Copy size={20} color={c.text} opacity={0.65} />
                <Text style={{ fontSize: 15, fontWeight: '600', color: c.text, flex: 1 }} numberOfLines={1}>Duplicate Course</Text>
              </Pressable>
              {/* Save as Template */}
              <Pressable onPress={() => { setShowOverflowMenu(false); setTemplateTitle(title); setShowSaveTemplate(true); }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 14 }}>
                <Bookmark size={20} color={c.text} opacity={0.65} />
                <Text style={{ fontSize: 15, fontWeight: '600', color: c.text, flex: 1 }} numberOfLines={1}>Save as Template</Text>
              </Pressable>
              {/* Archive */}
              <Pressable onPress={() => { setShowOverflowMenu(false); setShowArchiveModal(true); }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 14 }}>
                <Archive size={20} color="#D97706" opacity={0.9} />
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#D97706', flex: 1 }} numberOfLines={1}>Archive Course</Text>
              </Pressable>
              {/* Dismiss */}
              <Pressable onPress={() => setShowOverflowMenu(false)}
                style={{ alignItems: 'center', paddingVertical: 14, marginTop: 4, borderTopWidth: 1, borderColor: `${c.text}12` }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: c.text, opacity: 0.45 }}>Cancel</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Tab Bar ── */}
      <View style={{ flexDirection: 'row', paddingHorizontal: layout.screenPx, gap: 8, marginBottom: 4 }}>
        {([
          { key: 'info', label: 'Info', icon: BookOpen },
          { key: 'structure', label: 'Structure', icon: Layers },
          { key: 'settings', label: 'Settings', icon: Settings },
        ] as { key: Tab; label: string; icon: any }[]).map(({ key, label, icon: Icon }) => (
          <Pressable key={key} onPress={() => setTab(key)}
            style={[
              tab === key ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
              { flex: 1, paddingVertical: 10, borderRadius: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 },
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
        <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: layout.screenPx, gap: 16, paddingBottom: layout.scrollBottom() }}>

          {/* Title */}
          <Field label="Course Title *">
            <NeuInput value={title} onChangeText={setTitle} placeholder="e.g. Clinical Pharmacology" isDark={isDark} c={c} />
          </Field>

          {/* Short description */}
          <Field label="Short Description *">
            <NeuInput value={shortDesc} onChangeText={setShortDesc} placeholder="One-line summary shown in listings" isDark={isDark} c={c} multiline />
          </Field>

          {/* Full description */}
          <Field label="Full Description *">
            <NeuInput value={fullDesc} onChangeText={setFullDesc} placeholder="Detailed course description, objectives, outcomes…"
              isDark={isDark} c={c} multiline style={{ minHeight: 100 }} />
          </Field>

          {/* Course Cover — single optional image */}
          <Field label="Course Cover (Optional)">
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
          <Field label="University">
            <PickerRow
              value={universityId} options={universities.map(u => ({ value: u.id, label: u.name }))}
              placeholder="Select university" onChange={v => { setUniversityId(v); setFacultyId(''); }} isDark={isDark} c={c}
            />
          </Field>

          {/* Faculty */}
          {faculties.length > 0 && (
            <Field label="Faculty">
              <PickerRow
                value={facultyId} options={faculties.map(f => ({ value: f.id, label: f.name }))}
                placeholder="Select faculty" onChange={setFacultyId} isDark={isDark} c={c}
              />
            </Field>
          )}

          {/* Language */}
          <Field label="Language">
            <PickerRow value={language}
              options={LANGUAGES.map(l => ({ value: l, label: l }))}
              placeholder="Language" onChange={setLanguage} isDark={isDark} c={c} />
          </Field>

          {/* Instructor */}
          <Field label="Instructor Name">
            <NeuInput value={instructorName} onChangeText={setInstructorName} placeholder="e.g. Dr. Ahmed Ali" isDark={isDark} c={c} />
          </Field>

          {/* Price (EGP) */}
          <Field label="Course Price (EGP) *">
            <View style={[neuPressedStyle(isDark), { borderRadius: 12, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }]}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary, marginRight: 8 }}>EGP</Text>
              <TextInput
                value={priceEgp}
                onChangeText={v => setPriceEgp(v.replace(/[^0-9.]/g, ''))}
                placeholder="0"
                placeholderTextColor={`${c.text}55`}
                keyboardType="decimal-pad"
                style={{ flex: 1, fontSize: 16, color: c.text, paddingVertical: 14, fontWeight: '600' }}
              />
              {parseFloat(priceEgp) === 0 || !priceEgp ? (
                <View style={{ backgroundColor: '#16A34A22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>Free</Text>
                </View>
              ) : (
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.45 }}>EGP {parseFloat(priceEgp).toFixed(2)}</Text>
              )}
            </View>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: 4 }}>
              Set to 0 to offer the course for free.
            </Text>
          </Field>

          {/* ── Contact Methods ─────────────────────────────────────── */}
          <View style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <MessageCircle size={14} color={c.primary} />
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.text, opacity: 0.75 }}>
                Contact Information
              </Text>
            </View>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginBottom: 10 }}>
              Students will use these to subscribe to this course.
            </Text>

            {/* Radio: use default vs custom */}
            {[
              { value: true,  label: 'Use my default contact information' },
              { value: false, label: 'Use custom contact information for this course' },
            ].map(opt => (
              <Pressable
                key={String(opt.value)}
                onPress={() => setUseDefaultContact(opt.value)}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
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
                }}>
                  {opt.label}
                </Text>
              </Pressable>
            ))}

            {/* Custom contact fields — only shown when custom is selected */}
            {!useDefaultContact && (
              <View style={{ marginTop: 4, gap: 8 }}>
                <View style={[neuFlatStyle(isDark), { borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 }]}>
                  <Text style={{ fontSize: 18 }}>💬</Text>
                  <TextInput
                    value={contactWhatsapp}
                    onChangeText={setContactWhatsapp}
                    placeholder="WhatsApp number  e.g. +201234567890"
                    placeholderTextColor={`${c.text}44`}
                    keyboardType="phone-pad"
                    style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 12 }}
                  />
                  {contactWhatsapp.trim() ? <Check size={14} color="#25D366" /> : null}
                </View>
                <View style={[neuFlatStyle(isDark), { borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 }]}>
                  <Send size={16} color="#229ED9" />
                  <TextInput
                    value={contactTelegram}
                    onChangeText={setContactTelegram}
                    placeholder="Telegram  e.g. @username or https://t.me/…"
                    placeholderTextColor={`${c.text}44`}
                    autoCapitalize="none"
                    style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 12 }}
                  />
                  {contactTelegram.trim() ? <Check size={14} color="#229ED9" /> : null}
                </View>
                <View style={[neuFlatStyle(isDark), { borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 }]}>
                  <Phone size={15} color="#16A34A" />
                  <TextInput
                    value={contactPhone}
                    onChangeText={setContactPhone}
                    placeholder="Phone number  e.g. +201234567890"
                    placeholderTextColor={`${c.text}44`}
                    keyboardType="phone-pad"
                    style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 12 }}
                  />
                  {contactPhone.trim() ? <Check size={14} color="#16A34A" /> : null}
                </View>
                {!contactWhatsapp.trim() && !contactTelegram.trim() && !contactPhone.trim() && (
                  <Text style={{ fontSize: 12, color: '#DC2626', opacity: 0.8, marginTop: 2 }}>
                    Please add at least one contact method.
                  </Text>
                )}
              </View>
            )}
          </View>

          {/* Status toggle */}
          <Field label="Course Status">
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {(['draft', 'published'] as const).map(s => (
                <Pressable key={s} onPress={() => setStatus(s)}
                  style={[
                    status === s ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                    { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
                  ]}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: status === s ? c.primary : c.text, opacity: status === s ? 1 : 0.5, textTransform: 'capitalize' }}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </Field>
        </ScrollView>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: STRUCTURE
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'structure' && (
        <View style={{ flex: 1 }}>
          {/* Search + Add Section */}
          <View style={{ paddingHorizontal: layout.screenPx, paddingVertical: 8, flexDirection: 'row', gap: 10 }}>
            <View style={[neuPressedStyle(isDark), { flex: 1, borderRadius: 12, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 }]}>
              <RefreshCw size={14} color={c.text} opacity={0.4} />
              <TextInput
                value={structureSearch} onChangeText={setStructureSearch}
                placeholder="Search sections & lessons…"
                placeholderTextColor={`${c.text}55`}
                style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 10 }}
              />
            </View>
            <Pressable onPress={handleAddSection}
              style={{ backgroundColor: c.primary, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Plus size={16} color="#fff" />
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Section</Text>
            </Pressable>
          </View>

          {/* Course duration summary */}
          {sections.length > 0 && (() => {
            const totalMin = calcCourseDuration(sections);
            const totalLessons = sections.reduce((t: number, s: any) => t + (s.lessons?.length ?? 0), 0);
            return totalMin > 0 ? (
              <View style={{ marginHorizontal: 20, marginBottom: 4, flexDirection: 'row', alignItems: 'center', gap: 8,
                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, backgroundColor: `${c.primary}10` }}>
                <Clock size={13} color={c.primary} />
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>
                  {formatStudyTime(totalMin)} total
                </Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.45 }}>·</Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.55 }}>
                  {totalLessons} lessons across {sections.length} sections
                </Text>
              </View>
            ) : null;
          })()}

          <FlatList
            data={filteredSections}
            keyExtractor={s => s.id}
            contentContainerStyle={{ padding: layout.screenPx, paddingTop: 4, paddingBottom: layout.scrollBottom(), gap: 12 }}
            contentInsetAdjustmentBehavior="automatic"
            ListEmptyComponent={
              <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                <Layers size={44} color={c.primary} opacity={0.2} />
                <Text style={{ color: c.text, opacity: 0.4, marginTop: 12, fontSize: 15 }}>No sections yet</Text>
                <Text style={{ color: c.text, opacity: 0.3, fontSize: 13, marginTop: 4 }}>{'Tap "+ Section" to get started'}</Text>
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
                  style={{ flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10, minHeight: 56 }}>
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
                      style={{ flex: 1, fontSize: 15, fontWeight: '700', color: c.text,
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
                    <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5 }}>
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
                      <Pressable onPress={() => handleDeleteSection(section.id)}
                        style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }} hitSlop={4}>
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
                    : <ChevronRight size={16} color={c.text} opacity={0.4} />}
                </Pressable>

                {/* ── Section "more" drawer (mobile) ── */}
                {isNarrow && sectionMoreId === section.id && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingBottom: 10,
                    paddingTop: 2, gap: 8, borderTopWidth: 1, borderColor: `${c.text}10` }}>
                    <Pressable onPress={() => { setRenamingSection(section.id); setRenameValue(section.title); setSectionMoreId(null); }}
                      style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 6,
                        paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44 }]}>
                      <Pencil size={14} color={c.primary} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.primary }}>Rename</Text>
                    </Pressable>
                    <Pressable onPress={() => { moveSectionUp(sIdx); setSectionMoreId(null); }}
                      style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 6,
                        paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                        opacity: sIdx === 0 ? 0.3 : 1 }]}>
                      <ArrowUp size={14} color={c.text} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>Move Up</Text>
                    </Pressable>
                    <Pressable onPress={() => { moveSectionDown(sIdx); setSectionMoreId(null); }}
                      style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 6,
                        paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                        opacity: sIdx === sections.length - 1 ? 0.3 : 1 }]}>
                      <ArrowDown size={14} color={c.text} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>Move Down</Text>
                    </Pressable>
                    <Pressable onPress={() => { handleBulkImport(section.id); setSectionMoreId(null); }}
                      style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 6,
                        paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44 }]}>
                      <FileUp size={14} color={c.text} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>Bulk Import</Text>
                    </Pressable>
                    <Pressable onPress={() => { handleDeleteSection(section.id); setSectionMoreId(null); }}
                      style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 6,
                        paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                        backgroundColor: '#DC262618' }]}>
                      <Trash2 size={14} color="#DC2626" />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: '#DC2626' }}>Delete</Text>
                    </Pressable>
                  </View>
                )}

                {/* ── Lessons ── */}
                {expandedSections.has(section.id) && (
                  <View style={{ borderTopWidth: 1, borderColor: `${c.text}10` }}>
                    {(section.lessons ?? []).map((lesson: any, lIdx: number) => (
                      <View key={lesson.id} style={{ borderBottomWidth: 1, borderColor: `${c.text}08` }}>

                        {/* Main lesson row */}
                        <View style={{ flexDirection: 'row', alignItems: 'center',
                          paddingHorizontal: 14, paddingVertical: 10, gap: 10, minHeight: 56 }}>
                          <GripVertical size={13} color={c.text} opacity={0.2} />
                          {/* Number */}
                          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, minWidth: 18, flexShrink: 0 }}>
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
                              style={{ flex: 1, fontSize: 13, color: c.text,
                                borderBottomWidth: 1, borderColor: c.primary, paddingVertical: 1 }}
                            />
                          ) : (
                            <Pressable style={{ flex: 1, minWidth: 0 }}
                              onPress={() => router.push(`/(app)/lesson-editor/${lesson.id}` as RelativePathString)}>
                              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={1}>
                                {lesson.title}
                              </Text>
                              <View style={{ flexDirection: 'row', gap: 6, marginTop: 2, alignItems: 'center' }}>
                                {/* Friendly type label */}
                                <LessonTypeIcon videoType={lesson.video_type} size={9} color={c.primary} />
                                <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>
                                  {lessonTypeLabel(lesson.video_type)}
                                </Text>
                                <Text style={{ fontSize: 11, color: c.text, opacity: 0.3 }}>·</Text>
                                {/* Friendly status label */}
                                <Text style={{ fontSize: 11, fontWeight: '600',
                                  color: lesson.status === 'published' ? '#16A34A' : lesson.status === 'scheduled' ? '#3B82F6' : '#D97706',
                                  opacity: 0.85 }}>
                                  {lessonStatusLabel(lesson.status)}
                                </Text>
                                {(lesson.estimated_minutes ?? 0) > 0 && (
                                  <>
                                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.3 }}>·</Text>
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
                            <ChevronRight size={15} color={c.primary} opacity={0.6} />
                          </Pressable>
                        </View>

                        {/* ── Lesson "more" drawer (mobile) ── */}
                        {isNarrow && lessonMoreId === lesson.id && (
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14,
                            paddingBottom: 10, paddingTop: 2, gap: 8, backgroundColor: `${c.text}05` }}>
                            <Pressable onPress={() => { setRenamingLesson(lesson.id); setRenameValue(lesson.title); setLessonMoreId(null); }}
                              style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 6,
                                paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44 }]}>
                              <Pencil size={13} color={c.primary} />
                              <Text style={{ fontSize: 13, fontWeight: '600', color: c.primary }}>Rename</Text>
                            </Pressable>
                            <Pressable onPress={() => { moveLessonUp(lIdx, section.id); setLessonMoreId(null); }}
                              style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 6,
                                paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                                opacity: lIdx === 0 ? 0.3 : 1 }]}>
                              <ArrowUp size={13} color={c.text} />
                              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>Move Up</Text>
                            </Pressable>
                            <Pressable onPress={() => { moveLessonDown(lIdx, section.id); setLessonMoreId(null); }}
                              style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 6,
                                paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                                opacity: lIdx === (section.lessons?.length ?? 0) - 1 ? 0.3 : 1 }]}>
                              <ArrowDown size={13} color={c.text} />
                              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>Move Down</Text>
                            </Pressable>
                            <Pressable onPress={() => { handleDuplicateLesson(lesson.id, section.id); setLessonMoreId(null); }}
                              style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 6,
                                paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44 }]}>
                              <RefreshCw size={13} color={c.text} />
                              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>Duplicate</Text>
                            </Pressable>
                            <Pressable onPress={() => { handleDeleteLesson(lesson.id, section.id); setLessonMoreId(null); }}
                              style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 6,
                                paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 44,
                                backgroundColor: '#DC262618' }]}>
                              <Trash2 size={13} color="#DC2626" />
                              <Text style={{ fontSize: 13, fontWeight: '600', color: '#DC2626' }}>Delete</Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    ))}

                    {/* Add Lesson + Bulk Import footer */}
                    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: `${c.text}08` }}>
                      <Pressable onPress={() => handleAddLesson(section.id)}
                        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8, minHeight: 44, opacity: 0.65 }}>
                        <Plus size={14} color={c.primary} />
                        <Text style={{ fontSize: 13, color: c.primary, fontWeight: '600' }}>Add Lesson</Text>
                      </Pressable>
                      <Pressable onPress={() => handleBulkImport(section.id)}
                        style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 6, minHeight: 44, opacity: 0.65 }}>
                        <FileUp size={14} color={c.text} opacity={0.6} />
                        <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, fontWeight: '600' }}>Bulk Import</Text>
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
        <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: layout.screenPx, gap: 16, paddingBottom: layout.scrollBottom() }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: c.text, opacity: 0.7 }}>Learning & Access</Text>

          <ToggleRow label="Sequential Learning" sub="Students must complete lessons in order"
            value={sequential} onChange={setSequential} isDark={isDark} c={c} />
          <ToggleRow label="Free Preview" sub="Allow non-enrolled students to preview the course"
            value={freePreview} onChange={setFreePreview} isDark={isDark} c={c} />
          <ToggleRow label="Certificate" sub="Issue a certificate on completion"
            value={certificate} onChange={setCertificate} isDark={isDark} c={c} />
          <ToggleRow label="Subscription Required" sub="Students must subscribe to access lessons"
            value={subscriptionRequired} onChange={setSubscriptionRequired} isDark={isDark} c={c} />

          {/* Platform info — credit cost is always 1, not configurable */}
          <NeuCard style={[neuPressedStyle(isDark), { padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 18 }}>🎓</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>Enrollment Cost: 1 Credit</Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 2 }}>
                Set by the platform. Students use 1 credit to subscribe.
              </Text>
            </View>
          </NeuCard>

          <NeuButton label="Save Settings" onPress={handleSaveAndExit} fullWidth />
        </ScrollView>
      )}

      {/* ── Publish Checklist Modal ── */}
      {showPublishCheck && (
        <View style={{ position: 'absolute', inset: 0, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <NeuCard style={{ width: '100%', maxWidth: 420 }}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, marginBottom: 4 }}>Publish Checklist</Text>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginBottom: 16 }}>Please resolve the following issues before publishing:</Text>
            {getPublishIssues().map((issue, i) => (
              <View key={`issue-${i}`} style={{ flexDirection: 'row', gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
                <Text style={{ fontSize: 16, color: '#DC2626' }}>✗</Text>
                <Text style={{ fontSize: 13, color: c.text, flex: 1 }}>{issue}</Text>
              </View>
            ))}
            {videoBlockers.length > 0 && (
              <>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#D97706', marginTop: 8, marginBottom: 6 }}>
                  ⚠️ Video uploads incomplete
                </Text>
                {videoBlockers.map((b, i) => (
                  <View key={`vb-${i}`} style={{ flexDirection: 'row', gap: 8, marginBottom: 6, alignItems: 'flex-start',
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
              <NeuButton label="Go Back and Fix" onPress={() => setShowPublishCheck(false)} fullWidth />
            </View>
          </NeuCard>
        </View>
      )}

      {/* ── Start Modal (Blank or Template) ── */}
      <Modal visible={showStartModal} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: '#000a', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Pressable onPress={e => e.stopPropagation()}>
            <NeuCard style={{ width: Math.min(screenWidth - 40, 440) }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 4 }}>Start New Course</Text>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginBottom: 20 }}>Choose how to start building your course.</Text>
              {/* Blank */}
              <Pressable onPress={() => setShowStartModal(false)}
                style={[neuFlatStyle(isDark), { borderRadius: 14, padding: 16, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 14 }]}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: `${c.primary}22`, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <BookOpen size={20} color={c.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }} numberOfLines={1}>Start Blank</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.45 }} numberOfLines={1}>Build from scratch</Text>
                </View>
              </Pressable>
              {/* Templates */}
              {loadingTemplates ? (
                <ActivityIndicator color={c.primary} style={{ marginVertical: 16 }} />
              ) : templates.length > 0 ? (
                <>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.45, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                    Saved Templates
                  </Text>
                  {templates.map(t => (
                    <Pressable key={t.id} onPress={() => handleStartFromTemplate(t.id)}
                      style={[neuFlatStyle(isDark), { borderRadius: 14, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
                      <Bookmark size={18} color={c.primary} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>{t.title}</Text>
                        {t.description ? <Text style={{ fontSize: 12, color: c.text, opacity: 0.45 }} numberOfLines={1}>{t.description}</Text> : null}
                      </View>
                      <ChevronRight size={16} color={c.text} opacity={0.35} />
                    </Pressable>
                  ))}
                </>
              ) : null}
              <Pressable onPress={() => setShowStartModal(false)} style={{ alignItems: 'center', marginTop: 8, padding: 8 }}>
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.4 }}>Dismiss</Text>
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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#D9770618', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Archive size={20} color="#D97706" />
                </View>
                <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, flex: 1 }} numberOfLines={1}>Archive Course</Text>
              </View>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.55, marginBottom: 16, lineHeight: 20 }}>
                This course will be hidden from the public catalog, search, and new subscriptions.
                {'\n\n'}Students already enrolled will retain full access to all lessons, videos, and progress.
              </Text>
              <View style={{ gap: 6, marginBottom: 16 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.5 }}>Reason (optional)</Text>
                <TextInput
                  value={archiveReason}
                  onChangeText={setArchiveReason}
                  placeholder="e.g. Outdated content, under revision…"
                  placeholderTextColor={`${c.text}55`}
                  multiline
                  style={{ borderRadius: 12, padding: 12, fontSize: 13, color: c.text, minHeight: 80,
                    textAlignVertical: 'top', backgroundColor: c.base,
                    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
                    shadowOpacity: 0.5, shadowRadius: 6 }}
                />
              </View>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pressable onPress={() => setShowArchiveModal(false)} style={[neuFlatStyle(isDark), { flex: 1, minWidth: 100, padding: 12, borderRadius: 12, alignItems: 'center' }]}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, opacity: 0.55 }} numberOfLines={1}>Cancel</Text>
                </Pressable>
                <Pressable onPress={handleArchive} disabled={archiving}
                  style={{ flex: 1, minWidth: 100, padding: 12, borderRadius: 12, alignItems: 'center', backgroundColor: '#D97706', opacity: archiving ? 0.6 : 1 }}>
                  {archiving
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }} numberOfLines={1}>Archive</Text>}
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
              <Text style={{ fontSize: 16, fontWeight: '800', color: c.text, marginBottom: 12 }}>Save as Template</Text>
              <NeuInput value={templateTitle} onChangeText={setTemplateTitle}
                placeholder="Template name…" isDark={isDark} c={c} style={{ marginBottom: 14 }} />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pressable onPress={() => setShowSaveTemplate(false)}
                  style={[neuFlatStyle(isDark), { flex: 1, minWidth: 100, padding: 12, borderRadius: 12, alignItems: 'center' }]}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, opacity: 0.55 }} numberOfLines={1}>Cancel</Text>
                </Pressable>
                <Pressable onPress={handleSaveTemplate} disabled={savingTemplate || !templateTitle.trim()}
                  style={{ flex: 1, minWidth: 100, padding: 12, borderRadius: 12, alignItems: 'center', backgroundColor: c.primary, opacity: templateTitle.trim() ? 1 : 0.45 }}>
                  {savingTemplate ? <ActivityIndicator size="small" color="#fff" /> :
                    <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }} numberOfLines={1}>Save</Text>}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: '700', opacity: 0.55 }}>{label}</Text>
      {children}
    </View>
  );
}

function NeuInput({ isDark, c, style, ...props }: any) {
  return (
    <TextInput
      placeholderTextColor={`${c.text}55`}
      style={[{
        ...neuPressedStyle(isDark),
        borderRadius: 12,
        padding: 14,
        fontSize: 14,
        color: c.text,
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
          {uploading ? 'Uploading…' : 'Upload Cover'}
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
          <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>Replace Cover</Text>
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
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Remove Cover</Text>
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
  return (
    <View>
      <Pressable onPress={() => setOpen(o => !o)}
        style={[neuPressedStyle(isDark), { borderRadius: 12, padding: 14, flexDirection: 'row', alignItems: 'center' }]}>
        <Text style={{ flex: 1, fontSize: 14, color: selected ? c.text : `${c.text}55` }}>
          {selected?.label ?? placeholder}
        </Text>
        <ChevronDown size={16} color={c.text} opacity={0.4} />
      </Pressable>
      {open && (
        <NeuCard style={{ marginTop: 4, padding: 4, maxHeight: 200, overflow: 'hidden' }}>
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {options.map(opt => (
              <Pressable key={opt.value} onPress={() => { onChange(opt.value); setOpen(false); }}
                style={{ padding: 12, borderRadius: 10, backgroundColor: value === opt.value ? `${c.primary}18` : 'transparent' }}>
                <Text style={{ fontSize: 14, color: c.text, fontWeight: value === opt.value ? '700' : '400' }}>
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

function ToggleRow({ label, sub, value, onChange, isDark, c }: {
  label: string; sub: string; value: boolean;
  onChange: (v: boolean) => void; isDark: boolean; c: any;
}) {
  return (
    <Pressable onPress={() => onChange(!value)}
      style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{label}</Text>
        <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 2 }}>{sub}</Text>
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
