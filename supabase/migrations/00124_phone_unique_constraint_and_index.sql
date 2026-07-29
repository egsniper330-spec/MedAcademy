
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: phone_unique_constraint_and_index
--
-- Phone is now a primary identity field. Enforce uniqueness on phone_e164 so
-- two accounts can never share the same phone number.
-- A partial unique index is used (WHERE phone_e164 IS NOT NULL) so that the
-- many accounts that genuinely have no phone (e.g. internal test accounts) are
-- not blocked from coexisting.
-- ─────────────────────────────────────────────────────────────────────────────

-- Unique index (partial — NULL values are excluded, so accounts without phone are allowed)
CREATE UNIQUE INDEX IF NOT EXISTS profiles_phone_e164_unique
  ON profiles (phone_e164)
  WHERE phone_e164 IS NOT NULL;

-- Non-unique index on phone_national for fast prefix searches (e.g. "0102")
CREATE INDEX IF NOT EXISTS profiles_phone_national_idx
  ON profiles (phone_national)
  WHERE phone_national IS NOT NULL;
