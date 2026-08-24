// supabase/functions/vdocipher-delete-video/index.ts
//
// Deletes a single VdoCipher video asset and optionally clears the lesson
// video reference in the database.
//
// Called by: delete-lesson, delete-course, cancel-upload, replace-video,
//            vdocipher-orphan-cleanup.
//
// DELETE order (per spec):
//   1. Call VdoCipher DELETE API — wait for response.
//   2a. Success (2xx) or 404 (already gone) → clear DB record if requested.
//   2b. Any other error → return error, do NOT touch DB.
//
// POST body:
//   { video_id: string, lesson_id?: string, upload_id?: string,
//     reason?: string, clear_lesson?: boolean }
//
// Response:
//   { success, vdo_deleted, video_id, vdo_status?, vdo_response?, error? }

import { requireAuth, json, corsHeaders, createServiceClient } from '../_shared/auth.ts';

const VDOCIPHER_API = 'https://dev.vdocipher.com/api';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const ts = new Date().toISOString();

  try {
    const { userId, role } = await requireAuth(req);

    const body = await req.json().catch(() => ({})) as {
      video_id?:    string;
      lesson_id?:   string;
      upload_id?:   string;
      reason?:      string;
      clear_lesson?: boolean;
    };

    const videoId    = body.video_id?.trim();
    const lessonId   = body.lesson_id?.trim();
    const uploadId   = body.upload_id?.trim();
    const reason     = body.reason ?? 'manual_delete';
    const clearLesson = body.clear_lesson ?? false;

    if (!videoId) return json({ error: 'video_id is required' }, 400);

    // ── Get API secret ────────────────────────────────────────────────────────
    const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET');
    if (!apiSecret) {
      console.error('[vdocipher-delete-video] VDOCIPHER_API_SECRET not configured');
      return json({ error: 'Video service not configured' }, 500);
    }

    // ── Call VdoCipher DELETE API ─────────────────────────────────────────────
    // Official endpoint: DELETE /api/videos?videos=<videoId>
    const deleteUrl = `${VDOCIPHER_API}/videos?videos=${encodeURIComponent(videoId)}`;

    console.log('[vdocipher-delete-video] DELETE request', {
      video_id:  videoId,
      lesson_id: lessonId ?? null,
      upload_id: uploadId ?? null,
      reason,
      url:       deleteUrl,
      actor_id:  userId,
      timestamp: ts,
    });

    const vdoRes = await fetch(deleteUrl, {
      method:  'DELETE',
      headers: {
        Authorization: `Apisecret ${apiSecret}`,
        Accept:        'application/json',
      },
    });

    const vdoBody = await vdoRes.json().catch(() => ({}));

    console.log('[vdocipher-delete-video] DELETE response', {
      video_id:   videoId,
      http_status: vdoRes.status,
      ok:         vdoRes.ok,
      body:       vdoBody,
      timestamp:  new Date().toISOString(),
    });

    // 404 = video was already deleted — treat as success (idempotent)
    const alreadyGone = vdoRes.status === 404;
    const vdoDeleted  = vdoRes.ok || alreadyGone;

    if (!vdoDeleted) {
      // VdoCipher returned an error — do NOT touch the DB
      const errMsg = vdoBody?.message ?? vdoBody?.error ?? `HTTP ${vdoRes.status}`;
      console.error('[vdocipher-delete-video] VdoCipher deletion FAILED — DB record preserved', {
        video_id:    videoId,
        lesson_id:   lessonId ?? null,
        http_status: vdoRes.status,
        error:       errMsg,
        timestamp:   new Date().toISOString(),
      });
      return json({
        success:     false,
        vdo_deleted: false,
        video_id:    videoId,
        vdo_status:  vdoRes.status,
        vdo_response: vdoBody,
        error:       errMsg,
      }, 502);
    }

    // ── VdoCipher deletion confirmed — update DB ──────────────────────────────
    const svc = createServiceClient();

    if (clearLesson && lessonId) {
      const { error: clearErr } = await svc.from('lessons').update({
        video_id:               null,
        video_status:           'none',
        video_upload_id:        null,
        video_thumbnail_url:    null,
        video_duration_seconds: null,
        updated_at:             new Date().toISOString(),
      }).eq('id', lessonId);

      if (clearErr) {
        console.error('[vdocipher-delete-video] failed to clear lesson video ref', {
          lesson_id: lessonId, error: clearErr.message,
        });
      }
    }

    if (uploadId) {
      await svc.from('video_uploads').update({
        status:     'deleted',
        updated_at: new Date().toISOString(),
      }).eq('id', uploadId).catch(() => {});
    }

    // Audit log
    svc.from('upload_audit_logs').insert({
      upload_id: uploadId ?? null,
      event:     'vdo_asset_deleted',
      details: {
        video_id:     videoId,
        lesson_id:    lessonId ?? null,
        already_gone: alreadyGone,
        reason,
        actor_id:     userId,
        actor_role:   role,
        timestamp:    new Date().toISOString(),
      },
    }).then(() => {}).catch(() => {});

    console.log('[vdocipher-delete-video] SUCCESS', {
      video_id:     videoId,
      lesson_id:    lessonId ?? null,
      already_gone: alreadyGone,
      clear_lesson: clearLesson,
      timestamp:    new Date().toISOString(),
    });

    return json({
      success:      true,
      vdo_deleted:  true,
      video_id:     videoId,
      already_gone: alreadyGone,
      vdo_response: vdoBody,
    });

  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[vdocipher-delete-video] unhandled error', String(e));
    return json({ error: String(e) }, 500);
  }
});
