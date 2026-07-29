
-- ============================================================
-- Migration 00018: Phone E.164 — normalization fix + backfill
-- Adds support for the 201020182886 format (country code, no +)
-- and re-backfills any profiles with phone but no phone_e164.
-- ============================================================

-- ── 1. Fix normalize_phone_e164 to handle country-code-without-+ format ───────
CREATE OR REPLACE FUNCTION normalize_phone_e164(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  cleaned text;
BEGIN
  cleaned := regexp_replace(COALESCE(p_phone, ''), '[\s\-\.\(\)]', '', 'g');

  IF length(cleaned) = 0 THEN RETURN NULL; END IF;

  -- Already E.164 (+XXXXXXXXXXX)
  IF cleaned ~ '^\+[1-9][0-9]{6,14}$' THEN
    RETURN cleaned;
  END IF;

  -- 00XX prefix → +XX  (e.g. 00201020182886 → +201020182886)
  IF cleaned ~ '^00[1-9][0-9]{6,14}$' THEN
    RETURN '+' || substring(cleaned FROM 3);
  END IF;

  -- ── Egyptian numbers ─────────────────────────────────────────────────────

  -- Country code without + prefix: 201020182886 (12 digits, starts with 20)
  -- This was the missing case causing "201020182886 → null"
  IF cleaned ~ '^20[1-9][0-9]{8,9}$' THEN
    RETURN '+' || cleaned;
  END IF;

  -- Local with leading 0: 01020182886
  IF cleaned ~ '^0[1-9][0-9]{8,9}$' THEN
    RETURN '+20' || substring(cleaned FROM 2);
  END IF;

  -- Bare 10-digit national: 1020182886
  IF cleaned ~ '^1[0-9]{9}$' THEN
    RETURN '+20' || cleaned;
  END IF;

  -- Generic fallback: any other number that looks like E.164 digits
  -- (not prefixed) — attempt nothing, return null for safety
  RETURN NULL;
END;
$$;

-- ── 2. Re-run backfill to catch any rows missed by the original migration ─────
--     Covers:
--     (a) Profiles created before migration 00016 ran the trigger
--     (b) Profiles auto-created by api.ts getProfile() that skipped the trigger
--     (c) The previously-failing 201020182886 format
DO $$
DECLARE
  r record;
  v_e164 text;
BEGIN
  FOR r IN
    SELECT id, phone
    FROM profiles
    WHERE phone IS NOT NULL
      AND (phone_e164 IS NULL OR phone_e164 = '')
  LOOP
    v_e164 := normalize_phone_e164(r.phone);
    IF v_e164 IS NOT NULL THEN
      UPDATE profiles SET
        phone_e164         = v_e164,
        phone_national     = substring(v_e164 FROM 2),   -- digits only without +
        phone_country_code = CASE
          WHEN v_e164 ~ '^\+20'   THEN '+20'
          WHEN v_e164 ~ '^\+1'    THEN '+1'
          WHEN v_e164 ~ '^\+44'   THEN '+44'
          WHEN v_e164 ~ '^\+49'   THEN '+49'
          WHEN v_e164 ~ '^\+971'  THEN '+971'
          WHEN v_e164 ~ '^\+966'  THEN '+966'
          WHEN v_e164 ~ '^\+962'  THEN '+962'
          WHEN v_e164 ~ '^\+965'  THEN '+965'
          WHEN v_e164 ~ '^\+974'  THEN '+974'
          WHEN v_e164 ~ '^\+961'  THEN '+961'
          WHEN v_e164 ~ '^\+218'  THEN '+218'
          WHEN v_e164 ~ '^\+249'  THEN '+249'
          WHEN v_e164 ~ '^\+964'  THEN '+964'
          WHEN v_e164 ~ '^\+963'  THEN '+963'
          WHEN v_e164 ~ '^\+212'  THEN '+212'
          WHEN v_e164 ~ '^\+216'  THEN '+216'
          WHEN v_e164 ~ '^\+213'  THEN '+213'
          ELSE '+' || substring(v_e164 FROM 2 FOR 2)  -- best-effort 2-digit code
        END
      WHERE id = r.id;
    END IF;
  END LOOP;
END;
$$;

-- ── 3. Ensure unique index exists (idempotent) ────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_phone_e164_unique
  ON profiles (phone_e164)
  WHERE phone_e164 IS NOT NULL;

-- ── 4. Update handle_new_user trigger to use fixed normalizer ─────────────────
-- (The function body now calls the fixed normalize_phone_e164 automatically
--  since we replaced the function in step 1 — trigger references it by name.)

-- ── 5. Verify backfill result ─────────────────────────────────────────────────
DO $$
DECLARE
  missing_count int;
BEGIN
  SELECT COUNT(*) INTO missing_count
  FROM profiles
  WHERE phone IS NOT NULL AND (phone_e164 IS NULL OR phone_e164 = '');

  IF missing_count > 0 THEN
    RAISE WARNING 'phone_e164 backfill: % row(s) still have phone but no phone_e164 (non-normalizable format).', missing_count;
  ELSE
    RAISE NOTICE 'phone_e164 backfill: all rows successfully normalized.';
  END IF;
END;
$$;
