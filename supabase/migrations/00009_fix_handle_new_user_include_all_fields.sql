
-- Replace handle_new_user to capture all metadata fields written by sign-up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    phone,
    role,
    status,
    university_id,
    faculty_id,
    academic_level_id
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'phone', '')), ''),
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'student'::user_role),
    'active'::user_status,
    NULLIF(NEW.raw_user_meta_data->>'university_id', '')::uuid,
    NULLIF(NEW.raw_user_meta_data->>'faculty_id', '')::uuid,
    NULLIF(NEW.raw_user_meta_data->>'academic_level_id', '')::uuid
  )
  ON CONFLICT (id) DO NOTHING;   -- idempotent: skip if trigger fires twice
  RETURN NEW;
END;
$$;

-- Ensure the trigger is still wired up (re-create if somehow dropped)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
