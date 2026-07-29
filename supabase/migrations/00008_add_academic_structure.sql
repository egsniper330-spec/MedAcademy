-- ── 1. Universities ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS universities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Faculties ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS faculties (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id  uuid NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  name           text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Academic Levels ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS academic_levels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id     uuid NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  name           text NOT NULL,
  display_order  int NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── 4. Add academic fields to profiles ───────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS university_id       uuid REFERENCES universities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS faculty_id          uuid REFERENCES faculties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS academic_level_id   uuid REFERENCES academic_levels(id) ON DELETE SET NULL;

-- ── 5. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_faculties_university    ON faculties(university_id);
CREATE INDEX IF NOT EXISTS idx_academic_levels_faculty ON academic_levels(faculty_id);
CREATE INDEX IF NOT EXISTS idx_profiles_university     ON profiles(university_id);
CREATE INDEX IF NOT EXISTS idx_profiles_faculty        ON profiles(faculty_id);

-- ── 6. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE universities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE faculties       ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_levels ENABLE ROW LEVEL SECURITY;

-- Public read (any authenticated user may read for sign-up dropdowns)
CREATE POLICY "universities_read"    ON universities    FOR SELECT TO authenticated USING (true);
CREATE POLICY "faculties_read"       ON faculties       FOR SELECT TO authenticated USING (true);
CREATE POLICY "academic_levels_read" ON academic_levels FOR SELECT TO authenticated USING (true);

-- Admin/SuperAdmin write — use a helper to avoid referencing auth schema directly
CREATE OR REPLACE FUNCTION is_admin_or_superadmin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT role IN ('admin','super_admin')
  FROM profiles WHERE id = auth.uid()
$$;

CREATE POLICY "universities_admin_write"
  ON universities FOR ALL TO authenticated
  USING (is_admin_or_superadmin())
  WITH CHECK (is_admin_or_superadmin());

CREATE POLICY "faculties_admin_write"
  ON faculties FOR ALL TO authenticated
  USING (is_admin_or_superadmin())
  WITH CHECK (is_admin_or_superadmin());

CREATE POLICY "academic_levels_admin_write"
  ON academic_levels FOR ALL TO authenticated
  USING (is_admin_or_superadmin())
  WITH CHECK (is_admin_or_superadmin());

-- ── 7. Auto-create 5 default levels when a faculty is inserted ───────────────
CREATE OR REPLACE FUNCTION create_default_academic_levels()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO academic_levels (faculty_id, name, display_order) VALUES
    (NEW.id, 'Level One',   1),
    (NEW.id, 'Level Two',   2),
    (NEW.id, 'Level Three', 3),
    (NEW.id, 'Level Four',  4),
    (NEW.id, 'Level Five',  5);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_default_levels ON faculties;
CREATE TRIGGER trg_default_levels
  AFTER INSERT ON faculties
  FOR EACH ROW EXECUTE FUNCTION create_default_academic_levels();