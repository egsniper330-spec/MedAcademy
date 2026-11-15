-- 042_pdf_forensic_audit_actions_down.sql
--
-- Rollback for 042. Re-creating the pre-042 enumeration would fail: existing pdf_forensic_*
-- audit rows would violate it, and those rows are evidence that must not be deleted.
-- The widened enumeration is backward compatible (accepts every previously valid action),
-- so this down migration is a documented no-op by design.

-- No-op.
