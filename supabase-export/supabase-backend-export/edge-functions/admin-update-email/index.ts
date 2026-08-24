// supabase/functions/admin-update-email/index.ts
// Super-admin-only: update a user's auth email + profile email via service role.
// Never exposes the service role key to the client.

import { requireAuth, requireRole, createServiceClient, json, corsHeaders } from '../_shared/auth.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return new Response(
    JSON.stringify({ error: 'Method not allowed' }),
    { status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
  );

  try {
    // 1. Authenticate caller and enforce super_admin only
    const { role: actorRole, userId: actorId } = await requireAuth(req);
    requireRole(actorRole, ['super_admin']);

    const body = await req.json() as { target_user_id?: string; new_email?: string };
    const { target_user_id, new_email } = body;

    if (!target_user_id?.trim()) return json({ error: 'target_user_id is required' }, 400);
    if (!new_email?.trim())       return json({ error: 'new_email is required' }, 400);

    const normalizedEmail = new_email.trim().toLowerCase();

    // 2. Validate email format
    if (!EMAIL_RE.test(normalizedEmail)) {
      return json({ error: 'Invalid email address format.' }, 400);
    }

    // 3. Prevent internal placeholder emails
    if (normalizedEmail.endsWith('@medacademy.internal')) {
      return json({ error: 'Cannot set an internal placeholder email.' }, 400);
    }

    const supabase = createServiceClient();

    // 4. Check uniqueness — query profiles table for duplicate
    const { data: existing, error: dupErr } = await supabase
      .from('profiles')
      .select('id')
      .or(`email.eq.${normalizedEmail},profile_email.eq.${normalizedEmail}`)
      .neq('id', target_user_id)
      .limit(1)
      .maybeSingle();

    if (dupErr) {
      console.error('[dup-check] error:', dupErr);
      return json({ error: 'Failed to check email uniqueness.' }, 500);
    }
    if (existing) {
      return json({ error: 'This email address is already in use by another account.' }, 409);
    }

    // 5. Update Supabase Auth email via admin API (no confirmation email)
    const { error: authErr } = await supabase.auth.admin.updateUserById(target_user_id, {
      email: normalizedEmail,
      email_confirm: true,
    });

    if (authErr) {
      console.error('[auth-update] error:', authErr);
      // Surface specific duplicate error from GoTrue
      const msg = authErr.message ?? '';
      if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
        return json({ error: 'This email address is already in use.' }, 409);
      }
      return json({ error: `Failed to update auth email: ${msg}` }, 500);
    }

    // 6. Sync profiles table — update both email + profile_email
    const { error: profileErr } = await supabase
      .from('profiles')
      .update({ email: normalizedEmail, profile_email: normalizedEmail })
      .eq('id', target_user_id);

    if (profileErr) {
      console.error('[profile-update] error:', profileErr);
      // Auth is already updated — log but still return partial success with warning
      return json({
        success: true,
        warning: 'Auth email updated but profile sync failed. Run a manual sync.',
        email: normalizedEmail,
      }, 200);
    }

    // 7. Write audit log (non-blocking)
    try {
      const { data: actorProfile } = await supabase
        .from('profiles').select('full_name').eq('id', actorId).single();
      const { data: targetProfile } = await supabase
        .from('profiles').select('full_name').eq('id', target_user_id).single();

      await supabase.from('audit_logs').insert({
        actor_id:       actorId,
        actor_name:     actorProfile?.full_name ?? 'Super Admin',
        action:         'email_changed',
        resource_type:  'profile',
        resource_id:    target_user_id,
        target_user_id,
        target_name:    targetProfile?.full_name ?? target_user_id,
        description:    `${actorProfile?.full_name ?? 'Super Admin'} changed email for ${targetProfile?.full_name ?? target_user_id}`,
        new_values:     { email: normalizedEmail },
        details:        { changed_by_role: actorRole },
        log_status:     'success',
      });
    } catch (auditErr) {
      console.warn('[audit] non-blocking failure:', auditErr);
    }

    console.log('[admin-update-email] success — target:', target_user_id, 'new email:', normalizedEmail);
    return json({ success: true, email: normalizedEmail });

  } catch (err) {
    if (err instanceof Response) return err;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[outer-catch]', msg);
    return new Response(
      JSON.stringify({ error: msg || 'Unexpected error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
    );
  }
});
