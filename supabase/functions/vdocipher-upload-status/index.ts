// supabase/functions/vdocipher-upload-status/index.ts
//
// Polls VdoCipher for the encoding / processing status of a video.
// Called repeatedly by the frontend after uploading to VdoCipher until
// status is 'ready' (VdoCipher reports "encoding" → "finished").
//
// VDOCIPHER_API_SECRET never leaves this function.
//
// GET /vdocipher-upload-status?video_id=<vdocipher_video_id>
// Response: {
//   video_id:    string,       // echoed back
//   status:      'processing' | 'encoding' | 'ready' | 'failed',
//   vdo_status:  string,       // raw VdoCipher status string
//   title?:      string,
//   duration?:   number,       // seconds, present when ready
//   poster?:     string,       // thumbnail URL, present when ready
// }

import { requireAuth, json, corsHeaders, createServiceClient } from '../_shared/auth.ts';

const VDOCIPHER_API = 'https://dev.vdocipher.com/api';

// Maps VdoCipher's native status strings to our internal UploadStatus values
function mapVdoStatus(vdoStatus: string): 'processing' | 'encoding' | 'ready' | 'failed' {
  switch (vdoStatus?.toLowerCase()) {
    case 'queued':
    case 'queue':
      return 'processing';
    case 'pre-processing':
    case 'preprocessing':
    case 'pre_processing':
      return 'processing';
    case 'processing':
      return 'encoding';
    case 'encoding':
    case 'transcoding':
      return 'encoding';
    case 'finished':
    case 'ready':
      return 'ready';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'processing';
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    // ── Auth: only doctors/admins may poll upload status ──────────────────────
    const { userId, role } = await requireAuth(req);
    if (!['doctor', 'admin', 'super_admin'].includes(role)) {
      return json({ error: 'Unauthorized' }, 403);
    }

    const url = new URL(req.url);
    const videoId = url.searchParams.get('video_id');
    if (!videoId) {
      return json({ error: 'video_id is required' }, 400);
    }

    // Basic sanity: VdoCipher IDs are alphanumeric, no slashes or dots
    if (videoId.includes('/') || videoId.includes('.')) {
      return json({
        error: 'Invalid video_id — this looks like a storage path, not a VdoCipher video ID.',
        hint: 'The lesson video_id was not set from a real VdoCipher upload. Re-upload the video.',
      }, 400);
    }

    const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET');
    if (!apiSecret) {
      console.error('[vdocipher-upload-status] VDOCIPHER_API_SECRET not configured');
      return json({ error: 'Video service not configured' }, 500);
    }

    // ── Query VdoCipher for video info ────────────────────────────────────────
    const vdoUrl = `${VDOCIPHER_API}/videos/${videoId}`;
    const vdoRes = await fetch(vdoUrl, {
      method: 'GET',
      headers: {
        Authorization: `Apisecret ${apiSecret}`,
        Accept: 'application/json',
      },
    });

    const vdoBody = await vdoRes.json().catch(() => ({}));

    if (vdoRes.status === 404) {
      // Video does not exist in VdoCipher — upload never reached the provider
      return json({
        video_id: videoId,
        status: 'failed',
        vdo_status: 'not_found',
        error: 'Video not found in VdoCipher — the upload may not have reached the provider.',
      }, 200);
    }

    if (!vdoRes.ok) {
      const errMsg = vdoBody?.message ?? vdoBody?.error ?? `HTTP ${vdoRes.status}`;
      console.error('[vdocipher-upload-status] VdoCipher error', { videoId, status: vdoRes.status, error: errMsg });
      return json({
        error: `VdoCipher status check failed: ${errMsg}`,
        vdocipher_status: vdoRes.status,
      }, 502);
    }

    const rawStatus: string = vdoBody?.status ?? '';
    const mappedStatus = mapVdoStatus(rawStatus);

    const response: Record<string, unknown> = {
      video_id: videoId,
      status: mappedStatus,
      vdo_status: rawStatus,
      title: vdoBody?.title ?? null,
    };

    // Include asset details when encoding is complete
    if (mappedStatus === 'ready') {
      response.duration = vdoBody?.length ?? null;   // duration in seconds
      response.poster = vdoBody?.poster ?? null;     // thumbnail URL
      response.dash = vdoBody?.dash ?? null;
      response.hls = vdoBody?.hls ?? null;
    }

    return json(response, 200);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[vdocipher-upload-status] unhandled error', msg);
    return json({ error: msg }, 500);
  }
});
