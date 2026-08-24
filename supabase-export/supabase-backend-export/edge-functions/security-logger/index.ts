import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SecurityEventPayload {
  event_type: string;
  detection_method?: string;
  policy_action?: string;
  risk_score?: number;
  device_id?: string;
  platform?: string;
  app_version?: string;
  ip_address?: string;
  metadata?: Record<string, unknown>;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Get user from JWT (optional — events can be logged pre-auth)
    const authHeader = req.headers.get('Authorization');
    let userId: string | null = null;
    if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user } } = await supabase.auth.getUser(token);
      userId = user?.id ?? null;
    }

    const body: SecurityEventPayload | SecurityEventPayload[] = await req.json();
    const events = Array.isArray(body) ? body : [body];

    const rows = events.map((e) => ({
      user_id:          userId,
      device_id:        e.device_id ?? null,
      event_type:       e.event_type,
      detection_method: e.detection_method ?? null,
      policy_action:    e.policy_action ?? null,
      risk_score:       Math.min(100, Math.max(0, e.risk_score ?? 0)),
      ip_address:       e.ip_address ?? req.headers.get('x-forwarded-for') ?? null,
      platform:         e.platform ?? null,
      app_version:      e.app_version ?? null,
      metadata:         e.metadata ?? {},
    }));

    const { error } = await supabase.from('security_events').insert(rows);
    if (error) throw error;

    return new Response(JSON.stringify({ success: true, logged: rows.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error
      ? err.message
      : (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err));
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
