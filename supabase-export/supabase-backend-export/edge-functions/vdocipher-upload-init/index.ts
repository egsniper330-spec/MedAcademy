// supabase/functions/vdocipher-upload-init/index.ts
//
// Creates a VdoCipher video entry and returns upload credentials so the
// frontend can upload the file DIRECTLY to VdoCipher's S3 endpoint.
//
// VDOCIPHER_API_SECRET never leaves this function.
//
// POST /vdocipher-upload-init
// Body: { lesson_id: string, title: string }
// Response: { video_id, upload_url, form_fields }
//   • video_id    — VdoCipher's opaque video ID (stored on the lesson)
//   • upload_url  — S3 presigned POST endpoint (extracted from clientPayload.uploadLink)
//   • form_fields — ALL remaining clientPayload fields verbatim (key, policy,
//                   x-amz-*, success_action_status, success_action_redirect,
//                   Content-Type, …).  Frontend appends every field as-is.

import { requireAuth, json, corsHeaders, createServiceClient } from '../_shared/auth.ts';
import { checkProviderPermission } from '../_shared/provider-check.ts';

const VDOCIPHER_API = 'https://dev.vdocipher.com/api';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    // ── Auth: only doctors/admins may upload ─────────────────────────────────
    const { userId, role } = await requireAuth(req);
    if (!['doctor', 'admin', 'super_admin'].includes(role)) {
      return json({ error: 'Only doctors and admins may upload videos' }, 403);
    }

    // ── Provider permission check ────────────────────────────────────────────
    const providerDenied = await checkProviderPermission(userId, role, 'vdocipher');
    if (providerDenied) return providerDenied;

    const body = await req.json();
    const { lesson_id, title } = body as { lesson_id?: string; title?: string };

    if (!lesson_id || typeof lesson_id !== 'string') {
      return json({ error: 'lesson_id is required' }, 400);
    }
    if (!title || typeof title !== 'string') {
      return json({ error: 'title is required' }, 400);
    }

    // ── Verify the lesson belongs to this doctor ─────────────────────────────
    const supabase = createServiceClient();
    const { data: lesson, error: lessonErr } = await supabase
      .from('lessons')
      .select('id, course_id, courses!inner(doctor_id)')
      .eq('id', lesson_id)
      .single();

    if (lessonErr || !lesson) {
      console.error('[vdocipher-upload-init] lesson not found', { lesson_id, lessonErr });
      return json({ error: 'Lesson not found' }, 404);
    }

    const courseAny = lesson as any;
    const doctorId = courseAny.courses?.doctor_id ?? courseAny['courses']?.doctor_id;
    if (role === 'doctor' && doctorId !== userId) {
      return json({ error: 'You do not own this course' }, 403);
    }

    // ── Get API secret ────────────────────────────────────────────────────────
    const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET');
    if (!apiSecret) {
      console.error('[vdocipher-upload-init] VDOCIPHER_API_SECRET not configured');
      return json({ error: 'Video service not configured' }, 500);
    }

    // ── Step 1: Create a VdoCipher video entry ────────────────────────────────
    // PUT /api/videos?title=<title>
    // VdoCipher returns { videoId, clientPayload } where clientPayload may be
    // EITHER a plain object OR a JSON-encoded string depending on API version.
    // We normalise to an object here so downstream code is always consistent.
    const encodedTitle = encodeURIComponent(title.slice(0, 200));
    const createUrl = `${VDOCIPHER_API}/videos?title=${encodedTitle}`;

    const vdoRes = await fetch(createUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Apisecret ${apiSecret}`,
        Accept: 'application/json',
      },
    });

    const vdoBody = await vdoRes.json().catch(() => ({}));

    if (!vdoRes.ok) {
      const errMsg = vdoBody?.message ?? vdoBody?.error ?? `HTTP ${vdoRes.status}`;
      console.error('[vdocipher-upload-init] VdoCipher API error', {
        status: vdoRes.status,
        error: errMsg,
        lesson_id,
      });
      return json({
        error: `VdoCipher rejected the request: ${errMsg}`,
        vdocipher_status: vdoRes.status,
        vdocipher_body: vdoBody,
      }, 502);
    }

    const { videoId, clientPayload: rawClientPayload } = vdoBody as {
      videoId?: string;
      clientPayload?: unknown;
    };

    if (!videoId || rawClientPayload == null) {
      console.error('[vdocipher-upload-init] unexpected VdoCipher response shape', {
        videoId, clientPayloadType: typeof rawClientPayload,
        bodyKeys: Object.keys(vdoBody),
      });
      return json({
        error: 'VdoCipher returned unexpected response — videoId or clientPayload missing',
        vdocipher_body: vdoBody,
      }, 502);
    }

    // ── Normalise clientPayload → plain object ────────────────────────────────
    let rawPayload: Record<string, unknown>;
    if (typeof rawClientPayload === 'string') {
      try {
        const parsed = JSON.parse(rawClientPayload);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rawPayload = parsed as Record<string, unknown>;
        } else {
          throw new Error('clientPayload JSON string did not parse to an object');
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[vdocipher-upload-init] clientPayload JSON.parse failed', { error: msg, preview: rawClientPayload.slice(0, 80) });
        return json({ error: `clientPayload parse error: ${msg}` }, 502);
      }
    } else if (typeof rawClientPayload === 'object' && !Array.isArray(rawClientPayload)) {
      rawPayload = rawClientPayload as Record<string, unknown>;
    } else {
      console.error('[vdocipher-upload-init] clientPayload has unexpected type', {
        type: typeof rawClientPayload,
      });
      return json({ error: `Unexpected clientPayload type: ${typeof rawClientPayload}` }, 502);
    }

    // ── Split upload_url from form_fields ─────────────────────────────────────
    const uploadUrl = rawPayload.uploadLink as string | undefined;
    if (!uploadUrl) {
      console.error('[vdocipher-upload-init] uploadLink missing from clientPayload', {
        clientPayloadKeys: Object.keys(rawPayload),
      });
      return json({ error: 'uploadLink missing from VdoCipher clientPayload' }, 502);
    }

    // Return client_payload verbatim (everything from VdoCipher) minus uploadLink.
    const { uploadLink: _removed, ...clientPayload } = rawPayload;

    // ── Step 2: Pre-store the video_id on the lesson (status = 'uploading') ───
    // This lets us correlate the lesson → VdoCipher asset immediately.
    // The lesson will be updated to 'ready' only after VdoCipher confirms encoding.
    const { error: updateErr } = await supabase
      .from('lessons')
      .update({
        video_id: videoId,
        video_status: 'uploading',
        updated_at: new Date().toISOString(),
      })
      .eq('id', lesson_id);

    if (updateErr) {
      console.error('[vdocipher-upload-init] failed to pre-store video_id', {
        lesson_id, videoId, error: updateErr,
      });
      // Non-fatal — still return credentials so upload can proceed;
      // the uploader will write video_id again after verification.
    }

    return json({
      video_id:       videoId,
      upload_url:     uploadUrl,
      // All fields from VdoCipher clientPayload verbatim, uploadLink extracted above.
      // The browser upload client copies these, then explicitly appends
      // success_action_status="201" and success_action_redirect="" per official docs.
      client_payload: clientPayload,
    }, 200);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[vdocipher-upload-init] unhandled error', msg);
    return json({ error: msg }, 500);
  }
});
