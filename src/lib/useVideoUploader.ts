/**
 * useVideoUploader.ts
 * React hook that drives the upload lifecycle for a single UploadTask.
 *
 * UPLOAD PIPELINE (chunked — each step must succeed before the next):
 *   1. stabiliseUri          → copy content:// → file:// (Android, no-op on iOS/web)
 *   2. uploadVideoInChunks   → read file in 8 MB slices, POST each to video-upload-chunk EF
 *                              Supports pause (AbortController) and resume (startChunkIndex)
 *   3. triggerChunkAssembly  → synchronous EF call: assembles chunks, creates VdoCipher entry,
 *                              streams to S3, marks status='processing', returns video_id
 *   4. pollVdoCipherReady    → poll /vdocipher-upload-status every POLL_INTERVAL_MS
 *                              until VdoCipher reports status='ready' (timeout → 'timeout')
 *   5. updateLessonVideoStatus with VdoCipher video_id
 *
 * Video files are NEVER uploaded to PHP object storage directly; they use the VdoCipher pipeline.
 * Chunks are stored temporarily in the video-chunks bucket and cleaned up after assembly.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useUploadQueueStore, getXhr, removeXhr, getAbortController, removeAbortController } from './uploadQueueStore';
import {
  updateUploadRecord,
  insertAuditLog,
  updateLessonVideoStatus,
  clearLessonVideoRef,
  generateVideoThumbnail,
  getVideoDurationSeconds,
  uploadThumbnailToStorage,
  sanitizeUploadError,
  formatUploadError,
  logUploadError,
  type UploadErrorLayer,
  type UploadTask,
} from './videoUploadEngine';
import * as FileSystem from 'expo-file-system';
import {
  getVdoCipherVideoStatus,
  pingUploadSessionHeartbeat,
  recoverStaleUploadSessions,
  getLessonVideoState,
  getChunkUploadState,
  triggerChunkAssembly,
  deleteVdoCipherVideo,
  cancelVdoCipherUpload,
} from './api';
import { uploadVideoInChunks, stabiliseUri } from './vdoCipherUpload';
import { pushNotification } from './uploadNotificationStore';
import {
  initializeBackgroundUploadNotifications,
  startForegroundServiceIfPossible,
  updateForegroundServiceNotification,
  stopForegroundServiceIfPossible,
  showUploadCompleteNotification,
  showUploadFailedNotification,
  showProcessingTimeoutNotification,
  cancelNativeAliveCheck,
} from './backgroundUploadService';
import {
  isNativeUploadAvailable,
  startNativeUpload,
  cancelNativeUpload,
  onNativeUploadEvent,
  getApiBaseForNative,
  getAuthTokenForNative,
  getRefreshTokenForNative,
  type NativeUploadEvent,
} from './nativeUploadBridge';
import { currentQueueUserId } from './uploadQueueStore';

const POLL_INTERVAL_MS = 5_000;          // check every 5 s
const POLL_TIMEOUT_MS  = 10 * 60 * 1000; // 10-minute hard deadline per requirement

// ── Module-level deduplication guard ─────────────────────────────────────────
// useVideoUploader() is called by MULTIPLE mounted components simultaneously
// (UploadFAB in root layout, UploadItemCard per task, RecoveryDialog, lesson-editor).
// Each instance has its own React ref, so a per-instance Set is invisible to the
// others — all N instances independently pick the same waiting task and call
// startUpload() N times concurrently.
//
// Fix: one module-level Set shared across every hook instance in the JS bundle.
// The first instance to evaluate the useEffect adds the id and calls startUpload;
// subsequent instances see it already present and bail immediately.
const globalProcessingSet = new Set<string>();

// Account-isolation checkpoint: returns true only while the task still exists
// for the CURRENT session and isn't canceled. A vanished task means the owner
// logged out, the account switched, or the user removed it — the pipeline must
// stop at the next checkpoint instead of continuing backend work under a
// different account's token.
function taskAlive(id: string): boolean {
  const t = useUploadQueueStore.getState().getTask(id);
  return !!t && t.status !== 'canceled';
}

// ─── Step 4: poll VdoCipher until encoding is complete ───────────────────────
async function pollVdoCipherReady(
  videoId: string,
  uploadId: string,
  onStage: (stage: 'processing' | 'encoding') => void,
): Promise<{
  duration: number | null;
  poster: string | null;
}> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastLoggedStatus = '';

  // ── Immediate first check — don't wait 5 s if VdoCipher already finished ─
  // After assembly, VdoCipher may have already processed a short video.
  // Check instantly before entering the polling loop.
  {
    let result: Awaited<ReturnType<typeof getVdoCipherVideoStatus>>;
    try {
      result = await getVdoCipherVideoStatus(videoId);
      if (result.status === 'ready') {
        await insertAuditLog(uploadId, 'vdocipher_encoding_complete', {
          videoId,
          duration: result.duration,
          vdo_status: result.vdo_status,
        });
        return { duration: result.duration, poster: result.poster };
      }
      if (result.status === 'failed') {
        await insertAuditLog(uploadId, 'vdocipher_encoding_failed', {
          videoId, vdo_status: result.vdo_status, error: result.error,
        });
        throw new Error(`VdoCipher encoding failed: ${result.vdo_status}${result.error ? ' — ' + result.error : ''}`);
      }
      if (result.status === 'processing' || result.status === 'encoding') {
        onStage(result.status);
      }
      lastLoggedStatus = result.vdo_status;
    } catch (e: any) {
      // First poll failed — continue to the interval loop
      if (__DEV__) console.warn('[pollVdoCipherReady] first poll failed, will retry in loop', {
        videoId, error: e?.message,
      });
    }
  }

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let result: Awaited<ReturnType<typeof getVdoCipherVideoStatus>>;
    try {
      result = await getVdoCipherVideoStatus(videoId);
    } catch (e: any) {
      if (__DEV__) console.warn('[pollVdoCipherReady] status call failed, retrying', {
        videoId, error: e?.message,
      });
      continue;
    }

    if (result.vdo_status !== lastLoggedStatus) {
      lastLoggedStatus = result.vdo_status;
    }

    if (result.status === 'ready') {
      await insertAuditLog(uploadId, 'vdocipher_encoding_complete', {
        videoId,
        duration: result.duration,
        vdo_status: result.vdo_status,
      });
      return { duration: result.duration, poster: result.poster };
    }

    if (result.status === 'failed') {
      await insertAuditLog(uploadId, 'vdocipher_encoding_failed', {
        videoId, vdo_status: result.vdo_status, error: result.error,
      });
      throw new Error(`VdoCipher encoding failed: ${result.vdo_status}${result.error ? ' — ' + result.error : ''}`);
    }

    // Still processing/encoding — notify UI and loop
    if (result.status === 'processing' || result.status === 'encoding') {
      onStage(result.status);
    }

    await updateUploadRecord(uploadId, { status: result.status });
  }

  throw new Error(
    `VdoCipher encoding timed out after ${POLL_TIMEOUT_MS / 60000} minutes (video_id: ${videoId})`
  );
}

export function useVideoUploader() {
  const { tasks, updateTask, recoveryChecked, setRecoveryChecked, setShowRecoveryDialog } =
    useUploadQueueStore();
  // processingRef intentionally removed — deduplication is now handled by the
  // module-level globalProcessingSet so all hook instances share one guard.
  const heartbeatRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeUploadId = useRef<string | null>(null);

  // ── Initialize background upload notifications on first mount ──────────────
  useEffect(() => {
    initializeBackgroundUploadNotifications();
  }, []);

  // ── Heartbeat: ping upload_sessions every 15 s during active upload ───────
  // This prevents orphan-cleanup from treating a live upload as abandoned.
  const startHeartbeat = useCallback((uploadId: string) => {
    stopHeartbeat();
    activeUploadId.current = uploadId;
    heartbeatRef.current = setInterval(() => {
      pingUploadSessionHeartbeat(uploadId).catch(() => {});
    }, 15_000);
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    activeUploadId.current = null;
  }, []);

  // ── Upload lock recovery on first mount ───────────────────────────────────
  // Scans the DB for sessions left in uploading/processing/encoding with a
  // stale heartbeat (> 60 s). These indicate crashes, reboots, or JS reloads.
  // Each stale session is matched against the local queue:
  //   - Found in queue as 'uploading'/'processing'/'encoding'  → mark 'recovering'
  //   - Not found in queue (state lost)                        → mark 'failed' + clear lesson
  useEffect(() => {
    if (recoveryChecked) return;
    setRecoveryChecked(true);

    // Account-isolation: capture the owner at scan start. If the account
    // switches while the async DB scan below is in flight, its results must
    // NOT be committed into the new account's queue.
    const scanOwner = currentQueueUserId();

    (async () => {
      // 0. Wait for the persisted queue to finish rehydrating. The store is
      // created before hydration resolves, so running the scans against the
      // not-yet-loaded (empty) task list would miss post-restart tasks.
      if (!useUploadQueueStore.persist.hasHydrated()) {
        await new Promise<void>((resolve) => {
          const unsub = useUploadQueueStore.persist.onFinishHydration(() => {
            unsub();
            resolve();
          });
        });
      }

      // 1. Local queue recovery (existing logic — catches in-memory stale tasks).
      // Tasks that already reached the provider (vdoCipherVideoId set) are NOT
      // byte-recovery candidates — reconciliation below owns them ("Resume"
      // would needlessly re-upload a fully transferred file).
      const localRecoverable = useUploadQueueStore.getState().tasks.filter(
        (t) => t.status === 'recovering' && !t.vdoCipherVideoId,
      );
      if (localRecoverable.length > 0) {
        setShowRecoveryDialog(true);
        localRecoverable.forEach((t) => {
          updateUploadRecord(t.id, { recovery_state: 'interrupted' });
          insertAuditLog(t.id, 'recovery_detected');
        });
      }

      // 1.5 Post-upload reconciliation — self-heal tasks stranded between
      // "encoding" and "ready". If a finalization sequence was interrupted
      // (crash/reload/transient write failure) the lesson may already be
      // durably READY while the local task still says processing/encoding.
      // The lesson row is the AUTHORITATIVE source for the handoff outcome:
      //   - lesson video_status = 'ready'  → task is final → mark task 'ready'
      //     (idempotent; matches the pipeline's post-lesson ordering).
      //   - lesson video_status in the pre-handoff set AND the provider asset
      //     reports 'ready'                → finalization never completed →
      //     route through retryProcessing (guarded) instead of a dead-end.
      //   - otherwise                       → leave for lock recovery / user.
      const postUpload = useUploadQueueStore.getState().tasks.filter(
        (t) =>
          ['processing', 'encoding', 'generating_streams', 'verifying'].includes(t.status) ||
          // Post-restart stranded tasks: rehydration maps mid-flight statuses to
          // 'recovering', but a task that already reached the provider (assembly
          // returned a video id) has NO bytes left to resume — its correct path
          // is processing reconciliation, not a chunk re-upload via "Resume".
          (t.status === 'recovering' && !!t.vdoCipherVideoId),
      );
      for (const t of postUpload) {
        try {
          if (!t.lessonId) continue;
          const lessonState = await getLessonVideoState(t.lessonId);
          if (!lessonState) continue;
          if (lessonState.video_status === 'ready' && lessonState.video_upload_id === t.id) {
            // Authoritative handoff already happened — task must be terminal.
            updateTask(t.id, { status: 'ready', progress: 100, verificationStatus: 'passed' });
            await insertAuditLog(t.id, 'reconciliation_task_finalized', {
              lesson_status: lessonState.video_status, provider_video_id: lessonState.video_id,
            });
            continue;
          }
          if (
            lessonState.video_status === 'ready' &&
            lessonState.video_upload_id !== t.id
          ) {
            // Lesson is final but linked to a DIFFERENT upload — this task was
            // superseded (e.g. the video was replaced). It must not linger in
            // the active queue forever; 'canceled' is honest and removable.
            updateTask(t.id, {
              status: 'canceled',
              errorMessage: 'Superseded: the lesson now uses a different video.',
            });
            await insertAuditLog(t.id, 'reconciliation_task_superseded', {
              lesson_status: lessonState.video_status,
              current_video_upload_id: lessonState.video_upload_id,
            });
            continue;
          }
          const PRE_HANDOFF = new Set(['none', 'uploading', 'processing', 'encoding', 'timeout']);
          if (
            PRE_HANDOFF.has(lessonState.video_status) &&
            t.vdoCipherVideoId &&
            lessonState.video_upload_id === t.id
          ) {
            // Encoding may already be finished provider-side; retryProcessing
            // polls the provider and finalizes (idempotent) or marks timeout.
            updateTask(t.id, { status: 'encoding', errorMessage: undefined });
            retryProcessing(t.id).catch(() => {});
          }
        } catch (e) {
          if (__DEV__) console.warn('[uploadLockRecovery] post-upload reconciliation failed (non-fatal)', {
            taskId: t.id, error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // 2. DB-level lock recovery — catches sessions surviving app restart
      //    (scoped to the owning account's session — see scanOwner guard below)
      try {
        const staleSessions = await recoverStaleUploadSessions(60);
        if (staleSessions.length === 0) return;

        // Account switched during the scan → abandon results entirely.
        if (scanOwner && currentQueueUserId() !== scanOwner) {
          if (__DEV__) console.warn('[uploadLockRecovery] account switched during scan — discarding results');
          return;
        }

        const queueState = useUploadQueueStore.getState();
        const activeStatuses = new Set(['uploading', 'processing', 'encoding', 'waiting', 'paused']);

        for (const session of staleSessions) {
          const { upload_id, lesson_id, provider_video_id, status } = session;
          if (!upload_id) continue;

          const localTask = queueState.getTask(upload_id);

          if (localTask && activeStatuses.has(localTask.status)) {
            // Task exists locally but was left mid-flight — mark as recovering
            updateTask(upload_id, { status: 'recovering' });
            await updateUploadRecord(upload_id, {
              status: 'recovering' as any,
              recovery_state: 'lock_recovered',
            });
            await insertAuditLog(upload_id, 'lock_recovery_recovering', {
              stale_status: status, provider_video_id,
            });
            setShowRecoveryDialog(true);
          } else if (!localTask) {
            // Task not in local queue — app was killed; mark failed
            await updateUploadRecord(upload_id, {
              status: 'failed',
              error_message: 'Upload interrupted by app crash or device restart.',
              recovery_state: 'lock_failed',
            });
            // Clear lesson ref so lesson isn't stuck showing "uploading"
            if (lesson_id) {
              await updateLessonVideoStatus(lesson_id, upload_id, 'failed');
            }
            await insertAuditLog(upload_id, 'lock_recovery_failed', {
              stale_status: status, provider_video_id,
              reason: 'task_not_in_local_queue',
            });
            if (__DEV__) console.warn('[uploadLockRecovery] task not in queue — marked failed', {
              upload_id, stale_status: status,
            });
          }
        }
      } catch (e) {
        if (__DEV__) console.warn('[uploadLockRecovery] DB scan failed (non-fatal):', e);
      }
    })();
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pick next waiting task ─────────────────────────────────────────────────
  useEffect(() => {
    const waiting = tasks.find((t) => t.status === 'waiting');
    if (!waiting || globalProcessingSet.has(waiting.id)) return;
    // Account-isolation guard: never drive a task owned by a different
    // account than the currently-authenticated session.
    const sessionUser = currentQueueUserId();
    if (sessionUser && waiting.ownerUserId && waiting.ownerUserId !== sessionUser) {
      if (__DEV__) console.warn('[useVideoUploader] skipping cross-account task', { id: waiting.id });
      return;
    }
    globalProcessingSet.add(waiting.id);
    startUpload(waiting);
  }, [tasks]);

  const startUpload = async (task: UploadTask) => {
    const { id, courseId, lessonId, fileUri, fileName, mimeType, fileSize, retryCount } = task;
    startHeartbeat(id);

    // Start foreground service notification for background upload
    await startForegroundServiceIfPossible(task);

    updateTask(id, { status: 'uploading' });
    await updateUploadRecord(id, {
      status: 'uploading',
      upload_started_at: new Date().toISOString(),
      retry_count: retryCount,
      recovery_state: 'none',
    });
    await insertAuditLog(id, retryCount > 0 ? 'upload_resumed' : 'upload_started');
    if (lessonId) await updateLessonVideoStatus(lessonId, id, 'uploading');
    pushNotification({
      uploadId: id, type: 'upload_started', fileName,
      message: 'Your video is being uploaded.',
    });

    // ── URI stabilisation: content:// → file:// ─────────────────────────────
    let stableFileUri = fileUri;
    try {
      stableFileUri = await stabiliseUri(fileUri, id, fileName);
    } catch (stabiliseErr) {
      const techMsg = logUploadError('[RN]', 'URI stabilisation failed', stabiliseErr, {
        uploadId: id, original_uri: fileUri,
      });
      globalProcessingSet.delete(id);
      await markFailed(id, lessonId, techMsg, 'uri_stabilisation', '[RN]');
      return;
    }

    // Release the processing slot before going async into the pipeline
    globalProcessingSet.delete(id);

    // Run the chunked VdoCipher pipeline. Fire-and-forget, but an unhandled
    // rejection here would silently kill the task's state machine (stuck at
    // whatever stage it reached) — catch and route to markFailed.
    runVdoCipherPipeline({
      id, courseId, lessonId,
      doctorId: task.doctorId,
      fileUri: stableFileUri,
      fileName,
      mimeType,
      fileSize: fileSize ?? 0,
    }).catch(async (e) => {
      if (!taskAlive(id)) return;
      const techMsg = logUploadError('[EF:pipeline]', 'Unexpected pipeline error', e, { uploadId: id });
      await markFailed(id, lessonId, techMsg, 'pipeline', '[EF:pipeline]').catch(() => {});
    });
  };

  // ── STEPS 1–4: Chunked upload + assembly + encoding + lesson update ─────────
  const runVdoCipherPipeline = async (params: {
    id: string;
    courseId: string | null;
    lessonId: string | null;
    doctorId?: string;
    fileUri: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
  }) => {
    const { id, courseId, lessonId, doctorId, fileUri, fileName, mimeType, fileSize } = params;

    // ── STEP 1: Calculate chunk plan + check for resume ──────────────────────
    const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB per chunk
    const totalChunks = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));

    // Check if this upload has already partially completed (resume scenario)
    let startChunkIndex = 0;
    let resuming = false;

    try {
      const state = await getChunkUploadState(id);
      if (state && state.chunks_completed > 0 && !state.assembly_triggered) {
        startChunkIndex = state.chunks_completed;
        resuming = true;
        if (__DEV__) console.log('[runVdoCipherPipeline] Resuming from chunk', { startChunkIndex, totalChunks });
      } else if (state?.assembly_triggered) {
        // Assembly already triggered — skip to assembly step
        updateTask(id, { status: 'processing', progress: 70 });
        await updateUploadRecord(id, { status: 'processing' });
        // Fall through to assembly call below (it's idempotent)
        startChunkIndex = totalChunks; // skip chunk loop
      }
    } catch (stateErr) {
      if (__DEV__) console.warn('[runVdoCipherPipeline] could not fetch chunk state (non-fatal):', stateErr);
    }

    const uploadStatus = resuming ? 'resuming' : 'uploading';
    updateTask(id, {
      status: uploadStatus,
      progress: resuming ? Math.round((startChunkIndex / totalChunks) * 65) : 2,
      totalChunks,
      chunksCompleted: startChunkIndex,
      chunkSizeBytes: CHUNK_SIZE,
    });
    await updateUploadRecord(id, {
      status: uploadStatus as any,
      upload_started_at: new Date().toISOString(),
      ...(resuming ? {} : { retry_count: useUploadQueueStore.getState().getTask(id)?.retryCount ?? 0 }),
    });
    await insertAuditLog(id, resuming ? 'chunk_upload_started' : 'upload_started', {
      totalChunks, startChunkIndex, fileSize,
    });

    // ── STEP 2: Upload chunks (skip on already-assembled) ────────────────────
    if (startChunkIndex < totalChunks) {
      // Check if native foreground upload is available (Android only)
      const useNative = await isNativeUploadAvailable().catch(() => false);

      if (useNative) {
        // ── NATIVE PATH: Android foreground service ──────────────────────
        // The native service performs HTTP chunk uploads in a foreground service,
        // which keeps the upload alive when the user backgrounds the app.
        if (__DEV__) console.log('[runVdoCipherPipeline] Using NATIVE upload path', { id });

        try {
          const apiUrl = await getApiBaseForNative();
          const authToken = await getAuthTokenForNative();
          const refreshToken = await getRefreshTokenForNative();

          await startNativeUpload({
            uploadId: id,
            fileUri,
            fileName: sanitize(fileName),
            mimeType,
            fileSize,
            chunkSize: CHUNK_SIZE,
            totalChunks,
            startChunk: startChunkIndex,
            apiUrl,
            authToken,
            refreshToken,
            lessonId: lessonId ?? null,
            courseId: courseId ?? null,
            doctorId: useUploadQueueStore.getState().getTask(id)?.doctorId ?? null,
          });

          // Wait for native upload completion via events
          await new Promise<void>((resolve, reject) => {
            const unsubscribe = onNativeUploadEvent(id, (event: NativeUploadEvent) => {
              // Stale-callback guard: if the account switched while this
              // native upload was in flight, its events must not mutate the
              // new account's queue state. The native service keeps running
              // (server-side ownership is unchanged); we simply stop listening.
              const sessionUser = currentQueueUserId();
              const taskOwner = useUploadQueueStore.getState().getTask(id)?.ownerUserId;
              if (sessionUser && taskOwner && taskOwner !== sessionUser) {
                unsubscribe();
                resolve(); // treat as ended — no error, no state mutation
                return;
              }
              switch (event.event) {
                case 'progress': {
                  // Native service is alive — cancel the alive-check timer
                  cancelNativeAliveCheck(id);
                  const chunkPct = event.totalChunks > 0 ? event.chunksCompleted / event.totalChunks : 0;
                  const displayPct = 2 + Math.round(chunkPct * 63);
                  updateTask(id, {
                    progress: displayPct,
                    bytesUploaded: event.bytesUploaded,
                    speedBps: 0,
                    etaSeconds: 0,
                    chunksCompleted: event.chunksCompleted,
                    totalChunks: event.totalChunks,
                  });
                  if (event.chunksCompleted % 5 === 0 || event.chunksCompleted === event.totalChunks) {
                    pushNotification({
                      uploadId: id, type: 'upload_progress', fileName,
                      message: `Uploading (${displayPct}%)`,
                      progress: displayPct,
                    });
                    updateForegroundServiceNotification(id, fileName, displayPct, 'uploading');
                  }
                  break;
                }
                case 'complete':
                  cancelNativeAliveCheck(id);
                  unsubscribe();
                  resolve();
                  break;
                case 'error':
                  cancelNativeAliveCheck(id);
                  unsubscribe();
                  reject(new Error(event.message));
                  break;
                default:
                  break;
              }
            });
          });

          await insertAuditLog(id, 'vdocipher_s3_upload_completed', {
            totalChunks, message: 'native upload completed',
          });
          pushNotification({
            uploadId: id, type: 'upload_completed', fileName,
            message: 'Upload completed successfully. Video is now processing.',
          });

        } catch (e: any) {
          if (e?.message?.includes('cancel') || e?.message?.includes('abort')) {
            if (__DEV__) console.log('[runVdoCipherPipeline] native upload cancelled', { id });
            return;
          }
          const techMsg = logUploadError('[EF:video-upload-chunk]', 'Native chunk upload failed', e, {
            uploadId: id,
          });
          await markFailed(id, lessonId, techMsg, 'chunk_upload', '[EF:video-upload-chunk]');
          return;
        }
      } else {
        // ── JS PATH: XHR chunk upload (web, iOS fallback) ───────────────
        if (__DEV__) console.log('[runVdoCipherPipeline] Using JS upload path', { id });

        try {
          await uploadVideoInChunks({
            fileUri,
            fileName: sanitize(fileName),
            mimeType,
            fileSize,
            uploadId: id,
            startChunkIndex,
            chunkSizeBytes: CHUNK_SIZE,
            onProgress: ({ chunksCompleted, totalChunks: total, bytesUploaded, speedBps, etaSeconds }) => {
              const chunkPct = total > 0 ? chunksCompleted / total : 0;
              // Chunk upload drives 2–65% of total progress
              const displayPct = 2 + Math.round(chunkPct * 63);
              updateTask(id, {
                progress:        displayPct,
                bytesUploaded,
                speedBps,
                etaSeconds,
                chunksCompleted,
                totalChunks:     total,
              });
              // Update notification every ~5 chunks to avoid spamming
              if (chunksCompleted % 5 === 0 || chunksCompleted === total) {
                pushNotification({
                  uploadId: id, type: 'upload_progress', fileName,
                  message: `Uploading (${displayPct}%)`,
                  progress: displayPct,
                });
                // Update foreground service notification for background visibility
                updateForegroundServiceNotification(id, fileName, displayPct, 'uploading');
              }
            },
          });

          await insertAuditLog(id, 'vdocipher_s3_upload_completed', {
            totalChunks, message: 'all chunks stored, triggering assembly',
          });
          pushNotification({
            uploadId: id, type: 'upload_completed', fileName,
            message: 'Upload completed successfully. Video is now processing.',
          });

        } catch (e: any) {
          // AbortError = user paused/cancelled — don't mark as failed
          if (e?.name === 'AbortError' || /paused|cancelled/i.test(e?.message ?? '')) {
            if (__DEV__) console.log('[runVdoCipherPipeline] upload aborted by user', { id });
            return; // pauseUpload/cancelUpload already updated state
          }
          const techMsg = logUploadError('[EF:video-upload-chunk]', 'Chunk upload failed', e, {
            uploadId: id,
          });
          await markFailed(id, lessonId, techMsg, 'chunk_upload', '[EF:video-upload-chunk]');
          return;
        }
      }
    }

    // ── STEP 3: Trigger assembly → returns VdoCipher video_id ────────────────
    updateTask(id, { status: 'processing', progress: 68, speedBps: 0, etaSeconds: 0 });
    await updateUploadRecord(id, { status: 'processing', processing_started_at: new Date().toISOString() });
    if (lessonId) await updateLessonVideoStatus(lessonId, id, 'processing');
    await insertAuditLog(id, 'assembly_triggered', { totalChunks });
    pushNotification({
      uploadId: id, type: 'processing', fileName,
      message: 'Video processing…',
    });
    await updateForegroundServiceNotification(id, fileName, 68, 'processing');

    let vdoVideoId: string;
    try {
      const assemblyResult = await triggerChunkAssembly({
        uploadId:    id,
        totalChunks,
        fileName:    sanitize(fileName),
        mimeType,
      });
      vdoVideoId = assemblyResult.video_id;

      // Store video ID immediately for deduplication and cleanup
      updateTask(id, { vdoCipherVideoId: vdoVideoId });
      await updateUploadRecord(id, {
        provider_video_id: vdoVideoId,
        file_analysis: { vdocipher_video_id: vdoVideoId },
      });
      await insertAuditLog(id, 'assembly_completed', { vdoVideoId });

    } catch (e: any) {
      if (!taskAlive(id)) return;
      const techMsg = logUploadError('[EF:video-assemble-upload]', 'Assembly / S3 stream failed', e, {
        uploadId: id,
      });
      await markFailed(id, lessonId, techMsg, 'assembly', '[EF:video-assemble-upload]');
      return;
    }

    // ── STEP 4: Poll VdoCipher until encoding is ready ────────────────────────
    updateTask(id, { status: 'encoding', progress: 76 });
    await updateUploadRecord(id, { status: 'encoding' });
    await insertAuditLog(id, 'vdocipher_polling_started', { vdoVideoId });
    await updateForegroundServiceNotification(id, fileName, 76, 'encoding');

    let vdoDuration: number | null = null;
    let vdoPoster: string | null = null;

    try {
      const stageProgress: Record<string, number> = { processing: 80, encoding: 88 };
      const result = await pollVdoCipherReady(
        vdoVideoId,
        id,
        (stage) => {
          updateTask(id, { status: stage, progress: stageProgress[stage] ?? 85 });
          updateUploadRecord(id, { status: stage });
        },
      );
      vdoDuration = result.duration;
      vdoPoster   = result.poster;

    } catch (e: any) {
      if (!taskAlive(id)) return;
      const techMsg = logUploadError('[VdoCipher]', 'Encoding / polling failed', e, {
        uploadId: id, vdoVideoId,
      });
      if (/timed out/i.test(techMsg)) {
        await markTimeout(id, lessonId, vdoVideoId);
      } else {
        await markFailed(id, lessonId, techMsg, 'vdocipher_encoding', '[VdoCipher]', vdoVideoId);
      }
      return;
    }

    // ── Bonus: local duration probe + thumbnail (best-effort) ────────────────
    let localDuration = 0;
    let thumbnailUrl: string | null = vdoPoster;

    const [durResult] = await Promise.allSettled([getVideoDurationSeconds(fileUri)]);
    if (durResult.status === 'fulfilled' && durResult.value > 0) {
      localDuration = durResult.value;
    }
    const finalDuration = vdoDuration ?? (localDuration > 0 ? localDuration : null);

    if (!thumbnailUrl) {
      try {
        const localThumb = await generateVideoThumbnail(fileUri);
        if (localThumb) {
          const uploaded = await uploadThumbnailToStorage(localThumb, courseId ?? 'library', lessonId ?? 'none', id);
          if (uploaded) {
            thumbnailUrl = uploaded.publicUrl;
            await updateUploadRecord(id, {
              thumbnail_url: thumbnailUrl,
              thumbnail_storage_path: uploaded.storagePath,
            });
            await insertAuditLog(id, 'thumbnail_generated');
          }
        }
      } catch (thumbErr) {
        if (__DEV__) console.warn('[runVdoCipherPipeline] thumbnail generation failed (non-fatal)', thumbErr);
      }
    }    if (!taskAlive(id)) return;

    updateTask(id, { progress: 95 });

    // ── STEP 5: Persist the usable lesson/asset relationship, then surface the
    // queue 'ready' badge. These writes are guarded as a unit: if the lesson
    // finalization SUCCEEDS, the queue task MUST reach a terminal state even if
    // a later housekeeping write (upload record / audit log) throws — otherwise
    // the lesson would show "Video Uploaded" while the queue sits at
    // "Encoding…" forever (the stale-queue bug). Transient failures BEFORE the
    // lesson write still route to markFailed/markTimeout as before.
    try {
      await updateLessonVideoStatus(lessonId, id, 'ready', {
        video_id: vdoVideoId,
        doctorId,
        ...(finalDuration ? { video_duration_seconds: finalDuration } : {}),
        ...(thumbnailUrl   ? { video_thumbnail_url: thumbnailUrl }    : {}),
      });
    } catch (e: any) {
      if (!taskAlive(id)) return;
      const techMsg = logUploadError('[EF:lesson-finalize]', 'Lesson finalization failed', e, {
        uploadId: id, vdoVideoId,
      });
      await markFailed(id, lessonId, techMsg, 'lesson_finalize', '[EF:lesson-finalize]', vdoVideoId);
      return;
    }

    // Lesson row is durably READY from here on — the provider asset is linked.
    // Drive the queue to its terminal state FIRST (synchronous, cannot fail),
    // then attempt the remaining housekeeping writes defensively.
    updateTask(id, { status: 'ready', progress: 100, verificationStatus: 'passed' });
    pushNotification({
      uploadId: id, type: 'video_ready', fileName,
      message: 'Your video is ready.',
    });
    useUploadQueueStore.getState().incrementUnread();
    try {
      await updateUploadRecord(id, {
        status: 'ready',
        provider_video_id: vdoVideoId,
        ready_at: new Date().toISOString(),
        verification_status: 'passed',
        verified_at: new Date().toISOString(),
      });
      await insertAuditLog(id, 'ready', { vdoVideoId });
    } catch (e) {
      // Non-fatal: the authoritative lesson/asset state is READY; a failed
      // housekeeping write must not strand the queue task at "Encoding…".
      if (__DEV__) console.warn('[runVdoCipherPipeline] housekeeping write failed after ready (non-fatal)', {
        uploadId: id, error: e instanceof Error ? e.message : String(e),
      });
    }
    // Stop foreground service and show system-level completion notification
    await stopForegroundServiceIfPossible();
    await showUploadCompleteNotification(id, fileName);

    // ── STEP 6: Delete old VdoCipher video (replace flow only) ───────────────
    // Only runs after the lesson DB row already points to the NEW video.
    // Failure here is non-fatal — the replacement itself succeeded.
    const currentTask = useUploadQueueStore.getState().getTask(id);
    if (currentTask?.isReplacement && currentTask.oldVdoCipherVideoId) {
      const oldVideoId = currentTask.oldVdoCipherVideoId;
      if (__DEV__) console.log('[runVdoCipherPipeline] deleting old VdoCipher video after successful replace', {
        lesson_id:     lessonId,
        new_video_id:  vdoVideoId,
        old_video_id:  oldVideoId,
        timestamp:     new Date().toISOString(),
      });
      try {
        const delResult = await deleteVdoCipherVideo(oldVideoId, {
          ...(lessonId ? { lessonId } : {}),
          reason: 'video_replaced',
        });
        if (delResult.vdo_deleted) {
          if (__DEV__) console.log('[runVdoCipherPipeline] old VdoCipher video deleted successfully', {
            old_video_id: oldVideoId, lesson_id: lessonId,
          });
        } else {
          // Log failure but do NOT roll back the replacement
          if (__DEV__) console.error('[runVdoCipherPipeline] old VdoCipher video deletion FAILED (replacement kept)', {
            old_video_id: oldVideoId, lesson_id: lessonId,
            error: delResult.vdo_error ?? 'unknown',
          });
          await insertAuditLog(id, 'old_vdo_delete_failed', {
            old_video_id: oldVideoId,
            new_video_id: vdoVideoId,
            error: delResult.vdo_error ?? 'unknown',
            timestamp: new Date().toISOString(),
          });
        }
      } catch (delErr) {
        // Never let old-video cleanup crash the upload success path
        if (__DEV__) console.error('[runVdoCipherPipeline] old VdoCipher video deletion threw (non-fatal)', {
          old_video_id: oldVideoId, lesson_id: lessonId,
          error: delErr instanceof Error ? delErr.message : String(delErr),
        });
      }
    }
    useUploadQueueStore.getState().incrementUnread();
    // DO NOT remove the task from the queue here — the user must see the
    // green 'Ready' state so they know the upload succeeded. The task is
    // removed when the user manually closes the queue (on rehydration,
    // ready/canceled tasks are already filtered out).
  };

  // ── Controls ──────────────────────────────────────────────────────────────

  const pauseUpload = async (taskId: string) => {
    // Abort in-flight chunk fetch (AbortController) OR legacy XHR
    const ac = getAbortController(taskId);
    if (ac) { ac.abort(); removeAbortController(taskId); }
    const xhr = getXhr(taskId);
    if (xhr) { xhr.abort(); removeXhr(taskId); }
    // Cancel native foreground upload if running (will resume from chunk on unpause)
    await cancelNativeUpload(taskId).catch(() => {});
    globalProcessingSet.delete(taskId);
    stopHeartbeat();
    const task = useUploadQueueStore.getState().getTask(taskId);
    if (!task) return;
    updateTask(taskId, { status: 'paused', _pausedAt: task.bytesUploaded });
    await updateUploadRecord(taskId, { status: 'paused' });
    await insertAuditLog(taskId, 'upload_paused');
    if (task.lessonId) await updateLessonVideoStatus(task.lessonId, taskId, 'paused');
    pushNotification({
      uploadId: taskId, type: 'upload_paused', fileName: task.fileName,
      message: 'Upload paused. Tap Resume to continue.',
    });
  };

  const resumeUpload = async (taskId: string) => {
    const task = useUploadQueueStore.getState().getTask(taskId);
    if (!task || (task.status !== 'paused' && task.status !== 'recovering')) return;
    // Set to 'resuming' — pipeline will read chunksCompleted from DB and skip done chunks
    updateTask(taskId, { status: 'waiting', errorMessage: undefined });
    await updateUploadRecord(taskId, { recovery_state: 'recovered' });
    await insertAuditLog(taskId, 'upload_resumed');
    pushNotification({
      uploadId: taskId, type: 'upload_resumed', fileName: task.fileName,
      message: 'Upload resumed.',
    });
  };

  // Cancel: stop local transfer immediately, then let PHP clean the provider
  // resource and persist the cancelled state under ownership checks.
  const cancelUpload = async (taskId: string) => {
    const ac = getAbortController(taskId);
    if (ac) { ac.abort(); removeAbortController(taskId); }
    const xhr = getXhr(taskId);
    if (xhr) { xhr.abort(); removeXhr(taskId); }
    // Also cancel native foreground upload if running
    await cancelNativeUpload(taskId).catch(() => {});
    globalProcessingSet.delete(taskId);
    stopHeartbeat();

    const task = useUploadQueueStore.getState().getTask(taskId);
    if (!task) return;

    updateTask(taskId, { status: 'canceled', progress: 0 });
    try {
      await cancelVdoCipherUpload(taskId);
      await insertAuditLog(taskId, 'upload_canceled', { step: task.status, provider_cleanup: true });
      useUploadQueueStore.getState().removeTask(taskId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Keep the task visible so a failed provider cleanup cannot be mistaken
      // for a successful cancellation; the red cancel action remains retryable.
      updateTask(taskId, {
        status: 'failed',
        errorMessage: `Cancellation cleanup failed: ${message}`,
        progress: 0,
      });
      try {
        await updateUploadRecord(taskId, {
          status: 'failed',
          error_message: `Cancellation cleanup failed: ${message}`,
        });
      } catch (_) {}
    }
  };

  // Retry upload — preserves chunk progress: pipeline will resume from chunksCompleted.
  const retryUpload = async (taskId: string) => {
    const task = useUploadQueueStore.getState().getTask(taskId);
    if (!task) return;
    updateTask(taskId, {
      status: 'waiting',
      progress: 0,
      bytesUploaded: 0,
      speedBps: 0,
      etaSeconds: 0,
      errorMessage: undefined,
      verificationStatus: undefined,
      verificationError: undefined,
      retryCount: task.retryCount + 1,
      // Preserve chunk state — pipeline resumes from DB-stored chunksCompleted
      // Only clear vdoCipherVideoId if assembly hasn't been triggered yet
    });
    await updateUploadRecord(taskId, {
      status: 'waiting',
      retry_count: task.retryCount + 1,
      error_message: '',
      verification_status: 'pending',
    });
    await insertAuditLog(taskId, 'retry_upload', { retryCount: task.retryCount + 1 });
  };

  // Retry processing ONLY — re-polls VdoCipher without re-uploading the file.
  // Valid when: status === 'timeout' AND vdoCipherVideoId is set (file reached VdoCipher).
  const retryProcessing = async (taskId: string) => {
    const task = useUploadQueueStore.getState().getTask(taskId);
    if (!task?.vdoCipherVideoId) {
      if (__DEV__) console.warn('[retryProcessing] no vdoCipherVideoId — cannot retry polling, use retryUpload');
      return;
    }
    const { lessonId, vdoCipherVideoId, doctorId } = task;

    updateTask(taskId, { status: 'encoding', progress: 76, errorMessage: undefined });
    await updateUploadRecord(taskId, { status: 'encoding', error_message: '' });
    await insertAuditLog(taskId, 'retry_processing', { vdoCipherVideoId });

    let vdoDuration: number | null = null;
    let vdoPoster: string | null = null;

    try {
      const stageProgress: Record<string, number> = { processing: 80, encoding: 88 };
      const result = await pollVdoCipherReady(
        vdoCipherVideoId,
        taskId,
        (stage) => {
          updateTask(taskId, { status: stage, progress: stageProgress[stage] ?? 85 });
          updateUploadRecord(taskId, { status: stage });
        },
      );
      vdoDuration = result.duration;
      vdoPoster   = result.poster;
    } catch (e: any) {
      if (useUploadQueueStore.getState().getTask(taskId)?.status === 'canceled') return;
      const techMsg = logUploadError('[VdoCipher]', 'Retry processing / polling failed', e, {
        taskId, vdoCipherVideoId,
      });
      if (/timed out/i.test(techMsg)) {
        await markTimeout(taskId, lessonId, vdoCipherVideoId);
      } else {
        await markFailed(taskId, lessonId, techMsg, 'retry_processing', '[VdoCipher]', vdoCipherVideoId);
      }
      return;
    }

    // Mark ready only after the lesson/asset relationship is durable.
    // Same guarded sequence as the main pipeline: once the lesson write
    // succeeds, the queue MUST reach its terminal state even if a later
    // housekeeping write throws — never strand the task at "Encoding…".
    if (useUploadQueueStore.getState().getTask(taskId)?.status === 'canceled') return;
    try {
      await updateLessonVideoStatus(lessonId, taskId, 'ready', {
        video_id: vdoCipherVideoId,
        doctorId,
        ...(vdoDuration ? { video_duration_seconds: vdoDuration } : {}),
        ...(vdoPoster   ? { video_thumbnail_url: vdoPoster }      : {}),
      });
    } catch (e: any) {
      if (useUploadQueueStore.getState().getTask(taskId)?.status === 'canceled') return;
      const techMsg = logUploadError('[EF:lesson-finalize]', 'Lesson finalization failed (retry processing)', e, {
        taskId, vdoCipherVideoId,
      });
      await markFailed(taskId, lessonId, techMsg, 'lesson_finalize', '[EF:lesson-finalize]', vdoCipherVideoId);
      return;
    }
    updateTask(taskId, { status: 'ready', progress: 100 });
    pushNotification({
      uploadId: taskId, type: 'video_ready', fileName: task.fileName,
      message: 'Your video is ready.',
    });
    useUploadQueueStore.getState().incrementUnread();
    try {
      await updateUploadRecord(taskId, { status: 'ready', provider_video_id: vdoCipherVideoId, ready_at: new Date().toISOString() });
      await insertAuditLog(taskId, 'ready', { vdoCipherVideoId, via: 'retry_processing' });
    } catch (e) {
      if (__DEV__) console.warn('[retryProcessing] housekeeping write failed after ready (non-fatal)', {
        taskId, error: e instanceof Error ? e.message : String(e),
      });
    }
    // Do not removeTask here — let the user see the Ready state.
  };

  // Remove a completed/timeout upload from the queue and clear its lesson ref.
  // Does NOT delete anything from VdoCipher — asset management is admin-only.
  const deleteVideo = async (taskId: string) => {
    const task = useUploadQueueStore.getState().getTask(taskId);
    if (!task) return;
    await cancelUpload(taskId);
  };

  const resumeAllRecoverable = async () => {
    const recoverable = useUploadQueueStore.getState().recoverableTasks();
    for (const t of recoverable) await resumeUpload(t.id);
    useUploadQueueStore.getState().setShowRecoveryDialog(false);
    await Promise.all(
      recoverable.map((t) => insertAuditLog(t.id, 'recovery_started')),
    );
  };

  return {
    pauseUpload,
    resumeUpload,
    cancelUpload,
    retryUpload,
    retryProcessing,
    deleteVideo,
    resumeAllRecoverable,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function markFailed(
  uploadId: string,
  lessonId: string | null,
  techMsg: string,
  step: string,
  layer: UploadErrorLayer,
  vdoCipherVideoId?: string,
): Promise<void> {
  // formatUploadError: shows full [LAYER] detail in __DEV__, sanitized in prod.
  // logUploadError() at the call site already logged the full stack — this is display only.
  const userMsg = formatUploadError(techMsg, layer);
  if (lessonId) await clearLessonVideoRef(lessonId);
  useUploadQueueStore.getState().updateTask(uploadId, {
    status: 'failed', errorMessage: userMsg, progress: 0,
  });
  // Persist the display message. The raw techMsg is in upload_audit_logs.details.error.
  await updateUploadRecord(uploadId, { status: 'failed', error_message: userMsg });
  await insertAuditLog(uploadId, 'upload_failed', {
    layer, step, error: techMsg,
    vdoCipherVideoId: vdoCipherVideoId ?? null,
  });
  if (lessonId) await updateLessonVideoStatus(lessonId, uploadId, 'failed');
  pushNotification({
    uploadId, type: 'upload_failed',
    fileName: useUploadQueueStore.getState().getTask(uploadId)?.fileName ?? '',
    message: userMsg,
    errorMessage: userMsg,
  });
  useUploadQueueStore.getState().incrementUnread();
  // Stop foreground service and show system-level failure notification
  await stopForegroundServiceIfPossible();
  const failedFileName = useUploadQueueStore.getState().getTask(uploadId)?.fileName ?? '';
  await showUploadFailedNotification(uploadId, failedFileName, userMsg);
}

async function markTimeout(
  uploadId: string,
  lessonId: string | null,
  vdoCipherVideoId: string,
): Promise<void> {
  // Do NOT delete the VdoCipher asset on timeout — encoding may still complete.
  // User can retry polling via retryProcessing().
  const msg = 'Processing timed out. Tap "Retry Processing" to check again.';
  useUploadQueueStore.getState().updateTask(uploadId, {
    status: 'timeout', errorMessage: msg, progress: 76,
  });
  await updateUploadRecord(uploadId, { status: 'timeout', error_message: msg });
  await insertAuditLog(uploadId, 'processing_timeout', {
    vdoCipherVideoId, deadline_minutes: 10,
  });
  if (lessonId) await updateLessonVideoStatus(lessonId, uploadId, 'timeout' as any);
  pushNotification({
    uploadId, type: 'processing_timeout',
    fileName: useUploadQueueStore.getState().getTask(uploadId)?.fileName ?? '',
    message: 'Video processing timed out.\nPlease try again later.',
  });
  useUploadQueueStore.getState().incrementUnread();
  // Stop foreground service and show system-level timeout notification
  await stopForegroundServiceIfPossible();
  await showProcessingTimeoutNotification(
    uploadId,
    useUploadQueueStore.getState().getTask(uploadId)?.fileName ?? '',
  );
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
