
-- 1. Add doctor_id to profiles (links assistants to their doctor)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS doctor_id UUID REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_doctor_id ON profiles(doctor_id);

-- 2. Add created_by to courses
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_courses_created_by ON courses(created_by);

-- 3. Expand assistant_permissions with granular permission columns
ALTER TABLE assistant_permissions
  ADD COLUMN IF NOT EXISTS can_create_courses BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_edit_own_courses BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_delete_own_courses BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_create_sections BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_edit_sections BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_delete_sections BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_create_lessons BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_edit_lessons BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_delete_lessons BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_reorder_lessons BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_upload_videos BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_replace_videos BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_delete_videos BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_upload_pdfs BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_replace_pdfs BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_delete_pdfs BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_publish_lessons BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_schedule_publishing BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_hide_lessons BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_manage_course_content BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_view_students BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_view_student_progress BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_reply_to_students BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_send_announcements BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_manage_comments BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_view_reports BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS granted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 4. Unique constraint on assistant_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_permissions_assistant_id_key'
  ) THEN
    ALTER TABLE assistant_permissions ADD CONSTRAINT assistant_permissions_assistant_id_key UNIQUE (assistant_id);
  END IF;
END $$;

-- 5. promote_to_assistant: doctor promotes a student
CREATE OR REPLACE FUNCTION promote_to_assistant(
  p_student_id UUID,
  p_doctor_id UUID,
  p_granted_by UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
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
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, new_value)
  VALUES (p_granted_by, 'role_promoted', 'profile', p_student_id,
    jsonb_build_object('role', 'assistant', 'doctor_id', p_doctor_id));
END;
$$;

-- 6. revoke_assistant: revoke assistant role back to student
CREATE OR REPLACE FUNCTION revoke_assistant(
  p_assistant_id UUID,
  p_revoked_by UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_assistant_id AND role = 'assistant') THEN
    RAISE EXCEPTION 'User is not an assistant';
  END IF;
  UPDATE profiles SET role = 'student', doctor_id = NULL WHERE id = p_assistant_id;
  DELETE FROM assistant_permissions WHERE assistant_id = p_assistant_id;
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, new_value)
  VALUES (p_revoked_by, 'role_revoked', 'profile', p_assistant_id, '{"role":"student"}'::jsonb);
END;
$$;

-- 7. promote_to_doctor: admin promotes student to doctor
CREATE OR REPLACE FUNCTION promote_to_doctor(
  p_user_id UUID,
  p_promoted_by UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_promoter_role TEXT;
BEGIN
  SELECT role INTO v_promoter_role FROM profiles WHERE id = p_promoted_by;
  IF v_promoter_role NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'Only admin or super_admin can promote to doctor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id AND role = 'student') THEN
    RAISE EXCEPTION 'User is not a student';
  END IF;
  UPDATE profiles SET role = 'doctor' WHERE id = p_user_id;
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, new_value)
  VALUES (p_promoted_by, 'role_promoted', 'profile', p_user_id, '{"role":"doctor"}'::jsonb);
END;
$$;

-- 8. demote_doctor: admin demotes doctor back to student; cascades assistants
CREATE OR REPLACE FUNCTION demote_doctor(
  p_doctor_id UUID,
  p_demoted_by UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_demoter_role TEXT;
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
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, new_value)
  VALUES (p_demoted_by, 'role_demoted', 'profile', p_doctor_id, '{"role":"student"}'::jsonb);
END;
$$;

-- 9. transfer_assistant: admin transfers assistant to another doctor
CREATE OR REPLACE FUNCTION transfer_assistant(
  p_assistant_id UUID,
  p_new_doctor_id UUID,
  p_transferred_by UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_assistant_id AND role = 'assistant') THEN
    RAISE EXCEPTION 'User is not an assistant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_new_doctor_id AND role = 'doctor') THEN
    RAISE EXCEPTION 'Target is not a doctor';
  END IF;
  UPDATE profiles SET doctor_id = p_new_doctor_id WHERE id = p_assistant_id;
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, new_value)
  VALUES (p_transferred_by, 'assistant_transferred', 'profile', p_assistant_id,
    jsonb_build_object('new_doctor_id', p_new_doctor_id));
END;
$$;
