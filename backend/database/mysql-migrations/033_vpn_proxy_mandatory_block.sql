-- ===========================================================================
-- Migration 033 — VPN / proxy = MANDATORY SECURITY BLOCK
-- ===========================================================================
-- ROOT CAUSE this migration fixes (reported defect, real iPhone):
--   VPN detection worked on iOS, but the app still showed the DISMISSIBLE
--   security-warning screen with a "Continue Anyway" button, so the user could
--   enter the app and make API requests while the VPN was active.
--
--   The client is fully server-driven: src/lib/security.ts#getSecurityPolicies()
--   merges the authoritative `security_policies` rows over the bundled defaults
--   (which already said `vpn → block_login`). The observed warn-level behaviour
--   was therefore produced by the STORED row resolving `vpn`/`proxy` to
--   `warn_only` (or being disabled) — a configuration value was allowed to
--   downgrade a connection-security block into a dismissal. The shipped docs
--   anticipated exactly this split: docs/DEVICE_VALIDATION_CHECKLIST.md §10
--   ("If your server's authoritative security_policies resolves VPN/proxy to
--   warn_only, you instead get the dismissible security-warning screen").
--
-- WHAT THIS MIGRATION DOES (owner requirement — a confirmed VPN/proxy always
-- blocks; the app can never be entered with one active):
--   1. Sets the `vpn` and `proxy` rows to action = 'block_login', enabled = 1.
--   2. Creates the rows when they are absent (a missing row previously fell
--      through to the bundled client default, which is fragile and invisible).
--
-- ENFORCED IN THREE PLANES (this file is one of them):
--   • DB            — this migration makes the stored policy correct.
--   • Server        — SecurityController::policies() serves the floor for
--                     vpn/proxy (MANDATORY_FLOOR) and updatePolicy() REFUSES any
--                     weakening write (MANDATORY_BLOCK: action != block_login or
--                     enabled = false ⇒ HTTP 422). Retro-fits installed clients.
--   • Client        — applyMandatoryConnectionFloor() (securityStateModel.ts)
--                     floors the two detectors in the merged policy table, so an
--                     offline launch or a stale 5-minute cache cannot resurrect
--                     the dismissible path.
--
-- HOW TO ALLOW A LEGITIMATE CORPORATE VPN (unchanged, admin-sanctioned):
--   insert its name into `security_vpn_whitelist`. Any row there makes the
--   client SKIP vpn/proxy detection by design (documented as §10.9). Do NOT
--   weaken the policy row — the server refuses it anyway.
--
-- IDEMPOTENT & SAFE:
--   * UPDATEs touch ONLY these two detection types — no other policy changes.
--   * INSERTs are guarded by NOT EXISTS (no duplicate-key error, no clobber).
--   * No rows are deleted, no CHECK constraint is modified or dropped.
--   * `updated_by` stays NULL = applied by migration, not by an admin.
--   * Safe to re-run; every statement is a no-op once applied.
--   * detection_type values 'vpn' and 'proxy' are already in
--     chk_security_policies_detection_type (schema.sql), so no constraint work.
-- ===========================================================================

-- 1) VPN → MANDATORY BLOCK
UPDATE security_policies
SET action = 'block_login',
    enabled = 1,
    updated_at = CURRENT_TIMESTAMP(6)
WHERE detection_type = 'vpn';

-- 2) Proxy → MANDATORY BLOCK (was warn_only by default)
UPDATE security_policies
SET action = 'block_login',
    enabled = 1,
    updated_at = CURRENT_TIMESTAMP(6)
WHERE detection_type = 'proxy';

-- 3) Ensure both rows EXIST
INSERT INTO security_policies (detection_type, action, enabled)
SELECT 'vpn', 'block_login', 1
WHERE NOT EXISTS (SELECT 1 FROM security_policies WHERE detection_type = 'vpn');

INSERT INTO security_policies (detection_type, action, enabled)
SELECT 'proxy', 'block_login', 1
WHERE NOT EXISTS (SELECT 1 FROM security_policies WHERE detection_type = 'proxy');

-- 4) VERIFY — expected:
--    proxy             | block_login | 1
--    vpn               | block_login | 1
--    (all other rows untouched)
SELECT detection_type, action, enabled, updated_at
FROM security_policies
ORDER BY detection_type;
