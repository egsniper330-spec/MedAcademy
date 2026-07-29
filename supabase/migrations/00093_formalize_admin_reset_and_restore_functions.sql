
-- Migration 00093: Formalize admin_reset_violations and admin_restore_account
-- Drop old versions first (parameter name mismatch), then recreate

DROP FUNCTION IF EXISTS public.admin_reset_violations(uuid);
DROP FUNCTION IF EXISTS public.admin_restore_account(uuid, boolean);

CREATE OR REPLACE FUNCTION public.admin_reset_violations(
  p_target_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  UPDATE profiles
  SET violation_count = 0,
      strike_count    = 0,
      updated_at      = now()
  WHERE id = p_target_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_restore_account(
  p_target_user_id uuid,
  p_reset_violations boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  UPDATE profiles
  SET
    status            = 'active',
    is_suspended      = false,
    suspension_reason = NULL,
    suspension_at     = NULL,
    suspension_device = NULL,
    violation_count   = CASE WHEN p_reset_violations THEN 0 ELSE violation_count END,
    strike_count      = CASE WHEN p_reset_violations THEN 0 ELSE strike_count END,
    updated_at        = now()
  WHERE id = p_target_user_id;
END;
$$;
