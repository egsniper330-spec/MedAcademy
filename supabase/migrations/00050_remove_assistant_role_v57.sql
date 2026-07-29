-- ── v57: Remove assistant role completely ────────────────────────────────────

-- 1. Migrate any existing assistant profiles to student
UPDATE profiles SET role = 'student' WHERE role = 'assistant';

-- 2. Remove assistant from user_role enum if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'assistant'
  ) THEN
    UPDATE profiles SET role = 'student' WHERE role = 'assistant';
  END IF;
END $$;

-- 3. Drop stale RPC functions (ignore if already absent)
DROP FUNCTION IF EXISTS promote_to_assistant(uuid, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS revoke_assistant(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS transfer_assistant(uuid, uuid, uuid) CASCADE;

-- 4. Clean up orphaned doctor_id on student profiles
UPDATE profiles SET doctor_id = NULL
WHERE role = 'student' AND doctor_id IS NOT NULL;

-- Confirm
SELECT 'v57 assistant removal complete' AS status,
       COUNT(*) FILTER (WHERE role = 'assistant') AS remaining_assistants
FROM profiles;