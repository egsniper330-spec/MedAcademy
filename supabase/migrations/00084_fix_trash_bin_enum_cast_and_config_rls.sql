
-- Fix 1: get_trash_list — cast p_role TEXT to user_role ENUM so the comparison works
CREATE OR REPLACE FUNCTION public.get_trash_list(
  p_role   TEXT DEFAULT NULL,
  p_limit  INT  DEFAULT 50,
  p_offset INT  DEFAULT 0
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_result JSON;
BEGIN
  SELECT json_build_object(
    'items', COALESCE(json_agg(t ORDER BY t.trashed_at DESC), '[]'::json),
    'total', COALESCE(MAX(t.total_count), 0)
  )
  INTO v_result
  FROM (
    SELECT
      p.id,
      p.full_name,
      p.email,
      p.phone_e164,
      p.role::text AS role,
      p.trashed_at,
      p.trash_expires_at,
      p.trash_reason,
      p.pre_trash_status,
      tb.full_name AS trashed_by_name,
      GREATEST(0, EXTRACT(EPOCH FROM (p.trash_expires_at - now())) / 86400)::INT AS days_remaining,
      COUNT(*) OVER () AS total_count
    FROM public.profiles p
    LEFT JOIN public.profiles tb ON tb.id = p.trashed_by
    WHERE p.status = 'trashed'
      AND (p_role IS NULL OR p.role = p_role::public.user_role)
    ORDER BY p.trashed_at DESC
    LIMIT p_limit OFFSET p_offset
  ) t;
  RETURN COALESCE(v_result, json_build_object('items', '[]'::json, 'total', 0));
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_trash_list(TEXT, INT, INT) TO authenticated;

-- Fix 2: trash_config RLS — add explicit UPDATE policy for super_admin
-- (the existing policy only covers SELECT; UPDATE was missing for the frontend client)
DO $$
BEGIN
  -- Drop old combined policy if it exists
  DROP POLICY IF EXISTS "Super admin manage trash config" ON public.trash_config;
  DROP POLICY IF EXISTS "trash_config_sa_select" ON public.trash_config;
  DROP POLICY IF EXISTS "trash_config_sa_update" ON public.trash_config;
  DROP POLICY IF EXISTS "trash_config_sa_insert" ON public.trash_config;

  CREATE POLICY "trash_config_sa_select" ON public.trash_config
    FOR SELECT TO authenticated
    USING (
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'super_admin')
    );

  CREATE POLICY "trash_config_sa_update" ON public.trash_config
    FOR UPDATE TO authenticated
    USING (
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'super_admin')
    )
    WITH CHECK (
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'super_admin')
    );

  CREATE POLICY "trash_config_sa_insert" ON public.trash_config
    FOR INSERT TO authenticated
    WITH CHECK (
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'super_admin')
    );
END $$;
