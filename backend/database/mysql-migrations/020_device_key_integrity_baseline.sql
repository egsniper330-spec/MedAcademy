-- 020_device_key_integrity_baseline.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Server-anchored INTEGRITY BASELINE (Phase 2/3/4 gap closure).
--
-- THREAT: self-attested integrity (a client hash compared against a constant
-- the client itself carries) is trivially patchable. Real anchoring requires
-- the SERVER to know what the legitimate binary looks like.
--
-- MODEL
--   1. The FIRST genuine client to register a key for (user, fingerprint)
--      records the SHA-256 of its runtime binary measurement.
--   2. The server stores it as the BASELINE for that device binding.
--      (Production hardening, optional: an operator can pin the official
--      release measurement in security_config.extras.device_evidence
--      .integrity_baseline_sha256 — every client is then compared against
--      the pinned value instead of first-seen-wins.)
--   7. Every evidence verification re-measures the binary; a mismatch vs the
--      stored baseline → BLOCKED (reason integrity_mismatch) and recorded.
--   8. All APK-identity questions remain Google's job (Play Integrity layer);
--      this binds the Keystore identity to A binary — not necessarily the
--      OFFICIAL one. That limitation is explicit and documented.
--
-- IDEMPOTENCY: INFORMATION_SCHEMA + PREPARE pattern (project convention).
-- ─────────────────────────────────────────────────────────────────────────────

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'device_keys'
     AND COLUMN_NAME = 'integrity_baseline_sha256'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `device_keys` ADD COLUMN `integrity_baseline_sha256` CHAR(64) NULL AFTER `verification_note`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'device_keys'
     AND COLUMN_NAME = 'integrity_last_sha256'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `device_keys` ADD COLUMN `integrity_last_sha256` CHAR(64) NULL AFTER `integrity_baseline_sha256`',
  'SELECT 2');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'device_keys'
     AND COLUMN_NAME = 'integrity_last_at'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `device_keys` ADD COLUMN `integrity_last_at` DATETIME(6) NULL AFTER `integrity_last_sha256`',
  'SELECT 3');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Per-decision integrity state (Part 14): the enforcement layer must be able
-- to reject a decision row whose binary measurement failed, independently of
-- the assurance tier. Values: ok | rejected | absent | unavailable.
SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'security_evidence'
     AND COLUMN_NAME = 'integrity_state'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `security_evidence` ADD COLUMN `integrity_state` VARCHAR(16) NULL AFTER `assurance`',
  'SELECT 4');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Operator hardening (documented; applied via security_config when ready):
--   security_config.extras.device_evidence.integrity_pinned_sha256 =
--     "<runtime_sha256 measured by collectBinaryIntegrity() on the OFFICIAL
--      release APK>"
--   When set, first-seen-wins is bypassed: every measurement must equal the
--   pinned value (SecurityEvidenceService::pinnedIntegrityBaseline).
--   Compute it by running the official release build and calling
--   ensureDeviceKeyRegistered() once on a clean device, then reading
--   device_keys.integrity_last_sha256 of a KNOWN-GOOD registration.
