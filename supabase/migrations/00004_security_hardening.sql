
-- ============================================================
-- MedAcademy Migration 00004: Security Hardening
-- ============================================================

-- ── 1. Fix audit_logs schema ──────────────────────────────────
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resource_type text,
  ADD COLUMN IF NOT EXISTS resource_id uuid,
  ADD COLUMN IF NOT EXISTS device_id uuid,
  ADD COLUMN IF NOT EXISTS success boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reason text;

UPDATE audit_logs SET actor_id = user_id WHERE actor_id IS NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- ── 2. Harden audit_logs RLS ──────────────────────────────────
DROP POLICY IF EXISTS "audit_logs_insert_all" ON audit_logs;
CREATE POLICY "audit_logs_no_update" ON audit_logs FOR UPDATE TO authenticated USING (false);
CREATE POLICY "audit_logs_no_delete" ON audit_logs FOR DELETE TO authenticated USING (false);

-- ── 3. SECURITY DEFINER: write_audit_log ─────────────────────
CREATE OR REPLACE FUNCTION write_audit_log(
  p_actor_id      uuid,
  p_action        audit_action,
  p_details       jsonb DEFAULT '{}',
  p_resource_type text DEFAULT NULL,
  p_resource_id   uuid DEFAULT NULL,
  p_ip_address    text DEFAULT NULL,
  p_success       boolean DEFAULT true,
  p_reason        text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_logs (
    user_id, actor_id, action, details,
    resource_type, resource_id,
    ip_address, success, reason
  ) VALUES (
    p_actor_id, p_actor_id, p_action, p_details,
    p_resource_type, p_resource_id,
    p_ip_address, p_success, p_reason
  );
END;
$$;

-- ── 4. Idempotency keys table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  operation    text NOT NULL,
  result       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key ON idempotency_keys(key);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys(expires_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "idempotency_select_own" ON idempotency_keys FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "idempotency_no_update"  ON idempotency_keys FOR UPDATE TO authenticated USING (false);
CREATE POLICY "idempotency_no_delete"  ON idempotency_keys FOR DELETE TO authenticated USING (false);

-- ── 5. Rate limits table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_limits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier    text NOT NULL,
  operation     text NOT NULL,
  window_start  timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  request_count integer NOT NULL DEFAULT 1,
  UNIQUE(identifier, operation, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup ON rate_limits(identifier, operation, window_start);
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER: check_rate_limit
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_identifier     text,
  p_operation      text,
  p_max_per_minute integer DEFAULT 10
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window timestamptz := date_trunc('minute', now());
  v_count  integer;
BEGIN
  INSERT INTO rate_limits (identifier, operation, window_start, request_count)
  VALUES (p_identifier, p_operation, v_window, 1)
  ON CONFLICT (identifier, operation, window_start)
  DO UPDATE SET request_count = rate_limits.request_count + 1
  RETURNING request_count INTO v_count;
  RETURN v_count <= p_max_per_minute;
END;
$$;

-- ── 6. Harden device binding ──────────────────────────────────
DROP POLICY IF EXISTS "devices_insert_own" ON devices;
DROP POLICY IF EXISTS "devices_update_own" ON devices;
-- INSERT policies use WITH CHECK (not USING)
CREATE POLICY "devices_no_direct_insert" ON devices FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY "devices_no_direct_update" ON devices FOR UPDATE TO authenticated USING (false);

-- SECURITY DEFINER: register_device
CREATE OR REPLACE FUNCTION register_device(
  p_fingerprint text,
  p_device_name text,
  p_platform    text,
  p_ip_address  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     uuid := auth.uid();
  v_device_count integer;
  v_device      devices;
  v_max         integer := 2;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  IF NOT check_rate_limit(v_user_id::text, 'register_device', 5) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Too many registration attempts');
  END IF;

  SELECT * INTO v_device FROM devices
  WHERE user_id = v_user_id AND device_fingerprint = p_fingerprint;

  IF FOUND THEN
    UPDATE devices SET last_active_at = now() WHERE id = v_device.id;
    PERFORM write_audit_log(v_user_id, 'login',
      jsonb_build_object('device_id', v_device.id, 'platform', p_platform),
      'device', v_device.id, p_ip_address);
    RETURN jsonb_build_object('success', true, 'device_id', v_device.id, 'is_trusted', v_device.is_trusted);
  END IF;

  SELECT COUNT(*) INTO v_device_count FROM devices WHERE user_id = v_user_id;

  IF v_device_count >= v_max THEN
    PERFORM write_audit_log(v_user_id, 'security_event',
      jsonb_build_object('reason', 'device_limit_exceeded', 'count', v_device_count),
      NULL, NULL, p_ip_address, false, 'Device limit exceeded');
    RETURN jsonb_build_object('success', false, 'error', 'Device limit reached. Contact support to reset.');
  END IF;

  INSERT INTO devices (user_id, device_fingerprint, device_name, platform)
  VALUES (v_user_id, p_fingerprint, p_device_name, p_platform)
  RETURNING * INTO v_device;

  PERFORM write_audit_log(v_user_id, 'login',
    jsonb_build_object('device_id', v_device.id, 'platform', p_platform, 'new_device', true),
    'device', v_device.id, p_ip_address);
  RETURN jsonb_build_object('success', true, 'device_id', v_device.id, 'is_trusted', true);
END;
$$;

-- Admin reset device
CREATE OR REPLACE FUNCTION admin_reset_device(
  p_target_user_id uuid,
  p_reason         text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
BEGIN
  IF NOT is_admin_or_super_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
  END IF;
  DELETE FROM devices WHERE user_id = p_target_user_id;
  PERFORM write_audit_log(v_admin_id, 'device_reset',
    jsonb_build_object('target_user', p_target_user_id, 'reason', p_reason),
    'device', p_target_user_id);
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ── 7. Harden activation_codes creation ──────────────────────
DROP POLICY IF EXISTS "activation_codes_insert_admin" ON activation_codes;
-- activation codes can only be inserted by SECURITY DEFINER functions
CREATE POLICY "activation_codes_no_direct_insert" ON activation_codes FOR INSERT TO authenticated WITH CHECK (false);

-- Server-side code creation with idempotency
CREATE OR REPLACE FUNCTION create_activation_code(
  p_course_id       uuid,
  p_expires_at      timestamptz DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  PERFORM write_audit_log(v_admin_id, 'code_created',
    jsonb_build_object('code_id', v_record.id, 'course_id', p_course_id),
    'activation_code', v_record.id);

  v_result := jsonb_build_object('success', true, 'code', v_code, 'id', v_record.id);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, user_id, operation, result)
    VALUES (p_idempotency_key, v_admin_id, 'create_activation_code', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- ── 8. Harden redeem_activation_code with rate limiting ───────
CREATE OR REPLACE FUNCTION redeem_activation_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code_row   activation_codes;
  v_student_id uuid := auth.uid();
BEGIN
  IF v_student_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  IF NOT check_rate_limit(v_student_id::text, 'redeem_code', 5) THEN
    PERFORM write_audit_log(v_student_id, 'security_event',
      jsonb_build_object('reason', 'rate_limit', 'operation', 'redeem_code'),
      NULL, NULL, NULL, false, 'Rate limit exceeded');
    RETURN jsonb_build_object('success', false, 'error', 'Too many attempts. Please wait.');
  END IF;

  SELECT * INTO v_code_row FROM activation_codes WHERE code = upper(trim(p_code)) FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM write_audit_log(v_student_id, 'security_event',
      jsonb_build_object('reason', 'invalid_code'),
      NULL, NULL, NULL, false, 'Code not found');
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
  UPDATE activation_codes SET status = 'used', used_by = v_student_id, used_at = now() WHERE id = v_code_row.id;

  PERFORM write_audit_log(v_student_id, 'code_redeemed',
    jsonb_build_object('code_id', v_code_row.id, 'course_id', v_code_row.course_id),
    'activation_code', v_code_row.id);

  RETURN jsonb_build_object('success', true, 'course_id', v_code_row.course_id);
END;
$$;

-- ── 9. Harden grant_course_access with idempotency ───────────
CREATE OR REPLACE FUNCTION grant_course_access(
  p_student_id      uuid,
  p_course_id       uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  PERFORM write_audit_log(v_doctor_id, 'credit_consumed',
    jsonb_build_object('student_id', p_student_id, 'course_id', p_course_id),
    'enrollment', p_student_id);

  v_result := jsonb_build_object('success', true);
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, user_id, operation, result)
    VALUES (p_idempotency_key, v_doctor_id, 'grant_course_access', v_result);
  END IF;
  RETURN v_result;
END;
$$;
