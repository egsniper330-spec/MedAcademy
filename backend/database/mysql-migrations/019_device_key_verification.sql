-- 019_device_key_verification.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- INITIAL DEVICE TRUST hardening (bootstrap-path review fix).
--
-- THREAT: a modified APK could register a Keystore key and immediately sign
-- "all-clean" evidence → TRUSTED on its FIRST verification. Device-key
-- possession proves nothing about APK authenticity, so self-asserted evidence
-- must NEVER be able to create TRUSTED status.
--
-- DESIGN (server-side only; no client input can influence it):
--   * device_keys.verified_at NULL  = UNVERIFIED (bootstrapping).
--   * Signed evidence from an UNVERIFIED key is capped at DEGRADED — it can
--     only LOWER assurance (blocking flags → BLOCKED), never raise it.
--   * The SERVER promotes a key to verified ONLY after server-observed
--     conditions: key age ≥ warmup (policy), account active, device active,
--     and (optionally, if configured) a live Play Integrity verdict exists
--     for the user. Time is the one input an attacker cannot patch.
--   * Enforcement gains an "enforce_strict" tier: requires assurance
--     TRUSTED — i.e. an established (verified) key. "enforce" (DEGRADED+)
--     remains available for bootstrap-tolerant actions like device_bind.
--   * ROLLOUT SAFETY: keys registered BEFORE this migration are grandfathered
--     (verified_at = registered_at) so existing users see no change; only new
--     registrations start unverified. Default tiers stay log_only.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. device_keys.verified_at + verification_note (server-side promotion state)
SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'device_keys'
     AND COLUMN_NAME = 'verified_at'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `device_keys` ADD COLUMN `verified_at` DATETIME(6) NULL AFTER `status`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'device_keys'
     AND COLUMN_NAME = 'verification_note'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE `device_keys` ADD COLUMN `verification_note` VARCHAR(191) NULL AFTER `verified_at`',
  'SELECT 2');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Grandfather existing active keys: their tenure predates this policy and
--    their accounts already carry server-side behavioral history. Idempotent
--    (only touches NULL rows).
UPDATE device_keys
   SET verified_at = registered_at,
       verification_note = 'grandfathered (registered before bootstrap policy)'
 WHERE status = 'active' AND verified_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- OPERATOR POLICY (security_config.extras.device_evidence):
--   "warmup_hours": 24,                 ← server-side key tenure before promotion
--   "promotion_require_integrity": false, ← optionally require a live Play
--                                           Integrity verdict for the user
--   "actions": {
--     "vdo_otp":     "enforce_strict",  ← requires TRUSTED (established key)
--     "redeem":      "enforce_strict",  ← requires TRUSTED (established key)
--     "device_bind": "enforce"          ← bootstrap-tolerant (DEGRADED ok)
--   }
--   Tiers: log_only | enforce (DEGRADED+) | enforce_strict (TRUSTED only)
-- ─────────────────────────────────────────────────────────────────────────────
