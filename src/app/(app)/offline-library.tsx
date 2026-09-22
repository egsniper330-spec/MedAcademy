/**
 * Offline Library — the single Downloads section inside MedAcademy.
 *
 * APP SHELL (real-device fix): rendered with the SAME shell as every other
 * authenticated screen — PageHeader (hamburger via DrawerContext) + DrawerNav
 * inside a DrawerProvider, exactly like notifications.tsx. The drawer works
 * online, offline, after cold launch, after restart, and after background.
 *
 * LAYOUT (real-device clipping fix): no negative margins, no fixed widths,
 * no absolute offsets — screen padding comes from the responsive design
 * system (useNeuSpacing().screenPx + inset-safe left/right), content is
 * width:"100%" inside the padded container, and the scroll area respects
 * Safe Area → Header → Content → Bottom Safe Area.
 *
 * VISUAL PASS: elevated NeuCards, real thumbnails (or token-based fallback),
 * typography hierarchy via the design system, a dedicated "Downloading"
 * section with per-lesson progress (Android bytes / iOS percent only —
 * official SDK values, never invented), and "Downloaded Courses" cards.
 *
 * SECURITY: unchanged — lives inside (app)/ under the authoritative gate;
 * playback re-validates via checkBeforeVideo and the live blocksVideo mirror
 * closes the player if a blocking finding appears mid-playback.
 *
 * TITLE HYGIENE: every rendered title passes safeDisplayTitle(); raw
 * VdoCipher filenames/mediaIds can never reach the screen.
 *
 * PARITY: one shared RN surface for Android + iOS. Byte counts render on
 * Android only (official SDK fields); iOS shows percent/state — never faked.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, LayoutAnimation, Platform, Pressable,
  RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, BookOpen, CalendarClock, Check, DownloadCloud, Folder, Pause, Play, RefreshCw,
  Trash2, TriangleAlert, X,
} from 'lucide-react-native';
import { useColorScheme } from 'react-native';
import {
  neuColors, useNeuSpacing, spacing, radius, typography,
  safeBottom, neuMicroStyle, neuFlatStyle,
} from '@/lib/neu';
import { ConnectivityPill } from '@/components/ConnectivityPill';
import { useConnectivity } from '@/lib/offlineTransition';
import { useSession } from '@/ctx';
import { useProfileStore } from '@/lib/store';
import {
  deleteOfflineVideo,
  exportOfflineCourseGroups,
  getOfflineVideos,
  hydrateOfflineLibrary,
  isOfflineVideoExpired,
  pauseOfflineVideo,
  resyncOfflineLibrary,
  retryOfflineVideo,
  safeDisplayTitle,
  subscribeOfflineVideos,
  type OfflineVideoEntry,
} from '@/lib/offlineVideoService';
import { OfflineVideoPlayer } from '@/components/OfflineVideoPlayer';
import { resolveWatermarkIdentity } from '@/lib/watermarkIdentity';
import { useSecurity } from '@/lib/SecurityContext';
import { PageHeader } from '@/components/PageHeader';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';
import NetInfo from '@react-native-community/netinfo';

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function fmtExpiry(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((t - Date.now()) / 86_400_000);
  if (days <= 0) return 'Expires today';
  if (days === 1) return 'Expires in 1 day';
  return `Expires in ${days} days`;
}

/** Tasteful initials fallback for courses without an image ("Pharmacology" → "P"). */
function courseInitials(name: string): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (!words.length) return 'MV';
  return words.map((w) => w[0]?.toUpperCase() ?? '').join('') || 'MV';
}

export default function OfflineLibraryScreen() {
  return (
    <DrawerProvider>
      <View style={{ flex: 1 }}>
        <OfflineLibraryContent />
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}

function OfflineLibraryContent() {
  const router = useRouter();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = isDark ? neuColors.dark : neuColors.light;
  const sp = useNeuSpacing();
  const insets = useSafeAreaInsets();
  const online = useConnectivity();
  const { session } = useSession();
  const { profile } = useProfileStore();
  // Live authoritative verdict — closes the player when a blocking finding
  // appears mid-playback (mirrors the online player's gate mirror).
  const { blocksVideo, checkBeforeVideo } = useSecurity();

  // WATERMARK IDENTITY — one authoritative resolution per profile object.
  // Memoized on `profile` so the identity is stable for the whole playing
  // session; resolves to null when no SAFE public id exists (no overlay —
  // the online player's rule; never a UUID fallback).
  const wmIdentity = useMemo(() => resolveWatermarkIdentity(profile), [profile]);

  const [entries, setEntries] = useState<OfflineVideoEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<OfflineVideoEntry | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const userId = session?.user?.id ?? profile?.id;
    if (!userId) return;
    let mounted = true;
    void hydrateOfflineLibrary(userId).then((list) => {
      if (mounted) { setEntries(list); setLoading(false); }
    });
    const unsub = subscribeOfflineVideos((list) => { if (mounted) setEntries(list); });
    return () => { mounted = false; unsub(); };
  }, [profile?.id]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        try {
          const st = await NetInfo.fetch();
          if (alive && st.isConnected) void resyncOfflineLibrary();
        } catch { /* offline — local state is authoritative */ }
      })();
      return () => { alive = false; };
    }, [])
  );

  const { downloading, failed, courses } = useMemo(() => {
    const all = exportOfflineCourseGroups(entries);
    const dl: OfflineVideoEntry[] = [];
    const fl: OfflineVideoEntry[] = [];
    for (const g of all) {
      for (const e of g.lessons) {
        if (e.phase === 'downloading' || e.phase === 'pending' || e.phase === 'authorizing') dl.push(e);
        else if (e.phase === 'failed') fl.push(e);
      }
    }
    // Completed courses only (a course that is purely downloading does not
    // render as a "Downloaded Course" card).
    const done = all
      .map((g) => ({ ...g, lessons: g.lessons.filter((e) => e.phase === 'completed' && !isOfflineVideoExpired(e)) }))
      .filter((g) => g.lessons.length > 0);
    return { downloading: dl, failed: fl, courses: done };
  }, [entries]);

  // ── LIVE SECURITY ENFORCEMENT WHILE PLAYING ────────────────────────────────
  useEffect(() => {
    if (playing && blocksVideo) setPlaying(null);
  }, [playing, blocksVideo]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void (async () => {
      try {
        const st = await NetInfo.fetch();
        if (st.isConnected) await resyncOfflineLibrary();
      } catch { /* ignore */ }
      setRefreshing(false);
    })();
  }, []);

  const confirmDelete = useCallback((e: OfflineVideoEntry) => {
    Alert.alert(
      'Delete this offline video?',
      `“${safeDisplayTitle(e.meta)}” will be removed from this device. The online course is not affected — you can download it again while online.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            void deleteOfflineVideo(e.meta.mediaId);
          },
        },
      ]
    );
  }, []);

  const startPlayback = useCallback((e: OfflineVideoEntry) => {
    if (isOfflineVideoExpired(e)) {
      Alert.alert('Download expired', 'The offline license has expired. Reconnect and download again.');
      return;
    }
    setPlaying(e);
  }, []);

  const screenPad = [safeLeftPad(sp), sp.screenPx, safeRightPad(sp), 0] as const;

  if (playing) {
    const playTitle = safeDisplayTitle(playing.meta);
    return (
      <View style={[styles.root, { backgroundColor: colors.base }]}>
        {/* WATCH-SCREEN HEADER — SafeArea-aware: the status-bar/notch inset is
            added to the layout so the back control and title are NEVER pushed
            under the system bar or clipped by a cutout (device-reported issue).
            No fixed offsets — responsive on every device. Integrated ← arrow
            (no ✕/"Close" text) — same language as the app's headers. */}
        <View style={[styles.playerHeader, { paddingTop: Math.max(insets.top, 8) + 6, paddingHorizontal: sp.screenPx }]}>
          <Pressable onPress={() => setPlaying(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back to Offline Videos">
            <ArrowLeft size={22} color={colors.text} opacity={0.75} />
          </Pressable>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15, flex: 1, marginLeft: 10 }} numberOfLines={1}>
            {playTitle}
          </Text>
        </View>
        <OfflineVideoPlayer
          key={`offline-lib-${playing.meta.mediaId}-${wmIdentity?.id ?? 'noid'}`}
          entry={playing}
          // Watermark identity: the ONE shared resolver (public MED-#### only,
          // never the internal DB id) — identical to the online player.
          watermarkId={wmIdentity?.id}
          watermarkName={wmIdentity?.name ?? undefined}
          shouldAllowPlayback={async () => !(await checkBeforeVideo())}
          onClose={() => setPlaying(null)}
        />
        <View style={{ padding: sp.screenPx }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>{playTitle}</Text>
          {!!playing.meta.courseName && (
            <Text style={{ color: colors.text, opacity: 0.55, fontSize: 13, marginTop: 4 }}>{playing.meta.courseName}</Text>
          )}
          {fmtExpiry(playing.meta.expiresAt) && (
            <Text style={{ color: colors.text, opacity: 0.45, fontSize: 12, marginTop: 4 }}>{fmtExpiry(playing.meta.expiresAt)}</Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.base }]}>
      {/* Normal MedAcademy header: hamburger + title + connectivity pill */}
      <PageHeader
        title="Offline Videos"
        rightAction={<ConnectivityPill online={online} />}
      />

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingBottom: safeBottom(0, spacing.xxl),
            paddingHorizontal: 0,
          }}
          style={{ flex: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ paddingHorizontal: sp.screenPx }}>

            {/* ── DOWNLOADING section (real SDK state; debug-look removed) ── */}
            {downloading.length > 0 && (
              <View style={{ marginBottom: sp.sectionGap }}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Downloading</Text>
                {downloading.map((e) => {
                  const title = safeDisplayTitle(e.meta);
                  const bytesLabel = Platform.OS === 'android'
                    ? `${fmtBytes(e.bytesDownloaded)}${e.totalSizeBytes ? ` / ${fmtBytes(e.totalSizeBytes)}` : ''}`
                    : '';
                  return (
                    <View key={e.meta.mediaId} style={[styles.dlCard, neuFlatStyle(isDark), { borderRadius: sp.cardRadius }]}>
                      {!!e.meta.lessonThumbnailUrl && (
                        <Image source={{ uri: e.meta.lessonThumbnailUrl }} style={styles.dlThumb} resizeMode="cover" />
                      )}
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }} numberOfLines={2}>{title}</Text>
                        {!!e.meta.courseName && (
                          <Text style={{ color: colors.text, opacity: 0.5, fontSize: 12, marginTop: 1 }} numberOfLines={1}>{e.meta.courseName}</Text>
                        )}
                        <Text style={{ color: colors.primary, fontSize: 12.5, fontWeight: '700', marginTop: 6 }}>
                          {e.phase === 'pending' || e.phase === 'authorizing' ? 'Queued…' : `Downloading… ${Math.round(e.progress)}%`}
                        </Text>
                        <View style={[styles.progressTrack, { backgroundColor: isDark ? '#ffffff22' : '#00000014' }]}>
                          <View style={[styles.progressFill, { width: `${Math.max(e.phase === 'pending' ? 2 : 4, Math.min(100, e.progress))}%` }]} />
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: 8 }}>
                          <Text style={{ color: colors.text, opacity: 0.45, fontSize: 11 }} numberOfLines={1}>
                            {/* Android: official byte fields. iOS: percent only — never faked. */}
                            {bytesLabel || (e.phase === 'pending' ? 'Waiting for the download to start' : `${Math.round(e.progress)}%`)}
                          </Text>
                          <View style={{ flexDirection: 'row', gap: 8 }}>
                            {e.phase === 'downloading' && (
                              <Pressable
                                onPress={() => void pauseOfflineVideo(e.meta.mediaId)}
                                style={[styles.chip, { backgroundColor: `${colors.text}14` }]}
                                accessibilityRole="button"
                                accessibilityLabel={`Pause ${title}`}
                              >
                                <Pause size={13} color={colors.text} />
                                <Text style={{ color: colors.text, fontSize: 11.5, fontWeight: '700' }}>Pause</Text>
                              </Pressable>
                            )}
                            <Pressable
                              onPress={() => confirmDelete(e)}
                              style={[styles.chip, { backgroundColor: '#FF5A5A18' }]}
                              accessibilityRole="button"
                              accessibilityLabel={`Cancel ${title}`}
                            >
                              <X size={13} color="#FF5A5A" />
                              <Text style={{ color: '#FF5A5A', fontSize: 11.5, fontWeight: '700' }}>Cancel</Text>
                            </Pressable>
                          </View>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            {/* ── FAILED section (retry) ── */}
            {failed.length > 0 && (
              <View style={{ marginBottom: sp.sectionGap }}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Needs attention</Text>
                {failed.map((e) => {
                  const title = safeDisplayTitle(e.meta);
                  return (
                    <View key={e.meta.mediaId} style={[styles.dlCard, neuFlatStyle(isDark), { borderRadius: sp.cardRadius }]}>
                      <View style={[styles.failIcon, { backgroundColor: '#FF5A5A18' }]}>
                        <TriangleAlert size={18} color="#FF5A5A" />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }} numberOfLines={2}>{title}</Text>
                        <Text style={{ color: '#FF5A5A', fontSize: 11.5, marginTop: 3 }} numberOfLines={2}>
                          {e.lastError || 'Download failed'}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => void retryOfflineVideo(e.meta.mediaId)}
                        style={[styles.chip, { backgroundColor: '#1E90FF22' }]}
                        accessibilityRole="button"
                        accessibilityLabel={`Retry ${title}`}
                      >
                        <RefreshCw size={13} color="#1E90FF" />
                        <Text style={{ color: '#1E90FF', fontSize: 11.5, fontWeight: '800' }}>Retry</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            )}

            {/* ── DOWNLOADED COURSES ── */}
            {courses.length > 0 ? (
              <View>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Downloaded Courses</Text>
                {courses.map((g) => {
                  // Course image: the SAME MedAcademy course image the online
                  // course uses (persisted at authorize time). Lesson thumbnail
                  // is a secondary fallback; initials are the last resort.
                  const courseImg = g.courseImageUrl
                    ?? g.lessons.find((e) => !!e.meta.lessonThumbnailUrl)?.meta.lessonThumbnailUrl
                    ?? null;
                  const count = g.completedCount;
                  // Earliest rental expiry among this course's downloads.
                  const expiries = g.lessons
                    .map((e) => Date.parse(e.meta.expiresAt))
                    .filter((t) => Number.isFinite(t));
                  const expiryLine = expiries.length
                    ? fmtExpiry(new Date(Math.min(...expiries)).toISOString())
                    : null;
                  return (
                    <Pressable
                      key={g.courseId}
                      onPress={() => router.push({ pathname: '/offline-course', params: { courseId: g.courseId } })}
                      style={({ pressed }) => [
                        styles.courseCard,
                        neuFlatStyle(isDark),
                        { borderRadius: sp.cardRadius, opacity: pressed ? 0.93 : 1 },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`Open offline course ${g.courseName}`}
                    >
                      {/* CIRCULAR course image — same image as the online course */}
                      <View style={styles.courseAvatarWrap}>
                        {courseImg ? (
                          <Image source={{ uri: courseImg }} style={styles.courseAvatar} resizeMode="cover" />
                        ) : (
                          <View style={[styles.courseAvatar, styles.courseAvatarFallback]}>
                            <Text style={[styles.courseAvatarInitial, { color: colors.primary }]}>
                              {courseInitials(g.courseName)}
                            </Text>
                          </View>
                        )}
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        {/* courseName is MedAcademy's own metadata — never a VdoCipher name.
                            No chevron: the whole card is the tap target (Issue: the stray
                            mid-card arrow is removed at the root — nothing floats). */}
                        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }} numberOfLines={2}>
                          {g.courseName}
                        </Text>
                        <Text style={{ color: colors.text, opacity: 0.55, fontSize: 12.5, marginTop: 2 }} numberOfLines={1}>
                          {count} video{count === 1 ? '' : 's'} downloaded
                        </Text>
                        {!!expiryLine && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 }}>
                            <CalendarClock size={12} color={`${colors.text}66`} />
                            <Text style={{ color: colors.text, opacity: 0.45, fontSize: 11.5 }} numberOfLines={1}>
                              {expiryLine}
                            </Text>
                          </View>
                        )}
                        {/* Bottom metadata row — honest counts only: we can only
                            ever know what is actually on the device. */}
                        <View style={[styles.courseMetaRow, { borderTopColor: isDark ? '#ffffff14' : '#00000010' }]}>
                          <Folder size={13} color={`${colors.text}66`} />
                          <Text style={{ color: colors.text, opacity: 0.55, fontSize: 12, fontWeight: '600' }}>
                            {g.progressPercent >= 100
                              ? `${count}/${count} videos downloaded`
                              : `${count} video${count === 1 ? '' : 's'} downloaded`}
                          </Text>
                          {g.progressPercent >= 100 ? (
                            <Text style={{ color: '#16A34A', fontSize: 12, fontWeight: '800', marginLeft: 'auto' }}>
                              {g.progressPercent}%
                            </Text>
                          ) : (
                            <View style={[styles.miniTrack, { backgroundColor: isDark ? '#ffffff22' : '#00000014' }]}>
                              <View style={[styles.miniFill, { width: `${Math.max(4, Math.min(100, g.progressPercent))}%` }]} />
                            </View>
                          )}
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
                <Text style={{ color: colors.text, opacity: 0.35, fontSize: 11.5, textAlign: 'center', marginTop: spacing.lg }}>
                  Downloads stay on this device only. Deleting a download never affects the online course.
                </Text>
              </View>
            ) : downloading.length === 0 && failed.length === 0 ? (
              /* ── EMPTY STATE ── */
              <View style={[styles.emptyCard, neuFlatStyle(isDark), { borderRadius: sp.cardRadius }]}>
                <View style={[styles.emptyIconWrap, { backgroundColor: isDark ? '#ffffff14' : '#1E90FF18' }]}>
                  <DownloadCloud size={40} color={colors.primary} />
                </View>
                <Text style={[styles.emptyTitle, { color: colors.text }]}>No offline videos yet</Text>
                <Text style={[styles.emptyBody, { color: colors.text }]}>
                  Download your lectures to watch them without an internet connection.
                </Text>
                <Pressable
                  onPress={() => router.push('/my-courses')}
                  style={[styles.browseBtn, { backgroundColor: colors.primary }]}
                  accessibilityRole="button"
                  accessibilityLabel="Browse my courses"
                >
                  <BookOpen size={16} color={isDark ? '#071628' : '#FFFFFF'} />
                  <Text style={{ color: isDark ? '#071628' : '#FFFFFF', fontWeight: '800', fontSize: 14 }}>Browse My Courses</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

// Inset-aware horizontal padding (notch / display-cutout aware on both
// platforms) — never a hardcoded left offset.
function safeLeftPad(sp: ReturnType<typeof useNeuSpacing>): number {
  return sp.isTablet ? spacing.sm : 0;
}
function safeRightPad(sp: ReturnType<typeof useNeuSpacing>): number {
  return sp.isTablet ? spacing.sm : 0;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  sectionTitle: {
    fontSize: 13, fontWeight: '800', letterSpacing: 1.1, textTransform: 'uppercase',
    opacity: 0.45, marginBottom: spacing.sm, marginTop: spacing.sm,
  },
  dlCard: {
    flexDirection: 'row', gap: 12, padding: spacing.lg, marginBottom: spacing.md,
    alignItems: 'center',
  },
  dlThumb: { width: 76, height: 76, borderRadius: radius.md },
  failIcon: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  courseCard: {
    flexDirection: 'row', gap: 14, padding: spacing.lg, marginBottom: spacing.md,
    alignItems: 'center',
  },
  courseAvatarWrap: { width: 56, height: 56, borderRadius: 28, overflow: 'hidden', backgroundColor: '#00000010' },
  courseAvatar: { width: '100%', height: '100%', borderRadius: 28 },
  courseAvatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#1E90FF18' },
  courseAvatarInitial: { fontSize: 20, fontWeight: '800', letterSpacing: 0.5 },
  courseMetaRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 10, paddingTop: 9, borderTopWidth: StyleSheet.hairlineWidth,
  },
  miniTrack: { height: 4, borderRadius: 2, overflow: 'hidden', flex: 1, marginLeft: 8 },
  miniFill: { height: 4, borderRadius: 2, backgroundColor: '#1E90FF' },
  progressTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: '#1E90FF' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999 },
  emptyCard: { padding: spacing.xxl, marginTop: spacing.md, alignItems: 'center', gap: 12 },
  emptyIconWrap: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyTitle: { fontSize: 19, fontWeight: '800', textAlign: 'center' },
  emptyBody: { fontSize: 13.5, textAlign: 'center', lineHeight: 20, opacity: 0.65, maxWidth: 280 },
  browseBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 14, marginTop: 6 },
  playerHeader: { flexDirection: 'row', alignItems: 'center', paddingBottom: 10 },
});
