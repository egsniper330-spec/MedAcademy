
-- ══════════════════════════════════════════════════════════════════════════════
-- v75 — Synchronise audit_action enum: add all values used in RPCs / EFs
-- ══════════════════════════════════════════════════════════════════════════════
--
-- CRITICAL fixes (RPCs in 00066 fail without these):
--   user_trashed, user_restored, bulk_trash, bulk_restore
--
-- Latent fixes (old migrations reference these without IF NOT EXISTS):
--   device_removed, user_hard_deleted
--
-- EF direct-writes (bulk-user-ops writes this string to audit_logs):
--   bulk_permanent_delete
--
-- Proactive additions from user requirement (Option A):
--   undo_delete, trash_emptied, system_health_check,
--   provider_changed, device_limit_changed,
--   unlimited_devices_enabled, unlimited_devices_disabled
--
-- All statements use IF NOT EXISTS so the migration is idempotent.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Trash Bin lifecycle (CRITICAL) ───────────────────────────────────────────
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'user_trashed';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'user_restored';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'bulk_trash';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'bulk_restore';

-- ── Hard delete variants ──────────────────────────────────────────────────────
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'user_hard_deleted';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'bulk_permanent_delete';

-- ── Device management (latent bug in 00034) ───────────────────────────────────
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'device_removed';

-- ── Proactive: undo / empty trash ─────────────────────────────────────────────
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'undo_delete';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'trash_emptied';

-- ── Proactive: system / infra ─────────────────────────────────────────────────
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'system_health_check';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'provider_changed';

-- ── Proactive: device limit variants (supplement existing limit_changed) ──────
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'device_limit_changed';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'unlimited_devices_enabled';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'unlimited_devices_disabled';

-- ── Verify: show full enum after migration ─────────────────────────────────────
-- (select only — does not affect schema)
SELECT enumlabel
FROM   pg_enum
WHERE  enumtypid = 'public.audit_action'::regtype
ORDER  BY enumsortorder;
