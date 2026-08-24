-- =============================================================================
-- MedAcademy — PostgreSQL Functions & RPCs
-- Generated: 2026-07-13
-- Total: 59 functions
-- IMPORTANT: Full live source available via:
--   SELECT proname, prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace;
-- This file contains the canonical definitions for reproduction.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER HELPER FUNCTIONS (used by RLS policies)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS public.user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
    AND role IN ('admin','super_admin')
    AND status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
    AND role = 'super_admin'
    AND status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_doctor()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
    AND role IN ('doctor','assistant')
    AND status = 'active'
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER FUNCTIONS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _full_name text;
  _phone     text;
  _email     text;
BEGIN
  _full_name := NEW.raw_user_meta_data->>'full_name';
  _phone     := COALESCE(NEW.phone, NEW.raw_user_meta_data->>'phone');
  _email     := COALESCE(NEW.email, NEW.raw_user_meta_data->>'email');

  INSERT INTO public.profiles (id, role, status, full_name, phone, email, is_first_login)
  VALUES (NEW.id, 'student', 'active', _full_name, _phone, _email, true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.credits (user_id, balance, total_allocated, total_consumed)
  VALUES (NEW.id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_user_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- FK ON DELETE CASCADE handles most cleanup.
  -- This trigger is a safety net for any orphan cleanup.
  DELETE FROM public.profiles WHERE id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_credit_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.balance < 0 THEN
    RAISE EXCEPTION 'Credit balance cannot go negative. Current: %, Attempted: %',
      OLD.balance, NEW.balance;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_enrollment_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.audit_logs (performed_by, target_user_id, action, table_name, record_id, new_values)
  VALUES (auth.uid(), NEW.user_id, 'enrollment_created', 'enrollments', NEW.id::text,
          jsonb_build_object('course_id', NEW.course_id, 'enrolled_at', NEW.enrolled_at));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_credit_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.audit_logs (performed_by, target_user_id, action, table_name, record_id, new_values)
  VALUES (NEW.performed_by, NEW.user_id, 'credit_allocated', 'credit_transactions', NEW.id::text,
          jsonb_build_object('amount', NEW.amount, 'type', NEW.transaction_type));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_code_redemption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Add credits to user balance
  UPDATE public.credits
  SET balance = balance + NEW.credit_amount,
      total_allocated = total_allocated + NEW.credit_amount,
      updated_at = now()
  WHERE user_id = NEW.used_by;

  -- Record the credit transaction
  INSERT INTO public.credit_transactions (user_id, amount, transaction_type, note)
  VALUES (NEW.used_by, NEW.credit_amount, 'allocation',
          'Activation code redeemed: ' || NEW.code);

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_storage_operation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.upload_audit_logs (user_id, action, file_name, bucket_name, storage_path, mime_type, file_size, status)
    VALUES (NEW.owner::uuid, 'upload', NEW.name, NEW.bucket_id, NEW.name, NEW.metadata->>'mimetype',
            (NEW.metadata->>'size')::bigint, 'success');
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.upload_audit_logs (user_id, action, file_name, bucket_name, storage_path, status)
    VALUES (OLD.owner::uuid, 'delete', OLD.name, OLD.bucket_id, OLD.name, 'deleted');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CORE RPCs (SECURITY DEFINER — key ones)
-- Full signatures; bodies condensed for brevity.
-- Full source: query pg_proc or Supabase Studio > Database > Functions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.redeem_activation_code(p_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code public.activation_codes%ROWTYPE;
  v_credit_balance int;
BEGIN
  -- Lock the row to prevent concurrent redemption
  SELECT * INTO v_code FROM public.activation_codes
  WHERE code = p_code AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Code not found or already used');
  END IF;
  IF v_code.expires_at IS NOT NULL AND v_code.expires_at < now() THEN
    UPDATE public.activation_codes SET status = 'expired' WHERE id = v_code.id;
    RETURN json_build_object('success', false, 'error', 'Code has expired');
  END IF;

  UPDATE public.activation_codes
  SET status = 'used', used_by = auth.uid(), used_at = now()
  WHERE id = v_code.id;

  -- Credits updated by handle_code_redemption trigger
  SELECT balance INTO v_credit_balance FROM public.credits WHERE user_id = auth.uid();

  RETURN json_build_object('success', true, 'credits_added', v_code.credit_amount,
                           'new_balance', v_credit_balance);
END;
$$;

CREATE OR REPLACE FUNCTION public.pre_login_device_check(
  p_user_id  uuid,
  p_device_id text,
  p_platform  text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile      public.profiles%ROWTYPE;
  v_device       public.devices%ROWTYPE;
  v_device_count int;
  v_max_devices  int := 2;
BEGIN
  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN json_build_object('allowed', false, 'reason', 'user_not_found');
  END IF;
  IF v_profile.status IN ('suspended','blocked','deleted','trashed') THEN
    RETURN json_build_object('allowed', false, 'reason', 'account_' || v_profile.status);
  END IF;
  IF v_profile.unlimited_devices THEN
    RETURN json_build_object('allowed', true, 'reason', 'unlimited_devices');
  END IF;

  SELECT * INTO v_device FROM public.devices
  WHERE user_id = p_user_id AND device_id = p_device_id LIMIT 1;

  IF FOUND THEN
    IF v_device.status = 'blocked' THEN
      RETURN json_build_object('allowed', false, 'reason', 'device_blocked');
    END IF;
    RETURN json_build_object('allowed', true, 'reason', 'known_device', 'device_db_id', v_device.id);
  END IF;

  -- New device — check limit
  SELECT COUNT(*) INTO v_device_count
  FROM public.devices WHERE user_id = p_user_id AND status = 'active';

  IF v_device_count >= v_max_devices THEN
    RETURN json_build_object('allowed', false, 'reason', 'device_limit_reached',
                             'current_count', v_device_count, 'max_devices', v_max_devices);
  END IF;

  RETURN json_build_object('allowed', true, 'reason', 'new_device_allowed',
                           'device_count', v_device_count + 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.write_audit_log(
  p_action        public.audit_action,
  p_target_user_id uuid DEFAULT NULL,
  p_metadata      jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.audit_logs (performed_by, target_user_id, action, metadata)
  VALUES (auth.uid(), p_target_user_id, p_action, p_metadata);
END;
$$;

CREATE OR REPLACE FUNCTION public.lookup_user_by_identifier(p_identifier text)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_results json;
BEGIN
  SELECT json_agg(row_to_json(r)) INTO v_results
  FROM (
    SELECT p.id, p.full_name, p.email, p.phone, p.role, p.status, p.avatar_url
    FROM public.profiles p
    WHERE p.email    ILIKE '%' || p_identifier || '%'
       OR p.phone    ILIKE '%' || p_identifier || '%'
       OR p.full_name ILIKE '%' || p_identifier || '%'
       OR p.id::text = p_identifier
    LIMIT 20
  ) r;
  RETURN COALESCE(v_results, '[]'::json);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_credits_balance()
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(balance, 0) FROM public.credits WHERE user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.get_security_version()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hash text;
BEGIN
  SELECT md5(string_agg(detection_type::text || action::text || enabled::text, ',' ORDER BY detection_type))
  INTO v_hash
  FROM public.security_policies;
  RETURN json_build_object('version', v_hash, 'generated_at', now());
END;
$$;

-- NOTE: Remaining 50+ RPCs follow the same SECURITY DEFINER pattern.
-- Full source for all functions available via:
--   SELECT routine_name, routine_definition
--   FROM information_schema.routines
--   WHERE routine_schema = 'public';
-- Or via Supabase Studio > Database > Functions
