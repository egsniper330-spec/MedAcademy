-- Fix write_audit_log overload ambiguity in register_device.
-- The two overloads have identical first 6 params; PostgreSQL can't resolve which to call
-- when only 6 args are passed. Fix by rewriting register_device to call the 7-param
-- variant explicitly with NULL for the 7th param (p_user_identifier).
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
    -- Explicit 7-param call to resolve overload ambiguity
    PERFORM write_audit_log(
      v_user_id, 'login'::audit_action,
      jsonb_build_object('device_id', v_device.id, 'platform', p_platform),
      'device', v_device.id,
      p_ip_address,    -- p_lookup_method (overload 1)
      NULL::text       -- p_user_identifier (overload 1) — disambiguates
    );
    RETURN jsonb_build_object('success', true, 'device_id', v_device.id, 'is_trusted', v_device.is_trusted);
  END IF;

  SELECT COUNT(*) INTO v_device_count FROM devices WHERE user_id = v_user_id;

  IF v_device_count >= v_max THEN
    -- Use the 8-param security overload explicitly
    PERFORM write_audit_log(
      v_user_id, 'security_event'::audit_action,
      jsonb_build_object('reason', 'device_limit_exceeded', 'count', v_device_count),
      NULL, NULL,
      p_ip_address,    -- p_ip_address (overload 2)
      false,           -- p_success
      'Device limit exceeded'
    );
    RETURN jsonb_build_object('success', false, 'error', 'Device limit reached. Contact support to reset.');
  END IF;

  INSERT INTO devices (user_id, device_fingerprint, device_name, platform)
  VALUES (v_user_id, p_fingerprint, p_device_name, p_platform)
  RETURNING * INTO v_device;

  PERFORM write_audit_log(
    v_user_id, 'login'::audit_action,
    jsonb_build_object('device_id', v_device.id, 'platform', p_platform, 'new_device', true),
    'device', v_device.id,
    p_ip_address,    -- p_lookup_method
    NULL::text       -- p_user_identifier — disambiguates to 7-param overload
  );
  RETURN jsonb_build_object('success', true, 'device_id', v_device.id, 'is_trusted', true);
END;
$$;