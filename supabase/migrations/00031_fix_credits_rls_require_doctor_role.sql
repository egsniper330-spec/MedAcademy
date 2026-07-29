-- SECURITY FIX: credits_select_own was allowing ANY user whose uid matches doctor_id.
-- After role demotion, orphaned credits rows remain readable by ex-doctors.
-- Tighten: only doctor/admin/super_admin roles can read credits rows.
DROP POLICY IF EXISTS credits_select_own ON credits;

CREATE POLICY credits_select_own ON credits
  FOR SELECT
  USING (
    is_admin_or_super_admin()
    OR (
      doctor_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM profiles
        WHERE id = auth.uid() AND role IN ('doctor', 'admin', 'super_admin')
      )
    )
  );

-- Clean up orphaned credits rows for non-doctor users
DELETE FROM credits
WHERE doctor_id IN (
  SELECT id FROM profiles WHERE role NOT IN ('doctor', 'admin', 'super_admin')
)
AND allocated = 0 AND consumed = 0;