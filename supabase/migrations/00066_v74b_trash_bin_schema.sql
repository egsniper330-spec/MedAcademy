
-- ═══════════════════════════════════════════════════════════
-- v74b: Trash Bin schema, RPCs, permissions
-- ═══════════════════════════════════════════════════════════

-- ── 1. Trash columns on profiles ─────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS trashed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trash_expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trashed_by         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trash_reason       TEXT,
  ADD COLUMN IF NOT EXISTS pre_trash_status   TEXT DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS delete_permissions JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_profiles_trashed_at       ON public.profiles(trashed_at)       WHERE trashed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_trash_expires_at ON public.profiles(trash_expires_at) WHERE trash_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_status           ON public.profiles(status);

-- ── 2. Trash config table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trash_config (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retention_days INT NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
  custom_days    INT,
  updated_by     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.trash_config (retention_days) VALUES (30);

ALTER TABLE public.trash_config ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trash_config' AND policyname='Super admin manage trash config') THEN
    CREATE POLICY "Super admin manage trash config" ON public.trash_config
      USING  (auth.jwt() ->> 'role' = 'super_admin')
      WITH CHECK (auth.jwt() ->> 'role' = 'super_admin');
  END IF;
END $$;

-- ── 3. trash_user() ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trash_user(
  p_target_user_id UUID,
  p_actor_id       UUID,
  p_reason         TEXT DEFAULT NULL
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_profile RECORD;
  v_actor   RECORD;
  v_retention INT;
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT id, full_name, role, status INTO v_profile
  FROM public.profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success',false,'code','NOT_FOUND','message','User not found');
  END IF;
  IF v_profile.status = 'trashed' THEN
    RETURN json_build_object('success',false,'code','ALREADY_TRASHED','message','User is already in trash');
  END IF;
  SELECT id, role INTO v_actor FROM public.profiles WHERE id = p_actor_id;

  SELECT COALESCE(custom_days, retention_days) INTO v_retention
  FROM public.trash_config ORDER BY updated_at DESC LIMIT 1;
  v_retention := COALESCE(v_retention, 30);
  v_expires   := now() + (v_retention || ' days')::INTERVAL;

  UPDATE public.profiles SET
    status           = 'trashed',
    pre_trash_status = v_profile.status::TEXT,
    trashed_at       = now(),
    trash_expires_at = v_expires,
    trashed_by       = p_actor_id,
    trash_reason     = p_reason
  WHERE id = p_target_user_id;

  INSERT INTO public.audit_logs(actor_id, action, resource_type, resource_id, success, details)
  VALUES (p_actor_id, 'user_trashed', 'profile', p_target_user_id, true,
    jsonb_build_object('target_name', v_profile.full_name,'target_role',v_profile.role,
                       'actor_role',v_actor.role,'reason',p_reason,'expires_at',v_expires));

  RETURN json_build_object('success',true,'expires_at',v_expires,'user_id',p_target_user_id,'full_name',v_profile.full_name);
END;
$$;

-- ── 4. restore_user() ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.restore_user(
  p_target_user_id UUID,
  p_actor_id       UUID
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_profile RECORD;
  v_actor   RECORD;
BEGIN
  SELECT id, full_name, role, status, pre_trash_status INTO v_profile
  FROM public.profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success',false,'code','NOT_FOUND','message','User not found');
  END IF;
  IF v_profile.status <> 'trashed' THEN
    RETURN json_build_object('success',false,'code','NOT_TRASHED','message','User is not in trash');
  END IF;
  SELECT id, role INTO v_actor FROM public.profiles WHERE id = p_actor_id;

  UPDATE public.profiles SET
    status           = COALESCE(v_profile.pre_trash_status,'active')::user_status,
    pre_trash_status = NULL,
    trashed_at       = NULL,
    trash_expires_at = NULL,
    trashed_by       = NULL,
    trash_reason     = NULL
  WHERE id = p_target_user_id;

  INSERT INTO public.audit_logs(actor_id, action, resource_type, resource_id, success, details)
  VALUES (p_actor_id, 'user_restored', 'profile', p_target_user_id, true,
    jsonb_build_object('target_name',v_profile.full_name,'target_role',v_profile.role,'actor_role',v_actor.role));

  RETURN json_build_object('success',true,'user_id',p_target_user_id,'full_name',v_profile.full_name);
END;
$$;

-- ── 5. get_trash_list() ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_trash_list(
  p_role   TEXT DEFAULT NULL,
  p_limit  INT  DEFAULT 50,
  p_offset INT  DEFAULT 0
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_result JSON;
BEGIN
  SELECT json_build_object(
    'items', COALESCE(json_agg(t ORDER BY t.trashed_at DESC),'[]'::json),
    'total', COALESCE(MAX(t.total_count), 0)
  )
  INTO v_result
  FROM (
    SELECT
      p.id, p.full_name, p.email, p.phone_e164, p.role,
      p.trashed_at, p.trash_expires_at, p.trash_reason, p.pre_trash_status,
      tb.full_name AS trashed_by_name,
      GREATEST(0, EXTRACT(EPOCH FROM (p.trash_expires_at - now())) / 86400)::INT AS days_remaining,
      COUNT(*) OVER () AS total_count
    FROM public.profiles p
    LEFT JOIN public.profiles tb ON tb.id = p.trashed_by
    WHERE p.status = 'trashed'
      AND (p_role IS NULL OR p.role = p_role)
    ORDER BY p.trashed_at DESC
    LIMIT p_limit OFFSET p_offset
  ) t;
  RETURN COALESCE(v_result, json_build_object('items','[]'::json,'total',0));
END;
$$;

-- ── 6. get_trash_stats() ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_trash_stats()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_result JSON;
BEGIN
  SELECT json_build_object(
    'total_trashed',  COUNT(*),
    'expiring_soon',  COUNT(*) FILTER (WHERE trash_expires_at < now() + INTERVAL '3 days'),
    'expired',        COUNT(*) FILTER (WHERE trash_expires_at < now()),
    'by_role', json_build_object(
      'student',    COUNT(*) FILTER (WHERE role = 'student'),
      'doctor',     COUNT(*) FILTER (WHERE role = 'doctor'),
      'admin',      COUNT(*) FILTER (WHERE role = 'admin'),
      'super_admin',COUNT(*) FILTER (WHERE role = 'super_admin')
    ),
    'recently_restored', (
      SELECT COALESCE(json_agg(r ORDER BY r.created_at DESC),'[]'::json)
      FROM (
        SELECT al.resource_id AS user_id,
               al.details->>'target_name' AS name,
               al.details->>'target_role' AS role,
               al.created_at
        FROM   public.audit_logs al
        WHERE  al.action = 'user_restored'
        ORDER  BY al.created_at DESC LIMIT 5
      ) r
    )
  ) INTO v_result
  FROM public.profiles WHERE status = 'trashed';
  RETURN v_result;
END;
$$;

-- ── 7. cleanup_expired_trash() ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_expired_trash()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_row     RECORD;
  v_deleted INT := 0;
  v_failed  INT := 0;
  v_res     JSON;
BEGIN
  FOR v_row IN
    SELECT id FROM public.profiles
    WHERE  status = 'trashed' AND trash_expires_at < now()
  LOOP
    BEGIN
      v_res := public.hard_delete_user(v_row.id, v_row.id, 'Auto-cleanup: retention period expired');
      IF (v_res->>'success')::BOOLEAN THEN v_deleted := v_deleted + 1;
      ELSE v_failed := v_failed + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;
  END LOOP;
  RETURN json_build_object('deleted',v_deleted,'failed',v_failed,'ran_at',now());
END;
$$;

-- ── 8. bulk_trash_users() ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bulk_trash_users(
  p_user_ids UUID[],
  p_actor_id UUID,
  p_reason   TEXT DEFAULT NULL
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id      UUID;
  v_success INT := 0;
  v_failed  INT := 0;
  v_res     JSON;
BEGIN
  FOREACH v_id IN ARRAY p_user_ids LOOP
    v_res := public.trash_user(v_id, p_actor_id, p_reason);
    IF (v_res->>'success')::BOOLEAN THEN v_success := v_success + 1;
    ELSE v_failed := v_failed + 1; END IF;
  END LOOP;
  INSERT INTO public.audit_logs(actor_id, action, resource_type, resource_id, success, details)
  VALUES (p_actor_id,'bulk_trash','profile',NULL,true,
    jsonb_build_object('total',array_length(p_user_ids,1),'success',v_success,'failed',v_failed,'reason',p_reason));
  RETURN json_build_object('success',true,'trashed',v_success,'failed',v_failed);
END;
$$;

-- ── 9. bulk_restore_users() ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bulk_restore_users(
  p_user_ids UUID[],
  p_actor_id UUID
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id      UUID;
  v_success INT := 0;
  v_failed  INT := 0;
  v_res     JSON;
BEGIN
  FOREACH v_id IN ARRAY p_user_ids LOOP
    v_res := public.restore_user(v_id, p_actor_id);
    IF (v_res->>'success')::BOOLEAN THEN v_success := v_success + 1;
    ELSE v_failed := v_failed + 1; END IF;
  END LOOP;
  INSERT INTO public.audit_logs(actor_id, action, resource_type, resource_id, success, details)
  VALUES (p_actor_id,'bulk_restore','profile',NULL,true,
    jsonb_build_object('total',array_length(p_user_ids,1),'success',v_success,'failed',v_failed));
  RETURN json_build_object('success',true,'restored',v_success,'failed',v_failed);
END;
$$;

-- ── 10. RLS: hide trashed users from normal profile lookups ───────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='Hide trashed from non-admin'
  ) THEN
    CREATE POLICY "Hide trashed from non-admin" ON public.profiles
      AS RESTRICTIVE FOR SELECT
      USING (
        status <> 'trashed'
        OR auth.jwt()->>'role' IN ('admin','super_admin')
        OR auth.uid() = id
      );
  END IF;
END $$;
