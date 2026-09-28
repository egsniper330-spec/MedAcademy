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
 * DESIGN (reference-matched): "DOWNLOADED COURSES" section — one clean card
 * per course (circular course image, title, optional subtle video count,
 * real completion progress bar with %, right chevron). No expiry/DRM/
 * technical noise on the card. Contextual empty space below the cards
 * ("No other downloaded courses" / true-empty state) with a soft cloud-
 * folder illustration. Dark mode is a first-class surface (elevated dark
 * cards, adapted illustration), not an inversion.
 *
 * SECURITY: unchanged — lives inside (app)/ under the authoritative gate;
 * playback re-validates via checkBeforeVideo and the live blocksVideo mirror
 * closes the player if a blocking finding appears mid-playback. Additionally
 * (entitlement): while ONLINE, a refresh revalidates course access against
 * the authoritative backend and deletes downloads for revoked courses —
 * network failures NEVER delete (fail-open, see offlineEntitlement.ts).
 *
 * TITLE HYGIENE: every rendered title passes safeDisplayTitle(); raw
 * VdoCipher filenames/mediaIds can never reach the screen.
 *
 * PARITY: one shared RN surface for Android + iOS.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, LayoutAnimation, Platform, Pressable,
  RefreshControl, ScrollView, StyleSheet, Text, View, useColorScheme,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, ChevronRight, Pause, Play, RefreshCw,
  TriangleAlert, X,
} from 'lucide-react-native';
import {
  neuColors, useNeuSpacing, spacing, radius,
  safeBottom, neuFlatStyle,
} from '@/lib/neu';
import { ConnectivityPill } from '@/components/ConnectivityPill';
import { useConnectivity } from '@/lib/offlineTransition';
import { useSession } from '@/ctx';
import { useProfileStore } from '@/lib/store';
import {
  deleteOfflineVideo,
  exportOfflineCourseGroups,
  hydrateOfflineLibrary,
  isOfflineVideoExpired,
  pauseOfflineVideo,
  resyncOfflineLibrary,
  retryOfflineVideo,
  safeDisplayTitle,
  subscribeOfflineVideos,
  type OfflineVideoEntry,
} from '@/lib/offlineVideoService';
import { revalidateOfflineEntitlements } from '@/lib/offlineEntitlement';
import { OfflineVideoPlayer } from '@/components/OfflineVideoPlayer';
import { resolveWatermarkIdentity } from '@/lib/watermarkIdentity';
import { useSecurity } from '@/lib/SecurityContext';
import { PageHeader } from '@/components/PageHeader';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';
import NetInfo from '@react-native-community/netinfo';

/** Muted secondary text for both themes (gray-blue in light, steel-blue in dark). */
const MUTED = { light: '#5A6B85', dark: '#8FA3BD' } as const;

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

/** Relative rental-expiry line — used ONLY on the player screen (never on the course cards). */
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
  const colors = {
    ...(isDark ? neuColors.dark : neuColors.light),
    textMuted: isDark ? MUTED.dark : MUTED.light,
  };
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

  // One authoritative account id for hydration + revalidation (account-switch
  // safe: the id string is the dep, not the profile object identity).
  const userId = session?.user?.id ?? profile?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    let mounted = true;
    void hydrateOfflineLibrary(userId).then((list) => {
      if (mounted) { setEntries(list); setLoading(false); }
    });
    const unsub = subscribeOfflineVideos((list) => { if (mounted) setEntries(list); });
    return () => { mounted = false; unsub(); };
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        try {
          const st = await NetInfo.fetch();
          if (alive && st.isConnected) {
            // Metadata reconciliation first (authoritative DRM registry),
            // then entitlement revalidation (authoritative access state).
            // Deletion happens ONLY on an authoritative verdict — a network
            // failure deletes nothing (fail-open).
            void resyncOfflineLibrary();
            const uid = userId;
            if (uid) {
              void revalidateOfflineEntitlements({ userId: uid, role: profile?.role });
            }
          }
        } catch { /* offline — local state is authoritative */ }
      })();
      return () => { alive = false; };
    }, [userId, profile?.role])
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
        if (st.isConnected) {
          await resyncOfflineLibrary();
          const uid = userId;
          if (uid) {
            await revalidateOfflineEntitlements({ userId: uid, role: profile?.role });
          }
        }
      } catch { /* ignore — fail-open by contract */ }
      setRefreshing(false);
    })();
  }, [userId, profile?.role]);

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

  // Empty-space copy: contextual when downloads exist, true-empty otherwise.
  const hasDownloads = courses.length > 0 || downloading.length > 0 || failed.length > 0;
  const emptyTitle = hasDownloads ? 'No other downloaded courses' : 'No downloaded courses';
  const emptyBody = hasDownloads
    ? `You currently have ${courses.length} downloaded course${courses.length === 1 ? '' : 's'}.\nAny additional downloaded courses will appear here.`
    : 'Downloaded videos will appear here for quick offline access.';

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
                <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>DOWNLOADING</Text>
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
                          <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 1 }} numberOfLines={1}>{e.meta.courseName}</Text>
                        )}
                        <Text style={{ color: colors.primary, fontSize: 12.5, fontWeight: '700', marginTop: 6 }}>
                          {e.phase === 'pending' || e.phase === 'authorizing' ? 'Queued…' : `Downloading… ${Math.round(e.progress)}%`}
                        </Text>
                        <View style={[styles.progressTrack, { backgroundColor: isDark ? '#ffffff1f' : '#1E90FF1a' }]}>
                          <View style={[styles.progressFill, { width: `${Math.max(e.phase === 'pending' ? 2 : 4, Math.min(100, e.progress))}%` }]} />
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: 8 }}>
                          <Text style={{ color: colors.textMuted, fontSize: 11 }} numberOfLines={1}>
                            {/* Android: official byte fields. iOS: percent only — never faked. */}
                            {bytesLabel || (e.phase === 'pending' ? 'Waiting for the download to start' : `${Math.round(e.progress)}%`)}
                          </Text>
                          <View style={{ flexDirection: 'row', gap: 8 }}>
                            {e.phase === 'downloading' && (
                              <Pressable
                                onPress={() => void pauseOfflineVideo(e.meta.mediaId)}
                                style={[styles.chip, { backgroundColor: isDark ? '#ffffff14' : `${colors.text}0f` }]}
                                accessibilityRole="button"
                                accessibilityLabel={`Pause ${title}`}
                              >
                                <Pause size={13} color={colors.text} />
                                <Text style={{ color: colors.text, fontSize: 11.5, fontWeight: '700' }}>Pause</Text>
                              </Pressable>
                            )}
                            <Pressable
                              onPress={() => confirmDelete(e)}
                              style={[styles.chip, { backgroundColor: isDark ? '#FF5A5A22' : '#FF5A5A14' }]}
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
                <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>NEEDS ATTENTION</Text>
                {failed.map((e) => {
                  const title = safeDisplayTitle(e.meta);
                  return (
                    <View key={e.meta.mediaId} style={[styles.dlCard, neuFlatStyle(isDark), { borderRadius: sp.cardRadius }]}>
                      <View style={[styles.failIcon, { backgroundColor: isDark ? '#FF5A5A22' : '#FF5A5A14' }]}>
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
                        style={[styles.chip, { backgroundColor: isDark ? '#1E90FF26' : '#1E90FF1a' }]}
                        accessibilityRole="button"
                        accessibilityLabel={`Retry ${title}`}
                      >
                        <RefreshCw size={13} color={colors.primary} />
                        <Text style={{ color: colors.primary, fontSize: 11.5, fontWeight: '800' }}>Retry</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            )}

            {/* ── DOWNLOADED COURSES — reference-matched cards ── */}
            {courses.length > 0 && (
              <View>
                <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>DOWNLOADED COURSES</Text>
                {courses.map((g) => {
                  // Course image: the SAME MedAcademy course image the online
                  // course uses (persisted at authorize time). Lesson thumbnail
                  // is a secondary fallback; initials are the last resort.
                  const courseImg = g.courseImageUrl
                    ?? g.lessons.find((e) => !!e.meta.lessonThumbnailUrl)?.meta.lessonThumbnailUrl
                    ?? null;
                  const count = g.completedCount;
                  return (
                    <Pressable
                      key={g.courseId}
                      onPress={() => router.push({ pathname: '/offline-course', params: { courseId: g.courseId } })}
                      style={({ pressed }) => [
                        styles.courseCard,
                        neuFlatStyle(isDark),
                        { borderRadius: sp.cardRadius, opacity: pressed ? 0.95 : 1 },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`Open offline course ${g.courseName}`}
                    >
                      {/* LEFT: circular course image (same image as online) */}
                      <View style={[styles.courseAvatarWrap, { backgroundColor: isDark ? '#1E90FF26' : '#1E90FF14' }]}>
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

                      {/* RIGHT: grouped course header + progress */}
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                          <Text style={[styles.courseTitle, { color: colors.text }]} numberOfLines={2}>
                            {g.courseName}
                          </Text>
                          {/* Right chevron — subtle affordance, never competes */}
                          <View style={styles.chevronWrap}>
                            <ChevronRight size={18} color={isDark ? '#ffffff55' : '#0F2A5C33'} />
                          </View>
                        </View>
                        {/* Subtle count — only when genuinely useful. No
                            "1/1" redundancy; expiry/DRM noise never shown. */}
                        {count > 0 && (
                          <Text style={[styles.countLine, { color: colors.textMuted }]} numberOfLines={1}>
                            {count} video{count === 1 ? '' : 's'} downloaded
                          </Text>
                        )}
                        {/* REAL completion progress (reference design) — honest
                            value from the SDK/metadata; never decorative. */}
                        <View style={styles.progressRow}>
                          <View style={[styles.progressTrack, { backgroundColor: isDark ? '#ffffff1f' : '#1E90FF1a' }]}>
                            <View style={[styles.progressFill, { width: `${Math.max(count > 0 ? 6 : 0, Math.min(100, g.progressPercent))}%` }]} />
                          </View>
                          <Text style={[styles.progressPct, { color: colors.primary }]}>{g.progressPercent}%</Text>
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {/* ── EMPTY / LOW-DENSITY SPACE (reference illustration) ── */}
            {(!hasDownloads || courses.length > 0) && (
              <View style={styles.emptySpace}>
                <CloudFolderArt isDark={isDark} />
                <Text style={[styles.emptyTitle, { color: colors.text }]}>{emptyTitle}</Text>
                <Text style={[styles.emptyBody, { color: colors.textMuted }]}>{emptyBody}</Text>
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

/**
 * Soft cloud + folder + play illustration (pure vector — theme-adaptive,
 * scales with the design system, disappears on no screen).
 */
function CloudFolderArt({ isDark }: { isDark: boolean }) {
  const cloud = isDark ? '#20344d' : '#e8f0fb';
  const cloudDeep = isDark ? '#2a4162' : '#d7e6fa';
  const folder = isDark ? '#3f6ea8' : '#8ab6f0';
  const folderDark = isDark ? '#33598a' : '#6ea3ec';
  const play = isDark ? '#7db4f5' : '#3d8bff';
  return (
    <View style={styles.artWrap} pointerEvents="none" accessibilityLabel="No additional downloads illustration">
      <View style={[styles.artCloud, { backgroundColor: cloud }]} />
      <View style={[styles.artCloudDeep, { backgroundColor: cloudDeep }]} />
      <View style={[styles.artFolderBody, { backgroundColor: folder }]} />
      <View style={[styles.artFolderTab, { backgroundColor: folderDark }]} />
      <View style={styles.artPlay}>
        <Play size={16} color={play} fill={play} />
      </View>
      <View style={[styles.artSpark1, { backgroundColor: play }]} />
      <View style={[styles.artSpark2, { backgroundColor: play }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  sectionTitle: {
    fontSize: 13, fontWeight: '800', letterSpacing: 1.1, textTransform: 'uppercase',
    marginBottom: spacing.sm, marginTop: spacing.md,
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
  courseAvatarWrap: { width: 64, height: 64, borderRadius: 32, overflow: 'hidden' },
  courseAvatar: { width: '100%', height: '100%', borderRadius: 32 },
  courseAvatarFallback: { alignItems: 'center', justifyContent: 'center' },
  courseAvatarInitial: { fontSize: 22, fontWeight: '800', letterSpacing: 0.5 },
  courseTitle: { flex: 1, fontWeight: '800', fontSize: 16.5, letterSpacing: 0.1 },
  chevronWrap: { paddingTop: 2 },
  countLine: { fontSize: 12.5, marginTop: 3 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden', flex: 1 },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: '#1E90FF' },
  progressPct: { fontSize: 13.5, fontWeight: '800', minWidth: 44, textAlign: 'right' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999 },
  emptySpace: { alignItems: 'center', paddingTop: spacing.xl, paddingBottom: spacing.xxl },
  artWrap: { width: 190, height: 150, marginBottom: spacing.lg },
  artCloud: { position: 'absolute', width: 170, height: 110, borderRadius: 55, top: 20, left: 10 },
  artCloudDeep: { position: 'absolute', width: 120, height: 78, borderRadius: 39, top: 52, left: 38 },
  artFolderBody: {
    position: 'absolute', width: 84, height: 60, borderRadius: 10, top: 58, left: 56,
    transform: [{ rotate: '-6deg' }],
  },
  artFolderTab: {
    position: 'absolute', width: 34, height: 12, borderTopLeftRadius: 6, borderTopRightRadius: 6,
    top: 50, left: 58, transform: [{ rotate: '-6deg' }],
  },
  artPlay: {
    position: 'absolute', top: 76, left: 90, width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
  },
  artSpark1: { position: 'absolute', width: 3, height: 12, borderRadius: 2, top: 30, left: 96, transform: [{ rotate: '18deg' }] },
  artSpark2: { position: 'absolute', width: 3, height: 9, borderRadius: 2, top: 26, left: 110, transform: [{ rotate: '40deg' }] },
  emptyTitle: { fontSize: 19, fontWeight: '800', textAlign: 'center' },
  emptyBody: { fontSize: 13.5, textAlign: 'center', lineHeight: 21, marginTop: 8, maxWidth: 320 },
  playerHeader: { flexDirection: 'row', alignItems: 'center', paddingBottom: 10 },
});
