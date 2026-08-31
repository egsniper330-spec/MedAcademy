/**
 * videoUploadEngine.ts
 * Upload engine for the VdoCipher-only video pipeline:
 *  - Multi-stage status lifecycle: upload → process → encode → stream → ready
 *  - Thumbnail generation via expo-video-thumbnails (native) / canvas (web)
 *  - Thumbnail storage in the PHP `course-images` public bucket
 *  - Pre-upload file analysis (size, estimated time, connection recommendation)
 *  - Replace-video flow (VdoCipher-only, no PHP storage for video files)
 *
 * Video files are uploaded directly to VdoCipher S3 — PHP storage is NOT
 * used for video files. PDFs and other lesson materials continue to use
 * PHP storage via api.ts (lesson-materials bucket) — do not modify those.
 */

import { backendClient } from '@/client/backendClient';
import { upsertVideoAsset } from '@/lib/videoLibraryApi';

export type UploadStatus =
  | 'waiting'
  | 'uploading'
  | 'paused'
  | 'resuming'     // resuming from last chunk — re-uploading missing chunks only
  | 'processing'
  | 'encoding'
  | 'generating_streams'
  | 'verifying'
  | 'ready'
  | 'failed'
  | 'timeout'      // processing exceeded 10-min deadline — retry polling only
  | 'canceled'
  | 'recovering';

export type VerificationStatus = 'pending' | 'verifying' | 'passed' | 'failed' | 'skipped';

export interface UploadProgressEvent {
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
  speedBps: number;
  etaSeconds: number;
}

/** Pre-upload file analysis result */
export interface FileAnalysis {
  fileSize: number;
  formattedSize: string;
  isVeryLarge: boolean;          // > 2 GB
  isLarge: boolean;              // > 500 MB
  estimatedMinutes: {
    slow: number;    // 5 Mbps
    medium: number;  // 25 Mbps
    fast: number;    // 100 Mbps
  };
  recommendedConnection: string;
  warningMessage: string | null;
}

export interface UploadTask {
  id: string;
  lessonId: string | null;
  courseId: string | null;
  doctorId?: string;           // Owner doctor — set at creation, used for video_assets upsert
  fileUri: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  status: UploadStatus;
  progress: number;
  bytesUploaded: number;
  speedBps: number;
  etaSeconds: number;
  errorMessage?: string;
  thumbnailUrl?: string;
  verificationStatus?: VerificationStatus;
  verificationError?: string;
  retryCount: number;
  createdAt: number;
  uploadedAt?: number;
  // VdoCipher provider tracking — set after Step 1 (init)
  vdoCipherVideoId?: string;
  // Replace-video metadata
  isReplacement?: boolean;
  oldVdoCipherVideoId?: string;  // VdoCipher ID of the video being replaced
  replacedUploadId?: string;
  // ── Chunked upload tracking ─────────────────────────────────────────────
  totalChunks?: number;        // total number of chunks for this upload
  chunksCompleted?: number;    // how many chunks have been stored on server
  chunkSizeBytes?: number;     // bytes per chunk (default 8 MB)
  // runtime — not serialized to AsyncStorage
  _xhr?: XMLHttpRequest;
  _pausedAt?: number;
  _abortController?: AbortController; // cancels in-flight chunk fetch
}

// ─── Constants ────────────────────────────────────────────────────────────────
const VERY_LARGE_BYTES = 2 * 1024 * 1024 * 1024;  // 2 GB
const LARGE_BYTES      = 500 * 1024 * 1024;         // 500 MB

// ─── Pre-upload file analysis ─────────────────────────────────────────────────
export function analyzeFile(fileSize: number, fileName: string): FileAnalysis {
  const mbSize = fileSize / (1024 * 1024);
  const gbSize = fileSize / (1024 * 1024 * 1024);
  const isVeryLarge = fileSize >= VERY_LARGE_BYTES;
  const isLarge = fileSize >= LARGE_BYTES;

  // Estimated upload minutes at different speeds (accounting for overhead)
  const overhead = 1.1;
  const slow   = Math.ceil((mbSize / (5   * 1024 / 8)) * overhead / 60);
  const medium = Math.ceil((mbSize / (25  * 1024 / 8)) * overhead / 60);
  const fast   = Math.ceil((mbSize / (100 * 1024 / 8)) * overhead / 60);

  let recommendedConnection = 'Wi-Fi';
  if (isVeryLarge) recommendedConnection = 'High-speed Wi-Fi (50 Mbps+)';
  else if (isLarge) recommendedConnection = 'Wi-Fi (10 Mbps+)';

  let warningMessage: string | null = null;
  if (isVeryLarge) {
    warningMessage = `This video is very large (${gbSize.toFixed(2)} GB). Upload may take a long time. Make sure you have a stable, high-speed connection.`;
  } else if (isLarge) {
    warningMessage = `Large file (${(mbSize).toFixed(0)} MB). Recommend uploading on Wi-Fi.`;
  }

  return {
    fileSize,
    formattedSize: formatBytes(fileSize),
    isVeryLarge,
    isLarge,
    estimatedMinutes: { slow, medium, fast },
    recommendedConnection,
    warningMessage,
  };
}

// ─── Thumbnail generation ─────────────────────────────────────────────────────
/**
 * Generate a thumbnail from a local video URI.
 * Uses expo-video-thumbnails on native, canvas on web.
 * Returns a local URI (data: or file:) or null on failure.
 */
export async function generateVideoThumbnail(videoUri: string): Promise<string | null> {
  try {
    if (process.env.EXPO_OS === 'web') {
      return await generateThumbnailWeb(videoUri);
    }
    // Native: expo-video-thumbnails
    const VideoThumbnails = await import('expo-video-thumbnails');
    const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
      time: 3000,      // 3 seconds in
      quality: 0.7,
    });
    return uri;
  } catch (_) {
    return null;
  }
}

// ─── Video duration probe ─────────────────────────────────────────────────────
/**
 * Read the actual duration (in seconds) from a local video URI.
 * Web: HTMLVideoElement.duration via onloadedmetadata
 * Native: expo-video createVideoPlayer with polling until duration > 0
 * Returns 0 on failure — caller should treat 0 as "unknown".
 */
export async function getVideoDurationSeconds(videoUri: string): Promise<number> {
  try {
    if (process.env.EXPO_OS === 'web') {
      return await new Promise<number>((resolve) => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.src = videoUri;
        video.onloadedmetadata = () => resolve(isFinite(video.duration) ? video.duration : 0);
        video.onerror = () => resolve(0);
        setTimeout(() => resolve(0), 10000);
      });
    }
    // Native: expo-video Player (already a project dependency)
    const { createVideoPlayer } = await import('expo-video');
    const player = createVideoPlayer(videoUri);
    // Poll until the player reports a non-zero duration (metadata loaded)
    let attempts = 0;
    while (player.duration === 0 && attempts < 30) {
      await new Promise<void>((r) => setTimeout(r, 100));
      attempts++;
    }
    const dur = player.duration ?? 0;
    player.release();
    return isFinite(dur) ? dur : 0;
  } catch (e) {
    if (__DEV__) console.warn('[getVideoDurationSeconds] failed', e);
    return 0;
  }
}

async function generateThumbnailWeb(videoUri: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const video = document.createElement('video');
      video.src = videoUri;
      video.crossOrigin = 'anonymous';
      video.currentTime = 3;
      video.onloadeddata = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = video.videoWidth  || 320;
        canvas.height = video.videoHeight || 180;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      video.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 10000);
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * uploadThumbnailToStorage
 * Uploads a thumbnail image to the PUBLIC `course-images` bucket so it is
 * directly accessible as a stable URL without signed-URL expiry.
 *
 * Thumbnails must NOT go into `lesson-materials` (private bucket) — any URL
 * generated via getPublicUrl() on a private bucket returns 400/403.
 */
export async function uploadThumbnailToStorage(
  thumbnailUri: string,
  courseId: string,
  lessonId: string,
  uploadId: string,
): Promise<{ storagePath: string; publicUrl: string } | null> {
  const THUMB_BUCKET = 'course-images'; // PUBLIC bucket — thumbnails are safe to expose
  try {
    const { fetch: expoFetch } = await import('expo/fetch');
    const resp = await expoFetch(thumbnailUri);
    const blob = await resp.blob();
    const storagePath = `thumbnails/${courseId}/${lessonId}/${uploadId}.jpg`;

    const { error } = await backendClient.storage
      .from(THUMB_BUCKET)
      .upload(storagePath, blob as any, { contentType: 'image/jpeg', upsert: true });

    if (error) {
      if (__DEV__) console.error('[uploadThumbnailToStorage] upload error', {
        bucket: THUMB_BUCKET, storagePath, error: error.message,
      });
      return null;
    }
    // course-images is a public bucket — getPublicUrl() works correctly here
    const { data } = backendClient.storage.from(THUMB_BUCKET).getPublicUrl(storagePath);
    return { storagePath, publicUrl: data.publicUrl };
  } catch (e) {
    if (__DEV__) console.error('[uploadThumbnailToStorage] exception', e);
    return null;
  }
}

// ─── DB helpers ──────────────────────────────────────────────────────────────
export async function createUploadRecord(task: Omit<UploadTask, '_xhr' | '_pausedAt' | '_abortController'>): Promise<string> {
  const { data, error } = await backendClient
    .from('video_uploads')
    .insert({
      id: task.id,
      lesson_id: task.lessonId ?? null,
      course_id: task.courseId ?? null,
      ...(task.doctorId ? { doctor_id: task.doctorId } : {}),
      file_name: task.fileName,
      file_size: task.fileSize,
      mime_type: task.mimeType,
      status: task.status,
      is_replacement: task.isReplacement ?? false,
      replaced_upload_id: task.replacedUploadId ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function updateUploadRecord(id: string, patch: Partial<{
  status: UploadStatus;
  bytes_uploaded: number;
  upload_speed_bps: number;
  eta_seconds: number;
  thumbnail_url: string;
  thumbnail_storage_path: string;
  error_message: string;
  retry_count: number;
  upload_started_at: string;
  upload_completed_at: string;
  processing_started_at: string;
  ready_at: string;
  verification_status: VerificationStatus;
  verification_error: string;
  verified_at: string;
  recovery_state: string;
  file_analysis: Record<string, unknown>;
  provider_video_id: string;       // VdoCipher video ID — stored for cleanup queries
}>): Promise<void> {
  const { error } = await backendClient.from('video_uploads').update(patch).eq('id', id);
  if (error) throw error;
}

/** Clear all video references from a lesson — sets it back to "No Video" state. */
export async function clearLessonVideoRef(lessonId: string): Promise<void> {
  const { error } = await backendClient.from('lessons').update({
    video_id:               null,
    video_asset_id:         null,
    video_status:           'none',
    video_upload_id:        null,
    video_thumbnail_url:    null,
    video_duration_seconds: null,
    updated_at:             new Date().toISOString(),
  }).eq('id', lessonId);
  if (error) throw error;
}

export async function insertAuditLog(
  uploadId: string,
  event: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await backendClient.from('upload_audit_logs').insert({ upload_id: uploadId, event, details });
}

export async function updateLessonVideoStatus(
  lessonId: string | null,
  videoUploadId: string,
  videoStatus: UploadStatus,
  patch?: Partial<{
    video_id: string;
    video_title: string;
    video_thumbnail_url: string;
    video_duration_seconds: number;
    doctorId?: string;           // Caller-provided owner — avoids extra DB round-trip
  }>,
): Promise<void> {
  // ── Sync video_assets when the upload becomes ready ──────────────────────
  // This keeps the library in sync without any manual step: whenever the
  // upload pipeline marks a video 'ready', we upsert the asset record and
  // wire video_asset_id on the lesson so it is reusable from the library.
  if (videoStatus === 'ready' && patch?.video_id) {
      // Resolve the owning doctor. Priority:
      //   1. Caller-provided doctorId (avoids extra DB round-trip)
      //   2. From lessons → courses.doctor_id join
      //   3. From video_uploads.doctor_id (set by PHP enforceOwnerOnWrite)
      let doctorId: string | undefined = patch.doctorId;

      if (!doctorId && lessonId) {
        const { data: lessonRow } = await backendClient
          .from('lessons')
          .select('course_id, courses!inner(doctor_id)')
          .eq('id', lessonId)
          .single();
        doctorId = (lessonRow as any)?.courses?.doctor_id as string | undefined;
      }

      if (!doctorId) {
        const { data: uploadRow } = await backendClient
          .from('video_uploads')
          .select('doctor_id')
          .eq('id', videoUploadId)
          .single();
        doctorId = (uploadRow as any)?.doctor_id as string | undefined;
      }

      // video_assets requires a valid doctor_id — throw instead of silently
      // skipping, so the pipeline marks the upload as failed rather than
      // removing it from the queue while no library entry exists.
      if (!doctorId) {
        throw new Error(
          `[updateLessonVideoStatus] Cannot create video_asset: doctor_id ` +
          `not found for upload ${videoUploadId}` +
          (lessonId ? ` (lesson ${lessonId})` : ' (library upload)'),
        );
      }

      const { data: uploadRow } = await backendClient
        .from('video_uploads')
        .select('file_size, file_name')
        .eq('id', videoUploadId)
        .maybeSingle();
      const asset = await upsertVideoAsset({
        doctorId,
        providerVideoId: patch.video_id,
        title: patch.video_title ?? (uploadRow as any)?.file_name ?? '',
        durationSeconds: patch.video_duration_seconds ?? null,
        fileSizeBytes: (uploadRow as any)?.file_size ?? null,
        thumbnailUrl: patch.video_thumbnail_url ?? null,
        status: 'ready',
        uploadId: videoUploadId,
      });

      if (lessonId) {
        const { error: assetLinkError } = await backendClient.from('lessons').update({
          video_asset_id: asset.id,
        }).eq('id', lessonId);
        if (assetLinkError) throw assetLinkError;
      }
  }

  if (!lessonId) return;
  const { error } = await backendClient.from('lessons').update({
    video_upload_id: videoUploadId,
    video_status: videoStatus,
    updated_at: new Date().toISOString(),
    ...patch,
  }).eq('id', lessonId);
  if (error) throw error;
}

// ─── Duplicate detection ──────────────────────────────────────────────────────
export async function checkDuplicateVideo(
  courseId: string,
  fileName: string,
  fileSizeBytes: number,
): Promise<{ isDuplicate: boolean; existingLessonTitle?: string; existingUploadId?: string }> {
  const { data } = await backendClient
    .from('video_uploads')
    .select('id, file_name, file_size, lesson_id, lesson:lessons(title)')
    .eq('course_id', courseId)
    .eq('status', 'ready')
    .eq('file_name', fileName)
    .eq('file_size', fileSizeBytes)
    .limit(1);

  if (data && data.length > 0) {
    const existing = data[0] as any;
    return {
      isDuplicate: true,
      existingLessonTitle: existing.lesson?.title,
      existingUploadId: existing.id,
    };
  }
  return { isDuplicate: false };
}

// ─── Course publish validation ────────────────────────────────────────────────
export interface PublishBlocker {
  lessonTitle: string;
  videoStatus: string;
  reason: string;
}

export async function getCoursePublishBlockers(courseId: string): Promise<PublishBlocker[]> {
  const { data, error } = await backendClient
    .from('lessons')
    .select('id, title, video_status, video_type, video_id, youtube_video_id')
    .eq('course_id', courseId);
  if (error || !data) return [];

  const blockers: PublishBlocker[] = [];
  for (const lesson of data) {
    const vt = lesson.video_type ?? 'vdocipher';

    // coming_soon lessons are always valid — no upload required
    if (vt === 'coming_soon') continue;

    // YouTube: only check that the ID is present — no upload pipeline status to poll
    if (vt === 'youtube') {
      if (!lesson.youtube_video_id?.trim()) {
        blockers.push({
          lessonTitle: lesson.title,
          videoStatus: 'missing',
          reason: 'YouTube video URL is missing',
        });
      }
      continue;
    }

    // vdocipher (and any future provider using the upload pipeline)
    const vs = lesson.video_status ?? 'none';
    if (vs === 'ready' || vs === 'none') continue;
    const reasons: Record<string, string> = {
      waiting:            'Waiting to upload',
      uploading:          'Currently uploading',
      paused:             'Upload paused',
      processing:         'Video is processing',
      encoding:           'Video is encoding',
      generating_streams: 'Generating streaming files',
      verifying:          'Verifying video integrity',
      failed:             'Upload failed — retry required',
      canceled:           'Upload was canceled',
      recovering:         'Recovering interrupted upload',
    };
    blockers.push({
      lessonTitle: lesson.title,
      videoStatus: vs,
      reason: reasons[vs] ?? vs,
    });
  }
  return blockers;
}

// ─── Storage monitor ──────────────────────────────────────────────────────────
export interface DoctorStorageStats {
  totalVideos: number;
  totalBytes: number;
  avgFileSizeBytes: number;
  largestFileSizeBytes: number;
  largestFileName: string;
}

export async function getDoctorStorageStats(doctorId: string): Promise<DoctorStorageStats> {
  const { data } = await backendClient
    .from('video_uploads')
    .select('file_size, file_name')
    .eq('doctor_id', doctorId)
    .eq('status', 'ready');

  if (!data || data.length === 0) {
    return { totalVideos: 0, totalBytes: 0, avgFileSizeBytes: 0, largestFileSizeBytes: 0, largestFileName: '' };
  }
  const totalBytes = data.reduce((s: number, r: { file_size: number | null }) => s + (r.file_size ?? 0), 0);
  const largest = data.reduce((a: any, b: any) => (b.file_size > a.file_size ? b : a), data[0] as any);
  return {
    totalVideos: data.length,
    totalBytes,
    avgFileSizeBytes: Math.round(totalBytes / data.length),
    largestFileSizeBytes: largest.file_size,
    largestFileName: largest.file_name,
  };
}

// ─── Error layer tags ─────────────────────────────────────────────────────────
// Used in both dev messages and structured logs so the exact failure point is
// always identifiable in the console / audit log.
export type UploadErrorLayer =
  | '[RN]'                      // React Native client code
  | '[EF:video-upload-chunk]'   // Edge Function: video-upload-chunk
  | '[EF:video-assemble-upload]'// Edge Function: video-assemble-upload
  | '[Storage]'                 // PHP storage (chunk bucket)
  |'[DB]'                     // PHP/MySQL API (RPC / table update)
  | '[VdoCipher]';              // VdoCipher API (encoding / polling)

// ─── User-friendly error sanitization ────────────────────────────────────────
/**
 * Maps technical error messages to user-facing text.
 *
 * PRODUCTION: Returns a simple, provider-neutral string.
 *   - Never exposes: VdoCipher, S3, AWS, chunk, assembly, step numbers, API names
 *
 * DEVELOPMENT (__DEV__ === true): Returns the FULL technical message prefixed
 *   with the layer tag so the exact failure point is visible in the console
 *   and on-screen during testing.
 *   e.g.  "[EF:video-assemble-upload] S3 upload failed (HTTP 403): ..."
 *
 * RULE: Log the original techMsg via logUploadError() BEFORE calling this.
 * This function only decides what to DISPLAY.
 */
export function formatUploadError(technicalMsg: string, layer: UploadErrorLayer): string {
  // __DEV__ is a React Native global: true in Expo Go / dev builds, false in prod
  if (__DEV__) {
    return `${layer} ${technicalMsg}`;
  }
  return sanitizeUploadError(technicalMsg);
}

/** Internal sanitizer — only called by formatUploadError in production */
export function sanitizeUploadError(technicalMsg: string): string {
  const m = technicalMsg?.toLowerCase() ?? '';

  // Network / connectivity
  if (/network error|fetch failed|failed to fetch|net::err|econnreset|econnrefused|etimedout|socket hang up|network request failed/i.test(m)) {
    return 'Upload failed: Network error.\nPlease check your internet connection and try again.';
  }
  if (/timeout|timed out/i.test(m)) {
    return 'Video processing timed out.\nPlease try again later.';
  }

  // Auth / session
  if (/401|403|unauthorized|forbidden|session expired|jwt expired|invalid token|token/i.test(m)) {
    return 'Upload failed.\nYour session has expired. Please sign in again.';
  }

  // Storage full / quota
  if (/quota|storage.*full|insufficient.*storage|storage.*exceeded/i.test(m)) {
    return 'Upload failed: Storage limit reached.\nPlease contact support.';
  }

  // File not found / read error
  if (/file.*not found|no such file|enoent|uri.*invalid|content.*uri|cannot read/i.test(m)) {
    return 'Upload failed: Could not read the video file.\nPlease select the file again.';
  }

  // Server errors
  if (/500|502|503|504|internal server|bad gateway|service unavailable/i.test(m)) {
    return 'Upload failed: Server error.\nPlease try again in a few minutes.';
  }

  // Processing / encoding failures — strip any internal provider detail
  if (/encoding|processing.*fail|transcode|failed.*status/i.test(m)) {
    return 'Video processing failed.\nPlease try again later.';
  }

  // Abort / cancel (should normally not surface, but guard anyway)
  if (/abort|cancel/i.test(m)) {
    return 'Upload was cancelled.';
  }

  // Default — helpful but generic
  return 'Upload failed.\nPlease try again.';
}

/**
 * Structured error logger — always emits the full technical detail to the
 * console regardless of dev/prod, so it is always available in logs / Sentry.
 *
 * @param layer  Where the error occurred
 * @param step   Sub-step label for context
 * @param err    The raw Error object or string from the catch block
 * @param extra  Any additional structured data (uploadId, chunkIndex, etc.)
 */
export function logUploadError(
  layer: UploadErrorLayer,
  step: string,
  err: unknown,
  extra?: Record<string, unknown>,
): string {
  const msg = err instanceof Error
    ? `${err.message}${err.stack ? `\n${err.stack}` : ''}`
    : String(err ?? 'Unknown error');

  const fullMsg = `${layer} ${step}: ${msg}`;
  if (__DEV__) console.error(fullMsg, extra ?? {});
  return msg; // raw technical string for use in markFailed / markTimeout
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(bps: number): string {
  if (bps <= 0) return '—';
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatEta(seconds: number): string {
  if (seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
