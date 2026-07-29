
CREATE OR REPLACE FUNCTION get_doctor_pricing_history(
  p_doctor_id uuid,
  p_limit     integer DEFAULT 50
)
RETURNS TABLE(
  id           uuid,
  field_name   text,
  old_value    text,
  new_value    text,
  changed_by   uuid,
  changer_name text,
  created_at   timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_caller_role text;
BEGIN
  -- Fully qualify profiles.id to avoid ambiguity with the RETURNS TABLE `id` OUT variable
  SELECT profiles.role INTO v_caller_role
  FROM profiles
  WHERE profiles.id = auth.uid();

  IF v_caller_role NOT IN ('admin','super_admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
    SELECT
      dph.id,
      dph.field_name,
      dph.old_value,
      dph.new_value,
      dph.changed_by,
      p.full_name  AS changer_name,
      dph.created_at
    FROM doctor_pricing_history dph
    LEFT JOIN profiles p ON p.id = dph.changed_by
    WHERE dph.doctor_id = p_doctor_id
    ORDER BY dph.created_at DESC
    LIMIT p_limit;
END;
$$;
