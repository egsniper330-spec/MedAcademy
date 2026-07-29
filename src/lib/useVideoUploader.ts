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
 * Video files are NEVER uploaded to Supabase Storage directly.
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
  getChunkUploadState,
  triggerChunkAssembly,
  deleteVdoCipherVideo,
} from './api';
import { uploadVideoInChunks, stabiliseUri } from './vdoCipherUpload';
import { pushNotification } from './uploadNotificationStore';

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

    (async () => {
      // 1. Local queue recovery (existing logic — catches in-memory stale tasks)
      const localRecoverable = useUploadQueueStore.getState().tasks.filter(
        (t) => t.status === 'recovering',
      );
      if (localRecoverable.length > 0) {
        setShowRecoveryDialog(true);
        localRecoverable.forEach((t) => {
          updateUploadRecord(t.id, { recovery_state: 'interrupted' });
          insertAuditLog(t.id, 'recovery_detected');
        });
      }

      // 2. DB-level lock recovery — catches sessions surviving app restart
      try {
        const staleSessions = await recoverStaleUploadSessions(60);
        if (staleSessions.length === 0) return;

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
    globalProcessingSet.add(waiting.id);
    startUpload(waiting);
  }, [tasks]);

  const startUpload = async (task: UploadTask) => {
    const { id, courseId, lessonId, fileUri, fileName, mimeType, fileSize, retryCount } = task;
    startHeartbeat(id);

    updateTask(id, { status: 'uploading' });
    await updateUploadRecord(id, {
      status: 'uploading',
      upload_started_at: new Date().toISOString(),
      retry_count: retryCount,
      recovery_state: 'none',
    });
    await insertAuditLog(id, retryCount > 0 ? 'upload_resumed' : 'upload_started');
    await updateLessonVideoStatus(lessonId, id, 'uploading');
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

    // Run the chunked VdoCipher pipeline
    runVdoCipherPipeline({
      id, courseId, lessonId,
      fileUri: stableFileUri,
      fileName,
      mimeType,
      fileSize: fileSize ?? 0,
    });
  };

  // ── STEPS 1–4: Chunked upload + assembly + encoding + lesson update ─────────
  const runVdoCipherPipeline = async (params: {
    id: string;
    courseId: string;
    lessonId: string;
    fileUri: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
  }) => {
    const { id, courseId, lessonId, fileUri, fileName, mimeType, fileSize } = params;

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

    // ── STEP 3: Trigger assembly → returns VdoCipher video_id ────────────────
    updateTask(id, { status: 'processing', progress: 68, speedBps: 0, etaSeconds: 0 });
    await updateUploadRecord(id, { status: 'processing', processing_started_at: new Date().toISOString() });
    await updateLessonVideoStatus(lessonId, id, 'processing');
    await insertAuditLog(id, 'assembly_triggered', { totalChunks });
    pushNotification({
      uploadId: id, type: 'processing', fileName,
      message: 'Video processing…',
    });

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
          const uploaded = await uploadThumbnailToStorage(localThumb, courseId, lessonId, id);
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
    }

    updateTask(id, { thumbnailUrl: thumbnailUrl ?? undefined, progress: 95 });

    // ── STEP 5: Mark lesson ready ─────────────────────────────────────────────
    updateTask(id, { status: 'ready', progress: 100, verificationStatus: 'passed' });
    await updateUploadRecord(id, {
      status: 'ready',
      ready_at: new Date().toISOString(),
      verification_status: 'passed',
      verified_at: new Date().toISOString(),
    });
    await insertAuditLog(id, 'ready', { vdoVideoId });
    pushNotification({
      uploadId: id, type: 'video_ready', fileName,
      message: 'Your video is ready.',
    });

    await updateLessonVideoStatus(lessonId, id, 'ready', {
      video_id: vdoVideoId,
      ...(finalDuration ? { video_duration_seconds: finalDuration } : {}),
      ...(thumbnailUrl   ? { video_thumbnail_url: thumbnailUrl }    : {}),
    });

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
          lessonId,
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
  };

  // ── Controls ──────────────────────────────────────────────────────────────

  const pauseUpload = async (taskId: string) => {
    // Abort in-flight chunk fetch (AbortController) OR legacy XHR
    const ac = getAbortController(taskId);
    if (ac) { ac.abort(); removeAbortController(taskId); }
    const xhr = getXhr(taskId);
    if (xhr) { xhr.abort(); removeXhr(taskId); }
    globalProcessingSet.delete(taskId);
    stopHeartbeat();
    const task = useUploadQueueStore.getState().getTask(taskId);
    if (!task) return;
    updateTask(taskId, { status: 'paused', _pausedAt: task.bytesUploaded });
    await updateUploadRecord(taskId, { status: 'paused' });
    await insertAuditLog(taskId, 'upload_paused');
    await updateLessonVideoStatus(task.lessonId, taskId, 'paused');
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

  // Cancel: abort in-flight chunk fetch or XHR, clear lesson ref, mark task canceled.
  const cancelUpload = async (taskId: string) => {
    const ac = getAbortController(taskId);
    if (ac) { ac.abort(); removeAbortController(taskId); }
    const xhr = getXhr(taskId);
    if (xhr) { xhr.abort(); removeXhr(taskId); }
    globalProcessingSet.delete(taskId);
    stopHeartbeat();

    const task = useUploadQueueStore.getState().getTask(taskId);
    if (!task) return;

    updateTask(taskId, { status: 'canceled', progress: 0 });
    await clearLessonVideoRef(task.lessonId);
    await updateUploadRecord(taskId, { status: 'canceled' });
    await insertAuditLog(taskId, 'upload_canceled', { step: task.status });
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
    const { lessonId, vdoCipherVideoId } = task;

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

    // Mark ready
    updateTask(taskId, { status: 'ready', progress: 100 });
    await updateUploadRecord(taskId, { status: 'ready', ready_at: new Date().toISOString() });
    await updateLessonVideoStatus(lessonId, taskId, 'ready', {
      video_id: vdoCipherVideoId,
      ...(vdoDuration ? { video_duration_seconds: vdoDuration } : {}),
      ...(vdoPoster   ? { video_thumbnail_url: vdoPoster }      : {}),
    });
    await insertAuditLog(taskId, 'ready', { vdoCipherVideoId, via: 'retry_processing' });
    pushNotification({
      uploadId: taskId, type: 'video_ready', fileName: task.fileName,
      message: 'Your video is ready.',
    });
    useUploadQueueStore.getState().incrementUnread();
  };

  // Remove a completed/timeout upload from the queue and clear its lesson ref.
  // Does NOT delete anything from VdoCipher — asset management is admin-only.
  const deleteVideo = async (taskId: string) => {
    const task = useUploadQueueStore.getState().getTask(taskId);
    if (!task) return;
    updateTask(taskId, { status: 'canceled', progress: 0 });
    await clearLessonVideoRef(task.lessonId);
    await insertAuditLog(taskId, 'video_removed_from_queue', {
      vdoCipherVideoId: task.vdoCipherVideoId ?? null,
    });
    useUploadQueueStore.getState().removeTask(taskId);
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
  lessonId: string,
  techMsg: string,
  step: string,
  layer: UploadErrorLayer,
  vdoCipherVideoId?: string,
): Promise<void> {
  // formatUploadError: shows full [LAYER] detail in __DEV__, sanitized in prod.
  // logUploadError() at the call site already logged the full stack — this is display only.
  const userMsg = formatUploadError(techMsg, layer);
  await clearLessonVideoRef(lessonId);
  useUploadQueueStore.getState().updateTask(uploadId, {
    status: 'failed', errorMessage: userMsg, progress: 0,
  });
  // Persist the display message. The raw techMsg is in upload_audit_logs.details.error.
  await updateUploadRecord(uploadId, { status: 'failed', error_message: userMsg });
  await insertAuditLog(uploadId, 'upload_failed', {
    layer, step, error: techMsg,
    vdoCipherVideoId: vdoCipherVideoId ?? null,
  });
  await updateLessonVideoStatus(lessonId, uploadId, 'failed');
  pushNotification({
    uploadId, type: 'upload_failed',
    fileName: useUploadQueueStore.getState().getTask(uploadId)?.fileName ?? '',
    message: userMsg,
    errorMessage: userMsg,
  });
  useUploadQueueStore.getState().incrementUnread();
}

async function markTimeout(
  uploadId: string,
  lessonId: string,
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
  await updateLessonVideoStatus(lessonId, uploadId, 'timeout' as any);
  pushNotification({
    uploadId, type: 'processing_timeout',
    fileName: useUploadQueueStore.getState().getTask(uploadId)?.fileName ?? '',
    message: 'Video processing timed out.\nPlease try again later.',
  });
  useUploadQueueStore.getState().incrementUnread();
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
