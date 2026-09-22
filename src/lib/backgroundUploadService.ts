/**
 * backgroundUploadService.ts
 *
 * Production-grade background video upload coordinator.
 *
 * Architecture:
 *   Android: Foreground Service keeps the process alive so JS thread continues
 *            executing chunk uploads while the app is backgrounded.
 *   iOS:     Limited background execution (~30s after backgrounding) + robust
 *            resume on foreground return. Uses BGTaskScheduler for recovery.
 *   Web:     No native background support — uploads pause when tab is hidden.
 *
 * The foreground service shows a persistent notification with upload progress.
 * System notifications provide completion/failure alerts.
 *
 * IMPORTANT: The actual chunk upload still runs in JavaScript (XHR). The
 * foreground service keeps the JS runtime alive so the XHR can complete.
 * On iOS, JS execution stops after ~30s in background, so the upload
 * pauses and resumes when the app returns to foreground.
 */

import { Platform, AppState, AppStateStatus } from 'react-native';
import * as Notifications from 'expo-notifications';
import { type UploadTask, type UploadStatus } from './videoUploadEngine';
import { useUploadQueueStore, currentQueueUserId } from './uploadQueueStore';

// ── Constants ────────────────────────────────────────────────────────────────
const NOTIFICATION_CHANNEL_ID = 'video-upload';
const NOTIFICATION_CHANNEL_NAME = 'Video Uploads';
const FOREGROUND_SERVICE_NOTIFICATION_ID = 'upload-foreground-service';

// ── State ────────────────────────────────────────────────────────────────────
let _isForegroundServiceActive = false;
let _activeUploadCount = 0;
let _appStateSubscription: any = null;
let _initialized = false;

// Timeout (ms) after foregrounding before we check if native uploads are stale.
// If no native progress events arrive within this window, the native service
// may have been killed by the OS, and we need to start recovery.
const NATIVE_ALIVE_CHECK_MS = 30_000;
// Map uploadId → setTimeout handle, so we can cancel if events arrive.
const _aliveCheckTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Notifications Setup ──────────────────────────────────────────────────────

/**
 * Initialize notification channels and handler.
 * Must be called once during app startup (from _layout_app.tsx or similar).
 */
export async function initializeBackgroundUploadNotifications(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Configure how foreground notifications are handled
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  // Create Android notification channel for upload progress
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
      name: NOTIFICATION_CHANNEL_NAME,
      importance: Notifications.AndroidImportance.LOW,
      vibrationPattern: [],
      lightColor: '#3B82F6',
      sound: undefined,
      // Show in notification tray but don't interrupt
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }

  // Start monitoring AppState for background → foreground transitions
  startAppStateMonitoring();
}

// ── AppState Monitoring ───────────────────────────────────────────────────────

function startAppStateMonitoring(): void {
  if (_appStateSubscription) return;

  let previousState: AppStateStatus = AppState.currentState;

  _appStateSubscription = AppState.addEventListener('change', (nextState) => {
    const wasBackgrounded =
      previousState === 'background' || previousState === 'inactive';
    const isNowActive = nextState === 'active';

    // App returned to foreground from background
    if (wasBackgrounded && isNowActive) {
      handleAppForegrounded();
    }

    previousState = nextState;
  });
}

function stopAppStateMonitoring(): void {
  if (_appStateSubscription) {
    _appStateSubscription.remove();
    _appStateSubscription = null;
  }
}

/**
 * Called when the app returns to foreground.
 *
 * IMPORTANT: On Android, the native ForegroundUploadService may still be
 * actively uploading chunks. Marking tasks as 'recovering' would trigger
 * useVideoUploader to start a DUPLICATE upload — the root cause of the
 * 12 MB restart/reset bug.
 *
 * Strategy:
 *   - 'uploading'/'resuming' → leave alone. The native service is likely
 *     still running and will emit progress/complete events. If the native
 *     service has silently died, useVideoUploader's mount reconciliation
 *     (which queries server-side chunk state) will catch it.
 *   - 'processing'/'encoding' → leave alone. VdoCipher polling or assembly
 *     may still be in progress.
 *   - 'paused' → leave alone. User explicitly paused.
 *   - 'recovering' → already being handled by useVideoUploader.
 */
async function handleAppForegrounded(): Promise<void> {
  // Account-isolation: if no authenticated account is active (signed out, or
  // between logout/login), do not schedule recovery for any task — the store
  // is empty and any native events for a prior account must not be re-driven.
  if (!currentQueueUserId()) {
    await stopForegroundServiceIfPossible();
    return;
  }
  const tasks = useUploadQueueStore.getState().tasks;
  const active = tasks.filter(
    (t) =>
      t.status === 'uploading' ||
      t.status === 'processing' ||
      t.status === 'encoding' ||
      t.status === 'paused' ||
      t.status === 'resuming'
  );

  if (__DEV__ && active.length > 0) {
    console.log('[BGUpload] App foregrounded — active tasks:',
      active.map((t) => ({ id: t.id, status: t.status, progress: t.progress })));
  }

  // DO NOT blindly mark tasks as 'recovering'.
  // The native Android service may still be uploading chunks, and marking
  // the task as 'recovering' would cause useVideoUploader to start a
  // duplicate upload, resulting in the 12 MB restart/reset bug.
  //
  // Instead, rely on:
  //   1. Native upload events (progress/complete/error) to update task state.
  //   2. useVideoUploader's mount-time reconciliation to check server-side
  //      chunk state and resume from the correct position if needed.
  //
  // The only exception: if we can definitively determine the native upload
  // is dead (e.g., service was killed by OS), mark for recovery. For now,
  // we let the mount-time check handle this.

  // Schedule alive-check timers: if no native progress events arrive within
  // NATIVE_ALIVE_CHECK_MS, the native service may have been killed by the OS.
  // In that case, mark the task as 'recovering' so useVideoUploader can resume.
  for (const task of active) {
    if (task.status === 'uploading' || task.status === 'resuming') {
      scheduleNativeAliveCheck(task.id, task.lessonId ?? null);
    }
  }

  // Stop foreground JS notification since we're back in foreground
  // (native Kotlin service manages its own notification independently)
  await stopForegroundServiceIfPossible();
}

/**
 * Schedule a check: if no native progress event arrives for this uploadId
 * within NATIVE_ALIVE_CHECK_MS, the native service may be dead.
 * Mark the task as 'recovering' so useVideoUploader can resume from
 * server-side chunk state.
 *
 * If a native event DOES arrive, cancel the timer.
 */
function scheduleNativeAliveCheck(uploadId: string, lessonId: string | null): void {
  // Cancel any existing timer for this uploadId
  cancelNativeAliveCheck(uploadId);

  const timer = setTimeout(() => {
    _aliveCheckTimers.delete(uploadId);

    // Check if the task is still in 'uploading' state — if native events
    // already updated it, this check is a no-op.
    const task = useUploadQueueStore.getState().getTask(uploadId);
    if (!task) return;

    if (task.status === 'uploading' || task.status === 'resuming') {
      if (__DEV__) {
        console.log('[BGUpload] Native alive-check: no events received — marking as recovering',
          { uploadId, status: task.status });
      }
      useUploadQueueStore.getState().updateTask(uploadId, {
        status: 'recovering',
      });
    }
  }, NATIVE_ALIVE_CHECK_MS);

  _aliveCheckTimers.set(uploadId, timer);
}

/**
 * Cancel the alive-check timer for an upload (called when a native event arrives).
 */
export function cancelNativeAliveCheck(uploadId: string): void {
  const timer = _aliveCheckTimers.get(uploadId);
  if (timer) {
    clearTimeout(timer);
    _aliveCheckTimers.delete(uploadId);
  }
}

// ── Foreground Service ───────────────────────────────────────────────────────

/**
 * Start the foreground upload notification.
 *
 * On Android: the native ForegroundUploadService.kt manages its own foreground
 * notification independently. We do NOT create a duplicate JS notification here.
 * On iOS: the native BackgroundUploadHandler manages its own UNUserNotification.
 * On Web: we use expo-notifications to show a persistent banner.
 */
export async function startForegroundServiceIfPossible(
  uploadTask: UploadTask
): Promise<void> {
  _activeUploadCount++;

  // On Android/iOS, the native service manages its own notification.
  // Only show JS notification on web where no native service exists.
  if (Platform.OS === 'web') {
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: FOREGROUND_SERVICE_NOTIFICATION_ID,
        content: {
          title: 'Uploading video…',
          body: `${uploadTask.fileName} — ${uploadTask.progress}%`,
          data: { uploadId: uploadTask.id, type: 'foreground_upload' },
          sound: false,
        },
        trigger: null,
      });
      _isForegroundServiceActive = true;
    } catch (e) {
      if (__DEV__) console.warn('[BGUpload] Failed to start foreground notification', e);
    }
  }
}/**
 * Update the foreground service notification with current upload progress.
 * On Android/iOS, native service manages its own — skip here.
 */
export async function updateForegroundServiceNotification(
  uploadId: string,
  fileName: string,
  progress: number,
  status: UploadStatus
): Promise<void> {
  // Native services (Android ForegroundUploadService, iOS BackgroundUploadHandler)
  // manage their own notifications. Only update on web.
  if (Platform.OS !== 'web') return;
  if (!_isForegroundServiceActive) return;

  const statusLabels: Record<string, string> = {
    uploading: 'Uploading',
    processing: 'Processing',
    encoding: 'Encoding',
    paused: 'Paused',
    resuming: 'Resuming',
  };

  const label = statusLabels[status] ?? 'Working';

  try {
    await Notifications.scheduleNotificationAsync({
      identifier: FOREGROUND_SERVICE_NOTIFICATION_ID,
      content: {
        title: `${label} video…`,
        body: `${fileName} — ${progress}%`,
        data: { uploadId, type: 'foreground_upload' },
        sound: false,
      },
      trigger: null,
    });
  } catch (e) {
    if (__DEV__) console.warn('[BGUpload] Failed to update foreground notification', e);
  }
}

/**
 * Stop the foreground service notification.
 * On Android/iOS, native service manages its own — skip here.
 */
export async function stopForegroundServiceIfPossible(): Promise<void> {
  _activeUploadCount = Math.max(0, _activeUploadCount - 1);

  // Only stop if no active uploads remain
  if (_activeUploadCount > 0) return;

  // Native services (Android/iOS) manage their own notification lifecycle.
  // Only dismiss on web.
  if (Platform.OS !== 'web') {
    _isForegroundServiceActive = false;
    return;
  }

  if (_isForegroundServiceActive) {
    try {
      await Notifications.dismissNotificationAsync(
        FOREGROUND_SERVICE_NOTIFICATION_ID
      );
    } catch (e) {
      // Non-fatal
    }
    _isForegroundServiceActive = false;

    if (__DEV__) {
      console.log('[BGUpload] Foreground service notification stopped');
    }
  }
}

// ── System Notifications ─────────────────────────────────────────────────────

/**
 * Show a completion notification (system-level, outside the app).
 * Tapping it should navigate to the upload queue / video library.
 */
export async function showUploadCompleteNotification(
  uploadId: string,
  fileName: string
): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Upload complete',
        body: `${fileName} has been uploaded successfully.`,
        data: { uploadId, type: 'upload_complete', screen: 'video-library' },
        sound: true,
        ...(Platform.OS === 'android'
          ? { channelId: NOTIFICATION_CHANNEL_ID }
          : {}),
      },
      trigger: null,
    });
  } catch (e) {
    if (__DEV__) {
      console.warn('[BGUpload] Failed to show completion notification', e);
    }
  }
}

/**
 * Show a failure notification.
 */
export async function showUploadFailedNotification(
  uploadId: string,
  fileName: string,
  errorMessage: string
): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Upload failed',
        body: `${fileName} — Tap to retry`,
        data: {
          uploadId,
          type: 'upload_failed',
          error: errorMessage,
          screen: 'upload-queue',
        },
        sound: true,
        ...(Platform.OS === 'android'
          ? { channelId: NOTIFICATION_CHANNEL_ID }
          : {}),
      },
      trigger: null,
    });
  } catch (e) {
    if (__DEV__) {
      console.warn('[BGUpload] Failed to show failure notification', e);
    }
  }
}

/**
 * Show a processing timeout notification.
 */
export async function showProcessingTimeoutNotification(
  uploadId: string,
  fileName: string
): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Processing timed out',
        body: `${fileName} — Tap to retry processing`,
        data: {
          uploadId,
          type: 'processing_timeout',
          screen: 'upload-queue',
        },
        sound: true,
        ...(Platform.OS === 'android'
          ? { channelId: NOTIFICATION_CHANNEL_ID }
          : {}),
      },
      trigger: null,
    });
  } catch (e) {
    if (__DEV__) {
      console.warn('[BGUpload] Failed to show timeout notification', e);
    }
  }
}

// ── App Resume Recovery ───────────────────────────────────────────────────────

/**
 * Check for interrupted uploads and queue them for recovery.
 * Called from the useVideoUploader hook on mount.
 */
export async function checkForInterruptedUploads(): Promise<UploadTask[]> {
  const tasks = useUploadQueueStore.getState().tasks;

  return tasks.filter(
    (t) =>
      t.status === 'uploading' ||
      t.status === 'processing' ||
      t.status === 'encoding' ||
      t.status === 'paused' ||
      t.status === 'resuming' ||
      t.status === 'recovering'
  );
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Clean up resources. Called on app shutdown.
 */
export function cleanupBackgroundUploadService(): void {
  stopAppStateMonitoring();
  _initialized = false;
  _isForegroundServiceActive = false;
  _activeUploadCount = 0;
}

// ── Utility ──────────────────────────────────────────────────────────────────

/**
 * Check if background upload is supported on this platform.
 */
export function isBackgroundUploadSupported(): boolean {
  return Platform.OS === 'android' || Platform.OS === 'ios';
}

/**
 * Get platform-specific background upload limitations.
 */
export function getBackgroundUploadLimits(): {
  platform: string;
  maxBackgroundTimeSeconds: number | null;
  supportsForegroundService: boolean;
  supportsBackgroundNetwork: boolean;
  notes: string;
} {
  if (Platform.OS === 'android') {
    return {
      platform: 'android',
      maxBackgroundTimeSeconds: null, // Unlimited with foreground service
      supportsForegroundService: true,
      supportsBackgroundNetwork: true,
      notes:
        'Foreground service keeps JS thread alive. Upload continues as long as the service runs.',
    };
  }

  if (Platform.OS === 'ios') {
    return {
      platform: 'ios',
      maxBackgroundTimeSeconds: 30, // ~30 seconds of additional background time
      supportsForegroundService: false,
      supportsBackgroundNetwork: false,
      notes:
        'iOS gives ~30s of background execution after backgrounding. Upload pauses and resumes when app returns to foreground.',
    };
  }

  return {
    platform: 'web',
    maxBackgroundTimeSeconds: 0,
    supportsForegroundService: false,
    supportsBackgroundNetwork: false,
    notes: 'Web uploads pause when the browser tab is hidden or backgrounded.',
  };
}
