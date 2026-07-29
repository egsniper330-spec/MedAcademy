
-- ============================================================
-- MedAcademy - Complete Database Schema
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================
CREATE TYPE user_role AS ENUM ('student', 'doctor', 'assistant', 'admin', 'super_admin');
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'pending');
CREATE TYPE course_status AS ENUM ('draft', 'published', 'hidden', 'archived');
CREATE TYPE lesson_status AS ENUM ('draft', 'published', 'hidden', 'scheduled');
CREATE TYPE activation_code_status AS ENUM ('active', 'used', 'expired', 'deactivated');
CREATE TYPE credit_transaction_type AS ENUM ('allocation', 'consumption', 'deduction', 'restoration');
CREATE TYPE notification_type AS ENUM ('info', 'course', 'system', 'security');
CREATE TYPE audit_action AS ENUM (
  'login', 'logout', 'register', 'password_reset',
  'course_created', 'course_updated', 'course_deleted',
  'lesson_created', 'lesson_updated', 'lesson_deleted',
  'video_uploaded', 'pdf_uploaded', 'pdf_deleted',
  'credit_allocated', 'credit_consumed', 'credit_deducted',
  'code_created', 'code_redeemed', 'code_deactivated',
  'device_reset', 'device_force_logout',
  'role_changed', 'permission_changed', 'user_suspended', 'user_activated',
  'enrollment_created', 'security_event'
);

-- ============================================================
-- PROFILES
-- ============================================================
CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text NOT NULL DEFAULT '',
  phone text,
  role user_role NOT NULL DEFAULT 'student',
  status user_status NOT NULL DEFAULT 'active',
  watermark_id text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(6), 'hex'),
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- DEVICES
-- ============================================================
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_fingerprint text NOT NULL,
  device_name text NOT NULL DEFAULT 'Unknown Device',
  platform text NOT NULL DEFAULT 'unknown',
  is_trusted boolean NOT NULL DEFAULT true,
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  -- Per-user device policy overrides
  allow_multiple boolean NOT NULL DEFAULT false,
  allow_unlimited boolean NOT NULL DEFAULT false,
  UNIQUE(user_id, device_fingerprint)
);

-- ============================================================
-- CATEGORIES
-- ============================================================
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- COURSES
-- ============================================================
CREATE TABLE courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  image_url text,
  status course_status NOT NULL DEFAULT 'draft',
  category_id uuid REFERENCES categories(id),
  total_lessons integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- SECTIONS
-- ============================================================
CREATE TABLE sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  order_index integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- LESSONS
-- ============================================================
CREATE TABLE lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  duration_seconds integer NOT NULL DEFAULT 0,
  video_id text,               -- VdoCipher video ID
  status lesson_status NOT NULL DEFAULT 'draft',
  order_index integer NOT NULL DEFAULT 0,
  scheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- LESSON PDFs
-- ============================================================
CREATE TABLE lesson_pdfs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_url text NOT NULL,
  file_size bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- ENROLLMENTS
-- ============================================================
CREATE TABLE enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  progress_percent integer NOT NULL DEFAULT 0,
  last_lesson_id uuid REFERENCES lessons(id),
  UNIQUE(student_id, course_id)
);

-- ============================================================
-- LESSON PROGRESS
-- ============================================================
CREATE TABLE lesson_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  watch_position_seconds integer NOT NULL DEFAULT 0,
  completed boolean NOT NULL DEFAULT false,
  last_watched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(student_id, lesson_id)
);

-- ============================================================
-- CREDITS
-- ============================================================
CREATE TABLE credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
  allocated integer NOT NULL DEFAULT 0,
  consumed integer NOT NULL DEFAULT 0,
  remaining integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- CREDIT TRANSACTIONS
-- ============================================================
CREATE TABLE credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  transaction_type credit_transaction_type NOT NULL,
  amount integer NOT NULL,
  course_id uuid REFERENCES courses(id),
  student_id uuid REFERENCES profiles(id),
  performed_by uuid NOT NULL REFERENCES profiles(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- ACTIVATION CODES
-- ============================================================
CREATE TABLE activation_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE DEFAULT upper(encode(gen_random_bytes(6), 'hex')),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status activation_code_status NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  used_by uuid REFERENCES profiles(id),
  used_at timestamptz,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  notification_type notification_type NOT NULL DEFAULT 'info',
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- AUDIT LOGS
-- ============================================================
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id),
  action audit_action NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- ASSISTANT PERMISSIONS
-- ============================================================
CREATE TABLE assistant_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  permission_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL REFERENCES profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(assistant_id, permission_key)
);

-- ============================================================
-- SYSTEM CONFIG
-- ============================================================
CREATE TABLE system_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  value jsonb NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_profiles_role ON profiles(role);
CREATE INDEX idx_profiles_status ON profiles(status);
CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_courses_doctor_id ON courses(doctor_id);
CREATE INDEX idx_courses_status ON courses(status);
CREATE INDEX idx_sections_course_id ON sections(course_id);
CREATE INDEX idx_lessons_course_id ON lessons(course_id);
CREATE INDEX idx_lessons_section_id ON lessons(section_id);
CREATE INDEX idx_lesson_pdfs_lesson_id ON lesson_pdfs(lesson_id);
CREATE INDEX idx_enrollments_student_id ON enrollments(student_id);
CREATE INDEX idx_enrollments_course_id ON enrollments(course_id);
CREATE INDEX idx_lesson_progress_student_id ON lesson_progress(student_id);
CREATE INDEX idx_credit_transactions_doctor_id ON credit_transactions(doctor_id);
CREATE INDEX idx_activation_codes_code ON activation_codes(code);
CREATE INDEX idx_activation_codes_course_id ON activation_codes(course_id);
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_assistant_permissions_assistant_id ON assistant_permissions(assistant_id);

-- ============================================================
-- SECURITY DEFINER HELPERS
-- ============================================================
CREATE OR REPLACE FUNCTION get_my_role()
RETURNS user_role
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION is_admin_or_super_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT role IN ('admin', 'super_admin') FROM profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION is_doctor_or_above()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT role IN ('doctor', 'admin', 'super_admin') FROM profiles WHERE id = auth.uid();
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_pdfs ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE activation_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;

-- PROFILES
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT TO authenticated USING (id = auth.uid() OR is_admin_or_super_admin());
CREATE POLICY "profiles_select_doctors" ON profiles FOR SELECT TO authenticated USING (role IN ('doctor', 'admin', 'super_admin'));
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY "profiles_admin_all" ON profiles FOR ALL TO authenticated USING (is_admin_or_super_admin());
CREATE POLICY "profiles_insert_self" ON profiles FOR INSERT TO authenticated WITH CHECK (id = auth.uid());

-- DEVICES
CREATE POLICY "devices_select_own" ON devices FOR SELECT TO authenticated USING (user_id = auth.uid() OR is_admin_or_super_admin());
CREATE POLICY "devices_insert_own" ON devices FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "devices_update_own" ON devices FOR UPDATE TO authenticated USING (user_id = auth.uid() OR is_admin_or_super_admin());
CREATE POLICY "devices_admin_all" ON devices FOR ALL TO authenticated USING (is_admin_or_super_admin());

-- CATEGORIES
CREATE POLICY "categories_select_all" ON categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "categories_admin_all" ON categories FOR ALL TO authenticated USING (is_admin_or_super_admin());

-- COURSES
CREATE POLICY "courses_select_published" ON courses FOR SELECT TO authenticated USING (
  status = 'published' OR doctor_id = auth.uid() OR is_admin_or_super_admin()
);
CREATE POLICY "courses_insert_doctor" ON courses FOR INSERT TO authenticated WITH CHECK (
  doctor_id = auth.uid() AND get_my_role() IN ('doctor', 'admin', 'super_admin')
);
CREATE POLICY "courses_update_own" ON courses FOR UPDATE TO authenticated USING (
  doctor_id = auth.uid() OR is_admin_or_super_admin()
);
CREATE POLICY "courses_delete_own" ON courses FOR DELETE TO authenticated USING (
  doctor_id = auth.uid() OR is_admin_or_super_admin()
);

-- SECTIONS
CREATE POLICY "sections_select" ON sections FOR SELECT TO authenticated USING (
  EXISTS(SELECT 1 FROM courses c WHERE c.id = course_id AND (c.status = 'published' OR c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
);
CREATE POLICY "sections_insert_doctor" ON sections FOR INSERT TO authenticated WITH CHECK (
  EXISTS(SELECT 1 FROM courses c WHERE c.id = course_id AND (c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
);
CREATE POLICY "sections_update_doctor" ON sections FOR UPDATE TO authenticated USING (
  EXISTS(SELECT 1 FROM courses c WHERE c.id = course_id AND (c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
);
CREATE POLICY "sections_delete_doctor" ON sections FOR DELETE TO authenticated USING (
  EXISTS(SELECT 1 FROM courses c WHERE c.id = course_id AND (c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
);

-- LESSONS
CREATE POLICY "lessons_select" ON lessons FOR SELECT TO authenticated USING (
  EXISTS(SELECT 1 FROM courses c WHERE c.id = course_id AND (c.status = 'published' OR c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
);
CREATE POLICY "lessons_insert_doctor" ON lessons FOR INSERT TO authenticated WITH CHECK (
  EXISTS(SELECT 1 FROM courses c WHERE c.id = course_id AND (c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
);
CREATE POLICY "lessons_update_doctor" ON lessons FOR UPDATE TO authenticated USING (
  EXISTS(SELECT 1 FROM courses c WHERE c.id = course_id AND (c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
);
CREATE POLICY "lessons_delete_doctor" ON lessons FOR DELETE TO authenticated USING (
  EXISTS(SELECT 1 FROM courses c WHERE c.id = course_id AND (c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
);

-- LESSON PDFS
CREATE POLICY "lesson_pdfs_select" ON lesson_pdfs FOR SELECT TO authenticated USING (
  EXISTS(SELECT 1 FROM lessons l JOIN courses c ON c.id = l.course_id WHERE l.id = lesson_id AND (c.status = 'published' OR c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
);
CREATE POLICY "lesson_pdfs_insert_doctor" ON lesson_pdfs FOR INSERT TO authenticated WITH CHECK (
  EXISTS(SELECT 1 FROM lessons l JOIN courses c ON c.id = l.course_id WHERE l.id = lesson_id AND (c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
);
CREATE POLICY "lesson_pdfs_delete_doctor" ON lesson_pdfs FOR DELETE TO authenticated USING (
  EXISTS(SELECT 1 FROM lessons l JOIN courses c ON c.id = l.course_id WHERE l.id = lesson_id AND (c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
);

-- ENROLLMENTS
CREATE POLICY "enrollments_select_own" ON enrollments FOR SELECT TO authenticated USING (
  student_id = auth.uid() OR is_doctor_or_above()
);
CREATE POLICY "enrollments_insert_admin" ON enrollments FOR INSERT TO authenticated WITH CHECK (
  is_admin_or_super_admin() OR student_id = auth.uid()
);
CREATE POLICY "enrollments_update" ON enrollments FOR UPDATE TO authenticated USING (
  student_id = auth.uid() OR is_admin_or_super_admin()
);

-- LESSON PROGRESS
CREATE POLICY "lesson_progress_select_own" ON lesson_progress FOR SELECT TO authenticated USING (
  student_id = auth.uid() OR is_doctor_or_above()
);
CREATE POLICY "lesson_progress_insert_own" ON lesson_progress FOR INSERT TO authenticated WITH CHECK (student_id = auth.uid());
CREATE POLICY "lesson_progress_update_own" ON lesson_progress FOR UPDATE TO authenticated USING (student_id = auth.uid());
CREATE POLICY "lesson_progress_upsert_own" ON lesson_progress FOR UPDATE TO authenticated USING (student_id = auth.uid()) WITH CHECK (student_id = auth.uid());

-- CREDITS
CREATE POLICY "credits_select_own" ON credits FOR SELECT TO authenticated USING (
  doctor_id = auth.uid() OR is_admin_or_super_admin()
);
CREATE POLICY "credits_admin_all" ON credits FOR ALL TO authenticated USING (is_admin_or_super_admin());

-- CREDIT TRANSACTIONS
CREATE POLICY "credit_transactions_select" ON credit_transactions FOR SELECT TO authenticated USING (
  doctor_id = auth.uid() OR is_admin_or_super_admin()
);
CREATE POLICY "credit_transactions_insert_admin" ON credit_transactions FOR INSERT TO authenticated WITH CHECK (is_admin_or_super_admin());

-- ACTIVATION CODES
CREATE POLICY "activation_codes_select_admin" ON activation_codes FOR SELECT TO authenticated USING (is_admin_or_super_admin());
CREATE POLICY "activation_codes_insert_admin" ON activation_codes FOR INSERT TO authenticated WITH CHECK (is_admin_or_super_admin());
CREATE POLICY "activation_codes_update_admin" ON activation_codes FOR UPDATE TO authenticated USING (is_admin_or_super_admin());
CREATE POLICY "activation_codes_delete_admin" ON activation_codes FOR DELETE TO authenticated USING (is_admin_or_super_admin());

-- NOTIFICATIONS
CREATE POLICY "notifications_select_own" ON notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "notifications_update_own" ON notifications FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "notifications_delete_own" ON notifications FOR DELETE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "notifications_insert_admin" ON notifications FOR INSERT TO authenticated WITH CHECK (is_admin_or_super_admin());

-- AUDIT LOGS
CREATE POLICY "audit_logs_select_admin" ON audit_logs FOR SELECT TO authenticated USING (is_admin_or_super_admin());
CREATE POLICY "audit_logs_insert_all" ON audit_logs FOR INSERT TO authenticated WITH CHECK (true);

-- ASSISTANT PERMISSIONS
CREATE POLICY "assistant_permissions_select" ON assistant_permissions FOR SELECT TO authenticated USING (
  assistant_id = auth.uid() OR is_admin_or_super_admin()
);
CREATE POLICY "assistant_permissions_all_admin" ON assistant_permissions FOR ALL TO authenticated USING (is_admin_or_super_admin());

-- SYSTEM CONFIG
CREATE POLICY "system_config_select_admin" ON system_config FOR SELECT TO authenticated USING (is_admin_or_super_admin());
CREATE POLICY "system_config_all_super_admin" ON system_config FOR ALL TO authenticated USING (get_my_role() = 'super_admin');

-- ============================================================
-- TRIGGER: Auto-create profile on sign-up
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'student')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- TRIGGER: Auto-create credits record for doctors
-- ============================================================
CREATE OR REPLACE FUNCTION handle_doctor_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.role = 'doctor' AND (OLD IS NULL OR OLD.role != 'doctor') THEN
    INSERT INTO credits (doctor_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_doctor_profile_created
  AFTER INSERT OR UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION handle_doctor_credits();

-- ============================================================
-- TRIGGER: Update course lesson count
-- ============================================================
CREATE OR REPLACE FUNCTION update_course_lesson_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE courses SET total_lessons = total_lessons + 1 WHERE id = NEW.course_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE courses SET total_lessons = GREATEST(total_lessons - 1, 0) WHERE id = OLD.course_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER lessons_count_trigger
  AFTER INSERT OR DELETE ON lessons
  FOR EACH ROW EXECUTE FUNCTION update_course_lesson_count();

-- ============================================================
-- FUNCTION: Redeem activation code
-- ============================================================
CREATE OR REPLACE FUNCTION redeem_activation_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code activation_codes;
  v_student_id uuid := auth.uid();
BEGIN
  -- Fetch code
  SELECT * INTO v_code FROM activation_codes WHERE code = p_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code not found');
  END IF;
  IF v_code.status != 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code is not active');
  END IF;
  IF v_code.expires_at IS NOT NULL AND v_code.expires_at < now() THEN
    UPDATE activation_codes SET status = 'expired' WHERE id = v_code.id;
    RETURN jsonb_build_object('success', false, 'error', 'Code has expired');
  END IF;
  -- Check already enrolled
  IF EXISTS(SELECT 1 FROM enrollments WHERE student_id = v_student_id AND course_id = v_code.course_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Already enrolled in this course');
  END IF;
  -- Enroll student
  INSERT INTO enrollments (student_id, course_id) VALUES (v_student_id, v_code.course_id);
  -- Mark code used
  UPDATE activation_codes SET status = 'used', used_by = v_student_id, used_at = now() WHERE id = v_code.id;
  -- Audit log
  INSERT INTO audit_logs (user_id, action, details) VALUES (v_student_id, 'code_redeemed', jsonb_build_object('code', p_code, 'course_id', v_code.course_id));
  RETURN jsonb_build_object('success', true, 'course_id', v_code.course_id);
END;
$$;

-- ============================================================
-- FUNCTION: Grant course access (doctor consumes credit)
-- ============================================================
CREATE OR REPLACE FUNCTION grant_course_access(p_student_id uuid, p_course_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_doctor_id uuid := auth.uid();
  v_credits credits;
BEGIN
  -- Verify caller is the course doctor
  IF NOT EXISTS(SELECT 1 FROM courses WHERE id = p_course_id AND doctor_id = v_doctor_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized for this course');
  END IF;
  -- Check credits
  SELECT * INTO v_credits FROM credits WHERE doctor_id = v_doctor_id;
  IF v_credits.remaining < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient credits');
  END IF;
  -- Check already enrolled
  IF EXISTS(SELECT 1 FROM enrollments WHERE student_id = p_student_id AND course_id = p_course_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Student already enrolled');
  END IF;
  -- Enroll
  INSERT INTO enrollments (student_id, course_id) VALUES (p_student_id, p_course_id);
  -- Consume credit
  UPDATE credits SET consumed = consumed + 1, remaining = remaining - 1, updated_at = now() WHERE doctor_id = v_doctor_id;
  -- Transaction log
  INSERT INTO credit_transactions (doctor_id, transaction_type, amount, course_id, student_id, performed_by)
  VALUES (v_doctor_id, 'consumption', 1, p_course_id, p_student_id, v_doctor_id);
  -- Audit log
  INSERT INTO audit_logs (user_id, action, details)
  VALUES (v_doctor_id, 'credit_consumed', jsonb_build_object('student_id', p_student_id, 'course_id', p_course_id));
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ============================================================
-- FUNCTION: Admin allocate credits
-- ============================================================
CREATE OR REPLACE FUNCTION allocate_credits(p_doctor_id uuid, p_amount integer, p_notes text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
BEGIN
  IF NOT is_admin_or_super_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
  END IF;
  INSERT INTO credits (doctor_id, allocated, remaining) VALUES (p_doctor_id, p_amount, p_amount)
  ON CONFLICT (doctor_id) DO UPDATE SET
    allocated = credits.allocated + p_amount,
    remaining = credits.remaining + p_amount,
    updated_at = now();
  INSERT INTO credit_transactions (doctor_id, transaction_type, amount, performed_by, notes)
  VALUES (p_doctor_id, 'allocation', p_amount, v_admin_id, p_notes);
  INSERT INTO audit_logs (user_id, action, details)
  VALUES (v_admin_id, 'credit_allocated', jsonb_build_object('doctor_id', p_doctor_id, 'amount', p_amount));
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ============================================================
-- SEED DATA: Categories
-- ============================================================
INSERT INTO categories (name) VALUES
  ('Anatomy'), ('Physiology'), ('Pharmacology'), ('Pathology'),
  ('Internal Medicine'), ('Surgery'), ('Pediatrics'), ('Obstetrics & Gynecology'),
  ('Psychiatry'), ('Radiology'), ('Emergency Medicine'), ('Cardiology');

-- ============================================================
-- SEED DATA: System Config
-- ============================================================
INSERT INTO system_config (key, value) VALUES
  ('app_name', '"MedAcademy"'),
  ('maintenance_mode', 'false'),
  ('security_policy', '{"block_root": true, "block_emulator": true, "block_vpn": false}'),
  ('video_provider', '"vdocipher"');
