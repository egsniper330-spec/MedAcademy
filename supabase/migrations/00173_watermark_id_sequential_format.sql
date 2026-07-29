
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: watermark_id_sequential_format
--
-- Replaces the random WM-XXXXXXXX (hex) watermark ID system with a
-- sequential WM-NNNN numeric format that is short, memorable, and unambiguous.
--
-- Strategy:
--   1. Create a dedicated sequence (wm_id_seq) for collision-free allocation.
--   2. Migrate ALL existing rows to WM-NNNN in a single pass (no re-use).
--   3. Replace the DEFAULT on profiles.watermark_id with a function call.
--   4. Replace handle_new_user to use the sequence.
--   5. Replace lookup_user_by_identifier to search WM-NNNN format.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Sequence for sequential ID allocation ──────────────────────────────────
-- Start at 1 — existing rows will consume values during migration below.
CREATE SEQUENCE IF NOT EXISTS public.wm_id_seq
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

-- ── 2. Helper function to format a sequence value as WM-NNNN ─────────────────
CREATE OR REPLACE FUNCTION public.next_watermark_id()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'WM-' || LPAD(nextval('public.wm_id_seq')::text, 4, '0');
$$;

-- ── 3. Change DEFAULT on profiles.watermark_id ───────────────────────────────
ALTER TABLE profiles
  ALTER COLUMN watermark_id SET DEFAULT public.next_watermark_id();

-- ── 4. Migrate ALL existing rows to WM-NNNN ──────────────────────────────────
-- Assigns a fresh sequence value to every profile that still has the old
-- random hex format (WM-XXXXXXXX or any non-numeric-suffix form).
-- Profiles that already have a WM-\d+ format are left untouched.
-- NOTE: LPAD(n,4) produces WM-0001 … WM-9999; above 9999 it naturally widens
--       to WM-10000, WM-10001, etc. — no overflow possible.

DO $$
DECLARE
  r RECORD;
  v_new_id TEXT;
BEGIN
  FOR r IN
    SELECT id
    FROM profiles
    WHERE watermark_id !~ '^WM-[0-9]+$'
    ORDER BY created_at ASC NULLS LAST  -- assign IDs in join order
  LOOP
    v_new_id := 'WM-' || LPAD(nextval('public.wm_id_seq')::text, 4, '0');
    UPDATE profiles SET watermark_id = v_new_id WHERE id = r.id;
  END LOOP;
END;
$$;

-- ── 5. Replace handle_new_user trigger to use sequence ────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wm               text;
  v_raw_phone        text;
  v_phone_e164       text;
  v_phone_country    text;
  v_phone_national   text;
BEGIN
  -- Allocate sequential WM-NNNN id — guaranteed unique via sequence.
  v_wm := public.next_watermark_id();

  -- Extract phone fields from user_metadata (sign-up screen stores these).
  v_raw_phone      := NEW.raw_user_meta_data->>'phone';
  v_phone_country  := NEW.raw_user_meta_data->>'phone_country_code';
  v_phone_national := NEW.raw_user_meta_data->>'phone_national';

  IF v_raw_phone IS NOT NULL THEN
    v_phone_e164 := COALESCE(normalize_phone_e164(v_raw_phone), v_raw_phone);
  END IF;

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
    v_raw_phone,
    v_phone_e164,
    v_phone_country,
    v_phone_national
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ── 6. Update lookup_user_by_identifier to search WM-NNNN format ──────────────
DROP FUNCTION IF EXISTS public.lookup_user_by_identifier(text);

CREATE OR REPLACE FUNCTION public.lookup_user_by_identifier(p_identifier text)
RETURNS TABLE(
  id            uuid,
  email         text,
  profile_email text,
  full_name     text,
  phone         text,
  phone_e164    text,
  role          user_role,
  status        user_status,
  watermark_id  text,
  qr_code_id    uuid
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_clean text := TRIM(p_identifier);
  v_upper text;
  v_like  text;
  v_e164  text;
BEGIN
  IF v_clean = '' OR v_clean IS NULL THEN RETURN; END IF;

  -- Normalise: upper-case so "wm-42" and "WM-42" both match
  v_upper := UPPER(v_clean);
  v_like  := '%' || v_upper || '%';

  -- 0. Exact UUID — return immediately
  IF v_clean ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN QUERY
      SELECT p.id, p.email, p.profile_email, p.full_name, p.phone, p.phone_e164,
             p.role, p.status, p.watermark_id, p.qr_code_id
      FROM profiles p WHERE p.id = v_clean::uuid LIMIT 1;
    RETURN;
  END IF;

  -- 1. Try E.164 normalisation for phone inputs
  v_e164 := normalize_phone_e164(v_clean);

  -- 2. Multi-field partial ILIKE search.
  --    watermark_id is stored as WM-NNNN (uppercase) — match against v_upper.
  RETURN QUERY
    SELECT DISTINCT ON (p.id)
           p.id, p.email, p.profile_email, p.full_name, p.phone, p.phone_e164,
           p.role, p.status, p.watermark_id, p.qr_code_id
    FROM profiles p
    WHERE
      UPPER(p.full_name)          LIKE v_like
      OR UPPER(p.profile_email)   LIKE v_like
      OR UPPER(p.email)           LIKE v_like
      OR UPPER(p.watermark_id)    LIKE v_like
      OR p.phone                  ILIKE ('%' || v_clean || '%')
      OR p.phone_e164             ILIKE ('%' || v_clean || '%')
      OR p.phone_national         ILIKE ('%' || v_clean || '%')
      OR (v_e164 IS NOT NULL AND p.phone_e164 = v_e164)
    ORDER BY p.id, p.full_name
    LIMIT 50;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_user_by_identifier(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.next_watermark_id() TO authenticated;
