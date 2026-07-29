
-- ══════════════════════════════════════════════════════════════════════
-- ROOT CAUSE FIX: migration 00003 stored procedures used `new_value`
-- (non-existent column) and wrong audit_action enum values.
--
-- Actual audit_logs columns: id, user_id, actor_id, action, details,
--   ip_address, resource_type, resource_id, success, reason, created_at
-- Actual enum values: role_changed, permission_changed (no role_promoted/demoted)
--
-- Fix: replace `new_value` → `details`, align enum values → `role_changed`
-- ══════════════════════════════════════════════════════════════════════

-- Add user_created / admin_created enum values for new create-user flow
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'user_created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'admin_created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'super_admin_created';

-- 1. promote_to_doctor
CREATE OR REPLACE FUNCTION promote_to_doctor(
  p_user_id     UUID,
  p_promoted_by UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_promoter_role TEXT;
BEGIN
  SELECT role INTO v_promoter_role FROM profiles WHERE id = p_promoted_by;
  IF v_promoter_role NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'Only admin or super_admin can promote to doctor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id AND role = 'student') THEN
    RAISE EXCEPTION 'User is not a student';
  END IF;
  UPDATE profiles SET role = 'doctor' WHERE id = p_user_id;
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
  VALUES (p_promoted_by, 'role_changed', 'profile', p_user_id,
    '{"old_role":"student","new_role":"doctor"}'::jsonb);
END;
$$;

-- 2. demote_doctor
CREATE OR REPLACE FUNCTION demote_doctor(
  p_doctor_id  UUID,
  p_demoted_by UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_demoter_role TEXT;
BEGIN
  SELECT role INTO v_demoter_role FROM profiles WHERE id = p_demoted_by;
  IF v_demoter_role NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'Only admin or super_admin can demote a doctor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_doctor_id AND role = 'doctor') THEN
    RAISE EXCEPTION 'User is not a doctor';
  END IF;
  -- Convert all linked assistants back to students
  UPDATE profiles SET role = 'student', doctor_id = NULL
  WHERE doctor_id = p_doctor_id AND role = 'assistant';
  DELETE FROM assistant_permissions ap
  USING profiles p WHERE ap.assistant_id = p.id AND p.doctor_id = p_doctor_id;
  -- Demote doctor
  UPDATE profiles SET role = 'student' WHERE id = p_doctor_id;
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
  VALUES (p_demoted_by, 'role_changed', 'profile', p_doctor_id,
    '{"old_role":"doctor","new_role":"student"}'::jsonb);
END;
$$;

-- 3. promote_to_assistant (grant_assistant alias)
CREATE OR REPLACE FUNCTION promote_to_assistant(
  p_student_id UUID,
  p_doctor_id  UUID,
  p_granted_by UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_doctor_id AND role = 'doctor') THEN
    RAISE EXCEPTION 'Target doctor not found or does not have doctor role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_student_id AND role = 'student') THEN
    RAISE EXCEPTION 'Target user is not a student';
  END IF;
  UPDATE profiles SET role = 'assistant', doctor_id = p_doctor_id WHERE id = p_student_id;
  INSERT INTO assistant_permissions (assistant_id, granted_by)
  VALUES (p_student_id, p_granted_by)
  ON CONFLICT (assistant_id) DO UPDATE SET granted_by = p_granted_by, updated_at = NOW();
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
  VALUES (p_granted_by, 'role_changed', 'profile', p_student_id,
    jsonb_build_object('old_role','student','new_role','assistant','doctor_id',p_doctor_id));
END;
$$;

-- 4. revoke_assistant
CREATE OR REPLACE FUNCTION revoke_assistant(
  p_assistant_id UUID,
  p_revoked_by   UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_assistant_id AND role = 'assistant') THEN
    RAISE EXCEPTION 'User is not an assistant';
  END IF;
  UPDATE profiles SET role = 'student', doctor_id = NULL WHERE id = p_assistant_id;
  DELETE FROM assistant_permissions WHERE assistant_id = p_assistant_id;
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
  VALUES (p_revoked_by, 'role_changed', 'profile', p_assistant_id,
    '{"old_role":"assistant","new_role":"student"}'::jsonb);
END;
$$;

-- 5. transfer_assistant
CREATE OR REPLACE FUNCTION transfer_assistant(
  p_assistant_id   UUID,
  p_new_doctor_id  UUID,
  p_transferred_by UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_assistant_id AND role = 'assistant') THEN
    RAISE EXCEPTION 'User is not an assistant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_new_doctor_id AND role = 'doctor') THEN
    RAISE EXCEPTION 'Target is not a doctor';
  END IF;
  UPDATE profiles SET doctor_id = p_new_doctor_id WHERE id = p_assistant_id;
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, details)
  VALUES (p_transferred_by, 'role_changed', 'profile', p_assistant_id,
    jsonb_build_object('action','assistant_transferred','new_doctor_id',p_new_doctor_id));
END;
$$;
