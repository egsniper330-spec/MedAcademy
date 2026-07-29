-- Remove the redundant duplicate read policy added this session; "Authenticated can read flags" already existed
DROP POLICY IF EXISTS feature_flags_authenticated_read ON feature_flags;