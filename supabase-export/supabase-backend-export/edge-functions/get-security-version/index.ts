import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * get-security-version — ultra-lightweight version-check endpoint.
 *
 * Returns ONLY the current security_version number so clients can decide
 * whether to download the full configuration. A full config fetch costs
 * ~4 KB; this response is ~40 bytes.
 *
 * Security model:
 *   • Requires a valid Supabase Auth JWT (same as get-security-config).
 *   • Service-role read bypasses RLS; clients never query the table directly.
 *   • Intentionally returns NO other configuration fields.
 *
 * Response:
 *   200  { "security_version": 3 }
 *   401  { "error": "Unauthorized" }
 *   404  { "error": "No active config" }
 *   500  { "error": "Internal server error" }
 *
 * Client flow:
 *   1. Call this endpoint every 15 min (or on app foreground).
 *   2. Compare returned security_version with cached version.
 *   3. If equal → skip full fetch, continue with cached config.
 *   4. If different → call get-security-config to download fresh config.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Service-role client: reads security_config bypassing RLS
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    // ── 1. Authenticate ────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const jwt = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
    if (authErr || !user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // ── 2. Fetch ONLY security_version ────────────────────────────────────
    // The partial index `idx_security_config_version_check` makes this
    // an index-only scan: no heap pages read, sub-millisecond latency.
    const { data, error } = await supabase
      .from('security_config')
      .select('security_version')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[get-security-version] DB error:', error.message);
      return json({ error: 'Internal server error' }, 500);
    }

    if (!data) {
      return json({ error: 'No active config' }, 404);
    }

    const security_version =
      typeof data.security_version === 'number' && data.security_version > 0
        ? Math.floor(data.security_version)
        : 1;

    // ── 3. Return the version only ─────────────────────────────────────────
    return json({ security_version });

  } catch (err) {
    console.error('[get-security-version] Unexpected error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
