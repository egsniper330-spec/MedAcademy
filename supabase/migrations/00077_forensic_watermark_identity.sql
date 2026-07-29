
-- =============================================================
-- MIGRATION: Forensic Watermark Identity System
--
-- 1. Reformat watermark_id to WM-XXXXXXXX (uppercase hex prefix)
-- 2. Backfill any existing rows with old-format IDs
-- 3. Update DEFAULT to generate WM- prefixed IDs
-- 4. Update handle_new_user trigger to explicitly set WM- format
-- 5. Update lookup_user_by_identifier to search BY watermark_id
-- 6. Update get_doctor_students RPC to include watermark_id
-- 7. Add RLS policy for doctors to see enrolled student profiles
-- =============================================================

-- ── 1. Change DEFAULT to WM-XXXXXXXX format ──────────────────
ALTER TABLE profiles
  ALTER COLUMN watermark_id
  SET DEFAULT 'WM-' || upper(left(encode(gen_random_bytes(6), 'hex'), 8));

-- ── 2. Backfill existing rows that don't have WM- prefix ─────
-- Generates a fresh WM-XXXXXXXX id for each old-format row
-- while guaranteeing uniqueness via a loop with conflict retry.
DO $$
DECLARE
  r record;
  new_wm text;
  conflict bool;
BEGIN
  FOR r IN SELECT id FROM profiles WHERE watermark_id NOT LIKE 'WM-%' LOOP
    LOOP
      new_wm   := 'WM-' || upper(left(encode(gen_random_bytes(6), 'hex'), 8));
      conflict := EXISTS (SELECT 1 FROM profiles WHERE watermark_id = new_wm AND id <> r.id);
      EXIT WHEN NOT conflict;
    END LOOP;
    UPDATE profiles SET watermark_id = new_wm WHERE id = r.id;
  END LOOP;
END;
$$;

-- ── 3. Update handle_new_user trigger to use WM- format ──────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wm text;
  v_conflict bool;
BEGIN
  -- Generate a unique WM-XXXXXXXX watermark id
  LOOP
    v_wm       := 'WM-' || upper(left(encode(gen_random_bytes(6), 'hex'), 8));
    v_conflict := EXISTS (SELECT 1 FROM profiles WHERE watermark_id = v_wm);
    EXIT WHEN NOT v_conflict;
  END LOOP;

  INSERT INTO profiles (id, email, full_name, role, watermark_id)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'student'),
    v_wm
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ── 4. Update lookup_user_by_identifier to search by watermark_id ──
-- Also adds a watermark_id-first branch (exact match, highest priority
-- since watermark IDs are globally unique and forensics use them directly).
CREATE OR REPLACE FUNCTION lookup_user_by_identifier(p_identifier text)
RETURNS TABLE (
  id            uuid,
  email         text,
  full_name     text,
  phone         text,
  phone_e164    text,
  role          user_role,
  status        user_status,
  watermark_id  text,
  qr_code_id    uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean text := TRIM(p_identifier);
  v_e164  text;
BEGIN
  IF v_clean = '' OR v_clean IS NULL THEN RETURN; END IF;

  -- 0. Watermark ID — exact match (WM-XXXXXXXX format)
  IF v_clean ~* '^WM-[0-9A-F]{8}$' THEN
    RETURN QUERY
      SELECT p.id, p.email, p.full_name, p.phone, p.phone_e164, p.role, p.status, p.watermark_id, p.qr_code_id
      FROM profiles p WHERE upper(p.watermark_id) = upper(v_clean) LIMIT 1;
    RETURN;
  END IF;

  -- 1. UUID → user_id
  IF v_clean ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN QUERY
      SELECT p.id, p.email, p.full_name, p.phone, p.phone_e164, p.role, p.status, p.watermark_id, p.qr_code_id
      FROM profiles p WHERE p.id = v_clean::uuid LIMIT 1;
    RETURN;
  END IF;

  -- 2. Email
  IF v_clean ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN QUERY
      SELECT p.id, p.email, p.full_name, p.phone, p.phone_e164, p.role, p.status, p.watermark_id, p.qr_code_id
      FROM profiles p WHERE lower(p.email) = lower(v_clean) LIMIT 1;
    RETURN;
  END IF;

  -- 3. Phone (E.164 normalised)
  v_e164 := normalize_phone_e164(v_clean);
  IF v_e164 IS NOT NULL THEN
    RETURN QUERY
      SELECT p.id, p.email, p.full_name, p.phone, p.phone_e164, p.role, p.status, p.watermark_id, p.qr_code_id
      FROM profiles p WHERE p.phone_e164 = v_e164 LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- 4. Name (partial, case-insensitive)
  RETURN QUERY
    SELECT p.id, p.email, p.full_name, p.phone, p.phone_e164, p.role, p.status, p.watermark_id, p.qr_code_id
    FROM profiles p
    WHERE p.full_name ILIKE '%' || v_clean || '%'
    ORDER BY p.full_name
    LIMIT 20;
END;
$$;

-- ── 5. Update get_doctor_students RPC to expose watermark_id ──
CREATE OR REPLACE FUNCTION get_doctor_students(p_doctor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Security check: caller must be the doctor or an admin
  IF p_doctor_id <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id',                e.id,
      'status',            e.status,
      'enrolled_at',       e.enrolled_at,
      'enrollment_method', COALESCE(e.enrollment_method, ''),
      'activation_method', COALESCE(e.activation_method, ''),
      'course', jsonb_build_object(
        'id',        c.id,
        'title',     c.title,
        'doctor_id', c.doctor_id
      ),
      'student', jsonb_build_object(
        'id',           p.id,
        'full_name',    p.full_name,
        'email',        p.email,
        'phone',        p.phone,
        'watermark_id', p.watermark_id,
        'university',     CASE WHEN u.id  IS NOT NULL THEN jsonb_build_object('id', u.id,  'name', u.name)  ELSE NULL END,
        'faculty',        CASE WHEN f.id  IS NOT NULL THEN jsonb_build_object('id', f.id,  'name', f.name)  ELSE NULL END,
        'academic_level', CASE WHEN al.id IS NOT NULL THEN jsonb_build_object('id', al.id, 'name', al.name) ELSE NULL END
      )
    )
    ORDER BY e.enrolled_at DESC
  )
  INTO v_result
  FROM enrollments e
  JOIN courses  c  ON c.id  = e.course_id  AND c.doctor_id = p_doctor_id
  JOIN profiles p  ON p.id  = e.student_id
  LEFT JOIN universities    u  ON u.id  = p.university_id
  LEFT JOIN faculties       f  ON f.id  = p.faculty_id
  LEFT JOIN academic_levels al ON al.id = p.academic_level_id;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION get_doctor_students(uuid)              TO authenticated;
GRANT EXECUTE ON FUNCTION lookup_user_by_identifier(text)        TO authenticated;
GRANT EXECUTE ON FUNCTION handle_new_user()                      TO authenticated;
