-- ============================================================================
-- VERIFY-ONLY (read-only) — constraints status check
-- ============================================================================
-- Confirms the three CHECK constraints that previously broke the app:
--
--   1. chk_lessons_video_type  must allow  vdocipher, coming_soon, youtube
--   2. chk_lessons_status      must allow  draft, published, hidden,
--                                           scheduled, archived
--   3. chk_audit_logs_action   must include profile_name_changed,
--                                           profile_avatar_changed,
--                                           profile_email_changed,
--                                           profile_phone_changed,
--                                           doctor_created,
--                                           role_changed_to_* (157 values total)
--
-- THIS FILE RUNS NO DDL AND NO DML. It contains only:
--   * SHOW CREATE TABLE   (works without information_schema privileges)
--   * plain read-only SELECTs against the application database
-- There is NO information_schema, NO PREPARE, NO EXECUTE, no dynamic SQL,
-- no stored procedures — safe for the cPanel phpMyAdmin user.
--
-- HOW TO USE:
--   Open phpMyAdmin → select the medacademy database → SQL tab →
--   paste this file's contents → Go.
--
-- Expected result (production is already correct):
--   * lessons table definition shows:
--       chk_lessons_video_type` CHECK (`video_type` in ('vdocipher','coming_soon','youtube'))
--       chk_lessons_status`     CHECK (`status` in ('draft','published','hidden','scheduled','archived'))
--   * audit_logs table definition shows chk_audit_logs_action with the full
--     157-value list (profile_name_changed, profile_avatar_changed,
--     profile_email_changed, profile_phone_changed, doctor_created,
--     role_changed_to_doctor/admin/super_admin/student, ... all present).
--   * The GROUP BY counts return only data — no errors.
--
-- If all three are present with the correct values, NOTHING needs to be
-- applied — do not import any ALTER statements.
-- ============================================================================


-- ── 1. lessons table definition (chk_lessons_video_type + chk_lessons_status)
SHOW CREATE TABLE `lessons`;


-- ── 2. audit_logs table definition (chk_audit_logs_action)
SHOW CREATE TABLE `audit_logs`;


-- ── 3. Data check: which video_type / status values exist (read-only)
SELECT `video_type`, COUNT(*) AS lessons
FROM `lessons`
GROUP BY `video_type`
ORDER BY `video_type`;

SELECT `status`, COUNT(*) AS lessons
FROM `lessons`
GROUP BY `status`
ORDER BY `status`;
