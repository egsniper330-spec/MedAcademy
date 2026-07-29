
-- v83: Phone-first account architecture
-- Add profile_email (real user email) separate from email (auth_email / internal placeholder).
-- profiles.email  = auth email used by Supabase Auth (may be phone_XXX@medacademy.internal)
-- profiles.profile_email = real email visible to user; set by user later; nullable

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS profile_email text;

-- Backfill: for accounts whose auth email is a real email (not internal), copy to profile_email
UPDATE public.profiles
SET profile_email = email
WHERE email NOT LIKE '%@medacademy.internal'
  AND profile_email IS NULL;

-- Index for fast lookups (admin search by real email)
CREATE INDEX IF NOT EXISTS idx_profiles_profile_email ON public.profiles(profile_email)
  WHERE profile_email IS NOT NULL;

-- Helper: return the public-facing email for a user
-- Returns profile_email if set, else the auth email only if it is NOT internal
CREATE OR REPLACE FUNCTION public.get_public_email(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN p.profile_email IS NOT NULL AND p.profile_email != '' THEN p.profile_email
    WHEN p.email NOT LIKE '%@medacademy.internal' THEN p.email
    ELSE NULL
  END
  FROM public.profiles p
  WHERE p.id = p_user_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_email(uuid) TO authenticated, service_role;
