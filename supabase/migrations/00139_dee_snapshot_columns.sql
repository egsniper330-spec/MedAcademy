-- Add immutable snapshot columns to doctor_earnings_events
ALTER TABLE doctor_earnings_events
  ADD COLUMN IF NOT EXISTS student_name_snapshot text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS course_name_snapshot  text DEFAULT NULL;

-- Backfill: rows with student_id → get full_name from profiles
UPDATE doctor_earnings_events dee
SET student_name_snapshot = p.full_name
FROM profiles p
WHERE dee.student_id = p.id
  AND dee.student_name_snapshot IS NULL;

-- Backfill: all rows → get course title from courses
UPDATE doctor_earnings_events dee
SET course_name_snapshot = c.title
FROM courses c
WHERE dee.course_id = c.id
  AND dee.course_name_snapshot IS NULL;
