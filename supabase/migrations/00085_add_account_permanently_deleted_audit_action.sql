-- v211 — Add missing audit_action enum value used by hard_delete_user() RPC
-- Root cause: hard_delete_user() inserts 'account_permanently_deleted' into audit_logs.action
-- but this value was never added to the enum → every permanent deletion fails with:
--   "invalid input value for enum audit_action: account_permanently_deleted"
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'account_permanently_deleted';

-- Verify it's present
SELECT enumlabel
FROM   pg_enum
WHERE  enumtypid = 'public.audit_action'::regtype
  AND  enumlabel = 'account_permanently_deleted';