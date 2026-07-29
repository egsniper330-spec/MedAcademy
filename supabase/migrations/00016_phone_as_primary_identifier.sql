
-- ============================================================
-- Phone as Primary Identifier — Enterprise Upgrade
-- MedAcademy Migration 00016
-- ============================================================

-- ── 1. Add structured phone columns to profiles ──────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS phone_country_code text,
  ADD COLUMN IF NOT EXISTS phone_national      text,
  ADD COLUMN IF NOT EXISTS phone_e164          text;

-- ── 2. QR code architecture field ────────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS qr_code_id uuid NOT NULL DEFAULT gen_random_uuid();

-- ── 3. Unique / performance indexes ──────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_phone_e164_unique
  ON profiles (phone_e164)
  WHERE phone_e164 IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_qr_code_id
  ON profiles (qr_code_id);

CREATE INDEX IF NOT EXISTS idx_profiles_phone_national
  ON profiles (phone_national)
  WHERE phone_national IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_email_lower
  ON profiles (lower(email));

CREATE INDEX IF NOT EXISTS idx_profiles_full_name_lower
  ON profiles (lower(full_name));

-- ── 4. Extend audit_logs ──────────────────────────────────────────────────────
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS lookup_method    text,
  ADD COLUMN IF NOT EXISTS user_identifier  text;

-- ── 5. Phone normalization helper ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION normalize_phone_e164(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  cleaned text;
  matched text[];
BEGIN
  cleaned := regexp_replace(COALESCE(p_phone, ''), '[\s\-\.\(\)]', '', 'g');

  IF length(cleaned) = 0 THEN RETURN NULL; END IF;

  -- Already E.164
  IF cleaned ~ '^\+[1-9][0-9]{6,14}$' THEN
    RETURN cleaned;
  END IF;

  -- 00XX prefix → +XX
  IF cleaned ~ '^00[1-9][0-9]{6,14}$' THEN
    RETURN '+' || substring(cleaned FROM 3);
  END IF;

  -- Egyptian mobile 01x (10-11 digits)
  IF cleaned ~ '^0[1-9][0-9]{8,9}$' THEN
    RETURN '+20' || substring(cleaned FROM 2);
  END IF;

  -- Bare Egyptian without leading 0 (10 digits starting with 1)
  IF cleaned ~ '^1[0-9]{9}$' THEN
    RETURN '+20' || cleaned;
  END IF;

  RETURN NULL;
END;
$$;

-- ── 6. Universal user lookup ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION lookup_user_by_identifier(p_identifier text)
RETURNS TABLE (
  id            uuid,
  email         text,
  full_name     text,
  phone         text,
  phone_e164    text,
  role          user_role,
  status        user_status,
  watermark_id  text,
  qr_code_id    uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean text := TRIM(p_identifier);
  v_e164  text;
BEGIN
  IF v_clean = '' OR v_clean IS NULL THEN RETURN; END IF;

  -- 1. UUID → user_id
  IF v_clean ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN QUERY
      SELECT p.id, p.email, p.full_name, p.phone, p.phone_e164, p.role, p.status, p.watermark_id, p.qr_code_id
      FROM profiles p WHERE p.id = v_clean::uuid LIMIT 1;
    RETURN;
  END IF;

  -- 2. Email
  IF v_clean ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN QUERY
      SELECT p.id, p.email, p.full_name, p.phone, p.phone_e164, p.role, p.status, p.watermark_id, p.qr_code_id
      FROM profiles p WHERE lower(p.email) = lower(v_clean) LIMIT 1;
    RETURN;
  END IF;

  -- 3. Phone
  v_e164 := normalize_phone_e164(v_clean);
  IF v_e164 IS NOT NULL THEN
    RETURN QUERY
      SELECT p.id, p.email, p.full_name, p.phone, p.phone_e164, p.role, p.status, p.watermark_id, p.qr_code_id
      FROM profiles p WHERE p.phone_e164 = v_e164 LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- 4. Name (partial)
  RETURN QUERY
    SELECT p.id, p.email, p.full_name, p.phone, p.phone_e164, p.role, p.status, p.watermark_id, p.qr_code_id
    FROM profiles p
    WHERE lower(p.full_name) LIKE '%' || lower(v_clean) || '%'
    ORDER BY p.full_name
    LIMIT 10;
END;
$$;

-- ── 7. Backfill phone_e164 for existing rows ──────────────────────────────────
DO $$
DECLARE
  r record;
  v_e164 text;
BEGIN
  FOR r IN SELECT id, phone FROM profiles WHERE phone IS NOT NULL AND phone_e164 IS NULL LOOP
    v_e164 := normalize_phone_e164(r.phone);
    IF v_e164 IS NOT NULL THEN
      UPDATE profiles SET
        phone_e164         = v_e164,
        phone_national     = substring(v_e164 FROM 2),
        phone_country_code = CASE
          WHEN v_e164 ~ '^\+20'  THEN '+20'
          WHEN v_e164 ~ '^\+1'   THEN '+1'
          WHEN v_e164 ~ '^\+44'  THEN '+44'
          WHEN v_e164 ~ '^\+49'  THEN '+49'
          WHEN v_e164 ~ '^\+971' THEN '+971'
          ELSE substring(v_e164 FROM 1 FOR 3)
        END
      WHERE id = r.id;
    END IF;
  END LOOP;
END;
$$;

-- ── 8. Update handle_new_user trigger ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone      text;
  v_phone_e164 text;
BEGIN
  v_phone      := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'phone', '')), '');
  v_phone_e164 := normalize_phone_e164(v_phone);

  INSERT INTO public.profiles (
    id, email, full_name, phone, phone_e164,
    phone_national, phone_country_code,
    role, status,
    university_id, faculty_id, academic_level_id
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    v_phone,
    v_phone_e164,
    CASE WHEN v_phone_e164 IS NOT NULL THEN substring(v_phone_e164 FROM 2) ELSE NULL END,
    CASE
      WHEN v_phone_e164 ~ '^\+20'  THEN '+20'
      WHEN v_phone_e164 ~ '^\+1'   THEN '+1'
      WHEN v_phone_e164 ~ '^\+44'  THEN '+44'
      WHEN v_phone_e164 ~ '^\+49'  THEN '+49'
      WHEN v_phone_e164 ~ '^\+971' THEN '+971'
      WHEN v_phone_e164 IS NOT NULL THEN substring(v_phone_e164 FROM 1 FOR 3)
      ELSE NULL
    END,
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'student'::user_role),
    'active'::user_status,
    NULLIF(NEW.raw_user_meta_data->>'university_id', '')::uuid,
    NULLIF(NEW.raw_user_meta_data->>'faculty_id', '')::uuid,
    NULLIF(NEW.raw_user_meta_data->>'academic_level_id', '')::uuid
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- ── 9. Extend write_audit_log ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION write_audit_log(
  p_actor_id        uuid,
  p_action          audit_action,
  p_details         jsonb DEFAULT '{}',
  p_resource_type   text DEFAULT NULL,
  p_resource_id     uuid DEFAULT NULL,
  p_lookup_method   text DEFAULT NULL,
  p_user_identifier text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_logs (
    user_id, action, details, resource_type, resource_id,
    lookup_method, user_identifier
  )
  VALUES (
    p_actor_id, p_action, p_details,
    p_resource_type, p_resource_id,
    p_lookup_method, p_user_identifier
  );
END;
$$;

-- ── 10. New audit_action enum values ─────────────────────────────────────────
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'phone_login';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'user_searched';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'initial_super_admin_created';
