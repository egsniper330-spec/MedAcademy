/**
 * nativeUploadBridge.ts
 *
 * JavaScript bridge to the native upload service on both Android and iOS.
 *
 * Android: communicates with NativeUploadBridge (Kotlin) which starts
 * the ForegroundUploadService. The service performs HTTP chunk uploads
 * natively in a foreground service, surviving JavaScript suspension.
 *
 * iOS: communicates with NativeUploadBridge (Swift) which starts a
 * URLSession background upload. The OS continues uploading chunks even
 * when the app is suspended. When all chunks are uploaded, the native
 * code triggers assembly + VdoCipher polling + finalization natively.
 *
 * Web: returns isNativeUploadAvailable = false. The existing JavaScript
 * XHR chunk upload pipeline is used instead.
 *
 * Events received from native (both platforms):
 *   nativeUploadEvent: { uploadId, event, ... }
 *     event = "progress" | "complete" | "error" | "cancelled"
 *            | "assembly_complete" | "processing"
 */

import { Platform, NativeModules, DeviceEventEmitter } from 'react-native';

const { NativeUploadBridge } = NativeModules;

// ── Types ────────────────────────────────────────────────────────────────────

export interface NativeUploadConfig {
  uploadId: string;
  fileUri: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  startChunk: number;
  apiUrl: string;
  authToken: string;
  refreshToken: string;
  lessonId: string | null;
  courseId: string | null;
  doctorId: string | null;
}

export interface NativeUploadProgressEvent {
  uploadId: string;
  event: 'progress';
  chunksCompleted: number;
  totalChunks: number;
  bytesUploaded: number;
  totalBytes: number;
  progress: number;
}

export interface NativeUploadCompleteEvent {
  uploadId: string;
  event: 'complete';
  videoId?: string;
}

export interface NativeUploadErrorEvent {
  uploadId: string;
  event: 'error';
  message: string;
}

export interface NativeUploadCancelledEvent {
  uploadId: string;
  event: 'cancelled';
}

export interface NativeUploadAssemblyEvent {
  uploadId: string;
  event: 'assembly_complete';
  videoId: string;
}

export interface NativeUploadProcessingEvent {
  uploadId: string;
  event: 'processing';
  status: string;
}

export type NativeUploadEvent =
  | NativeUploadProgressEvent
  | NativeUploadCompleteEvent
  | NativeUploadErrorEvent
  | NativeUploadCancelledEvent
  | NativeUploadAssemblyEvent
  | NativeUploadProcessingEvent;

// ── Platform Detection ───────────────────────────────────────────────────────

/**
 * Check if native foreground/background upload is available on this platform.
 * Returns true on both Android (foreground service) and iOS (URLSession background).
 * Returns false on web.
 */
export async function isNativeUploadAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  if (!NativeUploadBridge) return false;

  try {
    return await NativeUploadBridge.isNativeUploadAvailable();
  } catch {
    return false;
  }
}

/**
 * Get the platform-specific description for logging.
 */
export function getNativePlatform(): string {
  switch (Platform.OS) {
    case 'android': return 'Android ForegroundService';
    case 'ios': return 'iOS URLSession Background';
    default: return 'Web (JS only)';
  }
}

// ── Start native upload ──────────────────────────────────────────────────────

/**
 * Start the native upload service on the current platform.
 *
 * Android: Starts a foreground service that performs native HTTP chunk uploads.
 * iOS: Starts a URLSession background upload that survives app suspension.
 *
 * The native module handles:
 *   - Chunk upload (both platforms)
 *   - Assembly trigger (both platforms)
 *   - VdoCipher status polling (iOS — when JS is suspended)
 *   - video_assets creation (iOS — when JS is suspended)
 *   - Progress reporting to JS
 *
 * @returns true if the native upload was started
 * @throws if the native module is unavailable
 */
export async function startNativeUpload(config: NativeUploadConfig): Promise<boolean> {
  if (!NativeUploadBridge) {
    throw new Error('NativeUploadBridge not available — use JS upload pipeline');
  }

  return await NativeUploadBridge.startUpload({
    uploadId: config.uploadId,
    fileUri: config.fileUri,
    fileName: config.fileName,
    mimeType: config.mimeType,
    fileSize: config.fileSize,
    chunkSize: config.chunkSize,
    totalChunks: config.totalChunks,
    startChunk: config.startChunk,
    apiUrl: config.apiUrl,
    authToken: config.authToken,
    refreshToken: config.refreshToken,
    lessonId: config.lessonId ?? '',
    courseId: config.courseId ?? '',
    doctorId: config.doctorId ?? '',
  });
}

// ── Cancel native upload ─────────────────────────────────────────────────────

/**
 * Cancel an active native upload on either platform.
 */
export async function cancelNativeUpload(uploadId: string): Promise<boolean> {
  if (!NativeUploadBridge) return false;

  try {
    return await NativeUploadBridge.cancelUpload(uploadId);
  } catch {
    return false;
  }
}

// ── Event listeners ──────────────────────────────────────────────────────────

type NativeUploadEventListener = (event: NativeUploadEvent) => void;

const listeners = new Map<string, Set<NativeUploadEventListener>>();
let globalSubscription: { remove: () => void } | null = null;

/**
 * Subscribe to native upload events for a specific uploadId.
 * Returns an unsubscribe function.
 *
 * On iOS, this is especially important because the native code handles
 * the complete pipeline (assembly + VdoCipher + finalization) while
 * JS is suspended. Events are delivered when JS becomes available again.
 */
export function onNativeUploadEvent(
  uploadId: string,
  callback: NativeUploadEventListener,
): () => void {
  if (!listeners.has(uploadId)) {
    listeners.set(uploadId, new Set());
  }
  listeners.get(uploadId)!.add(callback);

  // Set up the global DeviceEventEmitter listener (once)
  if (!globalSubscription) {
    globalSubscription = DeviceEventEmitter.addListener(
      'nativeUploadEvent',
      (event: NativeUploadEvent) => {
        const uploadId = event.uploadId;
        const callbacks = listeners.get(uploadId);
        if (callbacks) {
          for (const cb of callbacks) {
            try {
              cb(event);
            } catch (e) {
              if (__DEV__) console.warn('[nativeUploadBridge] listener error', e);
            }
          }
        }
      }
    );
  }

  return () => {
    const callbacks = listeners.get(uploadId);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        listeners.delete(uploadId);
      }
    }
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the backend API base URL from the PHP client configuration.
 */
export async function getApiBaseForNative(): Promise<string> {
  const { backendApiBase } = await import('@/client/backendClient');
  return backendApiBase;
}

/**
 * Get the current auth token from the PHP client.
 */
export async function getAuthTokenForNative(): Promise<string> {
  const { backendClient } = await import('@/client/backendClient');
  const session = await backendClient.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error('Not authenticated — cannot start native upload');
  return token;
}

/**
 * Get the current refresh token from the PHP client session.
 * The native uploader needs this to refresh the access token during
 * long-running background uploads.
 */
export async function getRefreshTokenForNative(): Promise<string> {
  const { backendClient } = await import('@/client/backendClient');
  const session = await backendClient.auth.getSession();
  const refreshToken = session.data.session?.refresh_token;
  if (!refreshToken) throw new Error('No refresh token — cannot start native upload');
  return refreshToken;
}
