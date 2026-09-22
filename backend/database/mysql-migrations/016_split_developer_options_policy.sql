-- ===========================================================================
-- Migration 016 (v2 — REVISED) — Developer Options = MANDATORY SECURITY BLOCK
-- ===========================================================================
-- OWNER REQUIREMENT (supersedes the v1 warn-only split):
--   ALL FOUR Android debug states are blocking conditions:
--     developer_options_enabled (the toggle itself)   → BLOCK
--     adb_enabled               (USB debugging)       → BLOCK
--     debugger_attached         (live debugger)       → BLOCK
--     debug_detected            (test-only build)     → BLOCK
--
-- ROOT CAUSE of the v1 failure (MySQL/MariaDB error #4025):
--   "CONSTRAINT chk_security_policies_detection_type failed"
--   The production schema (backend/database/schema.sql:1324) defines:
--     CHECK (detection_type IN ('root_jailbreak','vpn','proxy','ssl_pinning',
--            'debug','screenshot','screen_recording','app_integrity',
--            'developer_options','frida','xposed','magisk','overlay','tamper',
--            'play_integrity'))
--   v1 tried to INSERT rows with detection_type 'debug_adb'/'debug_options',
--   which are NOT in that allowlist → the CHECK rejected the INSERT.
--
-- CORRECT ARCHITECTURE (no constraint weakening, no schema change):
--   * The four states remain technically separate EVENT types on the wire
--     (developer_options_enabled / adb_enabled / debugger_attached /
--     debug_detected) so the security_events audit trail records exactly
--     which surface is present.
--   * At the POLICY layer they map onto the two CHECK-allowlisted buckets:
--       developer_options → developer_options_enabled + adb_enabled
--       debug             → debug_detected  + debugger_attached
--     and BOTH buckets are set to block_login + enabled.
--   * The client detector (src/lib/security.ts DETECTION_TO_EVENT) maps the
--     same way; server security_policies remains the authoritative source.
--
-- IDEMPOTENT & SAFE:
--   * UPDATEs touch ONLY the two target rows — no other policy is altered.
--   * INSERTs are guarded by NOT EXISTS (no duplicate-key error, no clobber).
--   * No rows are deleted. No CHECK constraint is modified or dropped.
--   * Safe to re-run; each statement is a no-op once applied.
-- ===========================================================================

-- 1) Inert Developer Options toggle → MANDATORY BLOCK
UPDATE security_policies
SET action = 'block_login',
    enabled = 1,
    updated_at = CURRENT_TIMESTAMP(6)
WHERE detection_type = 'developer_options';

-- 2) Debug bucket (test-only build + attached debugger) → MANDATORY BLOCK
UPDATE security_policies
SET action = 'block_login',
    enabled = 1,
    updated_at = CURRENT_TIMESTAMP(6)
WHERE detection_type = 'debug';

-- 3) Ensure both rows EXIST (CHECK-allowlisted types only; updated_by stays
--    NULL = applied by migration, not an admin)
INSERT INTO security_policies (detection_type, action, enabled)
SELECT 'developer_options', 'block_login', 1
WHERE NOT EXISTS (SELECT 1 FROM security_policies WHERE detection_type = 'developer_options');

INSERT INTO security_policies (detection_type, action, enabled)
SELECT 'debug', 'block_login', 1
WHERE NOT EXISTS (SELECT 1 FROM security_policies WHERE detection_type = 'debug');

-- 4) VERIFY — expected result:
--    developer_options | block_login | 1
--    debug             | block_login | 1
--    (all other rows untouched)
SELECT detection_type, action, enabled, updated_at
FROM security_policies
ORDER BY detection_type;
