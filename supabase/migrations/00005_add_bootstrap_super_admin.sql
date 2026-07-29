-- Add bootstrap action to audit_action enum
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'initial_super_admin_created';

-- ============================================================
-- bootstrap_super_admin()
-- Atomically inserts the first super_admin profile + audit log.
-- Called by the bootstrap-super-admin Edge Function AFTER the
-- Auth user has already been created.
-- Refuses to run if any super_admin already exists.
-- SECURITY DEFINER so it bypasses RLS (runs as postgres owner).
-- ============================================================
CREATE OR REPLACE FUNCTION bootstrap_super_admin(
  p_user_id   uuid,
  p_email     text,
  p_full_name text,
  p_phone     text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Guard: refuse if any super_admin already exists
  IF EXISTS (
    SELECT 1 FROM profiles WHERE role = 'super_admin' LIMIT 1
  ) THEN
    RAISE EXCEPTION 'BOOTSTRAP_LOCKED: A Super Admin already exists. Bootstrap is permanently disabled.';
  END IF;

  -- Insert profile
  INSERT INTO profiles (id, email, full_name, phone, role, status)
  VALUES (
    p_user_id,
    p_email,
    p_full_name,
    p_phone,
    'super_admin',
    'active'
  );

  -- Insert audit log (user_id = the new super_admin themselves)
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

-- Revoke public execute — only service role (via Edge Function) may call this
REVOKE ALL ON FUNCTION bootstrap_super_admin(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bootstrap_super_admin(uuid, text, text, text) TO service_role;