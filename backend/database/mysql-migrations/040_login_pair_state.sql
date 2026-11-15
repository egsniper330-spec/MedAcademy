-- ============================================================================
-- 040_login_pair_state.sql
--
-- Progressive login cooldown state, keyed to (source IP, normalized identifier).
--
-- WHY
--   The per-IP limiter (rate_limits, fixed window) caps total throughput from
--   one source but cannot slow a targeted guessing run against one account
--   spread across many attempts. This table holds exponential cooldown state
--   for each source+identifier PAIR. It deliberately does NOT lock an account:
--   a failure from one source never affects a legitimate user on another source.
--
-- PRIVACY
--   pair_key is HMAC-SHA256(LOGIN_THROTTLE_HMAC_KEY, ip | normalized identifier),
--   hex encoded. No raw e-mail, phone, Public User ID, user id or IP is stored.
--
-- WHY NOT rate_limits
--   rate_limits is a fixed window with no per-row cooldown timestamp; it cannot
--   express "next attempt allowed at T" and grows the cooldown on every hit.
--
-- SAFETY
--   Additive only: one new table. No existing row or column is touched.
--
-- HOW TO APPLY (LATER — not applied to production by this change)
--   phpMyAdmin → MedAcademy database → Import, or paste into the SQL tab. Run ONCE.
-- ============================================================================

CREATE TABLE IF NOT EXISTS `login_pair_state` (
  `pair_key`        CHAR(64)     NOT NULL,
  `fail_count`      INT UNSIGNED NOT NULL DEFAULT 0,
  `last_failure_at` DATETIME(6)  NULL,
  `next_allowed_at` DATETIME(6)  NULL,
  PRIMARY KEY (`pair_key`),
  KEY `idx_login_pair_state_last_failure` (`last_failure_at`),
  KEY `idx_login_pair_state_next_allowed` (`next_allowed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
