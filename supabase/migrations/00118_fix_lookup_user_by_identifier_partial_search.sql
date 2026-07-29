
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
  v_like  text;
  v_e164  text;
BEGIN
  IF v_clean = '' OR v_clean IS NULL THEN RETURN; END IF;

  v_like := '%' || v_clean || '%';

  -- 0. Exact UUID — return immediately
  IF v_clean ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN QUERY
      SELECT p.id, p.email, p.profile_email, p.full_name, p.phone, p.phone_e164,
             p.role, p.status, p.watermark_id, p.qr_code_id
      FROM profiles p WHERE p.id = v_clean::uuid LIMIT 1;
    RETURN;
  END IF;

  -- 1. Try E.164 normalisation for phone (may be NULL if input is not a phone)
  v_e164 := normalize_phone_e164(v_clean);

  -- 2. Multi-field partial ILIKE search across all searchable columns
  --    Matches: name, profile_email, auth email, watermark_id, phone (raw/e164/national)
  RETURN QUERY
    SELECT DISTINCT ON (p.id)
           p.id, p.email, p.profile_email, p.full_name, p.phone, p.phone_e164,
           p.role, p.status, p.watermark_id, p.qr_code_id
    FROM profiles p
    WHERE
      p.full_name          ILIKE v_like
      OR p.profile_email   ILIKE v_like
      OR p.email           ILIKE v_like
      OR p.watermark_id    ILIKE v_like
      OR p.phone           ILIKE v_like
      OR p.phone_e164      ILIKE v_like
      OR p.phone_national  ILIKE v_like
      OR (v_e164 IS NOT NULL AND p.phone_e164 = v_e164)
    ORDER BY p.id, p.full_name
    LIMIT 50;
END;
$$;

-- Restore EXECUTE permission for authenticated users
GRANT EXECUTE ON FUNCTION public.lookup_user_by_identifier(text) TO authenticated;
