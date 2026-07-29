
-- ── Video Provider Management ─────────────────────────────────────────────────
-- Global registry of video upload providers.
-- Scalable: add new providers (bunny_stream, vimeo, mux, etc.) by inserting rows.
CREATE TABLE video_providers (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key      text        NOT NULL UNIQUE,         -- 'plyr', 'vdocipher', ...
  display_name      text        NOT NULL,
  is_globally_enabled boolean   NOT NULL DEFAULT true,
  updated_by        uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Per-teacher provider permission overrides.
-- FinalPermission = global.is_globally_enabled AND perm.is_enabled
CREATE TABLE teacher_provider_permissions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_key text        NOT NULL,
  is_enabled   boolean     NOT NULL DEFAULT true,
  updated_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teacher_provider_permissions_teacher_provider_key UNIQUE (teacher_id, provider_key)
);

-- Seed the two current providers
INSERT INTO video_providers (provider_key, display_name, is_globally_enabled) VALUES
  ('plyr',       'Plyr',       true),
  ('vdocipher',  'VdoCipher',  true);

-- ── RLS ────────────────────────────────────────────────────────────────────────
ALTER TABLE video_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_provider_permissions ENABLE ROW LEVEL SECURITY;

-- Helper: check if caller is super_admin (SECURITY DEFINER avoids self-loop)
CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'
  );
$$;

-- Helper: get current user's role
CREATE OR REPLACE FUNCTION get_current_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$;

-- video_providers: super_admin full access; doctors/admins read-only; anon none
CREATE POLICY "vp_super_admin_all" ON video_providers
  FOR ALL
  TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

CREATE POLICY "vp_authenticated_read" ON video_providers
  FOR SELECT
  TO authenticated
  USING (true);

-- teacher_provider_permissions: super_admin full; teachers read own; anon none
CREATE POLICY "tpp_super_admin_all" ON teacher_provider_permissions
  FOR ALL
  TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

CREATE POLICY "tpp_teacher_read_own" ON teacher_provider_permissions
  FOR SELECT
  TO authenticated
  USING (teacher_id = auth.uid());

-- ── updated_at trigger ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER video_providers_updated_at
  BEFORE UPDATE ON video_providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER teacher_provider_permissions_updated_at
  BEFORE UPDATE ON teacher_provider_permissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Convenience RPC: resolve final permissions for a teacher ──────────────────
-- Returns: [{provider_key, display_name, global_enabled, teacher_enabled, final_enabled}]
-- Called by frontend to know which providers a teacher can actually use.
CREATE OR REPLACE FUNCTION get_teacher_provider_permissions(p_teacher_id uuid DEFAULT NULL)
RETURNS TABLE (
  provider_key      text,
  display_name      text,
  global_enabled    boolean,
  teacher_enabled   boolean,
  final_enabled     boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    vp.provider_key,
    vp.display_name,
    vp.is_globally_enabled                          AS global_enabled,
    COALESCE(tpp.is_enabled, true)                  AS teacher_enabled,
    vp.is_globally_enabled AND COALESCE(tpp.is_enabled, true) AS final_enabled
  FROM video_providers vp
  LEFT JOIN teacher_provider_permissions tpp
    ON tpp.provider_key = vp.provider_key
   AND tpp.teacher_id   = COALESCE(p_teacher_id, auth.uid())
  ORDER BY vp.provider_key;
$$;

-- ── Convenience RPC: Super Admin upsert teacher permission ───────────────────
CREATE OR REPLACE FUNCTION upsert_teacher_provider_permission(
  p_teacher_id   uuid,
  p_provider_key text,
  p_is_enabled   boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'Forbidden: super_admin only';
  END IF;
  INSERT INTO teacher_provider_permissions (teacher_id, provider_key, is_enabled, updated_by)
    VALUES (p_teacher_id, p_provider_key, p_is_enabled, auth.uid())
  ON CONFLICT (teacher_id, provider_key)
    DO UPDATE SET is_enabled = p_is_enabled, updated_by = auth.uid(), updated_at = now();
END;
$$;
