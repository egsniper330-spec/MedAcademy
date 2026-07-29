
-- ============================================================
-- Migration 00043 — v48 Advanced Course Builder
-- ============================================================

-- ── 1. download_permission enum ───────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE download_permission AS ENUM ('allow', 'preview_only', 'hidden', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Extend lesson_materials: download_permission column ────────────────────
ALTER TABLE lesson_materials
  ADD COLUMN IF NOT EXISTS permission download_permission NOT NULL DEFAULT 'allow';

-- Migrate existing download_enabled → permission
UPDATE lesson_materials
  SET permission = CASE
    WHEN download_enabled = true  THEN 'allow'::download_permission
    ELSE 'preview_only'::download_permission
  END
  WHERE permission = 'allow';

-- ── 3. Extend lessons: scheduled_at already exists; add archived status ────────
DO $$ BEGIN
  ALTER TYPE lesson_status ADD VALUE IF NOT EXISTS 'archived';
EXCEPTION WHEN others THEN NULL; END $$;

-- ── 4. course_templates table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS course_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text,
  source_course_id uuid REFERENCES courses(id) ON DELETE SET NULL,
  template_data   jsonb NOT NULL DEFAULT '{}',
  is_public       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_course_templates_doctor ON course_templates(doctor_id);
ALTER TABLE course_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ct_select_own" ON course_templates FOR SELECT TO authenticated
  USING (doctor_id = auth.uid() OR is_public = true OR is_admin_or_super_admin());

CREATE POLICY "ct_insert_own" ON course_templates FOR INSERT TO authenticated
  WITH CHECK (doctor_id = auth.uid());

CREATE POLICY "ct_update_own" ON course_templates FOR UPDATE TO authenticated
  USING (doctor_id = auth.uid() OR is_admin_or_super_admin());

CREATE POLICY "ct_delete_own" ON course_templates FOR DELETE TO authenticated
  USING (doctor_id = auth.uid() OR is_admin_or_super_admin());

-- ── 5. get_course_progress RPC ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_course_progress(
  p_student_id  uuid,
  p_course_id   uuid
)
RETURNS TABLE(
  total_lessons       integer,
  completed_lessons   integer,
  progress_pct        integer,
  remaining_seconds   bigint,
  last_lesson_id      uuid,
  last_viewed_at      timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH lesson_data AS (
    SELECT
      l.id,
      COALESCE(l.duration_seconds, l.video_duration_seconds, 0) AS dur,
      COALESCE(lp.completed, false) AS is_completed,
      lp.last_watched_at
    FROM lessons l
    JOIN sections s ON s.id = l.section_id AND s.course_id = p_course_id
    LEFT JOIN lesson_progress lp
      ON lp.lesson_id = l.id AND lp.student_id = p_student_id
    WHERE l.status = 'published'
  ),
  agg AS (
    SELECT
      COUNT(*)::integer                            AS total_lessons,
      COUNT(*) FILTER (WHERE is_completed)::integer AS completed_lessons,
      SUM(dur) FILTER (WHERE NOT is_completed)    AS remaining_sec,
      (SELECT id        FROM lesson_data ORDER BY last_watched_at DESC NULLS LAST LIMIT 1) AS last_lid,
      (SELECT last_watched_at FROM lesson_data ORDER BY last_watched_at DESC NULLS LAST LIMIT 1) AS last_viewed
    FROM lesson_data
  )
  SELECT
    agg.total_lessons,
    agg.completed_lessons,
    CASE WHEN agg.total_lessons = 0 THEN 0
         ELSE ((agg.completed_lessons * 100) / agg.total_lessons)
    END,
    COALESCE(agg.remaining_sec, 0)::bigint,
    agg.last_lid,
    agg.last_viewed
  FROM agg;
END;
$$;

-- ── 6. duplicate_course RPC ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION duplicate_course(
  p_source_id       uuid,
  p_target_doctor   uuid,
  p_new_title       text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_new_course_id   uuid;
  v_new_section_id  uuid;
  v_new_lesson_id   uuid;
  sec               RECORD;
  les               RECORD;
  mat               RECORD;
BEGIN
  -- Copy course row (exclude student/analytics data)
  INSERT INTO courses (
    title, description, short_description, full_description,
    thumbnail_url, cover_url, category_id, university_id, faculty_id, academic_level_id,
    language, difficulty, tags, estimated_duration_hours, instructor_name,
    sequential_learning, free_preview, certificate_enabled,
    subscription_required, credits_required, activation_code_required,
    doctor_id, status,
    whatsapp, telegram, facebook, phone
  )
  SELECT
    COALESCE(p_new_title, title || ' (Copy)'),
    description, short_description, full_description,
    thumbnail_url, cover_url, category_id, university_id, faculty_id, academic_level_id,
    language, difficulty, tags, estimated_duration_hours, instructor_name,
    sequential_learning, free_preview, certificate_enabled,
    subscription_required, credits_required, activation_code_required,
    p_target_doctor, 'draft',
    whatsapp, telegram, facebook, phone
  FROM courses WHERE id = p_source_id
  RETURNING id INTO v_new_course_id;

  -- Copy sections
  FOR sec IN SELECT * FROM sections WHERE course_id = p_source_id ORDER BY order_index LOOP
    INSERT INTO sections (course_id, title, description, order_index)
    VALUES (v_new_course_id, sec.title, sec.description, sec.order_index)
    RETURNING id INTO v_new_section_id;

    -- Copy lessons within section
    FOR les IN SELECT * FROM lessons WHERE section_id = sec.id ORDER BY order_index LOOP
      INSERT INTO lessons (
        section_id, course_id, title, description, order_index,
        video_type, video_id, video_title, video_playback_id, video_thumbnail, video_duration_seconds,
        external_url, content_html, notes,
        is_preview, download_enabled, comments_enabled, visible,
        status, duration_seconds
      )
      VALUES (
        v_new_section_id, v_new_course_id, les.title, les.description, les.order_index,
        les.video_type, les.video_id, les.video_title, les.video_playback_id, les.video_thumbnail, les.video_duration_seconds,
        les.external_url, les.content_html, les.notes,
        les.is_preview, les.download_enabled, les.comments_enabled, les.visible,
        'draft', les.duration_seconds
      )
      RETURNING id INTO v_new_lesson_id;

      -- Copy lesson materials
      FOR mat IN SELECT * FROM lesson_materials WHERE lesson_id = les.id ORDER BY order_index LOOP
        INSERT INTO lesson_materials (
          lesson_id, course_id, uploaded_by, file_name, file_url, storage_path,
          file_type, file_size, download_enabled, preview_enabled, permission, order_index
        )
        VALUES (
          v_new_lesson_id, v_new_course_id, p_target_doctor,
          mat.file_name, mat.file_url, mat.storage_path,
          mat.file_type, mat.file_size, mat.download_enabled, mat.preview_enabled, mat.permission, mat.order_index
        );
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN v_new_course_id;
END;
$$;

-- ── 7. Indexes for performance (1000+ lessons) ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lessons_section_order ON lessons(section_id, order_index);
CREATE INDEX IF NOT EXISTS idx_lessons_status        ON lessons(status);
CREATE INDEX IF NOT EXISTS idx_lessons_scheduled_at  ON lessons(scheduled_at) WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lp_student_course     ON lesson_progress(student_id, course_id);
CREATE INDEX IF NOT EXISTS idx_lp_last_watched       ON lesson_progress(student_id, last_watched_at DESC);
