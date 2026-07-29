
-- ================================================================
-- Migration 00039: Phone Login RLS Fix
--
-- ROOT CAUSE: profiles table has RLS enabled with ALL policies
-- restricted to `authenticated` role only. The phone-to-email
-- lookup in resolveEmailFromIdentifier() runs BEFORE the user is
-- authenticated (as `anon`), so RLS blocks all rows → null result
-- → "No account found" error.
--
-- FIX: Create a SECURITY DEFINER function callable by anon that
-- performs the phone→email lookup bypassing RLS.
-- Only returns a single email string — no sensitive data exposed.
-- ================================================================

-- ── 1. Backfill the one missed profile (phone='11111111' is invalid, skip) ────
-- Fix profiles that have phone in E.164 format but phone_e164 is null
DO $$
DECLARE
  r record;
  v_e164 text;
BEGIN
  FOR r IN
    SELECT id, phone FROM profiles
    WHERE phone IS NOT NULL AND (phone_e164 IS NULL OR phone_e164 = '')
  LOOP
    v_e164 := normalize_phone_e164(r.phone);
    IF v_e164 IS NOT NULL THEN
      UPDATE profiles SET
        phone_e164         = v_e164,
        phone_national     = substring(v_e164 FROM 2),
        phone_country_code = CASE
          WHEN v_e164 ~ '^\+20'  THEN '+20'
          WHEN v_e164 ~ '^\+1'   THEN '+1'
          WHEN v_e164 ~ '^\+44'  THEN '+44'
          WHEN v_e164 ~ '^\+971' THEN '+971'
          WHEN v_e164 ~ '^\+966' THEN '+966'
          ELSE '+' || substring(v_e164 FROM 2 FOR 2)
        END
      WHERE id = r.id;
    END IF;
  END LOOP;
END;
$$;

-- ── 2. SECURITY DEFINER phone lookup — callable by anon, bypasses RLS ─────────
-- Returns the email address for a given phone number in ANY format.
-- Normalizes input on the fly so all 4 formats work:
--   01020182886 / 201020182886 / +201020182886 / 00201020182886
-- Only returns email (never full profile). Safe to expose to anon.
CREATE OR REPLACE FUNCTION public.get_email_by_phone(p_phone TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_e164  TEXT;
  v_email TEXT;
BEGIN
  -- Normalize whatever format the caller provided
  v_e164 := normalize_phone_e164(p_phone);
  IF v_e164 IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT email INTO v_email
  FROM profiles
  WHERE phone_e164 = v_e164
  LIMIT 1;

  RETURN v_email;
END;
$$;

-- Grant execute to anon (unauthenticated users) so sign-in can call it
GRANT EXECUTE ON FUNCTION public.get_email_by_phone(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.get_email_by_phone(TEXT) TO authenticated;

-- ── 3. Verify backfill result ─────────────────────────────────────────────────
DO $$
DECLARE
  missing_count int;
BEGIN
  SELECT COUNT(*) INTO missing_count
  FROM profiles
  WHERE phone IS NOT NULL
    AND (phone_e164 IS NULL OR phone_e164 = '')
    AND length(phone) >= 8;  -- skip obviously invalid short numbers

  IF missing_count > 0 THEN
    RAISE WARNING 'phone_e164 backfill: % normalizable row(s) still missing phone_e164', missing_count;
  ELSE
    RAISE NOTICE 'phone_e164 backfill: OK — all valid phone numbers normalized';
  END IF;
END;
$$;
