-- Performance: add missing indexes on high-traffic FK / filter columns.
-- Only indexes that do not already exist in earlier migrations.

-- courses.doctor_id — every doctor dashboard query
CREATE INDEX IF NOT EXISTS idx_courses_doctor_id
  ON courses(doctor_id);

-- courses.status — published-courses filter
CREATE INDEX IF NOT EXISTS idx_courses_status
  ON courses(status);

-- courses.category_id — category browse
CREATE INDEX IF NOT EXISTS idx_courses_category_id
  ON courses(category_id);

-- activation_codes.used_by — code-history lookups (who redeemed)
CREATE INDEX IF NOT EXISTS idx_activation_codes_used_by
  ON activation_codes(used_by);

-- activation_codes.batch_id added in later migration — guard with DO block
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='activation_codes' AND column_name='batch_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_activation_codes_batch_id ON activation_codes(batch_id)';
  END IF;
END$$;

-- notifications.created_at — notification list ordering
CREATE INDEX IF NOT EXISTS idx_notifications_created_at
  ON notifications(created_at DESC);

-- notifications unread count per user
CREATE INDEX IF NOT EXISTS idx_notifications_user_read
  ON notifications(user_id, is_read);

-- lesson_progress.lesson_id — per-lesson progress lookups
CREATE INDEX IF NOT EXISTS idx_lesson_progress_lesson_id
  ON lesson_progress(lesson_id);

-- lesson_progress.course_id — per-course completion queries
CREATE INDEX IF NOT EXISTS idx_lesson_progress_course_id
  ON lesson_progress(course_id);

-- video_uploads.lesson_id — lesson video lookups
CREATE INDEX IF NOT EXISTS idx_video_uploads_lesson_id
  ON video_uploads(lesson_id);

-- video_uploads.status — video health / monitoring queries
CREATE INDEX IF NOT EXISTS idx_video_uploads_status
  ON video_uploads(status);

-- credit_transactions.student_id — student credit history
CREATE INDEX IF NOT EXISTS idx_credit_transactions_student_id
  ON credit_transactions(student_id);

-- credit_transactions.course_id — per-course credit reporting
CREATE INDEX IF NOT EXISTS idx_credit_transactions_course_id
  ON credit_transactions(course_id);

-- doctor_earnings_events.student_id — earnings breakdown per student
CREATE INDEX IF NOT EXISTS idx_dee_student_id
  ON doctor_earnings_events(student_id);

-- audit_logs.user_id — per-user audit history (actor side)
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id
  ON audit_logs(user_id);