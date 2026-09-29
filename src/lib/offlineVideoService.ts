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
import * as FileSystem from 'expo-file-system/legacy';
import { getOfflineDownloadToken } from './api';
import { describeProviderError } from './videoProviderPolicy';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OfflineDownloadPhase =
  | 'authorizing'   // backend offline-authorize in flight (transient)
  | 'pending'       // enqueued with VdoCipher, queued/starting (paused maps to 'paused')
  | 'downloading'
  | 'processing'    // native post-download finalization (real SDK state — shown, never faked)
  | 'paused'        // native PAUSED download status (official SDK state)
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
  /** Offline-safe copy of the course image cached on-device at download
   *  time (native only). Rendered BEFORE courseImageUrl so the circular
   *  course thumbnail still works with zero connectivity. Optional so
   *  metadata persisted by earlier builds hydrates unchanged. */
  courseImageUrlLocal?: string | null;
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
  /** Best course image to render: on-device cached copy first (works
   *  offline), then the remote URL, then a lesson thumbnail. Screens still
   *  fall back to initials via the Image onError handler (a URL can be
   *  broken server-side — e.g. legacy rows whose file no longer exists). */
  courseImage: string | null;
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
    // courseId is persisted at authorize time. LEGACY rows downloaded before
    // that metadata existed carry courseId=null; grouping them under one key
    // VISUALLY MERGED distinct courses into a single card (the reported bug).
    // They are still separable by the persisted courseName — use it as the
    // fallback key so legacy downloads of different courses render as their
    // own independent cards. Entries with neither remain in a shared bucket.
    const key = e.meta.courseId
      || (e.meta.courseName?.trim() ? `name:${e.meta.courseName.trim()}` : '__nocourse__');
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
    // Course image resolution order (offline-first):
    //   1. on-device cached copy (works with zero connectivity)
    //   2. the remote MedAcademy course image (works online)
    //   3. a lesson thumbnail (secondary)
    //   null → the screens render their initials fallback.
    const courseImage = ordered.find((e) => !!e.meta.courseImageUrlLocal)?.meta.courseImageUrlLocal
      ?? ordered.find((e) => !!e.meta.courseImageUrl)?.meta.courseImageUrl
      ?? ordered.find((e) => !!e.meta.lessonThumbnailUrl)?.meta.lessonThumbnailUrl
      ?? null;
    groups.push({
      courseId,
      courseName: ordered.find((e) => !!e.meta.courseName)?.meta.courseName ?? 'My Downloads',
      courseImageUrl: ordered.find((e) => !!e.meta.courseImageUrl)?.meta.courseImageUrl ?? null,
      courseImage,
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
    case 'processing': return 'processing'; // native finalization state — surfaced honestly
    case 'paused':     return 'paused';     // user paused via the SDK's own lifecycle
    case 'pending':    return 'pending';
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

// ─── Pure helpers (unit-tested; platform-safe) ────────────────────────────────

/**
 * Official getDownloadOptions params builder: customPlayerId is an OPTIONAL
 * official parameter (docs: "We can also pass the customPlayerId along with
 * the otp and playbackInfo which should be applied to the downloaded video").
 * The backend supplies it ONLY when the operator's VdoCipher account needs a
 * specific player profile for downloadable renditions; absent → exactly the
 * previous behavior (account default player).
 */
export function buildOfflineOptionParams(
  token: { otp: string; playbackInfo: string; customPlayerId?: string | null }
): { otp: string; playbackInfo: string; customPlayerId?: string } {
  const base = { otp: token.otp, playbackInfo: token.playbackInfo };
  const pid = typeof token.customPlayerId === 'string' ? token.customPlayerId.trim() : '';
  return pid ? { ...base, customPlayerId: pid } : base;
}

export type OfflineLoadErrorKind = 'expired' | 'incomplete_media' | 'renderer' | 'drm_state' | 'other';

/**
 * Classifies an SDK load-error code (VdoCipher Android error-code table,
 * also used by the RN bridge on Android; iOS surfaces its own strings):
 *   6187               → DRM keys expired (rental window finished)
 *   6102 / 5160 / 5161 → offline media incomplete/missing (play attempted
 *                        on a download that never truly completed, or its
 *                        files were removed outside the app)
 *   6120 / 6122 / 6101 → renderer / secure-decoder failures (documented as
 *                        "much more common" with >1 VdoPlayer instance)
 *   6157/6161/6166/6172/6177/6181/6190/6196 → Widevine CDM state errors
 */
export function classifyOfflineLoadError(code: number | string | null | undefined): OfflineLoadErrorKind {
  const n = typeof code === 'string' ? Number.parseInt(code, 10) : code;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'other';
  if (n === 6187) return 'expired';
  if (n === 6102 || n === 5160 || n === 5161) return 'incomplete_media';
  if (n === 6120 || n === 6122 || n === 6101) return 'renderer';
  if (n === 6157 || n === 6161 || n === 6166 || n === 6172 || n === 6177 || n === 6181 || n === 6190 || n === 6196) return 'drm_state';
  return 'other';
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
 * Offline-safe course-image cache (native only).
 *
 * The course thumbnail is a REMOTE MedAcademy storage URL. Without caching,
 * the Offline Library's circular course image renders blank the moment the
 * device is offline (RN `<Image>` cannot fetch it) — plus legacy rows whose
 * server file no longer exists 404 even online. At download time we copy the
 * image into the app's document directory (a stable on-device file:// URI)
 * and persist that path alongside the metadata. Rendering order becomes:
 * cached local file → remote URL → initials fallback. Best-effort by design:
 * a failed cache write NEVER blocks or fails the download itself, and web
 * (no documentDirectory) keeps using the remote URL.
 */
async function cacheCourseImage(
  url: string | null | undefined,
  mediaId: string,
): Promise<string | null> {
  if (!url || Platform.OS === 'web') return null;
  try {
    const dir = `${FileSystem.documentDirectory ?? ''}course-images`.replace(/\/$/, '');
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    const ext = /\.png(?:$|\?)/i.test(url) ? 'png' : /\.webp(?:$|\?)/i.test(url) ? 'webp' : 'jpg';
    const dest = `${dir}/${mediaId}.${ext}`;
    const res = await FileSystem.downloadAsync(url, dest);
    return res?.status === 200 && res.uri ? res.uri : null;
  } catch {
    return null; // offline/URL-dead/cache-full → remote URL + initials fallback still apply
  }
}

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
    // A provider-policy refusal (video_provider_disabled) surfaces as the
    // friendly availability message; every other error keeps its own text.
    const msg = describeProviderError(e);
    return { ok: false, error: msg, kind: 'auth' };
  }

  // 2) Official options fetch — the SDK exchanges our OTP with VdoCipher.
  //    customPlayerId passes through only when the backend issues one.
  let optionsResult: Awaited<ReturnType<typeof VdoDownload.getDownloadOptions>>;
  try {
    optionsResult = await VdoDownload.getDownloadOptions(buildOfflineOptionParams(token));
  } catch (e: unknown) {
    const err = e as { errorMsg?: string; errorCode?: number | string; httpStatusCode?: number };
    // Sanitized diagnostics (NO otp/playbackInfo/tokens — code+message only).
    // STAGE = native getDownloadOptions. On iOS the bridge's VdoDownload.swift
    // throws its literal "Tracks Not Found" error HERE — inside the closed
    // SDK, after asset.getVideoQualities() returns zero — before any JS sees
    // a track list. So msg="Tracks Not Found" at this stage is stage-proof
    // that VdoCipher itself supplied zero downloadable renditions (case A/F:
    // SDK/account-media level), NOT a JS filtering or parsing failure.
    console.info(
      `[offline-dl] STAGE=native-getDownloadOptions FAILED code=${String(err?.errorCode ?? '?')} http=${String(err?.httpStatusCode ?? '?')} msg="${String(err?.errorMsg ?? '?')}" platform=${Platform.OS}`
    );
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
  const availableTracks = optionsResult.downloadOptions.availableTracks ?? [];
  const { selections } = selectDownloadTracks(availableTracks);
  // Sanitized track inventory (safe fields only) — makes "Tracks Not Found"-
  // class failures diagnosable from device logs without exposing credentials.
  // The video/audio CENSUS is the decisive diagnostic: VdoCipher returns zero
  // downloadable video renditions when the ACCOUNT/MEDIA lacks offline
  // (FairPlay/Widevine) renditions — a dashboard-side configuration state,
  // not a client parsing failure. This line makes that unmistakable.
  const videoTracks = availableTracks.filter((t: { type?: string }) => t.type === 'video').length;
  const audioTracks = availableTracks.filter((t: { type?: string }) => t.type === 'audio').length;
  console.info(
    `[offline-dl] STAGE=native-getDownloadOptions OK mediaId=${mediaId} tracks=${availableTracks.length} video=${videoTracks} audio=${audioTracks} platform=${Platform.OS}` +
      availableTracks
        .map((t: { type?: string; bitrate?: number; language?: string }, i: number) => ` #${i}:${t.type}${typeof t.bitrate === 'number' && t.bitrate > 0 ? `@${t.bitrate}` : ''}${t.language ? `/${t.language}` : ''}`)
        .join('')
  );
  if (videoTracks === 0) {
    console.info(
      `[offline-dl] STAGE=js-track-selection ZERO VIDEO TRACKS mediaId=${mediaId} — the SDK delivered an options payload with ` +
        `no downloadable video rendition. With a freshly processed video this is an ACCOUNT/MEDIA CONFIGURATION condition ` +
        `(offline/FairPlay renditions are enabled dashboard-side), not a client failure. ` +
        `The honest refusal below is intentional; no track data is invented.`
    );
  }
  if (!selections.length) {
    console.info(`[offline-dl] enqueue refused platform=${Platform.OS} reason=no-usable-tracks`);
    return { ok: false, error: 'No downloadable tracks were provided for this video.', kind: 'options' };
  }
  console.info(`[offline-dl] enqueue mediaId=${mediaId} selections=[${selections.join(',')}] platform=${Platform.OS}`);
  try {
    await optionsResult.enqueue({ selections });
  } catch (e: unknown) {
    const err = e as { msg?: string; exception?: string };
    return { ok: false, error: err?.msg || err?.exception || 'Could not start the download.', kind: 'enqueue' };
  }

  // 4) Install official event listeners BEFORE creating the row: any native
  //    event fired between enqueue and applyEntry (onQueued / early onChanged,
  //    or even onCompleted for a tiny file) must be observable, not dropped.
  //    patch() no-ops while the row is absent, and listeners read `cache`
  //    live — so ordering listeners first is sufficient and race-free.
  ensureDownloadListeners();

  // 4b) Persist metadata. NOTE: the course-image cache runs AFTER applyEntry
  //     (fire-and-forget) — awaiting this network download here previously
  //     delayed the row's creation by seconds, during which the Lesson row
  //     showed a stale "Queued…" and early SDK events had no row to land on.
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
      // courseImageUrlLocal is patched in AFTER the fire-and-forget image
      // cache resolves (patchOfflineEntryMeta) — never blocks the row.
    },
    phase: 'pending',
    progress: 0,
    bytesDownloaded: 0,
    totalSizeBytes: null,
    lastError: null,
    updatedAt: Date.now(),
  });
  void cacheCourseImage(p.courseImageUrl ?? null, mediaId)
    .then((local) => { if (local) patchOfflineEntryMeta(mediaId, { courseImageUrlLocal: local }); })
    .catch(() => { /* best-effort only */ });
  return { ok: true, mediaId };
}

/** Merge-only metadata patch (never touches phase/progress): used for
 *  best-effort post-entry enrichments (e.g. the cached course image). */
export function patchOfflineEntryMeta(
  mediaId: string,
  meta: Partial<OfflineVideoMeta>,
): void {
  if (!cache) return;
  const e = cache.find((x) => x.meta.mediaId === mediaId);
  if (!e) return;
  applyEntry({ ...e, meta: { ...e.meta, ...meta }, updatedAt: Date.now() });
}

// ─── Official event listeners (installed once per JS session) ─────────────────

let listenersInstalled = false;

/** Apply a mutation to one cached row (no-op when the row is not in cache).
 *  Module-scope so BOTH the official event listeners and the one-shot
 *  syncOfflineEntry() reconcile share the exact same write path. */
function patch(
  mediaId: string,
  mutate: (e: OfflineVideoEntry) => OfflineVideoEntry | null,
): void {
  if (!cache) return;
  const e = cache.find((x) => x.meta.mediaId === mediaId);
  if (!e) return;
  const next = mutate(e);
  if (next) applyEntry(next);
}

function ensureDownloadListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;

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
      // `processing` is a REAL native post-download state — surface it honestly
      // instead of folding it into 'downloading' (which shows a fake percent).
      if (status.status === 'processing') {
        return { ...e, phase: 'processing' as OfflineDownloadPhase, lastError: null, updatedAt: Date.now() };
      }
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
 * NATIVE-STATE RECONCILIATION for ONE media (playback-time safety net).
 *
 * Called by the offline player when the SDK refuses to load an offline asset
 * (e.g. 6102 "Internal Database Error" = play attempted on a download that is
 * not actually complete, or 6120-class renderer errors). The SDK registry is
 * the authority for what DRM media exists; a local row claiming 'completed'
 * while the native state disagrees is reconciled here so the UI immediately
 * stops offering playback (docs: "You can only load videos which completed
 * successfully... use query filters to only show play option on completed
 * downloads").
 *
 * Returns the authoritative verdict:
 *   'completed'      → native registry confirms a completed download
 *   'not_completed'  → native registry contradicts the local 'completed' row
 *                      (local row reconciled to the native state)
 *   'unknown'        → registry unreachable/media absent (row removed when it
 *                      claimed completed — media deleted outside the app)
 */
export async function reconcileOfflineMediaState(mediaId: string): Promise<'completed' | 'not_completed' | 'unknown'> {
  let native: DownloadStatus | undefined;
  try {
    const statuses: DownloadStatus[] = await VdoDownload.query({ mediaId: [mediaId], status: [] });
    native = statuses.find((s: DownloadStatus) => s.mediaInfo.mediaId === mediaId);
  } catch { return 'unknown'; }
  if (!native) {
    const e = (cache ?? []).find((x) => x.meta.mediaId === mediaId);
    if (e && e.phase === 'completed') removeEntry(mediaId);
    return 'unknown';
  }
  if (native.status === 'completed') return 'completed';
  const e = (cache ?? []).find((x) => x.meta.mediaId === mediaId);
  if (e && e.phase === 'completed') {
    applyEntry({
      ...e,
      phase: mapNativeStatus(native.status, 'failed'),
      progress: typeof native.downloadPercent === 'number' ? native.downloadPercent : e.progress,
      bytesDownloaded: native.bytesDownloaded ?? e.bytesDownloaded,
      totalSizeBytes: native.totalSizeBytes ?? e.totalSizeBytes,
      lastError: native.reasonDescription || 'Download is not complete on this device.',
      updatedAt: Date.now(),
    });
  }
  return 'not_completed';
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
/**
 * One-shot authoritative reconcile for a SINGLE mediaId (official query()).
 *
 * Why this exists: the Offline Library self-heals via resyncOfflineLibrary(),
 * but the Lesson screen previously never queried the SDK — so a row stranded
 * by a dropped early event (or an event that fired before listeners/row
 * existed) stayed "Queued…" forever while the Offline Library showed the
 * truth. Screens call this on focus/return; it is idempotent and safe when
 * the SDK is unavailable ('unknown' → local state preserved, nothing faked).
 */
export async function syncOfflineEntry(mediaId: string): Promise<OfflineVideoEntry | null> {
  const before = (cache ?? []).find((x) => x.meta.mediaId === mediaId) ?? null;
  try {
    const statuses: DownloadStatus[] = await VdoDownload.query({ mediaId: [mediaId], status: [] });
    const n = statuses.find((s) => s.mediaInfo.mediaId === mediaId);
    if (!n) return before; // registry has nothing for it → keep local state
    patch(mediaId, () => ({
      ...before!,
      meta: {
        ...before!.meta,
        posterUrl: n.poster || before!.meta.posterUrl,
        durationSec: n.mediaInfo?.duration
          ? Math.round(n.mediaInfo.duration / 1000)
          : before!.meta.durationSec,
      },
      phase: mapNativeStatus(n.status, before!.phase),
      progress: typeof n.downloadPercent === 'number' ? n.downloadPercent : before!.progress,
      bytesDownloaded: n.bytesDownloaded ?? before!.bytesDownloaded,
      totalSizeBytes: n.totalSizeBytes ?? before!.totalSizeBytes,
      lastError: n.status === 'failed' ? (n.reasonDescription || before!.lastError) : null,
      updatedAt: Date.now(),
    }));
    return (cache ?? []).find((x) => x.meta.mediaId === mediaId) ?? before;
  } catch {
    return before; // SDK unreachable → untouched local state
  }
}

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
