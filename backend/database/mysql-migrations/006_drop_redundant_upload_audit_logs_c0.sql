-- ===========================================================================
-- Migration 006 — drop redundant chk_upload_audit_logs_c0
-- ===========================================================================
-- WHY:
--   upload_audit_logs has TWO overlapping CHECK constraints on `event`:
--     chk_upload_audit_logs_c0  (20 values — the pre-chunked-upload list)
--     chk_upload_audit_logs_c1  (38 values — the canonical list from PG
--                                migration 00096_chunked_upload_v1, a strict
--                                superset of c0)
--   MySQL/MariaDB evaluates EVERY CHECK on a row, so inserting events that
--   only c1 allows (chunk_received, assembly_*, vdocipher_*, …) fails with
--   error 4025 against c0. This blocks the VdoCipher chunked-upload audit
--   trail. The original PostgreSQL design used a SINGLE constraint that was
--   replaced (DROP + ADD) as the event list grew; the MySQL port mistakenly
--   kept both old and new constraints.
--
-- FIX: drop the redundant narrower constraint c0. The effective allowed set
--   is unchanged (c1 is a superset of c0), so no audit validation is weakened.
--   No data is modified or deleted.
--
-- SAFE: static DDL only. No information_schema, PREPARE, EXECUTE, or
--   stored procedures. Safe to run through phpMyAdmin.
-- IDEMPOTENCY: if c0 was already dropped (or a fresh schema was built from
--   the updated schema.sql), the DROP below errors with
--   "Can't DROP CONSTRAINT ...; check that it exists". That is harmless —
--   verify with the SHOW CREATE TABLE at the end and continue.
-- ===========================================================================

ALTER TABLE `upload_audit_logs`
  DROP CONSTRAINT `chk_upload_audit_logs_c0`;

-- ── Verification (read-only, works with the restricted cPanel user) ────────
-- Expected: the table shows ONLY chk_upload_audit_logs_c1 with the full
-- 38-value list (including chunk_received, assembly_*, vdocipher_*).
SHOW CREATE TABLE `upload_audit_logs`;
