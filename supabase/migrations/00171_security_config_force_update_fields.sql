-- ─── Force Update fields for security_config ─────────────────────────────────
-- Adds all update-management columns to the existing security_config table.
-- Existing rows are back-filled with safe defaults; no data is lost.
-- The existing minimum_app_version column is kept for backward compat
-- (old cached bundles still read it); new logic uses minimum_supported_version.

-- minimum_supported_version: hard floor — clients BELOW this are force-blocked.
ALTER TABLE security_config
  ADD COLUMN IF NOT EXISTS minimum_supported_version text NOT NULL DEFAULT '1.0.0';

-- latest_version: soft ceiling — clients below this see a dismissible banner.
ALTER TABLE security_config
  ADD COLUMN IF NOT EXISTS latest_version text NOT NULL DEFAULT '1.0.0';

-- update_title / update_message: admin-controlled copy shown on the update screen.
ALTER TABLE security_config
  ADD COLUMN IF NOT EXISTS update_title text NOT NULL DEFAULT 'Update Required';

ALTER TABLE security_config
  ADD COLUMN IF NOT EXISTS update_message text NOT NULL DEFAULT
    'A critical update is available. Please update the app to continue.';

-- Platform store URLs (open on "Update Now" press).
ALTER TABLE security_config
  ADD COLUMN IF NOT EXISTS android_store_url text NOT NULL DEFAULT '';

ALTER TABLE security_config
  ADD COLUMN IF NOT EXISTS ios_store_url text NOT NULL DEFAULT '';

-- Back-fill existing rows: seed minimum_supported_version from minimum_app_version
-- so a live row with minimum_app_version='1.2.0' gets the same floor immediately.
UPDATE security_config
SET minimum_supported_version = minimum_app_version
WHERE minimum_supported_version = '1.0.0'
  AND minimum_app_version <> '1.0.0';

-- Bump security_version so all clients re-download the full config on next cycle.
UPDATE security_config
SET security_version = security_version + 1
WHERE is_active = true;