import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, Pressable, ActivityIndicator, Platform, useWindowDimensions } from 'react-native';
import { PortalOverlay } from '@/components/PortalOverlay';
import { useFullscreenWindowDims } from '@/lib/useFullscreenWindowDims';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft, Check, CheckCircle, Clock, Download, Eye, FileText, Film,
  Lock, Paperclip, Pause, Play, RefreshCw, ShieldAlert, X,
} from 'lucide-react-native';
import { getLessonById, upsertLessonProgress, getMaterialSignedUrl, getMaterialPdfUrl, getLessonPdfSignedUrl, getCourseById } from '@/lib/api';
import { getMySubscriptionsCached } from '@/lib/myCoursesCache';
import { isPdfMaterial, materialAccess, materialActionLabel, visibleMaterials } from '@/lib/lessonMaterials';
import { backendClient } from '@/client/backendClient';
import { useProfileStore } from '@/lib/store';
import { isPreviewStudent } from '@/lib/previewAsStudent';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout, neuFlatStyle, safeTop, safeLeft, safeRight, safeBottom, mutedTextStyle } from '@/lib/neu';
// expo-file-system v55: legacy sub-path exports createDownloadResumable
// (real progress callbacks) + documentDirectory/cacheDirectory string constants
import {
  createDownloadResumable,
  documentDirectory,
  cacheDirectory,
  deleteAsync,
  getInfoAsync,
} from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import { useSecurity } from '@/lib/SecurityContext';
import {
  deleteOfflineVideo, getOfflineVideos, hydrateOfflineLibrary, isOfflineVideoExpired,
  pauseOfflineVideo,
  syncOfflineEntry, resumeOfflineVideo, safeDisplayTitle,
  startOfflineDownload, subscribeOfflineVideos, type OfflineVideoEntry,
} from '@/lib/offlineVideoService';
import { useScreenCapture } from '@/lib/useScreenCapture';
import { useContentProtection } from '@/lib/useContentProtection';
import { ContentProtectionWarning } from '@/components/ContentProtectionWarning';
import { RecordingBlockedOverlay } from '@/components/RecordingBlockedOverlay';
import { VideoPlayer } from '@/components/VideoPlayer';
import { useTranslation } from '@/lib/i18n';

/** Byte label for the download-progress line (Android-only official fields). */
function fmtBytesLocal(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

const FILE_ICONS: Record<string, { icon: any; color: string }> = {
  'application/pdf': { icon: FileText, color: '#DC2626' },
  'video/': { icon: Film, color: '#7C3AED' },
  'image/': { icon: Eye, color: '#16A34A' },
  default: { icon: Paperclip, color: '#2563EB' },
};
function fileIcon(mimeType: string) {
  if (mimeType?.startsWith('video/')) return FILE_ICONS['video/'];
  if (mimeType?.startsWith('image/')) return FILE_ICONS['image/'];
  return FILE_ICONS[mimeType] ?? FILE_ICONS.default;
}
function formatBytes(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Helpers to strip internal implementation details from display ─────────────
// Internal filenames: storage paths with slashes, timestamp-prefixed names, or
// raw export filenames (e.g. "export_1783530975990.mov").
function isInternalFilename(name: string | null | undefined): boolean {
  if (!name) return true;
  return (
    name.includes('/') ||          // storage path
    /^export_\d+/.test(name) ||    // raw export filename
    /^\d{10,}_/.test(name) ||      // timestamp-prefixed upload
    /^\d{13}/.test(name)           // epoch-ms prefixed
  );
}

// Returns a clean display name for a material file.
// Falls back to "Course Material" if the real name is an internal path.
function cleanFileName(name: string | null | undefined): string {
  if (!name || isInternalFilename(name)) return 'Course Material';
  return name;
}

// A VdoCipher video_id is a short alphanumeric hash (no slashes, no dots).
// Storage paths contain slashes and look like "videos/.../file.mov".
function isVdoCipherVideoId(videoId: string | null | undefined): boolean {
  return !!videoId && !videoId.includes('/') && !videoId.includes('.');
}

/**
 * Lesson Materials / Attachments — the ONE renderer used by both lesson-screen
 * layouts (pinned-player and standard), so the two can never drift apart.
 *
 * Visibility rules (client half; the server enforces the same policy when it
 * mints the signed URL):
 *   • `hidden` / `disabled` materials are NOT listed to a student at all.
 *   • `preview_only` (or download disabled) materials are listed as View — no
 *     download is offered, and a download link is refused server-side anyway.
 *   • `allow` materials offer Download.
 * The section renders nothing when there is no accessible content, so an empty
 * lesson never shows a dangling heading.
 */
function MaterialsSection({
  materials, pdfs, canAccess, c,
  onOpenMaterial, onOpenPdf,
}: {
  materials: any[];
  pdfs: any[];
  canAccess: boolean;
  c: any;
  onOpenMaterial: (material: any, displayName: string, forDownload: boolean) => void;
  onOpenPdf: (fileUrlOrPath: string, displayName: string) => void;
}) {
  const { t, tCount } = useTranslation();
  const items = visibleMaterials(materials);
  if (items.length === 0 && pdfs.length === 0) return null;

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 17, fontWeight: '700', color: c.text }}>{t('lesson.lectureMaterials')}</Text>
        {!canAccess ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Lock size={13} color={c.text} opacity={0.4} />
            <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.4) }}>{t('lesson.subscribersOnly')}</Text>
          </View>
        ) : (
          <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45) }}>
            {tCount('lesson.fileCount', items.length + pdfs.length)}
          </Text>
        )}
      </View>

      {canAccess ? (
        <>
          {items.map((mat: any) => {
            const fi = fileIcon(mat.file_type);
            const Icon = fi.icon;
            const name = cleanFileName(mat.file_name);
            const access = materialAccess(mat);
            const downloadable = access === 'download';
            const path = mat.storage_path ?? mat.file_url;
            return (
              <Pressable
                key={mat.id}
                onPress={() => { if (path) onOpenMaterial(mat, name, downloadable); }}
                accessibilityLabel={downloadable ? `Download ${name}` : `View ${name}`}
                accessibilityRole="button"
              >
                <NeuCard style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
                  <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: `${fi.color}18`, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon size={22} color={fi.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }} numberOfLines={1}>{name}</Text>
                    <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45) }}>
                      {[formatBytes(mat.file_size), mat.file_type?.split('/')[1]?.toUpperCase() ?? 'FILE']
                        .filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: `${c.primary}12`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
                    {downloadable ? <Download size={13} color={c.primary} /> : <Eye size={13} color={c.primary} />}
                    <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>
                      {materialActionLabel(access)}
                    </Text>
                  </View>
                </NeuCard>
              </Pressable>
            );
          })}
          {/* legacy lesson_pdfs — staff only (no per-material permission column,
              and the bytes cannot be watermarked). The caller passes an empty
              list for students, so this renders for doctors/admins only. */}
          {pdfs.map((pdf: any) => {
            const pdfName = pdf.title ?? pdf.file_name ?? 'Lecture Notes';
            return (
              <Pressable key={pdf.id} onPress={() => onOpenPdf(pdf.file_url, pdfName)} accessibilityLabel={`Download ${pdfName}`} accessibilityRole="button">
                <NeuCard style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
                  <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                    <FileText size={22} color="#DC2626" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{pdfName}</Text>
                    <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.45) }}>{t('lesson.pdfDocument')}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#DC262612', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
                    <Download size={13} color="#DC2626" />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#DC2626' }}>{t('lesson.download')}</Text>
                  </View>
                </NeuCard>
              </Pressable>
            );
          })}
        </>
      ) : (
        <NeuCard style={{ padding: 16, alignItems: 'center', gap: 10 }}>
          <Lock size={32} color={c.text} opacity={0.2} />
          <Text style={{ fontSize: 14, fontWeight: '600', ...mutedTextStyle(c, 0.5) }}>
            Subscribe to access {items.length + pdfs.length} {items.length + pdfs.length === 1 ? 'material' : 'materials'}
          </Text>
        </NeuCard>
      )}
    </>
  );
}

export default function LessonPlayer() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const layout = useLayout();
  const insets = layout.insets;
  const { width: screenWidth } = useWindowDimensions();
  const router = useRouter();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useProfileStore();
  const { blocksVideo, hasWarnings, riskScore, threats, isSuperAdmin, checkBeforeVideo, securityLockHard } = useSecurity();

  // Enable screenshot/recording protection while this screen is mounted.
  // Super Admin bypass: SA sessions are exempt — they can screenshot/record freely.
  useScreenCapture({ blockCapture: true, isSuperAdmin });

  // Pause video callback — passed to useContentProtection so recording
  // detection can stop playback immediately before showing the overlay.
  const pauseVideo = useCallback(() => {
    setPlayerVisible(false);
  }, []);

  // Content protection: Android native recording detection + iOS screenshot/recording + strike system.
  // Super Admin bypass: SA sessions are fully exempt from violation reporting.
  const {
    screenshotDetected,
    recordingActive,
    warningMessage,
    strikeCount,
    acknowledgeScreenshot,
  } = useContentProtection(true, pauseVideo, isSuperAdmin);

  const [lesson, setLesson] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [markingComplete, setMarkingComplete] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  // Video playback state — playerVisible switches the thumbnail to the inline player
  const [playerVisible, setPlayerVisible] = useState(false);
  // Watch-position ref — updated on every progress tick; persisted on end/unmount
  const watchPositionRef = useRef(0);
  // Resume position loaded from DB — passed to the player so it seeks on start
  const [resumePosition, setResumePosition] = useState(0);
  // Fullscreen state — when true, all non-video lesson content is hidden so
  // the player fills the screen YouTube-style.
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Explicit fullscreen window pixels — the card/ScrollView fills below use
  // concrete dimensions instead of edge-anchored fill (ancestor-collapse fix).
  const fsWin = useFullscreenWindowDims(isFullscreen);

  // ── LIVE COLLAPSE ON A SECURITY VERDICT FLIP ──────────────────────────────
  // A violation detected at ANY time (periodic check, foreground re-check,
  // screen-capture event, or the player's own parallel re-validation) sets
  // blocksVideo → the player is unmounted by the render gate below. Without
  // this effect the screen would stay in its FULLSCREEN layout with no player
  // and no exit affordance (the header/back control is hidden while
  // fullscreen). Collapsing first guarantees a visible, escapable state.
  // ROOT-CAUSE EXTENSION (security containment): the trigger used to be
  // `blocksVideo` ONLY, but VPN/proxy policy is `block_login` — so a detected
  // VPN raised the gate with `blocksVideo:false` and the native player was
  // NEVER unmounted: it kept decoding (and holding the audio session) behind
  // the full-screen block. The central security lock (securityLockHard) is
  // true for ANY authoritative block, so the player is now destroyed for a
  // login-blocking finding too.
  //
  // `playerVisible` is deliberately cleared: after recovery (VPN off) the
  // screen must NOT silently remount an autoPlay player. Playback restarts
  // only from an explicit user tap.
  useEffect(() => {
    if (!blocksVideo && !securityLockHard) return;
    setIsFullscreen(false);
    setPlayerVisible(false);
  }, [blocksVideo, securityLockHard]);

  // ── Download state ────────────────────────────────────────────────────────
  const [downloadState, setDownloadState] = useState<{
    visible: boolean;
    fileName: string;
    progress: number; // 0–1
    status: 'downloading' | 'success' | 'error';
    errorMsg?: string;
  }>({ visible: false, fileName: '', progress: 0, status: 'downloading' });

  const loadData = useCallback(async () => {
    if (!id) return;
    try {
      setLoadError(null);
      // "Preview as Student": doctors exercise the exact student fetch path —
      // the same scoped GET, the same published-only client filter — so any
      // student-only authorization bug reproduces in the preview.
      const data = await getLessonById(id, profile?.role === 'student' || isPreviewStudent() ? 'student' : profile?.role ?? undefined);
      // Students (and previews) must never see draft lessons — treat as not-found.
      if ((profile?.role === 'student' || isPreviewStudent()) && data?.status !== 'published') {
        setLesson(null);
        setLoading(false);
        return;
      }
      setLesson(data);
      // Check subscription
      if (profile?.role === 'student' && data.section?.course_id) {
        const subs = await getMySubscriptionsCached(profile.id);
        setIsSubscribed(subs.some((s: any) => s.course_id === data.section.course_id));
      } else if (isPreviewStudent()) {
        // Preview: the doctor plays through the privileged OTP path; treat as
        // subscribed so the player is reachable, without any backend change.
        setIsSubscribed(true);
      }
      // Load persisted completion + resume position from DB on every focus
      if (profile?.id) {
        const { data: prog } = await backendClient
          .from('lesson_progress')
          .select('completed, watch_position_seconds')
          .eq('student_id', profile.id)
          .eq('lesson_id', id)
          .maybeSingle();
        setCompleted(prog?.completed === true);
        setResumePosition(prog?.watch_position_seconds ?? 0);
      }
    } catch (e: any) {
      // The silent catch here previously turned EVERY fetch failure — including
      // server 500s like the deployed ownerScope PDO binding bug — into the
      // generic "Lesson not found" screen, hiding the real cause.
      // Surface it (message only; never tokens/PII) so failures are diagnosable.
      const msg = e?.message ?? String(e ?? 'Unknown error');
      console.error('[lesson] getLessonById failed:', msg);
      setLoadError(msg);
      setLesson(null);
    }
    setLoading(false);
  }, [id, profile]);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  // Tap play → security gate → show inline embedded player
  const handlePlay = useCallback(async () => {
    const isVdo = lesson?.video_type === 'vdocipher' && isVdoCipherVideoId(lesson.video_id);
    const isYt  = lesson?.video_type === 'youtube' && !!lesson.youtube_video_id;
    if (!isVdo && !isYt) return;
    // ── SECURITY GATE AT THE CONTENT BOUNDARY (fail-closed) ───────────────
    // The authoritative SecurityContext verdict must explicitly say SAFE
    // before any player is created. UNKNOWN (evaluation in progress / result
    // not yet confirmed) = BLOCKED — a hung or slow check can never open a
    // playback window. The UI render path also re-checks blocksVideo below,
    // and YouTubePlayer independently re-validates before its fullscreen
    // Modal mounts (defense in depth at every boundary).
    if (!isSuperAdmin) {
      if (blocksVideo) return;
      try {
        const blocked = await checkBeforeVideo();
        if (blocked) return;
      } catch {
        return; // fail-closed: evaluation error never opens playback
      }
    }
    // Pre-video native re-check: catches recording that started after login.
    if (process.env.EXPO_OS === 'android') {
      const { getNativeSecurityFlags } = await import('@/lib/nativeSecurity');
      const flags = await getNativeSecurityFlags();
      if (flags.screenBeingRecorded) {
        // Recording is already active — show overlay without starting playback
        return;
      }
    }
    setPlayerVisible(true);
  }, [lesson, isSuperAdmin, blocksVideo, checkBeforeVideo]);

  // ── OFFLINE DOWNLOAD (official VdoCipher DRM flow) ─────────────────────
  // Backend /video/offline-authorize runs the SAME gates as playback OTP
  // MedAcademy course title for the offline metadata — persisted at authorize
  // time so the Offline Library groups under the real course name (online
  // fetch; harmless offline where it stays null → generic grouping label).
  const [courseTitle, setCourseTitle] = useState<string | null>(null);
  // Course IMAGE + section title are persisted at authorize time so the
  // Offline Library shows the SAME course image as the online course.
  const [courseImageUrl, setCourseImageUrl] = useState<string | null>(null);
  useEffect(() => {
    const cid = lesson?.section?.course_id;
    if (!cid) { setCourseTitle(null); setCourseImageUrl(null); return; }
    let alive = true;
    void (async () => {
      try {
        const c = (await getCourseById(cid)) as any;
        if (alive) {
          setCourseTitle(c?.title ?? null);
          setCourseImageUrl(c?.image_url ?? c?.cover_url ?? c?.thumbnail_url ?? null);
        }
      } catch { if (alive) { setCourseTitle(null); setCourseImageUrl(null); } }
    })();
    return () => { alive = false; };
  }, [lesson?.section?.course_id]);

  // (auth/entitlement/security) and issues a finite rental license. The SDK
  // then fetches DRM-protected media; progress/complete/fail flow through
  // offlineVideoService into the Offline Library. Security gate first.
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [offlineMsg, setOfflineMsg] = useState<string | null>(null);
  // Live state machine for the Download button — reconciled from the
  // authoritative offlineVideoService (SDK events + MedAcademy metadata),
  // not from a snapshot taken at mount.
  const [dlEntry, setDlEntry] = useState<OfflineVideoEntry | null>(null);
  const handleDownloadForOffline = useCallback(async () => {
    if (!profile || !lesson) return;
    if (lesson.video_type !== 'vdocipher' || !isVdoCipherVideoId(lesson.video_id)) return;
    if (!isSuperAdmin) {
      if (blocksVideo) return;
      try {
        const blocked = await checkBeforeVideo();
        if (blocked) return;
      } catch { return; }
    }
    setOfflineBusy(true);
    setOfflineMsg(null);
    try {
      const res = await startOfflineDownload({
        userId: profile.id,
        videoId: lesson.video_id,
        lessonId: lesson.id,
        courseId: lesson.section?.course_id ?? null,
        // MedAcademy course/lesson metadata persisted NOW (authorize time) so
        // the Offline Library renders its own titles/images — never VdoCipher
        // names or internal ids. courseImageUrl = the online course's image.
        courseName: courseTitle,
        courseImageUrl,
        sectionTitle: (lesson.section as any)?.title ?? null,
        title: safeDisplayTitle({
          lessonTitle: lesson.title,
          title: lesson.video_title,
        }),
        lessonTitle: lesson.title,
        lessonThumbnailUrl: lesson.video_thumbnail ?? null,
        lessonOrder: typeof lesson.order_index === 'number' ? lesson.order_index : null,
      });
      setOfflineMsg(res.ok
        ? 'Downloading — track progress here or in Offline Videos.'
        : (res.error || 'Could not start the download.'));
    } catch (e:any) {
      setOfflineMsg(e?.message ?? 'Could not start the download.');
    } finally {
      setOfflineBusy(false);
    }
  }, [profile, lesson, isSuperAdmin, blocksVideo, checkBeforeVideo, courseTitle]);

  // Authoritative download state for THIS lesson: live subscription to the
  // offlineVideoService store (SDK events + MedAcademy metadata) — the button
  // reacts to queued/downloading/completed/failed without remounting.
  useEffect(() => {
    if (!lesson) return;
    let mounted = true;
    const pick = (list: OfflineVideoEntry[]) => {
      if (!mounted) return;
      setDlEntry(list.find((e) => e.meta.lessonId === lesson.id) ?? null);
    };
    pick(getOfflineVideos());
    void hydrateOfflineLibrary(profile?.id ?? '').catch(() => {});
    const unsub = subscribeOfflineVideos(pick);
    return () => { mounted = false; unsub(); };
  }, [lesson?.id, profile?.id]);

  // 6120 SAFETY: an online native player must NEVER survive navigation into
  // offline playback. The player is unmount-gated behind playerVisible; hiding
  // it on screen-blur guarantees ZERO online VdoPlayerView instances while any
  // offline watch screen (or any other screen) is in front. Playback position
  // is already persisted continuously by onProgress, and enableAutoResume
  // seeks back on the next play — nothing is lost by unmounting here.
  useFocusEffect(
    useCallback(() => {
      return () => { setPlayerVisible(false); };
    }, []),
  );

  // SDK RECONCILE ON FOCUS: the Lesson row must observe the SAME authoritative
  // state the Offline Library sees. Early native events can fire before the
  // listeners/row exist (or while the screen was navigated away); one official
  // VdoDownload.query on every focus re-syncs the row — no timers, no faking.
  useEffect(() => {
    const mid = dlEntry?.meta.mediaId;
    if (!mid) return;
    let cancelled = false;
    void syncOfflineEntry(mid).catch(() => {});
    return () => { cancelled = true; void cancelled; };
  }, [dlEntry?.meta.mediaId]);

  // Cancel an in-flight/queued download (official remove; metadata dropped).
  const handleCancelDownload = useCallback(() => {
    if (!dlEntry) return;
    void deleteOfflineVideo(dlEntry.meta.mediaId);
    setOfflineMsg(null);
  }, [dlEntry]);

  // EXPIRED → [Redownload]: drop the stale local row (official remove), then
  // run the normal authorize+download flow for a fresh finite rental license.
  const handleRedownload = useCallback(async () => {
    if (dlEntry) await deleteOfflineVideo(dlEntry.meta.mediaId);
    setDlEntry(null);
    await handleDownloadForOffline();
  }, [dlEntry, handleDownloadForOffline]);

  // Progress tick from player → keep watch-position ref current (no re-render)
  const handleVideoProgress = useCallback((currentTime: number) => {
    watchPositionRef.current = Math.floor(currentTime);
  }, []);

  // Playback ended → persist watch-position + auto-mark complete if not already
  const handleVideoEnd = useCallback(async () => {
    if (!profile || !lesson) return;
    const pos = watchPositionRef.current || lesson.duration_seconds || 0;
    try {
      await upsertLessonProgress({
        student_id: profile.id,
        lesson_id: lesson.id,
        course_id: lesson.section?.course_id ?? '',
        watch_position_seconds: pos,
        completed: true,
      });
      setCompleted(true);
    } catch {}
  }, [profile, lesson]);

  // NEW FEATURE: toggle completed ↔ incomplete
  const handleToggleComplete = async () => {
    if (!profile || !lesson) return;
    setMarkingComplete(true);
    const newState = !completed;
    try {
      await upsertLessonProgress({
        student_id: profile.id,
        lesson_id: lesson.id,
        course_id: lesson.section?.course_id ?? '',
        watch_position_seconds: lesson.duration_seconds ?? 0,
        completed: newState,
      });
      setCompleted(newState);
    } catch {}
    setMarkingComplete(false);
  };

  /** Download a file to the device using expo-file-system/legacy createDownloadResumable.
   *
   *  Gives real per-chunk progress callbacks (0→1).
   *  Android: caches file first, then MediaLibrary.saveToLibraryAsync moves it to Downloads.
   *  iOS:     saves to Documents dir (Files app visible) then offers share sheet.
   *  Web:     opens URL in browser tab (no native FS on web).
   */
  const downloadFile = useCallback(async (signedUrl: string, displayName: string) => {
    if (!signedUrl) return;

    // ── Web: FETCH first, then save ────────────────────────────────────────
    // Navigating to the URL only looked like "nothing happened": a refusal is
    // a JSON body that renders as a blank tab, and no file is ever produced.
    // Fetch it instead, so a failure becomes a visible, actionable message and
    // a success becomes a real download with the document's own filename.
    if (process.env.EXPO_OS === 'web') {
      setDownloadState({ visible: true, fileName: displayName, progress: 0.15, status: 'downloading' });
      let res: Response;
      try {
        res = await fetch(signedUrl);
      } catch {
        // Cross-origin fetch refused (deployment without a CORS header on this
        // route): fall back to the historical navigation, which still works
        // because the server marks the response as an attachment.
        setDownloadState(prev => ({ ...prev, visible: false }));
        const { Linking } = await import('react-native');
        await Linking.openURL(signedUrl);
        return;
      }
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!res.ok || contentType.includes('json')) {
        let message = `Download failed (HTTP ${res.status}).`;
        try {
          const parsed = JSON.parse(await res.text()) as { error?: { message?: string }; message?: string };
          message = parsed?.error?.message ?? parsed?.message ?? message;
        } catch { /* non-JSON body: keep the HTTP status message */ }
        const failure = new Error(message) as Error & { httpStatus?: number };
        failure.httpStatus = res.status;
        throw failure;
      }
      const blob = await res.blob();
      if (blob.size === 0) throw new Error('The server returned an empty file.');
      const safeName = displayName.replace(/[^\w.\-]/g, '_') || 'download';
      const typeExt = contentType.includes('pdf')
        ? 'pdf'
        : (contentType.split('/')[1] ?? '').split(';')[0].trim();
      const downloadName = safeName.includes('.') || !typeExt ? safeName : `${safeName}.${typeExt}`;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = downloadName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
      setDownloadState(prev => ({ ...prev, progress: 1, status: 'success' }));
      setTimeout(() => setDownloadState(prev => ({ ...prev, visible: false })), 1200);
      return;
    }

    // Derive a safe local filename
    const urlExt = signedUrl.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
    const safeName = displayName.replace(/[^\w.\-]/g, '_');
    const localName = safeName.includes('.') ? safeName : `${safeName}.${urlExt || 'bin'}`;

    // iOS → permanent Documents dir (visible in Files app)
    // Android → cache first, then MediaLibrary moves it to Downloads
    const baseDir = Platform.OS === 'ios' ? documentDirectory : cacheDirectory;
    const destUri = `${baseDir ?? ''}${localName}`;

    setDownloadState({ visible: true, fileName: displayName, progress: 0, status: 'downloading' });

    try {
      // Remove stale file so we always get a fresh download
      const info = await getInfoAsync(destUri);
      if (info.exists) await deleteAsync(destUri, { idempotent: true });

      // createDownloadResumable (legacy) — real per-chunk progress callbacks
      const task = createDownloadResumable(
        signedUrl,
        destUri,
        {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          const pct = totalBytesExpectedToWrite > 0
            ? totalBytesWritten / totalBytesExpectedToWrite
            : 0;
          setDownloadState(prev => ({ ...prev, progress: Math.min(0.98, pct) }));
        },
      );

      const result = await task.downloadAsync();
      if (!result?.uri) throw new Error('Download produced no output file.');

      setDownloadState(prev => ({ ...prev, progress: 1, status: 'success' }));

      // ── Persist / share 1.2 s after success ────────────────────────────
      setTimeout(async () => {
        setDownloadState(prev => ({ ...prev, visible: false }));

        if (Platform.OS === 'android') {
          try {
            const { status } = await MediaLibrary.requestPermissionsAsync();
            if (status === 'granted') {
              await MediaLibrary.saveToLibraryAsync(result.uri);
            } else {
              const canShare = await Sharing.isAvailableAsync();
              if (canShare) await Sharing.shareAsync(result.uri, { dialogTitle: displayName });
            }
          } catch {
            const canShare = await Sharing.isAvailableAsync();
            if (canShare) await Sharing.shareAsync(result.uri, { dialogTitle: displayName });
          }
        } else {
          // iOS: file is already in Documents — offer share/save sheet
          const canShare = await Sharing.isAvailableAsync();
          if (canShare) await Sharing.shareAsync(result.uri, { dialogTitle: displayName });
        }
      }, 1200);
    } catch (e: any) {
      console.error('[downloadFile] error:', e?.message ?? e);
      setDownloadState(prev => ({
        ...prev,
        status: 'error',
        errorMsg: e?.message ?? 'Download failed. Please try again.',
      }));
    }
  }, []);

  /**
   * Open a lesson material.
   *
   * PDFs go through the personalized delivery endpoint, which returns a
   * short-lived token URL for a copy watermarked with THIS student's name and
   * public account id — both for viewing and for downloading. The watermarking
   * is decided server-side from the authenticated role, so this screen cannot
   * (and must not) ask for an unwatermarked copy.
   *
   * Every other attachment keeps the existing signed-storage flow: office
   * documents, archives and images cannot be personalized and are unaffected.
   *
   * `forDownload` mirrors the action the student took: a `preview_only` material
   * (or one with downloads switched off) asks for a VIEW link, and the server
   * refuses to mint a download link for it. A refusal is surfaced as the honest
   * per-material message rather than a generic failure.
   */
  const openMaterial = useCallback(async (
    material: any,
    displayName?: string,
    forDownload = true,
  ) => {
    const name = displayName ?? t('lesson.courseMaterial');
    const path = material?.storage_path ?? material?.file_url ?? '';
    if (!path && !material?.id) return;
    try {
      let url: string;
      if (isPdfMaterial(material) && material?.id) {
        // The delivery endpoint mints a fresh token for every open, so a shared
        // or expired link cannot be reused, and the bytes are always this
        // student's personalized copy.
        const delivery = await getMaterialPdfUrl(String(material.id), forDownload);
        url = delivery.url;
      } else {
        url = await getMaterialSignedUrl(String(path), forDownload);
      }
      await downloadFile(url, name);
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const status = Number(e?.httpStatus ?? 0);
      const code = String(e?.errorCode ?? '');
      const refused = status === 403 || code === 'forbidden' || /access denied|forbidden/i.test(msg);
      // ── PERSONALIZED-DELIVERY STAGES ─────────────────────────────────────
      // The server now names the failing stage on the response code (see
      // MaterialDeliveryController::failureStage and the codes thrown by
      // PdfWatermarkService). They are all the SAME user-facing state — the
      // personalized copy could not be produced, and the unwatermarked
      // original will never be substituted — but the exact code is logged so a
      // field report says WHERE it failed instead of "it failed".
      const WATERMARK_STAGES = [
        'watermark_unavailable', 'watermark_busy', 'engine_unavailable',
        'render_failed', 'pdf_parse', 'output_missing', 'publish_failed',
        'source_missing', 'source_unreadable', 'source_not_pdf',
        'source_encrypted', 'source_too_large', 'storage_unwritable', 'schema',
      ];
      const engineMissing =
        WATERMARK_STAGES.includes(code) || /watermarking is not available/i.test(msg);
      console.error('[openMaterial] delivery error:', msg, { status, code, stage: code || 'unreported' });
      setDownloadState({
        visible: true, fileName: name,
        progress: 0, status: 'error',
        errorMsg: refused
          ? (forDownload
              ? t('lesson.materialDownloadUnavailable')
              : t('lesson.materialNoAccess'))
          : (engineMissing || status === 503 || status === 422 || status === 500
              ? t('lesson.materialWatermarkUnavailable')
              : t('lesson.downloadLinkError')),
      });
    }
  }, [downloadFile, t]);

  /** Download a legacy lesson-pdf via a fresh 1-hour signed URL. */
  const openPdf = useCallback(async (fileUrlOrPath: string, displayName?: string) => {
    if (!fileUrlOrPath) return;
    try {
      const signedUrl = await getLessonPdfSignedUrl(fileUrlOrPath);
      await downloadFile(signedUrl, displayName ?? t('lesson.lectureNotes'));
    } catch (e: any) {
      console.error('[openPdf] signed URL error:', e?.message ?? e);
      setDownloadState({
        visible: true, fileName: displayName ?? t('lesson.lectureNotes'),
        progress: 0, status: 'error',
        errorMsg: t('lesson.downloadLinkError'),
      });
    }
  }, [downloadFile, t]);

  const isStudent = profile?.role === 'student';
  const canAccessMaterials = isSubscribed || lesson?.is_preview || !isStudent;

  if (loading) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.base }}>
      <ActivityIndicator color={c.primary} size="large" />
    </View>
  );
  if (!lesson) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.base, gap: 8, padding: 24 }}>
      <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, textAlign: 'center' }}>
        {loadError
          ? t('lesson.failedToLoad')
          : profile?.role === 'student' || isPreviewStudent()
            ? t('lesson.notAvailable')
            : t('lesson.notFound')}
      </Text>
      {loadError ? (
        <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5), textAlign: 'center' }} numberOfLines={4}>
          {loadError}
        </Text>
      ) : (
        <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.45), textAlign: 'center' }}>
          {profile?.role === 'student' || isPreviewStudent() ? t('lesson.mayBeRemoved') : ''}
        </Text>
      )}
      {/* Retry — the fetch is idempotent (plain GET); no side effects. */}
      <Pressable
        onPress={() => { setLoading(true); loadData(); }}
        accessibilityRole="button"
        accessibilityLabel={t('lesson.retryLoad')}
        style={{ marginTop: 8, paddingHorizontal: 22, paddingVertical: 10, borderRadius: 12, backgroundColor: `${c.primary}15` }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: c.primary }}>{t('common.retry')}</Text>
      </Pressable>
    </View>
  );

  const durationMins = lesson.video_duration_seconds
    ? Math.floor(lesson.video_duration_seconds / 60)
    : lesson.duration_seconds ? Math.floor(lesson.duration_seconds / 60) : null;


  // ── Pinned-player layout (fullscreen/rotation root-cause fix) ─────────────
  // While the real player is live, it renders as a DIRECT child of the
  // screen root so the player's in-place fullscreen expansion (absolute-fill
  // of its own container) covers the whole screen. Nested inside the
  // ScrollView, an absolute-fill would only cover the scroll content box.
  // The SAME player instance renders in both placements — only its
  // container style toggles between the inline 16:9 block and absolute fill.
  const isPinnedPlayer = !blocksVideo && !securityLockHard && playerVisible &&
    (lesson.video_type === 'vdocipher' || lesson.video_type === 'youtube');

  // Header — spacing from headerTokens (EDGE_PAD=4, BREATHING=8)
  const headerBlock = (
      <View style={{ paddingTop: layout.headerTop, paddingLeft: layout.headerLeft, paddingRight: layout.headerRight, paddingBottom: 12, flexDirection: 'row', alignItems: 'center' }}>
        <Pressable onPress={() => router.back()}
          hitSlop={8}
          accessibilityLabel="Go back"
          accessibilityRole="button"
          style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center',
            shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 5, marginRight: 14 }}>
          <ArrowLeft size={20} color={c.text} opacity={0.6} />
        </Pressable>
        <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, flex: 1 }} numberOfLines={1}>{lesson.title}</Text>
      </View>
  );

  const playerSection = (
    <>
        {/* ── Video Player — provider-routed (VdoCipher or YouTube) ── */}
        {!blocksVideo && !securityLockHard && (lesson.video_type === 'vdocipher' || lesson.video_type === 'youtube') && (
          /* FULLSCREEN EXPANSION TARGET — this card is the player's direct
             parent, so IT receives the absolute-fill style when fullscreen
             (style-only: same card, same player instance, no remount).
             Yoga positions absolute children against the DIRECT parent, so
             expanding the adapter alone would only fill this card — that
             parent/child mismatch was the split-screen bug.

             WATERMARK LAYERING: the card is also the watermark's ancestor —
             when fullscreen it must win the sibling z-order against the
             content ScrollView below, or the content's opaque black layer
             paints OVER the card and buries the RN watermark overlay (the
             video stays visible only via its higher native layer → the
             "video plays but watermark disappears" bug). zIndex 110 > 10:
             exactly ONE player system, no second watermark — the SAME
             canonical overlay simply stays above every sibling. */
          <NeuCard
            style={isFullscreen
              ? { padding: 0, position: 'absolute', top: 0, left: 0, width: fsWin.width, height: fsWin.height, zIndex: 110, backgroundColor: '#000', borderRadius: 0 }
              : { padding: 0 }}
          >
            {playerVisible ? (
              // ── Inline player — replaces thumbnail once Play is tapped ─────
              <VideoPlayer
                videoType={lesson.video_type}
                videoId={lesson.video_id}
                youtubeVideoId={lesson.youtube_video_id}
                lessonId={lesson.id}
                resumePosition={resumePosition}
                // Watermark identity: the product's public-facing identifier
                // (MED-#### public_user_id, shown on profile screens as the
                // forensic Watermark ID) with the legacy WM id as fallback.
                // Never an internal DB id, never a token.
                watermarkId={profile?.public_user_id ?? profile?.watermark_id ?? undefined}
                // Viewer display name for ALL roles — a doctor previewing their
                // own content must also see the watermark (it previously only
                // rendered for students, leaving doctor sessions unwatermarked).
                watermarkName={profile?.full_name ?? undefined}
                onProgress={handleVideoProgress}
                onEnd={handleVideoEnd}
                onFullscreen={setIsFullscreen}
                // SECURITY GATE (fullscreen boundary): fullscreen expansion
                // happens IN PLACE (no Modal/second surface), so the expanded
                // player still sits below the SecurityGate overlay. The gate
                // verdict is re-validated by the player at entry (fail-closed)
                // and re-checked live while fullscreen, so a violation that
                // occurs mid-playback collapses fullscreen.
                shouldAllowFullscreen={async () => {
                  if (isSuperAdmin) return true;
                  if (blocksVideo) return false;
                  try {
                    return !(await checkBeforeVideo());
                  } catch {
                    return false;
                  }
                }}
                // LIVE VERDICT — the already-published SecurityContext verdict
                // (plus the Super Admin bypass). Read synchronously so fullscreen
                // appears in the same frame as the tap; `shouldAllowFullscreen`
                // above then re-validates the full pipeline in parallel and a
                // denial collapses fullscreen immediately. Fail-closed: an
                // UNKNOWN verdict (blocksVideo true) still refuses entry.
                fullscreenVerdictNow={() => isSuperAdmin || (!blocksVideo && !securityLockHard)}
              />
            ) : (
              // ── Thumbnail / placeholder — tap to load ─────────────────────
              <Pressable onPress={handlePlay} accessibilityLabel={t('lesson.playVideo')} accessibilityRole="button">
                {lesson.video_thumbnail ? (
                  <View style={{ width: '100%', aspectRatio: 16 / 9, position: 'relative' }}>
                    <Image source={{ uri: lesson.video_thumbnail }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
                    <View style={{ position: 'absolute', inset: 0, backgroundColor: '#00000055', alignItems: 'center', justifyContent: 'center' }}>
                      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: `${c.primary}cc`, alignItems: 'center', justifyContent: 'center' }}>
                        <Play size={24} color="#fff" />
                      </View>
                    </View>
                  </View>
                ) : (
                  <View style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: `${c.primary}12`, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                    <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: `${c.primary}cc`, alignItems: 'center', justifyContent: 'center' }}>
                      <Play size={24} color="#fff" />
                    </View>
                    {resumePosition > 10 && (
                      <Text style={{ fontSize: 12, fontWeight: '600', ...mutedTextStyle(c, 0.5) }}>
                        {t('lesson.resumeAt', {
                          mins: Math.floor(resumePosition / 60),
                          secs: Math.floor(resumePosition % 60),
                        })}
                      </Text>
                    )}
                  </View>
                )}
              </Pressable>
            )}
            {/* VdoCipher-only: show stored video title if it is not an internal filename.
                NOTE: `!!lesson.video_title` — an empty-string title would otherwise
                short-circuit this && chain to '' which React renders as a raw text
                node inside a <View> ("Unexpected text node" warning). */}
            {lesson.video_type === 'vdocipher' && !!lesson.video_title && !isInternalFilename(lesson.video_title) && isVdoCipherVideoId(lesson.video_id) && (
              <View style={{ padding: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: c.text, flex: 1 }} numberOfLines={2}>{lesson.video_title}</Text>
                  {/* ── Download button state machine (authoritative SDK state) ── */}
                  {(() => {
                    const expired = dlEntry ? isOfflineVideoExpired(dlEntry) : false;
                    const phase = dlEntry?.phase;
                    const pill = (bg: string) => ({
                      flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6,
                      paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: bg,
                    });
                    const busy = offlineBusy;
                    if (dlEntry && expired) {
                      return (
                        <Pressable onPress={handleRedownload} disabled={busy} accessibilityRole="button" accessibilityLabel={t('lesson.redownloadExpired')} style={pill('#FFB02022')}>
                          <RefreshCw size={15} color="#FFB020" />
                          <Text style={{ fontSize: 12, fontWeight: '700', color: '#FFB020' }}>{t('lesson.redownload')}</Text>
                        </Pressable>
                      );
                    }
                    if (phase === 'completed') {
                      return (
                        <Pressable
                          onPress={() => {
                            // 6120 ROOT-CAUSE GUARD: the online VdoCipher player
                            // is still mounted behind this navigation. VdoCipher
                            // documents error 6120 (renderer error) as much more
                            // common with >1 VdoPlayer instance — mounting the
                            // offline player while this one holds its decoder
                            // surface is exactly that scenario. Tear the online
                            // player down FIRST so exactly ONE VdoPlayer exists
                            // for the offline playback session.
                            setPlayerVisible(false);
                            router.push(dlEntry?.meta.courseId
                              ? { pathname: '/offline-course', params: { courseId: dlEntry.meta.courseId } }
                              : '/offline-library');
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={t('lesson.watchOffline')}
                          style={pill('#22C55E1F')}
                        >
                          <Check size={15} color="#22C55E" />
                          <Text style={{ fontSize: 12, fontWeight: '700', color: '#22C55E' }}>{t('lesson.watchOfflineTitle')}</Text>
                        </Pressable>
                      );
                    }
                    if (phase === 'paused') {
                      return (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <Pressable onPress={() => void resumeOfflineVideo(dlEntry!.meta.mediaId)} accessibilityRole="button" accessibilityLabel={t('lesson.resumeDownload')} style={pill(`${c.primary}22`)}>
                            <Download size={15} color={c.text} />
                            <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }}>{t('course.resume')}</Text>
                          </Pressable>
                          <Pressable onPress={handleCancelDownload} accessibilityRole="button" accessibilityLabel={t('lesson.cancelDownload')} style={pill(`${c.text}14`)}>
                            <X size={14} color={c.text} />
                            <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }}>{t('common.cancel')}</Text>
                          </Pressable>
                        </View>
                      );
                    }
                    if (phase === 'processing') {
                      return (
                        <View style={pill(`${c.primary}22`)}>
                          <Download size={15} color={c.text} />
                          <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }}>{t('lesson.processing')}</Text>
                        </View>
                      );
                    }
                    if (phase === 'downloading') {
                      return (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <Pressable onPress={() => void pauseOfflineVideo(dlEntry!.meta.mediaId)} accessibilityRole="button" accessibilityLabel={t('lesson.pauseDownload')} style={pill(`${c.primary}22`)}>
                            <Pause size={15} color={c.text} />
                            <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }}>{Math.round(dlEntry!.progress)}%</Text>
                          </Pressable>
                          <Pressable onPress={handleCancelDownload} accessibilityRole="button" accessibilityLabel={t('lesson.cancelDownload')} style={pill(`${c.text}14`)}>
                            <X size={14} color={c.text} />
                            <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }}>{t('common.cancel')}</Text>
                          </Pressable>
                        </View>
                      );
                    }
                    if (phase === 'pending' || phase === 'authorizing') {
                      return (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <View style={pill(`${c.primary}22`)}>
                            <Download size={15} color={c.text} />
                            <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }}>{t('lesson.queued')}</Text>
                          </View>
                          <Pressable onPress={handleCancelDownload} accessibilityRole="button" accessibilityLabel={t('lesson.cancelDownload')} style={pill(`${c.text}14`)}>
                            <X size={14} color={c.text} />
                            <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }}>{t('common.cancel')}</Text>
                          </Pressable>
                        </View>
                      );
                    }
                    if (phase === 'failed') {
                      return (
                        <Pressable onPress={() => void resumeOfflineVideo(dlEntry!.meta.mediaId)} accessibilityRole="button" accessibilityLabel={t('lesson.retryDownload')} style={pill('#FF5A5A1F')}>
                          <RefreshCw size={15} color="#FF5A5A" />
                          <Text style={{ fontSize: 12, fontWeight: '700', color: '#FF5A5A' }}>{t('common.retry')}</Text>
                        </Pressable>
                      );
                    }
                    return (
                      <Pressable onPress={handleDownloadForOffline} disabled={busy} accessibilityRole="button" accessibilityLabel={t('lesson.downloadForOffline')} style={pill(busy ? `${c.primary}33` : `${c.primary}22`)}>
                        <Download size={15} color={c.text} />
                        <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }}>{busy ? t('lesson.starting') : t('lesson.download')}</Text>
                      </Pressable>
                    );
                  })()}
                </View>

                {/* In-flight progress details: percentage, bytes (Android only —
                    official SDK byte fields; never faked on iOS), pause/cancel. */}
                {(dlEntry?.phase === 'downloading' || dlEntry?.phase === 'paused') && (
                  <View style={{ marginTop: 10 }}>
                    <View style={{ height: 6, borderRadius: 3, backgroundColor: `${c.text}14`, overflow: 'hidden' }}>
                      <View style={{ height: 6, borderRadius: 3, backgroundColor: c.primary, width: `${Math.max(3, Math.min(100, dlEntry.progress))}%` }} />
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                      <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5) }}>
                        {Math.round(dlEntry.progress)}%
                        {Platform.OS === 'android' && dlEntry.totalSizeBytes
                          ? ` · ${fmtBytesLocal(dlEntry.bytesDownloaded)} / ${fmtBytesLocal(dlEntry.totalSizeBytes)}`
                          : ''}
                      </Text>
                    </View>
                  </View>
                )}
                {!!dlEntry?.lastError && dlEntry.phase === 'failed' && (
                  <Text style={{ fontSize: 11, color: '#FF5A5A', marginTop: 6 }} numberOfLines={2}>{dlEntry.lastError}</Text>
                )}
                {dlEntry && dlEntry.phase === 'completed' && !isOfflineVideoExpired(dlEntry) && (
                  <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45), marginTop: 6 }}>
                    Downloaded — available in Offline Videos until the license expires.
                  </Text>
                )}
              </View>
            )}
            {!!offlineMsg && (
              <Text style={{ paddingHorizontal: 14, paddingBottom: 12, fontSize: 12, ...mutedTextStyle(c, 0.6) }} numberOfLines={3}>
                {offlineMsg}
              </Text>
            )}
          </NeuCard>
        )}
    </>
  );
  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>

      {/* ── iOS Screen Recording block overlay (absolute, covers video area) ── */}
      {recordingActive && (
        <RecordingBlockedOverlay />
      )}

      {/* ── iOS Screenshot warning modal ── */}
      <ContentProtectionWarning
        visible={screenshotDetected}
        warningMessage={warningMessage}
        strikeCount={strikeCount}
        onAcknowledge={acknowledgeScreenshot}
      />

      {/* ── Download progress modal ─────────────────────────────────────── */}
      <PortalOverlay
        visible={downloadState.visible}
        variant="dialog"
        backdropColor="rgba(0,0,0,0.45)"
        onRequestClose={() => {
          if (downloadState.status !== 'downloading') {
            setDownloadState(prev => ({ ...prev, visible: false }));
          }
        }}
      >
        <View style={{ width: '100%', alignItems: 'center', padding: 24 }}>
          <View style={{
            backgroundColor: c.base, borderRadius: 24, padding: 24, width: Math.min(screenWidth - 48, 420), gap: 16,
            shadowColor: c.shadowDark, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 20,
          }}>
            {/* Title row */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{
                width: 44, height: 44, borderRadius: 13,
                backgroundColor: downloadState.status === 'error' ? '#DC262615' : `${c.primary}15`,
                alignItems: 'center', justifyContent: 'center',
              }}>
                {downloadState.status === 'success'
                  ? <CheckCircle size={22} color="#16A34A" />
                  : downloadState.status === 'error'
                    ? <X size={22} color="#DC2626" />
                    : <Download size={22} color={c.primary} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>
                  {downloadState.status === 'success' ? 'Download Complete' :
                   downloadState.status === 'error'   ? 'Download Failed' :
                   'Downloading…'}
                </Text>
                <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5), marginTop: 2 }} numberOfLines={1}>
                  {downloadState.fileName}
                </Text>
              </View>
              {downloadState.status !== 'downloading' && (
                <Pressable
                  onPress={() => setDownloadState(prev => ({ ...prev, visible: false }))}
                  accessibilityLabel={t('lesson.dismissPanel')}
                  accessibilityRole="button"
                  hitSlop={6} style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: `${c.text}0D`, alignItems: 'center', justifyContent: 'center' }}
                >
                  <X size={15} color={c.text} />
                </Pressable>
              )}
            </View>

            {/* Progress bar — only shown while downloading */}
            {downloadState.status === 'downloading' && (
              <View>
                <View style={{ height: 8, backgroundColor: `${c.text}10`, borderRadius: 4, overflow: 'hidden' }}>
                  <View style={{
                    height: 8, borderRadius: 4, backgroundColor: c.primary,
                    width: `${Math.round(downloadState.progress * 100)}%` as `${number}%`,
                  }} />
                </View>
                <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5), marginTop: 6, textAlign: 'right' }}>
                  {Math.round(downloadState.progress * 100)}%
                </Text>
              </View>
            )}

            {/* Error message */}
            {downloadState.status === 'error' && downloadState.errorMsg && (
              <Text style={{ fontSize: 13, color: '#DC2626', lineHeight: 19 }}>
                {downloadState.errorMsg}
              </Text>
            )}

            {/* Success hint */}
            {downloadState.status === 'success' && (
              <Text style={{ fontSize: 13, color: '#16A34A', lineHeight: 19 }}>
                File saved. The share sheet will open shortly.
              </Text>
            )}
          </View>
        </View>
      </PortalOverlay>
      {isPinnedPlayer ? (
        <>
          {/* FULLSCREEN (in-place, ONE player instance): the player's own
              container expands to absolute-fill of this screen root — it
              simply COVERS the header/content below (they stay mounted so
              the player is never remounted and playback position is kept).
              Hiding the header here is style-only; nothing is unmounted. */}
          {!isFullscreen && headerBlock}
          {playerSection}
          <ScrollView
            style={isFullscreen
              ? { position: 'absolute', top: 0, left: 0, width: fsWin.width, height: fsWin.height, zIndex: 100, backgroundColor: '#000' }
              : { flex: 1 }}
            contentContainerStyle={isFullscreen
              ? { width: fsWin.width, height: fsWin.height }
              : { paddingBottom: safeBottom(layout.insets.bottom) }}
            scrollEnabled={!isFullscreen}
          >
            <View style={isFullscreen ? { width: fsWin.width, height: fsWin.height } : { padding: layout.screenPx, gap: 16 }}>

        {/* Lesson meta — BUG#1: status badge hidden from students */}
        <NeuCard>
          <Text style={{ fontSize: 20, fontWeight: '800', color: c.text, marginBottom: 8 }}>{lesson.title}</Text>
          {lesson.description ? (
            <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.65), lineHeight: 22, marginBottom: 12 }}>{lesson.description}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
            {durationMins !== null && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Clock size={14} color={c.primary} />
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6) }}>{durationMins} min</Text>
              </View>
            )}
            {/* BUG #1 FIX: never show status to students — draft/published is editor-only */}
            {!isStudent && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4,
                  backgroundColor: lesson.status === 'published' ? '#16A34A' : '#D97706' }} />
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6) }}>
                  {lesson.status === 'published' ? 'Published' : lesson.status === 'scheduled' ? 'Scheduled' : 'Draft'}
                </Text>
              </View>
            )}
            {lesson.is_preview && (
              <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20, backgroundColor: `${c.primary}15` }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>{t('lesson.freePreview')}</Text>
              </View>
            )}
          </View>
        </NeuCard>

        {/* ── Video Security Gate ── */}
        {blocksVideo && (
          <View style={[flat, {
            borderRadius: 20, padding: 28,
            alignItems: 'center', gap: 14,
            borderLeftWidth: 4, borderLeftColor: '#EF4444',
          }]}>
            <View style={{
              width: 64, height: 64, borderRadius: 20,
              backgroundColor: '#EF444418',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <ShieldAlert size={32} color="#EF4444" />
            </View>
            <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, textAlign: 'center' }}>
              Video Playback Blocked
            </Text>
            <Text style={{ fontSize: 14, color: `${c.text}77`, textAlign: 'center', lineHeight: 20 }}>
              This device does not meet security requirements.{'\n'}Video content is unavailable.
            </Text>
            <View style={{
              paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
              backgroundColor: '#EF444418',
            }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#EF4444' }}>
                Risk Score: {riskScore}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
              {threats.map((t, i) => (
                <View key={i} style={{
                  paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20,
                  backgroundColor: '#EF444410',
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '600', color: '#EF4444' }}>
                    {t.type.replace(/_/g, ' ')}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ── Security Warning Banner (warn-only policy) ── */}
        {!blocksVideo && hasWarnings && threats.length > 0 && (
          <View style={[flat, {
            borderRadius: 16, padding: 14, flexDirection: 'row', gap: 12,
            alignItems: 'flex-start', borderLeftWidth: 3, borderLeftColor: '#F59E0B',
          }]}>
            <ShieldAlert size={18} color="#F59E0B" />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{t('lesson.securityWarning')}</Text>
              <Text style={{ fontSize: 12, color: `${c.text}77` }}>
                {threats.map((t) => t.type.replace(/_/g, ' ')).join(', ')} detected (Risk: {riskScore})
              </Text>
            </View>
          </View>
        )}
        {/* VdoCipher only: no valid ID yet — video still processing */}
        {!blocksVideo && lesson.video_type === 'vdocipher' && !isVdoCipherVideoId(lesson.video_id) && (
          <NeuCard style={{ padding: 0 }}>
            <View style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: `${c.primary}08`, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <ActivityIndicator color={c.primary} size="large" />
              <Text style={{ fontSize: 14, fontWeight: '700', ...mutedTextStyle(c, 0.65) }}>{t('lesson.processingVideo')}</Text>
              <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.4), textAlign: 'center', paddingHorizontal: 24 }}>
                This video is being prepared. Check back shortly.
              </Text>
            </View>
          </NeuCard>
        )}

        {lesson.video_type === 'coming_soon' && (
          <NeuCard style={{ padding: 24, alignItems: 'center', gap: 10 }}>
            <Clock size={44} color="#D97706" opacity={0.5} />
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>{t('lesson.comingSoon')}</Text>
            <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.45), textAlign: 'center' }}>
              This lesson&apos;s video will be available soon.
            </Text>
          </NeuCard>
        )}

        {/* ── Lesson Notes ── */}
        {!isFullscreen && !!lesson.notes && (
          <NeuCard>
            <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 8 }}>{t('lesson.notes')}</Text>
            <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.65), lineHeight: 22 }}>{lesson.notes}</Text>
          </NeuCard>
        )}

        {/* ── Lecture Materials / Attachments ──
            One shared renderer for both lesson layouts. It hides itself when the
            lesson has no accessible attachments, lists hidden/disabled ones to
            nobody, and offers View (not Download) for `preview_only` materials.
            Shown below the player, lesson info and notes.
            Legacy `lesson_pdfs` rows (superseded by lesson materials) are
            staff-only: their bytes cannot be personalized, so no student is
            offered them — listing one would only produce a dead button, as the
            server refuses its signed URL. */}
        {!isFullscreen && (
          <MaterialsSection
            materials={lesson.lesson_materials ?? []}
            pdfs={isStudent ? [] : (lesson.lesson_pdfs ?? [])}
            canAccess={canAccessMaterials}
            c={c}
            onOpenMaterial={openMaterial}
            onOpenPdf={openPdf}
          />
        )}

        {/* Mark Complete / Mark Incomplete — hidden during fullscreen */}
        {!isFullscreen && isStudent && (
          <View style={{ marginTop: 4 }}>
            {completed ? (
              <View style={{ gap: 10 }}>
                <NeuCard style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 18, gap: 10 }}>
                  <CheckCircle size={22} color="#16A34A" />
                  <Text style={{ fontSize: 16, fontWeight: '700', color: '#16A34A' }}>{t('lesson.completed')}</Text>
                </NeuCard>
                <Pressable
                  onPress={handleToggleComplete}
                  disabled={markingComplete}
                  accessibilityLabel={markingComplete ? 'Updating lesson status' : 'Mark as incomplete'}
                  accessibilityRole="button"
                  style={{ alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ fontSize: 13, color: c.text, opacity: markingComplete ? 0.3 : 0.45, textDecorationLine: 'underline' }}>
                    {markingComplete ? 'Updating…' : 'Mark as Incomplete'}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <NeuButton
                label={t('lesson.markComplete')}
                onPress={handleToggleComplete}
                loading={markingComplete}
                fullWidth
                style={{ backgroundColor: '#16A34A' }}
              />
            )}
          </View>
        )}
            </View>
          </ScrollView>
        </>
      ) : (
        <ScrollView
          style={isFullscreen
            ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10, backgroundColor: '#000' }
            : { flex: 1, backgroundColor: c.base }}
          contentContainerStyle={isFullscreen
            ? { flex: 1 }
            : { paddingBottom: safeBottom(layout.insets.bottom) }}
          scrollEnabled={!isFullscreen}
        >
          {!isFullscreen && headerBlock}
          <View style={isFullscreen ? { flex: 1 } : { padding: layout.screenPx, gap: 16 }}>

        {/* Lesson meta — BUG#1: status badge hidden from students */}
        <NeuCard>
          <Text style={{ fontSize: 20, fontWeight: '800', color: c.text, marginBottom: 8 }}>{lesson.title}</Text>
          {lesson.description ? (
            <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.65), lineHeight: 22, marginBottom: 12 }}>{lesson.description}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
            {durationMins !== null && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Clock size={14} color={c.primary} />
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6) }}>{durationMins} min</Text>
              </View>
            )}
            {/* BUG #1 FIX: never show status to students — draft/published is editor-only */}
            {!isStudent && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4,
                  backgroundColor: lesson.status === 'published' ? '#16A34A' : '#D97706' }} />
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6) }}>
                  {lesson.status === 'published' ? 'Published' : lesson.status === 'scheduled' ? 'Scheduled' : 'Draft'}
                </Text>
              </View>
            )}
            {lesson.is_preview && (
              <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20, backgroundColor: `${c.primary}15` }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>{t('lesson.freePreview')}</Text>
              </View>
            )}
          </View>
        </NeuCard>

        {/* ── Video Security Gate ── */}
        {blocksVideo && (
          <View style={[flat, {
            borderRadius: 20, padding: 28,
            alignItems: 'center', gap: 14,
            borderLeftWidth: 4, borderLeftColor: '#EF4444',
          }]}>
            <View style={{
              width: 64, height: 64, borderRadius: 20,
              backgroundColor: '#EF444418',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <ShieldAlert size={32} color="#EF4444" />
            </View>
            <Text style={{ fontSize: 17, fontWeight: '800', color: c.text, textAlign: 'center' }}>
              Video Playback Blocked
            </Text>
            <Text style={{ fontSize: 14, color: `${c.text}77`, textAlign: 'center', lineHeight: 20 }}>
              This device does not meet security requirements.{'\n'}Video content is unavailable.
            </Text>
            <View style={{
              paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
              backgroundColor: '#EF444418',
            }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#EF4444' }}>
                Risk Score: {riskScore}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
              {threats.map((t, i) => (
                <View key={i} style={{
                  paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20,
                  backgroundColor: '#EF444410',
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '600', color: '#EF4444' }}>
                    {t.type.replace(/_/g, ' ')}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ── Security Warning Banner (warn-only policy) ── */}
        {!blocksVideo && hasWarnings && threats.length > 0 && (
          <View style={[flat, {
            borderRadius: 16, padding: 14, flexDirection: 'row', gap: 12,
            alignItems: 'flex-start', borderLeftWidth: 3, borderLeftColor: '#F59E0B',
          }]}>
            <ShieldAlert size={18} color="#F59E0B" />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{t('lesson.securityWarning')}</Text>
              <Text style={{ fontSize: 12, color: `${c.text}77` }}>
                {threats.map((t) => t.type.replace(/_/g, ' ')).join(', ')} detected (Risk: {riskScore})
              </Text>
            </View>
          </View>
        )}
          {playerSection}
        {/* VdoCipher only: no valid ID yet — video still processing */}
        {!blocksVideo && lesson.video_type === 'vdocipher' && !isVdoCipherVideoId(lesson.video_id) && (
          <NeuCard style={{ padding: 0 }}>
            <View style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: `${c.primary}08`, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <ActivityIndicator color={c.primary} size="large" />
              <Text style={{ fontSize: 14, fontWeight: '700', ...mutedTextStyle(c, 0.65) }}>{t('lesson.processingVideo')}</Text>
              <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.4), textAlign: 'center', paddingHorizontal: 24 }}>
                This video is being prepared. Check back shortly.
              </Text>
            </View>
          </NeuCard>
        )}

        {lesson.video_type === 'coming_soon' && (
          <NeuCard style={{ padding: 24, alignItems: 'center', gap: 10 }}>
            <Clock size={44} color="#D97706" opacity={0.5} />
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>{t('lesson.comingSoon')}</Text>
            <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.45), textAlign: 'center' }}>
              This lesson&apos;s video will be available soon.
            </Text>
          </NeuCard>
        )}

        {/* ── Lesson Notes ── */}
        {!isFullscreen && !!lesson.notes && (
          <NeuCard>
            <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 8 }}>{t('lesson.notes')}</Text>
            <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.65), lineHeight: 22 }}>{lesson.notes}</Text>
          </NeuCard>
        )}

        {/* ── Lecture Materials / Attachments ──
            One shared renderer for both lesson layouts. It hides itself when the
            lesson has no accessible attachments, lists hidden/disabled ones to
            nobody, and offers View (not Download) for `preview_only` materials.
            Shown below the player, lesson info and notes.
            Legacy `lesson_pdfs` rows (superseded by lesson materials) are
            staff-only: their bytes cannot be personalized, so no student is
            offered them — listing one would only produce a dead button, as the
            server refuses its signed URL. */}
        {!isFullscreen && (
          <MaterialsSection
            materials={lesson.lesson_materials ?? []}
            pdfs={isStudent ? [] : (lesson.lesson_pdfs ?? [])}
            canAccess={canAccessMaterials}
            c={c}
            onOpenMaterial={openMaterial}
            onOpenPdf={openPdf}
          />
        )}

        {/* Mark Complete / Mark Incomplete — hidden during fullscreen */}
        {!isFullscreen && isStudent && (
          <View style={{ marginTop: 4 }}>
            {completed ? (
              <View style={{ gap: 10 }}>
                <NeuCard style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 18, gap: 10 }}>
                  <CheckCircle size={22} color="#16A34A" />
                  <Text style={{ fontSize: 16, fontWeight: '700', color: '#16A34A' }}>{t('lesson.completed')}</Text>
                </NeuCard>
                <Pressable
                  onPress={handleToggleComplete}
                  disabled={markingComplete}
                  accessibilityLabel={markingComplete ? 'Updating lesson status' : 'Mark as incomplete'}
                  accessibilityRole="button"
                  style={{ alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ fontSize: 13, color: c.text, opacity: markingComplete ? 0.3 : 0.45, textDecorationLine: 'underline' }}>
                    {markingComplete ? 'Updating…' : 'Mark as Incomplete'}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <NeuButton
                label={t('lesson.markComplete')}
                onPress={handleToggleComplete}
                loading={markingComplete}
                fullWidth
                style={{ backgroundColor: '#16A34A' }}
              />
            )}
          </View>
        )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
