/**
 * process-violation Edge Function
 *
 * Records a content protection violation for a user, increments strike/violation
 * count, applies the configured policy action, and returns the action taken.
 *
 * Body:
 *   user_id, violation_type, device_id?, device_name?, platform?,
 *   installation_id?, session_id?, ip_address?
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json();
    const {
      user_id,
      violation_type,
      device_id,
      device_name,
      platform,
      installation_id,
      session_id,
      ip_address,
    } = body as {
      user_id: string;
      violation_type: 'screenshot_detected' | 'screen_recording_detected';
      device_id?: string;
      device_name?: string;
      platform?: string;
      installation_id?: string;
      session_id?: string;
      ip_address?: string;
    };

    if (!user_id || !violation_type) {
      return new Response(
        JSON.stringify({ error: 'user_id and violation_type are required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // Load policy
    const { data: policy } = await supabase
      .from('content_protection_policies')
      .select('*')
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .maybeSingle();

    const strikeActions: Record<number, string> = {
      1: policy?.strike1_action ?? 'warning',
      2: policy?.strike2_action ?? 'logout',
      3: policy?.strike3_action ?? 'suspend',
    };

    // Increment violation + strike counters atomically
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('violation_count, strike_count, is_suspended, role')
      .eq('id', user_id)
      .maybeSingle();

    if (profileErr || !profile) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // ── ROLE GUARD ─────────────────────────────────────────────────────────────
    // Content-protection violations only apply to students. Doctors, Admins and
    // Super Admins legitimately preview course content for quality checks, lesson
    // editing, etc. Recording a violation for them would increment their strike
    // count and eventually trigger a force-logout — the exact bug we are fixing.
    // Return early with action='exempt' so the client knows the event was received
    // but no penalty was applied.
    const userRole: string = profile.role ?? 'student';
    if (userRole !== 'student') {
      console.log(`[process-violation] EXEMPT: user_id=${user_id} role="${userRole}" — non-student roles are not subject to content protection enforcement`);
      return new Response(
        JSON.stringify({ action: 'exempt', role: userRole, strike_count: 0, violation_count: 0 }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    if (profile.is_suspended) {
      return new Response(
        JSON.stringify({ action: 'suspend', already_suspended: true }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const newViolationCount = (profile.violation_count ?? 0) + 1;
    const newStrikeCount    = Math.min((profile.strike_count ?? 0) + 1, 3);
    const actionKey         = Math.min(newStrikeCount, 3);
    const actionTaken       = strikeActions[actionKey] ?? 'warning';

    // Apply suspension if action requires it
    const isSuspend = actionTaken === 'suspend' || actionTaken === 'ban';
    const suspensionData = isSuspend ? {
      is_suspended:      true,
      suspension_reason: 'Content Protection Violation',
      suspension_at:     new Date().toISOString(),
      suspension_device: { device_id, device_name, platform, installation_id },
      status:            'suspended' as const,
    } : {};

    await supabase
      .from('profiles')
      .update({
        violation_count: newViolationCount,
        strike_count:    newStrikeCount,
        updated_at:      new Date().toISOString(),
        ...suspensionData,
      })
      .eq('id', user_id);

    // Record violation log
    await supabase.from('content_protection_violations').insert({
      user_id,
      violation_type,
      strike_count: newStrikeCount,
      action_taken: actionTaken,
      device_id,
      device_name,
      platform,
      installation_id,
      session_id,
      ip_address,
    });

    // Log to security_events as well
    await supabase.from('security_events').insert({
      user_id,
      event_type:       violation_type,
      detection_method: platform === 'ios' ? 'iOS native listener' : 'FLAG_SECURE bypass',
      policy_action:    actionTaken,
      device_id,
      device_name,
      platform,
      installation_id,
    }).select();

    // Force sign-out if logout/suspend
    if (actionTaken === 'logout' || isSuspend) {
      await supabase.auth.admin.signOut(user_id, 'global');
    }

    return new Response(
      JSON.stringify({
        action:          actionTaken,
        role:            userRole,
        strike_count:    newStrikeCount,
        violation_count: newViolationCount,
        is_suspended:    isSuspend,
      }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('process-violation error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
