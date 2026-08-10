/**
 * LessonEditor — Per-lesson editor with video upload, materials, and settings.
 * Route: /lesson-editor/[id]
 * Auto-saves on field changes after 1.5 s debounce.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, FlatList, KeyboardAvoidingView, Modal,
  Pressable, ScrollView, Text, TextInput, useColorScheme, View,
  useWindowDimensions,
} from 'react-native';
import { useFadeAnim } from '@/lib/motion';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft, Check, CheckCircle, ChevronDown, Clock, Download,
  Eye, EyeOff, FileText, Film,
  Layers, MessageCircle, Paperclip, Play, Plus, RefreshCw, Save,
  Settings, ShieldAlert, Trash2, Upload, Video, Calendar, AlertCircle, X, RotateCcw,
} from 'lucide-react-native';
import * as DocumentPicker from 'expo-document-picker';
import { randomUUID } from 'expo-crypto';

import { NeuButton } from '@/components/NeuButton';
import { NeuCard } from '@/components/NeuCard';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, neuFlatStyle, neuPressedStyle, safeTop, safeLeft, safeRight, safeBottom } from '@/lib/neu';
import { useProfileStore } from '@/lib/store';
import { friendlyError } from '@/lib/validation';
import {
  createLessonMaterial, deleteLessonMaterial, getLessonById,
  updateLesson, updateMaterialPermission,
  uploadLessonMaterial, replaceLessonMaterialFile,
  getLessonVideoState, getVdoCipherVideoStatus, markLessonVideoMissing,
  getMyProviderPermissions,
  type LessonBuilderPayload, type DownloadPermission, type TeacherProviderPermission,
} from '@/lib/api';
import {
  attachAssetToLesson, getVideoAssetUsage,
  type VideoAsset,
} from '@/lib/videoLibraryApi';
import { VideoLibraryPicker } from '@/components/VideoLibraryPicker';
import { VideoReplaceSheet } from '@/components/VideoReplaceSheet';
import { useUploadQueueStore } from '@/lib/uploadQueueStore';import {
  createUploadRecord, checkDuplicateVideo, analyzeFile, clearLessonVideoRef,
  type FileAnalysis,
} from '@/lib/videoUploadEngine';
import { useVideoUploader } from '@/lib/useVideoUploader';
import { validateVideoFile, resolveUploadMime } from '@/lib/videoFormats';
import { LargeFileWarning } from '@/components/LargeFileWarning';
import { VideoThumbnailCard } from '@/components/VideoThumbnailCard';

/** Format seconds → "12m 34s" */
function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Friendly label for each upload status stage */
function uploadStatusLabel(status: string): string {
  switch (status) {
    case 'waiting':            return 'Queued…';
    case 'uploading':          return 'Uploading…';
    case 'processing':         return 'Processing video…';
    case 'encoding':           return 'Encoding…';
    case 'generating_streams': return 'Generating streams…';
    case 'verifying':          return 'Verifying…';
    case 'ready':              return 'Ready';
    case 'failed':             return 'Upload failed';
    case 'timeout':            return 'Processing timed out';
    case 'canceled':           return 'Canceled';
    default:                   return status;
  }
}

type VideoType = 'vdocipher' | 'coming_soon' | 'youtube';
type LessonTab = 'video' | 'materials' | 'settings';

/** Extract the 11-char YouTube video ID from any standard YouTube URL format. */
function extractYouTubeId(input: string): string | null {
  const trimmed = input.trim();
  const match = trimmed.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );
  if (match) return match[1];
  // Plain 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}
type LessonStatus = 'draft' | 'published' | 'hidden' | 'scheduled' | 'archived';

const LESSON_STATUSES: { value: LessonStatus; label: string; color: string }[] = [
  { value: 'draft',     label: 'Draft',     color: '#D97706' },
  { value: 'published', label: 'Published', color: '#16A34A' },
  { value: 'hidden',    label: 'Hidden',    color: '#6B7280' },
  { value: 'scheduled', label: 'Scheduled', color: '#3B82F6' },
  { value: 'archived',  label: 'Archived',  color: '#9CA3AF' },
];

const PERMISSION_OPTIONS: { value: DownloadPermission; label: string; icon: any; color: string }[] = [
  { value: 'allow',        label: 'Allow',       icon: Download, color: '#16A34A' },
  { value: 'preview_only', label: 'Preview Only', icon: Eye,      color: '#3B82F6' },
  { value: 'hidden',       label: 'Hidden',       icon: EyeOff,   color: '#6B7280' },
  { value: 'disabled',     label: 'Disabled',     icon: Layers,   color: '#DC2626' },
];

/** Video source options shown to the doctor. */
const VIDEO_TYPES: { value: VideoType; label: string; icon: any; color: string }[] = [
  { value: 'vdocipher',   label: 'Video Lesson',  icon: Video, color: '#7C3AED' },
  { value: 'youtube',     label: 'YouTube Video', icon: Film,  color: '#DC2626' },
  { value: 'coming_soon', label: 'Coming Soon',   icon: Clock, color: '#D97706' },
];

const FILE_ICONS: Record<string, { icon: any; color: string }> = {
  'application/pdf':   { icon: FileText, color: '#DC2626' },
  'video/':            { icon: Film,     color: '#7C3AED' },
  'image/':            { icon: Eye,      color: '#16A34A' },
  default:             { icon: Paperclip, color: '#2563EB' },
};

function fileIcon(mimeType: string) {
  if (mimeType.startsWith('video/')) return FILE_ICONS['video/'];
  if (mimeType.startsWith('image/')) return FILE_ICONS['image/'];
  return FILE_ICONS[mimeType] ?? FILE_ICONS.default;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Human-readable "Saved X min ago" label. */
function savedLabel(date: Date): string {
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (diffMin < 1) return '✓ Saved just now';
  if (diffMin === 1) return '✓ Saved 1 min ago';
  if (diffMin < 60) return `✓ Saved ${diffMin} min ago`;
  return `✓ Last saved: ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`;
}

export default function LessonEditor() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { width: screenWidth } = useWindowDimensions();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useProfileStore();
  const { showToast } = useToast();
  const layout = useLayout();
  const insets = layout.insets;

  const [tab, setTab] = useState<LessonTab>('video');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  // Transient "✓ Saved" flash — reserves NO layout space
  const [savedVisible, setSavedVisible] = useState(false);
  const savedFade = useFadeAnim(savedVisible, { duration: 500 });
  const showSavedFlash = useCallback(() => {
    setSavedVisible(true);
    setTimeout(() => setSavedVisible(false), 1700);
  }, []);
  const [uploading, setUploading] = useState(false);
  const [duplicateInfo, setDuplicateInfo] = useState<{ fileName: string; existingLesson?: string } | null>(null);
  const [pendingFile, setPendingFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [fileAnalysis, setFileAnalysis] = useState<FileAnalysis | null>(null);
  const [showLargeFileWarning, setShowLargeFileWarning] = useState(false);
  const [pendingReplaceOldPath, setPendingReplaceOldPath] = useState<string | null>(null);
  const [videoThumbnailUrl, setVideoThumbnailUrl] = useState<string | null>(null);
  const [autoThumbnailUrl, setAutoThumbnailUrl] = useState<string | null>(null);
  const [currentUploadId, setCurrentUploadId] = useState<string | null>(null);
  const { addTask, setQueueVisible, tasks } = useUploadQueueStore();
  const { cancelUpload, retryProcessing, deleteVideo } = useVideoUploader();

  // Upload-complete dialog
  const [showUploadCompleteDialog, setShowUploadCompleteDialog] = useState(false);
  const [completedTaskSnapshot, setCompletedTaskSnapshot] = useState<any>(null);
  const [showDeleteVideoDialog, setShowDeleteVideoDialog] = useState(false);
  const [videoMissing, setVideoMissing] = useState(false);
  const [auditingVideo, setAuditingVideo] = useState(false);
  const prevTasksRef = useRef<typeof tasks>([]);

  // Lesson metadata
  const [lesson, setLesson] = useState<any>(null);
  const [materials, setMaterials] = useState<any[]>([]);

  // Video fields
  const [videoType, setVideoType] = useState<VideoType>('vdocipher');
  const [videoId, setVideoId] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [videoPlaybackId, setVideoPlaybackId] = useState('');
  const [videoThumbnail, setVideoThumbnail] = useState('');
  // YouTube-specific
  const [youtubeVideoId, setYoutubeVideoId] = useState('');
  const [youtubeUrlInput, setYoutubeUrlInput] = useState('');
  const [youtubeUrlError, setYoutubeUrlError] = useState<string | null>(null);

  // Content
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState('draft');

  // Settings
  const [isPreview, setIsPreview] = useState(false);
  const [downloadEnabled, setDownloadEnabled] = useState(true);
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  const [visible, setVisible] = useState(true);
  const [scheduledAt, setScheduledAt] = useState('');

  // Provider permissions (doctor-role gate for upload options)
  const [providerPerms, setProviderPerms] = useState<TeacherProviderPermission[]>([]);

  // Per-material permission picker & replace tracking
  const [openPermMenu, setOpenPermMenu] = useState<string | null>(null);
  const [replacingId, setReplacingId] = useState<string | null>(null);

  // ── Video Library state ───────────────────────────────────────────────────
  // Picker shown when no video is linked yet ("Choose From Library")
  const [showLibraryPicker, setShowLibraryPicker] = useState(false);
  // Replace sheet shown when a video is already linked ("Replace")
  const [showReplaceSheet, setShowReplaceSheet] = useState(false);
  // How many lessons share the current video_asset_id (for replace-scope prompt)
  const [sharedLessonCount, setSharedLessonCount] = useState(0);

  // Auto-save timer
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleAutoSave = useCallback((updates: Partial<LessonBuilderPayload>) => {
    if (!id) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await updateLesson(id, updates);
        setLastSaved(new Date());
        showSavedFlash();
      } catch (_) {}
      setSaving(false);
    }, 1500);
  }, [id]);

  const loadLesson = useCallback(async () => {
    if (!id) return;
    try {
      const data = await getLessonById(id);
      setLesson(data);
      setTitle(data.title ?? '');
      setDescription(data.description ?? '');
      setNotes(data.notes ?? '');
      setStatus(data.status ?? 'draft');
      setVideoType(data.video_type ?? 'vdocipher');
      setVideoId(data.video_id ?? '');
      setVideoTitle(data.video_title ?? '');
      setVideoPlaybackId(data.video_playback_id ?? '');
      setVideoThumbnail(data.video_thumbnail ?? '');
      // YouTube
      const ytId = data.youtube_video_id ?? '';
      setYoutubeVideoId(ytId);
      setYoutubeUrlInput(ytId ? `https://youtu.be/${ytId}` : '');
      setVideoThumbnailUrl(data.video_thumbnail_url ?? null);
      setAutoThumbnailUrl(data.video_thumbnail_url ?? null);
      setIsPreview(data.is_preview ?? false);
      setDownloadEnabled(data.download_enabled ?? true);
      setCommentsEnabled(data.comments_enabled ?? true);
      setVisible(data.visible ?? true);
      setScheduledAt(data.scheduled_at ?? '');
      setMaterials(data.lesson_materials ?? []);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to load lesson.') });
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { loadLesson(); }, [loadLesson]);

  // Load provider permissions for doctors so the upload UI can gate correctly
  useEffect(() => {
    if (!profile) return;
    if (!['doctor', 'admin', 'super_admin'].includes(profile.role ?? '')) return;
    (async () => {
      try {
        const perms = await getMyProviderPermissions();
        setProviderPerms(perms);
      } catch (_) { /* non-fatal — fail open so existing uploads aren't broken */ }
    })();
  }, [profile]);

  // ── Consistency audit: verify provider_video_id exists in VdoCipher ──────
  // Runs whenever the lesson loads and has video_status='ready' + a video_id.
  // If VdoCipher reports the asset is missing, marks the lesson 'video_missing'
  // so the doctor sees a clear "Re-upload" prompt instead of a broken player.
  useEffect(() => {
    if (!lesson || !id) return;
    if (lesson.video_status !== 'ready' && lesson.video_status !== 'video_missing') return;
    if (!lesson.video_id) return;
    // Skip if there's already an active upload for this lesson
    const hasActiveTask = tasks.some(
      (t) => t.lessonId === id && !['ready', 'canceled', 'failed', 'timeout'].includes(t.status),
    );
    if (hasActiveTask) return;

    (async () => {
      setAuditingVideo(true);
      try {
        const result = await getVdoCipherVideoStatus(lesson.video_id);
        if (result?.status === 'failed' || result?.error) {
          // Asset is confirmed gone on VdoCipher side
          console.warn('[consistencyAudit] VdoCipher asset missing for lesson', {
            lessonId: id, videoId: lesson.video_id, result,
          });
          await markLessonVideoMissing(id);
          setVideoMissing(true);
          setVideoId('');
        } else {
          // Asset exists — clear any previous missing flag
          if (lesson.video_status === 'video_missing') {
            // Was previously marked missing but is now found — refresh lesson
            await loadLesson();
          }
          setVideoMissing(false);
        }
      } catch (e) {
        // Network error — don't mark missing; surface silently
        console.warn('[consistencyAudit] check failed (non-fatal):', e);
      } finally {
        setAuditingVideo(false);
      }
    })();
  }, [lesson?.id, lesson?.video_status, lesson?.video_id]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Trigger auto-save on field changes
  useEffect(() => {
    if (!lesson) return;
    scheduleAutoSave({
      title, description, notes, status,
      video_type: videoType, video_id: videoId, video_title: videoTitle,
      video_playback_id: videoPlaybackId, video_thumbnail: videoThumbnail,
      youtube_video_id: youtubeVideoId || undefined,
      is_preview: isPreview, download_enabled: downloadEnabled,
      comments_enabled: commentsEnabled, visible,
      scheduled_at: scheduledAt || undefined,
    });
  }, [title, description, notes, status, videoType, videoId, videoTitle, videoPlaybackId,
    videoThumbnail, youtubeVideoId, isPreview, downloadEnabled, commentsEnabled, visible, scheduledAt]);

  // ── Auto-refresh + upload-complete dialog when this lesson's task becomes ready
  useEffect(() => {
    const prev = prevTasksRef.current;
    prevTasksRef.current = tasks;
    const cur  = tasks.find(t => t.lessonId === id);
    const old  = prev.find(t => t.lessonId === id);
    if (cur?.status === 'ready' && old?.status !== 'ready') {
      loadLesson();
      setCompletedTaskSnapshot({ ...cur });
      setShowUploadCompleteDialog(true);
    }
  }, [tasks, id, loadLesson]);

  // ── Queue-based video upload (MedAcademy Video type)
  const handleUploadVideo = async (forceFile?: DocumentPicker.DocumentPickerAsset, isReplace = false) => {
    try {
      let file = forceFile;
      if (!file) {
        const result = await DocumentPicker.getDocumentAsync({ type: ['video/*'], multiple: false });
        if (result.canceled || !result.assets?.[0]) return;
        file = result.assets[0];
      }
      if (!lesson) return;

      // ── Format validation (MIME-first, extension fallback) ─────────────────
      const validation = validateVideoFile(
        file.name,
        file.mimeType,
        file.size ?? 0,
      );
      if (!validation.ok) {
        const e = validation.error!;
        console.warn('[LessonEditor] video validation failed', {
          fileName: e.fileName,
          detectedExtension: e.detectedExtension,
          detectedMime: e.detectedMime,
          resolvedMime: e.resolvedMime,
          fileSize: e.fileSize,
          code: e.code,
        });
        showToast({ type: 'error', message: e.message });
        return;
      }

      // Pre-upload file analysis — warn for large files
      const analysis = analyzeFile(file.size ?? 0, file.name);
      if (analysis.isLarge) {
        setFileAnalysis(analysis);
        setPendingFile(file);
        setPendingReplaceOldPath(isReplace ? (lesson.video_id ?? null) : null);
        setShowLargeFileWarning(true);
        return;
      }

      const courseId = lesson.section?.course_id ?? lesson.course_id;

      // Duplicate detection (skip for explicit replacement)
      if (!isReplace) {
        const dupCheck = await checkDuplicateVideo(courseId, file.name, file.size ?? 0);
        if (dupCheck.isDuplicate) {
          setDuplicateInfo({ fileName: file.name, existingLesson: dupCheck.existingLessonTitle });
          setPendingFile(file);
          return;
        }
      }

      await enqueueVideoUpload(file, courseId, isReplace ? (lesson.video_id ?? undefined) : undefined);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to queue video.') });
    }
  };

  const handleReplaceVideo = () => handleUploadVideo(undefined, true);

  // ── Attach a library asset to this lesson (no upload needed) ─────────────
  const handleAttachLibraryAsset = async (asset: VideoAsset) => {
    if (!lesson) return;
    try {
      await attachAssetToLesson(lesson.id, asset);
      await loadLesson();
      showToast({ type: 'success', message: `"${asset.title || 'Video'}" linked to this lesson.` });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to link video.') });
    }
  };

  // ── Open replace sheet — pre-load shared lesson count ────────────────────
  const handleOpenReplaceSheet = async () => {
    if (lesson?.video_asset_id) {
      try {
        const usages = await getVideoAssetUsage(lesson.video_asset_id);
        setSharedLessonCount(usages.length);
      } catch (_) {
        setSharedLessonCount(0);
      }
    } else {
      setSharedLessonCount(0);
    }
    setShowReplaceSheet(true);
  };

  const enqueueVideoUpload = async (
    file: DocumentPicker.DocumentPickerAsset,
    courseId: string,
    oldVdoCipherVideoId?: string,   // VdoCipher ID of the video being replaced
  ) => {
    setDuplicateInfo(null);
    setPendingFile(null);
    setShowLargeFileWarning(false);
    setFileAnalysis(null);
    const taskId = randomUUID();
    const task = {
      id: taskId,
      lessonId: lesson!.id,
      courseId,
      fileUri: file.uri,
      fileName: file.name,
      fileSize: file.size ?? 0,
      mimeType: resolveUploadMime(file.name, file.mimeType),
      status: 'waiting' as const,
      progress: 0,
      bytesUploaded: 0,
      speedBps: 0,
      etaSeconds: 0,
      retryCount: 0,
      createdAt: Date.now(),
      isReplacement:      !!oldVdoCipherVideoId,
      oldVdoCipherVideoId: oldVdoCipherVideoId,
    };
    await createUploadRecord(task);
    addTask(task);
    setCurrentUploadId(taskId);
    setQueueVisible(true);
    showToast({ type: 'success', message: `Queued: ${file.name}` });
  };

  // ── Delete uploaded video with confirmation ───────────────────────────────
  const handleDeleteVideo = async () => {
    setShowDeleteVideoDialog(false);
    if (!lesson) return;
    try {
      // VdoCipher asset management is admin-only; only clear the lesson ref here.
      await clearLessonVideoRef(lesson.id);
      // Also cancel any in-flight upload task for this lesson
      const activeTask = tasks.find(t => t.lessonId === lesson.id);
      if (activeTask) await cancelUpload(activeTask.id);
      // Refresh lesson
      await loadLesson();
      showToast({ type: 'success', message: 'Video deleted.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to delete video.') });
    }
  };

  // ── Upload material
  const handleUploadMaterial = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false });
      if (result.canceled || !result.assets?.[0]) return;
      const file = result.assets[0];
      if (!profile || !lesson) return;

      setUploading(true);
      const courseId = lesson.section?.course_id ?? lesson.course_id;
      const { storagePath, publicUrl } = await uploadLessonMaterial(
        courseId, lesson.id, file.uri, file.name,
        file.mimeType ?? 'application/octet-stream',
      );

      const material = await createLessonMaterial({
        lesson_id: lesson.id,
        course_id: courseId,
        uploaded_by: profile.id,
        file_name: file.name,
        file_url: publicUrl,
        storage_path: storagePath,
        file_type: file.mimeType ?? 'application/octet-stream',
        file_size: file.size ?? 0,
        download_enabled: true,
        preview_enabled: true,
        order_index: materials.length,
      });
      setMaterials(prev => [...prev, material]);
      showToast({ type: 'success', message: `${file.name} uploaded.` });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Upload failed.') });
    }
    setUploading(false);
  };

  // ── Replace material file
  const handleReplaceMaterial = async (material: any) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false });
      if (result.canceled || !result.assets?.[0]) return;
      const file = result.assets[0];
      if (!lesson) return;

      setReplacingId(material.id);
      const courseId = lesson.section?.course_id ?? lesson.course_id;
      const updated = await replaceLessonMaterialFile(
        material.id, material.storage_path,
        courseId, lesson.id,
        file.uri, file.name,
        file.mimeType ?? 'application/octet-stream',
        file.size ?? 0,
      );
      setMaterials(prev => prev.map(m => m.id === material.id ? updated : m));
      showToast({ type: 'success', message: 'File replaced.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Replace failed.') });
    }
    setReplacingId(null);
  };

  const handleDeleteMaterial = async (material: any) => {
    try {
      await deleteLessonMaterial(material.id, material.storage_path);
      setMaterials(prev => prev.filter(m => m.id !== material.id));
      showToast({ type: 'success', message: 'File deleted.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Delete failed.') });
    }
  };

  const handleUpdatePermission = async (materialId: string, permission: DownloadPermission) => {
    try {
      await updateMaterialPermission(materialId, permission);
      setMaterials(prev => prev.map(m => m.id === materialId ? { ...m, permission } : m));
      setOpenPermMenu(null);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to update permission.') });
    }
  };

  const handleSave = async () => {
    if (!id) return;
    // Cancel any pending auto-save before running the explicit save to prevent
    // a race where the timer fires concurrently with this call.
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setSaving(true);
    try {
      const saved = await updateLesson(id, {
        title, description, notes, status,
        video_type: videoType, video_id: videoId, video_title: videoTitle,
        video_playback_id: videoPlaybackId, video_thumbnail: videoThumbnail,
        youtube_video_id: youtubeVideoId || undefined,
        is_preview: isPreview, download_enabled: downloadEnabled,
        comments_enabled: commentsEnabled, visible,
        scheduled_at: scheduledAt || undefined,
      });
      // Verify the DB actually stored the status the doctor selected.
      // If there is a silent mismatch, surface it instead of showing success.
      if (saved.status !== status) {
        throw new Error(`Status mismatch: expected '${status}' but database returned '${saved.status}'. Please try again.`);
      }
      setLastSaved(new Date());
      showToast({ type: 'success', message: 'Lesson saved.' });
      router.back();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Save failed.') });
    }
    setSaving(false);
  };

  // Derive active task for this lesson (any non-terminal status)
  const activeTask = tasks.find(
    t => t.lessonId === id &&
      !['ready', 'canceled', 'failed'].includes(t.status),
  );
  // Timed-out task for this lesson — may still have VdoCipher asset
  const timedOutTask = tasks.find(
    t => t.lessonId === id && t.status === 'timeout',
  );

  if (loading) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.base }}>
      <ActivityIndicator color={c.primary} size="large" />
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.base }}
      behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'}>

      {/* ══ Upload-Complete Dialog ══════════════════════════════════════════ */}
      <Modal
        visible={showUploadCompleteDialog}
        transparent
        animationType="fade"
        onRequestClose={() => setShowUploadCompleteDialog(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <Pressable onPress={e => e.stopPropagation()}>
            <View style={[neuFlatStyle(isDark), { width: Math.min(screenWidth - 40, 400), borderRadius: 24, padding: 24, gap: 20, alignItems: 'center' }]}>
              {/* Success icon */}
              <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}>
                <CheckCircle size={36} color="#16A34A" />
              </View>
              <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, textAlign: 'center' }}>
                Video uploaded successfully
              </Text>

              {/* Thumbnail */}
              {completedTaskSnapshot?.thumbnailUrl ? (
                <Image
                  source={{ uri: completedTaskSnapshot.thumbnailUrl }}
                  style={{ width: '100%', height: 160, borderRadius: 14 }}
                  contentFit="cover"
                />
              ) : (
                <View style={[neuPressedStyle(isDark), { width: '100%', height: 120, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 8 }]}>
                  <Video size={32} color={c.primary} opacity={0.4} />
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.4 }}>Generating thumbnail…</Text>
                </View>
              )}

              {/* Duration + status row */}
              <View style={{ flexDirection: 'row', gap: 12, width: '100%' }}>
                {lesson?.video_duration_seconds > 0 && (
                  <View style={[neuPressedStyle(isDark), { flex: 1, padding: 12, borderRadius: 14, alignItems: 'center', gap: 4 }]}>
                    <Clock size={16} color={c.primary} />
                    <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>
                      {formatDuration(lesson.video_duration_seconds)}
                    </Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Duration</Text>
                  </View>
                )}
                <View style={[neuPressedStyle(isDark), { flex: 1, padding: 12, borderRadius: 14, alignItems: 'center', gap: 4 }]}>
                  <CheckCircle size={16} color="#16A34A" />
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>Ready</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Status</Text>
                </View>
              </View>

              {/* Actions */}
              <View style={{ flexDirection: 'row', gap: 12, width: '100%' }}>
                <Pressable
                  onPress={() => { setShowUploadCompleteDialog(false); handleUploadVideo(); }}
                  style={[neuFlatStyle(isDark), { flex: 1, minWidth: 100, padding: 14, borderRadius: 14, alignItems: 'center' }]}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary }} numberOfLines={1}>Upload Another</Text>
                </Pressable>
                <Pressable
                  onPress={() => setShowUploadCompleteDialog(false)}
                  style={{ flex: 1, minWidth: 100, padding: 14, borderRadius: 14, alignItems: 'center', backgroundColor: c.primary }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }} numberOfLines={1}>Done</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        </View>
      </Modal>
      {/* ── Video Library Picker (no-video flow: "Choose From Library") ── */}
      <VideoLibraryPicker
        visible={showLibraryPicker}
        onClose={() => setShowLibraryPicker(false)}
        onSelect={handleAttachLibraryAsset}
      />

      {/* ── Replace Sheet (linked-video flow: "Replace" button) ── */}
      <VideoReplaceSheet
        visible={showReplaceSheet}
        lessonId={id ?? ''}
        currentAssetId={lesson?.video_asset_id ?? null}
        sharedLessonCount={sharedLessonCount}
        onClose={() => setShowReplaceSheet(false)}
        onUploadNew={() => { setShowReplaceSheet(false); handleUploadVideo(undefined, true); }}
        onAssetAttached={async () => { setShowReplaceSheet(false); await loadLesson(); }}
      />

      {/* ── Header — spacing from headerTokens (EDGE_PAD=4, BREATHING=8) ── */}
      <View style={{ paddingTop: layout.headerTop, paddingLeft: layout.headerLeft, paddingRight: layout.headerRight, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable onPress={() => router.back()}
          hitSlop={8}
          style={[neuFlatStyle(isDark), { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }]}>
          <ArrowLeft size={20} color={c.text} opacity={0.6} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <TextInput
            value={title} onChangeText={setTitle} placeholder="Lesson Title"
            placeholderTextColor={`${c.text}55`}
            style={{ fontSize: 17, fontWeight: '800', color: c.text, padding: 0 }}
          />
          {/* Transient ✓ Saved flash — no reserved layout space */}
          {savedVisible && (
            <Animated.View style={{ position: 'absolute', bottom: -14, left: 0, ...savedFade.style, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <Check size={10} color="#16A34A" />
              <Text style={{ fontSize: 10, color: '#16A34A', fontWeight: '600' }}>Saved</Text>
            </Animated.View>
          )}
        </View>
        <Pressable onPress={handleSave} disabled={saving}
          style={{ backgroundColor: c.primary, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {saving ? <ActivityIndicator size="small" color="#fff" /> : <Save size={15} color="#fff" />}
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Save</Text>
        </Pressable>
      </View>

      {/* ── Tab Bar ── */}
      <View style={{ flexDirection: 'row', paddingHorizontal: layout.screenPx, gap: 8, marginBottom: 4 }}>
        {([
          { key: 'video',      label: 'Video',     icon: Play },
          { key: 'materials',  label: 'Materials', icon: Paperclip },
          { key: 'settings',   label: 'Settings',  icon: Settings },
        ] as { key: LessonTab; label: string; icon: any }[]).map(({ key, label, icon: Icon }) => (
          <Pressable key={key} onPress={() => setTab(key)}
            style={[
              tab === key ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
              { flex: 1, paddingVertical: 10, borderRadius: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 },
            ]}>
            <Icon size={15} color={tab === key ? c.primary : c.text} opacity={tab === key ? 1 : 0.45} />
            <Text style={{ fontSize: 13, fontWeight: '700', color: tab === key ? c.primary : c.text, opacity: tab === key ? 1 : 0.55 }}>
              {label}
            </Text>
            {key === 'materials' && materials.length > 0 && (
              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 10, color: '#fff', fontWeight: '700' }}>{materials.length}</Text>
              </View>
            )}
          </Pressable>
        ))}
      </View>

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: VIDEO
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'video' && (
        <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: layout.screenPx, gap: 16, paddingBottom: layout.scrollBottom() }}>

          {/* ── Live upload / processing status card ─────────────────────── */}
          {activeTask && (
            <NeuCard style={{ padding: 16, gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {activeTask.status === 'failed' ? (
                  <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                    <AlertCircle size={18} color="#DC2626" />
                  </View>
                ) : (
                  <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator size="small" color={c.primary} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: activeTask.status === 'failed' ? '#DC2626' : c.text }}>
                    {uploadStatusLabel(activeTask.status)}
                  </Text>
                  {activeTask.status === 'uploading' && activeTask.progress > 0 && (
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>
                      {activeTask.progress.toFixed(0)}% · {activeTask.fileName}
                    </Text>
                  )}
                  {activeTask.status === 'failed' && activeTask.errorMessage && (
                    <Text style={{ fontSize: 12, color: '#DC2626', opacity: 0.7, marginTop: 2 }} numberOfLines={2}>
                      {activeTask.errorMessage}
                    </Text>
                  )}
                </View>
              </View>
              {/* Progress bar — only during uploading */}
              {activeTask.status === 'uploading' && (
                <View style={{ height: 4, borderRadius: 2, backgroundColor: `${c.primary}20`, overflow: 'hidden' }}>
                  <View style={{ height: '100%', borderRadius: 2, backgroundColor: c.primary, width: `${activeTask.progress}%` }} />
                </View>
              )}
              {/* Stage dots */}
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                {(['waiting', 'uploading', 'processing', 'verifying'] as const).map((stage, i) => {
                  const stageOrder = ['waiting', 'uploading', 'processing', 'verifying'];
                  const curIdx = stageOrder.indexOf(activeTask.status);
                  const done = i < curIdx;
                  const active = i === curIdx;
                  return (
                    <View key={stage} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      {i > 0 && <View style={{ width: 16, height: 1.5, borderRadius: 1, backgroundColor: done ? c.primary : `${c.text}20` }} />}
                      <View style={{
                        width: active ? 8 : 6, height: active ? 8 : 6, borderRadius: 4,
                        backgroundColor: done ? c.primary : active ? c.primary : `${c.text}25`,
                        opacity: done ? 0.7 : active ? 1 : 0.4,
                      }} />
                    </View>
                  );
                })}
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginLeft: 4 }}>
                  {(['Queued', 'Uploading', 'Processing', 'Verifying'] as const)[
                    Math.min(['waiting', 'uploading', 'processing', 'verifying'].indexOf(activeTask.status), 3)
                  ]}
                </Text>
              </View>
            </NeuCard>
          )}

          {/* Description */}
          <Field label="Lesson Description">
            <NeuInput value={description} onChangeText={setDescription}
              placeholder="Briefly describe what this lesson covers…"
              isDark={isDark} c={c} multiline style={{ minHeight: 80 }} />
          </Field>

          {/* Video Source Selector */}
          <Field label="Video Source">
            {/* Provider permission gate: show notice when all upload providers are blocked */}
            {(() => {
              const allBlocked = providerPerms.length > 0 && providerPerms.every(p => !p.final_enabled);
              const vdoCipherPerm = providerPerms.find(p => p.provider_key === 'vdocipher');
              const vdoCipherBlocked = vdoCipherPerm ? !vdoCipherPerm.final_enabled : false;
              const vdoCipherDisabledMsg = vdoCipherPerm && !vdoCipherPerm.global_enabled
                ? 'VdoCipher uploads are currently disabled by the administrator.'
                : 'VdoCipher uploads have been disabled for your account.';
              return (
                <>
                  {allBlocked && (
                    <NeuCard style={{ marginBottom: 10, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <AlertCircle size={16} color="#D97706" />
                      <Text style={{ flex: 1, fontSize: 12, color: '#92400E', fontWeight: '600' }}>
                        Video uploads are currently disabled by the administrator.
                      </Text>
                    </NeuCard>
                  )}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                    {VIDEO_TYPES.map(vt => {
                      const Icon = vt.icon;
                      const selected = videoType === vt.value;
                      // Gate: hide vdocipher button when provider is blocked
                      if (vt.value === 'vdocipher' && vdoCipherBlocked) return null;
                      return (
                        <Pressable key={vt.value} onPress={() => setVideoType(vt.value)}
                          style={[
                            selected ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                            { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
                          ]}>
                          <Icon size={16} color={selected ? vt.color : c.text} opacity={selected ? 1 : 0.45} />
                          <Text style={{ fontSize: 13, fontWeight: '700', color: selected ? vt.color : c.text, opacity: selected ? 1 : 0.55 }}>
                            {vt.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  {vdoCipherBlocked && (
                    <Text style={{ marginTop: 6, fontSize: 12, color: '#D97706' }}>
                      {vdoCipherDisabledMsg}
                    </Text>
                  )}
                </>
              );
            })()}
          </Field>

          {/* MedAcademy Video — queue-based upload */}
          {videoType === 'vdocipher' && (
            <>
              {/* Large file warning modal */}
              <LargeFileWarning
                visible={showLargeFileWarning}
                analysis={fileAnalysis}
                fileName={pendingFile?.name ?? ''}
                onProceed={async () => {
                  if (!pendingFile || !lesson) return;
                  const courseId = lesson.section?.course_id ?? lesson.course_id;
                  const isReplace = !!pendingReplaceOldPath;
                  const dupCheck = !isReplace
                    ? await checkDuplicateVideo(courseId, pendingFile.name, pendingFile.size ?? 0)
                    : { isDuplicate: false };
                  if (!isReplace && dupCheck.isDuplicate) {
                    setShowLargeFileWarning(false);
                    setDuplicateInfo({ fileName: pendingFile.name, existingLesson: (dupCheck as any).existingLessonTitle });
                    return;
                  }
                  await enqueueVideoUpload(pendingFile, courseId, pendingReplaceOldPath ?? undefined);
                }}
                onCancel={() => { setShowLargeFileWarning(false); setPendingFile(null); setFileAnalysis(null); }}
              />

              {/* Duplicate detection dialog */}
              {duplicateInfo && (
                <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 12, borderLeftWidth: 3, borderLeftColor: '#D97706' }]}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#D97706' }}>⚠️ Duplicate Video Detected</Text>
                  <Text style={{ fontSize: 13, color: c.text, opacity: 0.7, lineHeight: 18 }}>
                    {`A file named "${duplicateInfo.fileName}" already exists in this course${duplicateInfo.existingLesson ? ` (lesson: ${duplicateInfo.existingLesson})` : ''}.`}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Pressable onPress={() => { setDuplicateInfo(null); setPendingFile(null); }}
                      style={[neuFlatStyle(isDark), { flex: 1, padding: 11, borderRadius: 12, alignItems: 'center' }]}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.6 }}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      onPress={async () => {
                        if (pendingFile) {
                          const courseId = lesson?.section?.course_id ?? lesson?.course_id;
                          await enqueueVideoUpload(pendingFile, courseId);
                        }
                      }}
                      style={{ flex: 1, padding: 11, borderRadius: 12, alignItems: 'center', backgroundColor: '#D97706' }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Upload Anyway</Text>
                    </Pressable>
                  </View>
                </NeuCard>
              )}

              {/* Active upload status card — Cancel button always visible */}
              {activeTask && activeTask.status !== 'timeout' && (
                <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 14, gap: 10 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>
                        {uploadStatusLabel(activeTask.status)}
                      </Text>
                      {activeTask.status === 'uploading' && (
                        <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>
                          {activeTask.progress}%
                        </Text>
                      )}
                    </View>
                    <Pressable
                      onPress={() => cancelUpload(activeTask.id)}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
                        paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
                        backgroundColor: '#DC262618', borderWidth: 1, borderColor: '#DC262630' }}>
                      <X size={13} color="#DC2626" />
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>Cancel</Text>
                    </Pressable>
                  </View>
                  {/* Inline progress bar */}
                  {['uploading', 'processing', 'encoding', 'generating_streams', 'verifying'].includes(activeTask.status) && (
                    <View style={{ height: 4, borderRadius: 2, backgroundColor: `${c.text}15` }}>
                      <View style={{ height: 4, borderRadius: 2, width: `${activeTask.progress}%` as any, backgroundColor: c.primary }} />
                    </View>
                  )}
                </NeuCard>
              )}

              {/* Timeout card — Retry Processing / Replace / Delete Upload */}
              {timedOutTask && (
                <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 12, borderLeftWidth: 3, borderLeftColor: '#F97316' }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <AlertCircle size={16} color="#F97316" />
                    <Text style={{ fontSize: 14, fontWeight: '700', color: '#F97316' }}>Processing Timed Out</Text>
                  </View>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, lineHeight: 17 }}>
                    The video was uploaded but VdoCipher did not finish encoding within 10 minutes.
                    {'\n'}You can retry polling, replace with a new file, or delete the upload.
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {timedOutTask.vdoCipherVideoId && (
                      <Pressable
                        onPress={() => retryProcessing(timedOutTask.id)}
                        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                          paddingVertical: 10, borderRadius: 10,
                          backgroundColor: '#F9731618', borderWidth: 1, borderColor: '#F9731640' }}>
                        <RotateCcw size={13} color="#F97316" />
                        <Text style={{ fontSize: 12, fontWeight: '700', color: '#F97316' }}>Retry</Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={handleReplaceVideo}
                      style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                        paddingVertical: 10, borderRadius: 10,
                        backgroundColor: '#7C3AED18', borderWidth: 1, borderColor: '#7C3AED40' }}>
                      <RefreshCw size={13} color="#7C3AED" />
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#7C3AED' }}>Replace</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => deleteVideo(timedOutTask.id)}
                      style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                        paddingVertical: 10, borderRadius: 10,
                        backgroundColor: '#DC262618', borderWidth: 1, borderColor: '#DC262630' }}>
                      <Trash2 size={13} color="#DC2626" />
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>Delete</Text>
                    </Pressable>
                  </View>
                </NeuCard>
              )}

              {videoId ? (
                // ── Video Missing card (consistency-audit detected asset gone) ────
                videoMissing ? (
                  <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 12,
                    borderLeftWidth: 3, borderLeftColor: '#DC2626' }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={{ width: 44, height: 44, borderRadius: 12,
                        backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                        <ShieldAlert size={22} color="#DC2626" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '800', color: '#DC2626' }}>
                          Video Missing
                        </Text>
                        <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, marginTop: 2 }}>
                          The video asset no longer exists on VdoCipher.
                        </Text>
                      </View>
                    </View>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.65, lineHeight: 18 }}>
                      {"This lesson's video was deleted or became unavailable on the provider."}
                      {" Student progress for this lesson is preserved."}
                      {" Upload a replacement to restore playback."}
                    </Text>
                    <Pressable
                      onPress={() => handleUploadVideo(undefined, false)}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                        gap: 8, paddingVertical: 12, borderRadius: 12,
                        backgroundColor: c.primary }}>
                      <Upload size={16} color="#fff" />
                      <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>Re-upload Video</Text>
                    </Pressable>
                    {auditingVideo && (
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, textAlign: 'center' }}>
                        Verifying with VdoCipher…
                      </Text>
                    )}
                  </NeuCard>
                ) : (
                // ── Video already linked — Replace + Delete ────────────────────
                <NeuCard style={[neuPressedStyle(isDark), { padding: layout.screenPx, alignItems: 'center', gap: 10 }]}>
                  <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                    <Video size={26} color={c.primary} />
                  </View>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>
                    {videoTitle || 'Video Uploaded'}
                  </Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, textAlign: 'center' }}>
                    MedAcademy Video Library · Secure Playback
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                    <Pressable onPress={handleOpenReplaceSheet}
                      style={{ flex: 1, paddingVertical: 10, borderRadius: 12,
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                        backgroundColor: '#7C3AED18', borderWidth: 1.5, borderColor: '#7C3AED40' }}>
                      <RefreshCw size={14} color="#7C3AED" />
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#7C3AED' }}>Replace</Text>
                    </Pressable>
                    <Pressable onPress={() => setShowDeleteVideoDialog(true)}
                      style={{ flex: 1, paddingVertical: 10, borderRadius: 12,
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                        backgroundColor: '#DC262618', borderWidth: 1.5, borderColor: '#DC262630' }}>
                      <Trash2 size={14} color="#DC2626" />
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Delete</Text>
                    </Pressable>
                  </View>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.35, textAlign: 'center' }}>
                    Replacing keeps lesson progress and materials.{'\n'}Old video is removed only after replacement succeeds.
                  </Text>

                  {/* Delete confirmation inline dialog */}
                  {showDeleteVideoDialog && (
                    <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 14, padding: 14, gap: 10, alignSelf: 'stretch', borderLeftWidth: 3, borderLeftColor: '#DC2626' }]}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Delete this video permanently?</Text>
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, lineHeight: 17 }}>
                        The VdoCipher asset will be removed. Student progress for this lesson is preserved.
                      </Text>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Pressable onPress={() => setShowDeleteVideoDialog(false)}
                          style={[neuFlatStyle(isDark), { flex: 1, padding: 10, borderRadius: 10, alignItems: 'center' }]}>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.6 }}>Cancel</Text>
                        </Pressable>
                        <Pressable onPress={handleDeleteVideo}
                          style={{ flex: 1, padding: 10, borderRadius: 10, alignItems: 'center', backgroundColor: '#DC2626' }}>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Yes, Delete</Text>
                        </Pressable>
                      </View>
                    </NeuCard>
                  )}
                </NeuCard>
                )  // closes: videoMissing ? <missing card> : ( <linked card> )
              ) : (
                // No video yet — two options: upload new OR choose from library
                !activeTask && !timedOutTask && (
                  <View style={{ gap: 12 }}>
                    {/* Upload new */}
                    <Pressable onPress={() => handleUploadVideo()}
                      style={[neuFlatStyle(isDark), { padding: layout.screenPx, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 16 }]}>
                      <View style={{ width: 52, height: 52, borderRadius: 14, backgroundColor: `${c.primary}15`, alignItems: 'center', justifyContent: 'center' }}>
                        <Upload size={24} color={c.primary} opacity={0.8} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>Upload New Video</Text>
                        <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 3 }}>
                          Pick a file — MP4, MOV, AVI, MKV up to 5 GB
                        </Text>
                      </View>
                    </Pressable>

                    {/* Choose from library */}
                    <Pressable onPress={() => setShowLibraryPicker(true)}
                      style={[neuFlatStyle(isDark), { padding: layout.screenPx, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 16 }]}>
                      <View style={{ width: 52, height: 52, borderRadius: 14, backgroundColor: `${c.accent}15`, alignItems: 'center', justifyContent: 'center' }}>
                        <Film size={24} color={c.accent} opacity={0.8} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>Choose From My Library</Text>
                        <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 3 }}>
                          Reuse an existing upload — no extra storage used
                        </Text>
                      </View>
                    </Pressable>
                  </View>
                )
              )}

              {/* Thumbnail card — shown once video is ready */}
              {videoThumbnailUrl && lesson?.id && currentUploadId && (
                <VideoThumbnailCard
                  thumbnailUrl={videoThumbnailUrl}
                  autoThumbnailUrl={autoThumbnailUrl}
                  uploadId={currentUploadId}
                  lessonId={lesson.id}
                  courseId={lesson.section?.course_id ?? lesson.course_id}
                  onThumbnailChange={(url) => setVideoThumbnailUrl(url)}
                />
              )}

              {/* Video Title */}
              {videoId ? (
                <Field label="Video Title">
                  <NeuInput value={videoTitle} onChangeText={setVideoTitle} placeholder="Display title for the video" isDark={isDark} c={c} />
                </Field>
              ) : null}

              {/* Auto-calculated duration — read-only, set by upload pipeline */}
              {lesson?.video_duration_seconds > 0 && (
                <NeuCard style={[neuPressedStyle(isDark), { padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
                  <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                    <Clock size={18} color={c.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}>Duration</Text>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: c.text, marginTop: 1 }}>
                      {formatDuration(lesson.video_duration_seconds)}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 11, color: c.primary, opacity: 0.6 }}>Auto-detected</Text>
                </NeuCard>
              )}
            </>
          )}

          {/* Coming Soon */}
          {videoType === 'coming_soon' && (
            <NeuCard style={[neuPressedStyle(isDark), { padding: 24, alignItems: 'center', gap: 8 }]}>
              <Clock size={36} color="#D97706" opacity={0.6} />
              <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>Coming Soon</Text>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.45, textAlign: 'center' }}>
                {'Students will see a "Coming Soon" placeholder for this lesson.'}
              </Text>
            </NeuCard>
          )}

          {/* YouTube Video */}
          {videoType === 'youtube' && (
            <NeuCard style={{ gap: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                  <Film size={18} color="#DC2626" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>YouTube Video</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.45 }}>Paste any YouTube URL or video ID</Text>
                </View>
                {youtubeVideoId ? (
                  <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: '#16A34A18' }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#16A34A' }}>Linked</Text>
                  </View>
                ) : null}
              </View>

              {/* URL input */}
              <View style={{ gap: 6 }}>
                <NeuInput
                  value={youtubeUrlInput}
                  onChangeText={(text: string) => {
                    setYoutubeUrlInput(text);
                    setYoutubeUrlError(null);
                    const extracted = extractYouTubeId(text);
                    if (extracted) {
                      setYoutubeVideoId(extracted);
                    } else if (text.trim().length > 0) {
                      setYoutubeVideoId('');
                    } else {
                      setYoutubeVideoId('');
                    }
                  }}
                  onBlur={() => {
                    if (youtubeUrlInput.trim().length > 0 && !youtubeVideoId) {
                      setYoutubeUrlError('Could not extract a YouTube video ID. Check the URL format.');
                    }
                  }}
                  placeholder="https://youtu.be/... or youtube.com/watch?v=..."
                  isDark={isDark}
                  c={c}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                {youtubeUrlError ? (
                  <Text style={{ fontSize: 12, color: '#DC2626' }}>{youtubeUrlError}</Text>
                ) : youtubeVideoId ? (
                  <Text style={{ fontSize: 12, color: '#16A34A' }}>
                    ✓ Video ID: {youtubeVideoId}
                  </Text>
                ) : null}
              </View>

              {/* Supported formats hint */}
              <View style={{ backgroundColor: `${c.primary}08`, borderRadius: 10, padding: 10, gap: 3 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5 }}>Supported formats</Text>
                {[
                  'https://youtu.be/VIDEO_ID',
                  'https://youtube.com/watch?v=VIDEO_ID',
                  'https://youtube.com/embed/VIDEO_ID',
                  'VIDEO_ID (11 characters)',
                ].map((fmt) => (
                  <Text key={fmt} style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{fmt}</Text>
                ))}
              </View>
            </NeuCard>
          )}

          {/* Lesson Notes */}
          <Field label="Lesson Notes">
            <NeuInput value={notes} onChangeText={setNotes}
              placeholder="Additional notes shown below the video…"
              isDark={isDark} c={c} multiline style={{ minHeight: 100 }} />
          </Field>

          {/* Status — 5 states */}
          <Field label="Lesson Status">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {LESSON_STATUSES.map(ls => (
                <Pressable key={ls.value} onPress={() => setStatus(ls.value)}
                  style={[
                    status === ls.value ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                    { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
                  ]}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ls.color, opacity: status === ls.value ? 1 : 0.4 }} />
                  <Text style={{ fontSize: 13, fontWeight: '700', color: status === ls.value ? ls.color : c.text, opacity: status === ls.value ? 1 : 0.5 }}>
                    {ls.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Scheduled date — shown only when status=scheduled */}
            {status === 'scheduled' && (
              <View style={{ marginTop: 10 }}>
                <Field label="Publish Date & Time">
                  <NeuInput
                    value={scheduledAt}
                    onChangeText={setScheduledAt}
                    placeholder="YYYY-MM-DD HH:MM (e.g. 2025-09-01 09:00)"
                    isDark={isDark} c={c}
                  />
                  <Text style={{ fontSize: 11, color: '#3B82F6', opacity: 0.8, marginTop: 2 }}>
                    Lesson will automatically become visible at this date/time.
                  </Text>
                </Field>
              </View>
            )}
          </Field>
        </ScrollView>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: MATERIALS  — unlimited attachments, preview/download, replace, delete
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'materials' && (
        <View style={{ flex: 1 }}>
          {/* Upload button */}
          <View style={{ paddingHorizontal: layout.screenPx, paddingVertical: 10 }}>
            <Pressable onPress={handleUploadMaterial} disabled={uploading}
              style={{ backgroundColor: c.primary, padding: 14, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, opacity: uploading ? 0.7 : 1 }}>
              {uploading ? <ActivityIndicator size="small" color="#fff" /> : <Upload size={18} color="#fff" />}
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                {uploading ? 'Uploading…' : 'Upload File'}
              </Text>
            </Pressable>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, textAlign: 'center', marginTop: 6 }}>
              PDF, PPTX, DOCX, XLSX, ZIP, images, audio, and more — up to 100 MB each
            </Text>
          </View>

          <FlatList
            data={materials}
            keyExtractor={m => m.id}
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: layout.screenPx, paddingTop: 4, gap: 10, paddingBottom: layout.scrollBottom() }}
            ListEmptyComponent={
              <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                <Paperclip size={44} color={c.primary} opacity={0.2} />
                <Text style={{ color: c.text, opacity: 0.4, marginTop: 12, fontSize: 15 }}>No attachments yet</Text>
                <Text style={{ color: c.text, opacity: 0.3, fontSize: 13, marginTop: 4 }}>
                  Upload PDFs, slides, or any file — unlimited
                </Text>
              </View>
            }
            renderItem={({ item }) => {
              const fi = fileIcon(item.file_type);
              const Icon = fi.icon;
              const perm = PERMISSION_OPTIONS.find(p => p.value === (item.permission ?? 'allow')) ?? PERMISSION_OPTIONS[0];
              const PermIcon = perm.icon;
              const isMenuOpen = openPermMenu === item.id;
              const isReplacing = replacingId === item.id;
              return (
                <NeuCard style={{ padding: 12, gap: 10 }}>
                  {/* File row */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: `${fi.color}18`, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon size={22} color={fi.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }} numberOfLines={1}>{item.file_name}</Text>
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 2 }}>
                        {formatBytes(item.file_size)} · {item.file_type.split('/')[1]?.toUpperCase() ?? 'FILE'}
                      </Text>
                    </View>
                    {/* Action buttons */}
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {/* Replace */}
                      <Pressable onPress={() => handleReplaceMaterial(item)} disabled={isReplacing} hitSlop={8}>
                        {isReplacing
                          ? <ActivityIndicator size="small" color={c.primary} />
                          : <RefreshCw size={15} color={c.primary} opacity={0.7} />
                        }
                      </Pressable>
                      {/* Delete */}
                      <Pressable onPress={() => handleDeleteMaterial(item)} hitSlop={8}>
                        <Trash2 size={15} color="#DC2626" opacity={0.7} />
                      </Pressable>
                    </View>
                  </View>

                  {/* Permission picker row */}
                  <View>
                    <Pressable
                      onPress={() => setOpenPermMenu(isMenuOpen ? null : item.id)}
                      style={[neuFlatStyle(isDark), { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                      <PermIcon size={14} color={perm.color} />
                      <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: perm.color }}>{perm.label}</Text>
                      <ChevronDown size={13} color={c.text} opacity={0.4} />
                    </Pressable>
                    {isMenuOpen && (
                      <NeuCard style={{ marginTop: 4, padding: 4 }}>
                        {PERMISSION_OPTIONS.map(opt => {
                          const OIcon = opt.icon;
                          return (
                            <Pressable key={opt.value} onPress={() => handleUpdatePermission(item.id, opt.value)}
                              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8,
                                backgroundColor: item.permission === opt.value ? `${opt.color}15` : 'transparent' }}>
                              <OIcon size={14} color={opt.color} />
                              <View style={{ flex: 1 }}>
                                <Text style={{ fontSize: 13, fontWeight: '700', color: opt.color }}>{opt.label}</Text>
                              </View>
                              {(item.permission ?? 'allow') === opt.value && (
                                <CheckCircle size={13} color={opt.color} />
                              )}
                            </Pressable>
                          );
                        })}
                      </NeuCard>
                    )}
                  </View>
                </NeuCard>
              );
            }}
          />
        </View>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: SETTINGS
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'settings' && (
        <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: layout.screenPx, gap: 16, paddingBottom: layout.scrollBottom() }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: c.text, opacity: 0.7 }}>Lesson Access</Text>

          <SettingToggle
            icon={Eye} label="Free Preview" sub="Non-enrolled students can watch this lesson"
            value={isPreview} onChange={setIsPreview} isDark={isDark} c={c} />
          <SettingToggle
            icon={Download} label="Allow Download" sub="Students can download lesson materials"
            value={downloadEnabled} onChange={setDownloadEnabled} isDark={isDark} c={c} />
          <SettingToggle
            icon={MessageCircle} label="Comments Enabled" sub="Students can comment on this lesson"
            value={commentsEnabled} onChange={setCommentsEnabled} isDark={isDark} c={c} />
          <SettingToggle
            icon={Layers} label="Visible" sub="Lesson is visible to enrolled students"
            value={visible} onChange={setVisible} isDark={isDark} c={c} />

          <NeuButton label="Save Settings" onPress={handleSave} loading={saving} fullWidth />
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}


// ── Sub-components ─────────────────────────────────────────────────────────────


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

function SettingToggle({ icon: Icon, label, sub, value, onChange, isDark, c }: {
  icon: any; label: string; sub: string;
  value: boolean; onChange: (v: boolean) => void;
  isDark: boolean; c: any;
}) {
  return (
    <Pressable onPress={() => onChange(!value)}
      style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }]}>
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${c.primary}15`, alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={18} color={c.primary} opacity={0.8} />
      </View>
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
          width: 22, height: 22, borderRadius: 11,
          backgroundColor: value ? '#fff' : `${c.text}40`,
          alignSelf: value ? 'flex-end' : 'flex-start',
        }} />
      </View>
    </Pressable>
  );
}
