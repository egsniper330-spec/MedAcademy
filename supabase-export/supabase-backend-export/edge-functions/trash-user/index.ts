// supabase/functions/trash-user/index.ts — v74
// Move a user account to the Trash Bin (soft-delete with configurable retention).
// Admin / super_admin only.
//
// Routes:
//   POST { target_user_id, reason? }  → trash the account
//   DELETE { target_user_id }         → undo trash (restore immediately, for 10-second undo)

import { createClient } from 'npm:@supabase/supabase-js@2';

function svc() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, x-client-info',
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
function err(code: string, msg: string, status = 400) {
  return json({ success: false, code, message: msg }, status);
}

async function getActor(req: Request, db: ReturnType<typeof svc>) {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user) throw err('UNAUTHORIZED', 'Invalid token', 401);
  const { data: p } = await db.from('profiles').select('id,role,delete_permissions').eq('id', user.id).single();
  if (!['admin', 'super_admin'].includes(p?.role ?? '')) throw err('FORBIDDEN', 'Requires admin or super_admin', 403);
  return { actorId: user.id, actorRole: p!.role as string, perms: (p!.delete_permissions ?? {}) as Record<string, boolean> };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const db = svc();
  try {
    const { actorId, actorRole, perms } = await getActor(req, db);

    if (req.method !== 'POST') return err('METHOD_NOT_ALLOWED', 'POST only', 405);

    const body = await req.json() as { target_user_id?: string; reason?: string; action?: string };
    const { target_user_id, reason, action } = body;

    // ── action=restore → undo trash / restore ─────────────────────────────
    if (action === 'restore') {
      if (!target_user_id) return err('MISSING_PARAMS', 'target_user_id required');

      const { data, error } = await db.rpc('restore_user', {
        p_target_user_id: target_user_id,
        p_actor_id: actorId,
      });
      if (error) return err('DB_ERROR', error.message, 500);
      const result = data as { success: boolean; code?: string; message?: string; full_name?: string };
      if (!result.success) return err(result.code ?? 'RESTORE_FAILED', result.message ?? 'Restore failed');

      // Re-enable auth user
      await db.auth.admin.updateUserById(target_user_id, { ban_duration: 'none' }).catch(() => {});

      return json({ success: true, action: 'restored', user_id: target_user_id, full_name: result.full_name });
    }

    // ── default: move to trash ────────────────────────────────────────────
    if (!target_user_id) return err('MISSING_PARAMS', 'target_user_id required');
    if (target_user_id === actorId) return err('SELF_TRASH', 'Cannot trash your own account');

    // Fetch target role for permission check
    const { data: target } = await db.from('profiles').select('role,status').eq('id', target_user_id).maybeSingle();
    if (!target) return err('NOT_FOUND', 'User not found', 404);
    if (target.status === 'trashed') return err('ALREADY_TRASHED', 'User is already in trash');

    // Permission checks (only enforced for admin; super_admin bypasses)
    if (actorRole === 'admin') {
      if (target.role === 'student'    && perms.can_delete_students === false) return err('FORBIDDEN', 'No permission to delete students', 403);
      if (target.role === 'doctor'     && perms.can_delete_doctors  === false) return err('FORBIDDEN', 'No permission to delete doctors', 403);
      if (target.role === 'admin'      && perms.can_delete_admins   === false) return err('FORBIDDEN', 'No permission to delete admins', 403);
      if (target.role === 'super_admin') return err('FORBIDDEN', 'Cannot trash a super_admin', 403);
    }
    if (target.role === 'super_admin' && actorRole !== 'super_admin') {
      return err('FORBIDDEN', 'Only super_admin can trash a super_admin', 403);
    }

    // DB: set status = trashed, record retention expiry
    const { data: rpcResult, error: rpcErr } = await db.rpc('trash_user', {
      p_target_user_id: target_user_id,
      p_actor_id: actorId,
      p_reason: reason ?? null,
    });
    if (rpcErr) return err('DB_ERROR', rpcErr.message, 500);
    const res = rpcResult as { success: boolean; code?: string; message?: string; expires_at?: string; full_name?: string };
    if (!res.success) return err(res.code ?? 'TRASH_FAILED', res.message ?? 'Trash failed');

    // Suspend auth user (prevent login, but DON'T delete — needed for restore)
    await db.auth.admin.updateUserById(target_user_id, {
      ban_duration: '87600h', // 10 years — effectively suspended until restored or permanently deleted
    }).catch((e: Error) => console.warn('[trash-user] auth ban failed:', e.message));

    return json({
      success:    true,
      user_id:    target_user_id,
      full_name:  res.full_name,
      expires_at: res.expires_at,
    });

  } catch (e) {
    if (e instanceof Response) return e;
    return err('INTERNAL_ERROR', String(e), 500);
  }
});
