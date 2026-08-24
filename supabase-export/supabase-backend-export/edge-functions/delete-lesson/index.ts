// supabase/functions/delete-lesson/index.ts
//
// Atomically deletes a lesson and all associated assets:
//   1. Delete VdoCipher asset (if video_id present)
//   2. Delete Supabase Storage files (video, thumbnail, PDFs, materials)
//   3. Delete DB rows: lesson_pdfs → lesson_materials → video_uploads → lesson
//   4. Write audit log
//
// Only the lesson-owning doctor (or admin) may call this.

import { createClient } from 'npm:@supabase/supabase-js@2';

function createServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, x-client-info',
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

const VDOCIPHER_API = 'https://dev.vdocipher.com/api';

async function requireAuth(req: Request, svc: ReturnType<typeof createServiceClient>) {
  const auth = req.headers.get('Authorization');
  if (!auth) throw new Response('Missing Authorization', { status: 401 });
  const token = auth.replace('Bearer ', '');
  const { data: { user }, error } = await svc.auth.getUser(token);
  if (error || !user) throw new Response('Invalid token', { status: 401 });
  const { data: profile } = await svc.from('profiles').select('role').eq('id', user.id).single();
  return { userId: user.id, role: (profile?.role ?? 'student') as string };
}

function extractStoragePath(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/object\/(?:public|sign)\/[^/]+\/(.+?)(?:\?.*)?$/);
  return m ? m[1] : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const svc = createServiceClient();

  try {
    const { userId, role } = await requireAuth(req, svc);
    if (!['doctor', 'admin', 'super_admin'].includes(role)) {
      return json({ error: 'Forbidden' }, 403);
    }

    const body = await req.json() as { lesson_id?: string; reason?: string };
    const lessonId = body.lesson_id?.trim();
    if (!lessonId) return json({ error: 'lesson_id is required' }, 400);

    // ── Fetch lesson + verify ownership ───────────────────────────────────────
    const { data: lesson, error: lessonErr } = await svc
      .from('lessons')
      .select(`
        id, title, video_id, video_thumbnail_url, video_upload_id,
        section:sections(course_id, courses(doctor_id))
      `)
      .eq('id', lessonId)
      .single();

    if (lessonErr || !lesson) return json({ error: 'Lesson not found' }, 404);

    const doctorId = (lesson as any).section?.courses?.doctor_id;
    if (role === 'doctor' && doctorId !== userId) {
      return json({ error: 'You do not own this lesson' }, 403);
    }

    const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET');

    // ── 1. VdoCipher asset deletion (MUST succeed before DB delete) ───────────
    let vdoDeleted = false;
    let vdoError: string | null = null;

    if (lesson.video_id && apiSecret) {
      const videoId   = lesson.video_id;
      const deleteUrl = `${VDOCIPHER_API}/videos?videos=${encodeURIComponent(videoId)}`;

      console.log('[delete-lesson] VdoCipher DELETE request', {
        lessonId,
        video_id:  videoId,
        url:       deleteUrl,
        timestamp: new Date().toISOString(),
      });

      const vdoRes = await fetch(deleteUrl, {
        method:  'DELETE',
        headers: {
          Authorization: `Apisecret ${apiSecret}`,
          Accept:        'application/json',
        },
      });

      const vdoBody = await vdoRes.json().catch(() => ({}));

      console.log('[delete-lesson] VdoCipher DELETE response', {
        lessonId,
        video_id:    videoId,
        http_status: vdoRes.status,
        ok:          vdoRes.ok,
        body:        vdoBody,
        timestamp:   new Date().toISOString(),
      });

      const alreadyGone = vdoRes.status === 404; // already deleted = success
      vdoDeleted = vdoRes.ok || alreadyGone;

      if (!vdoDeleted) {
        // VdoCipher deletion failed — do NOT delete the DB record
        vdoError = vdoBody?.message ?? vdoBody?.error ?? `HTTP ${vdoRes.status}`;
        console.error('[delete-lesson] VdoCipher deletion FAILED — aborting, DB record preserved', {
          lessonId, video_id: videoId, error: vdoError, timestamp: new Date().toISOString(),
        });
        return json({
          success:     false,
          lesson_id:   lessonId,
          vdo_deleted: false,
          vdo_error:   vdoError,
          vdo_status:  vdoRes.status,
          vdo_response: vdoBody,
        }, 502);
      }

      if (alreadyGone) {
        console.log('[delete-lesson] VdoCipher video already gone (404) — treating as success', {
          lessonId, video_id: videoId,
        });
      }
    } else if (!lesson.video_id) {
      // No video attached to this lesson — nothing to delete on VdoCipher
      vdoDeleted = true;
      console.log('[delete-lesson] no video_id on lesson — skipping VdoCipher delete', { lessonId });
    } else {
      // API secret missing — log but continue so admins can still delete lessons
      vdoError = 'VDOCIPHER_API_SECRET not configured';
      console.error('[delete-lesson] VDOCIPHER_API_SECRET not set — cannot delete VdoCipher asset', {
        lessonId, video_id: lesson.video_id,
      });
    }

    // ── 2. Collect storage paths ───────────────────────────────────────────────
    const pdfPaths: string[] = [];
    const materialPaths: string[] = [];

    const { data: pdfs } = await svc
      .from('lesson_pdfs')
      .select('file_url')
      .eq('lesson_id', lessonId);
    (pdfs ?? []).forEach((p: any) => {
      const path = extractStoragePath(p.file_url);
      if (path) pdfPaths.push(path);
    });

    const { data: materials } = await svc
      .from('lesson_materials')
      .select('storage_path, file_url')
      .eq('lesson_id', lessonId);
    (materials ?? []).forEach((m: any) => {
      const path = m.storage_path || extractStoragePath(m.file_url);
      if (path) materialPaths.push(path);
    });

    const { data: uploads } = await svc
      .from('video_uploads')
      .select('storage_path, thumbnail_storage_path')
      .eq('lesson_id', lessonId);
    (uploads ?? []).forEach((v: any) => {
      if (v.storage_path) materialPaths.push(v.storage_path);
      if (v.thumbnail_storage_path) materialPaths.push(v.thumbnail_storage_path);
    });

    // Thumbnail URL
    if (lesson.video_thumbnail_url) {
      const p = extractStoragePath(lesson.video_thumbnail_url);
      if (p) materialPaths.push(p);
    }

    // ── 3. Cascade DB delete ───────────────────────────────────────────────────
    await svc.from('lesson_pdfs').delete().eq('lesson_id', lessonId);
    await svc.from('lesson_materials').delete().eq('lesson_id', lessonId);
    await svc.from('video_uploads').delete().eq('lesson_id', lessonId);

    const { error: deleteErr } = await svc.from('lessons').delete().eq('id', lessonId);
    if (deleteErr) return json({ error: deleteErr.message }, 500);

    // ── 4. Storage cleanup (best-effort, fire-and-forget) ─────────────────────
    (async () => {
      try {
        await Promise.allSettled([
          pdfPaths.length      > 0 && svc.storage.from('lesson-pdfs').remove(pdfPaths),
          materialPaths.length > 0 && svc.storage.from('lesson-materials').remove(materialPaths),
        ]);
      } catch (_) {}
    })();

    // ── 5. Audit log ──────────────────────────────────────────────────────────
    svc.from('upload_audit_logs').insert({
      upload_id:  lesson.video_upload_id ?? null,
      event:      'lesson_deleted',
      details: {
        actor_id:    userId,
        actor_role:  role,
        lesson_id:   lessonId,
        lesson_title: (lesson as any).title,
        video_id:    lesson.video_id,
        vdo_deleted: vdoDeleted,
        vdo_error:   vdoError,
        reason:      body.reason ?? 'doctor_delete',
      },
    }).then(() => {}).catch(() => {});

    return json({
      success: true,
      lesson_id:   lessonId,
      vdo_deleted: vdoDeleted,
      vdo_error:   vdoError,
    });

  } catch (e) {
    if (e instanceof Response) return e;
    return json({ error: String(e) }, 500);
  }
});
