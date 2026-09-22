-- =============================================================================
-- Migration 009: Public User ID (MED-0001 format)
-- =============================================================================
-- Introduces profiles.public_user_id: a stable, unique, human-readable user
-- identifier in the format MED-0001 / MED-0042 / MED-0123 (MED- + exactly 4
-- digits). At MED-9999 the trigger SIGNALs instead of emitting a 5-digit ID
-- (see the guard in the trigger body below).
--
-- Design notes:
--   * The internal CHAR(36) UUID primary key and every foreign key that
--     references it are LEFT UNTOUCHED. public_user_id is a dedicated display
--     / search identifier with its own UNIQUE index.
--   * IDs are assigned exactly once per user:
--       - existing users: backfill below (ordered by created_at — stable)
--       - new users: trg_on_auth_user_created draws from public_user_id_seq
--         using the atomic LAST_INSERT_ID() trick, so concurrent registrations
--         can never draw the same number. The draw variable is declared
--         BIGINT — values can never pass through a DECIMAL (the bug class
--         that once produced 'MED-1.00' style values).
--   * 4-digit contract: the trigger deliberately SIGNALs (fails loudly) if the
--     sequence would exceed MED-9999, rather than silently emitting a 5-digit
--     ID. Remove the IF v_num > 9999 guard to allow natural 5-digit extension
--     (LPAD already handles it) — this is a documented, reversible decision.
--   * The migration is IDEMPOTENT: re-running never renumbers an existing
--     user (only NULL rows are backfilled; the sequence is synced to the
--     observed MAX, never lowered).
--   * Matching is case/hyphen tolerant at the application layer: MED-0001,
--     med-0001, MED0001, and 0001 all resolve to the canonical MED-0001
--     (see AuthService::normalizePublicUserId()).
-- =============================================================================

-- 1. Sequence table (atomic generator for new IDs) ---------------------------
CREATE TABLE IF NOT EXISTS `public_user_id_seq` (
  `id` TINYINT NOT NULL PRIMARY KEY,
  `next_val` BIGINT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `public_user_id_seq` (`id`, `next_val`) VALUES (1, 1);

-- 2. Add the column (idempotent: only when missing) ---------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'profiles'
     AND COLUMN_NAME = 'public_user_id'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `profiles` ADD COLUMN `public_user_id` VARCHAR(20) NULL AFTER `watermark_id`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Backfill existing users (only NULL rows → re-run safe) -------------------
--    Order by created_at (then id as tiebreaker) so IDs are chronologically
--    stable. Offset by the largest already-assigned number so a partial
--    backfill can never collide with existing IDs.
SET @offset = (
  SELECT COALESCE(MAX(CAST(SUBSTRING(p.public_user_id, 5) AS UNSIGNED)), 0)
    FROM profiles p
   WHERE p.public_user_id REGEXP '^MED-[0-9]{4,}$'
);
UPDATE profiles p
JOIN (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
    FROM profiles
   WHERE public_user_id IS NULL
) s ON s.id = p.id
SET p.public_user_id = CONCAT('MED-', LPAD(@offset + s.rn, 4, '0'));

-- 4. Sync the sequence past every assigned ID (never lower it) ----------------
INSERT INTO `public_user_id_seq` (`id`, `next_val`)
VALUES (1, (SELECT COALESCE(MAX(CAST(SUBSTRING(p.public_user_id, 5) AS UNSIGNED)), 0) + 1 FROM profiles p
             WHERE p.public_user_id REGEXP '^MED-[0-9]{4,}$'))
ON DUPLICATE KEY UPDATE `next_val` = GREATEST(`next_val`, VALUES(`next_val`));

-- 5. Tighten: NOT NULL + UNIQUE (idempotent) ----------------------------------
SET @nulls = (SELECT COUNT(*) FROM `profiles` WHERE `public_user_id` IS NULL);
SET @ddl = IF(@nulls = 0,
  'ALTER TABLE `profiles` MODIFY `public_user_id` VARCHAR(20) NOT NULL',
  'SELECT 2');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (
  SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'profiles'
     AND INDEX_NAME = 'uq_profiles_public_user_id'
);
SET @ddl = IF(@idx_exists = 0,
  'ALTER TABLE `profiles` ADD UNIQUE KEY `uq_profiles_public_user_id` (`public_user_id`)',
  'SELECT 3');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6. Assign IDs to ALL future users automatically -----------------------------
--    Replaces the profile-creation trigger so every new user row receives its
--    public ID in the same statement that creates the profile. The LAST_INSERT_ID
--    trick makes the sequence draw atomic per connection (no read-after-write
--    race between concurrent registrations).
--
--    NOTE (phpMyAdmin / MariaDB): the DELIMITER directives below are REQUIRED.
--    Without them the client splits the trigger body on the first `;` and
--    MariaDB rejects the mangled statement with #1064. Same convention as
--    migration 008 and triggers.sql (both proven to import on this server).

DELIMITER $$

DROP TRIGGER IF EXISTS trg_on_auth_user_created $$
CREATE TRIGGER trg_on_auth_user_created
AFTER INSERT ON `users`
FOR EACH ROW
BEGIN
  DECLARE v_num BIGINT;
  DECLARE v_pub VARCHAR(20);

  -- Atomic sequential draw (LAST_INSERT_ID trick: safe under concurrency).
  -- v_num is BIGINT so the value can never pass through a DECIMAL — the exact
  -- bug class that once produced 'MED-1.00' style corrupted values.
  UPDATE public_user_id_seq SET next_val = LAST_INSERT_ID(next_val + 1) WHERE id = 1;
  SET v_num = LAST_INSERT_ID();

  -- Enforce the 4-digit contract: fail loudly (aborting the INSERT with a
  -- clear message) instead of silently producing MED-10000.
  IF v_num > 9999 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'public_user_id exhausted: 4-digit range MED-0001..MED-9999 is full';
  END IF;

  SET v_pub = CONCAT('MED-', LPAD(v_num, 4, '0'));

  INSERT INTO `profiles` (`id`, `email`, `full_name`, `role`, `watermark_id`, `public_user_id`)
  VALUES (
    NEW.`id`,
    COALESCE(NEW.`email`, ''),
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(NEW.`raw_user_meta_data`, '$.full_name')), ''),
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(NEW.`raw_user_meta_data`, '$.role')), 'student'),
    UUID(),
    v_pub
  );
END $$

DELIMITER ;

-- =============================================================================
-- Rollback (manual, only if ever needed — IDs are meant to be permanent):
--   DROP TRIGGER trg_on_auth_user_created;  -- then recreate the pre-009 version
--   ALTER TABLE profiles DROP INDEX uq_profiles_public_user_id;
--   ALTER TABLE profiles DROP COLUMN public_user_id;
--   DROP TABLE public_user_id_seq;
-- =============================================================================
