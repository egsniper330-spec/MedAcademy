
-- ══════════════════════════════════════════════════════════════════════════════
-- v75b — Add remaining bulk_* audit_action values written by bulk-user-ops EF
-- ══════════════════════════════════════════════════════════════════════════════
-- bulk-user-ops EF writes these strings directly via `bulk_${operation}`:
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'bulk_suspend';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'bulk_unsuspend';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'bulk_reset_devices';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'bulk_reset_password';

-- Confirm final count
SELECT count(*) AS total_audit_action_values
FROM   pg_enum
WHERE  enumtypid = 'public.audit_action'::regtype;
