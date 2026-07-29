/**
 * vdoCipherUpload.ts
 *
 * ═══════════════════════════════════════════════════════════════════
 * SINGLE SOURCE OF TRUTH — VdoCipher direct S3 upload
 * ═══════════════════════════════════════════════════════════════════
 *
 * This is the PROVEN upload implementation extracted from the
 * vdo-isolation debug screen, which confirmed:
 *   ✓ Credentials correct
 *   ✓ VdoCipher API correct
 *   ✓ React Native XHR + FormData works
 *   ✓ S3 accepts the multipart body
 *
 * Both the production Lesson Editor upload pipeline and any future
 * "replace video" or retry flows MUST call uploadToVdoCipherS3().
 * DO NOT maintain a second FormData/XHR implementation anywhere else.
 *
 * OFFICIAL VDOCIPHER BROWSER UPLOAD SPEC
 * https://www.vdocipher.com/docs/server/upload/browser/
 *
 *   FormData order (MUST be respected):
 *     1. All clientPayload fields verbatim (except success_action_* and uploadLink)
 *     2. success_action_status = "201"   ← always explicit
 *     3. success_action_redirect = ""    ← always explicit
 *     4. file = { uri, name, type }      ← MUST be last
 *
 *   XHR rules:
 *     • DO NOT set Content-Type — RN XHR auto-generates multipart/form-data; boundary=...
 *     • DO NOT use Blob / ArrayBuffer — use { uri, name, type } object (RN native stream)
 *     • HTTP 201 = S3 success
 */

// New expo-file-system v55 API (File class, Paths)
import { File as FSFile, Paths as FSPaths } from 'expo-file-system';
// Legacy API — copyAsync correctly handles content:// source URIs on Android
import { copyAsync, readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { uploadVideoChunk } from './api';
import { setAbortController, removeAbortController } from './uploadQueueStore';

/**
 * Upload a video file in chunks to the video-upload-chunk Edge Function.
 *
 * - Reads the file in CHUNK_SIZE_BYTES slices via expo-file-system (base64 decode → Uint8Array)
 * - On Web: slices the ArrayBuffer from fetch(blobUri)
 * - Supports resume: starts from `startChunkIndex` (previously completed chunks are skipped)
 * - Supports pause/cancel via AbortController stored in the global abortMap
 * - Reports per-chunk progress, speed (bytes/s), and ETA via onProgress
 *
 * @returns totalChunks (so caller can pass it to triggerChunkAssembly)
 */
export interface ChunkedUploadParams {
  fileUri:          string;           // stable file:// URI (content:// must be stabilised first)
  fileName:         string;
  mimeType:         string;
  fileSize:         number;           // total bytes — used for ETA computation
  uploadId:         string;           // video_uploads.id
  startChunkIndex?: number;           // resume from this chunk (default 0)
  chunkSizeBytes?:  number;           // default 8 MB
  onProgress?: (params: {
    chunksCompleted: number;
    totalChunks:     number;
    bytesUploaded:   number;
    speedBps:        number;
    etaSeconds:      number;
    assemblyTriggered: boolean;
  }) => void;
}

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB

export async function uploadVideoInChunks(params: ChunkedUploadParams): Promise<{
  totalChunks: number;
  assemblyTriggered: boolean;
}> {
  const {
    fileUri,
    fileName,
    mimeType,
    fileSize,
    uploadId,
    startChunkIndex = 0,
    chunkSizeBytes = DEFAULT_CHUNK_SIZE,
    onProgress,
  } = params;

  const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSizeBytes));
  const isWeb = process.env.EXPO_OS === 'web';

  // ── Build AbortController for pause/cancel ───────────────────────────────
  const ac = new AbortController();
  setAbortController(uploadId, ac);

  // ── Pre-fetch full buffer on Web (blob: URI, can't seek) ─────────────────
  let webBuffer: ArrayBuffer | null = null;
  if (isWeb) {
    const blobRes = await fetch(fileUri, { signal: ac.signal });
    webBuffer = await blobRes.arrayBuffer();
  }

  let speedBps = 0;
  let assemblyTriggered = false;

  const uploadStart = Date.now();
  let bytesUploadedSoFar = startChunkIndex * chunkSizeBytes;

  for (let i = startChunkIndex; i < totalChunks; i++) {
    // Honour abort between chunks
    if (ac.signal.aborted) {
      throw new Error('Upload paused or cancelled');
    }

    const chunkStart = i * chunkSizeBytes;
    const chunkEnd   = Math.min(chunkStart + chunkSizeBytes, fileSize);
    const thisChunkBytes = chunkEnd - chunkStart;

    let chunkData: Uint8Array;

    if (isWeb && webBuffer) {
      // Slice ArrayBuffer directly
      chunkData = new Uint8Array(webBuffer.slice(chunkStart, chunkEnd));
    } else {
      // Native: read base64-encoded slice, decode to Uint8Array
      const b64 = await readAsStringAsync(fileUri, {
        encoding: EncodingType.Base64,
        position: chunkStart,
        length:   thisChunkBytes,
      });
      chunkData = base64ToUint8Array(b64);
    }

    const chunkUploadStart = Date.now();

    const result = await uploadVideoChunk({
      uploadId,
      chunkIndex:  i,
      totalChunks,
      chunkData,
      fileName,
      mimeType,
      signal: ac.signal,
    });

    const chunkElapsedMs = Math.max(1, Date.now() - chunkUploadStart);
    speedBps = Math.round((thisChunkBytes / chunkElapsedMs) * 1000);

    bytesUploadedSoFar += thisChunkBytes;
    assemblyTriggered = result.assembly_triggered;

    const totalElapsedMs  = Math.max(1, Date.now() - uploadStart);
    const overallSpeedBps = (bytesUploadedSoFar / totalElapsedMs) * 1000;
    const remainingBytes  = fileSize - bytesUploadedSoFar;
    const etaSeconds      = overallSpeedBps > 0 ? Math.round(remainingBytes / overallSpeedBps) : 0;

    onProgress?.({
      chunksCompleted:   result.received,
      totalChunks:       result.total,
      bytesUploaded:     bytesUploadedSoFar,
      speedBps:          Math.round(overallSpeedBps),
      etaSeconds,
      assemblyTriggered: result.assembly_triggered,
    });
  }

  removeAbortController(uploadId);
  return { totalChunks, assemblyTriggered };
}

// ── Base64 → Uint8Array (cross-platform, no atob on older Android WebViews) ──
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface VdoCipherUploadParams {
  /** Stable file:// URI (Android content:// must be copied before calling this) */
  fileUri:       string;
  /** Display / S3 key filename — must be non-empty */
  fileName:      string;
  /** MIME type, e.g. "video/mp4" */
  mimeType:      string;
  /** S3 presigned POST endpoint (extracted from VdoCipher clientPayload.uploadLink) */
  uploadUrl:     string;
  /**
   * All S3 form fields from VdoCipher clientPayload, with uploadLink removed.
   * e.g. { key, policy, x-amz-signature, x-amz-credential, x-amz-date, x-amz-algorithm }
   */
  clientPayload: Record<string, unknown>;
  /** Optional progress callback, 0–100 */
  onProgress?:  (pct: number) => void;
  /**
   * Optional raw XHR result callback — fires in xhr.onload for BOTH success (201)
   * and failure (4xx/5xx). Lets debug screens capture status + response XML without
   * duplicating the XHR implementation. Never fires on network-error or timeout.
   */
  onRawResult?: (status: number, body: string) => void;
}

/**
 * Upload a video file directly to VdoCipher's AWS S3 endpoint.
 *
 * Matches the EXACT implementation proven in vdo-isolation.tsx.
 * Throws on failure with a descriptive message including the S3 XML body.
 */
export async function uploadToVdoCipherS3(params: VdoCipherUploadParams): Promise<void> {
  const { fileUri, fileName, mimeType, uploadUrl, clientPayload, onProgress, onRawResult } = params;

  const uriScheme = fileUri ? fileUri.split(':')[0].toLowerCase() : '(none)';
  const isWeb = process.env.EXPO_OS === 'web';

  // FSFile only understands native filesystem paths (file://).
  // On Web, DocumentPicker returns blob: URLs which live in browser memory —
  // FSFile.exists is always false for blob: scheme and must NOT be used as a
  // validation gate. Skip the probe entirely on Web; the blob URL is valid by
  // definition (the browser just created it from the user's selected file).
  let fsExists = false;
  let fsSize: number | null = null;
  if (!isWeb) {
    try {
      const probe = new FSFile(fileUri);
      fsExists = probe.exists;
      fsSize   = probe.size ?? null;
    } catch (probeErr) {
      if (__DEV__) console.error('[uploadToVdoCipherS3] FSFile probe threw', { fileUri, error: String(probeErr) });
    }
  }

  if (!fileUri) throw new Error('[uploadToVdoCipherS3] ABORT: fileUri is null/undefined.');
  if (!fileName) throw new Error('[uploadToVdoCipherS3] ABORT: fileName is empty.');
  // Native-only filesystem guards — skipped on Web where blob: URLs are valid
  if (!isWeb && !fsExists) {
    throw new Error(
      `[uploadToVdoCipherS3] ABORT: File not found at "${fileUri}" (scheme: ${uriScheme}).\n` +
      (uriScheme === 'content'
        ? 'content:// URI not yet copied to file://. Call stabiliseUri() first.\n'
        : '') +
      'S3 would receive an empty body → "No content provided".'
    );
  }
  if (!isWeb && fsExists && fsSize === 0) {
    throw new Error(
      `[uploadToVdoCipherS3] ABORT: File is 0 bytes at "${fileUri}".\n` +
      'Direct cause of S3 "No content provided".'
    );
  }

  // ── Build FormData — official VdoCipher browser spec ─────────────────────
  const fd = new FormData();
  const copiedKeys:  string[] = [];
  const skippedKeys: string[] = [];

  // Step A: copy clientPayload fields verbatim (skip the two we set explicitly)
  for (const [key, value] of Object.entries(clientPayload)) {
    if (key === 'success_action_status' || key === 'success_action_redirect') {
      skippedKeys.push(key);
      continue;
    }
    if (value === undefined) { skippedKeys.push(key); continue; }
    fd.append(key, value === null ? '' : String(value));
    copiedKeys.push(key);
  }

  // Step B: explicit required fields per VdoCipher browser spec
  fd.append('success_action_status',  '201');
  fd.append('success_action_redirect', '');

  // Step C: file MUST be last — S3 ignores anything after the file part
  //
  // NATIVE: RN XHR polyfill streams { uri, name, type } from filesystem (zero heap copy).
  // WEB:    fileUri is a blob: URL. The browser XHR sees a plain object as "[object Object]"
  //         (~150 bytes) — NOT the file content. Must resolve blob: → real Blob → File first.
  let fileSizeForLog: number | null = fsSize;
  if (process.env.EXPO_OS === 'web') {
    const blobResponse = await fetch(fileUri);
    const blob = await blobResponse.blob();
    const fileBlob = new File([blob], fileName, { type: mimeType });
    fd.append('file', fileBlob);
    fileSizeForLog = fileBlob.size;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fd.append('file', { uri: fileUri, name: fileName, type: mimeType } as any);
  }

  const allFields = [...copiedKeys, 'success_action_status', 'success_action_redirect', 'file'];

  // ── POST to S3 — do NOT set Content-Type ─────────────────────────────────
  // RN XHR auto-generates: Content-Type: multipart/form-data; boundary=<uuid>
  // Setting it manually loses the boundary → S3 cannot parse the body.

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl, true);
    // intentionally no setRequestHeader('Content-Type', ...) call

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) {
        onProgress(Math.round((ev.loaded / ev.total) * 100));
      }
      
    };

    xhr.onload = () => {
      onRawResult?.(xhr.status, xhr.responseText ?? '');

      if (xhr.status === 201) {
        resolve();
      } else {
        if (__DEV__) console.error('[uploadToVdoCipherS3] S3 upload failed', {
          status:      xhr.status,
          responseXml: xhr.responseText,
          hint: xhr.status === 403
            ? 'Policy validation failed — check responseXml for failed condition name'
            : `Unexpected HTTP ${xhr.status}`,
        });
        reject(new Error(
          `VdoCipher S3 upload failed (HTTP ${xhr.status}): ${xhr.responseText ?? 'no response body'}`
        ));
      }
    };

    xhr.onerror   = () => {
      reject(new Error('Network error during VdoCipher S3 upload'));
    };
    xhr.ontimeout = () => {
      reject(new Error('VdoCipher S3 upload timed out'));
    };
    xhr.timeout   = 600_000; // 10 minutes

    xhr.send(fd);
  });
}

/**
 * Stabilise a file URI for multi-step pipelines on Android.
 *
 * Android `content://` URIs are one-time grants scoped to the DocumentPicker
 * transaction. If the app performs an async network call (e.g. Supabase Storage
 * upload) between picking the file and calling uploadToVdoCipherS3, the OS may
 * revoke the grant → XHR streams 0 bytes → S3 returns "No content provided".
 *
 * This function copies content:// (and iOS ph://) URIs to a stable file:// path
 * in the app cache directory using `copyAsync` from `expo-file-system/legacy`,
 * which is the only API that correctly handles content:// source URIs on Android.
 *
 * The new expo-file-system v55 `File.copy()` method does NOT support content://
 * source URIs — it only works with file:// paths.
 *
 * Returns the original URI unchanged for file:// and asset:// URIs.
 */
export async function stabiliseUri(
  fileUri:  string,
  uploadId: string,
  fileName: string,
): Promise<string> {
  const uriScheme = fileUri.split(':')[0].toLowerCase();

  // Only content:// (Android) and ph:// (iOS Photos) need stabilisation
  if (uriScheme !== 'content' && uriScheme !== 'ph') {
    return fileUri;
  }

  const ext       = fileName.split('.').pop() ?? 'mp4';
  // Paths.cache is the new v55 Directory reference — .uri gives the file:// string
  const cachePath = `${FSPaths.cache.uri}vdo_${uploadId}.${ext}`;

  // Check for a valid cached copy from a previous retry
  try {
    const existing = new FSFile(cachePath);
    if (existing.exists && (existing.size ?? 0) > 0) {
      return cachePath;
    }
  } catch (_) {}

  // ── CRITICAL: use copyAsync (legacy API), NOT new FSFile().copy() ─────────
  //
  // The new expo-file-system v55 File.copy() only supports file:// source URIs.
  // copyAsync from the legacy module correctly streams content:// URIs on Android.

  try {
    await copyAsync({ from: fileUri, to: cachePath });
  } catch (copyErr) {
    throw new Error(
      `[stabiliseUri] copy failed: ${String(copyErr)}\n` +
      `from: ${fileUri}\n` +
      `to: ${cachePath}\n` +
      'Content:// URI may have been revoked or the source file deleted.'
    );
  }

  // Verify the copy produced a non-empty file
  const copied = new FSFile(cachePath);
  if (!copied.exists) {
    throw new Error(`[stabiliseUri] Copied file not found at "${cachePath}"`);
  }
  const copiedSize = copied.size ?? 0;
  if (copiedSize === 0) {
    throw new Error(
      `[stabiliseUri] Copy produced 0-byte file at "${cachePath}".\n` +
      'The content:// URI may already be revoked.\n' +
      'S3 would return "No content provided".'
    );
  }

  return cachePath;
}


