-- ===========================================================================
-- Migration 011 — REMOVE legacy Activation Code system
-- MedAcademy — Phase 1 legacy removal
--
-- WHAT THIS DOES
--   Drops the legacy course-activation-code objects:
--     - activation_ledger_view    (view)
--     - activation_codes_summary  (view)
--     - activation_codes          (table)
--     - code_batches              (table)
--
-- WHAT THIS PRESERVES
--   * users, profiles, courses, enrollments, Doctor<->Student relationships
--   * credits, credit_transactions (ledger history incl. 'code_redeemed' rows)
--   * audit_logs and every historical action value
--   * enrollments.enrollment_method (historical text, no FK dependency)
--
-- IDEMPOTENCE
--   All drops use IF EXISTS, safe to rerun after partial execution.
--   The views are dropped before the tables they read from.
--   No procedures, triggers, functions or events are created here.
-- ===========================================================================

SET FOREIGN_KEY_CHECKS = 0;

DROP VIEW  IF EXISTS `activation_ledger_view`;
DROP VIEW  IF EXISTS `activation_codes_summary`;
DROP TABLE IF EXISTS `activation_codes`;
DROP TABLE IF EXISTS `code_batches`;

SET FOREIGN_KEY_CHECKS = 1;

-- Also remove any stray verification procedure from a previous defective attempt.
DROP PROCEDURE IF EXISTS `mig011_verify`;
