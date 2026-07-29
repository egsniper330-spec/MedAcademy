-- BUG: profiles_select_doctors exposes admin/super_admin profiles to all authenticated users.
-- Students need to see doctors for course browsing, but NOT admins or super_admins.
-- Fix: restrict to role = 'doctor' only.
DROP POLICY IF EXISTS "profiles_select_doctors" ON profiles;
CREATE POLICY "profiles_select_doctors" ON profiles
  FOR SELECT TO authenticated
  USING (role = 'doctor'::user_role);