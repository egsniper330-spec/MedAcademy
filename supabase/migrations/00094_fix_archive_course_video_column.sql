
-- Migration 00094: Correct archive_course to use video_id (text, VdoCipher ID)
-- Migration 00092 incorrectly changed video_id to video_upload_id.
-- video_id (text) = VdoCipher video ID — correct indicator that a lesson has a video.
-- video_upload_id (uuid) = internal upload session FK — separate concept.

CREATE OR REPLACE FUNCTION public.archive_course(
  p_course_id  uuid,
  p_actor_id   uuid,
  p_actor_role text,
  p_reason     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_course      courses%ROWTYPE;
  v_students    integer;
  v_lessons     integer;
  v_videos      integer;
  v_attachments integer;
BEGIN
  SELECT * INTO v_course FROM courses WHERE id = p_course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Course not found'; END IF;
  IF v_course.archived_at IS NOT NULL THEN RAISE EXCEPTION 'Course is already archived'; END IF;

  -- Fixed: was course_subscriptions (doesn't exist) → enrollments
  SELECT COUNT(*) INTO v_students    FROM enrollments      WHERE course_id = p_course_id AND status = 'active';
  SELECT COUNT(*) INTO v_lessons     FROM lessons          WHERE course_id = p_course_id;
  -- video_id (text) is the VdoCipher external ID — correct column
  SELECT COUNT(*) INTO v_videos      FROM lessons          WHERE course_id = p_course_id AND video_id IS NOT NULL;
  SELECT COUNT(*) INTO v_attachments FROM lesson_materials WHERE course_id = p_course_id;

  UPDATE courses
  SET archived_at    = now(),
      archived_by    = p_actor_id,
      archive_reason = p_reason,
      status         = 'archived',
      updated_at     = now()
  WHERE id = p_course_id;

  INSERT INTO course_lifecycle_logs
    (course_id, course_title, doctor_id, action, actor_id, actor_role, reason,
     students_count, lessons_count, videos_count, attachments_count)
  VALUES
    (p_course_id, v_course.title, v_course.doctor_id, 'archived',
     p_actor_id, p_actor_role, p_reason,
     v_students, v_lessons, v_videos, v_attachments);
END;
$$;
