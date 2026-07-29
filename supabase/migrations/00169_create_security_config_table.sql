
-- ─────────────────────────────────────────────────────────────────────────────
-- security_config — dynamic security configuration served to all app clients.
--
-- Design principles:
--   • Single active row (enforced by the `is_active` partial unique index).
--   • Super Admin / service_role can write; authenticated users read only through
--     the get-security-config Edge Function (direct table access is blocked).
--   • extras JSONB column makes the schema forward-compatible: new settings can
--     be added without ALTER TABLE or new migrations.
--   • All timestamps are UTC. updated_at is auto-maintained by trigger.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS security_config (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Play Integrity ───────────────────────────────────────────────────────
  -- Controls whether the Play Integrity API check runs on the client.
  -- Set to true only after the app is published on Google Play and all
  -- required Supabase secrets are configured (see docs/PLAY_INTEGRITY_SETUP.md).
  play_integrity_enabled  boolean     NOT NULL DEFAULT false,

  -- ── APK Signing Certificate ──────────────────────────────────────────────
  -- Expected SHA-256 fingerprint of the production release signing certificate.
  -- Format: uppercase hex without colons, exactly 64 characters.
  -- Example: 'A1B2C3D4E5F6...64CHARS'
  -- How to obtain:
  --   Play Console → Your app → Setup → App integrity → App signing key certificate
  --   Copy the SHA-256 fingerprint, remove colon separators, uppercase.
  -- Changing this value here takes effect on next client config refresh
  -- (within 15 minutes) — no new app release required.
  expected_cert_sha256    text        NULL
    CONSTRAINT chk_sha256_format CHECK (
      expected_cert_sha256 IS NULL
      OR (length(expected_cert_sha256) = 64
          AND expected_cert_sha256 ~ '^[0-9A-Fa-f]{64}$')
    ),

  -- ── App Version Enforcement ──────────────────────────────────────────────
  -- Minimum app version required to use the service.
  -- Format: semver string, e.g. '2.1.0'
  -- Clients below this version are shown a force-update screen.
  minimum_app_version     text        NOT NULL DEFAULT '1.0.0',

  -- Whether to force-update clients below minimum_app_version.
  force_update            boolean     NOT NULL DEFAULT false,

  -- ── Config Versioning ────────────────────────────────────────────────────
  -- Monotonically increasing integer. Clients can compare their cached version
  -- against this to decide whether to refresh without re-downloading if equal.
  security_version        integer     NOT NULL DEFAULT 1,

  -- ── Forward-compatibility extras ─────────────────────────────────────────
  -- JSONB bag for future settings. Add new keys here without schema changes.
  -- Example: { "require_biometric": false, "max_sessions": 3 }
  extras                  jsonb       NOT NULL DEFAULT '{}',

  -- ── Active row marker ────────────────────────────────────────────────────
  -- Only one row may be active at a time (partial unique index below).
  -- Inactive rows are kept as history.
  is_active               boolean     NOT NULL DEFAULT true,

  -- ── Audit fields ─────────────────────────────────────────────────────────
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Only one active row allowed
CREATE UNIQUE INDEX IF NOT EXISTS uq_security_config_active
  ON security_config (is_active)
  WHERE is_active = true;

-- Fast lookup of the current config
CREATE INDEX IF NOT EXISTS idx_security_config_active
  ON security_config (is_active, updated_at DESC);

-- Auto-update updated_at on every write
CREATE OR REPLACE FUNCTION update_security_config_timestamp()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_security_config_updated_at ON security_config;
CREATE TRIGGER trg_security_config_updated_at
  BEFORE UPDATE ON security_config
  FOR EACH ROW EXECUTE FUNCTION update_security_config_timestamp();

-- ─── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE security_config ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by Edge Functions and migrations)
CREATE POLICY "service_role_full_access"
  ON security_config FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- Super Admin can read (used for admin dashboard display)
CREATE POLICY "super_admin_read"
  ON security_config FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'super_admin'
    )
  );

-- Super Admin can write (insert/update/delete)
CREATE POLICY "super_admin_write"
  ON security_config FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'super_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'super_admin'
    )
  );

-- All other roles: no direct table access.
-- Config is served exclusively through the get-security-config Edge Function
-- which applies its own authentication and validation logic.

-- ─── Seed the initial active configuration row ────────────────────────────────
-- This is the safe-default state: Play Integrity disabled, no cert fingerprint.
-- A Super Admin updates this row via the admin dashboard or direct SQL after
-- completing the Play Integrity setup steps in docs/PLAY_INTEGRITY_SETUP.md.
INSERT INTO security_config (
  play_integrity_enabled,
  expected_cert_sha256,
  minimum_app_version,
  force_update,
  security_version,
  extras,
  is_active
) VALUES (
  false,     -- play_integrity_enabled: disabled until Play Console is set up
  NULL,      -- expected_cert_sha256: fill after first Play Console upload
  '1.0.0',   -- minimum_app_version: update when a breaking release is published
  false,     -- force_update: enable alongside minimum_app_version when needed
  1,         -- security_version: increment each time an admin changes this row
  '{}',      -- extras: empty — add future settings here as JSON
  true       -- is_active: this is the live configuration row
)
ON CONFLICT DO NOTHING;
