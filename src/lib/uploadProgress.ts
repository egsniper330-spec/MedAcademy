/**
 * uploadProgress.ts — pure helpers for the lesson-material (PDF) upload UI.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A doctor attaching a PDF used to see a spinner and the word "Uploading…"
 * until the request finished. On a slow connection a 40 MB scan can take
 * minutes, so the screen looked hung: no bytes, no percentage, no way to tell
 * "still transferring" from "the request died", and no way to cancel. The
 * video queue already reports byte progress; material uploads did not.
 *
 * This module turns raw `xhr.upload.onprogress` counters into the numbers the
 * UI shows (percentage, smoothed speed, ETA) plus the stage vocabulary and the
 * failure → message mapping. It is intentionally dependency-free (no React, no
 * React Native, no i18n import) so the test suite can compile and EXECUTE it —
 * same convention as `src/lib/uploadPart.ts` and `src/lib/semver.ts`.
 *
 * IMPORTANT: bytes transferred is NOT the same as server-side completion. The
 * last bytes leaving the device says nothing about whether PHP stored the file,
 * measured its size or computed its digest, so `percent` reaching 100 and the
 * `verifying` / `saving` stages are deliberately distinct.
 */

export type UploadStage =
  | 'preparing'   // building the multipart body / resolving the picked file
  | 'uploading'   // bytes are on the wire (this is the only measurable part)
  | 'verifying'   // server answered; checking measured size + digest
  | 'saving'      // writing the lesson_materials row
  | 'done'
  | 'failed'
  | 'cancelled';

export interface UploadProgressSnapshot {
  stage: UploadStage;
  bytesSent: number;
  totalBytes: number;
  /** 0–100, or null when the total is unknown (indeterminate). */
  percent: number | null;
  /** Smoothed bytes/second; 0 until two samples exist. */
  speedBps: number;
  /** Seconds remaining at the current smoothed speed, or null. */
  etaSeconds: number | null;
  elapsedMs: number;
}

/** i18n key for each stage. Every key must exist in en AND ar. */
const STAGE_MESSAGE_KEYS: Record<UploadStage, string> = {
  preparing: 'lessonEditor.upload.preparing',
  uploading: 'lessonEditor.upload.uploading',
  verifying: 'lessonEditor.upload.verifyingStored',
  saving: 'lessonEditor.upload.saving',
  done: 'lessonEditor.upload.ready',
  failed: 'lessonEditor.upload.failed',
  cancelled: 'lessonEditor.upload.cancelled',
};

export function stageMessageKey(stage: UploadStage): string {
  return STAGE_MESSAGE_KEYS[stage] ?? STAGE_MESSAGE_KEYS.uploading;
}

/** True while the upload is still in flight (not a terminal state). */
export function isActiveStage(stage: UploadStage): boolean {
  return stage === 'preparing' || stage === 'uploading' || stage === 'verifying' || stage === 'saving';
}

/** 0–100 with one decimal, clamped; null when the total is unknown. */
export function percentOf(bytesSent: number, totalBytes: number): number | null {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const sent = Number.isFinite(bytesSent) ? Math.max(0, bytesSent) : 0;
  const pct = (sent / totalBytes) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

/** Human byte count, ASCII-safe on every platform (used in RTL layouts too). */
export function formatByteCount(bytes: number): string {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * Smoothed transfer tracker.
 *
 * The native progress event fires far more often than the UI should re-render,
 * and instantaneous speed from two nearby samples is extremely noisy (it swings
 * between 0 and several times the real rate), which produces an ETA that jumps
 * from "3 s" to "4 min". An exponential moving average fixes that. Progress is
 * also monotonic: a reported byte count that goes backwards (a retried request,
 * a buffered XHR) must never make the bar jump back.
 */
export function createUploadTracker(
  totalBytes: number,
  startMs: number,
  options: { now?: () => number; smoothing?: number } = {},
) {
  const now = options.now ?? (() => Date.now());
  const smoothing = options.smoothing ?? 0.3;
  let peakBytes = 0;
  let lastMs = startMs;
  let speedBps = 0;
  let stage: UploadStage = 'preparing';
  // The wire total (multipart body length) beats the picker's claim, which is
  // absent for some Android content:// providers. It arrives with the first
  // progress event, after the tracker was created.
  let total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;

  function setStage(next: UploadStage): void {
    stage = next;
  }

  function setTotal(nextTotal: number): void {
    if (Number.isFinite(nextTotal) && nextTotal > 0) total = nextTotal;
  }

  function snapshot(bytesSent?: number, atMs?: number): UploadProgressSnapshot {
    const at = atMs ?? now();
    if (typeof bytesSent === 'number' && Number.isFinite(bytesSent)) {
      const clamped = Math.max(0, bytesSent);
      // Only advance the peak: a lower value is a re-report, not a rewind.
      if (clamped > peakBytes) {
        const dt = at - lastMs;
        if (dt > 0) {
          const instant = ((clamped - peakBytes) * 1000) / dt;
          speedBps = speedBps > 0 ? speedBps * (1 - smoothing) + instant * smoothing : instant;
          lastMs = at;
        }
        peakBytes = clamped;
      }
    }
    const remaining = total - peakBytes;
    const etaSeconds = speedBps > 0 && remaining > 0 ? Math.ceil(remaining / speedBps) : null;
    return {
      stage,
      bytesSent: peakBytes,
      totalBytes: Math.max(0, total),
      percent: percentOf(peakBytes, total),
      speedBps: Math.round(speedBps),
      etaSeconds,
      elapsedMs: Math.max(0, at - startMs),
    };
  }

  return { snapshot, setStage, setTotal, get speedBps() { return speedBps; } };
}

export interface UploadFailureInfo {
  stage: 'failed' | 'cancelled';
  messageKey: string;
  /** Whether retrying the same file can plausibly succeed. */
  retryable: boolean;
  status: number;
}

/**
 * Backend failure codes that mean something more precise than their HTTP status.
 *
 * Kept in one place so the wording the doctor sees is decided by the server's
 * STABLE code (never by parsing an English sentence), and so a new code without
 * an entry degrades to the generic localized message instead of leaking server
 * text into the UI (which would break RTL/translation).
 */
const SERVER_CODE_MESSAGES: Record<string, { messageKey: string; retryable: boolean }> = {
  // The document itself was refused at upload — retrying the SAME file cannot
  // help, the doctor has to supply a copy the engine can read.
  pdf_unsupported_format: { messageKey: 'lessonEditor.upload.pdfUnsupported', retryable: false },
  pdf_invalid: { messageKey: 'lessonEditor.upload.pdfInvalid', retryable: false },
  pdf_encrypted: { messageKey: 'lessonEditor.upload.pdfEncrypted', retryable: false },
  source_too_large: { messageKey: 'lessonEditor.upload.tooLarge', retryable: false },
  // The transfer stopped short — the same file can be sent again.
  pdf_truncated: { messageKey: 'lessonEditor.upload.pdfTruncated', retryable: true },
  upload_truncated: { messageKey: 'lessonEditor.upload.pdfTruncated', retryable: true },
  // Bytes reached storage but the row could not be written, or the engine could
  // not find them. The file is safe to pick again once support/DB recovers.
  material_file_missing: { messageKey: 'lessonEditor.upload.notStored', retryable: true },
  material_file_empty: { messageKey: 'lessonEditor.upload.notStored', retryable: true },
  // The bytes that arrived are not the bytes that were selected. Retrying the
  // SAME pick can work (a transient cache URI), but the document is not saved.
  upload_size_mismatch: { messageKey: 'lessonEditor.upload.sizeMismatch', retryable: true },
  material_write_failed: { messageKey: 'lessonEditor.upload.saveFailed', retryable: true },
  storage_write_failed: { messageKey: 'lessonEditor.upload.saveFailed', retryable: true },
  persist_mismatch: { messageKey: 'lessonEditor.upload.saveFailed', retryable: true },
  upload_storage_error: { messageKey: 'lessonEditor.upload.saveFailed', retryable: true },
};

/**
 * Do the bytes the server stored correspond to the file the picker reported?
 *
 * The upload and the material row are separate requests, so "the upload worked"
 * says nothing about WHICH file the server received. A stale cache or
 * `content://` URI, or a provider that substituted an asset, can send a
 * different document — and attaching it would be worse than a visible failure.
 *
 * A picker that reports no size (some Android providers) cannot be compared, and
 * a zero-byte response is the empty-body case, handled elsewhere. The tolerance
 * absorbs provider metadata that is a few KB off without letting a genuinely
 * different file through: 2 % or 4 KB, whichever is larger.
 */
export function uploadSizeMismatch(declaredBytes: number, storedBytes: number): boolean {
  const declared = Number.isFinite(declaredBytes) ? Math.trunc(declaredBytes) : 0;
  const stored = Number.isFinite(storedBytes) ? Math.trunc(storedBytes) : 0;
  if (declared <= 0 || stored <= 0) return false;
  const tolerance = Math.max(4096, Math.round(declared * 0.02));
  return Math.abs(stored - declared) > tolerance;
}

/**
 * Did the SERVER definitively refuse this request (4xx)?
 *
 * Only then is it safe to reclaim the object that was just uploaded: a 4xx means
 * no row was written, so the bytes are unreferenced and would linger as an
 * orphan. A 5xx, a timeout or a dropped connection means the outcome is UNKNOWN
 * — the row may exist — and deleting the object would leave a material pointing
 * at nothing, which is the failure this whole file exists to prevent.
 */
export function isServerRefusal(error: { status?: number } | null | undefined): boolean {
  const status = Number(error?.status ?? 0);
  return status >= 400 && status < 500;
}

/**
 * Map a transport/HTTP failure onto an actionable, translatable message.
 *
 * Distinguishing these matters: "Upload failed." gives the doctor nothing to
 * do, while 413 (host request limit), 429 (rate limit), 401 (expired session)
 * and a dropped connection each need a different response.
 *
 * The SERVER's stable error codes are part of that mapping. A refused PDF is
 * the case that matters most: the backend rejects a document it could not
 * water-mark (damaged, encrypted, or saved with a compressed cross-reference
 * stream the engine cannot read), and every one of those needs its own advice —
 * "re-export as PDF 1.4" fixes one, "upload a different copy" fixes another.
 * Status alone cannot express that: all three arrive as HTTP 422.
 */
export function classifyUploadFailure(error: { status?: number; code?: string; name?: string } | null | undefined): UploadFailureInfo {
  const status = Number(error?.status ?? 0);
  const code = String(error?.code ?? '');
  const name = String(error?.name ?? '');

  if (name === 'AbortError' || code === 'ABORT_ERR') {
    return { stage: 'cancelled', messageKey: 'lessonEditor.upload.cancelled', retryable: false, status: 0 };
  }
  if (code === 'TIMEOUT' || status === 408 || status === 504) {
    // Distinct from the VIDEO "processing timed out": here the bytes stopped moving.
    return { stage: 'failed', messageKey: 'lessonEditor.upload.transferTimedOut', retryable: true, status };
  }
  if (status === 401 || status === 403) {
    return { stage: 'failed', messageKey: 'lessonEditor.upload.sessionExpired', retryable: false, status };
  }
  if (code === 'upload_empty') {
    // Server answered 200 but measured zero stored bytes: a real failure the
    // generic mapping would mislabel as a network problem.
    return { stage: 'failed', messageKey: 'lessonEditor.uploadEmpty', retryable: true, status };
  }
  if (status === 413) {
    return { stage: 'failed', messageKey: 'lessonEditor.upload.tooLarge', retryable: false, status };
  }
  if (status === 429) {
    return { stage: 'failed', messageKey: 'lessonEditor.upload.tooManyRequests', retryable: true, status };
  }
  // Stable backend codes (ApiException) → their own wording. Auth/limit statuses
  // above win, so a 401 that happens to carry a code still says "sign in again".
  const byCode = SERVER_CODE_MESSAGES[code];
  if (byCode) {
    return { stage: 'failed', messageKey: byCode.messageKey, retryable: byCode.retryable, status };
  }
  if (status >= 500) {
    return { stage: 'failed', messageKey: 'lessonEditor.upload.serverError', retryable: true, status };
  }
  if (code === 'NETWORK') {
    // Only the transport says NETWORK. A bare status 0 without that code is a
    // client-side refusal (e.g. an unsupported payload), which is not the same
    // thing as a dropped connection and must not tell the doctor to retry.
    return { stage: 'failed', messageKey: 'lessonEditor.upload.networkError', retryable: true, status };
  }
  return { stage: 'failed', messageKey: 'lessonEditor.upload.failed', retryable: true, status };
}
