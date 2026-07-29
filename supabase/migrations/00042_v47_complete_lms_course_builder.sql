
-- ============================================================
-- Migration 00042 — v47 Complete LMS Course Builder
-- Extends: courses, sections, lessons
-- Creates: lesson_materials, storage bucket
-- ============================================================

-- ── 1. ENUM: video type ────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE video_type AS ENUM ('vdocipher', 'external', 'youtube', 'coming_soon');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE difficulty_level AS ENUM ('beginner', 'intermediate', 'advanced', 'all_levels');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. EXTEND courses ─────────────────────────────────────────────────────────
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS short_description      text,
  ADD COLUMN IF NOT EXISTS full_description       text,
  ADD COLUMN IF NOT EXISTS thumbnail_url          text,
  ADD COLUMN IF NOT EXISTS cover_url              text,
  ADD COLUMN IF NOT EXISTS language               text NOT NULL DEFAULT 'Arabic',
  ADD COLUMN IF NOT EXISTS difficulty             difficulty_level NOT NULL DEFAULT 'all_levels',
  ADD COLUMN IF NOT EXISTS tags                   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS estimated_duration_hours numeric(6,1),
  ADD COLUMN IF NOT EXISTS instructor_name        text,
  ADD COLUMN IF NOT EXISTS university_id          uuid REFERENCES universities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS faculty_id             uuid REFERENCES faculties(id)    ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS academic_level_id      uuid REFERENCES academic_levels(id) ON DELETE SET NULL,
  -- Settings
  ADD COLUMN IF NOT EXISTS sequential_learning    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS free_preview           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS certificate_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS subscription_required  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS credits_required       integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS activation_code_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS total_sections         integer NOT NULL DEFAULT 0;

-- Rename image_url → thumbnail_url data migration (keep image_url as alias if exists)
UPDATE courses SET thumbnail_url = image_url WHERE thumbnail_url IS NULL AND image_url IS NOT NULL;

-- ── 3. EXTEND sections ────────────────────────────────────────────────────────
ALTER TABLE sections
  ADD COLUMN IF NOT EXISTS description  text,
  ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();

-- ── 4. EXTEND lessons ─────────────────────────────────────────────────────────
ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS video_type         video_type NOT NULL DEFAULT 'vdocipher',
  ADD COLUMN IF NOT EXISTS video_title        text,
  ADD COLUMN IF NOT EXISTS video_playback_id  text,
  ADD COLUMN IF NOT EXISTS video_thumbnail    text,
  ADD COLUMN IF NOT EXISTS video_duration_seconds integer,
  ADD COLUMN IF NOT EXISTS external_url       text,
  ADD COLUMN IF NOT EXISTS content_html       text,
  ADD COLUMN IF NOT EXISTS is_preview         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS download_enabled   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS comments_enabled   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS visible            boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notes              text;

-- ── 5. CREATE lesson_materials ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lesson_materials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id     uuid NOT NULL REFERENCES lessons(id)  ON DELETE CASCADE,
  course_id     uuid NOT NULL REFERENCES courses(id)  ON DELETE CASCADE,
  uploaded_by   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  file_name     text NOT NULL,
  file_url      text NOT NULL,
  storage_path  text NOT NULL,
  file_type     text NOT NULL DEFAULT 'application/octet-stream',
  file_size     bigint NOT NULL DEFAULT 0,
  download_enabled boolean NOT NULL DEFAULT true,
  preview_enabled  boolean NOT NULL DEFAULT true,
  order_index   integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lesson_materials_lesson  ON lesson_materials(lesson_id);
CREATE INDEX IF NOT EXISTS idx_lesson_materials_course  ON lesson_materials(course_id);
ALTER TABLE lesson_materials ENABLE ROW LEVEL SECURITY;

-- RLS: lesson_materials
DROP POLICY IF EXISTS "lm_select_enrolled_or_owner" ON lesson_materials;
CREATE POLICY "lm_select_enrolled_or_owner" ON lesson_materials
  FOR SELECT TO authenticated USING (
    -- Doctor who owns the course
    EXISTS (SELECT 1 FROM courses c WHERE c.id = course_id AND c.doctor_id = auth.uid())
    -- Admin
    OR is_admin_or_super_admin()
    -- Enrolled student (or lesson is marked as preview)
    OR EXISTS (
      SELECT 1 FROM lessons l
      WHERE l.id = lesson_id AND (
        l.is_preview = true
        OR EXISTS (
          SELECT 1 FROM enrollments e
          WHERE e.course_id = lesson_materials.course_id AND e.student_id = auth.uid()
        )
      )
    )
  );

DROP POLICY IF EXISTS "lm_insert_doctor" ON lesson_materials;
CREATE POLICY "lm_insert_doctor" ON lesson_materials
  FOR INSERT TO authenticated WITH CHECK (
    uploaded_by = auth.uid()
    AND EXISTS (SELECT 1 FROM courses c WHERE c.id = course_id AND (c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
  );

DROP POLICY IF EXISTS "lm_update_doctor" ON lesson_materials;
CREATE POLICY "lm_update_doctor" ON lesson_materials
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM courses c WHERE c.id = course_id AND (c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
  );

DROP POLICY IF EXISTS "lm_delete_doctor" ON lesson_materials;
CREATE POLICY "lm_delete_doctor" ON lesson_materials
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM courses c WHERE c.id = course_id AND (c.doctor_id = auth.uid() OR is_admin_or_super_admin()))
  );

-- ── 6. Storage bucket: lesson-materials (private) ─────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'lesson-materials',
  'lesson-materials',
  false,
  104857600,  -- 100 MB per file
  ARRAY[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/x-zip-compressed',
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'audio/mpeg', 'audio/ogg', 'audio/wav',
    'video/mp4', 'video/webm',
    'text/plain', 'text/html',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage RLS for lesson-materials bucket
DROP POLICY IF EXISTS "lm_storage_upload" ON storage.objects;
CREATE POLICY "lm_storage_upload" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'lesson-materials' AND
    (
      -- Doctor or admin may upload
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('doctor','admin','super_admin'))
    )
  );

DROP POLICY IF EXISTS "lm_storage_select" ON storage.objects;
CREATE POLICY "lm_storage_select" ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'lesson-materials' AND (
      -- Doctors / admins always have access
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('doctor','admin','super_admin'))
      -- Enrolled students or preview lessons
      OR EXISTS (
        SELECT 1 FROM lesson_materials lm
        JOIN lessons l ON l.id = lm.lesson_id
        WHERE lm.storage_path = name AND (
          l.is_preview = true
          OR EXISTS (
            SELECT 1 FROM enrollments e
            WHERE e.course_id = lm.course_id AND e.student_id = auth.uid()
          )
        )
      )
    )
  );

DROP POLICY IF EXISTS "lm_storage_delete" ON storage.objects;
CREATE POLICY "lm_storage_delete" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'lesson-materials' AND
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('doctor','admin','super_admin'))
  );

-- ── 7. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_courses_university ON courses(university_id);
CREATE INDEX IF NOT EXISTS idx_courses_faculty    ON courses(faculty_id);
CREATE INDEX IF NOT EXISTS idx_courses_difficulty ON courses(difficulty);
CREATE INDEX IF NOT EXISTS idx_lessons_video_type ON lessons(video_type);

-- ── 8. total_sections trigger ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_course_section_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE courses SET total_sections = (
      SELECT COUNT(*) FROM sections WHERE course_id = OLD.course_id
    ) WHERE id = OLD.course_id;
  ELSE
    UPDATE courses SET total_sections = (
      SELECT COUNT(*) FROM sections WHERE course_id = NEW.course_id
    ) WHERE id = NEW.course_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_section_count ON sections;
CREATE TRIGGER trg_section_count
  AFTER INSERT OR DELETE ON sections
  FOR EACH ROW EXECUTE FUNCTION update_course_section_count();
