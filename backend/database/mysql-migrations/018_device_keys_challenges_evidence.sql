-- 018_device_keys_challenges_evidence.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Device-bound cryptographic evidence layer (Phases 3–7).
--
-- MODEL
--   CLIENT  = sensor + evidence producer (Android Keystore signs, never trusts)
--   BACKEND = final security/authorization authority (verifies everything)
--   DB      = authoritative state (keys, challenges, verdicts)
--
--   1. Client generates an EC P-256 keypair IN Android Keystore (private key
--      never leaves the TEE/StrongBox — it is not exportable by design).
--   2. Client registers the PUBLIC key + key id with the backend, bound to
--      (user, device fingerprint). Server records status active/revoked.
--   3. For a protected action the client asks the server for a CHALLENGE:
--      unpredictable 256-bit nonce, short-lived, SINGLE-USE, bound to
--      (user, device, session, action, request_hash).
--   4. Client signs CANONICAL evidence (JSON, sorted keys) with the Keystore
--      private key and sends challenge + evidence + signature.
--   5. Backend verifies: signature (server-stored public key), challenge
--      freshness/single-use/user/device/session/action/request-hash binding,
--      counter progression (anti-replay), evidence schema, then derives a
--      SECURITY ASSURANCE verdict from the evidence + server-side state and
--      applies the per-action policy. The decision row (security_evidence)
--      is the ONLY thing that can authorize the protected call.
--
-- This is NOT Google Play Integrity and NOT App Attest: the Keystore key
-- proves possession of a device key, not the genuineness of the APK. The
-- existing /integrity/play flow (migration 017) remains the APK-genuineness
-- layer; these compose as independent gates.
--
-- IDEMPOTENCY: follows the project's INFORMATION_SCHEMA + PREPARE pattern
-- (same as 009/017) — safe to re-run on MySQL.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. device_keys — public half of each device key (private half never leaves
--    the device's Keystore). Reinstall/new key = new row; old row superseded.
CREATE TABLE IF NOT EXISTS `device_keys` (
  `id` CHAR(36) DEFAULT (UUID()) COMMENT 'pg_default: gen_random_uuid()',
  `user_id` CHAR(36) NOT NULL COMMENT 'owner profile',
  `device_id` CHAR(36) NULL COMMENT 'devices.id this key belongs to (nullable: key may register before device row exists)',
  `device_fingerprint` VARCHAR(191) NOT NULL COMMENT 'existing device fingerprint (mirrors devices.device_fingerprint)',
  `key_id` VARCHAR(64) NOT NULL COMMENT 'client-chosen stable identifier for the Keystore alias (public value)',
  `public_key_pem` TEXT NOT NULL COMMENT 'SPKI PEM (EC P-256) — public material only',
  `keystore_security` VARCHAR(32) NOT NULL DEFAULT 'unknown' COMMENT 'strongbox | tee | software (client-reported, NOT security-critical)',
  `status` VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active | revoked | superseded',
  `counter` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'server-tracked monotonic signature counter (anti-replay)',
  `registered_at` DATETIME(6) DEFAULT CURRENT_TIMESTAMP NOT NULL COMMENT 'pg_default: now()',
  `last_used_at` DATETIME(6) NULL,
  `revoked_at` DATETIME(6) NULL,
  `revoked_reason` VARCHAR(191) NULL,
  `revoked_by` CHAR(36) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device_keys_user_key` (`user_id`, `key_id`),
  KEY `idx_device_keys_fingerprint` (`device_fingerprint`),
  KEY `idx_device_keys_status` (`status`),
  CONSTRAINT `fk_device_keys_user` FOREIGN KEY (`user_id`) REFERENCES `profiles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_device_keys_revoked_by` FOREIGN KEY (`revoked_by`) REFERENCES `profiles` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. security_challenges — single-use, server-issued challenges. The
--    authoritative bindings (user, device, session, action, request_hash)
--    live HERE; a client can never mint or re-scope one.
CREATE TABLE IF NOT EXISTS `security_challenges` (
  `id` CHAR(36) DEFAULT (UUID()) COMMENT 'pg_default: gen_random_uuid()',
  `challenge` CHAR(64) NOT NULL COMMENT '256-bit random hex — unpredictable, server-generated',
  `user_id` CHAR(36) NOT NULL,
  `device_id` CHAR(36) NULL COMMENT 'bound device (devices.id) when known at issue time',
  `device_fingerprint` VARCHAR(191) NULL,
  `session_id` VARCHAR(64) NULL COMMENT 'access-token jti / device binding the challenge is bound to',
  `action` VARCHAR(64) NOT NULL COMMENT 'protected action key (whitelist-checked at issue time)',
  `request_hash` CHAR(64) NULL COMMENT 'hash of the exact request body this challenge may authorize',
  `counter_at_issue` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'device key counter snapshot (client must present counter > this)',
  `consumed_at` DATETIME(6) NULL COMMENT 'set transactionally on first use (single-use guarantee)',
  `expires_at` DATETIME(6) NOT NULL,
  `created_at` DATETIME(6) DEFAULT CURRENT_TIMESTAMP NOT NULL COMMENT 'pg_default: now()',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_security_challenges_challenge` (`challenge`),
  KEY `idx_sec_challenges_lookup` (`user_id`, `action`, `expires_at`),
  KEY `idx_sec_challenges_expiry` (`expires_at`),
  CONSTRAINT `fk_sec_challenges_user` FOREIGN KEY (`user_id`) REFERENCES `profiles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. security_evidence — every verification decision (pass AND fail) for
--    audit + the assurance row protected endpoints consult.
CREATE TABLE IF NOT EXISTS `security_evidence` (
  `id` CHAR(36) DEFAULT (UUID()) COMMENT 'pg_default: gen_random_uuid()',
  `user_id` CHAR(36) NOT NULL,
  `device_key_id` CHAR(36) NULL COMMENT 'device_keys.id used to sign (NULL for failed verifications)',
  `challenge_id` CHAR(36) NULL COMMENT 'security_challenges.id consumed by this decision',
  `action` VARCHAR(64) NOT NULL,
  `assurance` VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN' COMMENT 'UNKNOWN | DEGRADED | TRUSTED | BLOCKED',
  `passed` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = accepted as evidence for the action',
  `reason` VARCHAR(191) NULL COMMENT 'machine-readable failure reason (signature_invalid, challenge_reused, …)',
  `evidence_json` JSON NULL COMMENT 'the canonical evidence the client signed (schema-versioned)',
  `assurance_detail` JSON NULL COMMENT 'server-derived assurance breakdown (signal → verdict)',
  `ip_address` VARCHAR(45) NULL,
  `created_at` DATETIME(6) DEFAULT CURRENT_TIMESTAMP NOT NULL COMMENT 'pg_default: now()',
  `expires_at` DATETIME(6) NOT NULL COMMENT 'decision TTL for the protected-call lookup',
  PRIMARY KEY (`id`),
  KEY `idx_sec_evidence_lookup` (`user_id`, `action`, `passed`, `expires_at`),
  KEY `idx_sec_evidence_challenge` (`challenge_id`),
  CONSTRAINT `fk_sec_evidence_user` FOREIGN KEY (`user_id`) REFERENCES `profiles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. security_events.event_type CHECK allowlist: add the evidence-layer
--    event types so verification decisions are auditable (CHECK constraints
--    are enforced — an unlisted type would make the audit insert fail).
--
--    MARIA DB COMPATIBILITY NOTE (live-import fix):
--    * `ALTER TABLE ... DROP CHECK name` is MySQL 8-only syntax and fails to
--      PARSE on MariaDB (#1064 near the constraint name). MariaDB 10.2.1+
--      uses `DROP CONSTRAINT name` for named CHECK constraints instead.
--    * The existence guard uses INFORMATION_SCHEMA.TABLE_CONSTRAINTS
--      (available since MariaDB 10.0) rather than CHECK_CONSTRAINTS, so the
--      guard itself parses on every supported version.
--    * The ADD runs as direct DDL with the FULL allowlist: all 22 existing
--      event types PRESERVED + the 3 new evidence types. Nothing is removed.
--    * Idempotent by construction: re-running drops the constraint and
--      re-adds the identical list (schema-identical, data untouched).
SET @chk_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'security_events'
     AND CONSTRAINT_TYPE = 'CHECK'
     AND CONSTRAINT_NAME = 'chk_security_events_event_type'
);
SET @ddl = IF(@chk_exists > 0,
  'ALTER TABLE `security_events` DROP CONSTRAINT `chk_security_events_event_type`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE `security_events`
  ADD CONSTRAINT `chk_security_events_event_type` CHECK (`event_type` IN (
    'root_detected', 'jailbreak_detected', 'vpn_detected', 'proxy_detected',
    'ssl_pinning_failure', 'screenshot_detected', 'screen_recording_detected',
    'debug_detected', 'frida_detected', 'xposed_detected',
    'app_integrity_compromised', 'developer_options_enabled', 'adb_enabled',
    'debugger_attached', 'magisk_detected', 'overlay_detected',
    'signature_invalid', 'tamper_detected', 'play_integrity_failed',
    'play_integrity_passed', 'detection_unavailable', 'app_attest_failed',
    'security_evidence_verified', 'security_evidence_rejected',
    'security_evidence_enforcement_failed'
  ));

-- 5. Housekeeping. The event body contains semicolons, so it is created via
--    a single PREPAREd statement (same proven pattern as migration 017, which
--    imported cleanly on the live MariaDB): the body lives inside a string
--    literal, so client-side statement splitters (phpMyAdmin) cannot break
--    it, and `CREATE EVENT` is valid PREPARE syntax on MariaDB.
--    Idempotent via the INFORMATION_SCHEMA.EVENTS guard.
--    NOTE: the event is CREATED regardless of scheduler state, but only
--    EXECUTES when event_scheduler=ON. Verify with:
--      SHOW VARIABLES LIKE 'event_scheduler';
--    If OFF, enable it (SET GLOBAL event_scheduler = ON; requires SUPER and
--    may need event_scheduler=ON in the server config to persist) or run the
--    purge statements via cron instead.
SET @event_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.EVENTS
   WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = 'ev_sec_evidence_cleanup'
);
SET @ddl = IF(@event_exists = 0,
  'CREATE EVENT `ev_sec_evidence_cleanup` ON SCHEDULE EVERY 1 HOUR DO BEGIN DELETE FROM security_challenges WHERE expires_at < UTC_TIMESTAMP(6) - INTERVAL 1 DAY; DELETE FROM security_evidence WHERE expires_at < UTC_TIMESTAMP(6) - INTERVAL 1 DAY; END',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─────────────────────────────────────────────────────────────────────────────
-- OPERATOR POLICY (no code change needed to tune):
--   security_config.extras (JSON) may carry:
--     "device_evidence": {
--       "actions": { "vdo_otp": "log_only", "redeem": "enforce", "device_bind": "enforce" },
--       "challenge_ttl_seconds": 120,
--       "evidence_ttl_seconds": 180,
--       "min_counter_gap": 1,
--       "require_registered_key": true
--     }
--   Default per-action tier is "log_only" (record + audit, never block) so no
--   legitimate user is locked out before key registration rolls out. Flip to
--   "enforce" per action once the client fleet has registered keys.
--   Existing blocking policies (VPN, developer_options, debug, tamper, …) in
--   security_policies are UNCHANGED by this migration.
-- ─────────────────────────────────────────────────────────────────────────────
