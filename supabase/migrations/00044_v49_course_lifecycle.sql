
-- ═══════════════════════════════════════════════════════════
--  v49 — Course Lifecycle: Estimated Study Time + Archive
-- ═══════════════════════════════════════════════════════════

-- 1. Add estimated_minutes to lessons
ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS estimated_minutes integer NOT NULL DEFAULT 0;

-- 2. Archive columns on courses
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS archive_reason text,
  ADD COLUMN IF NOT EXISTS restored_at timestamptz,
  ADD COLUMN IF NOT EXISTS restored_by uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS permanently_deleted boolean NOT NULL DEFAULT false;

-- 3. Course lifecycle audit log table
CREATE TABLE course_lifecycle_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id      uuid REFERENCES courses(id) ON DELETE SET NULL,
  course_title   text NOT NULL,
  doctor_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
  action         text NOT NULL, -- 'archived' | 'restored' | 'deleted' | 'viewed_from_archive'
  actor_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  actor_role     text,
  reason         text,
  students_count integer DEFAULT 0,
  lessons_count  integer DEFAULT 0,
  videos_count   integer DEFAULT 0,
  attachments_count integer DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE course_lifecycle_logs ENABLE ROW LEVEL SECURITY;

-- Admins/Super Admins can read
CREATE POLICY "admins_read_lifecycle_logs"
  ON course_lifecycle_logs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin','super_admin','doctor')
    )
  );

-- Only service role can insert (via RPC)
CREATE POLICY "service_insert_lifecycle_logs"
  ON course_lifecycle_logs FOR INSERT
  TO authenticated
  WITH CHECK (false);

-- 4. RPC: archive_course
CREATE OR REPLACE FUNCTION archive_course(
  p_course_id    uuid,
  p_actor_id     uuid,
  p_actor_role   text,
  p_reason       text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_course       courses%ROWTYPE;
  v_students     integer;
  v_lessons      integer;
  v_videos       integer;
  v_attachments  integer;
BEGIN
  SELECT * INTO v_course FROM courses WHERE id = p_course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Course not found'; END IF;
  IF v_course.archived_at IS NOT NULL THEN RAISE EXCEPTION 'Course is already archived'; END IF;

  SELECT COUNT(*) INTO v_students  FROM course_subscriptions WHERE course_id = p_course_id;
  SELECT COUNT(*) INTO v_lessons   FROM lessons WHERE course_id = p_course_id;
  SELECT COUNT(*) INTO v_videos    FROM lessons WHERE course_id = p_course_id AND video_id IS NOT NULL;
  SELECT COUNT(*) INTO v_attachments FROM lesson_materials WHERE course_id = p_course_id;

  UPDATE courses
  SET archived_at = now(), archived_by = p_actor_id, archive_reason = p_reason,
      status = 'archived', updated_at = now()
  WHERE id = p_course_id;

  INSERT INTO course_lifecycle_logs
    (course_id, course_title, doctor_id, action, actor_id, actor_role, reason,
     students_count, lessons_count, videos_count, attachments_count)
  VALUES
    (p_course_id, v_course.title, v_course.doctor_id, 'archived', p_actor_id, p_actor_role, p_reason,
     v_students, v_lessons, v_videos, v_attachments);
END;
$$;

-- 5. RPC: restore_course
CREATE OR REPLACE FUNCTION restore_course(
  p_course_id  uuid,
  p_actor_id   uuid,
  p_actor_role text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_course courses%ROWTYPE;
BEGIN
  SELECT * INTO v_course FROM courses WHERE id = p_course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Course not found'; END IF;
  IF v_course.archived_at IS NULL THEN RAISE EXCEPTION 'Course is not archived'; END IF;

  UPDATE courses
  SET archived_at = NULL, archived_by = NULL, archive_reason = NULL,
      restored_at = now(), restored_by = p_actor_id,
      status = 'published', updated_at = now()
  WHERE id = p_course_id;

  INSERT INTO course_lifecycle_logs
    (course_id, course_title, doctor_id, action, actor_id, actor_role)
  VALUES
    (p_course_id, v_course.title, v_course.doctor_id, 'restored', p_actor_id, p_actor_role);
END;
$$;

-- 6. RPC: permanently_delete_course (Super Admin only — enforced app-side + RLS)
CREATE OR REPLACE FUNCTION permanently_delete_course(
  p_course_id  uuid,
  p_actor_id   uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_course      courses%ROWTYPE;
  v_students    integer;
  v_lessons     integer;
  v_videos      integer;
  v_attachments integer;
BEGIN
  SELECT * INTO v_course FROM courses WHERE id = p_course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Course not found'; END IF;
  IF v_course.archived_at IS NULL THEN RAISE EXCEPTION 'Course must be archived before permanent deletion'; END IF;

  SELECT COUNT(*) INTO v_students  FROM course_subscriptions WHERE course_id = p_course_id;
  SELECT COUNT(*) INTO v_lessons   FROM lessons WHERE course_id = p_course_id;
  SELECT COUNT(*) INTO v_videos    FROM lessons WHERE course_id = p_course_id AND video_id IS NOT NULL;
  SELECT COUNT(*) INTO v_attachments FROM lesson_materials WHERE course_id = p_course_id;

  -- Log before deletion (course_id set to NULL via ON DELETE SET NULL)
  INSERT INTO course_lifecycle_logs
    (course_id, course_title, doctor_id, action, actor_id, actor_role,
     students_count, lessons_count, videos_count, attachments_count)
  VALUES
    (p_course_id, v_course.title, v_course.doctor_id, 'deleted', p_actor_id, 'super_admin',
     v_students, v_lessons, v_videos, v_attachments);

  -- Cascade deletes all related data
  DELETE FROM courses WHERE id = p_course_id;
END;
$$;

-- 7. RPC: get_archived_courses (with actor/doctor join)
CREATE OR REPLACE FUNCTION get_archived_courses(
  p_actor_id   uuid,
  p_actor_role text,
  p_doctor_id  uuid DEFAULT NULL
) RETURNS TABLE (
  id              uuid,
  title           text,
  doctor_id       uuid,
  doctor_name     text,
  archived_at     timestamptz,
  archived_by     uuid,
  archived_by_name text,
  archive_reason  text,
  students_count  bigint,
  lessons_count   bigint,
  status          text
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.title,
    c.doctor_id,
    d.full_name AS doctor_name,
    c.archived_at,
    c.archived_by,
    ab.full_name AS archived_by_name,
    c.archive_reason,
    (SELECT COUNT(*) FROM course_subscriptions cs WHERE cs.course_id = c.id) AS students_count,
    (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lessons_count,
    c.status
  FROM courses c
  LEFT JOIN profiles d ON d.id = c.doctor_id
  LEFT JOIN profiles ab ON ab.id = c.archived_by
  WHERE c.archived_at IS NOT NULL
    AND (
      p_actor_role IN ('admin','super_admin')
      OR (p_actor_role = 'doctor' AND c.doctor_id = p_actor_id)
    )
    AND (p_doctor_id IS NULL OR c.doctor_id = p_doctor_id)
  ORDER BY c.archived_at DESC;
END;
$$;

-- 8. RPC: get_archive_analytics
CREATE OR REPLACE FUNCTION get_archive_analytics()
RETURNS TABLE (
  total_archived   bigint,
  total_restored   bigint,
  total_deleted    bigint,
  recent_archives  json
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM course_lifecycle_logs WHERE action = 'archived')::bigint,
    (SELECT COUNT(*) FROM course_lifecycle_logs WHERE action = 'restored')::bigint,
    (SELECT COUNT(*) FROM course_lifecycle_logs WHERE action = 'deleted')::bigint,
    (SELECT json_agg(row_to_json(t)) FROM (
       SELECT course_title, action, actor_role, created_at
       FROM course_lifecycle_logs
       ORDER BY created_at DESC
       LIMIT 20
     ) t);
END;
$$;

-- 9. Indexes
CREATE INDEX IF NOT EXISTS idx_lessons_estimated_minutes ON lessons(estimated_minutes);
CREATE INDEX IF NOT EXISTS idx_courses_archived_at       ON courses(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lifecycle_logs_course_id  ON course_lifecycle_logs(course_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_logs_action     ON course_lifecycle_logs(action);
CREATE INDEX IF NOT EXISTS idx_lifecycle_logs_created_at ON course_lifecycle_logs(created_at DESC);
