-- =============================================================================
-- Migration 010: Repair Public User ID decimal corruption (MED-1.00 → MED-0001)
-- =============================================================================
-- WHY THIS EXISTS
--   An early revision of migration 009 produced DECIMAL-formatted values on
--   some rows — e.g. "MED-1.00", "MED-2.00" — because LPAD() received the
--   DECIMAL string "1.00" (already 4 chars, so LPAD left it untouched) instead
--   of the integer 1. phpMyAdmin also logged #1292 warnings when re-running
--   009's CAST(... AS UNSIGNED) over those corrupted strings.
--
-- WHAT THIS MIGRATION DOES (all steps idempotent — safe to re-run)
--   1. Ensures public_user_id_seq.next_val is a true integer column (BIGINT).
--   2. Temporarily drops the unique index so repairs can never abort midway
--      (it is re-created at the very end, after all repairs are consistent).
--   3. Repairs every malformed public_user_id by taking the INTEGER PART of
--      the stored value ("MED-1.00" → 1 → "MED-0001"). CAST(... AS DECIMAL(20,0))
--      is used instead of CAST(... AS UNSIGNED) so MariaDB never emits #1292.
--      Already-canonical values ("MED-0001") are re-derived to the same string
--      and therefore unchanged.
--   4. If two rows repaired to the same number (defensive; unique sequence
--      draws make this near-impossible), the later row is re-numbered from
--      the sequence. NULL rows (if any) are assigned fresh numbers too.
--   5. Re-syncs the sequence past the highest assigned number (never lowers).
--   6. Recreates trg_on_auth_user_created (integer-only MED-#### generation,
--      atomic LAST_INSERT_ID sequence draw) so NEW users always get clean IDs.
--   7. Enforces NOT NULL + UNIQUE last.
--
-- The internal CHAR(36) UUID primary key, all foreign keys, and watermark_id
-- are NOT touched. ID assignment stays database-authoritative.
-- =============================================================================

-- 1. Sequence table — force integer type --------------------------------------
SET @col_type = (
  SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'public_user_id_seq'
     AND COLUMN_NAME  = 'next_val'
);
SET @ddl = IF(@col_type IS NULL,
  'CREATE TABLE IF NOT EXISTS `public_user_id_seq` (`id` TINYINT NOT NULL PRIMARY KEY, `next_val` BIGINT NOT NULL DEFAULT 1) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  IF(@col_type <> 'bigint',
     'ALTER TABLE `public_user_id_seq` MODIFY `next_val` BIGINT NOT NULL',
     'SELECT 1'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO `public_user_id_seq` (`id`, `next_val`) VALUES (1, 1);

-- 2. Ensure the column exists (in case 009 never completed) --------------------
SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'profiles'
     AND COLUMN_NAME = 'public_user_id'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `profiles` ADD COLUMN `public_user_id` VARCHAR(20) NULL AFTER `watermark_id`',
  'SELECT 2');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Temporarily drop the unique index (repairs must never abort midway) -------
SET @idx_exists = (
  SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'profiles'
     AND INDEX_NAME = 'uq_profiles_public_user_id'
);
SET @ddl = IF(@idx_exists > 0,
  'ALTER TABLE `profiles` DROP INDEX `uq_profiles_public_user_id`',
  'SELECT 3');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Repair malformed values (integer part → canonical MED-####) ---------------
--    Canonical regex: '^MED-[0-9]{4,}$'. Eligible for repair — pure-numeric
--    payloads only, so the CAST below can NEVER emit a warning:
--      - "MED-1.00"  → integer part 1   → "MED-0001"  (observed corruption)
--      - "MED-42.00" → integer part 42  → "MED-0042"
--      - "MED-16"    → integer part 16  → "MED-0016"  (re-padded short ID)
--    The user's allocated number is PRESERVED (integer part of the stored
--    value) — IDs are never re-derived from the internal UUID primary key.
--    Rows failing even the eligibility pattern (unexpected garbage) are left
--    untouched and reported by the verification queries at the bottom.
--    CAST(x AS DECIMAL(20,0)) parses "1.00" as 1 with NO warning — casting
--    that same string AS UNSIGNED is what produced the #1292 warnings.
UPDATE `profiles`
   SET `public_user_id` = CONCAT(
         'MED-',
         LPAD(CAST(SUBSTRING(`public_user_id`, 5) AS DECIMAL(20,0)), 4, '0')
       )
 WHERE `public_user_id` IS NOT NULL
   AND `public_user_id` NOT REGEXP '^MED-[0-9]{4,}$'
   AND `public_user_id` REGEXP '^MED-[0-9]+([.][0-9]+)?$';

-- 5. De-duplicate (defensive) — later duplicates lose their value and are ------
--    re-numbered below with the other NULLs (deterministic, ordered backfill).
--    Runs AFTER the repair, so every value is canonical and these casts are
--    warning-free.
UPDATE `profiles` p
JOIN (
  SELECT id FROM (
    SELECT p2.id,
           ROW_NUMBER() OVER (
             PARTITION BY CAST(SUBSTRING(p2.`public_user_id`, 5) AS UNSIGNED)
             ORDER BY p2.`created_at`, p2.`id`
           ) AS dup_rank
      FROM `profiles` p2
     WHERE p2.`public_user_id` REGEXP '^MED-[0-9]{4,}$'
  ) r
  WHERE r.dup_rank > 1
) s ON s.id = p.id
SET p.`public_user_id` = NULL;

-- 6. Assign fresh numbers to every row that still has none ---------------------
--    Offset by the largest already-assigned number so nothing can collide.
SET @offset = (
  SELECT COALESCE(MAX(CAST(SUBSTRING(p.`public_user_id`, 5) AS UNSIGNED)), 0)
    FROM `profiles` p
   WHERE p.`public_user_id` REGEXP '^MED-[0-9]{4,}$'
);
UPDATE `profiles` p
JOIN (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
    FROM `profiles`
   WHERE `public_user_id` IS NULL
) s ON s.id = p.id
SET p.`public_user_id` = CONCAT('MED-', LPAD(@offset + s.rn, 4, '0'));

-- 7. Re-sync the sequence past every assigned ID (never lower it) --------------
INSERT INTO `public_user_id_seq` (`id`, `next_val`)
VALUES (1, (SELECT COALESCE(MAX(CAST(SUBSTRING(p.`public_user_id`, 5) AS UNSIGNED)), 0) + 1 FROM `profiles` p
             WHERE p.`public_user_id` REGEXP '^MED-[0-9]{4,}$'))
ON DUPLICATE KEY UPDATE `next_val` = GREATEST(`next_val`, VALUES(`next_val`));

-- 8. Trigger — integer-only MED-#### generation for every new user -------------
--    NOTE: DELIMITER directives are REQUIRED for phpMyAdmin imports (client
--    directive, not server SQL). Same convention as 008 / 009 / triggers.sql.
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

-- 9. Tighten: NOT NULL + UNIQUE (re-created after all repairs) -----------------
SET @nulls = (SELECT COUNT(*) FROM `profiles` WHERE `public_user_id` IS NULL);
SET @ddl = IF(@nulls = 0,
  'ALTER TABLE `profiles` MODIFY `public_user_id` VARCHAR(20) NOT NULL',
  'SELECT 9');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (
  SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'profiles'
     AND INDEX_NAME = 'uq_profiles_public_user_id'
);
SET @ddl = IF(@idx_exists = 0,
  'ALTER TABLE `profiles` ADD UNIQUE KEY `uq_profiles_public_user_id` (`public_user_id`)',
  'SELECT 10');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- =============================================================================
-- VERIFICATION QUERIES (run manually after import — all must return 0/empty):
--   -- zero malformed IDs:
--   SELECT id, public_user_id FROM profiles
--    WHERE public_user_id IS NULL OR public_user_id NOT REGEXP '^MED-[0-9]{4,}$';
--   -- zero duplicates:
--   SELECT public_user_id, COUNT(*) c FROM profiles
--    GROUP BY public_user_id HAVING c > 1;
--   -- sequence type + value:
--   SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'public_user_id_seq'
--      AND COLUMN_NAME = 'next_val';          -- must be: bigint
--   SELECT * FROM public_user_id_seq;          -- next_val > highest MED number
--   SHOW TRIGGERS LIKE 'users';                -- trg_on_auth_user_created present
-- =============================================================================
