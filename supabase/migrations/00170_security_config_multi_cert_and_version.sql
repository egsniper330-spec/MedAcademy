
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: multi-certificate fingerprints + version-check optimisation
--
-- Changes:
--   1. Add expected_cert_sha256s (JSONB array) — replaces single expected_cert_sha256.
--   2. Automatically migrate any existing single fingerprint into the array.
--   3. Keep expected_cert_sha256 column for one release cycle so old cached
--      client bundles never break — mark it deprecated via comment.
--   4. Add DB-level constraint: each element must be 64 hex chars.
--   5. Add a fast index for the version-check query (security_version only).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add the new multi-cert column (nullable; filled by migration step below)
ALTER TABLE security_config
  ADD COLUMN IF NOT EXISTS expected_cert_sha256s jsonb NOT NULL DEFAULT '[]';

-- 2. Migrate existing single fingerprint → array (idempotent)
--    Only runs when: the old column has a value AND the new array is still empty.
UPDATE security_config
SET expected_cert_sha256s = jsonb_build_array(upper(expected_cert_sha256))
WHERE expected_cert_sha256 IS NOT NULL
  AND length(expected_cert_sha256) = 64
  AND expected_cert_sha256s = '[]'::jsonb;

-- 3. DB-level validation function: each array element must be 64 hex chars,
--    no duplicates, no empty strings.
CREATE OR REPLACE FUNCTION validate_cert_fingerprints(arr jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  elem text;
  seen text[] := '{}';
BEGIN
  IF jsonb_typeof(arr) <> 'array' THEN RETURN false; END IF;
  FOR elem IN SELECT jsonb_array_elements_text(arr) LOOP
    IF elem IS NULL OR length(elem) <> 64 THEN RETURN false; END IF;
    IF elem !~ '^[0-9A-Fa-f]{64}$' THEN RETURN false; END IF;
    IF elem = ANY(seen) THEN RETURN false; END IF;  -- duplicate
    seen := array_append(seen, upper(elem));
  END LOOP;
  RETURN true;
END;
$$;

-- 4. Apply constraint (skip if already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_cert_fingerprints_format'
      AND conrelid = 'security_config'::regclass
  ) THEN
    ALTER TABLE security_config
      ADD CONSTRAINT chk_cert_fingerprints_format
      CHECK (validate_cert_fingerprints(expected_cert_sha256s));
  END IF;
END $$;

-- 5. Comment the deprecated single-cert column (kept for backward compatibility)
COMMENT ON COLUMN security_config.expected_cert_sha256
  IS 'DEPRECATED: use expected_cert_sha256s (array). Kept for old cached client bundles. Will be removed in a future migration.';

COMMENT ON COLUMN security_config.expected_cert_sha256s
  IS 'Array of trusted APK signing cert SHA-256 fingerprints (64 uppercase hex, no colons). Signature check passes if the runtime cert matches ANY entry. Allows seamless cert rotation without an app release.';

-- 6. Lightweight index for the version-check query (get-security-version EF)
--    Covers: SELECT security_version FROM security_config WHERE is_active = true
CREATE INDEX IF NOT EXISTS idx_security_config_version_check
  ON security_config (is_active, security_version)
  WHERE is_active = true;
