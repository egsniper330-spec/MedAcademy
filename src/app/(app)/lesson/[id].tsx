import { useCallback, useRef, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, Pressable, ActivityIndicator, Modal, Platform, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft, CheckCircle, Clock, Download, Eye, FileText, Film,
  Lock, Paperclip, Play, ShieldAlert, X,
} from 'lucide-react-native';
import { getLessonById, upsertLessonProgress, getMySubscriptions, getMaterialSignedUrl, getLessonPdfSignedUrl } from '@/lib/api';
import { supabase } from '@/client/supabase';
import { useProfileStore } from '@/lib/store';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout, neuFlatStyle, safeTop, safeLeft, safeRight } from '@/lib/neu';
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
import { useScreenCapture } from '@/lib/useScreenCapture';
import { useContentProtection } from '@/lib/useContentProtection';
import { ContentProtectionWarning } from '@/components/ContentProtectionWarning';
import { RecordingBlockedOverlay } from '@/components/RecordingBlockedOverlay';
import { VideoPlayer } from '@/components/VideoPlayer';

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

export default function LessonPlayer() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const layout = useLayout();
  const insets = layout.insets;
  const { width: screenWidth } = useWindowDimensions();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useProfileStore();
  const { blocksVideo, hasWarnings, riskScore, threats, isSuperAdmin } = useSecurity();

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
      const data = await getLessonById(id, profile?.role ?? undefined);
      // Students must never see draft lessons — treat as not-found.
      if (profile?.role === 'student' && data?.status !== 'published') {
        setLesson(null);
        setLoading(false);
        return;
      }
      setLesson(data);
      // Check subscription
      if (profile?.role === 'student' && data.section?.course_id) {
        const subs = await getMySubscriptions(profile.id);
        setIsSubscribed(subs.some((s: any) => s.course_id === data.section.course_id));
      }
      // Load persisted completion + resume position from DB on every focus
      if (profile?.id) {
        const { data: prog } = await supabase
          .from('lesson_progress')
          .select('completed, watch_position_seconds')
          .eq('student_id', profile.id)
          .eq('lesson_id', id)
          .maybeSingle();
        setCompleted(prog?.completed === true);
        setResumePosition(prog?.watch_position_seconds ?? 0);
      }
    } catch {}
    setLoading(false);
  }, [id, profile]);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  // Tap play → security gate → show inline embedded player
  const handlePlay = useCallback(async () => {
    const isVdo = lesson?.video_type === 'vdocipher' && isVdoCipherVideoId(lesson.video_id);
    const isYt  = lesson?.video_type === 'youtube' && !!lesson.youtube_video_id;
    if (!isVdo && !isYt) return;
    // Pre-video security check: re-run native checks before granting access.
    // This catches Developer Options / ADB / recording that started after login.
    if (process.env.EXPO_OS === 'android') {
      const { getNativeSecurityFlags } = await import('@/lib/nativeSecurity');
      const flags = await getNativeSecurityFlags();
      if (flags.screenBeingRecorded) {
        // Recording is already active — show overlay without starting playback
        return;
      }
    }
    setPlayerVisible(true);
  }, [lesson]);

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

    // ── Web fallback ───────────────────────────────────────────────────────
    if (process.env.EXPO_OS === 'web') {
      const { Linking } = await import('react-native');
      await Linking.openURL(signedUrl);
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

  /** Download a lesson-material via a fresh 1-hour signed URL. */
  const openMaterial = useCallback(async (storagePathOrUrl: string, displayName?: string) => {
    if (!storagePathOrUrl) return;
    try {
      const signedUrl = await getMaterialSignedUrl(storagePathOrUrl);
      await downloadFile(signedUrl, displayName ?? 'Course Material');
    } catch (e: any) {
      console.error('[openMaterial] signed URL error:', e?.message ?? e);
      setDownloadState({
        visible: true, fileName: displayName ?? 'Course Material',
        progress: 0, status: 'error',
        errorMsg: 'Could not generate a download link. Please try again.',
      });
    }
  }, [downloadFile]);

  /** Download a legacy lesson-pdf via a fresh 1-hour signed URL. */
  const openPdf = useCallback(async (fileUrlOrPath: string, displayName?: string) => {
    if (!fileUrlOrPath) return;
    try {
      const signedUrl = await getLessonPdfSignedUrl(fileUrlOrPath);
      await downloadFile(signedUrl, displayName ?? 'Lecture Notes');
    } catch (e: any) {
      console.error('[openPdf] signed URL error:', e?.message ?? e);
      setDownloadState({
        visible: true, fileName: displayName ?? 'Lecture Notes',
        progress: 0, status: 'error',
        errorMsg: 'Could not generate a download link. Please try again.',
      });
    }
  }, [downloadFile]);

  const isStudent = profile?.role === 'student';
  const canAccessMaterials = isSubscribed || lesson?.is_preview || !isStudent;

  if (loading) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.base }}>
      <ActivityIndicator color={c.primary} size="large" />
    </View>
  );
  if (!lesson) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.base, gap: 8 }}>
      <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>
        {profile?.role === 'student' ? 'This lesson is not available.' : 'Lesson not found'}
      </Text>
      <Text style={{ fontSize: 13, color: c.text, opacity: 0.45 }}>
        {profile?.role === 'student' ? 'It may have been removed or is not yet published.' : ''}
      </Text>
    </View>
  );

  const durationMins = lesson.video_duration_seconds
    ? Math.floor(lesson.video_duration_seconds / 60)
    : lesson.duration_seconds ? Math.floor(lesson.duration_seconds / 60) : null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic">
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
      <Modal
        visible={downloadState.visible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (downloadState.status !== 'downloading') {
            setDownloadState(prev => ({ ...prev, visible: false }));
          }
        }}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
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
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }} numberOfLines={1}>
                  {downloadState.fileName}
                </Text>
              </View>
              {downloadState.status !== 'downloading' && (
                <Pressable
                  onPress={() => setDownloadState(prev => ({ ...prev, visible: false }))}
                  accessibilityLabel="Dismiss download panel"
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
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 6, textAlign: 'right' }}>
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
      </Modal>
      {/* Header — spacing from headerTokens (EDGE_PAD=4, BREATHING=8) */}
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

      <View style={{ padding: layout.screenPx, gap: 16 }}>
        {/* Lesson meta — BUG#1: status badge hidden from students */}
        <NeuCard>
          <Text style={{ fontSize: 20, fontWeight: '800', color: c.text, marginBottom: 8 }}>{lesson.title}</Text>
          {lesson.description ? (
            <Text style={{ fontSize: 14, color: c.text, opacity: 0.65, lineHeight: 22, marginBottom: 12 }}>{lesson.description}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
            {durationMins !== null && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Clock size={14} color={c.primary} />
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.6 }}>{durationMins} min</Text>
              </View>
            )}
            {/* BUG #1 FIX: never show status to students — draft/published is editor-only */}
            {!isStudent && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4,
                  backgroundColor: lesson.status === 'published' ? '#16A34A' : '#D97706' }} />
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.6 }}>
                  {lesson.status === 'published' ? 'Published' : lesson.status === 'scheduled' ? 'Scheduled' : 'Draft'}
                </Text>
              </View>
            )}
            {lesson.is_preview && (
              <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20, backgroundColor: `${c.primary}15` }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>Free Preview</Text>
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
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>Security Warning</Text>
              <Text style={{ fontSize: 12, color: `${c.text}77` }}>
                {threats.map((t) => t.type.replace(/_/g, ' ')).join(', ')} detected (Risk: {riskScore})
              </Text>
            </View>
          </View>
        )}

        {/* ── Video Player — provider-routed (VdoCipher or YouTube) ── */}
        {!blocksVideo && (lesson.video_type === 'vdocipher' || lesson.video_type === 'youtube') && (
          <NeuCard style={{ padding: 0 }}>
            {playerVisible ? (
              // ── Inline player — replaces thumbnail once Play is tapped ─────
              <VideoPlayer
                videoType={lesson.video_type}
                videoId={lesson.video_id}
                youtubeVideoId={lesson.youtube_video_id}
                lessonId={lesson.id}
                resumePosition={resumePosition}
                watermarkId={profile?.watermark_id ?? undefined}
                watermarkName={profile?.role === 'student' ? (profile?.full_name ?? undefined) : undefined}
                onProgress={handleVideoProgress}
                onEnd={handleVideoEnd}
                onFullscreen={setIsFullscreen}
              />
            ) : (
              // ── Thumbnail / placeholder — tap to load ─────────────────────
              <Pressable onPress={handlePlay} accessibilityLabel="Play video" accessibilityRole="button">
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
                      <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, opacity: 0.5 }}>
                        Resume at {Math.floor(resumePosition / 60)}m {Math.floor(resumePosition % 60)}s
                      </Text>
                    )}
                  </View>
                )}
              </Pressable>
            )}
            {/* VdoCipher-only: show stored video title if it is not an internal filename */}
            {lesson.video_type === 'vdocipher' && lesson.video_title && !isInternalFilename(lesson.video_title) && isVdoCipherVideoId(lesson.video_id) && (
              <View style={{ padding: 14 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{lesson.video_title}</Text>
              </View>
            )}
          </NeuCard>
        )}

        {/* VdoCipher only: no valid ID yet — video still processing */}
        {!blocksVideo && lesson.video_type === 'vdocipher' && !isVdoCipherVideoId(lesson.video_id) && (
          <NeuCard style={{ padding: 0 }}>
            <View style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: `${c.primary}08`, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <ActivityIndicator color={c.primary} size="large" />
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, opacity: 0.65 }}>Processing Video…</Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, textAlign: 'center', paddingHorizontal: 24 }}>
                This video is being prepared. Check back shortly.
              </Text>
            </View>
          </NeuCard>
        )}

        {lesson.video_type === 'coming_soon' && (
          <NeuCard style={{ padding: 24, alignItems: 'center', gap: 10 }}>
            <Clock size={44} color="#D97706" opacity={0.5} />
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>Coming Soon</Text>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.45, textAlign: 'center' }}>
              This lesson&apos;s video will be available soon.
            </Text>
          </NeuCard>
        )}

        {/* ── Lesson Notes ── */}
        {!isFullscreen && lesson.notes && (
          <NeuCard>
            <Text style={{ fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 8 }}>Lesson Notes</Text>
            <Text style={{ fontSize: 14, color: c.text, opacity: 0.65, lineHeight: 22 }}>{lesson.notes}</Text>
          </NeuCard>
        )}

        {/* ── Materials ── */}
        {!isFullscreen && ((lesson.lesson_materials?.length > 0) || (lesson.lesson_pdfs?.length > 0)) && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 17, fontWeight: '700', color: c.text }}>Lesson Materials</Text>
              {!canAccessMaterials && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Lock size={13} color={c.text} opacity={0.4} />
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.4 }}>Subscribers only</Text>
                </View>
              )}
            </View>

            {canAccessMaterials ? (
              <>
                {/* lesson_materials (new) */}
                {(lesson.lesson_materials ?? []).map((mat: any) => {
                  const fi = fileIcon(mat.file_type);
                  const Icon = fi.icon;
                  const name = cleanFileName(mat.file_name);
                  return (
                    <Pressable
                      key={mat.id}
                      onPress={() => mat.download_enabled && openMaterial(mat.storage_path ?? mat.file_url, name)}
                      accessibilityLabel={mat.download_enabled ? `Download ${name}` : name}
                      accessibilityRole="button"
                    >
                      <NeuCard style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
                        <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: `${fi.color}18`, alignItems: 'center', justifyContent: 'center' }}>
                          <Icon size={22} color={fi.color} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }} numberOfLines={1}>{name}</Text>
                          <Text style={{ fontSize: 12, color: c.text, opacity: 0.45 }}>
                            {formatBytes(mat.file_size)} · {mat.file_type?.split('/')[1]?.toUpperCase() ?? 'FILE'}
                          </Text>
                        </View>
                        {mat.download_enabled && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: `${c.primary}12`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
                            <Download size={13} color={c.primary} />
                            <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>Download</Text>
                          </View>
                        )}
                      </NeuCard>
                    </Pressable>
                  );
                })}
                {/* legacy lesson_pdfs */}
                {(lesson.lesson_pdfs ?? []).map((pdf: any) => {
                  const pdfName = pdf.title ?? pdf.file_name ?? 'Lecture Notes';
                  return (
                    <Pressable key={pdf.id} onPress={() => openPdf(pdf.file_url, pdfName)} accessibilityLabel={`Download ${pdfName}`} accessibilityRole="button">
                      <NeuCard style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
                        <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                          <FileText size={22} color="#DC2626" />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{pdfName}</Text>
                          <Text style={{ fontSize: 12, color: c.text, opacity: 0.45 }}>PDF Document</Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#DC262612', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
                          <Download size={13} color="#DC2626" />
                          <Text style={{ fontSize: 11, fontWeight: '700', color: '#DC2626' }}>Download</Text>
                        </View>
                      </NeuCard>
                    </Pressable>
                  );
                })}
              </>
            ) : (
              <NeuCard style={{ padding: layout.screenPx, alignItems: 'center', gap: 10 }}>
                <Lock size={32} color={c.text} opacity={0.2} />
                <Text style={{ fontSize: 14, fontWeight: '600', color: c.text, opacity: 0.5 }}>
                  Subscribe to access {(lesson.lesson_materials?.length ?? 0) + (lesson.lesson_pdfs?.length ?? 0)} materials
                </Text>
              </NeuCard>
            )}
          </>
        )}

        {/* Mark Complete / Mark Incomplete — hidden during fullscreen */}
        {!isFullscreen && isStudent && (
          <View style={{ marginTop: 4 }}>
            {completed ? (
              <View style={{ gap: 10 }}>
                <NeuCard style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 18, gap: 10 }}>
                  <CheckCircle size={22} color="#16A34A" />
                  <Text style={{ fontSize: 16, fontWeight: '700', color: '#16A34A' }}>Lesson Completed!</Text>
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
                label="Mark as Complete"
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
  );
}
