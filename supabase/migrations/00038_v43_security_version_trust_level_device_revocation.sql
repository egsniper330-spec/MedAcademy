
-- ================================================================
-- Migration 00038: Advanced Device Security
-- Adds security_version (force-logout), trust_level & revoked_at
-- on devices; updates admin_reset_device to bump version; adds
-- force_logout_device and logout_all_devices RPC helpers.
-- Also re-runs phone_e164 backfill for any missed rows.
-- ================================================================

-- ── 1. profiles.security_version ─────────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS security_version INTEGER NOT NULL DEFAULT 0;

-- ── 2. devices extra columns ──────────────────────────────────────────────────
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS trust_level TEXT NOT NULL DEFAULT 'trusted'
    CHECK (trust_level IN ('trusted','current','blocked','inactive','revoked')),
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

-- Index for fast device authorization checks
CREATE INDEX IF NOT EXISTS idx_devices_user_status
  ON devices (user_id, status);

-- ── 3. Extend audit_action enum if needed ─────────────────────────────────────
DO $$
BEGIN
  -- add 'device_force_logout' if not already present (idempotent)
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'audit_action'::regtype
      AND enumlabel = 'device_force_logout'
  ) THEN
    ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'device_force_logout';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'audit_action'::regtype
      AND enumlabel = 'device_logout_all'
  ) THEN
    ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'device_logout_all';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'audit_action'::regtype
      AND enumlabel = 'device_revoked'
  ) THEN
    ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'device_revoked';
  END IF;
END;
$$;

-- ── 4. Update admin_reset_device to increment security_version ────────────────
CREATE OR REPLACE FUNCTION public.admin_reset_device(
  p_target_user_id uuid,
  p_reason text DEFAULT ''
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
BEGIN
  IF NOT is_admin_or_super_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
  END IF;

  -- Mark all existing devices as revoked (keep records for history)
  UPDATE devices
  SET status       = 'logged_out',
      trust_level  = 'revoked',
      revoked_at   = now(),
      revoked_reason = COALESCE(NULLIF(p_reason,''), 'Admin reset')
  WHERE user_id = p_target_user_id
    AND status  != 'logged_out';

  -- Bump security_version → forces active sessions to detect change and log out
  UPDATE profiles
  SET security_version = COALESCE(security_version, 0) + 1
  WHERE id = p_target_user_id;

  PERFORM write_audit_log(
    v_admin_id,
    'device_reset'::audit_action,
    jsonb_build_object('target_user', p_target_user_id, 'reason', p_reason),
    'device'::text,
    p_target_user_id,
    NULL::text,
    true::boolean,
    NULL::text
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ── 5. force_logout_device: revoke a single device + bump security_version ────
CREATE OR REPLACE FUNCTION public.force_logout_device(
  p_device_id UUID,
  p_reason    TEXT DEFAULT 'Admin force logout'
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
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

  UPDATE devices
  SET status         = 'logged_out',
      trust_level    = 'revoked',
      revoked_at     = now(),
      revoked_reason = p_reason
  WHERE id = p_device_id;

  -- Bump security_version on owner so their app detects forced logout
  UPDATE profiles
  SET security_version = COALESCE(security_version, 0) + 1
  WHERE id = v_owner_id;

  PERFORM write_audit_log(
    v_admin_id,
    'device_force_logout'::audit_action,
    jsonb_build_object('device_id', p_device_id, 'reason', p_reason),
    'device'::text,
    v_owner_id,
    NULL::text,
    true::boolean,
    NULL::text
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ── 6. logout_all_devices: super_admin can logout ALL devices for a user ──────
CREATE OR REPLACE FUNCTION public.logout_all_devices(
  p_target_user_id UUID,
  p_exclude_fingerprint TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT 'Admin logout all'
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_admin_id  UUID := auth.uid();
  v_admin_role TEXT;
BEGIN
  SELECT role INTO v_admin_role FROM profiles WHERE id = v_admin_id;
  IF v_admin_role NOT IN ('admin','super_admin') THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  UPDATE devices
  SET status         = 'logged_out',
      trust_level    = 'revoked',
      revoked_at     = now(),
      revoked_reason = p_reason
  WHERE user_id = p_target_user_id
    AND status  != 'logged_out'
    AND (p_exclude_fingerprint IS NULL OR device_fingerprint != p_exclude_fingerprint);

  -- Bump security_version
  UPDATE profiles
  SET security_version = COALESCE(security_version, 0) + 1
  WHERE id = p_target_user_id;

  PERFORM write_audit_log(
    v_admin_id,
    'device_logout_all'::audit_action,
    jsonb_build_object('target_user', p_target_user_id, 'reason', p_reason,
                       'excluded_fp', p_exclude_fingerprint),
    'device'::text,
    p_target_user_id,
    NULL::text,
    true::boolean,
    NULL::text
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ── 7. get_security_version: fast check used by client on app focus ───────────
CREATE OR REPLACE FUNCTION public.get_security_version()
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(security_version, 0)
  FROM profiles
  WHERE id = auth.uid();
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.get_security_version() TO authenticated;
GRANT EXECUTE ON FUNCTION public.force_logout_device(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.logout_all_devices(UUID, TEXT, TEXT) TO authenticated;

-- ── 8. Re-run phone_e164 backfill (catch any rows missed since migration 18) ──
DO $$
DECLARE
  r record;
  v_e164 text;
BEGIN
  FOR r IN
    SELECT id, phone
    FROM profiles
    WHERE phone IS NOT NULL
      AND (phone_e164 IS NULL OR phone_e164 = '')
  LOOP
    v_e164 := normalize_phone_e164(r.phone);
    IF v_e164 IS NOT NULL THEN
      UPDATE profiles SET
        phone_e164         = v_e164,
        phone_national     = substring(v_e164 FROM 2),
        phone_country_code = CASE
          WHEN v_e164 ~ '^\+20'  THEN '+20'
          WHEN v_e164 ~ '^\+1'   THEN '+1'
          WHEN v_e164 ~ '^\+44'  THEN '+44'
          WHEN v_e164 ~ '^\+971' THEN '+971'
          WHEN v_e164 ~ '^\+966' THEN '+966'
          ELSE '+' || substring(v_e164 FROM 2 FOR 2)
        END
      WHERE id = r.id;
    END IF;
  END LOOP;
END;
$$;
