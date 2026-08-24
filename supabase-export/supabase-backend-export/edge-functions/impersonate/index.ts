// supabase/functions/impersonate/index.ts
// Super Admin only — generate a magic link for the target user.
// Returns { magic_link } which the client uses to sign in as that user.
// Every call is written to audit_logs.

import { requireAuth, requireRole, createServiceClient, json, corsHeaders } from '../_shared/auth.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { userId: actorId, role: actorRole } = await requireAuth(req);
    requireRole(actorRole, ['super_admin']);

    const { target_user_id } = await req.json() as { target_user_id: string };
    if (!target_user_id) return json({ error: 'target_user_id is required' }, 400);

    const supabase = createServiceClient();

    // Fetch target profile — cannot impersonate super admins
    const { data: target, error: profileErr } = await supabase
      .from('profiles')
      .select('id, email, role, full_name')
      .eq('id', target_user_id)
      .single();

    if (profileErr || !target) return json({ error: 'User not found' }, 404);
    if (target.role === 'super_admin') return json({ error: 'Cannot impersonate Super Admin accounts' }, 403);
    if (actorId === target_user_id) return json({ error: 'Cannot impersonate yourself' }, 400);

    // Generate a magic-link OTP for the target user.
    // The `email_otp` field is the raw one-time token the client uses to call
    // supabase.auth.verifyOtp({ email, token, type:'magiclink' }) — this avoids
    // any browser redirect and gives back a real session directly.
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: target.email,
    });

    if (linkErr || !linkData?.properties?.email_otp) {
      return json({ error: linkErr?.message ?? 'Failed to generate impersonation token' }, 500);
    }

    // Audit log (non-blocking)
    try {
      await supabase.from('audit_logs').insert({
        actor_id: actorId,
        action: 'impersonation_started' as const,  // audit_action enum — v76
        resource_type: 'profile',
        resource_id: target_user_id,
        details: {
          target_name: target.full_name,
          target_email: target.email,
          target_role: target.role,
          initiated_by_role: actorRole,
        },
      });
    } catch (_) {}

    // Return the raw OTP token + email — the client uses verifyOtp to exchange for a session
    return json({
      email_otp: linkData.properties.email_otp,
      email: target.email,
      target,
    });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error('impersonate error:', err);
    return json({ error: String(err) }, 500);
  }
});
