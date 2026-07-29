
-- ─────────────────────────────────────────────────────────────
-- v73: Deletion Infrastructure
-- ─────────────────────────────────────────────────────────────

-- ── 1. Push tokens ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token        TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('expo','fcm','apns')),
  device_id    UUID REFERENCES public.devices(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, token)
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON public.push_tokens(user_id);
ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='push_tokens' AND policyname='Service role full access'
  ) THEN
    CREATE POLICY "Service role full access" ON public.push_tokens
      USING (auth.jwt() ->> 'role' IN ('admin','super_admin'))
      WITH CHECK (auth.jwt() ->> 'role' IN ('admin','super_admin'));
  END IF;
END $$;

-- ── 2. Deletion records ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.deletion_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id        UUID NOT NULL,
  target_name           TEXT,
  target_role           TEXT,
  target_email          TEXT,
  target_phone          TEXT,
  actor_id              UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason                TEXT,
  status                TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','deleting_db','deleting_storage',
                                            'deleting_videos','deleting_notifications',
                                            'deleting_auth','cleaning_cache','completed','failed')),
  files_removed         INT DEFAULT 0,
  videos_removed        INT DEFAULT 0,
  devices_removed       INT DEFAULT 0,
  credits_removed       INT DEFAULT 0,
  push_tokens_removed   INT DEFAULT 0,
  storage_bytes_freed   BIGINT DEFAULT 0,
  verification          JSONB DEFAULT '{}',
  verification_passed   BOOLEAN,
  orphan_storage        BOOLEAN DEFAULT false,
  orphan_videos         BOOLEAN DEFAULT false,
  orphan_devices        BOOLEAN DEFAULT false,
  error_details         JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deletion_records_actor   ON public.deletion_records(actor_id);
CREATE INDEX IF NOT EXISTS idx_deletion_records_status  ON public.deletion_records(status);
CREATE INDEX IF NOT EXISTS idx_deletion_records_created ON public.deletion_records(created_at DESC);
ALTER TABLE public.deletion_records ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='deletion_records' AND policyname='Admin read deletion_records'
  ) THEN
    CREATE POLICY "Admin read deletion_records" ON public.deletion_records
      FOR SELECT USING (auth.jwt() ->> 'role' IN ('admin','super_admin'));
  END IF;
END $$;

-- ── 3. get_deletion_stats() ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_deletion_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_result JSON;
BEGIN
  SELECT json_build_object(
    'total',          COUNT(*),
    'completed',      COUNT(*) FILTER (WHERE status = 'completed'),
    'failed',         COUNT(*) FILTER (WHERE status = 'failed'),
    'pending',        COUNT(*) FILTER (WHERE status NOT IN ('completed','failed')),
    'orphan_storage', COUNT(*) FILTER (WHERE orphan_storage = true),
    'orphan_videos',  COUNT(*) FILTER (WHERE orphan_videos  = true),
    'orphan_devices', COUNT(*) FILTER (WHERE orphan_devices = true),
    'recent', (
      SELECT json_agg(r ORDER BY r.created_at DESC)
      FROM (
        SELECT id, target_name, target_role, status, verification_passed,
               orphan_storage, orphan_videos, files_removed, videos_removed,
               created_at, completed_at
        FROM   public.deletion_records
        ORDER  BY created_at DESC LIMIT 20
      ) r
    )
  ) INTO v_result
  FROM public.deletion_records;
  RETURN v_result;
END;
$$;

-- ── 4. Drop + recreate hard_delete_user() with role-prefixed labels ────────
DROP FUNCTION IF EXISTS public.hard_delete_user(UUID, UUID, TEXT);

CREATE FUNCTION public.hard_delete_user(
  p_target_user_id UUID,
  p_actor_id       UUID,
  p_reason         TEXT DEFAULT 'Admin-initiated permanent delete'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_profile        RECORD;
  v_actor          RECORD;
  v_admin_count    INT;
  v_sa_count       INT;
  v_course_count   INT;
  v_deleted_label  TEXT;
  v_actor_label    TEXT;
BEGIN
  SELECT id, full_name, role, email, phone_e164, status
  INTO   v_profile FROM public.profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success',false,'code','NOT_FOUND','message','User not found');
  END IF;

  SELECT id, role, full_name INTO v_actor FROM public.profiles WHERE id = p_actor_id;

  v_deleted_label := CASE v_profile.role
    WHEN 'student'     THEN 'Deleted Student'
    WHEN 'doctor'      THEN 'Deleted Doctor'
    WHEN 'admin'       THEN 'Deleted Admin'
    WHEN 'super_admin' THEN 'Deleted Super Admin'
    ELSE                    'Deleted User'
  END;

  v_actor_label := COALESCE(v_actor.full_name, 'Unknown Actor');

  -- Role guards
  IF v_profile.role = 'doctor' AND (v_actor.role IS DISTINCT FROM 'super_admin') THEN
    SELECT COUNT(*) INTO v_course_count FROM public.courses
    WHERE  doctor_id = p_target_user_id AND status NOT IN ('archived','deleted');
    IF v_course_count > 0 THEN
      RETURN json_build_object('success',false,'code','DOCTOR_HAS_COURSES',
        'message', format('Doctor has %s active course(s). Archive them first.', v_course_count));
    END IF;
  END IF;

  IF v_profile.role = 'admin' THEN
    SELECT COUNT(*) INTO v_admin_count FROM public.profiles
    WHERE  role = 'admin' AND status = 'active' AND id <> p_target_user_id;
    IF v_admin_count = 0 THEN
      RETURN json_build_object('success',false,'code','LAST_ADMIN',
        'message','Cannot delete the last active admin.');
    END IF;
  END IF;

  IF v_profile.role = 'super_admin' THEN
    SELECT COUNT(*) INTO v_sa_count FROM public.profiles
    WHERE  role = 'super_admin' AND status = 'active' AND id <> p_target_user_id;
    IF v_sa_count = 0 THEN
      RETURN json_build_object('success',false,'code','LAST_SUPER_ADMIN',
        'message','Cannot delete the last active super admin.');
    END IF;
  END IF;

  -- Anonymize NO ACTION FK references with role-prefixed labels
  UPDATE public.audit_logs
  SET    user_id = NULL,
         details = COALESCE(details,'{}')
                   || jsonb_build_object('deleted_actor_label', v_deleted_label, 'deletion_reason', p_reason)
  WHERE  user_id = p_target_user_id;

  UPDATE public.audit_logs
  SET    actor_id = NULL,
         details  = COALESCE(details,'{}')
                    || jsonb_build_object('deleted_actor_label', v_actor_label)
  WHERE  actor_id = p_target_user_id;

  UPDATE public.credit_transactions SET performed_by = NULL WHERE performed_by = p_target_user_id;
  UPDATE public.credit_transactions SET student_id   = NULL WHERE student_id   = p_target_user_id;
  UPDATE public.activation_codes    SET created_by   = NULL WHERE created_by   = p_target_user_id;
  UPDATE public.code_batches         SET created_by   = NULL WHERE created_by   = p_target_user_id;
  UPDATE public.courses SET archived_by = NULL WHERE archived_by = p_target_user_id;
  UPDATE public.courses SET restored_by = NULL WHERE restored_by = p_target_user_id;
  UPDATE public.fraud_flags           SET user_id  = NULL WHERE user_id  = p_target_user_id;
  UPDATE public.provider_audit_log    SET actor_id = NULL WHERE actor_id = p_target_user_id;
  UPDATE public.subscription_timeline SET actor_id = NULL WHERE actor_id = p_target_user_id;

  BEGIN UPDATE public.security_policies       SET created_by = NULL WHERE created_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.security_vpn_whitelist   SET added_by   = NULL WHERE added_by   = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.assistant_permissions    SET granted_by = NULL WHERE granted_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.content_protection_policies SET created_by = NULL WHERE created_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;
  BEGIN UPDATE public.video_health_alerts SET resolved_by = NULL WHERE resolved_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- Delete profile (CASCADE handles devices, enrollments, push_tokens, etc.)
  DELETE FROM public.profiles WHERE id = p_target_user_id;

  -- Audit entry
  INSERT INTO public.audit_logs(actor_id, action, resource_type, resource_id, success, details)
  VALUES (p_actor_id, 'account_permanently_deleted', 'profile', p_target_user_id, true,
    jsonb_build_object(
      'deleted_name',        v_profile.full_name,
      'deleted_role',        v_profile.role,
      'deleted_actor_label', v_deleted_label,
      'actor_name',          v_actor_label,
      'actor_role',          v_actor.role,
      'reason',              p_reason
    )
  );

  RETURN json_build_object(
    'success',       true,
    'deleted_name',  v_profile.full_name,
    'deleted_role',  v_profile.role,
    'deleted_label', v_deleted_label
  );
END;
$$;

-- ── 5. Orphan-repair helpers ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_orphan_deletion_records()
RETURNS SETOF public.deletion_records
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT * FROM public.deletion_records
  WHERE  status = 'failed' OR orphan_storage = true OR orphan_videos = true OR orphan_devices = true
  ORDER  BY created_at DESC LIMIT 100;
$$;

CREATE OR REPLACE FUNCTION public.mark_deletion_repaired(p_record_id UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.deletion_records
  SET    orphan_storage = false, orphan_videos = false, orphan_devices = false,
         status = 'completed', completed_at = now()
  WHERE  id = p_record_id;
$$;
