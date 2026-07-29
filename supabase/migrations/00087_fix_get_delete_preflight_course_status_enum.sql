-- v213 — Fix get_delete_preflight(): same invalid 'deleted' enum bug as hard_delete_user()
--
-- ROOT CAUSE (the actual function causing the current crash):
--   get_delete_preflight() is called BEFORE hard_delete_user() to show the admin
--   a summary of what would be deleted. It contains:
--     WHERE doctor_id = p_target_user_id AND status NOT IN ('archived','deleted')
--   courses.status is ENUM('draft','published','hidden','archived') — 'deleted' is NOT valid.
--   Postgres throws: "invalid input value for enum course_status: deleted"
--   This aborts the preflight call → the Delete Forever button shows "Something went wrong"
--   before hard_delete_user() is ever called.
--
-- hard_delete_user() was already fixed in v212 with the same correction.
-- This migration applies the identical fix to get_delete_preflight().

CREATE OR REPLACE FUNCTION public.get_delete_preflight(
  p_target_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_role         text;
  v_name         text;
  v_email        text;
  v_phone        text;
  v_courses      bigint;
  v_credits_rem  int;
  v_devices      bigint;
  v_enrollments  bigint;
BEGIN
  SELECT role, full_name, email, phone
    INTO v_role, v_name, v_email, v_phone
  FROM profiles WHERE id = p_target_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Active courses (doctor)
  -- FIX: was NOT IN ('archived','deleted') — 'deleted' is NOT a valid course_status enum value.
  -- Courses are hard-deleted from the DB; the only non-active status is 'archived'.
  SELECT COUNT(*) INTO v_courses FROM courses
  WHERE doctor_id = p_target_user_id
    AND status != 'archived'::public.course_status;

  -- Credit balance (doctor)
  SELECT COALESCE(remaining, 0) INTO v_credits_rem FROM credits
  WHERE doctor_id = p_target_user_id LIMIT 1;

  -- Registered devices
  SELECT COUNT(*) INTO v_devices FROM devices WHERE user_id = p_target_user_id;

  -- Active enrollments (student)
  SELECT COUNT(*) INTO v_enrollments FROM enrollments
  WHERE student_id = p_target_user_id AND status = 'active';

  RETURN jsonb_build_object(
    'found',               true,
    'id',                  p_target_user_id,
    'role',                v_role,
    'full_name',           v_name,
    'email',               v_email,
    'phone',               v_phone,
    'active_courses',      v_courses,
    'credits_remaining',   COALESCE(v_credits_rem, 0),
    'devices',             v_devices,
    'active_enrollments',  v_enrollments
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_delete_preflight(uuid) TO authenticated;

-- Prove the fix: test-call the function against a non-existent UUID (should return {found:false}, not crash)
SELECT public.get_delete_preflight('00000000-0000-0000-0000-000000000000'::uuid);