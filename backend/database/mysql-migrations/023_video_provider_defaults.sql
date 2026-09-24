-- ===========================================================================
-- MIGRATION 023 — Video Provider Control Center
--
-- NO SCHEMA CHANGE: both tables already exist in the shipped schema:
--   video_providers              (schema.sql ~line 1235) — global registry
--   teacher_provider_permissions (schema.sql ~line 1249) — per-doctor rows
--
-- This migration ONLY seeds deterministic DEFAULT rows so the Super Admin
-- console and the doctor-side gate render the two REAL providers instead of
-- relying on fail-open defaults. EXISTING PRODUCTION DATA IS PRESERVED:
--   * INSERT IGNORE — an existing row (any operator-chosen state) wins.
--   * NO per-doctor override rows are created: absence = INHERIT, which is
--     exactly the correct starting policy for every existing doctor.
--
-- Provider keys are the application's own identifiers:
--   plyr       → the YouTube/Plyr playback path (lessons.video_type='youtube')
--   vdocipher  → the VdoCipher DRM path        (lessons.video_type='vdocipher')
-- ===========================================================================

INSERT IGNORE INTO `video_providers`
    (`id`, `provider_key`, `display_name`, `is_globally_enabled`, `created_at`, `updated_at`)
VALUES
    ('00000000-0000-0000-0000-100000000001', 'plyr',      'Plyr',      1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)),
    ('00000000-0000-0000-0000-100000000002', 'vdocipher', 'VdoCipher', 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6));

-- Fail-open starting state: both real providers enabled globally, zero
-- per-doctor overrides. Every doctor therefore inherits ON until an
-- administrator explicitly changes it. (Intentionally no inserts into
-- teacher_provider_permissions — INHERIT is the default by design.)
