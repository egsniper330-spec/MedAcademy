-- FIX: grant_course_access — ambiguous 5-arg write_audit_log → use 8-arg overload-1
CREATE OR REPLACE FUNCTION public.grant_course_access(
  p_student_id      uuid,
  p_course_id       uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_doctor_id uuid := auth.uid();
  v_credits   credits;
  v_existing  idempotency_keys;
  v_result    jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM idempotency_keys
    WHERE key = p_idempotency_key AND user_id = v_doctor_id AND expires_at > now();
    IF FOUND THEN RETURN v_existing.result; END IF;
  END IF;

  IF NOT EXISTS(SELECT 1 FROM courses WHERE id = p_course_id AND doctor_id = v_doctor_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized for this course');
  END IF;

  SELECT * INTO v_credits FROM credits WHERE doctor_id = v_doctor_id FOR UPDATE;
  IF v_credits.remaining < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient credits');
  END IF;

  IF EXISTS(SELECT 1 FROM enrollments WHERE student_id = p_student_id AND course_id = p_course_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Student already enrolled');
  END IF;

  INSERT INTO enrollments (student_id, course_id) VALUES (p_student_id, p_course_id);
  UPDATE credits SET consumed = consumed + 1, remaining = remaining - 1, updated_at = now()
  WHERE doctor_id = v_doctor_id;
  INSERT INTO credit_transactions (doctor_id, transaction_type, amount, course_id, student_id, performed_by)
  VALUES (v_doctor_id, 'consumption', 1, p_course_id, p_student_id, v_doctor_id);

  -- Overload-1: (actor, action, details, resource_type, resource_id, ip, success, reason)
  PERFORM write_audit_log(
    v_doctor_id,
    'credit_consumed'::audit_action,
    jsonb_build_object('student_id', p_student_id, 'course_id', p_course_id),
    'enrollment'::text,
    p_student_id,
    NULL::text,
    true::boolean,
    NULL::text
  );

  v_result := jsonb_build_object('success', true);
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, user_id, operation, result)
    VALUES (p_idempotency_key, v_doctor_id, 'grant_course_access', v_result);
  END IF;
  RETURN v_result;
END;
$$;

-- FIX: redeem_activation_code — ambiguous 5-arg write_audit_log on 'code_redeemed' → 8-arg overload-1
CREATE OR REPLACE FUNCTION public.redeem_activation_code(
  p_code text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_code_row   activation_codes;
  v_student_id uuid := auth.uid();
BEGIN
  IF v_student_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  IF NOT check_rate_limit(v_student_id::text, 'redeem_code', 5) THEN
    PERFORM write_audit_log(
      v_student_id, 'security_event'::audit_action,
      jsonb_build_object('reason', 'rate_limit', 'operation', 'redeem_code'),
      NULL::text, NULL::uuid, NULL::text, false::boolean, 'Rate limit exceeded'::text
    );
    RETURN jsonb_build_object('success', false, 'error', 'Too many attempts. Please wait.');
  END IF;

  SELECT * INTO v_code_row FROM activation_codes WHERE code = upper(trim(p_code)) FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM write_audit_log(
      v_student_id, 'security_event'::audit_action,
      jsonb_build_object('reason', 'invalid_code'),
      NULL::text, NULL::uuid, NULL::text, false::boolean, 'Code not found'::text
    );
    RETURN jsonb_build_object('success', false, 'error', 'Invalid code');
  END IF;

  IF v_code_row.status != 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code is not active');
  END IF;

  IF v_code_row.expires_at IS NOT NULL AND v_code_row.expires_at < now() THEN
    UPDATE activation_codes SET status = 'expired' WHERE id = v_code_row.id;
    RETURN jsonb_build_object('success', false, 'error', 'Code has expired');
  END IF;

  IF EXISTS(SELECT 1 FROM enrollments WHERE student_id = v_student_id AND course_id = v_code_row.course_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Already enrolled');
  END IF;

  INSERT INTO enrollments (student_id, course_id) VALUES (v_student_id, v_code_row.course_id);
  UPDATE activation_codes SET status = 'used', used_by = v_student_id, used_at = now()
  WHERE id = v_code_row.id;

  -- Overload-1: (actor, action, details, resource_type, resource_id, ip, success, reason)
  PERFORM write_audit_log(
    v_student_id,
    'code_redeemed'::audit_action,
    jsonb_build_object('code_id', v_code_row.id, 'course_id', v_code_row.course_id),
    'activation_code'::text,
    v_code_row.id,
    NULL::text,
    true::boolean,
    NULL::text
  );

  RETURN jsonb_build_object('success', true, 'course_id', v_code_row.course_id);
END;
$$;