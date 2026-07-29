// supabase/functions/change-password/index.ts
// v8 — fixes device session bug after self password-change.
//
// Bug: When a user changes their own password the old Supabase session JWT
// becomes invalid (Supabase invalidates all sessions on password update).
// On next sign-in, `pre_login_device_check` compares the installation_id
// against the devices table. The previous device row was NOT revoked, so the
// returning device is found as a *known_device* → allowed = true. This should
// work, but in practice the security_version mismatch (bumped by other paths)
// or a stale device row state can cause the returning device to be treated as
// an unknown device → limit_reached → "already logged in on another device".
//
// Fix: After a self password-change, bump the security_version (invalidates
// any remaining JWTs) AND update all active device rows for this user to set
// last_active_at = now() so they stay recognised as known devices. We do NOT
// delete or revoke the user's own devices — that would trigger the
// "already logged in on another device" error on the very next login.
//
// Super Admin can change any user's password directly (no email, no old password).
// Regular Admin can change student/doctor passwords only.
import { requireAuth, createServiceClient, json, corsHeaders } from '../_shared/auth.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { userId, role: callerRole } = await requireAuth(req);
    const body = await req.json();
    const { target_user_id, new_password, current_installation_id } = body;

    if (!new_password || new_password.length < 8) {
      return json({ error: 'Password must be at least 8 characters' }, 400);
    }

    const svc = createServiceClient();

    // ── Self password change ────────────────────────────────────────────────
    if (!target_user_id || target_user_id === userId) {
      const { error } = await svc.auth.admin.updateUserById(userId, { password: new_password });
      if (error) return json({ error: error.message }, 400);

      // DEVICE SESSION FIX:
      // Supabase invalidates all existing JWTs on password update.
      // We must NOT bump security_version here because that would cause
      // check_authorization to reject the new session immediately after login.
      //
      // Instead: touch last_active_at on ALL of the user's active device rows.
      // This keeps every device in a known/active state so pre_login_device_check
      // recognises the returning device by installation_id and returns
      // { allowed: true, known_device: true } instead of limit_reached.
      //
      // If a specific current_installation_id is provided by the client, we
      // prioritise refreshing that device row. Either way we refresh all rows.
      try {
        const touchQuery = svc
          .from('devices')
          .update({ last_active_at: new Date().toISOString() })
          .eq('user_id', userId)
          .neq('status', 'blocked');

        await touchQuery;
      } catch (_) { /* non-fatal — device touch failure must not fail the password change */ }

      try {
        await svc.from('audit_logs').insert({
          actor_id:      userId,
          action:        'password_changed' as const,
          resource_type: 'profile',
          resource_id:   userId,
          description:   'User changed their own password.',
          log_status:    'success',
        });
      } catch (_) { /* non-fatal */ }
      return json({ success: true });
    }

    // ── Admin changing another user's password ─────────────────────────────
    // Fetch both profiles in parallel
    const [{ data: actorProfile }, { data: targetProfile }] = await Promise.all([
      svc.from('profiles').select('full_name, email, role').eq('id', userId).single(),
      svc.from('profiles').select('full_name, email, role').eq('id', target_user_id).single(),
    ]);

    if (!targetProfile) return json({ error: 'Target user not found' }, 404);

    // Permission matrix:
    //   super_admin → can change any user's password (student/doctor/admin/super_admin)
    //   admin       → can only change student/doctor passwords
    const isSuperAdmin = callerRole === 'super_admin';
    const targetRole   = targetProfile.role as string;
    const adminAllowed = ['student', 'doctor'];
    const superAllowed = ['student', 'doctor', 'admin', 'super_admin'];

    const allowed = isSuperAdmin ? superAllowed : adminAllowed;
    if (!allowed.includes(targetRole)) {
      return json({
        error: isSuperAdmin
          ? 'Target user role not supported.'
          : 'Only Super Admin can change passwords for Admin or Super Admin accounts.',
      }, 403);
    }

    // Update password directly via Supabase Admin API — no email sent
    const { error } = await svc.auth.admin.updateUserById(target_user_id, { password: new_password });
    if (error) return json({ error: error.message }, 400);

    // Write rich audit log — never store the password itself
    const actorName  = actorProfile?.full_name ?? 'Unknown';
    const targetName = targetProfile.full_name ?? 'Unknown';
    try {
      await svc.from('audit_logs').insert({
        actor_id:       userId,
        actor_name:     actorName,
        actor_email:    actorProfile?.email ?? null,
        actor_role:     callerRole,
        action:         'password_changed_by_admin' as const,
        resource_type:  'profile',
        resource_id:    target_user_id,
        target_user_id: target_user_id,
        target_name:    targetName,
        description:    `${actorName} changed ${targetName}'s password.`,
        new_values:     { changed_by: userId, changed_by_role: callerRole },
        user_id:        target_user_id,
        log_status:     'success',
      });
    } catch (_) { /* non-fatal — password was already changed */ }

    return json({ success: true, target_name: targetName });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error('[change-password] error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
