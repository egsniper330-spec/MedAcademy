// supabase/functions/vdocipher-debug-creds/index.ts
//
// DEBUG ONLY — standalone VdoCipher credential request.
// NO lesson lookup. NO ownership check. NO DB write.
// Calls VdoCipher PUT /api/videos?title=<title> and returns the FULL raw
// response verbatim so the debug screen can inspect every field.
//
// POST /vdocipher-debug-creds
// Body: { title: string }
// Response: {
//   vdo_status:   number,         // VdoCipher HTTP status
//   vdo_ok:       boolean,
//   vdo_body:     object,         // raw VdoCipher response, unmodified
//   upload_url:   string | null,  // extracted uploadLink (if present)
//   form_fields:  object | null,  // clientPayload minus uploadLink (if parseable)
//   policy_decoded: object | null // decoded S3 policy JSON (if present)
// }

import { requireAuth, json, corsHeaders } from '../_shared/auth.ts';

const VDOCIPHER_API = 'https://dev.vdocipher.com/api';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const { userId, role } = await requireAuth(req);
    requireRole(role, ['super_admin']);
    console.log('[vdocipher-debug-creds] called by', { userId, role });

    const body = await req.json().catch(() => ({}));
    const title = (body.title as string | undefined)?.trim() || 'debug-test-video';

    const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET');
    if (!apiSecret) {
      return json({ error: 'VDOCIPHER_API_SECRET not configured on the server' }, 500);
    }

    // ── Call VdoCipher ────────────────────────────────────────────────────────
    const createUrl = `${VDOCIPHER_API}/videos?title=${encodeURIComponent(title.slice(0, 200))}`;
    console.log('[vdocipher-debug-creds] PUT', createUrl);

    const vdoRes = await fetch(createUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Apisecret ${apiSecret}`,
        Accept: 'application/json',
      },
    });

    const vdoBody = await vdoRes.json().catch(() => ({ __parse_error: true }));
    console.log('[vdocipher-debug-creds] raw response', {
      status: vdoRes.status,
      ok: vdoRes.ok,
      bodyKeys: typeof vdoBody === 'object' ? Object.keys(vdoBody) : typeof vdoBody,
    });

    // ── Extract & decode without throwing ─────────────────────────────────────
    let uploadUrl: string | null = null;
    let formFields: Record<string, unknown> | null = null;
    let policyDecoded: unknown = null;
    let clientPayloadParseError: string | null = null;

    try {
      const cp = vdoBody?.clientPayload;
      let payload: Record<string, unknown> | null = null;

      if (typeof cp === 'string') {
        const parsed = JSON.parse(cp);
        payload = parsed as Record<string, unknown>;
        console.log('[vdocipher-debug-creds] clientPayload was JSON string, parsed OK', { keys: Object.keys(payload) });
      } else if (cp && typeof cp === 'object' && !Array.isArray(cp)) {
        payload = cp as Record<string, unknown>;
        console.log('[vdocipher-debug-creds] clientPayload was plain object', { keys: Object.keys(payload) });
      }

      if (payload) {
        uploadUrl = (payload.uploadLink as string) ?? null;
        const { uploadLink: _drop, ...rest } = payload;
        formFields = rest;

        // Decode policy if present
        const policyB64 = payload.policy as string | undefined;
        if (policyB64) {
          try {
            policyDecoded = JSON.parse(atob(policyB64));
          } catch (_e) {
            policyDecoded = { __decode_error: 'base64 decode or JSON parse failed', raw: policyB64.slice(0, 80) };
          }
        }
      }
    } catch (e: unknown) {
      clientPayloadParseError = e instanceof Error ? e.message : String(e);
      console.error('[vdocipher-debug-creds] clientPayload parse error', clientPayloadParseError);
    }

    return json({
      vdo_status:            vdoRes.status,
      vdo_ok:                vdoRes.ok,
      vdo_body:              vdoBody,           // complete raw response
      upload_url:            uploadUrl,
      form_fields:           formFields,
      policy_decoded:        policyDecoded,
      client_payload_error:  clientPayloadParseError,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[vdocipher-debug-creds] unexpected error', msg);
    return json({ error: msg }, 500);
  }
});
