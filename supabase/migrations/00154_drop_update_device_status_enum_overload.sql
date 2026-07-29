
-- Drop the obsolete device_status enum overload (OID 18820, from migration 00034).
-- Keep only the text-parameter version (OID 25603, from migration 00111) which has
-- the richer audit trail (actor names, descriptions) and is what the Edge Function
-- already targets by passing plain string values like 'blocked' / 'active'.
--
-- The enum overload was the source of:
--   "could not choose the best candidate function between
--    public.update_device_status(p_status => device_status) and
--    public.update_device_status(p_status => text)"
-- because PostgreSQL could not resolve 'blocked'::text → device_status vs text
-- when both signatures were present.

DROP FUNCTION IF EXISTS public.update_device_status(
  p_device_id   uuid,
  p_status      public.device_status,
  p_block_reason text,
  p_actor_id    uuid
);

-- Re-assert the canonical text version with GRANT to ensure it survives
-- any future OR REPLACE that might not re-issue the grant.
GRANT EXECUTE ON FUNCTION public.update_device_status(uuid, text, text, uuid)
  TO authenticated;
