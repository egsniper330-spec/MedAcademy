
-- The bootstrap_super_admin() DB function raises BOOTSTRAP_LOCKED when it sees
-- any super_admin profile — but handle_new_user trigger already inserted the
-- profile for THIS user before bootstrap_super_admin() runs.
-- Fix: exclude the current user's own profile from the lock check.
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
  -- (exclude the profile that handle_new_user trigger just created for p_user_id)
  IF EXISTS (
    SELECT 1 FROM profiles
    WHERE role = 'super_admin'
      AND id  != p_user_id
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'BOOTSTRAP_LOCKED: A Super Admin already exists. Bootstrap is permanently disabled.';
  END IF;

  -- Upsert the profile: handle_new_user may have already inserted a minimal row;
  -- ensure full_name, phone, role, status are correct.
  INSERT INTO profiles (id, email, full_name, phone, role, status)
  VALUES (p_user_id, p_email, p_full_name, p_phone, 'super_admin', 'active')
  ON CONFLICT (id) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        phone     = EXCLUDED.phone,
        role      = 'super_admin',
        status    = 'active';

  -- Audit log
  INSERT INTO audit_logs (user_id, action, details, ip_address, user_agent)
  VALUES (
    p_user_id,
    'initial_super_admin_created',
    jsonb_build_object(
      'email',     p_email,
      'full_name', p_full_name,
      'role',      'super_admin',
      'note',      'Bootstrap: first super_admin created via bootstrap-super-admin Edge Function'
    ),
    NULL,
    'bootstrap-super-admin/edge-function'
  );
END;
$$;
