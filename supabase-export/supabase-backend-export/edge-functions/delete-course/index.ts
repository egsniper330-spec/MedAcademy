// supabase/functions/delete-course/index.ts
//
// Permanently deletes a doctor's own course in a safe ordered cascade:
//   1. Collect storage paths + VdoCipher video IDs
//   2. Delete each VdoCipher asset (required before DB delete — prevents orphans)
//   3. Delete DB rows: lesson_pdfs → lesson_materials → video_uploads →
//      lessons → sections → activation_codes → enrollments → course
//   4. Delete storage files from all three buckets (best-effort)
//   5. Write audit log
//
// Returns: { success, title, students_removed, lessons_deleted,
//            videos_deleted, vdo_deleted, storage_bytes_freed }

import { createClient } from 'npm:@supabase/supabase-js@2';

const VDOCIPHER_API = 'https://dev.vdocipher.com/api';

function createServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );
}

/** Delete a single VdoCipher video asset. Returns true on success or 404-not-found. */
async function deleteVdoCipherAsset(videoId: string, apiSecret: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${VDOCIPHER_API}/videos?videos=${encodeURIComponent(videoId)}`,
      { method: 'DELETE', headers: { Authorization: `Apisecret ${apiSecret}` } },
    );
    return res.ok || res.status === 404;
  } catch (_) {
    return false;
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, x-client-info, x-idempotency-key',
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function err(code: string, message: string, step: string, status = 400) {
  return json({ success: false, code, message, step }, status);
}

async function requireAuth(req: Request, svc: ReturnType<typeof createServiceClient>) {
  const auth = req.headers.get('Authorization');
  if (!auth) throw new Response('Missing Authorization header', { status: 401 });
  const token = auth.replace('Bearer ', '');
  const { data: { user }, error } = await svc.auth.getUser(token);
  if (error || !user) throw new Response('Invalid token', { status: 401 });
  const { data: profile } = await svc.from('profiles').select('role').eq('id', user.id).single();
  return { userId: user.id, role: (profile?.role ?? 'student') as string };
}

/** Extract the storage object path from a full Supabase public URL.
 *  e.g. https://xxx.supabase.co/storage/v1/object/public/bucket/a/b.jpg → a/b.jpg */
function extractStoragePath(url: string | null | undefined): string | null {
  if (!url) return null;
  // match /object/public/<bucket>/... or /object/sign/<bucket>/...
  const m = url.match(/\/object\/(?:public|sign)\/[^/]+\/(.+?)(?:\?.*)?$/);
  return m ? m[1] : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return err('METHOD_NOT_ALLOWED', 'POST only', 'routing', 405);

  const svc = createServiceClient();

  try {
    const { userId: actorId, role: actorRole } = await requireAuth(req, svc);
    if (!['doctor', 'admin', 'super_admin'].includes(actorRole)) {
      return err('FORBIDDEN', 'Requires doctor or admin role', 'auth', 403);
    }

    const body = await req.json() as { course_id?: string };
    const courseId = body.course_id?.trim();
    if (!courseId) return err('MISSING_FIELD', 'course_id is required', 'validation');

    // ── Fetch course + verify ownership ────────────────────────────────────────
    const { data: course, error: courseErr } = await svc
      .from('courses')
      .select('id, title, doctor_id, image_url, thumbnail_url, cover_url')
      .eq('id', courseId)
      .single();

    if (courseErr || !course) return err('NOT_FOUND', 'Course not found', 'fetch', 404);
    if (actorRole === 'doctor' && course.doctor_id !== actorId) {
      return err('FORBIDDEN', 'You do not own this course', 'ownership', 403);
    }

    // ── Collect all lesson IDs and storage paths ────────────────────────────────
    const { data: lessons } = await svc
      .from('lessons')
      .select('id, video_id')
      .eq('course_id', courseId);

    const lessonIds = (lessons ?? []).map((l: any) => l.id);
    const lessonsDeleted = lessonIds.length;

    // Collect VdoCipher video IDs from lessons
    const vdoCipherVideoIds: string[] = [];
    (lessons ?? []).forEach((l: any) => {
      if (l.video_id) vdoCipherVideoIds.push(l.video_id);
    });

    // Collect storage paths
    const courseImagePaths: string[] = [];
    const pdfPaths: string[] = [];
    const materialPaths: string[] = [];

    // Course-level images
    [course.image_url, course.thumbnail_url, course.cover_url].forEach(url => {
      const p = extractStoragePath(url);
      if (p) courseImagePaths.push(p);
    });

    let videosDeleted = 0;
    let storageBytesFreed = 0;

    if (lessonIds.length > 0) {
      // lesson_pdfs
      const { data: pdfs } = await svc
        .from('lesson_pdfs')
        .select('file_url, file_size')
        .in('lesson_id', lessonIds);
      (pdfs ?? []).forEach((p: any) => {
        const path = extractStoragePath(p.file_url);
        if (path) pdfPaths.push(path);
        storageBytesFreed += p.file_size ?? 0;
      });

      // lesson_materials
      const { data: materials } = await svc
        .from('lesson_materials')
        .select('storage_path, file_url, file_size')
        .in('lesson_id', lessonIds);
      (materials ?? []).forEach((m: any) => {
        const path = m.storage_path || extractStoragePath(m.file_url);
        if (path) materialPaths.push(path);
        storageBytesFreed += m.file_size ?? 0;
      });

      // video_uploads
      const { data: videos } = await svc
        .from('video_uploads')
        .select('storage_path, thumbnail_storage_path, file_size')
        .eq('course_id', courseId);
      videosDeleted = (videos ?? []).length;
      (videos ?? []).forEach((v: any) => {
        if (v.storage_path) materialPaths.push(v.storage_path);
        if (v.thumbnail_storage_path) materialPaths.push(v.thumbnail_storage_path);
        storageBytesFreed += v.file_size ?? 0;
      });
    }

    // Count enrollments before deletion
    const { count: enrollCount } = await svc
      .from('enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', courseId);
    const studentsRemoved = enrollCount ?? 0;

    // ── VdoCipher asset deletion (before any DB deletes) ──────────────────────
    // Delete all VdoCipher videos first. Continue on individual failure (bulk
    // safety) but collect failures. DB cascade proceeds regardless, with failures
    // reported in the response so callers can clean up stragglers.
    const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET');
    let vdoDeletedCount = 0;
    const vdoFailures: Array<{ video_id: string; error: string }> = [];

    if (apiSecret && vdoCipherVideoIds.length > 0) {
      console.log('[delete-course] starting VdoCipher bulk delete', {
        courseId,
        total_videos: vdoCipherVideoIds.length,
        timestamp: new Date().toISOString(),
      });

      await Promise.allSettled(
        vdoCipherVideoIds.map(async (videoId) => {
          const deleteUrl = `${VDOCIPHER_API}/videos?videos=${encodeURIComponent(videoId)}`;

          console.log('[delete-course] VdoCipher DELETE request', {
            courseId, video_id: videoId, url: deleteUrl, timestamp: new Date().toISOString(),
          });

          try {
            const vdoRes = await fetch(deleteUrl, {
              method:  'DELETE',
              headers: {
                Authorization: `Apisecret ${apiSecret}`,
                Accept:        'application/json',
              },
            });

            const vdoBody = await vdoRes.json().catch(() => ({}));

            console.log('[delete-course] VdoCipher DELETE response', {
              courseId, video_id: videoId,
              http_status: vdoRes.status, ok: vdoRes.ok,
              body: vdoBody, timestamp: new Date().toISOString(),
            });

            const alreadyGone = vdoRes.status === 404;
            if (vdoRes.ok || alreadyGone) {
              vdoDeletedCount++;
            } else {
              const errMsg = vdoBody?.message ?? vdoBody?.error ?? `HTTP ${vdoRes.status}`;
              console.error('[delete-course] VdoCipher DELETE failed for video (continuing)', {
                courseId, video_id: videoId, error: errMsg,
              });
              vdoFailures.push({ video_id: videoId, error: errMsg });
            }
          } catch (fetchErr) {
            const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
            console.error('[delete-course] VdoCipher DELETE threw exception (continuing)', {
              courseId, video_id: videoId, error: errMsg,
            });
            vdoFailures.push({ video_id: videoId, error: errMsg });
          }
        }),
      );

      console.log('[delete-course] VdoCipher bulk delete complete', {
        courseId,
        deleted: vdoDeletedCount,
        failed:  vdoFailures.length,
        timestamp: new Date().toISOString(),
      });
    } else if (!apiSecret) {
      console.error('[delete-course] VDOCIPHER_API_SECRET not set — cannot delete VdoCipher assets', {
        courseId, total_videos: vdoCipherVideoIds.length,
      });
    }

    // ── Cascade DB deletions (ordered to respect FKs) ──────────────────────────

    // 1. lesson_pdfs
    if (lessonIds.length > 0) {
      await svc.from('lesson_pdfs').delete().in('lesson_id', lessonIds);
      // 2. lesson_materials
      await svc.from('lesson_materials').delete().in('lesson_id', lessonIds);
      // 3. video_uploads
      await svc.from('video_uploads').delete().eq('course_id', courseId);
      // 4. lessons
      await svc.from('lessons').delete().eq('course_id', courseId);
    }

    // 5. sections
    await svc.from('sections').delete().eq('course_id', courseId);
    // 6. activation_codes
    await svc.from('activation_codes').delete().eq('course_id', courseId);
    // 7. enrollments
    await svc.from('enrollments').delete().eq('course_id', courseId);
    // 8. course itself
    const { error: deleteErr } = await svc.from('courses').delete().eq('id', courseId);
    if (deleteErr) {
      return err('DELETE_FAILED', deleteErr.message, 'course_delete', 500);
    }

    // ── Storage cleanup (non-blocking — best-effort, never fails the response) ──
    const storageCleanup = async () => {
      try {
        const buckets: Array<{ bucket: string; paths: string[] }> = [
          { bucket: 'course-images',    paths: courseImagePaths },
          { bucket: 'lesson-pdfs',      paths: pdfPaths },
          { bucket: 'lesson-materials', paths: materialPaths },
        ];
        await Promise.allSettled(
          buckets
            .filter(b => b.paths.length > 0)
            .map(b => svc.storage.from(b.bucket).remove(b.paths))
        );
      } catch (_) { /* storage errors must never fail the response */ }
    };
    // Fire and forget — do not await
    storageCleanup();

    // ── Audit log ──────────────────────────────────────────────────────────────
    svc.from('audit_logs').insert({
      actor_id:      actorId,
      action:        'course_deleted',
      resource_type: 'course',
      resource_id:   courseId,
      success:       true,
      details: {
        course_title:     course.title,
        deleted_by_role:  actorRole,
        students_removed: studentsRemoved,
        lessons_deleted:  lessonsDeleted,
        videos_deleted:   videosDeleted,
        storage_bytes_freed: storageBytesFreed,
      },
    }).then(() => {}).catch(() => {});

    return json({
      success: true,
      title:               course.title,
      students_removed:    studentsRemoved,
      lessons_deleted:     lessonsDeleted,
      videos_deleted:      videosDeleted,
      vdo_deleted:         vdoDeletedCount,
      vdo_failed:          vdoFailures.length,
      vdo_failures:        vdoFailures,
      storage_bytes_freed: storageBytesFreed,
    });

  } catch (e) {
    if (e instanceof Response) return e;
    return err('INTERNAL_ERROR', String(e), 'unexpected', 500);
  }
});
