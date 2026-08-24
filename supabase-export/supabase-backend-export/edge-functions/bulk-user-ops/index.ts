// supabase/functions/bulk-user-ops/index.ts — v76
// Bulk operations on user accounts.
// Admin / super_admin only.
//
// POST { operation, user_ids, reason? }
//
// Operations:
//   trash              — move all to trash
//   restore            — restore all from trash
//   suspend            — set status = suspended
//   unsuspend          — set status = active
//   reset_password     — send password reset email to each
//   reset_devices      — clear device binding for each
//   permanent_delete   — hard delete all (super_admin only)

import { createClient } from 'npm:@supabase/supabase-js@2';

function svc() {
  // Supabase auto-injects SUPABASE_SERVICE_ROLE_KEY; SERVICE_ROLE_KEY is the
  // legacy custom-secret name. Accept either so both deployment configs work.
  const key =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
    Deno.env.get('SERVICE_ROLE_KEY');
  if (!key) console.error('[bulk-user-ops] FATAL: no service-role key found in environment');
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    key ?? '',
    { auth: { persistSession: false } }
  );
}

/** Map a raw error message to a clean, user-facing string that never leaks SQL internals. */
function safeMsg(raw: string, fallback = 'Operation failed.'): string {
  if (!raw) return fallback;
  const PG_PATTERN = /\b(select|insert|update|delete|from|where|join|on table|column|constraint|violates|relation|tuple)\b/i;
  const PG_CODE    = /\b[0-9]{5}\b/;
  if (PG_PATTERN.test(raw) || PG_CODE.test(raw)) return fallback;
  if (raw.length < 300) return raw;
  return fallback;
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, x-client-info',
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
function err(code: string, msg: string, status = 400) {
  return json({ success: false, code, message: msg }, status);
}

type BulkOp = 'trash' | 'restore' | 'suspend' | 'unsuspend' | 'reset_password' | 'reset_devices' | 'permanent_delete';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return err('METHOD_NOT_ALLOWED', 'POST only', 405);

  const db = svc();
  try {
    // ── Auth ───────────────────────────────────────────────────────────────
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: { user }, error: authErr } = await db.auth.getUser(token);
    if (authErr || !user) return err('UNAUTHORIZED', 'Invalid token', 401);
    const { data: actor } = await db.from('profiles').select('id,role,full_name,delete_permissions').eq('id', user.id).single();
    if (!['admin', 'super_admin'].includes(actor?.role ?? '')) return err('FORBIDDEN', 'Requires admin or super_admin', 403);

    const actorId   = user.id;
    const actorRole = actor!.role as string;
    const actorName: string = (actor as Record<string, unknown>)?.full_name as string ?? 'Unknown';

    // ── Parse body ─────────────────────────────────────────────────────────
    const { operation, user_ids, reason } = await req.json() as {
      operation: BulkOp;
      user_ids: string[];
      reason?: string;
    };

    if (!operation)        return err('MISSING_PARAMS', 'operation required');
    if (!Array.isArray(user_ids) || user_ids.length === 0) return err('MISSING_PARAMS', 'user_ids array required');
    if (user_ids.length > 200) return err('TOO_MANY', 'Max 200 users per bulk operation');

    // Remove self from list silently
    const safeIds = user_ids.filter(id => id !== actorId);

    // ── Permission guard for permanent_delete ─────────────────────────────
    if (operation === 'permanent_delete' && actorRole !== 'super_admin') {
      return err('FORBIDDEN', 'Only super_admin can permanently delete accounts', 403);
    }

    let success = 0;
    let failed  = 0;
    const errors: Array<{ user_id: string; message: string }> = [];

    // ── Execute per operation ─────────────────────────────────────────────
    if (operation === 'trash') {
      const { data, error: rpcErr } = await db.rpc('bulk_trash_users', {
        p_user_ids: safeIds,
        p_actor_id: actorId,
        p_reason:   reason ?? null,
      });
      if (rpcErr) return err('DB_ERROR', rpcErr.message, 500);
      const r = data as { trashed: number; failed: number };
      success = r.trashed; failed = r.failed;

      // Suspend auth for all trashed users (best-effort)
      await Promise.allSettled(
        safeIds.map(id => db.auth.admin.updateUserById(id, { ban_duration: '87600h' }))
      );

    } else if (operation === 'restore') {
      const { data, error: rpcErr } = await db.rpc('bulk_restore_users', {
        p_user_ids: safeIds,
        p_actor_id: actorId,
      });
      if (rpcErr) return err('DB_ERROR', rpcErr.message, 500);
      const r = data as { restored: number; failed: number };
      success = r.restored; failed = r.failed;

      // Re-enable auth for all restored users (best-effort)
      await Promise.allSettled(
        safeIds.map(id => db.auth.admin.updateUserById(id, { ban_duration: 'none' }))
      );

    } else if (operation === 'suspend' || operation === 'unsuspend') {
      const newStatus = operation === 'suspend' ? 'suspended' : 'active';
      const { error: upErr } = await db.from('profiles')
        .update({ status: newStatus })
        .in('id', safeIds);
      if (upErr) return err('DB_ERROR', upErr.message, 500);
      success = safeIds.length;

      // Sync auth ban
      const banDuration = operation === 'suspend' ? '87600h' : 'none';
      await Promise.allSettled(
        safeIds.map(id => db.auth.admin.updateUserById(id, { ban_duration: banDuration }))
      );

      // Use explicit enum-safe action string — never interpolate into the action column
      const bulkStatusAction = operation === 'suspend' ? 'bulk_suspend' : 'bulk_unsuspend';
      await db.from('audit_logs').insert({
        actor_id:     actorId,
        actor_name:   actorName,
        action:       bulkStatusAction,
        resource_type: 'profile',
        resource_id:  null,
        description:  `${actorName} bulk ${operation === 'suspend' ? 'suspended' : 'unsuspended'} ${safeIds.length} account(s)${reason ? `. Reason: ${reason}` : ''}`,
        new_values:   { status: newStatus, affected_count: safeIds.length },
        log_status:   'success',
      }).catch(() => {});

    } else if (operation === 'reset_devices') {
      const { error: devErr } = await db.from('devices').delete().in('user_id', safeIds);
      if (devErr) return err('DB_ERROR', devErr.message, 500);
      success = safeIds.length;
      await db.from('audit_logs').insert({
        actor_id:    actorId,
        actor_name:  actorName,
        action:      'bulk_reset_devices',
        resource_type: 'profile',
        resource_id: null,
        description: `${actorName} reset all devices for ${safeIds.length} account(s)`,
        new_values:  { devices_cleared: true, affected_count: safeIds.length },
        log_status:  'success',
      }).catch(() => {});

    } else if (operation === 'reset_password') {
      // Fetch emails for each user
      const { data: profiles } = await db.from('profiles').select('id,email').in('id', safeIds);
      const results = await Promise.allSettled(
        (profiles ?? []).map(p =>
          p.email ? db.auth.resetPasswordForEmail(p.email, {
            redirectTo: `${Deno.env.get('SITE_URL') ?? 'https://medacademy.app'}/reset-password`,
          }) : Promise.reject(new Error('No email'))
        )
      );
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') success++;
        else { failed++; errors.push({ user_id: safeIds[i], message: r.reason?.message ?? 'Failed' }); }
      });
      await db.from('audit_logs').insert({
        actor_id:    actorId,
        actor_name:  actorName,
        action:      'bulk_reset_password',
        resource_type: 'profile',
        resource_id: null,
        description: `${actorName} sent password reset emails to ${success} of ${safeIds.length} account(s)${failed > 0 ? ` (${failed} failed)` : ''}`,
        new_values:  { emails_sent: success, failed, affected_count: safeIds.length },
        log_status:  success > 0 ? 'success' : 'failure',
      }).catch(() => {});

    } else if (operation === 'permanent_delete') {
      for (const id of safeIds) {
        try {
          const { data: res, error: rpcErr } = await db.rpc('hard_delete_user', {
            p_target_user_id: id, p_actor_id: actorId,
            p_reason: reason ?? 'Bulk permanent delete by super_admin',
          });
          if (rpcErr) {
            console.error('[bulk-user-ops] hard_delete_user rpc error:', rpcErr.message, 'user_id:', id);
            failed++;
            errors.push({ user_id: id, message: safeMsg(rpcErr.message) });
          } else if ((res as any)?.success) {
            // Auth deletion: retry once on transient failure
            const { error: authErr1 } = await db.auth.admin.deleteUser(id);
            if (authErr1) {
              console.warn('[bulk-user-ops] auth delete attempt 1 failed:', authErr1.message, 'user_id:', id, '— retrying');
              await new Promise(r => setTimeout(r, 800));
              const { error: authErr2 } = await db.auth.admin.deleteUser(id);
              if (authErr2) {
                console.error('[bulk-user-ops] auth delete attempt 2 failed:', authErr2.message, 'user_id:', id);
                // Fallback: clear ban so orphaned auth row doesn't show "User is banned"
                await db.auth.admin.updateUserById(id, { ban_duration: 'none' }).catch(() => {});
              }
            }
            success++;
          } else {
            const code = (res as any)?.code ?? 'DELETE_FAILED';
            const rawMsg = (res as any)?.message ?? 'Deletion failed (unknown reason)';
            console.warn('[bulk-user-ops] hard_delete_user returned failure:', code, rawMsg, 'user_id:', id);
            failed++;
            errors.push({ user_id: id, message: safeMsg(rawMsg) });
          }
        } catch (e) {
          const emsg = e instanceof Error ? `${e.name}: ${e.message}`
            : (e && typeof e === 'object' && 'message' in e)
              ? String((e as Record<string,unknown>).message)
              : String(e);
          console.error('[bulk-user-ops] unexpected error for user_id:', id, emsg);
          failed++;
          errors.push({ user_id: id, message: safeMsg(emsg) });
        }
      }
      await db.from('audit_logs').insert({
        actor_id:    actorId,
        actor_name:  actorName,
        action:      'bulk_permanent_delete',
        resource_type: 'profile',
        resource_id: null,
        description: `${actorName} permanently deleted ${success} of ${safeIds.length} account(s)${reason ? `. Reason: ${reason}` : ''}${failed > 0 ? ` (${failed} failed)` : ''}`,
        new_values:  { deleted: success, failed, affected_count: safeIds.length },
        log_status:  success > 0 ? 'success' : 'failure',
      }).catch(() => {});

      // If every single delete failed, surface a clean error so the frontend
      // throws and shows the message instead of silently succeeding with 0 deleted.
      if (success === 0 && failed > 0) {
        // errors[].message is already sanitized via safeMsg() above
        const firstMsg = errors[0]?.message ?? 'All deletions failed.';
        console.error('[bulk-user-ops] all permanent deletes failed, returning 422. first error:', firstMsg);
        return err('DELETE_FAILED', firstMsg, 422);
      }

    } else {
      return err('UNKNOWN_OPERATION', `Unknown operation: ${operation}`);
    }

    return json({ success: true, operation, processed: safeIds.length, succeeded: success, failed, errors });

  } catch (e) {
    if (e instanceof Response) return e;
    const emsg = e instanceof Error ? `${e.name}: ${e.message}`
      : (e && typeof e === 'object' && 'message' in e)
        ? String((e as Record<string,unknown>).message)
        : String(e);
    console.error('[bulk-user-ops] unexpected outer catch:', emsg);
    return err('INTERNAL_ERROR', safeMsg(emsg, 'An unexpected error occurred.'), 500);
  }
});
