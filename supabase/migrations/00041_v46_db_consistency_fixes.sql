
-- ============================================================
-- Migration 00041 — v46 Database Consistency Fixes
-- Fixes:
--   1. write_audit_log: add missing 8-arg overload (uuid,uuid,audit_action,text,text,text,text,text)
--   2. user_status enum: add 'deleted' value for soft-delete
--   3. audit_action enum: add 'user_deleted'
--   4. delete_user RPC: canonical soft-delete with audit trail
-- ============================================================

-- ── 1. write_audit_log — missing 8-arg overload ─────────────────────────────
-- Root cause: migrations 00034 call write_audit_log with 8 args where arg-2 is
-- a uuid (target_user_id), not audit_action.  Neither existing overload matches.
-- Existing overloads:
--   A) (uuid, audit_action, jsonb, text, uuid, text, boolean, text)  — 8 args, arg2=audit_action
--   B) (uuid, audit_action, jsonb, text, uuid, text, text)           — 7 args, arg2=audit_action
-- Missing:
--   C) (uuid, uuid, audit_action, text, text, text, text, text)      — 8 args, arg2=uuid (target)
CREATE OR REPLACE FUNCTION write_audit_log(
  p_actor_id    uuid,
  p_target_id   uuid,
  p_action      audit_action,
  p_old_data    text    DEFAULT NULL,
  p_new_data    text    DEFAULT NULL,
  p_extra1      text    DEFAULT NULL,
  p_extra2      text    DEFAULT NULL,
  p_extra3      text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_logs (
    user_id, actor_id, action, details,
    resource_type, resource_id,
    ip_address, success, reason
  )
  VALUES (
    p_target_id,
    p_actor_id,
    p_action,
    jsonb_build_object(
      'old_data',  p_old_data,
      'new_data',  p_new_data,
      'extra',     p_extra1
    ),
    NULL,               -- resource_type
    p_target_id,        -- resource_id = target
    p_extra1,           -- ip_address (if provided)
    true,               -- success
    p_extra3            -- reason
  );
END;
$$;

GRANT EXECUTE ON FUNCTION write_audit_log(uuid, uuid, audit_action, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION write_audit_log(uuid, uuid, audit_action, text, text, text, text, text) TO service_role;

-- ── 2. user_status enum: add 'deleted' ──────────────────────────────────────
DO $$ BEGIN
  ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'deleted';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. audit_action enum: add 'user_deleted' ────────────────────────────────
DO $$ BEGIN
  ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'user_deleted';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. Canonical delete_user RPC ─────────────────────────────────────────────
-- Soft-deletes any user: sets status='deleted', writes audit trail.
-- Only admins / super_admins may call this.
-- The caller's auth token is validated via auth.uid(); Edge Functions
-- must pass p_actor_id when using service role (auth.uid()=NULL).
CREATE OR REPLACE FUNCTION delete_user(
  p_target_user_id uuid,
  p_actor_id       uuid  DEFAULT NULL,
  p_reason         text  DEFAULT 'Admin deleted'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid  := COALESCE(p_actor_id, auth.uid());
  v_role  text;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
  END IF;

  -- Only admin / super_admin may delete
  IF NOT is_admin_or_super_admin() AND
     NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND role IN ('admin','super_admin')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
  END IF;

  -- Prevent self-deletion
  IF p_target_user_id = v_actor THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot delete your own account');
  END IF;

  -- Get target role (for audit)
  SELECT role INTO v_role FROM profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found');
  END IF;

  -- Soft-delete
  UPDATE profiles
  SET status = 'deleted', updated_at = now()
  WHERE id = p_target_user_id;

  -- Revoke all active devices
  UPDATE devices
  SET status = 'logged_out', last_active_at = now()
  WHERE user_id = p_target_user_id AND status NOT IN ('logged_out','blocked');

  -- Audit trail
  INSERT INTO audit_logs (user_id, actor_id, action, details, resource_type, resource_id)
  VALUES (
    v_actor, v_actor, 'user_deleted',
    jsonb_build_object(
      'target_user_id', p_target_user_id,
      'target_role',    v_role,
      'reason',         p_reason
    ),
    'user', p_target_user_id
  );

  RETURN jsonb_build_object('success', true, 'deleted_user_id', p_target_user_id);
END;
$$;

GRANT EXECUTE ON FUNCTION delete_user(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_user(uuid, uuid, text) TO service_role;

-- ── 5. Verify new write_audit_log overload can be resolved ──────────────────
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt
  FROM pg_proc
  WHERE proname = 'write_audit_log';
  RAISE NOTICE 'write_audit_log overload count after fix: %', cnt;
  IF cnt < 3 THEN
    RAISE EXCEPTION 'Expected at least 3 write_audit_log overloads, found %', cnt;
  END IF;
END;
$$;

-- ── 6. Verify user_status has 'deleted' ──────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'user_status'::regtype AND enumlabel = 'deleted'
  ) THEN
    RAISE EXCEPTION 'user_status enum is missing "deleted" value';
  END IF;
  RAISE NOTICE 'user_status.deleted: OK';
END;
$$;
