
-- ─────────────────────────────────────────────────────────────────────────────
-- sync_auth_phone_bidirectional
--
-- Ensures auth.users.phone is always in sync with profiles.phone_e164.
--
-- WHY auth.users.phone is empty today
-- ────────────────────────────────────
-- supabase.auth.signUp() does NOT accept a `phone` field in the registration
-- payload when using email+password auth — it only accepts `email`, `password`,
-- and `options.data` (user_metadata). The phone is stored in user_metadata.phone
-- and then copied to profiles by the handle_new_user trigger.  auth.users.phone
-- is the OTP/SMS-auth column and is only set by Supabase when a phone OTP flow
-- is used.  We keep it populated for dashboard visibility and future OTP support.
--
-- APPROACH:
--   1. After handle_new_user fires and creates the profile row, a SECOND trigger
--      on auth.users (AFTER INSERT) sets auth.users.phone from raw_user_meta_data.
--      We cannot do it inside handle_new_user because that function writes to
--      profiles, not back to auth.users (would cause recursive trigger issues
--      and permission violations from the profiles schema).
--      Instead we use a separate SECURITY DEFINER function that directly updates
--      auth.users using the service role context available to SECURITY DEFINER
--      functions.
--
--   2. A trigger on public.profiles AFTER UPDATE of phone_e164 writes back to
--      auth.users so profile edits (admin or self) stay in sync.
--
--   3. A one-time backfill updates existing users.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── FUNCTION 1: called by auth.users AFTER INSERT trigger ────────────────────
-- Reads the phone from user_metadata and writes it to auth.users.phone.
-- Must be SECURITY DEFINER to write to auth schema.
CREATE OR REPLACE FUNCTION public.sync_auth_phone_from_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  v_phone := NULLIF(trim(NEW.raw_user_meta_data->>'phone'), '');

  -- Only update if phone is present in metadata and auth.users.phone is empty
  IF v_phone IS NOT NULL AND (NEW.phone IS NULL OR NEW.phone = '') THEN
    UPDATE auth.users
    SET phone = v_phone,
        phone_confirmed_at = now()   -- mark confirmed (doctor-registered / self-registered)
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger on auth.users AFTER INSERT — fires after handle_new_user
-- (both are AFTER INSERT, PostgreSQL fires them in alphabetical order by name;
--  "sync_auth_phone_on_new_user" sorts after "on_auth_user_created" ✅)
DROP TRIGGER IF EXISTS sync_auth_phone_on_new_user ON auth.users;
CREATE TRIGGER sync_auth_phone_on_new_user
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_auth_phone_from_metadata();


-- ── FUNCTION 2: called by profiles AFTER UPDATE trigger ──────────────────────
-- Propagates phone_e164 changes from profiles → auth.users.phone.
CREATE OR REPLACE FUNCTION public.sync_auth_phone_from_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act when phone_e164 actually changed
  IF NEW.phone_e164 IS NOT DISTINCT FROM OLD.phone_e164 THEN
    RETURN NEW;
  END IF;

  UPDATE auth.users
  SET phone = NEW.phone_e164,
      phone_confirmed_at = CASE
        WHEN NEW.phone_e164 IS NOT NULL THEN now()
        ELSE NULL
      END
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

-- Trigger on profiles AFTER UPDATE of phone_e164
DROP TRIGGER IF EXISTS sync_auth_phone_on_profile_update ON public.profiles;
CREATE TRIGGER sync_auth_phone_on_profile_update
  AFTER UPDATE OF phone_e164 ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_auth_phone_from_profile();


-- ── BACKFILL: populate auth.users.phone for all existing users ────────────────
-- Uses raw_user_meta_data->>'phone' as source (what sign-up stores).
-- Falls back to profiles.phone_e164 for admin-created users.
UPDATE auth.users u
SET
  phone               = COALESCE(
                          NULLIF(trim(u.raw_user_meta_data->>'phone'), ''),
                          p.phone_e164
                        ),
  phone_confirmed_at  = CASE
    WHEN COALESCE(
           NULLIF(trim(u.raw_user_meta_data->>'phone'), ''),
           p.phone_e164
         ) IS NOT NULL
    THEN COALESCE(u.phone_confirmed_at, now())
    ELSE NULL
  END
FROM public.profiles p
WHERE p.id = u.id
  AND (u.phone IS NULL OR u.phone = '')
  AND COALESCE(
        NULLIF(trim(u.raw_user_meta_data->>'phone'), ''),
        p.phone_e164
      ) IS NOT NULL;


COMMENT ON FUNCTION public.sync_auth_phone_from_metadata IS
  'AFTER INSERT on auth.users — copies phone from user_metadata into auth.users.phone '
  'so the Supabase dashboard Phone column is populated for email-registered users.';

COMMENT ON FUNCTION public.sync_auth_phone_from_profile IS
  'AFTER UPDATE of phone_e164 on profiles — propagates phone changes back to '
  'auth.users.phone so both locations stay in sync after admin or self-service edits.';
