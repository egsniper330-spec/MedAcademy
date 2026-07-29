// supabase/functions/_shared/auth.ts
// Shared auth helpers — import from here, NOT from supabase-js admin client

import { createClient } from 'npm:@supabase/supabase-js@2';

export function createServiceClient() {
  // Supabase auto-injects SUPABASE_SERVICE_ROLE_KEY into every Edge Function.
  // SERVICE_ROLE_KEY is the legacy custom-secret name used in older deploys.
  // Accept either so both configs work; log loudly if neither is present
  // because auth.admin.* calls will silently fail with an anon-scoped client.
  const key =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
    Deno.env.get('SERVICE_ROLE_KEY');
  if (!key) {
    console.error('[_shared/auth] FATAL: neither SUPABASE_SERVICE_ROLE_KEY nor SERVICE_ROLE_KEY is set — auth.admin.* calls will fail');
  }
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    key ?? '',
    { auth: { persistSession: false } }
  );
}

/**
 * Creates a Supabase client scoped to the calling user's JWT.
 * Use for RPCs that rely on auth.uid() internally (e.g. register_device).
 */
export function createUserClient(token: string) {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  );
}

export async function requireAuth(req: Request): Promise<{ userId: string; role: string; token: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) throw new Response('Missing Authorization header', { status: 401 });

  const supabase = createServiceClient();
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) throw new Response('Invalid token', { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  return { userId: user.id, role: profile?.role ?? 'student', token };
}

export function requireRole(role: string, allowed: string[]): void {
  if (!allowed.includes(role)) {
    throw new Response(`Forbidden: requires role ${allowed.join(' or ')}`, { status: 403 });
  }
}

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // List every header sent by any client (web preview + native app).
    // Missing entries cause browser CORS preflight to block the request with
    // a network-level "Load failed" error before the POST ever fires.
    // Custom chunk-upload headers (x-upload-id etc.) MUST be listed here or
    // the preflight for video-upload-chunk will be rejected by the browser.
    'Access-Control-Allow-Headers': [
      'Authorization',
      'Content-Type',
      'apikey',
      'x-client-info',
      'x-idempotency-key',
      // Chunk upload custom headers — required by video-upload-chunk
      'x-upload-id',
      'x-chunk-index',
      'x-total-chunks',
      'x-chunk-size',
      'x-file-name',
      'x-mime-type',
    ].join(', '),
  };
}

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}
