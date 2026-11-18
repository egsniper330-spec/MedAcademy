/**
 * LessonEditor — Per-lesson editor with video upload, materials, and settings.
 * Route: /lesson-editor/[id]
 * Auto-saves on field changes after 1.5 s debounce.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppModal } from '@/components/AppModal';
import {
  ActivityIndicator, Animated, FlatList, KeyboardAvoidingView, Modal,
  Platform, Pressable, ScrollView, Text, TextInput, useColorScheme, View,
  useWindowDimensions,
} from 'react-native';
import { getInfoAsync } from 'expo-file-system/legacy';
import { resolveDeclaredFileSize } from '@/lib/localFileSize';
import { useFadeAnim } from '@/lib/motion';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft, ArrowRight, Check, CheckCircle, ChevronDown, Clock, Download,
  Eye, EyeOff, FileText, Film,
  Layers, MessageCircle, Paperclip, Play, Plus, RefreshCw, Save,
  Settings, ShieldAlert, Trash2, Upload, Video, Calendar, AlertCircle, X, RotateCcw,
} from 'lucide-react-native';
import * as DocumentPicker from 'expo-document-picker';
import { randomUUID } from 'expo-crypto';

import { NeuButton } from '@/components/NeuButton';
import { NeuCard } from '@/components/NeuCard';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, neuFlatStyle, neuPressedStyle, safeTop, safeLeft, safeRight, safeBottom, mutedTextStyle } from '@/lib/neu';
import { useProfileStore } from '@/lib/store';
import { friendlyError } from '@/lib/validation';
import {
  createLessonMaterial, deleteLessonMaterial, getLessonById,
  updateLesson, updateMaterialPermission,
  uploadLessonMaterial, replaceLessonMaterialFile,
  discardUploadedMaterialObject,
  getLessonVideoState, markLessonVideoMissing,
  getMyProviderPermissions,
  type LessonBuilderPayload, type DownloadPermission, type TeacherProviderPermission,
} from '@/lib/api';
import { validateMaterialFile } from '@/lib/lessonMaterials';
import { isYoutubeReference } from '@/lib/publishValidation';
import { isProviderDisabledError, describeProviderError } from '@/lib/videoProviderPolicy';
import { FeatureUnavailableState } from '@/components/ScreenState';

import { useTranslation } from '@/lib/i18n';
import { MaterialUploadProgress } from '@/components/MaterialUploadProgress';
import {
  classifyUploadFailure,
  isServerRefusal,
  isActiveStage,
  type UploadProgressSnapshot,
} from '@/lib/uploadProgress';

/** Format seconds → "12m 34s" */
function formatDuration(sec: number, locale: string): string {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  const language = locale === 'ar' ? 'ar-EG' : 'en-US';
  return s > 0 ? `${m.toLocaleString(language)}m ${s.toLocaleString(language)}s` : `${m.toLocaleString(language)}m`;
}

/** Friendly label for each upload status stage */
function uploadStatusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'waiting':            return t('lessonEditor.upload.queued');
    case 'uploading':          return t('lessonEditor.upload.uploading');
    case 'processing':         return t('lessonEditor.upload.processing');
    case 'encoding':           return t('lessonEditor.upload.encoding');
    case 'generating_streams': return t('lessonEditor.upload.generatingStreams');
    case 'verifying':          return t('lessonEditor.upload.verifying');
    case 'ready':              return t('lessonEditor.upload.ready');
    case 'failed':             return t('lessonEditor.upload.failed');
    case 'timeout':            return t('lessonEditor.upload.timedOut');
    case 'canceled':           return t('lessonEditor.upload.canceled');
    default:                   return status;
  }
}

type VideoType = 'vdocipher' | 'coming_soon' | 'youtube';
type LessonTab = 'video' | 'materials' | 'settings';

/**
 * Extract the 11-char YouTube video ID from any standard YouTube URL format.
 * Mirrors extractYouTubeVideoId in YouTubePlayer.tsx (watch, youtu.be, embed,
 * shorts, live, m./music. hosts, youtube-nocookie) so what the editor accepts
 * is exactly what the player will validate and play.
 */
function extractYouTubeId(input: string): string | null {
  const trimmed = input.trim();
  const match = trimmed.match(
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[a-z_]+=[^&]*&)*v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );
  if (match) return match[1];
  // Plain 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}
type LessonStatus = 'draft' | 'published' | 'hidden' | 'scheduled' | 'archived';

const LESSON_STATUSES: { value: LessonStatus; labelKey: string; color: string }[] = [
  { value: 'draft',     labelKey: 'courseStatus.draft',     color: '#D97706' },
  { value: 'published', labelKey: 'courseStatus.published', color: '#16A34A' },
  { value: 'hidden',    labelKey: 'courseStatus.hidden',    color: '#6B7280' },
  { value: 'scheduled', labelKey: 'courseStatus.scheduled', color: '#3B82F6' },
  { value: 'archived',  labelKey: 'courseStatus.archived',  color: '#9CA3AF' },
];

const PERMISSION_OPTIONS: { value: DownloadPermission; labelKey: string; icon: any; color: string }[] = [
  { value: 'allow',        labelKey: 'lessonEditor.permission.allow',       icon: Download, color: '#16A34A' },
  { value: 'preview_only', labelKey: 'lessonEditor.permission.previewOnly', icon: Eye,      color: '#3B82F6' },
  { value: 'hidden',       labelKey: 'courseStatus.hidden',                  icon: EyeOff,   color: '#6B7280' },
  { value: 'disabled',     labelKey: 'lessonEditor.permission.disabled',    icon: Layers,   color: '#DC2626' },
];



const VIDEO_TYPES: { value: VideoType; labelKey: string; icon: any; color: string }[] = [
  // VdoCipher is retired: its source button, upload flow and player are gone. A lesson
  // either carries a YouTube URL or is marked coming soon. Lessons that still hold a
  // VdoCipher id keep their record untouched and render the unavailable panel.
  { value: 'youtube',     labelKey: 'lessonEditor.video.youtube', icon: Film,  color: '#DC2626' },
  { value: 'coming_soon', labelKey: 'cb.lessonType.comingSoon',  icon: Clock, color: '#D97706' },
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

function formatBytes(bytes: number, locale: string): string {
  const language = locale === 'ar' ? 'ar-EG' : 'en-US';
  if (bytes < 1024) return `${bytes.toLocaleString(language)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString(language, { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString(language, { maximumFractionDigits: 1 })} MB`;
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
  const { t, tCount, isRTL, locale } = useTranslation();
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
  /**
   * The material transfer that is visible in the Materials tab.
   *
   * This replaces a bare spinner: a 40 MB PDF on a slow link took minutes
   * with no bytes, no percentage and no cancel, which is indistinguishable
   * from a hung request. The snapshot is produced by lib/uploadProgress.ts
   * and distinguishes uploading (bytes on the wire) from verifying/saving
   * (server-side), so 100 % transferred is never shown as success.
   */
  const [materialTransfer, setMaterialTransfer] = useState<{
    fileName: string;
    snapshot: UploadProgressSnapshot;
    error: string | null;
    canRetry: boolean;
  } | null>(null);
  /** Aborts ONLY the in-flight material transfer the doctor started. */
  const materialAbortRef = useRef<AbortController | null>(null);


  // Lesson metadata
  const [lesson, setLesson] = useState<any>(null);
  const [materials, setMaterials] = useState<any[]>([]);

  // Video fields
  const [videoType, setVideoType] = useState<VideoType>('youtube');
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

  //  Set when the SERVER refused a save because the lesson's video provider is
  //  disabled for this account. Renders the informative inline unavailable
  //  state in the video entry area (instead of leaving a form that will fail
  //  again). Cleared on retry and when the lesson reloads.
  const [providerSaveBlocked, setProviderSaveBlocked] = useState<string | null>(null);

  //  Effective provider availability for THIS account — the exact mirror of
  //  VideoProviderPolicyService. Hoisted here (previously computed inline in
  //  the picker) so the video entry area can render the same decision.
  const plyrPerm      = providerPerms.find(p => p.provider_key === 'plyr');
  const plyrBlocked      = plyrPerm ? !plyrPerm.final_enabled : false;
  const providerBlockedMsg = (perm: TeacherProviderPermission | undefined, name: string) =>
    perm && !perm.global_enabled
      ? `${name} is currently disabled by the administrator.`
      : `${name} has been disabled for your account.`;

  // Per-material permission picker & replace tracking
  const [openPermMenu, setOpenPermMenu] = useState<string | null>(null);
  const [replacingId, setReplacingId] = useState<string | null>(null);

  // ── Video Library state ───────────────────────────────────────────────────
  // Picker shown when no video is linked yet ("Choose From Library")
  // Replace sheet shown when a video is already linked ("Replace")
  // How many lessons share the current video_asset_id (for replace-scope prompt)

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
      // YouTube. The reference can live in EITHER column: the editor itself
      // writes both on save (see the payload below), but records created before
      // that normalisation — or by an older build — may carry only
      // `video_id`. Without this fallback the saved URL looked empty on reopen
      // while the lesson really had one.
      const ytId = data.youtube_video_id
        || (isYoutubeReference(data.video_id) ? (extractYouTubeId(data.video_id ?? '') || data.video_id) : '');
      setYoutubeVideoId(ytId);
      setYoutubeUrlInput(ytId ? `https://youtu.be/${ytId}` : '');
      setIsPreview(data.is_preview ?? false);
      setDownloadEnabled(data.download_enabled ?? true);
      setCommentsEnabled(data.comments_enabled ?? true);
      setVisible(data.visible ?? true);
      setScheduledAt(data.scheduled_at ?? '');
      setMaterials(data.lesson_materials ?? []);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('lessonEditor.loadFailed')) });
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

  // Trigger auto-save on field changes
  useEffect(() => {
    if (!lesson) return;
    scheduleAutoSave({
      title, description, notes, status,
      video_type: videoType,
      // ONE reference, TWO columns, written together: `video_id` is what every
      // consumer (course builder, player, duplication) reads, and
      // `youtube_video_id` is the legacy/editor column. Writing only one of them
      // is what made a saved YouTube lesson look empty at publish time.
      video_id: videoType === 'youtube' ? (youtubeVideoId || videoId) : videoId,
      video_title: videoTitle,
      video_playback_id: videoPlaybackId, video_thumbnail: videoThumbnail,
      youtube_video_id: youtubeVideoId || undefined,
      is_preview: isPreview, download_enabled: downloadEnabled,
      comments_enabled: commentsEnabled, visible,
      scheduled_at: scheduledAt || undefined,
    });
  }, [title, description, notes, status, videoType, videoId, videoTitle, videoPlaybackId,
    videoThumbnail, youtubeVideoId, isPreview, downloadEnabled, commentsEnabled, visible, scheduledAt]);

  // ── Attach a library asset to this lesson (no upload needed) ─────────────
  // ── Material transfer (progress + cancellation) ──────────────────────────
  /**
   * Runs one material transfer and reports byte progress.
   *
   * ONE AT A TIME: a second call is ignored while a transfer is registered, so
   * a double tap on "Upload file" cannot start two uploads for the same
   * lesson (which used to leave a duplicate material and wasted bytes).
   */
  const runMaterialTransfer = async (
    file: DocumentPicker.DocumentPickerAsset,
    kind: 'new' | 'replace',
    material?: any,
  ) => {
    if (!lesson || !profile) return;
    if (materialAbortRef.current) return;
    const controller = new AbortController();
    materialAbortRef.current = controller;
    // The byte count we declare must be a MEASUREMENT where possible: the
    // picker's `size` is provider metadata that has reported 679 bytes for a
    // 140 KB PDF. Stat the local file first and tell the server which number we
    // sent (`stat` vs `picker`), so a bad hint can never refuse a real document.
    const declared = await resolveDeclaredFileSize(
      { uri: file.uri, pickerSize: file.size, platform: Platform.OS },
      async (uri) => {
        const info = await getInfoAsync(uri);
        return info.exists && !info.isDirectory ? Number(info.size ?? 0) : 0;
      },
    );
    const total = declared.size;
    setMaterialTransfer({
      fileName: file.name,
      snapshot: {
        stage: 'preparing', bytesSent: 0, totalBytes: total > 0 ? total : 0,
        percent: null, speedBps: 0, etaSeconds: null, elapsedMs: 0,
      },
      error: null,
      canRetry: false,
    });
    const onProgress = (snapshot: UploadProgressSnapshot) => {
      setMaterialTransfer(prev => (prev ? { ...prev, snapshot } : prev));
    };
    const setStage = (stage: UploadProgressSnapshot["stage"]) => {
      setMaterialTransfer(prev => (prev ? { ...prev, snapshot: { ...prev.snapshot, stage } } : prev));
    };
    try {
      const courseId = lesson.section?.course_id ?? lesson.course_id;
      if (kind === 'replace' && material) {
        setReplacingId(material.id);
        const updated = await replaceLessonMaterialFile(
          material.id, material.storage_path,
          courseId, lesson.id,
          file.uri, file.name,
          file.mimeType ?? 'application/octet-stream',
          declared.size,
          { onProgress, signal: controller.signal, declaredSizeSource: declared.source },
        );
        setMaterials(prev => prev.map(m => m.id === material.id ? updated : m));
        showToast({ type: 'success', message: t('lessonEditor.fileReplaced') });
      } else {
        setUploading(true);
        const { storagePath, publicUrl, size } = await uploadLessonMaterial(
          courseId, lesson.id, file.uri, file.name,
          file.mimeType ?? 'application/octet-stream',
          declared.size,
          { onProgress, signal: controller.signal, declaredSizeSource: declared.source },
        );
        // Bytes are stored; the row still has to be written.
        setStage('saving');
        let created;
        try {
          created = await createLessonMaterial({
            lesson_id: lesson.id,
            course_id: courseId,
            uploaded_by: profile.id,
            file_name: file.name,
            file_url: publicUrl,
            storage_path: storagePath,
            file_type: file.mimeType ?? 'application/octet-stream',
            file_size: size,
            download_enabled: true,
            preview_enabled: true,
            order_index: materials.length,
          });
        } catch (e) {
          // The row was REFUSED after the bytes were already stored. Nothing
          // references that object, so a retry would upload it a second time and
          // leave the first copy orphaned in private storage forever. Reclaim it
          // only when the server definitively said no (4xx): a 5xx or a dropped
          // connection has an UNKNOWN outcome, and deleting the bytes then could
          // leave a material row pointing at nothing.
          if (isServerRefusal(e as { status?: number })) {
            void discardUploadedMaterialObject(storagePath);
          }
          throw e;
        }
        setMaterials(prev => [...prev, created]);
        showToast({ type: 'success', message: t('lessonEditor.fileUploaded', { name: file.name }) });
      }
      setMaterialTransfer(prev => (prev
        ? { ...prev, snapshot: { ...prev.snapshot, stage: 'done' as const, percent: 100 }, error: null, canRetry: false }
        : prev));
    } catch (e) {
      // Distinguish the doctor's own cancel from a real failure, and map
      // 413 / 429 / 401 / 5xx / dropped connection to actionable wording.
      const info = classifyUploadFailure(e as { status?: number; code?: string; name?: string });
      // Quote the server's operation id when the refusal carried one: it is the
      // only way to point at THIS attempt in the upload log (`op` on the
      // `storage-upload` lines) instead of describing the whole afternoon.
      const op = String((e as { op?: string })?.op ?? '');
      const message = info.stage === 'failed' && op !== ''
        ? `${t(info.messageKey)}\n\n${t('lessonEditor.upload.reference', { op })}`
        : t(info.messageKey);
      setMaterialTransfer(prev => (prev
        ? { ...prev, snapshot: { ...prev.snapshot, stage: info.stage }, error: message, canRetry: info.retryable }
        : prev));
      if (info.stage === 'failed') showToast({ type: 'error', message });
    } finally {
      materialAbortRef.current = null;
      setUploading(false);
      setReplacingId(null);
    }
  };

  /** Cancel the registered material transfer only (never other work). */
  const cancelMaterialTransfer = () => {
    materialAbortRef.current?.abort();
  };

  // ── Upload material
  const handleUploadMaterial = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false });
      if (result.canceled || !result.assets?.[0]) return;
      const file = result.assets[0];
      if (!profile || !lesson) return;

      // Fail fast on the same policy the server enforces (size + file type), so
      // the doctor gets a specific reason instead of a generic "Upload failed"
      // after the bytes have already been sent.
      const policyError = validateMaterialFile({ name: file.name, size: file.size });
      if (policyError) {
        showToast({ type: 'error', message: policyError });
        return;
      }

      // A picker that hands back a 0-byte asset (iCloud placeholder, a revoked
      // content:// grant, an empty file) would otherwise be "uploaded" and then
      // stored as a zero-byte document — the failure that reached production.
      if (!(Number(file.size ?? 0) > 0)) {
        showToast({ type: 'error', message: t('lessonEditor.uploadEmpty') });
        return;
      }

      await runMaterialTransfer(file, 'new');
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('lessonEditor.uploadFailed')) });
    }
  };

  // ── Replace material file
  const handleReplaceMaterial = async (material: any) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false });
      if (result.canceled || !result.assets?.[0]) return;
      const file = result.assets[0];
      if (!lesson) return;

      const replacePolicyError = validateMaterialFile({ name: file.name, size: file.size });
      if (replacePolicyError) {
        showToast({ type: 'error', message: replacePolicyError });
        return;
      }
      if (!(Number(file.size ?? 0) > 0)) {
        showToast({ type: 'error', message: t('lessonEditor.uploadEmpty') });
        return;
      }

      await runMaterialTransfer(file, 'replace', material);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('lessonEditor.replaceFailed')) });
    }
  };

  const handleDeleteMaterial = async (material: any) => {
    try {
      await deleteLessonMaterial(material.id, material.storage_path);
      setMaterials(prev => prev.filter(m => m.id !== material.id));
      showToast({ type: 'success', message: t('lessonEditor.fileDeleted') });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('lessonEditor.deleteMaterialFailed')) });
    }
  };

  const handleUpdatePermission = async (materialId: string, permission: DownloadPermission) => {
    try {
      await updateMaterialPermission(materialId, permission);
      setMaterials(prev => prev.map(m => m.id === materialId ? { ...m, permission } : m));
      setOpenPermMenu(null);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('lessonEditor.permissionFailed')) });
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
        video_type: videoType,
        video_id: videoType === 'youtube' ? (youtubeVideoId || videoId) : videoId,
        video_title: videoTitle,
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
      setProviderSaveBlocked(null);
      showToast({ type: 'success', message: t('lessonEditor.lessonSaved') });
      router.back();
    } catch (e) {
      //  A disabled video provider is a DELIBERATE policy state, not a bug.
      //  Surface the friendly provider notice and render the inline
      //  unavailable state in the video entry area — never a generic
      //  "Save failed." that reads as a broken app.
      if (isProviderDisabledError(e)) {
        const msg = describeProviderError(e);
        setProviderSaveBlocked(msg);
        showToast({ type: 'info', message: msg });
      } else {
        showToast({ type: 'error', message: friendlyError(e, t('lessonEditor.saveFailed')) });
      }
    }
    setSaving(false);
  };

  if (loading) return (        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.base }}>

      <ActivityIndicator color={c.primary} size="large" />
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.base, direction: isRTL ? 'rtl' : 'ltr' }}
      behavior={undefined} /* keyboard: native inset only */>

      {/* ── Header — spacing from headerTokens (EDGE_PAD=4, BREATHING=8) ── */}
      <View style={{ paddingTop: layout.headerTop, paddingStart: isRTL ? layout.headerRight : layout.headerLeft, paddingEnd: isRTL ? layout.headerLeft : layout.headerRight, paddingBottom: 12, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 12 }}>
        <Pressable onPress={() => router.back()}
          hitSlop={8}
          style={[neuFlatStyle(isDark), { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }]}>
          {/* Direction-aware arrow, never a rotated one: rotating an Svg icon by
              style pushes its glyph outside the 20×20 viewport, which clips it
              (the button then renders as an empty rounded square in Arabic).
              Icons are not mirrored by the layout engine, so the glyph itself
              is chosen from the app locale — same rule as the shared PageHeader. */}
          {isRTL
            ? <ArrowRight size={20} color={c.text} opacity={0.6} />
            : <ArrowLeft  size={20} color={c.text} opacity={0.6} />}
        </Pressable>
        <View style={{ flex: 1 }}>
          <TextInput
            value={title} onChangeText={setTitle} placeholder={t('lessonEditor.titlePlaceholder')}
            placeholderTextColor={c.mode === 'dark' ? c.textMuted : '#56657A'}
            style={{ fontSize: 17, fontWeight: '800', color: c.text, padding: 0, textAlign: isRTL ? 'right' : 'left', writingDirection: isRTL ? 'rtl' : 'ltr' }}
          />
          {/* Transient ✓ Saved flash — no reserved layout space */}
          {savedVisible && (
            <Animated.View style={{ position: 'absolute', bottom: -14, start: 0, ...savedFade.style, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 3 }}>
              <Check size={10} color="#16A34A" />
              <Text style={{ fontSize: 10, color: '#16A34A', fontWeight: '600' }}>{t('cb.saved')}</Text>
            </Animated.View>
          )}
        </View>
        <Pressable onPress={handleSave} disabled={saving}
          style={{ backgroundColor: c.primary, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {saving ? <ActivityIndicator size="small" color="#fff" /> : <Save size={15} color="#fff" />}
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{t('common.save')}</Text>
        </Pressable>
      </View>

      {/* ── Tab Bar ── */}
      <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', paddingHorizontal: layout.screenPx, gap: 8, marginBottom: 4 }}>
        {([
          { key: 'video',      labelKey: 'lessonEditor.tab.video',     icon: Play },
          { key: 'materials',  labelKey: 'lessonEditor.tab.materials', icon: Paperclip },
          { key: 'settings',   labelKey: 'lessonEditor.tab.settings', icon: Settings },
        ] as { key: LessonTab; labelKey: string; icon: any }[]).map(({ key, labelKey, icon: Icon }) => (
          <Pressable key={key} onPress={() => setTab(key)}
            style={[
              tab === key ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
              { flex: 1, paddingVertical: 10, borderRadius: 14, alignItems: 'center', flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', justifyContent: 'center', gap: 6 },
            ]}>
            <Icon size={15} color={tab === key ? c.primary : c.text} opacity={tab === key ? 1 : 0.45} />
            <Text style={{ fontSize: 13, fontWeight: '700', color: tab === key ? c.primary : c.text, opacity: tab === key ? 1 : 0.55 }}>
              {t(labelKey)}
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
        <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: layout.screenPx, gap: 16 }}>

          {/* Coming Soon */}
          {videoType === 'coming_soon' && (
            <NeuCard style={[neuPressedStyle(isDark), { padding: 24, alignItems: 'center', gap: 8 }]}>
              <Clock size={36} color="#D97706" opacity={0.6} />
              <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{t('courseStatus.comingSoon')}</Text>
              <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.45), textAlign: 'center' }}>
                {t('lessonEditor.comingSoonHelp')}
              </Text>
            </NeuCard>
          )}

          {/* YouTube Video — always visible (the only supported source). */}
          {(videoType === 'youtube' || videoType === 'coming_soon' || videoType === 'vdocipher') && (
            <NeuCard style={{ gap: 14 }}>
              <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                  <Film size={18} color="#DC2626" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{t('lessonEditor.video.youtube')}</Text>
                  <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45) }}>{t('lessonEditor.youtubePasteHint')}</Text>
                </View>
                {youtubeVideoId ? (
                  <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: '#16A34A18' }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#16A34A' }}>{t('lessonEditor.linked')}</Text>
                  </View>
                ) : null}
              </View>

              {/* URL input — replaced by an informative unavailable state when
                  this provider is disabled for the account, so the doctor is
                  never left filing a form the server will refuse. */}
              {plyrBlocked || providerSaveBlocked ? (
                <FeatureUnavailableState
                  compact
                  title={t('lessonEditor.youtubeUnavailable')}
                  description={providerSaveBlocked ?? providerBlockedMsg(plyrPerm, 'YouTube video')}
                />
              ) : (
              <View style={{ gap: 6 }}>
                <NeuInput
                  value={youtubeUrlInput}
                  onChangeText={(text: string) => {
                    setYoutubeUrlInput(text);
                    setYoutubeUrlError(null);
                    const extracted = extractYouTubeId(text);
                    if (extracted) {
                      setYoutubeVideoId(extracted);
                      // Entering a YouTube reference IS choosing YouTube: a
                      // lesson created with another/retired type would
                      // otherwise be saved as that type with an empty own id,
                      // and publishing would report "no video".
                      setVideoType('youtube');
                    } else if (text.trim().length > 0) {
                      setYoutubeVideoId('');
                    } else {
                      setYoutubeVideoId('');
                    }
                  }}
                  onBlur={() => {
                    if (youtubeUrlInput.trim().length > 0 && !youtubeVideoId) {
                      setYoutubeUrlError(t('lessonEditor.youtubeUrlInvalid'));
                    }
                  }}
                  placeholder={t('lessonEditor.youtubeUrlPlaceholder')}
                  isDark={isDark}
                  c={c}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                {youtubeUrlError ? (
                  <Text style={{ fontSize: 12, color: '#DC2626' }}>{youtubeUrlError}</Text>
                ) : youtubeVideoId ? (
                  <Text style={{ fontSize: 12, color: '#16A34A' }}>                      ✓ Video ID: {youtubeVideoId}

                  </Text>
                ) : null}
              </View>
              )}

              {/* Supported formats hint */}
              <View style={{ backgroundColor: `${c.primary}08`, borderRadius: 10, padding: 10, gap: 3 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', ...mutedTextStyle(c, 0.5) }}>{t('lessonEditor.supportedFormats')}</Text>
                {[
                  'https://youtu.be/VIDEO_ID',
                  'https://youtube.com/watch?v=VIDEO_ID',
                  'https://youtube.com/embed/VIDEO_ID',
                  'https://youtube.com/shorts/VIDEO_ID',
                  'https://youtube.com/live/VIDEO_ID',
                  'VIDEO_ID (11 characters)',
                ].map((fmt) => (
                  <Text key={fmt} style={{ fontSize: 11, ...mutedTextStyle(c, 0.4) }}>{fmt}</Text>
                ))}
              </View>
            </NeuCard>
          )}

          {/* Lesson Notes */}
          <Field label={t('lessonEditor.notes')}>
            <NeuInput value={notes} onChangeText={setNotes}
              placeholder={t('lessonEditor.notesPlaceholder')}
              isDark={isDark} c={c} multiline style={{ minHeight: 100 }} />
          </Field>

        </ScrollView>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: MATERIALS  — unlimited attachments, preview/download, replace, delete
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'materials' && (
        <View style={{ flex: 1 }}>
          {/* Material transfer — byte progress, stage and cancel */}
          {materialTransfer && (
            <View style={{ paddingHorizontal: layout.screenPx, paddingTop: 10 }}>
              <MaterialUploadProgress
                fileName={materialTransfer.fileName}
                snapshot={materialTransfer.snapshot}
                errorMessage={materialTransfer.error}
                canRetry={materialTransfer.canRetry}
                onCancel={cancelMaterialTransfer}
                onDismiss={() => setMaterialTransfer(null)}
              />
            </View>
          )}

          {/* Upload button */}
          <View style={{ paddingHorizontal: layout.screenPx, paddingVertical: 10 }}>
            <Pressable onPress={handleUploadMaterial} disabled={uploading || !!materialTransfer && isActiveStage(materialTransfer.snapshot.stage)}
              style={{ backgroundColor: c.primary, padding: 14, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, opacity: uploading ? 0.7 : 1 }}>
              {uploading ? <ActivityIndicator size="small" color="#fff" /> : <Upload size={18} color="#fff" />}
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                {uploading ? t('lessonEditor.upload.uploading') : t('lessonEditor.uploadFile')}
              </Text>
            </Pressable>
            <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.4), textAlign: 'center', marginTop: 6 }}>                { t('lessonEditor.fileTypesHint') }

            </Text>
          </View>

          <FlatList
            data={materials}
            keyExtractor={m => m.id}
            contentContainerStyle={{ padding: layout.screenPx, paddingTop: 4, gap: 10 }}
            ListEmptyComponent={
              <View style={{ alignItems: 'center', paddingVertical: 60 }}>
                <Paperclip size={44} color={c.primary} opacity={0.2} />
                <Text style={{ ...mutedTextStyle(c, 0.4), marginTop: 12, fontSize: 15 }}>{t('lessonEditor.noAttachments')}</Text>
                <Text style={{ ...mutedTextStyle(c, 0.3), fontSize: 13, marginTop: 4 }}>
                  {t('lessonEditor.noAttachmentsHint')}
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
                  <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 12 }}>
                    <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: `${fi.color}18`, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon size={22} color={fi.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }} numberOfLines={1}>{item.file_name}</Text>
                      <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45), marginTop: 2 }}>
                        {formatBytes(item.file_size, locale)} · {item.file_type.split('/')[1]?.toUpperCase() ?? t('lessonEditor.fileType')}
                      </Text>
                    </View>
                    {/* Action buttons */}
                    <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', gap: 6 }}>
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
                      <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: perm.color }}>{t(perm.labelKey)}</Text>
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
                                <Text style={{ fontSize: 13, fontWeight: '700', color: opt.color }}>{t(opt.labelKey)}</Text>
                              </View>
                              {(item.permission ?? 'allow') === opt.value && (
                                <CheckCircle size={13} color={opt.color} />
                              )}
                            </Pressable>
                          );
                        })}

                        {/* NOT a setting. Every student copy of a PDF is
                            personalized with that student's name and public
                            account id; there is no switch to turn it off, and
                            this row only explains that. It is deliberately
                            non-interactive so no doctor can believe they can
                            disable traceability. */}
                        <View style={{ height: 1, backgroundColor: c.border, opacity: 0.4, marginVertical: 4 }} />
                        <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8 }}>
                          <ShieldAlert size={14} color='#7C3AED' />
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: '#7C3AED' }}>
                              {t('lessonEditor.watermarkTitle')}
                            </Text>
                            <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.55) }}>
                              {t('lessonEditor.watermarkBody')}
                            </Text>
                          </View>
                          <View style={{ flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 4 }}>
                            <CheckCircle size={13} color='#7C3AED' />
                            <Text style={{ fontSize: 11, fontWeight: '700', color: '#7C3AED' }}>{t('common.on')}</Text>
                          </View>
                        </View>
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
        <ScrollView automaticallyAdjustKeyboardInsets={process.env.EXPO_OS === 'ios'} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: layout.screenPx, gap: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }}>{t('lessonEditor.lessonAccess')}</Text>

          <SettingToggle
            icon={Eye} label={t('lessonEditor.freePreview')} sub={t('lessonEditor.freePreviewHelp')}
            value={isPreview} onChange={setIsPreview} isDark={isDark} c={c} />
          <SettingToggle
            icon={Download} label={t('lessonEditor.allowDownload')} sub={t('lessonEditor.allowDownloadHelp')}
            value={downloadEnabled} onChange={setDownloadEnabled} isDark={isDark} c={c} />
          <SettingToggle
            icon={MessageCircle} label={t('lessonEditor.commentsEnabled')} sub={t('lessonEditor.commentsEnabledHelp')}
            value={commentsEnabled} onChange={setCommentsEnabled} isDark={isDark} c={c} />
          <SettingToggle
            icon={Layers} label={t('lessonEditor.visible')} sub={t('lessonEditor.visibleHelp')}
            value={visible} onChange={setVisible} isDark={isDark} c={c} />

          <NeuButton label={t('cb.saveSettings')} onPress={handleSave} loading={saving} fullWidth />
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}


// ── Sub-components ─────────────────────────────────────────────────────────────


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const { isRTL } = useTranslation();
  const scheme = useColorScheme();
  const c = scheme === 'dark' ? neuColors.dark : neuColors.light;
  return (
    <View style={{ gap: 6 }}>
      <Text style={[{ fontSize: 13, fontWeight: '700', textAlign: isRTL ? 'right' : 'left' }, mutedTextStyle(c, 0.6)]}>{label}</Text>
      {children}
    </View>
  );
}

function NeuInput({ isDark, c, style, ...props }: any) {
  const { isRTL } = useTranslation();
  return (
    <TextInput
      placeholderTextColor={c.mode === 'dark' ? c.textMuted : '#56657A'}
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

function SettingToggle({ icon: Icon, label, sub, value, onChange, isDark, c }: {
  icon: any; label: string; sub: string;
  value: boolean; onChange: (v: boolean) => void;
  isDark: boolean; c: any;
}) {
  const { isRTL } = useTranslation();
  return (
    <Pressable onPress={() => onChange(!value)}
      style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, flexDirection: 'row', direction: isRTL ? 'rtl' : 'ltr', alignItems: 'center', gap: 14 }]}>
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${c.primary}15`, alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={18} color={c.primary} opacity={0.8} />
      </View>
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
          width: 22, height: 22, borderRadius: 11,
          backgroundColor: value ? '#fff' : `${c.text}40`,
          alignSelf: value ? 'flex-end' : 'flex-start',
        }} />
      </View>
    </Pressable>
  );
}
