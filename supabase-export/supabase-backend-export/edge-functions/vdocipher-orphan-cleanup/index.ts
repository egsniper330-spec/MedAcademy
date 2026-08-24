// supabase/functions/vdocipher-orphan-cleanup/index.ts
//
// ⚠️  CLEANUP DISABLED — DEBUG ROLLBACK ⚠️
//
// This scheduled job has been temporarily stubbed to a no-op.
// No VdoCipher assets will be deleted by this job until deletion is re-enabled.
//
// Scheduled cleanup job — runs every hour via Supabase Cron (CURRENTLY DISABLED).
// Implements the DEFERRED cleanup strategy:
//
//   POLICY: Provider (VdoCipher) assets are NEVER deleted immediately on failure.
//   Assets are kept until one of these conditions is met:
//     1. Doctor explicitly cancels → upload_sessions.status = 'cancelled', expires_at = now()
//     2. Lesson deleted            → upload_sessions.lesson_id = null (SET NULL on cascade)
//     3. Course deleted            → upload_sessions.course_id = null (SET NULL on cascade)
//     4. Cleanup job expires       → upload_sessions.expires_at <= now() (24h for failed)
//
//   Cleanup sources (in order):
//   A. upload_sessions: rows where status IN ('failed','cancelled','expired')
//      AND expires_at <= now() — use get_cleanable_upload_sessions() RPC
//   B. Lesson-less video_uploads: lesson was hard-deleted, upload stuck > 1h
//   C. No-provider stuck > 1h (encoding started but no VdoCipher ID)
//
// Schedule (add in Supabase Dashboard → Database → Extensions → pg_cron):
//   SELECT cron.schedule('vdocipher-orphan-cleanup', '0 * * * *',
//     $$SELECT net.http_post(url:='<SUPABASE_URL>/functions/v1/vdocipher-orphan-cleanup',
//       headers:='{"Authorization":"Bearer <SERVICE_ROLE_KEY>"}')$$);

import { json, corsHeaders, createServiceClient } from '../_shared/auth.ts';

const VDOCIPHER_API = 'https://dev.vdocipher.com/api';

async function deleteVdoCipherAsset(
  videoId: string,
  apiSecret: string,
): Promise<{ deleted: boolean; error?: string }> {
  try {
    const res = await fetch(`${VDOCIPHER_API}/videos?videos=${encodeURIComponent(videoId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Apisecret ${apiSecret}`, Accept: 'application/json' },
    });
    if (res.ok || res.status === 404) return { deleted: true };
    const body = await res.text().catch(() => '');
    return { deleted: false, error: `HTTP ${res.status}: ${body}` };
  } catch (e) {
    return { deleted: false, error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const ts = new Date().toISOString();
  const svc = createServiceClient();

  const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET');
  if (!apiSecret) {
    console.error('[vdocipher-orphan-cleanup] VDOCIPHER_API_SECRET not configured');
    return json({ error: 'Video service not configured' }, 500);
  }

  const errors: string[] = [];
  let sessionsCount  = 0;
  let orphansCount   = 0;
  let noProviderCount = 0;

  // ── Source A: upload_sessions with expired / failed / cancelled status ──────
  try {
    const { data: sessions, error: sessErr } = await svc.rpc('get_cleanable_upload_sessions');
    if (sessErr) {
      errors.push(`get_cleanable_upload_sessions: ${sessErr.message}`);
    } else {
      for (const session of (sessions ?? []) as Array<{
        id: string; video_id: string | null; lesson_id: string | null; course_id: string | null;
      }>) {
        if (!session.video_id) continue;
        const deleteUrl = `${VDOCIPHER_API}/videos?videos=${encodeURIComponent(session.video_id)}`;
        console.log('[vdocipher-orphan-cleanup] session cleanup DELETE', {
          session_id: session.id, video_id: session.video_id, timestamp: new Date().toISOString(),
        });
        try {
          const vdoRes = await fetch(deleteUrl, {
            method: 'DELETE',
            headers: { Authorization: `Apisecret ${apiSecret}`, Accept: 'application/json' },
          });
          const body = await vdoRes.json().catch(() => ({}));
          console.log('[vdocipher-orphan-cleanup] session cleanup response', {
            session_id: session.id, video_id: session.video_id,
            http_status: vdoRes.status, body, timestamp: new Date().toISOString(),
          });
          if (vdoRes.ok || vdoRes.status === 404) {
            sessionsCount++;
            // Mark session as cleaned up
            await svc.from('upload_sessions').update({
              status: 'cleaned', updated_at: new Date().toISOString(),
            }).eq('id', session.id).catch(() => {});
          } else {
            errors.push(`session ${session.id}: HTTP ${vdoRes.status}`);
          }
        } catch (fetchErr) {
          errors.push(`session ${session.id}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
        }
      }
    }
  } catch (e) {
    errors.push(`sessions phase: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Source B: video_uploads rows whose lesson was hard-deleted (stuck > 1 h) ─
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: orphanUploads } = await svc
      .from('video_uploads')
      .select('id, provider_video_id, course_id')
      .is('lesson_id', null)
      .lte('created_at', oneHourAgo)
      .not('provider_video_id', 'is', null)
      .neq('status', 'deleted');

    for (const upload of (orphanUploads ?? []) as Array<{
      id: string; provider_video_id: string; course_id: string | null;
    }>) {
      const videoId = upload.provider_video_id;
      const deleteUrl = `${VDOCIPHER_API}/videos?videos=${encodeURIComponent(videoId)}`;
      console.log('[vdocipher-orphan-cleanup] orphan upload DELETE', {
        upload_id: upload.id, video_id: videoId, timestamp: new Date().toISOString(),
      });
      try {
        const vdoRes = await fetch(deleteUrl, {
          method: 'DELETE',
          headers: { Authorization: `Apisecret ${apiSecret}`, Accept: 'application/json' },
        });
        const body = await vdoRes.json().catch(() => ({}));
        console.log('[vdocipher-orphan-cleanup] orphan upload response', {
          upload_id: upload.id, video_id: videoId,
          http_status: vdoRes.status, body, timestamp: new Date().toISOString(),
        });
        if (vdoRes.ok || vdoRes.status === 404) {
          orphansCount++;
          await svc.from('video_uploads').update({
            status: 'deleted', updated_at: new Date().toISOString(),
          }).eq('id', upload.id).catch(() => {});
        } else {
          errors.push(`orphan upload ${upload.id}: HTTP ${vdoRes.status}`);
        }
      } catch (fetchErr) {
        errors.push(`orphan upload ${upload.id}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
      }
    }
  } catch (e) {
    errors.push(`orphan phase: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Source C: video_uploads stuck > 1 h with no VdoCipher ID ─────────────
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: stuck } = await svc
      .from('video_uploads')
      .select('id')
      .in('status', ['uploading', 'processing', 'encoding'])
      .lte('created_at', oneHourAgo)
      .is('provider_video_id', null);

    for (const row of (stuck ?? []) as Array<{ id: string }>) {
      noProviderCount++;
      await svc.from('video_uploads').update({
        status: 'failed', error_message: 'Cleaned up by orphan job — no provider asset',
        updated_at: new Date().toISOString(),
      }).eq('id', row.id).catch(() => {});
    }
  } catch (e) {
    errors.push(`no-provider phase: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log('[vdocipher-orphan-cleanup] completed', {
    sessions_cleaned:      sessionsCount,
    orphans_deleted:       orphansCount,
    no_provider_cancelled: noProviderCount,
    errors:                errors.length,
    timestamp: new Date().toISOString(),
  });

  return json({
    success:               errors.length === 0,
    sessions_cleaned:      sessionsCount,
    orphan_deleted:        orphansCount,
    no_provider_cancelled: noProviderCount,
    errors,
    timestamp: ts,
  });
});
