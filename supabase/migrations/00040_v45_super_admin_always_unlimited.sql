
-- ================================================================
-- Migration 00040: Super Admin Device Limit Guard
-- Ensures super_admin profiles always have max_devices = NULL
-- (unlimited) and creates a trigger to enforce this permanently.
-- ================================================================

-- 1. Fix any existing super_admin rows that have a non-null max_devices
UPDATE profiles
SET max_devices = NULL
WHERE role = 'super_admin' AND max_devices IS NOT NULL;

-- 2. Create a trigger function that enforces the invariant
CREATE OR REPLACE FUNCTION enforce_super_admin_unlimited()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When a profile is inserted or updated as super_admin,
  -- always force max_devices to NULL (unlimited)
  IF NEW.role = 'super_admin' THEN
    NEW.max_devices := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Attach the trigger to profiles
DROP TRIGGER IF EXISTS trg_super_admin_unlimited ON profiles;
CREATE TRIGGER trg_super_admin_unlimited
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION enforce_super_admin_unlimited();

-- 4. Verify
DO $$
DECLARE cnt int;
BEGIN
  SELECT COUNT(*) INTO cnt FROM profiles WHERE role = 'super_admin' AND max_devices IS NOT NULL;
  IF cnt > 0 THEN
    RAISE EXCEPTION 'super_admin limit guard failed: % rows still have non-null max_devices', cnt;
  END IF;
  RAISE NOTICE 'super_admin unlimited guard: OK';
END;
$$;
