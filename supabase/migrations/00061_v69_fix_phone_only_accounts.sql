
-- ── v69: Phone-only account repair ───────────────────────────────────────────
--
-- PROBLEM: Phone-only students were created with phone_X@medacademy.internal
-- email but auth.users.phone was not populated (normalizePhoneE164 returned
-- null for short test numbers) and profiles.phone_e164 was not set.
-- The get_email_by_phone RPC queries phone_e164 column → phone login fails.
--
-- FIX:
--  1. Ensure profiles.phone_e164 is populated (try E.164 normalization, fall
--     back to raw digits from the email pattern so at least the row is queryable).
--  2. Update get_email_by_phone to also search profiles.phone (raw) as fallback
--     so existing accounts with non-normalizable numbers can still log in.
--  3. Repair user_metadata.phone for completeness.

-- ── 1. Add phone_original column (stores the raw input before normalisation) ─
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone_original TEXT;

-- ── 2. Backfill phone_e164 for all phone-only accounts ──────────────────────
--   Strategy:
--     a. Try normalize_phone_e164(profiles.phone) — works for valid lengths
--     b. If that returns NULL, store the raw digits in phone_e164 AS-IS so the
--        RPC can still find the user (only for legacy test numbers)
--   Also save original phone for audit trail.
UPDATE public.profiles
SET
  phone_original = phone,
  phone_e164 = COALESCE(
    normalize_phone_e164(phone),
    phone   -- fallback: store raw for legacy/test accounts
  )
WHERE
  email LIKE 'phone_%@medacademy.internal'
  AND phone IS NOT NULL
  AND phone != ''
  AND (phone_e164 IS NULL OR phone_e164 = '');

-- ── 3. Upgrade get_email_by_phone to also search raw phone as fallback ───────
CREATE OR REPLACE FUNCTION public.get_email_by_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_e164  TEXT;
  v_email TEXT;
BEGIN
  -- Try exact E.164 match first (normalizing caller's input)
  v_e164 := normalize_phone_e164(p_phone);

  IF v_e164 IS NOT NULL THEN
    SELECT email INTO v_email
    FROM public.profiles
    WHERE phone_e164 = v_e164
    LIMIT 1;

    IF v_email IS NOT NULL THEN
      RETURN v_email;
    END IF;

    -- Also try matching the stored e164 directly against caller's raw input
    -- (covers accounts whose phone_e164 = raw digits from legacy repair above)
    SELECT email INTO v_email
    FROM public.profiles
    WHERE phone_e164 = p_phone
       OR phone = p_phone
    LIMIT 1;

    IF v_email IS NOT NULL THEN
      RETURN v_email;
    END IF;
  END IF;

  -- Final fallback: match raw phone column for any format variant
  SELECT email INTO v_email
  FROM public.profiles
  WHERE phone = p_phone
     OR phone_e164 = p_phone
  LIMIT 1;

  RETURN v_email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text) TO anon, authenticated;

-- ── 4. Helper RPC: repair_phone_account — used by EF after auth user created ─
--   Sets phone + phone_e164 + phone_original on the profile row.
CREATE OR REPLACE FUNCTION public.repair_phone_account(
  p_user_id    uuid,
  p_phone_raw  text,
  p_phone_e164 text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.profiles
  SET
    phone          = p_phone_raw,
    phone_e164     = COALESCE(p_phone_e164, p_phone_raw),
    phone_original = p_phone_raw
  WHERE id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.repair_phone_account(uuid, text, text) TO service_role;
