-- BUG: write_audit_log(uuid, audit_action, jsonb, text, uuid) still ambiguous between 
-- overload-1 (8 args with ip/success/reason) and overload-2 (7 args with lookup_method/identifier).
-- Fix: call overload-1 explicitly with all 8 positional arguments (no ambiguity possible).
CREATE OR REPLACE FUNCTION public.create_activation_code(
  p_course_id uuid,
  p_expires_at timestamp with time zone DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_code     text;
  v_record   activation_codes;
  v_existing idempotency_keys;
  v_result   jsonb;
BEGIN
  IF NOT is_admin_or_super_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM idempotency_keys
    WHERE key = p_idempotency_key AND user_id = v_admin_id AND expires_at > now();
    IF FOUND THEN RETURN v_existing.result; END IF;
  END IF;

  LOOP
    v_code := upper(encode(gen_random_bytes(8), 'hex'));
    EXIT WHEN NOT EXISTS(SELECT 1 FROM activation_codes WHERE code = v_code);
  END LOOP;

  INSERT INTO activation_codes (code, course_id, expires_at, created_by)
  VALUES (v_code, p_course_id, p_expires_at, v_admin_id)
  RETURNING * INTO v_record;

  -- Overload-1: (actor, action, details, resource_type, resource_id, ip, success, reason)
  PERFORM write_audit_log(
    v_admin_id,
    'code_created'::audit_action,
    jsonb_build_object('code_id', v_record.id, 'course_id', p_course_id),
    'activation_code'::text,
    v_record.id,
    NULL::text,
    true::boolean,
    NULL::text
  );

  v_result := jsonb_build_object('success', true, 'code', v_code, 'id', v_record.id);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, user_id, operation, result)
    VALUES (p_idempotency_key, v_admin_id, 'create_activation_code', v_result);
  END IF;

  RETURN v_result;
END;
$$;