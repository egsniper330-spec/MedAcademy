
-- v70: Backfill phone_e164 for ALL phone-only accounts that still have it NULL
-- (accounts created after the v69 migration ran don't have phone_e164 set yet
--  because the EF profile upsert passes phoneE164 which is null for non-Egyptian numbers)
UPDATE public.profiles
SET
  phone_e164 = COALESCE(
    normalize_phone_e164(phone),
    phone   -- store raw as fallback for non-normalizable numbers
  ),
  phone_original = COALESCE(phone_original, phone)
WHERE
  email LIKE 'phone_%@medacademy.internal'
  AND phone IS NOT NULL
  AND phone != ''
  AND (phone_e164 IS NULL OR phone_e164 = '');

-- Also ensure get_email_by_phone can find accounts by raw phone
-- even when phone_e164 wasn't set.  The v69 RPC already handles this,
-- but confirm the grant is intact.
GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text) TO anon, authenticated;
