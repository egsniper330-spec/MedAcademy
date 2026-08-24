// supabase/functions/activation-codes/index.ts — v3
// Fixed: duplicate Deno.serve() + duplicate imports caused BOOT_ERROR.
// Actions: create, batch_create, assign, deactivate, reactivate, delete_code,
//          disable_batch, enable_batch, soft_delete_batch, clone_batch,
//          bulk_delete, bulk_disable, bulk_enable
import { requireAuth, requireRole, createServiceClient, json, corsHeaders } from '../_shared/auth.ts';

async function resolveUserId(
  svc: ReturnType<typeof createServiceClient>,
  body: Record<string, unknown>
): Promise<{ id: string; lookupMethod: string; userIdentifier: string } | null> {
  if (body.target_user_id && typeof body.target_user_id === 'string') {
    return { id: body.target_user_id, lookupMethod: 'user_id', userIdentifier: body.target_user_id };
  }
  const identifier = body.identifier as string | undefined;
  if (!identifier || identifier.trim().length < 2) return null;
  const { data } = await svc.rpc('lookup_user_by_identifier', { p_identifier: identifier.trim() });
  if (!data || data.length === 0) return null;
  const method = /^[^@\s]+@[^@\s]+/.test(identifier) ? 'email'
    : /^[\+0-9]/.test(identifier) ? 'phone' : 'name';
  return { id: data[0].id, lookupMethod: method, userIdentifier: identifier.trim() };
}

async function checkBulkFraud(svc: ReturnType<typeof createServiceClient>, actorId: string, count: number) {
  if (count > 50) {
    await svc.from('fraud_flags').insert({
      flag_type: 'bulk_code_generation', severity: 'medium',
      details: { count, actor_id: actorId },
    }).catch(() => {});
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { userId, role, token: _token } = await requireAuth(req);
    requireRole(role, ['admin', 'super_admin']);

    const idempotencyKey = req.headers.get('x-idempotency-key') ?? null;
    const body = await req.json();
    const { action, course_id, expires_at, count, code_id, batch_id, batch_label, notes, code_ids, prefix, max_uses } = body;

    const svc = createServiceClient();

    // Resolve actor name once for all audit entries in this request
    let actorName = 'Unknown';
    try {
      const { data: ap } = await svc.from('profiles').select('full_name').eq('id', userId).single();
      actorName = ap?.full_name ?? 'Unknown';
    } catch (_) {}

    // ── CREATE single ────────────────────────────────────────────────────────
    if (action === 'create') {
      if (!course_id) return json({ error: 'course_id is required' }, 400);
      const codeVal = Math.random().toString(36).substring(2, 10).toUpperCase();
      const { data: inserted, error: insErr } = await svc.from('activation_codes').insert({
        code: codeVal, course_id, status: 'active',
        created_by: userId, expires_at: expires_at ?? null,
      }).select('id, code, course_id, status, expires_at, created_at').single();
      if (insErr) return json({ error: insErr.message }, 400);
      try {
        await svc.from('audit_logs').insert({
          actor_id:      userId,
          actor_name:    actorName,
          action:        'code_created',
          resource_type: 'activation_code',
          resource_id:   inserted.id,
          description:   `${actorName} created activation code ${codeVal} for course ${course_id}`,
          new_values:    { code: codeVal, course_id, expires_at: expires_at ?? null },
          log_status:    'success',
        });
      } catch (_) {}
      if (idempotencyKey) { /* noted */ }
      return json(inserted);
    }

    // ── BATCH CREATE ─────────────────────────────────────────────────────────
    if (action === 'batch_create') {
      if (!course_id) return json({ error: 'course_id is required' }, 400);
      const qty = Math.min(Math.max(parseInt(String(count ?? '1'), 10), 1), 500);
      const codePrefix = typeof prefix === 'string' && prefix.trim().length > 0
        ? prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
        : null;
      const maxUsesVal = max_uses != null && max_uses !== 'unlimited'
        ? Math.max(1, parseInt(String(max_uses), 10))
        : null;
      const newBatchId = crypto.randomUUID();

      // Insert batch record — propagate error instead of silently swallowing it
      const { error: batchInsErr } = await svc.from('code_batches').insert({
        id: newBatchId,
        label: batch_label ?? `Batch ${new Date().toLocaleDateString()}`,
        course_id, created_by: userId, total_count: qty,
        expires_at: expires_at ?? null, notes: notes ?? null,
        prefix: codePrefix, max_uses: maxUsesVal,
      });
      if (batchInsErr) {
        console.error('[batch_create] code_batches insert failed:', batchInsErr);
        return json({ error: `Failed to create batch record: ${batchInsErr.message}` }, 400);
      }

      // Generate codes that are unique within the batch AND globally
      // Use 10-char tokens to drastically reduce global collision probability
      const usedTokens = new Set<string>();
      const generateCode = () => {
        let token: string;
        let attempts = 0;
        do {
          // 10 chars of base36 = ~3.7 trillion combinations
          token = Math.random().toString(36).substring(2, 12).toUpperCase();
          attempts++;
          if (attempts > 1000) throw new Error('Could not generate unique tokens after 1000 attempts');
        } while (usedTokens.has(token));
        usedTokens.add(token);
        return codePrefix ? `${codePrefix}-${token}` : token;
      };

      const rows = Array.from({ length: qty }, () => ({
        code: generateCode(),
        course_id, status: 'active', created_by: userId,
        expires_at: expires_at ?? null,
        batch_id: newBatchId, batch_label: batch_label ?? null,
        max_uses: maxUsesVal,
      }));

      const { error: insErr } = await svc.from('activation_codes').insert(rows);
      if (insErr) {
        console.error('[batch_create] activation_codes insert failed:', insErr);
        // Clean up the orphaned batch record
        await svc.from('code_batches').delete().eq('id', newBatchId).catch(() => {});
        return json({ error: `Failed to insert codes: ${insErr.message}` }, 400);
      }
      await checkBulkFraud(svc, userId, qty);
      // Return only summary — never stream all N code rows back; large payloads
      // cause Deno to hit its CPU/wall-clock limit and kill the connection before
      // the response is fully written, which the client receives as a 500 error
      // even though the DB commit already succeeded.
      return json({ success: true, batch_id: newBatchId, count: qty });
    }

    // ── ASSIGN (create + enroll) ─────────────────────────────────────────────
    if (action === 'assign') {
      if (!course_id) return json({ error: 'course_id is required' }, 400);
      const resolved = await resolveUserId(svc, body);
      if (!resolved) return json({ error: 'target_user_id or identifier is required and must match a user' }, 400);
      const codeVal = Math.random().toString(36).substring(2, 10).toUpperCase();
      const { data: codeData, error: codeErr } = await svc.from('activation_codes').insert({
        code: codeVal, course_id, status: 'used', created_by: userId,
        expires_at: expires_at ?? null, used_by: resolved.id, used_at: new Date().toISOString(),
      }).select('id, code').single();
      if (codeErr) return json({ error: codeErr.message }, 400);
      const { error: enrollErr } = await svc.from('enrollments').insert({ student_id: resolved.id, course_id });
      if (enrollErr && !enrollErr.message.includes('duplicate')) return json({ error: enrollErr.message }, 400);
      // Resolve target name for rich description
      let targetName = resolved.userIdentifier;
      try {
        const { data: tp } = await svc.from('profiles').select('full_name').eq('id', resolved.id).single();
        targetName = tp?.full_name ?? resolved.userIdentifier;
      } catch (_) {}
      try {
        await svc.from('audit_logs').insert({
          actor_id:       userId,
          actor_name:     actorName,
          action:         'code_redeemed',   // valid audit_action enum value (added in migration)
          resource_type:  'activation_code',
          resource_id:    codeData.id,
          target_user_id: resolved.id,
          target_name:    targetName,
          description:    `${actorName} assigned activation code ${codeData.code} to ${targetName} for course ${course_id}`,
          new_values:     { code: codeData.code, course_id, assigned_to: resolved.id },
          log_status:     'success',
        });
      } catch (_) {}
      return json({ success: true, target_user_id: resolved.id, code: codeData.code });
    }

    // ── DEACTIVATE single code ───────────────────────────────────────────────
    if (action === 'deactivate') {
      if (!code_id) return json({ error: 'code_id is required' }, 400);
      const { error } = await svc.from('activation_codes')
        .update({ status: 'deactivated', disabled_by: userId, disabled_at: new Date().toISOString() })
        .eq('id', code_id).eq('status', 'active');
      if (error) return json({ error: error.message }, 400);
      try {
        await svc.from('audit_logs').insert({
          actor_id:      userId,
          actor_name:    actorName,
          action:        'code_deactivated',
          resource_type: 'activation_code',
          resource_id:   code_id,
          description:   `${actorName} deactivated activation code ${code_id}`,
          old_values:    { status: 'active' },
          new_values:    { status: 'deactivated' },
          log_status:    'success',
        });
      } catch (_) {}
      return json({ success: true });
    }

    // ── REACTIVATE single code ───────────────────────────────────────────────
    if (action === 'reactivate') {
      if (!code_id) return json({ error: 'code_id is required' }, 400);
      const { error } = await svc.from('activation_codes')
        .update({ status: 'active', disabled_by: null, disabled_at: null })
        .eq('id', code_id).eq('status', 'deactivated');
      if (error) return json({ error: error.message }, 400);
      return json({ success: true });
    }

    // ── DELETE single code ───────────────────────────────────────────────────
    if (action === 'delete_code') {
      if (!code_id) return json({ error: 'code_id is required' }, 400);
      const { data: codeRow } = await svc.from('activation_codes')
        .select('status, code').eq('id', code_id).maybeSingle();
      if (!codeRow) return json({ error: 'Code not found' }, 404);
      if (codeRow.status === 'used') return json({ error: 'Cannot delete a code that has already been used' }, 400);
      const { error: delErr } = await svc.from('activation_codes').delete().eq('id', code_id);
      if (delErr) return json({ error: delErr.message }, 400);
      try {
        await svc.from('audit_logs').insert({
          actor_id:      userId,
          actor_name:    actorName,
          action:        'code_deleted',
          resource_type: 'activation_code',
          resource_id:   code_id,
          description:   `${actorName} deleted activation code ${codeRow.code}`,
          old_values:    { code: codeRow.code, status: codeRow.status },
          log_status:    'success',
        });
      } catch (_) {}
      return json({ success: true });
    }

    // ── BULK DELETE ──────────────────────────────────────────────────────────
    if (action === 'bulk_delete') {
      if (!Array.isArray(code_ids) || code_ids.length === 0) return json({ error: 'code_ids array is required' }, 400);
      // Only allow deleting non-used codes
      const { error } = await svc.from('activation_codes')
        .delete()
        .in('id', code_ids)
        .neq('status', 'used');
      if (error) return json({ error: error.message }, 400);
      return json({ success: true, deleted: code_ids.length });
    }

    // ── BULK DISABLE ─────────────────────────────────────────────────────────
    if (action === 'bulk_disable') {
      if (!Array.isArray(code_ids) || code_ids.length === 0) return json({ error: 'code_ids array is required' }, 400);
      const { error } = await svc.from('activation_codes')
        .update({ status: 'deactivated', disabled_by: userId, disabled_at: new Date().toISOString() })
        .in('id', code_ids).eq('status', 'active');
      if (error) return json({ error: error.message }, 400);
      return json({ success: true });
    }

    // ── BULK ENABLE ──────────────────────────────────────────────────────────
    if (action === 'bulk_enable') {
      if (!Array.isArray(code_ids) || code_ids.length === 0) return json({ error: 'code_ids array is required' }, 400);
      const { error } = await svc.from('activation_codes')
        .update({ status: 'active', disabled_by: null, disabled_at: null })
        .in('id', code_ids).eq('status', 'deactivated');
      if (error) return json({ error: error.message }, 400);
      return json({ success: true });
    }

    // ── DISABLE entire batch ─────────────────────────────────────────────────
    if (action === 'disable_batch') {
      if (!batch_id) return json({ error: 'batch_id is required' }, 400);
      const { error, count: affected } = await svc.from('activation_codes')
        .update({ status: 'disabled', disabled_by: userId, disabled_at: new Date().toISOString() })
        .eq('batch_id', batch_id).eq('status', 'active');
      if (error) return json({ error: error.message }, 400);
      await svc.from('code_batches').update({ disabled_count: affected ?? 0 }).eq('id', batch_id).catch(() => {});
      return json({ success: true, disabled: affected });
    }

    // ── ENABLE entire batch ──────────────────────────────────────────────────
    if (action === 'enable_batch') {
      if (!batch_id) return json({ error: 'batch_id is required' }, 400);
      const { error, count: affected } = await svc.from('activation_codes')
        .update({ status: 'active', disabled_by: null, disabled_at: null })
        .eq('batch_id', batch_id).eq('status', 'disabled');
      if (error) return json({ error: error.message }, 400);
      return json({ success: true, enabled: affected });
    }

    // ── HARD DELETE entire batch ─────────────────────────────────────────────
    // Delete child codes first, then the parent batch record.
    // activation_codes.batch_id also has ON DELETE CASCADE as DB-level safety net,
    // but we delete explicitly so the operation is clear and auditable.
    if (action === 'hard_delete_batch') {
      if (!batch_id) return json({ error: 'batch_id is required' }, 400);

      // Verify batch exists
      const { data: batchRow } = await svc.from('code_batches')
        .select('id, label').eq('id', batch_id).maybeSingle();
      if (!batchRow) return json({ error: 'Batch not found' }, 404);

      // Step 1: permanently delete all child activation codes
      const { error: codesErr } = await svc.from('activation_codes')
        .delete().eq('batch_id', batch_id);
      if (codesErr) {
        console.error('[hard_delete_batch] codes delete failed:', codesErr);
        return json({ error: `Failed to delete batch codes: ${codesErr.message}` }, 400);
      }

      // Step 2: permanently delete the batch record itself
      const { error: batchErr } = await svc.from('code_batches')
        .delete().eq('id', batch_id);
      if (batchErr) {
        console.error('[hard_delete_batch] batch delete failed:', batchErr);
        return json({ error: `Failed to delete batch record: ${batchErr.message}` }, 400);
      }

      // Audit log
      try {
        await svc.from('audit_logs').insert({
          actor_id:      userId,
          actor_name:    actorName,
          action:        'code_deleted',
          resource_type: 'activation_code',
          resource_id:   batch_id,
          description:   `${actorName} permanently deleted batch "${batchRow.label ?? batch_id}" and all its codes`,
          old_values:    { batch_id, batch_label: batchRow.label },
          log_status:    'success',
        });
      } catch (_) {}

      return json({ success: true, batch_id });
    }

    // ── CLONE batch ──────────────────────────────────────────────────────────
    if (action === 'clone_batch') {
      if (!batch_id) return json({ error: 'batch_id is required' }, 400);
      const { data: srcBatch } = await svc.from('code_batches').select('*').eq('id', batch_id).single();
      if (!srcBatch) return json({ error: 'Batch not found' }, 404);
      const qty = srcBatch.total_count ?? 10;
      const newBatchId = crypto.randomUUID();
      await svc.from('code_batches').insert({
        id: newBatchId,
        label: `Clone of ${srcBatch.label ?? batch_id}`,
        course_id: srcBatch.course_id, created_by: userId,
        total_count: qty, expires_at: srcBatch.expires_at ?? null,
        notes: `Cloned from ${batch_id}`,
      }).catch(() => {});
      const rows = Array.from({ length: qty }, () => ({
        code: Math.random().toString(36).substring(2, 10).toUpperCase(),
        course_id: srcBatch.course_id, status: 'active', created_by: userId,
        expires_at: srcBatch.expires_at ?? null,
        batch_id: newBatchId, batch_label: `Clone of ${srcBatch.label ?? batch_id}`,
      }));
      const { data: inserted, error: insErr } = await svc.from('activation_codes').insert(rows).select('id, code');
      if (insErr) return json({ error: insErr.message }, 400);
      return json({ success: true, new_batch_id: newBatchId, count: inserted?.length ?? 0 });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    if (err instanceof Response) return err;
    console.error('[activation-codes] error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
