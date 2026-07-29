
-- ══════════════════════════════════════════════════════════════════════════════
-- v76b — RPC: get_enum_values_bulk
-- Returns all enum values for a list of enum type names.
-- Used by the frontend EnumIntegrity health check to diff DB vs frontend.
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_enum_values_bulk(p_enum_names TEXT[])
RETURNS TABLE(enum_name TEXT, value TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.typname::TEXT AS enum_name,
         e.enumlabel::TEXT AS value
  FROM   pg_type t
  JOIN   pg_enum e ON e.enumtypid = t.oid
  JOIN   pg_namespace n ON n.oid = t.typnamespace
  WHERE  n.nspname = 'public'
    AND  t.typname = ANY(p_enum_names)
  ORDER BY t.typname, e.enumsortorder;
$$;

-- Allow authenticated users to call (superadmin screen uses the anon/auth client)
GRANT EXECUTE ON FUNCTION public.get_enum_values_bulk(TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_enum_values_bulk(TEXT[]) TO anon;
