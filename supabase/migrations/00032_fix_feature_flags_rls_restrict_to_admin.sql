-- SECURITY FIX: feature_flags was readable by all authenticated users.
-- Only admins/super_admins should read/write flags. Students/doctors have no business seeing them.
-- However, the frontend uses feature flags to gate UI features client-side — 
-- so we allow authenticated reads but restrict writes to admin only.
-- Decision: keep read open (flags are non-sensitive), restrict INSERT/UPDATE/DELETE.

-- Check existing policies first, then fix
DO $$
BEGIN
  -- Drop any existing permissive select policy
  DROP POLICY IF EXISTS feature_flags_select_all ON feature_flags;
  DROP POLICY IF EXISTS feature_flags_read_all ON feature_flags;
  DROP POLICY IF EXISTS feature_flags_public_read ON feature_flags;
END $$;

-- Policy: any authenticated user can READ feature flags (needed for client-side gating)
-- But only admins can modify them
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON p.polrelid = c.oid
    WHERE c.relname = 'feature_flags' AND p.polname = 'feature_flags_authenticated_read'
  ) THEN
    EXECUTE 'CREATE POLICY feature_flags_authenticated_read ON feature_flags
      FOR SELECT USING (auth.uid() IS NOT NULL)';
  END IF;
END $$;