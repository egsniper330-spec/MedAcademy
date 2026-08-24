-- MedAcademy MySQL schema — split files for phpMyAdmin import.
-- Primary method: cPanel Terminal -> mysql -u USER -p DB < backend/database/schema.sql
-- See backend/NAMECHEAP_DEPLOYMENT.md step 7.

TRIGGERS (ported from PostgreSQL trigger functions in supabase/migrations)
-- ---------------------------------------------------------------------------
-- These reproduce the business-critical invariants the PG triggers enforced.
-- The PHP service layer is the PRIMARY enforcer; triggers are belt-and-braces
-- so raw SQL imports / ad-hoc admin edits cannot silently break invariants.
-- ===========================================================================

DELIMITER $$

-- 1. Auto-create profile row when a user account is created
--    (PG: handle_new_user / on_auth_user_created)
DROP TRIGGER IF EXISTS trg_on_auth_user_created $$
CREATE TRIGGER trg_on_auth_user_created
AFTER INSERT ON `users`
FOR EACH ROW
BEGIN
  INSERT INTO `profiles` (`id`, `email`, `full_name`, `role`)
  VALUES (
    NEW.`id`,
    NEW.`email`,
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(NEW.`raw_user_meta_data`, '$.full_name')), ''),
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(NEW.`raw_user_meta_data`, '$.role')), 'student')
  );
END $$

-- 2. Auto-create credits row when a profile becomes a doctor
--    (PG: handle_doctor_credits / on_doctor_profile_created)
DROP TRIGGER IF EXISTS trg_on_doctor_profile_created $$
CREATE TRIGGER trg_on_doctor_profile_created
AFTER INSERT ON `profiles`
FOR EACH ROW
BEGIN
  IF NEW.`role` = 'doctor' THEN
    INSERT INTO `credits` (`doctor_id`) VALUES (NEW.`id`)
    ON DUPLICATE KEY UPDATE `doctor_id` = `doctor_id`;
  END IF;
END $$

DROP TRIGGER IF EXISTS trg_on_doctor_profile_promoted $$
CREATE TRIGGER trg_on_doctor_profile_promoted
AFTER UPDATE ON `profiles`
FOR EACH ROW
BEGIN
  IF NEW.`role` = 'doctor' AND (OLD.`role` IS NULL OR OLD.`role` <> 'doctor') THEN
    INSERT INTO `credits` (`doctor_id`) VALUES (NEW.`id`)
    ON DUPLICATE KEY UPDATE `doctor_id` = `doctor_id`;
  END IF;
END $$

-- 3. Super admin always unlimited credits
--    (PG: trg_super_admin_unlimited)
DROP TRIGGER IF EXISTS trg_super_admin_unlimited $$
CREATE TRIGGER trg_super_admin_unlimited
BEFORE INSERT ON `credits`
FOR EACH ROW
BEGIN
  DECLARE v_role VARCHAR(50);
  SELECT `role` INTO v_role FROM `profiles` WHERE `id` = NEW.`doctor_id`;
  IF v_role = 'super_admin' THEN
    SET NEW.`allocated` = -1, NEW.`consumed` = 0, NEW.`remaining` = -1;
  END IF;
END $$

-- 4. Course lesson count maintenance
--    (PG: update_course_lesson_count / lessons_count_trigger)
DROP TRIGGER IF EXISTS trg_lessons_count_insert $$
CREATE TRIGGER trg_lessons_count_insert
AFTER INSERT ON `lessons`
FOR EACH ROW
BEGIN
  UPDATE `courses` SET `total_lessons` = `total_lessons` + 1 WHERE `id` = NEW.`course_id`;
END $$

DROP TRIGGER IF EXISTS trg_lessons_count_delete $$
CREATE TRIGGER trg_lessons_count_delete
AFTER DELETE ON `lessons`
FOR EACH ROW
BEGIN
  UPDATE `courses` SET `total_lessons` = GREATEST(`total_lessons` - 1, 0) WHERE `id` = OLD.`course_id`;
END $$

-- 5. Section count maintenance (PG: trg_section_count)
DROP TRIGGER IF EXISTS trg_section_count_insert $$
CREATE TRIGGER trg_section_count_insert
AFTER INSERT ON `sections`
FOR EACH ROW
BEGIN
  UPDATE `courses` SET `total_sections` = `total_sections` + 1 WHERE `id` = NEW.`course_id`;
END $$

DROP TRIGGER IF EXISTS trg_section_count_delete $$
CREATE TRIGGER trg_section_count_delete
AFTER DELETE ON `sections`
FOR EACH ROW
BEGIN
  UPDATE `courses` SET `total_sections` = GREATEST(`total_sections` - 1, 0) WHERE `id` = OLD.`course_id`;
END $$

-- 6. Earnings event on credit consumption
--    (PG: trg_record_earnings_event / trg_earnings_on_consumption, final
--     version from 00150 — assigned price > course revenue price > doctor
--     global price, with student/course snapshots)
DROP TRIGGER IF EXISTS trg_earnings_on_consumption $$
CREATE TRIGGER trg_earnings_on_consumption
AFTER INSERT ON `credit_transactions`
FOR EACH ROW
BEGIN
  DECLARE v_doctor_global_price DECIMAL(20,6) DEFAULT 0;
  DECLARE v_course_revenue_price DECIMAL(20,6);
  DECLARE v_assigned_price DECIMAL(20,6);
  DECLARE v_resolved_price DECIMAL(20,6) DEFAULT 0;
  DECLARE v_student_name TEXT;
  DECLARE v_student_email TEXT;
  DECLARE v_student_phone TEXT;
  DECLARE v_student_watermark TEXT;
  DECLARE v_course_name TEXT;

  -- Only fire on consumption events with a doctor (no LEAVE — nested IFs)
  IF NEW.`transaction_type` = 'consumption' AND NEW.`doctor_id` IS NOT NULL THEN
    SELECT COALESCE(`doctor_global_price`, 0) INTO v_doctor_global_price
      FROM `profiles` WHERE `id` = NEW.`doctor_id`;

    IF NEW.`course_id` IS NOT NULL THEN
      SELECT `doctor_revenue_price`, `title` INTO v_course_revenue_price, v_course_name
        FROM `courses` WHERE `id` = NEW.`course_id`;
    END IF;

    IF NEW.`course_id` IS NOT NULL AND NEW.`student_id` IS NOT NULL THEN
      SELECT `assigned_price` INTO v_assigned_price
        FROM `enrollments`
        WHERE `course_id` = NEW.`course_id` AND `student_id` = NEW.`student_id`
        ORDER BY `enrolled_at` DESC LIMIT 1;
    END IF;

    SET v_resolved_price = COALESCE(v_assigned_price, v_course_revenue_price, v_doctor_global_price, 0);

    IF NEW.`student_id` IS NOT NULL THEN
      SELECT `full_name`, COALESCE(`profile_email`, `email`),
             COALESCE(`phone_national`, `phone_e164`, `phone`), `watermark_id`
        INTO v_student_name, v_student_email, v_student_phone, v_student_watermark
        FROM `profiles` WHERE `id` = NEW.`student_id`;
    END IF;

    INSERT INTO `doctor_earnings_events` (
      `doctor_id`, `course_id`, `student_id`, `event_type`, `pricing_mode`,
      `price_snapshot`, `earnings_amount`, `transaction_type`,
      `student_name_snapshot`, `student_email_snapshot`, `student_phone_snapshot`,
      `student_watermark_snapshot`, `course_name_snapshot`, `notes`
    ) VALUES (
      NEW.`doctor_id`, NEW.`course_id`, NEW.`student_id`,
      'credit_use', 'doctor_independent', v_resolved_price,
      NEW.`amount` * v_resolved_price, 'purchase',
      v_student_name, v_student_email, v_student_phone,
      v_student_watermark, v_course_name,
      'Auto-recorded on credit consumption'
    );
  END IF;
END $$

-- 7. Earnings deduction when a student account is trashed
--    (PG: trg_deduct_earnings_on_account_deletion / trg_earnings_on_account_deletion)
DROP TRIGGER IF EXISTS trg_earnings_on_account_deletion $$
CREATE TRIGGER trg_earnings_on_account_deletion
AFTER UPDATE ON `profiles`
FOR EACH ROW
BEGIN
  IF NEW.`status` = 'trashed' AND (OLD.`status` IS NULL OR OLD.`status` <> 'trashed') THEN
    INSERT INTO `doctor_earnings_events` (
      `doctor_id`, `course_id`, `student_id`, `event_type`, `pricing_mode`,
      `price_snapshot`, `earnings_amount`, `transaction_type`,
      `student_name_snapshot`, `course_name_snapshot`, `notes`
    )
    SELECT dee.`doctor_id`, dee.`course_id`, NEW.`id`,
           'credit_use', 'doctor_independent',
           SUM(dee.`earnings_amount`), -SUM(dee.`earnings_amount`),
           'account_deletion',
           COALESCE(NEW.`full_name`, 'Deleted Account'), dee.`course_name_snapshot`,
           'Student account deleted'
    FROM `doctor_earnings_events` dee
    WHERE dee.`student_id` = NEW.`id`
      AND dee.`transaction_type` = 'purchase'
    GROUP BY dee.`doctor_id`, dee.`course_id`, dee.`course_name_snapshot`
    HAVING SUM(dee.`earnings_amount`) > 0;
  END IF;
END $$

-- 8. updated_at maintenance
DROP TRIGGER IF EXISTS trg_video_uploads_updated_at $$
CREATE TRIGGER trg_video_uploads_updated_at
BEFORE UPDATE ON `video_uploads`
FOR EACH ROW SET NEW.`updated_at` = CURRENT_TIMESTAMP(6) $$

DROP TRIGGER IF EXISTS trg_upload_sessions_updated_at $$
CREATE TRIGGER trg_upload_sessions_updated_at
BEFORE UPDATE ON `upload_sessions`
FOR EACH ROW SET NEW.`updated_at` = CURRENT_TIMESTAMP(6) $$

DROP TRIGGER IF EXISTS trg_video_providers_updated_at $$
CREATE TRIGGER trg_video_providers_updated_at
BEFORE UPDATE ON `video_providers`
FOR EACH ROW SET NEW.`updated_at` = CURRENT_TIMESTAMP(6) $$

DROP TRIGGER IF EXISTS trg_teacher_provider_permissions_updated_at $$
CREATE TRIGGER trg_teacher_provider_permissions_updated_at
BEFORE UPDATE ON `teacher_provider_permissions`
FOR EACH ROW SET NEW.`updated_at` = CURRENT_TIMESTAMP(6) $$

DROP TRIGGER IF EXISTS trg_video_assets_updated_at $$
CREATE TRIGGER trg_video_assets_updated_at
BEFORE UPDATE ON `video_assets`
FOR EACH ROW SET NEW.`updated_at` = CURRENT_TIMESTAMP(6) $$

DROP TRIGGER IF EXISTS trg_security_config_updated_at $$
CREATE TRIGGER trg_security_config_updated_at
BEFORE UPDATE ON `security_config`
FOR EACH ROW SET NEW.`updated_at` = CURRENT_TIMESTAMP(6) $$

-- 9. Phone sync between users and profiles
--    (PG: sync_auth_phone_on_new_user, sync_auth_phone_on_profile_update)
DROP TRIGGER IF EXISTS trg_sync_auth_phone_on_new_user $$
CREATE TRIGGER trg_sync_auth_phone_on_new_user
AFTER INSERT ON `users`
FOR EACH ROW
BEGIN
  IF NEW.`phone` IS NOT NULL AND NEW.`phone` <> '' THEN
    UPDATE `profiles`
       SET `phone` = NEW.`phone`, `phone_e164` = NEW.`phone`
     WHERE `id` = NEW.`id`;
  END IF;
END $$

DROP TRIGGER IF EXISTS trg_sync_auth_phone_on_profile_update $$
CREATE TRIGGER trg_sync_auth_phone_on_profile_update
AFTER UPDATE ON `profiles`
FOR EACH ROW
BEGIN
  IF NEW.`phone_e164` IS NOT NULL AND NEW.`phone_e164` <> '' AND OLD.`phone_e164` IS DISTINCT FROM NEW.`phone_e164` THEN
    UPDATE `users` SET `phone` = NEW.`phone_e164` WHERE `id` = NEW.`id`;
  END IF;
END $$

-- 10. Default academic levels per faculty (PG: trg_default_levels)
DROP TRIGGER IF EXISTS trg_default_levels $$
CREATE TRIGGER trg_default_levels
AFTER INSERT ON `faculties`
FOR EACH ROW
BEGIN
  IF (SELECT COUNT(*) FROM `academic_levels` WHERE `faculty_id` = NEW.`id`) = 0 THEN
    INSERT INTO `academic_levels` (`faculty_id`, `name`, `order_index`) VALUES
      (NEW.`id`, '1st Year', 1),
      (NEW.`id`, '2nd Year', 2),
      (NEW.`id`, '3rd Year', 3),
      (NEW.`id`, '4th Year', 4),
      (NEW.`id`, '5th Year', 5);
  END IF;
END $$

DELIMITER ;

-- ===========================================================================
-- APPENDIX: MedAcademy PHP runtime tables
-- ---------------------------------------------------------------------------
-- No PostgreSQL counterpart. These replace Supabase Auth internals:
--   * refresh_tokens        — refresh-token rotation + device-session revocation
--   * password_reset_tokens — forgot/reset password tokens (replaces GoTrue
--                             recovery_token flow)
--   * watermark_seq         — sequential watermark_id generator
-- ===========================================================================

CREATE TABLE IF NOT EXISTS `refresh_tokens` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36) NOT NULL,
  `device_id` CHAR(36) NULL,
  `token_hash` VARCHAR(64) NOT NULL COMMENT 'sha256 hex of the refresh token',
  `expires_at` DATETIME(6) NOT NULL,
  `revoked_at` DATETIME(6) NULL,
  `revoked_reason` VARCHAR(64) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_refresh_tokens_token_hash` (`token_hash`),
  KEY `idx_refresh_tokens_user_id` (`user_id`),
  KEY `idx_refresh_tokens_device_id` (`device_id`),
  CONSTRAINT `fk_refresh_tokens_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_refresh_tokens_device_id` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `password_reset_tokens` (
  `id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `user_id` CHAR(36) NOT NULL,
  `token_hash` VARCHAR(64) NOT NULL COMMENT 'sha256 hex of the reset token',
  `expires_at` DATETIME(6) NOT NULL,
  `used_at` DATETIME(6) NULL,
  `ip_address` VARCHAR(45) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_password_reset_tokens_token_hash` (`token_hash`),
  KEY `idx_password_reset_tokens_user_id` (`user_id`),
  CONSTRAINT `fk_password_reset_tokens_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `watermark_seq` (
  `id` TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
  `next_val` BIGINT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `watermark_seq` (`id`, `next_val`) VALUES (1, 1);

SET FOREIGN_KEY_CHECKS = 1;
