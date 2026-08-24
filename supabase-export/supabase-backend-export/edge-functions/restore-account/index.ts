/**
 * restore-account Edge Function
 *
 * Admin/Super Admin only: remove suspension, optionally reset violations/strikes.
 *
 * Body: { target_user_id, reset_violations?: boolean }
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Verify calling user is admin/super_admin
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authErr } = await serviceClient.auth.getUser(token);
    if (authErr || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const { data: callerProfile } = await serviceClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    if (!callerProfile || !['admin', 'super_admin'].includes(callerProfile.role)) {
      return new Response(
        JSON.stringify({ error: 'Insufficient permissions' }),
        { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const { target_user_id, reset_violations = true } = await req.json() as {
      target_user_id: string;
      reset_violations?: boolean;
    };

    if (!target_user_id) {
      return new Response(
        JSON.stringify({ error: 'target_user_id is required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const update: Record<string, unknown> = {
      is_suspended:     false,
      suspension_reason: null,
      suspension_at:    null,
      suspension_device: null,
      status:           'active',
      updated_at:       new Date().toISOString(),
    };
    if (reset_violations) {
      update.violation_count = 0;
      update.strike_count    = 0;
    }

    const { error } = await serviceClient
      .from('profiles')
      .update(update)
      .eq('id', target_user_id);

    if (error) throw error;

    // Audit log
    await serviceClient.from('audit_logs').insert({
      actor_id:   user.id,
      target_id:  target_user_id,
      action:     'account_restored' as const,  // audit_action enum — v76
      new_value:  JSON.stringify({ reset_violations }),
    }).select();

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('restore-account error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
