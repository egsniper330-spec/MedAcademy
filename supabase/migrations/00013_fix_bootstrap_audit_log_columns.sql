
-- Fix bootstrap_super_admin: audit_logs has no user_agent column
CREATE OR REPLACE FUNCTION public.bootstrap_super_admin(
  p_user_id   uuid,
  p_email     text,
  p_full_name text,
  p_phone     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Guard: refuse if a DIFFERENT super_admin already exists
  IF EXISTS (
    SELECT 1 FROM profiles
    WHERE role = 'super_admin'
      AND id  != p_user_id
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'BOOTSTRAP_LOCKED: A Super Admin already exists. Bootstrap is permanently disabled.';
  END IF;

  -- Upsert profile (handle_new_user trigger may have already created it)
  INSERT INTO profiles (id, email, full_name, phone, role, status)
  VALUES (p_user_id, p_email, p_full_name, p_phone, 'super_admin', 'active')
  ON CONFLICT (id) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        phone     = EXCLUDED.phone,
        role      = 'super_admin',
        status    = 'active';

  -- Audit log using actual columns
  INSERT INTO audit_logs (user_id, action, details, ip_address)
  VALUES (
    p_user_id,
    'super_admin_created',
    jsonb_build_object(
      'email',     p_email,
      'full_name', p_full_name,
      'role',      'super_admin',
      'note',      'Bootstrap: first super_admin created via bootstrap-super-admin Edge Function'
    ),
    NULL
  );
END;
$$;
