/**
 * offlineVideoService.ts
 *
 * ═══════════════════════════════════════════════════════════════════
 * SINGLE SOURCE OF TRUTH — VdoCipher OFFLINE DRM downloads (Android+iOS)
 * ═══════════════════════════════════════════════════════════════════
 *
 * Uses ONLY the official VdoCipher offline flow (vdocipher-rn-bridge 2.0.1,
 * VdoFramework 2.9.4 iOS / Widevine offline Android), per
 * https://www.vdocipher.com/docs/mobile/react-native/offline/ :
 *
 *   getOfflineDownloadToken()      → MedAcademy backend authorizes (auth +
 *                                    entitlement + security gates) and issues
 *                                    a DOWNLOAD otp/playbackInfo carrying a
 *                                    finite rental license (licenseValidty).
 *                                    The VdoCipher API secret never leaves the
 *                                    server.
 *   VdoDownload.getDownloadOptions({otp, playbackInfo})
 *   enqueue({selections})          → DRM-protected media lands in VdoCipher's
 *                                    private storage — never a clear MP4,
 *                                    never a custom container. `selections`
 *                                    are INDICES into availableTracks: exactly
 *                                    one video + one audio track (Android);
 *                                    video track only (iOS — official rule).
 *   VdoDownload.addEventListener   → official progress/complete/fail/deleted
 *                                    events (each call returns an unregister
 *                                    function).
 *   VdoDownload.query()            → restores/validates state after app
 *                                    restart — the SDK registry is the
 *                                    authority for what DRM media exists.
 *   VdoDownload.remove([mediaId])  → official delete (cancels in-flight,
 *                                    removes DRM files + license).
 *   VdoPlayerView embedInfo={offline:true, mediaId} → offline playback.
 *
 * WHAT WE PERSIST (AsyncStorage key: @medacademy/offline_videos_v1):
 *   ONLY metadata needed to reconstruct the Offline Library: lesson/course
 *   ids, title, mediaId, server-issued rental expiry, owner binding.
 *   NO filesystem paths, NO tokens at rest, NO clear media.
 *
 * PLATFORM PARITY (audited both sides of the official bridge):
 *   • Identical flow on both platforms — same bridge API.
 *   • iOS: video-track-only selection (official rule); Android also picks one
 *     audio track (official rule).
 *   • isExpired() is Android-only per official docs → BOTH platforms derive
 *     expiry from the server-issued `expiresAt` (single source of truth;
 *     DRM license enforcement remains authoritative at playback).
 *   • Android targetSdk 34+: app manifest already declares
 *     FOREGROUND_SERVICE_DATA_SYNC (official download requirement).
 *   • iOS debug-mode + Flipper breaks downloads (official note) — dev-only.
 *
 * SECURITY: nothing here relaxes any check; "offline" never means "trusted".
 * The Offline Library is served only after the same SecurityGate evaluation
 * as online content, and offline playback re-validates before mounting.
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import VdoDownload from 'vdocipher-rn-bridge/downloads';
import type { DownloadStatus, Track } from 'vdocipher-rn-bridge/type';
import { getOfflineDownloadToken } from './api';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OfflineDownloadPhase =
  | 'authorizing'   // backend offline-authorize in flight (transient)
  | 'pending'       // enqueued with VdoCipher, queued/starting/paused
  | 'downloading'
  | 'completed'
  | 'failed';

export interface OfflineVideoMeta {
  /** VdoCipher mediaId (authoritative DRM identifier) — never shown in UI */
  mediaId: string;
  lessonId: string;
  courseId: string | null;
  title: string;
  /** MedAcademy's own lesson title (UI uses safeDisplayTitle, never this raw) */
  lessonTitle: string;
  /** MedAcademy course title persisted at authorize time */
  courseName: string | null;
  /** MedAcademy course image (same image the online course uses) */
  courseImageUrl: string | null;
  /** MedAcademy chapter/section title persisted at authorize time */
  sectionTitle: string | null;
  /** MedAcademy lesson video thumbnail (postercard) captured at authorize time */
  lessonThumbnailUrl: string | null;
  /** Lesson ordering inside its section (for stable course-details sorting) */
  lessonOrder: number | null;
  /** Server-issued rental expiry (ISO) — finite licenses, never permanent */
  expiresAt: string;
  rentalHours: number;
  /** Epoch ms when the download was authorized */
  authorizedAt: number;
  /** Owner binding — metadata never crosses accounts */
  userId: string;
  durationSec: number | null;
  posterUrl: string | null;
}

export interface OfflineVideoEntry {
  meta: OfflineVideoMeta;
  phase: OfflineDownloadPhase;
  /** 0..100 — official DownloadStatus.downloadPercent */
  progress: number;
  /** Android only (official field) — 0 on iOS */
  bytesDownloaded: number;
  /** Android only (official field) — null on iOS */
  totalSizeBytes: number | null;
  /** Last failure reason (official reasonDescription or our message) */
  lastError: string | null;
  updatedAt: number;
}

// ─── Store (AsyncStorage-backed, process-wide cache) ─────────────────────────

const STORAGE_KEY = '@medacademy/offline_videos_v1';

type Listener = (entries: OfflineVideoEntry[]) => void;
const listeners = new Set<Listener>();
let cache: OfflineVideoEntry[] | null = null;
let hydrated = false;
let hydrating: Promise<void> | null = null;
// ── Cross-account raw store (account-isolation fix) ──────────────────────────
// The persisted store is SHARED across accounts on this device. `cache` is the
// CURRENT account's authoritative view; `rawStore` remembers every account's
// rows as last read from disk so persist() can merge the current view OVER the
// other accounts' rows instead of destroying them. Previously persist() wrote
// the filtered view alone, so the first hydration by account B permanently
// deleted account A's metadata rows (their DRM licenses remained but became
// unreachable) — a real isolation + data-loss bug.
let rawStore: OfflineVideoEntry[] = [];
let hydratedUserId: string | null = null;

function emit(): void {
  if (!cache) return;
  for (const l of listeners) {
    try { l([...cache]); } catch { /* listener errors never break the service */ }
  }
}

export function subscribeOfflineVideos(l: Listener): () => void {
  listeners.add(l);
  if (hydrated) l([...(cache ?? [])]);
  return () => { listeners.delete(l); };
}

export function getOfflineVideos(): OfflineVideoEntry[] {
  return [...(cache ?? [])];
}

// ─── Pure display/grouping helpers (unit-tested; no imports) ─────────────────

/**
 * VdoCipher media often arrives titled with the raw uploaded filename
 * (e.g. "2023_08_22_01_20_IMG_4574.MP4"). Such strings must NEVER surface in
 * the student-facing UI — the lesson screen already filters them with this
 * same heuristic before rendering, and the Offline Library re-applies it here
 * as the single source of truth for display titles.
 */
export function isInternalVideoTitle(name: string | null | undefined): boolean {
  if (!name) return true;
  const n = name.trim();
  if (!n) return true;
  if (/\.(mp4|mov|m4v|mpd|m3u8|mkv|webm)$/i.test(n)) return true; // raw media filenames
  if (/^\d{4}_\d{2}_\d{2}([_ T]\d{2}_\d{2})?\s*[-_]?\s*IMG[_-]?\d+\.(mp4|mov|jpg|jpeg|png)$/i.test(n)) return true;
  if (/^[a-f0-9]{16,}$/i.test(n.replace(/\s+/g, ''))) return true; // opaque hashes
  return false;
}

/**
 * The ONLY way a downloaded video's title is derived for display:
 * MedAcademy's own lesson title first, then the persisted title if it is a
 * real human title, then a safe generic label. A raw VdoCipher filename can
 * never reach the screen through this function.
 */
export function safeDisplayTitle(meta: {
  lessonTitle?: string | null;
  title?: string | null;
}): string {
  if (!isInternalVideoTitle(meta.lessonTitle)) return meta.lessonTitle!.trim();
  if (!isInternalVideoTitle(meta.title)) return meta.title!.trim();
  return 'Offline Video';
}

export interface OfflineCourseGroup {
  courseId: string;
  courseName: string;
  /** MedAcademy course image (the online course's own image when known) */
  courseImageUrl: string | null;
  lessons: OfflineVideoEntry[];
  completedCount: number;
  activeCount: number;
  failedCount: number;
  /** Overall 0..100 progress across this course's offline lessons */
  progressPercent: number;
}

/**
 * Groups the flat offline entries into course cards for the library.
 * Pure + deterministic: newest activity first, stable lesson order inside.
 * Only genuinely-downloaded lessons are counted — the UI never invents a
 * course total it cannot know ("3 videos downloaded", not "3 of 8").
 */
export function exportOfflineCourseGroups(entries: OfflineVideoEntry[]): OfflineCourseGroup[] {
  const byCourse = new Map<string, OfflineVideoEntry[]>();
  for (const e of entries) {
    const key = e.meta.courseId || '__nocourse__';
    const list = byCourse.get(key);
    if (list) list.push(e);
    else byCourse.set(key, [e]);
  }
  const groups: OfflineCourseGroup[] = [];
  for (const [courseId, lessons] of byCourse) {
    const ordered = [...lessons].sort((a, b) => {
      const oa = a.meta.lessonOrder ?? Number.MAX_SAFE_INTEGER;
      const ob = b.meta.lessonOrder ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return a.meta.lessonTitle.localeCompare(b.meta.lessonTitle);
    });
    const completedCount = ordered.filter((e) => e.phase === 'completed').length;
    const failedCount = ordered.filter((e) => e.phase === 'failed').length;
    const activeCount = ordered.filter((e) => e.phase === 'downloading' || e.phase === 'pending' || e.phase === 'authorizing').length;
    const progressSum = ordered.reduce((acc, e) => acc + (e.phase === 'completed' ? 100 : Math.max(0, Math.min(100, e.progress))), 0);
    groups.push({
      courseId,
      courseName: ordered.find((e) => !!e.meta.courseName)?.meta.courseName ?? 'My Downloads',
      courseImageUrl: ordered.find((e) => !!e.meta.courseImageUrl)?.meta.courseImageUrl ?? null,
      lessons: ordered,
      completedCount,
      activeCount,
      failedCount,
      progressPercent: ordered.length ? Math.round(progressSum / ordered.length) : 0,
    });
  }
  // Courses with anything in flight or failed first, then by newest activity.
  return groups.sort((a, b) => {
    const pri = (g: OfflineCourseGroup) => (g.activeCount > 0 ? 0 : g.failedCount > 0 ? 1 : 2);
    if (pri(a) !== pri(b)) return pri(a) - pri(b);
    const lastA = Math.max(...a.lessons.map((e) => e.updatedAt), 0);
    const lastB = Math.max(...b.lessons.map((e) => e.updatedAt), 0);
    return lastB - lastA;
  });
}

async function persist(): Promise<void> {
  // NEVER persist an unhydrated state: cache===null means we have not read the
  // store yet — writing [] here would wipe every account's rows (e.g. a
  // write-flow racing a slow hydration). Pre-hydration writers have nothing
  // authoritative to say.
  if (cache === null) return;
  try {
    // Merge: other accounts' rows preserved verbatim (their DRM licenses are
    // per-user; their metadata must survive this account's session), the
    // current account's rows replaced wholesale by `cache`.
    const others = rawStore.filter((e) => e?.meta?.userId !== hydratedUserId);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...others, ...cache]));
  } catch { /* storage full/corrupt → in-memory state stays valid this session */ }
}

/** Pure transition table — unit-tested (tests/offlineState.test.cjs). */
export function nextPhase(
  current: OfflineDownloadPhase,
  event: 'enqueued' | 'progress' | 'completed' | 'failed' | 'removed'
): OfflineDownloadPhase | null {
  switch (event) {
    case 'enqueued':  return 'pending';
    case 'progress':  return current === 'completed' ? 'completed' : 'downloading';
    case 'completed': return 'completed';
    case 'failed':    return current === 'completed' ? 'completed' : 'failed';
    case 'removed':   return null; // caller drops the row
  }
}

function applyEntry(next: OfflineVideoEntry): void {
  if (!cache) cache = [];
  const i = cache.findIndex((e) => e.meta.mediaId === next.meta.mediaId);
  if (i >= 0) cache[i] = next;
  else cache.push(next);
  emit();
  void persist();
}

function removeEntry(mediaId: string): void {
  if (!cache) return;
  const before = cache.length;
  cache = cache.filter((e) => e.meta.mediaId !== mediaId);
  if (cache.length !== before) {
    emit();
    void persist();
  }
}

/**
 * Hydrates the library after app restart:
 *   1. Load AsyncStorage metadata (owner-bound to this userId).
 *   2. Reconcile against the native VdoCipher registry via official query()
 *      — the SDK is the authority for what DRM media actually exists.
 *      Completed rows whose native media is gone are dropped (deleted via
 *      the SDK's own UI / OS cleanup). pending/failed rows are KEPT when
 *      absent (query may not report them) so retry remains possible.
 */
export async function hydrateOfflineLibrary(userId: string): Promise<OfflineVideoEntry[]> {
  if (hydrating) return hydrating.then(() => getOfflineVideos());
  if (hydrated) return getOfflineVideos();
  hydrating = (async () => {
    let stored: OfflineVideoEntry[] = [];
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) stored = parsed as OfflineVideoEntry[];
      }
    } catch { /* corrupt store → start empty; SDK reconciliation still applies */ }
    rawStore = stored; // cross-account raw rows (persist merges over these)
    hydratedUserId = userId;

    // Owner binding: a device that changed accounts never shows other
    // accounts' downloads (their DRM licenses are per-user anyway).
    const mine = stored.filter(
      (e) => e?.meta && typeof e.meta.mediaId === 'string' && e.meta.userId === userId
    );

    let nativeStatuses: DownloadStatus[] = [];
    try {
      nativeStatuses = await VdoDownload.query({ mediaId: [], status: [] });
    } catch { /* SDK unavailable → metadata-only mode this session */ }
    const nativeById = new Map(nativeStatuses.map((s) => [s.mediaInfo.mediaId, s]));

    const reconciled: OfflineVideoEntry[] = [];
    for (const e of mine) {
      const native = nativeById.get(e.meta.mediaId);
      if (!native) {
        // Completed but absent from the registry → the media was deleted
        // outside our UI. pending/failed rows are kept (retry-able).
        if (e.phase === 'completed') continue;
        reconciled.push({ ...e, updatedAt: Date.now() });
        continue;
      }
      reconciled.push({
        ...e,
        meta: {
          ...e.meta,
          posterUrl: native.poster || e.meta.posterUrl,
          durationSec: native.mediaInfo?.duration
            ? Math.round(native.mediaInfo.duration / 1000)
            : e.meta.durationSec,
        },
        phase: mapNativeStatus(native.status, e.phase),
        progress: typeof native.downloadPercent === 'number' ? native.downloadPercent : e.progress,
        bytesDownloaded: native.bytesDownloaded ?? e.bytesDownloaded,
        totalSizeBytes: native.totalSizeBytes ?? e.totalSizeBytes,
        updatedAt: Date.now(),
      });
    }

    cache = reconciled;
    hydrated = true;
    hydrating = null;
    await persist();
    emit();
  })();
  return hydrating.then(() => getOfflineVideos());
}

function mapNativeStatus(native: string, fallback: OfflineDownloadPhase): OfflineDownloadPhase {
  switch (native) {
    case 'completed':  return 'completed';
    case 'failed':     return 'failed';
    case 'downloading': return 'downloading';
    case 'pending':
    case 'paused':     return 'pending';
    default:           return fallback;
  }
}

// ─── Track selection (official rules) ─────────────────────────────────────────

/**
 * Returns selections (INDICES into availableTracks) per official docs:
 *   Android: exactly ONE video track + ONE audio track.
 *   iOS:     exactly ONE video track (no audio-track option).
 * Prefers the highest-bitrate video track; first audio track otherwise.
 */
export function selectDownloadTracks(availableTracks: Track[]): { selections: number[]; platform: 'android' | 'ios' } {
  const isAndroid = Platform.OS !== 'ios';
  let videoIdx = -1;
  let audioIdx = -1;
  let bestBitrate = -1;
  availableTracks.forEach((t, idx) => {
    if (t.type === 'video') {
      const br = typeof t.bitrate === 'number' ? t.bitrate : 0;
      if (br > bestBitrate) { bestBitrate = br; videoIdx = idx; }
      else if (videoIdx === -1) videoIdx = idx;
    } else if (isAndroid && t.type === 'audio' && audioIdx === -1) {
      audioIdx = idx;
    }
  });
  const selections = videoIdx >= 0 ? [videoIdx] : [];
  if (audioIdx >= 0) selections.push(audioIdx);
  return { selections, platform: isAndroid ? 'android' : 'ios' };
}

// ─── Download orchestration ───────────────────────────────────────────────────

export interface StartDownloadParams {
  userId: string;
  videoId: string;
  lessonId: string;
  courseId: string | null;
  courseName: string | null;
  /** MedAcademy course image — persisted for circular course thumbnails */
  courseImageUrl?: string | null;
  /** MedAcademy chapter/section title — persisted for offline course structure */
  sectionTitle?: string | null;
  title: string;
  /** MedAcademy's own lesson title — persisted for UI display */
  lessonTitle?: string;
  /** MedAcademy lesson video thumbnail — persisted for the library card */
  lessonThumbnailUrl?: string | null;
  /** Lesson ordering (order_index) — persisted for course-details sorting */
  lessonOrder?: number | null;
}

export type StartDownloadResult =
  | { ok: true; mediaId: string }
  | { ok: false; error: string; kind: 'auth' | 'options' | 'enqueue' };

/**
 * Full offline download flow for ONE lesson video:
 *   backend authorize → official getDownloadOptions → enqueue → live events.
 * Official VdoCipher API only; no custom download/encryption anywhere.
 */
export async function startOfflineDownload(p: StartDownloadParams): Promise<StartDownloadResult> {
  // 1) Backend authorization (auth + entitlement + security + rental license)
  let token: Awaited<ReturnType<typeof getOfflineDownloadToken>>;
  try {
    token = await getOfflineDownloadToken(p.videoId, p.lessonId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Authorization failed';
    return { ok: false, error: msg, kind: 'auth' };
  }

  // 2) Official options fetch — the SDK exchanges our OTP with VdoCipher
  let optionsResult: Awaited<ReturnType<typeof VdoDownload.getDownloadOptions>>;
  try {
    optionsResult = await VdoDownload.getDownloadOptions({
      otp: token.otp,
      playbackInfo: token.playbackInfo,
    });
  } catch (e: unknown) {
    const err = e as { errorMsg?: string; errorCode?: number };
    // Honest capability surfacing: most commonly the VdoCipher ACCOUNT does
    // not have offline downloads enabled (dashboard/plan capability — cannot
    // be enabled from code). Surface the SDK's own description verbatim.
    return {
      ok: false,
      error: err?.errorMsg || 'Offline download is not available for this video.',
      kind: 'options',
    };
  }

  const mediaId = optionsResult.downloadOptions.mediaId;

  // 3) Official track selection + enqueue (indices; platform rules above)
  const { selections } = selectDownloadTracks(optionsResult.downloadOptions.availableTracks);
  if (!selections.length) {
    return { ok: false, error: 'No downloadable tracks were provided for this video.', kind: 'options' };
  }
  try {
    await optionsResult.enqueue({ selections });
  } catch (e: unknown) {
    const err = e as { msg?: string; exception?: string };
    return { ok: false, error: err?.msg || err?.exception || 'Could not start the download.', kind: 'enqueue' };
  }

  // 4) Persist metadata + install official event listeners
  applyEntry({
    meta: {
      mediaId,
      lessonId: p.lessonId,
      courseId: p.courseId,
      courseName: p.courseName,
      courseImageUrl: p.courseImageUrl ?? null,
      sectionTitle: p.sectionTitle ?? null,
      title: p.title,
      lessonTitle: p.lessonTitle ?? p.title,
      lessonThumbnailUrl: p.lessonThumbnailUrl ?? null,
      lessonOrder: p.lessonOrder ?? null,
      userId: p.userId,
      rentalHours: token.rentalHours,
      expiresAt: token.expiresAt,
      authorizedAt: Date.now(),
      durationSec: optionsResult.downloadOptions.mediaInfo?.duration
        ? Math.round(optionsResult.downloadOptions.mediaInfo.duration / 1000)
        : null,
      posterUrl: null,
    },
    phase: 'pending',
    progress: 0,
    bytesDownloaded: 0,
    totalSizeBytes: null,
    lastError: null,
    updatedAt: Date.now(),
  });
  ensureDownloadListeners();
  return { ok: true, mediaId };
}

// ─── Official event listeners (installed once per JS session) ─────────────────

let listenersInstalled = false;
function ensureDownloadListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;

  const patch = (mediaId: string, mutate: (e: OfflineVideoEntry) => OfflineVideoEntry | null): void => {
    if (!cache) return;
    const e = cache.find((x) => x.meta.mediaId === mediaId);
    if (!e) return;
    const next = mutate(e);
    if (next) applyEntry(next);
  };

  // Each addEventListener returns an unregister function (official API);
  // we intentionally listen for the whole JS session (module singleton —
  // nothing to leak: the set is bounded and never re-registered).
  VdoDownload.addEventListener('onQueued', (mediaId: string) => {
    patch(mediaId, (e) => {
      const phase = nextPhase(e.phase, 'enqueued');
      return phase ? { ...e, phase, updatedAt: Date.now() } : null;
    });
  });
  VdoDownload.addEventListener('onChanged', (mediaId: string, status: DownloadStatus) => {
    patch(mediaId, (e) => {
      const phase = nextPhase(e.phase, 'progress');
      if (!phase) return null;
      return {
        ...e,
        phase,
        progress: status.downloadPercent,
        bytesDownloaded: status.bytesDownloaded ?? e.bytesDownloaded,
        totalSizeBytes: status.totalSizeBytes || e.totalSizeBytes,
        lastError: null,
        updatedAt: Date.now(),
      };
    });
  });
  VdoDownload.addEventListener('onCompleted', (mediaId: string, status: DownloadStatus) => {
    patch(mediaId, (e) => ({
      ...e,
      phase: 'completed',
      progress: 100,
      bytesDownloaded: status.bytesDownloaded ?? e.bytesDownloaded,
      totalSizeBytes: status.totalSizeBytes || e.totalSizeBytes,
      meta: {
        ...e.meta,
        posterUrl: status.poster || e.meta.posterUrl,
        durationSec: status.mediaInfo?.duration
          ? Math.round(status.mediaInfo.duration / 1000)
          : e.meta.durationSec,
      },
      lastError: null,
      updatedAt: Date.now(),
    }));
  });
  VdoDownload.addEventListener('onFailed', (mediaId: string, status: DownloadStatus) => {
    patch(mediaId, (e) => {
      const phase = nextPhase(e.phase, 'failed');
      return phase
        ? { ...e, phase, lastError: status.reasonDescription || `Download failed (code ${status.reason})`, updatedAt: Date.now() }
        : null;
    });
  });
  VdoDownload.addEventListener('onDeleted', (mediaId: string) => {
    removeEntry(mediaId);
  });
}

// ─── Library operations (official APIs only) ─────────────────────────────────

/** Official delete: removes DRM media + license via the SDK, then metadata. */
export async function deleteOfflineVideo(mediaId: string): Promise<void> {
  try { await VdoDownload.remove([mediaId]); } catch { /* tombstone regardless */ }
  removeEntry(mediaId);
}

/**
 * Official resume — used for both paused and failed-network downloads
 * (matches the official sample app's retry behavior).
 */
export async function retryOfflineVideo(mediaId: string): Promise<{ ok: boolean; error?: string }> {
  const e = (cache ?? []).find((x) => x.meta.mediaId === mediaId);
  if (!e) return { ok: false, error: 'Download not found.' };
  if (e.phase === 'completed') return { ok: true };
  try {
    await VdoDownload.resume([mediaId]);
    applyEntry({ ...e, phase: 'downloading', lastError: null, updatedAt: Date.now() });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Resume failed.';
    return { ok: false, error: msg };
  }
}

/** Official stop (pause) for an in-flight download. */
export async function pauseOfflineVideo(mediaId: string): Promise<void> {
  try { await VdoDownload.stop([mediaId]); } catch { /* best-effort */ }
  const e = (cache ?? []).find((x) => x.meta.mediaId === mediaId);
  if (e && e.phase === 'downloading') {
    applyEntry({ ...e, phase: 'pending', updatedAt: Date.now() });
  }
}

/**
 * Official resume for a paused download (distinct UX from retry-on-failure,
 * same official VdoDownload.resume call underneath).
 */
export async function resumeOfflineVideo(mediaId: string): Promise<{ ok: boolean; error?: string }> {
  const e = (cache ?? []).find((x) => x.meta.mediaId === mediaId);
  if (!e) return { ok: false, error: 'Download not found.' };
  if (e.phase === 'completed') return { ok: true };
  return retryOfflineVideo(mediaId);
}

/**
 * License expiry — SINGLE SOURCE OF TRUTH: the server-issued `expiresAt`
 * carried by the download OTP's rental license. VdoCipher's isExpired() is
 * Android-only per official docs; deriving from expiresAt behaves identically
 * on BOTH platforms and never shows a playable-but-expired entry. The DRM
 * layer independently refuses playback past the license window (device-clock
 * manipulation cannot defeat Widevine/FairPlay license expiry).
 */
export function isOfflineVideoExpired(e: OfflineVideoEntry): boolean {
  if (e.phase !== 'completed') return false;
  const t = Date.parse(e.meta.expiresAt);
  return Number.isFinite(t) && Date.now() >= t;
}

export function getPlayableOfflineVideos(): OfflineVideoEntry[] {
  return getOfflineVideos().filter((e) => e.phase === 'completed' && !isOfflineVideoExpired(e));
}

/** Called when connectivity returns: reconcile metadata with the SDK registry. */
export async function resyncOfflineLibrary(): Promise<void> {
  if (!hydrated) return;
  let nativeStatuses: DownloadStatus[] = [];
  try {
    nativeStatuses = await VdoDownload.query({ mediaId: [], status: [] });
  } catch { return; }
  const nativeById = new Map(nativeStatuses.map((s) => [s.mediaInfo.mediaId, s]));
  if (!cache) return;
  let changed = false;
  const next: OfflineVideoEntry[] = [];
  for (const e of cache) {
    const n = nativeById.get(e.meta.mediaId);
    if (!n) {
      if (e.phase === 'completed') { changed = true; continue; } // deleted externally
      next.push(e);
      continue;
    }
    const merged: OfflineVideoEntry = {
      ...e,
      meta: {
        ...e.meta,
        posterUrl: n.poster || e.meta.posterUrl,
        durationSec: n.mediaInfo?.duration ? Math.round(n.mediaInfo.duration / 1000) : e.meta.durationSec,
      },
      phase: mapNativeStatus(n.status, e.phase),
      progress: typeof n.downloadPercent === 'number' ? n.downloadPercent : e.progress,
      bytesDownloaded: n.bytesDownloaded ?? e.bytesDownloaded,
      totalSizeBytes: n.totalSizeBytes ?? e.totalSizeBytes,
      updatedAt: Date.now(),
    };
    if (merged.phase !== e.phase || merged.progress !== e.progress) changed = true;
    next.push(merged);
  }
  if (changed) {
    cache = next;
    emit();
    void persist();
  }
}

/** Reset test/logout hook: drops in-memory state (metadata persists on disk). */
export function _resetOfflineCacheForTests(): void {
  cache = null;
  hydrated = false;
  hydrating = null;
}

/**
 * ACCOUNT-SWITCH ISOLATION (parity: same RN surface on Android + iOS).
 *
 * Called on SIGNED_OUT and on account change (useSession user id change).
 * Drops the in-memory library so the NEXT account hydrates from scratch:
 * hydrateOfflineLibrary() is once-per-process by design, so without this the
 * previous user's library would remain visible after a hot account switch.
 *
 * Boundaries that keep this safe even before any fix:
 *  • DRM: VdoCipher offline licenses are device-bound DRM objects — playback
 *    through embedInfo={offline:true} is gated by the license, not our cache.
 *  • Metadata: persisted rows carry the owner's userId; hydration filters by
 *    the CURRENT user, so a cold start after switching accounts never shows
 *    the previous account's rows.
 * The DRM media itself is intentionally NOT deleted (the SDK registry keeps
 * it; re-downloading under the new account re-licenses per policy, and a
 * subsequent login of the original account still finds its downloads).
 */
export function resetOfflineLibraryForAccountSwitch(): void {
  cache = null;
  hydrated = false;
  hydrating = null;
  // Raw store is intentionally retained on switch only until the next hydrate
  // re-reads disk; cache===null guarantees no persist can run in between.
  emit();
}
