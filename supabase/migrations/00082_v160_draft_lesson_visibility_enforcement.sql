-- ══════════════════════════════════════════════════════════════════════════════
-- v160: Draft Lesson Visibility Enforcement
-- ══════════════════════════════════════════════════════════════════════════════
--
-- BUG: The existing `lessons_select` RLS policy only checked that the *course*
-- was published. It did NOT check the lesson's own `status` column, so draft
-- lessons inside a published course were fully visible to enrolled students.
--
-- FIX: Replace the three affected policies so that:
--   • Students (role = 'student') can only SELECT lessons/PDFs/materials where
--     the lesson itself has status = 'published'.
--   • Doctors (course owners), admins, and super admins continue to see ALL
--     lesson statuses — they need drafts for management.
--
-- Surface area fixed:
--   1. lessons             — lessons_select policy
--   2. lesson_pdfs         — lesson_pdfs_select policy
--   3. lesson_materials    — lm_select_enrolled_or_owner policy
--
-- get_course_progress RPC already had WHERE l.status = 'published' — no change
-- needed there.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. lessons_select ─────────────────────────────────────────────────────────
-- Old: only checked course.status = 'published'
-- New: additionally checks lessons.status = 'published' for non-privileged users
DROP POLICY IF EXISTS "lessons_select" ON lessons;
CREATE POLICY "lessons_select" ON lessons
  FOR SELECT TO authenticated
  USING (
    -- Course owner (doctor) can see all their lessons regardless of lesson status
    EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = course_id AND c.doctor_id = auth.uid()
    )
    -- Admins / super admins see everything
    OR is_admin_or_super_admin()
    -- Everyone else (students): course must be published AND lesson must be published
    OR (
      lessons.status = 'published'
      AND EXISTS (
        SELECT 1 FROM courses c
        WHERE c.id = course_id AND c.status = 'published'
      )
    )
  );

-- ── 2. lesson_pdfs_select ─────────────────────────────────────────────────────
-- Old: checked course.status = 'published', not lesson.status
-- New: also requires lesson.status = 'published' for non-privileged users
DROP POLICY IF EXISTS "lesson_pdfs_select" ON lesson_pdfs;
CREATE POLICY "lesson_pdfs_select" ON lesson_pdfs
  FOR SELECT TO authenticated
  USING (
    -- Doctor who owns the course
    EXISTS (
      SELECT 1 FROM lessons l
      JOIN courses c ON c.id = l.course_id
      WHERE l.id = lesson_id AND c.doctor_id = auth.uid()
    )
    -- Admins / super admins
    OR is_admin_or_super_admin()
    -- Students: lesson must be published in a published course
    OR EXISTS (
      SELECT 1 FROM lessons l
      JOIN courses c ON c.id = l.course_id
      WHERE l.id = lesson_id
        AND l.status = 'published'
        AND c.status = 'published'
    )
  );

-- ── 3. lesson_materials (lm_select_enrolled_or_owner) ────────────────────────
-- Old: enrolled student or preview — did not filter by lesson.status
-- New: student path also requires l.status = 'published'
DROP POLICY IF EXISTS "lm_select_enrolled_or_owner" ON lesson_materials;
CREATE POLICY "lm_select_enrolled_or_owner" ON lesson_materials
  FOR SELECT TO authenticated
  USING (
    -- Doctor who owns the course
    EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = course_id AND c.doctor_id = auth.uid()
    )
    -- Admin / super admin
    OR is_admin_or_super_admin()
    -- Enrolled student (or preview lesson) — lesson must be published
    OR EXISTS (
      SELECT 1 FROM lessons l
      WHERE l.id = lesson_id
        AND l.status = 'published'
        AND (
          l.is_preview = true
          OR EXISTS (
            SELECT 1 FROM enrollments e
            WHERE e.course_id = lesson_materials.course_id
              AND e.student_id = auth.uid()
          )
        )
    )
  );

-- ── 4. Helper index (performance) ─────────────────────────────────────────────
-- The new policies filter by lessons.status frequently; ensure it is indexed.
CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons (status);
CREATE INDEX IF NOT EXISTS idx_lessons_course_status ON lessons (course_id, status);
