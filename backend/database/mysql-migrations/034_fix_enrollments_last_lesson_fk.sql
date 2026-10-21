-- =============================================================
-- 034_fix_enrollments_last_lesson_fk.sql
--
-- PROBLEM ("Failed to delete section" / lesson)
-- ---------------------------------------------
-- `enrollments`.`last_lesson_id` referenced `lessons`.`id` with NO
-- ON DELETE action, which MySQL treats as RESTRICT. Deleting a lesson
-- (or a SECTION, whose lessons are cascade-deleted with it) therefore
-- failed with error 1451 the moment ANY student's resume pointer
-- referenced one of those lessons:
--
--   SQLSTATE[23000]: Integrity constraint violation: 1451 Cannot
--   delete or update a parent row: a foreign key constraint fails
--   (`medacademy`.`enrollments`, CONSTRAINT `fk_enrollments_last_lesson_id`)
--
-- The client masks raw SQL, so the doctor only saw
-- "Failed to delete section."
--
-- FIX
-- ---
-- The pointer is "where the student stopped watching", not ownership:
-- it must not be able to block content deletion. `ON DELETE SET NULL`
-- forgets the resume position and keeps the enrollment, the student
-- and their progress rows untouched.
--
-- The application no longer depends on this migration: the section and
-- lesson delete endpoints clear the pointer explicitly inside their
-- transaction. This migration simply makes the schema correct for
-- future installs and for any other delete path.
--
-- SAFETY
-- ------
-- • No rows are deleted or modified by this script — only the FK's
--   delete rule changes (`ALTER TABLE` rewrites no data here).
-- • Idempotent: each step is skipped when it is already satisfied.
-- • Do NOT run it against production without approval; the app-level
--   fix already makes deletion work.
--
-- phpMyAdmin NOTES
-- ----------------
-- The conditional steps use server-side dynamic SQL (SET / PREPARE /
-- EXECUTE), which phpMyAdmin displays awkwardly: if a skipped step ran
-- `PREPARE … 'SELECT 1'`, the EXECUTE result has no result-set metadata
-- and phpMyAdmin prints three BENIGN PHP warnings ("Undefined array key
-- statement" / "parser", "Attempt to read property list on null").
-- Those are display notices, NOT SQL errors — but to keep the import
-- output clean this script's skipped-step branch is a prepared
-- `SET @noop = 0`, which returns no result set at all, and verification
-- uses `SHOW CREATE TABLE` instead of a result-returning information_schema
-- SELECT.
--
-- TO APPLY: phpMyAdmin → select the database → Import → this file
--   (or: mysql -u USER -p DBNAME < 034_fix_enrollments_last_lesson_fk.sql)
-- TO VERIFY AFTERWARDS: the `SHOW CREATE TABLE` output below must show
--   CONSTRAINT `fk_enrollments_last_lesson_id` … ON DELETE SET NULL
--   (a missing FK plus the "constraint named differently" query in
--   verify_constraints_status.sql is the fallback check).
-- =============================================================

-- 1. Drop the existing FK (whatever its current name) if it is not
--    already SET NULL.
SET @fk = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
    AND rc.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'enrollments'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'last_lesson_id'
    AND kcu.REFERENCED_TABLE_NAME = 'lessons'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
    AND rc.DELETE_RULE <> 'SET NULL'
  LIMIT 1
);
SET @sql = IF(@fk IS NOT NULL,
              CONCAT('ALTER TABLE `enrollments` DROP FOREIGN KEY `', @fk, '`'),
              -- No-op: SET returns no result set, so phpMyAdmin renders nothing
              -- (a prepared `SELECT 1` here is what produced the warnings).
              'SET @noop = 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Re-add it with ON DELETE SET NULL when it is missing entirely.
SET @existing = (
  SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON  tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
    AND tc.TABLE_NAME        = kcu.TABLE_NAME
    AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
    AND tc.TABLE_NAME = 'enrollments'
    AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND kcu.COLUMN_NAME = 'last_lesson_id'
    AND kcu.REFERENCED_TABLE_NAME = 'lessons'
    AND kcu.REFERENCED_COLUMN_NAME = 'id'
  LIMIT 1
);
SET @sql = IF(@existing IS NULL,
              'ALTER TABLE `enrollments` ADD CONSTRAINT `fk_enrollments_last_lesson_id` FOREIGN KEY (`last_lesson_id`) REFERENCES `lessons` (`id`) ON DELETE SET NULL',
              'SET @noop = 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Verify (read-only). Look for `fk_enrollments_last_lesson_id` … ON DELETE SET NULL.
SHOW CREATE TABLE `enrollments`;
