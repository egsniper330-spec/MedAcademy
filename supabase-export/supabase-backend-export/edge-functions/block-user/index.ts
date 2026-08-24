// supabase/functions/block-user/index.ts
// Super-admin-only: block or unblock a user account.
//
// Block:   sets profiles.status = 'blocked', sets ban_duration on auth.users,
//          force-signs-out all sessions, bumps security_version (invalidates
//          any existing JWT on the next check_authorization call).
//
// Unblock: sets profiles.status = 'active', clears ban_duration,
//          bumps security_version so the user must log in fresh.

import { requireAuth, requireRole, createServiceClient, json, corsHeaders } from '../_shared/auth.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return new Response(
    JSON.stringify({ error: 'Method not allowed' }),
    { status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
  );

  try {
    // 1. Authenticate + enforce super_admin only
    const { role: actorRole, userId: actorId } = await requireAuth(req);
    requireRole(actorRole, ['super_admin']);

    const body = await req.json() as { target_user_id?: string; action?: 'block' | 'unblock' };
    const { target_user_id, action } = body;

    if (!target_user_id?.trim()) return json({ error: 'target_user_id is required' }, 400);
    if (action !== 'block' && action !== 'unblock') return json({ error: 'action must be "block" or "unblock"' }, 400);

    // 2. Prevent super_admin from blocking themselves
    if (target_user_id === actorId) {
      return json({ error: 'You cannot block your own account.' }, 400);
    }

    const supabase = createServiceClient();

    // 3. Fetch target profile — verify they exist and get role/name
    const { data: targetProfile, error: fetchErr } = await supabase
      .from('profiles')
      .select('id, full_name, status, role')
      .eq('id', target_user_id)
      .maybeSingle();

    if (fetchErr || !targetProfile) {
      return json({ error: 'Target user not found.' }, 404);
    }

    // 4. Prevent blocking another super_admin
    if (action === 'block' && targetProfile.role === 'super_admin') {
      return json({ error: 'Super Admins cannot be blocked.' }, 403);
    }

    // 5. Prevent no-op
    if (action === 'block'   && targetProfile.status === 'blocked') return json({ error: 'Account is already blocked.' }, 409);
    if (action === 'unblock' && targetProfile.status !== 'blocked') return json({ error: 'Account is not currently blocked.' }, 409);

    const newStatus = action === 'block' ? 'blocked' : 'active';

    // 6a. Update profiles.status
    const { error: profileErr } = await supabase
      .from('profiles')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', target_user_id);

    if (profileErr) {
      console.error('[block-user] profile update error:', profileErr);
      return json({ error: 'Failed to update account status.' }, 500);
    }

    // 6b. Supabase Auth: set/clear ban_duration
    //   ban_duration: '87600h' (10 years) for block, 'none' to lift.
    //   This makes Supabase Auth reject any token refresh/signIn for the user.
    const banDuration = action === 'block' ? '87600h' : 'none';
    const { error: authErr } = await supabase.auth.admin.updateUserById(target_user_id, {
      ban_duration: banDuration,
    });

    if (authErr) {
      console.error('[block-user] auth ban_duration error:', authErr);
      // Profile is already updated — log warning, non-fatal (security_version bump below handles sessions)
      console.warn('[block-user] auth ban_duration update failed — sessions invalidated via security_version bump only');
    }

    // 6c. Bump security_version to immediately invalidate all existing sessions.
    //   checkRevocation in ctx.tsx fires on every poll/foreground/realtime event
    //   and will call forceSignOut when version mismatches.
    const { error: verErr } = await supabase.rpc('increment_security_version', {
      p_user_id: target_user_id,
    });
    if (verErr) console.warn('[block-user] security_version bump failed (non-fatal):', verErr);

    // 6d. For block: also force-sign-out all active sessions immediately
    if (action === 'block') {
      const { error: signOutErr } = await supabase.auth.admin.signOut(target_user_id, 'global');
      if (signOutErr) console.warn('[block-user] global signOut failed (non-fatal):', signOutErr.message);
    }

    // 7. Audit log
    try {
      const { data: actorProfile } = await supabase
        .from('profiles').select('full_name').eq('id', actorId).single();
      const actorName = actorProfile?.full_name ?? 'Super Admin';

      await supabase.from('audit_logs').insert({
        actor_id:       actorId,
        actor_name:     actorName,
        action:         action === 'block' ? 'user_blocked' : 'user_unblocked',
        resource_type:  'profile',
        resource_id:    target_user_id,
        target_user_id,
        target_name:    targetProfile.full_name ?? target_user_id,
        description:    `${actorName} ${action === 'block' ? 'blocked' : 'unblocked'} account for ${targetProfile.full_name ?? target_user_id}`,
        new_values:     { status: newStatus },
        details:        { changed_by_role: actorRole },
        log_status:     'success',
      });
    } catch (auditErr) {
      console.warn('[block-user] audit log failed (non-blocking):', auditErr);
    }

    console.log(`[block-user] ${action} success — target:`, target_user_id, 'new status:', newStatus);
    return json({ success: true, status: newStatus });

  } catch (err) {
    if (err instanceof Response) return err;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[block-user] outer-catch:', msg);
    return new Response(
      JSON.stringify({ error: msg || 'Unexpected error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
    );
  }
});
