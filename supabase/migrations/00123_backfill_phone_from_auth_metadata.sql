
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: backfill_phone_from_auth_metadata
--
-- Existing accounts that registered before the trigger fix have NULL phone
-- columns in profiles even though phone data exists in auth.users.raw_user_meta_data.
--
-- This backfill reads from auth.users and writes to profiles for every row
-- where profiles.phone_e164 IS NULL but metadata contains a phone value.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE profiles p
SET
  phone              = u.raw_user_meta_data->>'phone',
  phone_e164         = COALESCE(
                         normalize_phone_e164(u.raw_user_meta_data->>'phone'),
                         u.raw_user_meta_data->>'phone'
                       ),
  phone_country_code = u.raw_user_meta_data->>'phone_country_code',
  phone_national     = u.raw_user_meta_data->>'phone_national',
  updated_at         = now()
FROM auth.users u
WHERE p.id = u.id
  AND p.phone_e164 IS NULL                         -- only rows that are missing phone
  AND (u.raw_user_meta_data->>'phone') IS NOT NULL  -- only when metadata has a phone
  AND (u.raw_user_meta_data->>'phone') <> '';       -- skip empty strings
