/**
 * provider-health Edge Function
 * Checks health of all registered providers and updates provider_registry.
 * Called by: Admin UI (on-demand) + scheduled daily cron.
 *
 * Actions:
 *   check_all   — ping every active provider, update status in DB
 *   check_one   — ping a single provider by provider_key
 *   list        — return all providers with current DB status
 *   activate    — set a provider as is_default for its category (super_admin only)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Provider health ping implementations ──────────────────────────────────────

async function pingProvider(providerKey: string, config: Record<string, unknown>): Promise<{
  status: 'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown';
  message?: string;
  version?: string;
}> {
  try {
    switch (providerKey) {
      case 'supabase_storage':
      case 'supabase_auth':
      case 'postgres_search':
      case 'internal_analytics':
      case 'internal_crash':
      case 'internal_ai': {
        // Internal Supabase services — always healthy if this function is running
        return { status: 'healthy', version: '1.0.0' };
      }

      case 'medacademy_video': {
        const vdoCipherKey = Deno.env.get('VDOCIPHER_API_SECRET');
        if (!vdoCipherKey) return { status: 'warning', message: 'VDOCIPHER_API_SECRET not set' };
        const res = await fetch('https://dev.vdocipher.com/api/videos?count=1', {
          headers: { Authorization: `Apisecret ${vdoCipherKey}` },
        });
        return res.ok ? { status: 'healthy' } : { status: 'warning', message: `VdoCipher returned ${res.status}` };
      }

      case 'expo_push': {
        // Ping Expo push receipt endpoint — no auth needed for empty check
        const res = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [] }),
        });
        return res.ok ? { status: 'healthy' } : { status: 'warning', message: `Expo returned ${res.status}` };
      }

      // Future providers not yet configured
      case 'cloudflare_stream':
      case 'mux':
      case 'bunny_stream':
      case 'aws_mediaconvert':
      case 'aws_s3':
      case 'cloudflare_r2':
      case 'gcs':
      case 'azure_blob':
      case 'firebase_fcm':
      case 'onesignal':
      case 'huawei_push':
      case 'resend':
      case 'sendgrid':
      case 'amazon_ses':
      case 'mailgun':
      case 'twilio':
      case 'vonage':
      case 'egypt_sms':
      case 'paymob':
      case 'stripe':
      case 'paypal':
      case 'fawry':
      case 'meeza':
      case 'firebase_auth':
      case 'auth0':
      case 'clerk':
      case 'firebase_analytics':
      case 'posthog':
      case 'mixpanel':
      case 'sentry':
      case 'crashlytics':
      case 'meilisearch':
      case 'typesense':
      case 'algolia':
      case 'openai':
      case 'claude':
      case 'gemini':
      case 'azure_openai':
        return { status: 'unknown', message: 'Not yet configured' };

      default:
        return { status: 'unknown', message: 'Unknown provider key' };
    }
  } catch (err) {
    return { status: 'offline', message: String(err) };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // Verify caller is super_admin (or service role from cron)
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.includes('service_role')) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user } } = await supabase.auth.getUser(token);
      if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      if (profile?.role !== 'super_admin') {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders });
      }
    }

    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? 'list';

    // ── list ──────────────────────────────────────────────────────────────────
    if (action === 'list') {
      const { data, error } = await supabase
        .from('provider_registry')
        .select('*')
        .order('category')
        .order('is_default', { ascending: false });
      if (error) throw error;
      return new Response(JSON.stringify({ providers: data }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── check_all ─────────────────────────────────────────────────────────────
    if (action === 'check_all') {
      const { data: providers } = await supabase
        .from('provider_registry')
        .select('provider_key, config');

      const updates: Array<{ provider_key: string; status: string; status_message: string | null; last_health_check: string }> = [];

      await Promise.allSettled(
        (providers ?? []).map(async (p: any) => {
          const result = await pingProvider(p.provider_key, p.config ?? {});
          updates.push({
            provider_key: p.provider_key,
            status: result.status,
            status_message: result.message ?? null,
            last_health_check: new Date().toISOString(),
          });
        }),
      );

      // Batch update
      for (const update of updates) {
        await supabase.from('provider_registry').update({
          status: update.status,
          status_message: update.status_message,
          last_health_check: update.last_health_check,
          updated_at: new Date().toISOString(),
        }).eq('provider_key', update.provider_key);
      }

      // Log to audit
      await supabase.from('provider_audit_log').insert({
        provider_key: 'all',
        category: 'system',
        operation: 'health_check_all',
        success: true,
        metadata: { checked: updates.length, timestamp: new Date().toISOString() },
      });

      return new Response(JSON.stringify({ checked: updates.length, results: updates }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── check_one ─────────────────────────────────────────────────────────────
    if (action === 'check_one') {
      const { provider_key } = body;
      if (!provider_key) return new Response(JSON.stringify({ error: 'provider_key required' }), { status: 400, headers: corsHeaders });

      const { data: provider } = await supabase
        .from('provider_registry')
        .select('*')
        .eq('provider_key', provider_key)
        .single();
      if (!provider) return new Response(JSON.stringify({ error: 'Provider not found' }), { status: 404, headers: corsHeaders });

      // Backend enforcement: block API calls for disabled providers
      if (provider.is_active === false) {
        return new Response(JSON.stringify({ error: 'Provider is disabled. Enable it before using.', status: 'disabled' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const result = await pingProvider(provider_key, provider.config ?? {});

      await supabase.from('provider_registry').update({
        status: result.status,
        status_message: result.message ?? null,
        last_health_check: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('provider_key', provider_key);

      return new Response(JSON.stringify({ provider_key, ...result }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── activate ──────────────────────────────────────────────────────────────
    if (action === 'activate') {
      const { provider_key } = body;
      if (!provider_key) return new Response(JSON.stringify({ error: 'provider_key required' }), { status: 400, headers: corsHeaders });

      const { data: target } = await supabase
        .from('provider_registry')
        .select('category')
        .eq('provider_key', provider_key)
        .single();
      if (!target) return new Response(JSON.stringify({ error: 'Provider not found' }), { status: 404, headers: corsHeaders });

      // Clear existing default in category, set new one
      await supabase.from('provider_registry').update({ is_default: false }).eq('category', target.category);
      await supabase.from('provider_registry').update({ is_default: true, is_active: true }).eq('provider_key', provider_key);

      await supabase.from('provider_audit_log').insert({
        provider_key,
        category: target.category,
        operation: 'activate_provider',
        success: true,
        metadata: { category: target.category },
      });

      return new Response(JSON.stringify({ success: true, provider_key, category: target.category }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
