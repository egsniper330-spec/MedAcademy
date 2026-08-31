-- ============================================================================
-- Migration 004 (FINAL): Fix lessons CHECK constraints (video_type, status)
-- ============================================================================
-- PROBLEM: saving a YouTube lesson fails on production with
--   SQLSTATE[23000] ... 4025 CONSTRAINT `chk_lessons_video_type` failed
-- because the constraint allows only ('vdocipher','coming_soon') while the
-- app (and the original Supabase-era enum) also supports 'youtube'.
-- Likewise `chk_lessons_status` omits 'archived', which the Lesson editor's
-- 5-state selector supports.
--
-- THIS FILE IS 100% STATIC SQL. It contains ONLY direct ALTER TABLE
-- statements. There is NO information_schema, NO PREPARE, NO EXECUTE, no
-- dynamic SQL, no stored procedures, no metadata queries of any kind.
--
-- Target constraints:
--   chk_lessons_video_type: CHECK (video_type IN ('vdocipher','coming_soon','youtube'))
--   chk_lessons_status:     CHECK (status IN ('draft','published','hidden','scheduled','archived'))
--
-- HOW TO USE (IMPORTANT — run 004_verify_lessons_constraints.sql FIRST):
--   * If verification shows BOTH constraints present (old OR new values):
--       → import this file as-is. It drops and re-adds both constraints with
--         the correct values. This is safe whether the old values or the
--         already-correct values are present (DROP then ADD is idempotent
--         for any state where the constraints exist).
--   * If verification shows the constraints are ALREADY MISSING (a previous
--     partial import dropped them but did not re-add them):
--       → do NOT import this file as-is (the DROP statements would error).
--       → run ONLY the two ADD statements from BLOCK B at the bottom
--         (uncomment them / copy them into the SQL box).
--   * If verification already shows the correct values (youtube + archived):
--       → nothing to do. Running this file is still harmless (it drops and
--         re-adds identical constraints), but it is unnecessary.
--
-- Existing lesson rows are NOT modified, updated, or deleted by anything in
-- this file. No table data is touched — only two CHECK constraints.
--
-- Compatibility: `ALTER TABLE ... DROP CONSTRAINT` is the MariaDB syntax for
-- CHECK constraints (cPanel) and also works on MySQL 8.0.19+. If you are on
-- MySQL 8.0.16–8.0.18, use `DROP CHECK` instead of `DROP CONSTRAINT`.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK A — DROP the old constraints, then re-add them with the full values.
-- Run this whole block when the constraints still exist (any values).
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE `lessons` DROP CONSTRAINT `chk_lessons_video_type`;
ALTER TABLE `lessons` DROP CONSTRAINT `chk_lessons_status`;

ALTER TABLE `lessons` ADD CONSTRAINT `chk_lessons_video_type` CHECK (`video_type` IN ('vdocipher', 'coming_soon', 'youtube'));
ALTER TABLE `lessons` ADD CONSTRAINT `chk_lessons_status` CHECK (`status` IN ('draft', 'published', 'hidden', 'scheduled', 'archived'));


-- ════════════════════════════════════════════════════════════════════════════
-- BLOCK B — ADD-only fallback.
-- ONLY for the state where a previous partial import already dropped the
-- constraints. Run ONLY these two lines in that case (do NOT run Block A).
-- ════════════════════════════════════════════════════════════════════════════
-- ALTER TABLE `lessons` ADD CONSTRAINT `chk_lessons_video_type` CHECK (`video_type` IN ('vdocipher', 'coming_soon', 'youtube'));
-- ALTER TABLE `lessons` ADD CONSTRAINT `chk_lessons_status` CHECK (`status` IN ('draft', 'published', 'hidden', 'scheduled', 'archived'));
