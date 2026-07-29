
-- ── platform_earnings_resets ───────────────────────────────────────────────
-- Stores every time a super admin resets the platform earnings counter.
-- Revenue shown in the dashboard = credits allocated AFTER the latest reset.
-- Historical credit_transactions rows are NEVER touched.
CREATE TABLE IF NOT EXISTS public.platform_earnings_resets (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reset_at         timestamptz NOT NULL DEFAULT now(),
  earnings_before  numeric     NOT NULL DEFAULT 0,   -- snapshot of revenue at time of reset
  reset_by_id      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  reset_by_email   text        NOT NULL DEFAULT '',
  note             text
);

-- Only super_admin may read or insert resets
ALTER TABLE public.platform_earnings_resets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admin_all" ON public.platform_earnings_resets
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'super_admin'
    )
  );

-- ── reset_platform_earnings() ─────────────────────────────────────────────
-- SECURITY DEFINER: atomically reads current earnings, inserts a reset row,
-- and writes an audit_logs entry. Called only by authenticated super admins.
CREATE OR REPLACE FUNCTION public.reset_platform_earnings(
  p_earnings_before numeric,
  p_admin_email     text,
  p_note            text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_reset_id uuid;
BEGIN
  -- Guard: only super_admin may call this function
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_admin_id AND role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'forbidden: super_admin role required';
  END IF;

  -- Insert reset record
  INSERT INTO public.platform_earnings_resets
    (earnings_before, reset_by_id, reset_by_email, note)
  VALUES
    (p_earnings_before, v_admin_id, p_admin_email, p_note)
  RETURNING id INTO v_reset_id;

  -- Write audit log
  INSERT INTO public.audit_logs
    (actor_id, action, target_type, target_id, metadata)
  VALUES (
    v_admin_id,
    'reset_platform_earnings',
    'platform_earnings_resets',
    v_reset_id::text,
    jsonb_build_object(
      'admin_email',     p_admin_email,
      'earnings_before', p_earnings_before,
      'reset_at',        now()::text
    )
  );

  RETURN v_reset_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_platform_earnings(numeric, text, text) TO authenticated;
