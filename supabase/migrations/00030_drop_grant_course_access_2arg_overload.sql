-- Drop the old 2-argument overload — only the 3-arg (with idempotency_key DEFAULT NULL) should remain
DROP FUNCTION IF EXISTS public.grant_course_access(uuid, uuid);