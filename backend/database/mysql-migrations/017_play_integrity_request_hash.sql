-- 017_play_integrity_request_hash.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Server-side Play Integrity enforcement (tamper-resistance fix).
--
-- Principle: the Android client is untrusted. A modified APK can flip any
-- client-side detection (VPN/adb/root/tamper) to false, so protected backend
-- operations must require a SERVER-VERIFIED Play Integrity verdict that is
-- cryptographically bound to the actual operation.
--
-- Binding model (official requestHash mechanism):
--   1. Client asks the server for a challenge → server generates a random
--      256-bit `request_hash`, stores it (single-use, 5-min TTL) together
--      with the protected action key it authorizes.
--   2. Client passes it to the Play Integrity API (classic request nonce —
--      Google surfaces it in requestDetails.requestHash).
--   3. Client sends the opaque token + request_hash to /integrity/play
--      (action=verify). The BACKEND decodes the token via Google and checks
--      requestPackageName, requestHash, appRecognitionVerdict,
--      certificateSha256Digest, deviceRecognitionVerdict — fail-closed.
--   4. On pass, the verdict is persisted in play_integrity_verdicts, bound
--      to user + action + request_hash with a short TTL, and consumed by
--      protected endpoints (video OTP, redeem, device binding) which look
--      it up via the X-Integrity-Hash header (IntegrityService).
--
-- Nothing client-supplied is ever treated as proof: only the Google-decoded
-- payload writes to play_integrity_verdicts.
--
-- IDEMPOTENCY: follows the project's INFORMATION_SCHEMA + PREPARE pattern
-- (same as 009) — safe to re-run on MySQL. (No MariaDB-only
-- `ADD COLUMN IF NOT EXISTS` syntax.)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Extend the challenge table: request-hash binding + action + consumption.
--    (Legacy `nonce` rows keep working as plain nonces; new rows carry all 3.)

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'play_integrity_nonces'
     AND COLUMN_NAME = 'request_hash'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `play_integrity_nonces` ADD COLUMN `request_hash` CHAR(64) NULL AFTER `user_id`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'play_integrity_nonces'
     AND COLUMN_NAME = 'action'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `play_integrity_nonces` ADD COLUMN `action` VARCHAR(64) NULL AFTER `request_hash`',
  'SELECT 2');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'play_integrity_nonces'
     AND COLUMN_NAME = 'consumed_at'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `play_integrity_nonces` ADD COLUMN `consumed_at` DATETIME(6) NULL AFTER `expires_at`',
  'SELECT 3');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Lookup index for the request_hash (single-use consumption path).
SET @idx_exists = (
  SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'play_integrity_nonces'
     AND INDEX_NAME = 'idx_pi_nonces_request_hash'
);
SET @ddl = IF(@idx_exists = 0,
  'CREATE INDEX `idx_pi_nonces_request_hash` ON `play_integrity_nonces` (`request_hash`)',
  'SELECT 4');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Persisted, Google-decoded verdicts (short-lived, one binding each).
CREATE TABLE IF NOT EXISTS `play_integrity_verdicts` (
  `id` CHAR(36) DEFAULT (UUID()) COMMENT 'pg_default: gen_random_uuid()',
  `user_id` CHAR(36) NOT NULL COMMENT 'owning session user (binding part 1)',
  `request_hash` CHAR(64) NOT NULL COMMENT 'server-issued challenge hash (binding part 2)',
  `action` VARCHAR(64) NOT NULL COMMENT 'protected action this verdict authorizes (binding part 3)',
  `passed` TINYINT(1) DEFAULT 0 NOT NULL COMMENT 'Google-verified pass',
  `verdict` TEXT NULL COMMENT 'raw verdict summary for audit (app;device;cert)',
  `cert_sha256` VARCHAR(64) NULL COMMENT 'signing-cert digest reported by Google (lowercase hex, no colons)',
  `ip_address` VARCHAR(45) NULL,
  `created_at` DATETIME(6) DEFAULT CURRENT_TIMESTAMP NOT NULL COMMENT 'pg_default: now()',
  `expires_at` DATETIME(6) NOT NULL COMMENT 'verdict TTL — protected endpoints reject stale verdicts',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pi_verdicts_hash` (`request_hash`),
  KEY `idx_pi_verdicts_lookup` (`user_id`, `action`, `passed`, `expires_at`),
  CONSTRAINT `fk_pi_verdicts_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Housekeeping: purge expired challenges/verdicts (opportunistic; each
--    verification also deletes stale rows it encounters).
SET @event_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.EVENTS
   WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = 'ev_pi_verdicts_cleanup'
);
SET @ddl = IF(@event_exists = 0,
  'CREATE EVENT `ev_pi_verdicts_cleanup` ON SCHEDULE EVERY 1 HOUR DO BEGIN DELETE FROM play_integrity_nonces WHERE expires_at < UTC_TIMESTAMP(6) - INTERVAL 1 DAY; DELETE FROM play_integrity_verdicts WHERE expires_at < UTC_TIMESTAMP(6) - INTERVAL 1 DAY; END',
  'SELECT 5');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─────────────────────────────────────────────────────────────────────────────
-- OPERATOR POLICY (no code change needed to tune):
--   security_config.play_integrity_enabled = 1 turns verification ON.
--   security_config.extras (JSON) may carry:
--     "play_integrity": {
--       "actions": { "vdo_otp": "enforce", "redeem": "log_only" },
--       "app_verdicts": ["PLAY_RECOGNIZED"],
--       "require_device_integrity": true,
--       "require_cert_match": true,
--       "verdict_ttl_seconds": 300
--     }
--   Default per-action policy is "log_only": verdicts are recorded without
--   blocking anyone until an operator flips a tier to "enforce".
--   security_config.expected_cert_sha256s lists the production signing
--   certificate digest(s) a verdict must carry when require_cert_match=true.
--   SERVER credentials required (never shipped in the APK):
--     GOOGLE_SERVICE_ACCOUNT_JSON  (service account with Play Integrity API)
--     ANDROID_PACKAGE_NAME         (defaults to com.medacademy.app)
-- ─────────────────────────────────────────────────────────────────────────────
