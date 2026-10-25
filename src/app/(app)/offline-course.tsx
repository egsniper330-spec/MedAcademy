/**
 * Course Offline Details — the per-course lesson list of the Offline Library.
 *
 * LOOK & FEEL (P2/P3): structured like the NORMAL MedAcademy course screen —
 * a course header with the SAME circular course image the online course uses,
 * name + honest metadata, Videos/About tabs, then CHAPTER/SECTION groups with
 * individual video rows (thumbnail, safe title, duration, downloaded state).
 * The student feels they opened the normal course page — except playback is
 * offline/DRM-backed. No invented data: only MedAcademy metadata persisted at
 * authorize time and official SDK state.
 *
 * TITLE/ID HYGIENE (P4): every rendered title passes safeDisplayTitle(); raw
 * VdoCipher filenames, mediaIds and internal ids can never reach the screen.
 * Watermark identity comes from the ONE shared resolver (public MED-#### id
 * only — never the internal DB user UUID).
 *
 * SECURITY: unchanged — lives inside (app)/ under the authoritative gate;
 * playback re-validates via checkBeforeVideo and the live blocksVideo gate
 * closes the player if a blocking finding appears mid-playback.
 *
 * PARITY: identical on Android + iOS; byte counts render on Android only
 * (official SDK field), never faked on iOS.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, LayoutAnimation, Platform, Pressable,
  ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowDownToLine, ArrowLeft, Check, ChevronLeft, DownloadCloud, Folder, Info, Pause, Play,
  RefreshCw, Trash2, TriangleAlert, X,
} from 'lucide-react-native';
import { useColorScheme } from 'react-native';
import { neuColors, useNeuSpacing, spacing, safeBottom, neuMicroStyle, neuFlatStyle } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';
import { useSession } from '@/ctx';
import { useProfileStore } from '@/lib/store';
import {
  deleteOfflineVideo,
  exportOfflineCourseGroups,
  hydrateOfflineLibrary,
  isOfflineVideoExpired,
  pauseOfflineVideo,
  resumeOfflineVideo,
  retryOfflineVideo,
  safeDisplayTitle,
  subscribeOfflineVideos,
  type OfflineVideoEntry,
} from '@/lib/offlineVideoService';
import { OfflineVideoPlayer } from '@/components/OfflineVideoPlayer';
import { resolveWatermarkIdentity } from '@/lib/watermarkIdentity';
import { useSecurity } from '@/lib/SecurityContext';
import { useTranslation } from '@/lib/i18n';

/** Translator signature (resolved at render, never at module load). */
type Translate = (key: string, params?: Record<string, string | number>) => string;

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

// LOCALIZED (was hardcoded English): the copy now follows the app language.
function fmtExpiry(iso: string, tr: Translate): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const days = Math.floor((at - Date.now()) / 86_400_000);
  if (days <= 0) return tr('offline.expiresToday');
  if (days === 1) return tr('offline.expiresInOneDay');
  return tr('offline.expiresInDays', { days });
}

function fmtDuration(sec: number | null): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Tasteful initials fallback for courses without an image. */
function courseInitials(name: string): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (!words.length) return 'MV';
  return words.map((w) => w[0]?.toUpperCase() ?? '').join('') || 'MV';
}

/**
 * Circular course avatar with honest failure handling (same as the library
 * screen): a dead/missing image degrades to the initials fallback instead of
 * a permanently blank circle.
 */
function CourseAvatar({ uri, fallbackInitial, fallbackColor }: {
  uri: string;
  fallbackInitial: string;
  fallbackColor: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={[styles.courseAvatar, styles.courseAvatarFallback]}>
        <Text style={[styles.courseAvatarInitial, { color: fallbackColor }]}>{fallbackInitial}</Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri }}
      style={styles.courseAvatar}
      resizeMode="cover"
      onError={() => setFailed(true)}
    />
  );
}

/** Localized per-phase label (these were hardcoded English literals). */
function stateLabel(phase: OfflineVideoEntry['phase'], tr: Translate): string {
  switch (phase) {
    case 'authorizing':  return tr('offlineCourse.phasePreparing');
    case 'pending':      return tr('offlineCourse.phaseQueued');
    case 'processing':   return tr('offlineCourse.phaseProcessing');
    case 'paused':       return tr('offlineCourse.phasePaused');
    case 'downloading':  return tr('offlineCourse.phaseDownloading');
    case 'completed':    return tr('offlineCourse.phaseCompleted');
    case 'failed':
    default:             return tr('offlineCourse.phaseFailed');
  }
}

export default function OfflineCourseScreen() {
  return (
    <DrawerProvider>
      <View style={{ flex: 1 }}>
        <OfflineCourseContent />
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}

function OfflineCourseContent() {
  // Every visible string on this screen goes through the shared dictionaries.
  const { t, tCount } = useTranslation();
  const router = useRouter();
  const sp = useNeuSpacing();
  const { courseId } = useLocalSearchParams<{ courseId: string }>();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = isDark ? neuColors.dark : neuColors.light;
  const insets = useSafeAreaInsets();
  const { profile } = useProfileStore();
  const { session } = useSession();
  // WATERMARK IDENTITY — one authoritative resolution (shared resolver;
  // public MED-#### only, never the internal DB id; stable per session).
  const wmIdentity = useMemo(() => resolveWatermarkIdentity(profile), [profile]);
  // Live authoritative verdict — closes the player when a blocking finding
  // appears mid-playback (mirrors the online player's gate mirror).
  const { blocksVideo, checkBeforeVideo, securityLockHard } = useSecurity();

  const [entries, setEntries] = useState<OfflineVideoEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<OfflineVideoEntry | null>(null);
  const [tab, setTab] = useState<'videos' | 'about'>('videos');

  useEffect(() => {
    let mounted = true;
    const userId = session?.user?.id;
    if (!userId) return;
    void hydrateOfflineLibrary(userId).then((list) => {
      if (mounted) { setEntries(list); setLoading(false); }
    });
    const unsub = subscribeOfflineVideos((list) => { if (mounted) setEntries(list); });
    return () => { mounted = false; unsub(); };
  }, [profile?.id]);

  const group = useMemo(() => {
    const groups = exportOfflineCourseGroups(entries);
    return groups.find((g) => g.courseId === courseId) ?? groups[0] ?? null;
  }, [entries, courseId]);

  // Chapter/section grouping from MedAcademy metadata persisted at authorize
  // time. Entries without a section title fall under a single untitled group.
  const chapters = useMemo(() => {
    if (!group) return [];
    const bySection = new Map<string, OfflineVideoEntry[]>();
    for (const e of group.lessons) {
      const key = e.meta.sectionTitle?.trim() || t('offlineCourse.sectionFallback');
      const list = bySection.get(key);
      if (list) list.push(e);
      else bySection.set(key, [e]);
    }
    return [...bySection.entries()].map(([title, lessons]) => ({ title, lessons }));
  }, [group, t]);

  useEffect(() => {
    // The security lock is the authoritative stop for ANY block (a VPN raises
    // `block_login`, which never set blocksVideo) — the offline player must not
    // survive behind the gate either.
    if (playing && (blocksVideo || securityLockHard)) setPlaying(null);
  }, [playing, blocksVideo, securityLockHard]);

  const confirmDelete = useCallback((e: OfflineVideoEntry) => {
    Alert.alert(
      t('offlineLibrary.deleteTitle'),
      t('offlineLibrary.deleteBody', { title: safeDisplayTitle(e.meta) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            void deleteOfflineVideo(e.meta.mediaId);
          },
        },
      ]
    );
  }, [t]);

  const startPlayback = useCallback((e: OfflineVideoEntry) => {
    if (isOfflineVideoExpired(e)) {
      Alert.alert(t('offlineCourse.expiredTitle'), t('offlineCourse.expiredBody'));
      return;
    }
    setPlaying(e);
  }, [t]);

  if (playing) {
    const playTitle = safeDisplayTitle(playing.meta);
    return (
      <View style={[styles.root, { backgroundColor: colors.base }]}>
        {/* WATCH-SCREEN HEADER — SafeArea-aware (see offline-library): back
            arrow and title always clear the status bar / notch; no fixed
            offsets. Integrated ← (no ✕/"Close" text). */}
      <View style={[styles.playerHeader, { paddingTop: Math.max(insets.top, 8) + 6 }]}>
          <Pressable onPress={() => setPlaying(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('offlineCourse.backToCourse')}>
            <ArrowLeft size={22} color={colors.text} opacity={0.75} />
          </Pressable>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15, flex: 1, marginLeft: 10 }} numberOfLines={1}>
            {playTitle}
          </Text>
        </View>
        <OfflineVideoPlayer
          key={`offline-course-play-${playing.meta.mediaId}-${wmIdentity?.id ?? 'noid'}`}
          entry={playing}
          watermarkId={wmIdentity?.id}
          watermarkName={wmIdentity?.name ?? undefined}
          shouldAllowPlayback={async () => !(await checkBeforeVideo())}
          fullscreenVerdictNow={() => !blocksVideo && !securityLockHard}
          onClose={() => setPlaying(null)}
        />
        <View style={{ padding: 16 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>{playTitle}</Text>
          {!!group && (
            <Text style={{ color: colors.text, opacity: 0.55, fontSize: 13, marginTop: 4 }}>{group.courseName}</Text>
          )}
        </View>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: colors.base }]}>
        <PageHeader title={t('offlineCourse.title')} showBack />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </View>
    );
  }

  if (!group) {
    return (
      <View style={[styles.root, { backgroundColor: colors.base }]}>
        <PageHeader title={t('offlineCourse.title')} showBack />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <DownloadCloud size={40} color={colors.text} style={{ opacity: 0.4 }} />
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16, marginTop: 12 }}>{t('offlineCourse.emptyTitle')}</Text>
          <Text style={{ color: colors.text, opacity: 0.55, fontSize: 13, textAlign: 'center', marginTop: 6 }}>
            {t('offlineCourse.emptyBody')}
          </Text>
        </View>
      </View>
    );
  }

  const courseImg = group.courseImage;
  const expiries = group.lessons
    .map((e) => Date.parse(e.meta.expiresAt))
    .filter((t) => Number.isFinite(t));
  const expiryLine = expiries.length
    ? fmtExpiry(new Date(Math.min(...expiries)).toISOString(), t)
    : null;
  const completedCount = group.completedCount;
  const totalDurationSec = group.lessons
    .filter((e) => e.phase === 'completed')
    .reduce((acc, e) => acc + (e.meta.durationSec ?? 0), 0);

  return (
    <View style={[styles.root, { backgroundColor: colors.base }]}>
      <PageHeader
        title={group.courseName}
        showBack
        subtitle={`${tCount('offlineCourse.downloadedCount', completedCount)}${group.activeCount > 0 ? t('offlineCourse.inProgress', { count: group.activeCount }) : ''}`}
      />

      <ScrollView contentContainerStyle={{ paddingBottom: safeBottom(0, spacing.xxl) }}>
        {/* ── COURSE HEADER — mirrors the normal course screen ─────────────── */}
        <View style={[styles.courseHeader, { paddingHorizontal: sp.screenPx }]}>
          <View style={styles.courseAvatarWrap}>
            {courseImg ? (
              <CourseAvatar
                uri={courseImg}
                fallbackInitial={courseInitials(group.courseName)}
                fallbackColor={colors.primary}
              />
            ) : (
              <View style={[styles.courseAvatar, styles.courseAvatarFallback]}>
                <Text style={[styles.courseAvatarInitial, { color: colors.primary }]}>
                  {courseInitials(group.courseName)}
                </Text>
              </View>
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 19 }} numberOfLines={2}>
              {group.courseName}
            </Text>
            <Text style={{ color: colors.text, opacity: 0.55, fontSize: 13, marginTop: 3 }} numberOfLines={1}>
              {tCount('offlineCourse.downloadedCount', completedCount)}
              {!!expiryLine ? ` · ${expiryLine}` : ''}
            </Text>
            {totalDurationSec > 0 && (
              <Text style={{ color: colors.text, opacity: 0.45, fontSize: 12, marginTop: 2 }}>
                {t('offlineCourse.totalWatchTime', { time: fmtDuration(totalDurationSec) })}
              </Text>
            )}
          </View>
        </View>

        {/* ── TABS — Videos / About, like the normal course page ───────────── */}
        <View style={[styles.tabsRow, { borderBottomColor: isDark ? '#ffffff14' : '#00000012' }]}>
          {/* NB: the map variable must NOT be named `t` — it would shadow the
              translator and silently render the tab key instead of a label. */}
          {(['videos', 'about'] as const).map((tabKey) => (
            <Pressable
              key={tabKey}
              onPress={() => setTab(tabKey)}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === tabKey }}
              style={styles.tabBtn}
            >
              <Text style={{
                color: tab === tabKey ? colors.primary : colors.text,
                opacity: tab === tabKey ? 1 : 0.5,
                fontWeight: tab === tabKey ? '800' : '600',
                fontSize: 14,
              }}>
                {tabKey === 'videos' ? t('offlineCourse.tabVideos') : t('offlineCourse.tabAbout')}
              </Text>
              {tab === tabKey && <View style={[styles.tabUnderline, { backgroundColor: colors.primary }]} />}
            </Pressable>
          ))}
        </View>

        {tab === 'videos' ? (
          <View style={{ paddingHorizontal: sp.screenPx }}>
            {chapters.map((chapter) => (
              <View key={chapter.title} style={{ marginTop: spacing.md }}>
                {/* CHAPTER / SECTION group — like the online course structure */}
                <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15.5 }}>
                  {chapter.title}
                </Text>
                <Text style={{ color: colors.text, opacity: 0.45, fontSize: 12, marginTop: 1, marginBottom: 8 }}>
                  {tCount('offlineCourse.videoCount', chapter.lessons.length)}
                </Text>
                {chapter.lessons.map((e) => {
                  const expired = isOfflineVideoExpired(e);
                  const playable = e.phase === 'completed' && !expired;
                  const title = safeDisplayTitle(e.meta);
                  const thumb = e.meta.lessonThumbnailUrl ?? null;
                  const sizeLabel = Platform.OS === 'android' ? fmtBytes(e.totalSizeBytes ?? e.bytesDownloaded) : '';
                  const stateColor = expired
                    ? '#FFB020'
                    : e.phase === 'failed'
                      ? '#FF5A5A'
                      : e.phase === 'completed'
                        ? '#22C55E'
                        : colors.primary;
                  return (
                    <View key={e.meta.mediaId} style={[styles.card, neuFlatStyle(isDark)]}>
                      <Pressable
                        onPress={() => (playable ? startPlayback(e) : undefined)}
                        style={{ flexDirection: 'row', flex: 1, gap: 12, alignItems: 'center', minWidth: 0 }}
                        accessibilityRole={playable ? 'button' : 'none'}
                        accessibilityLabel={playable ? `${t('offlineCourse.play')} ${title}` : title}
                      >
                        <View style={styles.thumbWrap}>
                          {thumb ? (
                            <Image source={{ uri: thumb }} style={styles.thumb} resizeMode="cover" />
                          ) : (
                            <View style={[styles.thumb, styles.thumbFallback]}>
                              <Play size={16} color={colors.text} style={{ opacity: 0.4 }} />
                            </View>
                          )}
                          {playable && (
                            <View style={styles.playBadge}>
                              <Play size={11} color="#fff" />
                            </View>
                          )}
                        </View>
                        <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14.5 }} numberOfLines={2}>{title}</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                            {!!fmtDuration(e.meta.durationSec) && (
                              <Text style={{ color: colors.text, opacity: 0.5, fontSize: 11.5 }}>
                                {fmtDuration(e.meta.durationSec)}
                              </Text>
                            )}
                            {expired ? (
                              <X size={11} color={stateColor} />
                            ) : e.phase === 'completed' ? (
                              <Check size={11} color={stateColor} />
                            ) : e.phase === 'failed' ? (
                              <TriangleAlert size={11} color={stateColor} />
                            ) : (
                              <ArrowDownToLine size={11} color={stateColor} />
                            )}
                            <Text style={{ color: stateColor, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                              {expired ? t('offlineCourse.expired') : stateLabel(e.phase, t)}
                            </Text>
                            {e.phase === 'downloading' && (
                              <Text style={{ color: colors.text, opacity: 0.5, fontSize: 11 }}>{Math.round(e.progress)}%</Text>
                            )}
                            {!!sizeLabel && e.phase !== 'completed' && (
                              <Text style={{ color: colors.text, opacity: 0.35, fontSize: 11 }}>{sizeLabel}</Text>
                            )}
                          </View>
                          {e.phase === 'downloading' && (
                            <View style={[styles.progressTrack, { backgroundColor: isDark ? '#ffffff22' : '#00000014', marginTop: 7 }]}>
                              <View style={[styles.progressFill, { width: `${Math.max(3, Math.min(100, e.progress))}%` }]} />
                            </View>
                          )}
                          {!!e.lastError && e.phase === 'failed' && (
                            <Text style={{ color: '#FF5A5A', fontSize: 11, marginTop: 4 }} numberOfLines={2}>{e.lastError}</Text>
                          )}
                          {playable && fmtExpiry(e.meta.expiresAt, t) && (
                            <Text style={{ color: colors.text, opacity: 0.4, fontSize: 11, marginTop: 4 }}>{fmtExpiry(e.meta.expiresAt, t)}</Text>
                          )}
                        </View>
                      </Pressable>

                      <View style={{ alignItems: 'flex-end', gap: 8 }}>
                        {e.phase === 'downloading' && (
                          <Pressable onPress={() => void pauseOfflineVideo(e.meta.mediaId)} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={`${t('offlineCourse.pause')} ${title}`}>
                            <Pause size={16} color={colors.text} />
                          </Pressable>
                        )}
                        {(e.phase === 'pending' || e.phase === 'authorizing') && (
                          <Pressable onPress={() => void resumeOfflineVideo(e.meta.mediaId)} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={`${t('offlineCourse.resume')} ${title}`}>
                            <Play size={16} color={colors.text} />
                          </Pressable>
                        )}
                        {e.phase === 'failed' && (
                          <Pressable onPress={() => void retryOfflineVideo(e.meta.mediaId)} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={`${t('common.retry')} ${title}`}>
                            <RefreshCw size={16} color={colors.text} />
                          </Pressable>
                        )}
                        <Pressable onPress={() => confirmDelete(e)} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={`${t('offlineCourse.delete')} ${title}`}>
                          <Trash2 size={16} color="#FF5A5A" />
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
        ) : (
          /* ── ABOUT TAB — honest offline metadata only ────────────────────── */
          <View style={{ paddingHorizontal: sp.screenPx, marginTop: spacing.md, gap: spacing.md }}>
            <View style={[styles.aboutCard, neuFlatStyle(isDark)]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Info size={16} color={colors.primary} />
                <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14.5 }}>{t('offlineCourse.aboutTitle')}</Text>
              </View>
              <Text style={{ color: colors.text, opacity: 0.65, fontSize: 13, lineHeight: 20, marginTop: 8 }}>
                {t('offlineCourse.aboutBody', {
                  count: completedCount,
                  course: group.courseName,
                  // The expiry clause is appended as a localized fragment; the
                  // English "expires " stripping hack is gone (it broke Arabic).
                  expiry: expiryLine ? ` — ${expiryLine}` : '',
                })}
              </Text>
              <View style={[styles.aboutRow, { borderTopColor: isDark ? '#ffffff14' : '#00000010' }]}>
                <Folder size={14} color={`${colors.text}66`} />
                <Text style={{ color: colors.text, opacity: 0.6, fontSize: 12.5, flex: 1 }}>
                  {group.progressPercent >= 100
                    ? t('offlineCourse.allReady', { count: completedCount })
                    : t('offlineCourse.onlyDownloaded')}
                </Text>
                {group.progressPercent >= 100 && (
                  <Text style={{ color: '#16A34A', fontWeight: '800', fontSize: 12.5 }}>100%</Text>
                )}
              </View>
              <View style={[styles.aboutRow, { borderTopColor: isDark ? '#ffffff14' : '#00000010' }]}>
                <DownloadCloud size={14} color={`${colors.text}66`} />
                <Text style={{ color: colors.text, opacity: 0.6, fontSize: 12.5, flex: 1 }}>
                  {t('offlineCourse.deleteSafe')}
                </Text>
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  playerHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 10 },
  courseHeader: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: spacing.md, paddingBottom: spacing.md },
  courseAvatarWrap: { width: 64, height: 64, borderRadius: 32, overflow: 'hidden', backgroundColor: '#00000010' },
  courseAvatar: { width: '100%', height: '100%', borderRadius: 32 },
  courseAvatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#1E90FF18' },
  courseAvatarInitial: { fontSize: 22, fontWeight: '800', letterSpacing: 0.5 },
  tabsRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.md },
  tabBtn: { paddingHorizontal: spacing.md, paddingVertical: 11, alignItems: 'center' },
  tabUnderline: { position: 'absolute', bottom: 0, left: spacing.md, right: spacing.md, height: 2.5, borderRadius: 2 },
  card: { borderRadius: 16, padding: 12, marginBottom: spacing.sm, flexDirection: 'row', gap: 4, alignItems: 'center' },
  thumbWrap: { width: 92, height: 56, borderRadius: 10, overflow: 'hidden', backgroundColor: '#00000010', position: 'relative' },
  thumb: { width: '100%', height: '100%' },
  thumbFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#1E90FF14' },
  playBadge: { position: 'absolute', right: 4, bottom: 4, width: 20, height: 20, borderRadius: 10, backgroundColor: '#1E90FFE6', alignItems: 'center', justifyContent: 'center' },
  progressTrack: { height: 5, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 5, borderRadius: 3, backgroundColor: '#1E90FF' },
  iconBtn: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#8080801A' },
  aboutCard: { borderRadius: 16, padding: 16 },
  aboutRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
