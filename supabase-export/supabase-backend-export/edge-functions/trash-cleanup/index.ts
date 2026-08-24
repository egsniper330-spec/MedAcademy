// supabase/functions/trash-cleanup/index.ts — v74
// Cron job: permanently delete all trash entries whose retention period has expired.
// Called daily by a scheduled trigger or manually by super_admin.
//
// POST {} (no body needed — actor is the service role)
// GET  → returns count of items pending cleanup

import { createClient } from 'npm:@supabase/supabase-js@2';

function svc() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, x-client-info',
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const db = svc();

    // ── GET: preview how many items are pending cleanup ───────────────────
    if (req.method === 'GET') {
      const { count, error } = await db.from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'trashed')
        .lt('trash_expires_at', new Date().toISOString());
      if (error) return json({ error: error.message }, 500);
      return json({ pending_cleanup: count ?? 0 });
    }

    // ── POST: run cleanup ─────────────────────────────────────────────────
    if (req.method === 'POST') {
      const cronSecret = Deno.env.get('CRON_SECRET');
      if (cronSecret) {
        const provided = req.headers.get('x-cron-secret');
        if (provided !== cronSecret) {
          return json({ success: false, code: 'UNAUTHORIZED' }, 401);
        }
      }

      const { data, error } = await db.rpc('cleanup_expired_trash');
      if (error) return json({ success: false, error: error.message }, 500);

      const result = data as { deleted: number; failed: number; ran_at: string };
      console.log(`[trash-cleanup] deleted=${result.deleted} failed=${result.failed}`);

      return json({ success: true, ...result });
    }

    return json({ success: false, code: 'METHOD_NOT_ALLOWED' }, 405);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[trash-cleanup] unhandled error:', msg);
    return json({ success: false, error: 'Internal server error' }, 500);
  }
});
