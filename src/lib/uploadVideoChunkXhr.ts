/**
 * uploadVideoChunkXhr.ts
 *
 * XHR-based single-chunk uploader that exposes byte-level upload progress
 * via xhr.upload.onprogress. Replaces the expo/fetch-based uploadVideoChunk
 * for the chunked upload pipeline so the UI shows continuous progress instead
 * of only updating after each chunk completes.
 *
 * The backend endpoint, headers, and response contract are identical to the
 * existing uploadVideoChunk in api.ts — this is a drop-in replacement that
 * adds an onProgress callback.
 */

import { backendApiBase, backendClient } from '@/client/backendClient';

/**
 * Upload a single binary chunk to the video-upload-chunk Edge Function.
 * Uses XMLHttpRequest to expose per-chunk byte-level upload progress.
 *
 * @param onProgress - Called during chunk upload with bytes loaded/total for this chunk
 * @returns { received, total, assembly_triggered }
 */
export async function uploadVideoChunkWithProgress(params: {
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  chunkData: Uint8Array | ArrayBuffer;
  fileName: string;
  mimeType: string;
  signal?: AbortSignal;
  onChunkProgress?: (loaded: number, total: number) => void;
}): Promise<{ received: number; total: number; assembly_triggered: boolean }> {
  const { uploadId, chunkIndex, totalChunks, chunkData, fileName, mimeType, signal, onChunkProgress } = params;

  const session = await backendClient.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const url = `${backendApiBase}/video/chunk`;
  const body: ArrayBuffer = (chunkData instanceof Uint8Array ? chunkData : new Uint8Array(chunkData)).buffer as ArrayBuffer;

  return new Promise<{ received: number; total: number; assembly_triggered: boolean }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('x-upload-id', uploadId);
    xhr.setRequestHeader('x-chunk-index', String(chunkIndex));
    xhr.setRequestHeader('x-total-chunks', String(totalChunks));
    xhr.setRequestHeader('x-chunk-size', String(body.byteLength));
    xhr.setRequestHeader('x-file-name', fileName);
    xhr.setRequestHeader('x-mime-type', mimeType);
    // Explicitly set Content-Type to octet-stream. The PHP Request parser
    // skips JSON decoding when Content-Type is NOT empty/json, so leaving
    // it unset causes the binary body to be rejected as "Invalid JSON body".
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    // Byte-level progress for THIS chunk
    xhr.upload.onprogress = (ev) => {
      if (onChunkProgress && ev.lengthComputable) {
        onChunkProgress(ev.loaded, ev.total);
      }
    };

    // Handle abort signal
    let onAbort: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      onAbort = () => xhr.abort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.onload = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json = JSON.parse(xhr.responseText) as { received: number; total: number; assembly_triggered: boolean };
          resolve(json);
        } catch {
          reject(new Error(`Invalid JSON response from chunk upload: ${xhr.responseText?.substring(0, 200)}`));
        }
      } else {
        let errMsg = `HTTP ${xhr.status}`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: unknown };
          const err = parsed?.error;
          if (typeof err === 'string') {
            errMsg = err;
          } else if (err && typeof err === 'object') {
            const e = err as { message?: unknown; error?: unknown };
            errMsg = typeof e.message === 'string'
              ? e.message
              : (typeof e.error === 'string' ? e.error : JSON.stringify(err));
          } else if (xhr.responseText) {
            errMsg = xhr.responseText;
          }
        } catch { errMsg = xhr.responseText || errMsg; }
        reject(new Error(`Chunk ${chunkIndex} upload failed: ${errMsg}`));
      }
    };

    xhr.onerror = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      reject(new Error('Network error during chunk upload'));
    };

    xhr.ontimeout = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      reject(new Error('Chunk upload timed out'));
    };

    xhr.timeout = 300_000; // 5 minutes per chunk

    xhr.send(body);
  });
}
