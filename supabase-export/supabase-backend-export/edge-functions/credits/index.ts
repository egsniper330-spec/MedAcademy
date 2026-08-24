// supabase/functions/credits/index.ts
// v2 — allocate, refund, revoke (reverse transaction), bulk ops, fraud flagging.
// Admin-only. Service role key never leaves this function.

import { requireAuth, requireRole, createServiceClient, json, corsHeaders } from '../_shared/auth.ts';

async function resolveDoctorId(
  supabase: ReturnType<typeof createServiceClient>,
  body: Record<string, unknown>
): Promise<{ id: string; lookupMethod: string; userIdentifier: string } | null> {
  if (body.doctor_id && typeof body.doctor_id === 'string') {
    return { id: body.doctor_id, lookupMethod: 'user_id', userIdentifier: body.doctor_id };
  }
  const identifier = body.identifier as string | undefined;
  if (!identifier || identifier.trim().length < 2) return null;
  const { data, error } = await supabase.rpc('lookup_user_by_identifier', { p_identifier: identifier.trim() });
  if (error || !data || data.length === 0) return null;
  const method = /^[^@\s]+@[^@\s]+/.test(identifier) ? 'email'
    : /^[\+0-9]/.test(identifier) ? 'phone' : 'name';
  return { id: data[0].id, lookupMethod: method, userIdentifier: identifier.trim() };
}

async function checkFraud(
  supabase: ReturnType<typeof createServiceClient>,
  doctorId: string, actorId: string, action: string, amount: number
) {
  if (action === 'allocate' && amount > 500) {
    await supabase.from('fraud_flags').insert({
      doctor_id: doctorId, flag_type: 'large_allocation', severity: 'high',
      details: { amount, actor_id: actorId },
    });
  }
  if (action === 'revoke') {
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await supabase
      .from('credit_transactions').select('id', { count: 'exact', head: true })
      .eq('doctor_id', doctorId).eq('transaction_type', 'deduction').gte('created_at', oneHourAgo);
    if ((count ?? 0) > 3) {
      await supabase.from('fraud_flags').insert({
        doctor_id: doctorId, flag_type: 'repeated_reversals', severity: 'medium',
        details: { count, actor_id: actorId },
      });
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { userId, role } = await requireAuth(req);
    requireRole(role, ['admin', 'super_admin']);

    const idempotencyKey = req.headers.get('x-idempotency-key') ?? null;
    const body = await req.json();
    const { action, amount, notes, reason, reference_id } = body;
    const supabase = createServiceClient();

    // ── BULK allocate ─────────────────────────────────────────────
    if (action === 'bulk_allocate') {
      const { doctor_ids, amounts } = body;
      if (!Array.isArray(doctor_ids) || doctor_ids.length === 0)
        return json({ error: 'doctor_ids array is required' }, 400);
      const results = [];
      for (let i = 0; i < doctor_ids.length; i++) {
        const amt = Array.isArray(amounts) ? (amounts[i] ?? amount) : amount;
        if (typeof amt !== 'number' || amt <= 0) continue;
        try {
          const { data, error } = await supabase.rpc('allocate_credits', {
            p_doctor_id: doctor_ids[i], p_amount: amt, p_notes: notes ?? '', p_actor_id: userId,
          });
          if (error) results.push({ doctor_id: doctor_ids[i], error: error.message });
          else {
            results.push({ doctor_id: doctor_ids[i], success: true, data });
            await checkFraud(supabase, doctor_ids[i], userId, 'allocate', amt);
            await supabase.rpc('check_low_credit_and_notify', { p_doctor_id: doctor_ids[i] });
          }
        } catch (e: any) { results.push({ doctor_id: doctor_ids[i], error: e.message }); }
      }
      return json({ success: true, results });
    }

    const resolved = await resolveDoctorId(supabase, body);
    if (!resolved) return json({ error: 'doctor_id or identifier is required' }, 400);
    const { id: doctor_id, lookupMethod, userIdentifier } = resolved;

    // ── ALLOCATE ──────────────────────────────────────────────────
    if (action === 'allocate') {
      if (typeof amount !== 'number' || amount <= 0) return json({ error: 'amount must be positive' }, 400);
      if (idempotencyKey) {
        const { data: existing } = await supabase.from('idempotency_keys').select('result')
          .eq('key', idempotencyKey).eq('user_id', userId).gt('expires_at', new Date().toISOString()).maybeSingle();
        if (existing) return json(existing.result);
      }
      const { data, error } = await supabase.rpc('allocate_credits', {
        p_doctor_id: doctor_id, p_amount: amount, p_notes: notes ?? '', p_actor_id: userId,
      });
      if (error) return json({ error: error.message }, 400);
      await checkFraud(supabase, doctor_id, userId, 'allocate', amount);
      await supabase.rpc('check_low_credit_and_notify', { p_doctor_id: doctor_id });
      const result = { success: true, doctor_id, amount };
      if (idempotencyKey) await supabase.from('idempotency_keys').insert({
        key: idempotencyKey, user_id: userId, operation: 'allocate_credits', result,
      });
      return json(result);
    }

    // ── REFUND (remove unused OR restore consumed credits) ───────────
    if (action === 'refund') {
      if (typeof amount !== 'number' || amount <= 0) return json({ error: 'amount must be positive' }, 400);
      if (idempotencyKey) {
        const { data: existing } = await supabase.from('idempotency_keys').select('result')
          .eq('key', idempotencyKey).eq('user_id', userId).gt('expires_at', new Date().toISOString()).maybeSingle();
        if (existing) return json(existing.result);
      }
      const { data: credits } = await supabase.from('credits').select('consumed, remaining, allocated')
        .eq('doctor_id', doctor_id).single();
      if (!credits) return json({ error: 'Doctor credits record not found' }, 404);

      // Business rule:
      //   - If removing UNUSED credits: remaining >= amount  → deduct from remaining
      //   - If restoring CONSUMED credits: consumed >= amount → move from consumed back to remaining
      // The client passes `refund_type: 'unused' | 'consumed'` to disambiguate.
      // Default (no refund_type): try unused first, then consumed.
      const refundType = (body.refund_type as string | undefined) ?? 'unused';

      if (refundType === 'unused') {
        if (credits.remaining < amount)
          return json({ error: `Cannot remove ${amount} unused credits — only ${credits.remaining} remaining (unspent).` }, 400);
        const balBefore = credits.remaining;
        const balAfter  = credits.remaining - amount;
        await supabase.from('credits').update({
          remaining: balAfter, allocated: (credits.allocated ?? 0) - amount,
          updated_at: new Date().toISOString(),
        }).eq('doctor_id', doctor_id);
        await supabase.from('credit_transactions').insert({
          doctor_id, transaction_type: 'deduction', amount, performed_by: userId,
          notes: notes ?? 'Admin removed unused credits', balance_before: balBefore, balance_after: balAfter,
          reference_id: reference_id ?? null,
        });
        await supabase.rpc('write_audit_log', {
          p_actor_id: userId, p_action: 'credit_allocated',
          p_details: { doctor_id, amount, type: 'remove_unused', notes },
          p_resource_type: 'credits', p_resource_id: doctor_id,
          p_lookup_method: lookupMethod, p_user_identifier: userIdentifier,
        });
        const result = { success: true, doctor_id, removed: amount, balance_before: balBefore, balance_after: balAfter };
        if (idempotencyKey) await supabase.from('idempotency_keys').insert({
          key: idempotencyKey, user_id: userId, operation: 'refund_credits', result,
        });
        return json(result);
      }

      // refund_type === 'consumed': restore consumed credits back to remaining
      if (credits.consumed < amount)
        return json({ error: `Refund amount ${amount} exceeds consumed credits (${credits.consumed}).` }, 400);
      const balBefore = credits.remaining;
      const balAfter  = credits.remaining + amount;
      await supabase.from('credits').update({
        consumed: credits.consumed - amount, remaining: balAfter, updated_at: new Date().toISOString(),
      }).eq('doctor_id', doctor_id);
      await supabase.from('credit_transactions').insert({
        doctor_id, transaction_type: 'restoration', amount, performed_by: userId,
        notes: notes ?? 'Admin refund', balance_before: balBefore, balance_after: balAfter,
        reference_id: reference_id ?? null,
      });
      await supabase.rpc('write_audit_log', {
        p_actor_id: userId, p_action: 'credit_allocated',
        p_details: { doctor_id, amount, type: 'refund_consumed', notes },
        p_resource_type: 'credits', p_resource_id: doctor_id,
        p_lookup_method: lookupMethod, p_user_identifier: userIdentifier,
      });
      await supabase.from('notifications').insert({
        user_id: doctor_id, title: 'Credits Refunded',
        body: `${amount} credits refunded. New balance: ${balAfter}`,
        notification_type: 'system',
      });
      const result = { success: true, doctor_id, refunded: amount, balance_before: balBefore, balance_after: balAfter };
      if (idempotencyKey) await supabase.from('idempotency_keys').insert({
        key: idempotencyKey, user_id: userId, operation: 'refund_credits', result,
      });
      return json(result);
    }

    // ── REVOKE (reverse transaction) ──────────────────────────────
    if (action === 'revoke') {
      if (typeof amount !== 'number' || amount <= 0) return json({ error: 'amount must be positive' }, 400);
      if (!reason) return json({ error: 'reason is required for revocation' }, 400);
      const { data, error } = await supabase.rpc('revoke_credits', {
        p_doctor_id: doctor_id, p_amount: amount,
        p_reason: reason, p_actor_id: userId,
        p_reference_id: reference_id ?? null,
      });
      if (error) return json({ error: error.message }, 400);
      await checkFraud(supabase, doctor_id, userId, 'revoke', amount);
      await supabase.rpc('check_low_credit_and_notify', { p_doctor_id: doctor_id });
      return json({ success: true, doctor_id, revoked: amount, ...(data as object) });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    if (err instanceof Response) return err;
    console.error('credits v2 error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
