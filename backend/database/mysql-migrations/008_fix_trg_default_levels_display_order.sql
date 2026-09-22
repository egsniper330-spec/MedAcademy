-- ============================================================================
-- Migration 008: Fix trg_default_levels trigger column name
-- Root cause of "Failed to save faculty" (SQLSTATE 42S22 / MySQL 1054):
--   trg_default_levels (AFTER INSERT ON faculties) seeded default levels with
--   INSERT INTO academic_levels (faculty_id, name, order_index) — but
--   academic_levels defines the ordering column as `display_order` (schema.sql).
--   `order_index` belongs to sections/lessons. Every faculty INSERT therefore
--   failed at the trigger with "Unknown column 'order_index' in 'INSERT INTO'"
--   and the API returned 500 → the UI showed "Failed to save faculty."
-- Fix: recreate the trigger using `display_order`.
-- Date: 2026-09-06
-- Safe: idempotent (DROP TRIGGER IF EXISTS + CREATE). No data changes.
-- Deploy: run on the production MySQL (medainmj_medacademy) as admin user.
-- ============================================================================

DELIMITER $$

DROP TRIGGER IF EXISTS trg_default_levels $$
CREATE TRIGGER trg_default_levels
AFTER INSERT ON `faculties`
FOR EACH ROW
BEGIN
  IF (SELECT COUNT(*) FROM `academic_levels` WHERE `faculty_id` = NEW.`id`) = 0 THEN
    INSERT INTO `academic_levels` (`faculty_id`, `name`, `display_order`) VALUES
      (NEW.`id`, '1st Year', 1),
      (NEW.`id`, '2nd Year', 2),
      (NEW.`id`, '3rd Year', 3),
      (NEW.`id`, '4th Year', 4),
      (NEW.`id`, '5th Year', 5);
  END IF;
END $$

DELIMITER ;
