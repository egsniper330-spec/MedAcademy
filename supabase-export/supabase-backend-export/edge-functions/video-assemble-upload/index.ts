// supabase/functions/video-assemble-upload/index.ts
//
// Assembles video chunks stored in the video-chunks bucket and uploads
// the full video to VdoCipher via their S3 presigned POST endpoint.
//
// Uses a fully-buffered approach:
//   1. Downloads all chunks from Storage into a single Uint8Array
//   2. Computes multipart/form-data Content-Length from the actual buffer size
//   3. POSTs the buffer to S3 — Content-Length is preserved (unlike ReadableStream)
//
// WHY BUFFERED NOT STREAMED:
//   Deno's fetch() silently strips the Content-Length header when the request
//   body is a ReadableStream, causing AWS S3 to return HTTP 411 MissingContentLength.
//   Passing a Uint8Array body guarantees the header reaches S3 intact.
//
// Called by video-upload-chunk after all chunks are stored (via waitUntil).
// May also be called manually to retry assembly.
//
// POST /video-assemble-upload
// Body: { upload_id: string, total_chunks: number, file_name: string, mime_type: string }

import { createServiceClient, requireAuth, json, corsHeaders } from '../_shared/auth.ts';
import { checkProviderPermission } from '../_shared/provider-check.ts';

const CHUNK_BUCKET    = 'video-chunks';
const VDOCIPHER_API   = 'https://dev.vdocipher.com/api';
const ASSEMBLY_TIMEOUT_MS = 3600_000; // 1 hour max for huge files

// ── Helpers ───────────────────────────────────────────────────────────────────

function encodeText(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Compute the exact byte length of the multipart/form-data body.
 * Required for the S3 presigned POST Content-Length header.
 */
function computeMultipartLength(params: {
  boundary:   string;
  formFields: Record<string, string>;
  fileName:   string;
  mimeType:   string;
  fileSize:   number;
}): number {
  const { boundary, formFields, fileName, mimeType, fileSize } = params;
  let len = 0;

  // Each form field: --boundary\r\nContent-Disposition...\r\n\r\nvalue\r\n
  for (const [key, value] of Object.entries(formFields)) {
    len += encodeText(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    ).length;
  }

  // File field header
  len += encodeText(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  ).length;

  // File data itself
  len += fileSize;

  // Closing boundary: \r\n--boundary--\r\n
  len += encodeText(`\r\n--${boundary}--\r\n`).length;

  return len;
}

/**
 * Build the complete multipart/form-data body as a single Uint8Array.
 * Downloads all chunks from Supabase Storage and concatenates them in order.
 *
 * WHY NOT STREAM: Deno's fetch() strips the Content-Length header when the
 * request body is a ReadableStream, causing S3 to return HTTP 411
 * (MissingContentLength). Buffering the full body guarantees Content-Length
 * is preserved and matches the presigned POST policy signature.
 */
async function buildMultipartBuffer(params: {
  supabase:    ReturnType<typeof createServiceClient>;
  boundary:    string;
  formFields:  Record<string, string>;
  fileName:    string;
  mimeType:    string;
  uploadId:    string;
  totalChunks: number;
  onProgress?: (chunksDownloaded: number) => void;
}): Promise<Uint8Array> {
  const { supabase, boundary, formFields, fileName, mimeType, uploadId, totalChunks, onProgress } = params;

  const parts: Uint8Array[] = [];

  // ── Form field parts ──────────────────────────────────────────────────────
  for (const [key, value] of Object.entries(formFields)) {
    parts.push(encodeText(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    ));
  }

  // ── File field header ─────────────────────────────────────────────────────
  parts.push(encodeText(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  ));

  // ── Download and append all chunks ───────────────────────────────────────
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = `${uploadId}/${String(i).padStart(6, '0')}`;

    const { data: chunkBlob, error: dlErr } = await supabase.storage
      .from(CHUNK_BUCKET)
      .download(chunkPath);

    if (dlErr || !chunkBlob) {
      throw new Error(`Failed to download chunk ${i}: ${dlErr?.message ?? 'empty'}`);
    }

    parts.push(new Uint8Array(await chunkBlob.arrayBuffer()));
    onProgress?.(i + 1);
  }

  // ── Closing boundary ──────────────────────────────────────────────────────
  parts.push(encodeText(`\r\n--${boundary}--\r\n`));

  // Concatenate all parts into one contiguous buffer
  const totalBytes = parts.reduce((acc, p) => acc + p.byteLength, 0);
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const { userId, role } = await requireAuth(req);
    if (!['doctor', 'admin', 'super_admin'].includes(role)) {
      return json({ error: 'Unauthorized' }, 403);
    }

    const providerDenied = await checkProviderPermission(userId, role, 'vdocipher');
    if (providerDenied) return providerDenied;

    const body = await req.json() as {
      upload_id:    string;
      total_chunks: number;
      file_name:    string;
      mime_type:    string;
    };

    const { upload_id: uploadId, total_chunks: totalChunks, file_name: fileName, mime_type: mimeType } = body;

    if (!uploadId || !totalChunks || !fileName) {
      return json({ error: 'Missing required fields: upload_id, total_chunks, file_name' }, 400);
    }

    const supabase = createServiceClient();

    // ── Load upload record ──────────────────────────────────────────────────
    const { data: upload, error: uploadErr } = await supabase
      .from('video_uploads')
      .select('id, lesson_id, course_id, file_name, file_size, mime_type, status, provider_video_id, assembly_triggered')
      .eq('id', uploadId)
      .single();

    if (uploadErr || !upload) {
      return json({ error: 'Upload not found' }, 404);
    }

    const uploadAny = upload as any;

    // ── Idempotency: already assembled / processing / ready ─────────────────
    // If assembly already completed and we have a vdo video ID, return it immediately.
    const existingVdoId: string | null = uploadAny.provider_video_id ?? null;
    const currentStatus: string        = uploadAny.status ?? '';
    const alreadyDone   = ['processing', 'encoding', 'ready', 'generating_streams'].includes(currentStatus)
                          && existingVdoId;

    if (alreadyDone) {
      console.log('[video-assemble-upload] idempotent return — already processing/ready', {
        uploadId, existingVdoId, currentStatus,
      });
      return json({ status: currentStatus, video_id: existingVdoId, skipped_upload: true });
    }

    await supabase.from('upload_audit_logs').insert({
      upload_id: uploadId,
      event: 'assembly_started',
      details: { totalChunks, existingVdoId },
    });

    // Update status to 'uploading' so UI shows progress during assembly
    await supabase.from('video_uploads').update({
      status: 'uploading',
      assembly_started_at: new Date().toISOString(),
    }).eq('id', uploadId);

    // ── Step 1: Create VdoCipher video entry ────────────────────────────────
    // Always create a fresh VdoCipher entry for new assembly runs.
    let vdoVideoId: string;
    const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET');
    if (!apiSecret) {
      return json({ error: 'Video service not configured' }, 500);
    }

    // Create VdoCipher video entry
    const encodedTitle = encodeURIComponent(
      (upload as any).file_name?.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 200) ?? fileName
    );
    const createRes = await fetch(`${VDOCIPHER_API}/videos?title=${encodedTitle}`, {
      method: 'PUT',
      headers: { Authorization: `Apisecret ${apiSecret}`, Accept: 'application/json' },
    });

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      const detail = `[VdoCipher] Video creation failed — HTTP ${createRes.status}: ${(err as any).message ?? JSON.stringify(err)}`;
      console.error('[video-assemble-upload]', detail, { uploadId });
      return json({ error: detail, layer: 'VdoCipher', http_status: createRes.status }, 502);
    }

    const vdoData = await createRes.json() as { videoId: string; clientPayload: unknown };
    vdoVideoId = vdoData.videoId;

    // Normalise clientPayload
    let rawPayload: Record<string, unknown>;
    if (typeof vdoData.clientPayload === 'string') {
      rawPayload = JSON.parse(vdoData.clientPayload) as Record<string, unknown>;
    } else {
      rawPayload = vdoData.clientPayload as Record<string, unknown>;
    }

    const vdoUploadUrl = rawPayload.uploadLink as string;
    const { uploadLink: _removed, ...restPayload } = rawPayload;
    const vdoClientPayload: Record<string, string> = {};
    for (const [k, v] of Object.entries(restPayload)) {
      if (v !== undefined && v !== null) vdoClientPayload[k] = String(v);
    }
    // VdoCipher browser spec: always include these two explicitly
    vdoClientPayload['success_action_status']   = '201';
    vdoClientPayload['success_action_redirect'] = '';

    // Store vdoCipher video ID immediately for deduplication
    await supabase.from('video_uploads').update({ provider_video_id: vdoVideoId }).eq('id', uploadId);
    await supabase.from('lessons').update({ video_id: vdoVideoId, video_status: 'uploading' }).eq('id', upload.lesson_id);

    // ── Step 2: Stream assembly → S3 ────────────────────────────────────────
    const fileSize = (upload as any).file_size as number ?? 0;
    const boundary = `VdoCipherAssembly${Date.now()}`;
    const sanitizedName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Build form fields for multipart (without file field — streamed separately)
    const formFields: Record<string, string> = { ...vdoClientPayload };
    // Remove success_action_* from the dict — we already added them above
    // They must be re-added in the correct order for S3 policy compliance:
    // all other fields → success_action_status → success_action_redirect → file
    delete formFields['success_action_status'];
    delete formFields['success_action_redirect'];

    const orderedFormFields: Record<string, string> = {
      ...formFields,
      success_action_status:   '201',
      success_action_redirect: '',
    };

    const totalLength = computeMultipartLength({
      boundary:   boundary,
      formFields: orderedFormFields,
      fileName:   sanitizedName,
      mimeType:   mimeType ?? 'video/mp4',
      fileSize:   fileSize,
    });

    console.log('[video-assemble-upload] starting buffer assembly for S3', {
      uploadId, vdoVideoId, totalChunks, fileSize, expectedContentLength: totalLength,
    });

    let chunksStreamed = 0;

    // Build the complete multipart body as a single Uint8Array.
    // Buffered (not streamed) because Deno's fetch() strips the Content-Length
    // header when the body is a ReadableStream → S3 returns HTTP 411.
    const multipartBody = await buildMultipartBuffer({
      supabase,
      boundary:    boundary,
      formFields:  orderedFormFields,
      fileName:    sanitizedName,
      mimeType:    mimeType ?? 'video/mp4',
      uploadId,
      totalChunks,
      onProgress:  (n) => { chunksStreamed = n; },
    });

    // Actual byte length of the assembled buffer — must match S3 presigned policy.
    const actualContentLength = multipartBody.byteLength;

    if (actualContentLength !== totalLength) {
      console.warn('[video-assemble-upload] content-length mismatch (pre-computed vs actual)', {
        uploadId, expectedContentLength: totalLength, actualContentLength,
      });
    }

    console.log('[video-assemble-upload] starting POST to S3', {
      uploadId, vdoVideoId, chunksStreamed, actualContentLength,
    });

    // POST to S3: pass the Uint8Array body so Deno preserves Content-Length.
    const s3Res = await fetch(vdoUploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(actualContentLength),
      },
      body: multipartBody,
    });

    if (s3Res.status !== 201) {
      const s3Body = await s3Res.text().catch(() => '');
      const errMsg = `[Storage] S3 upload rejected — HTTP ${s3Res.status}: ${s3Body}`;
      console.error('[video-assemble-upload]', errMsg, { uploadId, vdoVideoId, chunksStreamed });

      await supabase.from('video_uploads').update({
        status: 'failed',
        assembly_error: errMsg,
      }).eq('id', uploadId);
      await supabase.from('lessons').update({ video_status: 'failed' }).eq('id', upload.lesson_id);
      await supabase.from('upload_audit_logs').insert({
        upload_id: uploadId,
        event: 'assembly_failed',
        details: { error: errMsg, s3Status: s3Res.status, s3Body, layer: 'Storage' },
      });

      return json({ error: errMsg, layer: 'Storage', http_status: s3Res.status }, 502);
    }

    // ── Step 3: Mark upload as processing ───────────────────────────────────
    await supabase.from('video_uploads').update({
      status: 'processing',
      upload_completed_at: new Date().toISOString(),
      processing_started_at: new Date().toISOString(),
    }).eq('id', uploadId);

    await supabase.from('lessons').update({
      video_id:     vdoVideoId,
      video_status: 'processing',
    }).eq('id', upload.lesson_id);

    await supabase.from('upload_audit_logs').insert({
      upload_id: uploadId,
      event: 'assembly_completed',
      details: { vdoVideoId, totalChunks, chunksStreamed },
    });

    // ── Step 4: Clean up chunks from Storage (best-effort) ──────────────────
    const cleanupPromise = (async () => {
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = `${uploadId}/${String(i).padStart(6, '0')}`;
        await supabase.storage.from(CHUNK_BUCKET).remove([chunkPath]).catch(() => {});
      }
    })();

    // @ts-ignore
    if (typeof EdgeRuntime !== 'undefined') {
      // @ts-ignore
      EdgeRuntime.waitUntil(cleanupPromise);
    }

    console.log('[video-assemble-upload] SUCCESS', { uploadId, vdoVideoId, chunksStreamed });

    return json({ status: 'processing', video_id: vdoVideoId, chunks_assembled: chunksStreamed });

  } catch (err: unknown) {
    const msg  = err instanceof Error ? err.message  : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : '';
    console.error('[video-assemble-upload] [unhandled]', { msg, stack, uploadId: 'unknown' });
    return json({ error: `[EF:video-assemble-upload] ${msg}`, layer: 'EF:video-assemble-upload' }, 500);
  }
});
