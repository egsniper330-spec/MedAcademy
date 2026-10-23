-- ============================================================================
-- 036_public_user_id_five_digits.sql
--
-- Widens the user-facing public id (`profiles.public_user_id`, the "MED-…"
-- identifier on every profile, watermark, search result and admin screen) from
-- the four-digit range to FIVE digits, and defines what happens when the last
-- sequential value is used.
--
-- BEFORE (migration 009/010)
--   trg_on_auth_user_created drew the next value from `public_user_id_seq` and
--   SIGNALled at 10000 ("4-digit range MED-0001..MED-9999 is full"). A shop that
--   reached MED-9999 therefore could not create any more users at all.
--
-- AFTER (this migration)
--   MED-0001 … MED-9999      four digits, zero padded — unchanged
--   MED-10000 … MED-99999    five digits, no padding needed
--   never six digits, never MED-0000, never a reused value.
--
--   While the sequence is inside 1..99999 the next unused sequential value is
--   issued. Once the sequence has passed 99999 (i.e. MED-99999 was allocated)
--   the trigger switches to a RANDOM five-digit candidate (10000..99999),
--   checks it is free and retries a bounded number of times. If no free value
--   remains it SIGNALs a clear exhaustion error instead of duplicating,
--   shortening or widening the id.
--
--   NOTE ON THE NAMESPACE: there are exactly 100,000 five-digit spellings
--   (MED-00000..MED-99999) and the sequential run consumes 1..99999. After
--   MED-99999 the random fallback can therefore only fill *gaps* (numbers
--   burned by rolled-back creations or legacy imports), which is the correct
--   and safe behaviour: nothing is re-issued, and a full namespace fails loudly.
--
-- UNIQUENESS
--   `uq_profiles_public_user_id` is (re)asserted here. Migration 009 already
--   added it on deployed databases; a schema.sql-only install previously had no
--   such index, so this migration makes the guarantee explicit everywhere.
--   The index is the hard guard: even a race between two concurrent random
--   draws cannot store the same id twice.
--
-- WHAT THIS MIGRATION DOES **NOT** DO
--   * It does NOT renumber, rewrite or delete a single existing id.
--   * It does NOT reset or lower the sequence (GREATEST is used).
--   * It does NOT touch the internal CHAR(36) primary key or any foreign key.
--   * It does NOT widen the column — VARCHAR(20) already holds MED-99999.
--   * If duplicate public_user_id values somehow exist, it does NOT "fix" them
--     (that would change real users' ids); it reports them and leaves the index
--     creation to you after a deliberate decision. See the query in step 3.
--
-- PRECONDITIONS
--   Migrations 009_public_user_id.sql and 010_fix_public_user_id.sql applied
--   (i.e. `profiles.public_user_id` exists and `public_user_id_seq` exists).
--
-- HOW TO APPLY (phpMyAdmin → select database → Import → choose this file)
--   Order relative to the code: run this migration BEFORE uploading the new
--   backend files. The new PHP allocator only *supplies* a value that this
--   trigger version validates; running the code first would leave the old
--   4-digit ceiling in place until the migration is applied.
--
--   Re-running this file is harmless: the sequence sync is a no-op, the index
--   step is skipped when it already exists, and the trigger is DROP+CREATE.
--
-- ROLLBACK (only if you must go back to the 4-digit build)
--   Re-import migration 009's trigger section. Do NOT shrink the column and do
--   NOT delete ids above 9999 — they are real users.
-- ============================================================================

-- ── 1. Sequence semantics + sync (never lowered) ───────────────────────────
-- next_val now means "the LAST ISSUED numeric value" (0 = nothing issued yet),
-- so the next draw is next_val + 1 and a fresh sequence issues MED-0001 first.
-- GREATEST() keeps a database whose sequence is already ahead.
SET @max_issued = (
  SELECT COALESCE(MAX(CAST(SUBSTRING(p.`public_user_id`, 5) AS UNSIGNED)), 0)
    FROM `profiles` p
   WHERE p.`public_user_id` REGEXP '^MED-[0-9]{4,5}$'
);

INSERT INTO `public_user_id_seq` (`id`, `next_val`)
VALUES (1, @max_issued)
ON DUPLICATE KEY UPDATE `next_val` = GREATEST(`next_val`, VALUES(`next_val`));

-- ── 2. Unique index (the hard duplicate guard) ─────────────────────────────
SET @idx_exists = (
  SELECT COUNT(DISTINCT `INDEX_NAME`)
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'profiles'
     AND INDEX_NAME = 'uq_profiles_public_user_id'
);

-- ── 3. Duplicate report — MUST be empty before the index is added ──────────
-- This SELECT always runs so the result is visible in phpMyAdmin. An empty
-- result set means "no duplicates"; any row means existing ids collide and the
-- index below is intentionally NOT created until you resolve them.
SELECT `public_user_id` AS duplicate_public_user_id, COUNT(*) AS copies
  FROM `profiles`
 GROUP BY `public_user_id`
HAVING COUNT(*) > 1;

SET @dup_groups = (
  SELECT COUNT(*)
    FROM (
      SELECT `public_user_id`
        FROM `profiles`
       GROUP BY `public_user_id`
      HAVING COUNT(*) > 1
    ) d
);

SET @ddl = IF(
  @idx_exists = 0 AND @dup_groups = 0,
  'ALTER TABLE `profiles` ADD UNIQUE KEY `uq_profiles_public_user_id` (`public_user_id`)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ── 4. The allocator trigger ───────────────────────────────────────────────
-- Replaces the 4-digit version from migration 009/010. Three sources of an id,
-- in order: (1) the value the application already allocated and passed in
-- `raw_user_meta_data.public_user_id` (validated here, never trusted blindly),
-- (2) the atomic sequential draw while the namespace lasts, (3) the bounded
-- random five-digit fallback. Every branch is inside the trigger's own
-- transaction, and the sequence row lock serializes concurrent creations.
-- DELIMITER is REQUIRED for phpMyAdmin/MariaDB: without it the client splits
-- the trigger body on the first `;` and the server rejects the mangled
-- statement with #1064. Same convention as migrations 008/009.
DELIMITER $$

DROP TRIGGER IF EXISTS trg_on_auth_user_created $$

CREATE TRIGGER trg_on_auth_user_created
AFTER INSERT ON `users`
FOR EACH ROW
BEGIN
  DECLARE v_num BIGINT DEFAULT 0;
  DECLARE v_pub VARCHAR(20) DEFAULT '';
  DECLARE v_supplied VARCHAR(20) DEFAULT '';
  DECLARE v_taken INT DEFAULT 0;
  DECLARE v_tries INT DEFAULT 0;

  -- (1) Application-supplied id (PublicUserIdService, CSPRNG random tail).
  -- Accepted only when canonical (MED- + 4/5 digits, value 1..99999, exactly
  -- the canonical spelling) AND currently free. Anything else is ignored and
  -- allocated below, so a stale/forged meta value can never become a stored id.
  SET v_supplied = COALESCE(
    JSON_UNQUOTE(JSON_EXTRACT(NEW.`raw_user_meta_data`, '$.public_user_id')),
    ''
  );
  IF v_supplied REGEXP '^MED-[0-9]{4,5}$'
     AND CAST(SUBSTRING(v_supplied, 5) AS UNSIGNED) BETWEEN 1 AND 99999
     AND CONCAT('MED-', LPAD(CAST(SUBSTRING(v_supplied, 5) AS UNSIGNED), 4, '0')) = v_supplied THEN
    SELECT COUNT(*) INTO v_taken FROM `profiles` WHERE `public_user_id` = v_supplied;
    IF v_taken = 0 THEN
      SET v_pub = v_supplied;
    END IF;
  END IF;

  -- (2) Sequential draw, MED-0001..MED-99999.
  -- LAST_INSERT_ID trick: the UPDATE takes the row lock and returns the value it
  -- wrote, so no two creations can read the same number. v_num is BIGINT so the
  -- value never passes through a DECIMAL (the old 'MED-1.00' corruption).
  IF v_pub = '' THEN
    UPDATE `public_user_id_seq` SET `next_val` = LAST_INSERT_ID(`next_val` + 1) WHERE `id` = 1;
    SET v_num = LAST_INSERT_ID();

    IF v_num BETWEEN 1 AND 99999 THEN
      SET v_pub = CONCAT('MED-', LPAD(v_num, 4, '0'));
      -- A restored dump or a hand-written row may already hold this number:
      -- never reuse it, fall through to the random tail.
      SELECT COUNT(*) INTO v_taken FROM `profiles` WHERE `public_user_id` = v_pub;
      IF v_taken > 0 THEN
        SET v_pub = '';
      END IF;
    END IF;
  END IF;

  -- (3) Random five-digit fallback, only reachable once the sequence passed
  -- 99999 (or the sequential number was already taken). Bounded: 40 attempts,
  -- then an explicit failure — never a duplicate, never a sixth digit.
  WHILE v_pub = '' DO
    IF v_tries >= 40 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'public_user_id exhausted: no free value remains in MED-0001..MED-99999';
    END IF;
    SET v_num = 10000 + FLOOR(RAND() * 90000);
    SET v_pub = CONCAT('MED-', v_num);
    SELECT COUNT(*) INTO v_taken FROM `profiles` WHERE `public_user_id` = v_pub;
    IF v_taken > 0 THEN
      SET v_pub = '';
    END IF;
    SET v_tries = v_tries + 1;
  END WHILE;

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

-- ── 5. Verification (read-only — keep the output with your deployment notes) ─
-- Every row should be canonical and NONE should be six digits.
SELECT
  COUNT(*)                                                        AS total_profiles,
  SUM(`public_user_id` REGEXP '^MED-[0-9]{4,5}$')                  AS canonical_ids,
  SUM(`public_user_id` REGEXP '^MED-[0-9]{6,}$')                   AS six_digit_ids,
  SUM(`public_user_id` = 'MED-0000')                               AS placeholder_ids,
  MAX(CAST(SUBSTRING(`public_user_id`, 5) AS UNSIGNED))            AS highest_numeric_value
FROM `profiles`;

SELECT `next_val` AS last_issued_numeric, `next_val` + 1 AS next_sequential_attempt
  FROM `public_user_id_seq`
 WHERE `id` = 1;
