
-- Creates bump_security_version(p_user_id) used by block_device Edge Function
-- to immediately invalidate the blocked device's session via the
-- check_authorization security_version comparison.
CREATE OR REPLACE FUNCTION public.bump_security_version(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE profiles
  SET security_version = COALESCE(security_version, 0) + 1
  WHERE id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bump_security_version(uuid) TO service_role;
