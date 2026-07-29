-- Add p_actor_id parameter so service-role callers (Edge Functions) can pass
-- the authenticated user's ID instead of relying on auth.uid() which is NULL
-- in service-role context.
CREATE OR REPLACE FUNCTION allocate_credits(
  p_doctor_id uuid,
  p_amount    integer,
  p_notes     text    DEFAULT '',
  p_actor_id  uuid    DEFAULT NULL   -- NEW: EF passes caller's userId here
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid := COALESCE(p_actor_id, auth.uid());
BEGIN
  IF v_admin_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
  END IF;

  -- Upsert doctor credits row
  INSERT INTO credits (doctor_id, allocated, remaining)
  VALUES (p_doctor_id, p_amount, p_amount)
  ON CONFLICT (doctor_id) DO UPDATE SET
    allocated  = credits.allocated  + p_amount,
    remaining  = credits.remaining  + p_amount,
    updated_at = now();

  -- Record transaction
  INSERT INTO credit_transactions (doctor_id, transaction_type, amount, performed_by, notes)
  VALUES (p_doctor_id, 'allocation', p_amount, v_admin_id, p_notes);

  -- Audit
  INSERT INTO audit_logs (user_id, action, details)
  VALUES (v_admin_id, 'credit_allocated',
    jsonb_build_object('doctor_id', p_doctor_id, 'amount', p_amount, 'notes', p_notes));

  RETURN jsonb_build_object('success', true);
END;
$$;