// supabase/functions/user-lookup/index.ts
// Universal user lookup by email / phone / user_id / name.
// Used by credits, activation-codes, course-grant, and admin search.
// Returns array of matching profiles (always safe — no auth secrets exposed).

import { requireAuth, requireRole, createServiceClient, json, corsHeaders } from '../_shared/auth.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { userId, role } = await requireAuth(req);
    // Doctors, admins, super_admins can search; students cannot
    requireRole(role, ['doctor', 'admin', 'super_admin']);

    const body = await req.json();
    const { identifier } = body;

    if (!identifier || typeof identifier !== 'string' || identifier.trim().length < 2) {
      return json({ error: 'identifier must be at least 2 characters' }, 400);
    }

    const supabase = createServiceClient();

    // Use the DB function for smart lookup
    const { data, error } = await supabase.rpc('lookup_user_by_identifier', {
      p_identifier: identifier.trim(),
    });

    if (error) return json({ error: error.message }, 400);

    // Audit — log the search (non-blocking)
    try {
      await supabase.rpc('write_audit_log', {
        p_actor_id: userId,
        p_action: 'user_searched',
        p_details: { identifier: identifier.trim(), result_count: (data ?? []).length },
        p_resource_type: 'profiles',
        p_resource_id: null,
        p_lookup_method: detectMethod(identifier.trim()),
        p_user_identifier: identifier.trim(),
      });
    } catch (_) {}

    return json({ results: data ?? [] });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error('user-lookup error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

function detectMethod(identifier: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)) return 'user_id';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identifier)) return 'email';
  if (/^[\+0-9\s\-\.\(\)]{7,}$/.test(identifier)) return 'phone';
  return 'name';
}
