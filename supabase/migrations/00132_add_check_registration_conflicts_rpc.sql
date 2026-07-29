
-- check_registration_conflicts
-- ─────────────────────────────────────────────────────────────────────────────
-- Safe, anon-callable RPC that checks whether an email or phone number is
-- already in use before the caller attempts to register.
--
-- Returns a row for EACH conflict found (0 rows = no conflicts, safe to register).
-- Running as SECURITY DEFINER so it can read auth.users + profiles without
-- exposing them through client-side RLS — the function only returns a boolean
-- pair, never any user data.
--
-- Called from the registration screen BEFORE supabase.auth.signUp() so that
-- the client can show friendly validation messages instead of surfacing the
-- internal "Database error saving new user" Supabase Auth error.

CREATE OR REPLACE FUNCTION public.check_registration_conflicts(
  p_email     text,
  p_phone_e164 text
)
RETURNS TABLE (
  email_taken  boolean,
  phone_taken  boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email_taken  boolean := false;
  v_phone_taken  boolean := false;
BEGIN
  -- Check email in auth.users (canonical source — Auth enforces uniqueness there)
  IF p_email IS NOT NULL AND length(trim(p_email)) > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM auth.users
      WHERE lower(email) = lower(trim(p_email))
        AND deleted_at IS NULL
    ) INTO v_email_taken;
  END IF;

  -- Check phone in profiles.phone_e164 (the normalised E.164 column with unique index)
  IF p_phone_e164 IS NOT NULL AND length(trim(p_phone_e164)) > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE phone_e164 = trim(p_phone_e164)
    ) INTO v_phone_taken;
  END IF;

  RETURN QUERY SELECT v_email_taken, v_phone_taken;
END;
$$;

-- Grant execute to anon so unauthenticated registration screens can call it
GRANT EXECUTE ON FUNCTION public.check_registration_conflicts(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_registration_conflicts(text, text) TO authenticated;

COMMENT ON FUNCTION public.check_registration_conflicts IS
  'Checks whether a given email and/or phone number are already registered. '
  'Safe to call as anon. Returns a single row with (email_taken, phone_taken). '
  'No user data is exposed — only boolean flags.';
