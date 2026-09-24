-- ===========================================================================
-- Migration 022 — Platform content defaults (Branding / CMS pages / Feature flags)
-- MedAcademy — Super Admin Platform control centre
--
-- WHY THIS EXISTS
--   `app_branding`, `app_pages` and `feature_flags` existed in the schema but
--   were never populated, so the Super Admin screens reported
--   "Branding unavailable" / "No CMS pages" and the Feature Flags screen had
--   nothing to list. The screens were reading real, empty tables.
--
--   The endpoints that serve them (PlatformController:
--   GET /platform/branding, /platform/pages, /platform/feature-flags) also
--   create any missing row on demand, so a deployment that cannot run SQL is
--   still functional. This migration makes the starting state explicit and
--   identical across environments.
--
-- WHAT THIS CREATES (never overwrites)
--   * app_branding  — the single platform identity row (fixed id used by the
--                     client since the first release).
--   * app_pages     — one row per page a real app screen renders. `content`
--                     stays EMPTY on purpose: an empty body means "render the
--                     text bundled inside the app", so seeding can never
--                     replace the published Terms/Privacy copy with a stub.
--                     A Super Admin writing content switches the app to the
--                     server-managed text; clearing it restores the built-in.
--   * feature_flags — one row per flag in FeatureFlagService::REGISTRY, all
--                     ENABLED (defaults fail OPEN: a config problem must never
--                     disable a capability).
--
-- DESIGN NOTES
--   * No flag can be invented from the table: the key space is the PHP registry
--     (FeatureFlagService::REGISTRY) and PUT /platform/feature-flags/{key}
--     rejects unknown keys with 422.
--   * Enforcement is server-side — see FeatureFlagService::assertEnabled() call
--     sites (auth register/login, course create/publish/enroll, doctor earnings).
--   * Priority is unchanged: authentication, account-suspended/revoked, forced
--     update and maintenance remain stronger than any flag.
--
-- IDEMPOTENCE / PARTIAL EXECUTION
--   INSERT IGNORE + unique keys (app_branding.id, app_pages.key,
--   feature_flags.key) make the file safe to re-run, and safe to run after the
--   endpoints have already created the rows. Nothing is updated or deleted.
-- ===========================================================================

-- ── Platform identity ───────────────────────────────────────────────────────
INSERT IGNORE INTO `app_branding`
  (`id`, `app_name`, `primary_color`, `secondary_color`,
   `contact_email`, `support_email`, `updated_at`)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'MedAcademy', '#1565C0', '#0D47A1',
   'support@medacademy.app', 'support@medacademy.app', UTC_TIMESTAMP(6));

-- ── CMS pages (empty content = app's built-in text) ─────────────────────────
INSERT IGNORE INTO `app_pages`
  (`id`, `key`, `title`, `content`, `published`, `updated_at`)
VALUES
  (UUID(), 'terms_conditions', 'Terms & Conditions', '', 1, UTC_TIMESTAMP(6)),
  (UUID(), 'privacy_policy',   'Privacy Policy',     '', 1, UTC_TIMESTAMP(6)),
  (UUID(), 'about_us',         'About Us',           '', 1, UTC_TIMESTAMP(6)),
  (UUID(), 'contact_us',       'Contact Us',         '', 1, UTC_TIMESTAMP(6));

-- ── Feature flags (all enabled; key space owned by the PHP registry) ─────────
INSERT IGNORE INTO `feature_flags`
  (`id`, `key`, `label`, `description`, `enabled`, `updated_at`)
VALUES
  (UUID(), 'user_registration', 'New User Registration',
   'Allow new accounts. Enforced on POST /auth/register.', 1, UTC_TIMESTAMP(6)),
  (UUID(), 'user_login', 'User Login',
   'Allow new sign-ins. Super Admin sign-in is always allowed so this flag can be re-enabled.', 1, UTC_TIMESTAMP(6)),
  (UUID(), 'course_creation', 'Course Creation',
   'Allow creating new courses. Enforced on POST /courses.', 1, UTC_TIMESTAMP(6)),
  (UUID(), 'doctor_course_publishing', 'Doctor Course Publishing',
   'Allow publishing a course. Enforced on POST /courses/{id}/publish. Existing published courses and drafts are never modified.', 1, UTC_TIMESTAMP(6)),
  (UUID(), 'course_enrollment', 'Course Enrollment',
   'Allow enrolling students into a course. Enforced on POST /courses/{id}/enroll.', 1, UTC_TIMESTAMP(6)),
  (UUID(), 'doctor_earnings', 'Doctor Earnings',
   'Expose doctor earnings to doctors. Enforced on the revenue read path. Balances and history are never modified.', 1, UTC_TIMESTAMP(6));
