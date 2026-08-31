-- ============================================================================
-- Verification for Migration 004: lessons CHECK constraints
-- ============================================================================
-- Run these queries BEFORE and AFTER importing 004_fix_lessons_video_type
-- status_enums.sql to confirm the constraint state.
--
-- These queries touch ONLY the application database. There is NO
-- information_schema, NO PREPARE/EXECUTE, no dynamic SQL — safe for the
-- cPanel phpMyAdmin user (which has no information_schema privileges).
-- ============================================================================


-- ── 1. Show the FULL current definition of the lessons table ────────────────
-- The CHECK constraints (chk_lessons_video_type, chk_lessons_status) appear
-- in the CHECK clauses. This is the definitive state check.
SHOW CREATE TABLE `lessons`;


-- ── 2. Show which video_type / status values actually exist in the data ─────
-- (Read-only. Confirms the rows are untouched and shows whether the app has
--  any youtube / archived lessons already.)
SELECT `video_type`, COUNT(*) AS lessons
FROM `lessons`
GROUP BY `video_type`
ORDER BY `video_type`;

SELECT `status`, COUNT(*) AS lessons
FROM `lessons`
GROUP BY `status`
ORDER BY `status`;
