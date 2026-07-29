
-- Patch force_logout_device to match admin_reset_device pipeline exactly:
-- DELETE the device row instead of just marking it revoked.
-- This makes check_authorization fall back to security_version comparison only,
-- which is the same proven path that Reset All Devices uses.
-- The device row being gone means check_authorization cannot return authorized=true
-- regardless of what storedVersion the client has cached.

CREATE OR REPLACE FUNCTION force_logout_device(
  p_device_id UUID,
  p_reason    TEXT DEFAULT 'Admin force logout'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_owner_id UUID;
BEGIN
  IF NOT is_admin_or_super_admin() THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  SELECT user_id INTO v_owner_id FROM devices WHERE id = p_device_id;
  IF v_owner_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Device not found');
  END IF;

  -- DELETE the device row (same as admin_reset_device).
  -- This ensures check_authorization cannot find the device fingerprint and
  -- return authorized=true. The security_version bump alone is the revocation signal.
  DELETE FROM devices WHERE id = p_device_id;

  -- Bump security_version — this is the signal the client detects via Realtime.
  UPDATE profiles
  SET security_version = COALESCE(security_version, 0) + 1
  WHERE id = v_owner_id;

  PERFORM write_audit_log(
    v_admin_id,
    'device_force_logout'::audit_action,
    jsonb_build_object('device_id', p_device_id, 'owner_id', v_owner_id, 'reason', p_reason),
    'device',
    p_device_id,
    NULL::text,
    true,
    p_reason
  );

  RETURN jsonb_build_object('success', true);
END;
$$;
