
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: fix_handle_new_user_phone_fields
--
-- Root cause:
--   handle_new_user only wrote (id, email, full_name, role, watermark_id).
--   phone, phone_e164, phone_country_code, phone_national were never included,
--   so every self-registered account had NULL phone columns.
--
-- The sign-up screen stores all four phone fields in user_metadata:
--   phone             → E.164 string  e.g. "+201020182886"
--   phone_country_code → calling code e.g. "+20"
--   phone_national     → digits only  e.g. "1020182886"
--
-- Fix: rewrite the trigger function to read those four fields from
-- NEW.raw_user_meta_data and INSERT them into profiles.
-- Also normalizes phone to E.164 via normalize_phone_e164() (same function
-- used by the fallback path in completeProfile / api.ts).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wm               text;
  v_conflict         bool;
  v_raw_phone        text;
  v_phone_e164       text;
  v_phone_country    text;
  v_phone_national   text;
BEGIN
  -- ── Generate unique watermark ID ─────────────────────────────────────────
  LOOP
    v_wm       := 'WM-' || upper(left(encode(extensions.gen_random_bytes(6), 'hex'), 8));
    v_conflict := EXISTS (SELECT 1 FROM profiles WHERE watermark_id = v_wm);
    EXIT WHEN NOT v_conflict;
  END LOOP;

  -- ── Extract phone fields from user_metadata ───────────────────────────────
  -- sign-up screen stores: phone (E.164), phone_country_code, phone_national
  v_raw_phone      := NEW.raw_user_meta_data->>'phone';
  v_phone_country  := NEW.raw_user_meta_data->>'phone_country_code';
  v_phone_national := NEW.raw_user_meta_data->>'phone_national';

  -- Normalize to E.164 using the same helper used by the JS fallback path.
  -- If normalize_phone_e164 returns NULL (non-phone input), keep the raw value.
  IF v_raw_phone IS NOT NULL THEN
    v_phone_e164 := COALESCE(normalize_phone_e164(v_raw_phone), v_raw_phone);
  END IF;

  -- ── Insert profile row ────────────────────────────────────────────────────
  INSERT INTO profiles (
    id,
    email,
    full_name,
    role,
    watermark_id,
    phone,
    phone_e164,
    phone_country_code,
    phone_national
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'student'),
    v_wm,
    v_raw_phone,          -- raw E.164 as supplied by sign-up screen
    v_phone_e164,         -- normalized E.164 (used by search)
    v_phone_country,      -- e.g. "+20"
    v_phone_national      -- digits-only national number e.g. "1020182886"
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;
