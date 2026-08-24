// supabase/functions/video-upload-chunk/index.ts
//
// Receives a single binary chunk from the client and stores it in the
// video-chunks Storage bucket. Atomically increments chunks_completed.
// When all chunks are received, triggers assembly via waitUntil.
//
// POST /video-upload-chunk
// Headers:
//   x-upload-id:     string (UUID — video_uploads.id)
//   x-chunk-index:   number (0-based)
//   x-total-chunks:  number
//   x-chunk-size:    number (bytes of this chunk, for validation)
//   x-file-name:     string
//   x-mime-type:     string
// Body: raw binary chunk data (application/octet-stream)
//
// Response: { received: N, total: M, assembly_triggered: bool }

import { createServiceClient, requireAuth, json, corsHeaders } from '../_shared/auth.ts';

const CHUNK_BUCKET = 'video-chunks';
const ASSEMBLY_FUNCTION = 'video-assemble-upload';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    const { userId, role, token } = await requireAuth(req);
    if (!['doctor', 'admin', 'super_admin'].includes(role)) {
      return json({ error: 'Only doctors and admins may upload videos' }, 403);
    }

    // ── Parse headers ───────────────────────────────────────────────────────
    const uploadId    = req.headers.get('x-upload-id')?.trim();
    const chunkIndex  = parseInt(req.headers.get('x-chunk-index') ?? '', 10);
    const totalChunks = parseInt(req.headers.get('x-total-chunks') ?? '', 10);
    const chunkSizeH  = parseInt(req.headers.get('x-chunk-size') ?? '0', 10);
    const fileName    = req.headers.get('x-file-name') ?? 'video.mp4';
    const mimeType    = req.headers.get('x-mime-type') ?? 'video/mp4';

    if (!uploadId || isNaN(chunkIndex) || isNaN(totalChunks) || totalChunks < 1) {
      return json({ error: 'Missing or invalid headers: x-upload-id, x-chunk-index, x-total-chunks' }, 400);
    }
    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
      return json({ error: `chunkIndex ${chunkIndex} out of range [0, ${totalChunks - 1}]` }, 400);
    }

    const supabase = createServiceClient();

    // ── Verify upload belongs to caller ─────────────────────────────────────
    const { data: uploadRow, error: uploadErr } = await supabase
      .from('video_uploads')
      .select('id, doctor_id, lesson_id, course_id, file_name, file_size, mime_type, status, chunks_completed, total_chunks, assembly_triggered')
      .eq('id', uploadId)
      .single();

    if (uploadErr || !uploadRow) {
      return json({ error: 'Upload record not found' }, 404);
    }
    if (role === 'doctor' && uploadRow.doctor_id !== userId) {
      return json({ error: 'You do not own this upload' }, 403);
    }
    if (uploadRow.assembly_triggered) {
      // Already assembling — idempotent success
      return json({ received: uploadRow.chunks_completed, total: totalChunks, assembly_triggered: true });
    }

    // ── Read chunk body ─────────────────────────────────────────────────────
    const chunkData = await req.arrayBuffer();
    if (chunkData.byteLength === 0) {
      return json({ error: 'Empty chunk body' }, 400);
    }
    if (chunkSizeH > 0 && chunkData.byteLength !== chunkSizeH) {
      console.warn('[video-upload-chunk] chunk size mismatch', {
        expected: chunkSizeH, received: chunkData.byteLength,
      });
    }

    // ── Storage path: video-chunks/{uploadId}/{chunkIndex:06d} ──────────────
    const chunkPath = `${uploadId}/${String(chunkIndex).padStart(6, '0')}`;

    const { error: storageErr } = await supabase.storage
      .from(CHUNK_BUCKET)
      .upload(chunkPath, chunkData, {
        contentType: 'application/octet-stream',
        upsert: true,  // idempotent: re-uploading the same chunk is safe
      });

    if (storageErr) {
      console.error('[video-upload-chunk] [Storage] chunk upload failed', {
        uploadId, chunkIndex, error: storageErr.message, bucket: CHUNK_BUCKET, path: chunkPath,
      });
      return json({
        error: `[Storage] Failed to store chunk ${chunkIndex}: ${storageErr.message}`,
        layer: 'Storage',
        chunk_index: chunkIndex,
      }, 500);
    }

    // ── Atomically increment chunks_completed ────────────────────────────────
    // Use RPC for atomic increment to handle concurrent chunk uploads safely.
    const { data: countRow, error: rpcErr } = await supabase.rpc(
      'increment_chunks_completed',
      { p_upload_id: uploadId, p_total_chunks: totalChunks },
    );

    if (rpcErr || !countRow || countRow.length === 0) {
      console.error('[video-upload-chunk] [DB] increment_chunks_completed RPC failed', {
        uploadId, chunkIndex, error: rpcErr?.message,
      });
      // Non-fatal: chunk was stored; another chunk will trigger assembly
      return json({
        received: chunkIndex + 1, total: totalChunks, assembly_triggered: false,
        warning: `[DB] increment RPC failed: ${rpcErr?.message ?? 'empty result'}`,
      });
    }

    const { chunks_completed: newCount, total_chunks: storedTotal, assembly_triggered } = countRow[0];

    console.log('[video-upload-chunk] chunk stored', {
      uploadId, chunkIndex, newCount, totalChunks, assembly_triggered,
    });

    // ── All chunks received — trigger assembly ───────────────────────────────
    if (newCount >= storedTotal && storedTotal > 0 && !assembly_triggered) {
      // Mark assembly as triggered atomically (prevent double-trigger)
      await supabase
        .from('video_uploads')
        .update({ assembly_triggered: true, assembly_started_at: new Date().toISOString() })
        .eq('id', uploadId)
        .eq('assembly_triggered', false); // conditional update — only one winner

      // Audit log
      await supabase.from('upload_audit_logs').insert({
        upload_id: uploadId,
        event: 'assembly_triggered',
        details: { chunks: newCount, total: storedTotal },
      });

      // Trigger assembly in background (fire-and-forget via waitUntil)
      const assemblyUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/${ASSEMBLY_FUNCTION}`;
      const assemblyBody = JSON.stringify({
        upload_id:    uploadId,
        total_chunks: storedTotal,
        file_name:    fileName,
        mime_type:    mimeType,
      });

      const assemblyPromise = fetch(assemblyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        },
        body: assemblyBody,
      }).then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          console.error('[video-upload-chunk] assembly trigger failed', { status: r.status, body });
        } else {
          console.log('[video-upload-chunk] assembly triggered successfully', { uploadId });
        }
      }).catch((e) => {
        console.error('[video-upload-chunk] assembly fetch error', e);
      });

      // @ts-ignore — Deno-specific, not in Node types
      if (typeof EdgeRuntime !== 'undefined') {
        // @ts-ignore
        EdgeRuntime.waitUntil(assemblyPromise);
      }

      return json({ received: newCount, total: storedTotal, assembly_triggered: true });
    }

    return json({ received: newCount, total: storedTotal, assembly_triggered: false });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : '';
    console.error('[video-upload-chunk] [RN→EF] unhandled error', { msg, stack });
    return json({ error: `[EF:video-upload-chunk] ${msg}`, layer: 'EF:video-upload-chunk' }, 500);
  }
});
