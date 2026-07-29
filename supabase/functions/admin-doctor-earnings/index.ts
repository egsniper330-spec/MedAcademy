// supabase/functions/admin-doctor-earnings/index.ts
//
// Admin-only endpoint for updating a doctor's earnings settings.
// The DB already has SECURITY DEFINER RPC set_doctor_earnings_settings which
// enforces admin/super_admin role internally — this EF validates the caller
// and forwards to that RPC.
//
// POST { action: 'update_settings', doctor_id, custom_pricing_enabled, earnings_mode }

import { requireAuth, requireRole, json, corsHeaders, createUserClient } from '../_shared/auth.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const { role, token } = await requireAuth(req);
    requireRole(role, ['admin', 'super_admin']);

    const body = await req.json().catch(() => ({})) as {
      action?:                  string;
      doctor_id?:               string;
      custom_pricing_enabled?:  boolean;
      earnings_mode?:           string;
    };

    const { action, doctor_id, custom_pricing_enabled, earnings_mode } = body;

    if (!action) return json({ error: 'action is required' }, 400);

    if (action === 'update_settings') {
      if (!doctor_id) return json({ error: 'doctor_id is required' }, 400);
      if (typeof custom_pricing_enabled !== 'boolean') {
        return json({ error: 'custom_pricing_enabled must be a boolean' }, 400);
      }
      if (!earnings_mode || !['credit', 'course'].includes(earnings_mode)) {
        return json({ error: "earnings_mode must be 'credit' or 'course'" }, 400);
      }

      // Use user-scoped client so the SECURITY DEFINER RPC sees auth.uid()
      // and can re-verify the caller's role internally.
      const userClient = createUserClient(token);
      const { data, error } = await userClient.rpc('set_doctor_earnings_settings', {
        p_doctor_id:      doctor_id,
        p_custom_enabled: custom_pricing_enabled,
        p_earnings_mode:  earnings_mode,
      });

      if (error) {
        const isForbidden = error.message?.includes('Forbidden');
        return json({ error: error.message }, isForbidden ? 403 : 500);
      }

      return json({ success: true, result: data });
    }

    return json({ error: `Unknown action: ${action}` }, 400);

  } catch (err) {
    if (err instanceof Response) return err;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[admin-doctor-earnings] unhandled error:', msg);
    return json({ error: 'Internal server error' }, 500);
  }
});
