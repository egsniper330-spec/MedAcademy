
-- 1. Add the missing enum value to the correct type name
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'platform_earnings_reset';

-- 2. Recreate the RPC with correct audit_logs column names + success flag
CREATE OR REPLACE FUNCTION public.reset_platform_earnings(
  p_earnings_before numeric,
  p_admin_email     text,
  p_note            text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_reset_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_admin_id AND role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'forbidden: super_admin role required';
  END IF;

  INSERT INTO public.platform_earnings_resets
    (earnings_before, reset_by_id, reset_by_email, note)
  VALUES
    (p_earnings_before, v_admin_id, p_admin_email, p_note)
  RETURNING id INTO v_reset_id;

  -- Correct column names: resource_type, resource_id (uuid), details, success
  INSERT INTO public.audit_logs
    (actor_id, action, resource_type, resource_id, details, success)
  VALUES (
    v_admin_id,
    'platform_earnings_reset',
    'platform_earnings_resets',
    v_reset_id,
    jsonb_build_object(
      'admin_email',     p_admin_email,
      'earnings_before', p_earnings_before,
      'reset_at',        now()::text
    ),
    true
  );

  RETURN v_reset_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_platform_earnings(numeric, text, text) TO authenticated;
